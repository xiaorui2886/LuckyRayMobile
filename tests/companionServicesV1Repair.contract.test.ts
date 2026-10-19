// REPAIR-R1 (#77) — production transport + client closure.
// Run: node --experimental-strip-types --test tests/companionServicesV1Repair.contract.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createCompanionServices, createFixtureTransport, createTauriServicesTransport,
  KnowledgeClient, PresentationClient, ServiceRegistry, IngestClient, MaterialsClient,
  ServicesError, base64Of, callServices,
} from "../src/services/companionServices/index.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const IDENT = { instanceId: "fixture-desktop-1", gatewayGeneration: 7, permissionRevision: 1 };

function services(deviceId = "device-a") {
  const transport = createFixtureTransport({ deviceId });
  return { transport, ...createCompanionServices(transport), fixture: transport.fixture };
}

// ===========================================================================
// P1-K1 — Knowledge registered list uses canonical afterId/limit/q
// ===========================================================================

test("P1-K1 — registeredList sends canonical afterId (never `after`)", async () => {
  const src = read("src", "services", "companionServices", "knowledgeClient.ts");
  assert.match(src, /afterId: options\.afterId/, "the canonical key is sent");
  const code = src.replace(/^\s*\/\/.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, "");
  // `after` IS canonical for the two CHANGE feeds; only the registered LIST must
  // use afterId, so scope the check to that method.
  const listAt = code.indexOf("async registeredList(");
  const listBody = code.slice(listAt, code.indexOf("async move(", listAt));
  assert.doesNotMatch(listBody, /query: \{ after:/u, "the wrong query key is gone from registeredList");
  assert.match(listBody, /afterId: options\.afterId/u, "afterId is what the list sends");
  assert.match(listBody, /limit: options\.limit/u, "limit is offered");
  assert.match(listBody, /q: options\.q/u, "q is offered");
  const client = new KnowledgeClient({ async request() { return { status: 200, body: { items: [], hasMore: false, nextAfterId: null } }; } } as any);
  await client.registeredList(IDENT.instanceId, "vault-1", { afterId: "note-5" });
});

test("P1-K1 — a real paginated request against the fixture works and is not INPUT_INVALID", async () => {
  const { knowledge, fixture } = services("device-a");
  // Seed enough notes to force a real page boundary.
  const snapshot = fixture.snapshot();
  const many = Array.from({ length: 5 }, (_, i) => ({
    vaultId: "vault-1", noteId: `note-${i + 1}`, title: `Note ${i + 1}`,
    content: "body", revision: `r${i + 1}`, parentRelativePath: "",
  }));
  const paged = createFixtureTransport({
    deviceId: "device-a",
    snapshot: { ...snapshot, notes: many },
  });
  const pagedKnowledge = new KnowledgeClient(paged);
  const first = await pagedKnowledge.registeredList(IDENT.instanceId, "vault-1", { limit: 2 });
  assert.equal(first.items.length, 2, "canonical limit honoured");
  assert.equal(first.hasMore, true);
  assert.ok(first.nextAfterId, "canonical nextAfterId returned");
  const second = await pagedKnowledge.registeredList(IDENT.instanceId, "vault-1", {
    afterId: first.nextAfterId!, limit: 2,
  });
  assert.ok(second.items.length > 0, "the second page reads via afterId");
  assert.notEqual(second.items[0].noteId, first.items[0].noteId, "a genuinely different page");
  void knowledge;
});

test("P1-K1 — q filters within the registered list", async () => {
  const { fixture } = services("device-a");
  const snapshot = fixture.snapshot();
  const notes = [
    { vaultId: "vault-1", noteId: "note-1", title: "Blue train", content: "", revision: "r1", parentRelativePath: "" },
    { vaultId: "vault-1", noteId: "note-2", title: "Red bus", content: "", revision: "r2", parentRelativePath: "" },
  ];
  const t = createFixtureTransport({ deviceId: "device-a", snapshot: { ...snapshot, notes } });
  const k = new KnowledgeClient(t);
  const page = await k.registeredList(IDENT.instanceId, "vault-1", { q: "blue" });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].noteId, "note-1");
});

