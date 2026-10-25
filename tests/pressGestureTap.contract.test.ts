// MATERIAL-LIBRARY-INSTANT-R1 REPAIR-R5b — a short tap must always open, on
// BOTH sources.
//
// R5 removed the tiles' plain `onClick` in favour of the shared gesture
// authority, but the authority early-returned on every handler when it was
// disabled. The Local source has no multi-select, so it passed `enabled=false`
// — and Local materials therefore had NO activation path at all: a short tap
// did nothing. The fix keeps the gesture fully active and only omits the
// long-press timer when there is no long press to arm.
//
// The decision table is pure, so the exact tap sequences are driven directly.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_PRESS_CONFIG, initialPressState, reducePress, suppressesClick,
} from "../src/still/kit/pressGesturePure.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const strip = (src: string) => src.replace(/^\s*\/\/.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, "");
const TILE = () => strip(read("src", "still", "kit", "mediaTile.tsx"));
const ROW = () => strip(read("src", "still", "kit", "libraryListRow.tsx"));
const ADAPTER = () => strip(read("src", "still", "kit", "pressGesture.ts"));

/**
 * Model the adapter exactly: the reducer drives the state, and the `arm` effect
 * is the ONLY thing gated on `enabled` (it starts the long-press timer). This
 * mirrors the production switch, so the assertions are about the real design.
 */
function harness(enabled: boolean) {
  let state = initialPressState();
  let held = false;
  let armed = false;
  const effects: string[] = [];
  const taps: string[] = [];
  const longPresses: string[] = [];

  const dispatch = (ev: Parameters<typeof reducePress>[1]) => {
    const r = reducePress(state, ev, DEFAULT_PRESS_CONFIG);
    state = r.state;
    switch (r.effect.type) {
      case "arm":
        armed = enabled;            // <- the only `enabled` gate in the adapter
        if (!enabled) effects.push("none");
        break;
      case "disarm": held = false; armed = false; break;
      case "longpress": held = true; longPresses.push("long"); break;
      case "activate": held = false; taps.push("open"); break;
      default: break;
    }
    return r.effect.type;
  };
  /** Deliver the long-press timer; it is only ever armed when enabled. */
  const tick = () => { if (armed) dispatch({ type: "timeout" }); };
  /** The trailing click the browser fires after a pointer/touch release. */
  const click = () => {
    if (held || state.phase === "held") { held = false; state = initialPressState(); return "swallowed"; }
    return "noop";
  };
  return { dispatch, tick, click, effects, taps, longPresses };
}

// The Local grid tile: no long press, so the gesture is disabled — and a tap
// must still open exactly once.
test("R5b-T1 — a Local grid short tap opens exactly once", () => {
  const h = harness(false);
  h.dispatch({ type: "down", x: 10, y: 10 });
  h.dispatch({ type: "up" });
  assert.deepEqual(h.taps, ["open"], "the Local tile opens on a short tap");
  assert.equal(h.click(), "noop", "and the trailing click adds no second open");
  assert.deepEqual(h.longPresses, [], "no selection is ever entered for Local");
});

// The Local list row behaves identically.
test("R5b-T2 — a Local list row short tap opens exactly once", () => {
  const h = harness(false);
  h.dispatch({ type: "down", x: 4, y: 4 });
  h.dispatch({ type: "up" });
  assert.deepEqual(h.taps, ["open"], "the Local row opens on a short tap");
  assert.equal(h.click(), "noop", "with no duplicate activation");
  assert.deepEqual(h.longPresses, []);
});

// Holding a Local tile must NOT enter selection (there is none) — it is just a
// tap that happens to be long.
test("R5b-T3 — holding a Local material does not enter selection", () => {
  const h = harness(false);
  h.dispatch({ type: "down", x: 10, y: 10 });
  h.tick();  // no timer was armed, so this is inert
  h.tick();
  h.dispatch({ type: "up" });
  assert.deepEqual(h.longPresses, [], "Local never enters multi-select");
  assert.deepEqual(h.taps, ["open"], "and the release still opens the detail");
});

// Desktop in normal mode: a short tap opens.
test("R5b-T4 — a Desktop short tap in normal mode opens exactly once", () => {
  const h = harness(true);
  h.dispatch({ type: "down", x: 10, y: 10 });
  h.dispatch({ type: "up" });
  assert.deepEqual(h.taps, ["open"], "the Desktop tile opens normally");
  assert.deepEqual(h.longPresses, [], "without entering selection");
  assert.equal(h.click(), "noop");
});

