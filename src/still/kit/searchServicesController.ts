// SERVICES-SEARCH-R1 — the ordinary Search page's Desktop-side controller.
//
// SINGLE owner of the canonical Desktop search truth: it composes the
// ACCEPTED production pieces — `ServiceRegistry` (discovery/permission truth)
// and `SearchSession` (canonical `search.unified` with pagination + 410
// recovery) — over the Rust-backed production transport. No fetch, no second
// REST client, no legacy `contentNotes/contentAssets/contentVaults` search.
//
// Currentness rules (Issue #82):
//   - query A → B: A rows drop immediately; late A success/error/page-N can
//     never commit (query epoch + SearchSession generation fences);
//   - Desktop instance switch: rebind retires the prior remote search at
//     once (old projections are rejected by the instance binding) and the
//     catalog is re-discovered for the new Desktop;
//   - reconnect / gateway generation change: the page retires the epoch and
//     rebinds; discovery runs again and a FRESH query starts (never a cursor
//     from a prior runtime generation);
//   - permissionRevision change (re-discovery observes a different revision):
//     the catalog is refreshed and a live query restarts under the new
//     revision — a late old-permission result is dropped by the epoch fence;
//   - operation truth from `registry.operation("search.unified")` maps to
//     truthful user copy (notGranted / temporarily-unavailable / unsupported).
//
// The LOCAL unified search is a separate authority and is never touched here.

import type { SearchHit } from "../../../shared/companion-services-v1/types.ts";
import { ServiceRegistry, stateOf } from "../../services/companionServices/index.ts";
import { SearchSession } from "../../services/companionServices/searchClient.ts";
import type { ServiceCatalog } from "../../../shared/companion-services-v1/types.ts";
import type { OperationState } from "../../../shared/companion-services-v1/types.ts";

export type RemoteSearchPhase =
  | "idle"                    // no query
  | "unpaired"                // no paired Desktop: local-only truth
  | "offline"                 // paired but the Desktop connection dropped
  | "waiting-catalog"         // paired+query, discovery in flight
  | "loading"                 // page 1 in flight
  | "loading-more"            // next page in flight (same generation)
  | "ready"                   // settled with (possibly zero) canonical rows
  | "not-granted"             // operation exists, grant missing
  | "temporarily-unavailable" // implemented but temporarily down
  | "unsupported"             // missing from catalog / unsupported / old Desktop
  | "error";                  // transport-level failure (bounded copy on the page)

export type RemoteSearchSnapshot = {
  phase: RemoteSearchPhase;
  /** The query the visible hits belong to. */
  query: string;
  /** The Desktop instance the visible hits belong to (captured at bind). */
  instanceId: string;
  /** Optional bounded refresh-failure reason (diagnostics only). */
  errorCode?: string;
  permissionRevision: number | null;
  /** Canonical ranked hits in EXACT server order (materials+knowledge mixed). */
  hits: SearchHit[];
  nextCursor: string | null;
  /** True when the visible projection replaced a 410-stale one. */
  recovered: boolean;
};

const EMPTY: RemoteSearchSnapshot = {
  phase: "idle", query: "", instanceId: "",
  permissionRevision: null, hits: [], nextCursor: null, recovered: false,
};

export type SearchServicesDeps = {
  registry: ServiceRegistry;
  session: SearchSession;
  debounceMs?: number;
};

export type SearchServicesBinding = {
  paired: boolean;
  instanceId: string;
  /** Liveness fence owned by the page (route generation / ws epoch). */
  isLive: () => boolean;
};

/** Map a canonical operation state to the controller phase. */
export function phaseForOperation(state: OperationState): RemoteSearchPhase {
  switch (state) {
    case "notGranted": return "not-granted";
    case "temporarilyUnavailable": return "temporarily-unavailable";
    case "unsupported": return "unsupported";
  }
  // `implemented` reaches here only from callers that then start the query.
  return "loading";
}

export class SearchServicesController {
  private readonly registry: ServiceRegistry;
  private readonly session: SearchSession;
  private readonly deps: SearchServicesDeps;
  private readonly debounceMs: number;
  private readonly listeners = new Set<(s: RemoteSearchSnapshot) => void>();

