import test from "node:test";
import assert from "node:assert/strict";
import { KnowledgeClient } from "../src/services/companionServices/knowledgeClient.ts";
import { ServicesError, type ServicesRequest } from "../src/services/companionServices/transport.ts";
import { callServices } from "../src/services/companionServices/transport.ts";
import { createFixtureTransport } from "../src/services/companionServices/fixtureTransport.ts";
import { ServiceRegistry } from "../src/services/companionServices/serviceRegistry.ts";
import { createKnowledgeEditingEffects } from "../src/services/knowledgeEditingEffects.ts";
import { KnowledgeEditingSession } from "../src/services/knowledgeEditingSession.ts";

test("production editing effects confirm only the exact true-publish receipt", async () => {
  const registry = new ServiceRegistry(createFixtureTransport());
  await registry.refreshAdopting("fixture-desktop-1");
  const token = "a".repeat(32);
  let response = {vaultId: "vault-1", noteId: "note-1", sessionId: token, generation: 1, editing: true, leaseMs: 15000};
  const effects = createKnowledgeEditingEffects({registry,
    knowledge: new KnowledgeClient({request: async () => ({status: 200, body: response})}),
    isLive: () => true, observe: () => {}});
  const scope = {instance: "fixture-desktop-1", vault: "vault-1", note: "note-1"};
  assert.equal(await effects.publish(scope, token, 1, true), true);
  response = {...response, generation: 2};
  assert.equal(await effects.publish(scope, token, 1, true), false, "newer server generation is not this hint's receipt");
  response = {...response, generation: 1, editing: false};
  assert.equal(await effects.publish(scope, token, 1, true), false, "inactive receipt cannot claim sent");
});

test("editingOpen uses the inert POST and accepts only the exact scope's server receipt", async () => {
  const requests: ServicesRequest[] = [];
  const token = "a".repeat(32);
  const client = new KnowledgeClient({ request: async req => {
    requests.push(req);
    return { status: 200, body: { vaultId: "v", noteId: "n", sessionId: token, generation: 0, editing: false, leaseMs: 15000 } };
  }});
  const lease = await client.editingOpen("A", "v", "n");
  assert.equal(lease.sessionId, token);
  assert.deepEqual(requests, [{ instance: "A", vault: "v", operationId: "knowledge.editingOpen", method: "POST",
    path: "/v1/services/knowledge/notes/n/editing", body: { vaultId: "v" } }]);
  for (const patch of [{ vaultId: "other" }, { noteId: "other" }, { sessionId: "client-uuid" },
    { editing: true }, { generation: 1 }, { leaseMs: 30000 }]) {
    const wrong = new KnowledgeClient({ request: async () => ({ status: 200,
      body: { vaultId: "v", noteId: "n", sessionId: token, generation: 0, editing: false, leaseMs: 15000, ...patch } }) });
    await assert.rejects(wrong.editingOpen("A", "v", "n"), (e: unknown) => e instanceof ServicesError && e.code === "MALFORMED_RESPONSE");
  }
});

test("higher Knowledge major fails closed even when an operation claims implemented", async () => {
  const transport = createFixtureTransport();
  const registry = new ServiceRegistry(transport);
  const catalog = await registry.refreshAdopting("fixture-desktop-1", {vault:"vault-1"});
  catalog.services.knowledge.version = 2;
  let writes = 0;
  const knowledge = new KnowledgeClient({ request: async () => { writes++; throw new Error("unknown major must not mutate"); } });
  const effects = createKnowledgeEditingEffects({ registry, knowledge, isLive: () => true, observe: () => {} });
  await assert.rejects(effects.open({ instance: "fixture-desktop-1", vault: "vault-1", note: "note-1" }),
    (e: unknown) => e instanceof ServicesError && e.code === "VERSION_UNSUPPORTED");
  assert.equal(writes, 0);
});

test("reverse material references require both actual Catalog and Vault scope; a page is never an empty-success denial", async () => {
  const initial = createFixtureTransport().fixture.snapshot();
  for (const mode of ["catalog", "vault"]) {
    const snapshot = structuredClone(initial);
    if (mode === "catalog") snapshot.devices["device-a"].catalogRead = false;
    else snapshot.devices["device-a"].vaults = ["vault-2"];
    const transport = createFixtureTransport({ snapshot });
    const client = new KnowledgeClient(transport);
    await assert.rejects(client.materialReferences("fixture-desktop-1", "vault-1", "asset-1"),
      (e: unknown) => e instanceof ServicesError && e.status === 403);
  }
});

