// KNOWLEDGE-ORGANIZATION-R1 (ORG-1A) — the DIRECTORY-mode list authority.
//
// Two DELIBERATELY different Desktop Knowledge authorities (the card's hard
// rule): ALL NOTES stays on the #84 canonical Services pipeline; a NON-EMPTY
// directory selection switches to the already-accepted A0 / legacy Content V1
// `q + directory` authority — a live gateway query with a truthful offline
// note_cache prefix fallback — and NEVER to a local filter of the canonical
// rows. This controller owns exactly that directory mode:
//
//   - request identity = instanceId + vaultId + directory + query;
//   - the Content V1 PAGE model (page-N load more), not canonical afterId;
//   - `source: live | cache` provenance is surfaced, never relabeled;
//   - generation fencing: a stale A response (owner/vault/directory/query/
//     page) can never commit into B;
//   - cache-first: suspend() on leave fences in-flight work but KEEPS the
//     last-good snapshot; activate() repaints a same-identity snapshot with
//     zero requests, and restarts exactly one fresh page-1 otherwise;
//   - offline is truthful (no move queue, no fake live).

import { readableNoteSearchEvidence, type NoteSearchEvidence } from "./noteSearch.ts";
import type { OperationState } from "../../../shared/companion-services-v1/types.ts";

export type DirectoryRow = {
  searchHit?: NoteSearchEvidence;
  instanceId: string;
  vaultId: string;
  noteId: string;
  title: string;
  /** The note's current vault-relative path (metadata; the UI shows a preview). */
  relativePath: string;
  /** The Desktop body revision this row's metadata was observed at. */
  revision: string;
  /**
   * REPAIR-R1.1 (P1-6): the LATEST REMOTE metadata revision (the
   * serverDocument observation). This is the MOVE baseline — deliberately
   * separate from `revision`, which stays the cached-body baseline (#84
   * provenance: a metadata-only summary never re-labels the body).
   */
  remoteRevision: string;
  /** True while Mobile holds an unsynced local write (move is fail-closed). */
  dirty: boolean;
  /** True while the note has an unresolved conflict (move is fail-closed). */
  conflict: boolean;
  updatedAt?: string;
};

export type DirectoryPhase =
  | "idle" | "unpaired" | "offline"
  | "loading" | "loading-more" | "ready"
  | "not-granted" | "temporarily-unavailable" | "unsupported" | "error";

export type DirectorySnapshot = {
  refreshing?: boolean;
  stale?: boolean;
  phase: DirectoryPhase;
  instanceId: string;
  vaultId: string;
  directory: string;
  query: string;
  rows: DirectoryRow[];
  page: number;
  hasMore: boolean;
  /** Content V1 truth: did the last committed page come from the gateway. */
  source: "live" | "cache" | "";
  errorCode: string;
  /** The identity this snapshot was produced for (render gate input). */
  identity: string;
};

export type DirectoryIdentity = {
  instanceId: string;
  vaultId: string;
  directory: string;
  query: string;
};

export function directoryIdentityKey(id: DirectoryIdentity): string {
  return JSON.stringify(["dir", id.instanceId, id.vaultId, id.directory, id.query.trim()]);
}

const EMPTY: DirectorySnapshot = {
  phase: "idle", instanceId: "", vaultId: "", directory: "", query: "",
  rows: [], page: 0, hasMore: false, source: "", errorCode: "", identity: "",
};

export type DirectoryFetchPage = (
  instanceId: string, vaultId: string, q: string, page: number, directory: string,
) => Promise<{ items: any[]; hasMore: boolean; source?: "live" | "cache" }>;

export type DirectoryOwnerBinding = {
  paired: boolean;
  connected: boolean;
  /** Explicit selected S1 replica: the same Content reader is local online and offline. */
  localReplica?: boolean;
  instanceId: string;
  /** The write-grant truth for move; directory READ only needs content.read. */
  writeGranted: boolean;
  isLive: () => boolean;
};

