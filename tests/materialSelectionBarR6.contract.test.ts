// MATERIAL-LIBRARY-INSTANT-R1 REPAIR-R6 (1/2) — the selection action bar must
// be VISIBLE, and real thumbnails must not swallow the long press.
//
// (1) The old floating notice rendered after the full-height CollectionView,
//     which put 已选择 N 项 / 取消 / 整理所选 off-screen on the device: the
//     check marks appeared but the actions were unreachable. The bar now lives
//     INSIDE the view, fixed between the search field and the scroll region.
// (2) On old WebViews a long press on a real <img> is intercepted by the
//     browser's own image behaviour (drag ghost / copy-image callout), which is
//     why image and video tiles could not enter multi-select while document
//     placeholders could. The thumbnail is now a purely visual layer.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const strip = (src: string) => src.replace(/^\s*\/\/.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, "");
const VIEWS = () => strip(read("src", "presentation", "still01", "Views.tsx"));
const LIB = () => strip(read("src", "still", "StillLibrary.tsx"));
const TILE = () => strip(read("src", "still", "kit", "mediaTile.tsx"));
const ROW = () => strip(read("src", "still", "kit", "libraryListRow.tsx"));
const CSS = () => read("src", "presentation", "still01", "still.css");

// ---------------------------------------------------------------------------
// (1) the fixed selection action bar
// ---------------------------------------------------------------------------

test("R6-S1 — the bar renders INSIDE the view, between search and scroll", () => {
  const views = VIEWS();
  const barIdx = views.indexOf('className="st-select-bar"');
  assert.ok(barIdx > 0, "the bar element exists");
  // Scope to the CollectionView region: earlier views also use .st-scroll.
  const fnStart = views.indexOf("export function CollectionView");
  const topIdx = views.indexOf('className="st-collection-top"', fnStart);
  const scrollIdx = views.indexOf('className="st-scroll"', topIdx);
  assert.ok(topIdx > fnStart && scrollIdx > topIdx, "the view layout anchors exist in CollectionView");
  assert.ok(topIdx < barIdx && barIdx < scrollIdx,
    "the bar sits AFTER the search field and BEFORE the scroll region (outside the scroller)");
});

test("R6-S2 — the bar shows count / 取消 / 整理所选 with exact semantics", () => {
  const views = VIEWS();
  const bar = views.slice(views.indexOf('className="st-select-bar"'), views.indexOf("</div>", views.indexOf("st-select-organize")) + 6);
  assert.match(bar, /已选择 \{p\.selectionBar\.count\} 项/u, "the exact count is shown");
  assert.match(bar, />取消</u, "the Cancel action");
  assert.match(bar, />整理所选</u, "the organize action");
  assert.match(bar, /disabled=\{p\.selectionBar\.count===0\|\|Boolean\(p\.selectionBar\.busy\)\}/u,
    "整理所选 is disabled at 0 items or while busy");
  assert.match(bar, /onClick=\{p\.selectionBar\.onCancel\}/u, "Cancel is wired to the page");
  assert.match(bar, /onClick=\{p\.selectionBar\.onOrganize\}/u, "and so is organize");
  assert.match(bar, /role="toolbar"/u, "the bar is a toolbar");
});

test("R6-S3 — the bar is fixed (flex:none), never scrolls, Cancel >= 44px", () => {
  const css = CSS();
  const rule = css.slice(css.indexOf(".st-select-bar{"));
  assert.match(rule.slice(0, rule.indexOf("}") + 1), /flex:none/u,
    "the bar does not flex with the scroller — it holds its place above it");
  // R7 A2: the actions moved from the heavy .st-button classes to dedicated
  // compact ones; the 44px target guarantee is unchanged.
  const cancel = css.slice(css.indexOf(".st-select-bar .st-select-cancel,"));
  assert.match(cancel.slice(0, cancel.indexOf("}") + 1), /min-height:44px/u,
    "every action in the bar, including 取消, keeps a 44px target");
  // The bar is inside .st-view (a column) above .st-scroll, and the scroller
  // owns the bottom padding — so the nav cannot cover the bar.
  const scroll = css.slice(css.indexOf(".st-scroll{"));
  assert.match(scroll.slice(0, scroll.indexOf("}") + 1), /flex:1/u, "the scroller still takes the remaining height");
});

