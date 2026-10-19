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
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
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
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const mountedRef = useRef(true);

  const paired = Boolean(conn?.paired);
  const instanceId = conn?.identity?.instanceId || "";

  // One production composition for the page's lifetime; the controller owns
  // all canonical Desktop search truth (discovery/permission/session).
  const servicesRef = useRef<ReturnType<typeof createProductionServices> | null>(null);
  if (!servicesRef.current) servicesRef.current = createProductionServices();
  const services = servicesRef.current;
  const ctrlRef = useRef<SearchServicesController | null>(null);
  if (!ctrlRef.current) {
    ctrlRef.current = new SearchServicesController({
      registry: services.registry,
      session: new SearchSession(createTauriServicesTransport()),
    });
  }
  const controller = ctrlRef.current;
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
  useEffect(() => () => { mountedRef.current = false; controller.retire(); }, [controller]);

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

  const localNotes = state.items.filter((r) => r.resultType === "note");
  const localAssets = state.items.filter((r) => r.resultType === "asset");
  const localEntries = state.items.filter((r) => r.resultType !== "note" && r.resultType !== "asset");
  const localCount = localNotes.length + localAssets.length + localEntries.length;

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
      open("asset", desktopAssetRoute(instance, hit.assetId));
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
            {localNotes.length ? (
              <>
                <SectionTitle>本机笔记</SectionTitle>
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
              remote={remote}
              localCount={localCount}
              onOpenHit={openHit}
              onLoadMore={() => controller.loadMore()}
            />
            {presentation.empty ? <Empty title="没有找到相关内容" body={emptyBody} /> : null}
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