// ===========================================================================
// P1-P1 — Presentation replay keeps the immutable target
// ===========================================================================

test("P1-P1 — replay never fabricates a target: unknown handle is refused", async () => {
  const { transport } = services("device-a");
  const client = new PresentationClient(transport);
  const outcome = await client.replay(IDENT.instanceId, "op-unknown");
  assert.equal((outcome as any).kind, "unresolvedHandle", "refused rather than inventing a target");
  const src = read("src", "services", "companionServices", "presentationClient.ts");
  assert.doesNotMatch(src, /assetId: ""/, "the fabricated empty target is gone");
});

test("P1-P1 — cold client B replays client A's opId + target and gets the durable receipt", async () => {
  // Client A opens the op over the fixture state.
  const first = services("device-a");
  const a = new PresentationClient(first.transport);
  const target = { domain: "materials", assetId: "asset-1" } as const;
  const opened = await a.open(IDENT.instanceId, "op-cold-1", target);
  assert.equal(opened.kind, "confirmed");
  const handle = a.handle("op-cold-1");
  assert.deepEqual(handle, { opId: "op-cold-1", target }, "A can persist the handle");

  // A is DISCARDED; B is a fresh client over the SAME fixture state.
  const b = new PresentationClient(first.transport);
  const replayed = await b.replay(IDENT.instanceId, handle!.opId, handle!.target);
  assert.deepEqual(replayed, opened, "B receives the same durable receipt");
  assert.equal((replayed as any).opId, "op-cold-1", "same opId, never rotated");
});

test("P1-P1 — same opId with a DIFFERENT target is not accepted as that receipt", async () => {
  const { transport } = services("device-a");
  const a = new PresentationClient(transport);
  await a.open(IDENT.instanceId, "op-dup", { domain: "materials", assetId: "asset-1" });
  // A different target under the same opId is an OP_ID_REUSED style conflict,
  // surfaced faithfully rather than silently accepted.
  await assert.rejects(
    () => a.open(IDENT.instanceId, "op-dup", { domain: "materials", assetId: "asset-2" }),
    (e: any) => e instanceof ServicesError && e.code === "OP_ID_REUSED",
  );
});

test("P1-P1 — handoffStarted is still non-confirmed and 410 still terminal", async () => {
  const snapshot = { ...createFixtureTransport({ deviceId: "device-a" }).fixture.snapshot(), presentationAck: false };
  const noAck = createFixtureTransport({ deviceId: "device-a", snapshot });
  const client = new PresentationClient(noAck);
  const outcome = await client.open(IDENT.instanceId, "op-hs", { domain: "materials", assetId: "asset-1" });
  assert.equal(outcome.kind, "handoffStarted");

  const retired = new PresentationClient({ async request() { return { status: 410, body: { code: "RECEIPT_EXPIRED" } }; } } as any);
  const r = await retired.open(IDENT.instanceId, "op-x", { domain: "materials", assetId: "asset-1" });
  assert.equal(r.kind, "retired");
  assert.equal(retired.isTerminal("op-x"), true);
});

// ===========================================================================
// P1-R1 — registry scope + catalog permission revision
// ===========================================================================

test("P1-R1 — OperationView exposes the canonical scope", async () => {
  const { registry } = services("device-a");
  await registry.refresh(IDENT);
  assert.equal(registry.operation("materials.detailV1").scope, "asset");
  assert.equal(registry.operation("materials.changes").scope, "catalog");
  assert.equal(registry.operation("ingest.chunk").scope, "ownedJob");
  assert.equal(registry.operation("no.such.op").scope, null, "unknown scope fails closed");
});

test("P1-R1 — initial discovery works WITHOUT knowing a permission revision", async () => {
  const { registry } = services("device-a");
  // No expected revision supplied: must succeed.
  const catalog = await registry.refresh(IDENT);
  assert.equal(catalog.permissionRevision, 1);
  assert.equal(registry.permissionRevision(), 1);
});

