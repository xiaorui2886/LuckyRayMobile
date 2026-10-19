// SERVICES-KNOWLEDGE-BROWSE-R1 REPAIR-R4.1 — the session-level Knowledge
// retention layer.
//
// R4 made the two authorities session singletons, but the review found the
// retention was incomplete and unsafe at the edges:
//
//   P0-A1 — the page read the retained Desktop snapshot during render, so
//           session-retained A rows could paint under a CURRENT Desktop B for
//           the first frame (the owner fence only ran in a post-paint effect).
//   P1-A2 — leaving a source still DESTROYED its last-good snapshot
//           (pager.enterDesktop/invalidate; desktop setConnection(unpaired)).
//   P1-A3 — the desktopVersion "first signal" guard was component-local, so a
//           vault/version drift while Knowledge was unmounted was missed.
//   (B5)  — the preview store was page state, so a return flashed
//           正文尚未缓存 before the retained previews came back.
//
// This module owns ALL of that at session level:
//
//   - `desktopViewFor(current)` is a SYNCHRONOUS render-time owner gate: the
//     retained snapshot is renderable only when its instanceId IS the current
//     connected/pairing instance; otherwise a stable per-instance cold
//     snapshot is returned (zero old-owner rows, truthful waiting phase).
//   - `PreviewRetainer` keeps preview stores keyed by exact instance|vault
//     with per-key request tokens (a stale load can never overwrite a newer
//     identity's store).
//   - `noteDesktopVersionSeen(v)` is the session-level currentness memory:
//     the first observation is recorded; a LATER drift (including one that
//     happened while Knowledge was unmounted) is reported so the page can
//     trigger one bounded rediscovery.
//
// Dependencies are injectable so behavior tests drive the REAL controllers
// and retainers with fakes — no production singleton is touched by tests.

import { LocalNotesPager } from "../../services/knowledgeNotesPager.ts";
import {
  KnowledgeBrowseController, type KnowledgeBrowseSnapshot,
} from "./knowledgeBrowseController.ts";
import type { ServiceRegistry } from "../../services/companionServices/serviceRegistry.ts";
import type { KnowledgeClient } from "../../services/companionServices/knowledgeClient.ts";
import { createProductionServices } from "../../services/companionServices/index.ts";
import { api } from "../../services/client.ts";
import type { KnowledgeReplicaReader } from "../../services/knowledgeReplica.ts";
import { toast } from "../../services/toast.ts";
import { failureCopy } from "../../services/feedback.ts";
import { loadPreviewStore, previewStoreKey, type PreviewStore } from "./notePreview.ts";
import { createKnowledgeNavigationReader, type KnowledgeNavigationReader } from "../../services/knowledgeNavigationReader.ts";
import { KnowledgeFolderCatalog } from "./knowledgeFolderCatalog.ts";
import { KnowledgeDirectoryController } from "./knowledgeDirectoryController.ts";
import { DesktopTransientProjection } from "./desktopProjection.ts";
import { createKnowledgeEditingEffects } from "../../services/knowledgeEditingEffects.ts";
import type { EditingEffects, EditingScope } from "../../services/knowledgeEditingSession.ts";
import {
  KnowledgeOrganizationController, resolveMoveAuthority,
  type MoveAuthority, type MoveDeps,
} from "./knowledgeOrganizationController.ts";

export type PreviewReader = (
  instance: string,
  vault: string,
  ids: string[],
) => Promise<PreviewStore>;

/** The production preview reader: the local-only bulk command (zero Desktop network). */
export const productionPreviewReader: PreviewReader = (instance, vault, ids) =>
  loadPreviewStore(instance, vault, ids);

export type DesktopOwnerView = { paired: boolean; connected: boolean; instanceId: string };

