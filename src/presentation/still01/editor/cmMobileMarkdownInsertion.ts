import {isTableCellComposing} from "./tableFocus.ts";
import type { EditorView } from "@codemirror/view";
import { mobileMarkdownInsertionTransactions, type MobileMarkdownInsertion } from "./mobileMarkdownInsertions.ts";

/** Explicit More-sheet action on this live editor only. Opening a sheet does
 * not grant a dormant title/inactive note's retained editor edit authority. */
export function runMobileMarkdownInsertion(view: EditorView, insertion: MobileMarkdownInsertion): boolean {
  if (view.composing || view.compositionStarted || isTableCellComposing(view) || !view.dom.isConnected) return false;
  if (view.dom.closest('.st-detail-stage')?.getAttribute('data-current') === 'false') return false;
  const active = view.dom.ownerDocument.activeElement;
  if (active?.closest('.st-note-title')) return false;
  const tableCellFocused = active?.matches?.('textarea.cm-lp-table-input') && view.dom.contains(active);
  if (tableCellFocused && active?.getAttribute('data-composing') === 'true') return false;
  const actionFocused = active?.closest('.st-sheet, .st-editor-tools');
  if (!view.hasFocus && !actionFocused && !tableCellFocused) return false;
  const transactions = mobileMarkdownInsertionTransactions(view.state, insertion);
  if (!transactions) return false;
  view.dispatch(transactions);
  if (!view.hasFocus) view.focus();
  return true;
}
