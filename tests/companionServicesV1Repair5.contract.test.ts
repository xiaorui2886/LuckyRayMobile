// REPAIR-R5 (#77) — retire-before-install cancellation race closure.
// Run: node --experimental-strip-types --test tests/companionServicesV1Repair5.contract.test.ts
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

// ===========================================================================
// P1-H7 — install must be current-aware, BEFORE any dial
// ===========================================================================

test("P1-H7 — the unconditional install API is gone", () => {
  // The old `install_cancellation(generation) -> Receiver` no longer exists.
  assert.doesNotMatch(
    code(HINTS),
    /fn install_cancellation\(\s*&self,\s*generation: u64,?\s*\)\s*->\s*tokio::sync::watch::Receiver<bool>/u,
    "the unconditional installer is removed",
  );
  assert.match(HINTS, /pub\(crate\) fn install_cancellation_if_current\(/u, "the current-aware API exists");
  assert.match(HINTS, /\) -> Option<tokio::sync::watch::Receiver<bool>> \{/u, "it returns an Option");
});

test("P1-H7 — installation refuses a stale or stopped generation", () => {
  const fn = HINTS.slice(
    HINTS.indexOf("pub(crate) fn install_cancellation_if_current"),
    HINTS.indexOf("pub(crate) fn installed_cancellation_generation"),
  );
  assert.ok(fn.length > 200, "the installer body is present");
  // Current-state proof BEFORE the sender is created.
  // R6 extracted this into `generation_is_live`, now consulted pre AND post
  // install; the R5 intent (prove current before using) is unchanged.
  const helper = HINTS.slice(HINTS.indexOf("fn generation_is_live"),
    HINTS.indexOf("fn remove_slot_if_generation"));
  assert.match(helper, /inner\.generation == generation && inner\.phase != HintPhaseValue::Stopped/,
    "it proves the generation is current and not stopped");
  assert.match(fn, /if !self\.generation_is_live\(generation\) \{/u, "…and refuses otherwise");
  // The sender is only created after that proof.
  const proofAt = fn.indexOf("if !self.generation_is_live(generation)");
  const channelAt = fn.indexOf("tokio::sync::watch::channel(false)");
  assert.ok(proofAt >= 0 && channelAt > proofAt, "no sender is created for a stale generation");
});

test("P1-H7 — a stale generation can never take over a newer slot", () => {
  const fn = HINTS.slice(
    HINTS.indexOf("pub(crate) fn install_cancellation_if_current"),
    HINTS.indexOf("pub(crate) fn installed_cancellation_generation"),
  );
  assert.match(fn, /if \*previous != generation \{\s*\r?\n\s*return None;/u,
    "an occupied slot held by another generation refuses the install");
  assert.match(fn, /\*guard = Some\(\(generation, sender\)\);/u, "only then is the slot written");
});

test("P1-H7 — lock ordering is deterministic and cannot deadlock", () => {
  const fn = HINTS.slice(
    HINTS.indexOf("pub(crate) fn install_cancellation_if_current"),
    HINTS.indexOf("pub(crate) fn installed_cancellation_generation"),
  );
  // R6 reaches inner through `generation_is_live`, which acquires and RELEASES
  // it before the cancel slot is taken — same invariant, new shape.
  const innerAt = fn.indexOf("self.generation_is_live(generation)");
  const cancelAt = fn.indexOf("self.cancel.lock()");
  assert.ok(innerAt >= 0 && cancelAt > innerAt, "inner is consulted first");
  assert.match(fn.slice(0, cancelAt), /if !self\.generation_is_live\(generation\) \{/u,
    "the pre-check refuses before the slot is touched");
  // Between them the inner guard must be dropped (no nested acquisition).
  const between = fn.slice(innerAt, cancelAt);
  assert.doesNotMatch(between, /self\.cancel\.lock\(\)/u, "cancel is never taken while holding inner");
  // retire() follows the same shape: inner, release, then cancel_current.
  const retire = HINTS.slice(HINTS.indexOf("pub fn retire(&self)"), HINTS.indexOf("fn cancel_current"));
  assert.match(retire, /self\.cancel_current\(\);/u, "retire signals after releasing inner");
});

test("P1-H7 — the worker refuses BEFORE any dial", () => {
  const worker = code(WORKER);
  const installAt = worker.indexOf("state.install_cancellation_if_current(generation)");
  const dialAt = worker.indexOf("hint_websocket_connect(&url, &authorization, &fingerprint)");
  assert.ok(installAt >= 0, "the worker installs through the current-aware API");
  assert.ok(dialAt > installAt, "…before it ever builds the dial future");
  // Refusal returns immediately.
  const refusal = worker.slice(installAt, installAt + 220);
  assert.match(refusal, /None => \{[\s\S]{0,120}?return;/u, "a refusal returns without dialling");
  // And the worker no longer calls the unconditional installer at all.
  assert.doesNotMatch(worker, /install_cancellation\(/u);
});

test("P1-H7 — no polling or timeout workaround was added", () => {
  const worker = code(WORKER);
  // Cancellation is still a select branch, not a polled flag.
  assert.match(worker, /_ = cancel\.changed\(\) =>/u, "cancellation stays a select branch");
  // A sleep already exists in the foundation reconnect backoff; what matters is
  // that the CANCELLATION path introduces none. So assert on the hint worker's
  // own body only.
  const hintWorker = worker.slice(worker.indexOf("pub(crate) async fn run_hint_worker"));
  assert.doesNotMatch(hintWorker, /sleep\(/u, "no sleep-based workaround in the hint worker");
  assert.doesNotMatch(worker, /loop \{[\s\S]{0,200}?install_cancellation_if_current/u,
    "the install is not retried inside a loop");
});

// ===========================================================================
// Required race test — exact retire-before-install window
// ===========================================================================

test("P1-H7 — the exact retire-before-install race is tested with a dial counter", () => {
  assert.match(HINTS, /async fn retire_before_install_refuses_the_late_worker_and_never_dials/u);
  const test_body = HINTS.slice(
    HINTS.indexOf("async fn retire_before_install_refuses_the_late_worker_and_never_dials"),
    HINTS.indexOf("fn a_stale_install_cannot_take_over_a_newer_cancellation_slot"),
  );
  assert.match(test_body, /AtomicU64::new\(0\)/u, "a real dial counter exists");
  assert.match(test_body, /state\.begin\("desktop-a"\)/u, "1) A begins");
  const retireAt = test_body.indexOf("state.retire();");
  const installAt = test_body.indexOf("install_cancellation_if_current(gen_a)");
  assert.ok(retireAt > 0, "2) the race step retires");
  assert.ok(installAt > retireAt, "2) retire happens BEFORE the install attempt");
  assert.match(test_body, /install_cancellation_if_current\(gen_a\)/u, "3) A attempts to install");
  assert.match(test_body, /dials\.load\([\s\S]{0,120}?\), 0, "the stale worker never dialled"/u,
    "4) the dial counter stays zero");
  assert.match(test_body, /state\.begin\("desktop-b"\)[\s\S]{0,240}?expect\("B installs normally"\)/u,
    "5) B installs normally");
});

test("P1-H7 — stale A install cannot disturb B's slot (tested)", () => {
  assert.match(HINTS, /fn a_stale_install_cannot_take_over_a_newer_cancellation_slot/u);
  const body = HINTS.slice(
    HINTS.indexOf("fn a_stale_install_cannot_take_over_a_newer_cancellation_slot"),
    HINTS.indexOf("fn install_after_a_stop_is_refused"),
  );
  assert.match(body, /install_cancellation_if_current\(gen_a\)\.is_none\(\)/u, "A is refused");
  assert.match(body, /installed_cancellation_generation\(\),\s*\r?\n\s*Some\(gen_b\)/u,
    "B's slot is untouched");
  assert.match(body, /!HintStreamState::is_cancelled\(&b_cancel\)/u, "B was not cancelled");
});

test("P1-H7 — install after a stop and for an unknown generation are both refused", () => {
  assert.match(HINTS, /fn install_after_a_stop_is_refused/u);
  assert.match(HINTS, /fn install_is_refused_for_a_generation_that_never_existed/u);
  assert.match(HINTS, /fn a_current_generation_installs_exactly_once/u);
});

// ===========================================================================
// Regression — R4 prompt cancellation still proven
// ===========================================================================

test("R5 regression — the R4 prompt-cancellation tests are unchanged", () => {
  assert.match(HINTS, /async fn retire_wakes_a_pending_worker_immediately/u);
  assert.match(HINTS, /std::future::pending::<\(\)>/u, "the read future is still intentionally pending");
  assert.match(HINTS, /from_millis\(500\)/u, "the short test budget is unchanged");
  assert.match(HINTS, /async fn replacing_the_generation_cancels_the_previous_worker/u);
  assert.match(HINTS, /async fn cancelling_one_generation_does_not_cancel_another/u);
  assert.match(HINTS, /fn retire_clears_the_cancellation_slot/u);
});

test("R5 regression — R4 generation-safe cleanup and reset paths are intact", () => {
  const worker = code(WORKER);
  assert.doesNotMatch(worker, /state\.retire\(\)/u, "no unconditional retire in the worker");
  assert.equal((worker.match(/state\.retire_if_current\(generation\)/gu) ?? []).length, 2);
  for (const name of ["do_pair", "conn_revoke", "ws_stop", "db_reset", "db_reset_full"]) {
    const at = LIB.indexOf(`fn ${name}`);
    assert.ok(LIB.indexOf("services_hints::retire_managed();", at) > 0, `${name} retires hints`);
  }
});

test("R5 regression — managed state, idempotency and phase reporting are intact", () => {
  assert.match(HINTS, /pub type ManagedHintState = Arc<HintStreamState>;/u);
  assert.match(HINTS, /pub enum StartOutcome/u);
  assert.match(HINTS, /AlreadyRunning \{ generation: u64 \}/u);
  assert.match(HINTS, /pub fn services_hints_status/u);
  assert.match(HINTS, /pub\(crate\) fn retire_if_current\(&self, generation: u64\) -> bool/u);
});

test("R5 regression — #72 LSH, Services transport and the foundation stream are untouched", () => {
  assert.match(LIB, /lsh_surface::lsh_surface_state/u);
  assert.match(LIB, /lsh_surface::lsh_surface_bootstrap/u);
  assert.match(LIB, /lsh_surface::lsh_surface_open/u);
  assert.match(LIB, /services_v1::services_v1_request/u);
  assert.match(WORKER, /pub struct EventStreamClient/u);
  const lsh = code(read("src-tauri", "src", "lsh_carrier.rs"));
  assert.doesNotMatch(lsh, /services_hints/u, "the LSH carrier still knows nothing about hints");
});

test("R5 regression — canonical vendor is untouched by this repair", () => {
  const sums = JSON.parse(read("shared", "companion-services-v1", "SHA256SUMS.json"));
  assert.equal(
    sums.bundleDigest,
    "6342ca7f1525c7f04238ed42b892034d74f218274bd1dec1c38e00736d74772d",
  );
});