/** A stable cold snapshot per (instanceId, phase) — first-frame truth, no old rows. */
function coldSnapshotFor(instanceId: string, phase: "waiting-catalog" | "offline" | "unpaired"): KnowledgeBrowseSnapshot {
  return {
    phase, instanceId, vaultId: "", vaultName: "",
    query: "", rows: [], nextAfterId: null, hasMore: false,
    loadingMore: false, errorCode: "", remoteCode: "",
    certifiedVersion: null,
  };
}

/**
 * Retains preview stores by exact `instance|vault`, owner-fenced per key:
 * a load for a superseded key (or an older token of the same key) can never
 * overwrite a newer store. Reads are synchronous and reference-stable, so a
 * return to the same identity repaints previews with NO 正文尚未缓存 flash.
 */
export class PreviewRetainer {
  private stores = new Map<string, PreviewStore>();
  private tokens = new Map<string, number>();
  /**
   * R4.2 (P2-PERF): the REQUESTED id set per key, tracked separately from
   * `byNoteId` — the local DB projection intentionally omits ids with no
   * cached body, so "covered" must include the known-missing ids or every
   * remount would re-read the DB for the same page.
   * R4.3 (P1-R42-4): each coverage also records the note-cache FRESHNESS it
   * was loaded under; a freshness bump (a note detail refresh just cached a
   * body) invalidates the coverage so the current page may re-read ONCE —
   * a newly cached body replaces 正文尚未缓存 — and unchanged freshness
   * stays zero-read.
   */
  private covered = new Map<string, { ids: string[]; freshness: number }>();
  private listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** The retained store for exactly this owner (null = never loaded). */
  snapshotFor(instance: string, vault: string): PreviewStore | null {
    return this.stores.get(previewStoreKey(instance, vault)) ?? null;
  }

  /**
   * Ensure the store for (instance, vault) covers `ids`. Loads through the
   * injected reader when the retained store is missing or its id set differs;
   * a no-op when the exact ids are already retained.
   */
  ensure(instance: string, vault: string, ids: string[], reader: PreviewReader, freshness = 0): void {
    if (!instance || !vault || ids.length === 0) return;
    const key = previewStoreKey(instance, vault);
    // Coverage is the REQUESTED set (including known-missing ids) UNDER the
    // current note-cache freshness: the exact same page after a remount is a
    // NO-OP with zero DB re-reads; a freshness bump allows ONE re-read.
    const covered = this.covered.get(key);
    if (covered && covered.freshness === freshness && sameIdSet(covered.ids, ids)) return;
    const token = (this.tokens.get(key) ?? 0) + 1;
    this.tokens.set(key, token);
    this.covered.set(key, { ids: [...ids], freshness });
    void reader(instance, vault, ids).then((store) => {
      // Owner fence: a newer ensure for this key must win; a stale resolution
      // is dropped whole.
      if (this.tokens.get(key) !== token) return;
      this.stores.set(key, store);
      this.emit();
    }).catch(() => {
      // The failed ensure still COVERS its ids (the read is deterministic
      // local DB): without this, a permanently-failing read would retry on
      // every remount. A different id set still reloads.
      if (this.tokens.get(key) === token) this.emit();
    });
  }
}

function sameIdSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  for (const x of b) if (!set.has(x)) return false;
  return true;
}

export type KnowledgeSessionDeps = {
  registry: ServiceRegistry;
  knowledge: KnowledgeClient;
  previewReader: PreviewReader;
  replica?: KnowledgeReplicaReader;
};

/**
 * R4.4 (P1-R43-1): the synchronous-gate input is identity + connection ONLY.
 * The coarse Desktop-domain `dataStore` version is NOT a vault-currentness
 * signal (every sync/note/material/cache commit bumps it), so it must never
 * gate the retained list. Canonical list refresh stays owned by owner/pairing
 * changes, connection flips, query changes, and the explicit user Refresh.
 */
export type DesktopGateInput = DesktopOwnerView;

