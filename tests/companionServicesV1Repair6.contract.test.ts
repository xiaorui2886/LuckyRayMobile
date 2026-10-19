// REPAIR-R6 (#77) — two-phase cancellation install (TOCTOU closure).
// Run: node --experimental-strip-types --test tests/companionServicesV1Repair6.contract.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

const HINTS = read("src-tauri", "src", "services_hints.rs");
const WORKER = read("src-tauri", "src", "eventstream.rs");
const LIB = read("src-tauri", "src", "lib.rs");

/** Strip comments so prose mentioning a symbol is not a match. */
const code = (src: string) =>
  src.replace(/^\s*\/\/.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, "");

const INSTALL = HINTS.slice(
  HINTS.indexOf("pub(crate) fn install_cancellation_if_current"),
  HINTS.indexOf("pub(crate) fn installed_cancellation_generation"),
);

// ===========================================================================
// P1-H8 — the install is now two-phase
// ===========================================================================

test("P1-H8 — install performs a pre-check, the slot write, then a post-check", () => {
  assert.ok(INSTALL.length > 200, "the installer body is present");
  const pre = INSTALL.indexOf("// Phase 1");
  const write = INSTALL.indexOf("*guard = Some((generation, sender));");
  const post = INSTALL.indexOf("// Phase 3");
  assert.ok(pre >= 0, "phase 1 pre-check exists");
  assert.ok(write > pre, "the slot write follows the pre-check");
  assert.ok(post > write, "phase 3 post-check follows the slot write");
  // The pre-check refuses before creating anything.
  assert.match(INSTALL.slice(pre, write), /if !self\.generation_is_live\(generation\) \{\s*\r?\n\s*return None;/u,
    "the pre-check returns None");
});

test("P1-H8 — the post-check failure removes ONLY this generation's sender", () => {
  const post = INSTALL.slice(INSTALL.indexOf("// Phase 3"));
  assert.match(post, /if !self\.generation_is_live\(generation\) \{/u, "the post-check tests liveness");
  assert.match(post, /self\.remove_slot_if_generation\(generation\);/u, "cleanup is generation-matched");
  assert.match(post, /return None;/u, "…and the install reports failure");
  // The cleanup helper only takes a slot belonging to the same generation.
  const helperAt = HINTS.indexOf("fn remove_slot_if_generation");
  assert.ok(helperAt > 0, "the helper exists");
  const helper = HINTS.slice(helperAt, helperAt + 700);
  assert.match(helper, /\*g == generation/u, "the removal matches the generation");
  assert.match(helper, /fn remove_slot_if_generation\(&self, generation: u64\)/u, "it is generation-parameterised");
  assert.match(helper, /guard\.take\(\)/u, "…and only then removes it");
});

test("P1-H8 — a successful install returns the receiver only after the post-check", () => {
  const post = INSTALL.slice(INSTALL.indexOf("// Phase 3"));
  const checkAt = post.indexOf("if !self.generation_is_live(generation)");
  const someAt = post.indexOf("Some(receiver)");
  assert.ok(checkAt >= 0 && someAt > checkAt, "Some(receiver) comes after the post-check");
});

test("P1-H8 — stale A cannot remove or cancel B", () => {
  // The slot write already refuses a slot owned by another generation…
  assert.match(INSTALL, /if \*previous != generation \{\s*\r?\n\s*return None;/u,
    "an occupied slot owned by B refuses A");
  // …and the cleanup is generation-matched, so A can never take B's sender.
  assert.match(HINTS, /fn remove_slot_if_generation\(&self, generation: u64\)/u);
  const helperAt = HINTS.indexOf("fn remove_slot_if_generation");
  const helper = HINTS.slice(helperAt, helperAt + 700);
  assert.doesNotMatch(helper, /send\(true\)/u, "cleanup of a loser never signals anyone");
});

test("P1-H8 — lock ordering stays deterministic and deadlock-free", () => {
  // inner, then cancel, then inner again — never held simultaneously.
  // `inner` is acquired inside the `generation_is_live` helper, so count the
  // CALLS in the installer plus the locks in the helper it uses.
  const helper = HINTS.slice(
    HINTS.indexOf("fn generation_is_live"),
    HINTS.indexOf("fn remove_slot_if_generation"),
  );
  assert.match(helper, /self\.inner\.lock\(\)/u, "the liveness helper takes inner");
  const liveCalls = (INSTALL.match(/self\.generation_is_live\(generation\)/gu) ?? []).length;
  assert.equal(liveCalls, 2, "inner is consulted twice (pre-check and post-check)");
  const cancelLocks = (INSTALL.match(/self\.cancel\.lock\(\)/gu) ?? []).length;
  assert.equal(cancelLocks, 1, "the cancel slot is taken exactly once, between the checks");
  // Each guard must be released before the next lock is taken: assert the
  // braces close between the phases rather than nesting.
  assert.doesNotMatch(INSTALL, /self\.cancel\.lock\(\)[\s\S]{0,400}?self\.inner\.lock\(\)/u,
    "the cancel guard is released before inner is re-acquired");
});

test("P1-H8 — no polling or sleep workaround was introduced", () => {
  assert.doesNotMatch(INSTALL, /sleep\(|yield_now\(\)|Instant::now\(\)/u,
    "the production installer contains no wait workaround");
  const worker = code(WORKER);
  const hintWorker = worker.slice(worker.indexOf("pub(crate) async fn run_hint_worker"));
  assert.doesNotMatch(hintWorker, /sleep\(/u, "the hint worker still has no sleep");
});

test("P1-H8 — the worker still refuses before constructing a dial", () => {
  const worker = code(WORKER);
  const installAt = worker.indexOf("state.install_cancellation_if_current(generation)");
  const dialAt = worker.indexOf("hint_websocket_connect(&url, &authorization, &fingerprint)");
  assert.ok(installAt >= 0 && dialAt > installAt, "install precedes the dial");
  assert.match(worker.slice(installAt, installAt + 220), /None => \{[\s\S]{0,120}?return;/u,
    "a refusal returns before any dial");
});

// ===========================================================================
// The deterministic race test
// ===========================================================================

test("P1-H8 — a test-only gate pauses the install inside the race window", () => {
  assert.match(HINTS, /install_gate: Mutex<Option<fn\(\)>>/u, "the gate holds a plain fn");
  assert.match(HINTS, /pub\(crate\) fn set_install_gate\(&self, hook: fn\(\)\)/u);
  assert.match(HINTS, /pub\(crate\) fn clear_install_gate\(&self\)/u);
  // The gate is invoked BETWEEN the pre-check and the slot write.
  const gateAt = INSTALL.indexOf("self.install_gate.lock()");
  const pre = INSTALL.indexOf("// Phase 1");
  const write = INSTALL.indexOf("*guard = Some((generation, sender));");
  assert.ok(gateAt > pre && gateAt < write, "the gate sits exactly in the P1-H8 window");
  // It is test-only, so production pays nothing.
  const before = INSTALL.slice(Math.max(0, gateAt - 200), gateAt);
  assert.match(before, /#\[cfg\(test\)\]/u, "the gate call is cfg(test)");
});

test("P1-H8 — the race test walks the exact nine steps", () => {
  assert.match(HINTS, /async fn retire_between_pre_check_and_install_is_detected_by_the_post_check/u);
  const body = HINTS.slice(
    HINTS.indexOf("async fn retire_between_pre_check_and_install_is_detected_by_the_post_check"),
    HINTS.indexOf("async fn a_retire_after_a_successful_install_still_signals_promptly"),
  );
  // The attribute sits on the line ABOVE the fn, so read a small window back.
  const fnAt = HINTS.indexOf("async fn retire_between_pre_check_and_install_is_detected_by_the_post_check");
  const attrWindow = HINTS.slice(Math.max(0, fnAt - 260), fnAt + 40);
  assert.match(attrWindow, /flavor = "multi_thread"/u,
    "the worker must be able to park on its own thread");
  assert.match(body, /state\.begin\("desktop-a"\)/u, "1) A begins");
  assert.match(body, /state\.set_install_gate\(gate_hook\)/u, "2) the window is armed");
  assert.match(body, /while !GATE_REACHED/u, "3) the test waits for the parked install");
  assert.match(body, /assert_eq!\(state\.installed_cancellation_generation\(\), None,\s*\r?\n?\s*"the slot is still empty"\)/u,
    "…while the slot is genuinely empty");
  assert.match(body, /state\.retire\(\);/u, "4) retire A inside the window");
  assert.match(body, /GATE_RESUME\.store\(true/u, "5) the install is resumed");
  assert.match(body, /dials\.load\([\s\S]{0,80}?\), 0, "A never dialled"/u, "6/7) no dial occurred");
  assert.match(body, /None,\s*\r?\n\s*"the stale A sender was cleaned up"/u, "8) no A sender remains");
  assert.match(body, /state\.begin\("desktop-b"\)[\s\S]{0,200}?expect\("B installs"\)/u, "9) B installs normally");
});

test("P1-H8 — a retire after a SUCCESSFUL install still signals promptly", () => {
  assert.match(HINTS, /async fn a_retire_after_a_successful_install_still_signals_promptly/u);
  const body = HINTS.slice(
    HINTS.indexOf("async fn a_retire_after_a_successful_install_still_signals_promptly"),
  );
  assert.match(body, /is_cancelled\(&cancel\)/u, "the installed sender is signalled");
  assert.match(body, /cancel\.changed\(\)/u, "…and the receiver wakes");
});

// ===========================================================================
// Regression — R4 / R5 unchanged
// ===========================================================================

test("R6 regression — R5 refuse-before-install behaviour is intact", () => {
  assert.match(HINTS, /async fn retire_before_install_refuses_the_late_worker_and_never_dials/u);
  assert.match(HINTS, /fn a_stale_install_cannot_take_over_a_newer_cancellation_slot/u);
  assert.match(HINTS, /fn install_after_a_stop_is_refused/u);
  assert.match(HINTS, /fn install_is_refused_for_a_generation_that_never_existed/u);
  assert.match(HINTS, /fn a_current_generation_installs_exactly_once/u);
});

test("R6 regression — R4 prompt cancellation tests are intact", () => {
  assert.match(HINTS, /async fn retire_wakes_a_pending_worker_immediately/u);
  assert.match(HINTS, /std::future::pending::<\(\)>/u);
  assert.match(HINTS, /async fn replacing_the_generation_cancels_the_previous_worker/u);
  assert.match(HINTS, /async fn cancelling_one_generation_does_not_cancel_another/u);
  assert.match(HINTS, /fn retire_clears_the_cancellation_slot/u);
});

test("R6 regression — R4 generation-safe cleanup and reset paths are intact", () => {
  const worker = code(WORKER);
  assert.doesNotMatch(worker, /state\.retire\(\)/u, "no unconditional retire in the worker");
  assert.equal((worker.match(/state\.retire_if_current\(generation\)/gu) ?? []).length, 2);
  for (const name of ["do_pair", "conn_revoke", "ws_stop", "db_reset", "db_reset_full"]) {
    const at = LIB.indexOf(`fn ${name}`);
    assert.ok(LIB.indexOf("services_hints::retire_managed();", at) > 0, `${name} retires hints`);
  }
});

test("R6 regression — managed state, transport and #72 LSH are untouched", () => {
  assert.match(HINTS, /pub type ManagedHintState = Arc<HintStreamState>;/u);
  assert.match(HINTS, /pub enum StartOutcome/u);
  assert.match(LIB, /services_v1::services_v1_request/u);
  assert.match(LIB, /lsh_surface::lsh_surface_open/u);
  assert.match(WORKER, /pub struct EventStreamClient/u);
  const sums = JSON.parse(read("shared", "companion-services-v1", "SHA256SUMS.json"));
  assert.equal(sums.bundleDigest, "6342ca7f1525c7f04238ed42b892034d74f218274bd1dec1c38e00736d74772d");
});
