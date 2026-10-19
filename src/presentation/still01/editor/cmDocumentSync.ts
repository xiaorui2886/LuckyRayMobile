// CM6-EDITOR-R1 — the shared document-sync diff (Mobile port).
//
// The same single-interval prefix/suffix algorithm the Desktop
// LiveMarkdownEditor uses privately (documentSyncChange): a saved external
// edit arrives as the SMALLEST replace-range transaction, so unchanged text
// positions, marks, selection and undo history survive; a save/index echo
// (identical text) produces no transaction at all. It is NOT a multi-range
// merge or CRDT and never claims to preserve arbitrary edit anchors.

import { Annotation, type Transaction } from "@codemirror/state";

/**
 * Marks a transaction as an EXTERNAL body application (never a user edit).
 * The adapter's update listener sees it and does NOT call onChange — the
 * save chain can never echo an external/hydration value back as user input.
 */
export const authoritativeSync = Annotation.define<boolean>();

/** True when a transaction set contains an external application. */
export function isAuthoritativeTransactionSet(transactions: readonly Transaction[]): boolean {
  return transactions.some((tr) => tr.annotation(authoritativeSync) === true);
}

export type DocumentSyncChange = { from: number; to: number; insert: string };

export function documentSyncChange(current: string, next: string): DocumentSyncChange {
  let from = 0;
  while (from < current.length && from < next.length && current[from] === next[from]) from++;
  let to = current.length, nextTo = next.length;
  while (to > from && nextTo > from && current[to - 1] === next[nextTo - 1]) { to--; nextTo--; }
  return { from, to, insert: next.slice(from, nextTo) };
}

/** True when the only difference is nothing at all (an echo). */
export function isDocumentEcho(current: string, next: string): boolean {
  return current === next;
}
