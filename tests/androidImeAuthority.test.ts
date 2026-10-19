// STABILITY-FIX-R1 Finding B — Android IME layout authority.
//
// Frozen architecture decision (#31): the NATIVE root insets are the single
// authority for how much space the on-screen keyboard occupies on Android.
// MainActivity must fold `Type.ime()` into the content-root bottom padding
// using `max(system bars / cutout, ime)`, and the frontend must NOT run a
// second, competing IME-height estimation chain that stacks on top of it.
//
// These are source/contract checks (no device required) so the boundary cannot
// silently regress; the real-device behaviour is verified separately on the MI8.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const androidSrc = join(ROOT, "scripts", "android-src");
const mainActivity = existsSync(join(androidSrc, "MainActivity.kt"))
  ? readFileSync(join(androidSrc, "MainActivity.kt"), "utf-8")
  : "";
const appTsx = readFileSync(join(ROOT, "src", "App.tsx"), "utf-8");
const appCss = readFileSync(join(ROOT, "src", "app.css"), "utf-8");
const tokens = readFileSync(join(ROOT, "src", "design", "tokens.css"), "utf-8");

test("ime authority — MainActivity is the Android IME layout authority", () => {
  assert.ok(mainActivity, "tracked MainActivity.kt source exists");
  // The ime inset type must be requested.
  assert.match(mainActivity, /Type\.ime\(\)/, "MainActivity requests WindowInsetsCompat.Type.ime()");
  // It must still handle system bars + cutout.
  assert.match(mainActivity, /Type\.systemBars\(\)/, "system bars insets still applied");
  assert.match(mainActivity, /Type\.displayCutout\(\)/, "display cutout insets still applied");
  // Bottom padding must be the MAX of the two, not a sum or the ime alone.
  assert.match(
    mainActivity,
    /maxOf\([^)]*bottom[^)]*\)/i,
    "bottom padding uses max(system/cutout, ime) semantics"
  );
  // Insets must be re-applied when the IME appears/disappears. Setting the
  // listener and requesting an initial application is sufficient only if the
  // framework re-dispatches on IME changes; assert we do not early-return.
  assert.match(mainActivity, /setOnApplyWindowInsetsListener/, "insets listener installed");
  assert.match(mainActivity, /requestApplyInsets/, "initial insets application requested");
});

/** Strip Kotlin comments so prose in an explanatory comment cannot be mistaken
 *  for a real call site (and vice versa). */
function stripKotlinComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
}

function assertContentFreeResumeOnly(source: string): void {
  const code = stripKotlinComments(source);
  // EDE native-return review sanctions only this literal lifecycle event.
  // No content, computed script, layout value or other evaluation is allowed.
  const resume = /\.evaluateJavascript\(\s*"window\.dispatchEvent\(new Event\('lr:main-resume'\)\)"\s*,\s*null\s*\)/g;
  assert.equal(code.match(resume)?.length, 1, "exactly one content-free resume evaluation");
  const remaining = code.replace(resume, "");
  assert.ok(
    !/evaluateJavascript/.test(remaining),
    "MainActivity must not inject IME CSS via evaluateJavascript"
  );
  assert.ok(
    !/addJavascriptInterface/.test(code),
    "no JS bridge is added for layout purposes"
  );
}

test("ime authority — MainActivity does not inject a second CSS IME value", () => {
  // Root padding remains the sole IME authority. The reviewed resume event
  // only wakes outstanding legacy-engine work; it never writes CSS/insets.
  assertContentFreeResumeOnly(mainActivity);
});

test("ime authority — the resume exception rejects extra, computed or layout evaluations", () => {
  const resume = `webView.evaluateJavascript("window.dispatchEvent(new Event('lr:main-resume'))", null)`;
  assertContentFreeResumeOnly(resume);
  assert.throws(() => assertContentFreeResumeOnly(`${resume}\nwebView.evaluateJavascript("document.body.style.paddingBottom='300px'", null)`));
  assert.throws(() => assertContentFreeResumeOnly(`${resume}\nwebView.evaluateJavascript(script, null)`));
  assert.throws(() => assertContentFreeResumeOnly(`${resume}\n${resume}`));
  assert.throws(() => assertContentFreeResumeOnly(`${resume}\nwebView.addJavascriptInterface(layoutBridge, "layout")`));
});

test("ime authority — the frontend keeps no competing dynamic IME height chain", () => {
  // The UI-refresh best-effort estimator must be gone: no baseline tracking and
  // no publishing of --ime-inset from the web layer.
  assert.ok(
    !/--ime-inset/.test(appTsx),
    "App.tsx must not publish a dynamic --ime-inset (native owns IME layout)"
  );
  assert.ok(
    !/baseline/.test(appTsx),
    "App.tsx must not keep the viewport-baseline IME estimator"
  );
  // And nothing may consume the removed variable either.
  assert.ok(!/--ime-inset/.test(appCss), "app.css must not consume --ime-inset");
  assert.ok(!/--ime-inset/.test(tokens), "tokens.css must not carry a dynamic --ime-inset");
});

test("ime authority — the generic, non-duplicating viewport logic is retained", () => {
  // The viewport-height tracking and focus reveal are NOT IME duplication and
  // must survive: they keep the shell tied to the visible area and the focused
  // control scrolled into view on old WebViews.
  assert.ok(/--app-viewport-h/.test(appTsx), "visual-viewport height tracking retained");
  assert.ok(/scrollIntoView/.test(appTsx), "focused-control reveal retained");
});
