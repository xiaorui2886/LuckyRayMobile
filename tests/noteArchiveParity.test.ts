// tests/noteArchiveParity.test.ts
// STITCH-R6-PARITY-CLOSURE-R1 — Local Note Archive & Parity Regression Guard.
//
// Regressions guarded against:
//  1. UI Reachability: Local NoteEditor must expose an archive/unarchive action
//     button toggling between "归档" and "恢复归档", calling localNoteSetFlags
//     and invalidating consumers via publishAfter("note", ...).
//  2. State Lifecycle & Filter Linkage: Knowledge's archived filter mode and active
//     filter mode must remain linked with localNoteSetFlags without disconnect.
//  3. SearchField cleanliness: No inverted or dead focused state/effects.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { filterKnowledgeNotes } from "../src/services/knowledgeFilter.ts";

const ROOT = join(import.meta.dirname, "..");
const noteEditorSource = readFileSync(join(ROOT, "src", "screens", "NoteEditor.tsx"), "utf8");
const uiSource = readFileSync(join(ROOT, "src", "components", "ui.tsx"), "utf8");
const knowledgeSource = readFileSync(join(ROOT, "src", "screens", "Knowledge.tsx"), "utf8");

test("noteArchiveParity — NoteEditor exposes archive / unarchive UI and uses localNoteSetFlags + publishAfter", () => {
  // 1. Must load archived state from localNoteGet
  assert.match(
    noteEditorSource,
    /setArchived\(Boolean\(n\.archived\)\)/,
    "NoteEditor must hydrate archived state from localNoteGet"
  );

  // 2. Must call api.localNoteSetFlags with { archived: !archived } wrapped in publishAfter("note", ...)
  assert.match(
    noteEditorSource,
    /publishAfter\(\s*"note"\s*,\s*api\.localNoteSetFlags\([^)]*\{\s*archived:\s*!archived\s*\}\s*\)\s*\)/,
    "toggleLocalArchived must commit via api.localNoteSetFlags and publishAfter('note', ...)"
  );

  // 3. Low-frequency action row must expose the button toggling between '归档' and '恢复归档'
  assert.match(
    noteEditorSource,
    /\{archived\s*\?\s*"恢复归档"\s*:\s*"归档"\}/,
    "Action row button must render '恢复归档' when archived=true, and '归档' when archived=false"
  );

  // 4. Knowledge row geometry must NOT be contaminated with list action buttons (keeps R6 calibrated row height)
  assert.doesNotMatch(
    knowledgeSource,
    /className="row-actions"/,
    "Knowledge screen must not re-introduce .row-actions into note rows to preserve R6 geometry"
  );
});

test("noteArchiveParity — SearchField does not contain inverted !autoFocus or dead focused state", () => {
  assert.doesNotMatch(
    uiSource,
    /if\s*\(!autoFocus\)\s*setFocused\(true\)/,
    "SearchField must not contain inverted !autoFocus effect"
  );
  assert.doesNotMatch(
    uiSource,
    /focused\s*\?\s*null\s*:\s*null/,
    "SearchField must not contain dead focused dummy expression"
  );
});

test("noteArchiveParity — Knowledge filter and archive/restore state transition end-to-end linkage", () => {
  type LocalNote = {
    noteId: string;
    title: string;
    content?: string;
    archived: boolean;
    pinned?: boolean;
    favorite?: boolean;
    updatedAt?: string;
  };

  const sampleNote: LocalNote = {
    noteId: "note-archive-test-1",
    title: "测试归档流笔记",
    content: "验证归档与恢复功能无断链",
    archived: false,
    pinned: false,
    favorite: false,
  };

  // Phase 1: Unarchived note appears in active Knowledge list, not in archived list
  const activeRes1 = filterKnowledgeNotes({
    localNotes: [sampleNote],
    desktopNotes: [],
    filterMode: "local",
    isPaired: false,
  });
  assert.equal(activeRes1.displayLocalNotes.length, 1);
  assert.equal(activeRes1.displayLocalNotes[0].noteId, "note-archive-test-1");

  const archivedRes1 = filterKnowledgeNotes({
    localNotes: [sampleNote],
    desktopNotes: [],
    filterMode: "archived",
    isPaired: false,
  });
  assert.equal(archivedRes1.displayLocalNotes.length, 0, "Unarchived note must not appear in archived list");

  // Phase 2: User performs archive in NoteEditor UI
  // NoteEditor sets archived = true, updates backend via localNoteSetFlags, and notifies store
  sampleNote.archived = true;

  // Active view now hides the archived note
  const activeRes2 = filterKnowledgeNotes({
    localNotes: [sampleNote],
    desktopNotes: [],
    filterMode: "local",
    isPaired: false,
  });
  assert.equal(activeRes2.displayLocalNotes.length, 0, "Archived note must disappear from active local notes");

  // Archived view now displays the note
  const archivedRes2 = filterKnowledgeNotes({
    localNotes: [sampleNote],
    desktopNotes: [],
    filterMode: "archived",
    isPaired: false,
  });
  assert.equal(archivedRes2.displayLocalNotes.length, 1, "Archived note must appear in archived list");
  assert.equal(archivedRes2.displayLocalNotes[0].noteId, "note-archive-test-1");
  assert.equal(archivedRes2.subtitleText, "已归档笔记");

  // Phase 3: User taps note from archived list -> opens NoteEditor -> taps "恢复归档"
  // NoteEditor sets archived = false, updates backend via localNoteSetFlags, and notifies store
  sampleNote.archived = false;

  // Active view once again displays the restored note
  const activeRes3 = filterKnowledgeNotes({
    localNotes: [sampleNote],
    desktopNotes: [],
    filterMode: "local",
    isPaired: false,
  });
  assert.equal(activeRes3.displayLocalNotes.length, 1, "Restored note must re-appear in active local notes");
  assert.equal(activeRes3.displayLocalNotes[0].noteId, "note-archive-test-1");

  // Archived view is empty once again
  const archivedRes3 = filterKnowledgeNotes({
    localNotes: [sampleNote],
    desktopNotes: [],
    filterMode: "archived",
    isPaired: false,
  });
  assert.equal(archivedRes3.displayLocalNotes.length, 0, "Restored note must leave archived list");
});