test("P1-R1 — namespace uses the CATALOG revision, not caller belief", async () => {
  const { registry, fixture } = services("device-a");
  // Caller believes revision 1, fixture is at 1.
  await registry.refresh(IDENT);
  assert.equal(registry.currentNamespace(), "fixture-desktop-1|7|1");
  // A permission change bumps the fixture; the caller's stale belief must NOT
  // be what the new catalog is cached under.
  fixture.grant("device-a", "content.read", true); // bumps permissionRevision
  const updated = await registry.refresh(
    { ...IDENT, permissionRevision: 1 },
  );
  assert.ok(updated.permissionRevision >= 2);
  assert.notEqual(registry.currentNamespace(), "fixture-desktop-1|7|1", "not cached under the stale belief");
  assert.equal(registry.currentNamespace(), `fixture-desktop-1|7|${updated.permissionRevision}`);
});

test("P1-R1 — an expected revision mismatch fails closed and caches nothing", async () => {
  const { registry } = services("device-a");
  await assert.rejects(
    () => registry.refresh(IDENT, 999),
    /services-catalog-permission-revision-mismatch/,
  );
  assert.equal(registry.snapshot(), null, "no truth retained after a mismatch");
  assert.equal(registry.currentNamespace(), "");
});

test("P1-R1 — a matching expected revision is accepted", async () => {
  const { registry } = services("device-a");
  const catalog = await registry.refresh(IDENT, 1);
  assert.equal(catalog.permissionRevision, 1);
  assert.equal(registry.currentNamespace(), "fixture-desktop-1|7|1");
});

// ===========================================================================
// P2-I1 — ingest stream refuses degenerate reads
// ===========================================================================

test("P2-I1 — a zero-length read is refused instead of spinning", async () => {
  const { ingest } = services("device-a");
  const { createHash } = await import("node:crypto");
  const payload = new Uint8Array(300000).fill(3);
  const job = await ingest.begin(IDENT.instanceId, {
    opId: "op-zero", kind: "file", target: { domain: "materials", folderId: null },
    name: "z.bin", mimeType: "application/octet-stream", sizeBytes: payload.byteLength,
    sha256: createHash("sha256").update(payload).digest("hex"),
  } as any);
  const source = {
    sizeBytes: payload.byteLength,
    read: async () => new Uint8Array(0), // premature EOF
  };
  await assert.rejects(
    () => ingest.streamChunks(IDENT.instanceId, job.jobId, source, 0),
    /ingest-source-read-empty/,
  );
});

test("P2-I1 — a SHORT read is refused (it would silently skip bytes)", async () => {
  const { ingest } = services("device-a");
  const { createHash } = await import("node:crypto");
  const payload = new Uint8Array(300000).fill(4);
  const job = await ingest.begin(IDENT.instanceId, {
    opId: "op-short", kind: "file", target: { domain: "materials", folderId: null },
    name: "s.bin", mimeType: "application/octet-stream", sizeBytes: payload.byteLength,
    sha256: createHash("sha256").update(payload).digest("hex"),
  } as any);
  const source = { sizeBytes: payload.byteLength, read: async () => new Uint8Array(10) };
  await assert.rejects(
    () => ingest.streamChunks(IDENT.instanceId, job.jobId, source, 0),
    /ingest-source-read-short/,
  );
});

test("P2-I1 — an OVERSIZED read is refused before send", async () => {
  const { ingest } = services("device-a");
  const { createHash } = await import("node:crypto");
  const payload = new Uint8Array(300000).fill(5);
  const job = await ingest.begin(IDENT.instanceId, {
    opId: "op-big", kind: "file", target: { domain: "materials", folderId: null },
    name: "b.bin", mimeType: "application/octet-stream", sizeBytes: payload.byteLength,
    sha256: createHash("sha256").update(payload).digest("hex"),
  } as any);
  const source = { sizeBytes: payload.byteLength, read: async () => new Uint8Array(400000) };
  await assert.rejects(
    () => ingest.streamChunks(IDENT.instanceId, job.jobId, source, 0),
    /ingest-source-read-oversized/,
  );
});

