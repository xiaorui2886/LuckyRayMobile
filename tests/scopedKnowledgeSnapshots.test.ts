import test from "node:test";
import assert from "node:assert/strict";
import { KnowledgeBrowseController } from "../src/still/kit/knowledgeBrowseController.ts";
import { KnowledgeDirectoryController } from "../src/still/kit/knowledgeDirectoryController.ts";
import { LibrarySession } from "../src/still/kit/librarySession.ts";
import { ServiceRegistry } from "../src/services/companionServices/serviceRegistry.ts";
import { ServicesError } from "../src/services/companionServices/transport.ts";
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 10; i++) await tick(); };
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const online = (instanceId = "desktop") => ({ paired: true, connected: true, instanceId, isLive: () => true });
function setup() {
  let generation = 1, permission = 1;
  const pending = new Map<string, ReturnType<typeof deferred<any>>>();
  const calls: string[] = [];
  const registry = new ServiceRegistry({ request: async request => ({ status: 200, body: {
    desktopInstanceId: request.instance, gatewayGeneration: generation, permissionRevision: permission,
    services: { knowledge: { version: 1 } }, operations: {
      "knowledge.vaults": { state: "implemented" }, "knowledge.registeredList": { state: "implemented" }, "knowledge.move": { state: "notGranted" },
    },
  } }) } as any);
  const knowledge = { vaults: async (_instance: string, vault = "A") => ({ items: [{ vaultId: vault, displayName: vault, readGranted: true, activeInDesktop: true }] }),
    registeredList: async (_instance: string, vault: string, options: any) => {
      calls.push(vault + (options?.afterId ?? ""));
      if (pending.has(vault)) return pending.get(vault)!.promise;
      return { items: [{ noteId: vault + "-note", vaultId: vault }], hasMore: false, nextAfterId: null };
    } };
  const controller = new KnowledgeBrowseController({ registry, knowledge: knowledge as any });
  return { controller, registry, pending, calls, knowledge, generation: (value: number) => { generation = value; }, permission: (value: number) => { permission = value; } };
}

test("exact-vault A→B→A paints A before effects and keeps it throughout delayed revalidation", async () => {
  const { controller, pending } = setup();
  controller.selectVault("A"); controller.setConnection(online()); await settle();
  const oldA = controller.snapshot();
  controller.selectVault("B"); await settle();
  assert.equal(controller.snapshot().rows[0].vaultId, "B");
  assert.strictEqual(controller.snapshotFor("desktop", "A"), oldA, "pre-effect lookup is stable and exact-owner");
  const gate = deferred<any>(); pending.set("A", gate);
  controller.selectVault("A");
  const snapshots: any[] = []; const stop = controller.subscribe(snapshot => snapshots.push(snapshot));
  await settle();
  assert.ok(snapshots.length > 0);
  assert.ok(snapshots.every(snapshot => snapshot.phase === "ready" && snapshot.rows[0]?.vaultId === "A"));
  assert.equal(controller.snapshot().refreshing, true);
  gate.resolve({ items: [{ noteId: "fresh", vaultId: "A" }], hasMore: false, nextAfterId: null }); await settle(); stop();
  assert.equal(controller.snapshot().rows[0].noteId, "fresh");
  assert.equal(controller.snapshot().refreshing, false);
  assert.equal(controller.snapshotFor("other-desktop", "A"), undefined);
});

test("a cold scope is reserved, and late A success cannot alter B or seed A's retained cache", async () => {
  const { controller, pending } = setup(); const gate = deferred<any>(); pending.set("A", gate);
  controller.selectVault("A"); controller.setConnection(online()); await settle();
  assert.equal(controller.snapshot().rows.length, 0); assert.equal(controller.snapshot().phase, "loading");
  controller.selectVault("B"); await settle();
  gate.resolve({ items: [{ noteId: "late", vaultId: "A" }], hasMore: false }); await settle();
  assert.equal(controller.snapshot().rows[0].vaultId, "B");
  assert.equal(controller.snapshotFor("desktop", "A"), undefined);
});

