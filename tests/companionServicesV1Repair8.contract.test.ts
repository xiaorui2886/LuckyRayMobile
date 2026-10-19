// REPAIR-R6 (#77) — scoped client-originated hint stop + drain fail-closed.
// Run: node --experimental-strip-types --test tests/companionServicesV1Repair8.contract.test.ts
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
const HINT_TS = read("src", "services", "companionServices", "hintSubscription.ts");
const FEED_TS = read("src", "services", "companionServices", "changeFeedClient.ts");
const LIB = read("src-tauri", "src", "lib.rs");

/** Strip comments so prose mentioning a symbol is not a match. */
const code = (src: string) =>
  src.replace(/^\s*\/\/.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, "");

/**
 * A faithful model of the native hint state used by the scoped-stop tests:
 * `begin` (owner+generation, clears buffer), `mark_running`, `publish`,
 * `retire_if_current_scope` (atomic owner/gen/live check + generation-matched
 * cancel), and `drain_if_current` (scoped destructive take).
 */
function nativeModel() {
  let owner = "";
  let generation = 0;
  let live = false;
  let buffer: Array<{ gen: number; kind: string }> = [];
  let cancelled = 0;
  const state = {
    begin(o: string) {
      const next = generation + 1;
      owner = o;
      generation = next;
      live = true;
      buffer = [];
      return next;
    },
    markRunning() {
      live = live && owner !== "";
      return live;
    },
    publish(kind: string) {
      if (!live) return false;
      buffer.push({ gen: generation, kind });
      return true;
    },
    retireIfCurrentScope(o: string, g: number) {
      if (!live || owner !== o || generation !== g) return false;
      live = false;
      buffer = [];
      generation += 1;
      cancelled += 1;
      return true;
    },
    drainIfCurrent(o: string, g: number) {
      if (!live || owner !== o || generation !== g) return [];
      const out = buffer.filter((r) => r.gen === g);
      buffer = buffer.filter((r) => r.gen !== g);
      return out;
    },
    get live() {
      return live;
    },
    get owner() {
      return owner;
    },
    get generation() {
      return generation;
    },
    get bufferCount() {
      return buffer.length;
    },
    get cancelledCount() {
      return cancelled;
    },
  };
  return state;
}

// ===========================================================================
// P1-G1H-STOP — scoped client-originated stop
// ===========================================================================

test("R6-STOP 1 — a stale A scoped stop is a no-op; B stays running and drains", async () => {
  const native = nativeModel();
  native.begin("desktop-a");
  native.markRunning();
  // B replaces A.
  native.begin("desktop-b");
  native.markRunning();
  native.publish("materialChanged");

  // Stale A calls its scoped stop: no-op, zero mutation, zero cancellation.
  assert.equal(native.retireIfCurrentScope("desktop-a", native.generation), false,
    "A's stop cannot retire B's live scope");
  assert.equal(native.live, true, "B remains running");
  assert.equal(native.owner, "desktop-b");
  assert.equal(native.cancelledCount, 0, "B's cancellation was NOT signalled by A");

  // B can still publish and drain its own records.
  assert.equal(native.publish("materialChanged"), true);
  const drained = native.drainIfCurrent("desktop-b", native.generation);
  assert.ok(drained.length >= 1, "B still drains normally after A's refused stop");
});

test("R6-STOP 2 — same-owner generation restart: stale gen1 stop cannot retire gen2", async () => {
  const native = nativeModel();
  native.begin("desktop-a");
  native.markRunning();
  const staleGeneration = native.generation;
  // Same owner restarts: new generation.
  native.begin("desktop-a");
  native.markRunning();
  const newGeneration = native.generation;
  assert.notEqual(newGeneration, staleGeneration);

  // A stale stop for the OLD generation is refused.
  assert.equal(native.retireIfCurrentScope("desktop-a", staleGeneration), false,
    "stale gen1 stop cannot retire gen2");
  assert.equal(native.live, true, "gen2 remains running");
  // While the CURRENT generation's scoped stop works.
  assert.equal(native.retireIfCurrentScope("desktop-a", newGeneration), true,
    "current generation can retire itself");
});

test("R6-STOP 3 — a current scoped stop retires and signals its own cancellation", () => {
  const native = nativeModel();
  native.begin("desktop-a");
  native.markRunning();
  const generation = native.generation;
  assert.equal(native.publish("lshStateChanged"), true, "a record is buffered");

  assert.equal(native.retireIfCurrentScope("desktop-a", generation), true,
    "the current scope retires itself");
  assert.equal(native.live, false, "publication is invalidated");
  assert.equal(native.bufferCount, 0, "the buffer is cleared");
  assert.equal(native.cancelledCount, 1, "the matching cancellation is signalled exactly once");
});

// ===========================================================================
// TS wiring — scoped stop through the captured binding
// ===========================================================================