test("P2-I1 — a well-behaved bounded source still streams and completes", async () => {
  const { ingest } = services("device-a");
  const { createHash } = await import("node:crypto");
  const payload = new Uint8Array(300000).fill(6);
  const job = await ingest.begin(IDENT.instanceId, {
    opId: "op-ok", kind: "file", target: { domain: "materials", folderId: null },
    name: "ok.bin", mimeType: "application/octet-stream", sizeBytes: payload.byteLength,
    sha256: createHash("sha256").update(payload).digest("hex"),
  } as any);
  const source = {
    sizeBytes: payload.byteLength,
    read: async (offset: number, length: number) => payload.slice(offset, offset + length),
  };
  const last = await ingest.streamChunks(IDENT.instanceId, job.jobId, source, 0);
  assert.equal(last.committedBytes, payload.byteLength);
  const receipt = await ingest.complete(IDENT.instanceId, job.jobId);
  assert.ok(receipt.revision);
});

test("P2-I1 — an invalid resume offset is refused", async () => {
  const { ingest } = services("device-a");
  const source = { sizeBytes: 10, read: async () => new Uint8Array(10) };
  await assert.rejects(
    () => ingest.streamChunks(IDENT.instanceId, "job-any", source, -1),
    /ingest-resume-offset-invalid/,
  );
  await assert.rejects(
    () => ingest.streamChunks(IDENT.instanceId, "job-any", source, 99),
    /ingest-resume-offset-invalid/,
  );
});

// ===========================================================================
// P1-T1 — production transport over a FAKE authority (no live Desktop)
// ===========================================================================

/** A fake Rust-side authority that applies the same pre-wire rules. */
function fakeAuthority() {
  const calls: any[] = [];
  const ALLOW = [
    { op: "services.discover", m: "GET", t: "/v1/services" },
    { op: "materials.detailV1", m: "GET", t: "/v1/services/materials/assets/*" },
    { op: "materials.metadataPatch", m: "PATCH", t: "/v1/services/materials/assets/*" },
    { op: "materials.removeRecord", m: "DELETE", t: "/v1/services/materials/assets/*" },
    { op: "presentation.open", m: "POST", t: "/v1/services/presentation/open" },
    { op: "ingest.chunk", m: "PUT", t: "/v1/services/ingest/jobs/*/chunks" },
  ];
  const CRED = ["token", "access_token", "cookie", "authorization", "secret"];
  const matches = (t: string, p: string) => {
    const a = t.split("/"); const b = p.split("/");
    return a.length === b.length && a.every((s, i) => (s === "*" ? b[i].length > 0 : s === b[i]));
  };
  const invoke = async (_cmd: string, args?: Record<string, unknown>) => {
    const r = (args as any).request;
    // Refusals carry no status: they never reached the wire.
    if (!r.path.startsWith("/v1/services")) throw { code: "SERVICES_PATH_NOT_ALLOWED" };
    if (r.path.includes("://") || r.path.includes("..")) throw { code: "SERVICES_PATH_INVALID" };
    const entry = ALLOW.find((a) => a.op === r.operationId && a.m === r.method);
    if (!entry) throw { code: "SERVICES_OPERATION_NOT_ALLOWED" };
    if (!matches(entry.t, r.path)) throw { code: "SERVICES_PATH_NOT_ALLOWED" };
    for (const k of Object.keys(r.query ?? {})) {
      if (CRED.includes(k.toLowerCase())) throw { code: "SERVICES_QUERY_CREDENTIAL_FORBIDDEN" };
    }
    if (!r.instance) throw { code: "CONTENT_SOURCE_CHANGED" };
    if (r.instance !== "fixture-desktop-1") throw { code: "CONTENT_SOURCE_CHANGED" };
    calls.push(r);
    return { status: 200, body: { ok: true, operationId: r.operationId } };
  };
  return { invoke, calls };
}

function transportOver(fake: ReturnType<typeof fakeAuthority>) {
  return createTauriServicesTransport(fake.invoke as any);
}

test("P1-T1 — the production transport composes the whole Services surface", () => {
  const fake = fakeAuthority();
  const composed = createCompanionServices(transportOver(fake));
  assert.ok(composed.registry instanceof ServiceRegistry);
  assert.ok(composed.materials instanceof MaterialsClient);
  assert.ok(composed.knowledge instanceof KnowledgeClient);
  assert.ok(composed.ingest instanceof IngestClient);
  assert.ok(composed.presentation instanceof PresentationClient);
});

