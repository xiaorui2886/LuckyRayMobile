import { useEffect, useRef, useState } from "react";
import type { CmEditorHandle } from "../../presentation/still01/editor/MobileCmEditor";
import { headingEditorOffset, noteHeadings, resolveNoteHeading, type NoteHeading } from "./noteHeadings";

export type NoteHeadingIntent = { fragment: string };
export type ReadingHeadingIntent = { offset: number };
/** Scroll intent only: never replace document, selection, history or mode. */
export function useNoteHeadingNavigation(options: {
  intent?: NoteHeadingIntent; body: string; current: boolean; ready: boolean; mode: "read" | "edit";
  composing: () => boolean; editor: () => CmEditorHandle | null;
  clearSearch: () => void; closeSheet: () => void; notice: (message: string) => void;
}) {
  const [readingHeading, setReadingHeading] = useState<ReadingHeadingIntent>();
  const consumed = useRef<NoteHeadingIntent | undefined>(undefined);
  const live = useRef(options); live.current = options;
  const navigate = (target: NoteHeading | string): boolean => {
    const o = live.current;
    if (!o.current || !o.ready || o.composing()) return false;
    const editor = o.mode === "edit" ? o.editor() : null;
    if (editor?.isComposing() || editor?.compositionStarted()) return false;
    const heading = typeof target === "string" ? resolveNoteHeading(noteHeadings(o.body), target)
      : noteHeadings(o.body).find(h => h.from === target.from && h.id === target.id);
    if (!heading) { o.notice("未找到目标标题，正文可能已更新。"); return true; }
    if (o.mode === "edit") {
      const offset = editor && headingEditorOffset(o.body, editor.getValue(), heading.from);
      if (!editor || offset === undefined || offset === null) { o.notice("正文尚未就绪，请稍后重试标题跳转。"); return false; }
      o.clearSearch(); o.closeSheet(); editor.scrollToSource(offset);
    } else { o.clearSearch(); o.closeSheet(); setReadingHeading({ offset: heading.from }); }
    return true;
  };
  useEffect(() => {
    if (!options.intent || consumed.current === options.intent || !options.current || !options.ready) return;
    if (navigate(options.intent.fragment)) consumed.current = options.intent;
  }, [options.intent, options.current, options.ready, options.body, options.mode]);
  useEffect(() => {
    let frame = 0, retries = 0;
    const retry = () => {
      const o = live.current;
      if (!o.current || !o.ready || !o.intent || consumed.current === o.intent) return;
      if (navigate(o.intent.fragment)) consumed.current = o.intent;
      else if (++retries < 2) frame = requestAnimationFrame(retry);
      else o.notice("暂未完成标题跳转，请结束输入后重试。");
    };
    const ended = (event: Event) => {
      if (!(event.target instanceof Element) || !event.target.closest('.st-detail-stage[data-current="true"]')) return;
      cancelAnimationFrame(frame); retries = 0;
      // CM can clear compositionStarted after the DOM compositionend event.
      // Two bounded frames only; a stuck IME waits for a legitimate new
      // compositionend/focus event, never spins or forces a commit.
      frame = requestAnimationFrame(retry);
    };
    document.addEventListener("compositionend", ended);
    document.addEventListener("focusin", ended);
    return () => {
      document.removeEventListener("compositionend", ended);
      document.removeEventListener("focusin", ended);
      cancelAnimationFrame(frame);
    };
  }, []);
  return { navigateHeading: navigate, readingHeading, consumeReadingHeading: () => setReadingHeading(undefined) };
}
