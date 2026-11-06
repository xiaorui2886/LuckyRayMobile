// tests/interactionClosureContract.test.ts — INTERACTION-CLOSURE-R1 guards.
//
// Deterministic contracts for the real-device interaction fixes, beyond the
// behavioral FilterDraft tests (tests/filterDraft.test.ts):
//   1. page-level zoom locked (viewport meta + shell pinch blocker);
//   2. media zoom confined to the image layer (never shell/layout);
//   3. pushed screens preserve the initiating root (pushScreen contract);
//   4. Home root Back uses the Android task-back fallback (never close/exit);
//   5. Capture + Settings artificial folds are gone (no token, no class);
//   6. editor title/body have no focus box while the global a11y ring stays;
//   7. Desktop Materials stays single-search-owner with compact tool row;
//   8. root nav/FAB hide during text editing (presentation-only visibility).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NavigationController } from "../src/navigation.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const indexHtml = read("index.html");
const appTsx = read("src", "App.tsx");
const appCss = read("src", "app.css");
const tokensCss = read("src", "design", "tokens.css");
const navigationTs = read("src", "navigation.ts");
const mediaZoom = read("src", "components", "MediaZoomLayer.tsx");
const captureTsx = read("src", "screens", "Capture.tsx");
const settingsTsx = read("src", "screens", "Settings.tsx");
const desktopLibrary = read("src", "components", "DesktopLibrary.tsx");
const deviceKt = read("scripts", "android-src", "DeviceBridge.kt");
const mainKt = read("scripts", "android-src", "MainActivity.kt");
const clientTs = read("src", "services", "client.ts");
const rustDevice = read("src-tauri", "src", "device.rs");

// ---- 1. page-level zoom locked -------------------------------------------
test("interaction closure — page-level pinch zoom is locked", () => {
  assert.match(
    indexHtml,
    /<meta name="viewport" content="width=device-width, initial-scale=1\.0, maximum-scale=1\.0, user-scalable=no, viewport-fit=cover" \/>/,
    "viewport meta locks user scaling"
  );
  assert.match(appTsx, /data-media-zoom-layer/, "shell pinch blocker references the media opt-in");
  assert.match(appTsx, /addEventListener\("touchmove", blockShellPinch, \{ passive: false \}\)/, "blocker actively preventDefaults");
  assert.match(appTsx, /if \(target\?\.closest\("\[data-media-zoom-layer\]"\)\) return;/, "media layer is the ONLY pinch escape hatch");
});