test("relation targets are read-only text, with complete typed fields rather than filesystem normalization", async () => {
  const item = { kind: "wikiLink", target: "../Target", line: 1, status: "unresolved", noteIds: [] };
  let items: unknown[] = [item];
  const client = new KnowledgeClient({ request: async () => ({ status: 200, body:
    { vaultId: "v", noteId: "n", revision: "r", items, hasMore: false, nextAfter: null } }) });
  assert.deepEqual((await client.relations("A", "v", "n")).items, [item]);
  for (const malformed of [{ kind: "wikiLink", target: "T" }, { ...item, line: 0 }, { ...item, status: "guessed" },
    { ...item, noteIds: ["bad/id"] }, { ...item, kind: "backlink" }, { kind: "material", target: "a.png" },
    { ...item, target: "/absolute" }, { ...item, target: "C:/private" }]) {
    items = [malformed];
    await assert.rejects(client.relations("A", "v", "n"),
      (e: unknown) => e instanceof ServicesError && e.code === "MALFORMED_RESPONSE");
  }
});

test("the composed production lifecycle sends release before its owner is retired", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const transport = createFixtureTransport();
  const requests: ServicesRequest[] = [];
  const seam = { request: (req: ServicesRequest) => { requests.push(req); return transport.request(req); } };
  let live = true;
  const hints: string[] = [];
  const lease = new KnowledgeEditingSession({ instance: "fixture-desktop-1", vault: "vault-1", note: "note-1" },
    createKnowledgeEditingEffects({ registry: new ServiceRegistry(seam), knowledge: new KnowledgeClient(seam),
      isLive: () => live, observe: () => {} }), true, (_scope, hint) => hints.push(hint));
  await new Promise<void>(resolve => setImmediate(resolve));
  lease.committed(); t.mock.timers.tick(400);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(requests.filter(r => r.method === "PUT").length, 1);
  assert.equal(hints.at(-1), "sent", "real client/registry/session consumes the fixture receipt");
  lease.retire(); live = false; // exact editor cleanup order
  assert.equal(hints.at(-1), "disabled");
  await new Promise<void>(resolve => setImmediate(resolve));
  const puts = requests.filter(r => r.method === "PUT");
  assert.equal(puts.length, 2);
  assert.equal((puts[1].body as any).editing, false);
  assert.equal((puts[1].body as any).generation, 2);
});

test("existing-client effects refuse unsupported and stale-owner sends; late catalog cannot open a lease", async () => {
  const requests: ServicesRequest[] = [];
  let live = true;
  let settle!: (value: any) => void;
  const transport = { request: async (req: ServicesRequest) => {
    requests.push(req);
    if (req.operationId === "services.discover") return new Promise<any>(resolve => { settle = resolve; });
    throw new Error("stale owner must not send an editing operation");
  }};
  const effects = createKnowledgeEditingEffects({ registry: new ServiceRegistry(transport), knowledge: new KnowledgeClient(transport),
    isLive: () => live, observe: () => {} });
  const scope = { instance: "A", vault: "v", note: "n" };
  const opening = effects.open(scope);
  await new Promise<void>(resolve => setImmediate(resolve));
  live = false;
  settle({ status: 200, body: { desktopInstanceId: "A", gatewayGeneration: 1, permissionRevision: 1,
    operations: { "knowledge.editingOpen": { state: "implemented" }, "knowledge.editingSet": { state: "implemented" } } } });
  await assert.rejects(opening, (e: unknown) => e instanceof ServicesError && e.code === "SOURCE_CHANGED");
  assert.deepEqual(requests.map(r => r.operationId), ["services.discover"]);
  const empty = { request: async () => ({ status: 200, body: { desktopInstanceId: "A", gatewayGeneration: 1, permissionRevision: 1, operations: {} } }) };
  const unsupported = createKnowledgeEditingEffects({ registry: new ServiceRegistry(empty), knowledge: new KnowledgeClient(transport),
    isLive: () => true, observe: () => {} });
  await assert.rejects(unsupported.open(scope), (e: unknown) => e instanceof ServicesError && e.code === "VERSION_UNSUPPORTED");
});

