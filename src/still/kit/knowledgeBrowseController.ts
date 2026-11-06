// SERVICES-KNOWLEDGE-BROWSE-R1 — the canonical read-side controller for
// 「知识 → 电脑」.
//
// Moves the connected browse/list/search/page authority for the DESKTOP source
// of the Knowledge page from the Content V1 cache reader to canonical
// Services, on the same accepted architecture as #82's search controller:
//
//   discover (`registry.refreshAdopting`) → `knowledge.vaults` → the ACTIVE,
//   read-granted vault → `knowledge.registeredList` (canonical `q`,
//   `afterId`, `nextAfterId` paging, server order preserved).
//
// Read-only by scope: nothing here creates, updates, deletes, renames or
// resolves conflicts. Write/editor authority stays with Content V1 and the
// DesktopStillNote editor.
//
// Directory boundary (hard): canonical Services V1 has NO knowledge directory
// enumeration/filter operation. This controller therefore has no directory
// concept at all — it never invents one, never builds a fake tree from a
// loaded page, and never disguises legacy `contentNoteDirectories` as
// Services. `parentRelativePath` is carried as plain row metadata.
//
// Currentness (all fenced by ONE monotonic epoch plus an explicit liveness
// callback):
//   - query A→B retires A immediately (debounced B, stale commits dropped);
//   - Desktop A→B drops A's rows and re-discovers under B;
//   - reconnect re-discovers and re-lists the SAME instance from scratch;
//   - the ACTIVE vault changing retires the old rows/token and re-lists;
//   - a late page-N success/error can never touch a newer identity;
//   - a permission/grant failure lands as a truthful phase, never stale rows.
//
// Offline: a paired-but-disconnected Desktop lands as `offline` — Desktop
// rows never pretend fresh, and this controller creates no cache authority.

import { readableNoteSearchEvidence, type NoteSearchEvidence } from "./noteSearch.ts";
import type { ServiceRegistry } from "../../services/companionServices/serviceRegistry.ts";
import type { KnowledgeClient } from "../../services/companionServices/knowledgeClient.ts";
import { ServicesError } from "../../services/companionServices/transport.ts";
import type { OperationState } from "../../../shared/companion-services-v1/types.ts";
import type { KnowledgeReplicaLibrary, KnowledgeReplicaReader } from "../../services/knowledgeReplica.ts";

export type KnowledgeBrowsePhase =
  | "idle"                    // source not on Desktop (or nothing to show)
  | "unpaired"                // Desktop source but no pairing
  | "offline"                 // paired, but the ws is down
  | "waiting-catalog"         // paired, discovery in flight
  | "discovering-vault"       // catalog read; resolving the active vault
  | "loading"                 // page-1 of the list in flight
  | "searching"               // R1.5-C: a certified same-vault query refinement
  | "loading-more"            // a later page in flight
  | "ready"                   // rows on screen (possibly zero results)
  | "not-granted"             // catalog truth: the operation is not granted
  | "temporarily-unavailable"
  | "unsupported"
  | "error";

export type KnowledgeBrowseRow = {
  /** Small query-bound evidence from the existing full-body S1 read. */
  searchHit?: NoteSearchEvidence;
  /** Exact row identity: instance + vault + note (route-grade). */
  instanceId: string;
  vaultId: string;
  noteId: string;
  title: string;
  /** Canonical row metadata — never a directory tree. */
  parentRelativePath: string;
  revision: string;
};

export type KnowledgeBrowseSnapshot = {
  /** Diagnostic request scope only, never authority for rows or operations. */
  requestedVaultId?: string;
  /** Explicitly confirmed, persisted single-vault scope; not connection truth. */
  replica?: KnowledgeReplicaLibrary;
  /** Background work never changes the mounted retained view into loading. */
  refreshing?: boolean;
  stale?: boolean;
  phase: KnowledgeBrowsePhase;
  instanceId: string;
  /** The resolved ACTIVE vault (identity of the rows on screen). */
  vaultId: string;
  vaultName: string;
  query: string;
  rows: KnowledgeBrowseRow[];
  /** Canonical `nextAfterId`; null = no more pages. */
  nextAfterId: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  errorCode: string;
  /** The canonical Services error code when the failure came from the wire. */
  remoteCode: string;
  /**
   * R4.2 (P1-A7): the Desktop-domain currentness signal (coarse
   * desktopVersion) that CERTIFIED this snapshot. A view gate can compare it
   * against the current signal synchronously, so a stale-vault snapshot is
   * never presented as current on the first render.
   */
  certifiedVersion: number | null;
};

const EMPTY: KnowledgeBrowseSnapshot = {
  phase: "idle", instanceId: "", vaultId: "", vaultName: "",
  query: "", rows: [], nextAfterId: null, hasMore: false,
  loadingMore: false, errorCode: "", remoteCode: "",
  certifiedVersion: null,
};

export type KnowledgeBrowseBinding = {
  paired: boolean;
  connected: boolean;
  instanceId: string;
  /** Liveness fence owned by the page (route lifetime). */
  isLive: () => boolean;
};

export type KnowledgeBrowseDeps = {
  registry: ServiceRegistry;
  knowledge: KnowledgeClient;
  replica?: KnowledgeReplicaReader;
  /** Canonical page size for `registeredList`. */
  pageSize?: number;
  debounceMs?: number;
};

function phaseForOperation(state: OperationState): KnowledgeBrowsePhase {
  switch (state) {
    case "notGranted": return "not-granted";
    case "temporarilyUnavailable": return "temporarily-unavailable";
    case "unsupported": return "unsupported";
  }
  return "loading";
}

