import { EditorSelection, type EditorState, type ChangeSpec, type Transaction } from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';
import type { EditorCommand } from './editorCommands';

// The same transactions run from the toolbar, hardware Enter and Android's
// native input path. Keep this state-only so tests execute the production code.
const pairs: Partial<Record<EditorCommand, readonly [string, string]>> = {
  wiki: ['[[', ']]'], bold: ['**', '**'], italic: ['*', '*'], strike: ['~~', '~~'],
  highlight: ['==', '=='], code: ['`', '`'], link: ['[', '](https://)'],
};
const annotations = [isolateHistory.of('full')];

type Prefix = { indent: string; quote: string; innerIndent: string; marker: string; kind: string; content: number };
function prefix(text: string): Prefix {
  const indent = /^[ \t]*/.exec(text)![0];
  const quote = /^(?:> ?)+/.exec(text.slice(indent.length))?.[0] ?? '';
  const innerIndent = quote ? /^[ \t]*/.exec(text.slice(indent.length + quote.length))![0] : '';
  const start = indent.length + quote.length + innerIndent.length;
  const rest = text.slice(start);
  const marker = /^(?:[-+*][ \t]+\[[ xX]\](?:[ \t]+|$)|(?:[-+*]|\d+[.)])[ \t]+|#{1,6}[ \t]+)/.exec(rest)?.[0] ?? '';
  const kind = /\[[ xX]\]/.test(marker) ? 'task' : /^\d/.test(marker) ? 'number'
    : /^[-+*]/.test(marker) ? 'bullet' : marker ? 'heading' : '';
  return { indent, quote, innerIndent, marker, kind, content: start + marker.length };
}

function inlineTransaction(state: EditorState, pair: readonly [string, string]): Transaction {
  const [open, close] = pair;
  const fences = fencedLines(state, state.doc.lineAt(state.selection.ranges[state.selection.ranges.length - 1].to).number);
  const spec = state.changeByRange(range => {
    const changes: ChangeSpec[] = [];
    let caret: number | undefined;
    if (range.empty) {
      if (fences.has(state.doc.lineAt(range.from).number)) return { range };
      const before = state.sliceDoc(Math.max(0, range.from - open.length), range.from);
      const after = state.sliceDoc(range.to, range.to + close.length);
      if (before === open && after === close) {
        changes.push({ from: range.from - open.length, to: range.from }, { from: range.to, to: range.to + close.length });
        caret = range.from - open.length;
      } else {
        changes.push({ from: range.from, insert: open + close });
        caret = range.from + open.length;
      }
    } else {
      const end = state.doc.lineAt(range.to).from === range.to ? range.to - 1 : range.to;
      const segments: { from: number; to: number; left?: number; right?: number }[] = [];
      for (let n = state.doc.lineAt(range.from).number; n <= state.doc.lineAt(end).number; n++) {
        const line = state.doc.line(n);
        if (fences.has(n)) continue;
        // Markdown syntax stays outside inline wrappers, including nested
        // quote/list/task markers. Blank lines do not gain empty formatting.
        let from = Math.max(range.from, line.from + prefix(line.text).content);
        let to = Math.min(range.to, line.to);
        if (from >= to || !state.sliceDoc(from, to).trim()) continue;
        // GFM emphasis cannot open/close against whitespace. Keep selected
        // indentation and trailing spaces intact, but outside the delimiters.
        const raw = state.sliceDoc(from, to);
        from += /^[ \t]*/.exec(raw)![0].length;
        to -= /[ \t]*$/.exec(raw)![0].length;
        const text = state.sliceDoc(from, to);
        const before = state.sliceDoc(line.from + prefix(line.text).content, from);
        const after = state.sliceDoc(to, line.to);
        const leftInside = text.startsWith(open) && (open !== '*' || (/^\*+/.exec(text)![0].length % 2 === 1));
        const rightInside = text.endsWith(close) && (open !== '*' || (/\*+$/.exec(text)![0].length % 2 === 1));
        const leftOutside = before.endsWith(open) && (open !== '*' || (/\*+$/.exec(before)![0].length % 2 === 1));
        const rightOutside = after.startsWith(close) && (open !== '*' || (/^\*+/.exec(after)![0].length % 2 === 1));
        const left = leftInside ? from : leftOutside ? from - open.length : undefined;
        const right = rightInside ? to - close.length : rightOutside ? to : undefined;
        const formatted = left !== undefined && right !== undefined && left + open.length <= right;
        segments.push({ from, to, left: formatted ? left : undefined, right: formatted ? right : undefined });
      }
      const remove = segments.length > 0 && segments.every(s => s.left !== undefined);
      for (const s of segments) {
        if (remove) changes.push({ from: s.left!, to: s.left! + open.length }, { from: s.right!, to: s.right! + close.length });
        else if (s.left === undefined) changes.push({ from: s.from, insert: open }, { from: s.to, insert: close });
      }
    }
    const set = state.changes(changes);
    if (caret !== undefined) return { changes: set, range: EditorSelection.cursor(caret) };
    const from = set.mapPos(range.from, 1), to = set.mapPos(range.to, -1);
    return { changes: set, range: EditorSelection.range(range.anchor <= range.head ? from : to, range.anchor <= range.head ? to : from) };
  });
  return state.update({ ...spec, annotations, userEvent: 'input.format', scrollIntoView: true });
}

