import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../../services/client";
import { LocalNotesPager } from "../../services/knowledgeNotesPager";
import { Sheet, SearchField, Button } from "./StillImports";
import { KnowledgeNoteRow } from "./knowledgeNoteRow";
import { literalSegments } from "./searchHit";
import { assertNoteSearchScope, desktopNoteRoute, noteSearchEvidence, readableNoteSearchEvidence, type DesktopNoteScope, type NoteSearchTarget } from "./noteSearch";

export type NoteSwitcherProps = {
  onClose: () => void;
  registerOverlay: (dismiss: () => void) => () => void;
  onPick: (route: string, search: NoteSearchTarget | undefined, isCurrent: () => boolean) => void;
  /** Omitted only by the explicitly local note surface. */
  scope?: DesktopNoteScope;
  enabled?: boolean;
  variant?: "search" | "browse";
  currentRoute?: string;
};

/** The existing generation-safe pager, bound to ONE immutable source scope.
 * S1 supplies full-body filtering BEFORE pagination, both online and offline.
 * No discovery, alternate vault, legacy notesList, or local fallback exists. */
export function ScopedNoteSwitcher({ onClose, registerOverlay, onPick, scope, enabled = true, variant = "search", currentRoute }: NoteSwitcherProps) {
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const scopeKey = JSON.stringify(scope ? ["desktop", scope.instance, scope.vault, scope.directory] : ["local"]);
  const intent = useRef({ scopeKey, generation: 0, active: enabled });
  if (intent.current.scopeKey !== scopeKey || intent.current.active !== enabled) {
    intent.current = { scopeKey, generation: intent.current.generation + 1, active: enabled };
  }
  useEffect(() => () => { intent.current.active = false; intent.current.generation += 1; }, []);
  const cancelPick = () => { intent.current.generation += 1; };
  const dismiss = () => { cancelPick(); onClose(); };
  // Sheet animates before calling onClose. Cancel at the user's dismissal
  // gesture, not 300 ms later when the animation finishes.
  useEffect(() => {
    // Window capture precedes Sheet's document stopImmediatePropagation.
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") cancelPick(); };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, []);
  const pager = useMemo(() => new LocalNotesPager(async filters => {
    const result = scope
      ? await api.contentReplicaNotes(scope.instance, scope.vault, filters.q, filters.page, scope.directory)
      : await api.localNoteList(filters);
    const rows = result.items || [];
    if (scope) assertNoteSearchScope(rows, scope);
    return { ...result, items: rows.map((note: any) => ({
      noteId: note.noteId,
      route: scope ? desktopNoteRoute(scope.instance, scope.vault, note.noteId) : note.noteId,
      title: note.title || "未命名笔记",
      path: scope ? note.relativePath || "" : "本机笔记",
      hit: scope ? readableNoteSearchEvidence(filters.q || "", note) : noteSearchEvidence(filters.q || "", note.content),
    })) };
  }, failure => setError(String(failure))), [scopeKey]);
  const page = useSyncExternalStore(callback => pager.subscribe(callback), () => pager.getState());
  useEffect(() => {
    pager.invalidate();
    setError("");
    if (!enabled) return;
    const timer = setTimeout(() => pager.reload({ q: query.trim() }), query.trim() ? 180 : 0);
    return () => { clearTimeout(timer); pager.suspend(); };
  }, [pager, query, enabled]);
  const matchesRequest = enabled && (pager.currentRequest().q || "") === query.trim();
  const items = matchesRequest ? page.items : [];
  const waiting = enabled && (!matchesRequest || page.loading || (page.page === 0 && !error));
  return <div style={{ display: "contents" }} onPointerDownCapture={event => {
    if ((event.target as Element).closest(".st-scrim, .st-sheet-handle")) cancelPick();
  }} onClickCapture={event => {
    if ((event.target as Element).closest(".st-scrim, .st-sheet-handle")) cancelPick();
  }}><Sheet title={variant === "browse" ? (scope ? "电脑笔记" : "本机笔记") : scope ? scope.directory ? "查找当前目录" : "查找当前知识库" : "查找本机笔记"} registerDismiss={close => registerOverlay(() => { cancelPick(); close(); })} onClose={dismiss}>
    {variant === "search" ? <SearchField value={query} onChange={value => {
      // Fence page-N synchronously, before the debounce and before paint.
      intent.current.generation += 1; pager.invalidate(); setError(""); setQuery(value);
    }} placeholder={scope?.directory ? `查找 ${scope.directory}` : "搜索标题和完整正文"} /> : null}
    {items.map((note: any) => <KnowledgeNoteRow activateOnClick key={note.route} noteId={note.noteId}
      title={note.title} body="" meta={note.route === currentRoute ? "当前笔记" : note.path}
      titleHit={query.trim() ? literalSegments(note.title, query) : undefined}
      bodyHitLine={note.hit?.snippet ? { kind: "hit", segments: literalSegments(note.hit.snippet, query), suffix: note.hit.outdated ? " · 缓存版本" : undefined } : undefined}
      onClick={() => {
        if (!matchesRequest) return;
        const generation = ++intent.current.generation;
        onPick(note.route, note.hit, () => intent.current.active && intent.current.generation === generation);
      }} />)}
    {!enabled ? <p className="st-note-switcher-status">当前电脑或笔记范围已变化，请返回知识页后重试。</p>
      : error ? <p className="st-note-switcher-status" role="status">{error.includes("OFFLINE_NOT_SELECTED")
        ? "这篇笔记所属知识库未保存在手机，请返回知识页确认该库。" : "暂时无法读取当前范围的笔记，请重试。"}</p>
      : waiting ? <p className="st-note-switcher-status" role="status">{variant === "browse" ? "正在加载笔记…" : "正在查找…"}</p>
      : !items.length ? <p className="st-note-switcher-status">{query.trim() ? "没有找到匹配的笔记" : "当前范围还没有笔记"}</p> : null}
    {enabled && error ? <Button kind="quiet" onClick={() => { setError(""); pager.reload({ q: query.trim() }); }}>重试</Button> : null}
    {enabled && page.hasMore && matchesRequest ? <Button kind="quiet" disabled={page.loading} onClick={() => void pager.loadMore({ q: query.trim() })}>
      {page.loading ? "正在加载…" : "加载更多"}
    </Button> : null}
  </Sheet></div>;
}
