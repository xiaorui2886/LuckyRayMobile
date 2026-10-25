import { UnifiedNotesRoot } from "./kit/UnifiedNotesView";
import type { ReactNode } from "react";
import { DirectoryLibrarySheet, useDesktopLibraries } from "./kit/DesktopLibraryPicker";
import { desktopLibraries, selectedLibraryReadable } from "../services/desktopLibraries";
import { useSourceSwipe } from "./kit/useHorizontalSwipe";
import { pickLocalNoteFile } from "./kit/LocalNoteImportBridge";
import { LocalNoteUploadSheet } from "./kit/LocalNoteUploadSheet";
import { desktopNotePrefetch } from "../services/desktopNotePrefetch";
// STILL-01.1 — Knowledge root (Still CollectionView domain=knowledge).
// 本机 notes run through the REAL generation-safe pager authority
// (LOCAL-KNOWLEDGE-USABILITY-R1): pagination, tag filter, per-row quick
// actions and truthful empty states. 电脑 notes come from the paired Desktop
// vault through the unchanged CollectionView path — Desktop rows stay
// read-only and never expose local write actions.
//
// The presentation primitives (Sheet/Option/Empty/SourceSwitch/SearchField,
// the st-note-row row language) are the frozen Still 01.1 authority, composed
// here for the local surface only.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, useCallback } from "react";
import { CollectionView, type NoteItem } from "../presentation/still01/Views";
import type { NoteState } from "../presentation/still01/Still";
import { SourceSwitch, SearchField, Icon, IconButton, Sheet, Option, Button, Empty } from "./kit/StillImports";
import { api, type ConnState } from "../services/client";
import { localDataStore } from "../services/localDataStore";
import { dataStore } from "../services/dataStore";
import { noteStatus } from "../services/noteProvenance";
import { setNotesSort, sortRows, SORT_LABELS, type SortKey } from "../services/viewPreferences";
import { FilterDraft, defaultKnowledgeFilter, type KnowledgeFilterState } from "../services/filterDraft";
import { collectTags, describeLocalEmpty, localHeadingFor } from "../services/localKnowledgeUsability";
import {
  type KnowledgeBrowseSnapshot,
} from "./kit/knowledgeBrowseController";
import { DesktopKnowledgeStatus } from "./kit/desktopKnowledgeStatus";
import { KnowledgeReplicaManagement } from "./kit/knowledgeReplicaManagement";
import { sessionKnowledge } from "./kit/knowledgeSession";
import "./kit/knowledgeNavigation.css";
import { folderChildren } from "./kit/knowledgeFolderCatalog";
import { FolderBreadcrumbs, FolderRows } from "./kit/knowledgeFolders";
import { DirectorySheet, DirectoryContents } from "./kit/directorySheet";
import { KnowledgeLibrarySheet } from "./kit/KnowledgeLibrarySheet";
import { DirectoryStatusLine } from "./kit/directoryStatusLine";
import {
  directoryMoveTargets, canonicalMoveTargets, parentOf, orchestrateListMove, createListCurrentness,
  type MoveTarget, type BatchReport, type BlockedNote, type MoveAuthority, type MoveFact,
} from "./kit/knowledgeOrganizationController";
import { createDragAutoScroll, type DragAutoScroll } from "./kit/dragAutoScroll";
import {
  literalSegments, bodyHitContext, visibleMatchKind, MATCH_LOCATION_UNKNOWN, transientMatchesQuery,
  type HitSegment,
} from "./kit/searchHit";
import { syncCoordinator } from "../services/syncCoordinator";
import { orchestrateDesktopCreate, createSubmitBusy, type CreateScope } from "./kit/desktopCreate";
import type { TransientDesktopRow } from "./kit/desktopProjection";
import { indexOfId, selectionWithRange, type RangeDrag } from "./kit/rangeSelect";
import { sameRequest } from "../services/knowledgeNotesPager";
import { previewStoreKey, NO_CACHED_BODY, type PreviewStore } from "./kit/notePreview";
import { LocalNotesPager, notesLoadedText, type NoteFilters } from "../services/knowledgeNotesPager";
import { failureCopy } from "../services/feedback";
import { toast } from "../services/toast";
import { localNoteItem, desktopMeta } from "./stillData";
import { useStillNav } from "./StillShell";

let rememberedLocalDirectory = "";

let rememberedSource: "local" | "desktop" = "local";

/** R1.6.1-2: extract the noteId from a desktop route id. */
function noteIdOfRoute(routeId: string): string {
  const at = routeId.lastIndexOf(":");
  try {
    return decodeURIComponent(at >= 0 ? routeId.slice(at + 1) : routeId);
  } catch {
    return at >= 0 ? routeId.slice(at + 1) : routeId;
  }
}

/**
 * R1.6.1-2: the projection OVERLAY — when the phone has a newer
 * locally-saved truth for THIS note, the presentation uses it (the canonical
 * revision/order/identity stay authoritative internally). Exact-noteId
 * keyed; ALL NOTES and DIRECTORY share the semantics.
 */
function applyDesktopOverlay(item: NoteItem, overlayIndex: Record<string, TransientDesktopRow>, q = ""): NoteItem {
  const overlay = overlayIndex[noteIdOfRoute(item.id)];
  if (!overlay) return item;
  const pending = overlay.blocked ? " · 同名暂停" : "";
  // R1.6.3-7: an ACTIVE query recomputes the hit presentation from the
  // OVERLAY's local truth (title/parent/preview) — the stale canonical hits
  // are never kept. Literal matching; zero Desktop detail N+1.
  if (q) {
    const kind = visibleMatchKind(
      { title: overlay.title, parentRelativePath: overlay.parent },
      overlay.preview || undefined, q);
    const bodyHit = kind === "body" && overlay.preview ? bodyHitContext(overlay.preview, q) : null;
    return {
      ...item,
      title: overlay.title,
      meta: overlay.preview ? `${overlay.preview}${pending}` : `${NO_CACHED_BODY}${pending}`,
      state: (overlay.pending ? "pending" : "synced") as NoteState,
      titleHit: kind === "title" ? literalSegments(overlay.title, q) : undefined,
      bodyHitLine: kind === "title" ? undefined
        : kind === "path" ? { kind: "hit" as const, segments: literalSegments(overlay.parent, q), prefix: "目录：" }
        : bodyHit ? { kind: "hit" as const, segments: bodyHit.segments, suffix: pending || undefined }
        : { kind: "fallback" as const, text: MATCH_LOCATION_UNKNOWN },
    };
  }
  return {
    ...item,
    title: overlay.title,
    meta: overlay.preview ? `${overlay.preview}${pending}` : `${NO_CACHED_BODY}${pending}`,
    state: (overlay.pending ? "pending" : "synced") as NoteState,
    titleHit: undefined,
    bodyHitLine: undefined,
  };
}

// R4 (A): per-source scroll offsets survive root-tab unmounts (session-level,
// like the retained controllers). A detail push/pop does not touch them —
// the list stays exactly where the user left it.
const rememberedScroll: Record<"local" | "desktop", number> = { local: 0, desktop: 0 };
const desktopScrollByScope = new Map<string, number>();

/** Local rows keep the Still NoteItem shape plus the favorite projection. */
type LocalNoteRow = NoteItem & { favorite?: boolean; raw: any };

export function StillKnowledge({ conn, active = true }: { conn: ConnState | null; active?: boolean }) {
  return <UnifiedNotesRoot active={active} legacy={(modeSwitch, management) => <LegacyStillKnowledge conn={conn} active={active} modeSwitch={modeSwitch} management={management} />} />;
}

