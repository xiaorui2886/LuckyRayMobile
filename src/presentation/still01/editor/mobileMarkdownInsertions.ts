import { EditorSelection, type EditorState, type Transaction } from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';

/** More-menu insertions are deliberately separate from customizable toolbar commands. */
export type MobileMarkdownInsertion = 'code-block' | 'table' | 'separator';

// Conservative fence protection, including quote/list containers and unfinished
// fences. Never wrap an existing fence or insert a table/rule inside literal code.
function touchesFence(state: EditorState, from: number, to: number): boolean {
  const first = state.doc.lineAt(from).number;
  const last = state.doc.lineAt(to > from && state.doc.lineAt(to).from === to ? to - 1 : to).number;
  let fence = '';
  for (let n = 1; n <= last; n++) {
    const text = state.doc.line(n).text.replace(/^\s*(?:>\s*)*(?:(?:[-+*]|\d+[.)])\s+)?/, '');
    const match = /^(`{3,}|~{3,})(.*)$/.exec(text);
    const inFence = !!fence;
    if (match && !fence) fence = match[1];
    else if (match && match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) fence = '';
    if (n >= first && (inFence || !!match)) return true;
  }
  return false;
}

function leadingGap(before: string): string {
  if (!before) return '';
  return '\n'.repeat(Math.max(0, 2 - (/\n*$/.exec(before)?.[0].length ?? 0)));
}
function trailingGap(after: string): string {
  if (!after) return '';
  return '\n'.repeat(Math.max(0, 2 - (/^\n*/.exec(after)?.[0].length ?? 0)));
}

/** A single isolated CM transaction: retains document/history and preserves text.
 * Code wraps the selection. Table/rule insert AFTER the last selected line,
 * leaving selected prose unchanged rather than guessing a lossy conversion.
 * Repeating code insertion inside its fence is a no-op, not nested fences.
 */
export function mobileMarkdownInsertionTransaction(state: EditorState, insertion: MobileMarkdownInsertion): Transaction | null {
  if (state.readOnly || state.selection.ranges.length !== 1) return null;
  const range = state.selection.main;
  if (touchesFence(state, range.from, range.to)) return null;
  let from = range.from, to = range.to;
  if (insertion !== 'code-block') {
    from = to = range.empty ? range.head : state.doc.lineAt(range.to > range.from && state.doc.lineAt(range.to).from === range.to ? range.to - 1 : range.to).to;
  }
  const before = state.sliceDoc(0, from), after = state.sliceDoc(to);
  const leading = leadingGap(before), trailing = trailingGap(after);
  let block: string, start: number, end: number;
  if (insertion === 'code-block') {
    const content = state.sliceDoc(from, to);
    // Longer delimiters safely preserve selected literal backticks.
    const runs = [...content.matchAll(/`+/g)].map(match => match[0].length);
    const fence = '`'.repeat(Math.max(3, ...runs.map(length => length + 1)));
    block = fence + '\n' + content + (content.endsWith('\n') ? '' : '\n') + fence;
    start = from + leading.length + fence.length + 1;
    end = start + content.length;
  } else if (insertion === 'table') {
    block = '| 标题 1 | 标题 2 |\n| --- | --- |\n| 内容 | 内容 |';
    start = end = from + leading.length + 2;
  } else {
    // Blank lines prevent --- from becoming a Setext heading. Always leave an
    // editable paragraph after the rule, even at EOF.
    block = '---\n\n';
    start = end = from + leading.length + block.length;
  }
  const insert = leading + block + (insertion === 'separator' ? '' : trailing);
  return state.update({
    changes: { from, to, insert },
    selection: EditorSelection.single(range.anchor > range.head && insertion === 'code-block' ? end : start, range.anchor > range.head && insertion === 'code-block' ? start : end),
    annotations: isolateHistory.of('full'), userEvent: 'input.format', scrollIntoView: true,
  });
}

/** Dispatch this batch as one view update. CM history otherwise derives redo's
 * selection by mapping the pre-insertion range, which puts an empty code-block
 * caret after the closing fence. An explicit selection-only checkpoint records
 * the actual insertion target without another document change or undo step. */
export function mobileMarkdownInsertionTransactions(state: EditorState, insertion: MobileMarkdownInsertion): readonly Transaction[] | null {
  const transaction = mobileMarkdownInsertionTransaction(state, insertion);
  if (!transaction?.docChanged) return null;
  const checkpoint = transaction.state.update({
    selection: transaction.state.selection,
    userEvent: 'select.format', annotations: isolateHistory.of('after'),
  });
  return [transaction, checkpoint];
}
