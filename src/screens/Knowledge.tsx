// Knowledge.tsx (STITCH-R6) — 知识库.
//
// Visual source: R6 `function knowledge()` — source axis (本机 / 电脑) +
// new-note action → tool row (search + filter) → section title → note rows
// with title / excerpt / foot (time + tags).
//
// Behaviour source: production, unchanged. 本机 notes are phone-owned; 电脑
// notes are the synced Desktop vault. Pagination still runs through the
// generation-safe LocalNotesPager and the shared unified-search session.
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type ConnState } from "../services/client";
import { IconFilter, IconNotes, IconPlus } from "../components/icons";
import type { Tab } from "../App";
import { filterKnowledgeNotes, type FilterMode } from "../services/knowledgeFilter";
import { localDataStore } from "../services/localDataStore";
import { initialPaged, type PagedState } from "../services/generationPagination";
import { LocalNotesPager, notesLoadedText, type NoteFilters } from "../services/knowledgeNotesPager";
import { useUnifiedSearch } from "../services/unifiedSearch";
import { searchResultKey } from "../services/searchContract";
import DesktopNotes, { desktopNoteRoute } from "../components/DesktopNotes";
import { EmptyState, OptionRow, Row, RowArt, SearchField, SectionTitle, Sheet, SourceTabs } from "../components/ui";
import { failureCopy } from "../services/feedback";
import { toast } from "../services/toast";
import { getNotesSort, setNotesSort, sortRows, SORT_LABELS, type SortKey } from "../services/viewPreferences";
import { FilterDraft, defaultKnowledgeFilter } from "../services/filterDraft";
import { noteStatus } from "../services/noteProvenance";

type Props = { conn: ConnState | null; go: (tab: Tab, detail?: string) => void };
let rememberedFilter: FilterMode = "local";

