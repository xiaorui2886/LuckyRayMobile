// STILL-01.1 — Library (Still CollectionView, real local pager + Desktop data).
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { CollectionView, type AssetItem } from "../presentation/still01/Views";
import { Sheet, Option, Button, Empty } from "./kit/StillImports";
import { LibrarySession } from "./kit/librarySession";

// Bounded list-mode thumbnail window: a first screen (near) plus one prefetch
// screen (tail). Offscreen list rows stay on their placeholder until visible.
const LIST_NEAR_COUNT = 8;
const LIST_THUMB_WINDOW = 20;
type FilterValue = { kind: string; flags: string[]; sort: string; view: "grid" | "list"; tag: string; folder: string };
type FilterOptions = { kinds: { value: string; label: string }[]; flags: { value: string; label: string }[]; sorts: { value: string; label: string }[] };
import { api, type ConnState } from "../services/client";
import { dataStore } from "../services/dataStore";
import { localDataStore } from "../services/localDataStore";
import { convertFileSrc } from "@tauri-apps/api/core";
import { thumbnailScheduler, localThumbKey, desktopThumbKey, materialImageVersion } from "../services/thumbnailQueue";
import { LocalAssetPager, assetsLoadedText, type AssetFilters } from "../services/localAssetPager";
import { localKindFilter } from "../services/libraryFilter";
import {
getLibraryView, setLibrarySort, setLibraryView,
  sortRows, SORT_LABELS, type SortKey,
} from "../services/viewPreferences";
import { FilterDraft, defaultLibraryFilter } from "../services/filterDraft";
import { failureCopy } from "../services/feedback";
import { toast } from "../services/toast";
import { fmtBytes } from "./stillData";
import { MaterialOrganizationController, desktopAssetRoute } from "./kit/materialOrganization";
import {
  DesktopPageAuthority, desktopIdentityOf, rowsForSnapshot,
} from "../services/desktopPageAuthority";
import { createDragAutoScroll, type DragAutoScroll } from "./kit/dragAutoScroll";
import { indexOfId, selectionWithRange, type RangeDrag } from "./kit/rangeSelect";
import { useStillNav } from "./StillShell";

type Props = {
  conn: ConnState | null;
  active?: boolean;
};

let rememberedDomain: "local" | "desktop" = "local";

// R7 (B2): the drag-select hint is shown at most once per app session — a
// light nudge the first time a drag actually grows the selection, never a
// recurring interruption.
let dragSelectHintShown = false;const KINDS = [
  { value: "全部", label: "全部类型" }, { value: "图片", label: "图片" },
  { value: "视频", label: "视频" }, { value: "文档", label: "文档" }, { value: "文件", label: "文件" },
];
const SORTS = [
  { value: "recent", label: SORT_LABELS.recent },
  { value: "name", label: SORT_LABELS.name },
  { value: "size", label: SORT_LABELS.size },
];
const DESKTOP_KINDS=[{value:"",label:"全部类型"},{value:"image",label:"图片"},{value:"video",label:"视频"},{value:"document",label:"文档"},{value:"audio",label:"音频"},{value:"other",label:"其他"}];

type Applied = { kind: string; favoriteOnly: boolean; archivedOnly: boolean; sort: string; view: "grid" | "list"; tag: string };
const DEFAULTS: Applied = { kind: "全部", favoriteOnly: false, archivedOnly: false, sort: "recent", view: "grid", tag: "" };