  private binding: SearchServicesBinding | null = null;
  private query = "";
  private debounce: ReturnType<typeof setTimeout> | null = null;
  // Monotonic epoch: A→B, rebind, drop/reconnect all supersede everything
  // issued under an older epoch, in addition to SearchSession's own fence.
  private epoch = 0;
  private loadingMore = false;
  /** Session generation at which the current page's query was started. */
  private sessionFloor = 0;

  private snap: RemoteSearchSnapshot = EMPTY;

  constructor(deps: SearchServicesDeps) {
    this.registry = deps.registry;
    this.session = deps.session;
    this.deps = deps;
    this.debounceMs = deps.debounceMs ?? 260;
    // Canonical hits flow through the session subscribe (page 1 / append /
    // 410 recovery all mutate the projection asynchronously).
    this.session.subscribe(() => this.onSessionProjection());
  }

  subscribe(fn: (s: RemoteSearchSnapshot) => void): () => void {
    this.listeners.add(fn);
    fn(this.snap);
    return () => { this.listeners.delete(fn); };
  }

  snapshot(): RemoteSearchSnapshot {
    return this.snap;
  }

  /** Connection event from the page. A Desktop/pairing change retires the
   *  prior remote search immediately (rows drop at once) and re-discovers. */
  setConnection(binding: SearchServicesBinding): void {
    const prev = this.binding;
    if (prev && prev.instanceId === binding.instanceId && prev.paired === binding.paired) return;
    this.epoch += 1;
    this.clearTimer();
    this.loadingMore = false;
    // REPAIR-R1-C4: a hard rebind must also kill the prior session generation
    // so an in-flight page-N can never commit under the new Desktop.
    this.session.invalidate();
    this.sessionFloor = this.session.currentGeneration()?.generation ?? 0;
    this.binding = binding;
    if (!binding.paired || !binding.instanceId) {
      // REPAIR-R1-A: unpaired + non-empty query must SETTLE remote immediately
      // (a truthful "connect your computer" state), never sit in
      // waiting-catalog while local results are already finished.
      this.session.invalidate();
      this.snap = {
        ...EMPTY,
        query: this.query,
        phase: this.query ? "unpaired" : "idle",
      };
      this.emit();
      return;
    }
    // Old rows must never survive an instance switch; the stale session
    // projection is rejected by the instance binding on arrival.
    this.snap = { ...EMPTY, query: this.query, phase: "waiting-catalog", instanceId: binding.instanceId };
    this.emit();
    if (this.query) void this.discoverAndRun(this.query, this.epoch);
  }

  /** The user's query (debounced). Drops visible rows for the old query at
   *  once; only the newest epoch+query may commit. */
  setQuery(q: string): void {
    const trimmed = q.trim();
    if (trimmed === this.query) return;
    this.query = trimmed;
    this.epoch += 1;
    this.clearTimer();
    // REPAIR-R1-C: the prior generation must die NOW — an old page-N
    // completion must not land during this query's debounce/discovery window.
    this.session.invalidate();
    this.sessionFloor = this.session.currentGeneration()?.generation ?? 0;
    this.loadingMore = false;
    if (!trimmed) {
      this.snap = { ...EMPTY, instanceId: this.binding?.instanceId ?? "" };
      this.emit();
      return;
    }
    const pairedNow = Boolean(this.binding?.paired && this.binding.instanceId);
    this.snap = {
      ...EMPTY, query: trimmed,
      phase: pairedNow ? "waiting-catalog" : "unpaired",
      instanceId: this.binding?.instanceId ?? "",
    };
    this.emit();
    if (!pairedNow) return;
    this.debounce = setTimeout(() => {
      void this.discoverAndRun(trimmed, this.epoch);
    }, this.debounceMs);
  }

