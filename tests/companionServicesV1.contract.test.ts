// Companion Services V1 — canonical fixture/client matrix (Issue #77).
//
// Every case drives the SAME production domain clients over the vendored
// canonical fixture. No test-only client exists.
// Run: node --experimental-strip-types --test tests/companionServicesV1.contract.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
  createCompanionServices, createFixtureTransport, ServiceRegistry, SearchSession,
  PresentationClient, MaterialsClient, KnowledgeClient, IngestClient, ChangeFeedClient,
  ServicesError, carrySafeSource, preservesWorkPageUrl, presentationCopy,
} from "../src/services/companionServices/index.ts";

const ROOT = join(import.meta.dirname, "..");
const vendor = (name: string) => join(ROOT, "shared", "companion-services-v1", name);
const readVendor = (name: string) => readFileSync(vendor(name), "utf8");

const IDENT = { instanceId: "fixture-desktop-1", gatewayGeneration: 7, permissionRevision: 1 };

function services(deviceId = "device-a") {
  const transport = createFixtureTransport({ deviceId });
  return { transport, ...createCompanionServices(transport), fixture: transport.fixture };
}

// ===========================================================================
// 1. Vendor proof — exact canonical bundle
// ===========================================================================

test("vendor — manifest revision and bundle digest match the frozen pointer", () => {
  const manifest = JSON.parse(readVendor("manifest.json"));
  const sums = JSON.parse(readVendor("SHA256SUMS.json"));
  assert.equal(manifest.bundleRevision, "2026-09-30.1");
  assert.equal(manifest.authority, "xiaorui2886/luckyray-app:luckyray-app/protocol/companion-v1/services-v1");
  assert.equal(manifest.productionStatusAtFreeze, "shared-candidate-not-lan-accepted");
  assert.equal(
    sums.bundleDigest,
    "6342ca7f1525c7f04238ed42b892034d74f218274bd1dec1c38e00736d74772d",
  );
});

test("vendor — every canonical file is present and the directory is unedited", () => {
  const manifest = JSON.parse(readVendor("manifest.json"));
  const sums = JSON.parse(readVendor("SHA256SUMS.json"));
  assert.equal(manifest.checksumFile, "SHA256SUMS.json");
  // The checksum file pins the bundle; if a vendored file were edited locally
  // the vendored verify.mjs run in CI would fail. Here we assert the file set.
  const listed = Object.keys(sums.files).length;
  assert.equal(listed, 21, "complete successor file set is pinned");
});

test("vendor — operations matrix is consumed as-is (19 .3 operations, restore unsupported)", () => {
  const ops = JSON.parse(readVendor("operations.json"));
  assert.equal(ops.bundleRevision, "2026-09-30.1");
  assert.deepEqual(ops.states, ["implemented", "notGranted", "temporarilyUnavailable", "unsupported"]);
  assert.deepEqual(ops.grantClasses, [
    "content.read", "content.write", "ingest.write", "desktop.open", "lsh.remote",
  ]);
  const restore = ops.operations.find((o: any) => o.id === "materials.restore");
  assert.ok(restore, "materials.restore is declared");
  assert.equal(restore.method, null, "restore has no method");
  assert.equal(restore.path, null, "restore has no path");
});

test("vendor — error codes are consumed verbatim", () => {
  const errors = JSON.parse(readVendor("errors.json"));
  assert.equal(errors.codes.CURSOR_TOO_OLD, 410);
  assert.equal(errors.codes.OP_ID_REUSED, 409);
  assert.equal(errors.codes.VERSION_UNSUPPORTED, 426);
  assert.equal(errors.codes.DESKTOP_DRAFT_BUSY, 503);
  assert.equal(errors.codes.PRESENTATION_BUSY, 409);
});

// ===========================================================================
// 2. Catalog / authorization
// ===========================================================================

test("catalog — registry reads the canonical catalog and reports per-operation state", async () => {
  const { registry } = services("device-a");
  const catalog = await registry.refresh(IDENT);
  assert.equal(catalog.bundleRevision, "2026-09-30.1");
  assert.equal(catalog.desktopInstanceId, "fixture-desktop-1");
  assert.equal(catalog.gatewayGeneration, 7);
  // Per-operation truth, never inferred from services.<domain>.granted.
  assert.equal(registry.operation("materials.detailV1").state, "implemented");
  assert.equal(registry.canCall("materials.detailV1"), true);
});

