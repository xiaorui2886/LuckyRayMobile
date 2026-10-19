import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SyncCoordinator } from "../src/services/syncCoordinator.ts";
import { KnowledgeLiveSync } from "../src/services/knowledgeLiveSync.ts";
import { DurablePublishDebounce } from "../src/services/durablePublishDebounce.ts";
import type { ChangeFeedClient } from "../src/services/companionServices/changeFeedClient.ts";

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("idle hint wakes existing sync; in-flight burst retains exactly one follow-up", async () => {
  let calls = 0;
  let finish!: () => void;
  const c = new SyncCoordinator(() => {
    calls++;
    return calls === 1 ? new Promise(resolve => { finish = () => resolve({}); }) : Promise.resolve({});
  }, { foundationBlocked: false, contentOnly: true });
  c.wake();
  assert.equal(calls, 1);
  for (let i = 0; i < 20; i++) c.wake();
  assert.equal(calls, 1);
  finish();
  await turn();
  assert.equal(calls, 2);
  await turn();
  assert.equal(calls, 2);
  c.dispose();
});

test("busy projection is scoped and clears on success and owner retirement", async () => {
  const busy = { instanceId: "A", vaultId: "v", desktopBusyNoteIds: ["n"] };
  let result = busy;
  const c = new SyncCoordinator(async () => result, { foundationBlocked: false, contentOnly: true });
  c.setOwner("A");
  await c.run();
  assert.deepEqual(c.snapshot().desktopBusyNotes, [JSON.stringify(["A", "v", "n"])]);
  result = { ...busy, desktopBusyNoteIds: [] };
  await c.run();
  assert.deepEqual(c.snapshot().desktopBusyNotes, []);
  result = busy;
  await c.run();
  c.setOwner("B");
  assert.deepEqual(c.snapshot().desktopBusyNotes, []);
  c.dispose();
});

test("late old-owner sync result cannot repopulate busy projection", async () => {
  let finish!: (value: unknown) => void;
  const c = new SyncCoordinator(() => new Promise(resolve => { finish = resolve; }), { foundationBlocked: false, contentOnly: true });
  c.setOwner("A");
  const pending = c.run();
  c.setOwner("B");
  finish({ instanceId: "A", vaultId: "v", desktopBusyNoteIds: ["n"] });
  await pending;
  assert.deepEqual(c.snapshot().desktopBusyNotes, []);
  c.dispose();
});

test("late retired-owner failure cannot schedule an unpaired retry", async () => {
  let reject!: (value: unknown) => void;
  const c = new SyncCoordinator(() => new Promise((_resolve, fail) => { reject = fail; }), { foundationBlocked: false, contentOnly: true });
  c.setOwner("A");
  const pending = c.run();
  c.setOwner("");
  reject(new Error("CONTENT_OFFLINE"));
  await pending;
  assert.equal(c.snapshot().status, "idle");
  assert.equal(c.snapshot().error, null);
  assert.equal(c["retryTimer"], null);
  c.dispose();
});

test("400ms publish starts only after local commit and coalesces new edits", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const p = new DurablePublishDebounce(() => calls++);
  const old = p.begin();
  t.mock.timers.tick(1000); // unresolved/failed local save never commits
  assert.equal(calls, 0);
  const current = p.begin();
  p.committed(old); // stale local completion
  t.mock.timers.tick(1000);
  assert.equal(calls, 0);
  p.committed(current);
  t.mock.timers.tick(399);
  assert.equal(calls, 0);
  const newer = p.begin(); // typing cancels previous publish
  t.mock.timers.tick(1);
  assert.equal(calls, 0);
  p.committed(newer);
  t.mock.timers.tick(400);
  assert.equal(calls, 1);
  p.committed(newer);
  p.dispose();
  t.mock.timers.tick(400);
  assert.equal(calls, 1);
});

