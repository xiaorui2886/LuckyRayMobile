import {allowNoteViewportNavigation} from './noteViewportStability';
import {noteScrollNavigation} from './cmCaretVisibility';
import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { EditorView } from '@codemirror/view';

import { editorOffsetAtSource, readingOffsetAtPoint, isReadingControl } from './noteTapEditing';

const PreviewHandoff = createContext<{ settle: (view: EditorView, restorePosition?: boolean, available?: boolean) => void; invalidate: () => void; waiting: boolean } | undefined>(undefined);
export const usePreviewHandoff = () => useContext(PreviewHandoff);

/** Gate every scoped editor entry, including a cold route with no reader. A
 * cold route uses the existing quiet opening skeleton; it never reparses the
 * whole note on the UI thread just to cover an undecorated editor.
 * Keep the actual reader mounted until this editor's first matching decorated
 * document is committed. This is a handoff, not another parser or saved copy.
 * The hidden editor can receive a deliberate focus/IME gesture immediately.
 * Read→edit→read invalidates old callbacks even when the text is identical. */
export function NoteBodyTransition({ mode, scope, body, editor, children, heading }: {
  mode: 'read' | 'edit'; scope?: string; body: string; editor: ReactNode; children: ReactNode; heading?: ReactNode;
}) {
  const retainedReader = useRef<{ scope?: string; body: string; element: ReactNode } | null>(null);
  if (retainedReader.current?.scope !== scope) retainedReader.current = null;
  if (mode === 'read') retainedReader.current = { scope, body, element: children };
  const cover = retainedReader.current?.scope === scope && retainedReader.current?.body === body ? retainedReader.current : null;
  const generation = useMemo(() => ({}), [mode, scope]);
  const current = useRef({ generation, body, mode, hasCover: Boolean(cover) });
  current.current = { generation, body, mode, hasCover: Boolean(cover) };
  const accepted = useRef<object | null>(null);
  const [ready, setReady] = useState<object | null>(null);
  const [unavailable, setUnavailable] = useState<object | null>(null);
  const editHost = useRef<HTMLDivElement>(null);
  const reader = useRef<HTMLDivElement>(null);
  const pendingView = useRef<EditorView | null>(null);
  const anchor = useRef<{ offset: number; atStart: boolean; paper: HTMLElement } | null>(null);
  const report = useMemo(() => (view: EditorView, restorePosition = true, available = true) => {
    if (accepted.current === generation || current.current.generation !== generation || current.current.mode !== 'edit'
      || view.state.doc.toString() !== current.current.body.replace(/\r\n?/g, '\n') || !view.dom.isConnected) return;
    if (!available) { pendingView.current = view; setUnavailable(generation); return; }
    setUnavailable(null);
    const root = reader.current, paper = root?.closest<HTMLElement>('.st-note-paper');
    anchor.current = null;
    // A deliberate caret/IME/search move owns its position; otherwise keep the
    // visible reading block, not a stale editor scroll from a previous visit.
    if (current.current.hasCover && root && paper && !view.hasFocus && restorePosition) {
      const box = paper.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) anchor.current = { offset: editorOffsetAtSource(current.current.body,
        readingOffsetAtPoint(root, current.current.body, box.left + 32, Math.max(box.top, paper.closest('.st-note-surface')?.querySelector('.st-header')?.getBoundingClientRect().bottom ?? box.top) + 8)), atStart: paper.scrollTop <= 1, paper };
    }
    accepted.current = generation;
    pendingView.current = view;
    setReady(generation);
  }, [generation]);
  const waiting = scope !== undefined && mode === 'edit' && ready !== generation && accepted.current !== generation;
  useLayoutEffect(() => {
    const host = editHost.current;
    const release = () => { accepted.current = generation; setReady(generation); };
    // React's legacy before-input plugin does not subscribe to every native
    // beforeinput event. Capture actual WebView input without preventing it.
    host?.addEventListener('beforeinput', release, true);
    return () => host?.removeEventListener('beforeinput', release, true);
  }, [mode, generation]);
  // Keep one title input/portal for the lifetime of the note surface. Moving
  // its container does not rebuild selection/undo. Never move it while title
  // focus/IME owns it: migrate only after focus leaves, before the next paint.
  const headingHome = useRef<HTMLDivElement>(null);
  const [headingNode] = useState(() => {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
    const node = document.createElement('div'); node.className = 'st-note-heading'; return node;
  });
  const [headingTarget, setHeadingTarget] = useState<HTMLElement | null>(null);
  const [headingRevision, bumpHeadingRevision] = useState(0);
  useLayoutEffect(() => {
    const node = headingNode;
    if (!node) return;
    let alive = true;
    const reconsider = () => queueMicrotask(() => { if (alive) bumpHeadingRevision(n => n + 1); });
    node.addEventListener('focusout', reconsider);
    node.addEventListener('compositionend', reconsider);
    return () => { alive = false; node.removeEventListener('focusout', reconsider); node.removeEventListener('compositionend', reconsider); node.remove(); };
  }, [headingNode]);
  useLayoutEffect(() => {
    if (!headingNode || !headingHome.current) return;
    const scroller = !waiting && mode === 'edit' && heading
      ? editHost.current?.querySelector<HTMLElement>('.cm-scroller') ?? null : null;
    const target = scroller ?? headingHome.current;
    if (headingNode.parentElement !== target) {
      // Title editing may outlast a delayed preview response. Do not detach an
      // actively composing/focused input just to change its scrolling owner.
      if (headingNode.contains(headingNode.ownerDocument.activeElement)) return;
      target.prepend(headingNode);
    }
    scroller?.classList.add('has-note-heading');
    setHeadingTarget(old => old === scroller ? old : scroller);
  }, [mode, waiting, Boolean(heading), generation, headingNode, headingRevision]);
  useLayoutEffect(() => {
    const paper = headingHome.current?.closest('.st-note-paper');
    paper?.classList.toggle('has-note-scroll-heading', Boolean(headingTarget && !waiting && mode === 'edit'));
    paper?.classList.toggle('is-preview-waiting', waiting);
    return () => { paper?.classList.remove('has-note-scroll-heading', 'is-preview-waiting'); };
  }, [headingTarget, mode, waiting]);
  useLayoutEffect(() => {
    if (waiting || mode !== 'edit') return;
    // Title portal must be in the scroll container before restoring an anchor.
    if (heading && editHost.current?.querySelector('.cm-scroller') && !headingTarget) return;
    const view = pendingView.current, position = anchor.current;
    pendingView.current = null; anchor.current = null;
    if (!view || !view.dom.isConnected) {
      if (headingTarget) EditorView.findFromDOM(headingTarget.parentElement!)?.requestMeasure();
      return;
    }
    // Measure after the editor returns to normal flow. Do not focus, select,
    // mutate source, or disturb an active composition to restore geometry.
    if (position && !view.hasFocus && current.current.generation === generation) {
      allowNoteViewportNavigation(view.dom);
      if (position.atStart) { view.scrollDOM.scrollTop = 0; position.paper.scrollTop = 0; }
      else view.dispatch({ effects: [noteScrollNavigation.of(null), EditorView.scrollIntoView(Math.max(0, Math.min(view.state.doc.length, position.offset)), { y: 'start', yMargin: 8 })] });
    }
    view.requestMeasure();
  }, [waiting, mode, generation, headingTarget, Boolean(heading)]);
  const invalidate = useMemo(() => () => {
    if (current.current.generation !== generation || current.current.mode !== 'edit') return;
    accepted.current = null; setReady(null); setUnavailable(null);
  }, [generation]);
  const handoff = useMemo(() => ({ settle: report, invalidate, waiting }), [report, invalidate, waiting]);
  return <PreviewHandoff.Provider value={handoff}>
    <div ref={headingHome} style={{ display: 'contents' }} />
    {headingNode ? createPortal(heading, headingNode) : heading}
    <div className="st-note-body-handoff" style={{ display: 'contents' }}>
      {mode === 'edit' ? <div ref={editHost} aria-hidden={waiting || undefined} data-preview-handoff={waiting ? 'pending' : 'ready'}
        style={waiting ? { position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', opacity: 0, pointerEvents: 'none' } : { display: 'contents' }}>
        <div style={{ display: 'contents' }} onCompositionStartCapture={() => { accepted.current = generation; setReady(generation); }} onBeforeInputCapture={() => { accepted.current = generation; setReady(generation); }}>{editor}</div>
      </div> : null}
      {mode === 'read' || waiting ? <div ref={reader}
        style={{ display: 'contents' }}
        onClickCapture={event => {
          // The temporary reader must not start a link/download session that
          // would be retired by the imminent handoff. Ordinary body gestures
          // still reach NoteSurface's existing tap/focus and IME path.
          if (waiting && !(event.target as Element).closest('.st-note-preview-unavailable') && isReadingControl(event.target as Element, event.currentTarget)) { event.preventDefault(); event.stopPropagation(); }
        }}>
        {mode === 'read' ? children : cover?.element ?? (unavailable === generation ? null : <div className="st-note-opening" role="status" aria-label="正在准备笔记"><i/><i/><i/></div>)}
        {waiting && unavailable === generation ? <div className="st-note-preview-unavailable" role="status">
          <span>暂时无法预览，原文已保留</span>
          <button type="button" onClick={event => { event.stopPropagation(); const view = pendingView.current; if (view) report(view, false); }}>以源码继续编辑</button>
        </div> : null}
      </div> : null}
    </div>
  </PreviewHandoff.Provider>;
}
