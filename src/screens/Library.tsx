// Library.tsx (STITCH-R6) — 素材.
//
// Visual source: R6 `function library(desktop)`. Structure:
//   source axis (本机 / 电脑) + import action → tool row (search + filter)
//   → section title → media grid (grid/list preference preserved)
//
// Behaviour source: production, unchanged. Local Assets stay phone-owned
// durable data; Desktop assets stay a read-only cached domain; kind filtering
// still happens in SQL so pagination stays exact; the Desktop source remains
// VISIBLE while unpaired and renders a truthful connect state instead of
// hiding (DESIGN.md §9).
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { dataStore } from "../services/dataStore";
import Thumb from "../components/asset/Thumb";
import DesktopLibrary from "../components/DesktopLibrary";
import { api, type ConnState } from "../services/client";
import { IconFilter, IconGrid, IconImage, IconPlus, IconRefresh } from "../components/icons";
import type { Tab } from "../App";
import { EmptyState, OptionRow, SearchField, SectionTitle, Sheet, SourceTabs } from "../components/ui";
import {
  filterLibraryAssets,
  localKindFilter,
  type DesktopAsset,
  type LibraryDomain,
} from "../services/libraryFilter";
import {
  commitNextPage,
  commitPageOne,
  initialLocalPage,
  localPageLoading,
  localPageStart,
  LOCAL_PAGE_SIZE,
  resetLocalPage,
  type LocalPageState,
} from "../services/libraryPagination";
import { thumbnailScheduler } from "../services/thumbnailQueue";
import { localDataStore } from "../services/localDataStore";
import { libraryEmptyState } from "../services/productShell";
import { failureCopy } from "../services/feedback";
import { toast } from "../services/toast";
import {
  getLibrarySort,
  getLibraryView,
  setLibrarySort,
  setLibraryView,
  sortRows,
  SORT_LABELS,
  type LibraryView,
  type SortKey,
} from "../services/viewPreferences";
import { FilterDraft, defaultLibraryFilter } from "../services/filterDraft";

type Props = { conn: ConnState | null; go: (tab: Tab, detail?: string) => void; refresh: () => void };

const KINDS: { key: string; label: string }[] = [
  { key: "全部", label: "全部类型" },
  { key: "图片", label: "图片" },
  { key: "视频", label: "视频" },
  { key: "文档", label: "文档" },
  { key: "文件", label: "文件" },
];
const SORTS: { key: SortKey; label: string }[] = [
  { key: "recent", label: SORT_LABELS.recent },
  { key: "name", label: SORT_LABELS.name },
  { key: "size", label: SORT_LABELS.size },
];
let rememberedDomain: LibraryDomain = "local";

