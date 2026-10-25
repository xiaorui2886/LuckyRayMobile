// MATERIAL-LIBRARY-INSTANT-R1 PHYSICAL-POLISH-R7 — rounded selection, lighter
// bar actions, drag-to-multi-select, selection-consumes-back, the restored
// 我的-page rhythm, and the cold-loading skeleton.

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
const VIEWS = () => strip(read("src", "presentation", "still01", "Views.tsx"));
const LIB = () => strip(read("src", "still", "StillLibrary.tsx"));
const TILE = () => strip(read("src", "still", "kit", "mediaTile.tsx"));
const ROW = () => strip(read("src", "still", "kit", "libraryListRow.tsx"));
const ADAPTER = () => strip(read("src", "still", "kit", "pressGesture.ts"));
const CSS = () => read("src", "presentation", "still01", "still.css");
const APP = () => strip(read("src", "App.tsx"));

// ---------------------------------------------------------------------------
// A1 — the selected treatment follows the card's rounded corners
// ---------------------------------------------------------------------------

test("R7-A1 — the selected ring follows the art's border-radius", () => {
  const css = CSS();
  // `outline` does NOT follow border-radius before Chromium 94 — the MI 8's
  // WebView 83 rendered the selected art with four sharp corners. An inset
  // box-shadow follows the radius everywhere.
  assert.doesNotMatch(css, /\.st-media-tile\.is-selected \.st-media-art\{[^}]*outline/u,
    "no outline-based selection remains");
  const rule = css.slice(css.indexOf(".st-media-tile.is-selected .st-media-art{"));
  assert.match(rule.slice(0, rule.indexOf("}") + 1), /box-shadow:inset 0 0 0 2px var\(--st-action\)/u,
    "the selected ring is an inset shadow that follows the 10px radius");
  // The art itself keeps its radius and its crop (the standalone product tile
  // block, not the selected-state rule that also ends in .st-media-art{).
  const artAt = css.indexOf(".st-media-art{position:relative;aspect-ratio");
  const art = css.slice(artAt);
  assert.match(art.slice(0, art.indexOf("}") + 1), /border-radius:10px/u, "the art radius is unchanged");
  // The check badge survives.
  assert.match(css, /\.st-tile-check\{/u, "the check badge is kept");
  // The list never used an outline; its selected truth stays the check itself.
  assert.doesNotMatch(css, /\.is-selected[^{]*\{[^}]*outline/u, "no selection outline anywhere");
});

// ---------------------------------------------------------------------------
// A2 — the bar actions are visually secondary but stay tappable
// ---------------------------------------------------------------------------

test("R7-A2 — the bar actions are compact and light with a 44px target", () => {
  const css = CSS();
  const idx = css.indexOf(".st-select-bar .st-select-cancel,");
  assert.ok(idx > 0, "the dedicated compact action classes exist");
  const rule = css.slice(idx, css.indexOf("}", idx) + 1);
  assert.match(rule, /min-height:44px/u, "the tap target stays a full 44px");
  assert.match(rule, /font-size:12px/u, "the labels are compact, not 14px primary weight");
  assert.match(rule, /padding:0 12px/u, "with restrained horizontal padding");
  const cancel = css.slice(css.indexOf(".st-select-bar .st-select-cancel{"));
  assert.match(cancel.slice(0, cancel.indexOf("}") + 1), /background:transparent/u,
    "取消 reads as a quiet secondary action");
  const views = VIEWS();
  assert.doesNotMatch(views, /st-button st-button--quiet st-select-cancel/u,
    "the heavy primary st-button classes are no longer reused in the bar");
  // The count still reads clearly.
  assert.match(css, /\.st-select-bar \.st-select-count\{[^}]*font-size:12px/u, "已选择 N 项 stays legible");
});

// ---------------------------------------------------------------------------
// B1/B2 — hold, then sweep: drag-to-multi-select
// ---------------------------------------------------------------------------

test("R7-B1 — held-phase moves are reported; the gesture stays ONE authority", () => {
  const adapter = ADAPTER();
  // The option exists and is read through a ref (stable handlers).
  assert.match(adapter, /onDragSelect\?: \(x: number, y: number\) => void;/u, "the adapter takes the callback");
  assert.match(adapter, /dragSelectRef\.current\?\.\(e\.clientX, e\.clientY\)/u,
    "pointer moves during the held phase report their coordinates");
  assert.match(adapter, /dragSelectRef\.current\?\.\(t\.clientX, t\.clientY\)/u,
    "and so does the old-WebView touch fallback");
  // It is reported ONLY while held — the guard is on the phase.
  const guard = adapter.slice(adapter.indexOf("onPointerMove = useCallback("));
  assert.match(guard.slice(0, 520), /if \(stateRef\.current\.phase === "held"\) \{/u,
    "moves report only after the long press latched");
  // The reducer keeps `held` through moves — the state that makes this safe.
  let state = initialPressState();
  state = reducePress(state, { type: "down", x: 1, y: 1 }, DEFAULT_PRESS_CONFIG).state;
  state = reducePress(state, { type: "timeout" }, DEFAULT_PRESS_CONFIG).state;
  const moved = reducePress(state, { type: "move", x: 40, y: 90 }, DEFAULT_PRESS_CONFIG);
  assert.equal(moved.state.phase, "held", "a held press stays held while sweeping");
  assert.equal(moved.effect.type, "none", "and the move itself neither arms nor cancels");
});

test("R7-B1b — the page hit-tests the finger and RECOMPUTES the range (R7c)", () => {
  const lib = LIB();
  const idx = lib.indexOf("const applyDragPoint = useCallback(");
  assert.ok(idx > 0, "the page has ONE drag point applier");
  const body = lib.slice(idx, idx + 900);
  assert.match(body, /if \(!selecting\) return;/u, "only in selection mode");
  assert.match(body, /document\.elementFromPoint\(x, y\)/u, "hit-testing the finger's position");
  assert.match(body, /closest\("\[data-asset-id\]"\)/u, "against the nearest tile");
  assert.match(body, /if \(idx == null\) return;/u, "whitespace keeps the last valid endpoint");
  assert.match(body, /selectionWithRange\(drag, idx, orderedDesktopIds\)/u,
    "every move RECOMPUTES anchor..endpoint — never a permanent append");
  assert.doesNotMatch(body, /open\(/u, "a drag NEVER opens a detail");
  // Tiles expose the hit-test attribute in BOTH layouts.
  assert.match(TILE(), /data-asset-id=\{assetId\}/u, "the grid tile carries data-asset-id");
  assert.match(ROW(), /data-asset-id=\{assetId\}/u, "and so does the list wrapper");
  // And the view forwards the shared handler to both.
  const views = VIEWS();
  assert.match(views, /onDragSelect=\{p\.onDragSelect\}/u, "the view forwards the handler");
});

test("R7-B2 — the first successful sweep shows ONE quiet hint (R7c range form)", () => {
  const lib = LIB();
  assert.match(lib, /let dragSelectHintShown = false;/u, "a module-level once-per-session latch");
  const idx = lib.indexOf("dragSelectHintShown = true;");
  const guard = lib.slice(idx - 320, idx + 140);
  assert.match(guard, /if \(!dragSelectHintShown && next\.length > drag\.baseline\.length \+ 1\)/u,
    "only when the range actually grows past the anchor");
  assert.match(guard, /toast\.info\("继续滑动可多选"\)/u, "with the quiet hint copy");
});

// ---------------------------------------------------------------------------
// 三 — selection mode consumes BACK
// ---------------------------------------------------------------------------

test("R7-BACK — an active selection consumes BACK before any navigation", () => {
  const app = APP();
  const idx = app.indexOf('new Event("luckyray:selection-back", {cancelable: true})');
  assert.ok(idx > 0, "the back pipeline dispatches the selection event");
  const stmt = app.slice(app.lastIndexOf("if (!window.dispatchEvent", idx), idx + 120);
  assert.match(stmt, /\)\)\) return;/u, "a prevented event stops the pipeline");
  const before = app.slice(app.indexOf("onBackButtonPress(() => {"), idx);
  const overlayAt = before.indexOf("overlayStack.dismissTop()");
  const noteAt = before.indexOf("luckyray:desktop-note-back");
  // A note listener cancels BACK and starts navigation even in reading mode.
  // An open image preview must dismiss before that listener is dispatched.
  assert.ok(overlayAt >= 0 && noteAt > overlayAt && noteAt < before.length,
    "an overlay dismisses before the note guard; both precede selection and navigation");
  const noteStmt = before.slice(before.lastIndexOf("if (!window.dispatchEvent", noteAt), noteAt + 120);
  assert.match(noteStmt, /\)\)\) return;/u,
    "with no overlay a prevented note event still blocks navigation until its save guard settles");
  assert.ok(overlayAt < idx, "selection-back is consulted AFTER overlays (an open sheet still closes first)");

  const lib = LIB();
  const li = lib.indexOf('"luckyray:selection-back"');
  assert.ok(li > 0, "the library listens for the event");
  const body = lib.slice(li - 400, li + 400);
  assert.match(body, /if \(!selecting \|\| !active\) return;/u,
    "without a selection, or while the retained root is hidden, BACK is not consumed");
  assert.match(body, /e\.preventDefault\(\);/u, "with one, the navigation is cancelled");
  assert.match(body, /setSelecting\(false\);\s*\n\s*setSelectedIds\(\[\]\);/u,
    "and the mode plus the ids are cleared");
});