test("transient scoped outage retains rows but explicit read revocation removes them permanently", async () => {
  const { controller, pending } = setup();
  controller.selectVault("A"); controller.setConnection(online()); await settle();
  const gate = deferred<any>(); pending.set("A", gate); controller.refresh(); await settle();
  gate.reject(new ServicesError("SERVICE_UNAVAILABLE", 503)); await settle();
  assert.equal(controller.snapshot().rows[0].vaultId, "A");
  assert.equal(controller.snapshot().phase, "temporarily-unavailable");
  controller.selectVault("A", false); assert.equal(controller.snapshot().rows.length, 0);
  controller.selectVault("B"); await settle();
  assert.equal(controller.snapshotFor("desktop", "A"), undefined);
});

test("inactive A revoke cannot resurrect rows on A return while B stays visible", async () => {
  const { controller, registry, pending } = setup();
  controller.selectVault("A"); controller.setConnection(online()); await settle();
  controller.selectVault("B"); await settle();
  registry.revoke("desktop", { vault: "A" });
  assert.equal(controller.snapshot().rows[0].vaultId, "B");
  assert.equal(controller.snapshotFor("desktop", "A"), undefined, "synchronous security gate, before selection effect");
  pending.set("A", deferred()); controller.selectVault("A");
  assert.equal(controller.snapshot().rows.length, 0); await settle();
  assert.equal(controller.snapshot().rows.length, 0);
});

test("new generation and permission invalidation gate retained snapshots before paint", async () => {
  const { controller, registry, generation, pending } = setup();
  controller.selectVault("A"); controller.setConnection(online()); await settle();
  controller.selectVault("B"); await settle();
  generation(2); await registry.forScope("desktop", { vault: "B" }).refreshAdopting("desktop", { vault: "B" });
  assert.equal(controller.snapshotFor("desktop", "A"), undefined);
  pending.set("B", deferred()); registry.invalidateForPermissionRevision(2, "desktop");
  assert.equal(controller.snapshot().rows.length, 0);
  assert.equal(controller.snapshotFor("desktop", "A"), undefined);
});

test("read-only write denial never blanks readable cached browse rows", async () => {
  const { controller } = setup(); controller.selectVault("A"); controller.setConnection(online()); await settle();
  controller.refresh(); assert.equal(controller.snapshot().rows[0].vaultId, "A"); await settle();
  assert.equal(controller.snapshot().phase, "ready");
});

test("directory cached views restore exact scopes, preserve loaded extent and retain on temporary failure", async () => {
  const pending = new Map<string, ReturnType<typeof deferred<any>>>();
  const calls: string[] = [];
  const controller = new KnowledgeDirectoryController(async (_instance, vault, _query, page, directory) => {
    calls.push(vault + ":" + page);
    if (pending.has(vault)) return pending.get(vault)!.promise;
    return { items: [{ noteId: vault + page, vaultId: vault, relativePath: directory + "/note.md" }], hasMore: page < 2, source: "live" };
  });
  const bind = (vault: string) => { controller.setOwner({ ...online(), writeGranted: true }); controller.setVault(vault); controller.setDirectory("Folder"); controller.activate(); };
  bind("A"); await settle(); controller.loadMore(); await settle();
  assert.equal(controller.snapshot().rows.length, 2);
  bind("B"); await settle();
  assert.equal(controller.snapshotFor({ instanceId: "desktop", vaultId: "A", directory: "Folder", query: "" }).rows.length, 2);
  const gate = deferred<any>(); pending.set("A", gate); bind("A"); await settle();
  assert.equal(controller.snapshot().phase, "ready"); assert.equal(controller.snapshot().rows.length, 2);
  gate.reject(new Error("temporary timeout")); await settle();
  assert.equal(controller.snapshot().rows.length, 2); assert.equal(controller.snapshot().stale, true);
  pending.delete("A"); controller.refresh(); await settle();
  assert.deepEqual(calls.slice(-2), ["A:1", "A:2"]);
  assert.equal(controller.snapshot().rows.length, 2);
  controller.invalidateScope("desktop", "A"); bind("B"); await settle();
  assert.equal(controller.snapshotFor({ instanceId: "desktop", vaultId: "A", directory: "Folder", query: "" }).rows.length, 0);
});

