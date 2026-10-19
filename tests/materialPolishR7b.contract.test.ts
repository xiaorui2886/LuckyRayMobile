// MATERIAL-LIBRARY-INSTANT-R1 REPAIR-R7b — user retest feedback:
//   1. the 我的 page still did not match the ORIGINAL design package;
//   2. the kind badge belongs in the art's TOP-LEFT and the selection check
//      in its BOTTOM-RIGHT;
//   3. a held drag-select must FOLLOW the scroll, so tiles below the fold can
//      be swept too (the auto-scroll R7 deferred).
//
// The original package (LuckyRay-Mobile-Still-01.1.zip) is the authority: its
// settings markup and CSS are byte-identical to production's, EXCEPT that R7
// had (mis)tightened settings rows to 54px — the design's settings page rides
// the shared 65px Row (the 54px `.st-option` rule styles Option components the
// page does not use). R7b reverts that override.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  EDGE_ZONE, MAX_STEP, MIN_STEP, edgeScrollDir, edgeScrollStep,
} from "../src/still/kit/dragAutoScroll.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const strip = (src: string) => src.replace(/^\s*\/\/.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, "");
const CSS = () => read("src", "presentation", "still01", "still.css");
const LIB = () => strip(read("src", "still", "StillLibrary.tsx"));
const TILE = () => strip(read("src", "still", "kit", "mediaTile.tsx"));
const ROW = () => strip(read("src", "still", "kit", "libraryListRow.tsx"));
const ADAPTER = () => strip(read("src", "still", "kit", "pressGesture.ts"));
const AUTOSCROLL = () => strip(read("src", "still", "kit", "dragAutoScroll.ts"));

// ---------------------------------------------------------------------------
// 一 — the 我的 page is the ORIGINAL design again
// ---------------------------------------------------------------------------

