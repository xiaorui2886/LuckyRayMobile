// LSH remote surface (Issue #72) — Android shell + integration-plumbing
// contract tests. Same style as tests/androidPatchContract.test.ts: the patch
// script and Kotlin sources are the contract, asserted as text (the generated
// project is checked additionally when present).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

const ACTIVITY = read("scripts", "android-src", "LshSurfaceActivity.kt");
const BRIDGE = read("scripts", "android-src", "LshSurfaceBridge.kt");
const PATCH = read("scripts", "apply-android-patches.sh");

test("lsh shell: the WebView runs with no JavaScript bridge into the page", () => {
  // M1 needs no native bridge; a bridge would be a second authority into the
  // Desktop surface. The API must not appear anywhere in the shell.
  assert.ok(!ACTIVITY.includes("addJavascriptInterface"), "no addJavascriptInterface");
  assert.ok(!BRIDGE.includes("addJavascriptInterface"), "no addJavascriptInterface in the bridge");
});

test("lsh shell: exact-origin policy covers navigation AND subresources", () => {
  // One origin definition drives both.
  assert.match(ACTIVITY, /private fun isSameOrigin\(uri: Uri\): Boolean/);
  assert.match(ACTIVITY, /shouldOverrideUrlLoading/);
  assert.match(ACTIVITY, /shouldInterceptRequest/);
  const calls = ACTIVITY.split("isSameOrigin(").length - 1;
  assert.ok(calls >= 3, `same-origin checked for navigation + subresources (+definition), saw ${calls}`);
  // Non-same-origin subresources are refused with an empty 403.
  assert.match(ACTIVITY, /blockedResponse\(\)/);
  assert.match(ACTIVITY, /403/);
  assert.match(ACTIVITY, /"no-store"/);
});

test("lsh shell: external http(s) goes to the system browser, other schemes are refused", () => {
  assert.match(ACTIVITY, /Intent\.ACTION_VIEW/);
  assert.match(ACTIVITY, /scheme == "https" \|\| scheme == "http"/);
  // The method returns true (consumed) for every non-same-origin navigation.
  const body = ACTIVITY.slice(ACTIVITY.indexOf("private fun handleNavigation"));
  const segment = body.slice(0, body.indexOf("private fun blockedResponse"));
  assert.match(segment, /return true \/\/ every other scheme is refused/);
});

test("lsh shell: System Back walks WebView history first, then returns to LuckyRay", () => {
  const body = ACTIVITY.slice(ACTIVITY.indexOf("override fun onBackPressed"));
  const end = body.indexOf("override fun onPause");
  const segment = body.slice(0, end);
  assert.match(segment, /webView\.canGoBack\(\)/);
  assert.match(segment, /webView\.goBack\(\)/);
  assert.match(segment, /finish\(\)/);
});

test("lsh shell: main-frame failures show a truthful native panel (no fabricated content)", () => {
  assert.match(ACTIVITY, /onReceivedError/);
  assert.match(ACTIVITY, /request\.isForMainFrame/);
  assert.match(ACTIVITY, /LightSeek 暂时无法加载/);
  assert.match(ACTIVITY, /"重试"/);
  assert.match(ACTIVITY, /"关闭"/);
});