  /** Explicit load-more. Coalesces double taps; appends only into the same
   *  generation via SearchSession.next() (410 → fresh page-1 replacement). */
  loadMore(): void {
    if (this.loadingMore || this.snap.phase !== "ready" || !this.snap.nextCursor) return;
    // REPAIR-R1-C: capture the full completion fence for this page request.
    const fence = this.captureFence();
    this.loadingMore = true;
    this.snap = { ...this.snap, phase: "loading-more" };
    this.emit();
    this.session.next()
      .then(() => {
        if (!this.isFenced(fence)) return; // a newer query/rebind owns the page now
        this.loadingMore = false;
        this.syncFromSession(fence);
      })
      .catch(() => {
        if (!this.isFenced(fence)) return;
        this.loadingMore = false;
        this.snap = { ...this.snap, phase: "error" };
        this.emit();
      });
  }

  /** The fence every async completion must still satisfy to commit. */
  private captureFence() {
    return {
      epoch: this.epoch,
      query: this.query,
      instanceId: this.binding?.instanceId ?? "",
      live: Boolean(this.binding?.isLive()),
    };
  }

  private isFenced(f: { epoch: number; query: string; instanceId: string; live: boolean }): boolean {
    return (
      f.epoch === this.epoch &&
      f.query === this.query &&
      f.instanceId === (this.binding?.instanceId ?? "") &&
      f.live &&
      Boolean(this.binding?.isLive())
    );
  }

  /** Page-driven retirement (ws drop / unmount): the session's in-flight
   *  requests are invalidated too, so a pre-drop answer landing late can
   *  never become the truth of a newer connection epoch. */
  retire(): void {
    this.epoch += 1;
    this.clearTimer();
    this.loadingMore = false;
    this.session.invalidate();
  }

  /**
   * REPAIR-R1-A: the page's WS-drop signal. Clears remote hits/cursor at once
   * and shows a SETTLED offline state so the page can render the truth
   * instead of stale rows; local search is untouched by this controller.
   */
  disconnected(): void {
    this.epoch += 1;
    this.clearTimer();
    this.loadingMore = false;
    this.session.invalidate();
    if (!this.query) {
      this.snap = { ...EMPTY };
      this.emit();
      return;
    }
    this.snap = { ...EMPTY, query: this.query, phase: "offline", instanceId: this.binding?.instanceId ?? "" };
    this.emit();
  }

  /**
   * REPAIR-R1-B: permission truth changed for a possibly-UNCHANGED query
   * (e.g. a `servicesChanged` hint carrying a new permission revision, or the
   * Desktop revoking a grant). Retires the current results, drops the cached
   * catalog and reruns the SAME query against freshly discovered truth —
   * including an implemented→notGranted transition. A late pre-change result
   * can never commit (epoch fence).
   */
  permissionChanged(): void {
    if (!this.binding?.paired || !this.binding.instanceId) return;
    this.epoch += 1;
    this.clearTimer();
    this.loadingMore = false;
    this.session.invalidate();
    this.registry.invalidate();
    if (!this.query) {
      this.snap = { ...EMPTY, query: "", phase: "idle", instanceId: this.binding.instanceId };
      this.emit();
      return;
    }
    this.snap = { ...EMPTY, query: this.query, phase: "waiting-catalog", instanceId: this.binding.instanceId };
    this.emit();
    void this.discoverAndRun(this.query, this.epoch);
  }

  /**
   * REPAIR-R2/R3: the page's reconnect signal. Retires the epoch, drops any
   * cached catalog, and re-discovers + re-runs the live query against the
   * (possibly restarted) Gateway. Unlike setConnection this runs even when
   * the instance id is unchanged — a reconnect is exactly the case where the
   * prior runtime's in-flight truth must be re-established from scratch.
   */
  reconnect(): void {
    if (!this.binding?.paired || !this.binding.instanceId) return;
    this.epoch += 1;
    this.clearTimer();
    this.loadingMore = false;
    this.registry.invalidate();
    this.session.invalidate();
    this.sessionFloor = this.session.currentGeneration()?.generation ?? 0;
    this.snap = { ...EMPTY, query: this.query, phase: this.query ? "waiting-catalog" : "idle", instanceId: this.binding.instanceId };
    this.emit();
    if (this.query) void this.discoverAndRun(this.query, this.epoch);
  }

  // --- internals -------------------------------------------------------------

