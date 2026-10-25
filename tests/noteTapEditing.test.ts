import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EditorState, Transaction } from "@codemirror/state";
import { history, undoDepth } from "@codemirror/commands";
import { consumeBodyFocusRequest, editorOffsetAtSource, isReadingControl, readingOffsetAtPoint } from "../src/presentation/still01/editor/noteTapEditing.ts";

test("tap entry: one-shot owner intent cannot replay across a new view incarnation", () => {
  const request = {scope: "cm|desktop|A|vault|same-id", offset: 12};
  assert.equal(consumeBodyFocusRequest(request, "cm|desktop|B|vault|same-id"), false);
  assert.equal(consumeBodyFocusRequest(request, request.scope), true);
  // The first view may now be destroyed, evicted or replaced. Consumption
  // belongs to the intent object, so a new view cannot execute it again.
  assert.equal(consumeBodyFocusRequest(request, request.scope), false);
  assert.equal(consumeBodyFocusRequest({...request}, request.scope), true, "another deliberate tap is a new intent");
  assert.equal(consumeBodyFocusRequest(undefined, request.scope), false);
});

test("tap entry: source offsets stay UTF-16, normalize CRLF, and never split emoji", () => {
  const body = "甲\r\n😀乙\r丙";
  assert.equal(editorOffsetAtSource(body, 3), 2);
  assert.equal(editorOffsetAtSource(body, 4), 2, "inside the surrogate pair snaps before the glyph");
  assert.equal(editorOffsetAtSource(body, 5), 4);
  assert.equal(editorOffsetAtSource(body, 99), 7);
  assert.equal(editorOffsetAtSource(body, -1), 0);
});

test("tap entry: caret mapping uses the tapped source span, not repeated text search", () => {
  const marker = {dataset: {noteSourceStart: "8", noteSourceEnd: "12"}, textContent: "重复正文"};
  const node = {nodeType: 3, parentElement: {closest: () => marker}};
  const calls: unknown[] = [];
  const root: any = {contains: (element: unknown) => element === marker, ownerDocument: {
    caretPositionFromPoint: (x: number, y: number) => {calls.push([x,y]);return {offsetNode: node, offset: 2};},
    createRange: () => ({selectNodeContents: (element: unknown) => assert.equal(element, marker),
      setEnd: (actual: unknown, offset: number) => {assert.equal(actual, node);assert.equal(offset, 2);}, toString: () => "重复"}),
  }};
  assert.equal(readingOffsetAtPoint(root, "重复正文\n\n\n\n重复正文", 40, 220), 10);
  assert.deepEqual(calls, [[40,220]]);
});

test("tap entry: Chromium range fallback handles escaped Markdown within its source span", () => {
  const marker = {dataset: {noteSourceStart: "2", noteSourceEnd: "9"}, textContent: "a&b"};
  const node = {nodeType: 3, parentElement: {closest: () => marker}};
  const root: any = {contains: () => true, ownerDocument: {
    caretRangeFromPoint: () => ({startContainer: node, startOffset: 2}),
    createRange: () => ({selectNodeContents() {}, setEnd() {}, toString: () => "a&"}),
  }};
  assert.equal(readingOffsetAtPoint(root, "##a&amp;b", 0, 0), 7);
});

test("tap entry: empty/blank space and unsupported caret APIs use bounded nearest blocks", () => {
  const root: any = {ownerDocument: {}, querySelectorAll: () => []};
  assert.equal(readingOffsetAtPoint(root, "", 10, 50), 0);
  root.querySelectorAll = () => [
    {dataset: {noteSourceStart:"0",noteSourceEnd:"4"}, getBoundingClientRect: () => ({top:100,bottom:140})},
    {dataset: {noteSourceStart:"6",noteSourceEnd:"10"}, getBoundingClientRect: () => ({top:200,bottom:240})},
  ];
  assert.equal(readingOffsetAtPoint(root, "甲甲甲甲\n\n乙乙乙乙", 10, 270), 10);
  assert.equal(readingOffsetAtPoint(root, "甲甲甲甲\n\n乙乙乙乙", 10, 90), 0);
});

test("tap entry: links, attachments and other controls retain their original action", () => {
  const control = {};
  const root: any = {contains: (element: unknown) => element === control};
  const target: any = {closest: (selector: string) => {
    for (const token of ["a", "button", "input", "video", "audio", "img", '[role="button"]']) assert.ok(selector.includes(token));
    return control;
  }};
  assert.equal(isReadingControl(target, root), true);
  assert.equal(isReadingControl({closest: () => null} as any, root), false);
  assert.equal(isReadingControl({closest: () => ({})} as any, root), false, "an ancestor outside the reader is not its interactive content");
});

test("tap entry: selection-only CM transaction preserves body and undo, with no save echo", () => {
  let state = EditorState.create({doc: "甲😀乙", extensions: [history()]});
  state = state.update({changes: {from: 4, insert: "测试"}}).state;
  const before = {body: state.doc.toString(), undo: undoDepth(state)};
  const transaction = state.update({selection: {anchor: editorOffsetAtSource(state.doc.toString(), 3)},
    scrollIntoView: true, annotations: Transaction.addToHistory.of(false)});
  assert.equal(transaction.docChanged, false);
  assert.equal(transaction.state.doc.toString(), before.body);
  assert.equal(undoDepth(transaction.state), before.undo);
  assert.equal(transaction.state.selection.main.anchor, 3);
});

test("tap entry: production mount never autofocuses or resets the reading/search position", () => {
  const editor = readFileSync("src/presentation/still01/editor/MobileCmEditor.tsx", "utf8");
  const page = readFileSync("src/still/StillNote.tsx", "utf8");
  assert.doesNotMatch(editor, /autoFocus|focusFrame/);
  assert.doesNotMatch(page, /autoFocus=|onMode=/);
  assert.equal((page.match(/focusRequest=\{bodyFocus\}/g) ?? []).length, 2);
  assert.match(editor, /consumeBodyFocusRequest\(focusRequest, scope\)/);
  assert.match(editor, /view.composing \|\| view.compositionStarted/);
  assert.match(editor, /restoreCmViewScroll\(scope\)/);
  assert.match(editor, /revealedSearchTargets/);
  assert.doesNotMatch(editor, /scrollTop\s*=\s*0/);
  assert.match(page, /await Promise.all\(pending.current\)/);
  assert.match(page, /await c\?\.flush\(\)/);
});

test("tap entry: title stays the same input and note controls contain no Edit/Done switch", () => {
  const surface = readFileSync("src/presentation/still01/Still.tsx", "utf8").split("export function NoteSurface")[1];
  assert.match(surface, /editable\?<input ref=\{titleInput\} className="st-note-title"/);
  assert.match(surface, /onFocus=\{\(\)=>\{if\(p.mode==='read'\)p.onEdit\(\)\}\}/);
  assert.match(surface, /editable=!noBody&&!p.readOnly/);
  assert.match(surface, /title\.blur\(\)/);
  assert.match(surface, /!e.nativeEvent.isComposing&&e.keyCode!==229/);
  assert.match(surface, /selection&&!selection.isCollapsed/);
  assert.match(surface, /Date.now\(\)-start.at>550/);
  assert.doesNotMatch(surface, /onMode|完成编辑|编辑笔记|>完成<|开始书写/);
  for (const action of ["返回上一页", "文本格式", "插入附件", "查找笔记", "新建笔记"]) assert.ok(surface.includes(action));
  assert.match(readFileSync(".github/workflows/ci-lite.yml", "utf8"), /tests\/noteTapEditing.test.ts/);
});
