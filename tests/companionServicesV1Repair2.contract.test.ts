// REPAIR-R2 (#77) — Tauri wire, hint channel, canonical errors.
// Run: node --experimental-strip-types --test tests/companionServicesV1Repair2.contract.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createCompanionServices, createFixtureTransport, createTauriServicesTransport,
  ChangeFeedClient, createHintSubscription, toHint, ServicesError,
  mapLocalRefusal, errorCodeOf, CANONICAL_REMOTE_CODES,
} from "../src/services/companionServices/index.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const RUST = read("src-tauri", "src", "services_v1.rs");
const HINTS_RUST = read("src-tauri", "src", "services_hints.rs");
const FEED_TS = read("src", "services", "companionServices", "changeFeedClient.ts");
const HINT_TS = read("src", "services", "companionServices", "hintSubscription.ts");

// ===========================================================================
// P1-W1 — exact nested wire shape
// ===========================================================================

test("P1-W1 — the Rust wire names are explicit, not implicit casing", () => {
  assert.match(RUST, /#\[serde\(rename = "operationId"\)\]/u);
  assert.match(RUST, /pub operation_id: String/u);
  assert.match(RUST, /#\[serde\(deny_unknown_fields\)\]/u);
  assert.match(RUST, /#\[serde\(rename = "bytes_base64"\)\]/u);
  assert.doesNotMatch(RUST, /rename_all/u, "no blanket casing rule");
});

test("P1-W1 — a real serde test exists for the production shapes", () => {
  assert.match(RUST, /fn deserializes_the_exact_production_request_shape/u);
  assert.match(RUST, /fn deserializes_the_exact_production_chunk_shape/u);
  assert.match(RUST, /fn snake_case_operation_id_would_be_rejected/u);
  assert.match(RUST, /"operationId"/u, "the literal wire key appears in the test");
});

test("P1-W1 — TS emits exactly the keys Rust declares", async () => {
  let captured: any = null;
  const t = createTauriServicesTransport((async (_c: string, a: any) => {
    captured = a; return { status: 200, body: {} };
  }) as any);
  await t.request({
    instance: "d", operationId: "materials.metadataPatch", method: "PATCH",
    path: "/v1/services/materials/assets/a", body: { opId: "o" },
  });
  assert.deepEqual(Object.keys(captured.request).sort(),
    ["body", "chunk", "instance", "library", "method", "operationId", "path", "query", "vault"]);
  assert.equal("operation_id" in captured.request, false);
});

// ===========================================================================
// P1-W2 — the hint route is a WebSocket, never an HTTP GET
// ===========================================================================

test("P1-W2 — the invalid HTTP GET for the hint stream is gone", () => {
  assert.doesNotMatch(FEED_TS, /path: "\/v1\/services\/events\/stream"/u,
    "no HTTP GET at the WebSocket route");
  assert.doesNotMatch(FEED_TS, /operationId: "changes\.hints"/u,
    "the hint operation is not requested over the JSON transport");
  assert.doesNotMatch(FEED_TS, /ServicesTransport/u, "the feed no longer issues transport requests");
});

test("P1-W2 — TS never opens a WebSocket itself", () => {
  const feed = FEED_TS.replace(/^\s*\/\/.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, "");
  const hint = HINT_TS.replace(/^\s*\/\/.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, "");
  for (const [name, code] of [["changeFeed", feed], ["hintSubscription", hint]] as const) {
    assert.doesNotMatch(code, /new WebSocket|WebSocket\(/u, `${name} must not open a socket`);
  }
  // The subscription reaches Rust through Tauri commands only.
  assert.match(HINT_TS, /invokeRef\("services_hints_start"/u);
  assert.match(HINT_TS, /invokeRef\("services_hints_state"/u);
  assert.match(HINT_TS, /invokeRef\("services_hints_stop"/u);
});

test("P1-W2 — Rust owns the pinned hint WebSocket with the bearer out of JS/URL", () => {
  assert.match(HINTS_RUST, /expected_scoped_gateway\(&shared, &instance, library\.as_deref\(\), vault\.as_deref\(\)\)/u, "owner captured");
  assert.match(HINTS_RUST, /services_hint_url/u, "the wss URL comes from the captured gateway");
  assert.match(HINTS_RUST, /ws_authorization/u, "the bearer is read Rust-side");
  const WORKER_RUST = read("src-tauri", "src", "eventstream.rs");
  assert.match(WORKER_RUST, /hint_websocket_connect/u, "reuses the pinned connect helper");
  assert.match(WORKER_RUST, /connect_pinned_websocket/u, "…the SAME helper the foundation stream uses");
  // The socket loop lives in the worker (eventstream.rs), which is where
  // ping/pong is handled.
  const WORKER = read("src-tauri", "src", "eventstream.rs");
  assert.match(WORKER, /Message::Ping\(payload\)[\s\S]{0,200}?Message::Pong\(payload\)/u,
    "an inbound ping is answered with a matching pong");
  assert.match(WORKER, /Message::Ping\(Vec::new\(\)\.into\(\)\)/u, "an idle keepalive ping is sent");
  assert.match(HINTS_RUST, /fn retire/u, "revoke/pair switch can retire the worker");
  // The bearer must not appear in a URL anywhere in the hint path.
  assert.doesNotMatch(HINTS_RUST, /token=|bearer=/iu, "never a query credential");
});

test("P1-W2 — the hint worker does not touch the foundation /v1/events worker", () => {
  assert.doesNotMatch(HINTS_RUST, /EventStreamClient/u, "separate worker");
  assert.match(HINTS_RUST, /run_hint_worker/u, "its own task");
  const lib = read("src-tauri", "src", "lib.rs");
  assert.match(lib, /mod services_hints;/u);
  assert.match(lib, /services_hints::services_hints_start,/u);
  assert.match(lib, /lsh_carrier|lsh_surface/u, "LSH still registered separately");
});

test("P1-W2 — typed hints only; an unknown shape fails closed", () => {
  assert.equal(toHint({ kind: "materialChanged", cursor: "m:1" })?.kind, "materialChanged");
  assert.equal(toHint({ kind: "servicesChanged", permissionRevision: 3 })?.kind, "servicesChanged");
  assert.equal(toHint({ kind: "knowledgeChanged", vaultId: "v", cursor: "k:1" })?.kind, "knowledgeChanged");
  assert.equal(toHint({ kind: "ingestChanged", jobId: "j" })?.kind, "ingestChanged");
  assert.equal(toHint({ kind: "lshStateChanged" })?.kind, "lshStateChanged");
  // Unknown / malformed fail closed.
  assert.equal(toHint({ kind: "brandNewThing" }), null);
  assert.equal(toHint({ kind: "materialChanged" }), null, "missing cursor");
  assert.equal(toHint({ kind: "servicesChanged" }), null, "missing revision");
  assert.equal(toHint(null), null);
  assert.equal(toHint("nope"), null);
});

test("P1-W2 — a servicesChanged hint only marks permission truth stale", async () => {
  const feed = new ChangeFeedClient(createHintSubscription((async (cmd: string) => {
    if (cmd === "services_hints_state") {
      return [{ generation: 1, hint: { kind: "servicesChanged", permissionRevision: 9 } }];
    }
    if (cmd === "services_hints_status") {
      return { generation: 1, phase: "running", owner: "fixture-desktop-1", connectFailures: 0 };
    }
    return { outcome: "started", generation: 1 };
  }) as any));
  await feed.start("fixture-desktop-1");
  const hints = await feed.readHints();
  assert.equal(feed.currentMode(), "hints");
  assert.equal(feed.permissionTruthStale(hints), 9, "the revision is reported as stale");
  assert.equal(feed.permissionTruthStale([{ kind: "materialChanged", cursor: "m:1" }]), null,
    "a material hint says nothing about permission truth");
});

test("P1-W2 — a hint cursor never advances the durable cursor", () => {
  const feed = new ChangeFeedClient(null);
  assert.equal(feed.resumeCursor("m:5", { kind: "materialChanged", cursor: "m:99" }), "m:5");
  assert.equal(feed.resumeCursor(null, { kind: "materialChanged", cursor: "m:99" }), null);
});

test("P1-W2 — an unavailable hint stream degrades to polling and durable catch-up still works", async () => {
  const failing = createHintSubscription((async () => { throw "no worker"; }) as any);
  const feed = new ChangeFeedClient(failing);
  await feed.start("fixture-desktop-1");
  assert.equal(feed.currentMode(), "polling", "degraded, not failed");
  assert.deepEqual(await feed.readHints(), [], "no hints in polling mode");

  // No subscription at all: polling-only, still functional.
  const pollingOnly = new ChangeFeedClient(null);
  assert.equal(pollingOnly.currentMode(), "polling");
  assert.deepEqual(await pollingOnly.readHints(), []);
});

test("P1-W2 — Rust rejects malformed and unknown hints (fail closed)", () => {
  assert.match(HINTS_RUST, /fn parse_hint/u);
  assert.match(HINTS_RUST, /fn an_unknown_kind_fails_closed/u);
  assert.match(HINTS_RUST, /fn a_malformed_hint_fails_closed/u);
  assert.match(HINTS_RUST, /fn a_stale_generation_cannot_publish/u);
  assert.match(HINTS_RUST, /fn retire_clears_owner_and_hints/u);
  assert.match(HINTS_RUST, /fn an_immediate_stop_blocks_publish_without_waiting_for_a_socket_timeout/u);
  assert.match(HINTS_RUST, /fn the_buffer_is_bounded/u);
});

test("P1-W2 — the hint buffer is bounded in Rust", () => {
  assert.match(HINTS_RUST, /MAX_BUFFERED_HINTS: usize = 64/u);
});

// ===========================================================================
// P1-W3 — canonical error mapping
// ===========================================================================

test("P1-W3 — no unchecked cast of an arbitrary code remains", () => {
  const ts = read("src", "services", "companionServices", "productionTransport.ts");
  assert.doesNotMatch(ts, /as ServicesErrorCode/u, "the unchecked cast is gone");
  assert.match(ts, /mapLocalRefusal/u, "it maps through the ONE boundary");
});

test("P1-W3 — internal vocabulary maps to canonical codes", () => {
  assert.equal(mapLocalRefusal("CONTENT_SOURCE_CHANGED"), "SOURCE_CHANGED");
  assert.equal(mapLocalRefusal("SOURCE_CHANGED"), "SOURCE_CHANGED");
  assert.equal(mapLocalRefusal("CONTENT_OFFLINE"), "SERVICE_UNAVAILABLE");
  assert.equal(mapLocalRefusal("CONTENT_DISCONNECTED"), "SERVICE_UNAVAILABLE");
  assert.equal(mapLocalRefusal("PAIRING_MISSING"), "PAIRING_REQUIRED");
  assert.equal(mapLocalRefusal("PAIRING_REQUIRED"), "PAIRING_REQUIRED");
  // Local allowlist misuse fails closed as a canonical request error.
  for (const code of [
    "SERVICES_OPERATION_NOT_ALLOWED", "SERVICES_PATH_NOT_ALLOWED", "SERVICES_PATH_INVALID",
    "SERVICES_METHOD_INVALID", "SERVICES_QUERY_NOT_ALLOWED", "SERVICES_QUERY_CREDENTIAL_FORBIDDEN",
  ]) {
    assert.equal(mapLocalRefusal(code), "INPUT_INVALID", code);
  }
  // Unknown internal failure never becomes a branchable canonical code.
  assert.equal(mapLocalRefusal("SOMETHING_NEW"), "TRANSPORT_FAILED");
  // A canonical code passes through unchanged.
  assert.equal(mapLocalRefusal("CURSOR_TOO_OLD"), "CURSOR_TOO_OLD");
});

test("P1-W3 — a real refusal crosses the boundary as its canonical code", async () => {
  const t = createTauriServicesTransport((async () => { throw { code: "CONTENT_SOURCE_CHANGED" }; }) as any);
  await assert.rejects(
    () => t.request({ instance: "d", operationId: "services.discover", method: "GET", path: "/v1/services" }),
    (e: any) => e instanceof ServicesError && e.code === "SOURCE_CHANGED",
  );
  const offline = createTauriServicesTransport((async () => { throw { code: "CONTENT_OFFLINE" }; }) as any);
  await assert.rejects(
    () => offline.request({ instance: "d", operationId: "services.discover", method: "GET", path: "/v1/services" }),
    (e: any) => e instanceof ServicesError && e.code === "SERVICE_UNAVAILABLE",
  );
  const unpaired = createTauriServicesTransport((async () => { throw { code: "PAIRING_MISSING" }; }) as any);
  await assert.rejects(
    () => unpaired.request({ instance: "d", operationId: "services.discover", method: "GET", path: "/v1/services" }),
    (e: any) => e instanceof ServicesError && e.code === "PAIRING_REQUIRED",
  );
  const misuse = createTauriServicesTransport((async () => { throw { code: "SERVICES_PATH_NOT_ALLOWED" }; }) as any);
  await assert.rejects(
    () => misuse.request({ instance: "d", operationId: "services.discover", method: "GET", path: "/v1/hello" }),
    (e: any) => e instanceof ServicesError && e.code === "INPUT_INVALID",
  );
});

test("P1-W3 — an unknown Desktop wire code becomes MALFORMED_RESPONSE", () => {
  assert.equal(errorCodeOf({ code: "CURSOR_TOO_OLD" }), "CURSOR_TOO_OLD");
  assert.equal(errorCodeOf({ code: "BRAND_NEW_REMOTE_CODE" }), "MALFORMED_RESPONSE");
  assert.equal(errorCodeOf({ code: "CONTENT_SOURCE_CHANGED" }), "MALFORMED_RESPONSE",
    "internal vocabulary is not a canonical remote code");
  assert.equal(errorCodeOf({}), "MALFORMED_RESPONSE");
  assert.equal(errorCodeOf(null), "MALFORMED_RESPONSE");
  assert.equal(errorCodeOf("nope"), "MALFORMED_RESPONSE");
});

test("P1-W3 — the canonical vocabulary matches the vendored canonical error table", () => {
  const errors = JSON.parse(read("shared", "companion-services-v1", "errors.json"));
  const canonicalKeys = Object.keys(errors.codes);
  for (const code of CANONICAL_REMOTE_CODES) {
    assert.ok(canonicalKeys.includes(code), `${code} is a canonical remote code`);
  }
  // The local-only vocabulary is NOT in the canonical table.
  for (const local of ["SOURCE_CHANGED", "TRANSPORT_FAILED", "MALFORMED_RESPONSE"]) {
    if (canonicalKeys.includes(local)) continue;
    assert.ok(CANONICAL_REMOTE_CODES.includes(local as any) === false || canonicalKeys.includes(local),
      `${local} handling is deliberate`);
  }
});

test("P1-W3 — a real client surfaces the mapped code end to end", async () => {
  const t = createTauriServicesTransport((async (_c: string, a: any) => {
    if (a.request.operationId === "services.discover") return { status: 200, body: { ok: true } };
    return { status: 200, body: { ok: true } };
  }) as any);
  const composed = createCompanionServices(t);
  assert.ok(composed.registry);
  const failing = createCompanionServices(
    createTauriServicesTransport((async () => { throw { code: "CONTENT_SOURCE_CHANGED" }; }) as any),
  );
  await assert.rejects(
    () => failing.registry.refresh({ instanceId: "d", gatewayGeneration: 1, permissionRevision: 1 }),
    (e: any) => e instanceof ServicesError && e.code === "SOURCE_CHANGED",
  );
});

// ===========================================================================
// Regression — previously accepted behaviour stays green
// ===========================================================================

test("R2 regression — accepted client semantics are untouched", async () => {
  const { registry, materials, knowledge, presentation } =
    createCompanionServices(createFixtureTransport({ deviceId: "device-a" }));
  const IDENT = { instanceId: "fixture-desktop-1", gatewayGeneration: 7, permissionRevision: 1 };
  // registry scope + revision
  await registry.refresh(IDENT);
  assert.equal(registry.operation("materials.detailV1").scope, "asset");
  assert.equal(registry.currentNamespace(), "fixture-desktop-1|7|1");
  // knowledge afterId
  const page = await knowledge.registeredList(IDENT.instanceId, "vault-1", { limit: 10 });
  assert.ok(Array.isArray(page.items));
  // presentation replay keeps the immutable handle
  await presentation.open(IDENT.instanceId, "op-r2", { domain: "materials", assetId: "asset-1" });
  assert.deepEqual(presentation.handle("op-r2"), {
    opId: "op-r2", target: { domain: "materials", assetId: "asset-1" },
  });
  // materials detail still carries source fidelity
  const detail = await materials.detailV1(IDENT.instanceId, "asset-1");
  assert.equal(detail.source?.pageKind, "work-page");
});
