import { managedFolderPaths, managedFolderChildren } from "./ManagedFolderPicker";
import { useEffect, useRef, useState } from "react";
import { managedVault, type ManagedNote } from "../../services/managedVault";
import { failureCopy } from "../../services/feedback";
import { Button, Icon, IconButton } from "./StillImports";
import "./notesInlineTree.css";

// A presentation preference belongs to a vault, not a folder name shared by vaults.
const expandedByVault = new Map<string, Set<string>>();
export function noteStatus(note: ManagedNote) {
  return note.bodyState === "missing" ? "正文尚未保存到手机" : note.bodyState === "conflict" || note.syncState === "conflict" ? "需处理冲突" : note.syncState === "pending" ? "已保存在手机 · 待同步" : note.syncState === "incomplete" ? "正文已保存 · 链接或附件待核对" : note.syncState === "synced" ? "已同步" : "仅保存在本地";
}
export function NotesActionIcon({ kind }: { kind: "folder-add" | "import" }) {
  return <svg className="st-icon" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{kind === "folder-add" ? <><path d="M3 7V5.5A1.5 1.5 0 0 1 4.5 4H9l2.5 3h8A1.5 1.5 0 0 1 21 8.5v10a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5Z"/><path d="M12 10v7m-3.5-3.5h7"/></> : <><path d="M14 3h3l4 4v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-3M17 3v5h4"/><path d="M3 9h10m-4-4 4 4-4 4"/></>}</svg>;
}
export function CompactNoteRow({ note, readOnly, showPath, currentNoteId, onOpen, onActions }: {
  note: ManagedNote; readOnly: boolean; showPath?: boolean; currentNoteId?: string; onOpen: (note: ManagedNote) => void; onActions?: (note: ManagedNote) => void;
}) {
  const status = noteStatus(note);
  const attention = note.bodyState !== "ready" || ["pending", "incomplete", "conflict"].includes(note.syncState);
  return <div className="st-local-note-entry st-tree-note">
    <button type="button" className="st-note-row" aria-current={currentNoteId === note.noteId ? "page" : undefined} title={`${note.title || "未命名笔记"}\n${note.folder || "根目录"} · ${status}`} onClick={() => onOpen(note)}>
      <span className="st-tree-file-icon" aria-hidden="true"><Icon name="file" size={17}/></span>
      <span className="st-tree-note-label"><strong>{note.title || "未命名笔记"}</strong>{showPath && note.folder ? <span className="st-tree-result-path">{note.folder}</span> : null}</span>
      <span className="st-note-meta st-tree-sr-only">{status}{note.tags.length ? " · " + note.tags.join(" / ") : ""}</span>
      {attention ? <span className={`st-tree-note-state is-${note.bodyState === "missing" ? "missing" : note.syncState}`} role="img" aria-label={status} title={status}/> : null}
      {note.pinned ? <span role="img" aria-label="已置顶"><Icon name="pin" size={12}/></span> : null}
      {note.favorite ? <span role="img" aria-label="已收藏"><Icon name="heart" size={12}/></span> : null}
    </button>
    {onActions ? <IconButton icon="more" disabled={readOnly} label={`笔记操作：${note.title}`} onClick={() => onActions(note)}/> : null}
  </div>;
}