export class KnowledgeBrowseController {
  private selectedVault = "";
  private selectionReadable = true;
  private selectionEpoch = 0;
  selectVault(vaultId: string, readable = true, selectionEpoch = this.selectionEpoch): void {
    if (this.selectedVault === vaultId && this.selectionReadable === readable && this.selectionEpoch === selectionEpoch) return;
    this.selectionEpoch = selectionEpoch;
    this.selectionReadable = readable;
    this.selectedVault = vaultId;
    this.epoch += 1; this.clearTimer(); this.loadingMore = false;
    this.certified = null; this.moveVault = null; this.replicaMoveToken += 1; this.replicaMoveKey = "";
    const instance = this.binding?.instanceId || "";
    if (!readable) { this.discardScope(instance, vaultId); this.blockedScopes.add(this.permissionKey(instance, vaultId)); }
    const keep = readable ? this.restore(instance, vaultId) : undefined;
    this.snap = keep ? { ...keep, refreshing: true } : {
      ...EMPTY, instanceId: instance, query: this.query, phase: readable ? "waiting-catalog" : "not-granted",
    };
    this.emit();
    if (readable && this.binding?.paired && !this.suspended) void this.discoverAndList(this.query, this.epoch, keep);
  }
  private readonly retained = new Map<string, { snapshot: KnowledgeBrowseSnapshot; pages: number; revocation: number; security: number }>();
  private readonly deniedViews = new Map<string, KnowledgeBrowseSnapshot>();
  private activeRevocation = 0;
  private activeSecurity = 0;
  private readonly blockedScopes = new Set<string>();
  private permissionKey(instance: string, vault: string): string { return JSON.stringify([instance, vault]); }
  private loadedPages = 1;
  private scopeKey(instance: string, vault: string, query = this.query): string {
    return JSON.stringify([instance, vault, query]);
  }
  private scopedRegistry(instance = this.binding?.instanceId || "", vault = this.selectedVault): ServiceRegistry {
    return this.registry.forScope?.(instance, vault ? { vault } : undefined) ?? this.registry;
  }
  private discardScope(instance: string, vault?: string): void {
    for (const [key, { snapshot }] of this.retained) {
      if (snapshot.instanceId === instance && (vault === undefined || snapshot.vaultId === vault || snapshot.requestedVaultId === vault)) this.retained.delete(key);
    }
  }
  /** Exact-owner synchronous render lookup, including before selection effects run. */
  snapshotFor(instance: string, vault = this.selectedVault, query = this.query): KnowledgeBrowseSnapshot | undefined {
    const registry = this.scopedRegistry(instance, vault);
    const denied = registry.snapshot?.() && ["knowledge.vaults", "knowledge.registeredList"].some(op => registry.operation(op).state === "notGranted");
    if (denied) {
      const key = this.scopeKey(instance, vault, query);
      let view = this.deniedViews.get(key);
      if (!view) {
        view = { ...EMPTY, instanceId: instance, requestedVaultId: vault, query, phase: "not-granted", remoteCode: "GRANT_REQUIRED" };
        this.deniedViews.set(key, view);
      }
      return view;
    }
    const snap = this.snap;
    if (this.activeSecurity === (registry.currentSecurityRevision?.() ?? 0)
      && this.activeRevocation === (registry.currentRevocationRevision?.() ?? 0)
      && snap.instanceId === instance && snap.query === query
      && (vault ? snap.vaultId === vault || (!snap.vaultId && snap.requestedVaultId === vault) : snap.requestedVaultId === "")) return snap;
    const retained = this.retained.get(this.scopeKey(instance, vault, query));
    return retained && retained.security === (registry.currentSecurityRevision?.() ?? 0) && retained.revocation === (registry.currentRevocationRevision?.() ?? 0) ? retained.snapshot : undefined;
  }
  private restore(instance: string, vault = this.selectedVault): KnowledgeBrowseSnapshot | undefined {
    const registry = this.scopedRegistry(instance, vault);
    this.activeRevocation = registry.currentRevocationRevision?.() ?? 0;
    this.activeSecurity = registry.currentSecurityRevision?.() ?? 0;
    const candidate = this.retained.get(this.scopeKey(instance, vault));
    const retained = candidate?.revocation === this.activeRevocation && candidate.security === this.activeSecurity ? candidate : undefined;
    this.loadedPages = retained?.pages ?? 1;
    this.replicaPage = retained?.pages ?? 1;
    this.afterId = retained?.snapshot.nextAfterId ?? null;
    return retained?.snapshot;
  }

  private readonly replica?: KnowledgeReplicaReader;
  private replicaPage = 1;
  private replicaRefreshPending = false;
  private replicaMoveKey = "";
  private replicaMoveToken = 0;
  private readonly registry: ServiceRegistry;
  private readonly knowledge: KnowledgeClient;
  private readonly pageSize: number;
  private readonly debounceMs: number;
  private readonly listeners = new Set<(s: KnowledgeBrowseSnapshot) => void>();

  private binding: KnowledgeBrowseBinding | null = null;
  private query = "";
  private debounce: ReturnType<typeof setTimeout> | null = null;
  /** ONE monotonic fence: query change / rebind / drop / reconnect / vault
   *  change all supersede everything issued under an older epoch. */
  private epoch = 0;
  /** `nextAfterId` of the LAST committed page under the current identity. */
  private afterId: string | null = null;
  private loadingMore = false;
  /** R4.2: true between suspend() and activate() — the source is inactive. */
  private suspended = false;
  /**
   * R4.2: the epoch of the currently-live discover/list, 0 when none. A
   * suspended request's epoch is below `this.epoch`, so activate() can tell
   * "fenced mid-flight" (restart exactly once) from "already loading"
   * (never double-start).
   */
  private activeEpoch = 0;
  /**
   * R1.5-C: the CERTIFIED browse authority (the owner+active vault that a
   * successful discovery proved). While it matches the current owner, an
   * ordinary query change takes the FAST PATH — one registeredList call,
   * never a re-discovery. Cleared on owner/pairing change, connection
   * flips, permission facts, and vault-currentness events; the explicit
   * user Refresh may always run the full path again.
   */
  private certified: { instanceId: string; vaultId: string; vaultName: string } | null = null;
  /**
   * ORG-1B REPAIR-R1.1 (P1-8): the ACTIVE vault's canonical facts as the
   * discovery that owns the rows observed them — the move affordance reads
   * its write grant from here instead of a hardcoded `true`. Null until a
   * discovery has actually resolved an active vault (fail closed).
   */
  private moveVault: { vaultId: string; vaultName: string; writeGranted: boolean } | null = null;

