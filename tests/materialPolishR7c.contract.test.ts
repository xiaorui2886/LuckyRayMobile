// MATERIAL-LIBRARY-INSTANT-R1 REPAIR-R7c — two corrected understandings:
//
// (1) The 我的-page defect was never row height: the generic Row rendered a
//     46px+12px placeholder slot when an item had neither thumb nor icon, so
//     every settings row's text started 58px too far right. The ORIGINAL Row
//     renders NOTHING in that case; R7c restores that, and the material LIST
//     now explicitly requests its art slot (reserveThumbSpace) instead of
//     riding a generic default.
// (2) Drag-select becomes mainstream album RANGE select: anchor ∪ endpoint
//     over the ordered page, not append-what-you-touch.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  indexOfId, selectionWithRange, type RangeDrag,
} from "../src/still/kit/rangeSelect.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const strip = (src: string) => src.replace(/^\s*\/\/.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, "");
const STILL = () => strip(read("src", "presentation", "still01", "Still.tsx"));
const ROWK = () => strip(read("src", "still", "kit", "libraryListRow.tsx"));
const LIB = () => strip(read("src", "still", "StillLibrary.tsx"));
const RANGE = () => strip(read("src", "still", "kit", "rangeSelect.ts"));

// ---------------------------------------------------------------------------
// (1) the Row's left slot
// ---------------------------------------------------------------------------

test("R7c-1 — no thumb and no icon renders NOTHING (the original behaviour)", () => {
  const still = STILL();
  const row = still.slice(still.indexOf("export function Row("));
  const body = row.slice(0, row.indexOf("export function", 10));
  assert.match(body, /:reserveThumbSlot\?<span className="st-row-thumb is-placeholder" aria-hidden="true"\/>:null\}/u,
    "the placeholder is gated on an EXPLICIT request and falls through to null");
  assert.match(body, /reserveThumbSlot\?:boolean/u, "the prop is opt-in");
  // The three-tier order still prefers a real thumb, then an icon.
  assert.match(body, /thumb&&!thumbFailed\?<img[\s\S]{0,160}?icon\?<span className="st-row-symbol"/u,
    "thumb, then icon, then the explicit slot, then nothing");
});

test("R7c-2 — the material LIST explicitly requests its art slot", () => {
  const row = ROWK();
  assert.match(row, /reserveThumbSpace\?: boolean;/u, "the wrapper declares the need");
  assert.match(row, /reserveThumbSpace = true/u, "defaulting to true FOR MATERIAL ROWS ONLY");
  assert.match(row, /reserveThumbSlot=\{reserveThumbSpace\}/u,
    "and passes it down as the explicit request — the generic Row never defaults it");
  // Every other Row consumer gets no slot unless it asks.
  const views = strip(read("src", "presentation", "still01", "Views.tsx"));
  const settings = views.slice(views.indexOf("export function SettingsView"));
  assert.match(settings, /<Row icon="monitor" title="连接电脑"/u,
    "连接电脑 keeps its monitor icon (requirement 4)");
  for (const t of ["外观", "存储与数据", "收集箱", "连接诊断", "恢复与修复"]) {
    const m = settings.match(new RegExp(`<Row title="${t}"`));
    assert.ok(m, `${t} renders a plain Row`);
  }
  assert.doesNotMatch(settings, /<Row title="(?:外观|存储与数据|收集箱|连接诊断|恢复与修复)"[^/]*reserveThumb/u,
    "none of them reserves a slot");
});

