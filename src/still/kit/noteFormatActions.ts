import type { EditorCommand } from '../../presentation/still01/editor/editorCommands';
import type { MobileMarkdownInsertion } from '../../presentation/still01/editor/mobileMarkdownInsertions';
export type NoteFormatAction = { label: string; command?: EditorCommand; insertion?: MobileMarkdownInsertion; icon: string };
/** More owns infrequent block insertions; existing toolbar preferences stay unchanged. */
export const noteFormatActions: readonly NoteFormatAction[] = [
  { label: '小标题', command: 'heading', icon: 'heading' },
  { label: '无序列表', command: 'bullet', icon: 'bullet' },
  { label: '待办事项', command: 'task', icon: 'task' },
  { label: '引用', command: 'quote', icon: 'quote' },
  { label: '链接', command: 'link', icon: 'link' },
  { label: '代码块', insertion: 'code-block', icon: 'code' },
  { label: '表格', insertion: 'table', icon: 'file' },
  { label: '分隔线', insertion: 'separator', icon: 'minus' },
];
export type NoteFormatSnapshot = { body: string; selection: {start: number; end: number} };
type FormatHandle = {
  getValue(): string; isComposing(): boolean; compositionStarted(): boolean;
  getSelection(): {start:number;end:number}; focus(): void;
  runCommand(command: EditorCommand): boolean; insert(insertion: MobileMarkdownInsertion): boolean;
};
export function applyNoteFormatAction(handle: FormatHandle | null, snapshot: NoteFormatSnapshot | null, action: NoteFormatAction): boolean {
  if (!handle || !snapshot || handle.isComposing() || handle.compositionStarted() || handle.getValue() !== snapshot.body) return false;
  const {start,end} = snapshot.selection;
  if (![start,end].every(Number.isSafeInteger) || start < 0 || end < start || end > snapshot.body.length) return false;
  if (!action.command && !action.insertion) return false;
  const current = handle.getSelection();
  if (current.start !== start || current.end !== end) return false;
  // Keep the retained selection itself, including its anchor direction.
  handle.focus();
  return action.insertion ? handle.insert(action.insertion) : handle.runCommand(action.command!);
}