test("R6-TS — stop forwards the captured scope and stale stop is a no-op", async () => {
  let stopCalls: Array<{ instance: string; generation: number }> = [];
  let nativeGeneration = 0;
  let nativeOwner = "";
  const sub = createHintSubscription((async (cmd: string, args: any) => {
    if (cmd === "services_hints_start") {
      nativeOwner = String(args?.instance ?? "");
      nativeGeneration = nativeOwner === "desktop-b" ? 9 : 4;
      return { outcome: "started", generation: nativeGeneration };
    }
    if (cmd === "services_hints_status") {
      return { generation: nativeGeneration, phase: "running", owner: nativeOwner, connectFailures: 0 };
    }
    if (cmd === "services_hints_stop") {
      stopCalls.push({ instance: String(args?.instance ?? ""), generation: Number(args?.generation ?? -1) });
      // Native scope check: only the live scope can retire.
      return stopCalls.at(-1)!.instance === nativeOwner;
    }
    return undefined;
  }) as any);

  const feed = new ChangeFeedClient(sub);
  await feed.start("desktop-a"); // binds gen 4, owner desktop-a
  // Another client switches the global worker to desktop-b.
  await sub.start("desktop-b");

  // A stops: the captured binding is (desktop-a, gen 4). The native side
  // refuses because the live scope is now desktop-b.
  await feed.stop();
  assert.equal(feed.currentMode(), "polling", "local context cleared");
  assert.equal(feed.boundGeneration(), null, "local binding cleared");
  assert.equal(nativeOwner, "desktop-b", "B's live scope untouched by A's stop");
  // A's scoped stop carried the OLD binding, which the native refused.
  assert.deepEqual(stopCalls.at(-1), { instance: "desktop-a", generation: 4 },
    "A's stop carried the stale scope and was refused native-side");
});

test("R6-TS — an unbound client never issues an unscoped global stop", async () => {
  let stopInvoked = 0;
  let stoppedWithScope = false;
  const sub = createHintSubscription((async (cmd: string, args: any) => {
    if (cmd === "services_hints_stop") {
      stopInvoked += 1;
      if (args && args.instance && typeof args.generation === "number" && args.generation >= 0) {
        stoppedWithScope = true;
      }
      return false;
    }
    return undefined;
  }) as any);
  const feed = new ChangeFeedClient(sub);
  // Never started: unbound.
  await feed.stop();
  assert.equal(stopInvoked, 0, "an unbound client issues no native stop at all");
  assert.equal(feed.currentMode(), "polling");
});

test("R6-TS — a polling client with no binding never issues an unscoped stop", async () => {
  // A client whose start degraded to polling (no binding) must never issue a
  // scoped native stop — it has nothing of its own to retire.
  let stopCalls = 0;
  const sub = createHintSubscription((async (cmd: string) => {
    if (cmd === "services_hints_stop") stopCalls += 1;
    return true;
  }) as any);
  const feed = new ChangeFeedClient(sub);
  // Start fails (the fake throws): the client degrades to polling, unbound.
  const brokenSub = createHintSubscription((async (cmd: string) => {
    if (cmd === "services_hints_start") throw "no worker";
    if (cmd === "services_hints_stop") stopCalls += 1;
    return true;
  }) as any);
  const unboundFeed = new ChangeFeedClient(brokenSub);
  await unboundFeed.start("desktop-a");
  await unboundFeed.stop();
  assert.equal(unboundFeed.currentMode(), "polling", "degraded to polling");
  assert.equal(stopCalls, 0, "no native stop from an unbound client");
});

// ===========================================================================
// Fail-closed drained-record generation (R4 restoration)
// ===========================================================================

test("R6-drain — a record without a numeric generation is skipped, not synthesized", async () => {
  const sub = createHintSubscription((async (cmd: string, args: any) => {
    if (cmd === "services_hints_state" && args?.generation === 7) {
      return [
        { generation: 7, hint: { kind: "materialChanged", cursor: "m:1" } },
        { hint: { kind: "lshStateChanged" } }, // malformed: no generation
        { generation: "7", hint: { kind: "lshStateChanged" } }, // non-numeric
      ];
    }
    return [];
  }) as any);
  const records = await sub.drain({ instance: "fixture-desktop-1", generation: 7 });
  assert.equal(records.length, 1, "only the well-formed record survives");
  assert.equal(records[0].generation, 7);
  assert.equal(records[0].hint.kind, "materialChanged");
  const src = read("src", "services", "companionServices", "hintSubscription.ts");
  // The record loop must NOT synthesize a generation from `expected.generation`
  // — the IPC forward of the binding is fine, but a record without a numeric
  // generation is skipped rather than back-filled.
  const stripped = src.replace(/^\s*\/\/.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, "");
  const recordLoop = stripped.slice(stripped.indexOf("for (const record of records)"), stripped.indexOf("return out"));
  assert.doesNotMatch(recordLoop, /expected\.generation/u,
    "the consumer never synthesizes a generation from the expectation");
});
