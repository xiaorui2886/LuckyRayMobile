import type { EditorView } from "@codemirror/view";
import { undo, redo } from "@codemirror/commands";
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
  if (view.composing || view.compositionStarted) return false;
  const active = view.dom?.ownerDocument.activeElement;
  const toolbarFocused = active?.closest('.st-editor-tools') && view.dom?.closest('.st-note-surface')?.contains(active);
  if (!view.hasFocus && !toolbarFocused) return false;
  if (!view.hasFocus) view.focus();
  if (command === "undo" || command === "redo") return (command === "undo" ? undo : redo)(view);
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  const pairs: Partial<Record<EditorCommand, [string, string]>> = {
    wiki: ["[[", "]]"], bold: ["**", "**"], italic: ["*", "*"], strike: ["~~", "~~"],
    highlight: ["==", "=="], code: ["`", "`"], link: ["[", "](https://)"],
  };
  const pair = pairs[command];
  if (pair) {
    view.dispatch({ changes: { from, to, insert: pair[0] + selected + pair[1] },
      selection: { anchor: from + pair[0].length, head: to + pair[0].length }, scrollIntoView: true });
    return true;
  }
  const prefixes: Partial<Record<EditorCommand, string>> = { heading: "## ", quote: "> ", bullet: "- ", number: "1. ", task: "- [ ] ", indent: "  " };
  const start = view.state.doc.lineAt(from).from;
  const endLine = view.state.doc.lineAt(to > from && view.state.doc.lineAt(to).from === to ? to - 1 : to);
  const changes = [];
  for (let pos = start; pos <= endLine.from;) {
    const line = view.state.doc.lineAt(pos);
    if (command === "outdent") {
      const count = /^ {1,2}|^\t/.exec(line.text)?.[0].length ?? 0;
      if (count) changes.push({ from: pos, to: pos + count, insert: "" });
    } else changes.push({ from: pos, insert: prefixes[command] ?? "" });
    pos = line.to + 1;
  }
  const changeSet = view.state.changes(changes);
  view.dispatch({ changes: changeSet, selection: view.state.selection.map(changeSet), scrollIntoView: true });
  return true;
}
