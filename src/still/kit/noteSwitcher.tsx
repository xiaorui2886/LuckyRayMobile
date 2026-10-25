import { managedVault, managedNoteRoute } from "../../services/managedVault";
import { noteFolderTree } from "./noteFolderTree";
import { NoteSidePanel } from "./NoteSidePanel";
import { sessionKnowledge } from "./knowledgeSession";
import { folderStatus } from "./knowledgeFolderCatalog";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../../services/client";
import { LocalNotesPager } from "../../services/knowledgeNotesPager";
import { Sheet, SearchField, Button, Icon, IconButton } from "./StillImports";
import { KnowledgeNoteRow } from "./knowledgeNoteRow";
import { literalSegments } from "./searchHit";
import { assertNoteSearchScope, desktopNoteRoute, noteSearchEvidence, readableNoteSearchEvidence, type DesktopNoteScope, type NoteSearchTarget } from "./noteSearch";

export type NoteSwitcherProps = {
  onClose: () => void;
  registerOverlay: (dismiss: () => void) => () => void;
  onPick: (route: string, search: NoteSearchTarget | undefined, isCurrent: () => boolean) => void;
  /** Omitted only by the explicitly local note surface. */
  scope?: DesktopNoteScope;
  localVaultId?: string;
  enabled?: boolean;
  variant?: "search" | "browse";
  currentRoute?: string;
  online?: boolean;
  onNew?: () => void;
};

/** The existing generation-safe pager, bound to ONE immutable source scope.
 * S1 supplies full-body filtering BEFORE pagination, both online and offline.
 * No discovery, alternate vault, legacy notesList, or local fallback exists. */
