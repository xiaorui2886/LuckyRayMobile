// MATERIAL-LIBRARY-INSTANT-R1 REPAIR-R5 (C/D) — long-press gesture authority.
//
// The physical-device requirement is that a long press on a Desktop material
// enters selection WITHOUT also opening the detail, that scrolling cancels it,
// and that grid and list behave identically. The decision table is pure, so it
// is driven directly here rather than through a synthetic DOM.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_PRESS_CONFIG, LONG_PRESS_SLOP, LONG_PRESS_THRESHOLD,
  initialPressState, isArmed, reducePress, suppressesClick,
  type PressState,
} from "../src/still/kit/pressGesturePure.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const strip = (src: string) => src.replace(/^\s*\/\/.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, "");

/** Drive a whole gesture, returning every effect in order. */
function run(events: Parameters<typeof reducePress>[1][], config = DEFAULT_PRESS_CONFIG) {
  let state: PressState = initialPressState();
  const effects: string[] = [];
  for (const e of events) {
    const r = reducePress(state, e, config);
    state = r.state;
    effects.push(r.effect.type);
  }
  return { state, effects };
}

// The card's window is 450-550ms.
test("R5-G0 — the long-press threshold is inside the required 450-550ms window", () => {
  assert.ok(LONG_PRESS_THRESHOLD >= 450 && LONG_PRESS_THRESHOLD <= 550,
    `threshold ${LONG_PRESS_THRESHOLD} must be within 450-550ms`);
});

// G7. long press enters selection and selects the held asset
test("R5-G7 — holding past the threshold fires exactly one long press", () => {
  const { state, effects } = run([
    { type: "down", x: 10, y: 10 },
    { type: "timeout" },
  ]);
  assert.deepEqual(effects, ["arm", "longpress"], "armed then long-pressed, once");
  assert.equal(state.phase, "held");
  assert.equal(suppressesClick(state), true, "and the trailing click is suppressed");
});

// G8. long press suppresses the following click/open
test("R5-G8 — the release after a long press does NOT activate", () => {
  const { effects } = run([
    { type: "down", x: 10, y: 10 },
    { type: "timeout" },
    { type: "up" },
  ]);
  assert.deepEqual(effects, ["arm", "longpress", "none"],
    "the release produces no activation after a long press");
});

// A short tap still opens the asset.
test("R5-G6 — a short tap activates exactly once", () => {
  const short = run([{ type: "down", x: 10, y: 10 }, { type: "up" }]);
  assert.deepEqual(short.effects, ["arm", "activate"], "down then a real tap");
  assert.equal(suppressesClick(short.state), false, "and it is not treated as held");
  // Repeating the gesture gives exactly one activation each time — never two.
  const twice = run([
    { type: "down", x: 1, y: 1 }, { type: "up" },
    { type: "down", x: 2, y: 2 }, { type: "up" },
  ]);
  assert.equal(twice.effects.filter((e) => e === "activate").length, 2,
    "one activation per tap, no duplicates on an old WebView");
});

// G9. movement before the threshold cancels the long press
test("R5-G9 — moving past the slop cancels the long press", () => {
  const { state, effects } = run([
    { type: "down", x: 10, y: 10 },
    { type: "move", x: 10 + LONG_PRESS_SLOP + 20, y: 10 },
  ]);
  assert.deepEqual(effects, ["arm", "disarm"], "the timer is disarmed when scrolling starts");
  assert.equal(state.phase, "moved");
  assert.equal(isArmed(state), false, "and no long press can still fire");
  // A timeout arriving after the cancel must be inert.
  const after = reducePress(state, { type: "timeout" });
  assert.equal(after.effect.type, "none", "a late timer cannot enter selection after a scroll");
  // Releasing after a scroll must not open either.
  const up = reducePress(after.state, { type: "up" });
  assert.equal(up.effect.type, "none", "a scroll never becomes an accidental open");
});

// Tiny jitter inside the slop must NOT cancel.
test("R5-G9b — jitter within the slop keeps the press alive", () => {
  const { state, effects } = run([
    { type: "down", x: 10, y: 10 },
    { type: "move", x: 10 + LONG_PRESS_SLOP - 2, y: 10 + 1 },
  ]);
  assert.deepEqual(effects, ["arm", "none"], "a small twitch is not a scroll");
  assert.equal(isArmed(state), true, "the press is still armed");
});

