import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, EditorSelection, type Transaction } from '@codemirror/state';
import { history, undo, redo, undoDepth } from '@codemirror/commands';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { mobileMarkdownInsertionTransactions as insert, type MobileMarkdownInsertion } from '../src/presentation/still01/editor/mobileMarkdownInsertions.ts';

function editor(doc: string, anchor = doc.length, head = anchor) {
  let state = EditorState.create({ doc, selection: { anchor, head }, extensions: history() });
  const target = { get state() { return state; }, dispatch(transaction: Transaction) { state = transaction.state; } };
  return { target, get state() { return state; }, text: () => state.doc.toString(),
    insert(kind: MobileMarkdownInsertion) { const batch = insert(state, kind); if (batch) for (const tr of batch) target.dispatch(tr); return batch; } };
}
const parse = (value: string) => unified().use(remarkParse).use(remarkGfm).parse(value);

test('empty insertions produce real Markdown blocks and editable caret targets', () => {
  for (const [kind, type] of [['code-block', 'code'], ['table', 'table'], ['separator', 'thematicBreak']] as const) {
    const e = editor(''); e.insert(kind);
    assert.equal(parse(e.text()).children[0].type, type);
    const caret = e.state.selection.main.head;
    if (kind === 'code-block') assert.equal(e.text().slice(caret - 1, caret + 1), '\n\n');
    if (kind === 'table') assert.equal(e.text().slice(caret, caret + 2), '标题');
    if (kind === 'separator') assert.equal(caret, e.text().length);
  }
});

test('code wraps exact selected text and one undo/redo restores document and reversed selection', () => {
  const doc = '前文中文\nsecond 后文';
  const e = editor(doc, 12, 2); e.insert('code-block');
  assert.equal(e.state.sliceDoc(e.state.selection.main.from, e.state.selection.main.to), doc.slice(2, 12));
  assert.ok(e.state.selection.main.anchor > e.state.selection.main.head);
  assert.equal(parse(e.text()).children[1].type, 'code');
  const formatted = e.text(), selection = e.state.selection.toJSON();
  assert.equal(undo(e.target), true); assert.equal(e.text(), doc);
  assert.equal(e.state.selection.main.anchor, 12); assert.equal(e.state.selection.main.head, 2);
  assert.equal(redo(e.target), true); assert.equal(e.text(), formatted); assert.deepEqual(e.state.selection.toJSON(), selection);
  assert.equal(e.insert('code-block'), null); assert.equal(e.text(), formatted);
});

test('all insertion undo steps stay separate from adjacent typing', () => {
  for (const kind of ['code-block', 'table', 'separator'] as const) {
    const e = editor('text'); e.insert(kind);
    const inserted = e.text();
    e.target.dispatch(e.state.update({ changes: { from: e.state.selection.main.head, insert: 'typed' }, userEvent: 'input' }));
    undo(e.target); assert.equal(e.text(), inserted);
    undo(e.target); assert.equal(e.text(), 'text');
  }
});

test('table and separator preserve selected prose verbatim and insert after selected last line', () => {
  for (const kind of ['table', 'separator'] as const) {
    const source = 'keep | this\nsecond\nnext';
    const e = editor(source, 3, 18); e.insert(kind);
    assert.ok(e.text().startsWith('keep | this\nsecond\n\n'));
    assert.ok(e.text().endsWith('next'));
    const types = parse(e.text()).children.map(node => node.type);
    assert.deepEqual(types, ['paragraph', kind === 'table' ? 'table' : 'thematicBreak', 'paragraph']);
    undo(e.target); assert.equal(e.text(), source); assert.equal(e.state.selection.main.from, 3); assert.equal(e.state.selection.main.to, 18);
  }
});

test('inserting mid-paragraph creates safe boundaries; separator never becomes a Setext heading', () => {
  for (const kind of ['code-block', 'table', 'separator'] as const) {
    const e = editor('beforeafter', 6); e.insert(kind);
    assert.deepEqual(parse(e.text()).children.map(node => node.type), ['paragraph', kind === 'code-block' ? 'code' : kind === 'table' ? 'table' : 'thematicBreak', 'paragraph']);
  }
});

test('selected backtick runs and terminal newline survive code wrapping without closing it', () => {
  for (const source of ['a ``` b', '中文\n', 'a ````` b\nline']) {
    const e = editor(source, 0, source.length); e.insert('code-block');
    assert.equal(e.state.sliceDoc(e.state.selection.main.from, e.state.selection.main.to), source);
    const tree = parse(e.text()); assert.equal(tree.children.length, 1); assert.equal(tree.children[0].type, 'code');
    assert.equal(e.insert('code-block'), null);
  }
});

test('existing and unfinished fences in quote/list containers are protected from all insertions', () => {
  for (const source of ['```js\ncontent\n```', '~~~\ncontent', '> ```\n> content\n> ```', '- ```\n  content\n  ```', '````\n```\ncontent\n````']) {
    const pos = source.indexOf('content') + 2;
    for (const kind of ['code-block', 'table', 'separator'] as const) {
      const e = editor(source, pos); assert.equal(e.insert(kind), null); assert.equal(e.text(), source);
    }
  }
  const e = editor('before\n```\ncontent\n```\nafter', 0, 25);
  assert.equal(e.insert('code-block'), null);
});

test('read-only and multirange states decline safely', () => {
  const readOnly = EditorState.create({ extensions: EditorState.readOnly.of(true) });
  const multiple = EditorState.create({ doc: 'a b', selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(2)]), extensions: EditorState.allowMultipleSelections.of(true) });
  for (const kind of ['code-block', 'table', 'separator'] as const) {
    assert.equal(insert(readOnly, kind), null); assert.equal(insert(multiple, kind), null);
  }
});


test('redo restores the actual insertion caret and selection without an extra undo step', () => {
  for (const kind of ['code-block', 'table', 'separator'] as const) {
    for (const [doc, anchor, head] of [['', 0, 0], ['prefixsuffix', 6, 6], ['selected', 8, 0]] as const) {
      const e = editor(doc, anchor, head); e.insert(kind);
      const expected = e.state.selection.toJSON(), text = e.text();
      assert.equal(undoDepth(e.state), 1);
      undo(e.target); assert.equal(e.text(), doc);
      assert.equal(e.state.selection.main.anchor, anchor); assert.equal(e.state.selection.main.head, head);
      assert.equal(undoDepth(e.state), 0);
      redo(e.target); assert.equal(e.text(), text); assert.deepEqual(e.state.selection.toJSON(), expected);
      assert.equal(undoDepth(e.state), 1);
    }
  }
});
