import {isTableCellComposing,runTableHistory} from "./tableFocus.ts";
import type { EditorView } from "@codemirror/view";
import { undo, redo } from "@codemirror/commands";
import { mobileMarkdownCommandTransaction } from "./mobileMarkdownCommands.ts";
export type EditorCommand = "undo" | "redo" | "wiki" | "heading" | "bold" | "italic" | "strike" | "highlight" | "code" | "quote" | "link" | "bullet" | "number" | "task" | "indent" | "outdent";
export const editorCommands: ReadonlyArray<{ command: EditorCommand; label: string; glyph: string }> = [
  { command: "undo", label: "撤销", glyph: "↶" }, { command: "redo", label: "重做", glyph: "↷" },
  { command: "wiki", label: "插入内部链接", glyph: "[[ ]]" },
  { command: "heading", label: "小标题", glyph: "H" }, { command: "bold", label: "加粗", glyph: "B" },
  { command: "italic", label: "斜体", glyph: "I" }, { command: "strike", label: "删除线", glyph: "S̶" },
  { command: "highlight", label: "高亮", glyph: "==" }, { command: "code", label: "代码", glyph: "</>" },
  { command: "quote", label: "引用", glyph: "❞" }, { command: "link", label: "网页链接", glyph: "↗" },
  { command: "bullet", label: "无序列表", glyph: "• ≡" }, { command: "number", label: "有序列表", glyph: "1. ≡" },
  { command: "task", label: "待办事项", glyph: "☑" }, { command: "indent", label: "增加缩进", glyph: "⇥" },
  { command: "outdent", label: "减少缩进", glyph: "⇤" },
];
/** Live CM selection/history only. Never end composition or focus a title's
 * dormant body editor. Every document change follows the existing save path. */
export function runEditorCommand(view: EditorView, command: EditorCommand): boolean {
  if (view.composing || view.compositionStarted || isTableCellComposing(view)) return false;
  const active = view.dom?.ownerDocument.activeElement;
  const tableCellFocused = active?.matches?.('textarea.cm-lp-table-input') && view.dom?.contains(active);
  if (tableCellFocused && active?.getAttribute('data-composing') === 'true') return false;
  const toolbarFocused = active?.closest('.st-editor-tools') && view.dom?.closest('.st-note-surface')?.contains(active);
  if (!view.hasFocus && !toolbarFocused && !tableCellFocused) return false;
  if (command === "undo" || command === "redo") {
    const handled = runTableHistory(view, command === "redo");
    if (handled !== null) return handled;
  }
  if (!view.hasFocus) view.focus();
  if (command === "undo" || command === "redo") return (command === "undo" ? undo : redo)(view);
  const transaction = mobileMarkdownCommandTransaction(view.state, command);
  if (!transaction || !transaction.docChanged) return false;
  view.dispatch(transaction);
  return true;
}