test("P1-T1 — a WRONG expected instance is refused before the wire", async () => {
  const fake = fakeAuthority();
  const t = transportOver(fake);
  await assert.rejects(
    () => t.request({ instance: "some-other-desktop", operationId: "services.discover", method: "GET", path: "/v1/services" }),
    (e: any) => e instanceof ServicesError && e.code === "SOURCE_CHANGED" && e.status === 0,
  );
  assert.equal(fake.calls.length, 0, "nothing reached the wire");
});

test("P1-T1 — an unknown operation is refused before the wire", async () => {
  const fake = fakeAuthority();
  const t = transportOver(fake);
  await assert.rejects(
    () => t.request({ instance: "fixture-desktop-1", operationId: "materials.restore", method: "PATCH", path: "/v1/services/materials/assets/a" }),
    (e: any) => e instanceof ServicesError && e.code === "INPUT_INVALID" && e.status === 0,
  );
  assert.equal(fake.calls.length, 0);
});

test("P1-T1 — an arbitrary non-Services path is refused before the wire", async () => {
  const fake = fakeAuthority();
  const t = transportOver(fake);
  for (const path of ["/v1/hello", "/v1/assets", "https://evil.test/v1/services", "/v1/services/../../etc"]) {
    await assert.rejects(
      () => t.request({ instance: "fixture-desktop-1", operationId: "services.discover", method: "GET", path }),
      (e: any) => e instanceof ServicesError && e.status === 0,
    );
  }
  assert.equal(fake.calls.length, 0);
});

test("P1-T1 — a credential in the query is refused before the wire", async () => {
  const fake = fakeAuthority();
  const t = transportOver(fake);
  await assert.rejects(
    () => t.request({ instance: "fixture-desktop-1", operationId: "services.discover", method: "GET", path: "/v1/services", query: { token: "x" } }),
    (e: any) => e instanceof ServicesError && e.code === "INPUT_INVALID",
  );
  assert.equal(fake.calls.length, 0);
});

test("P1-T1 — JSON GET/PATCH/DELETE/POST all travel with the right method", async () => {
  const fake = fakeAuthority();
  const t = transportOver(fake);
  await t.request({ instance: "fixture-desktop-1", operationId: "services.discover", method: "GET", path: "/v1/services" });
  await t.request({ instance: "fixture-desktop-1", operationId: "materials.metadataPatch", method: "PATCH", path: "/v1/services/materials/assets/a", body: { opId: "o", expectedRevision: "r" } });
  await t.request({ instance: "fixture-desktop-1", operationId: "materials.removeRecord", method: "DELETE", path: "/v1/services/materials/assets/a", body: { opId: "o", expectedRevision: "r", mode: "removeRecord" } });
  await t.request({ instance: "fixture-desktop-1", operationId: "presentation.open", method: "POST", path: "/v1/services/presentation/open", body: { opId: "o", target: { domain: "materials", assetId: "a" } } });
  assert.deepEqual(fake.calls.map((c) => c.method), ["GET", "PATCH", "DELETE", "POST"]);
});

test("P1-T1 — a raw chunk travels as bounded base64 + offset + sha256", async () => {
  const fake = fakeAuthority();
  const t = transportOver(fake);
  const bytes = new Uint8Array([1, 2, 3, 4]);
  await t.request({
    instance: "fixture-desktop-1", operationId: "ingest.chunk", method: "PUT",
    path: "/v1/services/ingest/jobs/job-1/chunks",
    chunk: { offset: 0, bytes, sha256: "a".repeat(64) },
  });
  const sent = fake.calls[0].chunk;
  assert.equal(sent.offset, 0);
  assert.equal(sent.sha256, "a".repeat(64));
  assert.equal(typeof sent.bytes_base64, "string");
  assert.equal(base64Of(bytes), sent.bytes_base64, "base64 without Node APIs");
});