test("R6-S4 — the old off-screen duplicate notice is gone", () => {
  const lib = LIB();
  assert.doesNotMatch(lib, /st-notice pending" role="status">[\s\S]{0,80}?已选择/u,
    "the floating notice after the CollectionView no longer exists");
  // The bar is passed instead.
  assert.match(lib, /selectionBar=\{domain === "desktop" && selecting \? \{/u,
    "the page drives the in-view bar from the real selection state");
  const block = lib.slice(lib.indexOf("selectionBar={domain === \"desktop\" && selecting ? {"));
  assert.match(block, /count: selectedIds\.length/u, "with the exact count");
  assert.match(block, /busy: orgSnapshot\.busy/u, "and the batch busy truth");
  assert.match(block, /onCancel: \(\) => \{ setSelecting\(false\); setSelectedIds\(\[\]\); \}/u,
    "Cancel clears BOTH the mode and the ids");
  assert.match(block, /onOrganize: \(\) => setBatchSheet\("actions"\)/u, "organize opens the batch sheet");
});

test("R6-S5 — normal mode is unchanged and no permanent select button returns", () => {
  const views = VIEWS();
  assert.match(views, /\{p\.selectionBar\?/u, "the bar renders ONLY when the page passes it");
  const lib = LIB();
  assert.match(lib, /selectionBar=\{domain === "desktop" && selecting \? \{/u,
    "and the page passes it only in Desktop selection mode");
  // The R5 no-button guarantee still holds.
  const rowStart = views.indexOf('<div className="st-compact-toolbar">');
  const filterAt = views.indexOf('label="筛选与排序"', rowStart);
  const toolbar = views.slice(rowStart, views.indexOf("</div>", filterAt) + 6);
  assert.doesNotMatch(toolbar, /选择素材|icon="select"/u, "no permanent select button in the toolbar");
});

// ---------------------------------------------------------------------------
// (2) the thumbnail is a purely visual layer
// ---------------------------------------------------------------------------

test("R6-T1 — the tile's <img> cannot start a drag or own the gesture", () => {
  const tile = TILE();
  const img = tile.slice(tile.indexOf("<img"), tile.indexOf("/>", tile.indexOf("<img")) + 2);
  assert.match(img, /draggable=\{false\}/u, "native drag is disabled");
  assert.match(img, /onDragStart=\{\(e\) => \{ e\.preventDefault\(\); \}\}/u,
    "and a drag start is prevented at the DOM level");
  assert.match(img, /onError=\{/u, "decode errors still surface (the retry path is untouched)");
  assert.match(img, /key=\{`attempt-/u, "the attempt generation still keys the element");
});

test("R6-T2 — CSS makes both thumbnail layers pointer-transparent", () => {
  const css = CSS();
  // The R6 block appends its own rules; anchor there (an earlier tile rule
  // also styles .st-media-art>img without these properties).
  const r6 = css.slice(css.indexOf("REPAIR-R6 — the thumbnail <img> is a purely VISUAL layer"));
  const art = r6.slice(r6.indexOf(".st-media-art>img{"));
  assert.match(art.slice(0, art.indexOf("}") + 1), /pointer-events:none/u, "grid art ignores pointers");
  assert.match(art.slice(0, art.indexOf("}") + 1), /-webkit-user-drag:none/u, "drag ghost suppressed");
  assert.match(art.slice(0, art.indexOf("}") + 1), /-webkit-touch-callout:none/u, "long-press callout suppressed");
  assert.match(art.slice(0, art.indexOf("}") + 1), /user-select:none/u, "and no text selection");
  const rowThumb = r6.slice(r6.indexOf(".st-row-thumb{"));
  assert.match(rowThumb.slice(0, rowThumb.indexOf("}") + 1), /pointer-events:none/u,
    "the LIST thumbnail is equally transparent");
  assert.match(rowThumb.slice(0, rowThumb.indexOf("}") + 1), /-webkit-touch-callout:none/u,
    "including the callout suppression");
});

test("R6-T3 — the parent tile/row owns the whole gesture in BOTH layouts", () => {
  const tile = TILE();
  const row = ROW();
  // The press handlers stay on the wrapping interactive element.
  assert.match(tile, /\{\.\.\.press\.handlers\}/u, "the grid tile spreads the gesture handlers");
  assert.match(row, /\{\.\.\.press\.handlers\}/u, "and so does the list wrapper");
  // Neither routes activation through a raw img-adjacent click.
  assert.doesNotMatch(tile, /onClick=\{onClick\}/u);
  assert.doesNotMatch(row, /onClick=\{onClick\}/u);
  // The SAME shared authority (not two implementations).
  assert.match(tile, /useLongPress\(/u);
  assert.match(row, /useLongPress\(/u);
  assert.doesNotMatch(tile, /setTimeout\(/u, "no private timer in the tile");
  assert.doesNotMatch(row, /setTimeout\(/u, "no private timer in the row");
});

// The document placeholder already long-pressed correctly — it must keep doing
// so, and all three kinds now behave identically because the gesture never
// depends on what is painted inside the art box.
test("R6-T4 — the gesture is art-agnostic (image/video/document identical)", () => {
  const tile = TILE();
  // The handlers are on the <button>, which wraps the art box regardless of
  // whether the art is an <img> or the placeholder span.
  const btnIdx = tile.indexOf('<button');
  const artIdx = tile.indexOf('className="st-media-art"');
  assert.ok(btnIdx > 0 && artIdx > btnIdx, "the art box is INSIDE the interactive element");
  assert.match(tile, /st-media-placeholder/u, "the placeholder art still exists for documents");
  // The shared reducer is unchanged: holding past the threshold still fires
  // longpress, a scroll still cancels (pinned by pressGesture.contract tests).
  const pure = strip(read("src", "still", "kit", "pressGesturePure.ts"));
  assert.match(pure, /export const LONG_PRESS_THRESHOLD = 500;/u, "the same 500ms threshold");
});