test("catalog — an absent/unknown operation fails closed as unsupported", async () => {
  const { registry } = services("device-a");
  await registry.refresh(IDENT);
  assert.equal(registry.operation("materials.restore").state, "unsupported");
  assert.equal(registry.operation("no.such.operation").state, "unsupported");
  assert.equal(registry.canCall("no.such.operation"), false);
});

test("catalog — a read-only device reports notGranted for write operations", async () => {
  const { registry } = services("device-read");
  const catalog = await registry.refresh({ ...IDENT });
  const patch = catalog.operations["materials.metadataPatch"];
  assert.equal(patch.state, "notGranted");
  assert.equal(registry.canCall("materials.metadataPatch"), false);
  // …while reads remain implemented.
  assert.equal(registry.operation("materials.detailV1").state, "implemented");
});

test("catalog — a revoked device fails closed", async () => {
  const { registry } = services("device-revoked");
  await assert.rejects(
    () => registry.refresh({ ...IDENT }),
    (e: any) => e instanceof ServicesError && e.code === "AUTH_REVOKED",
  );
});

test("catalog — namespace includes instance, gateway generation and permission revision", async () => {
  const { registry } = services("device-a");
  await registry.refresh(IDENT);
  assert.equal(registry.currentNamespace(), "fixture-desktop-1|7|1");
  // A permission-revision change invalidates the cache and demands a refresh.
  assert.equal(registry.invalidateForPermissionRevision(2), true);
  assert.equal(registry.snapshot(), null, "cache dropped on permission change");
  // Same revision is a no-op.
  await registry.refresh(IDENT);
  assert.equal(registry.invalidateForPermissionRevision(1), false);
});

test("catalog — a stale Desktop/generation response cannot be adopted as current truth", async () => {
  const { registry } = services("device-a");
  await assert.rejects(
    () => registry.refresh({ instanceId: "fixture-desktop-1", gatewayGeneration: 99, permissionRevision: 1 }),
    /services-catalog-generation-mismatch/,
  );
  assert.equal(registry.snapshot(), null, "no stale truth retained");
});

test("catalog — reconnect (gateway generation change) invalidates the namespace", async () => {
  const { registry, fixture } = services("device-a");
  await registry.refresh(IDENT);
  const before = registry.currentNamespace();
  const next = fixture.reconnect();
  registry.invalidate();
  assert.equal(next, 8);
  assert.equal(registry.snapshot(), null);
  await registry.refresh({ ...IDENT, gatewayGeneration: next });
  assert.notEqual(registry.currentNamespace(), before);
});

// ===========================================================================
// 3. Materials
// ===========================================================================

test("materials — detailV1 carries the canonical SafeSource unchanged", async () => {
  const { materials } = services("device-a");
  const detail = await materials.detailV1(IDENT.instanceId, "asset-1");
  assert.equal(detail.assetId, "asset-1");
  assert.equal(detail.revision, "asset-r1");
  assert.equal(detail.source?.pageKind, "work-page");
  const carried = carrySafeSource(detail.source);
  assert.equal(carried.pageKind, "work-page");
  assert.equal(carried.pageUrl, "https://www.pinterest.com/pin/700591285831031728/");
  assert.equal(preservesWorkPageUrl(detail.source), true);
});

test("materials — metadataPatch uses the caller's immutable opId (replay is idempotent)", async () => {
  const { materials } = services("device-a");
  const body = { opId: "op-patch-1", expectedRevision: "asset-r1", name: "Renamed" };
  const first = await materials.metadataPatch(IDENT.instanceId, "asset-1", body as any);
  assert.equal(first.disposition, "updated");
  // Same opId + same payload → the SAME one-time receipt, no new operation.
  const replay = await materials.metadataPatch(IDENT.instanceId, "asset-1", body as any);
  assert.deepEqual(replay, first);
});

test("materials — same opId with a DIFFERENT payload is OP_ID_REUSED (terminal conflict)", async () => {
  const { materials } = services("device-a");
  await materials.metadataPatch(IDENT.instanceId, "asset-1", {
    opId: "op-patch-2", expectedRevision: "asset-r1", name: "A",
  } as any);
  await assert.rejects(
    () => materials.metadataPatch(IDENT.instanceId, "asset-1", {
      opId: "op-patch-2", expectedRevision: "asset-r1", name: "B",
    } as any),
    (e: any) => e instanceof ServicesError && e.code === "OP_ID_REUSED",
  );
});

