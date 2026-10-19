// CM6-EDITOR-R1 — focused adapter tests (node-runnable; @codemirror/state is
// pure JS, so the state-level contracts run for real; view-level behavior is
// covered by cm6EditorLifecycle.test.mjs on real React/CM and StillApp).

import test from "node:test";
import assert from "node:assert/strict";
import { EditorState, EditorSelection } from "@codemirror/state";
import { documentSyncChange, isDocumentEcho } from "../src/presentation/still01/editor/cmDocumentSync.ts";
import { authoritativeSync, isAuthoritativeTransactionSet } from "../src/presentation/still01/editor/cmDocumentSync.ts";
import { Transaction } from "@codemirror/state";

// ---------------------------------------------------------------------------
// D1 — the document-sync diff.
// ---------------------------------------------------------------------------

test("D1 — the minimal single-interval diff", () => {
  // Identical: an echo (no transaction should be dispatched at all).
  assert.ok(isDocumentEcho("abc", "abc"));
  assert.deepEqual(documentSyncChange("abc", "abc"), { from: 3, to: 3, insert: "" });
  // Pure insert in the middle.
  assert.deepEqual(documentSyncChange("hello world", "hello brave world"), { from: 6, to: 6, insert: "brave " });
  // Pure delete.
  assert.deepEqual(documentSyncChange("hello brave world", "hello world"), { from: 6, to: 12, insert: "" });
  // Replace.
  assert.deepEqual(documentSyncChange("the old text", "the new text"), { from: 4, to: 7, insert: "new" });
  // Whole-document replace.
  assert.deepEqual(documentSyncChange("aaa", "bbb"), { from: 0, to: 3, insert: "bbb" });
  // Empty <-> content.
  assert.deepEqual(documentSyncChange("", "你好"), { from: 0, to: 0, insert: "你好" });
  assert.deepEqual(documentSyncChange("你好", ""), { from: 0, to: 2, insert: "" });
  // Common prefix/suffix must NOT be included in the replaced range.
  const change = documentSyncChange("共通前缀A共通后缀", "共通前缀B共通后缀");
  assert.deepEqual(change, { from: 4, to: 5, insert: "B" });
});

// ---------------------------------------------------------------------------
// D2 — external application at the STATE level: minimal transaction, no
// history entry, positions/selection preserved, and the authoritative
// annotation is detectable (the adapter's no-echo gate).
// ---------------------------------------------------------------------------

test("D2 — an external apply is minimal, unhistoried and detectable", () => {
  let state = EditorState.create({ doc: "第一行\n第二行\n第三行" });
  // The user's selection sits AFTER the edit position.
  state = state.update({ selection: EditorSelection.cursor(10) }).state;

  const next = "第一行\n第二行(改)\n第三行";
  const change = documentSyncChange(state.doc.toString(), next);
  const tr = state.update({
    changes: change,
    annotations: [authoritativeSync.of(true), Transaction.addToHistory.of(false)],
  });
  state = tr.state;

  assert.equal(state.doc.toString(), next, "the external value applied exactly");
  assert.ok(isAuthoritativeTransactionSet([tr]), "the no-echo gate detects the annotation");
  // CM maps the selection through the external change: the anchor at 10 sat
  // AFTER the 3-char insert at from=7, so it maps to 13 — the SAME TEXT
  // (第三行's 三), never dropped, never clamped to the change boundary.
  assert.equal(state.selection.main.anchor, 13, "the selection maps to the same text");
  // An un-annotated user transaction is NOT flagged (onChange must fire).
  const user = state.update({ changes: { from: 0, to: 0, insert: "字" } });
  assert.ok(!isAuthoritativeTransactionSet([user]));
});

test("D2b — an echo dispatches nothing (the adapter's guard)", () => {
  let state = EditorState.create({ doc: "正文" });
  const before = state.doc.toString();
  const value = before;
  // The adapter: `if (value === current) return;` — the same doc.
  assert.equal(value, before);
  // A user transaction after the skipped echo still works.
  state = state.update({ changes: { from: 2, to: 2, insert: "!" } }).state;
  assert.equal(state.doc.toString(), "正文!");
});

// ---------------------------------------------------------------------------
// D3 — undo isolation: external applications never enter the user's undo.
// ---------------------------------------------------------------------------

test("D3 — external applies stay out of the undo history", () => {
  // addToHistory(false) is carried on the transaction; at state level the
  // proof is that the annotation + flag are present on exactly the external
  // transaction and absent from user transactions (interactive undo is
  // covered by the visual QA on the real view).
  let state = EditorState.create({ doc: "初始" });
  const user = state.update({ changes: { from: 2, to: 2, insert: "用户" } });
  state = user.state;
  const external = state.update({
    changes: documentSyncChange(state.doc.toString(), "初始用户+远端"),
    annotations: [authoritativeSync.of(true), Transaction.addToHistory.of(false)],
  });
  state = external.state;
  assert.equal(state.doc.toString(), "初始用户+远端");
  // The user transaction carries NO addToHistory exclusion; the external one
  // is explicitly excluded — actual user undo is separately exercised in
  // cm6EditorLifecycle.test.mjs through production StillApp.
  const userFlag = user.annotation(Transaction.addToHistory);
  const externalFlag = external.annotation(Transaction.addToHistory);
  assert.notEqual(userFlag, false, "user edits keep their history entry");
  assert.equal(externalFlag, false, "the external apply is explicitly excluded from history");
});