test("lsh shell: LshSurfaceBridge is warmed on the normal startup path (G1 row 5)", () => {
  // The bridge's `init { nativeInit() }` caches the JVM + class GlobalRef for
  // Rust. Without an explicit startup touch the object is never initialized
  // and the first product-path open() fails before any Activity launch.
  const MAIN = read("scripts", "android-src", "MainActivity.kt");
  assert.match(BRIDGE, /@JvmStatic[\s\S]{0,40}fun warm\(\)/, "LshSurfaceBridge exposes warm()");
  assert.match(BRIDGE, /init \{ nativeInit\(\) \}/, "the warm seam still self-registers via nativeInit");
  assert.match(MAIN, /LshSurfaceBridge\.warm\(\)/, "MainActivity warms the bridge");
  // It runs during onCreate, after super.onCreate, not lazily on first tap.
  const onCreate = MAIN.slice(MAIN.indexOf("override fun onCreate"));
  const superAt = onCreate.indexOf("super.onCreate(savedInstanceState)");
  const warmAt = onCreate.indexOf("LshSurfaceBridge.warm()");
  assert.ok(superAt !== -1 && warmAt !== -1, "both statements exist in onCreate");
  assert.ok(warmAt > superAt, "warm() runs after super.onCreate()");
  // And it is grouped with the other production bridge initialization.
  assert.ok(
    onCreate.indexOf("CaptureBridge.init(this)") < warmAt && warmAt < onCreate.indexOf("LshSurfaceBridge.warm()") + 1,
    "warm() sits alongside the other startup bridge init",
  );
});
test("lsh shell: WebView diagnostics are bounded, sanitized and injection-free (G1 row 6)", () => {
  // Diagnostic-only instrumentation: it captures why the surface renders
  // blank WITHOUT loosening any security behavior or touching the page.
  assert.match(ACTIVITY, /const val DIAG_TAG = "LshSurfaceDiag"/, "one diagnostic tag");
  // Console capture + page lifecycle + HTTP errors + bounded error detail.
  assert.match(ACTIVITY, /webChromeClient = object : WebChromeClient\(\)/);
  assert.match(ACTIVITY, /override fun onConsoleMessage\(message: ConsoleMessage\)/);
  assert.match(ACTIVITY, /override fun onPageStarted\(/);
  assert.match(ACTIVITY, /override fun onPageFinished\(/);
  assert.match(ACTIVITY, /override fun onReceivedHttpError\(/);
  assert.match(ACTIVITY, /error\.errorCode/);
  assert.match(ACTIVITY, /bounded\(error\.description/);
  // The installed WebView version is recorded once.
  assert.match(ACTIVITY, /private fun logWebViewVersion\(\)/);
  assert.match(ACTIVITY, /logWebViewVersion\(\)/, "called on the startup path");
  // Sanitization: scheme/host/path only — query/fragment never logged.
  assert.match(ACTIVITY, /private fun sanitizeUrl\(raw: String\?\): String/, "the sanitizer exists");
  const sanitizer = ACTIVITY.slice(ACTIVITY.indexOf("private fun sanitizeUrl"));
  const sanitizerBody = sanitizer.slice(0, sanitizer.indexOf("private fun logWebViewVersion"));
  assert.match(sanitizerBody, /uri\.scheme/, "scheme extracted");
  assert.match(sanitizerBody, /uri\.host/, "host extracted");
  assert.match(sanitizerBody, /uri\.path/, "path extracted");
  assert.ok(!/uri\.query|uri\.fragment|encodedQuery|encodedFragment/.test(sanitizerBody),
    "the sanitizer never reads query or fragment");
  // Bounded message length.
  assert.match(ACTIVITY, /const val MAX_DIAG_CHARS = 300/);
  // Diagnostic logging never logs the sensitive URL parts directly.
  assert.ok(!/Log\.[a-z]\(DIAG_TAG, *"\$\{?sessionUrl\}?"/.test(ACTIVITY),
    "the raw session URL is never logged");
  assert.match(ACTIVITY, /sanitizeUrl\(sessionUrl\)/, "the session URL is sanitized before logging");
  // Forbidden: debugging enablement and any JS injection.
  for (const forbidden of ["setWebContentsDebuggingEnabled", "evaluateJavascript", "addJavascriptInterface"]) {
    assert.ok(!ACTIVITY.includes(forbidden), `no ${forbidden}`);
  }
  // Core security behavior unchanged.
  assert.match(ACTIVITY, /settings\.allowFileAccess = false/);
  assert.match(ACTIVITY, /settings\.allowContentAccess = false/);
  assert.match(ACTIVITY, /private fun isSameOrigin\(uri: Uri\): Boolean/);
  assert.match(ACTIVITY, /scheme == "http" && host != "127\.0\.0\.1"/, "the loopback gate is intact");
});
test("lsh shell: no process-global cookie purge exists in the LSH activity", () => {
  // P1-M1: Android CookieManager is process/profile-wide — wiping it would
  // clear cookies belonging to other LuckyRay surfaces. LSH browser-session
  // isolation belongs to the #166-backed carrier/bootstrap contract.
  assert.ok(!ACTIVITY.includes("removeAllCookies"), "no removeAllCookies anywhere in the shell");
  assert.ok(!ACTIVITY.includes("CookieManager.getInstance"), "no global CookieManager use at all");
  assert.ok(!BRIDGE.includes("CookieManager.getInstance"), "and none in the bridge");
});

test("lsh shell: the launch still requires a provable owner", () => {
  assert.match(ACTIVITY, /EXTRA_OWNER_INSTANCE_ID/, "the owner rides with the launch");
  // A surface without its owner is unprovable and refused.
  const body = ACTIVITY.slice(ACTIVITY.indexOf("override fun onCreate"));
  const segment = body.slice(0, body.indexOf("sessionOrigin = Uri.parse"));
  assert.match(segment, /finish\(\)/, "an owner-less launch finishes instead of guessing");
});

test("lsh shell: the dedicated WebView forbids local file and content access", () => {
  assert.match(ACTIVITY, /settings\.allowFileAccess = false/);
  assert.match(ACTIVITY, /settings\.allowContentAccess = false/);
});

test("lsh shell: the activity re-validates the URL fail-closed before loadUrl", () => {
  // The gate exists, mirrors the Rust validator, and runs before anything loads.
  assert.match(ACTIVITY, /private fun isLoadableSessionUrl\(raw: String\): Boolean/);
  assert.match(ACTIVITY, /scheme != "http" && scheme != "https"/);
  assert.match(ACTIVITY, /raw\.contains\("@"\)/, "user-info-bearing URLs are refused");
  assert.match(ACTIVITY, /MAX_URL_CHARS/, "URL length is bounded");
  const body = ACTIVITY.slice(ACTIVITY.indexOf("override fun onCreate"));
  const segment = body.slice(0, body.indexOf("webView.loadUrl"));
  const gate = segment.indexOf("isLoadableSessionUrl(sessionUrl)");
  assert.ok(gate !== -1, "the gate runs during onCreate");
  assert.ok(gate < segment.indexOf("loadUrl"), "the gate precedes any load");
  assert.match(segment.slice(gate), /finish\(\)/, "an invalid URL finishes the activity");
});

test("lsh shell: the display title is bounded and sanitized", () => {
  assert.match(ACTIVITY, /private fun sanitizeTitle\(raw: String\): String/);
  assert.match(ACTIVITY, /MAX_TITLE_CHARS/);
  assert.match(ACTIVITY, /sanitizeTitle\(intent\.getStringExtra\(EXTRA_TITLE\)/, "the intent title never reaches the UI raw");
});

test("lsh shell: the native launch boundary re-proves the owner before opening", () => {
  const rust = read("src-tauri", "src", "lsh_surface.rs");
  const at = rust.indexOf("pub(crate) async fn lsh_surface_open");
  const body = rust.slice(at, rust.indexOf("const MAX_SURFACE_URL_CHARS"));
  // The command now carries SharedState (callable directly by the renderer, so
  // it is an authority boundary).
  assert.match(body.slice(0, 400), /state: tauri::State<'_, crate::SharedState>/, "SharedState is a parameter");
  const owner = body.indexOf("require_expected_source(&state, &owner_instance_id)");
  const launch = body.indexOf("shell::open");
  assert.ok(owner !== -1, "the owner is re-proven at the native boundary");
  assert.ok(launch !== -1);
  assert.ok(owner < launch, "the owner re-proof precedes the shell launch");
  // The display title is sanitized natively too; the session URL must be the
  // Mobile-owned loopback carrier origin (strict gate in is_loopback_session_url).
  assert.match(body, /sanitize_surface_title\(&title\)/);
  assert.match(body, /is_loopback_session_url\(&session_url\)/);
  assert.match(rust, /pub\(crate\) fn is_loopback_session_url\(raw: &str\) -> bool/);
  assert.match(rust, /const MAX_SURFACE_TITLE_CHARS: usize = 64;/);
});

test("lsh shell: Rust unit tests cover the refused URL classes", () => {
  const rust = read("src-tauri", "src", "lsh_surface.rs");
  // The final boundary is is_loopback_session_url: only the Mobile-owned
  // loopback carrier origin qualifies. Its shape is contract-tested here.
  const fn_at = rust.indexOf("pub(crate) fn is_loopback_session_url");
  const fn_body = rust.slice(fn_at, fn_at + 900);
  assert.match(fn_body, /strip_prefix\(\"http:\/\/\"\)/, "loopback http only");
  assert.match(fn_body, /host == "127\.0\.0\.1"/, "loopback host only");
  // And the Rust command refuses before the shell is consulted.
  assert.match(rust, /is_loopback_session_url\(&session_url\)/);
});

test("lsh shell: lifecycle is wired (pause/resume/destroy)", () => {
  for (const hook of ["override fun onPause", "override fun onResume", "override fun onDestroy"]) {
    assert.match(ACTIVITY, new RegExp(hook.replace("(", "\\(")));
  }
  assert.match(ACTIVITY, /webView\.onPause\(\)/);
  assert.match(ACTIVITY, /webView\.onResume\(\)/);
  assert.match(ACTIVITY, /webView\.destroy\(\)/);
});

test("lsh shell: the WebView-83 fleet constraint holds (plain programmatic views)", () => {
  // No layout XML resource, no newer-API-only view code.
  assert.ok(!ACTIVITY.includes("R.layout."), "no layout XML dependency");
  assert.match(ACTIVITY, /LinearLayout/, "plain programmatic views");
});

test("lsh shell: the patch script registers a NON-exported dedicated activity", () => {
  // The dedicated activity must exist and must NOT be exported (the pairing
  // contract allows exactly one exported component: the launcher MainActivity).
  assert.match(PATCH, /android:name="\.LshSurfaceActivity"/);
  const registration = PATCH.slice(PATCH.indexOf('android:name=".LshSurfaceActivity"'));
  assert.match(registration.slice(0, 400), /android:exported="false"/);
  // The insertion is idempotent.
  assert.match(PATCH, /grep -q 'android:name="\.LshSurfaceActivity"'/);
  // Both sources ship via the copy block.
  assert.match(PATCH, /cp "\$SRC_KOTLIN\/LshSurfaceBridge\.kt"/);
  assert.match(PATCH, /cp "\$SRC_KOTLIN\/LshSurfaceActivity\.kt"/);
  // The bridge survives R8 (JNI entry point).
  assert.match(PATCH, /-keep class com\.luckyray\.mobile\.LshSurfaceBridge \{ \*; \}/);
});

test("lsh shell: when the generated project exists, the manifest keeps exactly one exported component", () => {
  const manifestPath = join(ROOT, "src-tauri", "gen", "android", "app", "src", "main", "AndroidManifest.xml");
  if (!existsSync(manifestPath)) return; // clean CI checkout: patch-script contract above is the guard
  const manifest = readFileSync(manifestPath, "utf-8");
  assert.ok(manifest.includes('android:name=".LshSurfaceActivity"'), "activity registered");
  // Line-ending tolerant: the generated manifest may be CRLF on Windows.
  assert.match(manifest, /android:name="\.LshSurfaceActivity"\r?\n\s+android:exported="false"/, "not exported");
  const exportedCount = (manifest.match(/android:exported="true"/g) ?? []).length;
  assert.equal(exportedCount, 1, "exactly one exported component (launcher MainActivity)");
});

test("lsh shell: the Rust seam retains one capture and binds the real contract", () => {
  const content = read("src-tauri", "src", "content.rs");
  // ONE retained capture (ExpectedGateway) drives hello/state/session —
  // no check-then-reacquire, no second source authority.
  assert.match(content, /pub\(crate\) struct ExpectedGateway/);
  assert.match(content, /pub\(crate\) fn expected_gateway\(/);
  assert.match(content, /pub\(crate\) async fn content_get\(&self, state: &SharedState, path: &str\)/);
  assert.match(content, /pub\(crate\) async fn lsh_session_mint\(&self, state: &SharedState\)/);
  // The fail-closed seam is gone: the real contract is bound.
  const rust = read("src-tauri", "src", "lsh_surface.rs");
  assert.ok(!rust.includes("LSH_GATEWAY_NOT_PROVIDED"), "the seam no longer fail-closes");
  assert.match(rust, /\/v1\/lsh\/remote\/session/);
  assert.match(rust, /\/v1\/lsh\/remote\/state/);
  // The launch boundary still re-proves the owner and validates the URL.
  assert.match(rust, /require_expected_source\(&state, &owner_instance_id\)/);
  assert.match(rust, /is_loopback_session_url\(&session_url\)/);
  // Registered so the commands actually exist.
  const lib = read("src-tauri", "src", "lib.rs");
  for (const cmd of ["lsh_surface::lsh_surface_state", "lsh_surface::lsh_surface_bootstrap", "lsh_surface::lsh_surface_open", "lsh_surface::lsh_surface_stop"]) {
    assert.ok(lib.includes(cmd), `${cmd} registered in generate_handler!`);
  }
});
test("lsh shell: the content module owns the retained gateway (no second source authority)", () => {
  const content = read("src-tauri", "src", "content.rs");
  assert.match(content, /pub\(crate\) fn expected_gateway\(/);
  const body = content.slice(content.indexOf("pub(crate) struct ExpectedGateway"));
  // Same capture discipline as the thumbnail source (R3): fenced before AND after.
  assert.match(body.slice(0, 1200), /verify_owner\(state\)\?/);
  assert.match(body.slice(0, 1200), /self\.source\.gateway\.hello\(\)\.await\?/);
  assert.equal((content.match(/fn expected_gateway\(/g) || []).length, 1, "exactly one gateway capture authority");
});