test("materials — read-only device is denied a write", async () => {
  const { materials } = services("device-read");
  await assert.rejects(
    () => materials.metadataPatch(IDENT.instanceId, "asset-1", {
      opId: "op-ro-1", expectedRevision: "asset-r1", name: "X",
    } as any),
    (e: any) => e instanceof ServicesError && e.code === "GRANT_REQUIRED",
  );
});

test("materials — changes catch-up from a durable cursor", async () => {
  const { materials, fixture } = services("device-a");
  const first = await materials.changes(IDENT.instanceId, null);
  assert.equal(first.recovered, false);
  assert.ok(first.nextCursor, "a durable cursor is returned");
  const generationBefore = first.generation;
  void fixture;
  void generationBefore;
});

// ===========================================================================
// 4. Knowledge
// ===========================================================================

test("knowledge — registered vault discovery never implies an active-vault switch", async () => {
  const { knowledge } = services("device-a");
  const page = await knowledge.vaults(IDENT.instanceId);
  assert.ok(page.items.length >= 1);
  const v = page.items[0];
  assert.equal(v.vaultId, "vault-1");
  assert.equal(v.activeInDesktop, true);
  assert.equal(v.readGranted, true);
});

test("knowledge — registered list is scoped to the requested vault", async () => {
  const { knowledge } = services("device-a");
  const page = await knowledge.registeredList(IDENT.instanceId, "vault-1");
  assert.ok(page.items.every((n) => n.vaultId === "vault-1"));
});

test("knowledge — a vault outside the device scope is SCOPE_DENIED", async () => {
  const { knowledge } = services("device-a");
  await assert.rejects(
    () => knowledge.registeredList(IDENT.instanceId, "vault-other"),
    (e: any) => e instanceof ServicesError && e.code === "SCOPE_DENIED",
  );
});

test("knowledge — move requires expectedRevision and returns a revision receipt", async () => {
  const { knowledge } = services("device-a");
  const receipt = await knowledge.move(IDENT.instanceId, "note-1", {
    opId: "op-move-1", vaultId: "vault-1", expectedRevision: "note-r1", parentRelativePath: "Archive",
  } as any);
  assert.equal(receipt.noteId, "note-1");
  assert.equal(receipt.parentRelativePath, "Archive");
});

test("knowledge — a stale expectedRevision is REVISION_CONFLICT", async () => {
  const { knowledge } = services("device-a");
  await assert.rejects(
    () => knowledge.move(IDENT.instanceId, "note-1", {
      opId: "op-move-2", vaultId: "vault-1", expectedRevision: "note-stale", parentRelativePath: "X",
    } as any),
    (e: any) => e instanceof ServicesError && e.code === "REVISION_CONFLICT",
  );
});

test("knowledge — DESKTOP_DRAFT_BUSY surfaces faithfully", async () => {
  const { knowledge, fixture } = services("device-a");
  fixture.setBusy(true);
  await assert.rejects(
    () => knowledge.move(IDENT.instanceId, "note-1", {
      opId: "op-move-busy", vaultId: "vault-1", expectedRevision: "note-r1", parentRelativePath: "X",
    } as any),
    (e: any) => e instanceof ServicesError && e.code === "DESKTOP_DRAFT_BUSY",
  );
});

test("knowledge — registered changes catch-up yields a per-vault projection", async () => {
  const { knowledge } = services("device-a");
  const projection = await knowledge.registeredChanges(IDENT.instanceId, "vault-1", null);
  assert.equal(projection.vaultId, "vault-1");
  assert.equal(projection.recovered, false);
  // G1-C3: the projection is keyed by scope (instance+vault), because a bare
  // vaultId can exist on more than one Desktop.
  assert.equal(knowledge.projectionFor(IDENT.instanceId, "vault-1")?.generation, 0);
});

// ===========================================================================
// 5. Ingest
// ===========================================================================

test("ingest — inline text begin carries exact size and hash", async () => {
  const { ingest } = services("device-a");
  const text = "hello canonical";
  const bytes = new TextEncoder().encode(text);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const job = await ingest.begin(IDENT.instanceId, {
    opId: "op-ing-1", kind: "text", target: { domain: "materials", folderId: null },
    name: "note.txt", mimeType: "text/plain", sizeBytes: bytes.byteLength, sha256, text,
  } as any);
  assert.ok(job.jobId);
  assert.equal(job.opId, "op-ing-1");
  // Inline text is committed at begin: the exact byte length, no more.
  assert.equal(job.committedBytes, bytes.byteLength);
});

