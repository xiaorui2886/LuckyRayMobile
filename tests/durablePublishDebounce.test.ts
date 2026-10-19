import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { DurablePublishDebounce } from "../src/services/durablePublishDebounce.ts";

// Execute the actual production edit closure, not a copied save implementation.
// Only its React refs/setters and IPC boundary are isolated; no DOM/LAN claim.
const noteSource = ts.createSourceFile("StillNote.tsx", readFileSync(new URL("../src/still/StillNote.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const desktopNote = noteSource.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "DesktopStillNote") as ts.FunctionDeclaration;
const editSource = desktopNote.body?.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "edit");
assert.ok(editSource, "production DesktopStillNote.edit must exist");
const editCode = ts.transpileModule(editSource.getText(noteSource), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

function editorHarness() {
  const saves: Array<{args: any; resolve: (value: any) => void; reject: (error: Error) => void}> = [];
  const state = { title: "", content: "", note: null as any, message: "", saving: false };
  const owner = { current: 1 };
  const failed = { current: false };
  const pending = { current: new Set<Promise<unknown>>() };
  const projections: any[] = [];
  let leaseCommits = 0;
  let durable: any = null;
  const published: Array<{at: number; generation: number; content: string}> = [];
  const publisher = new DurablePublishDebounce(() => {
    assert.ok(durable, "a wake must have a successful durable save");
    published.push({ at: Date.now(), generation: durable.generation, content: durable.content });
  });
  const edit = runInNewContext(`${editCode}\nedit;`, {
    api: { contentNoteEdit: (args: any) => new Promise((resolve, reject) => saves.push({ args, resolve, reject })) },
    owner, failed, pending, navigationActivity: { current: 0 },
    editGeneration: { current: 0 }, epoch: { current: 7 }, displayedRevision: { current: "r1" },
    publisher: { current: publisher }, editingLease: { current: { committed: () => leaseCommits++ } },
    session2: { projection: { upsert: (value: any) => projections.push(value) } },
    draft: { current: { title: "", content: "" } },
    setTitle: (value: string) => { state.title = value; },
    setContent: (value: string) => { state.content = value; },
    setNote: (value: any) => { state.note = value; },
    setMessage: (value: string) => { state.message = value; },
    setSaving: (value: boolean) => { state.saving = value; },
    instance: "synthetic-instance", vault: "synthetic-vault", id: "synthetic-note",
    parentOfSafe: () => "Docs", safePreviewLine: (value: string) => value,
  }) as (title: string, content: string) => Promise<boolean>;
  return {
    edit, state, owner, failed, pending, projections, publisher, published,
    leaseCommits: () => leaseCommits,
    commit: async (index: number) => {
      const save = saves[index];
      durable = { ...save.args, dirty: true, relativePath: "Docs/note.md" };
      save.resolve(durable);
      await settle();
    },
    reject: async (index: number) => { saves[index].reject(new Error("synthetic local save failure")); await settle(); },
  };
}

test("durable receipts continuously one input behind still wake within two seconds", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const publishedAt: number[] = [];
  const publisher = new DurablePublishDebounce(() => publishedAt.push(Date.now()));
  let previous = publisher.begin();

  for (let i = 0; i < 12; i++) {
    t.mock.timers.tick(250);
    const current = publisher.begin();
    publisher.committed(previous);
    previous = current;
    if (i < 8) assert.deepEqual(publishedAt, []);
  }

  // First durable receipt is at 250ms; subsequent typing cannot move its bound.
  assert.deepEqual(publishedAt, [2250]);
  publisher.dispose();
});

test("production edit accepts durable receipts one input behind without adopting older UI state", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const editor = editorHarness();
  const requests = [editor.edit("Title", "draft-0")];
  for (let i = 1; i <= 12; i++) {
    t.mock.timers.tick(250);
    requests.push(editor.edit("Title", `draft-${i}`));
    await editor.commit(i - 1);
  }
  assert.deepEqual(editor.published, [{ at: 2250, generation: 8, content: "draft-7" }]);
  assert.equal(editor.state.content, "draft-12");
  assert.equal(editor.state.note, null);
  assert.equal(editor.leaseCommits(), 0);
  assert.equal(editor.projections.length, 0);
  assert.equal(editor.pending.current.size, 1);

  await editor.commit(12);
  t.mock.timers.tick(399);
  assert.equal(editor.published.length, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(editor.published[1], { at: 3400, generation: 13, content: "draft-12" });
  assert.equal(editor.state.note.content, "draft-12");
  assert.equal(editor.leaseCommits(), 1);
  assert.equal(editor.projections.length, 1);
  assert.equal(editor.pending.current.size, 0);
  assert.equal(editor.state.saving, false);
  assert.ok((await Promise.all(requests)).every(Boolean));
  t.mock.timers.tick(3000);
  assert.equal(editor.published.length, 2);
  editor.publisher.dispose();
});

test("raw input and receipts for inputs that never began cannot schedule a wake", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let wakes = 0;
  const publisher = new DurablePublishDebounce(() => wakes++);
  const generation = publisher.begin();
  t.mock.timers.tick(10000);
  publisher.committed(generation + 1);
  publisher.committed(0);
  t.mock.timers.tick(3000);
  assert.equal(wakes, 0);
  publisher.dispose();
});

test("dispose clears scheduled progress and fences late receipts when the publisher is reused", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let wakes = 0;
  const publisher = new DurablePublishDebounce(() => wakes++);
  const old = publisher.begin();
  publisher.committed(old);
  const oldPending = publisher.begin();
  publisher.dispose();
  publisher.committed(old);
  publisher.committed(oldPending);
  t.mock.timers.tick(5000);
  assert.equal(wakes, 0);

  const saved = publisher.begin();
  const newest = publisher.begin();
  publisher.committed(oldPending);
  publisher.committed(saved);
  t.mock.timers.tick(1999);
  assert.equal(wakes, 0);
  t.mock.timers.tick(1);
  assert.equal(wakes, 1);
  publisher.committed(newest);
  t.mock.timers.tick(400);
  assert.equal(wakes, 2);
  publisher.dispose();
});

