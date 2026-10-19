import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

describe("responsiveDesignContract (ADAPTIVE-FOUNDATION-R1)", () => {
  const tokensCss = fs.readFileSync(path.join(root, "src/design/tokens.css"), "utf-8");
  const appCss = fs.readFileSync(path.join(root, "src/app.css"), "utf-8");
  const allSourceFiles = [
    tokensCss,
    appCss,
    fs.readFileSync(path.join(root, "src/App.tsx"), "utf-8"),
    fs.readFileSync(path.join(root, "src/screens/Home.tsx"), "utf-8"),
    fs.readFileSync(path.join(root, "src/screens/Library.tsx"), "utf-8"),
    fs.readFileSync(path.join(root, "src/screens/Knowledge.tsx"), "utf-8"),
    fs.readFileSync(path.join(root, "src/screens/Capture.tsx"), "utf-8"),
    fs.readFileSync(path.join(root, "src/screens/Settings.tsx"), "utf-8"),
    fs.readFileSync(path.join(root, "src/screens/NoteEditor.tsx"), "utf-8"),
  ].join("\n");

  it("prohibits device/vendor model and UA branching in CSS and TSX", () => {
    // Prohibits if (isMi8), isSamsung, isXiaomi, isOppo, isVivo, isPixel
    const forbiddenPatterns = [
      /\b(isMi8|isXiaomi|isSamsung|isOppo|isVivo|isPixel)\b/i,
      /navigator\.userAgent/i,
      /data-device=/i,
      /data-model=/i,
      /@media.*(?:xiaomi|samsung|pixel|oppo|vivo)/i,
    ];
    for (const pat of forbiddenPatterns) {
      assert.strictEqual(
        pat.test(allSourceFiles),
        false,
        `Forbidden device/vendor pattern found: ${pat}`
      );
    }
  });

  it("prohibits global transform: scale(...) and zoom scaling hacks", () => {
    // Prohibits transform: scale() or zoom on html, body, #root, or .app-shell
    const scaleMatches = appCss.match(/(\.app-shell|html|body|#root)[^{]*\{[^}]*(transform\s*:\s*scale|zoom\s*:)[^}]*\}/gi);
    assert.strictEqual(
      scaleMatches,
      null,
      `Forbidden global scale or zoom hack found: ${scaleMatches}`
    );
  });

  it("prohibits flex gap, container queries, and backdrop-filter (WebView 83 constraints)", () => {
    // Prohibit flex gap (grid-gap / gap in grid is fine per WebView 83, but flex gap is not)
    assert.strictEqual(/display\s*:\s*flex[^;}]*;\s*gap\s*:/i.test(appCss), false, "Flex gap is not supported in WebView 83");
    assert.strictEqual(/@container\b/i.test(appCss), false, "Container queries not supported in WebView 83");
    assert.strictEqual(/backdrop-filter\s*:/i.test(appCss), false, "backdrop-filter dependency forbidden in WebView 83");
  });

  it("declares continuous layout tokens; ALL artificial folds removed (INTERACTION-CLOSURE-R1)", () => {
    assert.match(tokensCss, /--layout-page-x/);
    assert.match(tokensCss, /--layout-content-max/);
    assert.match(tokensCss, /--layout-nav-h/);
    // REAL-DEVICE-UI-POLISH-R1 removed the note fold; INTERACTION-CLOSURE-R1
    // removed capture/settings folds too — no viewport-derived spacer remains.
    assert.doesNotMatch(tokensCss, /--fold-pad-(note|capture|settings)/);
  });

  it("guards the Local Note editor against artificial fold spacers (REAL-DEVICE-UI-POLISH-R1)", () => {
    // The note actions flow normally after the body; a viewport-height-derived
    // spacer before them is a real-device regression and must never return.
    assert.doesNotMatch(appCss, /--fold-pad-note/);
    assert.doesNotMatch(appCss, /\.note-actions-fold/);
    assert.match(appCss, /\.note-actions\s*\{\s*margin-top:\s*18px;\s*\}/);
    // No other rule may reintroduce a giant fixed/derived top padding whose
    // only purpose is pushing content below the fold.
    for (const m of appCss.matchAll(/\.note-actions[^{]*\{([^}]*)\}/g)) {
      assert.doesNotMatch(m[1], /padding-top\s*:\s*(calc|clamp|\d{3,}px)/);
    }
  });

  it("keeps capture/settings content in natural document flow (no fold classes)", () => {
    assert.doesNotMatch(appCss, /capture-inbox-fold|settings-content-fold/);
  });

  it("guards touch targets to >= 44px on interactive controls", () => {
    assert.match(tokensCss, /--touch-target\s*:\s*44px/);
    assert.match(appCss, /\.nav-item\s*\{[^}]*min-height\s*:\s*var\(--touch-target\)/);
  });
});