export function StillLibrary({ conn, active = true }: Props) {
  const { open, registerOverlay } = useStillNav();
  const [domain, setDomain] = useState<"local" | "desktop">(rememberedDomain);
  useEffect(() => { rememberedDomain = domain; }, [domain]);
  const draft = useRef(new FilterDraft(defaultLibraryFilter));
  const [, bump] = useState(0);
  const [applied, setApplied] = useState<Applied>(DEFAULTS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // 浏览（folder/browse）与导入（plus/import）是两条完全独立的交互：
  // browse 打开真实筛选/目录/标签，import 打开 native 导入。
  const [browseOpen, setBrowseOpen] = useState(false);
  const [desktopFolder, setDesktopFolder] = useState("");
  const [desktopTag, setDesktopTag] = useState("");
  const [desktopKind,setDesktopKind]=useState("");
  const [desktopKindDraft,setDesktopKindDraft]=useState("");
  const [sourceQueries, setSourceQueries] = useState({ local: "", desktop: "" });
  const localQuery = sourceQueries.local, desktopQuery = sourceQueries.desktop;
  const query = sourceQueries[domain];
  const setQuery = (value: string) => setSourceQueries(prev => ({ ...prev, [domain]: value }));
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // Wave A: batch organization. Selection mode applies to the Desktop material
  // source only; local materials keep their existing behaviour.
  const org = useRef(new MaterialOrganizationController({
    setFavorite: (i, id, fav) => api.contentMaterialSetFavorite(i, id, fav),
    setTags: (i, id, patch) => api.contentMaterialSetTags(i, id, patch),
    setFolder: (i, id, folderId) => api.contentMaterialSetFolder(i, id, folderId),
    createTag: (i, name) => api.contentMaterialCreateTag(i, name),
    createFolder: (i, name) => api.contentMaterialCreateFolder(i, name),
    batch: (i, input) => api.contentMaterialBatch(i, input),
  })).current;
  const [orgSnapshot, setOrgSnapshot] = useState(org.snapshot());
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchSheet, setBatchSheet] = useState<"" | "actions" | "tags" | "folder">("");
  const [batchTags, setBatchTags] = useState<{ id: string; name: string }[]>([]);
  const [batchFolders, setBatchFolders] = useState<{ id: string; label: string }[]>([]);
  // A1: the local list runs through the ONE request-epoch pager authority —
  // immutable request identity, generation invalidation on every identity
  // change, and loadMore that can only continue the active request.
  const pagerRef = useRef<LocalAssetPager | null>(null);
  if (!pagerRef.current) {
    pagerRef.current = new LocalAssetPager(
      // Every field comes from the request identity the pager handed us —
      // never from mutable outside state.
      (f) =>
        api.localAssetList({
          kind: f.kind,
          q: f.q,
          tag: f.tag,
          favorite: f.favorite,
          archived: f.archived,
          sort: f.sort,
          page: f.page,
          limit: f.limit,
        }),
      (e) => toast.error(failureCopy(e, "读取本机素材失败。"))
    );
  }
  const assetPager = pagerRef.current;
  const localPage = useSyncExternalStore(
    (fn) => assetPager.subscribe(fn),
    () => assetPager.getState()
  );
  // MATERIAL-LIBRARY-INSTANT-R1 REPAIR-R5: ONE authority owns the Desktop owner
  // lifecycle AND the request sequencing. Previously two independent effects
  // both advanced a generation counter, so binding an owner could retire the
  // page-1 the same commit had just issued — the response was dropped and the
  // page stayed "正在读取素材…" until Refresh. `bind` now retires and then
  // requests, as a single ordered transition nothing else can pre-empt.
  const desktopAuthorityRef = useRef<DesktopPageAuthority | null>(null);
  if (!desktopAuthorityRef.current) {
    desktopAuthorityRef.current = new DesktopPageAuthority(
      async (owner, source, page) => {
        const value = await api.contentAssets(owner, {
          page, limit: 100, q: source.query.trim(), kind: source.kind || "",
          folder: source.folder || undefined, tag: source.tag || undefined,
        });
        return value;
      },
      (e) => toast.error(failureCopy(e, "读取电脑素材失败。"))
    );
  }
  const desktopAuthority = desktopAuthorityRef.current;
  const desktopSnapshot = useSyncExternalStore(
    (fn) => desktopAuthority.subscribe(fn),
    () => desktopAuthority.snapshot()
  );
  useEffect(() => () => desktopAuthority.dispose(), [desktopAuthority]);
  // The Desktop instance the current page belongs to. A Desktop switch must
  // never silently retarget an A page onto B.
  const desktopOwnerRef = useRef("");
  // Desktop-domain store events (sync content, pairing, desktop cache) refresh
  // the DESKTOP list only. They must never blank the LOCAL list: the local
  // rows are revalidated in place through their own authority (UX-POLISH-R1
  // §3.3 — the偶发整页刷新 root cause was exactly this shared key).
  const version = useSyncExternalStore(
    (fn) => dataStore.subscribe(fn),
    () => dataStore.getVersion()
  );
  // A5: local mutations (import/favorite/archive/rename/delete) publish
  // localDataStore("asset"); the LOCAL list revalidates from that bus. The two
  // authorities stay separate — a local publish never triggers a Desktop call.
  const localVersion = useSyncExternalStore(
    (fn) => localDataStore.subscribe(fn),
    () => localDataStore.getVersion()
  );
  // A3: the tag picker reads the Local Asset tag AUTHORITY, not the loaded
  // page: tags that exist only on later pages are still offered, and an
  // applied tag never hides the others. Local-only; Desktop never sees it.
  const [tagVocabulary, setTagVocabulary] = useState<string[]>([]);
  useEffect(() => {
    if (domain !== "local") return;
    let alive = true;
    api.localAssetTags()
      .then((r) => { if (alive) setTagVocabulary(r?.tags || []); })
      .catch(() => { if (alive) setTagVocabulary([]); });
    return () => { alive = false; };
  }, [domain, localVersion, reloadKey]);
  const filterTags = filtersOpen
    ? collectAssetTags(tagVocabulary.map((t) => ({ tags: [t] })), draft.current.getDraft().tag)
    : [];

  // Bound to the current Desktop identity: switching Desktop fences any
  // in-flight organization request and clears the selection.
  useEffect(() => {
    org.setIdentity(conn?.identity?.instanceId || "");
    setSelectedIds([]);
    setSelecting(false);
    return org.subscribe(setOrgSnapshot);
  }, [org, conn?.identity?.instanceId]);
  useEffect(() => () => org.dispose(), [org]);
  // Leaving the Desktop source ends selection mode.
  useEffect(() => {
    if (domain !== "desktop") { setSelecting(false); setSelectedIds([]); }
  }, [domain]);
  // R7 (三): while multi-select is active, the system BACK (key or edge
  // gesture — both reach the same pipeline) first EXITS the selection instead
  // of leaving the page. The cancelable event follows the exact pattern the
  // note editor already uses (luckyray:desktop-note-back); nothing about the
  // normal back semantics changes when no selection is active.
  useEffect(() => {
    const onSelectionBack = (e: Event) => {
      if (!selecting || !active) return;
      e.preventDefault();
      setSelecting(false);
      setSelectedIds([]);
    };
    window.addEventListener("luckyray:selection-back", onSelectionBack);
    return () => window.removeEventListener("luckyray:selection-back", onSelectionBack);
  }, [selecting, active]);
  useEffect(() => {
    if (active) return;
    setBrowseOpen(false); setFiltersOpen(false); setImportOpen(false); setBatchSheet("");
    dragAutoScrollRef.current?.stop();
  }, [active]);



  const kindFilter = localKindFilter(applied.kind);
  // The retained-source authority (MATERIAL-LIBRARY-INSTANT-R1): one instance
  // for the page's lifetime, holding a last-good snapshot per source plus each
  // source's scroll offset.
  const session = useMemo(() => new LibrarySession(), []);
  /** The Local request identity as a stable string (query/kind/tag/range/sort). */
  const localIdentity = (): string => {
    const f = localFilters();
    return ["local", f.q ?? "", f.kind ?? "", f.tag ?? "", String(f.favorite ?? ""), String(f.archived ?? ""), f.sort ?? ""].join("|");
  };
  /** The Desktop request identity INCLUDING the producing instance.
   *  Delegates to the authority module so the page, the request and the render
   *  gate can never disagree about what "the same page" means. */
  const desktopIdentity = (owner: string): string =>
    desktopIdentityOf({ owner, query: desktopQuery.trim(), folder: desktopFolder, tag: desktopTag,kind:desktopKind });
  /** The CURRENT Desktop source axes (owner added per call site). */
  const DESKTOP_SOURCE = () => ({
    query: desktopQuery.trim(), folder: desktopFolder || "", tag: desktopTag || "",
    kind:desktopKind,
  });
  /** The CURRENT request identity: query/kind/tag/range/sort, all of them.
   *  Built fresh on every use so a loadMore can prove it is continuing the
   *  same identity the active page-1 used. */
  const localFilters = (q: string = localQuery): AssetFilters => ({
    q: q.trim() || undefined,
    kind: kindFilter,
    tag: applied.tag || undefined,
    favorite: applied.favoriteOnly ? true : undefined,
    archived: applied.archivedOnly ? true : false,
    sort: (applied.sort === "name" || applied.sort === "size" ? applied.sort : "recent"),
  });
  // Request-IDENTITY changes (query/kind/tag/range/sort/source) are the only
  // thing that may clear and reload the local list. Two further triggers keep
  // their own bounded paths instead of riding this one:
  //   * localVersion (a real local mutation) → pager.revalidate: rows stay
  //     mounted, fresh page-1 swaps in — no blank frame;
  //   * reloadKey (an explicit user refresh) → reload, with visible feedback.
  useEffect(() => {
    // MATERIAL-LIBRARY-INSTANT-R1 REPAIR-R1: this effect depends ONLY on the
    // Local request identity. `domain` is deliberately absent — a source
    // toggle must never invalidate or reload the Local list, so returning to
    // 本机 paints the retained rows in the same frame (no 200 ms wait).
    //
    // The identity changed the moment a filter/query/sort moved: invalidate the
    // CURRENT generation immediately (closing the debounce/loadMore mixing
    // window); only the page-1 FETCH waits for the debounce (typing only).
    const identity = localIdentity();
    session.bind("local", identity);
    assetPager.invalidate();
    const timer = setTimeout(() => assetPager.reload(localFilters()), 200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetPager, session, localQuery, kindFilter, applied]);
  // REPAIR-R2 (2): the Local settled/empty truth is committed from the pager's
  // OWN state stream, so a successful zero-row page-1 becomes settled-empty,
  // a failure never masquerades as empty, and an identity change goes back to
  // pending. One product authority (the pager) feeds the retained session.
  useEffect(() => {
    const sync = (state: any) => {
      const identity = localIdentity();
      session.bind("local", identity);
      if (state.loading) {
        session.beginRefresh("local", identity);
        return;
      }
      // REPAIR-R3 (1): the outcome is EXPLICIT, never inferred from
      // `loading === false` — a rejected page-1 also clears loading and would
      // otherwise commit zero rows as a false "settled empty".
      const outcome = assetPager.lastOutcome();
      if (outcome === "settled") {
        session.commit("local", identity, state.items ?? []); // rows, or a true empty
        return;
      }
      if (outcome === "error") {
        // Keep whatever rows are on screen and mark them stale; with no rows
        // the state stays pending so the page can never claim "没有找到素材".
        if ((state.items ?? []).length > 0) session.fail("local", identity);
        else session.beginRefresh("local", identity);
        return;
      }
      // "pending": nothing requested yet, or a newer attempt is in flight.
      if (state.generation === 0 && state.page === 0) return;
      session.beginRefresh("local", identity);
    };
    sync(assetPager.getState());
    return assetPager.subscribe(sync);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetPager, session, localQuery, kindFilter, applied]);

  // A local mutation refreshes the SAME identity in place (never blanks).
  useEffect(() => {
    if (domain !== "local") return;
    assetPager.revalidate(localFilters());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetPager, domain, localVersion]);
  // An explicit user refresh reloads page 1 with visible feedback. The mount
  // run is a no-op: the identity effect above owns the initial load.
  const firstRefresh = useRef(true);
  useEffect(() => {
    if (firstRefresh.current) { firstRefresh.current = false; return; }
    if (domain !== "local") return;
    assetPager.invalidate();
    assetPager.reload(localFilters());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetPager, reloadKey]);

  function loadMore() {
    // Refuses unless the caller's identity IS the active request, and appends
    // using the ACTIVE identity — the debounce mixing window is closed.
    if (domain === "desktop") void desktopAuthority.loadMore(DESKTOP_SOURCE());
    else void assetPager.loadMore(localFilters());
  }

  // Desktop: real content query (single search owner = this query field).
  // The rows belong to ONE concrete Desktop instance. The request is issued
  // against that owner (the authority enforces it), and both the owner and the
  // generation must still be current for the response to commit — so a slower
  // A response can never repopulate a newer B page.
  const desktopOwner = conn?.identity?.instanceId || "";
  useEffect(() => {
    desktopOwnerRef.current = desktopOwner;
  }, [desktopOwner]);
  // The owner lifecycle and its FIRST page-1, as ONE ordered transition.
  //
  // `bind` retires the previous owner's page (rows, staleness, identity) and
  // then immediately requests the current identity. Because the retirement and
  // the request happen inside the same call, no other effect can slip a
  // generation bump in between and retire the request — which is exactly how
  // the physical device ended up permanently pending, with Refresh as the only
  // way out. An owner switch stays fail-closed: A's rows are dropped before B
  // is requested, and a late A response can never commit (the authority fences
  // on generation AND owner).
  useEffect(() => {
    if (!conn?.paired || !desktopOwner) {
      // Unpaired / disconnected: retire the page rather than leaving A's rows
      // actionable behind a dead owner.
      desktopAuthority.bind("", DESKTOP_SOURCE());
      setDesktopThumbs({});
      return;
    }
    desktopAuthority.bind(desktopOwner, DESKTOP_SOURCE());
    // A new owner starts with a clean thumbnail namespace, and any selection
    // made against the previous owner is dropped (Desktop A selections must
    // never survive into B).
    setDesktopThumbs({});
    setSelectedIds([]);
    setSelecting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktopAuthority, conn?.paired, desktopOwner]);

  // A query / folder / tag change is an IDENTITY change on the SAME owner: it
  // retires the retained rows and requests the new identity. Kept separate from
  // the owner bind above so an identity change can never be mistaken for an
  // owner switch (and vice versa).
  useEffect(() => {
    if (!conn?.paired || !desktopOwner) return;
    const source = DESKTOP_SOURCE();
    if (desktopAuthority.isCurrent(desktopIdentityOf({ ...source, owner: desktopOwner }))) return;
    // Debounce typing before the bounded Content read, not a fake load delay.
    // Render identity gates already hide older query results immediately.
    const timer = setTimeout(() => desktopAuthority.request(source), 180);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktopAuthority, desktopQuery, desktopFolder, desktopTag,desktopKind]);

  // An explicit user refresh re-runs the CURRENT identity in place, and it
  // FORCES the read so an explicit refresh always reaches the wire.
  //
  // REPAIR-R5c: `force` bypasses the authority's coalescing, which is correct
  // for a real user action but wrong for this effect's FIRST run. The effect
  // fires once on mount just like every other effect, and on mount there is no
  // user intent behind it: it would issue a second page-1 and retire the one
  // the owner bind had just started (forcing = it cannot be coalesced away), so
  // the first entry into 电脑 would again lose its response. This guard skips
  // exactly the mount run.
  //
  // This is NOT the race-hiding guard R5b removed: it does not paper over an
  // authority ordering problem, it distinguishes "React mounted this effect"
  // from "the user pressed Refresh". The ordering itself is still owned by the
  // authority, and every later reloadKey change is a genuine refresh.
  const refreshArmed = useRef(false);
  useEffect(() => {
    if (!refreshArmed.current) { refreshArmed.current = true; return; }
    if (!conn?.paired || !desktopOwner) return;
    desktopAuthority.revalidate(DESKTOP_SOURCE(), true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktopAuthority, reloadKey]);

  // Desktop-domain store events (sync content, pairing, desktop cache) re-run
  // the CURRENT identity. They must never blank the LOCAL list: the local rows
  // are revalidated in place through their own authority.
  useEffect(() => {
    if (!conn?.paired || !desktopOwner) return;
    desktopAuthority.revalidate(DESKTOP_SOURCE());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktopAuthority, version]);

  // Rows are only ever rendered while their producing Desktop is STILL the
  // current one, and while their identity is EXACTLY the current request's.
  // Both facts now come from the ONE authority that issued and committed them,
  // so the page cannot disagree with the pipeline that produced the rows.
  const committedDesktopOwner = desktopSnapshot.owner;
  const currentDesktopIdentity = desktopOwner ? desktopIdentity(desktopOwner) : "";
  const desktopItems = rowsForSnapshot(desktopSnapshot, desktopOwner, currentDesktopIdentity);
  // Desktop thumbnails are keyed by Desktop asset id within the CURRENT owner's
  // namespace (the owner change effect below clears exactly this map).
  const [desktopThumbs, setDesktopThumbs] = useState<Record<string, string>>({});
  const desktopRowsRef = useRef(desktopItems);
  desktopRowsRef.current = desktopItems;
  const desktopThumbVersions = useRef<Record<string,string>>({});

  // 切换 本机 ↔ 电脑：browse 状态与目录/标签轴绝不泄漏到另一边。
  useEffect(() => {
    setBrowseOpen(false);
  }, [domain]);

  // Desktop thumbnails resolve through the real thumbnail authority too, keyed
  // by the owner that produced the rows.
  // Desktop thumbnails go through the SAME bounded scheduler as Local ones —
  // never a 100-item burst of direct Tauri calls. Keys are source-qualified
  // (`desktop:<owner>:<assetId>`) so an owner change or a source toggle can
  // never collide with, or erase, the other source's entries. Work is started
  // viewport-first: tiles ask for their thumbnail when they come near the
  // viewport (MediaTile.onVisible), and everything else stays queued.
  // The map is read through a ref so a retry is never blocked by the closure
  // that was current when the tile first rendered (REPAIR-R1 D3).
  const desktopThumbsRef = useRef<Record<string, string>>({});
  const requestDesktopThumb = useCallback((
    owner: string, desktopAssetId: string, force = false,
    priority: "near" | "tail" = "near",
  ) => {
    if (!owner || !desktopAssetId) return;
    const row=desktopRowsRef.current.find(a=>a.desktopAssetId===desktopAssetId);
    if (!row) return;
    const revision=materialImageVersion(row);
    if (!force && desktopThumbsRef.current[desktopAssetId] && desktopThumbVersions.current[desktopAssetId]===revision) return;
    thumbnailScheduler
      .enqueue(desktopThumbKey(owner, desktopAssetId,revision), () => api.assetThumbnail(owner, desktopAssetId, force,false,revision), priority)
      .then((t: any) => {
        if (desktopOwnerRef.current !== owner || !t?.uri) return;
        const current=desktopRowsRef.current.find(a=>a.desktopAssetId===desktopAssetId);
        if (!current || materialImageVersion(current)!==revision) return;
        desktopThumbVersions.current[desktopAssetId]=revision;
        const url = convertFileSrc(t.uri);
        desktopThumbsRef.current = { ...desktopThumbsRef.current, [desktopAssetId]: url };
        setDesktopThumbs((prev) => ({ ...prev, [desktopAssetId]: url }));
      })
      .catch(() => { /* placeholder art stays; the tile geometry is stable */ });
  }, []);
  useEffect(() => { desktopThumbsRef.current = desktopThumbs; }, [desktopThumbs]);
  useEffect(() => {
    const valid=new Map(desktopItems.map(a=>[a.desktopAssetId,materialImageVersion(a)]));
    const allowed=new Set(desktopItems.map(a=>desktopThumbKey(committedDesktopOwner,a.desktopAssetId,materialImageVersion(a))));
    setDesktopThumbs(prev=> {
      const next=Object.fromEntries(Object.entries(prev).filter(([id])=>valid.has(id)&&desktopThumbVersions.current[id]===valid.get(id)));
      return Object.keys(next).length===Object.keys(prev).length ? prev : next;
    });
    desktopThumbVersions.current=Object.fromEntries(Object.entries(desktopThumbVersions.current).filter(([id])=>valid.has(id)));
    thumbnailScheduler.cancelPending(key=>key.startsWith("desktop:")&&!key.endsWith(":screen")&&!allowed.has(key));
  }, [desktopItems,committedDesktopOwner]);

  async function importMedia(m: "image" | "video" | "file") {
    setBusy(true);
    try {
      const r = await api.localAssetImport(m);
      // A5: a successful import publishes the LOCAL asset domain so Library,
      // Home and Settings all converge; a cancel publishes nothing.
      if (r?.cancelled) toast.info("已取消导入");
      else { toast.success(`已导入「${r?.name ?? m}」`); localDataStore.publish("asset"); }
    } catch (e: any) {
      toast.error(failureCopy(e, "导入失败，请重试。"));
    } finally { setBusy(false); }
  }

  // Source-qualified thumbnail state: Local is keyed by local asset id, Desktop
  // by Desktop instance + asset id. A Desktop owner change clears ONLY the
  // Desktop map (below); a source toggle clears neither.
  const [thumbMap, setThumbMap] = useState<Record<string, string>>({});
  const localThumbVersions=useRef<Record<string,string>>({});
  const localThumbsRef=useRef(thumbMap); localThumbsRef.current=thumbMap;
  const requestLocalThumb=useCallback((id:string,force=false,priority:"near"|"tail"="near")=>{
    const row=assetPager.getState().items.find(a=>a.assetId===id);
    if (!row || row.kind!=="image") return;
    const revision=materialImageVersion(row);
    if (!force && localThumbsRef.current[id] && localThumbVersions.current[id]===revision) return;
    void thumbnailScheduler.enqueue(localThumbKey(id,revision),()=>api.localAssetThumbnail(id,false,force),priority).then(t=>{
      const current=assetPager.getState().items.find(a=>a.assetId===id);
      if (!t?.uri || !current || materialImageVersion(current)!==revision) return;
      localThumbVersions.current[id]=revision;
      localThumbsRef.current={...localThumbsRef.current,[id]:convertFileSrc(t.uri)};
      setThumbMap(prev=>({...prev,[id]:convertFileSrc(t.uri)}));
    }).catch(()=>{});
  },[assetPager]);
  useEffect(()=>{
    const valid=new Map(localPage.items.map(a=>[a.assetId,materialImageVersion(a)]));
    const allowed=new Set(localPage.items.map(a=>localThumbKey(a.assetId,materialImageVersion(a))));
    setThumbMap(prev=>{
      const next=Object.fromEntries(Object.entries(prev).filter(([id])=>valid.has(id)&&localThumbVersions.current[id]===valid.get(id)));
      return Object.keys(next).length===Object.keys(prev).length ? prev : next;
    });
    localThumbVersions.current=Object.fromEntries(Object.entries(localThumbVersions.current).filter(([id])=>valid.has(id)));
    thumbnailScheduler.cancelPending(key=>key.startsWith("local:")&&!key.endsWith(":screen")&&!allowed.has(key));
    if (domain!=="local" || !active) return;
    for (const [index,row] of localPage.items.slice(0,LIST_THUMB_WINDOW).entries()) requestLocalThumb(row.assetId,false,index<LIST_NEAR_COUNT ? "near" : "tail");
  },[domain,active,localPage.items,requestLocalThumb]);

  // A2: NO client-side re-sort — the authority already returned these pages
  // in the selected order (applied before LIMIT/OFFSET), so re-sorting here
  // would only reshuffle the loaded subset and misrepresent the library.
  const orderedLocal = localPage.items;
  const assets: AssetItem[] =
    domain === "local"
      ? orderedLocal.map((a: any) => ({
          id: `local:${a.assetId}`,
          title: a.name,
          src: localThumbVersions.current[a.assetId]===materialImageVersion(a) ? thumbMap[a.assetId] || "" : "",
          kind: a.kind === "video" ? "video" : a.kind === "document" ? "document" : "image",
          source: "local" as const,
          meta: `${kindLabel(a.kind)} · 本机`,
        }))
      : desktopItems.map((a: any) => ({
          id: a.desktopAssetId,
          title: a.name,
          src: desktopThumbVersions.current[a.desktopAssetId]===materialImageVersion(a) ? desktopThumbs[a.desktopAssetId] || "" : "",
          kind: a.kind === "video" ? "video" : a.kind === "document" ? "document" : "image",
          source: "desktop" as const,
          meta: `${kindLabel(a.kind)} · 电脑缓存`,
        }));

  // R7c: RANGE drag-select (mainstream album semantics). A long press fixes
  // the ANCHOR; every drag move — and every auto-scroll tick while the finger
  // is parked in an edge zone — moves the ENDPOINT; the selection is always
  // baseline ∪ orderedIds[anchor..endpoint], so the range grows dragging away
  // and SHRINKS dragging back, untouched grid columns join, and manual picks
  // made before the drag survive. Whitespace keeps the last valid endpoint.
  // Finger-up freezes the range (plain taps toggle individually again).
  // ONE selection path: `applyDragPoint` serves the live moves and the
  // auto-scroll loop alike.
  const dragAutoScrollRef = useRef<DragAutoScroll | null>(null);
  if (!dragAutoScrollRef.current) dragAutoScrollRef.current = createDragAutoScroll();
  const rangeDragRef = useRef<RangeDrag | null>(null);
  const endpointRef = useRef<number | null>(null);
  /** The rendered Desktop order the anchor/endpoint indices address. */
  const orderedDesktopIds = useMemo(
    () => (domain === "desktop" ? assets.map((a) => a.id) : []),
    [domain, assets],
  );
  const applyDragPoint = useCallback((x: number, y: number) => {
    if (!selecting) return;
    const drag = rangeDragRef.current;
    if (!drag) return; // the range is frozen (between drags)
    const hit = document.elementFromPoint(x, y);
    const host = hit && hit.closest ? hit.closest("[data-asset-id]") : null;
    const id = host?.getAttribute("data-asset-id") || "";
    const idx = id ? indexOfId(orderedDesktopIds, id) : null;
    if (idx == null) return; // whitespace: the last valid endpoint stands
    endpointRef.current = idx;
    const next = selectionWithRange(drag, idx, orderedDesktopIds);
    setSelectedIds((prev) => {
      // R7 (B2): the FIRST time a drag actually grows past the anchor, one
      // quiet hint — never again this session.
      if (!dragSelectHintShown && next.length > drag.baseline.length + 1) {
        dragSelectHintShown = true;
        toast.info("继续滑动可多选");
      }
      return next.length === prev.length && next.every((v, i) => v === prev[i]) ? prev : next;
    });
  }, [selecting, orderedDesktopIds]);
  useEffect(() => {
    if (!selecting) {
      dragAutoScrollRef.current?.stop();
      rangeDragRef.current = null;
      endpointRef.current = null;
    }
  }, [selecting]);
  useEffect(() => () => dragAutoScrollRef.current?.stop(), []);

  // MATERIAL-LIBRARY-INSTANT-R1 REPAIR-R1 (C): the page's truthful source state
  // comes from the retained-snapshot authority for each source, so the UI can
  // distinguish initial loading / retained+refreshing / settled empty /
  // stale-offline. Local reads the session; Desktop reads the Desktop
  // authority, which is the SAME object that requested and committed the rows —
  // so the reported state can never drift from the pipeline's real state.
  const localView = session.view<any>("local");
  // Scroll offsets are per-SOURCE presentation state and always come from the
  // session, whatever authority owns the row truth.
  const scrollView = domain === "local" ? localView : session.view<any>("desktop");
  const activeView = domain === "local" ? localView : desktopSnapshot;
  const showAssets = domain === "local" ? localPage.items.length > 0 : desktopItems.length > 0;
  const retainedTruth = domain === "local"
    ? localView.retained
    : desktopItems.length > 0;
  const refreshingTruth = activeView.refreshing;
  const desktopError=desktopAuthority.isCurrent(currentDesktopIdentity) ? desktopSnapshot.error : "";
  const staleTruth = domain === "local" ? localView.stale : desktopAuthority.isCurrent(currentDesktopIdentity) && desktopSnapshot.stale;
  // "Settled" is only true once a request for the CURRENT identity returned.
  const settledTruth = domain === "local"
    ? (localPage.items.length > 0 || localView.settled)
    : (desktopSnapshot.identity===currentDesktopIdentity && desktopSnapshot.settled);
  // True cold loading (no retained rows at all) is distinct from a background
  // refresh over retained rows: only the latter may say the old results are
  // still on screen.
  const coldLoading = domain === "local"
    ? (!retainedTruth && !settledTruth)
    : !retainedTruth && !settledTruth && !desktopError;
  // A Desktop identity that has settled WITH zero rows is a genuine empty; one
  // that is still in flight (or failed) never is. This is what stops the page
  // from flashing 没有找到素材 while a request is outstanding.
  const desktopSettledEmpty = domain === "desktop"
    && desktopSnapshot.settled && desktopItems.length === 0
    && !desktopSnapshot.refreshing && !desktopSnapshot.cold;

  const filterLabel = domain !== "local" ? `${desktopKind ? DESKTOP_KINDS.find(k=>k.value===desktopKind)?.label+" · " : ""}${desktopItems.length} 项${desktopSnapshot.hasMore ? " · 可继续加载" : ""}` : (() => {
    const parts = [
      applied.kind !== "全部" ? applied.kind : "",
      applied.favoriteOnly ? "仅收藏" : "",
      applied.archivedOnly ? "已含归档" : "",
      applied.tag ? "#" + applied.tag : "",
      applied.sort !== "recent" ? SORT_LABELS[applied.sort as SortKey] : "",
    ].filter(Boolean);
    return parts.length ? parts.join(" · ") : `${localPage.total} 项`;
  })();

  // 视图切换必须驱动 React 状态：只写 localStorage 不会触发重渲染，
  // 按钮就会"没反应/点很多次才生效"（缩略图异步到达时才碰巧刷新）。
  const [listPref, setListPref] = useState(() => getLibraryView() === "list");

  // D2 (REPAIR-R2 3A): LIST mode runs bounded thumbnail work too, but NOT as a
  // 100-row "near" burst. Only a bounded first screen (plus the next screen as a
  // prefetch window) starts eagerly; the rest keep their stable placeholder until
  // they scroll into view, where the row asks for its own thumbnail through the
  // same source-qualified, bounded authority.
  useEffect(() => {
    if (domain !== "desktop" || !committedDesktopOwner || !active) return;
    const window = desktopItems.slice(0, LIST_THUMB_WINDOW);
    for (const a of window) {
      if (!a.desktopAssetId) continue;
      // The first screen is visible by definition -> near; the prefetch half is
      // queued as tail so it can never outrank genuinely visible work.
      requestDesktopThumb(committedDesktopOwner, a.desktopAssetId, false,
        window.indexOf(a) < LIST_NEAR_COUNT ? "near" : "tail");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain, active, committedDesktopOwner, desktopItems, listPref]);
  const toggleListView = () => {
    const next = !listPref;
    setLibraryView(next ? "list" : "grid");
    setListPref(next);
  };

  // Wave A batch handlers: every one revalidates authoritative state on success
  // and reports a partial result as partial.
  const [batchTagRemove, setBatchTagRemove] = useState(false);

  async function runBatch(input: {
    favorited?: boolean;
    add?: string[];
    remove?: string[];
    /** Explicit presence signal: only a folder action may carry a folderId, so
     *  an unrelated batch never accidentally clears the folder. */
    folderChange?: boolean;
    folderId?: string | null;
  }) {
    const { folderChange, ...rest } = input;
    const result = await org.batch(
      {
        assetIds: selectedIds,
        ...rest,
        folderChange: Boolean(folderChange),
        ...(folderChange ? { folderId: rest.folderId ?? null } : {}),
      },
      async () => {
        setReloadKey((k) => k + 1);
      }
    );
    if (result) {
      setBatchSheet("");
      // Partial success still revalidated the authority; keeping the selection
      // and the warning is what makes the partial outcome visible.
      if ((result.failed || []).length === 0) {
        setSelecting(false);
        setSelectedIds([]);
      }
    }
  }

  async function openBatchTags(mode: "add" | "remove" = "add") {
    setBatchTagRemove(mode === "remove");
    try {
      const nav: any = await api.contentNavigation(committedDesktopOwner);
      setBatchTags((nav?.tags || []).map((t: any) => ({ id: t.id, name: t.name })));
    } catch { setBatchTags([]); }
    setBatchSheet("tags");
  }

  async function openBatchFolders() {
    try {
      const nav: any = await api.contentNavigation(committedDesktopOwner);
      const flat: { id: string; label: string }[] = [];
      const walk = (rows: any[], prefix: string) => {
        for (const row of rows || []) {
          flat.push({ id: row.id, label: prefix + (row.name ?? "") });
          walk(row.children || [], prefix + (row.name ?? "") + " / ");
        }
      };
      walk(nav?.folders || [], "");
      setBatchFolders(flat);
    } catch { setBatchFolders([]); }
    setBatchSheet("folder");
  }

  return (
    <>
      <CollectionView
        domain="library"
        source={domain}
        onSource={(s) => setDomain(s === "desktop" ? "desktop" : "local")}
        query={query}
        onQuery={setQuery}
        onFilter={() => { draft.current.begin();setDesktopKindDraft(desktopKind); setFiltersOpen(true); }}
        onNew={() => setImportOpen(true)}
        onBrowse={() => setBrowseOpen(true)}
        onRefresh={() => { setReloadKey((k) => k + 1); }}
        notes={[]}
        assets={assets}
        open={(_page, id) => {
          // In selection mode a tap TOGGLES the asset instead of opening it.
          // A Desktop row opens against the Desktop that PRODUCED it, carried
          // in the route — never against whatever is connected at tap time.
          if (selecting && domain === "desktop" && id) {
            setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
            return;
          }
          if (domain === "desktop") {
            if (!committedDesktopOwner) return;
            const card = assets.find(a => a.id === id);
            open("asset", desktopAssetRoute(committedDesktopOwner, id || ""), { assetPreview: card ? { title: card.title, thumbnail: card.src, kind: card.kind, version:materialImageVersion(desktopItems.find(a=>a.desktopAssetId===id)) } : undefined });
            return;
          }
          const card = assets.find(a => a.id === id);
          open("asset", id || "", { assetPreview: card ? { title: card.title, thumbnail: card.src, kind: card.kind } : undefined });
        }}
        // REPAIR-R5: a long press enters selection mode and selects the held
        // asset, WITHOUT also opening it (the gesture authority swallows the
        // trailing click). Desktop-only: the local source keeps its existing
        // single-tap behaviour and no batch semantics.
        // R7 (B1): while a long press is HELD, every move reports the finger's
        // position; the tile under the finger joins the selection, the way
        // photo albums continue a drag-select. Append-only by design — no
        // de-select on drag-back in this round.
        // R7b: the SAME hit-test also feeds the edge auto-scroll, so tiles
        // below the fold join as the scroller follows the parked finger —
        // one selection path for live moves and scrolled content alike.
        onDragSelect={domain === "desktop" ? (x, y) => {
          applyDragPoint(x, y);
          // The auto-scroll loop re-invokes the SAME range point as the
          // scroller follows a finger parked in an edge zone.
          const scroller = document.elementFromPoint(x, y)?.closest?.(".st-scroll") as HTMLElement | null;
          if (scroller) dragAutoScrollRef.current!.update(scroller, y, applyDragPoint, x);
        } : undefined}
        // R7c: finger-up freezes the range (the ref drops; plain taps toggle
        // individually again) and stops the follow-scroll.
        onDragEnd={domain === "desktop" ? () => {
          dragAutoScrollRef.current!.stop();
          rangeDragRef.current = null;
          endpointRef.current = null;
        } : undefined}
        onLongPress={domain === "desktop" ? (id) => {
          if (!id || !committedDesktopOwner) return;
          // R7c: the long press is the range ANCHOR. Baseline = whatever was
          // picked before (manual picks survive the drag); the range itself
          // starts as just the anchor and recomputes from the endpoint.
          const idx = indexOfId(orderedDesktopIds, id);
          if (idx == null) return;
          setSelecting(true);
          setSelectedIds((prev) => selectionWithRange({ anchorIndex: idx, baseline: prev }, idx, orderedDesktopIds));
          rangeDragRef.current = { anchorIndex: idx, baseline: selectedIds };
          endpointRef.current = idx;
        } : undefined}
        selecting={domain === "desktop" && selecting}
        selectedIds={domain === "desktop" ? selectedIds : undefined}
        // REPAIR-R6 (1): the selection action bar lives INSIDE the view, fixed
        // between the search field and the scroll region. The old floating
        // notice was rendered after the full-height CollectionView and was
        // therefore off-screen on the device — the checks were visible but the
        // actions were unreachable.
        selectionBar={domain === "desktop" && selecting ? {
          count: selectedIds.length,
          busy: orgSnapshot.busy,
          onCancel: () => { setSelecting(false); setSelectedIds([]); },
          onOrganize: () => setBatchSheet("actions"),
        } : undefined}
        // REPAIR-R3 (2): list rows request their thumbnail only when they
        // actually approach the viewport, so row 21+ is no longer stranded on
        // its placeholder. Same bounded, source/owner-qualified authority.
        listVisible={(id) => {
          const aid = id.startsWith("local:") ? id.slice(6) : id;
          if (domain === "desktop") {
            requestDesktopThumb(committedDesktopOwner, aid, false, "near");
            return;
          }
          requestLocalThumb(aid);
        }}
        tileVisible={(id) => {
          if (domain !== "desktop") {requestLocalThumb(id.startsWith("local:") ? id.slice(6) : id); return;}
          // Viewport-first: a tile asks for its thumbnail when it comes near.
          const aid = id.startsWith("local:") ? id.slice(6) : id;
          requestDesktopThumb(committedDesktopOwner, aid);
        }}
        // D3: ONE bounded forced re-query of the existing thumbnail authority.
        // `force` bypasses the retained-URL check, which is exactly what used
        // to swallow the retry.
        tileRetry={(id) => {
          const aid = id.startsWith("local:") ? id.slice(6) : id;
          if (domain === "desktop") {
            if (!committedDesktopOwner) return;
            // Drop this owner+asset entry first: the refetch may return the
            // same URI, and MediaTile's attempt key then remounts the image so
            // the retry is a real new attempt. Scoped to the exact owner, so
            // Desktop A's retry can never disturb B.
            setDesktopThumbs((prev) => {
              if (!(aid in prev)) return prev;
              const next = { ...prev };
              delete next[aid];
              return next;
            });
            requestDesktopThumb(committedDesktopOwner, aid, true);
            return;
          }
          // Local: the same bounded path, source-qualified.
          requestLocalThumb(aid,true);
        }}
        paired={Boolean(conn?.paired)}
        connected={Boolean(conn?.paired && conn?.ws?.state === "connected")}
        list={listPref}
        onList={toggleListView}
        filterLabel={filterLabel}
        statusSlot={!showAssets && (domain==="desktop" ? Boolean(desktopError) : assetPager.lastOutcome()==="error")
          ? <Empty title="暂时读不到素材" body={domain==="desktop" ? "请检查电脑与连接后重试。本机内容不受影响。" : "本机文件暂时不可用，请重试。"}>
            <Button kind="quiet" onClick={()=>domain==="desktop" ? desktopAuthority.revalidate(DESKTOP_SOURCE(),true) : setReloadKey(k=>k+1)}>重试读取素材</Button>
          </Empty> : undefined}
        retained={retainedTruth}
        coldLoading={coldLoading}
        refreshing={refreshingTruth}
        stale={staleTruth}
        settled={settledTruth}
        scrollTop={scrollView.scrollTop}
        onScroll={(top) => { session.setScroll(domain === "local" ? "local" : "desktop", top); }}
        footerSlot={((domain === "local" ? localPage.hasMore : desktopSnapshot.hasMore) ? <div className="st-material-page-footer">
          <Button kind="quiet" disabled={domain === "local" ? localPage.loading : desktopSnapshot.refreshing} onClick={loadMore}>
            {(domain === "local" ? localPage.loading : desktopSnapshot.refreshing) ? "加载中…" : "加载更多"}
          </Button>
          <small>{domain === "local" ? assetsLoadedText(localPage.items.length, localPage.total) : `已显示 ${desktopItems.length} 项`}</small>
        </div> : undefined)}
      />

      {filtersOpen && domain==="desktop" ? <Sheet title="筛选素材" registerDismiss={registerOverlay} onClose={()=>setFiltersOpen(false)}
        footer={<><Button kind="quiet" onClick={()=>setDesktopKindDraft("")}>恢复默认</Button><Button onClick={()=>{setDesktopKind(desktopKindDraft);setFiltersOpen(false);}}>显示结果</Button></>}>
        <p className="st-sheet-caption">类型</p>
        {DESKTOP_KINDS.map(k=><Option key={k.value} label={k.label} selected={desktopKindDraft===k.value} onClick={()=>setDesktopKindDraft(k.value)} />)}
      </Sheet> : null}
      {filtersOpen && domain==="local" ? (
        <FilterSheet
          draft={draft.current.getDraft()}
          availableTags={filterTags}
          onEdit={(patch: Partial<Applied>) => { draft.current.edit(patch); bump((n) => n + 1); }}
          onReset={() => { draft.current.reset(); bump((n) => n + 1); }}
          onApply={() => {
            const v = draft.current.commit() as Applied;
            setApplied(v);
            if (v.sort === "recent" || v.sort === "name" || v.sort === "size") setLibrarySort(v.sort);
            // View preference stays owned by the toolbar alone. The sheet
            // neither offers nor resets it — a stale draft view (the pre-R1
            // behaviour) could silently flip a toolbar-chosen list back to
            // grid on every apply.
            setFiltersOpen(false);
          }}
          onClose={() => { draft.current.cancel(); setFiltersOpen(false); }}
          registerOverlay={registerOverlay}
        />
      ) : null}

      {importOpen ? (
        <Sheet title="导入到本机" registerDismiss={registerOverlay} onClose={() => setImportOpen(false)}>
          <button type="button" className="st-option" disabled={busy} onClick={() => void importMedia("image")}><span>图片<small>从相册选择</small></span></button>
          <button type="button" className="st-option" disabled={busy} onClick={() => void importMedia("video")}><span>视频<small>从相册选择</small></span></button>
          <button type="button" className="st-option" disabled={busy} onClick={() => void importMedia("file")}><span>文件<small>任意文档或压缩包</small></span></button>
        </Sheet>
      ) : null}

      {orgSnapshot.partial ? (
        <div className="st-notice danger" role="status">
          部分完成：成功 {orgSnapshot.partial.succeeded} 项，失败 {orgSnapshot.partial.failed} 项
        </div>
      ) : null}
      {orgSnapshot.error ? <div className="st-notice danger" role="status">{orgSnapshot.error}</div> : null}
      {batchSheet === "actions" ? (
        <Sheet title="整理所选素材" registerDismiss={registerOverlay} onClose={() => setBatchSheet("")}
          busy={orgSnapshot.busy}>
          <p className="st-sheet-caption">已选择 {selectedIds.length} 项</p>
          <Option label="收藏所选" icon="pin" onClick={() => { void runBatch({ favorited: true }); }} />
          <Option label="取消收藏所选" icon="pin" onClick={() => { void runBatch({ favorited: false }); }} />
          <Option label="添加标签" icon="list" onClick={() => { void openBatchTags(); }} />
          <Option label="移除标签" icon="list" onClick={() => { void openBatchTags("remove"); }} />
          <Option label="移动到文件夹" icon="folder" onClick={() => { void openBatchFolders(); }} />
        </Sheet>
      ) : null}
      {batchSheet === "tags" ? (
        <Sheet title={batchTagRemove ? "移除标签" : "添加标签"} registerDismiss={registerOverlay}
          onClose={() => setBatchSheet("")} busy={orgSnapshot.busy}>
          {batchTags.length === 0 ? <p className="st-sheet-copy">电脑上还没有标签，可以先在素材详情里新建。</p> : null}
          {batchTags.map((tag) => (
            <Option key={tag.id} label={tag.name} icon="list"
              onClick={() => { void runBatch(batchTagRemove ? { remove: [tag.id] } : { add: [tag.id] }); }} />
          ))}
        </Sheet>
      ) : null}
      {batchSheet === "folder" ? (
        <Sheet title="移动到文件夹" registerDismiss={registerOverlay} onClose={() => setBatchSheet("")}
          busy={orgSnapshot.busy}>
          <Option label="根目录" icon="library" onClick={() => { void runBatch({ folderChange: true, folderId: null }); }} />
          {batchFolders.map((folder) => (
            <Option key={folder.id} label={folder.label} icon="folder"
              onClick={() => { void runBatch({ folderChange: true, folderId: folder.id }); }} />
          ))}
        </Sheet>
      ) : null}
      {browseOpen ? (
        domain === "local" ? (
          <Sheet title="浏览本机素材" registerDismiss={registerOverlay} onClose={() => setBrowseOpen(false)}>
            <Option label="全部素材" icon="library" selected={!applied.favoriteOnly && !applied.archivedOnly}
              onClick={() => { setApplied({ ...applied, favoriteOnly: false, archivedOnly: false, kind: "全部" }); setBrowseOpen(false); }} />
            <Option label="收藏" icon="pin" selected={applied.favoriteOnly}
              onClick={() => { setApplied({ ...applied, favoriteOnly: true, archivedOnly: false }); setBrowseOpen(false); }} />
            <Option label="归档" icon="archive" selected={applied.archivedOnly}
              onClick={() => { setApplied({ ...applied, favoriteOnly: false, archivedOnly: true }); setBrowseOpen(false); }} />
          </Sheet>
        ) : (
          <DesktopBrowseSheet owner={committedDesktopOwner} folder={desktopFolder} tag={desktopTag}
            onFolder={(f) => { setDesktopFolder(f); setBrowseOpen(false); }}
            onTag={(t) => { setDesktopTag(t); setBrowseOpen(false); }}
            onClose={() => setBrowseOpen(false)}
            registerOverlay={registerOverlay} />
        )
      ) : null}
    </>
  );
}

/** 电脑素材 目录与标签: REAL Desktop folders/tags via the content navigation
 *  authority (folders arrive as a tree, flattened with path labels like the
 *  legacy Desktop library); selection stores IDs that drive the real
 *  contentAssets request axes. */
function DesktopBrowseSheet({ owner, folder, tag, onFolder, onTag, onClose, registerOverlay }: {
  owner: string; folder: string; tag: string;
  onFolder: (id: string) => void; onTag: (id: string) => void;
  onClose: () => void; registerOverlay: (d: () => void) => () => void;
}) {
  const [nav, setNav] = useState<{ folders: { id: string; label: string }[]; tags: { id: string; name: string }[] } | null>(null);
  useEffect(() => {
    let alive = true;
    api.contentNavigation(owner).then((value) => {
      if (!alive) return;
      const folders: { id: string; label: string }[] = [];
      const flatten = (rows: any[], prefix: string) => {
        for (const row of rows || []) {
          folders.push({ id: row.id, label: prefix + row.name });
          flatten(row.children || [], prefix + row.name + " / ");
        }
      };
      flatten(value?.folders || [], "");
      setNav({ folders, tags: (value?.tags || []).map((t: any) => ({ id: t.id, name: t.name })) });
    }).catch(() => { if (alive) setNav({ folders: [], tags: [] }); });
    return () => { alive = false; };
  }, []);
  return (
    <Sheet title="目录与标签" registerDismiss={registerOverlay} onClose={onClose}>
      <p className="st-sheet-caption">目录</p>
      <Option label="全部目录" icon="folder" selected={!folder} onClick={() => onFolder("")} />
      {(nav?.folders || []).map((f) => (
        <Option key={f.id} label={f.label} icon="folder" selected={folder === f.id} onClick={() => onFolder(f.id)} />
      ))}
      <p className="st-sheet-caption">标签</p>
      <Option label="全部标签" icon="list" selected={!tag} onClick={() => onTag("")} />
      {(nav?.tags || []).map((t) => (
        <Option key={t.id} label={t.name} icon="list" selected={tag === t.id} onClick={() => onTag(t.id)} />
      ))}
      {nav && !(nav.folders || []).length && !(nav.tags || []).length ? (
        <p className="st-sheet-copy">电脑还没有可用的目录或标签。</p>
      ) : null}
    </Sheet>
  );
}

/** REAL Still Filter Sheet: draft edits / Apply commits / backdrop+Back discard. */
function FilterSheet({ draft, availableTags = [], onEdit, onReset, onApply, onClose, registerOverlay }: {
  draft: Applied;
  availableTags?: string[];
  onEdit: (patch: Partial<Applied>) => void;
  onReset: () => void;
  onApply: () => void;
  onClose: () => void;
  registerOverlay: (d: () => void) => () => void;
}) {
  const options: FilterOptions = {
    kinds: KINDS, flags: [], sorts: SORTS,
  };
  const value: FilterValue = {
    kind: draft.kind,
    flags: [
      ...(draft.favoriteOnly ? ["favorite"] : []),
      ...(draft.archivedOnly ? ["archived"] : []),
    ],
    sort: draft.sort,
    view: draft.view,
    tag: draft.tag, folder: "",
  };
  void value.view; // the toolbar is the ONLY view owner; the sheet no longer offers it
  return (
    <FilterSheetInner
      value={value}
      options={options}
      sorts={SORTS}
      availableTags={availableTags}
      onTag={(t) => onEdit({ tag: t })}
      onKind={(k) => onEdit({ kind: k })}
      onFlag={(f) => {
        if (f === "favorite") onEdit({ favoriteOnly: !draft.favoriteOnly });
        if (f === "archived") onEdit({ archivedOnly: !draft.archivedOnly });
      }}
      onSort={(s) => onEdit({ sort: s })}
      onReset={onReset}
      onApply={onApply}
      onClose={onClose}
      registerOverlay={registerOverlay}
    />
  );
}

function FilterSheetInner(props: {
  value: FilterValue; options: FilterOptions; sorts: { value: string; label: string }[];
  availableTags?: string[]; onTag: (t: string) => void;
  onKind: (k: string) => void; onFlag: (f: string) => void; onSort: (s: string) => void;
  onReset: () => void; onApply: () => void; onClose: () => void;
  registerOverlay: (d: () => void) => () => void;
}) {
  return (
    <Sheet
      title="筛选与排序"
      registerDismiss={props.registerOverlay}
      onClose={props.onClose}
      footer={<>
        <Button kind="quiet" onClick={props.onReset}>恢复默认</Button>
        <Button onClick={props.onApply}>显示结果</Button>
      </>}
    >
      <p className="st-sheet-caption">类型</p>
      {props.options.kinds.map((k) => (
        <Option key={k.value} label={k.label} selected={props.value.kind === k.value} onClick={() => props.onKind(k.value)} />
      ))}
      <Option label="仅收藏" selected={props.value.flags.includes("favorite")} onClick={() => props.onFlag("favorite")} />
      <Option label="显示归档" selected={props.value.flags.includes("archived")} onClick={() => props.onFlag("archived")} />
      <p className="st-sheet-caption">标签</p>
      <Option label="全部标签" selected={!props.value.tag} onClick={() => props.onTag("")} />
      {(props.availableTags ?? []).map((t) => (
        <Option key={t} label={"#" + t} selected={props.value.tag === t} onClick={() => props.onTag(t)} />
      ))}
      {props.sorts.map((s) => (
        <Option key={s.value} label={s.label} selected={props.value.sort === s.value} onClick={() => props.onSort(s.value)} />
      ))}
    </Sheet>
  );
}

/** Bounded tag picker list: the authority vocabulary plus the draft tag. */
function collectAssetTags(notes: { tags?: string[] }[], extra: string): string[] {
  const set = new Set<string>();
  for (const n of notes) for (const t of n.tags || []) set.add(t);
  if (extra) set.add(extra);
  return [...set].slice(0, 24);
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "image": return "图片";
    case "video": return "视频";
    case "document": return "文档";
    default: return "文件";
  }
}

