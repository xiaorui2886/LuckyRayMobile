import DesktopNotePreview from "../../components/DesktopNotePreview";
import type { NoteResource } from "../../services/noteResourceSession";
import { managedVault, type ManagedNote, type VaultBinding } from "../../services/managedVault";
import { managedBoundWikiMatches, resolveManagedBoundWiki } from "./managedWiki";
import type { LocalBacklink } from "./localBacklinks";
import { scanLocalBacklinks } from "./localBacklinkScanner";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../../services/client";
import { SafeNoteMarkdown } from "../../components/SafeNoteMarkdown";
import { type ReadingFind } from "./NoteReadingContent";
import { localWikiDisplayStatus, localWikiReferences, resolveLocalWiki, localWikiChoiceDetail, chooseLocalWiki, type LocalWikiNote, type LocalWikiClient } from "./localWiki";
import { splitWikiHeading } from "./noteHeadings";
import type { WikiReference } from "./knowledgeRelations";
import { Sheet, Option, Button } from "./StillImports";

/** Local links stay within the local catalog; no Desktop requests or new save owner. */
export function LocalKnowledgeReader({ source, localVaultId, binding, resources, revision, content, current, find, registerOverlay, onNavigate, panelOnly = false, renderEditor }: {
  localVaultId?: string; binding?: VaultBinding; resources?: NoteResource[]; revision?: string;
  renderEditor?: (follow: (reference: WikiReference) => void, status: (reference: WikiReference) => "resolved" | "missing" | "ambiguous" | "unknown") => ReactNode;
  panelOnly?: boolean; source: string; content: string; current: boolean; find: ReadingFind;
  registerOverlay: (dismiss: () => void) => () => void;
  onNavigate: (noteId: string, isCurrent: () => boolean, heading?: string) => Promise<void>;
}) {
  const boundScope = useMemo(() => localVaultId && binding ? { localVaultId, binding } : null, [localVaultId, binding?.instanceId, binding?.remoteVaultId]);
  const [backlinks, setBacklinks] = useState<LocalBacklink[]>([]);
  const [backlinkRetry, setBacklinkRetry] = useState(0);
  const [backlinkPage, setBacklinkPage] = useState(1);
  const [backlinkMore, setBacklinkMore] = useState(false);
  const [backlinkPending, setBacklinkPending] = useState(false);
  const [backlinkError, setBacklinkError] = useState(false);
  useEffect(() => { setBacklinks([]); setBacklinkPage(1); setBacklinkMore(false); }, [localVaultId, source, current]);
  const references = useMemo(() => panelOnly ? localWikiReferences(content) : [], [content, panelOnly]);
  const [catalog, setCatalog] = useState<{ source: string; notes: LocalWikiNote[] } | null>(null);
  useEffect(() => {
    let alive = true; setCatalog(null); setBacklinkError(false);
    if (current) void (localVaultId ? managedVault.linkCatalog(localVaultId).then(result => ({ items: result.items.map(note => ({ ...note, managedIdentity: true })) })) : api.localNoteLinkCatalog()).then(result => {
      if (alive && Array.isArray(result.items)) setCatalog({ source, notes: result.items });
    }).catch(() => { if (alive) setBacklinkError(true); });
    return () => { alive = false; };
  }, [localVaultId, source, current, backlinkRetry]);
  useEffect(() => {
    if (!panelOnly || !current || !catalog || catalog.source !== source) return;
    let alive = true; let cancelScan: (()=>void)|undefined;
    setBacklinkPending(true); setBacklinkError(false);
    // Search the authoritative local body before pagination, then parse
    // long candidates off the input thread. Partial results stay explicit.
    void (localVaultId ? managedVault.notes({ localVaultId, q: "[[", page: backlinkPage, limit: 25, sort: "name" }) : api.localNoteList({ q: "[[", page: backlinkPage, limit: 25, sort: "name" })).then(async result => {
      if (!alive) return;
      const scan=scanLocalBacklinks(source, result.items || [], catalog.notes, boundScope ? (ref, note, rows) => { const matches = managedBoundWikiMatches(ref, rows as ManagedNote[], note.noteId, boundScope).notes; return matches.length === 1 ? matches[0].noteId : null; } : undefined); cancelScan=scan.cancel;
      const found=await scan.promise;
      if (!alive) return;
      setBacklinks(previous => [...new Map([...(backlinkPage === 1 ? [] : previous), ...found].map(note => [note.noteId, note])).values()]);
      setBacklinkMore(Boolean(result.hasMore));
    }).catch(() => { if (alive) setBacklinkError(true); }).finally(() => { if (alive) setBacklinkPending(false); });
    return () => { alive = false; cancelScan?.(); };
  }, [localVaultId, boundScope, panelOnly, current, catalog, source, backlinkPage, backlinkRetry]);
  const linkStatus = useCallback((reference: WikiReference) => {
    if (!current || !catalog || catalog.source !== source) return "unknown" as const;
    if (boundScope) {
      try { const matches = managedBoundWikiMatches(reference, catalog.notes as ManagedNote[], source, boundScope).notes; return matches.length === 1 ? "resolved" : matches.length ? "ambiguous" : "missing"; } catch { return "unknown"; }
    }
    return localWikiDisplayStatus(reference, catalog.notes);
  }, [catalog, source, current, boundScope]);
  const [notice, setNotice] = useState("");
  const [choice, setChoice] = useState<{ notes: LocalWikiNote[]; token: number; reference: WikiReference; heading?: string } | null>(null);
  const generation = useRef(0), busy = useRef(false), active = useRef(current); active.current = current;
  const cancelPendingChoice = () => { ++generation.current; busy.current = false; };
  useEffect(() => {
    ++generation.current; busy.current = false; setNotice(""); setChoice(null);
    return () => { ++generation.current; };
  }, [localVaultId, source, content, current]);
  useEffect(() => {
    if (!choice) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") cancelPendingChoice(); };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [Boolean(choice)]);
  const scopedClient = (isCurrent: () => boolean): LocalWikiClient => {
    const requireCurrent = () => { if (!isCurrent()) throw Error("LOCAL_WIKI_RETIRED"); };
    return {
      ...(localVaultId ? { managedScope: true as const } : {}),
      catalog: async () => { requireCurrent(); const result = await (localVaultId ? managedVault.linkCatalog(localVaultId).then(result => ({ items: result.items.map(note => ({ ...note, managedIdentity: true })) })) : api.localNoteLinkCatalog()); requireCurrent(); return result; },
      get: async id => { requireCurrent(); const result = await (localVaultId ? managedVault.get(localVaultId, id) : api.localNoteGet(id)); requireCurrent(); return result; },
    };
  };
  const boundClient = (isCurrent: () => boolean) => ({
    catalog: async () => { if (!boundScope || !isCurrent()) throw Error("LOCAL_WIKI_RETIRED"); const value = await managedVault.linkCatalog(boundScope.localVaultId); if (!isCurrent()) throw Error("LOCAL_WIKI_RETIRED"); return value; },
    get: async (id: string) => { if (!boundScope || !isCurrent()) throw Error("LOCAL_WIKI_RETIRED"); const value = await managedVault.get(boundScope.localVaultId, id); if (!isCurrent()) throw Error("LOCAL_WIKI_RETIRED"); return value; },
  });
  async function follow(reference: WikiReference) {
    if (!active.current || busy.current) return;
    const token = ++generation.current; busy.current = true;
    const isCurrent = () => active.current && generation.current === token;
    setNotice("正在查找笔记…");
    try {
      const split = splitWikiHeading(reference.target);
      if (!split) throw Error("LOCAL_WIKI_ANCHOR_UNSUPPORTED");
      if (!split.noteTarget && split.heading !== undefined) {
        setNotice(""); await onNavigate(source, isCurrent, split.heading); return;
      }
      const result = boundScope ? await resolveManagedBoundWiki(reference, source, boundScope, boundClient(isCurrent)) : await resolveLocalWiki(reference, scopedClient(isCurrent));
      if (!isCurrent()) return;
      if (result.kind === "resolved") { setNotice(""); await onNavigate(result.notes[0].noteId, isCurrent, result.heading); }
      else if (result.kind === "ambiguous") { setNotice(""); setChoice({ notes: result.notes, token, reference, heading: result.heading }); }
      else setNotice("未找到这篇笔记。");
    } catch (error) {
      if (isCurrent()) setNotice(error instanceof Error && error.message === "LOCAL_WIKI_PATH_UNSUPPORTED"
        ? "链接路径无效，请使用笔记名称或根目录下的文件夹路径。"
        : error instanceof Error && error.message === "LOCAL_WIKI_ANCHOR_UNSUPPORTED"
          ? "章节链接格式无效，请检查标题名称。"
          : "暂时无法打开链接，请重试。");
    } finally { if (isCurrent()) busy.current = false; }
  }
  async function choose(note: LocalWikiNote) {
    if (!choice || choice.token !== generation.current || !active.current || busy.current) return;
    const token = choice.token; busy.current = true;
    const isCurrent = () => active.current && token === generation.current;
    try {
      if (boundScope) await resolveManagedBoundWiki(choice.reference, source, boundScope, boundClient(isCurrent), { noteId: note.noteId, expectedIds: choice.notes.map(item => item.noteId) });
      else await chooseLocalWiki(choice.reference, note.noteId, choice.notes.map(item => item.noteId), scopedClient(isCurrent));
      if (!isCurrent()) return;
      setChoice(null); await onNavigate(note.noteId, isCurrent, choice.heading);
    } catch { if (isCurrent()) { setChoice(null); setNotice("笔记已变化，请重新打开链接。"); } }
    finally { if (isCurrent()) busy.current = false; }
  }
  const closeChoice = () => { cancelPendingChoice(); setChoice(null); };
  return <>
    {current && choice?.token === generation.current ? <div style={{ display: "contents" }}
      onClick={event => event.stopPropagation()}
      onPointerDownCapture={event => { if ((event.target as Element).closest(".st-scrim, .st-sheet-handle")) cancelPendingChoice(); }}
      onClickCapture={event => { if ((event.target as Element).closest(".st-scrim, .st-sheet-handle")) cancelPendingChoice(); }}>
      <Sheet title="选择笔记" registerDismiss={close => registerOverlay(() => { cancelPendingChoice(); close(); })} onClose={closeChoice}>
      <p className="st-sheet-copy">当前名称或历史名称匹配到多篇笔记，请选择要打开的一篇。</p>
      {choice.notes.map(note => <Option key={note.noteId} label={note.title} detail={localWikiChoiceDetail(note)} onClick={() => void choose(note)} />)}
    </Sheet></div> : null}
    {notice ? <p className="st-note-switcher-status" role="status">{notice}</p> : null}
    {renderEditor ? renderEditor(reference => void follow(reference), linkStatus) : panelOnly ? <div className="st-local-note-links"><h3 className="st-links-heading">链接到</h3>{references.length ? references.map(ref => <Option key={ref.from} label={ref.label} detail={ref.label !== ref.target ? ref.target : undefined} icon="link" onClick={() => void follow(ref)} />) : <p className="st-sheet-copy">还没有内部链接。</p>}
      <section className="st-note-relations" aria-label="引用此笔记"><h3 className="st-links-heading">引用此笔记</h3>
        {backlinks.map(note => <Option key={note.noteId} label={note.title} detail={note.excerpt} icon="file" onClick={() => void follow({target: localVaultId ? `@id/${note.noteId}` : note.noteId, label: note.title, from: 0, to: 0, line: 0})}/>)}
        {!backlinkError && (backlinkPending || !catalog) ? <p className="st-folder-status" role="status">正在查找引用…</p> : backlinkError ? <Button kind="quiet" onClick={() => setBacklinkRetry(value => value + 1)}>重试</Button> : !backlinks.length && !backlinkMore ? <p className="st-folder-status">还没有其他笔记引用此笔记。</p> : null}
        {backlinkMore && !backlinkPending ? <Button kind="quiet" onClick={() => setBacklinkPage(value => value + 1)}>继续查找引用</Button> : null}
      </section></div> : localVaultId ? <DesktopNotePreview localVaultId={localVaultId} revision={revision} instance="" vault={localVaultId} note={source} content={content} resources={resources || []} online={false} find={find} wikiStatus={linkStatus} onWikiLink={reference => void follow(reference)} registerOverlay={registerOverlay} /> : <SafeNoteMarkdown content={content} find={find} wikiStatus={linkStatus} onWikiLink={reference => void follow(reference)} />}
  </>;
}
