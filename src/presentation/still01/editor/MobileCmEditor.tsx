import {isTableCellComposing,tableStructureHistory} from './tableFocus.ts';
import { usePreviewHandoff } from './NoteBodyTransition';
import { cmLivePreview, refreshLivePreview, type PreviewLinkStatus } from './cmLivePreview';
import type { WikiReference } from '../../../still/kit/knowledgeRelations';
import './cmLivePreview.css';
import { cmCaretVisibility, noteScrollNavigation } from './cmCaretVisibility';
import type { MobileMarkdownInsertion } from './mobileMarkdownInsertions';
import { runMobileMarkdownInsertion } from './cmMobileMarkdownInsertion';
import { cmMobileMarkdownInput } from './cmMobileMarkdownInput';
import { NoteActionIcon } from "./NoteActionIcon";
// CM6-EDITOR-R1 — the Mobile CM6 body editor adapter.
//
// Replaces ONLY the body textarea of the Still NoteSurface in edit mode.
// The page shell, title input, toolbar, reading view, save pipeline
// (LocalNoteAutosaveCoordinator / StillNote edit+ACK) and sync chain are
// untouched. Contracts (from the E426 assessment §4):
//
//   1. Single save authority — ONLY real user doc transactions call
//      onChange; external/hydration applications (authoritativeSync) never
//      echo into the save chain, and an identical value is a no-op.
//   2. Local minimal diff — external values apply through documentSyncChange
//      with addToHistory(false): unchanged positions, selection, marks and
//      the user's undo history survive; the state is never rebuilt whole.
//   3. Owner scope — the view is retained per FULL scope key; switching
//      note/source/instance forgets the old view (the page drives that).
//   4. IME/composition truth — composition/focus state is read from the REAL
//      contentDOM at call time; nothing forces composition to end.
//
// The host element carries the ORIGINAL `.st-note-editor` class, so every
// existing page-level predicate (focus checks, composition listeners) keeps
// working via closest(); the imperative handle covers the textarea-style
// operations the page used through DOM queries.