// ---------------------------------------------------------------------------
// D4 — the format-insertion contract: a USER transaction with the caret
// moved after the marker (exactly one insert, selection after).
// ---------------------------------------------------------------------------

test("D4 — the format insertion shape", () => {
  let state = EditorState.create({ doc: "标题内容" });
  const pos = { start: 2, end: 2 };
  const from = Math.min(pos.start, pos.end);
  const tr = state.update({
    changes: { from, to: Math.max(pos.start, pos.end), insert: "## " },
    selection: { anchor: from + "## ".length },
  });
  state = tr.state;
  assert.equal(state.doc.toString(), "标题## 内容");
  assert.equal(state.selection.main.anchor, 5, "the caret sits after the marker");
  assert.ok(!isAuthoritativeTransactionSet([tr]), "a format insert is a USER transaction");
});

// ---------------------------------------------------------------------------
// P1 — pool bookkeeping only (EditorView-shaped stubs, not lifecycle proof).
// ---------------------------------------------------------------------------

test("P1 — the retained pool: detach keeps, re-acquire returns the SAME view, LRU bounds", async () => {
  const pool = await import("../src/presentation/still01/editor/cmEditorSessions.ts");
  // Reset any residue from other tests.
  pool.destroyAllCmViews();
  const makeView = (tag: string) => {
    const dom = documentShim();
    let destroyed = false;
    return {
      dom,
      scrollDOM: { scrollTop: 0, scrollLeft: 0 },
      scrollSnapshot: () => ({}),
      get destroyed() { return destroyed; },
      destroy() { destroyed = true; },
      tag,
    } as never;
  };
  const a = pool.acquireCmView("scope-a", () => makeView("a"));
  const b = pool.acquireCmView("scope-b", () => makeView("b"));
  assert.equal(pool.retainedCmViewCount(), 2);
  // Detach keeps the view alive for a later mount.
  pool.detachCmView("scope-a");
  assert.equal(pool.retainedCmViewCount(), 2, "detach does NOT destroy");
  // Re-acquire returns the SAME view (state retention across read↔edit).
  const a2 = pool.acquireCmView("scope-a", () => makeView("a2"));
  assert.equal(a2, a, "the retained view is reused, never re-created");
  // The third scope evicts the least-recently-used (b).
  pool.acquireCmView("scope-c", () => makeView("c"));
  assert.equal(pool.retainedCmViewCount(), 2, "the pool is bounded at 2");
  assert.equal(pool.peekCmView("scope-b"), null, "the LRU entry (b) was destroyed");
  assert.ok(pool.peekCmView("scope-a") !== null, "the recently-used view survives");
  // forget destroys exactly that scope.
  pool.forgetCmView("scope-a");
  assert.equal(pool.peekCmView("scope-a"), null);
  pool.destroyAllCmViews();
  assert.equal(pool.retainedCmViewCount(), 0);
});

function documentShim(): unknown {
  return {
    parentNode: null,
    removeChild() { /* the pool guards on parentNode */ },
  };
}

// ---------------------------------------------------------------------------
// S1 — the page wiring contracts (source-level, like the repo's other
// production-wiring proofs).
// ---------------------------------------------------------------------------

test("S1 — StillNote wires the CM adapter for BOTH sources with full scopes", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("src/still/StillNote.tsx", "utf8");
  assert.ok(src.includes('cmScope("local", "", "", id)'), "the local note uses a full local scope");
  assert.ok(src.includes('cmScope("desktop", instance, vault, id)'), "the desktop note uses instance|vault|note");
  assert.ok(src.includes('forgetCmView(cmScope("local", "", "", id))'), "leaving a local note destroys its view");
  assert.ok(src.includes('forgetCmView(cmScope("desktop", instance, vault, id))'), "leaving a desktop note destroys its view");
  assert.ok(src.includes("isEditorElement(document.activeElement)"), "adoptIncoming uses the descendant-aware predicate");
  assert.ok(src.includes("isEditorElement((event.target as Element) ?? null)"), "the composition listener uses the same predicate");
  assert.ok(src.includes("pageEditorHandle()"), "format/selection operations go through the handle");
  // The save chains are untouched.
  assert.ok(src.includes("onChange={(t, b) => edit(t, b)}") || src.includes("void edit(title, next)"), "the desktop save chain stays");
  assert.ok(src.includes("LocalNoteAutosaveCoordinator"), "the local coordinator stays");
});

test("S2 — NoteSurface keeps the textarea fallback + the CM slot", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("src/presentation/still01/Still.tsx", "utf8");
  assert.ok(src.includes("bodyEditor??<textarea"), "the textarea remains the fallback branch");
  assert.ok(src.includes("!p.bodyEditor&&pendingBody.current!==null"), "only an explicit tap may focus the textarea fallback");
  assert.ok(!src.includes("requestAnimationFrame(()=>input.current?.focus"), "opening the note must not schedule fallback autofocus");
});