test("P1-T1 — a canonical non-2xx status/code is propagated verbatim", async () => {
  const t = createTauriServicesTransport((async () => ({
    status: 410, body: { code: "CURSOR_TOO_OLD" },
  })) as any);
  // The transport reports the status; `callServices` (the single funnel every
  // client uses) turns it into a faithful error carrying the code AND status.
  const res = await t.request({
    instance: "d", operationId: "materials.changes", method: "GET", path: "/v1/services/materials/changes",
  });
  assert.equal(res.status, 410, "status crosses the boundary unchanged");
  await assert.rejects(
    () => callServices(t, { instance: "d", operationId: "materials.changes", method: "GET", path: "/v1/services/materials/changes" }),
    (e: any) => e instanceof ServicesError && e.code === "CURSOR_TOO_OLD" && e.status === 410,
  );
});

test("P1-T1 — an infrastructure failure is a faithful error, never a silent success", async () => {
  const t = createTauriServicesTransport((async () => { throw "boom"; }) as any);
  await assert.rejects(
    () => t.request({ instance: "d", operationId: "services.discover", method: "GET", path: "/v1/services" }),
    (e: any) => e instanceof ServicesError && e.code === "TRANSPORT_FAILED" && e.status === 0,
  );
});

test("P1-T1 — a malformed reply is rejected", async () => {
  const t = createTauriServicesTransport((async () => ({ nope: true })) as any);
  await assert.rejects(
    () => t.request({ instance: "d", operationId: "services.discover", method: "GET", path: "/v1/services" }),
    (e: any) => e instanceof ServicesError && e.code === "MALFORMED_RESPONSE",
  );
});