type TreeProps = {
  vaultId: string; paths: string[]; selected: string; onSelect: (path: string) => void;
  sort: "name" | "recent"; revision: number; readOnly: boolean; revealSelection?: number; active?: boolean;
  onTags?: (tags: string[]) => void; currentNoteId?: string;
  onOpen: (note: ManagedNote) => void; onActions?: (note: ManagedNote) => void;
};
export function NotesInlineFolders(props: TreeProps) {
  const [expanded, setExpanded] = useState(() => new Set(expandedByVault.get(props.vaultId)));
  useEffect(() => {
    if (!props.selected) return;
    setExpanded(previous => {
      const next = new Set(previous), parts = props.selected.split("/");
      // Reveal a selection made in the directory sheet without changing pages.
      for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join("/"));
      expandedByVault.set(props.vaultId, next); return next;
    });
  }, [props.selected, props.vaultId]);
  useEffect(() => {
    if (!props.revealSelection || !props.selected) return;
    setExpanded(previous => { const next = new Set(previous); const parts = props.selected.split("/"); for (let i = 1; i <= parts.length; i++) next.add(parts.slice(0, i).join("/")); expandedByVault.set(props.vaultId, next); return next; });
  }, [props.revealSelection]);
  useEffect(() => {
    const back = (event: Event) => {
      if (!props.active || !props.selected) return;
      event.preventDefault();
      if (expanded.has(props.selected)) { const next = new Set(expanded); next.delete(props.selected); expandedByVault.set(props.vaultId, next); setExpanded(next); }
      else props.onSelect(props.selected.split("/").slice(0, -1).join("/"));
    };
    window.addEventListener("luckyray:directory-back", back);
    return () => window.removeEventListener("luckyray:directory-back", back);
  }, [props.active, props.selected, props.vaultId, expanded]);
  const toggle = (path: string) => {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path); else next.add(path);
    expandedByVault.set(props.vaultId, next); setExpanded(next); props.onSelect(path);
  };
  // Old manifests may list leaves only. Derive ancestors without modifying paths.
  const paths = managedFolderPaths(props.paths);
  const children = (parent: string) => managedFolderChildren(paths, parent);
  const branch = (parent: string, depth: number) => children(parent).map(path => <div className="st-tree-branch" key={path}>
    <button type="button" className={"st-folder-row st-tree-folder" + (props.selected === path ? " is-selected" : "")} aria-expanded={expanded.has(path)} aria-current={props.selected === path ? "location" : undefined} title={path} onClick={() => toggle(path)} onKeyDown={event => {
      if (event.key === "ArrowRight" && !expanded.has(path) || event.key === "ArrowLeft" && expanded.has(path)) { event.preventDefault(); toggle(path); }
    }}><span className="st-tree-disclosure"><Icon name="right" size={13}/></span><span className="st-folder-symbol"><Icon name="folder" size={20}/></span><span className="st-folder-name">{path.split("/").pop()}</span></button>
    {expanded.has(path) ? <div className={"st-tree-children" + (depth >= 3 ? " is-deep" : "")} role="group" aria-label={path}>
      {branch(path, depth + 1)}
      <FolderNotes key={JSON.stringify([props.vaultId, path, props.sort])} {...props} path={path}/>
    </div> : null}
  </div>);
  return <section className="st-notes-inline-tree" aria-label="笔记文件夹">{branch("", 0)}</section>;
}

function FolderNotes(props: TreeProps & { path: string }) {
  const [result, setResult] = useState<{items: ManagedNote[]; page: number; hasMore: boolean} | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState("");
  const generation = useRef(0), alive = useRef(true), extent = useRef(1);
  const load = async (page: number) => {
    const token = ++generation.current; setLoading(true); setError("");
    try {
      let all: ManagedNote[] = [], cursor = page, more = false;
      do {
        const next = await managedVault.notes({localVaultId: props.vaultId, folder: props.path, sort: props.sort, archived: false, page: cursor, limit: 50});
        if (!alive.current || token !== generation.current) return;
        if (next.items.some(note => note.localVaultId !== props.vaultId || note.folder !== props.path)) throw new Error("笔记目录身份不匹配，已停止显示");
        all = [...all, ...next.items]; more = next.hasMore;
        if (!more || cursor >= extent.current) break;
        cursor++;
      } while (true);
      extent.current = cursor;
      props.onTags?.([...new Set(all.flatMap(note => note.tags))]);
      setResult(previous => ({items: page > 1 ? [...(previous?.items || []), ...all.filter(note => !previous?.items.some(old => old.noteId === note.noteId))] : all, page: cursor, hasMore: more}));
    } catch (reason) { if (alive.current && token === generation.current) setError(failureCopy(reason)); }
    finally { if (alive.current && token === generation.current) setLoading(false); }
  };
  useEffect(() => { if (props.active === false) return; alive.current = true; void load(1); return () => { alive.current = false; generation.current++; }; }, [props.revision, props.active]);
  return <>
    {result?.items.map(note => <CompactNoteRow key={note.noteId} note={note} readOnly={props.readOnly} currentNoteId={props.currentNoteId} onOpen={props.onOpen} onActions={props.onActions}/>)}
    {loading ? <p className="st-tree-hint" role="status">正在读取…</p> : error ? <div className="st-tree-hint" role="alert">{error}<Button kind="quiet" onClick={() => void load(1)}>重试</Button></div> : !result?.items.length && !props.paths.some(path => path.startsWith(props.path + "/")) ? <p className="st-tree-hint">空文件夹</p> : null}
    {result?.hasMore ? <Button kind="quiet" disabled={loading} onClick={() => void load(result.page + 1)}>加载更多笔记</Button> : null}
  </>;
}