function LegacyStillKnowledge({ conn, active = true, modeSwitch, management }: { conn: ConnState | null; active?: boolean; modeSwitch: ReactNode; management: ReactNode }) {
  const { open, registerOverlay } = useStillNav();
  const [source, setSource] = useState<"local" | "desktop">(rememberedSource);
  // R4.1/R4.2: ONE session object owns the retention layer (Local pager +
  // Desktop controller + preview retainer + gates + currentness/UI memory).
  const session = sessionKnowledge();
  const pager = session.pager;
  const desktopCtrl = session.desktop;
  // ORG-1A/1B: the directory-mode authority + the move authority.
  const directoryCtrl = session.directory;
  const folderCatalog = session.folders;
  const orgCtrl = session.organization;
  // R4.2 (P1-A6): the search text and the Local filter identity are SESSION
  // UI state — returning to Knowledge restores EXACTLY what the user left,
  // so the visible request identity can never mismatch the retained rows
  // (no `foo` rows under an emptied search box, no default-filter rows under
  // a saved filter — and vice versa) even for one frame.
  const [query, setQueryState] = useState(session.ui.query);
  const setQuery = (q: string) => { session.ui.query = q; setQueryState(q); };
  const [reloadKey, setReloadKey] = useState(0);
  // The CURRENT connection identity, available SYNCHRONOUSLY in render — the
  // owner gate below is what keeps session-retained Desktop A rows from ever
  // painting under a current Desktop B, including on the FIRST frame.
  const paired = Boolean(conn?.paired);
  const instanceId = conn?.identity?.instanceId || "";
  const currentInstanceRef = useRef(instanceId); currentInstanceRef.current = instanceId;
  const wsState = conn?.ws?.state || "";
  const connected = wsState === "connected";
  const libraries = useDesktopLibraries(instanceId, connected);
  const selectedVault = libraries.catalog?.scopeSelectionVersion === 1 ? libraries.vault : undefined;
  useEffect(() => { desktopCtrl.selectVault(selectedVault || "", selectedLibraryReadable(libraries,"knowledge"), libraries.knowledgeEpoch); }, [desktopCtrl, instanceId, selectedVault, libraries.knowledgeEpoch, libraries.phase]);
  // The Desktop-domain store signal, declared BEFORE the gated store (its
  // value is part of the gate's synchronous input).
  const desktopVersion = useSyncExternalStore(
    (fn) => dataStore.subscribe(fn),
    () => dataStore.getVersion()
  );
  const replicaSync = useSyncExternalStore(fn => syncCoordinator.subscribe(fn), () => syncCoordinator.snapshot());
  const desktop = useSyncExternalStore<KnowledgeBrowseSnapshot>(
    (fn) => desktopCtrl.subscribe(fn),
    // R4.2: the gate also sees the CURRENT connection truth and the
    // currentness signal — offline/old-vault snapshots never render as live
    // current truth on the first frame.
    () => session.desktopViewFor({ paired, connected, instanceId, vaultId:selectedVault, readable: selectedLibraryReadable(libraries, "knowledge") })
  );
  useEffect(() => {
    // Even a zero-document pass can persist a current-vault/permission change.
    if (source === "desktop" && desktop.replica && replicaSync.status !== "syncing") desktopCtrl.revalidateReplica();
  }, [desktopVersion, source, desktopCtrl, replicaSync.status, replicaSync.error]);
  // ORG-1A REPAIR-R1.1 (P1-5): the selected Desktop directory is derived
  // SYNCHRONOUSLY from the scope-keyed session map on EVERY render — never a
  // one-time `useState(retainedDir)` seed. The moment the instance or vault
  // changes, this read returns the CURRENT scope's value (or "" = ROOT), so
  // A's `Work` can never paint or query under B / another vault, not even
  // for one frame.
  const desktopDirectory = session.retainedDirectoryFor(instanceId, desktop ? desktop.vaultId : "");
  const [, setDirectoryRev] = useState(0);
  const folderSnapshot = useSyncExternalStore(folderCatalog.subscribe,
    () => folderCatalog.snapshot({ instance: instanceId, vault: desktop.vaultId }));
  useEffect(() => {
    if (source !== "desktop") { folderCatalog.suspend(); return; }
    void folderCatalog.activate({ instance: instanceId, vault: desktop.vaultId }, connected);
  }, [folderCatalog, source, instanceId, desktop.vaultId, connected]);
  const setDesktopDirectory = (d: string) => {
    session.retainDirectory(instanceId, desktop ? desktop.vaultId : "", d);
    setDirectoryRev((n) => n + 1);
  };
  // ORG-1A: the directory-mode snapshot (Content V1 authority).
  const directorySnap = useSyncExternalStore(
    (fn) => directoryCtrl.subscribe(fn),
    () => directoryCtrl.snapshotFor({ instanceId, vaultId: desktop.vaultId, directory: desktopDirectory, query })
  );
  const desktopScrollKey = JSON.stringify([instanceId, desktop.vaultId, desktopDirectory, query.trim()]);
  useEffect(() => {
    if (libraries.catalog?.scopeSelectionVersion === 1 && !selectedLibraryReadable(libraries, "knowledge")) {
      directoryCtrl.invalidateScope(instanceId, selectedVault);
    }
  }, [directoryCtrl, instanceId, selectedVault, libraries.knowledgeEpoch, libraries.phase]);
  // R1.6-B: the TRANSIENT Mobile Desktop-note projection for the CURRENT
  // exact scope — newly created/edited Desktop notes stay visible on the
  // list BEFORE the canonical authority converges (dedupe by noteId below).
  const pendingDesktopRows = useSyncExternalStore(
    (fn) => session.projection.subscribe(fn),
    () => session.projection.rowsFor(instanceId, desktop.vaultId),
  );
  const [sheet, setSheet] = useState<
    "" | "upload-local" | "filter" | "notebooks" | "vault" | "note-actions" | "confirm-delete" | "create-folder" | "move-local" | "desktop-filter" | "desktop-folder-info"
  >("");
  const [actionNote, setActionNote] = useState<any>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [directory, setDirectoryState] = useState(rememberedLocalDirectory);
  const setDirectory = (path: string) => {
    rememberedLocalDirectory = path;
    rememberedScroll.local = 0;
    setDirectoryState(path);
  };
  const [localFolders, setLocalFolders] = useState<string[]>([]);
  const [folderName, setFolderName] = useState("");
  const [folderError, setFolderError] = useState("");
  const folderBusy = useRef(false);
  const [folderSaving, setFolderSaving] = useState(false);
  const [localFolderError, setLocalFolderError] = useState("");
  const [busy, setBusy] = useState(false);
  // R1.5.3: the SYNCHRONOUS create-submit lock — React state cannot guard a
  // double invoke (both taps run before the re-render).
  const createBusyRef = useRef(false);
  const draft = useRef(new FilterDraft<KnowledgeFilterState>(defaultKnowledgeFilter));
  // R4.3 (P1-R42-3): the draft's INTERNAL applied state is restored from the
  // session filter, so opening 筛选与排序 shows exactly what the list is
  // filtered by (and Apply cannot silently reset it). The DEFAULTS factory
  // stays `defaultKnowledgeFilter`, so 重置 still returns the REAL defaults.
  if (draft.current.getApplied().mode !== session.ui.localFilter.mode
    || draft.current.getApplied().sort !== session.ui.localFilter.sort
    || draft.current.getApplied().tag !== session.ui.localFilter.tag) {
    draft.current.restoreApplied(
      { mode: session.ui.localFilter.mode as KnowledgeFilterState["mode"], sort: session.ui.localFilter.sort, tag: session.ui.localFilter.tag }
    );
  }
  const [, bump] = useState(0);
  const appliedRef = useRef<KnowledgeFilterState>(
    // R4.2: the committed Local filter identity is restored from the session
    // too (same write-through pattern as the query).
    { mode: session.ui.localFilter.mode as KnowledgeFilterState["mode"], sort: session.ui.localFilter.sort, tag: session.ui.localFilter.tag }
  );
  const version = useSyncExternalStore(
    (fn) => localDataStore.subscribe(fn),
    () => localDataStore.getVersion()
  );
  useEffect(() => { rememberedSource = source; }, [source]);

  useEffect(() => {
    if (source !== "local") return;
    let alive = true;
    api.localNoteFolders().then(result => {
      if (!alive) return;
      setLocalFolders(result.paths);
      setLocalFolderError("");
    }).catch(e => { if (alive) setLocalFolderError(failureCopy(e, "读取本机文件夹失败。")); });
    return () => { alive = false; };
  }, [source, version, reloadKey]);
  useEffect(() => {
    const onDirectoryBack = (event: Event) => {
      const path = source === "desktop" ? desktopDirectory : directory;
      if (!path) return;
      event.preventDefault();
      // Search is a flat view. Restore the folder first, then climb one level.
      if (query.trim()) { setQuery(""); return; }
      if (source === "desktop") setDesktopDirectory(parentOf(path));
      else setDirectory(parentOf(path));
    };
    window.addEventListener("luckyray:directory-back", onDirectoryBack);
    return () => window.removeEventListener("luckyray:directory-back", onDirectoryBack);
  }, [source, desktopDirectory, directory, query]);

  const applied = appliedRef.current;
  const mode: KnowledgeFilterState["mode"] = applied.mode;

  // ------------------------------------------------------------------
  // A: 本机 notes pagination — the ONE pager authority
  // (LocalNotesPager: request-epoch generation, stale responses dropped,
  // loadMore appends under the current filters). The pager's fetch closure
  // reads the latest query through a ref, so query changes reuse the same
  // epoch authority instead of a second request path.
  // ------------------------------------------------------------------
  const localPage = useSyncExternalStore(
    (fn) => pager.subscribe(fn),
    () => pager.getState()
  );

  /** The CURRENT request identity: query + tag + range + sort, all of them.
   *  Built fresh on every use so a `loadMore` can prove it is continuing the
   *  same identity the active page-1 used. */
  const localFilters = (q: string = query): NoteFilters => ({
    q: q.trim() || undefined,
    folder: q.trim() ? undefined : directory || undefined,
    tag: applied.tag || undefined,
    pinned: mode === "pinned" ? true : undefined,
    favorite: mode === "favorite" ? true : undefined,
    archived: mode === "archived" ? true : false,
    sort: (applied.sort === "name" ? "name" : "recent"),
  });

  // R4.1: cache-first LOCAL loads. Leaving the Local source (or the root
  // unmounting) SUSPENDS the pager — in-flight work is fenced, but the
  // last-good rows stay. Returning to the SAME request identity repaints
  // them synchronously with NO invalidate/reload (the fast path below); a
  // genuinely different identity keeps the full invalidate + debounced
  // reload semantics, so query/filter changes stay generation-safe.
  useEffect(() => {
    if (source !== "local") {
      pager.suspend();
      return;
    }
    const identity = localFilters();
    if (pager.hasLoadedRows() && sameRequest(pager.currentRequest(), identity)) {
      return; // retained: the exact-identity last-good page paints now
    }
    // The identity changed the moment the user typed / applied a filter, so
    // the CURRENT generation is invalidated NOW — before the debounce — which
    // removes the window where a loadMore could fetch under the new identity
    // and append into the previous one's rows. Only the page-1 FETCH waits.
    pager.invalidate();
    const timer = setTimeout(() => pager.reload(identity), 200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, pager, query, directory, mode, applied.tag, applied.sort]);

  // Local mutations (data-version events) refresh the SAME identity with the
  // rows-retained revalidate: the last-good page stays painted while the
  // fresh page-1 commits. R4.2: the session remembers the last-seen data
  // version, so a pure root-tab return with NO mutation does ZERO work — the
  // revalidate fires only on an actual version change.
  useEffect(() => {
    // R4.3 (P1-R42-2): observe-always, act-on-Local. A version bump while the
    // Local source is inactive (e.g. a note saved from Search) is NOT
    // consumed — it stays pending and acts exactly once on Local activation.
    session.observeLocalDataVersion(version);
    if (source !== "local") return;
    if (!session.localDriftPending()) return;
    session.markLocalDriftActioned();
    if (pager.hasLoadedRows()) pager.revalidate(localFilters());
    session.certifyLocalDataVersion(version);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, source, pager, version]);

  // Certify the initial load too: the first successful Local page-1 under a
  // version certifies it, so a later bump (from anywhere) is detected.
  useEffect(() => {
    if (source !== "local") return;
    if (!pager.hasLoadedRows()) return;
    if (!session.localDriftPending()) session.certifyLocalDataVersion(version);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, source, pager, version, localPage.items]);

  // R4.1: leaving the Desktop source (or unmounting the root) now SUSPENDS
  // the controller — the epoch fences any in-flight work, but the retained
  // exact-owner snapshot SURVIVES, so returning repaints it synchronously.
  // Re-entering feeds the live identity; setConnection's own owner/offline
  // fences stay fully intact for real changes.
  useEffect(() => {
    if (source !== "desktop") {
      desktopCtrl.suspend();
      return;
    }
    desktopCtrl.setConnection({
      paired, connected, instanceId,
      isLive: () => document.contains(document.querySelector(".st-view")) && source === "desktop",
    });
    // R4.2 (P1-A4): the explicit resume. setConnection alone early-returns
    // on the same binding, which left a request suspended mid-cold-load
    // forever; activate() restarts exactly one fresh discover/list when the
    // retained snapshot is not a same-query READY page, and is a no-op for
    // a cache-first return or an already-live request.
    desktopCtrl.activate();
  }, [desktopCtrl, source, paired, connected, instanceId]);

  // R2-REPAIR (2): the connection flip in `setConnection` above is the ONE
  // authority for offline→online re-discovery — no second ws-edge reconnect
  // here (that used to fire twice for one flip). A drop still retires through
  // the same flip; nothing to do on this edge.

  // R4.4 (P1-R43-1): the coarse dataStore version is NOT an active-vault
  // signal — every sync/note/material/cache commit bumps it. It is used ONLY
  // as note-cache freshness for the local preview bulk store (below); it must
  // never trigger activeVaultChanged(), never re-request vaults/registeredList,
  // and never blank the retained list. Canonical list refresh stays owned by
  // owner/pairing changes (setConnection), connection flips, query changes,
  // and the explicit user Refresh (refresh()).

  // Query A→B: canonical q through the controller (debounced inside).
  useEffect(() => { desktopCtrl.setQuery(query); }, [desktopCtrl, query]);

  // ORG-1A: the DIRECTORY-mode authority feed. Only runs while the Desktop
  // source is active with a NON-EMPTY directory selected ("" = ALL NOTES
  // stays on the canonical pipeline above). Leaving the source suspends
  // (fence, keep); returning activates (cache-first or one fresh page-1).
  const directoryActive = source === "desktop" && desktopDirectory !== "" && !query.trim();
  // ORG-1B REPAIR-R1.1 (P1-8): the REAL move grant truth from the canonical
  // discovery that owns the rows — never a hardcoded writeGranted:true. The
  // submit paths re-resolve fresh through session.resolveMoveAuthority.
  const moveAuthorityNow = desktopCtrl.moveAuthority();
  const moveGrant = moveAuthorityNow.writeGranted && moveAuthorityNow.vaultId === desktop.vaultId && !desktop.replica?.waitingCurrent;
  useEffect(() => {
    if (!directoryActive) {
      directoryCtrl.suspend();
      return;
    }
    directoryCtrl.setOwner({
      paired, connected, instanceId, writeGranted: moveGrant, localReplica: Boolean(desktop.replica?.confirmed),
      isLive: () => document.contains(document.querySelector(".st-view")) && source === "desktop",
    });
    directoryCtrl.setVault(desktop.vaultId);
    directoryCtrl.setDirectory(desktopDirectory);
    directoryCtrl.activate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directoryCtrl, directoryActive, paired, connected, instanceId, desktop.vaultId, desktopDirectory, source, moveGrant, desktop.replica?.confirmed]);
  useEffect(() => {
    if (!directoryActive) return;
    directoryCtrl.setQuery(query);
  }, [directoryCtrl, directoryActive, query]);
  useEffect(() => {
    if (directoryActive && desktop.replica && replicaSync.status !== "syncing") directoryCtrl.revalidateReplica();
  }, [desktopVersion, directoryActive, directoryCtrl, replicaSync.status, replicaSync.error]);
  // REPAIR-R1.2 (P1-4): ONE explicit user-refresh dispatcher. The old two
  // effects shared one firstDesktopRefresh guard, so an ordinary ALL-NOTES
  // mount/return consumed the directory effect's guard and then silently ran
  // a canonical refresh — defeating the #84 retained-return ZERO-refresh
  // invariant. Now a single effect keyed ONLY to the user's reloadKey
  // dispatches exactly ONE refresh for the CURRENT mode; the mount run is
  // skipped, and a pure root/detail/source return (reloadKey unchanged)
  // calls ZERO desktopCtrl.refresh / ZERO directoryCtrl.refresh.
  const userRefreshArmed = useRef(false);
  useEffect(() => {
    if (!userRefreshArmed.current) { userRefreshArmed.current = true; return; }
    if (source !== "desktop" || !paired || !instanceId) return;
    void folderCatalog.refresh({ instance: instanceId, vault: desktop.vaultId }, connected);
    if (directoryActive) directoryCtrl.refresh();
    // R4.1: the explicit refresh is stale-while-revalidate — rows stay
    // painted; a failure keeps them with the truthful error state.
    else desktopCtrl.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  // 切换来源：目录选择与目录清单绝不泄漏到另一边。
  useEffect(() => { setDirectory(""); setSheet((cur) => (cur === "vault" ? "" : cur)); }, [source]);

  // R1.6-B reconciliation: transient rows retire ONLY once the canonical row
  // is present (exact-noteId dedupe — never a duplicate, never an absent
  // flash), and their presence schedules ONE quiet same-vault FAST
  // revalidate (registeredList only — zero discover/vaults) so the canonical
  // authority converges in the background.
  useEffect(() => {
    if (pendingDesktopRows.length === 0) return;
    // R1.6.2-1/R1.6.3-1/5: the CURRENT authority's convergence facts
    // (revision + title per exact noteId). In ALL NOTES that is the
    // canonical rows; in DIRECTORY mode the exact current-directory rows
    // (remoteRevision observation + title) prove convergence under the SAME
    // ack-target equality rule — never an unrelated directory/query's rows.
    const authority = directoryActive
      ? new Map(directorySnap.rows.map((r) => [r.noteId, { revision: r.remoteRevision, title: r.title }]))
      : new Map(desktop.rows.map((r) => [r.noteId, { revision: r.revision, title: r.title }]));
    for (const row of pendingDesktopRows) {
      session.projection.retireIfPresent(row.instanceId, row.vaultId, row.noteId, authority);
    }
  }, [pendingDesktopRows, desktop.rows, directorySnap.rows, directoryActive, session]);
  useEffect(() => {
    if (source !== "desktop" || pendingDesktopRows.length === 0) return;
    // Returning to the list with local projections: they paint synchronously
    // (the memo above), then ONE quiet fast revalidate runs in background.
    desktopCtrl.fastRevalidate();
  }, [source, pendingDesktopRows.length, desktopCtrl]);
  // R1.6.3-3: the auto-copy/target refresh is LIST/SESSION-OWNED — it no
  // longer depends on the detail lifetime. Every Desktop-domain store bump
  // (a sync round may have auto-copied a title or landed an ack) triggers
  // ONE bounded LOCAL re-read of the EXACT projected noteIds: the projection
  // title/preview/ack-target update even when the detail already unmounted.
  // Local cache reads only — ZERO Desktop detail N+1.
  useEffect(() => {
    if (source !== "desktop" || pendingDesktopRows.length === 0) return;
    let alive = true;
    void (async () => {
      for (const row of pendingDesktopRows.slice(0, 20)) {
        const value = await api.contentNoteGet(row.instanceId, row.vaultId, row.noteId).catch(() => null);
        if (!alive) return;
        if (!value) continue;
        const clean = value.dirty === false && value.serverDocument;
        session.projection.update(row.instanceId, row.vaultId, row.noteId, {
          title: value.title || row.title,
          preview: row.preview,
          blocked: Boolean(value.createCollisionBlocked),
          ...(clean ? { pending: false, targetRemoteRevision: value.serverDocument.revision || undefined } : {}),
        });
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, desktopVersion]);

  // D: local rows keep the Still shape plus the favorite projection; the
  // archived filter stays authoritative (rows hidden outside 归档 mode).
  const localRows: LocalNoteRow[] = useMemo(() => {
    if (source !== "local") return [];
    // NO client-side re-sort: the authority already returned these pages in
    // the selected order (it applies the sort before LIMIT/OFFSET), so
    // re-sorting here would only reshuffle within the loaded subset and
    // misrepresent the whole-library order.
    const rows = localPage.items.filter((n) => !n.archived || mode === "archived");
    return rows.map((n) => ({ ...localNoteItem(n), favorite: Boolean(n.favorite), raw: n }));
  }, [source, localPage.items, mode]);

  // The tag picker comes from the Local Note tag AUTHORITY: tags that exist
  // only on later pages are still offered, and an applied tag never hides the
  // others. Refreshed from the same local-data version as the list.
  const [tagVocabulary, setTagVocabulary] = useState<string[]>([]);
  useEffect(() => {
    if (source !== "local") return;
    let alive = true;
    api.localNoteTags()
      .then((r) => { if (alive) setTagVocabulary(r?.tags || []); })
      .catch(() => { if (alive) setTagVocabulary([]); });
    return () => { alive = false; };
  }, [source, version, reloadKey]);
  const draftTags = sheet === "filter"
    ? collectTags(tagVocabulary.map((t) => ({ tags: [t] })), draft.current.getDraft().tag)
    : [];

  // R4.1: the preview store is RETAINED at session level by the exact
  // `instance|vault` owner — reading it is synchronous, so a return to the
  // same identity repaints previews immediately with NO 正文尚未缓存 flash.
  // The retainer loads through the production local-only reader (one bounded
  // bulk command; zero Desktop network) and owner-fences every resolution.
  const retainedPreviews = useSyncExternalStore<PreviewStore | null>(
    (fn) => session.previews.subscribe(fn),
    () => session.previews.snapshotFor(desktop.instanceId, desktop.vaultId)
  );
  const previewKey = desktop.vaultId
    ? previewStoreKey(desktop.instanceId, desktop.vaultId)
    : "";
  useEffect(() => {
    // REPAIR-R1.1 (P1-7): while DIRECTORY mode is active the canonical rows
    // are not rendered — their ensure is gated OFF so the directory page's
    // ids own the retainer's coverage (no ping-pong between two id sets).
    if (source !== "desktop" || !previewKey || directoryActive) return;
    // R4.3 (P1-R42-4): the coarse Desktop-domain signal doubles as the
    // note-cache freshness for preview coverage — opening a note (its detail
    // refresh caches the body) bumps it, allowing ONE local bulk re-read so a
    // newly cached body replaces 正文尚未缓存; unchanged returns stay
    // zero-read. Zero Desktop requests either way.
    session.observeNoteCacheVersion(desktopVersion);
    session.previews.ensure(desktop.instanceId, desktop.vaultId,
      desktop.rows.map((r) => r.noteId), session.previewReader,
      session.noteCacheVersion());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, source, previewKey, desktop.rows, desktopVersion, directoryActive]);

  // ORG-1A: DIRECTORY-mode rows come from the Content V1 authority (live or
  // truthful cache fallback), with the same body-preview subtitle as ALL
  // NOTES. NEVER a local filter of the canonical rows.
  const dirPreviewKey = directorySnap.vaultId
    ? previewStoreKey(directorySnap.instanceId, directorySnap.vaultId)
    : "";
  const dirPreviews = retainedPreviews && retainedPreviews.key === dirPreviewKey
    ? retainedPreviews.byNoteId
    : {};
  // REPAIR-R1.1 (P1-7): the SAME retained local-only bulk preview reader
  // covers the DIRECTORY page's ids too (zero Desktop N+1, exact
  // instance|vault fencing, unchanged rows = zero re-reads).
  useEffect(() => {
    if (!directoryActive || !dirPreviewKey) return;
    session.observeNoteCacheVersion(desktopVersion);
    session.previews.ensure(directorySnap.instanceId, directorySnap.vaultId,
      directorySnap.rows.map((r) => r.noteId), session.previewReader,
      session.noteCacheVersion());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, directoryActive, dirPreviewKey, directorySnap.rows, desktopVersion]);
  const directoryItems: NoteItem[] = useMemo(() => {
    const q = query.trim();
    // R1.6-B: a transient row shows in DIRECTORY mode ONLY when its parent
    // IS the current directory (never fabricated membership).
    const dirCanonicalIds = new Set(directorySnap.rows.map((r) => r.noteId));
    const qDir = query.trim();
    const transientDirItems: NoteItem[] = directoryActive
      ? pendingDesktopRows
        .filter((row) => !dirCanonicalIds.has(row.noteId) && row.parent === desktopDirectory)
        .filter((row) => !qDir || transientMatchesQuery(row, qDir))
        .map((row) => ({
          id: `desktop:${encodeURIComponent(row.instanceId)}:${encodeURIComponent(row.vaultId)}:${encodeURIComponent(row.noteId)}`,
          title: row.title,
          body: "",
          source: "desktop" as const,
          meta: `${row.preview || NO_CACHED_BODY}${row.blocked ? " · 同名暂停" : ""}`,
          state: "pending" as const,
          notebook: desktop.vaultName || "LuckyRay 知识库",
        }))
      : [];
    const dirOverlayIndex: Record<string, TransientDesktopRow> = {};
    for (const row of pendingDesktopRows) dirOverlayIndex[row.noteId] = row;
    return [
      ...transientDirItems,
      ...directorySnap.rows.map((row) => {
      const p = dirPreviews[row.noteId];
      const preview = p && p.preview ? (p.outdated ? `${p.preview} · 缓存版本` : p.preview) : "";
      // R1.5-D: only PROVEN literal matches are highlighted. The overlay
      // post-pass below applies the SAME R1.6.1-2 presentation semantics. 
      const visibleKind = q ? visibleMatchKind(
        { title: row.title, parentRelativePath: row.relativePath },
        p && p.preview ? p.preview : undefined, q) : "none";
      const fullBodyHit = row.searchHit?.query === q ? row.searchHit : undefined;
      const kind = visibleKind === "none" && fullBodyHit?.bodyRange ? "body" : visibleKind;
      const bodyHit = q && kind === "body" && fullBodyHit?.snippet
        ? { segments: literalSegments(fullBodyHit.snippet, q) }
        : q && kind === "body" && p?.preview ? bodyHitContext(p.preview, q) : null;
      return {
        id: `desktop:${encodeURIComponent(row.instanceId)}:${encodeURIComponent(row.vaultId)}:${encodeURIComponent(row.noteId)}`,
        title: row.title,
        body: "",
        source: "desktop" as const,
        meta: preview || NO_CACHED_BODY,
        state: "synced" as const,
        notebook: desktop.vaultName || "LuckyRay 知识库",
        titleHit: q && kind === "title" ? literalSegments(row.title, q) : undefined,
        bodyHitLine: !q ? undefined
          : kind === "title" ? undefined
          : kind === "path" ? { kind: "hit" as const, segments: literalSegments(parentOf(row.relativePath) || row.relativePath, q), prefix: "目录：" }
          : bodyHit ? { kind: "hit" as const, segments: bodyHit.segments, suffix: p?.outdated ? " · 缓存版本" : undefined }
          : { kind: "fallback" as const, text: MATCH_LOCATION_UNKNOWN },
      };
      }),
    ].map((item) => desktop.replica && qDir && dirCanonicalIds.has(noteIdOfRoute(item.id))
      ? item : applyDesktopOverlay(item, dirOverlayIndex, qDir))
    // R1.6.3-6: DIRECTORY active-query rows carrying an overlay are filtered
    // by the OVERLAY's local truth, except S1 canonical results, whose full
    // local body has already been searched before native pagination.
    .filter((item) => {
      if (!qDir) return true;
      if (desktop.replica && dirCanonicalIds.has(noteIdOfRoute(item.id))) return true;
      const overlay = dirOverlayIndex[noteIdOfRoute(item.id)];
      if (!overlay) return true;
      return transientMatchesQuery(overlay, qDir);
    });
  }, [directorySnap.rows, dirPreviews, desktop.vaultName, query, pendingDesktopRows, directoryActive, desktopDirectory, desktop.replica]);

  const items: NoteItem[] = useMemo(() => {
    if (source === "desktop" && directoryActive) return directoryItems;
    if (source === "desktop") {
      // Canonical rows: title + body preview as metadata; the id IS the exact
      // `instance:vault:note` route for the active vault. R4.1: an OUTDATED
      // cached body is previewed only under the truthful 缓存版本 marker —
      // its revision is never relabeled.
      const previews = retainedPreviews && retainedPreviews.key === previewKey
        ? retainedPreviews.byNoteId
        : {};
      const q = query.trim();
      // R1.6.1-2: the noteId overlay index.
      const overlayIndex: Record<string, TransientDesktopRow> = {};
      for (const row of pendingDesktopRows) overlayIndex[row.noteId] = row;
      return [
        ...desktop.rows.map((r) => {
        const p = previews[r.noteId];
        const preview = p && p.preview ? (p.outdated ? `${p.preview} · 缓存版本` : p.preview) : "";
        // R1.5-D: highlight only locally PROVEN matches (no server ranges).
        const visibleKind = q ? visibleMatchKind(r, p?.preview, q) : "none";
        const fullBodyHit = r.searchHit?.query === q ? r.searchHit : undefined;
        const kind = visibleKind === "none" && fullBodyHit?.bodyRange ? "body" : visibleKind;
        const bodyHit = q && kind === "body" && fullBodyHit?.snippet
          ? { segments: literalSegments(fullBodyHit.snippet, q) }
          : q && kind === "body" && p?.preview ? bodyHitContext(p.preview, q) : null;
        return {
          id: `desktop:${encodeURIComponent(r.instanceId)}:${encodeURIComponent(r.vaultId)}:${encodeURIComponent(r.noteId)}`,
          title: r.title,
          body: "",
          source: "desktop" as const,
          meta: preview || (p && p.outdated ? `缓存版本 · ${NO_CACHED_BODY}` : NO_CACHED_BODY),
          state: "synced" as const,
          notebook: desktop.vaultName || "LuckyRay 知识库",
          titleHit: q && kind === "title" ? literalSegments(r.title, q) : undefined,
          bodyHitLine: !q ? undefined
            : kind === "title" ? undefined
            : kind === "path" ? { kind: "hit" as const, segments: literalSegments(r.parentRelativePath, q), prefix: "目录：" }
            : bodyHit ? { kind: "hit" as const, segments: bodyHit.segments, suffix: p?.outdated ? " · 缓存版本" : undefined }
            : { kind: "fallback" as const, text: MATCH_LOCATION_UNKNOWN },
        };
        }),
        // R1.6-B/R1.6.1-6: the transients NOT yet canonically present append
        // here (exact-noteId dedupe) — but under an ACTIVE query they show
        // only when a LOCAL fact (title/parent/preview) proves the match;
        // no Desktop detail N+1, no fabricated body hit.
        ...pendingDesktopRows
          .filter((row) => !desktop.rows.some((r) => r.noteId === row.noteId))
          .filter((row) => !q || transientMatchesQuery(row, q))
          .map((row) => ({
            id: `desktop:${encodeURIComponent(row.instanceId)}:${encodeURIComponent(row.vaultId)}:${encodeURIComponent(row.noteId)}`,
            title: row.title,
            body: "",
            source: "desktop" as const,
            meta: `${row.preview || NO_CACHED_BODY}${row.blocked ? " · 同名暂停" : ""}`,
            state: "pending" as const,
            notebook: desktop.vaultName || "LuckyRay 知识库",
          })),
      ].map((item) => desktop.replica && q && desktop.rows.some(row => row.noteId === noteIdOfRoute(item.id))
        ? item : applyDesktopOverlay(item, overlayIndex, q))
      // R1.6.2-5: under an ACTIVE query the PROJECTED local truth decides
      // visibility — a canonical row whose overlay no longer matches q is
      // hidden, and an overlay whose local facts match q shows even when the
      // old canonical visible fields did not. Local title/parent/preview
      // only for non-S1/transient rows; S1 canonical results have already
      // searched the complete local body. Zero Desktop detail N+1.
      .filter((item) => {
        if (!q) return true;
        if (desktop.replica && desktop.rows.some(row => row.noteId === noteIdOfRoute(item.id))) return true;
        const overlay = overlayIndex[noteIdOfRoute(item.id)];
        if (!overlay) return true; // no local projection: canonical search truth
        return transientMatchesQuery(overlay, q);
      });
    }
    return localRows;
  }, [source, localRows, desktop.rows, desktop.vaultName, retainedPreviews, previewKey, query, pendingDesktopRows, desktop.replica, directoryActive, directoryItems]);

  // ---------------------------------------------------------------------------
  // ORG-1B REPAIR-R1.1 — Desktop Knowledge multi-select + move, wired through
  // the SAME #85 primitives the Library uses (selectionWithRange +
  // createDragAutoScroll + the ONE press-gesture authority on the note rows).
  // ---------------------------------------------------------------------------
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [moveSheetOpen, setMoveSheetOpen] = useState(false);
  const [moveBusy, setMoveBusy] = useState(false);
  const [moveAuthority, setMoveAuthority] = useState<MoveAuthority | null>(null);
  const [batchOutcome, setBatchOutcome] = useState<{
    report: BatchReport; blocked: BlockedNote[]; titleByNoteId: Record<string, string>;
  } | null>(null);

  // Selection scope: instance + vault + directory/list identity + query. Any
  // owner/vault/query/directory/source change RETIRES the selection (A's
  // picks can never act under B).
  const selectionScope = source === "desktop"
    ? ["sel", instanceId, desktop.vaultId, directoryActive ? desktopDirectory : "", query.trim()].join("|")
    : "";
  const selectionScopeRef = useRef(selectionScope);
  selectionScopeRef.current = selectionScope;
  // REPAIR-R1.2 (P1-1): the CONNECTION truth read synchronously by the
  // liveness fence — a drop during authority resolution stops unsent work.
  const connectedRef = useRef(connected);
  connectedRef.current = connected;
  const createLocalRef = useRef(Boolean(desktop.replica && paired && desktop.replica.writeState === "granted"));
  createLocalRef.current = Boolean(desktop.replica && paired && desktop.replica.writeState === "granted");
  // REPAIR-R1.4 (ABA): ONE monotonic, deterministic move generation. A
  // semantic scope string cannot distinguish incarnations (S1→S2→S1, or
  // connected true→false→true, restores the same string); every retirement
  // event increments this counter so an old run can NEVER become current
  // again. Never a timestamp, never randomness.
  const moveGenerationRef = useRef(0);
  const moveCurrentness = useMemo(() => createListCurrentness({
    scope: () => selectionScopeRef.current,
    generation: () => moveGenerationRef.current,
    connected: () => connectedRef.current,
  }), []);
  useEffect(() => {
    setSelecting(false);
    setSelectedIds([]);
    setBatchOutcome(null);
    // REPAIR-R1.3 (P1-3): a scope change also closes the move sheet — a
    // stale runMove completion must find nothing left to mutate.
    setMoveSheetOpen(false);
    // REPAIR-R1.4 (ABA): the scope change retires the GENERATION too —
    // returning to the same scope string later is a NEW incarnation.
    moveGenerationRef.current += 1;
    orgCtrl.cancel();
  }, [selectionScope, orgCtrl]);
  // REPAIR-R1.4 (ABA): a connection truth transition retires any in-flight
  // run — true→false→true must not resurrect it.
  useEffect(() => {
    moveGenerationRef.current += 1;
  }, [connected]);
  // Leaving the Desktop source (or the root) also stops a live drag.
  useEffect(() => {
    if (source !== "desktop" || !selecting) return;
    const onSelectionBack = (e: Event) => {
      // While multi-select is active, the system BACK first EXITS the
      // selection instead of leaving the page (the same pipeline #85 uses).
      e.preventDefault();
      setSelecting(false);
      setSelectedIds([]);
      // REPAIR-R1.4 (ABA): an explicit user retirement advances the
      // generation — a run started under the retired selection stays stale.
      moveGenerationRef.current += 1;
    };
    window.addEventListener("luckyray:selection-back", onSelectionBack);
    return () => window.removeEventListener("luckyray:selection-back", onSelectionBack);
  }, [source, selecting]);

  /** The rendered Desktop order the anchor/endpoint indices address. */
  const orderedNoteIds = useMemo(
    () => (source === "desktop" ? items.map((n) => n.id) : []),
    [source, items],
  );
  const dragAutoScrollRef = useRef<DragAutoScroll | null>(null);
  if (!dragAutoScrollRef.current) dragAutoScrollRef.current = createDragAutoScroll();
  const rangeDragRef = useRef<RangeDrag | null>(null);
  const endpointRef = useRef<number | null>(null);
  useEffect(() => {
    if (!selecting) {
      dragAutoScrollRef.current?.stop();
      rangeDragRef.current = null;
      endpointRef.current = null;
    }
  }, [selecting]);
  useEffect(() => () => dragAutoScrollRef.current?.stop(), []);

  /** ONE selection path for live moves and the auto-scroll loop alike. */
  const applyNoteDragPoint = useCallback((x: number, y: number) => {
    if (!selecting) return;
    const drag = rangeDragRef.current;
    if (!drag) return; // the range is frozen (between drags)
    const hit = document.elementFromPoint(x, y);
    // NOTE-row hit targets: data-note-id (never the asset-tile attribute).
    const host = hit && hit.closest ? hit.closest("[data-note-id]") : null;
    const id = host?.getAttribute("data-note-id") || "";
    const idx = id ? indexOfId(orderedNoteIds, id) : null;
    if (idx == null) return; // whitespace: the last valid endpoint stands
    endpointRef.current = idx;
    const next = selectionWithRange(drag, idx, orderedNoteIds);
    setSelectedIds((prev) => (
      next.length === prev.length && next.every((v, i) => v === prev[i]) ? prev : next
    ));
  }, [selecting, orderedNoteIds]);

  const onNoteLongPress = useCallback((id: string) => {
    if (source !== "desktop" || !instanceId || !id) return;
    const idx = indexOfId(orderedNoteIds, id);
    if (idx == null) return;
    setSelecting(true);
    setSelectedIds((prev) => selectionWithRange({ anchorIndex: idx, baseline: prev }, idx, orderedNoteIds));
    rangeDragRef.current = { anchorIndex: idx, baseline: selectedIds };
    endpointRef.current = idx;
  }, [source, instanceId, orderedNoteIds, selectedIds]);

  /** The move capability, re-resolved FRESH from the canonical catalog when
   *  the destination sheet opens (fail-closed copy when unavailable). */
  useEffect(() => {
    if (!moveSheetOpen) { setMoveAuthority(null); return; }
    let alive = true;
    void session.resolveMoveAuthority(instanceId, desktop.vaultId).then((authority) => {
      if (alive) setMoveAuthority(authority);
    });
    return () => { alive = false; };
  }, [moveSheetOpen, session, instanceId, connected]);

  // R1.5.1: the CREATE authority (Content V1 noteWrite) drives the New Note
  // button — NOT the canonical move authority. Re-resolved per owner/vault/
  // connection incarnation; the submit path re-proves it fresh anyway.
  const [createAuthority, setCreateAuthority] = useState<{ usable: boolean } | null>(null);
  useEffect(() => {
    if (source !== "desktop" || (!connected && !desktop.replica) || !instanceId || !desktop.vaultId) {
      setCreateAuthority(null);
      return;
    }
    let alive = true;
    void api.contentNoteCreateAuthority(instanceId, desktop.vaultId)
      .then((r) => { if (alive) setCreateAuthority({ usable: Boolean(r?.usable) }); })
      .catch(() => { if (alive) setCreateAuthority({ usable: false }); });
    return () => { alive = false; };
  }, [source, connected, instanceId, desktop.vaultId, desktop.replica?.writeState]);

  const moveUnavailableReason = (authority: MoveAuthority | null): string => {
    if (!connected) return "电脑暂未连接，连接后才能移动笔记";
    if (authority && authority.moveState !== "implemented") return "当前电脑版本不支持移动笔记";
    if (authority && !authority.writeGranted) return "未获电脑知识库写入授权，无法移动";
    if (authority && authority.vaultId && desktop.vaultId && authority.vaultId !== desktop.vaultId) {
      return "当前知识库已变化，请刷新后再试";
    }
    return "";
  };

  /** The preselected row of the move sheet: a SINGLE selected note's current
   *  parent, read synchronously from the CURRENT row authority (no facts
   *  read — that is submit-time only). */
  const singleMoveCurrentParent = (): string => {
    const route = selectedIds[0] || "";
    if (directoryActive) {
      const row = directorySnap.rows.find((r) => routeOf(r) === route);
      return row ? parentOf(row.relativePath) : "（无法移动）";
    }
    const row = desktop.rows.find((r) => routeOf(r) === route);
    return row ? (row.parentRelativePath || "") : "（无法移动）";
  };

  /** Route id → move target for the CURRENT row authority. Canonical safety
   *  comes from the SUBMIT-TIME bounded local facts read (REPAIR-R1.2 P1-5)
   *  — never the preview retainer's first-100 subset. */
  const routeOf = (r: { instanceId: string; vaultId: string; noteId: string }) =>
    `desktop:${encodeURIComponent(r.instanceId)}:${encodeURIComponent(r.vaultId)}:${encodeURIComponent(r.noteId)}`;
  const buildMoveTargets = async (routes: string[]): Promise<{
    targets: MoveTarget[]; blocked: BlockedNote[]; titleByNoteId: Record<string, string>;
  }> => {
    const wanted = new Set(routes);
    if (directoryActive) {
      const rows = directorySnap.rows.filter((r) => wanted.has(routeOf(r)));
      return directoryMoveTargets(instanceId, rows);
    }
    const rows = desktop.rows.filter((r) => wanted.has(routeOf(r)));
    const ids = rows.map((r) => r.noteId);
    // Bounded local-only chunks (≤100 per command). A read failure returns
    // null → the builder blocks EVERY selected note (unproven safety),
    // never "assume clean".
    let facts: Record<string, MoveFact> | null = {};
    for (let i = 0; i < ids.length; i += 100) {
      const r = await api.contentNoteMoveFacts(instanceId, desktop.vaultId, ids.slice(i, i + 100)).catch(() => null);
      if (!r) { facts = null; break; }
      for (const item of r.items || []) {
        facts[item.noteId] = { dirty: Boolean(item.dirty), pending: Boolean(item.pending), conflict: Boolean(item.conflict) };
      }
    }
    return canonicalMoveTargets(instanceId, rows, facts);
  };

  /** The committed-move projection hook: the Rust receipt converges the
   *  ORIGINAL scope's cache (awaited inside the controller BEFORE this
   *  runs); the two visible row authorities re-project in place — and each
   *  one NO-OPs unless its CURRENT owner/vault is exactly the receipt's
   *  scope, so a late A receipt can never touch B's visible rows. */
  const onMoveCommitted = useCallback((committed: {
    instanceId: string; vaultId: string; noteId: string;
    revision: string; parentRelativePath: string;
  }) => {
    directoryCtrl.applyMoveReceipt(committed.instanceId, committed.vaultId, committed.noteId, committed.parentRelativePath, committed.revision);
    desktopCtrl.applyMoveReceipt(committed.instanceId, committed.vaultId, committed.noteId, committed.parentRelativePath, committed.revision);
  }, [directoryCtrl, desktopCtrl]);

  async function runMove(destination: string) {
    if (moveBusy || !selecting || selectedIds.length === 0) return;
    // REPAIR-R1.4 (ABA): capture BOTH the semantic scope key AND the
    // monotonic generation token — returning to the same string later is a
    // DIFFERENT incarnation and can never resurrect this run.
    const capturedScope = moveCurrentness.capture();
    // Submit-time truth: the capability is re-proven before ANY request.
    const authority = await session.resolveMoveAuthority(instanceId, desktop.vaultId);
    // REPAIR-R1.2/R1.4: the owner/scope/connection/generation can change
    // while the authority resolution was pending — re-prove before anything
    // is built or sent.
    if (!moveCurrentness.isCurrent(capturedScope)) {
      toast.error("电脑或所选范围已变化，已取消移动");
      return;
    }
    const unavailable = moveUnavailableReason(authority);
    if (unavailable) {
      toast.error(unavailable);
      return;
    }
    setMoveBusy(true);
    setBatchOutcome(null);
    // REPAIR-R1.3/R1.4: ONE generation-backed currentness truth feeds the
    // send fence and every completion gate (inside the controller and the
    // orchestrator): same generation + same semantic scope + connected.
    const isScopeCurrent = () => moveCurrentness.isCurrent(capturedScope);
    const deps = session.moveDeps({
      isLive: () => isScopeCurrent()
        && document.contains(document.querySelector(".st-view"))
        && source === "desktop",
      onCommitted: onMoveCommitted,
    });
    try {
      const result = await orchestrateListMove({
        org: orgCtrl,
        deps,
        destination,
        isScopeCurrent,
        buildTargets: () => buildMoveTargets(selectedIds),
      });
      if (result.kind === "stale") {
        // The selection scope/generation left while we were awaiting (facts
        // read or the remote move itself): NO UI mutation for the old scope
        // — no outcome block, no success/partial toast, no selection
        // restore. The retire effect already cleared the selection/sheet;
        // committed remote results stay real and the original-scope DB
        // receipts stay durable.
        return;
      }
      setMoveSheetOpen(false);
      if (result.kind === "no-targets") {
        setBatchOutcome({ report: { succeeded: 0, noop: 0, failed: 0, failures: [], stopped: false }, blocked: result.blocked, titleByNoteId: result.titleByNoteId });
        return;
      }
      const { report, blocked, titleByNoteId } = result;
      if (report.failed === 0 && blocked.length === 0) {
        toast.success(`已移动 ${report.succeeded} 篇笔记`);
        setSelecting(false);
        setSelectedIds([]);
      } else {
        // Partial success stays visible: the committed rows moved, the
        // failures/blocked keep their truthful reasons, the selection stays.
        setBatchOutcome({ report, blocked, titleByNoteId });
      }
    } finally {
      setMoveBusy(false);
    }
  }

  /** The in-scroll partial-result block (never after the full-height view),
   *  composed ahead of the real status line inside the status slot. */
  const withBatchOutcome = (status: React.ReactNode) => (<>{batchOutcomeSlot}{batchFailuresSlot}{status}</>);
  const batchOutcomeSlot = batchOutcome ? (
    <div className="st-kb-status is-danger" role="status" data-testid="org-batch-outcome">
      <span>
        {`移动部分完成：成功 ${batchOutcome.report.succeeded} 篇`}
        {batchOutcome.report.noop ? ` · 已在目标目录 ${batchOutcome.report.noop} 篇` : ""}
        {` · 未移动 ${batchOutcome.report.failed + batchOutcome.blocked.length} 篇`}
        {batchOutcome.report.stopped ? " · 已停止（电脑或授权变化）" : ""}
      </span>
      <Button kind="quiet" onClick={() => setBatchOutcome(null)}>知道了</Button>
    </div>
  ) : null;
  const batchFailuresSlot = batchOutcome && (batchOutcome.report.failures.length || batchOutcome.blocked.length) ? (
    <div className="st-kb-status" role="status">
      <span>
        {/* REPAIR-R1.2 (P2-1): the recognizable TITLE + reason, falling back
            to the raw id only when the title is genuinely unknown. */}
        {[...batchOutcome.report.failures, ...batchOutcome.blocked]
          .slice(0, 3)
          .map((f) => `「${batchOutcome.titleByNoteId[f.noteId] || f.noteId}」${f.reason}`)
          .join("；")}
        {batchOutcome.report.failures.length + batchOutcome.blocked.length > 3 ? " 等" : ""}
      </span>
    </div>
  ) : null;

  const filterLabel = mode === "archived" ? "已归档"
    : mode === "pinned" ? "置顶笔记"
    : mode === "favorite" ? "收藏"
    : applied.sort === "name" ? SORT_LABELS.name
    : "";
  const localHeading = localHeadingFor(applied, SORT_LABELS);

  async function createNote() {
    if (busy) return;
    setBusy(true);
    try {
      const note = await api.localNoteAdd("新笔记", "", [], query.trim() ? "" : directory);
      localDataStore.publish("note");
      open("note", note.noteId, { edit: true });
    } catch (e: any) {
      toast.error(failureCopy(e, "新建笔记失败。"));
    } finally { setBusy(false); }
  }

  async function createLocalFolder() {
    if (folderBusy.current) return;
    const name = folderName.trim();
    if (!name || name === "." || name === ".." || /[\\/:\u0000-\u001f\u007f]/.test(name) || [...name].length > 120) {
      setFolderError("请输入 1–120 个字符的文件夹名称，不能包含斜杠、冒号或控制字符。");
      return;
    }
    if (folderChildren(localFolders, directory).some(path => path.slice(path.lastIndexOf("/") + 1).toLocaleLowerCase() === name.toLocaleLowerCase())) {
      setFolderError("此目录下已存在同名文件夹。"); return;
    }
    folderBusy.current = true; setFolderSaving(true); setFolderError("");
    try {
      const result = await api.localNoteCreateFolder(name, directory);
      setLocalFolders(paths => [...new Set([...paths, result.path])]);
      localDataStore.publish("note");
      setQuery(""); setDirectory(result.path); setSheet("");
      toast.success("文件夹已创建");
    } catch (e) { setFolderError(failureCopy(e, "新建文件夹失败，请重试。")); }
    finally { folderBusy.current = false; setFolderSaving(false); }
  }
  async function moveLocalNote(path: string) {
    if (!actionNote || folderBusy.current) return;
    folderBusy.current = true; setFolderSaving(true);
    try {
      await api.localNoteSetFolder(actionNote.noteId, path);
      localDataStore.publish("note"); setSheet(""); setActionNote(null);
      toast.success("已移动笔记");
    } catch (e) { toast.error(failureCopy(e, "移动失败，请重试。")); }
    finally { folderBusy.current = false; setFolderSaving(false); }
  }

  // -------------------------------------------------------------------------
  // R1.5-B — Desktop-source New Note through the EXISTING Content V1 create
  // authority (never StillNewNote/localNoteAdd). ROOT when ALL NOTES is
  // active; the CURRENT EXISTING directory in directory mode. The staged
  // pending create opens directly at the Desktop route in edit mode and the
  // existing sync coordinator publishes it.
  // -------------------------------------------------------------------------
  async function createDesktopNote() {
    // R1.5.3: the SYNCHRONOUS lock is acquired on the FIRST line, BEFORE any
    // await — a double tap cannot stage two pending Desktop notes. (The
    // orchestrator additionally carries its own module lock as the hard
    // guarantee.)
    if (createBusyRef.current) return;
    createBusyRef.current = true;
    setBusy(true); // the visible disable rides the same tick
    try {
      // R1.5.1: the CREATE authority is the Content V1 capability truth
      // (contentVersion 1 + noteWrite over the exact Desktop/vault) — never
      // the canonical knowledge.move operation state. The create scope
      // (instance + vault + ROOT/current directory + generation +
      // connection) is captured on the orchestrator's FIRST line and
      // re-proven after the authority resolve: a stale or ABA completion
      // issues ZERO creates.
      const result = await orchestrateDesktopCreate({
        resolveAuthority: () => api.contentNoteCreateAuthority(instanceId, desktop.vaultId),
        create: (scope: CreateScope) => api.contentNoteCreate(scope.instance, scope.vault, "新笔记", scope.parent || undefined),
        currentness: {
          instance: () => conn?.identity?.instanceId || "",
          vault: () => desktop.vaultId,
          parent: () => (directoryActive ? desktopDirectory : ""),
          generation: () => moveGenerationRef.current,
          connected: () => connectedRef.current || createLocalRef.current,
        },
      });
      if (result.kind === "busy") {
        return; // a double submit: silently dropped by the hard lock
      }
      if (result.kind === "stale") {
        return; // the scope incarnation left: nothing created, nothing shown
      }
      if (result.kind === "denied") {
        toast.error(result.reason.includes("NOTE") || result.reason.includes("UPGRADE")
          ? "当前电脑不支持新建笔记（需要电脑知识库写权限）"
          : result.reason.includes("VAULT") ? "当前知识库已变化，请刷新后再试"
          : "电脑暂未连接，连接后才能新建电脑笔记");
        return;
      }
      // Every local stage stays durable in its captured scope. #92 waits
      // for the first real edit/attachment to publish the initial placeholder.
      // R1.6-B: register the TRANSIENT projection under the CAPTURED scope —
      // the note is immediately visible on the list (ALL NOTES always; the
      // current directory when the captured parent matches).
      session.projection.upsert({
        instanceId: result.scope.instance,
        vaultId: result.scope.vault,
        noteId: result.noteId,
        title: "新笔记",
        parent: result.scope.parent,
        pending: true,
        preview: "",
        origin: "create",
      });
      if (result.kind === "created-current") {
        // Navigate the EXACT captured instance/vault/note route, in edit mode.
        open("note",
          `desktop:${encodeURIComponent(result.scope.instance)}:${encodeURIComponent(result.scope.vault)}:${encodeURIComponent(result.noteId)}`,
          { edit: true });
      }
      // A stale completion keeps its local draft without old-route navigation.
    } finally {
      createBusyRef.current = false;
      setBusy(false);
    }
  }

  // ------------------------------------------------------------------
  // C: quick actions — local notes only; single mutating flag prevents
  // duplicate submits; success republishes (authoritative reload), failure
  // keeps the row untouched with a truthful toast.
  // ------------------------------------------------------------------
  function openNoteActions(raw: any) {
    setActionNote(raw);
    setConfirmDelete(false);
    setSheet("note-actions");
  }
  function closeNoteActions() {
    if (mutating) return;
    setActionNote(null);
    setConfirmDelete(false);
    setSheet("");
  }
  async function toggleNoteFlag(flag: "pinned" | "favorite" | "archived") {
    const note = actionNote;
    if (!note || mutating) return;
    setMutating(true);
    try {
      await api.localNoteSetFlags(note.noteId, { [flag]: !note[flag] });
      localDataStore.publish("note"); // authoritative reload via the pager effect
      setActionNote(null);
      setConfirmDelete(false);
      setSheet("");
    } catch (e: any) {
      toast.error(failureCopy(e, "操作失败，请重试。"));
    } finally { setMutating(false); }
  }
  async function deleteActionNote() {
    const note = actionNote;
    if (!note || mutating) return;
    setMutating(true);
    try {
      await api.localNoteDelete(note.noteId);
      localDataStore.publish("note"); // page-1 reload converges the filter/page state
      toast.success("已删除");
      setActionNote(null);
      setConfirmDelete(false);
      setSheet("");
    } catch (e: any) {
      toast.error(failureCopy(e, "删除失败，请重试。"));
    } finally { setMutating(false); }
  }

  const emptyState = describeLocalEmpty({ mode, tag: applied.tag, query });
  const loadedText = notesLoadedText(localPage.items.length, localPage.total);

    const visibleBodies = useRef(new Set<string>());
  const [visibleBodyTick, setVisibleBodyTick] = useState(0);
  const noteVisibility = useCallback((route: string, visible: boolean) => {
    const had=visibleBodies.current.has(route);
    if (visible) visibleBodies.current.add(route); else visibleBodies.current.delete(route);
    if (had!==visible) setVisibleBodyTick(v=>v+1);
  }, []);
  useEffect(() => {
    const currentRows=directoryActive ? directorySnap.rows : desktop.rows;
    const scope={instance:desktop.instanceId,vault:desktop.vaultId};
    const publish=()=>{
      const targets=[...visibleBodies.current].map(noteIdOfRoute).map(id=>currentRows.find(r=>r.noteId===id))
        .filter((row): row is NonNullable<typeof row> => Boolean(row))
        .map(row=>({...scope,id:row.noteId,revision:row.revision || ""}));
      desktopNotePrefetch.setVisible(scope,targets,active&&source==="desktop"&&connected&&!document.hidden
        && Boolean(scope.instance&&scope.vault) && (directoryActive ? directorySnap.query : desktop.query)===query.trim());
      if(document.hidden || !connected)desktopNotePrefetch.suspend();
    };
    publish(); document.addEventListener("visibilitychange",publish);
    return ()=>{ document.removeEventListener("visibilitychange",publish); desktopNotePrefetch.setVisible(scope,[],false); };
  }, [active,source,connected,desktop.instanceId,desktop.vaultId,desktop.rows,desktop.query,directoryActive,directorySnap.rows,directorySnap.query,query,visibleBodyTick]);

  const localSourceSwipe = {};

  // ------------------------------------------------------------------
  // Desktop source keeps the unchanged CollectionView path (read-only rows).
  // ------------------------------------------------------------------
  if (source === "desktop") {
    // The folder inventory is independent of paged note metadata. Search is
    // deliberately a flat whole-vault view; clearing it restores the folder.
    const vaultLabel = query.trim() ? "搜索全部笔记" : directoryActive
      ? ""
      : desktop.vaultName
        ? `${desktop.replica?.waitingCurrent ? "手机保存" : "当前知识库"} · ${desktop.vaultName}`
        : "电脑知识库";
    // R1-REPAIR (5B): canonical registeredList carries no sort, so the desktop
    // source hides the (would-be-inert) sort affordance. Local keeps its own.

  return (
      <>
        <CollectionView
          domain="knowledge"
          sourceSwitchSlot={modeSwitch}
          source={source}
          onSource={() => {}}
          query={query}
          onQuery={setQuery}
          onFilter={undefined}
          onNew={() => { void createDesktopNote(); }}
          onBrowse={() => setSheet("vault")}
          onRefresh={() => setReloadKey((k) => k + 1)}
          notes={items}
          assets={[]}
          open={(page, id) => {
            // In selection mode a tap TOGGLES the note instead of opening it
            // (the gesture authority swallows the trailing long-press click).
            if (page === "note" && selecting && id) {
              setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
              return;
            }
            // The active Desktop vault keeps its existing Content V1
            // detail/editor route — read-side only here.
            if (page === "note" && id) {
              const snapshot = directoryActive ? directorySnap : desktop;
              // S1 keeps the old rows during a debounced query. Do not open
              // them under a NEW query or pass its ranges to an old result.
              if (snapshot.query !== query.trim() || snapshot.phase === "searching") return;
              const row = snapshot.rows.find(row => row.noteId === noteIdOfRoute(id));
              const target = query.trim() ? row?.searchHit ?? { query: query.trim() } : undefined;
              open("note", id, { noteSearch: target });
            }
            else if (page === "connect") open("connect");
          }}
          paired={Boolean(conn?.paired)}
          connected={connected}
          list={false}
          onList={() => {}}
          // ORG-1B REPAIR-R1.1: the SAME #85 gesture/range primitives, wired
          // to the NOTE rows (data-note-id hit targets). Long press anchors
          // the range; a held drag (and its edge auto-scroll) grows/shrinks
          // it; finger-up freezes it; plain taps toggle while selecting.
          onNoteVisibility={source === "desktop" ? noteVisibility : undefined}
          selecting={source === "desktop" && selecting}
          selectedIds={source === "desktop" ? selectedIds : undefined}
          onLongPress={source === "desktop" ? onNoteLongPress : undefined}
          onDragSelect={source === "desktop" ? (x, y) => {
            applyNoteDragPoint(x, y);
            const scroller = document.elementFromPoint(x, y)?.closest?.(".st-scroll") as HTMLElement | null;
            if (scroller) dragAutoScrollRef.current!.update(scroller, y, applyNoteDragPoint, x);
          } : undefined}
          onDragEnd={source === "desktop" ? () => {
            dragAutoScrollRef.current!.stop();
            rangeDragRef.current = null;
            endpointRef.current = null;
          } : undefined}
          selectionBar={source === "desktop" && selecting ? {
            count: selectedIds.length,
            busy: moveBusy || orgCtrl.isBusy(),
            onCancel: () => {
              // REPAIR-R1.4 (ABA): an explicit cancel retires the run's
              // generation — no in-flight completion may reapply UI.
              moveGenerationRef.current += 1;
              setSelecting(false);
              setSelectedIds([]);
            },
            onOrganize: () => setMoveSheetOpen(true),
            organizeLabel: "移动",
          } : undefined}
          // R2-REPAIR (1): the canonical status and the bounded load-more live
          // INSIDE the scroll region as bounded slots — never after the
          // full-height view, never off-screen.
          filterLabel={vaultLabel}
          hideContextLabel
          toolbarSlot={<div className="st-compact-toolbar st-knowledge-toolbar">
            <div className="st-knowledge-trail">
              {desktopDirectory && !query.trim() ? <FolderBreadcrumbs current={desktopDirectory} onSelect={setDesktopDirectory} /> : <span>{query.trim() ? "搜索全部笔记" : "全部笔记"}</span>}
            </div>
            <IconButton icon="filter" label="筛选笔记" onClick={() => setSheet("desktop-filter")} />
            <IconButton icon="folder" label="新建文件夹" className="st-folder-create" onClick={() => setSheet("desktop-folder-info")} />
          </div>}
          disableNew={!(createAuthority?.usable === true && (desktop.replica ? desktop.replica.writeState === "granted" : connected)) || busy}
          hideFilter
          scrollTop={desktopScrollByScope.get(desktopScrollKey) ?? 0}
          onScroll={(top) => { desktopScrollByScope.set(desktopScrollKey, top); }}
          statusSlot={<>
            {!query.trim() && desktop.vaultId ? <>
              <FolderRows showStatus={false} snapshot={folderSnapshot} current={desktopDirectory} online={connected} onSelect={setDesktopDirectory} />
            </> : null}
            {directoryActive
              ? withBatchOutcome(<DirectoryStatusLine quiet snapshot={directorySnap} onConnect={() => open("connect")} />)
              : withBatchOutcome(<DesktopKnowledgeStatus quiet snapshot={desktop} onConnect={() => open("connect")} />)}
          </>}
          loadMoreSlot={directoryActive
            ? (directorySnap.phase === "loading-more" || (directorySnap.hasMore && directorySnap.phase === "ready") ? (
              <div style={{ padding: "10px 23px 4px" }}>
                <Button kind="quiet" disabled={directorySnap.phase === "loading-more"}
                  onClick={() => directoryCtrl.loadMore()}>
                  {directorySnap.phase === "loading-more" ? "正在加载…" : "加载更多"}
                </Button>
              </div>
            ) : null)
            : (desktop.phase === "loading-more" || (desktop.hasMore && (desktop.phase === "ready" || desktop.replica)) ? (
              <div style={{ padding: "10px 23px 4px" }}>
                <Button kind="quiet" disabled={desktop.phase === "loading-more"}
                  onClick={() => desktopCtrl.loadMore()}>
                  {desktop.phase === "loading-more" ? "正在加载…" : "加载更多"}
                </Button>
              </div>
            ) : null)}
        />

        {sheet === "desktop-filter" ? <DirectorySheet
          registerOverlay={registerOverlay} onClose={() => setSheet("")}
          instanceId={instanceId} vaultId={desktop.vaultId} vaultName={desktop.vaultName || "LuckyRay 知识库"}
          connected={connected} current={desktopDirectory} title="筛选笔记" rootLabel="全部笔记"
          notice="按目录查看笔记。电脑接口暂不支持按置顶或收藏筛选。"
          onSelect={path => { setQuery(""); setDesktopDirectory(path); setSheet(""); }} /> : null}
        {sheet === "desktop-folder-info" ? <Sheet title="新建文件夹" registerDismiss={registerOverlay} onClose={() => setSheet("")}>
          <p className="st-sheet-copy">当前电脑知识库接口尚不支持从手机新建文件夹。请先在电脑端创建，再刷新此页。</p>
        </Sheet> : null}
        {sheet === "filter" ? (
          <KnowledgeFilterSheet
            draft={draft.current.getDraft()}
            source={source}
            onEdit={(patch) => { draft.current.edit(patch); bump((n) => n + 1); }}
            onReset={() => { draft.current.reset(); bump((n) => n + 1); }}
            onApply={() => {
              const v = draft.current.commit();
              appliedRef.current = v;
              session.ui.localFilter = { mode: v.mode, sort: v.sort, tag: v.tag };
              if (v.sort === "recent" || v.sort === "name") setNotesSort(v.sort);
              setSheet("");
            }}
            onClose={() => { draft.current.cancel(); setSheet(""); }}
            registerOverlay={registerOverlay}
          />
        ) : null}
        {sheet === "vault" ? (
          <DirectoryLibrarySheet instance={instanceId} kind="knowledge" fallback={desktop.vaultName}
            registerOverlay={registerOverlay} onClose={() => setSheet("")}
            onSelect={async (id, isCurrent) => {
              if (!await desktopLibraries.switchTo(instanceId, "knowledge", id, () => isCurrent() && currentInstanceRef.current === instanceId)) return false;
              setSelectedIds([]); setSelecting(false);
              return true;
            }}
            directory={<DirectoryContents registerOverlay={registerOverlay} onClose={() => setSheet("")}
              instanceId={instanceId} vaultId={desktop.vaultId} vaultName={desktop.vaultName || "LuckyRay 知识库"}
              connected={connected} current={desktopDirectory} title="目录" rootLabel="全部笔记"
              onSelect={path => { setQuery(""); setDesktopDirectory(path); setSheet(""); }}
              syncManagement={<>
                <div onClick={() => setSheet("")}>{management}</div>
                <Option label="本机笔记" icon="knowledge" onClick={() => { setSource("local"); setSheet(""); }} />
                <KnowledgeReplicaManagement instance={instanceId} vault={desktop.vaultId} connected={connected} onChanged={() => desktopCtrl.revalidateReplica()} />
              </>} />} />
        ) : null}
        {/* ORG-1B: the batch/single move destination — ROOT + the existing
            synced directories ONLY (no create), with the real capability
            truth resolved fresh and a fail-closed copy when unavailable. */}
        {moveSheetOpen ? (
          <DirectorySheet
            registerOverlay={registerOverlay}
            onClose={() => { if (!moveBusy) setMoveSheetOpen(false); }}
            instanceId={instanceId}
            vaultId={desktop.vaultId}
            vaultName={desktop.vaultName || "LuckyRay 知识库"}
            connected={connected}
            current={selectedIds.length === 1 ? singleMoveCurrentParent() : "（多选）"}
            title="移动到目录"
            rootLabel="根目录（全部笔记）"
            notice={moveUnavailableReason(moveAuthority) || undefined}
            onSelect={(dir) => { void runMove(dir); }}
          />
        ) : null}
      </>
    );
  }

  // ------------------------------------------------------------------
  // Local source: the usability-closed composition. Same Still primitives
  // and row language; pagination / quick actions / truthful empties.
  // ------------------------------------------------------------------
  return (
    <>
      <div className="st-view st-knowledge-view" data-swipe-owner="sources" {...localSourceSwipe} style={{ touchAction: "pan-y" }}>
        <div className="st-collection-head">
          {modeSwitch}
          <IconButton icon="folder" label="选择知识库" onClick={() => setSheet("notebooks")} />
          <IconButton icon="file" label="导入笔记文件" onClick={() => void pickLocalNoteFile()} />
          <IconButton icon="edit" label="新建笔记" onClick={() => void createNote()} disabled={busy} />
        </div>
        <div className="st-collection-top">
          <SearchField value={query} onChange={setQuery} placeholder="搜索笔记" />
        </div>
        <div
          className="st-scroll"
          ref={(el) => {
            if (el && Math.abs(el.scrollTop - rememberedScroll[source]) > 1) {
              el.scrollTop = rememberedScroll[source];
            }
          }}
          onScroll={(e) => { rememberedScroll[source] = (e.target as HTMLElement).scrollTop; }}
        >
          <div className="st-compact-toolbar st-knowledge-toolbar">
            <div className="st-knowledge-trail">
              {directory && !query.trim() ? <FolderBreadcrumbs current={directory} onSelect={setDirectory} /> : <span>{query.trim() ? "搜索全部笔记" : localHeading || "全部笔记"}</span>}
            </div>
            <IconButton icon="filter" label="筛选与排序"
              onClick={() => { draft.current.begin(); bump(n => n + 1); setSheet("filter"); }}
              className={localHeading ? "st-filter-active" : ""} />
            <IconButton icon="folder" label="新建文件夹" className="st-folder-create"
              onClick={() => { setFolderName(""); setFolderError(""); setSheet("create-folder"); }} />
          </div>
          {localFolderError ? <p className="st-sheet-copy" role="status">{localFolderError}<Button kind="quiet" onClick={() => setReloadKey(k => k + 1)}>重试</Button></p> : null}
          {!query.trim() ? <section className="st-knowledge-folders" aria-label="本机文件夹">
            {folderChildren(localFolders, directory).map(path => <button type="button" key={path} className="st-folder-row" onClick={() => setDirectory(path)}>
              <span className="st-folder-symbol"><Icon name="folder" size={20} /></span><span className="st-folder-name">{path.slice(path.lastIndexOf("/") + 1)}</span><Icon name="right" size={14} />
            </button>)}
          </section> : null}
          {localRows.length ? (
            <div>
              {localRows.map((n) => (
                <div key={n.id} className="st-local-note-entry">
                  <button className="st-note-row" style={{ flex: 1, minWidth: 0 }} onClick={() => open("note", n.id, { noteSearch: query.trim() ? { query: query.trim() } : undefined })}>
                    <span className="st-knowledge-note-symbol" aria-hidden="true"><Icon name="file" size={20} /></span>
                    <strong>{n.title}</strong>
                    <p>{n.body}</p>
                    {/* UX-POLISH-R1 5: the title line starts clean; pin and
                        favorite are quiet flags on the RIGHT of the metadata
                        line (indicators only — mutations stay in the actions
                        sheet through the real handlers). */}
                    <small>
                      <span className="st-note-meta">
                        {n.meta}
                        {n.archived ? " · 已归档" : ""}
                        {n.tags?.length ? " · " + n.tags.join(" / ") : ""}
                      </span>
                      <span className="st-note-flags">
                        {n.pinned ? <span role="img" aria-label="已置顶"><Icon name="pin" size={12} className="st-flag-pin" /></span> : null}
                        {n.favorite ? <span role="img" aria-label="已收藏"><Icon name="heart" size={12} className="st-flag-fav is-on" /></span> : null}
                      </span>
                    </small>
                  </button>
                  <IconButton
                    icon="more"
                    label={`笔记操作：${n.title}`}
                    onClick={() => openNoteActions(n.raw)}
                  />
                </div>
              ))}
              {localPage.hasMore ? (
                <Button
                  kind="quiet"
                  disabled={localPage.loading}
                  onClick={() => void pager.loadMore(localFilters())}
                >
                  {localPage.loading ? "正在加载…" : "加载更多"}
                </Button>
              ) : null}
              {loadedText ? (
                <p className="st-sheet-caption" style={{ textAlign: "center" }}>{loadedText}</p>
              ) : null}
            </div>
          ) : (
            <Empty
              title={directory && !query.trim() ? "此文件夹还没有笔记" : emptyState.title}
              body={directory && !query.trim() ? "在这里新建笔记，或从笔记操作中移入已有笔记。" : emptyState.body}
            >
              {emptyState.action === "new" ? (
                <Button kind="quiet" onClick={() => void createNote()}>新建笔记</Button>
              ) : emptyState.action === "clear-search" ? (
                <Button kind="quiet" onClick={() => setQuery("")}>清除搜索</Button>
              ) : (
                <Button kind="quiet" onClick={() => { draft.current.begin(); bump((n) => n + 1); setSheet("filter"); }}>调整筛选</Button>
              )}
            </Empty>
          )}
        </div>
      </div>
      {sheet === "filter" ? (
        <KnowledgeFilterSheet
          draft={draft.current.getDraft()}
          source={source}
          availableTags={draftTags}
          onEdit={(patch) => { draft.current.edit(patch); bump((n) => n + 1); }}
          onReset={() => { draft.current.reset(); bump((n) => n + 1); }}
          onApply={() => {
            const v = draft.current.commit();
            appliedRef.current = v;
            session.ui.localFilter = { mode: v.mode, sort: v.sort, tag: v.tag };
            if (v.sort === "recent" || v.sort === "name") setNotesSort(v.sort);
            setSheet("");
          }}
          onClose={() => { draft.current.cancel(); setSheet(""); }}
          registerOverlay={registerOverlay}
        />
      ) : null}
      {sheet === "note-actions" && actionNote ? (
        <Sheet
          title="笔记操作"
          registerDismiss={registerOverlay}
          onClose={closeNoteActions}
        >
          {confirmDelete ? (
            <>
              <p className="st-sheet-caption">删除后无法恢复。确定删除「{actionNote.title || "无标题笔记"}」？</p>
              {mutating ? <p className="st-sheet-caption" role="status">正在删除…</p> : null}
              <Option label="确认删除" danger onClick={() => void deleteActionNote()} />
              <Option label="先不删" selected={false} onClick={() => setConfirmDelete(false)} />
            </>
          ) : (
            <>
              {mutating ? <p className="st-sheet-caption" role="status">正在同步…</p> : null}
              <Option label={actionNote.pinned ? "取消置顶" : "置顶"} icon="pin" onClick={() => void toggleNoteFlag("pinned")} />
              <Option label={actionNote.favorite ? "取消收藏" : "收藏"} onClick={() => void toggleNoteFlag("favorite")} />
              <Option label={actionNote.archived ? "取消归档" : "归档"} onClick={() => void toggleNoteFlag("archived")} />
              <Option label="上传到电脑知识库" icon="monitor" onClick={() => setSheet("upload-local")} />
              <Option label="移动到文件夹" icon="folder" onClick={() => setSheet("move-local")} />
              <Option label="删除" danger onClick={() => setConfirmDelete(true)} />
            </>
          )}
        </Sheet>
      ) : null}
      {sheet === "create-folder" ? <Sheet title="新建文件夹" registerDismiss={registerOverlay}
        busy={folderSaving} onClose={() => { if (!folderBusy.current) setSheet(""); }}
        footer={<><Button kind="quiet" disabled={folderSaving} onClick={() => setSheet("")}>取消</Button><Button disabled={folderSaving || !folderName.trim()} onClick={() => void createLocalFolder()}>{folderSaving ? "创建中…" : "创建"}</Button></>}>
        <p className="st-sheet-caption">位置：{directory || "本机笔记"}</p>
        <label className="st-folder-name-field">文件夹名称<input autoFocus value={folderName} maxLength={120} disabled={folderSaving}
          onChange={e => { setFolderName(e.target.value); setFolderError(""); }} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void createLocalFolder(); } }} /></label>
        {folderError ? <p className="st-folder-error" role="alert">{folderError}</p> : null}
      </Sheet> : null}
      {sheet === "move-local" ? <Sheet title="移动到文件夹" registerDismiss={registerOverlay} busy={folderSaving}
        onClose={() => { if (!folderBusy.current) setSheet(""); }}>
        <Option label="根目录" icon="folder" selected={!actionNote?.folder} onClick={() => void moveLocalNote("")} />
        {localFolders.map(path => <Option key={path} label={path} icon="folder" selected={actionNote?.folder === path} onClick={() => void moveLocalNote(path)} />)}
      </Sheet> : null}
      {sheet === "upload-local" && actionNote ? <LocalNoteUploadSheet noteId={actionNote.noteId} conn={conn} registerOverlay={registerOverlay} onClose={closeNoteActions} /> : null}
      {sheet === "notebooks" ? (
        <Sheet title="目录与库" registerDismiss={registerOverlay} onClose={() => setSheet("")}>
          <div onClick={() => setSheet("")}>{management}</div>
          <Option label="导入文件" detail="仅导入 .md / .markdown / .txt 的文字；关联附件不会自动复制" icon="file" onClick={() => { setSheet(""); void pickLocalNoteFile(); }} />
          <Option label="本机笔记" icon="knowledge" selected onClick={() => { setSource("local"); setSheet(""); }} />
          <Option label="LuckyRay 电脑知识库" icon="monitor" onClick={() => { setSource("desktop"); setSheet(""); }} />
        </Sheet>
      ) : null}
    </>
  );
}

function KnowledgeFilterSheet({ draft, source, availableTags = [], onEdit, onReset, onApply, onClose, registerOverlay }: {
  draft: KnowledgeFilterState;
  source: "local" | "desktop";
  /** Tags offered for the LOCAL draft (derived from the authority's rows). */
  availableTags?: string[];
  onEdit: (patch: Partial<KnowledgeFilterState>) => void;
  onReset: () => void;
  onApply: () => void;
  onClose: () => void;
  registerOverlay: (d: () => void) => () => void;
}) {
  return (
    <Sheet title="筛选与排序" registerDismiss={registerOverlay} onClose={onClose}
      footer={<>
        <Button kind="quiet" onClick={onReset}>重置</Button>
        <Button onClick={onApply}>应用</Button>
      </>}>
      {source === "local" ? (
        <>
          <p className="st-sheet-caption">范围</p>
          {([["local", "全部笔记"], ["pinned", "置顶"], ["favorite", "收藏"], ["archived", "归档"]] as const).map(([v, t]) => (
            <Option key={v} label={t} selected={draft.mode === v} onClick={() => onEdit({ mode: v })} />
          ))}
          <p className="st-sheet-caption">标签</p>
          <Option label="全部标签" selected={!draft.tag} onClick={() => onEdit({ tag: "" })} />
          {availableTags.map((t) => (
            <Option key={t} label={`#${t}`} selected={draft.tag === t} onClick={() => onEdit({ tag: t })} />
          ))}
        </>
      ) : null}
      <p className="st-sheet-caption">排序</p>
      {([["recent", "最近更新"], ["name", "名称"]] as const).map(([v, t]) => (
        <Option key={v} label={t} selected={draft.sort === v} onClick={() => onEdit({ sort: v })} />
      ))}
    </Sheet>
  );
}


// R1-REPAIR (4) — the REAL Desktop knowledge status line. Every canonical
// browse phase lands here as product copy, inside the view flow (rendered
// between the toolbar and the notes), so a QA sweep of the real component IS
// the product presentation. Desktop never falls through to the local
// "给想法留个位置 / 新建笔记" empty composition.