test("out-of-order and duplicate receipts cannot postpone quiet publish or rearm published progress", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let wakes = 0;
  const publisher = new DurablePublishDebounce(() => wakes++);
  const first = publisher.begin();
  const second = publisher.begin();
  const latest = publisher.begin();
  publisher.committed(second);
  publisher.committed(latest);
  t.mock.timers.tick(100);
  publisher.committed(first);
  publisher.committed(second);
  t.mock.timers.tick(299);
  assert.equal(wakes, 0);
  t.mock.timers.tick(1);
  assert.equal(wakes, 1);
  publisher.committed(latest);
  publisher.committed(first);
  t.mock.timers.tick(3000);
  assert.equal(wakes, 1);
  publisher.dispose();
});

test("older production success can wake durable progress without clearing the latest save failure", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const editor = editorHarness();
  const older = editor.edit("Title", "durable-older");
  const latest = editor.edit("Title", "unsaved-latest");
  await editor.reject(1);
  assert.equal(await latest, false);
  const failureMessage = editor.state.message;
  assert.ok(failureMessage);
  assert.equal(editor.failed.current, true);
  t.mock.timers.tick(3000);
  assert.deepEqual(editor.published, []);

  await editor.commit(0);
  assert.equal(await older, true);
  t.mock.timers.tick(1999);
  assert.deepEqual(editor.published, []);
  t.mock.timers.tick(1);
  assert.deepEqual(editor.published, [{ at: 5000, generation: 1, content: "durable-older" }]);
  assert.equal(editor.state.content, "unsaved-latest");
  assert.equal(editor.state.message, failureMessage);
  assert.equal(editor.failed.current, true);
  assert.equal(editor.state.note, null);
  assert.equal(editor.projections.length, 0);
  assert.equal(editor.leaseCommits(), 0);
  assert.equal(editor.pending.current.size, 0);
  editor.publisher.dispose();
});

test("production completion from a retired owner cannot wake or certify the successor", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const editor = editorHarness();
  const old = editor.edit("Old", "old-session");
  editor.owner.current++;
  editor.publisher.dispose();
  const current = editor.edit("Current", "new-session");
  await editor.commit(0);
  assert.equal(await old, true);
  t.mock.timers.tick(2500);
  assert.equal(editor.published.length, 0);
  assert.equal(editor.state.content, "new-session");
  assert.equal(editor.state.note, null);
  assert.equal(editor.projections.length, 0);
  assert.equal(editor.leaseCommits(), 0);

  await editor.commit(1);
  assert.equal(await current, true);
  t.mock.timers.tick(400);
  assert.equal(editor.published.length, 1);
  assert.equal(editor.published[0].content, "new-session");
  assert.equal(editor.state.note.content, "new-session");
  editor.publisher.dispose();
});
