// SERVICES-INTEGRATION-R2 — acceptance driver gating contract.
//
// Proves, at the source and behavior level, what the execution card requires:
//   1. the acceptance surface is OFF by default and reachable ONLY through the
//      explicit build flag `VITE_LUCKYRAY_SERVICES_ACCEPTANCE=1`;
//   2. the driver uses the PRODUCTION Services composition — no fetch, no
//      WebSocket, no handcrafted HTTP, no second pairing/credential store;
//   3. evidence rows are field-allowlisted: a bearer/credential/body can never
//      appear in the acceptance log by construction.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { servicesAcceptanceEnabled } from "../src/servicesAcceptance/acceptanceFlag.ts";
import { acceptanceEvent, formatEvent } from "../src/servicesAcceptance/acceptanceLog.ts";
import { acceptanceUuidV4, formatUuidV4 } from "../src/servicesAcceptance/acceptanceUuid.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const strip = (src: string) => src.replace(/^\s*\/\/.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, "");

test("acceptance — the surface is OFF by default (no env, no flag)", () => {
  assert.equal(servicesAcceptanceEnabled(undefined), false, "no env at all -> OFF");
  assert.equal(servicesAcceptanceEnabled({}), false, "empty env -> OFF");
  assert.equal(servicesAcceptanceEnabled({ VITE_LUCKYRAY_SERVICES_ACCEPTANCE: "" }), false, "empty flag -> OFF");
  assert.equal(servicesAcceptanceEnabled({ VITE_LUCKYRAY_SERVICES_ACCEPTANCE: "0" }), false, "explicit 0 -> OFF");
  assert.equal(servicesAcceptanceEnabled({ VITE_LUCKYRAY_SERVICES_ACCEPTANCE: "false" }), false, "'false' -> OFF");
  assert.equal(servicesAcceptanceEnabled({ SOMETHING_ELSE: "1" }), false, "unrelated flag -> OFF");
});

test("acceptance — ONLY the exact build flag enables the surface", () => {
  // Semantics match the literal main.tsx gate EXACTLY: only string "1".
  assert.equal(servicesAcceptanceEnabled({ VITE_LUCKYRAY_SERVICES_ACCEPTANCE: "1" }), true);
  assert.equal(servicesAcceptanceEnabled({ VITE_LUCKYRAY_SERVICES_ACCEPTANCE: 1 }), false, "numeric 1 -> OFF");
  assert.equal(servicesAcceptanceEnabled({ VITE_LUCKYRAY_SERVICES_ACCEPTANCE: true }), false, "boolean true -> OFF");
  // Anything that merely CONTAINS 1 is not the flag value.
  assert.equal(servicesAcceptanceEnabled({ VITE_LUCKYRAY_SERVICES_ACCEPTANCE: "10" }), false);
  assert.equal(servicesAcceptanceEnabled({ VITE_LUCKYRAY_SERVICES_ACCEPTANCE: " 1" }), false);
});

test("acceptance — main.tsx gates the driver behind the literal build flag", () => {
  const main = strip(read("src", "main.tsx"));
  const gate = main.indexOf('import.meta.env.VITE_LUCKYRAY_SERVICES_ACCEPTANCE === "1"');
  const mount = main.indexOf('import("./servicesAcceptance/AcceptanceDriver")');
  assert.ok(gate !== -1, "main.tsx must gate on the LITERAL flag (vite folds it, helper cannot)");
  assert.ok(mount !== -1, "main.tsx must import the driver only dynamically");
  assert.ok(gate < mount, "the dynamic import must sit AFTER the flag gate");
  // The product render path stays the else-branch of the same gate, so a normal
  // build folds the driver branch away entirely.
  assert.match(main, /if \(import\.meta\.env\.VITE_LUCKYRAY_SERVICES_ACCEPTANCE === "1"\)/u);
  // The tested helper must keep the exact same value semantics as the literal.
  const helper = strip(read("src", "servicesAcceptance", "acceptanceFlag.ts"));
  assert.match(helper, /VITE_LUCKYRAY_SERVICES_ACCEPTANCE/u);
});

test("acceptance — the browser build stubs the Node-only canonical fixture module", () => {
  // The acceptance build includes the production barrel, which re-exports the
  // fixture transport; the vendor file itself is frozen, so vite.config maps
  // ONLY that module id to a throwing browser stub.
  const config = read("vite.config.ts");
  assert.match(config, /fixture-browser-stub/u, "stub plugin must exist");
  assert.match(config, /companion-services-v1\/fixture\.mjs/u, "stub must target exactly the fixture module");
  assert.match(config, /Node-only and cannot run in a browser build/u, "stub throws if ever used");
  // Nothing in the product tree imports the fixture transport.
  const barrel = strip(read("src", "services", "companionServices", "index.ts"));
  assert.match(barrel, /createFixtureTransport/u, "barrel re-export is pre-existing production surface");
});

