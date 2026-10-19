// tests/uiPolishContract.test.ts — REAL-DEVICE-UI-POLISH-R1 deterministic
// guards for the real-device fixes beyond the safe area (covered separately
// in safeAreaAuthority.test.ts):
//   1. Local Note editor: no artificial fold spacer; actions in normal flow.
//   2. Desktop Note attachment toolbar: horizontal, 3 equal actions, 56px
//      targets, no vertical stack of full-width rows.
//   3. App-internal enumerations (folder/tag/…) use LuckyRay Sheets, not
//      system-styled <select> controls.
//   4. Desktop Materials has exactly ONE search owner: DesktopLibrary
//      consumes a `query` prop and renders no SearchField of its own.
//   5. Search focus is a single :focus-within state on the outer well; the
//      inner input never paints a second outline; global :focus-visible for
//      real controls is preserved.
//   6. Asset details are media-first: two-state sheet + tap toggle +
//      overlayStack registration; images use object-fit: contain.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

const appCss = read("src", "app.css");
const tokensCss = read("src", "design", "tokens.css");
const noteEditor = read("src", "screens", "NoteEditor.tsx");
const desktopNoteEditor = read("src", "screens", "DesktopNoteEditor.tsx");
const desktopLibrary = read("src", "components", "DesktopLibrary.tsx");
const library = read("src", "screens", "Library.tsx");
const mediaFirst = read("src", "components", "MediaFirstDetail.tsx");
const localAssetDetail = read("src", "screens", "LocalAssetDetail.tsx");
const assetDetail = read("src", "screens", "AssetDetail.tsx");

test("local note — no artificial fold spacer; secondary actions flow normally", () => {
  assert.doesNotMatch(tokensCss, /--fold-pad-note/, "fold token removed");
  assert.doesNotMatch(appCss, /\.note-actions-fold/, "fold spacer class removed");
  assert.match(appCss, /\.note-actions\s*\{[^}]*margin-top:\s*18px/, "compact action area follows the body");
  assert.match(noteEditor, /className="note-actions"/, "NoteEditor renders the flowing action area");
  // Every capability stays reachable in normal flow.
  for (const marker of ["toggleLocalPin", "toggleLocalFavorite", "toggleLocalArchived", "deleteLocalNote", "addTag", "handleManualSave"]) {
    assert.ok(noteEditor.includes(marker), `${marker} retained`);
  }
  // Guard against ANY viewport-derived giant spacer before the actions.
  for (const m of appCss.matchAll(/\.note-actions[^{]*\{([^}]*)\}/g)) {
    assert.doesNotMatch(m[1], /padding-top\s*:\s*(calc|clamp|\d{3,}px)/);
  }
});

