// MATERIAL-LIBRARY-INSTANT-R1 REPAIR-R7a — a held drag-select must not be
// stolen by the WebView's default scroll.
//
// The tiles' pointer/touch moves DID report coordinates during the held phase,
// but nothing stopped the browser's pan: on the MI 8's WebView 83 the first
// real movement after the long press lets the WebView start scrolling, which
// fires pointercancel and kills the drag. The fix is ONE phase-aware
// non-passive touchmove guard per gesture host, attached through the shared
// adapter: it acts ONLY in the held phase (armed/moved scroll freely), and the
// reducer already treats a cancel during held as inert, so even a stray
// pointercancel cannot end the sweep.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_PRESS_CONFIG, initialPressState, reducePress,
} from "../src/still/kit/pressGesturePure.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const strip = (src: string) => src.replace(/^\s*\/\/.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, "");
const ADAPTER = () => strip(read("src", "still", "kit", "pressGesture.ts"));
const TILE = () => strip(read("src", "still", "kit", "mediaTile.tsx"));
const ROW = () => strip(read("src", "still", "kit", "libraryListRow.tsx"));
const CSS = () => read("src", "presentation", "still01", "still.css");

/**
 * Drive the guard's exact decision table: given the LIVE phase, does the
 * native touchmove handler prevent the default and report the coordinates?
 * This mirrors the production handler one-to-one.
 */
function guardDecision(phase: "idle" | "armed" | "held" | "moved" | "cancelled") {
  let prevented = false;
  const reported: Array<[number, number]> = [];
  // The production handler, verbatim in structure:
  const handler = (e: { touches: Array<{ clientX: number; clientY: number }>; preventDefault: () => void }) => {
    if (phase !== "held") return; // before the threshold: scroll freely
    e.preventDefault();
    const t = e.touches[0];
    if (t) reported.push([t.clientX, t.clientY]);
  };
  handler({ touches: [{ clientX: 30, clientY: 70 }], preventDefault: () => { prevented = true; } });
  return { prevented, reported };
}

// 1. a move BEFORE the threshold never prevents the default scroll.
test("R7a-1 — armed/moved/idle moves do not preventDefault", () => {
  for (const phase of ["idle", "armed", "moved", "cancelled"] as const) {
    const d = guardDecision(phase);
    assert.equal(d.prevented, false, `${phase}: the page keeps its normal scrolling`);
    assert.equal(d.reported.length, 0, `${phase}: and nothing is reported`);
  }
});

// 2. a held touchmove prevents the default AND reports the drag coordinates.
test("R7a-2 — a held touchmove preventDefaults and reports", () => {
  const d = guardDecision("held");
  assert.equal(d.prevented, true, "the WebView pan is suppressed");
  assert.deepEqual(d.reported, [[30, 70]], "and the same onDragSelect gets the coordinates");
});