test("acceptance — the driver uses the production composition, never raw transport", () => {
  const src = strip(read("src", "servicesAcceptance", "AcceptanceDriver.tsx"));
  assert.match(src, /createProductionServices\(\)/u, "driver must construct the production composition");
  assert.match(src, /createTauriServicesTransport\(\)/u, "SearchSession seam is the production transport");
  // The instance authority is the app's existing pairing state — no manual
  // origin/token field, no second pairing store.
  assert.match(src, /api\.connState\(\)/u, "instance comes from the existing connection authority");
  assert.doesNotMatch(src, /conn_pair|pair_pick_file|connPair/u, "driver never pairs");
  assert.doesNotMatch(src, /baseUrl|origin\s*[:=]|token\s*[:=]|bearer\s*[:=]/iu,
    "no manual Desktop origin/token/bearer field");
});

test("acceptance — no direct fetch/WebSocket/manual HTTP in the driver", () => {
  const src = strip(read("src", "servicesAcceptance", "AcceptanceDriver.tsx"));
  assert.doesNotMatch(src, /\bfetch\s*\(/u, "no fetch()");
  assert.doesNotMatch(src, /new\s+WebSocket|XMLHttpRequest|EventSource/u, "no direct socket/SSE");
  assert.doesNotMatch(src, /invoke\s*\(/u, "no direct Tauri invoke outside the production transport");
  assert.doesNotMatch(src, /axios|http\.request|net\.connect/u, "no other HTTP client");
  // The only wire path is the canonical seam call for the catalog probe.
  const seamUses = src.match(/callServices</gu) ?? [];
  assert.equal(seamUses.length, 1, "exactly one bounded seam use: the cold-client catalog probe");
});

test("acceptance — evidence rows are field-allowlisted (no secret can leak)", () => {
  const event = acceptanceEvent("ingest.complete", true, {
    generation: 3,
    assetId: "a-1",
    // A caller that accidentally spreads a whole response body:
    bearer: "Bearer secret-token",
    authorization: "Basic zzz",
    certificateFingerprintSha256: "ff",
    privateKey: "-----BEGIN",
    rawBody: { code: "x", nested: { bearer: "tok" } },
    password: "hunter2",
  } as Record<string, unknown>);
  const rendered = formatEvent(event);
  for (const secret of ["secret-token", "zzz", "-----BEGIN", "hunter2", "tok", "ff"]) {
    assert.ok(!rendered.includes(secret), `rendered row must not contain ${secret}`);
  }
  assert.equal(event.generation, 3, "whitelisted currentness field survives");
  assert.equal(event.assetId, "a-1", "whitelisted identifier survives");
});

test("acceptance — evidence rows are bounded in length and count", () => {
  const long = "x".repeat(5000);
  const rendered = formatEvent(acceptanceEvent("op", true, { kind: long }));
  assert.ok(rendered.length < 400, `row is bounded (got ${rendered.length})`);
  assert.ok(rendered.endsWith("…"), "over-long values are truncated, not dropped silently");
});

test("acceptance — no #78 route/visual file is touched by the driver wiring", () => {
  // The only product-bootstrap file the driver touches is main.tsx (gate).
  const main = read("src", "main.tsx");
  assert.match(main, /servicesAcceptanceEnabled/u);
  // The driver directory must not import any Still/#78 visual module.
  for (const file of ["AcceptanceDriver.tsx", "acceptanceFlag.ts", "acceptanceLog.ts"]) {
    const src = strip(read("src", "servicesAcceptance", file));
    assert.doesNotMatch(src, /from "\.\.\/still\/|StillShell|StillApp|productShell/u,
      `${file} must stay out of the #78 visual tree`);
  }
});

// ---------------------------------------------------------------------------
// R3: the frozen epoch367 real-LAN matrix must be executable stepwise.
// ---------------------------------------------------------------------------

test("R3 — search pagination retains ONE SearchSession (start + next)", () => {
  const src = strip(read("src", "servicesAcceptance", "AcceptanceDriver.tsx"));
  assert.match(src, /sessionRef\.current \?\?= new SearchSession|if \(!sessionRef\.current\) sessionRef\.current = new SearchSession/u,
    "the session is created once and RETAINED between presses");
  assert.match(src, /runSearchNext[\s\S]*?sessionRef\.current\.next\(\)/u,
    "search next drives the RETAINED session");
  // next() must not restart the query.
  const nextBody = src.slice(src.indexOf("const runSearchNext"), src.indexOf("const styles"));
  assert.doesNotMatch(nextBody, /\.start\(/u, "search.next must never restart the query");
});

test("R3 — ingest opId is minted ONCE and stable across status/next/resume/complete", () => {
  const src = strip(read("src", "servicesAcceptance", "AcceptanceDriver.tsx"));
  // Exactly two acceptance mint SITES, both through the WebView-83-compatible
  // helper (assert semantic helper use, never a literal API name count).
  const mints = src.match(/acceptanceUuidV4\(\)/gu) ?? [];
  assert.equal(mints.length, 2, "exactly two mints: the ingest opId and the presentation opId");
  assert.doesNotMatch(src, /crypto\.randomUUID\s*\(/u,
    "no direct crypto.randomUUID call may remain (WebView 83 lacks it)");
  const beginBody = src.slice(src.indexOf("const runIngestBegin"), src.indexOf("const runIngestStatus"));
  assert.match(beginBody, /acceptanceUuidV4\(\)/u, "begin mints the acceptance opId");
  // The step bodies after begin must NOT mint anything.
  for (const name of ["runIngestStatus", "runIngestNextChunk", "runIngestResume", "runIngestComplete"]) {
    const body = src.slice(src.indexOf(`const ${name}`), src.indexOf(`const ${name}`) + 1200);
    assert.doesNotMatch(body, /acceptanceUuidV4\(\)|crypto\.randomUUID/u,
      `${name} must never mint an opId`);
  }
  // Resume uses the SAME jobId and the server's committedBytes.
  const resumeBody = src.slice(src.indexOf("const runIngestResume"), src.indexOf("const runIngestComplete"));
  assert.match(resumeBody, /services\.ingest\.status\(inst, state\.jobId\)/u, "resume re-reads job state");
  assert.match(resumeBody, /streamChunks\(inst, job\.jobId, [\s\S]*?job\.committedBytes\)/u,
    "resume streams the SAME job from the RETURNED committedBytes");
});

test("R3 — presentation retains one handle; replay uses the SAME opId + target", () => {
  const src = strip(read("src", "servicesAcceptance", "AcceptanceDriver.tsx"));
  const openBody = src.slice(src.indexOf("const runPresentationOpen"), src.indexOf("const runPresentationReplay"));
  assert.match(openBody, /presentationRef\.current = \{ opId: acceptanceUuidV4\(\), target \}/u,
    "the handle (opId + target) is minted once and retained");
  const replayBody = src.slice(src.indexOf("const runPresentationReplay"), src.indexOf("const runSearchStart"));
  assert.match(replayBody, /replay\(inst, handle\.opId, handle\.target\)/u,
    "replay passes the SAME opId + SAME target");
  assert.doesNotMatch(replayBody, /acceptanceUuidV4\(\)|crypto\.randomUUID/u,
    "replay never mints a second opId");
});

test("R3 — presentation prefers the acceptance-owned ingest asset", () => {
  const src = strip(read("src", "servicesAcceptance", "AcceptanceDriver.tsx"));
  assert.match(src, /ingestAssetIdRef\.current \|\| materialAssetRef\.current/u,
    "target selection prefers the ingest receipt assetId");
  // The ingest completion is what records the acceptance assetId.
  const completeBody = src.slice(src.indexOf("const runIngestComplete"), src.indexOf("const runIngestReset"));
  assert.match(completeBody, /ingestAssetIdRef\.current = receipt\.assetId/u,
    "ingest.complete records the acceptance-owned assetId");
});

test("R3 — material detail logs bounded evidence, never source URLs or paths", () => {
  const src = strip(read("src", "servicesAcceptance", "AcceptanceDriver.tsx"));
  const detailBody = src.slice(src.indexOf("const runMaterialDetail"), src.indexOf("const runKnowledge"));
  for (const forbidden of ["pageUrl", "siteOrigin", "capturedAt", "JSON.stringify"]) {
    assert.ok(!detailBody.includes(forbidden), `detail must not log ${forbidden}`);
  }
  assert.match(detailBody, /sourcePresent: Boolean\(detail\.source\)/u, "only a presence boolean is logged");
  // Defense in depth: the allowlist itself has no URL-ish field.
  const allow = read("src", "servicesAcceptance", "acceptanceLog.ts");
  for (const field of ["pageUrl", "siteOrigin", "url", "path", "body", "bearer", "token"]) {
    assert.ok(!new RegExp(`"${field}"`).test(allow), `allowlist must not contain "${field}"`);
  }
});

test("R3 — hint read is an independent observation and never starts a worker", () => {
  const src = strip(read("src", "servicesAcceptance", "AcceptanceDriver.tsx"));
  const readBody = src.slice(src.indexOf("const runHintsRead"), src.indexOf("const runHintsStop"));
  assert.match(readBody, /refreshMode\(\)/u, "read observes via refreshMode");
  assert.match(readBody, /readHints\(\)/u, "read drains via readHints");
  assert.doesNotMatch(readBody, /\.start\(/u, "hint read must NOT start a new scope");
});

test("R3 — the acceptance sample spans more than one canonical chunk", () => {
  const src = strip(read("src", "servicesAcceptance", "AcceptanceDriver.tsx"));
  assert.match(src, /SAMPLE_CHUNKS = 3/u);
  assert.match(src, /const SAMPLE_BYTES = SAMPLE_CHUNKS \* INGEST_CHUNK_BYTES/u,
    "sample size is derived from the CANONICAL chunk size, >1 chunk");
});

// ---------------------------------------------------------------------------
// R5 (epoch368): acceptance opId mint must work on Android System WebView 83,
// which has NO crypto.randomUUID.
// ---------------------------------------------------------------------------

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

test("R5 — the native randomUUID path is preferred and forwarded", () => {
  const native = "123e4567-e89b-42d3-a456-426614174000";
  const fake = { randomUUID: () => native } as unknown as Crypto;
  assert.equal(acceptanceUuidV4(fake), native);
});

test("R5 — a WebView83-style engine (no randomUUID) still yields a valid v4", () => {
  // Deterministic byte source standing in for getRandomValues.
  const bytes = Uint8Array.from({ length: 16 }, (_v, i) => (i * 17 + 3) & 0xff);
  const fake = {
    getRandomValues: (arr: Uint8Array) => { arr.set(bytes); return arr; },
  } as unknown as Crypto;
  const value = acceptanceUuidV4(fake);
  assert.match(value, V4, `expected canonical v4, got ${value}`);
});

test("R5 — version nibble is 4 and variant bits are 10xx", () => {
  const fake = {
    getRandomValues: (arr: Uint8Array) => {
      for (let i = 0; i < arr.length; i++) arr[i] = 0xff; // worst case: all bits set
      return arr;
    },
  } as unknown as Crypto;
  const value = acceptanceUuidV4(fake);
  const parts = value.split("-");
  assert.equal(parts[2][0], "4", "version nibble must be 4");
  assert.ok(["8", "9", "a", "b"].includes(parts[3][0]), "variant nibble must be 8/9/a/b");
  assert.match(value, V4);
});

test("R5 — all-zero entropy still produces the forced version/variant bits", () => {
  const fake = {
    getRandomValues: (arr: Uint8Array) => { arr.fill(0); return arr; },
  } as unknown as Crypto;
  const value = acceptanceUuidV4(fake);
  assert.match(value, V4);
  assert.equal(value[14], "4", "version nibble forced even with zero entropy");
});

test("R5 — missing secure randomness FAILS CLOSED (no insecure fallback)", () => {
  assert.throws(() => acceptanceUuidV4(null), /secure-randomness-unavailable/u);
  assert.throws(() => acceptanceUuidV4({} as unknown as Crypto), /secure-randomness-unavailable/u);
  // A randomUUID shim that returns something that is NOT a v4 must be refused,
  // never passed through.
  assert.throws(
    () => acceptanceUuidV4({ randomUUID: () => "not-a-uuid" } as unknown as Crypto),
    /secure-randomness-unavailable/u,
  );
});

test("R5 — no Math.random / timestamp / counter fallback exists in the helper", () => {
  const src = strip(read("src", "servicesAcceptance", "acceptanceUuid.ts"));
  assert.doesNotMatch(src, /Math\.random/u, "no Math.random");
  assert.doesNotMatch(src, /Date\.now|new Date\(/u, "no timestamp fallback");
  assert.doesNotMatch(src, /\bcounter\b|\+\+.*uuid|uuid.*\+\+/iu, "no counter fallback");
  // The only randomness sources allowed:
  assert.match(src, /randomUUID/u);
  assert.match(src, /getRandomValues/u);
});

test("R5 — formatUuidV4 rejects a wrong-size buffer", () => {
  assert.throws(() => formatUuidV4(new Uint8Array(15)), /uuid-needs-16-bytes/u);
  assert.match(formatUuidV4(new Uint8Array(16)), V4);
});