test("desktop note — attachments render as ONE horizontal toolbar", () => {
  assert.match(desktopNoteEditor, /className="attach-bar"/, "single attach-bar container");
  assert.match(desktopNoteEditor, /className="attach-action"/, "equal attach actions");
  assert.equal((desktopNoteEditor.match(/attach-action/g) || []).length, 3, "exactly three actions");
  assert.doesNotMatch(desktopNoteEditor, /className="attachment"/, "old vertical attachment rows removed");
  assert.match(appCss, /\.attach-bar\s*\{[\s\S]{0,120}?display:\s*flex/, "toolbar is flex (row)");
  assert.match(appCss, /\.attach-action\s*\{[\s\S]{0,160}?flex:\s*1[\s\S]{0,160}?min-height:\s*56px/, ">=44px targets, no overflow at 320");
});

test("app-internal selectors — LuckyRay Sheet, not system <select>", () => {
  // Desktop materials folder/tag pickers must be Sheets with OptionRow.
  const stripComments = (s: string) =>
    s.replace(new RegExp("\\/\\*[\\s\\S]*?\\*\\/", "g"), "").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(stripComments(desktopLibrary), /<select/, "no system <select> in DesktopLibrary");
  // (the previous statement replaces the inline chained version)
  assert.match(desktopLibrary, /title="选择目录"[\s\S]{0,80}onClose/, "folder picker is a LuckyRay Sheet");
  assert.match(desktopLibrary, /title="选择标签"[\s\S]{0,80}onClose/, "tag picker is a LuckyRay Sheet");
  // Repo-wide: no new system <select> may appear in screens/components except
  // none are currently legitimate (file/photo pickers are native via Tauri).
  for (const f of ["screens/Library.tsx", "screens/Knowledge.tsx", "screens/Settings.tsx", "screens/Capture.tsx"]) {
    const src = read("src", f);
    assert.doesNotMatch(src, /<select/, `${f} uses app Sheets, not <select>`);
  }
});

test("desktop materials — exactly ONE search owner (Library root)", () => {
  // DesktopLibrary must not render a search field; it consumes `query`.
  assert.doesNotMatch(desktopLibrary, /SearchField/, "no second search field in DesktopLibrary");
  assert.match(desktopLibrary, /query:\s*string/, "DesktopLibrary accepts a query prop");
  assert.match(desktopLibrary, /const q = query;/, "internal query is the consumed prop");
  // The Library root still owns the one search field and passes the query down.
  assert.match(library, /query=\{search\}/, "Library passes its query to DesktopLibrary");
  const toolRow = desktopLibrary.match(/<div className="chip-scroll desktop-tools"[^>]*>[\s\S]{0,1400}?<\/div>/);
  assert.ok(toolRow, "desktop tools row exists (chips-only, one row)");
  assert.doesNotMatch(toolRow[0], /SearchField|<input/, "desktop tools row has no search input");
});

test("search focus — single :focus-within state; accessibility rings preserved", () => {
  assert.match(appCss, /\.search:focus-within\s*\{\s*border-color:\s*var\(--accent\)/, "outer well carries the focus state");
  assert.match(appCss, /\.search input:focus-visible,\s*\.search input:focus\s*\{\s*outline:\s*none/, "inner input paints no second outline");
  // Global focus-visible ring for real controls must still exist.
  assert.match(appCss, /button:focus-visible,\s*input:focus-visible,\s*textarea:focus-visible,\s*select:focus-visible\s*\{\s*outline:\s*2px solid var\(--accent\)/);
});

test("asset detail — media-first two-state contract", () => {
  // Shared component: two states, tap toggle, drag threshold, overlay registration.
  assert.match(mediaFirst, /data-state=\{expanded \? "expanded" : "collapsed"\}/, "two discrete states");
  assert.match(mediaFirst, /detail-sheet-handle/, "handle exists");
  assert.match(mediaFirst, /aria-expanded=\{expanded\}/, "handle exposes aria-expanded");
  assert.match(mediaFirst, /onClick=\{toggle\}/, "handle is a TAP toggle (not gesture-only)");
  assert.match(mediaFirst, /dy < -24/, "upward drag threshold expands");
  assert.match(mediaFirst, /dy > 24/, "downward drag threshold collapses");
  assert.match(mediaFirst, /overlayStack\.push\(\(\) => setExpanded\(false\)\)/, "expanded sheet registers Back-collapse");
  // Media stage: full-image contain, sheet never position:fixed (WebView 83).
  assert.match(appCss, /\.media-stage img\s*\{[^}]*object-fit:\s*contain/, "images shown whole (contain)");
  assert.doesNotMatch(appCss, /\.detail-sheet\s*\{[^}]*position:\s*fixed/, "detail sheet never fixed");
  assert.match(appCss, /\.detail-sheet\s*\{[^}]*position:\s*absolute/, "detail sheet anchored inside the shell");
  // Both surfaces adopted the layout.
  assert.match(localAssetDetail, /MediaFirstLayout/, "Local asset detail is media-first");
  assert.match(assetDetail, /MediaFirstLayout/, "Desktop asset detail is media-first");
});
