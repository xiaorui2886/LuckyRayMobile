import test from "node:test";
import assert from "node:assert/strict";
import { captureReadingAnchor, plainReadingBlocks, readingSourceOffset, readingSourcePositions, restoreReadingAnchor } from "../src/presentation/still01/editor/noteReadingPosition.ts";
import { EditorState } from "@codemirror/state";

test("normalized CM offsets map to original CRLF/CR source without accepting changed text", () => {
  const body = "第一行\r\n😀same\r\n第三行\r第四行";
  const editorBody = EditorState.create({doc: body}).doc.toString();
  assert.equal(editorBody, "第一行\n😀same\n第三行\n第四行");
  for (const word of ["第一行", "😀same", "第三行", "第四行"]) {
    assert.equal(readingSourceOffset(editorBody, body, editorBody.indexOf(word)), body.indexOf(word));
  }
  assert.equal(readingSourceOffset(editorBody, body, editorBody.length), body.length);
  assert.equal(readingSourceOffset(editorBody, body, 3), 3, "a newline offset remains before its CRLF pair");
  assert.equal(readingSourceOffset(editorBody, body + "new remote text", 3), undefined);
  assert.equal(readingSourceOffset("same", "same", 99), 4);
});

test("plain reading keeps exact source offsets, including repeated paragraphs and empty blocks", () => {
  assert.deepEqual(plainReadingBlocks("same\n\nsame\n\n\n\nend"), [
    { text: "same", from: 0, to: 4 }, { text: "same", from: 6, to: 10 },
    { text: "", from: 12, to: 12 }, { text: "end", from: 14, to: 17 },
  ]);
  assert.deepEqual(plainReadingBlocks(""), [{ text: "", from: 0, to: 0 }]);
});

test("Markdown positions survive formatting without reparsing text or trusting raw HTML", () => {
  const text: any = { type: "text", value: "same", position: { start: { offset: 2 }, end: { offset: 6 } } };
  const tree: any = { type: "root", children: [
    { type: "element", tagName: "strong", properties: {}, position: { start: { offset: 0 }, end: { offset: 8 } }, children: [text] },
    { type: "text", value: "\n" }, { type: "raw", value: "<script>bad()</script>" },
  ] };
  readingSourcePositions()(tree);
  const strong = tree.children[0];
  assert.equal(strong.properties["data-note-source-start"], 0);
  assert.equal(strong.properties["data-note-source-end"], 8);
  assert.equal(strong.children[0].tagName, "span");
  assert.equal(strong.children[0].properties["data-note-source-start"], 2);
  assert.equal(strong.children[0].properties["data-note-source-end"], 6);
  assert.equal(strong.children[0].children[0], text);
  assert.deepEqual(tree.children[1], { type: "text", value: "\n" });
  assert.deepEqual(tree.children[2], { type: "raw", value: "<script>bad()</script>" });
});

test("source markers are bounded metadata; generated nodes without positions remain untouched", () => {
  const tree: any = { type: "root", children: [
    { type: "element", tagName: "img", properties: { src: "resource-id" }, children: [] },
    { type: "text", value: "generated wiki label" },
    { type: "text", value: "bad", position: { start: { offset: -1 }, end: { offset: 2 } } },
  ] };
  const before = JSON.stringify(tree);
  readingSourcePositions()(tree);
  assert.equal(JSON.stringify(tree), before);
});

test("capture uses visible source coordinates, never the caret or a document-height ratio", () => {
  const view: any = { dom: { isConnected: true, closest: () => ({scrollTop: 0,
    getBoundingClientRect: () => ({top: 50, bottom: 650})}) },
    scrollDOM: {scrollTop: 4200, getBoundingClientRect: () => ({left: 30, top: 120, bottom: 720, width: 300})},
    posAtCoords: (point: any) => { assert.deepEqual(point, {x: 46, y: 385}); return 9000; },
    coordsAtPos: (offset: number) => { assert.equal(offset, 9000); return {top: 380}; },
    state: {selection: {main: {head: 0}}},
    dispatch: () => assert.fail("capturing must never dispatch a selection or document transaction"),
  };
  assert.deepEqual(captureReadingAnchor(view), {offset: 9000, viewportFraction: 260 / 530, atStart: false});
  view.scrollDOM.scrollTop = 0;
  assert.equal(captureReadingAnchor(view)?.atStart, true);
  view.dom.isConnected = false;
  assert.equal(captureReadingAnchor(view), undefined);
});