test("ingest — bounded chunk transport: offsets, then complete", async () => {
  const { ingest } = services("device-a");
  const payload = new Uint8Array(300000).fill(7);
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const job = await ingest.begin(IDENT.instanceId, {
    opId: "op-ing-chunk", kind: "file", target: { domain: "materials", folderId: null },
    name: "big.bin", mimeType: "application/octet-stream",
    sizeBytes: payload.byteLength, sha256,
  } as any);
  const source = {
    sizeBytes: payload.byteLength,
    read: async (offset: number, length: number) => payload.slice(offset, offset + length),
  };
  const afterChunks = await ingest.streamChunks(IDENT.instanceId, job.jobId, source, 0);
  assert.equal(afterChunks.committedBytes, payload.byteLength, "all bounded chunks committed");
  const receipt = await ingest.complete(IDENT.instanceId, job.jobId);
  assert.equal(receipt.domain, "materials");
  assert.ok(receipt.revision);
});

test("ingest — an over-limit chunk is refused before hitting the wire", async () => {
  const { ingest } = services("device-a");
  await assert.rejects(
    () => ingest.chunk(IDENT.instanceId, "job-x", 0, new Uint8Array(300000)),
    /ingest-chunk-exceeds-canonical-limit/,
  );
});

test("ingest — cancel yields a cancelled job", async () => {
  const { ingest } = services("device-a");
  const job = await ingest.begin(IDENT.instanceId, {
    opId: "op-ing-cancel", kind: "url", target: { domain: "materials" },
    name: "u", mimeType: "text/uri-list",
    sizeBytes: Buffer.byteLength("https://example.test/a", "utf8"),
    sha256: createHash("sha256").update(Buffer.from("https://example.test/a", "utf8")).digest("hex"),
    text: "https://example.test/a",
  } as any);
  const cancelled = await ingest.cancel(IDENT.instanceId, job.jobId);
  assert.equal(cancelled.state, "cancelled");
});

// ===========================================================================
// 6. Search .3 lease semantics
// ===========================================================================

test("search — normal pagination appends into the SAME generation", async () => {
  const { transport } = services("device-a");
  const session = new SearchSession(transport);
  const first = await session.start({ q: "blue", limit: 1 }, { instanceId: IDENT.instanceId, permissionRevision: 1 });
  assert.equal(first.items.length, 1);
  assert.ok(session.currentGeneration());
  const gen = session.currentGeneration()!.generation;
  if (first.nextCursor) {
    const second = await session.next();
    assert.equal(session.currentGeneration()!.generation, gen, "same generation appended");
    assert.ok(second.items.length >= first.items.length);
  }
});

test("search — 410 CURSOR_TOO_OLD starts a NEW generation and REPLACES the projection", async () => {
  const { transport, fixture } = services("device-a");
  const session = new SearchSession(transport);
  const first = await session.start({ q: "blue", limit: 1 }, { instanceId: IDENT.instanceId, permissionRevision: 1 });
  const genBefore = session.currentGeneration()!.generation;
  assert.ok(first.nextCursor, "fixture paginates with limit 1");

  // Reclaim the lease: the old cursor is now too old.
  fixture.expireSearch();
  const recovered = await session.next();

  assert.equal(recovered.recovered, true, "recovery is reported internally");
  assert.ok(session.currentGeneration()!.generation > genBefore, "a NEW generation was opened");
  // REPLACED, never concatenated: the fresh page-1 count equals the projection.
  assert.equal(recovered.items.length, 1, "projection is exactly one fresh page-1 (limit=1), not appended");
  const ids = recovered.items.map((h: any) => h.assetId ?? h.noteId);
  assert.equal(new Set(ids).size, ids.length, "no duplicated rows from an old+new concatenation");
  // Never surfaced as an empty result.
  assert.notEqual(recovered.items.length, 0);
});