test("offline directory activation waits for complete owner/vault/directory feed", async () => {
  const calls: string[][] = [];
  const controller = new KnowledgeDirectoryController(async (owner, vault, _q, _page, dir) => { calls.push([owner, vault, dir]); return { items: [], hasMore: false, source: "cache" }; });
  controller.setOwner({ ...online(), connected: false, localReplica: true, writeGranted: false });
  controller.setVault("A"); controller.setDirectory("Folder");
  assert.equal(calls.length, 0); controller.activate(); await settle();
  assert.deepEqual(calls, [["desktop", "A", "Folder"]]);
});

test("material presentation scroll belongs to exact identity and survives A→B→A", () => {
  const session = new LibrarySession();
  session.bind("desktop", "owner-A|library-A"); session.commit("desktop", "owner-A|library-A", ["A"]); session.setScroll("desktop", 720);
  session.bind("desktop", "owner-A|library-B"); session.commit("desktop", "owner-A|library-B", ["B"]); session.setScroll("desktop", 90);
  assert.equal(session.view("desktop", "owner-A|library-A").scrollTop, 720);
  assert.deepEqual(session.view("desktop", "owner-A|library-A").items, ["A"]);
  session.bind("desktop", "owner-A|library-A"); assert.equal(session.view("desktop").scrollTop, 720);
  session.discard("desktop", "owner-A|library-A"); assert.equal(session.view("desktop").items.length, 0);
});

test("cold directory request captures security revision before await and cannot relabel a revoked result", async () => {
  for (const notifyDuringFlight of [true, false]) {
    let revision = 0, notify = () => {};
    const pending = deferred<any>();
    const controller = new KnowledgeDirectoryController(() => pending.promise, {
      scopeRevision: () => revision, subscribe: callback => { notify = callback; return () => {}; },
    });
    controller.setOwner({ ...online(), writeGranted: true }); controller.setVault("A"); controller.setDirectory("Folder"); controller.activate();
    revision += 1; if (notifyDuringFlight) notify();
    pending.resolve({ items: [{ noteId: "protected", vaultId: "A" }], hasMore: false, source: "live" }); await settle();
    assert.equal(controller.snapshot().rows.length, 0);
    assert.equal(controller.snapshotFor({ instanceId: "desktop", vaultId: "A", directory: "Folder", query: "" }).rows.length, 0);
  }
});

test("cold saved-replica read cannot publish after a scoped revoke", async () => {
  const { registry } = setup(); const pending = deferred<any>();
  const controller = new KnowledgeBrowseController({ registry, knowledge: {} as any, replica: {
    libraries: async () => [{ instanceId: "desktop", vaultId: "A", confirmed: true, name: "A" }],
    notes: () => pending.promise,
  } as any });
  controller.selectVault("A"); controller.setConnection(online()); await settle();
  registry.revoke("desktop", { vault: "A" });
  pending.resolve({ items: [{ instanceId: "desktop", vaultId: "A", noteId: "protected" }], hasMore: false }); await settle();
  assert.equal(controller.snapshot().rows.length, 0); assert.equal(controller.snapshot().phase, "not-granted");
});

test("actual unpair retires capabilities and retained rows; ordinary offline does not revoke the scope", async () => {
  const { controller, registry } = setup();
  controller.selectVault("A"); controller.setConnection(online()); await settle();
  const scope = registry.forScope("desktop", { vault: "A" });
  assert.ok(scope.snapshot());
  controller.setConnection({ ...online(), connected: false });
  assert.ok(scope.snapshot(), "offline is not a permission revocation");
  assert.equal(controller.snapshot().rows.length, 1); assert.equal(controller.snapshot().phase, "offline");
  controller.setConnection({ paired: false, connected: false, instanceId: "", isLive: () => true });
  assert.equal(scope.snapshot(), null); assert.equal(controller.snapshot().phase, "unpaired");
  assert.equal(controller.snapshotFor("desktop", "A"), undefined);
});

test("explicit read denial has a stable terminal render snapshot, never an endless waiting projection", async () => {
  const { controller, registry } = setup();
  controller.selectVault("A"); controller.setConnection(online()); await settle();
  registry.denyOperation("desktop", { vault: "A" }, "knowledge.registeredList");
  const view = controller.snapshotFor("desktop", "A")!;
  assert.equal(view.phase, "not-granted"); assert.equal(view.rows.length, 0); assert.equal(view.requestedVaultId, "A");
  assert.strictEqual(controller.snapshotFor("desktop", "A"), view);
});