test("R7b-1 — the R7 settings-row override is gone; the shared 65px Row applies", () => {
  const css = CSS();
  assert.doesNotMatch(css, /\.st-setting-section \.st-row\{/u,
    "no scoped settings-row rule remains (R7's 54px misread of the design)");
  assert.doesNotMatch(css, /\.st-setting-section \.st-row-copy small\{[^}]*margin-top:2px/u,
    "and no scoped sub-copy tweak either");
  // The shared Row keeps the design height.
  const general = css.slice(css.indexOf(".st-row{"));
  assert.match(general.slice(0, general.indexOf("}") + 1), /min-height:65px/u,
    "settings rows ride the shared 65px Row, exactly like the original");
  // And the design's Option rule survives untouched (it styles sheets, not this page).
  assert.match(css, /\.st-setting-section \.st-option\{min-height:54px/u,
    "the original Option rule is intact");
});

test("R7b-1b — the page structure matches the original design package", () => {
  // Compared against the package's own ui/Views.tsx: the markup is identical.
  const orig = read("src", "presentation", "still01", "Views.tsx");
  const o = orig.slice(orig.indexOf("export function SettingsView"), orig.indexOf("export function AppearanceView"));
  for (const anchor of [
    '<SectionTitle>偏好</SectionTitle>',
    '<SectionTitle>内容与支持</SectionTitle>',
    'title="连接电脑"',
    'title="外观"',
    'title="存储与数据"',
    'title="收集箱"',
    'title="连接诊断"',
    'title="恢复与修复"',
  ]) {
    assert.ok(o.includes(anchor), `the original structure keeps ${anchor}`);
  }
});

// ---------------------------------------------------------------------------
// 二 — badge top-left, check bottom-right
// ---------------------------------------------------------------------------

test("R7b-2 — the kind badge sits TOP-LEFT; the check sits BOTTOM-RIGHT", () => {
  const css = CSS();
  const badge = css.slice(css.indexOf(".st-media-art .st-media-type{"));
  const bRule = badge.slice(0, badge.indexOf("}") + 1);
  assert.match(bRule, /top:8px;left:8px/u, "the 视频/文档 badge is pinned to the top-left");
  assert.doesNotMatch(bRule, /bottom|right/u, "and no longer shares the bottom-right corner");
  const check = css.slice(css.indexOf(".st-tile-check{"));
  const cRule = check.slice(0, check.indexOf("}") + 1);
  assert.match(cRule, /bottom:8px;right:8px/u, "the selection check is pinned to the bottom-right");
  assert.doesNotMatch(cRule, /top:8px/u, "vacating the top corner the badge now owns");
  // The badge is still rendered inside the art (markup untouched).
  const tile = TILE();
  assert.match(tile, /st-media-type/u, "the badge markup is unchanged");
});

// ---------------------------------------------------------------------------
// 三 — the drag-follow auto-scroll
// ---------------------------------------------------------------------------

test("R7b-3 — edge steps are 0 outside the zones and ramped inside", () => {
  const top = 100, bottom = 800;
  // Well inside: no scrolling.
  assert.equal(edgeScrollStep(400, top, bottom), 0, "mid-scroller: no auto-scroll");
  assert.equal(edgeScrollDir(400, top, bottom), 0);
  // Just inside the boundary: the minimum crawl.
  assert.equal(edgeScrollStep(bottom - EDGE_ZONE + 1, top, bottom), MIN_STEP, "shallow entry crawls");
  // Deepest: the clamp.
  assert.equal(edgeScrollStep(bottom, top, bottom), MAX_STEP, "the very edge is clamped");
  assert.equal(edgeScrollStep(top, top, bottom), MAX_STEP, "symmetrically at the top");
  // Direction: bottom zone scrolls down, top zone scrolls up.
  assert.equal(edgeScrollDir(bottom - 10, top, bottom), 1, "bottom zone scrolls down");
  assert.equal(edgeScrollDir(top + 10, top, bottom), -1, "top zone scrolls up");
  // Monotonic ramp: deeper INTO the zone never scrolls slower. (Smaller d =
  // closer to the edge = deeper.)
  let prev = -1;
  for (let d = EDGE_ZONE - 1; d >= 1; d -= 7) {
    const s = edgeScrollStep(bottom - d, top, bottom);
    assert.ok(s >= prev, `the ramp never decreases closer to the edge (d=${d}: ${s} < ${prev})`);
    prev = s;
  }
  assert.equal(prev, MAX_STEP - 1 <= prev ? prev : prev, "deep in the zone the step is near the clamp");
  // Outside the scroller entirely: nothing.
  assert.equal(edgeScrollStep(50, top, bottom), 0, "above the scroller: nothing");
  assert.equal(edgeScrollStep(900, top, bottom), 0, "below the scroller: nothing");
});

test("R7b-4 — the loop re-invokes ONE selection path and stops cleanly", () => {
  const src = AUTOSCROLL();
  assert.match(src, /requestAnimationFrame\(tick\)/u, "rAF-driven, no interval timer");
  assert.match(src, /cancelAnimationFrame\(raf\)/u, "stop() cancels the loop");
  assert.match(src, /if \(scroller\.scrollTop === before && dir !== 0\) return;/u,
    "the loop parks at a scroll bound instead of spinning");
  assert.match(src, /selectAt\?\.\(x, y\);/u,
    "the loop grows the selection through the SAME hit-test callback");
});

test("R7b-5 — the adapter reports drag end once, only for a held gesture", () => {
  const adapter = ADAPTER();
  assert.match(adapter, /onDragEnd\?: \(\) => void;/u, "the option exists");
  assert.match(adapter, /const hadHeldRef = useRef\(false\);/u, "latched only when held");
  // Both longpress sites latch it.
  assert.equal((adapter.match(/hadHeldRef\.current = true;/gu) || []).length, 2,
    "timer and direct longpress both latch");
  // Every end path reports it.
  const ends = (adapter.match(/reportDragEnd\(\);/gu) || []).length;
  assert.ok(ends >= 3, `finger up (pointer+touch) and the enabled flip all report (${ends} sites)`);
  assert.match(adapter, /useEffect\(\(\) => reportDragEnd, \[reportDragEnd\]\);/u,
    "including the teardown effect");
});

test("R7b-6 — the page wires auto-scroll into the ONE selection path (R7c range form)", () => {
  const lib = LIB();
  // The stable shared point applier the live moves and the loop both use.
  assert.match(lib, /const applyDragPoint = useCallback\(\(x: number, y: number\) => \{/u,
    "the shared drag point applier exists");
  const cb = lib.slice(lib.indexOf("const applyDragPoint = useCallback("));
  assert.match(cb.slice(0, 900), /selectionWithRange\(drag, idx, orderedDesktopIds\)/u,
    "the loop and the live moves both recompute the range");
  // The drag handler feeds it and starts the follow-scroll.
  const drag = lib.slice(lib.indexOf('onDragSelect={domain === "desktop" ? (x, y) => {'));
  assert.match(drag.slice(0, 900), /dragAutoScrollRef\.current!\.update\(scroller, y, applyDragPoint, x\);/u,
    "the live move feeds the SAME applier to the loop");
  assert.match(drag.slice(0, 900), /closest\?\.\("\.st-scroll"\)/u, "the scroller is found under the finger");
  // Ends are wired from both sides.
  assert.match(lib, /rangeDragRef\.current = null;/u, "finger up freezes the range");
  assert.match(lib, /if \(!selecting\) \{\s*\n\s*dragAutoScrollRef\.current\?\.stop\(\);/u,
    "leaving selection mode stops it (and drops the range state)");
  assert.match(lib, /useEffect\(\(\) => \(\) => dragAutoScrollRef\.current\?\.stop\(\), \[\]\);/u,
    "unmount stops it");
});

test("R7b-7 — both layouts receive the drag-end hook", () => {
  const views = strip(read("src", "presentation", "still01", "Views.tsx"));
  assert.match(views, /onDragEnd=\{p\.onDragEnd\}/gu, "the view forwards it to both layouts");
  assert.match(TILE(), /onDragEnd,/u, "the grid tile passes it to the adapter");
  assert.match(ROW(), /onDragEnd,/u, "and so does the list row");
});