test("app hint drain uses one feed, burst wakes once, unavailable feed remains harmless", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let hints: any[] = [];
  const starts: string[] = [];
  let stops = 0;
  let wakes = 0;
  const feed = {
    stop: async () => { stops++; },
    start: async (instance: string) => { starts.push(instance); },
    boundGeneration: () => 1,
    refreshMode: async () => "hints",
    readHints: async () => { const batch = hints; hints = []; return batch; },
  } as unknown as ChangeFeedClient;
  const live = new KnowledgeLiveSync(feed, () => wakes++);
  const retire = live.bind("A");
  await turn();
  hints = [{ kind: "knowledgeChanged", vaultId: "v", cursor: "k:999" }, { kind: "knowledgeChanged", vaultId: "v", cursor: "k:1000" }];
  t.mock.timers.tick(400);
  await turn();
  assert.equal(wakes, 1);
  assert.deepEqual(starts, ["A"]);
  t.mock.timers.tick(400);
  await turn();
  assert.equal(wakes, 1);
  const retireB = live.bind("B");
  retire(); // old teardown must not retire B
  await turn();
  assert.deepEqual(starts, ["A", "B"]);
  retireB();
  t.mock.timers.tick(400);
  await turn();
  assert.equal(stops, 3);
});

test("retired drain cannot wake successor even when its old response arrives late", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let finish!: (hints: unknown[]) => void;
  let wakes = 0;
  const live = new KnowledgeLiveSync({
    stop: async () => {}, start: async () => {}, boundGeneration: () => 1,
    refreshMode: async () => "hints",
    readHints: () => new Promise(resolve => { finish = resolve; }),
  } as unknown as ChangeFeedClient, () => wakes++);
  const retire = live.bind("A");
  await turn();
  t.mock.timers.tick(400);
  await turn();
  retire();
  finish([{ kind: "knowledgeChanged", vaultId: "v", cursor: "k:1" }]);
  await turn();
  assert.equal(wakes, 0);
});

test("unavailable hint worker does not manufacture wakes", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let wakes = 0;
  const live = new KnowledgeLiveSync({
    stop: async () => {}, start: async () => {}, boundGeneration: () => null,
    refreshMode: async () => "polling", readHints: async () => [],
  } as unknown as ChangeFeedClient, () => wakes++);
  const retire = live.bind("A");
  await turn();
  t.mock.timers.tick(400);
  await turn();
  assert.equal(wakes, 0);
  retire();
});

test("production wiring reuses Knowledge composition, fallback and successful save gate", () => {
  const session = read("src/still/kit/knowledgeSession.ts");
  assert.equal(session.match(/= createProductionServices\(\)/g)?.length, 1);
  assert.match(session, /knowledgeChangeFeed = productionServices.changeFeed/);
  const app = read("src/App.tsx");
  assert.match(app, /knowledgeLiveSync.bind\(instance\)/);
  assert.match(app, /document.visibilityState === "visible"[\s\S]*?5000/);
  const note = read("src/still/StillNote.tsx");
  const edit = note.slice(note.indexOf("function edit(nextTitle"), note.indexOf("async function resolve(copy"));
  assert.ok(edit.indexOf("publisher.current.committed") > edit.indexOf(".then((value)"));
  assert.match(edit, /session === owner.current && generation === editGeneration.current/);
  const create = read("src/still/StillCollection.tsx").split("async function createDesktopNote()")[1].split("// C: quick actions")[0];
  assert.doesNotMatch(create, /syncCoordinator\.(trigger|wake)/);
  assert.match(note, /电脑正在编辑 · 你的修改已保存在手机，电脑保存后会自动继续同步/);
  const rust = read("src-tauri/src/content/notes.rs");
  const busy = rust.split('outcome == Outcome::DesktopBusy')[1].split("} else {")[0];
  assert.match(busy, /desktop_busy_note_ids.push/);
  assert.doesNotMatch(busy, /content_conflict|content_ack|content_resolve/);
});
