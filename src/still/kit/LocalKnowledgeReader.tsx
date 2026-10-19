import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../../services/client";
import { plainReadingBlocks } from "../../presentation/still01/editor/noteReadingPosition";
import { ReadingText, type ReadingFind } from "./NoteReadingContent";
import { localWikiReferences, resolveLocalWiki, localWikiChoiceDetail, type LocalWikiNote } from "./localWiki";
import type { WikiReference } from "./knowledgeRelations";
import { Sheet, Option } from "./StillImports";

/** Inline local links only, no Desktop relation requests, backlinks or new save system. */
export function LocalKnowledgeReader({ source, content, current, find, registerOverlay, onNavigate, panelOnly = false }: {
  panelOnly?: boolean; source: string; content: string; current: boolean; find: ReadingFind;
  registerOverlay: (dismiss: () => void) => () => void;
  onNavigate: (noteId: string, isCurrent: () => boolean) => Promise<void>;
}) {
  const references = useMemo(() => localWikiReferences(content), [content]);
  const [notice, setNotice] = useState("");
  const [choice, setChoice] = useState<{ notes: LocalWikiNote[]; token: number } | null>(null);
  const generation = useRef(0), busy = useRef(false), active = useRef(current); active.current = current;
  const cancelPendingChoice = () => { ++generation.current; busy.current = false; };
  useEffect(() => {
    ++generation.current; busy.current = false; setNotice(""); setChoice(null);
    return () => { ++generation.current; };
  }, [source, content, current]);
  useEffect(() => {
    if (!choice) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") cancelPendingChoice(); };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [Boolean(choice)]);
  async function follow(reference: WikiReference) {
    if (!active.current || busy.current) return;
    const token = ++generation.current; busy.current = true;
    const isCurrent = () => active.current && generation.current === token;
    setNotice("正在查找本机笔记…");
    try {
      const requireCurrent = () => { if (!isCurrent()) throw Error("LOCAL_WIKI_RETIRED"); };
      const result = await resolveLocalWiki(reference, {
        list: async options => { requireCurrent(); const result = await api.localNoteList(options); requireCurrent(); return result; },
        get: async id => { requireCurrent(); const result = await api.localNoteGet(id); requireCurrent(); return result; },
      });
      if (!isCurrent()) return;
      if (result.kind === "resolved") { setNotice(""); await onNavigate(result.notes[0].noteId, isCurrent); }
      else if (result.kind === "ambiguous") { setNotice(""); setChoice({ notes: result.notes, token }); }
      else setNotice("未找到这篇笔记。");
    } catch (error) {
      if (isCurrent()) setNotice(error instanceof Error && error.message === "LOCAL_WIKI_PATH_UNSUPPORTED"
        ? "本机链接不支持目录路径，请使用 [[笔记名]]。"
        : error instanceof Error && error.message === "LOCAL_WIKI_ANCHOR_UNSUPPORTED"
          ? "暂不支持章节定位，请使用 [[笔记名]]。"
          : "暂时无法打开链接，请重试。");
    } finally { if (isCurrent()) busy.current = false; }
  }
  async function choose(note: LocalWikiNote) {
    if (!choice || choice.token !== generation.current || !active.current || busy.current) return;
    const token = choice.token; busy.current = true;
    const isCurrent = () => active.current && token === generation.current;
    try {
      const actual = await api.localNoteGet(note.noteId);
      if (!isCurrent()) return;
      if (actual?.noteId !== note.noteId || actual.title !== note.title) throw Error("LOCAL_WIKI_CHANGED");
      setChoice(null); await onNavigate(note.noteId, isCurrent);
    } catch { if (isCurrent()) { setChoice(null); setNotice("笔记已变化，请重新打开链接。"); } }
    finally { if (isCurrent()) busy.current = false; }
  }
  const closeChoice = () => { cancelPendingChoice(); setChoice(null); };
  return <>
    {current && choice?.token === generation.current ? <div style={{ display: "contents" }}
      onClick={event => event.stopPropagation()}
      onPointerDownCapture={event => { if ((event.target as Element).closest(".st-scrim, .st-sheet-handle")) cancelPendingChoice(); }}
      onClickCapture={event => { if ((event.target as Element).closest(".st-scrim, .st-sheet-handle")) cancelPendingChoice(); }}>
      <Sheet title="选择本机笔记" registerDismiss={close => registerOverlay(() => { cancelPendingChoice(); close(); })} onClose={closeChoice}>
      <p className="st-sheet-copy">找到多篇同名笔记，请选择要打开的一篇。</p>
      {choice.notes.map(note => <Option key={note.noteId} label={note.title} detail={localWikiChoiceDetail(note)} onClick={() => void choose(note)} />)}
    </Sheet></div> : null}
    {notice ? <p className="st-note-switcher-status" role="status">{notice}</p> : null}
    {panelOnly ? <div className="st-local-note-links">{references.length ? references.map(ref => <Option key={ref.from} label={ref.label} detail={ref.label !== ref.target ? ref.target : undefined} icon="link" onClick={() => void follow(ref)} />) : <p className="st-sheet-copy">还没有内部链接。</p>}</div> : plainReadingBlocks(content).map(({ text, from, to }, i) => {
      const nodes: ReactNode[] = []; let consumed = from;
      for (const ref of references.filter(ref => ref.from >= from && ref.to <= to)) {
        nodes.push(<ReadingText key={consumed} text={content.slice(consumed, ref.from)} from={consumed} find={find} />);
        nodes.push(<button key={"wiki-" + ref.from} type="button" className="st-wiki-link"
          data-note-source-start={ref.from} data-note-source-end={ref.to} onClick={() => void follow(ref)}>{ref.label}</button>);
        consumed = ref.to;
      }
      nodes.push(<ReadingText key={consumed} text={content.slice(consumed, to)} from={consumed} find={find} />);
      return <p key={i} data-note-source-start={from} data-note-source-end={to}>{references.length ? nodes : <ReadingText text={text} from={from} find={find} />}</p>;
    })}
  </>;
}