  private snap: KnowledgeBrowseSnapshot = EMPTY;

  constructor(deps: KnowledgeBrowseDeps) {
    this.replica = deps.replica;
    this.registry = deps.registry;
    this.knowledge = deps.knowledge;
    this.pageSize = deps.pageSize ?? 50;
    this.debounceMs = deps.debounceMs ?? 260;
    this.registry.subscribe?.(() => {
      for (const [key, saved] of this.retained) {
        const scope = this.scopedRegistry(saved.snapshot.instanceId, saved.snapshot.requestedVaultId ?? "");
        if (saved.security !== (scope.currentSecurityRevision?.() ?? 0) || saved.revocation !== (scope.currentRevocationRevision?.() ?? 0)
          || (scope.snapshot?.() && ["knowledge.vaults", "knowledge.registeredList"].some(op => scope.operation(op).state === "notGranted"))) {
          this.retained.delete(key);
          this.blockedScopes.add(this.permissionKey(saved.snapshot.instanceId, saved.snapshot.requestedVaultId ?? ""));
        }
      }
      const b = this.binding;
      if (!b?.paired || !b.instanceId) return;
      const scope = this.scopedRegistry();
      const denied = Boolean(scope.snapshot?.() && ["knowledge.vaults", "knowledge.registeredList"].some(op => scope.operation(op).state === "notGranted"));
      const revoked = this.activeRevocation !== (scope.currentRevocationRevision?.() ?? 0);
      if (!denied && !revoked && this.activeSecurity === (scope.currentSecurityRevision?.() ?? 0)) return;
      this.blockedScopes.add(this.permissionKey(b.instanceId, this.selectedVault));
      this.activeRevocation = scope.currentRevocationRevision?.() ?? 0;
      this.activeSecurity = scope.currentSecurityRevision?.() ?? 0;
      this.epoch += 1; this.clearTimer(); this.loadingMore = false;
      this.certified = null; this.moveVault = null; this.replicaMoveToken += 1;
      this.snap = { ...EMPTY, instanceId: b.instanceId, query: this.query, phase: denied || revoked ? "not-granted" : "waiting-catalog" };
      this.emit();
      if (!denied && !revoked && this.selectionReadable && b.connected && !this.suspended) {
        const epoch = this.epoch;
        queueMicrotask(() => { if (epoch === this.epoch && this.live()) void this.discoverAndList(this.query, epoch); });
      }
    });
  }

  subscribe(fn: (s: KnowledgeBrowseSnapshot) => void): () => void {
    this.listeners.add(fn);
    fn(this.snap);
    return () => { this.listeners.delete(fn); };
  }

  snapshot(): KnowledgeBrowseSnapshot {
    return this.snap;
  }

  private emit(): void {
    this.snap = { ...this.snap, requestedVaultId: this.selectedVault };
    if ((this.snap.phase === "ready" || (this.snap.phase === "offline" && this.snap.replica))
      && !this.snap.refreshing && this.snap.instanceId && this.snap.vaultId) {
      this.retained.set(this.scopeKey(this.snap.instanceId, this.selectedVault), {
        snapshot: this.snap, pages: this.snap.replica ? this.replicaPage : this.loadedPages,
        revocation: this.scopedRegistry().currentRevocationRevision?.() ?? 0,
        security: this.scopedRegistry().currentSecurityRevision?.() ?? 0,
      });
    }
    for (const fn of this.listeners) fn(this.snap);
  }

  /** Connection event from the page (synchronous identity). */
  setConnection(binding: KnowledgeBrowseBinding): void {
    const prev = this.binding;
    const wasSuspended = this.suspended;
    this.binding = binding;
    this.suspended = false;
    if (prev && !wasSuspended && prev.instanceId === binding.instanceId
      && prev.paired === binding.paired && prev.connected === binding.connected) return;
    this.epoch += 1; this.clearTimer(); this.loadingMore = false;
    this.certified = null; this.moveVault = null; this.replicaMoveKey = ""; this.replicaMoveToken += 1;
    if (!binding.paired || !binding.instanceId) {
      this.retained.clear(); this.afterId = null;
      if (prev?.paired) this.registry.invalidate();
      this.snap = { ...EMPTY, phase: "unpaired", instanceId: binding.instanceId, query: this.query };
      this.emit(); return;
    }
    const keep = this.selectionReadable ? this.restore(binding.instanceId) : undefined;
    this.snap = { ...EMPTY, ...keep, instanceId: binding.instanceId, query: this.query,
      phase: !this.selectionReadable ? "not-granted" : !binding.connected ? "offline" : keep?.phase ?? "waiting-catalog",
      refreshing: this.selectionReadable && Boolean(keep) && binding.connected,
      stale: Boolean(keep) && !binding.connected };
    this.emit();
    if (this.selectionReadable && (binding.connected || this.replica)) void this.discoverAndList(this.query, this.epoch, keep);
  }

