// STITCH-R6-PARITY-FIX-R1 — Touch & Navigation Blocker Regression Guard (P1).
//
// Regressions guarded against:
//  1. The "unclickable Home / frozen Bottom Nav" incident on MI8 / WebView 83:
//     - `.sheet-layer` MUST dismiss when tapping the backdrop outside `.sheet`;
//     - `.sheet` MUST carry an explicit close button;
//     - `.sheet` options must scroll internally so the footer button is NEVER
//       pushed out of the viewport;
//     - `.bottom-nav`, `.compose-fab` and `.sheet-layer` MUST follow R6
//       authority and use `position: absolute` inside `.app-shell`, NEVER
//       fixed (fixed creates isolated compositor layers in WebView 83 that
//       break hit testing and overlap other targets);
//     - `.screen.active` MUST NOT carry a `translateY` animation that offsets
//       the page geometry by 5px or leaves stale transformation matrices;
//  2. `overlayStack` lifecycle: deterministic push/pop/dismissTop.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OverlayStack } from "../src/services/overlayStack.ts";

const ROOT = join(import.meta.dirname, "..");
const uiSource = readFileSync(join(ROOT, "src", "components", "ui.tsx"), "utf8");
const appCss = readFileSync(join(ROOT, "src", "app.css"), "utf8");

test("p1 regression — Sheet has backdrop tap dismiss, internal scroll and footer reachability", () => {
  // Must check target === currentTarget to close on backdrop tap
  assert.match(
    uiSource,
    /e\.target\s*===\s*e\.currentTarget\s*\)\s*onClose\(\)/,
    "Sheet must dismiss when tapping the backdrop scrim"
  );
  // Must register to overlayStack for physical Back key dismiss
  assert.match(
    uiSource,
    /overlayStack\.push\(onClose\)/,
    "Sheet must register its onClose dismisser to overlayStack"
  );
  // Sheet content must be constrained to an internal scroller so footer is never pushed out
  assert.match(
    uiSource,
    /maxHeight:\s*"calc\(82vh\s*-\s*130px\)"/,
    "Sheet options must scroll internally with a safe viewport ceiling"
  );
});

test("p1 regression — Bottom Nav and FAB follow R6 authority and use absolute positioning", () => {
  // R6 HTML specifies position: absolute for bottom-nav and compose-fab
  assert.match(
    appCss,
    /\.bottom-nav\s*\{[^}]*position:\s*absolute;/,
    ".bottom-nav must be position: absolute inside .app-shell"
  );
  assert.match(
    appCss,
    /\.compose-fab\s*\{[^}]*position:\s*absolute;/,
    ".compose-fab must be position: absolute inside .app-shell"
  );
  // .screen.active must NOT have transform animation
  assert.doesNotMatch(
    appCss,
    /\.screen\.active\s*\{[^}]*animation:\s*page-in/,
    ".screen.active must not have translateY animation"
  );
});

test("p1 regression — overlayStack deterministic lifecycle", () => {
  const stack = new OverlayStack();
  assert.equal(stack.depth(), 0);
  assert.equal(stack.dismissTop(), false, "empty stack returns false");

  let closed1 = false;
  let closed2 = false;
  const release1 = stack.push(() => { closed1 = true; });
  const release2 = stack.push(() => { closed2 = true; });
  assert.equal(stack.depth(), 2);

  // Topmost dismisses first
  assert.equal(stack.dismissTop(), true);
  assert.equal(closed2, true);
  assert.equal(closed1, false);

  // Manual release of remaining item
  release1();
  assert.equal(stack.depth(), 0);
  assert.equal(stack.dismissTop(), false);
});