// Movement cancels in BOTH axes (a vertical scroll must cancel too).
test("R5-G9c — a vertical scroll cancels the long press", () => {
  const { state, effects } = run([
    { type: "down", x: 10, y: 10 },
    { type: "move", x: 11, y: 10 + LONG_PRESS_SLOP + 30 },
  ]);
  assert.deepEqual(effects, ["arm", "disarm"], "scrolling down cancels it");
  assert.equal(state.phase, "moved");
});

// pointer / touch cancel cancels the gesture.
test("R5-G10 — a platform cancel abandons the press", () => {
  const { state, effects } = run([
    { type: "down", x: 10, y: 10 },
    { type: "cancel" },
  ]);
  assert.deepEqual(effects, ["arm", "disarm"], "the timer stops");
  assert.equal(state.phase, "cancelled");
  const late = reducePress(state, { type: "timeout" });
  assert.equal(late.effect.type, "none", "no long press after a cancel");
  const up = reducePress(late.state, { type: "up" });
  assert.equal(up.effect.type, "none", "and no open either");
});

// A second pointer-down mid-gesture must not arm a second timer.
test("R5-G11 — a repeated down cannot arm two long presses", () => {
  let state = initialPressState();
  const effects: string[] = [];
  for (const e of [
    { type: "down", x: 1, y: 1 }, { type: "down", x: 2, y: 2 }, { type: "timeout" },
  ] as const) {
    const r = reducePress(state, e);
    state = r.state; effects.push(r.effect.type);
  }
  assert.equal(effects.filter((e) => e === "longpress").length, 1,
    "only one long press fires for the gesture");
});

// A held gesture that is cancelled still cannot activate.
test("R5-G12 — a held gesture followed by a cancel stays inert", () => {
  const { effects } = run([
    { type: "down", x: 1, y: 1 }, { type: "timeout" }, { type: "cancel" }, { type: "up" },
  ]);
  assert.equal(effects.filter((e) => e === "activate").length, 0,
    "no activation path exists after a long press");
});

// ---------------------------------------------------------------------------
// The adapter must be ONE shared implementation used by grid AND list.
// ---------------------------------------------------------------------------

test("R5-G13 — grid and list share ONE press implementation", () => {
  const tile = strip(read("src", "still", "kit", "mediaTile.tsx"));
  const row = strip(read("src", "still", "kit", "libraryListRow.tsx"));
  assert.match(tile, /useLongPress\(/u, "the grid tile uses the shared hook");
  assert.match(row, /useLongPress\(/u, "the list row uses the same hook");
  // Neither tile implements its own timer.
  assert.doesNotMatch(tile, /setTimeout\(/u, "the tile owns no timer of its own");
  assert.doesNotMatch(row, /setTimeout\(/u, "nor does the row");
  // The threshold lives in exactly one place.
  const pure = strip(read("src", "still", "kit", "pressGesturePure.ts"));
  assert.match(pure, /export const LONG_PRESS_THRESHOLD = 500;/u, "one threshold constant");
  const adapter = strip(read("src", "still", "kit", "pressGesture.ts"));
  assert.match(adapter, /DEFAULT_PRESS_CONFIG/u, "the adapter reads the shared config");
  assert.doesNotMatch(adapter, /setTimeout\([\s\S]{0,40}?\b(450|500|550)\b/u,
    "the adapter does not hard-code a second threshold");
});

test("R5-G14 — the adapter registers a non-passive touch guard and blocks the context menu", () => {
  const adapter = strip(read("src", "still", "kit", "pressGesture.ts"));
  assert.match(adapter, /addEventListener\("touchmove", handler, \{ passive: false \}\)/u,
    "touchmove is non-passive so the browser cannot also run its own long press");
  assert.match(adapter, /onContextMenu[\s\S]{0,120}?preventDefault\(\)/u,
    "the context menu is suppressed (no system callout on a long press)");
  // Old-WebView fallback: without Pointer Events the touch path still works.
  assert.match(adapter, /hasPointerEvents\(\)/u, "the adapter detects Pointer Events support");
  assert.match(adapter, /const touchStart = useCallback\(\(e: React\.TouchEvent\) => \{[\s\S]{0,160}?hasPointerEvents\(\)\) return;/u,
    "the touch path bails out only when Pointer Events exist");
  assert.match(adapter, /dispatch\(\{ type: "down", x: t\.clientX, y: t\.clientY \}\)/u,
    "and otherwise drives the same reducer from the touch coordinates");
  assert.match(adapter, /onTouchStart: touchStart/u, "the touch handlers are exported to the element");
  assert.match(adapter, /setPointerCapture/u, "pointer capture keeps the gesture on the tile");
});
