// CM6-EDITOR-R1 — the retained editor session pool (Mobile port).
//
// NoteSurface unmounts the edit branch on every read↔edit switch; a fresh
// CM EditorState per switch would lose the undo history, selection and
// scroll of the in-progress edit session. This pool keeps DETACHED
// EditorViews alive per scope — the Desktop RetainedEditorViews idea, sized
// for the MI8: at most `MAX_RETAINED` views survive (LRU), and a scope that
// is explicitly forgotten (note switch / source switch / instance switch in
// StillNote) is destroyed immediately. Views are keyed by the FULL scope
// (sourceKind + instance/vault/note), so a local note, Desktop A's note and
// Desktop B's same-id note can never share an editor.
//
// The pool owns NO save logic: the existing LocalNoteAutosaveCoordinator /
// StillNote edit pipeline remain the single save authority.

import type { EditorView } from "@codemirror/view";
import { captureReadingAnchor, readingSourceOffset, type NoteReadingAnchor } from "./noteReadingPosition.ts";

/** Retained detached views — bounded, LRU-trimmed. */
const MAX_RETAINED = 2;

type PoolEntry = {
  view: EditorView;
  lastUsed: number;
  scroll?: { effect: ReturnType<EditorView["scrollSnapshot"]>; top: number; left: number };
  readingAnchor?: NoteReadingAnchor;
};

const entries = new Map<string, PoolEntry>();

/** Attach (or create) the retained view for the exact scope. */
export function acquireCmView(scope: string, create: () => EditorView): EditorView {
  const existing = entries.get(scope);
  if (existing) {
    existing.lastUsed = ++monotonic;
    return existing.view;
  }
  const view = create();
  entries.set(scope, { view, lastUsed: ++monotonic });
  trim();
  return view;
}

/** Detach without destroying — the view keeps its state for a later mount. */
export function detachCmView(scope: string): void {
  const entry = entries.get(scope);
  if (!entry) return;
  const { scrollDOM } = entry.view;
  entry.readingAnchor = captureReadingAnchor(entry.view);
  entry.scroll = scrollDOM.scrollTop || scrollDOM.scrollLeft
    ? { effect: entry.view.scrollSnapshot(), top: scrollDOM.scrollTop, left: scrollDOM.scrollLeft }
    : undefined;
  if (entry.view.dom.parentNode) {
    entry.view.dom.parentNode.removeChild(entry.view.dom);
  }
}

/** One edit→read handoff, only for the same owner's exact current document. */
export function takeCmReadingAnchor(scope: string, body: string): NoteReadingAnchor | undefined {
  const entry = entries.get(scope);
  if (!entry) return;
  const anchor = entry.readingAnchor;
  entry.readingAnchor = undefined;
  if (!anchor) return;
  const offset = readingSourceOffset(entry.view.state.doc.toString(), body, anchor.offset);
  return offset === undefined ? undefined : { ...anchor, offset };
}

/** Restore after attachment, before authoritative transactions/first paint. */
export function restoreCmViewScroll(scope: string): void {
  const entry = entries.get(scope);
  const snapshot = entry?.scroll;
  if (!entry || !snapshot) return;
  entry.scroll = undefined;
  entry.view.scrollDOM.scrollTop = snapshot.top;
  entry.view.scrollDOM.scrollLeft = snapshot.left;
  entry.view.dispatch({ effects: snapshot.effect });
}

/** Destroy the view for a scope the page has LEFT for good (note switch). */
export function forgetCmView(scope: string): void {
  const entry = entries.get(scope);
  if (!entry) return;
  entries.delete(scope);
  try { entry.view.destroy(); } catch { /* a destroyed view is already gone */ }
}

/** The retained view for a scope, if any (no acquire side effects). */
export function peekCmView(scope: string): EditorView | null {
  return entries.get(scope)?.view ?? null;
}

/** True while the scope's view is alive in the pool. */
export function hasCmView(scope: string): boolean {
  return entries.has(scope);
}

/** Test/diagnostic: the number of retained views. */
export function retainedCmViewCount(): number {
  return entries.size;
}

/** Destroy every retained view (app teardown / tests). */
export function destroyAllCmViews(): void {
  for (const entry of entries.values()) {
    try { entry.view.destroy(); } catch { /* already destroyed */ }
  }
  entries.clear();
}

let monotonic = 0;

function trim(): void {
  if (entries.size <= MAX_RETAINED) return;
  // LRU — but a MOUNTED view (its DOM is still attached to a document) is
  // NEVER evicted: destroying a live editor out from under its host would
  // blank the page. Only DETACHED entries (read↔edit switches left them
  // parked) may be dropped; if every entry is mounted the pool temporarily
  // exceeds the bound (production mounts at most one editor at a time).
  const ordered = [...entries.entries()]
    .filter(([, entry]) => !entry.view.dom.isConnected)
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  let excess = entries.size - MAX_RETAINED;
  for (const [scope, entry] of ordered) {
    if (excess <= 0) break;
    entries.delete(scope);
    try { entry.view.destroy(); } catch { /* already destroyed */ }
    excess -= 1;
  }
}