export class KnowledgeDirectoryController {
  private epoch = 0;
  private binding: DirectoryOwnerBinding | null = null;
  private identityKey = "";
  private suspended = false;
  /** The live-request epoch (0 = none): activate() never double-starts. */
  private activeEpoch = 0;
  private replicaRefreshPending = false;
  private snap: DirectorySnapshot = EMPTY;
  private readonly retained = new Map<string, DirectorySnapshot>();
  private readonly cold = new Map<string, DirectorySnapshot>();
  private needsRevalidation = false;
  private readonly revisions = new Map<string, number>();
  private activeRevision = 0;
  private readonly scopeRevision: (instance: string, vault: string) => number;

  /** Render reads its exact scope before the effect commits the active owner. */
  snapshotFor(id: DirectoryIdentity): DirectorySnapshot {
    const key = directoryIdentityKey(id);
    const revision = this.scopeRevision(id.instanceId, id.vaultId);
    const valid = this.revisions.get(key) === revision;
    if (this.snap.identity === key && (valid || this.snap.page === 0)) return this.snap;
    const retained = valid ? this.retained.get(key) : undefined;
    if (retained) return retained;
    let cold = this.cold.get(key);
    if (!cold) {
      cold = { ...EMPTY, ...id, query: id.query.trim(), identity: key, phase: "loading" };
      this.cold.set(key, cold);
    }
    return cold;
  }

  invalidateScope(instance: string, vault?: string): void {
    for (const [key, snap] of this.retained) {
      if (snap.instanceId === instance && (vault === undefined || snap.vaultId === vault)) this.retained.delete(key);
    }
    if (this.snap.instanceId === instance && (vault === undefined || this.snap.vaultId === vault)) {
      ++this.epoch; this.clearTimer(); this.activeEpoch = 0; this.needsRevalidation = true;
      this.activeRevision = this.scopeRevision(this.snap.instanceId, this.snap.vaultId);
      this.snap = { ...this.snap, phase: "not-granted", rows: [], page: 0, hasMore: false, refreshing: false };
      this.emit();
    }
  }
  private readonly listeners = new Set<() => void>();
  private readonly pageSize: number;
  private readonly debounceMs: number;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private query = "";

  private readonly fetchPage: DirectoryFetchPage;

  constructor(
    fetchPage: DirectoryFetchPage,
    opts: { pageSize?: number; debounceMs?: number; scopeRevision?: (instance: string, vault: string) => number; subscribe?: (listener: () => void) => () => void } = {},
  ) {
    this.fetchPage = fetchPage;
    this.pageSize = opts.pageSize ?? 50;
    this.debounceMs = opts.debounceMs ?? 260;
    this.scopeRevision = opts.scopeRevision ?? (() => 0);
    opts.subscribe?.(() => {
      if (this.snap.identity && this.activeRevision !== this.scopeRevision(this.snap.instanceId, this.snap.vaultId)) {
        this.invalidateScope(this.snap.instanceId, this.snap.vaultId);
      }
      for (const [key, snapshot] of this.retained) {
        if (this.revisions.get(key) !== this.scopeRevision(snapshot.instanceId, snapshot.vaultId)) {
          this.invalidateScope(snapshot.instanceId, snapshot.vaultId);
        }
      }
    });
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    fn();
    return () => { this.listeners.delete(fn); };
  }

  snapshot(): DirectorySnapshot {
    return this.snap;
  }

  private emit(): void {
    if (this.snap.phase === "ready" && !this.snap.refreshing && this.snap.identity) {
      this.retained.set(this.snap.identity, this.snap);
      this.revisions.set(this.snap.identity, this.scopeRevision(this.snap.instanceId, this.snap.vaultId));
    }
    for (const fn of this.listeners) fn();
    if (this.replicaRefreshPending && this.activeEpoch !== this.epoch && !this.suspended) {
      this.replicaRefreshPending = false;
      queueMicrotask(() => this.revalidateReplica());
    }
  }

