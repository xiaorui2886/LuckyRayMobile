// tests/stillUserQaFixContract.test.ts — STILL-01.1-USER-QA-FIX-R1 guards.
//
// 1–3  IME closed → dock restores (one-bit viewport lifecycle signal),
//      input may keep focus, re-tap re-enters text-entry;
// 4–5  sheet drag dismiss decisions (long drag dismisses, short drag springs);
// 6–8  grip tap / backdrop / Android Back dismissal paths;
// 9–13 browse ≠ import on both sources, real local filter changes,
//      real Desktop folder/tag request axes, no state leak across switch;
// 14   the asset-info engineering copy is gone.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dragDismissDecision } from "../src/still/kit/sheetDrag.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

const appTsx = read("src", "App.tsx");
const shellTsx = read("src", "still", "StillShell.tsx");
const kitSheet = read("src", "still", "kit", "Sheet.tsx");
const libraryTsx = read("src", "still", "StillLibrary.tsx");
const assetTsx = read("src", "still", "StillAsset.tsx");

// ---- 1–3. IME → dock recovery ----------------------------------------------
test("qa fix — IME close restores the dock via a one-bit viewport signal", () => {
  assert.match(appTsx, /onViewportResize/, "viewport resize lifecycle listener exists");
  assert.match(appTsx, /else if \(h >= closedViewportHeight - 60\) \{\r?\n\s*closedViewportHeight = h;\r?\n\s*setEditingText\(false\);/,
    "returning to the stable closed height clears the editing flag");
  assert.match(appTsx, /closedViewportHeight = h;/, "hysteresis anchor re-arms");
  assert.match(appTsx, /window\.visualViewport\?\.addEventListener\("resize", onViewportResize\)/,
    "visualViewport used as the lifecycle signal");
  assert.doesNotMatch(appTsx, /--ime-inset/, "still no second IME geometry authority");
  assert.doesNotMatch(appTsx, /keyboardHeight|imeHeight/i, "no keyboard-height math");
  assert.doesNotMatch(appTsx, /paddingBottom|\.padding\s*=/, "viewport signal never writes geometry");
});

test("qa fix — the input keeps focus and can re-enter text-entry", () => {
  assert.doesNotMatch(appTsx, /activeElement\.blur\(\)/, "restore never blurs the focused input");
  assert.match(appTsx, /const onFocusIn = \(e: FocusEvent\)/, "focusin still starts a text-entry session");
  assert.match(shellTsx, /data-text-entry=\{editingText \? "true" : undefined\}/,
    "the flag still reaches the Still shell");
});

test("qa fix — re-tapping an already-focused input hides the dock again", () => {
  // Tapping a focused input fires no focusin, so the keyboard-OPENING viewport
  // shrink must enter the text-entry state by itself (reading — not writing —
  // the focused element).
  assert.match(appTsx, /if \(h < closedViewportHeight - 60\)/, "shrink branch (keyboard opening) exists");
  assert.match(appTsx, /if \(h < closedViewportHeight - 60\) \{[\s\S]*?setEditingText\(true\);/,
    "shrink re-enters the text-entry state");
  assert.match(appTsx, /closedViewportHeight/, "hysteresis anchor present (IME overshoot bounce cannot un-hide)");
  assert.match(appTsx, /a instanceof HTMLInputElement \|\| a instanceof HTMLTextAreaElement/,
    "shrink branch confirms a real text session before hiding");
});

// ---- 4–5. drag decisions ------------------------------------------------------
test("qa fix — long drag dismisses, short drag springs back", () => {
  assert.equal(dragDismissDecision(300, 500), "dismiss", "long drag dismisses");
  assert.equal(dragDismissDecision(300, 80), "dismiss", "long fast drag dismisses");
  assert.equal(dragDismissDecision(40, 300), "spring-back", "short slow drag springs back");
  assert.equal(dragDismissDecision(30, 40), "dismiss", "short flick above velocity dismisses");
  assert.equal(dragDismissDecision(40, 300, true), "spring-back", "cancelled short drag never closes");
  assert.equal(dragDismissDecision(300, 500, true), "dismiss", "cancelled long drag still dismisses");
});

test("qa fix — compat sheet tracks the gesture without setPointerCapture", () => {
  assert.match(kitSheet, /window\.addEventListener\("pointermove", onPointerMove\)/,
    "move tracking is capture-independent");
  assert.match(kitSheet, /window\.addEventListener\("pointerup", onPointerUp\)/,
    "pointerup is tracked on window");
  assert.match(kitSheet, /stops WebView scroll\/overscroll arbitration/,
    "touchmove arbitration lock documented");
  assert.match(kitSheet, /if \(start\.current\) e\.preventDefault\(\)/,
    "non-passive touchmove blocker engages during the drag");
  assert.match(kitSheet, /if \(dragDismissDecision\(Math\.max\(0, dy\), dt\) === "dismiss"\) close\(\); else setDrag\(0\);/,
    "pointerup uses the shared decision");
  assert.doesNotMatch(kitSheet, /\.setPointerCapture\(/, "no pointer-capture call");
  assert.match(kitSheet, /function close\(\) \{\s*\n\s*if \(busyRef\.current \|\| closing\.current\) return;/,
    "busy lock + single-flight close");
  assert.match(kitSheet, /const release = registerDismiss\?\.\(close\);/, "joins overlayStack Back chain");
  const authority = read("src", "presentation", "still01", "Still.tsx");
  assert.doesNotMatch(authority, /compat drag transport/i, "authority Sheet source not modified");
});

// ---- 6–8. tap / backdrop / Back dismissal -------------------------------------
test("qa fix — grip tap, backdrop and Back all dismiss through one close path", () => {
  assert.match(kitSheet, /onClick=\{\(\) => \{ if \(!suppressClick\.current\) close\(\); \}\}/,
    "grip tap dismisses (drag never synthesizes a second close)");
  assert.match(kitSheet, /<div className="st-scrim" onClick=\{close\}/, "backdrop dismisses");
  assert.match(appTsx, /if \(overlayStack\.dismissTop\(\)\) return;/, "Android Back dismisses the top overlay");
});

// ---- 9–13. browse ≠ import -----------------------------------------------------
test("qa fix — library browse and import are two states, two sheets", () => {
  assert.match(libraryTsx, /const \[browseOpen, setBrowseOpen\] = useState\(false\);/, "browse state exists");
  assert.match(libraryTsx, /const \[importOpen, setImportOpen\] = useState\(false\);/, "import state exists");
  assert.match(libraryTsx, /onNew=\{\(\) => setImportOpen\(true\)\}/, "plus opens import");
  assert.match(libraryTsx, /onBrowse=\{\(\) => setBrowseOpen\(true\)\}/, "folder opens browse");
  assert.match(libraryTsx, /title="浏览本机素材"/, "local browse sheet title");
  assert.match(libraryTsx, /title="目录与标签"/, "desktop browse sheet title");
  assert.match(libraryTsx, /title="导入到本机"/, "import sheet title");
  assert.doesNotMatch(libraryTsx, /onBrowse=\{\(\) => setImportOpen\(true\)\}/, "browse no longer opens import");
});

test("qa fix — local browse options really change the local filter", () => {
  assert.match(libraryTsx, /setApplied\(\{ \.\.\.applied, favoriteOnly: true, archivedOnly: false \}\)/,
    "收藏 commits the real filter state");
  assert.match(libraryTsx, /setApplied\(\{ \.\.\.applied, favoriteOnly: false, archivedOnly: true \}\)/,
    "归档 commits the real filter state");
  assert.match(libraryTsx, /favorite: applied\.favoriteOnly \? true : undefined/,
    "the pager request consumes the flag");
  assert.match(libraryTsx, /archived: applied\.archivedOnly \? true : false/,
    "the pager request consumes the archive flag");
});

test("qa fix — desktop browse drives real folder/tag request axes", () => {
  // The navigation read is owner-bound (SOURCE-OWNER-R2), not anonymous.
  assert.match(libraryTsx, /api\.contentNavigation\(committedDesktopOwner\)/,
    "reads the real Desktop navigation authority for the owning Desktop");
  // REPAIR-R5: the axes are built once, by DESKTOP_SOURCE, and flow into the
  // authority's fetch — so the request still carries the selected axes.
  assert.match(libraryTsx, /const DESKTOP_SOURCE = \(\) => \(\{/,
    "the Desktop request axes are built in one place");
  assert.match(libraryTsx, /query: desktopQuery\.trim\(\), folder: desktopFolder \|\| "", tag: desktopTag \|\| "",\s*kind:\s*desktopKind/,
    "carrying the selected folder and tag");
  assert.match(libraryTsx, /folder: source\.folder \|\| undefined, tag: source\.tag \|\| undefined/,
    "contentAssets request carries the selected axes");
  // The request is re-issued for the browse axes AND for the Desktop instance
  // that owns the page, so a Desktop switch (or an axis change) never leaves
  // A's rows under B.
  assert.match(
    libraryTsx,
    /\}, \[desktopAuthority, desktopQuery, desktopFolder, desktopTag,\s*desktopKind\]\);/,
    "the identity effect depends on the browse axes",
  );
  assert.match(
    libraryTsx,
    /\}, \[desktopAuthority, conn\?\.paired, desktopOwner\]\);/,
    "and the owner bind depends on the owning Desktop",
  );
  assert.match(libraryTsx, /\}, \[desktopAuthority, version\]\);/,
    "with the Desktop-domain store events on their own revalidate path",
  );
});