export default function Knowledge({ conn, go }: Props) {
  const [filterMode, setFilterMode] = useState<FilterMode>(rememberedFilter);
  useEffect(() => { rememberedFilter = filterMode; }, [filterMode]);
  const [tagFilter, setTagFilter] = useState<string>("");
  const [desktopNotes, setDesktopNotes] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(false);
  // INTERACTION-CLOSURE-R1: real draft/apply/cancel. Options edit the DRAFT;
  // Apply commits (which drives the real pager reload); Cancel/backdrop/Back
  // discard. This replaces the old instant-apply rows the user read as dead.
  const filterDraftRef = useRef(new FilterDraft(defaultKnowledgeFilter));
  const [, bumpDraft] = useState(0);
  const [sort, setSort] = useState<SortKey>(getNotesSort);
  const [notePage, setNotePage] = useState<PagedState<any>>(initialPaged);
  const pagerRef = useRef<LocalNotesPager | null>(null);
  if (!pagerRef.current) {
    pagerRef.current = new LocalNotesPager(
      (f) => api.localNoteList(f),
      (e) => toast.error(failureCopy(e, "读取本地笔记失败。"))
    );
  }
  const pager = pagerRef.current;
  useEffect(() => pager.subscribe((s) => setNotePage(s)), [pager]);
  const { state: search, setQuery: setSearch, loadMore: searchLoadMore } = useUnifiedSearch();

  const reload = () => setReloadKey((k) => k + 1);
  const desktopMode = filterMode === "desktop";

  const noteFilters = (): NoteFilters => ({
    tag: tagFilter || undefined,
    pinned: filterMode === "pinned" ? true : undefined,
    favorite: filterMode === "favorite" ? true : undefined,
    archived: filterMode === "archived" ? true : false,
  });

  const localVersion = useLocalDataVersion();

  useEffect(() => {
    if (desktopMode) {
      pager.enterDesktop();
      return;
    }
    pager.reload(noteFilters());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterMode, tagFilter, reloadKey, localVersion, pager]);

  function loadMoreNotes() {
    void pager.loadMore(noteFilters());
  }

  useEffect(() => {
    let alive = true;
    if (conn?.paired) {
      api
        .notesList()
        .then((res) => {
          if (alive) setDesktopNotes(res || []);
        })
        .catch(() => {});
    } else {
      setDesktopNotes([]);
    }
    return () => {
      alive = false;
    };
  }, [conn?.paired, reloadKey]);

  async function createNote() {
    setBusy(true);
    try {
      const note = await api.localNoteAdd("新笔记", "", []);
      localDataStore.publish("note");
      reload();
      go("knowledge", note.noteId);
    } catch (e: any) {
      toast.error(failureCopy(e, "新建笔记失败。"));
    } finally {
      setBusy(false);
    }
  }

  async function toggleFlag(note: any, flag: "pinned" | "favorite" | "archived", e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await api.localNoteSetFlags(note.noteId, { [flag]: !note[flag] });
      localDataStore.publish("note");
      reload();
    } catch (err: any) {
      toast.error(failureCopy(err, "操作失败，请重试。"));
    }
  }

  async function deleteNote(note: any, e: React.MouseEvent) {
    e.stopPropagation();
    if (!window.confirm(`确定删除本地笔记「${note.title || "未命名笔记"}」？`)) return;
    try {
      await api.localNoteDelete(note.noteId);
      localDataStore.publish("note");
      reload();
      toast.success("已删除");
    } catch (err: any) {
      toast.error(failureCopy(err, "删除失败。"));
    }
  }

  const { displayLocalNotes, displayDesktopNotes } = filterKnowledgeNotes({
    localNotes: desktopMode ? [] : notePage.items,
    desktopNotes,
    filterMode,
    isPaired: Boolean(conn?.paired),
  });

  const searching = !desktopMode && search.query.trim().length > 0;
  const orderedLocal = useMemo(() => sortRows(displayLocalNotes, sort), [displayLocalNotes, sort]);
  const totalCount = displayLocalNotes.length + displayDesktopNotes.length;
  const activeFilterCount =
    (filterMode === "pinned" || filterMode === "favorite" || filterMode === "archived" ? 1 : 0) +
    (tagFilter ? 1 : 0);
  const allTags = useMemo(() => collectTags(notePage.items), [notePage.items]);

  return (
    <>
      <div className="root-source-row">
        <SourceTabs
          items={[
            { key: "local", label: "本机" },
            { key: "desktop", label: "电脑" },
          ]}
          value={desktopMode ? "desktop" : "local"}
          onChange={(v) => setFilterMode(v === "desktop" ? "desktop" : "local")}
          ariaLabel="笔记来源"
        />
        <button className="nav-action" aria-label="新建笔记" disabled={busy || desktopMode} onClick={createNote}>
          <IconPlus size={18} />
        </button>
      </div>

      {!desktopMode ? (
        <>
          <div className="tool-row">
            <SearchField value={search.query} onChange={setSearch} placeholder="搜索标题与正文" />
            <button
              className={"filter-btn" + (activeFilterCount ? " accent" : "")}
              aria-label="筛选与排序"
              onClick={() => {
                filterDraftRef.current.begin();
                setFiltersOpen(true);
              }}
            >
              <IconFilter size={18} />
            </button>
          </div>

          {tagFilter ? (
            <div className="chip-scroll">
              <button className="chip active" onClick={() => setTagFilter("")}>
                #{tagFilter} ✕
              </button>
            </div>
          ) : null}
        </>
      ) : null}

      {desktopMode ? (
        <DesktopNotes conn={conn} open={(route) => go("knowledge", route)} />
      ) : searching ? (
        <>
          <SectionTitle
            title="搜索结果"
            meta={`${search.total}${search.items.length < search.total ? ` · 已加载 ${search.items.length}` : ""}`}
          />
          {search.error ? (
            <EmptyState title="搜索暂时不可用" body={failureCopy(search.error)} />
          ) : search.items.length === 0 ? (
            <EmptyState
              title={search.loading ? "搜索中…" : "没有匹配的内容"}
              body={search.loading ? undefined : `没有找到包含“${search.query.trim()}”的本地内容。`}
            />
          ) : (
            <>
              <div className="list">
                {search.items.map((res) => (
                  <Row
                    key={searchResultKey(res)}
                    onClick={() => {
                      if (res.resultType === "note") go("knowledge", res.id);
                      else if (res.resultType === "asset") go("library", `local:${res.id}`);
                      else go("capture", res.id);
                    }}
                    leading={<RowArt><IconNotes size={18} /></RowArt>}
                    title={res.title || "未命名"}
                    meta={
                      (res.resultType === "note"
                        ? "笔记"
                        : res.resultType === "asset"
                          ? `素材 · ${res.kind}`
                          : `收集箱 · ${res.kind}`) + (res.snippet ? ` — ${res.snippet}` : "")
                    }
                  />
                ))}
              </div>
              {search.hasMore ? (
                <button className="quiet btn-block load-more" disabled={search.loading} onClick={searchLoadMore}>
                  {search.loading ? "加载中…" : "加载更多"}
                </button>
              ) : null}
            </>
          )}
        </>
      ) : (
        <>
          <SectionTitle
            title={headingFor(filterMode)}
            meta={notesLoadedText(notePage.items.length, notePage.total) ?? undefined}
          />
          {totalCount === 0 && !notePage.loading ? (
            <EmptyState
              icon={<IconNotes size={20} />}
              title={emptyTitleFor(filterMode)}
              body={filterMode === "local" ? "记下想法、会议要点或阅读摘录，全部离线可用。" : undefined}
              action={
                filterMode === "local" || filterMode === "pinned" || filterMode === "favorite" ? (
                  <button className="primary" onClick={createNote} disabled={busy}>
                    新建笔记
                  </button>
                ) : undefined
              }
            />
          ) : (
            <>
              <div>
                {orderedLocal.map((n) => (
                  <NoteRow
                    key={n.noteId}
                    note={n}
                    tagFilter={tagFilter}
                    onOpen={() => go("knowledge", n.noteId)}
                    onTag={(t) => setTagFilter(tagFilter === t ? "" : t)}
                    onFlag={toggleFlag}
                    onDelete={deleteNote}
                  />
                ))}
                {displayDesktopNotes.map((n) => (
                  <NoteRow
                    key={n.noteId}
                    note={n}
                    tagFilter={tagFilter}
                    onOpen={() =>
                      go("knowledge", n.vaultId && n.instanceId ? desktopNoteRoute(n.instanceId, n.vaultId, n.noteId) : n.noteId)
                    }
                    onTag={() => {}}
                  />
                ))}
              </div>
              {notePage.hasMore ? (
                <button className="quiet btn-block load-more" disabled={notePage.loading} onClick={loadMoreNotes}>
                  {notePage.loading ? "加载中…" : "加载更多"}
                </button>
              ) : totalCount > 0 ? (
                <p className="list-foot">已显示 {totalCount} 篇</p>
              ) : null}
            </>
          )}
        </>
      )}

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
              setFilterMode(applied.mode);
              setTagFilter(applied.tag);
              if (applied.sort === "recent" || applied.sort === "name") setSort(setNotesSort(applied.sort));
              setFiltersOpen(false);
            }}
          >
            显示结果
          </button>
        }
      >
        <OptionRow label="全部本机笔记" active={filterDraftRef.current.getDraft().mode === "local"} onClick={() => { filterDraftRef.current.edit({ mode: "local" }); bumpDraft((n) => n + 1); }} />
        <OptionRow label="置顶" active={filterDraftRef.current.getDraft().mode === "pinned"} onClick={() => { filterDraftRef.current.edit({ mode: "pinned" }); bumpDraft((n) => n + 1); }} />
        <OptionRow label="收藏" active={filterDraftRef.current.getDraft().mode === "favorite"} onClick={() => { filterDraftRef.current.edit({ mode: "favorite" }); bumpDraft((n) => n + 1); }} />
        <OptionRow label="归档" active={filterDraftRef.current.getDraft().mode === "archived"} onClick={() => { filterDraftRef.current.edit({ mode: "archived" }); bumpDraft((n) => n + 1); }} />
        <OptionRow label={SORT_LABELS.recent} active={filterDraftRef.current.getDraft().sort === "recent"} onClick={() => { filterDraftRef.current.edit({ sort: "recent" }); bumpDraft((n) => n + 1); }} />
        <OptionRow label={SORT_LABELS.name} active={filterDraftRef.current.getDraft().sort === "name"} onClick={() => { filterDraftRef.current.edit({ sort: "name" }); bumpDraft((n) => n + 1); }} />
        {allTags.length ? (
          <>
            <p className="field-label" style={{ marginTop: 14 }}>标签</p>
            <div className="chip-scroll">
              <button
                className={"chip" + (filterDraftRef.current.getDraft().tag === "" ? " active" : "")}
                onClick={() => { filterDraftRef.current.edit({ tag: "" }); bumpDraft((n) => n + 1); }}
              >
                全部
              </button>
              {allTags.map((t) => (
                <button
                  key={t}
                  className={"chip" + (filterDraftRef.current.getDraft().tag === t ? " active" : "")}
                  onClick={() => { filterDraftRef.current.edit({ tag: t }); bumpDraft((n) => n + 1); }}
                >
                  #{t}
                </button>
              ))}
            </div>
          </>
        ) : null}
      </Sheet>
    </>
  );
}