  /** The owner/vault feed. An identity change retires the snapshot. */
  setOwner(binding: DirectoryOwnerBinding): void {
    const prev = this.binding;
    this.binding = binding;
    this.suspended = false;
    if (!binding.paired || !binding.instanceId) {
      this.retained.clear();
      if (prev && (prev.paired || prev.instanceId)) {
        this.epoch += 1;
        this.snap = { ...EMPTY, phase: "unpaired" };
        this.emit();
      }
      return;
    }
    if (!prev || prev.instanceId !== binding.instanceId) {
      // Owner switch: full retire (A rows never render under B).
      this.epoch += 1;
      this.retireTo("loading", binding);
      return;
    }
    if (binding.localReplica && prev.connected !== binding.connected) {
      this.epoch += 1; this.clearTimer(); this.activeEpoch = 0;
      this.snap = {...this.snap, source: "cache", phase: this.snap.rows.length ? "ready" : "offline"};
      this.emit(); this.revalidateReplica();
      return;
    }
    // REPAIR-R1.1 (P1-4): the SAME owner dropping offline is a truth
    // transition. In-flight work is fenced, the rows are RETAINED, and the
    // live provenance degrades synchronously — a live label can never
    // outlive the connection that produced it.
    if (prev.connected && !binding.connected) {
      this.epoch += 1;
      this.clearTimer();
      this.activeEpoch = 0;
      if (this.snap.rows.length > 0) {
        this.snap = {
          ...this.snap,
          phase: "ready",
          source: "cache",
          hasMore: false,
          errorCode: "",
        };
      } else {
        this.snap = { ...this.snap, phase: "offline", hasMore: false };
      }
      this.emit();
      return;
    }
    // Same owner: an offline->online flip restarts exactly one fresh page-1
    // when the retained snapshot is not a same-identity READY page.
    if (prev.connected !== binding.connected && binding.connected) {
      this.activate();
    }
  }

  /** The vault feed (the active vault identity of the browse authority). */
  setVault(vaultId: string): void {
    if (vaultId === this.snap.vaultId) return;
    const b = this.binding;
    if (!b?.paired || !b.instanceId) return;
    this.epoch += 1;
    this.retireTo("loading", b, vaultId);
  }

  /** Selecting (or clearing) a directory is an identity change. */
  setDirectory(directory: string): void {
    const b = this.binding;
    if (!b?.paired || !b.instanceId) return;
    const dir = directory.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (dir === this.snap.directory) return;
    this.epoch += 1;
    this.retireTo("loading", b, undefined, dir);
  }

  /** The visible query (debounced). ALL-NOTES canonical q is a different path. */
  setQuery(q: string): void {
    const trimmed = q.trim();
    if (trimmed === this.query) return;
    this.query = trimmed;
    const b = this.binding;
    if (!b?.paired || !b.instanceId) return;
    this.epoch += 1;
    this.clearTimer();
    const identity = this.currentKey();
    this.snap = this.retained.get(identity) ?? { ...this.snap, identity, query: trimmed, rows: [], page: 0, hasMore: false, phase: "loading" };
    this.needsRevalidation = true;
    this.emit();
    // REPAIR-R1.1: while offline the truthful projection is the V1 cache
    // fallback (never a live query debounce that pretends freshness).
    if (!b.connected) {
      this.runOffline(b, this.snap.vaultId, this.snap.directory);
      return;
    }
    this.debounce = setTimeout(() => {
      if (this.suspended) return;
      this.startPage1(b);
    }, this.debounceMs);
  }

  /** Leaving the source / root unmount: fence, keep the snapshot. */
  suspend(): void {
    this.epoch += 1;
    this.clearTimer();
    this.suspended = true;
    this.replicaRefreshPending = false;
  }

  /** Returning: same-identity READY repaints with ZERO requests. */
  activate(): void {
    this.suspended = false;
    const b = this.binding;
    if (!b?.paired || !b.instanceId) return;
    // ROOT ("") is the ALL-NOTES canonical authority — this controller owns
    // DIRECTORY mode only and must never issue a legacy all-notes query.
    if (!this.snap.directory) return;
    if (this.activeEpoch === this.epoch && this.epoch > 0) return; // live request
    const snap = this.snap;
    if (!this.needsRevalidation && b.localReplica && snap.phase === "ready" && snap.identity === this.currentKey()) return;
    // Cache-first ONLY for a snapshot the gateway actually produced while
    // live: an offline-degraded or cache-origin page must re-prove itself on
    // reconnect (one fresh page-1), never keep a cached label as truth.
    if (!this.needsRevalidation && b.connected && snap.phase === "ready" && snap.source === "live"
      && snap.identity === this.currentKey()) {
      return; // cache-first
    }
    if (!b.connected) {
      if (this.needsRevalidation || snap.page === 0) {
        this.needsRevalidation = false;
        if (b.localReplica && snap.page > 0) this.revalidateReplica();
        else this.runOffline(b, snap.vaultId, snap.directory);
      }
      return;
    }
    this.startPage1(b, snap.identity === this.currentKey() && snap.page > 0 ? snap.rows : undefined);
  }