  /** The user's query (debounced). A→B retires A's rows immediately. */
  setQuery(q: string): void {
    const trimmed = q.trim();
    if (trimmed === this.query) return;
    this.query = trimmed;
    this.epoch += 1;
    this.clearTimer();
    this.loadingMore = false;
    this.afterId = null;
    const b = this.binding;
    const pairedNow = Boolean(b?.paired && b.instanceId);
    if (!pairedNow) {
      this.certified = null;
      this.snap = { ...EMPTY, query: trimmed, phase: "unpaired", instanceId: b?.instanceId ?? "" };
      this.emit();
      return;
    }
    if (this.replica && this.snap.replica) {
      this.replicaPage = 1;
      this.snap = {...this.snap, query: trimmed, phase: "searching", hasMore: false, loadingMore: false};
      this.emit();
      this.debounce = setTimeout(() => { void this.discoverAndList(trimmed, this.epoch); }, this.debounceMs);
      return;
    }
    if (!b!.connected) {
      this.certified = null;
      this.snap = { ...EMPTY, query: trimmed, phase: "offline", instanceId: b!.instanceId };
      this.emit();
      return;
    }
    // R1.5-C FAST PATH: once the SAME owner's active vault has a certified
    // browse authority, an ordinary query refinement (including clearing the
    // query) calls ONLY knowledge.registeredList — never services.discover,
    // never knowledge.vaults. The last-good rows stay painted under a light
    // 正在搜索… phase; a stale query response is epoch-fenced.
    const cert = this.certified;
    if (cert && cert.instanceId === b!.instanceId && this.snap.instanceId === b!.instanceId && cert.vaultId === this.snap.vaultId && this.snap.vaultId) {
      this.snap = {
        ...this.snap, query: trimmed, phase: "searching",
        rows: this.snap.rows, nextAfterId: null, hasMore: false,
        loadingMore: false, errorCode: "", remoteCode: "",
      };
      this.emit();
      this.debounce = setTimeout(() => { void this.listOnly(trimmed, this.epoch); }, this.debounceMs);
      return;
    }
    // Cold / re-certifying path: the full discover → vaults → list pipeline.
    this.snap = {
      ...EMPTY, query: trimmed, phase: "waiting-catalog",
      instanceId: b!.instanceId,
    };
    this.emit();
    this.debounce = setTimeout(() => { void this.discoverAndList(trimmed, this.epoch); }, this.debounceMs);
  }

  /**
   * R1.5-C: the certified fast-path list query — one registeredList call
   * against the already-proven owner+vault. Stale responses are epoch-fenced
   * exactly like the full path; permission facts still classify and retire
   * the certification.
   */
  private async listOnly(query: string, epoch: number): Promise<void> {
    const b = this.binding;
    if (!b || !b.paired || !b.instanceId || !b.connected) return;
    const { vaultId, vaultName } = this.snap;
    if (!vaultId) return;
    const keep = this.snap.instanceId === b.instanceId && this.snap.query === query
      && this.snap.phase !== "searching" ? this.snap : undefined;
    this.activeEpoch = epoch;
    try {
      const page = await this.knowledge.registeredList(b.instanceId, vaultId, {
        q: query || undefined, limit: this.pageSize,
      });
      if (epoch !== this.epoch || !this.live()) return;
      this.afterId = page.nextAfterId ?? null;
      this.loadedPages = 1;
      this.loadingMore = false;
      this.snap = {
        ...this.snap, phase: "ready", refreshing: false, stale: false, query,
        rows: pageItems(b.instanceId, vaultId, vaultName, page.items ?? []),
        nextAfterId: page.nextAfterId ?? null,
        hasMore: Boolean(page.hasMore),
        loadingMore: false, errorCode: "", remoteCode: "",
      };
      this.emit();
    } catch (error) {
      if (epoch !== this.epoch || !this.live()) return;
      this.fail(epoch, error, keep);
    } finally {
      if (this.activeEpoch === epoch) this.activeEpoch = 0;
    }
  }

  /**
   * R4.1: the user's EXPLICIT refresh, stale-while-revalidate. The epoch and
   * the catalog cache are refreshed and a full discover+list runs, but the
   * same-owner last-good ROWS STAY PAINTED while it runs; a failure keeps
   * them and surfaces the truthful error state instead of blanking. Owner
   * fences are untouched — this only ever runs for the bound owner.
   */
  refresh(): void {
    if (this.snap.replica) { this.revalidateReplica(); return; }
    const b = this.binding;
    if (!b?.paired || !b.instanceId || !b.connected) return;
    this.epoch += 1;
    this.clearTimer();
    this.loadingMore = false;
    const kept = this.restore(b.instanceId) ?? this.snap;
    this.snap = { ...kept, refreshing: true, loadingMore: false, errorCode: "", remoteCode: "" };
    this.emit();
    void this.discoverAndList(this.query, this.epoch, kept);
  }

  /**
   * R4.1: fence WITHOUT destroying. Leaving the Desktop source (or the
   * Knowledge root unmounting) bumps the epoch so any in-flight discover/list
   * can never commit later — but the retained snapshot STAYS in the session,
   * so returning to the SAME owner/identity repaints it synchronously. A
   * later `setConnection`/`reconnect` for a different owner or a currentness
   * signal supersedes it through the normal fail-closed paths.
   */
  suspend(): void {
    this.epoch += 1;
    this.clearTimer();
    this.loadingMore = false;
    this.suspended = true;
  }

  /**
   * R4.2 (P1-A4): the explicit ACTIVATION side of suspend. Returning to the
   * Desktop source must not rely on setConnection's same-binding early-return
   * — that left a request suspended mid-cold-load permanently pending. Rules:
   *
   *   - same owner + a READY retained snapshot + same query: repaint it
   *     immediately, NO cold request (the cache-first return);
   *   - anything else (no last-good, or a phase that was fenced mid-flight:
   *     waiting/discovering/loading), start EXACTLY ONE fresh discover/list.
   *
   * The epoch moves again so a still-resolving suspended request stays dead.
   */
  activate(): void {
    this.suspended = false;
    const b = this.binding;
    if (!b?.paired || !b.instanceId) return;
    // A genuinely-live request for the CURRENT epoch is never restarted.
    if (this.activeEpoch === this.epoch) return;
    const snap = this.snap;
    const sameQuery = snap.query === this.query;
    if (b.connected && snap.instanceId === b.instanceId && snap.phase === "ready" && sameQuery) {
      return; // retained cache-first: nothing to restart
    }
    if (!b.connected) {
      if (this.replica && !snap.vaultId) void this.discoverAndList(this.query, this.epoch);
      // Offline truth now; the reconnect/refresh paths own the fresh list.
      return;
    }
    this.epoch += 1;
    this.clearTimer();
    this.loadingMore = false;
    const kept = snap.instanceId === b.instanceId && sameQuery ? this.restore(b.instanceId) : undefined;
    this.snap = { ...EMPTY, ...kept, query: this.query, phase: kept?.phase ?? "waiting-catalog", refreshing: Boolean(kept), instanceId: b.instanceId };
    this.emit();
    void this.discoverAndList(this.query, this.epoch, kept);
  }