// Desktop long press enters selection AND does not open.
test("R5b-T5 — a Desktop long press enters selection and never opens", () => {
  const h = harness(true);
  h.dispatch({ type: "down", x: 10, y: 10 });
  h.tick();
  h.dispatch({ type: "up" });
  assert.deepEqual(h.longPresses, ["long"], "selection is entered once");
  assert.deepEqual(h.taps, [], "and the detail does NOT open");
  assert.equal(h.click(), "swallowed", "the trailing click is swallowed");
  assert.deepEqual(h.taps, [], "so nothing opens afterwards either");
});

// In selection mode the page routes a tap to a toggle, not to open. The gesture
// itself must still report exactly one activation for the page to consume.
test("R5b-T6 — in selection mode a Desktop tap activates exactly once for the toggle", () => {
  const h = harness(true);
  h.dispatch({ type: "down", x: 10, y: 10 });
  h.dispatch({ type: "up" });
  assert.deepEqual(h.taps, ["open"], "one activation the page turns into a toggle");
  assert.equal(h.click(), "noop", "never two, which would toggle back off");
  // Several consecutive taps stay one-for-one.
  for (let i = 0; i < 3; i++) { h.dispatch({ type: "down", x: 1, y: 1 }); h.dispatch({ type: "up" }); h.click(); }
  assert.equal(h.taps.length, 4, "each tap toggles exactly once");
});

// Scrolling still never opens in either mode.
test("R5b-T7 — a scroll opens nothing in either mode", () => {
  for (const enabled of [false, true]) {
    const h = harness(enabled);
    h.dispatch({ type: "down", x: 10, y: 10 });
    h.dispatch({ type: "move", x: 10, y: 60 });
    h.tick();
    h.dispatch({ type: "up" });
    assert.deepEqual(h.taps, [], `enabled=${enabled}: a scroll never opens`);
    assert.deepEqual(h.longPresses, [], `enabled=${enabled}: and never enters selection`);
    assert.equal(suppressesClick(initialPressState()), false);
  }
});

// ---------------------------------------------------------------------------
// Production wiring for the adapter and the tiles.
// ---------------------------------------------------------------------------

test("R5b-T8 — the adapter gates ONLY the long-press timer on `enabled`", () => {
  const adapter = ADAPTER();
  // The `arm` case is where `enabled` is consulted, and it omits the timer.
  const armIdx = adapter.indexOf('case "arm":');
  assert.ok(armIdx > 0, "the arm case exists");
  const arm = adapter.slice(armIdx, adapter.indexOf('case "disarm":', armIdx));
  assert.match(arm, /if \(!enabled\) break;/u, "a disabled gesture arms no timer");
  assert.match(arm, /setTimeout\(/u, "while an enabled one does");
  // No handler early-returns on `enabled` any more: that was the bug.
  for (const name of ["onPointerDown", "onPointerMove", "onPointerUp", "touchStart", "touchEnd", "touchCancel"]) {
    const idx = adapter.indexOf(`const ${name} = useCallback(`);
    assert.ok(idx > 0, `${name} exists`);
    const body = adapter.slice(idx, adapter.indexOf("}, [", idx));
    assert.doesNotMatch(body, /if \(!enabled\) return;/u,
      `${name} must not early-return when disabled (that removed the tap path)`);
  }
  // The down/up pair still reaches the reducer, which is what produces `activate`.
  assert.match(adapter, /dispatch\(\{ type: "down", x: e\.clientX, y: e\.clientY \}\);/u,
    "pointer down always drives the reducer");
  assert.match(adapter, /const endPointer = useCallback\(\(\) => \{[\s\S]{0,40}?dispatch\(\{ type: "up" \}\);/u,
    "and so does the release");
});

test("R5b-T9 — both tiles keep the gesture active and only omit the long press", () => {
  for (const [name, src] of [["tile", TILE()], ["row", ROW()]] as const) {
    assert.match(src, /enabled: Boolean\(onLongPress\)/u,
      `${name} passes long-press availability, not tap availability`);
    assert.match(src, /onTap: \(\) => onClick/u, `${name} always routes its tap`);
    assert.match(src, /\{\.\.\.press\.handlers\}/u, `${name} always spreads the handlers`);
    // Neither tile has a competing raw click that could double-activate.
    assert.doesNotMatch(src, /onClick=\{onClick\}/u, `${name} has no second activation path`);
  }
  // The Local source genuinely has no long press (so no multi-select for it).
  const lib = strip(read("src", "still", "StillLibrary.tsx"));
  assert.match(lib, /onLongPress=\{domain === "desktop" && writeGranted \?/u,
    "the page offers a long press only for the Desktop source");
});