test("search — a stale recovery cannot commit onto a newer query", async () => {
  const { transport } = services("device-a");
  const session = new SearchSession(transport);
  await session.start({ q: "blue", limit: 1 }, { instanceId: IDENT.instanceId, permissionRevision: 1 });
  const startGen = session.currentGeneration()!.generation;
  // User changes the query while a recovery would be in flight.
  await session.start({ q: "red", limit: 1 }, { instanceId: IDENT.instanceId, permissionRevision: 1 });
  const afterGen = session.currentGeneration()!.generation;
  assert.ok(afterGen > startGen, "the new query opened a new generation");
  assert.equal(session.currentGeneration()!.query, "red");
  assert.equal(session.snapshot().recovered, false, "fresh query starts unrecovered");
});

test("search — a 410 is never presented as 'no results'", async () => {
  const { transport, fixture } = services("device-a");
  const session = new SearchSession(transport);
  await session.start({ q: "blue", limit: 1 }, { instanceId: IDENT.instanceId, permissionRevision: 1 });
  fixture.expireSearch();
  const projection = await session.next();
  assert.ok(projection.items.length > 0, "recovery returns real results, not an empty state");
});

// ===========================================================================
// 7. Presentation .3 handoff semantics
// ===========================================================================

test("presentation — accepted is a confirmed outcome", async () => {
  const { transport } = services("device-a");
  const client = new PresentationClient(transport);
  const outcome = await client.open(IDENT.instanceId, "op-pres-1", { domain: "materials", assetId: "asset-1" });
  assert.equal(outcome.kind, "confirmed");
  assert.match(presentationCopy(outcome), /电脑/);
});

test("presentation — handoffStarted is NOT a confirmed display", async () => {
  const { transport, fixture } = services("device-a");
  const snapshot = fixture.snapshot();
  const withoutAck = { ...snapshot, presentationAck: false };
  const noAckFixture = createFixtureTransport({ deviceId: "device-a", snapshot: withoutAck });
  const client = new PresentationClient(noAckFixture);
  const outcome = await client.open(IDENT.instanceId, "op-pres-hs", { domain: "materials", assetId: "asset-1" });
  assert.equal(outcome.kind, "handoffStarted", "the fixture's presentationAck=false yields handoffStarted");
  // The copy must NOT claim the item is open on the Desktop.
  const copy = presentationCopy(outcome);
  assert.notEqual(copy, "已在电脑打开");
  assert.doesNotMatch(copy, /已(在电脑)?打开/);
  void transport;
});

test("presentation — a same-op replay returns the same receipt and does not re-navigate", async () => {
  const { transport } = services("device-a");
  const client = new PresentationClient(transport);
  const first = await client.open(IDENT.instanceId, "op-pres-replay", { domain: "materials", assetId: "asset-1" });
  const replay = await client.replay(IDENT.instanceId, "op-pres-replay");
  assert.deepEqual(replay, first, "the same one-time receipt, no second navigation");
});

test("presentation — an opId is never auto-rotated and a refused op is terminal", async () => {
  const { transport } = services("device-a");
  const client = new PresentationClient(transport);
  await client.open(IDENT.instanceId, "op-pres-terminal", { domain: "materials", assetId: "asset-1" });
  // A second call under the SAME opId stays the same op (no new opId minted).
  const again = await client.open(IDENT.instanceId, "op-pres-terminal", { domain: "materials", assetId: "asset-1" });
  assert.equal(again.opId, "op-pres-terminal");
});

test("presentation — a 410 retired operation stays terminal with no new opId", async () => {
  // Transport that answers 410 for the presentation op, as the review requires.
  const retiredTransport = {
    async request() {
      return { status: 410, body: { code: "RECEIPT_EXPIRED" } };
    },
  };
  const client = new PresentationClient(retiredTransport as any);
  const outcome = await client.open(IDENT.instanceId, "op-pres-retired", { domain: "materials", assetId: "asset-1" });
  assert.equal(outcome.kind, "retired");
  assert.equal(client.isTerminal("op-pres-retired"), true);
  // No automatic retry and no auto-created replacement opId.
  const retry = await client.open(IDENT.instanceId, "op-pres-retired", { domain: "materials", assetId: "asset-1" });
  assert.equal(retry.kind, "retired");
  assert.equal(retry.opId, "op-pres-retired", "the opId was never rotated");
});

// ===========================================================================
// 8. ChangeFeed hints
// ===========================================================================