  /** Content V1 page-N load more (never canonical afterId). */
  loadMore(): void {
    const b = this.binding;
    if (!b?.paired || !b.instanceId || (!b.connected && !b.localReplica)) return;
    const snap = this.snap;
    if (snap.phase !== "ready" || !snap.hasMore || this.activeEpoch === this.epoch) return;
    const page = snap.page + 1;
    const epoch = ++this.epoch;
    this.activeEpoch = epoch;
    const revision = this.scopeRevision(b.instanceId, snap.vaultId); this.activeRevision = revision;
    const identity = this.currentKey();
    this.snap = { ...snap, phase: "loading-more" };
    this.emit();
    void this.fetchPage(b.instanceId, snap.vaultId, snap.query, page, snap.directory)
      .then((r) => {
        if (epoch !== this.epoch || !this.live() || revision !== this.scopeRevision(b.instanceId, snap.vaultId)) return;
        const rows = [...snap.rows, ...toRows(b.instanceId, snap.vaultId, r.items ?? [], snap.query)];
        this.activeEpoch = 0;
        this.snap = {
          ...this.snap, phase: "ready", rows, page,
          hasMore: Boolean(r.hasMore),
          source: r.source === "cache" || snap.source === "cache" ? "cache" : "live",
          identity,
        };
        this.emit();
      })
      .catch((error: unknown) => {
        if (epoch !== this.epoch || !this.live() || revision !== this.scopeRevision(b.instanceId, snap.vaultId)) return;
        this.activeEpoch = 0;
        this.fail(error, this.snap);
      });
  }

  /**
   * A committed move receipt applied by the page (row projection update).
   *
   * REPAIR-R1.2 (P0-CURRENTNESS): scoped to the receipt's ORIGINAL
   * instance+vault — a late receipt from Desktop A is a NO-OP for B's
   * current directory projection (A's Mobile cache converges via the
   * A-scoped Rust command instead).
   *
   * REPAIR-R1.2 (P1-3): membership reasons from the DESTINATION parent vs
   * the CURRENT directory (never the old row path): while viewing D the
   * moved row stays visible iff destination parent == D or starts with
   * `D + "/"` — so Work→ROOT and Work→Docs leave the Work view, while
   * Work→Work/Sub stays.
   */
  applyMoveReceipt(instanceId: string, vaultId: string, noteId: string, newParent: string, newRevision = ""): void {
    const snap = this.snap;
    if (snap.instanceId !== instanceId || snap.vaultId !== vaultId) return;
    if (snap.phase !== "ready" && snap.phase !== "loading-more") return;
    const dir = snap.directory;
    const stays = newParent === dir
      || (dir !== "" && newParent.startsWith(dir + "/"));
    const prefix = newParent ? newParent + "/" : "";
    const rows = snap.rows
      .filter((row) => row.noteId !== noteId || stays)
      .map((row) => row.noteId === noteId
        ? {
            ...row,
            relativePath: prefix + basename(row.relativePath),
            // The committed move's revision is the latest REMOTE observation;
            // the cached-body `revision` baseline is never re-labeled.
            remoteRevision: newRevision || row.remoteRevision,
          }
        : row);
    this.snap = { ...snap, rows };
    this.emit();
  }

  /** A manual refresh: stale-while-revalidate page-1 for the CURRENT identity. */
  refresh(): void {
    if (this.binding?.localReplica) { this.revalidateReplica(); return; }
    const b = this.binding;
    if (!b?.paired || !b.instanceId || !b.connected) return;
    this.startPage1(b, this.snap.rows);
  }

