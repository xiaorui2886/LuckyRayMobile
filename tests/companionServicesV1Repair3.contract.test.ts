// REPAIR-R3 (#77) — hint worker managed state + lifecycle retirement.
// Run: node --experimental-strip-types --test tests/companionServicesV1Repair3.contract.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ChangeFeedClient, createHintSubscription, toHint,
} from "../src/services/companionServices/index.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

const HINTS = read("src-tauri", "src", "services_hints.rs");
const LIB = read("src-tauri", "src", "lib.rs");
const WORKER = read("src-tauri", "src", "eventstream.rs");
const HINT_TS = read("src", "services", "companionServices", "hintSubscription.ts");
const FEED_TS = read("src", "services", "companionServices", "changeFeedClient.ts");

/** Strip Rust/TS comments so prose mentioning a symbol is not a match. */
const code = (src: string) =>
  src.replace(/^\s*\/\/.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, "");

// ===========================================================================
// P1-H1 — exactly one managed state type
// ===========================================================================

test("P1-H1 — one managed type alias is declared and used by every command", () => {
  assert.match(HINTS, /pub type ManagedHintState = Arc<HintStreamState>;/u);
  for (const cmd of [
    "pub fn services_hints_state",
    "pub fn services_hints_status",
    "pub fn services_hints_stop",
    "pub async fn services_hints_start",
  ]) {
    const at = HINTS.indexOf(cmd);
    assert.ok(at > 0, `${cmd} exists`);
    const sig = HINTS.slice(at, HINTS.indexOf("{", at));
    assert.match(sig, /State<'_, ManagedHintState>/u, `${cmd} requests the alias`);
    assert.doesNotMatch(sig, /State<'_, HintStreamState>/u, `${cmd} does not request the bare type`);
  }
});

test("P1-H1 — setup registers the SAME managed type the commands request", () => {
  assert.match(LIB, /app\.manage\(hint_state\)/u, "the Arc is handed to Tauri");
  assert.match(LIB, /services_hints::ManagedHintState::default\(\)/u, "the same alias is built");
  assert.match(LIB, /services_hints::install_managed\(hint_state\.clone\(\)\)/u,
    "the native-retirement handle points at the SAME Arc");
  // No bare-struct registration anywhere.
  assert.doesNotMatch(code(LIB), /app\.manage\([^)]*HintStreamState::default\(\)\)/u);
});

test("P1-H1 — a bare HintStreamState is never requested by a command", () => {
  // Scan only signature positions: the module's own guard test legitimately
  // NAMES the bare type in order to forbid it.
  const bare: string[] = [];
  for (const cmd of ["pub fn services_hints_state", "pub fn services_hints_status",
    "pub fn services_hints_stop", "pub async fn services_hints_start"]) {
    const at = HINTS.indexOf(cmd);
    if (at < 0) continue;
    const sig = HINTS.slice(at, HINTS.indexOf("{", at));
    if (/State<'_, HintStreamState>/u.test(sig)) bare.push(cmd);
  }
  assert.deepEqual(bare, [], "no command bypasses the alias");
});

// ===========================================================================
// P1-H2 — explicit worker state machine
// ===========================================================================

test("P1-H2 — start reports Started/AlreadyRunning, both success", () => {
  assert.match(HINTS, /pub enum StartOutcome/u);
  assert.match(HINTS, /Started \{ generation: u64 \}/u);
  assert.match(HINTS, /AlreadyRunning \{ generation: u64 \}/u);
  // The ambiguous Option is gone from the begin path.
  assert.match(HINTS, /pub\(crate\) enum BeginOutcome/u);
  const start = HINTS.slice(HINTS.indexOf("pub async fn services_hints_start"));
  assert.match(start, /Ok\(StartOutcome::AlreadyRunning \{ generation \}\)/u,
    "a same-owner restart returns success, not an error");
  assert.doesNotMatch(start, /SERVICE_UNAVAILABLE/u, "idempotent start is never a failure");
});

test("P1-H2 — every worker exit path finishes only its own generation", () => {
  assert.match(HINTS, /pub\(crate\) fn finish\(&self, generation: u64, count_failure: bool\)/u);
  // Generation-conditional: a stale exit cannot touch a newer scope.
  assert.match(HINTS, /if inner\.generation != generation \{\s*\r?\n\s*return false;/u);
  // mark_running is conditional too.
  assert.match(HINTS, /pub\(crate\) fn mark_running\(&self, generation: u64\)/u);
  // The worker calls finish on dial failure, EOF, protocol error and ping failure.
  const worker = code(WORKER);
  assert.match(worker, /state\.finish\(generation, true\);\s*\r?\n\s*return;/u, "dial failure finishes");
  assert.ok((worker.match(/state\.finish\(generation, true\)/gu) ?? []).length >= 4,
    "EOF / protocol / ping failures all finish the generation");
  assert.match(worker, /state\.mark_running\(generation\)/u, "only a current generation goes running");
});

test("P1-H2 — a dead worker becomes stopped and a later start reconnects", () => {
  // Proven directly by the Rust unit tests; assert they exist.
  assert.match(HINTS, /fn a_dead_worker_can_be_restarted_for_the_same_owner/u);
  assert.match(HINTS, /fn a_stale_worker_exit_cannot_clear_a_newer_generation/u);
  assert.match(HINTS, /fn a_second_start_for_the_same_owner_is_already_running_not_an_error/u);
  assert.match(HINTS, /fn a_stale_generation_cannot_publish/u);
  assert.match(HINTS, /fn the_phase_reports_starting_then_running_then_stopped/u);
});

test("P1-H2 — TS does not treat a queued task as live hints", async () => {
  // The worker never reaches `running`, so the feed must stay polling.
  const neverRuns = createHintSubscription((async (cmd: string) => {
    if (cmd === "services_hints_status") {
      return { generation: 2, phase: "starting", owner: "desktop-a", connectFailures: 0 };
    }
    return { outcome: "started", generation: 2 };
  }) as any);
  const feed = new ChangeFeedClient(neverRuns);
  await feed.start("fixture-desktop-1");
  assert.equal(feed.currentMode(), "polling", "queued is not live");
  assert.deepEqual(await feed.readHints(), []);

  // A stopped worker also degrades.
  const stopped = createHintSubscription((async (cmd: string) => {
    if (cmd === "services_hints_status") {
      return { generation: 3, phase: "stopped", owner: "", connectFailures: 1 };
    }
    return { outcome: "started", generation: 3 };
  }) as any);
  const f2 = new ChangeFeedClient(stopped);
  await f2.start("fixture-desktop-1");
  assert.equal(f2.currentMode(), "polling");
});

test("P1-H2 — a downgrade is visible: refreshMode notices a dead worker", async () => {
  let phase = "running";
  const sub = createHintSubscription((async (cmd: string) => {
    // The owner must be the instance this client started, or the binding is
    // correctly refused (G1H).
    if (cmd === "services_hints_status") return { generation: 1, phase, owner: "fixture-desktop-1", connectFailures: 0 };
    return { outcome: "started", generation: 1 };
  }) as any);
  const feed = new ChangeFeedClient(sub);
  await feed.start("fixture-desktop-1");
  assert.equal(feed.currentMode(), "hints");
  phase = "stopped"; // the socket died
  assert.equal(await feed.refreshMode(), "polling", "the feed stops claiming hints");
});

test("P1-H2 — a start failure degrades to polling rather than throwing", async () => {
  const failing = createHintSubscription((async () => { throw "nope"; }) as any);
  const feed = new ChangeFeedClient(failing);
  await feed.start("fixture-desktop-1");
  assert.equal(feed.currentMode(), "polling");
});

test("P1-H2 — the subscription exposes a bounded status, never bearer/URL", () => {
  assert.match(HINT_TS, /export type HintStatus/u);
  assert.match(HINT_TS, /export type HintPhase = "stopped" \| "starting" \| "running"/u);
  assert.match(HINT_TS, /invokeRef\("services_hints_status"\)/u);
  const stripped = code(HINT_TS);
  assert.doesNotMatch(stripped, /bearer|token|authorization|wss:\/\//iu, "no credential or URL is exposed");
});

// ===========================================================================
// P1-H3 — native lifecycle retirement
// ===========================================================================

test("P1-H3 — the three original native paths retire hints", () => {
  // R4 added the two db_reset paths, so this asserts at least the R3 set and
  // that each of those three is present.
  const retires = LIB.match(/services_hints::retire_managed\(\);/gu) ?? [];
  assert.ok(retires.length >= 3, `do_pair + conn_revoke + ws_stop (saw ${retires.length})`);
  for (const name of ["do_pair", "conn_revoke", "ws_stop"]) {
    const at = LIB.indexOf(`fn ${name}`);
    assert.ok(LIB.indexOf("services_hints::retire_managed();", at) > 0, `${name} retires hints`);
  }
});

test("P1-H3 — retirement happens BEFORE credential/pairing ownership changes", () => {
  const markers = [
    ["do_pair", "persist secure credential before metadata"],
    ["conn_revoke", "clear_pairing_and_secure_credentials(&mut db, &secure_store)?"],
    ["ws_stop", "mirror_conn_intent(&state, ConnectionIntent::ManualStop)"],
  ] as const;
  for (const [name, anchor] of markers) {
    const retire = LIB.indexOf("services_hints::retire_managed();", LIB.indexOf(`fn ${name}`));
    const clear = LIB.indexOf(anchor);
    assert.ok(retire > 0, `${name} retires hints`);
    assert.ok(clear > 0, `${name} has its ownership step`);
    assert.ok(retire < clear, `${name}: hints retire BEFORE ownership changes`);
  }
});

test("P1-H3 — hints retire in the same gate as the existing authenticated channels", () => {
  // In each lifecycle path the hint retirement sits with the LSH carrier stop.
  // The three R3 paths (do_pair / conn_revoke / ws_stop) sit in the SAME gate
  // as the LSH carrier stop, with only the explanatory comment between them.
  // The R4 db_reset paths are their own destructive gates and do not touch LSH,
  // so they are asserted separately (see the R4 contracts).
  for (const name of ["do_pair", "conn_revoke", "ws_stop"]) {
    const at = LIB.indexOf(`fn ${name}`);
    const retire = LIB.indexOf("services_hints::retire_managed();", at);
    assert.ok(retire > 0, `${name} retires hints`);
    const before = LIB.slice(Math.max(0, retire - 400), retire);
    assert.match(before, /crate::lsh_carrier::stop\(\);/u,
      `${name}: the hint retirement sits in the same gate as the LSH carrier stop`);
  }
});

test("P1-H3 — an immediate retire blocks publish without waiting for the socket", () => {
  // Bounded proof in Rust: publish is refused the instant retirement happens.
  assert.match(HINTS, /fn an_immediate_stop_blocks_publish_without_waiting_for_a_socket_timeout/u);
  // The publish guard checks the generation AND the phase.
  assert.match(HINTS, /if inner\.generation != generation \|\| inner\.phase == HintPhaseValue::Stopped/u);
});

test("P1-H3 — retirement does not require the UI to call stop", () => {
  // The native paths are the enforcement point, not the command.
  assert.match(LIB, /services_hints::retire_managed\(\)/u);
  assert.doesNotMatch(code(LIB), /luckyray.*stop hints/ui, "no UI-triggered reliance in native code");
  // retire_managed is safe with no installed state.
  assert.match(HINTS, /pub fn retire_managed\(\) \{\s*\r?\n\s*if let Some\(state\) = managed\(\)/u);
  assert.match(HINTS, /static MANAGED: std::sync::OnceLock<ManagedHintState>/u);
});

test("P1-H3 — no #72 LSH coupling was introduced", () => {
  const lsh = read("src-tauri", "src", "lsh_carrier.rs");
  assert.doesNotMatch(code(lsh), /services_hints/u, "the LSH carrier does not know about hints");
  const surface = read("src-tauri", "src", "lsh_surface.rs");
  assert.doesNotMatch(code(surface), /services_hints/u, "the LSH surface does not either");
});

// ===========================================================================
// Regression — accepted behaviour preserved
// ===========================================================================

test("R3 regression — typed hints and the bounded buffer are unchanged", () => {
  assert.equal(toHint({ kind: "materialChanged", cursor: "m:1" })?.kind, "materialChanged");
  assert.equal(toHint({ kind: "brandNew" }), null);
  assert.match(HINTS, /MAX_BUFFERED_HINTS: usize = 64/u);
  assert.match(HINTS, /fn the_buffer_is_bounded/u);
});

test("R3 regression — durable cursor is still truth and hints still wake only", () => {
  const feed = new ChangeFeedClient(null);
  assert.equal(feed.resumeCursor("m:5", { kind: "materialChanged", cursor: "m:99" }), "m:5");
  assert.equal(feed.currentMode(), "polling", "no subscription means polling");
  assert.match(FEED_TS, /permissionTruthStale/u, "servicesChanged still only invalidates");
});

test("R3 regression — no TS WebSocket and no HTTP GET at the hint route", () => {
  for (const [name, src] of [["hintSubscription", HINT_TS], ["changeFeed", FEED_TS]] as const) {
    const stripped = code(src);
    assert.doesNotMatch(stripped, /new WebSocket|WebSocket\(/u, `${name} opens no socket`);
    assert.doesNotMatch(stripped, /\/v1\/services\/events\/stream/u, `${name} never GETs the WSS route`);
  }
});

test("R3 regression — the foundation stream and LSH lifecycle are untouched", () => {
  // The hint worker is a separate task; the foundation client is still there.
  assert.match(WORKER, /pub struct EventStreamClient/u);
  assert.match(WORKER, /pub async fn stop\(&self\)/u);
  assert.match(LIB, /lsh_surface::lsh_surface_state/u);
  assert.match(LIB, /lsh_surface::lsh_surface_bootstrap/u);
  assert.match(LIB, /lsh_surface::lsh_surface_open/u);
  // And the Services HTTP transport is still registered.
  assert.match(LIB, /services_v1::services_v1_request/u);
});