import { mergeWikiChoices, wikiResourceChoices } from "./wikiCompletion";
import { cmWikiCompletion, type WikiLoader } from "./cmWikiCompletion";
import { cmInlineImages, type EditorImageScope } from "./cmInlineImages";
import { runEditorCommand, type EditorCommand } from "./editorCommands";
import React, { useLayoutEffect, useRef, useState } from "react";
import { Compartment, EditorState, Transaction, type Extension } from "@codemirror/state";
import { EditorView, keymap, placeholder as cmPlaceholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { documentSyncChange, authoritativeSync, isAuthoritativeTransactionSet } from "./cmDocumentSync";
import { noteSearchField, setNoteSearch } from "./cmNoteSearch";
import { bodyMatchRanges, type NoteSearchTarget } from "../../../still/kit/noteSearch";
import { acquireCmView, detachCmView, restoreCmViewScroll } from "./cmEditorSessions";
import { consumeBodyFocusRequest, editorOffsetAtSource, type NoteBodyFocusRequest } from "./noteTapEditing";

export { authoritativeSync, isAuthoritativeTransactionSet } from "./cmDocumentSync";

// The compartment belongs to each retained state, not to the React mount
// that originally created it. Rebind to the current owner on EVERY acquire.
const changeListener = new Compartment();
const assistFeatures = new Compartment();
const imageFeatures = new Compartment();
const previewFeatures = new Compartment();
const appliedSearchTargets = new WeakMap<EditorView, NoteSearchTarget | undefined>();
const revealedSearchTargets = new WeakMap<EditorView, NoteSearchTarget>();

export type CmEditorSelection = { start: number; end: number };

export type CmEditorHandle = {
  /** The view's CURRENT doc — the page never edits from a stale snapshot. */
  getValue(): string;
  runCommand(command: EditorCommand): boolean;
  insert(insertion: MobileMarkdownInsertion): boolean;
  getSelection(): CmEditorSelection;
  setSelection(sel: CmEditorSelection): void;
  /** A user-level replace (enters history, triggers onChange exactly once). */
  replaceRange(text: string, range?: CmEditorSelection): void;
  focus(): void;
  hasFocus(): boolean;
  /** The REAL composing state of the contentDOM right now. */
  isComposing(): boolean;
  /** True once an IME composition session started (may outlast composing). */
  compositionStarted(): boolean;
  /** The scroller's current scrollTop (scroll snapshot). */
  scrollTop(): number;
  scrollTo(top: number): void;
  /** Navigate without replacing the retained editor, selection or undo history. */
  scrollToSource(offset: number): void;
};

export type MobileCmEditorProps = {
  /** FULL owner scope: sourceKind + instance/vault/note (the retention key). */
  scope: string;
  registerOverlay?: (dismiss:()=>void)=>()=>void;
  wikiLoader?: WikiLoader;
  onWikiLink?: (reference: WikiReference) => void;
  linkStatus?: (reference: WikiReference) => PreviewLinkStatus;
  imageScope?: EditorImageScope;
  assistActive?: boolean;
  sourceMode?: boolean;
  /** The externally-owned body value (external applications only). */
  value: string;
  /** Fires ONLY on real user doc transactions. */
  onChange: (next: string) => void;
  placeholderText?: string;
  ariaLabel?: string;
  /** Only a deliberate body tap may move the caret/focus. Never route entry. */
  focusRequest?: NoteBodyFocusRequest;
  /** The page's owner-scoped handle slot (cleared on unmount). */
  handleRef?: React.MutableRefObject<CmEditorHandle | null>;
  search?: NoteSearchTarget;
  searchActive?: boolean;
  onDismissSearch?: () => void;
};

// A title is portalled into the retained editor scroll viewport. Do not
// reconfigure/hydrate that host while its input owns focus or IME: hiding the
// pending body would otherwise also hide the live title. Keep only the latest
// effect and resume at the real blur boundary, without a timer or forced blur.
function afterTitleEditing(view: EditorView, apply: () => void): () => void {
  let retired = false;
  const active = document.activeElement;
  const title = active instanceof HTMLElement && active.closest('.st-note-heading') && view.dom.contains(active) ? active : null;
  const resume = () => queueMicrotask(() => { if (!retired && view.dom.isConnected) apply(); });
  if (title) title.addEventListener('blur', resume, { once: true });
  else apply();
  return () => { retired = true; title?.removeEventListener('blur', resume); };
}

export function MobileCmEditor({
  scope, registerOverlay, wikiLoader, onWikiLink, linkStatus, imageScope, sourceMode = false, assistActive = true, value, onChange, placeholderText = "", ariaLabel = "笔记正文", focusRequest, handleRef, search, searchActive = true, onDismissSearch,
}: MobileCmEditorProps) {
  const handoff = usePreviewHandoff();
  const handoffRef = useRef(handoff?.settle); handoffRef.current = handoff?.settle;
  const handoffWaiting = handoff?.waiting ?? false;
  const invalidateHandoff = useRef(handoff?.invalidate); invalidateHandoff.current = handoff?.invalidate;
  const pendingBodyIntent = useRef<NoteBodyFocusRequest | null>(null);
  const handoffSearch = useRef(search); handoffSearch.current = search;
  const assistRef = useRef({ wikiLoader, assistActive, imageScope, onWikiLink, linkStatus, registerOverlay });
  assistRef.current = { wikiLoader, assistActive, imageScope, onWikiLink, linkStatus, registerOverlay };
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // onChange is read through a ref so the view is created ONCE per scope —
  // a re-render mid-gesture must never swap the listener identity.
  const onChangeRef = useRef(onChange);
  useLayoutEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  const placeholderRef = useRef(placeholderText);
  const [findStatus, setFindStatus] = useState({ index: 0, count: 0 });
  const pendingFind = useRef<(() => void) | null>(null);
  const searchActiveRef = useRef(searchActive);
  searchActiveRef.current = searchActive;
  const revealMatch = (view: EditorView) => {
    if (viewRef.current !== view || !searchActiveRef.current) return;
    const reveal = () => {
      const match = view.state.field(noteSearchField).ranges[view.state.field(noteSearchField).index];
      if (match) view.dispatch({ effects: [noteScrollNavigation.of(null), EditorView.scrollIntoView(match.from, { y: "center" })] });
    };
    if (view.composing || view.compositionStarted || isTableCellComposing(view)) pendingFind.current = reveal;
    else reveal();
  };
  const nextMatch = (direction: number) => {
    const view = viewRef.current;
    if (!view || !searchActiveRef.current) return;
    const change = () => {
      const state = view.state.field(noteSearchField);
      if (!state.ranges.length) return;
      view.dispatch({ effects: setNoteSearch.of({ query: state.query,
        index: (state.index + direction + state.ranges.length) % state.ranges.length }) });
      revealMatch(view);
    };
    // Do not dispatch or move selection during an IME composition. The
    // final composition input settles before the deferred navigation runs.
    if (view.composing || view.compositionStarted || isTableCellComposing(view)) pendingFind.current = change;
    else change();
  };

  // Acquire before the value layout effect below: a retained view must never
  // paint its old body under a revision already adopted by StillNote.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const extensions: Extension[] = [
      history(),
      tableStructureHistory,
      cmCaretVisibility,
      noteSearchField,
      cmMobileMarkdownInput,
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.lineWrapping,
      cmPlaceholder(placeholderRef.current),
      changeListener.of([]),
      assistFeatures.of([]), imageFeatures.of([]), previewFeatures.of([]),
    ];
    const view = acquireCmView(scope, () => new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent: host,
    }));
    viewRef.current = view;
    view.dispatch({ effects: changeListener.reconfigure(EditorView.updateListener.of((update) => {
      if (viewRef.current !== update.view) return;
      const found = update.state.field(noteSearchField);
      setFindStatus(previous => previous.index === found.index && previous.count === found.ranges.length
        ? previous : { index: found.index, count: found.ranges.length });
      if (isAuthoritativeTransactionSet(update.transactions)) return; // no save echo
      if (update.docChanged) onChangeRef.current(update.state.doc.toString());
    })) });
    if (view.dom.parentNode !== host) {
      host.appendChild(view.dom);
    }
    restoreCmViewScroll(scope);
    // The outer editor also owns the title and embedded table controls. A
    // second textbox role flattens those descendants in Android accessibility.
    // CM's actual contentDOM remains the labelled, multiline textbox.
    view.dom.setAttribute("role", "group");
    view.dom.removeAttribute("aria-multiline");
    view.dom.setAttribute("aria-label", ariaLabel);
    view.contentDOM.setAttribute("aria-label", ariaLabel);
    const handle = createHandle(view);
    if (handleRef) handleRef.current = handle;
    // The page-level DOM helpers (pageEditorHandle) read it off the host.
    (host as HTMLDivElement & { __cmHandle?: CmEditorHandle }).__cmHandle = handle;
    let compositionFrame = 0;
    const settleFind = () => {
      compositionFrame = requestAnimationFrame(() => {
        if (viewRef.current !== view || !searchActiveRef.current) { pendingFind.current = null; return; }
        if (view.composing || view.compositionStarted || isTableCellComposing(view)) { settleFind(); return; }
        const action = pendingFind.current; pendingFind.current = null; action?.();
      });
    };
    view.contentDOM.addEventListener("compositionend", settleFind);
    return () => {
      cancelAnimationFrame(compositionFrame);
      pendingFind.current = null;
      view.contentDOM.removeEventListener("compositionend", settleFind);
      view.dispatch({effects:[assistFeatures.reconfigure([]), imageFeatures.reconfigure([]), previewFeatures.reconfigure([])]});
      teardown(scope, view, viewRef, handleRef);
    };
    // The view is created once per scope; value/placeholder flow through the
    // layout effect below, never through re-creation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  const imageKey = JSON.stringify(imageScope || null);
  const readiness = useRef<{ preview?: EditorState['doc']; images?: EditorState['doc'] }>({});
  useLayoutEffect(() => { readiness.current = {}; }, [scope, imageKey, sourceMode]);
  const reportReady = (view: EditorView, kind: 'preview' | 'images', available = true) => {
    if (viewRef.current !== view) return;
    if (!available) { handoffRef.current?.(view, !handoffSearch.current?.query, false); return; }
    readiness.current[kind] = view.state.doc;
    if (readiness.current.preview === view.state.doc && (!assistRef.current.imageScope || readiness.current.images === view.state.doc))
      handoffRef.current?.(view, !handoffSearch.current?.query);
  };
  useLayoutEffect(() => {
    const view = viewRef.current; if (!view) return;
    let frame = 0, retired = false;
    const configure = () => {
      if (retired || viewRef.current !== view) return;
      if (view.composing || view.compositionStarted || isTableCellComposing(view)) { frame = requestAnimationFrame(configure); return; }
      const extensions: Extension[] = [];
      if (assistActive && wikiLoader) extensions.push(cmWikiCompletion(async (q,embed) => {
        const attachments=wikiResourceChoices(assistRef.current.imageScope?.resources||[],q);
        if(embed)return {items:attachments.slice(0,12),partial:attachments.length>12};
        let notes;
        try { notes=await assistRef.current.wikiLoader!(q); }
        catch(error) { if(attachments.length)return {items:attachments.slice(0,12),partial:true}; throw error; }
        return {items:mergeWikiChoices(notes.items,attachments),partial:notes.partial||notes.items.length+attachments.length>12};
      }, () => assistRef.current.assistActive));
      view.dispatch({effects:assistFeatures.reconfigure(extensions)});
    };
    const stopWaiting = afterTitleEditing(view, configure);
    return () => { retired = true; stopWaiting(); cancelAnimationFrame(frame); };
  }, [scope, assistActive, Boolean(wikiLoader), imageKey]);
  // Opening a menu only suspends suggestions. Existing image geometry stays
  // mounted; source mode alone removes its rendered decorations.
  useLayoutEffect(() => {
    const view = viewRef.current; if (!view) return;
    let frame = 0, retired = false;
    const configure = () => {
      if (retired || viewRef.current !== view) return;
      if (view.composing || view.compositionStarted || isTableCellComposing(view)) { frame = requestAnimationFrame(configure); return; }
      view.dispatch({effects:imageFeatures.reconfigure(imageScope && !sourceMode ? cmInlineImages(imageScope,view.hasFocus,(editor, available) => { if (!retired) reportReady(editor, 'images', available); }) : [])});
    };
    const stopWaiting = afterTitleEditing(view, configure);
    return () => { retired = true; stopWaiting(); cancelAnimationFrame(frame); };
  }, [scope, imageKey, sourceMode]);

  // Display-only ordinary editing. All source/history/save authority remains
  // with the retained CodeMirror document; menu state only gates actions.
  useLayoutEffect(() => {
    const view = viewRef.current; if (!view) return;
    let frame = 0, retired = false;
    const configure = () => {
      if (retired || viewRef.current !== view) return;
      if (view.composing || view.compositionStarted || isTableCellComposing(view)) { frame = requestAnimationFrame(configure); return; }
      invalidateHandoff.current?.();
      view.dispatch({ effects: previewFeatures.reconfigure(sourceMode ? [] : cmLivePreview({
        onSettled: (editor, available) => { if (!retired) reportReady(editor, 'preview', available); },
        enabled: () => viewRef.current === view && assistRef.current.assistActive,
        registerOverlay: dismiss => assistRef.current.registerOverlay?.(dismiss) || (()=>{}),
        onWikiLink: reference => assistRef.current.onWikiLink?.(reference),
        linkStatus: reference => assistRef.current.linkStatus?.(reference) || 'unknown',
        imageScope,
      }, view.hasFocus)) });
      if (sourceMode) queueMicrotask(() => { if (!retired && viewRef.current === view) handoffRef.current?.(view, !handoffSearch.current?.query); });
    };
    const stopWaiting = afterTitleEditing(view, configure);
    return () => { retired = true; stopWaiting(); cancelAnimationFrame(frame); };
  }, [scope, imageKey, sourceMode]);

  // Link availability changes presentation, not the Markdown parse. Keep the
  // ready AST/decorations instead of briefly recreating a raw long document.
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (view) view.dispatch({ effects: refreshLivePreview.of(null) });
  }, [scope, linkStatus]);

  // External value application: the SMALLEST diff, no history entry, no echo.
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    return afterTitleEditing(view, () => {
      const current = view.state.doc.toString();
      // CM normalizes line endings when constructing its document. Compare and
      // diff in that same coordinate space; diffing LF against CRLF can create
      // an extra trailing newline during an otherwise identical hydration.
      const normalizedValue = value.replace(/\r\n?/g, "\n");
      if (normalizedValue === current) return; // echo: no transaction at all
      // Authoritative late hydration/replacement is another first frame. Never
      // reveal the new raw document while its matching decorations are pending.
      if (!sourceMode) invalidateHandoff.current?.();
      view.dispatch({
        changes: documentSyncChange(current, normalizedValue),
        annotations: [authoritativeSync.of(true), Transaction.addToHistory.of(false)],
      });
    });
  }, [value, scope, sourceMode]);

  // Selection-only input entry: no document transaction, history reset or
  // save. Run synchronously in the gesture's commit so mobile keyboards can
  // open. Reattachment/refresh cannot replay a consumed request.
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view || !searchActive || !focusRequest || focusRequest.scope !== scope) return;
    if (pendingBodyIntent.current !== focusRequest) {
      if (!consumeBodyFocusRequest(focusRequest, scope)) return;
      pendingBodyIntent.current = focusRequest;
    }
    if (view.composing || view.compositionStarted || isTableCellComposing(view)) return;
    // A validated, deliberate body gesture takes ownership immediately. Do not
    // keep an invisible focused editor behind the retained reader.
    if (handoffWaiting) { handoffRef.current?.(view, false); return; }
    pendingBodyIntent.current = null;
    const offset = editorOffsetAtSource(value, focusRequest.offset);
    view.focus();
    view.dispatch({ selection: { anchor: Math.min(view.state.doc.length, offset) },
      scrollIntoView: true, annotations: Transaction.addToHistory.of(false) });
  }, [scope, focusRequest, searchActive, handoffWaiting]);

  // A new route's query is applied once. Returning to the same retained
  // editor keeps its active match and scroll; fresh body hydration can still
  // establish the first match without changing the document or selection.
  const requestedSearch = useRef(search);
  requestedSearch.current = search;
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const query = search?.query.trim() || "";
    if (!appliedSearchTargets.has(view) || appliedSearchTargets.get(view) !== search) {
      pendingFind.current = null;
      const apply = () => {
        if (viewRef.current !== view || requestedSearch.current !== search) return;
        const ranges = bodyMatchRanges(view.state.doc.toString(), query);
        const rangeIndex = search?.bodyRange
          ? ranges.findIndex(range => range.from === search.bodyRange?.from && range.to === search.bodyRange?.to) : 0;
        view.dispatch({ effects: setNoteSearch.of({ query, index: Math.max(0, rangeIndex) }) });
        appliedSearchTargets.set(view, search);
        revealedSearchTargets.delete(view);
        if (query && ranges.length && search && searchActiveRef.current) {
          revealedSearchTargets.set(view, search); revealMatch(view);
        }
      };
      if (view.composing || view.compositionStarted || isTableCellComposing(view)) pendingFind.current = apply;
      else apply();
    }
  }, [scope, search, searchActive]);
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view || !searchActive || !search?.query) return;
    if (appliedSearchTargets.get(view) === search && revealedSearchTargets.get(view) !== search && view.state.field(noteSearchField).ranges.length) {
      revealedSearchTargets.set(view, search);
      revealMatch(view);
    }
  }, [scope, value, search, searchActive]);
  useLayoutEffect(() => { if (!searchActive) pendingFind.current = null; }, [searchActive]);

  return <>
    {search?.query ? <div className="st-note-find" role="group" aria-label="正文查找">
      <span className="st-note-find-query">{search.query}</span>
      <span className="st-note-find-count">{findStatus.count ? `${findStatus.index + 1} / ${findStatus.count}` : "正文无匹配"}</span>
      <button type="button" aria-label="上一处匹配" disabled={!findStatus.count} onPointerDown={event => event.preventDefault()} onClick={() => nextMatch(-1)}><NoteActionIcon name="up" size={18}/></button>
      <button type="button" aria-label="下一处匹配" disabled={!findStatus.count} onPointerDown={event => event.preventDefault()} onClick={() => nextMatch(1)}><NoteActionIcon name="down" size={18}/></button>
      <button type="button" aria-label="关闭正文查找" onPointerDown={event => event.preventDefault()} onClick={onDismissSearch}><NoteActionIcon name="close" size={18}/></button>
    </div> : null}
    <div ref={hostRef} className="st-note-editor is-cm" />
  </>;
}