  /** S1 cache revalidation preserves every loaded directory page and visible position. */
  revalidateReplica(): void {
    const b = this.binding, snap = this.snap;
    if (!b?.localReplica || !b.paired || !b.instanceId || !snap.vaultId || !snap.directory || this.suspended || !this.live()) return;
    if (this.activeEpoch === this.epoch && this.epoch > 0) { this.replicaRefreshPending = true; return; }
    const epoch = ++this.epoch;
    this.activeEpoch = epoch;
    const revision = this.scopeRevision(b.instanceId, snap.vaultId); this.activeRevision = revision;
    void (async () => {
      const rows: DirectoryRow[] = [];
      let page = 1, hasMore = false;
      for (; page <= Math.max(1, snap.page); page++) {
        const result = await this.fetchPage(b.instanceId, snap.vaultId, snap.query, page, snap.directory);
        if (epoch !== this.epoch || !this.live() || revision !== this.scopeRevision(b.instanceId, snap.vaultId)) return;
        rows.push(...toRows(b.instanceId, snap.vaultId, result.items ?? [], snap.query));
        hasMore = Boolean(result.hasMore);
        if (!hasMore) break;
      }
      if (epoch !== this.epoch || !this.live() || revision !== this.scopeRevision(b.instanceId, snap.vaultId)) return;
      this.activeEpoch = 0;
      this.snap = {...snap, phase: "ready", rows, page: Math.min(page, Math.max(1, snap.page)), hasMore, source: "cache", errorCode: ""};
      this.emit();
    })().catch(error => {
      if (epoch !== this.epoch || !this.live() || revision !== this.scopeRevision(b.instanceId, snap.vaultId)) return;
      this.activeEpoch = 0;
      this.fail(error, snap);
    });
  }

  private currentKey(): string {
    const b = this.binding;
    return b
      ? directoryIdentityKey({ instanceId: b.instanceId, vaultId: this.snap.vaultId, directory: this.snap.directory, query: this.query })
      : "";
  }

  private live(): boolean {
    return Boolean(this.binding?.isLive());
  }

  private clearTimer(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
  }

  private retireTo(
    phase: DirectoryPhase,
    b: DirectoryOwnerBinding,
    vaultId?: string,
    directory?: string,
  ): void {
    this.clearTimer();
    const vault = vaultId ?? this.snap.vaultId;
    const dir = directory ?? this.snap.directory;
    const identity = directoryIdentityKey({ instanceId: b.instanceId, vaultId: vault, directory: dir, query: this.query });
    this.snap = this.retained.get(identity) ?? {
      ...EMPTY, phase, instanceId: b.instanceId, vaultId: vault,
      directory: dir, query: this.query, identity,
    };
    this.needsRevalidation = true;
    this.activeRevision = this.scopeRevision(b.instanceId, vault);
    this.emit();
    // The complete owner/vault/directory feed is committed before activate
    // issues a read, offline too. Intermediate scopes never reach the wire.
    // Connected: activate() owns THE single start — the page feeds
    // owner/vault/directory and then activates once, so an identity feed
    // can never triple-fire page-1.
  }

  /** Offline truth: the V1 command's cache fallback, labeled cache. */
  private runOffline(b: DirectoryOwnerBinding, vault: string, dir: string): void {
    if (!vault || !dir) return;
    const epoch = this.epoch;
    this.activeEpoch = epoch;
    const revision = this.scopeRevision(b.instanceId, vault); this.activeRevision = revision;
    const identity = this.currentKey();
    void this.fetchPage(b.instanceId, vault, this.query, 1, dir)
      .then((r) => {
        if (epoch !== this.epoch || !this.live() || revision !== this.scopeRevision(b.instanceId, vault)) return;
        this.activeEpoch = 0;
        this.snap = {
          ...this.snap, phase: "ready",
          rows: toRows(b.instanceId, vault, r.items ?? [], this.query),
          page: 1, hasMore: Boolean(r.hasMore),
          source: r.source === "live" ? "live" : "cache",
          identity,
        };
        this.emit();
      })
      .catch(() => {
        if (epoch !== this.epoch || revision !== this.scopeRevision(b.instanceId, vault)) return;
        this.activeEpoch = 0;
        this.snap = { ...this.snap, phase: "offline" };
        this.emit();
      });
  }

  private fail(error: unknown, keep: DirectorySnapshot): void {
    const code = String((error as { code?: string })?.code ?? brief(error));
    const status = Number((error as { status?: number })?.status);
    if (status === 401 || status === 403 || /GRANT_REQUIRED|AUTH_REVOKED|SCOPE_DENIED|PAIRING_REQUIRED|CONTENT_READ_NOT_GRANTED|CONTENT_NOT_GRANTED|UNAUTHORIZED|FORBIDDEN|HTTP[_ :/-]*(401|403)\b/i.test(code)) {
      this.invalidateScope(keep.instanceId, status === 401 || /AUTH_REVOKED|PAIRING_REQUIRED|UNAUTHORIZED|HTTP[_ :/-]*401\b/i.test(code) ? undefined : keep.vaultId);
      return;
    }
    this.snap = { ...keep, phase: keep.page > 0 ? "ready" : "error", refreshing: false, stale: keep.page > 0, errorCode: brief(error) };
    this.emit();
  }

