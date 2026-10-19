// CrossDeviceSearchController — the SINGLE owner of all cross-device search
// async truth (A0 STATE-CONTROLLER-STABILIZATION-R1).
//
// States: idle | waiting-context | loading | settled | partial-failure
//
//   idle             no pairing or empty query: nothing will be requested
//   waiting-context  a query exists but the pairing/vault context is not ready
//                    yet — the query is REMEMBERED and starts automatically
//                    when the context arrives (the user never re-types)
//   loading          a request for the current generation is in flight
//   settled          the last request committed cleanly
//   partial-failure  the last request committed with one domain missing (a
//                    failed domain keeps the other domain's results)
//
// Ownership: pairing identity, vault readiness, query, generation, identity
// epoch, debounce, waiting-context, loading/settled, desktop notes, desktop
// assets, per-domain live/cache provenance, failures, and the COMMITTED result
// context all live here. The React page only feeds events and renders
// snapshots — it owns no search truth of its own.
import type { Provenance } from "./provenance";

export type SearchContext = { instanceId: string; vault: string };
export type SearchPhase = "idle" | "waiting-context" | "loading" | "settled" | "partial-failure";
export type DomainResult = { items: any[]; provenance: Provenance };
export type SearchSnapshot = {
  phase: SearchPhase;
  query: string;
  /** The identity the VISIBLE results belong to (route from this, never from
   *  a later connection value). */
  committedContext: SearchContext;
  notes: DomainResult;
  assets: DomainResult;
  failures: { notes: boolean; assets: boolean };
};

const EMPTY: DomainResult = { items: [], provenance: "cache" };

export type SearchDeps = {
  fetchNotes: (q: string, ctx: SearchContext) => Promise<DomainResult>;
  fetchAssets: (q: string, ctx: SearchContext) => Promise<DomainResult>;
  debounceMs?: number;
};

export class CrossDeviceSearchController {
  private deps: SearchDeps;
  private listeners = new Set<(s: SearchSnapshot) => void>();

  // --- pairing / context -----------------------------------------------------
  private paired = false;
  private context: SearchContext = { instanceId: "", vault: "" };
  private query = "";

  // --- fencing ---------------------------------------------------------------
  private generation = 0;
  private identityEpoch = 0;
  private debounce: ReturnType<typeof setTimeout> | null = null;

  // --- committed result ------------------------------------------------------
  private phase: SearchPhase = "idle";
  private committedContext: SearchContext = { instanceId: "", vault: "" };
  private notes: DomainResult = EMPTY;
  private assets: DomainResult = EMPTY;
  private failures = { notes: false, assets: false };
  private snapshotCache: SearchSnapshot | null = null;

  constructor(deps: SearchDeps) {
    this.deps = { debounceMs: 260, ...deps };
  }

  subscribe(fn: (s: SearchSnapshot) => void): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  /** Stable reference between transitions (useSyncExternalStore compares by
   *  identity — a fresh object per call would loop forever). */
  snapshot(): SearchSnapshot {
    if (!this.snapshotCache) this.snapshotCache = this.buildSnapshot();
    return this.snapshotCache;
  }

  /** SYNCHRONOUS identity event. Any pairing or Desktop-identity change fences
   *  in-flight work at once — it never waits for the async vault lookup. */
  setConnection(input: { paired: boolean; instanceId: string }) {
    const pairedChanged = input.paired !== this.paired;
    const instanceChanged = input.instanceId !== this.context.instanceId;
    if (!pairedChanged && !instanceChanged) return;
    this.paired = input.paired;
    // Identity fence: epoch + generation bump, debounce dropped, context reset.
    this.identityEpoch += 1;
    this.generation += 1;
    this.clearTimer();
    this.context = { instanceId: input.paired ? input.instanceId : "", vault: "" };
    this.dropDesktopResults();
    // A non-empty query waits for the new context instead of firing against
    // the previous Desktop.
    this.reconcile();
  }

  /** Vault readiness for the CURRENT instance. A stale resolution (the identity
   *  moved on while contentVaults was pending) is ignored. */
  setVault(vaultId: string, forInstanceId?: string) {
    if (this.context.instanceId === "") return; // unpaired: nothing to attach to
    if (forInstanceId !== undefined && forInstanceId !== this.context.instanceId) return; // stale resolution
    if (vaultId === this.context.vault) return;
    this.context = { ...this.context, vault: vaultId };
    this.reconcile();
  }

  /** The user's query. Remembers the pending query while the context is not
   *  ready — no re-typing required. */
  setQuery(q: string) {
    const changed = q.trim() !== this.query.trim();
    this.query = q;
    if (changed) {
      // Visible rows belong to the NEW query only once it settles: drop them.
      // reconcile() supersedes the previous request via its own generation bump.
      this.clearTimer();
      this.dropDesktopResults();
    }
    this.reconcile();
  }

  /** Invalidate in-flight work without touching context (page unmount). */
  cancel() {
    this.generation += 1;
    this.clearTimer();
    if (this.phase === "loading") this.phase = this.notes.items.length || this.assets.items.length ? "settled" : "idle";
    this.emit();
  }

  dispose() {
    this.cancel();
    this.listeners.clear();
  }

  // --- internals -------------------------------------------------------------

  private clearTimer() {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
  }

  private dropDesktopResults() {
    this.notes = EMPTY;
    this.assets = EMPTY;
    this.failures = { notes: false, assets: false };
    this.committedContext = { instanceId: "", vault: "" };
  }

  private contextReady(): boolean {
    return this.paired && this.context.instanceId !== "" && this.context.vault !== "";
  }

  /** The single transition function: every event above funnels through here. */
  private reconcile() {
    const q = this.query.trim();
    if (!this.paired || !q) {
      this.clearTimer();
      this.phase = "idle";
      this.dropDesktopResults();
      this.emit();
      return;
    }
    if (!this.contextReady()) {
      // Remember the query; it runs the moment the context arrives.
      this.clearTimer();
      this.phase = "waiting-context";
      this.emit();
      return;
    }
    // One bump site: issuing a request supersedes whatever came before.
    const myGeneration = ++this.generation;
    const myEpoch = this.identityEpoch;
    this.phase = "loading";
    this.emit();
    this.clearTimer();
    const ctx = { ...this.context };
    this.debounce = setTimeout(async () => {
      if (myGeneration !== this.generation || myEpoch !== this.identityEpoch) return;
      const [notesR, assetsR] = await Promise.allSettled([
        this.deps.fetchNotes(q, ctx),
        this.deps.fetchAssets(q, ctx),
      ]);
      // Fenced: a stale identity/generation never commits.
      if (myGeneration !== this.generation || myEpoch !== this.identityEpoch) return;
      this.failures = {
        notes: notesR.status === "rejected",
        assets: assetsR.status === "rejected",
      };
      this.notes = notesR.status === "fulfilled" ? notesR.value : EMPTY;
      this.assets = assetsR.status === "fulfilled" ? assetsR.value : EMPTY;
      this.committedContext = ctx;
      this.phase = this.failures.notes || this.failures.assets ? "partial-failure" : "settled";
      this.emit();
    }, this.deps.debounceMs);
  }

  private buildSnapshot(): SearchSnapshot {
    return {
      phase: this.phase,
      query: this.query,
      committedContext: { ...this.committedContext },
      notes: this.notes,
      assets: this.assets,
      failures: { ...this.failures },
    };
  }

  private emit() {
    this.snapshotCache = this.buildSnapshot();
    for (const fn of this.listeners) fn(this.snapshotCache);
  }
}
