import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { managedVault, managedNoteRoute, parseManagedNoteRoute, type ManagedNote } from "../../services/managedVault";
import { LocalNotesPager } from "../../services/knowledgeNotesPager";
import { failureCopy } from "../../services/feedback";
import { NoteSidePanel } from "./NoteSidePanel";
import { CompactNoteRow, NotesInlineFolders } from "./NotesInlineTree";
import { Button, IconButton, SearchField } from "./StillImports";
import { readNotesSort } from "./notesSortPreference";
import type { NoteSwitcherProps } from "./noteSwitcher";

/** Same inline folder/note rows as the outer list; opening this view never creates a note. */
export function ManagedNoteBrowser({ localVaultId, vaultName, currentRoute, enabled = true, onClose, registerOverlay, onPick, onNew, onSwitchVault }: NoteSwitcherProps & { localVaultId: string }) {
  const [paths, setPaths] = useState<string[]>([]);
  const [folderError, setFolderError] = useState("");
  const [foldersLoaded, setFoldersLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const intent = useRef({ active: enabled, generation: 0 });
  if (intent.current.active !== enabled) { intent.current.active = enabled; intent.current.generation++; }
  const cancel = () => { intent.current.generation++; };
  const dismiss = () => { cancel(); onClose(); };
  useEffect(() => {
    intent.current.active = enabled;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") cancel(); };
    window.addEventListener("keydown", escape, true);
    return () => { intent.current.active = false; cancel(); window.removeEventListener("keydown", escape, true); };
  }, [enabled]);
  useEffect(() => {
    const changed = (event: Event) => {
      const vault = (event as CustomEvent<{localVaultId?: string}>).detail?.localVaultId;
      if (!vault || vault === localVaultId) setRevision(value => value + 1);
    };
    window.addEventListener("luckyray:managed-vault-change", changed);
    return () => window.removeEventListener("luckyray:managed-vault-change", changed);
  }, [localVaultId]);
  useEffect(() => {
    let alive = true;
    if (enabled) void managedVault.folders(localVaultId).then(value => {
      if (alive) { setPaths(value.paths); setFolderError(""); setFoldersLoaded(true); }
    }, reason => { if (alive) { setFolderError(failureCopy(reason)); setFoldersLoaded(true); } });
    return () => { alive = false; };
  }, [localVaultId, enabled, revision]);
  const pager = useMemo(() => new LocalNotesPager(async filters => {
    const result = await managedVault.notes({ ...filters, localVaultId });
    if (result.items.some(note => note.localVaultId !== localVaultId || (filters.folder !== undefined && note.folder !== filters.folder)))
      throw new Error("笔记库或目录身份不匹配，已停止显示");
    return result;
  }, reason => setError(failureCopy(reason))), [localVaultId]);
  const page = useSyncExternalStore(callback => pager.subscribe(callback), () => pager.getState());
  const q = query.trim();
  const sort = readNotesSort(localVaultId);
  // Root rows are unfiled only. Child rows come from the existing lazy inline tree.
  const filters = { q, folder: q ? undefined : "", sort, archived: false };
  useEffect(() => {
    setError("");
    if (!enabled) return;
    const timer = setTimeout(() => {
      const previous = pager.currentRequest();
      if (pager.hasLoadedRows() && (previous.q || "") === q && previous.folder === filters.folder && previous.sort === sort) pager.revalidate(filters);
      else pager.reload(filters);
    }, q ? 180 : 0);
    return () => { clearTimeout(timer); pager.suspend(); };
  }, [pager, q, sort, enabled, revision]);
  const matches = enabled && (pager.currentRequest().q || "") === q && pager.currentRequest().folder === filters.folder && pager.currentRequest().sort === sort;
  const items: ManagedNote[] = matches ? page.items : [];
  const open = (note: ManagedNote) => {
    if (!enabled || note.localVaultId !== localVaultId) return;
    const generation = ++intent.current.generation;
    onPick(managedNoteRoute(localVaultId, note.noteId), q ? { query: q } : undefined,
      () => intent.current.active && intent.current.generation === generation);
  };
  const activeNote = currentRoute ? parseManagedNoteRoute(currentRoute) : null;
  const currentNoteId = activeNote?.localVaultId === localVaultId ? activeNote.noteId : undefined;
  const label = vaultName || "知识库";
  return <div style={{ display: "contents" }} onPointerDownCapture={cancel}><NoteSidePanel side="left" title={label} registerOverlay={close => registerOverlay(() => { cancel(); close(); })} onClose={dismiss}
    footer={<><small>{label}</small><div>{onNew ? <IconButton icon="plus" label="新建笔记" disabled={!enabled} onClick={() => { cancel(); onNew(); }}/> : null}<IconButton icon="search" label="搜索笔记" disabled={!enabled} onClick={() => { cancel(); if (q) pager.invalidate(); setQuery(""); setSearching(value => !value); }}/><IconButton icon="folder" label="切换库" disabled={!enabled || !onSwitchVault} onClick={() => { cancel(); onSwitchVault?.(); }}/></div></>}>
    <div className="st-managed-note-browser" aria-busy={enabled && !error && (!matches || page.loading || page.page === 0 || (!q && !foldersLoaded))}>
    {searching ? <SearchField value={query} onChange={value => { cancel(); if (value.trim() !== q) pager.invalidate(); setError(""); setQuery(value); }} placeholder="搜索标题和完整正文"/> : null}
    {enabled && !q ? <NotesInlineFolders vaultId={localVaultId} paths={paths} selected={selected} onSelect={path => { cancel(); setSelected(path); }} sort={sort} revision={revision} readOnly currentNoteId={currentNoteId} active onOpen={open}/> : null}
    {folderError ? <p role="alert" className="st-folder-status">{folderError}<Button kind="quiet" onClick={() => setRevision(value => value + 1)}>重新读取目录</Button></p> : null}
    {items.map(note => <CompactNoteRow key={note.noteId} note={note} readOnly currentNoteId={currentNoteId} showPath={!!q} onOpen={open}/>)}
    {!enabled ? <p role="status" className="st-folder-status">当前笔记库不可用，请重新选择。</p> : error ? <p role="alert" className="st-folder-status">{error}<Button kind="quiet" onClick={() => { setError(""); pager.reload(filters); }}>重试</Button></p> : matches && !page.loading && page.page > 0 && !items.length && (q || (foldersLoaded && !folderError && !paths.length)) ? <p className="st-folder-status">{q ? "没有找到匹配的笔记" : "当前知识库还没有笔记"}</p> : null}
    {matches && page.hasMore ? <Button kind="quiet" disabled={page.loading} onClick={() => void pager.loadMore(filters)}>加载更多</Button> : null}
    </div>
  </NoteSidePanel></div>;
}
