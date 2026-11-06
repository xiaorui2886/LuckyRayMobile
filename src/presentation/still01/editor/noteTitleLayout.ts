import { useLayoutEffect, type RefObject } from 'react';
import { EditorView } from '@codemirror/view';

/** Layout only: never focus, edit, select, save or move the note's scroll owner. */
export function fitNoteTitle(title: HTMLTextAreaElement): void {
  if (title.getBoundingClientRect().width <= 0) return;
  const previous = title.style.height;
  title.style.height = 'auto';
  const line = parseFloat(title.ownerDocument.defaultView!.getComputedStyle(title).lineHeight) || 0;
  const height = Math.max(line, title.scrollHeight);
  if (height <= 0) { title.style.height = previous; return; }
  title.style.height = `${Math.ceil(height)}px`;
  // The retained title is a sibling of cm-content in the same scroll owner.
  // Let CM remeasure that offset; do not reset its selection or scrollTop.
  if (title.style.height !== previous) {
    const editor = title.closest<HTMLElement>('.cm-editor');
    if (editor) EditorView.findFromDOM(editor)?.requestMeasure();
  }
}

export function useNoteTitleLayout(ref: RefObject<HTMLTextAreaElement | null>, value: string, editable: boolean): void {
  useLayoutEffect(() => { if (ref.current) fitNoteTitle(ref.current); }, [ref, value, editable]);
  useLayoutEffect(() => {
    const title = ref.current;
    if (!title) return;
    const win = title.ownerDocument.defaultView!;
    let width = -1;
    const changedWidth = () => {
      const current = title.getBoundingClientRect().width;
      if (current <= 0 || current === width) return;
      width = current;
      fitNoteTitle(title);
    };
    changedWidth();
    // Also handles the existing title portal moving between reader and CM.
    const observer = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(changedWidth) : null;
    observer?.observe(title);
    win.addEventListener('resize', changedWidth);
    return () => { observer?.disconnect(); win.removeEventListener('resize', changedWidth); };
  }, [ref, editable]);
}
