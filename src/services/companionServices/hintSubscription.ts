// Services hint subscription adapter (Issue #77 REPAIR-R2 P1-W2).
//
// Desktop `.3` exposes `/v1/services/events/stream` as a WEBSOCKET. TS never
// opens it: the Rust worker owns the pinned socket and buffers typed hints, and
// this adapter simply drains them through Tauri commands.
//
// Consequences that matter:
//  - no WebSocket, no URL and no bearer exist on the TS side;
//  - a hint is a WAKE-UP TARGET only — the durable cursor remains the truth and
//    is never advanced from a hint;
//  - a `servicesChanged` hint marks the registry's permission truth STALE;
//  - `stop()` retires the worker (also happens on revoke / pairing switch).

import { invoke } from "@tauri-apps/api/core";

/** Canonical typed hints the stream may carry. */
export type Hint =
  | { kind: "servicesChanged"; permissionRevision: number }
  | { kind: "materialChanged"; cursor: string }
  | { kind: "knowledgeChanged"; vaultId: string; cursor: string }
  | { kind: "ingestChanged"; jobId: string }
  | { kind: "lshStateChanged" };

export type HintRecord = { generation: number; hint: unknown };

/**
 * A drained hint WITH its worker generation preserved.
 *
 * The generation must survive the IPC boundary: Rust clearing its buffer later
 * cannot revoke bytes already copied into an in-flight response, so the
 * consumer — not the producer — decides whether a record is still adoptable.
 */
export type DrainedHint = { generation: number; hint: Hint };

/** Validate one drained record into a typed Hint, failing closed. */
export function toHint(value: unknown): Hint | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  switch (v.kind) {
    case "servicesChanged":
      return typeof v.permissionRevision === "number"
        ? { kind: "servicesChanged", permissionRevision: v.permissionRevision }
        : null;
    case "materialChanged":
      return typeof v.cursor === "string" ? { kind: "materialChanged", cursor: v.cursor } : null;
    case "knowledgeChanged":
      return typeof v.vaultId === "string" && typeof v.cursor === "string"
        ? { kind: "knowledgeChanged", vaultId: v.vaultId, cursor: v.cursor }
        : null;
    case "ingestChanged":
      return typeof v.jobId === "string" ? { kind: "ingestChanged", jobId: v.jobId } : null;
    case "lshStateChanged":
      return { kind: "lshStateChanged" };
    default:
      return null; // unknown shape fails closed
  }
}

/** Coarse worker phase reported by Rust. */
export type HintPhase = "stopped" | "starting" | "running";

export type HintStatus = {
  generation: number;
  phase: HintPhase;
  owner: string;
  connectFailures: number;
};

/** What a start call did. Both are SUCCESS; neither guarantees a live socket. */
export type StartOutcome =
  | { outcome: "started"; generation: number }
  | { outcome: "alreadyRunning"; generation: number };

export type HintSubscription = {
  /**
   * Start (or rejoin) the Rust worker for this Desktop.
   *
   * Resolves with the outcome; it does NOT prove the socket is live, because
   * the dial happens in the spawned task. Callers must consult `status()` (or
   * rely on `drain()` returning nothing) before treating hints as available.
   */
  start: (instance: string) => Promise<StartOutcome>;
  /**
   * Drain hints ONLY for the named owner + generation.
   *
   * Both values are checked ATOMICALLY in native state against the live worker,
   * so a client that lost the worker to another owner receives `[]` and that
   * owner's buffered records are left untouched. Passing no binding drains
   * nothing (G1-R3: filtering after a destructive take is insufficient).
   */
  drain: (expected: { instance: string; generation: number }) => Promise<DrainedHint[]>;
  /** The worker phase — the only honest signal that hints are live. */
  status: () => Promise<HintStatus>;
  /**
   * Retire the hint scope ONLY for the bound owner + generation.
   *
   * The native side checks owner/generation/live atomically: a client that lost
   * the worker to another owner gets `false` and that owner's worker (and its
   * cancellation) is untouched.
   */
  stop: (expected: { instance: string; generation: number }) => Promise<boolean>;
};

const STOPPED: HintStatus = { generation: 0, phase: "stopped", owner: "", connectFailures: 0 };

function toStatus(value: unknown): HintStatus {
  if (!value || typeof value !== "object") return STOPPED;
  const v = value as Record<string, unknown>;
  const phase = v.phase;
  if (phase !== "stopped" && phase !== "starting" && phase !== "running") return STOPPED;
  return {
    generation: typeof v.generation === "number" ? v.generation : 0,
    phase,
    owner: typeof v.owner === "string" ? v.owner : "",
    connectFailures: typeof v.connectFailures === "number" ? v.connectFailures : 0,
  };
}

export function createHintSubscription(
  invokeRef: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> = invoke,
): HintSubscription {
  return {
    async start(instance: string): Promise<StartOutcome> {
      const reply = (await invokeRef("services_hints_start", { instance })) as any;
      const generation = typeof reply?.generation === "number" ? reply.generation : 0;
      // `outcome` is tagged by serde; treat anything unrecognised as started so
      // the caller still checks status().
      const outcome = reply?.outcome === "alreadyRunning" ? "alreadyRunning" : "started";
      return { outcome, generation } as StartOutcome;
    },
    async status(): Promise<HintStatus> {
      try {
        return toStatus(await invokeRef("services_hints_status"));
      } catch {
        return STOPPED;
      }
    },
    async drain(expected: { instance: string; generation: number }): Promise<DrainedHint[]> {
      // No binding means nothing to drain for: refuse without touching the
      // native buffer.
      if (!expected.instance || expected.generation < 0) return [];
      const records = (await invokeRef("services_hints_state", {
        instance: expected.instance,
        generation: expected.generation,
      })) as HintRecord[] | null;
      if (!Array.isArray(records)) return [];
      const out: DrainedHint[] = [];
      for (const record of records) {
        // Generation is part of the IPC currentness proof. A record without a
        // numeric generation must NOT be synthesized from the expectation —
        // evidence the consumer may not invent. Fail closed / skip it.
        if (typeof record?.generation !== "number") continue;
        const hint = toHint(record?.hint);
        if (!hint) continue; // unknown shape fails closed
        out.push({ generation: record.generation, hint });
      }
      return out;
    },
    async stop(expected: { instance: string; generation: number }): Promise<boolean> {
      // No bound scope means there is nothing of ours to retire: refuse without
      // issuing an unscoped global retirement.
      if (!expected.instance || expected.generation < 0) return false;
      const retired = (await invokeRef("services_hints_stop", {
        instance: expected.instance,
        generation: expected.generation,
      })) as unknown;
      return retired === true;
    },
  };
}