/** `.note-row` — title, 2-line excerpt, foot with time + tags. Status appears
 *  ONLY when it needs explaining (R6: normal/synced rows stay quiet). */
function NoteRow({
  note,
  tagFilter,
  onOpen,
  onTag,
}: {
  note: any;
  tagFilter: string;
  onOpen: () => void;
  onTag: (t: string) => void;
  onFlag?: (n: any, f: "pinned" | "favorite" | "archived", e: React.MouseEvent) => void;
  onDelete?: (n: any, e: React.MouseEvent) => void;
}) {
  const isLocal = !note.vaultId;
  const status = isLocal ? null : noteStatus(note);
  const showStatus = status && status.key !== "synced";
  return (
    <div className="note-row">
      <button className="note-row-body" onClick={onOpen}>
        <b>{note.title || "无标题笔记"}</b>
        <p>{note.content ? note.content.slice(0, 90) : isLocal ? "空白笔记" : note.relativePath || "电脑笔记"}</p>
        <div className="note-foot">
          <span>{note.updatedAt?.replace("T", " ").slice(0, 16) || ""}</span>
          {note.pinned ? <span style={{ color: "var(--pending)" }}>置顶</span> : null}
          {note.favorite ? <span style={{ color: "var(--accent)" }}>★</span> : null}
          {showStatus ? (
            <span style={{ color: status.tone === "danger" ? "var(--danger)" : status.tone === "warn" ? "var(--pending)" : "var(--ink2)" }}>
              {status.label}
            </span>
          ) : null}
          {isLocal && note.tags?.length
            ? note.tags.map((t: string) => (
                <span
                  key={t}
                  className="tag"
                  style={{ color: tagFilter === t ? "var(--accent)" : undefined }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onTag(t);
                  }}
                >
                  #{t}
                </span>
              ))
            : null}
        </div>
      </button>
    </div>
  );
}

function collectTags(notes: any[]): string[] {
  const set = new Set<string>();
  for (const n of notes) for (const t of n.tags || []) set.add(t);
  return [...set].slice(0, 24);
}

function headingFor(mode: FilterMode): string {
  switch (mode) {
    case "pinned":
      return "置顶笔记";
    case "favorite":
      return "收藏笔记";
    case "archived":
      return "归档笔记";
    default:
      return "最近笔记";
  }
}

function emptyTitleFor(mode: FilterMode): string {
  switch (mode) {
    case "archived":
      return "没有归档的笔记";
    case "pinned":
      return "没有置顶的笔记";
    case "favorite":
      return "没有收藏的笔记";
    default:
      return "还没有本地笔记";
  }
}

function useLocalDataVersion(): number {
  const [version, setVersion] = useState(() => localDataStore.getVersion());
  useEffect(() => {
    return localDataStore.subscribe(() => setVersion(localDataStore.getVersion()));
  }, []);
  return version;
}
