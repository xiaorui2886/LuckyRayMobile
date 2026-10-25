import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, EditorSelection, type Transaction } from '@codemirror/state';
import { history, undo, redo } from '@codemirror/commands';
import { EditorView, keymap } from '@codemirror/view';
import { mobileMarkdownCommandTransaction as format, mobileMarkdownEnterTransaction as enter } from '../src/presentation/still01/editor/mobileMarkdownCommands.ts';
import { runEditorCommand, type EditorCommand } from '../src/presentation/still01/editor/editorCommands.ts';
import { runMobileMarkdownEnter, cmMobileMarkdownInput, trackMobileMarkdownBeforeInput } from '../src/presentation/still01/editor/cmMobileMarkdownInput.ts';

function editor(doc: string, anchor = doc.length, head = anchor) {
  let state = EditorState.create({ doc, selection: { anchor, head }, extensions: [history(), EditorState.allowMultipleSelections.of(true)] });
  // Actual production transactions and CM history, not a fabricated format edit.
  const target = { get state() { return state; }, dispatch(tr: Transaction) { state = tr.state; }, hasFocus: true, composing: false, compositionStarted: false, dom: undefined };
  return { target, get state() { return state; }, text: () => state.doc.toString(),
    format(command: EditorCommand) { return runEditorCommand(target as never, command); },
    enter() { return runMobileMarkdownEnter(target as never); },
    set(anchor: number, head = anchor) { state = state.update({ selection: { anchor, head } }).state; },
  };
}