test("P1-T1 — the TS transport never builds a URL, origin or credential", () => {
  const src = read("src", "services", "companionServices", "productionTransport.ts");
  const code = src.replace(/^\s*\/\/.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, "");
  // Real egress only: a fetch/WebSocket call or a constructed Desktop URL.
  assert.doesNotMatch(code, /fetch\(|new WebSocket|WebSocket\(/u, "no direct network on the TS side");
  assert.doesNotMatch(code, /["'`]https?:\/\//u, "no Desktop origin is ever constructed");
  assert.doesNotMatch(code, /headers\s*:\s*\{[^}]*[Aa]uthorization/u, "no credential is attached here");
  // The command is invoked through the injected/default `invokeRef`.
  assert.match(code, /invokeRef\(\s*"services_v1_request"/u, "the only egress is the Tauri command");
  // The production default is the Tauri `invoke` (imported at the top).
  assert.match(src, /import \{ invoke \} from "@tauri-apps\/api\/core"/u,
    "the production default is the Tauri invoke");
});

test("P1-T1 — the Rust command is registered and the module exists", () => {
  const lib = read("src-tauri", "src", "lib.rs");
  assert.match(lib, /mod services_v1;/, "module declared");
  assert.match(lib, /services_v1::services_v1_request,/, "command registered in the handler");
  const rust = read("src-tauri", "src", "services_v1.rs");
  // Owner proof before AND after the awaited response.
  assert.match(rust, /expected_gateway\(&state, &request\.instance\)/, "expected owner captured");
  // Each Services gateway method proves the owner before the send and again
  // after the awaited response.
  const content = read("src-tauri", "src", "content.rs");
  for (const method of ["services_request(", "services_request_json(", "services_request_with_chunk("]) {
    const at = content.indexOf(method);
    assert.ok(at > 0, `${method} exists`);
    // Slice to the NEXT method (or EOF) so the whole body is inspected.
    const nextAt = content.indexOf("pub(crate) async fn ", at + 1);
    const body = content.slice(at, nextAt > at ? nextAt : undefined);
    // G1-N upgraded this from an instance-only check to the captured-epoch
    // fence, which proves the owner AND the captured connection epoch.
    assert.equal((body.match(/services_connection_current\(state\)\?/gu) ?? []).length, 2,
      `${method} fences the captured connection on both sides of the await`);
    assert.match(body, /\.await\?/, `${method} awaits the gateway`);
  }
  // No generic proxy: closed allowlist + template matching.
  assert.match(rust, /const ALLOWED: &\[Allowed\]/, "closed allowlist");
  assert.match(rust, /template_matches/, "template matching");
  assert.match(rust, /MAX_CHUNK_BYTES: usize = 262_144/, "canonical chunk bound");
});

test("P1-T1 — the Rust transport reuses the existing pinned gateway (no new authority)", () => {
  const rust = read("src-tauri", "src", "services_v1.rs");
  assert.match(rust, /expected_gateway/, "uses the existing expected-owner seam");
  assert.doesNotMatch(rust, /reqwest::Client::builder|build_pinned_client_config|Client::new\(\)/,
    "no second HTTP client / TLS authority");
  const content = read("src-tauri", "src", "content.rs");
  assert.match(content, /services_request_json/, "ExpectedGateway gained the JSON method");
  assert.match(content, /services_request_with_chunk/, "ExpectedGateway gained the chunk method");
  assert.match(content, /source\.gateway\.content_request/, "delegates to the pinned GatewayClient");
});

// ===========================================================================
// P1-W1 — the nested Tauri wire shape is explicit on BOTH sides
// ===========================================================================

test("P1-W1 — TS emits the exact nested wire shape Rust declares", async () => {
  let captured: any = null;
  const t = createTauriServicesTransport((async (_cmd: string, args: any) => {
    captured = args;
    return { status: 200, body: { ok: true } };
  }) as any);
  await t.request({
    instance: "fixture-desktop-1",
    operationId: "materials.metadataPatch",
    method: "PATCH",
    path: "/v1/services/materials/assets/asset-1",
    query: { limit: 5, skip: undefined as any },
    body: { opId: "o" },
  });
  assert.deepEqual(Object.keys(captured).sort(), ["request"], "one nested `request` object");
  const wire = captured.request;
  assert.deepEqual(
    Object.keys(wire).sort(),
    ["body", "chunk", "instance", "method", "operationId", "path", "query"],
    "exactly the Rust-side field names",
  );
  assert.equal(wire.operationId, "materials.metadataPatch", "camelCase operationId, not snake_case");
  assert.equal("operation_id" in wire, false, "no snake_case leaking onto the wire");
  assert.deepEqual(wire.query, { limit: "5" }, "query values are strings; undefined dropped");
});

test("P1-W1 — TS emits the exact chunk wire shape", async () => {
  let captured: any = null;
  const t = createTauriServicesTransport((async (_cmd: string, args: any) => {
    captured = args;
    return { status: 200, body: {} };
  }) as any);
  await t.request({
    instance: "d", operationId: "ingest.chunk", method: "PUT",
    path: "/v1/services/ingest/jobs/job-1/chunks",
    chunk: { offset: 7, bytes: new Uint8Array([1, 2]), sha256: "a".repeat(64) },
  });
  const chunk = captured.request.chunk;
  assert.deepEqual(Object.keys(chunk).sort(), ["bytes_base64", "offset", "sha256"]);
  assert.equal(chunk.offset, 7);
  assert.equal(chunk.sha256, "a".repeat(64));
});

test("P1-W1 — a bodiless request still carries chunk/body keys as null", async () => {
  let captured: any = null;
  const t = createTauriServicesTransport((async (_cmd: string, args: any) => {
    captured = args;
    return { status: 200, body: {} };
  }) as any);
  await t.request({ instance: "d", operationId: "services.discover", method: "GET", path: "/v1/services" });
  assert.equal(captured.request.chunk, null);
  assert.equal(captured.request.body, null);
});

test("P1-W1 — the Rust struct declares the same names explicitly (no implicit casing)", () => {
  const rust = read("src-tauri", "src", "services_v1.rs");
  assert.match(rust, /#\[serde\(rename = "operationId"\)\]/u, "operationId is renamed explicitly");
  assert.match(rust, /pub operation_id: String/u, "…onto the Rust field");
  assert.match(rust, /#\[serde\(rename = "bytes_base64"\)\]/u, "bytes_base64 is explicit");
  assert.match(rust, /deny_unknown_fields/u, "an unexpected wire field is refused");
  assert.doesNotMatch(rust, /rename_all = "camelCase"/u, "nothing relies on a blanket casing rule");
});