/** Retained Knowledge UI request identity (R4.2 P1-A6 + ORG-1A). */
export type KnowledgeUiState = {
  /** The shared search text (both sources). */
  query: string;
  /** The Local applied filter identity (mode/sort/tag). */
  localFilter: { mode: string; sort: string; tag: string };
};

export type KnowledgeSession = {
  folders: KnowledgeFolderCatalog;
  navigation: KnowledgeNavigationReader;
  editingEffects(opts: { isLive: (scope: EditingScope) => boolean; observe: EditingEffects["observe"] }): EditingEffects;
  pager: LocalNotesPager;
  desktop: KnowledgeBrowseController;
  /** ORG-1A: the DIRECTORY-mode Content V1 list authority (session-retained). */
  directory: KnowledgeDirectoryController;
  /** ORG-1B: the note-move authority (single + bounded batch). */
  organization: KnowledgeOrganizationController;
  /**
   * ORG-1A REPAIR-R1.1 (P1-5): the retained directory for the CURRENT owner
   * scope, read from a scope-keyed map SYNCHRONOUSLY every render (a
   * different Desktop/vault gets "" — ROOT — never another scope's pick).
   */
  retainedDirectoryFor(instanceId: string, vaultId: string): string;
  /** ORG-1A: retain the directory under the exact owner scope. */
  retainDirectory(instanceId: string, vaultId: string, directory: string): void;
  /**
   * ORG-1B REPAIR-R1.1 (P1-3): move deps over the ONE injected Services
   * client (`deps.knowledge.move`) — never a second transport/client — plus
   * the Mobile-local metadata receipt command. The page supplies only the
   * liveness fence and the visible-projection hook.
   */
  moveDeps(opts: { isLive: () => boolean; onCommitted?: MoveDeps["onCommitted"] }): MoveDeps;
  /**
   * ORG-1B REPAIR-R1.1 (P1-8): resolve the real move authority (active vault
   * write grant + knowledge.move operation state) through the SAME injected
   * registry/client. Fail-closed.
   */
  resolveMoveAuthority(instanceId: string): Promise<MoveAuthority>;
  previews: PreviewRetainer;
  /**
   * The SYNCHRONOUS render-time Desktop gate (R4.1 P0-A1 + R4.2 P1-A5 +
   * R4.4 P1-R43-1):
   *   - unpaired                 -> unpaired cold snapshot;
   *   - another instance         -> waiting cold snapshot for the CURRENT one;
   *   - paired but disconnected  -> truthful OFFLINE (retained rows stay
   *                                  painted as cached content, never live ready);
   *   - exact owner + connected  -> the retained snapshot itself.
   *
   * R4.4: a generic dataStore bump (note detail exit/edit, sync, material,
   * cache) is deliberately NOT part of this gate — it is note-cache freshness
   * for PREVIEWS only and never blanks the list.
   */
  desktopViewFor(current: DesktopGateInput): KnowledgeBrowseSnapshot;
  // --- Retained Knowledge UI identity (R4.2 P1-A6) ---
  ui: KnowledgeUiState;
  // --- Local data-version memory (R4.2 + R4.3 P1-R42-2) ---
  /** Observe the current Local data version; never consumes (safe anywhere). */
  observeLocalDataVersion(v: number): void;
  /** True when the version differs from the certified one (pending drift). */
  localDriftPending(): boolean;
  /** Mark the pending drift as actioned (one rows-retained revalidate follows). */
  markLocalDriftActioned(): void;
  /** Certify the current Local version (after acting, or on first load). */
  certifyLocalDataVersion(v: number): void;
  /**
   * R4.3 (P1-R42-4): the coarse Desktop-domain note-cache freshness signal
   * (dataStore version). Preview coverage is only valid while this is
   * unchanged; a bump (a note detail refresh/edit cached a body) allows ONE
   * bounded local re-read for the current page.
   */
  observeNoteCacheVersion(v: number): void;
  /** The last-observed note-cache freshness signal. */
  noteCacheVersion(): number;
  /** The injected preview reader (the production one is local-only). */
  readonly previewReader: PreviewReader;
  /**
   * R1.6-B: the TRANSIENT Mobile Desktop-note projection (create/edit
   * visibility before the canonical list converges). Session-scoped,
   * exact-instance|vault keyed, subscribe-able.
   */
  projection: DesktopTransientProjection;
};

