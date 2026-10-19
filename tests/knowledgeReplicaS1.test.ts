import test from "node:test";
import assert from "node:assert/strict";
import { KnowledgeBrowseController } from "../src/still/kit/knowledgeBrowseController.ts";
import { KnowledgeDirectoryController } from "../src/still/kit/knowledgeDirectoryController.ts";
import { loadPreviewStore } from "../src/still/kit/notePreview.ts";
import { api } from "../src/services/client.ts";
import { DurablePublishDebounce } from "../src/services/durablePublishDebounce.ts";
import { canAdoptKnowledgeBody } from "../src/services/knowledgeIncomingDraft.ts";
import type { KnowledgeReplicaLibrary } from "../src/services/knowledgeReplica.ts";
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 8; i++) await turn(); };
function fixture() {
  let library: KnowledgeReplicaLibrary = {instanceId: "A", vaultId: "v", name: "Library", confirmed: true, paused: false, waitingCurrent: false, writeState: "granted", metadataReady: true, total: 112, ready: 112, failed: 0, unverified: 0};
  const rows = Array.from({length: 112}, (_, i) => ({instanceId: "A", vaultId: "v", noteId: `n${i}`, title: `笔记 ${i}`, relativePath: `Docs/${i}.md`, revision: "r1", content: i === 100 ? "正文长尾词" : "正文"}));
  const calls: Array<{instance: string; vault: string; q: string; page: number}> = [];
  let discovery = 0;
  const deps: any = {registry: {refreshAdopting: async () => {discovery++; return {};}, invalidate() {}, operation: () => ({state: "implemented"})}, knowledge: {vaults: async () => ({items: [{vaultId: "v", activeInDesktop: true, displayName: "Library", writeGranted: true}]}), registeredList: async () => {throw new Error("replica must not use a second network list");}}, debounceMs: 1,
    replica: {libraries: async (instance: string) => instance === "A" ? [library] : [], notes: async (instance: string, vault: string, q: string, page: number) => {calls.push({instance, vault, q, page}); const all = rows.filter(r => `${r.title} ${r.content}`.includes(q)); return {items: all.slice((page - 1) * 50, page * 50), hasMore: page * 50 < all.length};}}};
  const ctrl = new KnowledgeBrowseController(deps);
  return {ctrl, deps, rows, calls, library, discovery: () => discovery, setLibrary: (value: KnowledgeReplicaLibrary) => {library = value;}};
}
test("S1 cold offline load uses selected scope, unopened full-body search, and original rows", async () => {
  const f = fixture(); f.ctrl.setConnection({paired: true, connected: false, instanceId: "A", isLive: () => true}); await settle();
  assert.equal(f.ctrl.snapshot().phase, "offline"); assert.equal(f.ctrl.snapshot().rows.length, 50); assert.equal(f.ctrl.snapshot().vaultId, "v");
  f.ctrl.setQuery("长尾词"); await new Promise(r => setTimeout(r, 8)); await settle();
  assert.deepEqual(f.ctrl.snapshot().rows.map(r => r.noteId), ["n100"]); assert.equal(f.discovery(), 0); f.ctrl.suspend();
});
test("S1 progress/reconnect refresh preserves two loaded pages and does not repeatedly discover", async () => {
  const f = fixture(); const binding = {paired: true, connected: true, instanceId: "A", isLive: () => true};
  f.ctrl.setConnection(binding); await settle(); f.ctrl.loadMore(); await settle(); assert.equal(f.ctrl.snapshot().rows.length, 100);
  const ids = f.ctrl.snapshot().rows.map(r => r.noteId); const discoveries = f.discovery();
  f.setLibrary({...f.library, ready: 110}); f.ctrl.revalidateReplica(); await settle();
  assert.deepEqual(f.ctrl.snapshot().rows.map(r => r.noteId), ids); assert.equal(f.discovery(), discoveries);
  f.ctrl.setConnection({...binding, connected: false}); await settle(); assert.deepEqual(f.ctrl.snapshot().rows.map(r => r.noteId), ids);
  f.ctrl.setConnection(binding); await settle(); assert.deepEqual(f.ctrl.snapshot().rows.map(r => r.noteId), ids); f.ctrl.suspend();
});
test("S1 pair owner change fences old body/read scope, even a late query", async () => {
  const f = fixture(); f.ctrl.setConnection({paired: true, connected: false, instanceId: "A", isLive: () => true}); await settle();
  f.ctrl.setQuery("笔记"); f.ctrl.setConnection({paired: true, connected: false, instanceId: "B", isLive: () => true}); await new Promise(r => setTimeout(r, 8)); await settle();
  assert.equal(f.ctrl.snapshot().instanceId, "B"); assert.equal(f.ctrl.snapshot().rows.length, 0); assert.ok(f.calls.every(call => call.instance === "A")); f.ctrl.suspend();
});
test("S1 continuous locally committed input publishes within 2 seconds, not before commit", t => {
  t.mock.timers.enable({apis: ["setTimeout"]}); let calls = 0; const p = new DurablePublishDebounce(() => calls++);
  p.begin(); t.mock.timers.tick(3000); assert.equal(calls, 0);
  for (let i = 0; i < 7; i++) { const gen = p.begin(); p.committed(gen); t.mock.timers.tick(300); }
  assert.equal(calls, 1); p.dispose(); t.mock.timers.tick(3000); assert.equal(calls, 1);
});
test("S1 external textarea adoption preserves IME/focus and newer unsaved input; clean reader follows", () => {
  const base = {current: true, sameGeneration: true, pending: 0, failed: false, editing: true, focused: true, composing: false, draft: {title: "Title", content: "old"}, incoming: {title: "Title", content: "new"}};
  assert.equal(canAdoptKnowledgeBody(base), false);
  assert.equal(canAdoptKnowledgeBody({...base, focused: false}), true);
  assert.equal(canAdoptKnowledgeBody({...base, editing: false}), true);
  assert.equal(canAdoptKnowledgeBody({...base, incoming: base.draft}), true);
  for (const changes of [{composing: true}, {pending: 1}, {failed: true}, {sameGeneration: false}, {current: false}]) assert.equal(canAdoptKnowledgeBody({...base, editing: false, ...changes}), false);
});
test("S1 directory keeps loaded pages through offline/reconnect and allows offline next page/search", async () => {
  const rows = Array.from({length: 112}, (_, i) => ({instanceId: "A", vaultId: "v", noteId: `n${i}`, title: `笔记 ${i}`, content: i === 110 ? "长尾词" : "正文", relativePath: `Docs/${i}.md`}));
  const ctrl = new KnowledgeDirectoryController(async (_instance, _vault, q, page, directory) => {
    assert.equal(directory, "Docs"); const all = rows.filter(n => `${n.title} ${n.content}`.includes(q));
    return {items: all.slice((page - 1) * 50, page * 50), hasMore: page * 50 < all.length, source: "cache"};
  }, {debounceMs: 1});
  const binding = {paired: true, connected: true, instanceId: "A", localReplica: true, writeGranted: true, isLive: () => true};
  ctrl.setOwner(binding); ctrl.setVault("v"); ctrl.setDirectory("Docs"); ctrl.activate(); await settle();
  ctrl.loadMore(); await settle(); assert.equal(ctrl.snapshot().rows.length, 100);
  ctrl.setOwner({...binding, connected: false}); await settle(); assert.equal(ctrl.snapshot().rows.length, 100);
  ctrl.loadMore(); await settle(); assert.equal(ctrl.snapshot().rows.length, 112); assert.equal(ctrl.snapshot().page, 3);
  ctrl.revalidateReplica(); await settle(); assert.equal(ctrl.snapshot().rows.length, 112);
  ctrl.setOwner(binding); ctrl.activate(); await settle(); assert.equal(ctrl.snapshot().rows.length, 112);
  ctrl.setQuery("长尾词"); await new Promise(r => setTimeout(r, 8)); await settle();
  assert.deepEqual(ctrl.snapshot().rows.map(n => n.noteId), ["n110"]); ctrl.suspend();
});
test("S1 a temporary local read failure keeps selected scope, every page and recovery", async () => {
  const f = fixture(); f.ctrl.setConnection({paired: true, connected: true, instanceId: "A", isLive: () => true}); await settle();
  f.ctrl.loadMore(); await settle(); const libraries = f.deps.replica.libraries;
  f.deps.replica.libraries = async () => {throw new Error("temporary local read failure");};
  f.ctrl.revalidateReplica(); await settle();
  assert.equal(f.ctrl.snapshot().phase, "error"); assert.equal(f.ctrl.snapshot().replica?.confirmed, true);
  assert.equal(f.ctrl.snapshot().rows.length, 100); assert.equal(f.ctrl.snapshot().hasMore, true);
  f.deps.replica.libraries = libraries; f.ctrl.revalidateReplica(); await settle();
  assert.equal(f.ctrl.snapshot().rows.length, 100); assert.equal(f.ctrl.snapshot().phase, "ready"); f.ctrl.suspend();
});
test("S1 background body progress cannot retire in-flight same-owner canonical move discovery", async () => {
  const f = fixture(); let resolve: (value: any) => void = () => {};
  f.deps.knowledge.vaults = () => new Promise(r => {resolve = r;});
  f.ctrl.setConnection({paired: true, connected: true, instanceId: "A", isLive: () => true}); await settle();
  f.ctrl.revalidateReplica(); await settle();
  resolve({items: [{vaultId: "v", activeInDesktop: true, displayName: "Library", writeGranted: true}]}); await settle();
  assert.equal(f.ctrl.moveAuthority().writeGranted, true); assert.equal(f.discovery(), 1); f.ctrl.suspend();
});
test("S1 preview coverage beyond 100 uses bounded exact-scope chunks without false missing bodies", async t => {
  const calls: string[][] = [];
  t.mock.method(api, "contentNotePreviews", async (instance: string, vault: string, ids: string[]) => {
    assert.equal(instance, "A"); assert.equal(vault, "v"); calls.push(ids);
    return {items: ids.map(noteId => ({noteId, content: `正文 ${noteId}`, bodyOutdated: false, dirty: false}))};
  });
  const ids = Array.from({length: 112}, (_, i) => `n${i}`);
  const store = await loadPreviewStore("A", "v", [...ids, "n1"]);
  assert.deepEqual(calls.map(c => c.length), [100, 12]); assert.equal(Object.keys(store.byNoteId).length, 112);
  assert.equal(store.byNoteId.n111.preview, "正文 n111");
});
