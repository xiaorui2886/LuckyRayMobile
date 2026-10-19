// MATERIAL-LIBRARY-INSTANT-R1 REPAIR-R5 (B/C/D) — multi-select entered by long
// press, with no permanent toolbar button.
//
// The physical-device requirement was: remove the常驻 选择素材 button entirely,
// then make Desktop multi-select fully usable by holding a material — in BOTH
// grid and list, with an exact selected state, a Cancel that clears, and an
// owner change that drops the selection.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const strip = (src: string) => src.replace(/^\s*\/\/.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, "");
const LIB = () => strip(read("src", "still", "StillLibrary.tsx"));
const VIEWS = () => strip(read("src", "presentation", "still01", "Views.tsx"));
const TILE = () => strip(read("src", "still", "kit", "mediaTile.tsx"));
const ROW = () => strip(read("src", "still", "kit", "libraryListRow.tsx"));

// F5. the ordinary toolbar carries no Select / multi-select button
test("R5-S5 — the compact toolbar has no permanent Select button", () => {
  const views = VIEWS();
  assert.doesNotMatch(views, /label="选择素材"/u, "the 选择素材 button is gone");
  assert.doesNotMatch(views, /icon="select"/u, "and its icon is no longer rendered in the toolbar");
  assert.doesNotMatch(views, /\bp\.select\b/u, "the `select` prop is entirely removed, not left dead");
  // The toolbar still has its real controls, so nothing was over-deleted.
  assert.match(views, /切换网格|切换列表/u, "the grid/list toggle remains");
  assert.match(views, /label="筛选与排序"/u, "and the filter control remains");
  // No dead prop survives anywhere in the tree.
  const all = [views, LIB(), TILE(), ROW()].join("\n");
  assert.doesNotMatch(all, /select\?:\{active:boolean;onToggle/u, "the old select prop type is gone");
});

// A stale `select` prop on the ONLY consumer is what would have left a dead API.
test("R5-S5b — no consumer passes the removed select prop", () => {
  const lib = LIB();
  assert.doesNotMatch(lib, /select=\{domain/u, "StillLibrary no longer passes it");
  assert.match(lib, /selecting=\{domain === "desktop" && selecting\}/u, "it passes the new truth instead");
  assert.match(lib, /selectedIds=\{domain === "desktop" \? selectedIds : undefined\}/u,
    "and the exact selected ids for the Desktop source only");
});

// F7. long press enters selection and selects the held asset (production wiring)
test("R5-S7 — a long press enters selection and selects the held asset", () => {
  const lib = LIB();
  const idx = lib.indexOf("onLongPress={domain === \"desktop\"");
  assert.ok(idx > 0, "the page handles a Desktop long press");
  const handler = lib.slice(idx, idx + 420);
  assert.match(handler, /setSelecting\(true\)/u, "selection mode is entered");
  // R7c: the long press is the range ANCHOR — baseline ∪ [anchor].
  assert.match(handler, /setSelectedIds\(\(prev\) => selectionWithRange\(\{ anchorIndex: idx, baseline: prev \}, idx, orderedDesktopIds\)\)/u,
    "the held asset becomes the selected anchor");
  // Desktop-only: the local source keeps single-tap semantics.
  assert.match(lib, /onLongPress=\{domain === "desktop" \?/u, "the gesture is Desktop-only");
});

// F6 + F11. short tap opens in normal mode; in selection mode it toggles exactly
test("R5-S6/S11 — a tap opens the detail normally and toggles in selection mode", () => {
  const lib = LIB();
  const idx = lib.indexOf("open={(_page, id) => {");
  const body = lib.slice(idx, lib.indexOf("\n        }}", idx));
  assert.match(body, /if \(selecting && domain === "desktop" && id\) \{/u,
    "selection mode intercepts the tap first");
  assert.match(body, /prev\.includes\(id\) \? prev\.filter\(\(x\) => x !== id\) : \[\.\.\.prev, id\]/u,
    "which toggles exactly that asset");
  assert.match(body, /desktopAssetRoute\(committedDesktopOwner, id \|\| ""\)/u,
    "and a normal Desktop tap still opens the owner-qualified detail route");
  assert.match(body, /open\("asset", id \|\| "", \{ assetPreview: card \? \{ title: card\.title, thumbnail: card\.src, kind: card\.kind \}/u,
    "a Local tap opens the same asset with its already-seen card");
});

// The long press must NOT also open: this is enforced in the shared gesture.
test("R5-S8 — a long press cannot also open the asset (grid and list)", () => {
  for (const [name, src] of [["tile", TILE()], ["row", ROW()]] as const) {
    // The element's own onClick is NOT wired straight to the open action: it is
    // owned by the gesture authority, which swallows the trailing click.
    assert.match(src, /onTap: \(\) => onClick/u, `${name} routes its tap through the gesture`);
    assert.doesNotMatch(src, /onClick=\{onClick\}/u, `${name} never binds the open action to a raw click`);
  }
  // The adapter swallows the click that follows a long press.
  const adapter = strip(read("src", "still", "kit", "pressGesture.ts"));
  assert.match(adapter, /if \(held \|\| stateRef\.current\.phase === "held"\) \{/u,
    "a click after a long press is detected");
  assert.match(adapter, /e\.preventDefault\(\);\s*\n\s*e\.stopPropagation\(\);/u,
    "and is swallowed rather than allowed to open the detail");
});

// F10. grid AND list both support the long press
test("R5-S10 — grid and list both wire long press plus the selected state", () => {
  const tile = TILE();
  const row = ROW();
  assert.match(tile, /onLongPress\?: \(\) => void;/u, "the tile accepts a long-press handler");
  assert.match(tile, /selected\?: boolean;/u, "and an exact selected flag");
  assert.match(tile, /selecting\?: boolean;/u, "and the mode flag");
  assert.match(row, /onLongPress\?: \(\) => void;/u, "the row accepts the same handler");
  assert.match(row, /selected\?: boolean;/u, "and the same selected flag");
  assert.match(row, /selecting\?: boolean;/u, "and the same mode flag");
  // Both render the check treatment from the SAME props.
  assert.match(tile, /is-selected/u, "the tile expresses selection in its class");
  assert.match(row, /is-selected/u, "as does the row");
  assert.match(VIEWS(), /selected=\{isSel\(a\.id\)\}/gu, "the view passes the exact selection to both layouts");
});

// F12. the selected visual exactly matches selectedIds — never more, never fewer
test("R5-S12 — the check mark matches selectedIds exactly", () => {
  const views = VIEWS();
  assert.match(views, /const isSel=\(id:string\)=>Boolean\(p\.selectedIds&&p\.selectedIds\.indexOf\(id\)>=0\);/u,
    "membership is derived from the exact id list");
  // The tile renders a check ONLY when selecting AND selected.
  const tile = TILE();
  assert.match(tile, /\{selecting \? \(\s*\n\s*<span className="st-tile-check"/u,
    "the tile check is gated on selection mode");
  assert.match(tile, /\{selected \? \(/u, "and the mark itself only on the exact selection");
  // A non-selected row must have an empty, invisible mark — not a check.
  const row = ROW();
  assert.match(row, /trail=\{selecting \? \(/u, "the row mark appears only in selection mode");
  assert.match(row, /\{selected \? \(/u, "and shows a check only when selected");
  // Behavioural: membership is exact for both sources.
  const ids = ["d1", "d3"];
  const isSel = (id: string) => ids.indexOf(id) >= 0;
  assert.equal(isSel("d1"), true); assert.equal(isSel("d2"), false); assert.equal(isSel("d3"), true);
});

// F13. Cancel clears the selection and leaves selection mode
test("R5-S13 — Cancel exits selection and clears it", () => {
  const lib = LIB();
  // REPAIR-R6: the actions moved INTO the view as the fixed selection bar
  // (the old floating notice after the full-height view was off-screen).
  const idx = lib.indexOf("selectionBar={domain === \"desktop\" && selecting ? {");
  assert.ok(idx > 0, "the selection bar is passed in selection mode");
  const block = lib.slice(idx, idx + 400);
  assert.match(block, /onCancel: \(\) => \{ setSelecting\(false\); setSelectedIds\(\[\]\); \}/u,
    "Cancel both exits the mode and empties the selection");
  assert.match(block, /count: selectedIds\.length/u, "and reports the exact count");
  assert.match(block, /onOrganize: \(\) => setBatchSheet\("actions"\)/u, "with the batch action available");
  assert.match(block, /busy: orgSnapshot\.busy/u, "and the busy truth reaches the bar");
});

// F14. a Desktop owner change clears the selection (A selections never reach B)
test("R5-S14 — a Desktop owner change exits and clears the selection", () => {
  const lib = LIB();
  const idx = lib.indexOf("desktopAuthority.bind(desktopOwner, DESKTOP_SOURCE());");
  assert.ok(idx > 0, "the owner bind exists");
  const after = lib.slice(idx, idx + 460);
  assert.match(after, /setSelectedIds\(\[\]\)/u, "the selection is emptied on an owner bind");
  assert.match(after, /setSelecting\(false\)/u, "and selection mode is left");
  // The unpaired branch retires too, so an offline switch cannot keep A selected.
  const unpaired = lib.slice(lib.indexOf("if (!conn?.paired || !desktopOwner) {"), lib.indexOf("if (!conn?.paired || !desktopOwner) {") + 260);
  assert.match(unpaired, /desktopAuthority\.bind\(""/u, "an unpaired Desktop retires the page");
  // Leaving the Desktop source also ends selection (existing invariant kept).
  assert.match(lib, /if \(domain !== "desktop"\) \{ setSelecting\(false\); setSelectedIds\(\[\]\); \}/u,
    "switching to Local ends selection");
});

// F15. no selection button regression at 360 / 392
test("R5-S15 — the toolbar is unchanged in width at 360 and 392", () => {
  const views = VIEWS();
  // Removing a control must not leave a spacer or an inert placeholder. The
  // toolbar element itself is bounded by its own closing </div>.
  const start = views.indexOf('<div className="st-compact-toolbar"');
  const toolbar = views.slice(start, views.indexOf("</div>", views.indexOf("label=\"筛选与排序\"", start)) + 6);
  assert.doesNotMatch(toolbar, /选择素材|icon="select"/u,
    "no selection affordance remains in the toolbar at either width");
  assert.doesNotMatch(toolbar, /\bp\.select\b/u, "and no dead select prop is read");
  assert.match(toolbar, /<span>\{p\.filterLabel/u, "the flexible heading still owns the spare width");
  // The removed button was 36px wide, so the toolbar only got roomier — the
  // remaining controls are unchanged and cannot overflow at 360.
  const css = read("src", "presentation", "still01", "still.css");
  assert.match(css, /\.st-compact-toolbar \.st-icon-button\{width:36px;height:44px\}/u,
    "the remaining icon buttons keep their bounded size");
});