  private clearTimer() {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
  }

  private live(): boolean {
    return Boolean(this.binding?.isLive());
  }

  /** A fresh session projection arrived (page 1 / append / 410 recovery).
   *  Stale identity/query/epoch projections are rejected whole. */
  private onSessionProjection(): void {
    const proj = this.session.snapshot();
    const gen = this.session.currentGeneration();
    if (!gen) return;
    if (gen.query !== this.query) return;
    if (!this.binding || gen.instanceId !== this.binding.instanceId) return;
    if (!this.binding.isLive()) return;
    // A retired epoch (query change / rebind / drop) means the session
    // projection belongs to a page this controller no longer owns.
    if (gen.generation < this.projectionFloor()) return;
    this.snap = {
      phase: this.loadingMore ? "loading-more" : "ready",
      query: gen.query,
      instanceId: gen.instanceId,
      permissionRevision: gen.permissionRevision,
      hits: proj.items,
      nextCursor: proj.nextCursor,
      recovered: proj.recovered,
    };
    this.emit();
  }

  /** Discover (fresh truth) then run the query if the operation allows. */
  private async discoverAndRun(query: string, epoch: number): Promise<void> {
    const binding = this.binding;
    if (!binding) return;
    this.snap = { ...EMPTY, query, phase: "waiting-catalog", instanceId: binding.instanceId };
    this.emit();
    try {
      // ONE canonical discovery through the production registry: the catalog
      // itself is the only source of gatewayGeneration/permissionRevision for
      // a cold client, and the registry adopts it under the same token fence.
      const catalog = await this.registry.refreshAdopting(binding.instanceId);
      if (epoch !== this.epoch || !this.live()) return;
      this.runUnder(catalog.permissionRevision, catalog, query, epoch);
    } catch (discoverError) {
      if (epoch !== this.epoch || !this.live()) return;
      this.snap = { ...EMPTY, query, phase: "error", errorCode: String((discoverError as any)?.message ?? discoverError).slice(0, 60), instanceId: binding.instanceId };
      this.emit();
    }
  }

  /** Decision from the adopted catalog: run the query or show truthful copy. */
  private runUnder(revision: number | null, adopted: ServiceCatalog | null, query: string, epoch: number): void {
    const state = stateOf(adopted, "search.unified");
    if (state !== "implemented") {
      this.snap = {
        ...EMPTY, query, phase: phaseForOperation(state),
        instanceId: this.binding?.instanceId ?? "",
        permissionRevision: revision,
      };
      this.emit();
      return;
    }
    const identity = { instanceId: this.binding!.instanceId, permissionRevision: revision ?? 0 };
    this.snap = { ...EMPTY, query, phase: "loading", instanceId: identity.instanceId, permissionRevision: revision };
    this.emit();
    this.session.start({ q: query, limit: 20 }, identity)
      .catch((error) => {
        if (epoch !== this.epoch || !this.live()) return;
        this.snap = { ...EMPTY, query, phase: "error", instanceId: identity.instanceId, permissionRevision: revision };
        this.emit();
        void error;
      });
  }

  /** Pull the session projection into the snapshot — only when the captured
   *  fence still holds (REPAIR-R1-C: no unfenced commit). */
  private syncFromSession(fence: { epoch: number; query: string; instanceId: string; live: boolean }): void {
    if (!this.isFenced(fence)) return;
    const proj = this.session.snapshot();
    const gen = this.session.currentGeneration();
    if (!gen) return;
    if (gen.query !== fence.query || gen.instanceId !== fence.instanceId) return;
    this.snap = {
      phase: "ready",
      query: gen.query,
      instanceId: gen.instanceId,
      permissionRevision: gen.permissionRevision,
      hits: proj.items,
      nextCursor: proj.nextCursor,
      recovered: proj.recovered,
    };
    this.emit();
  }

  /** Monotonic marker: session generations issued before the current epoch
   *  are stale by definition (their page was retired). */
  private projectionFloor(): number {
    return this.sessionFloor;
  }

  private emit() {
    this.snap = { ...this.snap };
    for (const fn of this.listeners) fn(this.snap);
  }
}