// ---- 2. media zoom confined to the image layer ----------------------------
test("interaction closure — media zoom only ever transforms the image", () => {
  assert.match(mediaZoom, /data-media-zoom-layer/, "zoom layer is the marked escape hatch");
  assert.match(mediaZoom, /transform: `translate\(\$\{offset\.x\}px, \$\{offset\.y\}px\) scale\(\$\{scale\}\)`/, "transform lands on the img only");
  assert.match(mediaZoom, /MAX_SCALE = 4/, "zoom capped at 4x");
  assert.match(mediaZoom, /MIN_SCALE = 1/, "zoom floored at 1x");
  assert.match(mediaZoom, /clampOffset/, "pan is clamped");
  assert.match(mediaZoom, /useEffect\(\(\) => \{\s*\n\s*setScale\(1\);/, "state resets on source change/route exit");
  assert.doesNotMatch(appTsx, /app-shell[^}]*transform/i);
  assert.doesNotMatch(appCss, /\.media-first\s*\{[^}]*transform/);
});

// ---- 3. pushed screens preserve the initiating root ------------------------
test("interaction closure — pushScreen keeps the initiating root (behavior)", () => {
  for (const root of ["library", "knowledge", "settings", "ai", "home"] as const) {
    const nav = new NavigationController();
    nav.switchRoot(root);
    nav.pushScreen("capture");
    assert.deepEqual(nav.current(), { tab: "capture" });
    assert.equal(nav.goBack(), true);
    assert.deepEqual(nav.current(), { tab: root }, `Back from Capture must land on ${root}`);
  }
  const nav = new NavigationController();
  nav.switchRoot("library");
  nav.pushScreen("capture");
  nav.pushScreen("capture");
  nav.pushScreen("capture");
  assert.equal(nav.hasLayer(), true);
  nav.goBack();
  assert.equal(nav.hasLayer(), false, "stack stays [root, pushed] — bounded");
});

test("interaction closure — pushScreen source no longer forces [home, pushed]", () => {
  assert.doesNotMatch(navigationTs, /this\.stack = \[\{ tab: "home" \}, \{ tab \}\];/, "old forced-home push removed");
  assert.match(navigationTs, /const root = this\.stack\[0\]/, "pushScreen now rides on the initiating root");
});

// ---- 4. Home root Back = Android task fallback ------------------------------
test("interaction closure — Home root Back uses Android task-back, never close/exit", () => {
  assert.match(appTsx, /void api\.moveTaskToBack\(\);/, "root fallback backgrounds the task");
  assert.doesNotMatch(appTsx, /getCurrentWindow\(\)\.close\(\)/, "window.close removed (no-op on Android WebView)");
  assert.doesNotMatch(appTsx, /process\.exit|app\.exit/, "no hard exit");
  assert.match(clientTs, /moveTaskToBack: \(\) => invoke<boolean>\("move_task_to_back"\)/, "TS command wired");
  assert.match(rustDevice, /"moveTaskToBack", "\(\)V"/, "Rust reaches the Kotlin task-back");
  assert.match(deviceKt, /moveTaskToBack\(true\)/, "Kotlin uses real Android task semantics");
  assert.doesNotMatch(deviceKt, /System\.exit|Process\.killProcess/, "no hard process kill");
});

// ---- 5. Capture/Settings artificial folds removed ---------------------------
test("interaction closure — Capture + Settings artificial folds are gone", () => {
  for (const [name, css] of [["capture", captureTsx], ["settings", settingsTsx]] as const) {
    assert.ok(!css.includes("-content-fold") && !css.includes("-inbox-fold"), `${name} wrapper removed`);
  }
  assert.doesNotMatch(appCss, /capture-inbox-fold|settings-content-fold|note-actions-fold/);
  assert.doesNotMatch(tokensCss, /--fold-pad-(capture|settings|note)/);
  assert.doesNotMatch(appCss, /min-height:\s*calc\(100(vh|dvh)\s*-\s*\d+px\)/, "no vh-derived fake spacer");
});

// ---- 6. editor focus: no box; a11y ring preserved ---------------------------
test("interaction closure — editor surfaces lose the focus box; a11y ring stays", () => {
  assert.match(
    appCss,
    /\.editor-title:focus-visible,\s*\.editor-title:focus,\s*\.editor-body:focus-visible,\s*\.editor-body:focus\s*\{\s*outline:\s*none;\s*box-shadow:\s*none;\s*\}/,
    "title/body focus box removed"
  );
  assert.match(
    appCss,
    /button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible\s*\{\s*outline: 2px solid var\(--accent\)/,
    "global :focus-visible ring preserved for buttons/real forms"
  );
});

// ---- 7. desktop materials: single search owner + compact row ----------------
test("interaction closure — desktop materials stays single-search-owner in one tool row", () => {
  assert.doesNotMatch(desktopLibrary, /SearchField/, "no second search field");
  assert.match(desktopLibrary, /chip-scroll desktop-tools/, "目录/标签/kind chips share one row");
  const stripped = desktopLibrary.replace(new RegExp("//[^" + "\n" + "]*", "g"), "");
  assert.doesNotMatch(stripped, /<select/, "no system select in code");
});

// ---- 8. root dock/compose presentation-only hide during editing --------------
// STILL-01.1: the legacy BottomNav/ComposeFab no longer exist in the rendered
// tree. The SAME contract is expressed against the Still shell: the editing
// flag flips data-text-entry on .st-app, and the authority stylesheet hides
// the dock/compose action from it. Visibility only — never an IME estimate.
test("interaction closure — dock/compose hide on text focus via visibility only", () => {
  const shellTsx = read("src", "still", "StillShell.tsx");
  const stillCss = read("src", "presentation", "still01", "still.css");
  assert.match(appTsx, /const \[editingText, setEditingText\] = useState\(false\);/, "editing state exists");
  assert.match(appTsx, /return <StillApp conn=\{conn\} editingText=\{editingText\} \/>;/, "the flag is handed to the Still shell");
  assert.match(shellTsx, /className="st-app"/, "Still app shell present");
  assert.match(shellTsx, /data-text-entry=\{editingText \|\| \(rootTab === "ai" && lshIme\) \? "true" : undefined\}/, "Still shell hides dock/compose via data-text-entry");
  assert.match(stillCss, /data-text-entry/, "authority CSS consumes the flag");
  assert.doesNotMatch(appTsx, /BottomNav|ComposeFab|bottom-nav|compose-fab/, "legacy nav/FAB no longer rendered");
  assert.doesNotMatch(appTsx, /--ime-inset/, "still no second IME authority");
  assert.doesNotMatch(appTsx, /keyboardHeight|imeHeight/i);
});

// ---- system bar appearance (用户问题1 标记1) ---------------------------------
test("interaction closure — system-bar appearance follows color mode (visual only)", () => {
  assert.match(clientTs, /setSystemBarAppearance: \(dark: boolean, dimmed = false, statusRgb\?: number, navigationRgb\?: number\)/, "TS api present");
  const appearance = readFileSync(new URL("../src/services/systemBarAppearance.ts", import.meta.url), "utf8");
  assert.match(appearance, /app\.dataset\.mode === "dark"/, "reads the rendered theme authority");
  assert.match(appearance, /"data-theme", "data-mode", "data-reduced"/, "syncs on color-mode change");
  assert.match(deviceKt, /isAppearanceLightStatusBars = !dark/, "light/dark icon appearance flips");
  // Frozen: the approved inset math must be untouched.
  assert.match(mainKt, /val bottom = maxOf\(safe\.bottom, ime\.bottom\)/);
  assert.match(mainKt, /view\.setPadding\(safe\.left, safe\.top, safe\.right, bottom\)/);
});

// ---- Settings child views join the Back chain -------------------------------
test("interaction closure — Settings child views Back to the Settings root", () => {
  assert.match(settingsTsx, /overlayStack\.push\(\(\) => setView\("root"\)\)/, "child views registered in overlayStack");
});

// ---- Home hierarchy ---------------------------------------------------------
test("interaction closure — 全部本机内容 demoted to tertiary meta", () => {
  const sectionAction = appCss.match(/\.section-title \.section-action\s*\{([\s\S]*?)\}/);
  assert.ok(sectionAction, "section-action rule exists");
  assert.match(sectionAction[1], /font-size:\s*10px/, "smaller than 最近");
  assert.match(sectionAction[1], /color:\s*var\(--tertiary\)/, "tertiary, not ink");
  assert.match(sectionAction[1], /font-weight:\s*400/, "not bold");
});