test('prefix caret moves after marker; every prefix toggles without nesting; undo/redo restore exact selection', () => {
  for (const [command, marker] of [['heading', '## '], ['quote', '> '], ['bullet', '- '], ['number', '1. '], ['task', '- [ ] ']] as const) {
    const e = editor('', 0); assert.equal(e.format(command), true);
    assert.equal(e.text(), marker); assert.equal(e.state.selection.main.head, marker.length);
    assert.equal(undo(e.target), true); assert.equal(e.text(), ''); assert.equal(e.state.selection.main.head, 0);
    assert.equal(redo(e.target), true); assert.equal(e.text(), marker);
    e.format(command); assert.equal(e.text(), ''); assert.equal(e.state.selection.main.head, 0);
  }
});
test('block conversion preserves indent/quote and selected numbering; excludes trailing untouched line', () => {
  const e = editor('  > - a\n  > - b\nuntouched', 0, 16);
  e.format('number'); assert.equal(e.text(), '  > 1. a\n  > 2. b\nuntouched');
  e.format('task'); assert.equal(e.text(), '  > - [ ] a\n  > - [ ] b\nuntouched');
});
test('inline multi-line formatting preserves heading/list/task/quote markers, skips blank lines and toggles', () => {
  const source = '## 标题\n- 项目\n  > - [x] 已做\n\n正文';
  const e = editor(source, 0, source.length);
  e.format('bold'); assert.equal(e.text(), '## **标题**\n- **项目**\n  > - [x] **已做**\n\n**正文**');
  e.format('bold'); assert.equal(e.text(), source);
  undo(e.target); assert.equal(e.text(), '## **标题**\n- **项目**\n  > - [x] **已做**\n\n**正文**');
  undo(e.target); assert.equal(e.text(), source); assert.equal(e.state.selection.main.from, 0); assert.equal(e.state.selection.main.to, source.length);
});
test('selected inner text and whole wrappers both toggle; mixed selection adds only missing format', () => {
  for (const [anchor, head] of [[2, 5], [0, 7], [5, 2]]) {
    const e = editor('**abc**', anchor, head); e.format('bold'); assert.equal(e.text(), 'abc');
    assert.equal(e.state.selection.main.anchor > e.state.selection.main.head, anchor > head);
  }
  const e = editor('**a**\nb', 0, 7); e.format('bold'); assert.equal(e.text(), '**a**\n**b**');
  e.format('bold'); assert.equal(e.text(), 'a\nb');
});
test('italic does not mistake bold for italic and combined styles retain the other format', () => {
  for (const [anchor, head] of [[0, 7], [2, 5]]) {
    const e = editor('**abc**', anchor, head); e.format('italic'); assert.equal(e.text(), '***abc***');
    e.format('italic'); assert.equal(e.text(), '**abc**');
  }
  const e = editor('***abc***', 0, 9); e.format('bold'); assert.equal(e.text(), '*abc*');
});
test('empty inline insertion places caret inside and repeated tap removes pair', () => {
  const e = editor('中文', 1); e.format('bold'); assert.equal(e.text(), '中****文'); assert.equal(e.state.selection.main.head, 3);
  e.format('bold'); assert.equal(e.text(), '中文'); assert.equal(e.state.selection.main.head, 1);
});
test('real Enter continues bullet/number/task; checked tasks continue unchecked, undo restores original range', () => {
  for (const [source, expected] of [['- 文', '- 文\n- '], ['9. 文', '9. 文\n10. '], ['2) 文', '2) 文\n3) '], ['  > + [x] 文', '  > + [x] 文\n  > + [ ] ']]) {
    const e = editor(source); assert.equal(e.enter(), true); assert.equal(e.text(), expected);
    assert.equal(e.state.selection.main.head, expected.length); undo(e.target); assert.equal(e.text(), source); assert.equal(e.state.selection.main.head, source.length);
  }
});
test('Enter empty root exits; nested item outdents one level before exiting', () => {
  const e = editor('  - [ ] '); e.enter(); assert.equal(e.text(), '- [ ] '); assert.equal(e.state.selection.main.head, 6);
  e.enter(); assert.equal(e.text(), ''); assert.equal(e.state.selection.main.head, 0);
  undo(e.target); assert.equal(e.text(), '- [ ] '); undo(e.target); assert.equal(e.text(), '  - [ ] ');
  const q = editor('> - '); q.enter(); assert.equal(q.text(), '> ');
});
test('Enter splits content and replaces selected range rather than appending copied text', () => {
  const e = editor('- abcd', 3, 5); e.enter(); assert.equal(e.text(), '- a\n- d'); assert.equal(e.state.selection.main.head, 6);
  undo(e.target); assert.equal(e.text(), '- abcd'); assert.equal(e.state.selection.main.anchor, 3); assert.equal(e.state.selection.main.head, 5);
});
test('composition/preedit and unfocused editor are never mutated or forcibly focused', () => {
  for (const property of ['composing', 'compositionStarted']) {
    const e = editor('- 中文'); e.target[property] = true;
    assert.equal(e.format('bold'), false); assert.equal(e.enter(), false); assert.equal(e.text(), '- 中文');
  }
  const e = editor('- text'); e.target.hasFocus = false;
  assert.equal(e.format('bold'), false); assert.equal(e.enter(), false);
});
test('ordinary text, fenced code and read-only documents leave default Enter untouched', () => {
  for (const doc of ['text', '```md\n- literal', '~~~\n- literal']) assert.equal(enter(EditorState.create({ doc, selection: { anchor: doc.length } })), null);
  const state = EditorState.create({ doc: '- text', selection: { anchor: 6 }, extensions: [EditorState.readOnly.of(true)] });
  assert.equal(enter(state), null); assert.equal(format(state, 'bold'), null);
});
test('multiple ranges format through real changeByRange and preserve main selection', () => {
  let state = EditorState.create({ doc: 'a b', selection: EditorSelection.create([EditorSelection.range(0, 1), EditorSelection.range(2, 3)], 1), extensions: EditorState.allowMultipleSelections.of(true) });
  state = format(state, 'bold')!.state; assert.equal(state.doc.toString(), '**a** **b**'); assert.equal(state.selection.mainIndex, 1);
  state = format(state, 'bold')!.state; assert.equal(state.doc.toString(), 'a b');
});
test('inline and block commands leave fenced code intact, including longer fences and embedded short fences', () => {
  const source = '前\n````md\n- code\n```\n````\n后';
  const e = editor(source, 0, source.length); e.format('bold');
  assert.equal(e.text(), '**前**\n````md\n- code\n```\n````\n**后**');
  e.format('bold'); assert.equal(e.text(), source);
  const inside = editor('```\n- literal\n```', 7); assert.equal(inside.format('bold'), false); assert.equal(inside.format('heading'), false);
});
test('native input fallback requires real Enter intent; paste/IME/other input and consumed key cannot duplicate it', () => {
  const configured = EditorState.create({ extensions: [cmMobileMarkdownInput] });
  const input = configured.facet(EditorView.inputHandler)[0];
  const e = editor('- text'); const view = e.target as never;
  assert.equal(input(view, 6, 6, '\n', () => { throw Error('unexpected default insertion'); }), false, 'bare newline is not Enter');
  trackMobileMarkdownBeforeInput(view, { isComposing: false, inputType: 'insertParagraph' });
  assert.equal(input(view, 6, 6, '\n', () => { throw Error('unexpected default insertion'); }), true);
  assert.equal(e.text(), '- text\n- ');
  assert.equal(input(view, 9, 9, '\n', () => { throw Error('unexpected default insertion'); }), false, 'consumed input cannot run again');
  for (const type of ['insertFromPaste', 'insertCompositionText', 'insertText']) {
    trackMobileMarkdownBeforeInput(view, { isComposing: false, inputType: 'insertParagraph' });
    trackMobileMarkdownBeforeInput(view, { isComposing: false, inputType: type });
    assert.equal(input(view, 9, 9, '\n', () => { throw Error('unexpected default insertion'); }), false);
  }
  trackMobileMarkdownBeforeInput(view, { isComposing: true, inputType: 'insertParagraph' });
  assert.equal(input(view, 9, 9, '\n', () => { throw Error('unexpected default insertion'); }), false);
  trackMobileMarkdownBeforeInput(view, { isComposing: false, inputType: 'insertParagraph' });
  assert.equal(configured.facet(keymap)[0][0].run!(view), true, 'native synthetic Enter uses production command');
  assert.equal(e.text(), '- text\n');
  assert.equal(input(view, 7, 7, '\n', () => { throw Error('unexpected default insertion'); }), false, 'key consumed native intent');
});
test('nested items within quotes preserve quote indentation and outdent before exiting', () => {
  const e = editor('>   - [x] 中文'); e.enter(); assert.equal(e.text(), '>   - [x] 中文\n>   - [ ] ');
  e.enter(); assert.equal(e.text(), '>   - [x] 中文\n> - [ ] ');
  e.enter(); assert.equal(e.text(), '>   - [x] 中文\n> ');
  const compact = editor('- [ ]'); compact.enter(); assert.equal(compact.text(), '');
});
test('inline delimiters stay inside selected boundary whitespace for valid Markdown', () => {
  const e = editor('  中文  \n- 内容 \t', 0, 13); e.format('bold');
  assert.equal(e.text(), '  **中文**  \n- **内容** \t'); e.format('bold'); assert.equal(e.text(), '  中文  \n- 内容 \t');
});