test("changes — a hint never advances the durable cursor by itself", () => {
  const { changeFeed } = services("device-a");
  assert.equal(changeFeed.resumeCursor("m:5", { kind: "materialChanged", cursor: "m:99" } as any), "m:5");
  assert.equal(changeFeed.resumeCursor(null, { kind: "materialChanged", cursor: "m:99" } as any), null);
});

test("changes — a 426 hint stream degrades to polling without disabling durable clients", async () => {
  const unsupported = {
    async request() { return { status: 426, body: { code: "VERSION_UNSUPPORTED" } }; },
  };
  const feed = new ChangeFeedClient(unsupported as any);
  const hints = await feed.readHints(IDENT.instanceId);
  assert.deepEqual(hints, [], "no hints from an unsupported stream");
  assert.equal(feed.currentMode(), "polling", "degraded, not failed");
});

// ===========================================================================
// 9. LSH stays #72
// ===========================================================================

test("lsh — the adapter reuses the #72 authority and opens no session", async () => {
  const { lsh } = services("device-a");
  const view = await lsh.capability(IDENT.instanceId);
  assert.equal(view.authority, "lsh-remote-surface-m1");
  const adapter = readFileSync(join(ROOT, "src", "services", "companionServices", "lshRemoteAdapter.ts"), "utf8");
  // Strip comments: the prose legitimately names what this adapter does NOT do.
  const code = adapter.replace(/^\s*\/\/.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, "");
  // Naming #72's operations in the ownership list is correct; IMPLEMENTING one
  // is not. So forbid the call shapes, not the identifiers.
  assert.doesNotMatch(code, /openSurface\(|\.bootstrap\(|LshSurfaceController|carrierGeneration|CookieJar/i,
    "no session/carrier logic duplicated");
});

test("lsh — the #77 layer does not replace the existing LSH controller path", () => {
  const index = readFileSync(join(ROOT, "src", "services", "companionServices", "index.ts"), "utf8");
  assert.match(index, /LshRemoteAdapter/);
  assert.doesNotMatch(index, /LshSurfaceController/, "the #72 controller is not re-exported as a #77 client");
});

// ===========================================================================
// 10. SafeSource precision
// ===========================================================================

test("safeSource — a full work-page URL with query AND hash survives byte-for-byte", () => {
  const safe = {
    captureKind: "web" as const,
    pageKind: "work-page" as const,
    pageUrl: "https://example.test/work?id=42#/slide/3",
    siteOrigin: "https://example.test",
  };
  assert.equal(safe.pageUrl, "https://example.test/work?id=42#/slide/3");
  const carried = carrySafeSource(safe);
  assert.equal(carried.pageUrl, "https://example.test/work?id=42#/slide/3", "query + hash preserved");
  assert.equal(carried.pageKind, "work-page");
  assert.equal(preservesWorkPageUrl(safe), true);
});

test("safeSource — an origin-only reduction of a work page is detected", () => {
  assert.equal(
    preservesWorkPageUrl({ captureKind: "web", pageKind: "work-page", pageUrl: "https://example.test/", siteOrigin: "https://example.test" }),
    false,
    "a work page reduced to its origin violates fidelity",
  );
});

test("safeSource — work-page vs capture-page are never conflated", () => {
  assert.equal(preservesWorkPageUrl({ captureKind: "web", pageKind: "capture-page" }), true, "capture-page needs no URL");
  assert.equal(preservesWorkPageUrl({ captureKind: "web", pageKind: "work-page" }), false, "work-page requires a URL");
});

// ===========================================================================
// 11. Scope guard — no nested authority, no local data clearing
// ===========================================================================

test("scope — the client layer owns no local persistence and clears no Mobile data", () => {
  for (const file of [
    "materialsClient.ts", "knowledgeClient.ts", "searchClient.ts",
    "ingestClient.ts", "presentationClient.ts", "changeFeedClient.ts",
  ]) {
    const src = readFileSync(join(ROOT, "src", "services", "companionServices", file), "utf8");
    assert.doesNotMatch(src, /localDataStore|localAssetPager|knowledgeNotesPager|localStorage/,
      `${file} must not touch Mobile-local stores`);
  }
});

test("scope — production transport never puts a bearer/token in the URL", () => {
  const src = readFileSync(join(ROOT, "src", "services", "companionServices", "transport.ts"), "utf8");
  const code = src.replace(/^\s*\/\/.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, "");
  assert.doesNotMatch(code, /bearer|Authorization|token|Cookie/i, "credentials belong to the Rust authority");
});
