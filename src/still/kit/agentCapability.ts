// AgentCapabilityController — the SINGLE owner of Agent capability truth
// (A0 STATE-CONTROLLER-STABILIZATION-R1).
//
// Root Agent and StillRun consume THIS; neither keeps its own derived copy
// (no capBlocked, no duplicate runs-capable booleans, no per-page retry
// nonce). Run list/events stay page-specific — only capability truth is
// shared.
//
// States: unpaired | offline | probing | probe-error | unavailable | ready
//   unpaired      no pairing
//   offline       paired but the gateway is not connected
//   probing       hello in flight
//   probe-error   hello request FAILED (capability unknown)
//   unavailable   hello SUCCEEDED and advertised runs=false  ← unsupported
//   ready         hello SUCCEEDED and advertised runs=true
//
// `canUseRuns` is derived from the state: ONLY `ready` may call
// agentRuns/agentEvents/agentStop.
export type AgentUiState =
  | "unpaired"
  | "offline"
  | "probing"
  | "probe-error"
  | "unavailable"
  | "ready";

export type AgentSnapshot = {
  state: AgentUiState;
  paired: boolean;
  connected: boolean;
  instanceId: string;
  canUseRuns: boolean;
  /** LSH remote-surface capability (Issue #72), independent of `runs`: a
   *  Desktop may offer the LightSeek surface without Agent run control. Only
   *  a CURRENT hello that advertised it enables the entry. */
  canUseLsh: boolean;
};

/** Pure derivation — the state table, unit-tested directly. */
export function deriveAgentState(input: {
  paired: boolean;
  connected: boolean;
  probe: "pending" | "success" | "error" | null;
  runs: true | false | null;
}): AgentUiState {
  if (!input.paired) return "unpaired";
  if (!input.connected) return "offline";
  if (input.probe === "pending" || input.probe === null) return "probing";
  if (input.probe === "error") return "probe-error";
  return input.runs === true ? "ready" : "unavailable";
}

export function canUseRuns(state: AgentUiState): boolean {
  return state === "ready";
}

export type AgentCapabilityDeps = {
  /** Probe the desktop capability (hello). */
  probe: () => Promise<{ runs: boolean; lshRemoteSurface?: boolean }>;
};

export class AgentCapabilityController {
  private deps: AgentCapabilityDeps;
  private listeners = new Set<(s: AgentSnapshot) => void>();

  private paired = false;
  private connected = false;
  private instanceId = "";
  private probePhase: "pending" | "success" | "error" | null = null;
  private runs: true | false | null = null;
  private lshRemoteSurface: true | false | null = null;
  /** Probe generation fences late hellos (instance switch / rapid retry). */
  private probeGeneration = 0;
  private snapshotCache: AgentSnapshot | null = null;

  constructor(deps: AgentCapabilityDeps) {
    this.deps = deps;
  }

  subscribe(fn: (s: AgentSnapshot) => void): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  snapshot(): AgentSnapshot {
    if (!this.snapshotCache) this.snapshotCache = this.buildSnapshot();
    return this.snapshotCache;
  }

  private buildSnapshot(): AgentSnapshot {
    const state = deriveAgentState({
      paired: this.paired,
      connected: this.connected,
      probe: this.probePhase,
      runs: this.runs,
    });
    return {
      state,
      paired: this.paired,
      connected: this.connected,
      instanceId: this.instanceId,
      canUseRuns: canUseRuns(state),
      // Independent of the runs state machine: a CURRENT successful hello that
      // advertised the LSH remote surface. Unknown/absent is never true.
      canUseLsh: this.connected && this.probePhase === "success" && this.lshRemoteSurface === true,
    };
  }

  /** Connection/identity event from the host. */
  setConnection(input: { paired: boolean; connected: boolean; instanceId: string }) {
    const changed =
      input.paired !== this.paired ||
      input.connected !== this.connected ||
      input.instanceId !== this.instanceId;
    if (!changed) return;
    this.paired = input.paired;
    this.connected = input.connected;
    this.instanceId = input.instanceId;
    if (!this.paired || !this.connected) {
      // Capability is unknown while disconnected — never claim unavailable.
      this.probePhase = null;
      this.runs = null;
      this.lshRemoteSurface = null;
      this.probeGeneration += 1;
      this.emit();
      return;
    }
    this.probeGeneration += 1;
    this.probePhase = "pending";
    this.runs = null;
    this.lshRemoteSurface = null;
    this.emit();
    void this.runProbe(this.probeGeneration);
  }

  /** Retry from any UI surface: same code path as the initial probe. */
  retry() {
    if (!this.paired || !this.connected) return;
    this.probeGeneration += 1;
    this.probePhase = "pending";
    this.runs = null;
    this.lshRemoteSurface = null;
    this.emit();
    void this.runProbe(this.probeGeneration);
  }

  private async runProbe(generation: number) {
    try {
      const hello = await this.deps.probe();
      if (generation !== this.probeGeneration) return; // stale hello
      this.probePhase = "success";
      this.runs = hello?.runs === true;
      this.lshRemoteSurface = hello?.lshRemoteSurface === true ? true : false;
    } catch {
      if (generation !== this.probeGeneration) return;
      this.probePhase = "error";
      this.runs = null;
      this.lshRemoteSurface = null;
    }
    this.emit();
  }

  private emit() {
    this.snapshotCache = this.buildSnapshot();
    for (const fn of this.listeners) fn(this.snapshotCache);
  }
}