// ---------------------------------------------------------------------------
// 四 — the 我的 page rhythm
// ---------------------------------------------------------------------------

test("R7-MYPAGE — settings rows ride the design's shared Row (R7b reverted the 54px override)", () => {
  const css = CSS();
  // R7b: the original design package is the authority — its settings page uses
  // the shared 65px Row (the 54px .st-option rule styles components the page
  // does not use). No scoped settings-row rule may exist.
  assert.doesNotMatch(css, /\.st-setting-section \.st-row\{/u,
    "no scoped settings-row override exists");
  // The page structure and items are unchanged.
  const views = VIEWS();
  for (const item of ["连接电脑", "外观", "存储与数据", "收集箱", "连接诊断", "恢复与修复"]) {
    assert.ok(views.includes(`>${item}</`) || views.includes(`label="${item}"`) || views.includes(item),
      `${item} is still present`);
  }
  assert.match(views, /SectionTitle>偏好</u, "the 偏好 group is intact");
  assert.match(views, /SectionTitle>内容与支持</u, "and the 内容与支持 group too");
  // The general content row keeps its own height (other pages unaffected).
  const general = css.slice(css.indexOf(".st-row{"));
  assert.match(general.slice(0, general.indexOf("}") + 1), /min-height:65px/u,
    "the shared Row height is untouched");
});


// ---------------------------------------------------------------------------
// 五 — the cold-loading skeleton
// ---------------------------------------------------------------------------

test("R7-LOADING — cold loading shows skeletons; retained refresh never does", () => {
  const views = VIEWS();
  // The cold branch is gated on coldLoading, and sits AFTER the retained
  // branch — retained rows can never be blanked into a skeleton.
  const retainedAt = views.indexOf('p.retained?(<Empty title="正在同步…"');
  const coldAt = views.indexOf("p.coldLoading?(");
  assert.ok(retainedAt > 0 && coldAt > retainedAt, "retained wins over cold in the render order");
  assert.match(views, /st-loading-block/u, "the skeleton block exists");
  assert.match(views, /正在从电脑读取素材/u, "with the restrained caption");
  assert.match(views, /\[0,1,2,3,4,5\]\.map\(i=><div className="st-skel-card"/u,
    "the grid renders six skeleton cards");
  assert.match(views, /\[0,1,2,3,4,5,6,7\]\.map\(i=><div className="st-skel-row"/u,
    "the list renders eight skeleton rows");
  const css = CSS();
  assert.match(css, /\.st-skel-art\{[^}]*border-radius:10px/u, "skeleton cards share the tile radius");
  assert.match(css, /@keyframes st-skel-pulse/u, "a quiet pulse");
  assert.match(css, /prefers-reduced-motion:reduce\)\{[^}]*animation:none/u, "disabled under reduced motion");
  // No <img> is involved — nothing can render a broken glyph.
  const block = views.slice(views.indexOf('className="st-loading-block"'), views.indexOf("没有找到素材"));
  assert.doesNotMatch(block, /<img/u, "the skeleton uses no images at all");
});