  /**
   * R1.6-B: ONE mutation-specific same-vault FAST revalidation — the
   * certified authority is re-listed through `registeredList` ONLY (zero
   * services.discover, zero knowledge.vaults), stale-while-revalidate: the
   * last-good rows stay painted. A no-op without a certified current vault
   * (the normal lifecycle paths own that case).
   */
  fastRevalidate(): void {
    if (this.snap.replica) { this.revalidateReplica(); return; }
    const b = this.binding;
    if (!b?.paired || !b.instanceId || !b.connected) return;
    const cert = this.certified;
    if (!cert || cert.instanceId !== b.instanceId) return;
    if (!this.snap.vaultId || cert.vaultId !== this.snap.vaultId) return;
    if (this.activeEpoch === this.epoch && this.epoch > 0) return; // a request is live
    this.epoch += 1;
    this.clearTimer();
    this.loadingMore = false;
    void this.listOnly(this.query, this.epoch);
  }

  /** The page's reconnect signal: same instance, fresh runtime. Retires the
   *  epoch, drops the catalog cache, and re-discovers + re-lists from scratch. */
  reconnect(): void {
    const b = this.binding;
    if (!b?.paired || !b.instanceId) return;
    this.epoch += 1;
    this.clearTimer();
    this.loadingMore = false;
    this.afterId = null;
    const keep = this.restore(b.instanceId);
    this.snap = { ...EMPTY, ...keep, query: this.query, phase: keep?.phase ?? "waiting-catalog", refreshing: Boolean(keep), instanceId: b.instanceId };
    this.emit();
    void this.discoverAndList(this.query, this.epoch, keep);
  }

  /** The Desktop's active vault changed (page-driven signal). Retires the old
   *  rows/token and re-lists the CURRENT identity from page 1. */
  activeVaultChanged(): void {
    const b = this.binding;
    if (!b?.paired || !b.instanceId || !b.connected) return;
    this.certified = null; // vault currentness changed
    this.epoch += 1;
    this.clearTimer();
    this.loadingMore = false;
    this.afterId = null;
    this.snap = { ...EMPTY, query: this.query, phase: "discovering-vault", instanceId: b.instanceId };
    this.emit();
    void this.discoverAndList(this.query, this.epoch);
  }

  /** Canonical `afterId` paging. Only the current identity may load more, and
   *  a late page-N success/error is fenced by the epoch. */
  loadMore(): void {
    if (this.snap.replica) {
      if (this.loadingMore || !this.snap.hasMore || this.activeEpoch) return;
      this.loadingMore = true;
      this.snap = {...this.snap, phase: "loading-more", loadingMore: true}; this.emit();
      const epoch = this.epoch, keep = this.snap;
      void this.readReplica(this.query, epoch, this.replicaPage + 1, true)
        .catch(error => this.fail(epoch, error, keep));
      return;
    }
    const b = this.binding;
    if (!b?.paired || !b.instanceId || !b.connected) return;
    if (this.loadingMore || this.activeEpoch === this.epoch || !this.snap.hasMore || !this.afterId) return;
    const epoch = this.epoch;
    const { vaultId, vaultName } = this.snap;
    const query = this.query;
    this.loadingMore = true;
    this.snap = { ...this.snap, phase: "loading-more", loadingMore: true };
    this.emit();
    // R1-REPAIR (1): the SAME q must ride every page — a search's page-2 with
    // a bare afterId would silently fall back to the whole vault and mix
    // unrelated notes into the search results.
    this.knowledge.registeredList(b.instanceId, vaultId, { q: query || undefined, afterId: this.afterId, limit: this.pageSize })
      .then((page) => {
        if (epoch !== this.epoch || !this.live()) return;
        const rows = [
          ...this.snap.rows,
          ...pageItems(b.instanceId, vaultId, vaultName, page.items ?? []),
        ];
        this.afterId = page.nextAfterId ?? null;
        this.loadedPages += 1;
        this.loadingMore = false;
        this.snap = {
          ...this.snap, phase: "ready", refreshing: false, stale: false, rows,
          nextAfterId: page.nextAfterId ?? null,
          hasMore: Boolean(page.hasMore),
          loadingMore: false,
        };
        this.emit();
      })
      .catch((error) => {
        // A late page-N failure must not blank or error a newer identity.
        if (epoch !== this.epoch || !this.live()) return;
        this.loadingMore = false;
        // R1-REPAIR (3): a canonical permission failure is a FACT even on a
        // later page — the stale actionable rows clear and the truth shows.
        if (error instanceof ServicesError) {
          this.fail(epoch, error, { ...this.snap, loadingMore: false });
          return;
        }
        // Any other paging failure keeps the loaded rows and surfaces quietly.
        this.snap = {
          ...this.snap, phase: "ready", loadingMore: false,
          errorCode: String((error as any)?.message ?? error).slice(0, 60),
        };
        this.emit();
      });
  }

  // --- internals -------------------------------------------------------------
  /** Local data refresh retains query, every loaded page, and row layout. */
  revalidateReplica(): void {
    if (!this.replica || !this.binding?.paired || !this.binding.instanceId || this.suspended) return;
    if (this.activeEpoch === this.epoch && this.activeEpoch > 0) { this.replicaRefreshPending = true; return; }
    const keep = this.snap;
    this.epoch += 1; this.clearTimer();
    void this.discoverAndList(this.query, this.epoch, keep);
  }