test("qa fix — source switch never leaks browse state", () => {
  // #97 retains each source's context, rather than destroying Desktop axes
  // during a Local visit. The Local request must never consume those axes.
  assert.match(libraryTsx, /useEffect\(\(\) => \{\s*setBrowseOpen\(false\);\s*\}, \[domain\]\);/,
    "switching 本机↔电脑 closes only the source-specific sheet");
  const local = libraryTsx.slice(libraryTsx.indexOf("const localFilters ="), libraryTsx.indexOf("});", libraryTsx.indexOf("const localFilters =")) + 3);
  assert.match(local, /q: string = localQuery/,
    "Local requests consume only their own query context");
  assert.doesNotMatch(local, /desktopQuery|desktopFolder|desktopTag|desktopKind/,
    "retained Desktop browse axes cannot leak into Local requests");
});

test("qa fix — library view toggle reacts immediately (state, not raw storage)", () => {
  assert.match(libraryTsx, /const \[listPref, setListPref\] = useState\(\(\) => getLibraryView\(\) === "list"\);/,
    "the view mode is component state, seeded from the persisted preference");
  assert.match(libraryTsx, /onList=\{toggleListView\}/, "the toolbar toggle drives the state");
  assert.match(libraryTsx, /setLibraryView\(next \? "list" : "grid"\);\r?\n\s*setListPref\(next\);/,
    "each tap persists AND re-renders");
  // UX-POLISH-R1 3.1: the filter sheet no longer offers a view mode — the
  // toolbar is the ONLY owner, and a stale draft view can never reset a
  // toolbar-chosen list on apply.
  assert.doesNotMatch(libraryTsx, /setListPref\(v\.view === "list"\);/,
    "the filter sheet can no longer rewrite the toolbar-owned view");
  assert.doesNotMatch(libraryTsx, /label="网格视图"/, "no grid-view option in the sheet");
  assert.doesNotMatch(libraryTsx, /label="列表视图"/, "no list-view option in the sheet");
});

// ---- 14. engineering copy gone --------------------------------------------------
test("qa fix — asset info no longer shows the engineering note", () => {
  assert.doesNotMatch(assetTsx, /信息层与图片层分开/, "engineering copy removed from both info sheets");
});