test("bounded directory/relation/reference clients consume canonical pages and never hide 410/revoke", async () => {
  const transport = createFixtureTransport();
  const client = new KnowledgeClient(transport);
  const root = await client.directories("fixture-desktop-1", "vault-1", { limit: 1 });
  assert.deepEqual(root.items, [{ parentRelativePath: "" }]);
  const afterRoot = await client.directories("fixture-desktop-1", "vault-1", { afterPath: "", limit: 100 });
  assert.equal(afterRoot.items.some(item => item.parentRelativePath === ""), false);
  const relations = await client.relations("fixture-desktop-1", "vault-1", "note-1", { limit: 1 });
  assert.equal(relations.vaultId, "vault-1");
  const references = await client.materialReferences("fixture-desktop-1", "vault-1", "asset-1", { limit: 100 });
  assert.equal(references.assetId, "asset-1");
  const stale = new KnowledgeClient({ request: async () => ({ status: 410, body: { code: "CURSOR_TOO_OLD" } }) });
  await assert.rejects(stale.relations("A", "v", "n", { after: "stale" }),
    (e: unknown) => e instanceof ServicesError && e.status === 410);
  transport.fixture.revoke("device-a");
  await assert.rejects(client.materialReferences("fixture-desktop-1", "vault-1", "asset-1"),
    (e: unknown) => e instanceof ServicesError && e.code === "AUTH_REVOKED");
});

test("unique creation preserves empty/null/omitted payload and fixture receipt replay", async () => {
  const transport = createFixtureTransport();
  const requests: ServicesRequest[] = [];
  const client = new KnowledgeClient({ request: req => { requests.push(req); return transport.request(req); } });
  for (const expected of [{}, { expectedRevision: null }, { expectedRevision: "" as const }]) {
    const payload = { opId: `create-${requests.length}`, noteId: `unique-${requests.length}`,
      vaultId: "vault-1", kind: "create" as const, title: "Same name", content: "later attachment intent", ...expected };
    const receipt = await client.createUnique("fixture-desktop-1", payload);
    assert.equal(receipt.document.noteId, payload.noteId);
    assert.deepEqual(await client.createUnique("fixture-desktop-1", payload), receipt);
    assert.equal(requests.at(-1)?.body, payload, "caller body is not rebuilt/normalized");
    await assert.rejects(client.createUnique("fixture-desktop-1", { ...payload, content: "changed" }),
      (e: unknown) => e instanceof ServicesError && e.code === "OP_ID_REUSED");
  }
  assert.equal(requests[0].operationId, "knowledge.createUnique");
  assert.equal(requests[0].path, "/v1/services/knowledge/notes");
  const bad = new KnowledgeClient({ request: async () => ({ status: 200, body: { opId: "wrong", document: {} } }) });
  await assert.rejects(bad.createUnique("A", { opId: "o", noteId: "n", vaultId: "v", kind: "create", title: "T" }),
    (e: unknown) => e instanceof ServicesError && e.code === "MALFORMED_RESPONSE");
});

test("the frozen NOTE_TOO_LARGE wire code survives a 413 response", async () => {
  await assert.rejects(callServices({ request: async () => ({ status: 413, body: { code: "NOTE_TOO_LARGE" } }) },
    { instance: "A", operationId: "knowledge.createUnique", method: "POST", path: "/v1/services/knowledge/notes" }),
  (e: unknown) => e instanceof ServicesError && e.status === 413 && e.code === "NOTE_TOO_LARGE");
});

test("editing GET and PUT preserve scope/token; unsafe generations never reach transport", async () => {
  const requests: ServicesRequest[] = [];
  const token = "b".repeat(32);
  const client = new KnowledgeClient({ request: async req => {
    requests.push(req);
    return { status: 200, body: req.method === "GET"
      ? { vaultId: "v", noteId: "n", desktopEditing: true, mobileEditing: false, leaseMs: 15000 }
      : { vaultId: "v", noteId: "n", sessionId: token, generation: 4, editing: false, leaseMs: 15000 } };
  }});
  assert.equal((await client.editing("A", "v", "n")).desktopEditing, true);
  assert.equal((await client.editingSet("A", "n", { vaultId: "v", sessionId: token, generation: 3, editing: true })).generation, 4,
    "a reordered PUT can return a newer current server generation");
  assert.deepEqual(requests[0], { instance: "A", vault: "v", operationId: "knowledge.editing", method: "GET",
    path: "/v1/services/knowledge/notes/n/editing", query: { vault: "v" } });
  assert.equal(requests[1].operationId, "knowledge.editingSet");
  assert.equal(requests[1].method, "PUT");
  for (const generation of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(client.editingSet("A", "n", { vaultId: "v", sessionId: token, generation, editing: true }),
      (e: unknown) => e instanceof ServicesError && e.code === "INPUT_INVALID");
  }
  assert.equal(requests.length, 2);
  const wrong = new KnowledgeClient({ request: async () => ({ status: 200, body:
    { vaultId: "v", noteId: "n", sessionId: "c".repeat(32), generation: 3, editing: true, leaseMs: 15000 } }) });
  await assert.rejects(wrong.editingSet("A", "n", { vaultId: "v", sessionId: token, generation: 3, editing: true }),
    (e: unknown) => e instanceof ServicesError && e.code === "MALFORMED_RESPONSE");
});