  private async readReplica(query: string, epoch: number, pages: number, append = false): Promise<boolean> {
    if (!this.replica || !this.binding?.paired || !this.binding.instanceId) return false;
    const instance = this.binding.instanceId;
    this.activeEpoch = epoch;
    try {
      const libraries = await this.replica.libraries(instance);
      if (epoch !== this.epoch || !this.live()) return true;
      const library = libraries.find(library => library.confirmed && library.instanceId === instance && (!this.selectedVault || library.vaultId === this.selectedVault));
      if (!library) return false;
      const same = this.snap.instanceId === instance && this.snap.vaultId === library.vaultId && this.snap.query === query;
      const targetPages = same ? pages : 1;
      let rows = append && same ? [...this.snap.rows] : [];
      let hasMore = false, lastPage = 1;
      for (let page = append && same ? targetPages : 1; page <= targetPages; page++) {
        const result = await this.replica.notes(instance, library.vaultId, query, page);
        if (epoch !== this.epoch || !this.live()) return true;
        if (result.items.some(row => row.instanceId !== instance || row.vaultId !== library.vaultId)) throw new Error("CONTENT_SOURCE_CHANGED");
        rows.push(...result.items.map(row => ({instanceId: instance, vaultId: library.vaultId, noteId: row.noteId,
          title: row.title || "无标题笔记", parentRelativePath: (row.relativePath || "").split("/").slice(0, -1).join("/"),
          revision: row.serverDocument?.revision || row.revision,
          searchHit: readableNoteSearchEvidence(query, row)})));
        hasMore = result.hasMore; lastPage = page;
        if (!hasMore) break;
      }
      this.replicaPage = lastPage; this.loadingMore = false;
      this.snap = {...EMPTY, replica: library, query, instanceId: instance, vaultId: library.vaultId, vaultName: library.name,
        phase: this.binding.connected ? "ready" : "offline", rows, hasMore, nextAfterId: hasMore ? String(lastPage) : null};
      this.emit();
      return true;
    } finally {
      if (this.activeEpoch === epoch) this.activeEpoch = 0;
      if (this.replicaRefreshPending) { this.replicaRefreshPending = false; this.revalidateReplica(); }
    }
  }

  /**
   * ORG-1B REPAIR-R1.1 (P1-8): the real move capability for the CURRENT
   * owner — the active vault's canonical write grant plus the live
   * `knowledge.move` operation state from the adopted catalog. Fail-closed
   * defaults: nothing is movable until both facts are proven.
   */
  moveAuthority(): { vaultId: string; vaultName: string; writeGranted: boolean; moveState: OperationState } {
    return {
      vaultId: this.moveVault?.vaultId ?? "",
      vaultName: this.moveVault?.vaultName ?? "",
      writeGranted: this.moveVault?.writeGranted === true,
      moveState: this.scopedRegistry().operation("knowledge.move").state,
    };
  }

  /**
   * ORG-1B REPAIR-R1.2 (P0-CURRENTNESS): apply a COMMITTED move to the
   * retained canonical rows — but ONLY when this controller's CURRENT
   * snapshot owner/vault is EXACTLY the receipt's original scope. A late
   * receipt from Desktop A converges A's cache (the Rust command is
   * A-scoped) yet must be a NO-OP for B's visible projection.
   *
   * REPAIR-R1.2 (P1-2): `parentRelativePath` is PARENT-ONLY by DTO — the
   * projection writes `newParent` EXACTLY (never a basename derivation) and
   * advances the canonical summary revision. Rows outside the snapshot (or a
   * foreign scope) are a no-op; the list never blanks.
   */
  applyMoveReceipt(instanceId: string, vaultId: string, noteId: string, newParent: string, newRevision: string): void {
    const snap = this.snap;
    if (snap.instanceId !== instanceId || snap.vaultId !== vaultId) return;
    if (snap.phase !== "ready" && snap.phase !== "loading-more") return;
    if (!snap.rows.some((r) => r.noteId === noteId)) return;
    const rows = snap.rows.map((row) => row.noteId === noteId
      ? { ...row, parentRelativePath: newParent, revision: newRevision || row.revision }
      : row);
    this.snap = { ...snap, rows };
    this.emit();
  }

  private clearTimer() {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
  }

  private live(): boolean {
    return Boolean(this.binding?.isLive());
  }

  private fail(epoch: number, message: unknown, keepRows?: Partial<KnowledgeBrowseSnapshot>): void {
    if (epoch !== this.epoch || !this.live()) return;
    // R1-REPAIR (3): classify canonical wire failures. A grant/auth revocation
    // must CLEAR the stale actionable rows and refresh the capability truth —
    // it is a permission fact, not a generic error.
    if (message instanceof ServicesError) {
      const code = message.code;
      if (code === "SOURCE_CHANGED") { keepRows = undefined; this.certified = null; this.discardScope(this.binding?.instanceId ?? "", this.selectedVault); }
      if (code === "GRANT_REQUIRED" || code === "AUTH_REVOKED" || code === "SCOPE_DENIED" || code === "PAIRING_REQUIRED") {
        this.epoch += 1;
        this.certified = null; // R1.5-C: a permission fact decertifies the fast path
        this.blockedScopes.add(this.permissionKey(this.binding?.instanceId ?? "", this.selectedVault));
        this.discardScope(this.binding?.instanceId ?? "", code === "AUTH_REVOKED" || code === "PAIRING_REQUIRED" ? undefined : this.selectedVault);
        this.scopedRegistry().invalidate();
        this.snap = {
          ...EMPTY, phase: "not-granted", query: this.query,
          instanceId: this.binding?.instanceId ?? "",
          remoteCode: code,
        };
        this.emit();
        return;
      }
      if (code === "SERVICE_UNAVAILABLE") {
        this.certified = null; // capability truth changed: re-certify on recovery
        this.snap = {
          ...EMPTY, ...keepRows, phase: "temporarily-unavailable", refreshing: false, stale: Boolean(keepRows?.rows?.length), query: this.query,
          instanceId: this.binding?.instanceId ?? "",
          remoteCode: code,
        };
        this.emit();
        return;
      }
      if (code === "VERSION_UNSUPPORTED") {
        this.discardScope(this.binding?.instanceId ?? "", this.selectedVault);
        this.certified = null; // capability truth changed: re-certify on recovery
        this.snap = {
          ...EMPTY, phase: "unsupported", query: this.query,
          instanceId: this.binding?.instanceId ?? "",
          remoteCode: code,
        };
        this.emit();
        return;
      }
    }
    this.snap = {
      ...EMPTY, ...keepRows, phase: "error", refreshing: false, stale: Boolean(keepRows?.rows?.length), query: this.query,
      instanceId: this.binding?.instanceId ?? "",
      errorCode: String((message as any)?.message ?? message).slice(0, 60),
      // Rows from a kept refresh survive a generic failure (truthful error
      // state + last-good rows), never blanked by a transient gateway error.
      rows: keepRows?.rows ?? [], vaultId: keepRows?.vaultId ?? "",
      vaultName: keepRows?.vaultName ?? "",
    };
    this.emit();
  }