export function createKnowledgeSession(deps: KnowledgeSessionDeps): KnowledgeSession {
  const pager = new LocalNotesPager(
    (f) =>
      api.localNoteList({
        q: f.q,
        tag: f.tag,
        pinned: f.pinned,
        favorite: f.favorite,
        archived: f.archived,
        sort: f.sort,
        page: f.page,
        limit: f.limit,
      }),
    (e) => toast.error(failureCopy(e, "读取本地笔记失败。"))
  );
  const desktop = new KnowledgeBrowseController({
    registry: deps.registry,
    knowledge: deps.knowledge,
    replica: deps.replica,
  });
  const previews = new PreviewRetainer();
  // Cold snapshots cached per (instanceId|phase) so the gate returns stable
  // references (useSyncExternalStore requires identity-stable snapshots).
  const coldByInstance = new Map<string, KnowledgeBrowseSnapshot>();
  // R4.3: identity-stable synthetic projections (keyed by owner + source
  // snapshot object; one entry per owner is enough — a newer source object
  // replaces it).
  const offlineProjection = new Map<string, { source: KnowledgeBrowseSnapshot; value: KnowledgeBrowseSnapshot }>();
  const coldFor = (instanceId: string, phase: "waiting-catalog" | "offline" | "unpaired"): KnowledgeBrowseSnapshot => {
    const key = `${instanceId}|${phase}`;
    let cold = coldByInstance.get(key);
    if (!cold) { cold = coldSnapshotFor(instanceId, phase); coldByInstance.set(key, cold); }
    return cold;
  };
  let lastSeenLocalVersion: number | null = null;
  let certifiedLocalVersion: number | null = null;
  let localDriftActioned = false;
  let lastNoteCacheVersion = 0;
  const ui: KnowledgeUiState = { query: "", localFilter: { mode: "local", sort: "recent", tag: "" } };
  // ORG-1A REPAIR-R1.1 (P1-5): the retained directory per EXACT
  // `instance|vault` scope. A scope-keyed map + synchronous getter — the
  // visible directory can never inherit another Desktop/vault's pick, even
  // for one frame, because every render reads its OWN scope's entry.
  const directoryByScope = new Map<string, string>();

  // ORG-1A: the directory authority over the real Content V1 command.
  const directory = new KnowledgeDirectoryController(
    (instanceId, vaultId, q, page, dir) =>
      api.contentNotes(instanceId, vaultId, q, page, dir),
  );
  // ORG-1B: the move authority (deps arrive per call through moveDeps —
  // the ONE injected Services client, never a second transport).
  const organization = new KnowledgeOrganizationController();
  // R1.6-B: the transient Desktop-note projection (UI/session only).
  const projection = new DesktopTransientProjection();

  let folderStorage: Storage | undefined;
  try { folderStorage = typeof localStorage !== "undefined" ? localStorage : undefined; } catch { /* WebView storage may be disabled */ }
  const navigation = createKnowledgeNavigationReader(deps.knowledge, deps.registry);
  const folders = new KnowledgeFolderCatalog(navigation,
    async (instance, vault) => (await api.contentNoteDirectories(instance, vault)).directories, folderStorage);

  return {
    folders,
    navigation,
    editingEffects(opts) { return createKnowledgeEditingEffects({ ...deps, ...opts }); },
    pager,
    desktop,
    directory,
    organization,
    projection,
    retainedDirectoryFor(instanceId: string, vaultId: string): string {
      return directoryByScope.get(`${instanceId}|${vaultId}`) ?? "";
    },
    retainDirectory(instanceId: string, vaultId: string, dirValue: string): void {
      directoryByScope.set(`${instanceId}|${vaultId}`, dirValue);
    },
    moveDeps(opts: { isLive: () => boolean; onCommitted?: MoveDeps["onCommitted"] }): MoveDeps {
      return {
        move: (instanceId, noteId, input) => deps.knowledge.move(instanceId, noteId, input),
        applyReceipt: (instanceId, vaultId, noteId, revision, parentRelativePath) =>
          api.contentNoteMoveReceipt(instanceId, vaultId, noteId, revision, parentRelativePath),
        isLive: opts.isLive,
        onCommitted: opts.onCommitted,
      };
    },
    resolveMoveAuthority(instanceId: string): Promise<MoveAuthority> {
      return resolveMoveAuthority({ registry: deps.registry, knowledge: deps.knowledge }, instanceId);
    },
    previews,
    previewReader: deps.previewReader,
    ui,
    desktopViewFor(current: DesktopGateInput): KnowledgeBrowseSnapshot {
      const snap = desktop.snapshot();
      if (!current.paired || !current.instanceId) {
        return coldFor("", "unpaired");
      }
      if (snap.instanceId !== current.instanceId) {
        return coldFor(current.instanceId, current.connected ? "waiting-catalog" : "offline");
      }
      // Same owner. Connection truth first: a retained ready snapshot is
      // shown OFFLINE (rows = cached content with the truthful status line),
      // never as live ready while the ws is down. R4.3 (P1-R42-1): the
      // synthetic projection is CACHED keyed by the source snapshot object +
      // phase, so repeated getSnapshot reads without a store change return
      // the SAME reference (React's getSnapshot contract); a real controller
      // change produces a new source object and therefore a new projection.
      if (!current.connected) {
        if (snap.phase === "ready" || snap.replica) {
          const pkey = `offline|${snap.instanceId}`;
          const cached = offlineProjection.get(pkey);
          if (cached && cached.source === snap) return cached.value;
          const value = { ...snap, phase: "offline" as const };
          offlineProjection.set(pkey, { source: snap, value });
          return value;
        }
        return coldFor(current.instanceId, "offline");
      }
      return snap;
    },
    observeLocalDataVersion(v: number): void {
      lastSeenLocalVersion = v;
    },
    localDriftPending(): boolean {
      return certifiedLocalVersion !== null && lastSeenLocalVersion !== certifiedLocalVersion && !localDriftActioned;
    },
    markLocalDriftActioned(): void {
      localDriftActioned = true;
    },
    certifyLocalDataVersion(v: number): void {
      certifiedLocalVersion = v;
      localDriftActioned = false;
    },
    observeNoteCacheVersion(v: number): void {
      lastNoteCacheVersion = v;
    },
    noteCacheVersion(): number {
      return lastNoteCacheVersion;
    },
  };
}

// The production singleton (Mobile session scope). Constructed once; the
// Knowledge root's mounts/unmounts only subscribe/unsubscribe.
const productionServices = createProductionServices();
export const knowledgeChangeFeed = productionServices.changeFeed;
/** Hints invalidate only the registry owning this exact connected Desktop. */
export function knowledgePermissionsChanged(instance: string, revision: number) {
  const catalog = productionServices.registry.snapshot();
  if (!catalog || catalog.desktopInstanceId === instance) productionServices.registry.invalidateForPermissionRevision(revision);
}
const productionSession = createKnowledgeSession({
  ...productionServices,
  previewReader: productionPreviewReader,
  replica: {libraries: instance => api.contentReplicaLibraries(instance), notes: (instance, vault, query, page) => api.contentReplicaNotes(instance, vault, query, page)},
});

/** The app-session Knowledge retention owner (production). */
export function sessionKnowledge(): KnowledgeSession {
  return productionSession;
}
