// REPAIR-R4 (#77) — real socket cancellation, generation-safe cleanup, reset paths.
// Run: node --experimental-strip-types --test tests/companionServicesV1Repair4.contract.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ChangeFeedClient, createHintSubscription,
} from "../src/services/companionServices/index.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

const HINTS = read("src-tauri", "src", "services_hints.rs");
const WORKER = read("src-tauri", "src", "eventstream.rs");
const LIB = read("src-tauri", "src", "lib.rs");
const HINT_TS = read("src", "services", "companionServices", "hintSubscription.ts");

/** Strip comments so prose mentioning a symbol is not a match. */
const code = (src: string) =>
  src.replace(/^\s*\/\/.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, "");

// ===========================================================================
// P1-H4 — real per-generation cancellation
// ===========================================================================

test("P1-H4 — the state owns a generation-scoped cancellation authority", () => {
  assert.match(HINTS, /cancel: Mutex<Option<\(u64, tokio::sync::watch::Sender<bool>\)>>/u,
    "the slot records the generation with its sender");
  // R5 replaced the unconditional installer with the current-aware one; the
  // R4 intent — a generation-scoped authority is installed per worker — holds.
  assert.match(HINTS, /pub\(crate\) fn install_cancellation_if_current\(/u);
  assert.match(HINTS, /fn cancel_current\(&self\)/u);
});

test("P1-H4 — retire() signals the CURRENT worker immediately", () => {
  const retire = HINTS.slice(HINTS.indexOf("pub fn retire(&self)"), HINTS.indexOf("fn cancel_current"));
  assert.match(retire, /inner\.phase = HintPhaseValue::Stopped;/u, "publication is invalidated");
  assert.match(retire, /self\.cancel_current\(\);/u, "…and the worker is woken");
});

test("P1-H4 — a replacement generation cancels the previous one", () => {
  // R5 made installation current-aware; replacement is still cancelled by
  // begin() retiring the outgoing scope, and only the SAME generation may
  // write its own slot.
  const install = HINTS.slice(HINTS.indexOf("pub(crate) fn install_cancellation_if_current"),
    HINTS.indexOf("pub(crate) fn installed_cancellation_generation"));
  assert.match(install, /\*guard = Some\(\(generation, sender\)\);/u, "the slot is written for this generation");
  assert.match(install, /if \*previous != generation \{/u,
    "a slot owned by another generation is never taken over");
  assert.match(install, /return None;/u, "the refusal path exists");
  const begin = HINTS.slice(HINTS.indexOf("pub(crate) fn begin(&self, owner: &str)"),
    HINTS.indexOf("pub(crate) fn mark_running"));
  assert.match(begin, /self\.cancel_current\(\);/u, "a replacement cancels the previous worker");
});
test("P1-H4 — cancellation is generation-scoped: stale A cannot cancel B", () => {
  const retireIf = HINTS.slice(HINTS.indexOf("pub(crate) fn retire_if_current"));
  assert.match(retireIf, /if inner\.generation != generation \{\s*\r?\n\s*false/u,
    "a stale generation never retires");
  assert.match(retireIf, /\*g == generation/u, "the cancel slot is matched by generation");
});

test("P1-H4 — the worker selects on cancellation, not a polling timeout", () => {
  const worker = code(WORKER);
  assert.match(worker, /tokio::select!/u, "the worker selects");
  assert.match(worker, /_ = cancel\.changed\(\) =>/u, "a cancellation branch exists");
  assert.match(worker, /next = socket\.next\(\) =>/u, "the read is a select branch");
  assert.match(worker, /_ = keepalive\.tick\(\) =>/u, "keepalive is a select branch");
  // The 30s timeout wrapper around the read is gone: cancellation wakes instead.
  assert.doesNotMatch(worker, /timeout\(\s*std::time::Duration::from_secs\(30\),\s*socket\.next\(\)/u,
    "the read is no longer wrapped in a 30s timeout");
});

test("P1-H4 — cancellation is also honoured while dialling", () => {
  const worker = code(WORKER);
  assert.match(worker, /let dial = hint_scoped_websocket_connect/u, "the dial future is named");
  assert.match(worker, /_ = cancel\.changed\(\) => \{[\s\S]{0,160}?state\.finish\(generation, false\);/u,
    "a retire during the dial finishes the generation without opening a socket");
});

test("P1-H4 — the worker closes the socket on the socket-loop cancellation path", () => {
  const worker = code(WORKER);
  // Two cancellation branches exist by design: one during the dial (no socket
  // exists yet) and one in the socket loop. Only the latter can close a socket.
  // Split on the branch head and inspect each following segment: no newline
  // appears inside the pattern, so this stays a single-line regex.
  const parts = worker.split(/_ = cancel\.changed\(\) =>/u).slice(1);
  const branches = parts.map((part) => part.slice(0, 260));
  assert.ok(branches.length >= 2, `a dial-phase and a loop-phase branch exist (saw ${branches.length})`);
  const closing = branches.filter((b) => /socket\.close\(None\)\.await/u.test(b));
  assert.equal(closing.length, 1, "the socket loop's cancellation branch closes the socket promptly");
  assert.match(closing[0], /state\.finish\(generation, false\)/u, "…and finishes only its own generation");
});

test("P1-H4 — services_hints_stop uses the same cancellation authority", () => {
  // G1-R4: client-originated stop is now SCOPE-QUALIFIED. It uses
  // `retire_if_current_scope`, whose retirement fires the generation-matched
  // cancellation exactly like `retire()` does for native lifecycle paths.
  const stop = HINTS.slice(HINTS.indexOf("pub fn services_hints_stop"));
  assert.match(stop, /retire_if_current_scope\(&instance, generation\)/u,
    "the stop command forwards the caller scope");
  assert.match(HINTS, /pub\(crate\) fn retire_if_current_scope\(/u, "the scoped retire exists");
  assert.match(HINTS, /pub fn retire\(&self\) \{[\s\S]{0,400}?self\.cancel_current\(\);/u,
    "native retire() is what fires the cancellation");
});

test("P1-H4 — a hermetic test proves a pending worker exits promptly", () => {
  assert.match(HINTS, /async fn retire_wakes_a_pending_worker_immediately/u);
  assert.match(HINTS, /std::future::pending::<\(\)>/u, "the read future is intentionally pending");
  assert.match(HINTS, /from_millis\(500\)/u, "the test budget is far below the 30s timeout");
  assert.match(HINTS, /async fn replacing_the_generation_cancels_the_previous_worker/u);
  assert.match(HINTS, /async fn cancelling_one_generation_does_not_cancel_another/u);
});

// ===========================================================================
// P1-H5 — generation-safe worker error cleanup
// ===========================================================================

test("P1-H5 — no unconditional retire remains in the worker", () => {
  const worker = code(WORKER);
  assert.doesNotMatch(worker, /state\.retire\(\)/u,
    "the worker must never retire the shared authority unconditionally");
  const conditional = worker.match(/state\.retire_if_current\(generation\)/gu) ?? [];
  assert.equal(conditional.length, 2, "malformed hint and owner failure both use the conditional path");
});

test("P1-H5 — malformed-hint and owner-failure cleanup are generation-conditional", () => {
  const worker = code(WORKER);
  // Malformed hint branch.
  const malformedAt = worker.indexOf("Err(()) => {");
  assert.ok(malformedAt > 0, "the malformed branch exists");
  const malformed = worker.slice(malformedAt, malformedAt + 260);
  assert.match(malformed, /state\.retire_if_current\(generation\)/u);
  // Owner-failure branch.
  const ownerAt = worker.indexOf("expected_gateway(&shared, &owner).is_err()");
  assert.ok(ownerAt > 0, "the owner-failure branch exists");
  const owner = worker.slice(ownerAt, ownerAt + 220);
  assert.match(owner, /state\.retire_if_current\(generation\)/u);
});

test("P1-H5 — native lifecycle may still retire the current authority", () => {
  // retire_managed is the intentional, current-authority path.
  assert.match(HINTS, /pub fn retire_managed\(\)/u);
  assert.match(LIB, /services_hints::retire_managed\(\);/u);
});

test("P1-H5 — race tests exist for both stale cleanup paths", () => {
  assert.match(HINTS, /fn stale_malformed_cleanup_leaves_a_newer_generation_running/u);
  assert.match(HINTS, /fn stale_owner_failure_cleanup_leaves_a_newer_generation_running/u);
  assert.match(HINTS, /fn the_current_generation_can_still_retire_itself/u);
});

test("P1-H5 — a stale worker's own exit still cannot clear a newer generation", () => {
  assert.match(HINTS, /pub\(crate\) fn finish\(&self, generation: u64, count_failure: bool\)/u);
  assert.match(HINTS, /if inner\.generation != generation \{\s*\r?\n\s*return false;/u);
  assert.match(HINTS, /pub\(crate\) fn retire_if_current\(&self, generation: u64\) -> bool/u);
});

// ===========================================================================
// P1-H6 — destructive reset paths retire hints
// ===========================================================================

test("P1-H6 — db_reset retires hints before clearing pairing", () => {
  const at = LIB.indexOf("async fn db_reset(state");
  assert.ok(at > 0);
  const body = LIB.slice(at, LIB.indexOf("\n}", at));
  const retire = body.indexOf("services_hints::retire_managed();");
  const clear = body.indexOf("clear_pairing_and_secure_credentials");
  assert.ok(retire > 0, "db_reset retires hints");
  assert.ok(clear > retire, "…before the pairing clear");
});

test("P1-H6 — db_reset_full retires hints before clearing pairing", () => {
  const at = LIB.indexOf("async fn db_reset_full(state");
  assert.ok(at > 0);
  const body = LIB.slice(at, LIB.indexOf("\n}", at));
  const retire = body.indexOf("services_hints::retire_managed();");
  const clear = body.indexOf("clear_pairing_and_secure_credentials");
  assert.ok(retire > 0, "db_reset_full retires hints");
  assert.ok(clear > retire, "…before the pairing clear");
  assert.match(body, /db\.reset_full\(\)/u, "the full reset still runs");
});

test("P1-H6 — every destructive pairing path retires hints before ownership changes", () => {
  const paths = ["do_pair", "conn_revoke", "ws_stop", "db_reset", "db_reset_full"];
  const retires = LIB.match(/services_hints::retire_managed\(\);/gu) ?? [];
  assert.equal(retires.length, paths.length, `${paths.length} destructive paths retire hints`);
  for (const name of paths) {
    const at = LIB.indexOf(`fn ${name}`);
    assert.ok(at > 0, `${name} exists`);
    assert.ok(
      LIB.indexOf("services_hints::retire_managed();", at) > 0,
      `${name} retires hints`,
    );
  }
});

test("P1-H6 — db_reset_full is the RecoveryScreen production path (not test-only)", () => {
  assert.match(LIB, /#\[tauri::command\][\s\S]{0,80}?async fn db_reset_full/u, "it is a command");
  // Registered in the invoke handler.
  assert.match(LIB, /db_reset_full,/u, "registered");
});

// ===========================================================================
// Regression — R3 behaviour preserved
// ===========================================================================

test("R4 regression — managed state, idempotency and phase reporting are intact", () => {
  assert.match(HINTS, /pub type ManagedHintState = Arc<HintStreamState>;/u);
  assert.match(HINTS, /Started \{ generation: u64 \}/u);
  assert.match(HINTS, /AlreadyRunning \{ generation: u64 \}/u);
  assert.match(HINTS, /pub enum HintPhase/u);
  assert.match(HINTS, /pub fn services_hints_status/u);
});

test("R4 regression — bearer/URL still never reach TS", () => {
  const stripped = code(HINT_TS);
  assert.doesNotMatch(stripped, /bearer|authorization|token|wss:\/\//iu);
  const worker = code(WORKER);
  assert.match(worker, /run_hint_worker/u, "the socket stays Rust-owned");
});

test("R4 regression — TS still degrades to polling unless the worker is live", async () => {
  const sub = createHintSubscription((async (cmd: string) => {
    if (cmd === "services_hints_status") {
      return { generation: 1, phase: "starting", owner: "desktop-a", connectFailures: 0 };
    }
    return { outcome: "started", generation: 1 };
  }) as any);
  const feed = new ChangeFeedClient(sub);
  await feed.start("fixture-desktop-1");
  assert.equal(feed.currentMode(), "polling", "queued is not live");
});

test("R4 regression — #72 LSH and the foundation stream are untouched", () => {
  assert.match(LIB, /lsh_surface::lsh_surface_state/u);
  assert.match(LIB, /lsh_surface::lsh_surface_bootstrap/u);
  assert.match(LIB, /lsh_surface::lsh_surface_open/u);
  assert.match(WORKER, /pub struct EventStreamClient/u);
  const lsh = code(read("src-tauri", "src", "lsh_carrier.rs"));
  assert.doesNotMatch(lsh, /services_hints/u, "the LSH carrier still knows nothing about hints");
  assert.match(LIB, /services_v1::services_v1_request/u, "the Services HTTP transport is intact");
});