  /**
   * ONE discovery path: registry catalog → the ACTIVE, read-granted vault →
   * registeredList page-1. Every step is fenced by the epoch; a grant/capability
   * failure lands as a truthful phase and clears stale actionable rows.
   */
  private async discoverAndList(query: string, epoch: number, keep?: KnowledgeBrowseSnapshot): Promise<void> {
    const b = this.binding;
    if (!b || !b.paired || !b.instanceId) return;
    this.activeEpoch = epoch;
    try {
      await this.discoverAndListInner(query, epoch, keep);
    } finally {
      // Only the newest owner of the flag may clear it (a superseding call
      // has already stamped its own epoch).
      if (this.activeEpoch === epoch) this.activeEpoch = 0;
    }
  }

  private async discoverAndListInner(query: string, epoch: number, keep?: KnowledgeBrowseSnapshot): Promise<void> {
    if (!this.selectionReadable) return;
    const b = this.binding;
    if (!b || !b.paired || !b.instanceId) return;
    const selectedVault = this.selectedVault;
    const registry = this.scopedRegistry(b.instanceId, selectedVault);
    const permissionKey = this.permissionKey(b.instanceId, selectedVault);
    if (this.replica && this.blockedScopes.has(permissionKey)) {
      // A saved replica is not permission proof after an observed revocation.
      if (!b.connected) { this.fail(epoch, new ServicesError("GRANT_REQUIRED", 403)); return; }
      try {
        await registry.refreshAdopting(b.instanceId, selectedVault ? { vault: selectedVault } : undefined);
        if (epoch !== this.epoch || !this.live()) return;
        const page = await this.knowledge.vaults(b.instanceId, selectedVault || undefined);
        if (epoch !== this.epoch || !this.live()) return;
        const allowed = page.items.find(v => selectedVault ? v.vaultId === selectedVault : v.activeInDesktop);
        if (!allowed?.readGranted || registry.operation("knowledge.registeredList").state !== "implemented") throw new ServicesError("GRANT_REQUIRED", 403);
        this.blockedScopes.delete(permissionKey);
      } catch (error) { this.fail(epoch, error); return; }
    }
    if (this.replica) {
      try {
        if (await this.readReplica(query, epoch, keep?.replica && keep.query === query ? this.replicaPage : 1)) {
          // Preserve the existing canonical move grant, but never use discovery
          // to silently change the persisted replica's vault or its list.
          const moveKey = `${b.instanceId}|${this.snap.vaultId}|${b.connected}`;
          if (b.connected && epoch === this.epoch && this.replicaMoveKey !== moveKey) {
            this.replicaMoveKey = moveKey;
            const moveToken = ++this.replicaMoveToken, scopeVault = this.snap.vaultId;
            void registry.refreshAdopting(b.instanceId, selectedVault ? {vault:selectedVault} : undefined).then(() => this.knowledge.vaults(b.instanceId, scopeVault)).then(page => {
              if (moveToken !== this.replicaMoveToken || this.replicaMoveKey !== moveKey || !this.live()
                || this.binding?.instanceId !== b.instanceId || !this.binding.connected || this.snap.vaultId !== scopeVault) return;
              const active = page.items.find(v => v.vaultId === scopeVault);
              this.moveVault = active ? {vaultId: active.vaultId, vaultName: active.displayName, writeGranted: active.writeGranted === true} : null;
              this.emit();
            }).catch(() => { if (moveToken === this.replicaMoveToken && this.replicaMoveKey === moveKey && this.live()) { this.moveVault = null; this.emit(); } });
          }
          if (!b.connected) this.replicaMoveKey = "";
          return;
        }
      } catch (error) { this.fail(epoch, error, keep); return; }
      if (!b.connected) return;
    }
    // R4.1: a kept (same-owner) snapshot rides along so a refresh can show
    // truthful progress phases WITHOUT dropping the last-good rows.
    let keepRows: Partial<KnowledgeBrowseSnapshot> = keep && keep.instanceId === b.instanceId && keep.query === query
      ? { ...keep, refreshing: true, loadingMore: false }
      : {};
    this.snap = { ...EMPTY, ...keepRows, query, phase: keep ? keep.phase : "waiting-catalog", instanceId: b.instanceId };
    this.emit();
    try {
      const catalog = await registry.refreshAdopting(b.instanceId, selectedVault ? {vault:selectedVault} : undefined);
      if (epoch !== this.epoch || !this.live()) return;
      // R1-REPAIR (3) + R2-REPAIR (3): canonical permission truth PER
      // OPERATION. `registry.operation(op).state` maps an operation MISSING
      // from the catalog to `unsupported` (fail-closed), so a required
      // operation that is absent never reaches the wire and never falls back
      // to a vault/list call.
      for (const op of ["knowledge.vaults", "knowledge.registeredList"] as const) {
        const state = registry.operation(op).state;
        if (state !== "implemented") {
          this.certified = null;
          this.moveVault = null;
          if (state === "notGranted" || state === "unsupported") { this.discardScope(b.instanceId, selectedVault); keepRows = {}; }
          this.snap = {
            ...EMPTY, ...keepRows, refreshing: false, stale: Boolean(keepRows.rows?.length), query, phase: phaseForOperation(state),
            instanceId: b.instanceId, remoteCode: "",
          };
          this.emit();
          return;
        }
      }
      this.snap = { ...EMPTY, ...keepRows, query, phase: keep ? keep.phase : "discovering-vault", instanceId: b.instanceId };
      this.emit();
      const vaultPage = await this.knowledge.vaults(b.instanceId, selectedVault || undefined);
      if (epoch !== this.epoch || !this.live()) return;
      const vaults = vaultPage?.items ?? [];
      const active = vaults.find((v) => selectedVault ? v.vaultId === selectedVault : v.activeInDesktop) ?? null;
      // The move authority's vault facts are recorded from the SAME
      // discovery that owns the rows (writeGranted is only ever the
      // canonical truth, never a default).
      this.moveVault = active
        ? {
            vaultId: active.vaultId,
            vaultName: active.displayName || "LuckyRay 知识库",
            writeGranted: active.writeGranted === true,
          }
        : null;
      if (!active) {
        this.certified = null;
        // An explicitly selected target missing from discovery is unavailable,
        // not a successful empty library. Otherwise the selected-vault view
        // fence turns this resolved, vault-less ready state into endless waiting.
        // Legacy discovery with no explicit choice still permits an empty result.
        this.snap = {
          ...EMPTY, query, phase: selectedVault ? "temporarily-unavailable" : "ready", instanceId: b.instanceId,
          remoteCode: "",
        };
        this.emit();
        return;
      }
      // R1-REPAIR (3): an active vault WITHOUT readGranted must not be listed.
      // Never call registeredList for it, never switch the Desktop's vault —
      // show the real permission state instead.
      if (!active.readGranted) {
        this.certified = null;
        this.discardScope(b.instanceId, active.vaultId);
        this.snap = {
          ...EMPTY, query, phase: "not-granted",
          instanceId: b.instanceId, vaultId: active.vaultId,
          vaultName: active.displayName || "LuckyRay 知识库",
          remoteCode: "GRANT_REQUIRED",
        };
        this.emit();
        return;
      }
      if (keepRows.vaultId !== active.vaultId) {
        // Newly discovered vault owns a different row set. A later 429 must
        // never bring the previous vault back under this new authority.
        this.certified = null;
        keepRows = { rows: [], vaultId: active.vaultId, vaultName: active.displayName || "LuckyRay 知识库" };
        keep = undefined; this.loadedPages = 1;
      }
      this.snap = {
        ...EMPTY, query, phase: keep ? keep.phase : "loading", refreshing: Boolean(keep), instanceId: b.instanceId,
        vaultId: active.vaultId, vaultName: active.displayName || "LuckyRay 知识库",
        // Rows from a kept refresh stay painted through the loading phase.
        rows: keepRows.rows ?? [], hasMore: keepRows.hasMore ?? false,
        nextAfterId: keepRows.nextAfterId ?? null,
      };
      this.emit();
      // Refresh the already-visible extent atomically, not just page one.
      // Otherwise a return from a scrolled page would shrink the list and jump.
      const rows: KnowledgeBrowseRow[] = [];
      let nextAfterId: string | null = null, hasMore = false, pages = 0;
      const extent = keep ? this.loadedPages : 1;
      for (; pages < extent;) {
        const page = await this.knowledge.registeredList(b.instanceId, active.vaultId, {
          q: query || undefined, limit: this.pageSize, afterId: nextAfterId ?? undefined,
        });
        if (epoch !== this.epoch || !this.live()) return;
        rows.push(...pageItems(b.instanceId, active.vaultId, active.displayName || "LuckyRay 知识库", page.items ?? []));
        pages += 1; nextAfterId = page.nextAfterId ?? null; hasMore = Boolean(page.hasMore);
        if (!hasMore || !nextAfterId) break;
      }
      this.loadedPages = pages; this.afterId = nextAfterId; this.loadingMore = false;
      this.snap = {
        ...this.snap, phase: "ready", refreshing: false, stale: false,
        rows, nextAfterId, hasMore, loadingMore: false, errorCode: "", remoteCode: "",
      };
      this.blockedScopes.delete(permissionKey);
      // R1.5-C: this owner+vault is now a CERTIFIED browse authority —
      // subsequent ordinary query changes take the single-list fast path.
      this.certified = {
        instanceId: b.instanceId,
        vaultId: active.vaultId,
        vaultName: active.displayName || "LuckyRay 知识库",
      };
      this.emit();
    } catch (error) {
      // R4.1: a kept refresh's GENERIC failure keeps the same-owner last-good
      // rows painted with the truthful error state (permission facts still
      // clear them through fail()'s own classification).
      this.fail(epoch, error, keepRows);
    }
  }
}

/** Canonical summaries → exact-identity rows, server order preserved. */
function pageItems(
  instanceId: string, vaultId: string, vaultName: string,
  items: Array<{ vaultId?: string; noteId: string; title?: string; parentRelativePath?: string; revision?: string }>,
): KnowledgeBrowseRow[] {
  if (items.some(n => n.vaultId && n.vaultId !== vaultId)) throw new Error("CONTENT_SOURCE_CHANGED");
  return items.map((n) => ({
    instanceId,
    vaultId: n.vaultId || vaultId,
    noteId: n.noteId,
    title: n.title || "无标题笔记",
    parentRelativePath: n.parentRelativePath || "",
    revision: n.revision || "",
  }));
  // `vaultName` intentionally unused per-row: the vault identity is carried by
  // the snapshot, not duplicated per row.
  void vaultName;
}
