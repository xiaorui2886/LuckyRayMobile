// tests/filterDraft.test.ts — INTERACTION-CLOSURE-R1 §6.1 behavioral tests.
//
// The FilterDraft controller is the REAL state machine behind the Knowledge
// and Library filter sheets. These tests exercise its behavior (not source
// strings): open snapshots applied, draft edits are invisible to applied,
// commit promotes + closes, cancel/backdrop discards, reopen shows applied,
// reset returns defaults only in the draft.
import test from "node:test";
import assert from "node:assert/strict";
import {
  FilterDraft,
  defaultLibraryFilter,
  defaultKnowledgeFilter,
  type LibraryFilterState,
  type KnowledgeFilterState,
} from "../src/services/filterDraft.ts";

test("filter draft — open snapshots applied; edits touch only the draft", () => {
  const d = new FilterDraft<LibraryFilterState>(defaultLibraryFilter);
  const first = d.begin();
  assert.deepEqual(first, { kind: "全部", favoriteOnly: false, archivedOnly: false, sort: "recent", view: "grid", tag: "" });
  d.edit({ kind: "图片", favoriteOnly: true });
  assert.equal(d.getDraft().kind, "图片");
  assert.equal(d.getDraft().favoriteOnly, true);
  // Applied unchanged while the sheet is open.
  assert.equal(d.getApplied().kind, "全部");
  assert.equal(d.getApplied().favoriteOnly, false);
});

test("filter draft — commit promotes the draft and closes", () => {
  const d = new FilterDraft<LibraryFilterState>(defaultLibraryFilter);
  d.begin();
  d.edit({ kind: "视频", sort: "name", view: "list" });
  const applied = d.commit();
  assert.deepEqual(applied, { kind: "视频", favoriteOnly: false, archivedOnly: false, sort: "name", view: "list", tag: "" });
  assert.equal(d.isOpen(), false);
  assert.deepEqual(d.getApplied(), applied);
});

test("filter draft — cancel/backdrop discards; applied unchanged; reopen shows applied", () => {
  const d = new FilterDraft<LibraryFilterState>(defaultLibraryFilter);
  d.begin();
  d.edit({ kind: "文档" });
  d.commit();
  // Second open: draft starts from applied (文档).
  d.begin();
  assert.equal(d.getDraft().kind, "文档");
  d.edit({ kind: "音频", archivedOnly: true });
  d.cancel();
  assert.equal(d.getApplied().kind, "文档", "cancel keeps the last applied");
  assert.equal(d.getApplied().archivedOnly, false, "cancel drops un-committed edits");
  // Third open: draft from applied again — NOT the cancelled edits.
  d.begin();
  assert.equal(d.getDraft().kind, "文档");
  assert.equal(d.getDraft().archivedOnly, false);
});

test("filter draft — reset restores defaults IN THE DRAFT only", () => {
  const d = new FilterDraft<KnowledgeFilterState>(defaultKnowledgeFilter);
  d.begin();
  d.edit({ mode: "archived", tag: "work" });
  d.commit();
  d.begin();
  d.edit({ mode: "pinned" });
  d.reset();
  assert.deepEqual(d.getDraft(), { mode: "local", sort: "recent", tag: "" });
  assert.equal(d.getApplied().mode, "archived", "reset alone must not touch applied");
  const applied = d.commit();
  assert.equal(applied.mode, "local", "commit after reset applies defaults");
});

test("filter draft — sequence mirrors the real user path (open→edit→cancel→open→edit→apply)", () => {
  const d = new FilterDraft<KnowledgeFilterState>(defaultKnowledgeFilter);
  // round 1: cancel
  d.begin(); d.edit({ mode: "pinned" }); d.cancel();
  // round 2: apply
  d.begin(); d.edit({ mode: "favorite" }); d.commit();
  // round 3: reopen shows applied favorite
  d.begin();
  assert.equal(d.getDraft().mode, "favorite");
  d.cancel();
  assert.equal(d.getApplied().mode, "favorite");
});