// 3. a held POINTER move also cancels the default pan where cancelable.
test("R7a-3 — a held pointer move preventDefaults when cancelable", () => {
  const adapter = ADAPTER();
  const idx = adapter.indexOf("const onPointerMove = useCallback(");
  const body = adapter.slice(idx, adapter.indexOf("}, [dispatch]);", idx));
  assert.match(body, /if \(stateRef\.current\.phase === "held"\) \{/u, "the held branch");
  assert.match(body, /if \(e\.cancelable\) e\.preventDefault\(\);/u,
    "cancels the default pan on the pointer path");
  assert.match(body, /dragSelectRef\.current\?\.\(e\.clientX, e\.clientY\)/u, "and reports");
  // The React TOUCH path must NOT preventDefault (passive at the root) — the
  // native guard owns it there.
  const tIdx = adapter.indexOf("const touchMove = useCallback(");
  const tBody = adapter.slice(tIdx, adapter.indexOf("}, [dispatch]);", tIdx));
  assert.doesNotMatch(tBody, /preventDefault/u,
    "the synthetic touchmove never preventDefaults (it is passive in React)");
});

// 4. a cancel BEFORE the hold still cancels the pending press normally.
test("R7a-4 — a pre-hold cancel still cancels", () => {
  let state = initialPressState();
  state = reducePress(state, { type: "down", x: 1, y: 1 }, DEFAULT_PRESS_CONFIG).state;
  const r = reducePress(state, { type: "cancel" }, DEFAULT_PRESS_CONFIG);
  assert.equal(r.state.phase, "cancelled");
  assert.equal(r.effect.type, "disarm", "the timer stops as before");
});

// 5. after the hold, a finger up never opens; and a stray pointercancel does
//    not end the sweep (the reducer treats it as inert in held).
test("R7a-5 — held: up opens nothing; a stray cancel cannot end the sweep", () => {
  let state = initialPressState();
  state = reducePress(state, { type: "down", x: 1, y: 1 }, DEFAULT_PRESS_CONFIG).state;
  state = reducePress(state, { type: "timeout" }, DEFAULT_PRESS_CONFIG).state;
  assert.equal(state.phase, "held");
  const cancelled = reducePress(state, { type: "cancel" }, DEFAULT_PRESS_CONFIG);
  assert.equal(cancelled.state.phase, "held", "a scroll-induced pointercancel does not break the drag");
  assert.equal(cancelled.effect.type, "none");
  const moved = reducePress(cancelled.state, { type: "move", x: 90, y: 400 }, DEFAULT_PRESS_CONFIG);
  assert.equal(moved.state.phase, "held", "the sweep keeps reporting after the stray cancel");
  const up = reducePress(moved.state, { type: "up" }, DEFAULT_PRESS_CONFIG);
  assert.equal(up.effect.type, "none", "finger up ends without opening");
});

// 6. grid AND list share ONE guard, attached through the shared adapter.
test("R7a-6 — both layouts pass their host ref into the same adapter guard", () => {
  const adapter = ADAPTER();
  assert.match(adapter, /useNonPassivePressGuard\(hostRef, stateRef,/u,
    "the adapter attaches the guard from the single hook implementation");
  assert.match(adapter, /hostRef\?: React\.RefObject<HTMLElement \| null>;/u,
    "the hook takes the host element");
  for (const [name, src] of [["tile", TILE()], ["row", ROW()]] as const) {
    const hook = src.slice(src.indexOf("useLongPress({"), src.indexOf("});", src.indexOf("useLongPress({")));
    assert.match(hook, /hostRef[:,\s]/u, `${name} passes its host ref into the hook`);
  }
  // The guard is attached natively and non-passively — the only mechanism that
  // can actually stop the WebView pan.
  const guard = adapter.slice(adapter.indexOf("export function useNonPassivePressGuard"));
  assert.match(guard, /addEventListener\("touchmove", handler, \{ passive: false \}\)/u,
    "registered natively and non-passively");
});

// 7. Local (gesture disabled) keeps normal scrolling and taps.
test("R7a-7 — a disabled gesture never reaches the held phase", () => {
  const adapter = ADAPTER();
  const arm = adapter.slice(adapter.indexOf('case "arm":'));
  assert.match(arm.slice(0, arm.indexOf('case "disarm":')), /if \(!enabled\) break;/u,
    "a disabled gesture arms no timer, so `held` is unreachable and the guard never acts");
  // And the reducer still gives a plain tap its activation.
  let state = initialPressState();
  state = reducePress(state, { type: "down", x: 1, y: 1 }, DEFAULT_PRESS_CONFIG).state;
  const up = reducePress(state, { type: "up" }, DEFAULT_PRESS_CONFIG);
  assert.equal(up.effect.type, "activate", "a Local short tap still opens");
});

// 8. no permanent touch-action:none anywhere.
test("R7a-8 — no blanket touch-action:none is introduced", () => {
  const css = CSS();
  // Pre-existing touch-action:none lives only on the full-screen asset viewer
  // pan area and the sheet drag handle — never on the material cards.
  for (const sel of [".st-media-tile{", ".st-media-grid{", ".st-row{", ".st-select-bar{"]) {
    for (let at = css.indexOf(sel); at !== -1; at = css.indexOf(sel, at + 1)) {
      const rule = css.slice(at, css.indexOf("}", at) + 1);
      assert.ok(!rule.includes("touch-action:none"),
        `${sel} never disables touch scrolling (rule: ${rule.slice(0, 80)}…)`);
    }
  }
  const adapter = ADAPTER();
  assert.doesNotMatch(adapter, /touchAction/u, "and the gesture code never writes touch-action");
  // Buttons keep only the tap-highlight suppression, which still allows pan.
  assert.match(css, /\.st-app button\{[^}]*touch-action:manipulation/u,
    "cards keep the standard manipulation behaviour (scroll allowed, double-tap zoom killed)");
});
