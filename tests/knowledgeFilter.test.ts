// Node.js test for Knowledge Filter semantics (M2.8 P1-3)
import test from "node:test";
import assert from "node:assert/strict";
import { filterKnowledgeNotes } from "../src/services/knowledgeFilter.ts";

const sampleLocal = [
  { noteId: "note-1", title: "Local Active 1", archived: false, pinned: false, favorite: true },
  { noteId: "note-2", title: "Local Pinned 2", archived: false, pinned: true, favorite: false },
  { noteId: "note-3", title: "Local Archived 3", archived: true, pinned: false, favorite: false },
];

const sampleDesktop = [
  { noteId: "desk-1", title: "Desktop Note 1", relativePath: "p1.md" },
  { noteId: "desk-2", title: "Desktop Note 2", relativePath: "p2.md" },
];

test("filterKnowledgeNotes — all mode with paired desktop", () => {
  const res = filterKnowledgeNotes({
    localNotes: sampleLocal,
    desktopNotes: sampleDesktop,
    filterMode: "all",
    isPaired: true,
  });

  assert.equal(res.displayLocalNotes.length, 2);
  assert.equal(res.displayDesktopNotes.length, 2);
  assert.equal(res.subtitleText, "本机 + Desktop");
});

test("filterKnowledgeNotes — local mode only shows active local notes", () => {
  const res = filterKnowledgeNotes({
    localNotes: sampleLocal,
    desktopNotes: sampleDesktop,
    filterMode: "local",
    isPaired: true,
  });

  assert.equal(res.displayLocalNotes.length, 2);
  assert.equal(res.displayDesktopNotes.length, 0, "Desktop notes must be excluded in local mode");
  assert.equal(res.subtitleText, "本机独享");
});

test("filterKnowledgeNotes — desktop mode only shows desktop notes", () => {
  const res = filterKnowledgeNotes({
    localNotes: sampleLocal,
    desktopNotes: sampleDesktop,
    filterMode: "desktop",
    isPaired: true,
  });

  assert.equal(res.displayLocalNotes.length, 0, "Local notes must be excluded in desktop mode");
  assert.equal(res.displayDesktopNotes.length, 2);
  assert.equal(res.subtitleText, "Desktop 同步笔记");
});

test("filterKnowledgeNotes — pinned mode filters active pinned local notes", () => {
  const res = filterKnowledgeNotes({
    localNotes: sampleLocal,
    desktopNotes: sampleDesktop,
    filterMode: "pinned",
    isPaired: true,
  });

  assert.equal(res.displayLocalNotes.length, 1);
  assert.equal(res.displayLocalNotes[0].noteId, "note-2");
  assert.equal(res.displayDesktopNotes.length, 0);
  assert.equal(res.subtitleText, "已置顶笔记");
});

test("filterKnowledgeNotes — favorite mode shows active favorite local notes only", () => {
  const res = filterKnowledgeNotes({
    localNotes: sampleLocal,
    desktopNotes: sampleDesktop,
    filterMode: "favorite",
    isPaired: true,
  });

  assert.equal(res.displayLocalNotes.length, 1);
  assert.equal(res.displayLocalNotes[0].noteId, "note-1");
  assert.equal(res.displayDesktopNotes.length, 0);
  assert.equal(res.subtitleText, "已收藏笔记");
});

test("filterKnowledgeNotes — archived mode shows archived local notes only", () => {
  const res = filterKnowledgeNotes({
    localNotes: sampleLocal,
    desktopNotes: sampleDesktop,
    filterMode: "archived",
    isPaired: true,
  });

  assert.equal(res.displayLocalNotes.length, 1);
  assert.equal(res.displayLocalNotes[0].noteId, "note-3");
  assert.equal(res.displayDesktopNotes.length, 0);
  assert.equal(res.subtitleText, "已归档笔记");
});