test("R7c-3 — no row-height games this round", () => {
  const css = read("src", "presentation", "still01", "still.css");
  assert.doesNotMatch(css, /\.st-setting-section \.st-row\{/u,
    "R7b already removed the scoped rule; R7c adds nothing height-based");
  const general = css.slice(css.indexOf(".st-row{"));
  assert.match(general.slice(0, general.indexOf("}") + 1), /min-height:65px/u,
    "the shared Row height stays the original 65px");
});

// ---------------------------------------------------------------------------
// (2) range select — the pure helper, every branch
// ---------------------------------------------------------------------------

const IDS = ["a", "b", "c", "d", "e", "f", "g", "h"];
const drag = (anchor: number, baseline: string[] = []): RangeDrag => ({ anchorIndex: anchor, baseline });

test("R7c-4 — anchor 2 dragged to endpoint 6 selects the whole 2..6 range", () => {
  const sel = selectionWithRange(drag(2), 6, IDS);
  assert.deepEqual([...sel].sort(), ["c", "d", "e", "f", "g"],
    "items the finger never crossed (the other grid column) join too");
});

test("R7c-5 — dragging back SHRINKS the range", () => {
  const far = selectionWithRange(drag(2), 6, IDS);
  const back = selectionWithRange(drag(2), 4, IDS);
  assert.deepEqual([...far].sort(), ["c", "d", "e", "f", "g"]);
  assert.deepEqual([...back].sort(), ["c", "d", "e"], "the range is recomputed, never appended");
  const home = selectionWithRange(drag(2), 2, IDS);
  assert.deepEqual([...home].sort(), ["c"], "returning to the anchor leaves the anchor alone");
});

test("R7c-6 — anchor > endpoint works (dragging upward)", () => {
  const sel = selectionWithRange(drag(6), 2, IDS);
  assert.deepEqual([...sel].sort(), ["c", "d", "e", "f", "g"], "symmetric in either direction");
});

test("R7c-7 — baseline manual picks survive every recompute", () => {
  const d = drag(2, ["a", "h"]);
  assert.deepEqual([...selectionWithRange(d, 4, IDS)].sort(), ["a", "c", "d", "e", "h"],
    "manual picks outside the range stay");
  assert.deepEqual([...selectionWithRange(d, 2, IDS)].sort(), ["a", "c", "h"],
    "even collapsed back to the anchor");
  assert.deepEqual([...selectionWithRange(d, 6, IDS)].sort(), ["a", "c", "d", "e", "f", "g", "h"],
    "and inside the range they simply merge");
});

test("R7c-8 — a null endpoint keeps the anchor-only range", () => {
  assert.deepEqual([...selectionWithRange(drag(3), null, IDS)].sort(), ["d"],
    "whitespace right after the press still leaves the anchor selected");
});

test("R7c-9 — indexOfId and bounds clamp", () => {
  assert.equal(indexOfId(IDS, "e"), 4);
  assert.equal(indexOfId(IDS, "zz"), null);
  // Out-of-range endpoints clamp to the page, never throw.
  assert.deepEqual([...selectionWithRange(drag(0), 99, IDS)].sort(), IDS);
  assert.deepEqual([...selectionWithRange(drag(99), 0, IDS)].sort(), IDS);
});

// ---------------------------------------------------------------------------
// (2) the page wiring
// ---------------------------------------------------------------------------

test("R7c-10 — the page drives anchor/endpoint through the shared helper", () => {
  const lib = LIB();
  assert.match(lib, /const rangeDragRef = useRef<RangeDrag \| null>\(null\);/u, "the anchor state");
  assert.match(lib, /const endpointRef = useRef<number \| null>\(null\);/u, "the endpoint");
  assert.match(lib, /const orderedDesktopIds = useMemo\(/u, "the rendered order both indices address");
  // The long press anchors.
  const lp = lib.slice(lib.indexOf('onLongPress={domain === "desktop" && writeGranted ? (id) => {'));
  assert.match(lp.slice(0, 700), /rangeDragRef\.current = \{ anchorIndex: idx, baseline: selectedIds \};/u,
    "the press records anchor + baseline");
  assert.match(lp.slice(0, 700), /selectionWithRange\(\{ anchorIndex: idx, baseline: prev \}, idx, orderedDesktopIds\)/u,
    "and selects baseline ∪ [anchor]");
  // One selection path for live moves and auto-scroll ticks.
  const dp = lib.slice(lib.indexOf("const applyDragPoint = useCallback("));
  assert.match(dp.slice(0, 900), /if \(idx == null\) return;/u,
    "whitespace keeps the last valid endpoint");
  assert.match(dp.slice(0, 900), /selectionWithRange\(drag, idx, orderedDesktopIds\)/u,
    "every move RECOMPUTES the range");
  assert.match(lib, /dragAutoScrollRef\.current!\.update\(scroller, y, applyDragPoint, x\);/u,
    "the auto-scroll loop moves the endpoint through the SAME path");
  // Finger-up freezes.
  const de = lib.slice(lib.indexOf('onDragEnd={domain === "desktop" ? () => {'));
  assert.match(de.slice(0, 300), /rangeDragRef\.current = null;/u, "the drag freezes");
  assert.match(de.slice(0, 300), /dragAutoScrollRef\.current!\.stop\(\);/u, "and the scroll stops");
  assert.match(dp.slice(0, 900), /if \(!drag\) return; \/\/ the range is frozen/u,
    "a frozen drag ignores stray points");
});

test("R7c-11 — plain taps still toggle individually after the freeze", () => {
  const lib = LIB();
  const open = lib.slice(lib.indexOf('open={(_page, id) => {'));
  assert.match(open.slice(0, 400), /if \(selecting && domain === "desktop" && id\) \{/u,
    "the selection-mode tap intercept is unchanged");
  assert.match(open.slice(0, 400), /prev\.includes\(id\) \? prev\.filter\(\(x\) => x !== id\) : \[\.\.\.prev, id\]/u,
    "and still toggles exactly that asset");
});

test("R7c-12 — grid and list share the ONE range helper", () => {
  const range = RANGE();
  assert.match(range, /export function selectionWithRange\(/u, "one pure helper");
  assert.match(range, /export function indexOfId\(/u, "one index lookup");
  // No layout-specific selection math anywhere else.
  const tile = strip(read("src", "still", "kit", "mediaTile.tsx"));
  const row = ROWK();
  assert.doesNotMatch(tile, /selectionWithRange|slice\(.*Math\.min/u, "the tile does no range math");
  assert.doesNotMatch(row, /selectionWithRange|slice\(.*Math\.min/u, "nor does the row");
});