function teardown(
  scope: string,
  view: EditorView,
  viewRef: React.RefObject<EditorView | null>,
  handleRef: React.MutableRefObject<CmEditorHandle | null> | undefined,
): void {
  // Detach (NOT destroy): the retained session survives read↔edit switches.
  detachCmView(scope);
  if (viewRef.current === view) viewRef.current = null;
  if (handleRef && handleRef.current) handleRef.current = null;
}

function createHandle(view: EditorView): CmEditorHandle {
  const clamp = (n: number): number => Math.max(0, Math.min(n, view.state.doc.length));
  return {
    getValue: () => view.state.doc.toString(),
    runCommand: command => runEditorCommand(view, command),
    insert: insertion => runMobileMarkdownInsertion(view, insertion),
    getSelection: () => {
      const sel = view.state.selection.main;
      return { start: clamp(Math.min(sel.from, sel.to)), end: clamp(Math.max(sel.from, sel.to)) };
    },
    setSelection: (sel) => {
      const start = clamp(Math.min(sel.start, sel.end));
      const end = clamp(Math.max(sel.start, sel.end));
      view.dispatch({ selection: { anchor: start, head: end } });
    },
    replaceRange: (text, range) => {
      // Preedit can start before the first document change. Neither a format
      // command nor its caller may mutate or force that IME session to end.
      if (view.composing || view.compositionStarted || isTableCellComposing(view)) return;
      const sel = view.state.selection.main;
      const from = range ? clamp(Math.min(range.start, range.end)) : clamp(Math.min(sel.from, sel.to));
      const to = range ? clamp(Math.max(range.start, range.end)) : clamp(Math.max(sel.from, sel.to));
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
        // A format/attachment insertion IS a user action: it enters history
        // and triggers the normal onChange → save chain exactly once.
        scrollIntoView: true,
      });
    },
    focus: () => { view.focus(); },
    hasFocus: () => view.hasFocus || Boolean(view.dom.ownerDocument.activeElement?.matches?.('.cm-lp-table-input') && view.dom.contains(view.dom.ownerDocument.activeElement)),
    isComposing: () => Boolean(view.composing || isTableCellComposing(view)),
    compositionStarted: () => Boolean(view.compositionStarted || isTableCellComposing(view)),
    scrollTop: () => view.scrollDOM ? view.scrollDOM.scrollTop : 0,
    scrollTo: (top) => { view.dispatch({effects:noteScrollNavigation.of(null)}); if (view.scrollDOM) view.scrollDOM.scrollTop = top; },
    scrollToSource: (offset) => {
      if (!Number.isFinite(offset)) return;
      view.dispatch({ effects: [noteScrollNavigation.of(null), EditorView.scrollIntoView(clamp(Math.trunc(offset)), { y: "start", yMargin: 12 })] });
    },
  };
}