export function ScopedNoteSwitcher({ onClose, registerOverlay, onPick, scope, localVaultId, enabled = true, variant = "search", currentRoute, online = false, onNew }: NoteSwitcherProps) {
  const [directory, setDirectory] = useState<string | undefined>(undefined);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [localFolders, setLocalFolders] = useState<string[]>([]);
  const [folderError, setFolderError] = useState(false);
  const catalog = sessionKnowledge().folders;
  const folderSnapshot = useSyncExternalStore(catalog.subscribe, () => scope ? catalog.snapshot(scope) : null);
  useEffect(() => {
    if (variant !== "browse" || !enabled) return;
    let alive = true;
    if (scope) void catalog.activate(scope, online);
    else void (localVaultId ? managedVault.folders(localVaultId) : api.localNoteFolders()).then(result => { if (alive) setLocalFolders(result.paths); }, () => { if (alive) setFolderError(true); });
    return () => { alive = false; };
  }, [localVaultId, catalog, scope?.instance, scope?.vault, online, enabled, variant]);
  const paths = enabled ? scope ? folderSnapshot?.paths || [] : localFolders : [];
  const folders = useMemo(() => noteFolderTree(paths), [paths]);
  const chooseDirectory = (path: string | undefined) => { intent.current.generation += 1; pager.invalidate(); setDirectory(path); };
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const scopeKey = JSON.stringify(scope ? ["desktop", scope.instance, scope.vault, scope.directory] : localVaultId ? ["managed", localVaultId] : ["local"]);
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
      ? await api.contentReplicaNotes(scope.instance, scope.vault, filters.q, filters.page, filters.folder ?? scope.directory)
      : localVaultId ? await managedVault.notes({ ...filters, localVaultId }) : await api.localNoteList(filters);
    const rows = result.items || [];
    if (scope) assertNoteSearchScope(rows, scope);
    return { ...result, items: rows.map((note: any) => ({
      noteId: localVaultId ? managedNoteRoute(localVaultId, note.noteId) : note.noteId,
      route: scope ? desktopNoteRoute(scope.instance, scope.vault, note.noteId) : localVaultId ? managedNoteRoute(localVaultId, note.noteId) : note.noteId,
      title: note.title || "未命名笔记",
      path: scope ? note.relativePath || "" : localVaultId ? note.relativePath || "Notes" : "本机笔记",
      hit: scope ? readableNoteSearchEvidence(filters.q || "", note) : noteSearchEvidence(filters.q || "", note.content),
    })) };
  }, failure => setError(String(failure))), [scopeKey]);
  const page = useSyncExternalStore(callback => pager.subscribe(callback), () => pager.getState());
  useEffect(() => {
    pager.invalidate();
    setError("");
    if (!enabled) return;
    const timer = setTimeout(() => pager.reload({ q: query.trim(), folder: directory }), query.trim() ? 180 : 0);
    return () => { clearTimeout(timer); pager.suspend(); };
  }, [pager, query, enabled, directory]);
  const matchesRequest = enabled && (pager.currentRequest().q || "") === query.trim() && pager.currentRequest().folder === directory;
  const items = matchesRequest ? page.items : [];
  const waiting = enabled && (!matchesRequest || page.loading || (page.page === 0 && !error));
  const Container = variant === "browse" ? NoteSidePanel : SearchContainer;
  const tree = (parent = "", depth = 0): React.ReactNode => (folders.get(parent) || []).map(path => <div key={path}>
    <div className={"st-note-folder-line" + (directory === path ? " is-current" : "")} style={{ paddingLeft: Math.min(depth, 8) * 12 }}>
      <button type="button" className="st-note-folder-toggle" aria-label={(expanded.has(path) ? "收起" : "展开") + path} aria-expanded={expanded.has(path)} disabled={!folders.get(path)?.length} onClick={() => setExpanded(previous => { const next = new Set(previous); if (next.has(path)) next.delete(path); else next.add(path); return next; })}><Icon name={expanded.has(path) ? "down" : "right"} size={13}/></button>
      <button type="button" className="st-note-folder-title" aria-current={directory === path ? "location" : undefined} onClick={() => chooseDirectory(path)}><Icon name="folder" size={18}/><span>{path.slice(path.lastIndexOf("/") + 1)}</span></button>
    </div>{expanded.has(path) ? tree(path, depth + 1) : null}
  </div>);
  return <div style={{ display: "contents" }} onPointerDownCapture={event => {
    if ((event.target as Element).closest(".st-scrim, .st-sheet-handle")) cancelPick();
  }} onClickCapture={event => {
    if ((event.target as Element).closest(".st-scrim, .st-sheet-handle")) cancelPick();
  }}><Container side="left" footer={variant === "browse" ? <><small>{localVaultId ? "Notes" : scope ? "电脑知识库" : "本机知识库"}</small><div>{onNew ? <IconButton icon="plus" label="新建笔记" onClick={onNew}/> : null}<IconButton icon="search" label="搜索笔记" onClick={() => { setQuery(""); setSearching(value => !value); }}/><IconButton icon="folder" label="收起所有目录" onClick={() => setExpanded(new Set())}/></div></> : undefined} title={variant === "browse" ? (localVaultId ? "Notes" : scope ? "电脑笔记" : "本机笔记") : scope ? scope.directory ? "查找当前目录" : "查找当前知识库" : "查找本机笔记"} registerOverlay={close => registerOverlay(() => { cancelPick(); close(); })} onClose={dismiss}>
    {variant === "browse" ? <nav className="st-note-folder-tree" aria-label="笔记目录"><div className={"st-note-folder-line" + (directory === undefined ? " is-current" : "")}><button type="button" className="st-note-folder-title" onClick={() => chooseDirectory(undefined)}><Icon name="knowledge" size={18}/><span>全部笔记</span></button></div>{tree()}{folderError ? <p className="st-note-folder-caption">文件夹暂未读取，笔记仍可浏览。</p> : null}{scope && folderSnapshot && folderStatus(folderSnapshot, online) ? <p className="st-note-folder-caption">{folderStatus(folderSnapshot, online)}</p> : null}</nav> : null}
    {variant === "search" || searching ? <SearchField value={query} onChange={value => {
      // Fence page-N synchronously, before the debounce and before paint.
      intent.current.generation += 1; pager.invalidate(); setError(""); setQuery(value);
    }} placeholder={scope?.directory ? `查找 ${scope.directory}` : "搜索标题和完整正文"} /> : null}
    {items.map((note: any) => <KnowledgeNoteRow activateOnClick current={note.route === currentRoute} key={note.route} noteId={note.noteId}
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
    {enabled && error ? <Button kind="quiet" onClick={() => { setError(""); pager.reload({ q: query.trim(), folder: directory }); }}>重试</Button> : null}
    {enabled && page.hasMore && matchesRequest ? <Button kind="quiet" disabled={page.loading} onClick={() => void pager.loadMore({ q: query.trim(), folder: directory })}>
      {page.loading ? "正在加载…" : "加载更多"}
    </Button> : null}
  </Container></div>;
}

function SearchContainer({title, children, onClose, registerOverlay}: {title: string; children: React.ReactNode; onClose: () => void; registerOverlay: (close: () => void) => () => void; side?: "left" | "right"; footer?: React.ReactNode}) { return <Sheet title={title} onClose={onClose} registerDismiss={registerOverlay}>{children}</Sheet>; }