  private startPage1(b: DirectoryOwnerBinding, keepRows?: DirectoryRow[]): void {
    this.clearTimer(); this.needsRevalidation = false;
    const epoch = ++this.epoch;
    this.activeEpoch = epoch;
    const vault = this.snap.vaultId, dir = this.snap.directory;
    if (!vault || !dir) { this.activeEpoch = 0; return; }
    const revision = this.scopeRevision(b.instanceId, vault); this.activeRevision = revision;
    const identity = this.currentKey();
    const keep = this.snap.identity === identity && this.snap.page > 0 && keepRows !== undefined ? this.snap : undefined;
    this.snap = {
      ...EMPTY, ...keep,
      phase: keep ? "ready" : "loading", refreshing: Boolean(keep), instanceId: b.instanceId, vaultId: vault,
      directory: dir, query: this.query, identity,
    };
    const pending = this.snap;
    this.emit();
    void (async () => {
      const rows: DirectoryRow[] = [];
      let page = 0, hasMore = false, sawCache = false;
      const extent = Math.max(1, keep?.page ?? 1);
      while (page < extent) {
        const result = await this.fetchPage(b.instanceId, vault, pending.query, page + 1, dir);
        if (epoch !== this.epoch || !this.live() || revision !== this.scopeRevision(b.instanceId, vault)) return;
        rows.push(...toRows(b.instanceId, vault, result.items ?? [], pending.query));
        page += 1; hasMore = Boolean(result.hasMore);
        sawCache = result.source === "cache" || sawCache;
        if (!hasMore) break;
      }
      if (epoch !== this.epoch || !this.live() || revision !== this.scopeRevision(b.instanceId, vault)) return;
      this.activeEpoch = 0;
      this.snap = { ...pending, phase: "ready", refreshing: false, stale: false, rows, page, hasMore, source: sawCache ? "cache" : "live", errorCode: "" };
      this.emit();
    })().catch((error: unknown) => {
      if (epoch !== this.epoch || !this.live() || revision !== this.scopeRevision(b.instanceId, vault)) return;
      this.activeEpoch = 0;
      this.fail(error, keep ?? pending);
    });
  }

}

function toRows(instanceId: string, vaultId: string, items: any[], query = ""): DirectoryRow[] {
  const rows: DirectoryRow[] = [];
  for (const n of items) {
    if (!n || n.deleted) continue;
    if ((n.instanceId && n.instanceId !== instanceId) || (n.vaultId && n.vaultId !== vaultId)) throw new Error("CONTENT_SOURCE_CHANGED");
    const noteId = n.noteId || n.note_id || "";
    if (!noteId) continue;
    rows.push({
      searchHit: readableNoteSearchEvidence(query, n),
      instanceId,
      vaultId: n.vaultId || vaultId,
      noteId,
      title: n.title || "无标题笔记",
      relativePath: n.relativePath || n.relative_path || "",
      // The cached-BODY baseline (#84 provenance — never the move baseline).
      revision: n.revision || "",
      // The latest remote metadata observation = the MOVE baseline.
      remoteRevision: n.serverDocument?.revision || "",
      dirty: Boolean(n.dirty),
      conflict: Boolean(n.conflictDocument),
      updatedAt: n.updatedAt || n.updated_at || undefined,
    });
  }
  return rows;
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

function brief(error: unknown): string {
  return String((error as any)?.message ?? error).slice(0, 60);
}

/** Map a canonical grant state to the move affordance truth. */
export function movePhaseForOperation(state: OperationState): "ready" | "not-granted" | "temporarily-unavailable" | "unsupported" {
  switch (state) {
    case "notGranted": return "not-granted";
    case "temporarilyUnavailable": return "temporarily-unavailable";
    case "unsupported": return "unsupported";
  }
  return "ready";
}