export default function Library({ conn, go, refresh }: Props) {
  const [domain, setDomain] = useState<LibraryDomain>(rememberedDomain);
  useEffect(() => { rememberedDomain = domain; }, [domain]);
  const [kind, setKind] = useState("全部");
  const [search, setSearch] = useState("");
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [archivedOnly, setArchivedOnly] = useState(false);
  const [view, setView] = useState<LibraryView>(getLibraryView);
  const [sort, setSort] = useState<SortKey>(getLibrarySort);
  const [filtersOpen, setFiltersOpen] = useState(false);
  // INTERACTION-CLOSURE-R1: real draft/apply/cancel (see Knowledge).
  const filterDraftRef = useRef(new FilterDraft(defaultLibraryFilter));
  const [, bumpDraft] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  const [localPage, setLocalPage] = useState<LocalPageState>(initialLocalPage);
  const queryGenRef = useRef(0);
  const [desktopAssets, setDesktopAssets] = useState<DesktopAsset[]>([]);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [localReloadKey, setLocalReloadKey] = useState(0);

  const reload = () => setReloadKey((k) => k + 1);
  const [desktopReloadSignal, setDesktopReloadSignal] = useState(0);

  // Still observe external Mobile-local asset mutations while mounted+hidden.
  useEffect(() => {
    return localDataStore.subscribe((d) => {
      if (d === "asset") setLocalReloadKey((k) => k + 1);
    });
  }, []);

  const kindFilter = localKindFilter(kind);

  useEffect(() => {
    const gen = ++queryGenRef.current;
    setLocalPage((prev) => localPageLoading(resetLocalPage(prev)));
    api
      .localAssetList({
        kind: kindFilter,
        q: search.trim() || undefined,
        favorite: favoriteOnly ? true : undefined,
        archived: archivedOnly ? true : false,
        page: 1,
        limit: LOCAL_PAGE_SIZE,
      })
      .then((r) => {
        if (gen !== queryGenRef.current) return;
        setLocalPage((prev) => commitPageOne(prev, gen, r.items || [], r.total, r.hasMore));
      })
      .catch((e: any) => {
        if (gen !== queryGenRef.current) return;
        setLocalPage((prev) => ({ ...initialLocalPage(), generation: prev.generation }));
        toast.error(failureCopy(e, "读取本机素材失败。"));
      });
  }, [kindFilter, search, favoriteOnly, archivedOnly, reloadKey, localReloadKey]);

  useEffect(() => {
    let alive = true;
    if (conn?.paired) {
      api
        .assetsLocal(0, 200, kind === "全部" ? undefined : kindFilter)
        .then((r) => {
          if (alive) setDesktopAssets(r.items || []);
        })
        .catch(() => {});
    } else {
      setDesktopAssets([]);
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn?.paired, kind, reloadKey]);

  const version = useSyncExternalStore(
    (fn) => dataStore.subscribe(fn),
    () => dataStore.getVersion()
  );
  useEffect(() => {
    reload();
  }, [version]);

  async function loadMore() {
    if (localPage.loading || !localPage.hasMore) return;
    const gen = queryGenRef.current;
    const page = localPageStart(localPage);
    setLocalPage((prev) => (prev.loading || !prev.hasMore ? prev : { ...prev, loading: true }));
    try {
      const r = await api.localAssetList({
        kind: kindFilter,
        q: search.trim() || undefined,
        favorite: favoriteOnly ? true : undefined,
        archived: archivedOnly ? true : false,
        page,
        limit: LOCAL_PAGE_SIZE,
      });
      if (gen !== queryGenRef.current) return;
      setLocalPage((prev) => commitNextPage(prev, gen, page, r.items || [], r.total, r.hasMore));
    } catch (e: any) {
      if (gen !== queryGenRef.current) return;
      setLocalPage((prev) => (prev.generation !== gen ? prev : { ...prev, loading: false }));
      toast.error(failureCopy(e, "加载更多失败。"));
    }
  }

  async function importMedia(m: "image" | "video" | "file") {
    setBusy(true);
    setImportOpen(false);
    try {
      const r = await api.localAssetImport(m);
      if (r?.cancelled) {
        toast.info("已取消导入");
      } else {
        toast.success(`已导入「${r?.name ?? m}」`);
        reload();
        refresh();
        localDataStore.publish("asset");
      }
    } catch (e: any) {
      toast.error(failureCopy(e, "导入失败，请重试。"));
    } finally {
      setBusy(false);
    }
  }

  const { localItems, desktopItems } = filterLibraryAssets({
    domain,
    kind,
    localAssets: localPage.items,
    desktopAssets,
    isPaired: Boolean(conn?.paired),
    localTotal: localPage.total,
  });

  const orderedLocal = useMemo(() => sortRows(localItems, sort), [localItems, sort]);
  const orderedDesktop = useMemo(() => sortRows(desktopItems, sort), [desktopItems, sort]);
  const total = localItems.length + desktopItems.length;
  const activeFilterCount = (kind !== "全部" ? 1 : 0) + (favoriteOnly ? 1 : 0) + (archivedOnly ? 1 : 0);

  // R6 renders TWO source tabs: 本机 / 电脑. 本机 maps to the `local` domain
  // (NOT `all`) so Desktop cached assets can never leak into the phone-owned
  // list — provenance stays separated (FEATURE_PARITY.md).
  const sourceItems: { key: LibraryDomain; label: string }[] = [
    { key: "local", label: "本机" },
    { key: "desktop", label: "电脑" },
  ];

  return (
    <>
      {/* Source axis: the Desktop source stays visible while unpaired and the
          section below renders the truthful connect state. */}
      <div className="root-source-row">
        <SourceTabs
          items={sourceItems}
          value={domain === "desktop" ? "desktop" : "local"}
          onChange={(v) => setDomain(v)}
          ariaLabel="素材来源"
        />
        {/* INTERACTION-CLOSURE-R1: desktop refresh lives next to the header `+`
            (user request); local keeps 导入到本机 as the header action. */}
        {domain === "desktop" ? (
          <button className="nav-action" aria-label="刷新电脑素材" onClick={() => { setDesktopReloadSignal((k) => k + 1); refresh(); }}>
            <IconRefresh size={18} />
          </button>
        ) : (
          <button className="nav-action" aria-label="导入到本机" disabled={busy} onClick={() => setImportOpen(true)}>
            <IconPlus size={18} />
          </button>
        )}
      </div>

      <div className="tool-row">
        <SearchField
          value={search}
          onChange={setSearch}
          placeholder={domain === "desktop" ? "搜索电脑素材" : "搜索名称、标签、类型"}
        />
        <button
          className={"filter-btn" + (activeFilterCount || sort !== "recent" ? " accent" : "")}
          aria-label="筛选与排序"
          onClick={() => setFiltersOpen(true)}
        >
          <IconFilter size={18} />
        </button>
      </div>

      {domain === "desktop" ? (
        conn?.identity ? (
          <DesktopLibrary
            key={conn.identity.instanceId}
            instance={conn.identity.instanceId}
            name={conn.identity.displayName}
            open={(id) => go("library", id)}
            query={search}
            reloadSignal={desktopReloadSignal}
          />
        ) : (
          <>
            <SectionTitle title="电脑素材" meta="未连接" />
            <EmptyState
              icon={<IconGrid size={20} />}
              title="还没有连接电脑"
              body="连接电脑后可以在这里浏览电脑上的素材，按需预览原文件。"
              action={
                <button className="primary" onClick={() => go("settings", "connect-computer")}>
                  连接电脑
                </button>
              }
            />
          </>
        )
      ) : (
        <>
          <SectionTitle
            title={kind === "全部" ? "全部" : kind}
            meta={total ? `${total} 项 · ${SORT_LABELS[sort]}` : undefined}
          />
          {total === 0 && !localPage.loading ? (
            <EmptyState
              icon={<IconImage size={20} />}
              title={localPage.total ? "没有匹配的素材" : "本机还没有素材"}
              body={libraryEmptyState(Boolean(conn?.paired), domain)}
              action={
                <button className="primary" onClick={() => setImportOpen(true)}>
                  导入到本机
                </button>
              }
            />
          ) : (
            <>
              <div className={"media-grid" + (view === "list" ? " list-view" : "")}>
                {orderedLocal.map((a, i) => (
                  <button key={a.assetId} className="tile" onClick={() => go("library", `local:${a.assetId}`)}>
                    <span className={`thumb ${artTone(a.kind, i)}`}>
                      <LocalThumb assetId={a.assetId} kind={a.kind} />
                    </span>
                    <span className="tile-caption">
                      <span className="tile-name">{a.name}</span>
                      <span className="tile-meta">
                        {kindLabel(a.kind)} · {fmtSize(a.sizeBytes)}
                        {a.favorite ? " · ★" : ""}
                        {a.archived ? " · 已归档" : ""}
                      </span>
                    </span>
                  </button>
                ))}
                {orderedDesktop.map((a, i) => (
                  <button key={a.desktopAssetId} className="tile" onClick={() => go("library", a.desktopAssetId)}>
                    <span className={`thumb ${artTone(a.kind, i)}`}>
                      <Thumb instance={conn?.identity?.instanceId || ""} id={a.desktopAssetId} />
                    </span>
                    <span className="tile-caption">
                      <span className="tile-name">{a.name}</span>
                      <span className="tile-meta">电脑 · {fmtSize(a.sizeBytes)}</span>
                    </span>
                  </button>
                ))}
              </div>
              {localPage.hasMore ? (
                <button className="quiet btn-block load-more" disabled={localPage.loading} onClick={loadMore}>
                  {localPage.loading ? "加载中…" : "加载更多"}
                </button>
              ) : total > 0 ? (
                <p className="list-foot">已显示 {total} 项</p>
              ) : null}
            </>
          )}
        </>
      )}

      {/* Import sheet */}
      <Sheet open={importOpen} onClose={() => setImportOpen(false)} title="导入到本机暂存">
        <OptionRow label="图片" hint="从相册选择" onClick={() => importMedia("image")} />
        <OptionRow label="视频" hint="从相册选择" onClick={() => importMedia("video")} />
        <OptionRow label="文件" hint="任意文档或压缩包" onClick={() => importMedia("file")} />
      </Sheet>

      {/* Filter & sort sheet — REAL draft/apply/cancel (INTERACTION-CLOSURE-
          R1 §6.1): rows edit the draft; 显示结果 commits (driving the real SQL
          re-query); backdrop/Back/取消 discard. */}
      <Sheet
        open={filtersOpen}
        onClose={() => {
          filterDraftRef.current.cancel();
          setFiltersOpen(false);
        }}
        title="筛选与排序"
        footer={
          <button
            className="primary btn-block"
            style={{ marginTop: 14 }}
            onClick={() => {
              const applied = filterDraftRef.current.commit();
              setKind(applied.kind);
              setFavoriteOnly(applied.favoriteOnly);
              setArchivedOnly(applied.archivedOnly);
              if (applied.sort === "recent" || applied.sort === "name" || applied.sort === "size") {
                setSort(setLibrarySort(applied.sort));
              }
              setView(setLibraryView(applied.view));
              setFiltersOpen(false);
            }}
          >
            显示结果
          </button>
        }
      >
        {KINDS.map((k) => (
          <OptionRow
            key={k.key}
            label={k.label}
            active={filterDraftRef.current.getDraft().kind === k.key}
            onClick={() => {
              filterDraftRef.current.edit({ kind: k.key });
              bumpDraft((n) => n + 1);
            }}
          />
        ))}
        <OptionRow
          label="仅收藏"
          active={filterDraftRef.current.getDraft().favoriteOnly}
          onClick={() => {
            filterDraftRef.current.edit({ favoriteOnly: !filterDraftRef.current.getDraft().favoriteOnly });
            bumpDraft((n) => n + 1);
          }}
        />
        <OptionRow
          label="显示归档"
          active={filterDraftRef.current.getDraft().archivedOnly}
          onClick={() => {
            filterDraftRef.current.edit({ archivedOnly: !filterDraftRef.current.getDraft().archivedOnly });
            bumpDraft((n) => n + 1);
          }}
        />
        {SORTS.map((s) => (
          <OptionRow
            key={s.key}
            label={s.label}
            active={filterDraftRef.current.getDraft().sort === s.key}
            onClick={() => {
              filterDraftRef.current.edit({ sort: s.key });
              bumpDraft((n) => n + 1);
            }}
          />
        ))}
        <OptionRow
          label="网格视图"
          hint="缩略图"
          active={filterDraftRef.current.getDraft().view === "grid"}
          onClick={() => {
            filterDraftRef.current.edit({ view: "grid" });
            bumpDraft((n) => n + 1);
          }}
        />
        <OptionRow
          label="列表视图"
          hint="完整名称"
          active={filterDraftRef.current.getDraft().view === "list"}
          onClick={() => {
            filterDraftRef.current.edit({ view: "list" });
            bumpDraft((n) => n + 1);
          }}
        />
        <button
          className="quiet btn-block"
          style={{ marginTop: 12 }}
          onClick={() => {
            filterDraftRef.current.reset();
            bumpDraft((n) => n + 1);
          }}
        >
          恢复默认
        </button>
      </Sheet>
    </>
  );
}

function LocalThumb({ assetId, kind }: { assetId: string; kind: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let alive = true;
    if (kind !== "image") return;
    setSrc("");
    thumbnailScheduler
      .enqueue(assetId, () => api.localAssetThumbnail(assetId))
      .then((t) => {
        if (alive && t?.uri) setSrc(convertFileSrc(t.uri));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [assetId, kind]);
  if (!src) return null;
  return <img src={src} alt="" />;
}

function artTone(kind: string, index?: number): string {
  if (typeof index === "number") {
    const tones = ["a", "b", "c", "d", "b", "a"];
    return tones[index % tones.length];
  }
  switch (kind) {
    case "image":
      return "a";
    case "video":
      return "b";
    case "document":
      return "c";
    default:
      return "d";
  }
}

function kindLabel(kind: string) {
  switch (kind) {
    case "image":
      return "图片";
    case "video":
      return "视频";
    case "document":
      return "文档";
    case "file":
      return "文件";
    default:
      return kind;
  }
}

function fmtSize(n: number) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}