export function mobileMarkdownCommandTransaction(state: EditorState, command: EditorCommand): Transaction | null {
  if (state.readOnly || command === 'undo' || command === 'redo') return null;
  const pair = pairs[command];
  if (pair) return inlineTransaction(state, pair);
  const lines = new Map<number, ReturnType<EditorState['doc']['lineAt']>>();
  for (const range of state.selection.ranges) {
    const end = range.to > range.from && state.doc.lineAt(range.to).from === range.to ? range.to - 1 : range.to;
    for (let n = state.doc.lineAt(range.from).number; n <= state.doc.lineAt(end).number; n++) lines.set(n, state.doc.line(n));
  }
  const fences = fencedLines(state, Math.max(...lines.keys()));
  const rows = [...lines.values()].filter(line => !fences.has(line.number)).sort((a, b) => a.from - b.from).map(line => ({ line, p: prefix(line.text) }));
  if (!rows.length) return null;
  const remove = rows.every(({ p }) => command === 'quote' ? !!p.quote : p.kind === command);
  const changes: ChangeSpec[] = [];
  let number = 1;
  for (const { line, p } of rows) {
    if (command === 'indent') changes.push({ from: line.from, insert: '  ' });
    else if (command === 'outdent') {
      const width = /^ {1,2}|^\t/.exec(line.text)?.[0].length ?? 0;
      if (width) changes.push({ from: line.from, to: line.from + width });
    } else if (command === 'quote') {
      const from = line.from + p.indent.length;
      // Toggle one outer quote level, not all nested semantic structure.
      if (remove) changes.push({ from, to: from + (p.quote.startsWith('> ') ? 2 : 1) });
      else if (!p.quote) changes.push({ from, insert: '> ' });
    } else {
      const from = line.from + p.indent.length + p.quote.length + p.innerIndent.length;
      const insert = remove ? '' : command === 'number' ? `${number++}. ` : command === 'heading' ? '## '
        : command === 'task' ? '- [ ] ' : '- ';
      changes.push({ from, to: from + p.marker.length, insert });
    }
  }
  const set = state.changes(changes);
  // Association +1 is essential: an empty caret at column zero must sit
  // AFTER the prefix, ready to type, rather than before the new marker.
  const selection = EditorSelection.create(state.selection.ranges.map(range => {
    const from = set.mapPos(range.from, 1), to = set.mapPos(range.to, range.empty ? 1 : -1);
    return EditorSelection.range(range.anchor <= range.head ? from : to, range.anchor <= range.head ? to : from);
  }), state.selection.mainIndex);
  return state.update({ changes: set, selection, annotations, userEvent: 'input.format', scrollIntoView: true });
}

function fencedLines(state: EditorState, through = state.doc.lines): Set<number> {
  const lines = new Set<number>();
  let fence = '';
  for (let n = 1; n <= through; n++) {
    const text = state.doc.line(n).text;
    const match = /^\s*(?:> ?)*(`{3,}|~{3,})(.*)$/.exec(text);
    if (fence) lines.add(n);
    if (!match) continue;
    if (!fence) { fence = match[1]; lines.add(n); }
    else if (match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) fence = '';
  }
  return lines;
}

/** null leaves ordinary Enter to CodeMirror. A range is accepted from the
 * native input handler because Android can report a changed DOM selection. */
export function mobileMarkdownEnterTransaction(state: EditorState, from = state.selection.main.from, to = state.selection.main.to): Transaction | null {
  if (state.readOnly || state.selection.ranges.length !== 1 || fencedLines(state, state.doc.lineAt(from).number).has(state.doc.lineAt(from).number)) return null;
  const line = state.doc.lineAt(from), p = prefix(line.text);
  if (!['bullet', 'number', 'task'].includes(p.kind) || from < line.from + p.content) return null;
  // The selected text is replaced, not retained or copied to the next item.
  // Empty-item exit is only valid with no selection and no residual content.
  if (from === to && !line.text.slice(p.content).trim()) {
    const from = line.from;
    const innerWidth = /^ {1,2}|^\t/.exec(p.innerIndent)?.[0].length ?? 0;
    const width = /^ {1,2}|^\t/.exec(p.indent)?.[0].length ?? 0;
    const innerFrom = from + p.indent.length + p.quote.length;
    const change = innerWidth ? { from: innerFrom, to: innerFrom + innerWidth, insert: '' }
      : width ? { from, to: from + width, insert: '' }
      : { from: from + p.indent.length + p.quote.length, to: line.to, insert: '' };
    const set = state.changes(change);
    return state.update({ changes: set, selection: { anchor: set.mapPos(line.to, -1) }, annotations, userEvent: 'input', scrollIntoView: true });
  }
  const marker = p.kind === 'task' ? `${p.marker[0]} [ ] ` : p.kind === 'number'
    ? p.marker.replace(/^\d+/, number => String(Number(number) + 1)) : p.marker;
  const insert = '\n' + p.indent + p.quote + p.innerIndent + marker;
  return state.update({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, annotations, userEvent: 'input', scrollIntoView: true });
}