test("hidden geometry and unmapped coordinates do not manufacture a source anchor", () => {
  const view: any = { dom: {isConnected: true, closest: () => null}, scrollDOM: {
    getBoundingClientRect: () => ({left: 0, top: 50, bottom: 50, width: 300}),
  }, posAtCoords: () => assert.fail("must not measure a hidden body") };
  assert.equal(captureReadingAnchor(view), undefined);
  view.scrollDOM.getBoundingClientRect = () => ({left: 0, top: 0, bottom: 300, width: 300});
  view.posAtCoords = () => null;
  assert.equal(captureReadingAnchor(view), undefined);
});

test("render restoration resolves the exact repeated-text source span and a wrapped text range", () => {
  // Synthetic geometry exercises the algorithm only. Real browser layout is
  // separately gated by scripts/qa/knowledgeReadingPosition.test.mjs.
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const oldFilter = Object.getOwnPropertyDescriptor(globalThis, "NodeFilter");
  const rangeCalls: unknown[] = [];
  const first = {dataset: {noteSourceStart: "0", noteSourceEnd: "4"}, textContent: "same",
    getBoundingClientRect: () => ({top: -300})};
  const third = {dataset: {noteSourceStart: "9000", noteSourceEnd: "9004"}, textContent: "same",
    getBoundingClientRect: () => ({top: 4000})};
  const paragraph = {dataset: {noteSourceStart: "8800", noteSourceEnd: "9400"}, textContent: "large paragraph",
    getBoundingClientRect: () => ({top: 3900})};
  const paper = {scrollTop: 100, getBoundingClientRect: () => ({top: 50, height: 600})};
  const root: any = {closest: () => paper, querySelectorAll: () => [first, paragraph, third]};
  Object.defineProperty(globalThis, "NodeFilter", {configurable: true, value: {SHOW_TEXT: 4}});
  Object.defineProperty(globalThis, "document", {configurable: true, value: {
    createTreeWalker: (target: unknown) => { assert.equal(target, third); let done = false; return {
      nextNode: () => done ? null : (done = true, {textContent: "same"}),
    }; },
    createRange: () => ({setStart: (_node: unknown, offset: number) => rangeCalls.push(offset),
      setEnd() {}, getClientRects: () => [{top: 4070}]}),
  }});
  try {
    assert.equal(restoreReadingAnchor(root, {offset: 9002, viewportFraction: 0.5, atStart: false}), true);
    assert.deepEqual(rangeCalls, [2]);
    assert.equal(paper.scrollTop, 3820, "use the rendered text's coordinate, not the editor's old pixel offset");
    assert.equal(restoreReadingAnchor(root, {offset: 0, viewportFraction: 0.5, atStart: true}), true);
    assert.equal(paper.scrollTop, 0, "an unscrolled note stays at its title");
    root.querySelectorAll = () => [];
    assert.equal(restoreReadingAnchor(root, {offset: 12, viewportFraction: 0.5, atStart: false}), false);
  } finally {
    if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument); else Reflect.deleteProperty(globalThis, "document");
    if (oldFilter) Object.defineProperty(globalThis, "NodeFilter", oldFilter); else Reflect.deleteProperty(globalThis, "NodeFilter");
  }
});

test("the handoff is one-shot, full-owner scoped, and rejects a different body", async () => {
  const pool = await import("../src/presentation/still01/editor/cmEditorSessions.ts");
  pool.destroyAllCmViews();
  const make = () => ({dom: {isConnected: true, parentNode: null, closest: () => null},
    scrollDOM: {scrollTop: 100, scrollLeft: 0, getBoundingClientRect: () => ({left: 0, top: 0, bottom: 300, width: 300})},
    posAtCoords: () => 10, coordsAtPos: () => ({top: 140}),
    scrollSnapshot: () => ({}), state: {doc: {toString: () => "current body"}}, destroy() {},
  } as any);
  try {
    pool.acquireCmView("cm|desktop|A|vault|same-id", make);
    pool.detachCmView("cm|desktop|A|vault|same-id");
    assert.equal(pool.takeCmReadingAnchor("cm|desktop|B|vault|same-id", "current body"), undefined);
    assert.equal(pool.takeCmReadingAnchor("cm|desktop|A|vault|same-id", "current body")?.offset, 10);
    assert.equal(pool.takeCmReadingAnchor("cm|desktop|A|vault|same-id", "current body"), undefined);
    pool.detachCmView("cm|desktop|A|vault|same-id");
    assert.equal(pool.takeCmReadingAnchor("cm|desktop|A|vault|same-id", "changed body"), undefined);
    assert.equal(pool.takeCmReadingAnchor("cm|desktop|A|vault|same-id", "current body"), undefined);
  } finally { pool.destroyAllCmViews(); }
});
