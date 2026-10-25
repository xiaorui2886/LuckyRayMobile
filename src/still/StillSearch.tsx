import { managedVault, managedNoteRoute, type ManagedNote } from "../services/managedVault";
import { noteSearchEvidence } from "./kit/noteSearch";
import { useDesktopLibraries } from "./kit/DesktopLibraryPicker";
// STILL-01.1 — 搜索 page: 本机 + 电脑 real content.
//
// SERVICES-SEARCH-R1: the Desktop search half now runs through the canonical
// Services path — `ServiceRegistry` + `SearchSession` (`search.unified`) over
// the Rust-backed production transport — composed in
// `searchServicesController.ts`. The LOCAL half keeps the accepted
// `useUnifiedSearch` authority untouched. This page only feeds events and
// renders snapshots; it owns no search truth.
import { Empty, Header, IconButton, Row, SectionTitle, Button, SearchField } from "../presentation/still01/Still";
import { useUnifiedSearch } from "../services/unifiedSearch";
import { searchResultKey } from "../services/searchContract";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "../services/client";
import { useMemo, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { desktopAssetRoute } from "./kit/materialOrganization";
import {
  deriveSearchPagePresentation,
} from "./kit/searchPresentation";
import {
  DesktopResultsSection, remoteSearchUnavailableText,
} from "./kit/desktopResultsSection";
import {
  SearchServicesController, type RemoteSearchSnapshot,
} from "./kit/searchServicesController";
import {
  createProductionServices, createTauriServicesTransport,
} from "../services/companionServices/index.ts";
import { SearchSession } from "../services/companionServices/searchClient.ts";
import type { SearchHit, ServiceCatalog } from "../../shared/companion-services-v1/types.ts";
import { useStillNav } from "./StillShell";

export function StillSearch() {
  const { conn, open, back } = useStillNav();
  const { state, setQuery, loadMore } = useUnifiedSearch();
  const q = state.query.trim();
  const [managedSearch, setManagedSearch] = useState<{ query: string; vault: string; items: ManagedNote[]; page: number; hasMore: boolean; loading: boolean; error: boolean }>({ query: "", vault: "", items: [], page: 0, hasMore: false, loading: false, error: false });
  const managedGeneration = useRef(0);
  const [managedVersion, setManagedVersion] = useState(0);
  useEffect(() => { const changed = () => setManagedVersion(value => value + 1); window.addEventListener("luckyray:managed-vault-change", changed); return () => window.removeEventListener("luckyray:managed-vault-change", changed); }, []);
  useEffect(() => {
    const generation = ++managedGeneration.current;
    setManagedSearch({ query: q, vault: "", items: [], page: 0, hasMore: false, loading: Boolean(q), error: false });
    if (!q) return;
    void (async () => {
      try {
        const vaults = await managedVault.list();
        const selected = vaults.items.find(vault => vault.localVaultId === vaults.selectedVaultId && vault.migrationState === "ready");
        const result = selected ? await managedVault.notes({ localVaultId: selected.localVaultId, q, page: 1, limit: 50 }) : { items: [], hasMore: false };
        if (managedGeneration.current === generation) setManagedSearch({ query: q, vault: selected?.localVaultId || "", items: result.items, page: 1, hasMore: result.hasMore, loading: false, error: false });
      } catch { if (managedGeneration.current === generation) setManagedSearch(previous => ({ ...previous, loading: false, error: true })); }
    })();
    return () => { ++managedGeneration.current; };
  }, [q, managedVersion]);
  async function moreManaged() {
    if (managedSearch.loading || !managedSearch.vault || managedSearch.query !== q) return;
    const generation = managedGeneration.current;
    setManagedSearch(previous => ({ ...previous, loading: true }));
    try {
      const result = await managedVault.notes({ localVaultId: managedSearch.vault, q, page: managedSearch.page + 1, limit: 50 });
      if (managedGeneration.current === generation) setManagedSearch(previous => ({ ...previous, items: [...previous.items, ...result.items], page: previous.page + 1, hasMore: result.hasMore, loading: false, error: false }));
    } catch { if (managedGeneration.current === generation) setManagedSearch(previous => ({ ...previous, loading: false, error: true })); }
  }
  const managedItems = managedSearch.query === q ? managedSearch.items : [];
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const mountedRef = useRef(true);

  const paired = Boolean(conn?.paired);
  const instanceId = conn?.identity?.instanceId || "";

  // One production composition for the page's lifetime; the controller owns
  // all canonical Desktop search truth (discovery/permission/session).
  const libraries = useDesktopLibraries(instanceId,conn?.ws?.state === "connected");
  const library = libraries.catalog?.scopeSelectionVersion === 1 ? libraries.material : undefined;
  const vault = libraries.catalog?.scopeSelectionVersion === 1 ? libraries.vault : undefined;
  const services = useMemo(() => createProductionServices({library,vault}), [library,vault]);
  const controller = useMemo(() => new SearchServicesController({registry:services.registry,
    session:new SearchSession(createTauriServicesTransport(undefined,{library,vault}))}), [services,library,vault]);
  const remote = useSyncExternalStore<RemoteSearchSnapshot>(
    (fn) => controller.subscribe(fn),
    () => controller.snapshot()
  );

  // Feed: SYNCHRONOUS identity (pairing + Desktop instance). An instance or
  // pairing change retires the prior remote search at once.
  useEffect(() => {
    controller.setConnection({ paired, instanceId, isLive: () => mountedRef.current });
  }, [controller, paired, instanceId]);

  // Same-Desktop connection transitions through the page's existing ws signal:
  // a drop retires the outstanding epoch; a reconnect rebinds and re-reads.
  const wsState = conn?.ws?.state || "";
  const prevWsRef = useRef(wsState);
  useEffect(() => {
    const prev = prevWsRef.current;
    prevWsRef.current = wsState;
    if (prev === wsState) return;
    if (prev === "connected" && wsState !== "connected") controller.disconnected();
    else if (wsState === "connected" && prev !== "connected" && paired && instanceId) {
      controller.reconnect();
    }
  }, [controller, wsState, paired, instanceId]);

  useEffect(() => { controller.setQuery(q); }, [controller, q]);

  // REPAIR-R2: permission truth for the SAME live query, driven by the SHARED
  // Services change-feed the page already owns (the same `changeFeed` /
  // `createHintSubscription` composition as the rest of the product — no new
  // worker, no second owner, no raw WebSocket, no new route/grant).
  //
  // Bounded poll (not a subscription): read whatever the shared worker has
  // buffered and let the change feed's own authority decide whether the
  // permission revision actually moved. A no-op read never re-triggers, so
  // there is no recursion (the previous registry.subscribe wiring recursed
  // through invalidate() -> notify()).
  useEffect(() => {
    if (!paired || !instanceId) return;
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      try {
        if (services.changeFeed.currentMode() !== "hints") {
          await services.changeFeed.start(instanceId);
        }
        const hints = await services.changeFeed.readHints();
        const stale = services.changeFeed.permissionTruthStale(hints);
        if (stale !== null && alive) controller.permissionChanged();
      } catch {
        /* a failed refresh is silent: the query keeps its last known truth */
      }
    };
    void tick();
    const timer = setInterval(() => { void tick(); }, 15000);
    return () => { alive = false; clearInterval(timer); };
  }, [services, controller, paired, instanceId]);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; controller.retire(); }; }, [controller]);

  useEffect(() => {
    let alive = true;
    for (const res of state.items) {
      if (res.resultType !== "asset" || thumbs[res.id]) continue;
      api.localAssetThumbnail(res.id).then((t) => {
        if (alive && t?.uri) setThumbs((prev) => ({ ...prev, [res.id]: convertFileSrc(t.uri) }));
      }).catch(() => {});
    }
    return () => { alive = false; };
  }, [state.items, thumbs]);

  const [searchAliases, setSearchAliases] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    const routes = [...state.items.filter(row => row.resultType === "note").map(row => row.id), ...remote.hits.flatMap(hit => hit.domain === "knowledge" ? [`desktop:${encodeURIComponent(remote.instanceId)}:${encodeURIComponent(hit.vaultId)}:${encodeURIComponent(hit.noteId)}`] : [])];
    void Promise.all(routes.map(async route => {
      try { const target = await managedVault.resolveLegacy(route); return [route, target ? managedNoteRoute(target.localVaultId, target.noteId) : ""] as const; }
      catch { return [route, ""] as const; } // Keep unverified legacy results visible; opening still fails closed.
    })).then(aliases => { if (alive) setSearchAliases(Object.fromEntries(aliases)); });
    return () => { alive = false; };
  }, [state.items, remote.hits, remote.instanceId, managedVersion]);
  // A migrated alias no longer owns search truth, even when its stale SQLite
  // text matches a query that the authoritative file no longer matches.
  const localNotes = state.items.filter((r) => r.resultType === "note" && !searchAliases[r.id]);
  const visibleRemote = { ...remote, hits: remote.hits.filter(hit => hit.domain !== "knowledge" || !searchAliases[`desktop:${encodeURIComponent(remote.instanceId)}:${encodeURIComponent(hit.vaultId)}:${encodeURIComponent(hit.noteId)}`]) };
  const localAssets = state.items.filter((r) => r.resultType === "asset");
  const localEntries = state.items.filter((r) => r.resultType !== "note" && r.resultType !== "asset");
  const localCount = managedItems.length + localNotes.length + localAssets.length + localEntries.length;

  // Combined presentation: local + canonical remote must BOTH be settled
  // before the page may claim emptiness.
  const presentation = deriveSearchPagePresentation({
    localLoading: state.loading,
    localCount,
    remote,
  });

  const emptyBody = !paired
    ? `本机没有包含「${q}」的内容。连接电脑后可以一起搜索电脑上的内容。`
    : remoteSearchUnavailableText(remote)
      ? `本机没有包含「${q}」的内容；${remoteSearchUnavailableText(remote)}`
      : `本机与电脑上都没有包含「${q}」的内容。`;

  /** Route a canonical hit with the identity captured by the search. */
  function openHit(hit: SearchHit): void {
    const instance = remote.instanceId;
    if (hit.domain === "materials") {
      open("asset", desktopAssetRoute(instance, hit.assetId, library));
      return;
    }
    open("note", `desktop:${encodeURIComponent(instance)}:${encodeURIComponent(hit.vaultId)}:${encodeURIComponent(hit.noteId)}`);
  }

  return (
    <div className="st-view">
      <Header title="搜索" left={<IconButton icon="back" label="返回上一页" onClick={back} />} />
      <div className="st-scroll">
        <SearchField value={state.query} onChange={setQuery} placeholder="搜索手机和电脑上的内容" autoFocus />
        {!q ? (
          <Empty title="笔记、素材与收集箱" body="搜索本机和电脑上的内容（电脑需已配对）。" />
        ) : presentation.loading ? (
          <Empty title="搜索中…" />
        ) : (
          <>
            {managedItems.length ? <><SectionTitle>笔记</SectionTitle>{managedItems.map(note => <Row key={managedNoteRoute(note.localVaultId, note.noteId)} title={note.title || "未命名笔记"} meta={note.relativePath} onClick={() => open("note", managedNoteRoute(note.localVaultId, note.noteId), { noteSearch: noteSearchEvidence(q, note.content) })} />)}</> : null}
            {managedSearch.loading ? <p role="status">正在查找本地文件…</p> : null}
            {managedSearch.error ? <Button kind="quiet" onClick={() => setManagedVersion(value => value + 1)}>重试本地文件搜索</Button> : null}
            {managedSearch.hasMore ? <Button kind="quiet" disabled={managedSearch.loading} onClick={() => void moreManaged()}>更多笔记</Button> : null}
            {localNotes.length ? (
              <>
                <SectionTitle>原有笔记</SectionTitle>
                {localNotes.map((res) => (
                  <Row key={searchResultKey(res)} title={res.title || "未命名笔记"} meta={res.snippet || "本机笔记"}
                    onClick={() => open("note", res.id)} />
                ))}
              </>
            ) : null}
            {localAssets.length ? (
              <>
                <SectionTitle>本机素材</SectionTitle>
                {localAssets.map((res) => (
                  <Row key={searchResultKey(res)} title={res.title || "未命名素材"} thumb={thumbs[res.id]}
                    onClick={() => open("asset", "local:" + res.id)} />
                ))}
              </>
            ) : null}
            {localEntries.length ? (
              <>
                <SectionTitle>收集箱</SectionTitle>
                {localEntries.map((res) => (
                  <Row key={searchResultKey(res)} title={res.title || "收集内容"} meta={res.snippet || "收集箱"}
                    onClick={() => open("inbox-detail", res.id)} />
                ))}
              </>
            ) : null}
            <DesktopResultsSection
              remote={visibleRemote}
              localCount={localCount}
              onOpenHit={openHit}
              onLoadMore={() => controller.loadMore()}
            />
            {presentation.empty && !managedSearch.loading && !managedSearch.error ? <Empty title="没有找到相关内容" body={emptyBody} /> : null}
            {state.hasMore ? (
              <div style={{ marginTop: 14 }}>
                <Button kind="quiet" disabled={state.loading} onClick={() => loadMore()}>
                  {state.loading ? "加载中…" : "加载更多"}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );

}

