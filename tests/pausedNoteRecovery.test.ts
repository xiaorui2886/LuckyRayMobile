import test from "node:test";
import assert from "node:assert/strict";
import { resumePausedDraft, pausedRecoveryError, openNoteDeletion } from "../src/services/pausedNoteRecovery.ts";
import { readFileSync } from "node:fs";

test("explicit recovery submits the captured local intent and publishes only its confirmed receipt", async () => {
  let sent: unknown, shown: unknown;
  const scope = { instance: "A", vault: "v", id: "n" };
  const draft = { dirty: true, operationPaused: true, pausedOperationId: "old", editorEpoch: 2, draftGeneration: 9 };
  assert.equal(await resumePausedDraft(scope, draft, {
    isCurrent: () => true,
    resume: async input => { sent = input; return { dirty: true, operationPaused: false }; },
    publish: value => { shown = value; },
  }), true);
  assert.deepEqual(sent, { ...scope, pausedOpId: "old", epoch: 2, generation: 9 });
  assert.deepEqual(shown, { dirty: true, operationPaused: false });
  assert.equal(draft.pausedOperationId, "old");
});

test("invalid or retired drafts never request recovery and a late receipt cannot reset a newer editor", async () => {
  const scope = { instance: "A", vault: "v", id: "n" };
  const valid = { dirty: true, operationPaused: true, pausedOperationId: "old", editorEpoch: 2, draftGeneration: 9 };
  let calls = 0;
  for (const bad of [null,{...valid,editorEpoch:0},{...valid,draftGeneration:-1},{...valid,titleNeedsCorrection:true},{...valid,conflictDocument:{}},{...valid,operationPaused:false},{...valid,dirty:false},{...valid,deleted:true},{...valid,pausedOperationId:undefined}]) {
    assert.equal(await resumePausedDraft(scope,bad,{isCurrent:()=>true,resume:async()=>{calls++;},publish:()=>assert.fail("no publish")}),false);
  }
  assert.equal(calls,0);
  let live = true, release!: (value: unknown) => void, publishes = 0;
  const pending = resumePausedDraft(scope,valid,{isCurrent:()=>live,resume:()=>new Promise(ok=>{release=ok;}),publish:()=>{publishes++;}});
  live = false;
  release({content:"old receipt"});
  assert.equal(await pending,false);
  assert.equal(publishes,0);
});

test("unknown recovery outcomes expose no private raw errors and never imply automatic replay", async () => {
  assert.match(pausedRecoveryError("CONTENT_ATTACHMENTS_PENDING"),/附件/);
  assert.match(pausedRecoveryError("CONTENT_OPERATION_PENDING"),/尚未确认.*笔记未删除/);
  assert.match(pausedRecoveryError("CONTENT_OPERATION_PAUSED"),/笔记未删除.*草稿和原请求已保留/);
  const raw = "private C:/secret body token";
  assert(!pausedRecoveryError(raw).includes(raw));
  assert.match(pausedRecoveryError(raw),/不会自动重复/);
  let calls = 0;
  await assert.rejects(resumePausedDraft({instance:"A",vault:"v",id:"n"},{dirty:true,operationPaused:true,pausedOperationId:"old",editorEpoch:1,draftGeneration:1},{isCurrent:()=>true,resume:async()=>{calls++;throw Error(raw);},publish:()=>assert.fail()}));
  assert.equal(calls,1);
});

test("the actual normal-source UI uses the tested explicit recovery caller and native registers only its local command", () => {
  const ui = readFileSync(new URL("../src/still/StillNote.tsx",import.meta.url),"utf8");
  assert.match(ui,/await resumePausedDraft\(/);
  assert.match(ui,/resume: input => api\.contentNoteResumePaused\(input\)/);
  assert.match(ui,/使用当前草稿建立新请求/);
  assert.match(ui,/openNoteDeletion\(note, setSheet\)/);
  assert.match(ui,/code === "CONTENT_OPERATION_PAUSED" \|\| code === "CONTENT_OPERATION_PENDING"/);
  assert.match(ui,/message\.includes\("笔记未删除"\)/);
  const native = readFileSync(new URL("../src-tauri/src/content/notes.rs",import.meta.url),"utf8");
  assert.match(native,/pub\(crate\) async fn content_note_resume_paused/);
  assert.match(native,/Source::capture_expected\(&state, &instance\)/);
  assert.match(native,/pub\(crate\) async fn content_note_delete[\s\S]*?SYNC_GATE[\s\S]*?db\.content_delete/);
  const ci = readFileSync(new URL("../.github/workflows/ci-lite.yml",import.meta.url),"utf8");
  assert(ci.includes("tests/pausedNoteRecovery.test.ts"));
});

test("normal delete intent sends an actively paused draft to its reachable source state, not delete confirmation", () => {
  const shown: string[] = [];
  const open = (sheet: "state" | "delete") => shown.push(sheet);
  const paused = { dirty:true,operationPaused:true,content:"retained body" };
  openNoteDeletion(paused,open);
  assert.deepEqual(shown,["state"]);
  assert.equal(paused.content,"retained body");
  openNoteDeletion({...paused,operationPaused:false},open);
  assert.deepEqual(shown,["state","delete"]);
});
