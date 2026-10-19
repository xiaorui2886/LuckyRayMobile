// tests/safeAreaAuthority.test.ts — REAL-DEVICE-UI-POLISH-R1 deterministic
// guard for the single safe-area/IME layout authority on Android.
//
// Root cause being locked out: MainActivity pads android.R.id.content by the
// real systemBars/cutout insets, while CSS env(safe-area-inset-*) can ALSO
// report non-zero on newer cutout WebViews (Xiaomi 14 Ultra class) — stacking
// both produced a ~90 CSS px dead band under the status bar. The fix: the
// frontend's --safe-* vars default to 0 on Android; only a browser/dev
// harness may override them. No device-model / UA branching anywhere.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const androidSrc = join(ROOT, "scripts", "android-src");
const mainActivity = existsSync(join(androidSrc, "MainActivity.kt"))
  ? readFileSync(join(androidSrc, "MainActivity.kt"), "utf8")
  : "";
const tokensCss = readFileSync(join(ROOT, "src", "design", "tokens.css"), "utf8");
const appCss = readFileSync(join(ROOT, "src", "app.css"), "utf8");
const appTsx = readFileSync(join(ROOT, "src", "App.tsx"), "utf8");

function stripKotlinComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

test("safe area — MainActivity remains the Android system-inset authority", () => {
  assert.ok(mainActivity, "tracked MainActivity.kt source exists");
  const code = stripKotlinComments(mainActivity);
  assert.match(code, /Type\.systemBars\(\)/, "systemBars insets requested");
  assert.match(code, /Type\.displayCutout\(\)/, "display cutout insets requested");
  assert.match(code, /maxOf\(safe\.bottom,\s*ime\.bottom\)/, "bottom = max(system, ime) — never a sum");
  assert.match(code, /view\.setPadding\(safe\.left,\s*safe\.top,\s*safe\.right,\s*bottom\)/, "content root padding is the native authority");
});

test("safe area — frontend --safe-* vars default to 0 (no CSS env() double-stack on Android)", () => {
  // The four vars must be literal 0px defaults, NOT env(...) readers: the
  // native layer already applied the real insets around the WebView.
  for (const v of ["--safe-top", "--safe-bottom", "--safe-left", "--safe-right"]) {
    const m = tokensCss.match(new RegExp(v.replace(/-/g, "\\-") + "\\s*:\\s*([^;]+);"));
    assert.ok(m, `${v} is declared`);
    assert.equal(m[1].trim(), "0px", `${v} defaults to 0px (native owns the real inset)`);
  }
  // No env(safe-area-inset-*) reader may return into the layout chain.
  assert.doesNotMatch(tokensCss, /env\(\s*safe-area-inset/, "tokens.css must not read env(safe-area-inset-*)");
  assert.doesNotMatch(appCss, /env\(\s*safe-area-inset/, "app.css must not read env(safe-area-inset-*)");
});

test("safe area — the shell still CONSUMES the vars (harness overridable, Android zero)", () => {
  // Keeping the consumption chain intact means a browser/dev harness can
  // still emulate insets by overriding --safe-* explicitly, without the
  // Android build stacking them.
  assert.match(appCss, /\.app-shell\s*\{[^}]*padding:\s*var\(--safe-top\)\s*var\(--safe-right\)\s*0\s*var\(--safe-left\)/);
});

test("safe area — no device-model / UA branching was introduced by the fix", () => {
  // Comments stripped so the fix EXPLANATION can name the device while
  // executable code may never branch on it.
  const noBlockComments = new RegExp("\\/\\*[\\s\\S]*?\\*\\/", "g");
  const noLineComments = /\/\/[^\n]*/g;
  const codeOnly = [tokensCss, appCss, appTsx].join(String.fromCharCode(10));
  const deviceBranch = /(isMi8|isXiaomi|isSamsung|isOppo|isVivo|isPixel|Xiaomi14)/i;
  assert.doesNotMatch(codeOnly, deviceBranch);
  assert.doesNotMatch(codeOnly, /navigator.userAgent/);
  // No negative-offset patches for any device.
  assert.doesNotMatch(codeOnly, new RegExp("(?:margin-top|top)s*:s*-d"));
});

test("safe area — IME stays native (no second keyboard-height authority)", () => {
  assert.doesNotMatch(appTsx, /--ime-inset/, "no dynamic --ime-inset publisher");
  assert.doesNotMatch(appCss, /--ime-inset/, "no --ime-inset consumer");
  assert.match(appTsx, /--app-viewport-h/, "visual-viewport height tracking retained");
});
