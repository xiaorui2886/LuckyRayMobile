/** Source contracts only. Android compilation / device geometry NOT RUN. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const native = read('scripts/android-src/LshEmbeddedSurface.kt');
const rust = read('src-tauri/src/lsh_surface.rs');
const main = read('scripts/android-src/MainActivity.kt');
test('embedded surface does not add a page-to-native bridge or new Activity', () => {
  assert.ok(!native.includes('addJavascriptInterface'));
  assert.ok(!native.includes('LshSurfaceActivity'));
  assert.match(native, /android.R.id.content/);
});
test('all navigation and subresources retain exact origin checks', () => {
  assert.match(native, /uri.scheme == it.scheme && uri.host == it.host && uri.port == it.port/);
  assert.match(native, /shouldOverrideUrlLoading/); assert.match(native, /shouldInterceptRequest/);
  assert.match(native, /403, "Forbidden"/);
  assert.match(native, /allowFileAccess = false; allowContentAccess = false/);
});
test('native completion is returned, not just a queued request', () => {
  assert.match(native, /FutureTask<String>/); assert.match(native, /task.get\(5, TimeUnit.SECONDS\)/);
});
test('layout derives scale and offsets from main WebView and clamps its rect', () => {
  assert.match(native, /main.width \/ viewport/);
  assert.match(native, /main.getLocationInWindow/);
  assert.match(native, /coerceIn\(0, main.width - left\)/);
  assert.match(native, /coerceIn\(0, main.height - top\)/);
});
test('hidden/loading/error surface cannot cover the parent retry or bottom nav', () => {
  assert.match(native, /if \(ready\) View.VISIBLE else View.INVISIBLE/);
  assert.match(native, /if \(failed\) return/);
  assert.match(native, /LSH_PAGE_LOAD_FAILED/);
  assert.match(native, /failed = true; ready = false; host\?\.visibility = View.GONE/);
});
test('close is owner-fenced and carrier teardown is lease-bound', () => {
  assert.match(native, /require\(owner == expected\)/);
  assert.match(native, /LshSurfaceBridge.retire\(oldLease\)/);
  assert.match(rust, /claim_current_launch\(url\)/);
  assert.match(rust, /action != "close" && action != "hide"/);
});
test('theme is a fixed light/dark presentation signal, not arbitrary script', () => {
  assert.match(native, /dataset.luckyrayMobileTheme='dark'/);
  assert.match(native, /dataset.luckyrayMobileTheme='light'/);
  assert.ok(!native.includes('evaluateJavascript(request'));
});
test('attachment chooser only accepts owner-page user file selection, no persistent grant', () => {
  assert.match(native, /onShowFileChooser/); assert.match(native, /Intent.ACTION_OPEN_DOCUMENT/);
  assert.match(native, /uri.scheme == "content"/);
  assert.match(native, /0 until clip.itemCount/);
  assert.ok(!native.includes("minOf(clip.itemCount"));
  assert.ok(!native.includes('takePersistableUriPermission'));
  assert.match(native, /requestCode != pendingFileRequest/);
});
test('MainActivity integrates pause, resume, destruction and chooser dispatch', () => {
  for (const method of ['pause()', 'resumeFor(this)', 'destroyFor(this)', 'onActivityResult(requestCode, resultCode, data)']) assert.ok(main.includes('LshEmbeddedSurface.' + method));
  assert.match(read('scripts/apply-android-patches.sh'), /cp "\$SRC_KOTLIN\/LshEmbeddedSurface.kt"/);
  assert.match(read('src-tauri/src/lib.rs'), /lsh_surface::lsh_surface_embed/);
});
test('system insets remain the single geometry authority and only boolean IME state crosses', () => {
  assert.match(main, /LshEmbeddedSurface.imeChanged\(windowInsets.isVisible\(WindowInsetsCompat.Type.ime\(\)\)\)/);
  assert.match(native, /luckyray-lsh-ime/);
  assert.match(native, /web\?\.hasFocus\(\) == true/);
  assert.match(native, /left - content.paddingLeft/);
  assert.match(native, /top - content.paddingTop/);
});
test('return from chooser/browser waits for a permission-checked foreground layout', () => {
  const resume = native.slice(native.indexOf('fun resumeFor'), native.indexOf('fun pause()'));
  assert.match(resume, /foreground = true/);
  assert.match(resume, /syncPresentationActivity\(\)/);
  assert.doesNotMatch(resume, /View.VISIBLE|onResume\(\)|wantedVisible = true/);
  assert.match(native, /if \(wantedVisible && ready && !failed\) suspendInput\(\);[\s\S]*?foreground = false; syncPresentationActivity\(\)/);
});

test('ready requires desktop version and real React conversation root with bounded fenced probe', () => {
  assert.match(native, /dataset.luckyrayMobileVersion/);
  assert.match(native, /data-luckyray-mobile-shell/);
  assert.match(native, /lr-mobile-conversation/);
  assert.match(native, /\[data-luckyray-mobile-shell=.*lr-mobile-overlay/);
  for (const marker of ['data-conversation-content', 'data-composer-seat', 'data-composer-card', 'data-composer-input', 'data-conversation-scroll', 'data-content-phase', 'data-slot-error', 'data-factory-error']) assert.ok(native.includes(marker), marker);
  assert.match(native, /installed && mounted/);
  assert.match(native, /generation != pageGeneration/);
  assert.match(native, /30_000L/);
  assert.match(native, /LSH_MOBILE_UI_NOT_READY/);
  assert.match(native, /LSH_MOBILE_UI_REQUIRED/);
});

test('back uses cancelable presentation event before Escape/history, never blocking the UI callback', () => {
  const back = native.slice(native.indexOf('private fun back('), native.indexOf('private fun error('));
  assert.match(back, /CompletableFuture<String>/);
  assert.match(back, /LSH_BACK_THREAD_INVALID/);
  assert.match(back, /luckyray-mobile-back/);
  assert.match(back, /cancelable:true/);
  assert.match(back, /KeyboardEvent/);
  assert.match(back, /!handled && view.canGoBack/);
  assert.match(back, /backHandled/);
  assert.match(back, /LSH_BACK_OUTCOME_UNKNOWN/);
  assert.match(back, /generation != pageGeneration/);
});
