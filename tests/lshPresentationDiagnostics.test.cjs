const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const native = fs.readFileSync(path.join(root, 'scripts/android-src/LshEmbeddedSurface.kt'), 'utf8');
const surface = fs.readFileSync(path.join(root, 'src/still/kit/lshSurface.ts'), 'utf8');
const expression = JSON.parse(native.split('\n').find(line => line.trim().startsWith('"[document.documentElement.dataset.luckyrayMobileVersion')) .trim());
function probe({ installed = false, mounted = false, query = '?luckyrayMobile=1', loader = true, style = false, overlay = mounted, body = mounted, phase = 'active', seat = true, composer = true, input = true, card = true, scroll = true, error = false } = {}) {
  return JSON.parse(JSON.stringify(vm.runInNewContext(expression, {
    URLSearchParams, location: { search: query },
    document: { documentElement: { dataset: { luckyrayMobileVersion: installed ? 'mobile-shell-v1-dsh-0.2.1-rc.2' : '' } }, querySelector: selector => selector.includes('lr-mobile-overlay') ? (overlay ? {} : null) : (mounted ? { querySelector: selector => selector.includes('data-slot-error') ? (error ? {} : null) : body ? { getAttribute: () => phase, querySelector: selector => selector.includes('data-composer-seat') ? (seat ? { childElementCount: composer ? 1 : 0, querySelector: selector => (selector.includes('data-composer-card') ? card : input) ? {} : null } : null) : (scroll ? {} : null) } : null } : null), getElementById: () => style ? {} : null },
    window: { __ModuleLoader__: loader ? { load() {} } : undefined },
  })));
}
test('the actual Kotlin-owned JS returns five booleans, never URL or page data', () => {
  assert.deepEqual(probe({ installed: true, mounted: true, style: true }), [true, true, true, true, true]);
  assert.deepEqual(probe({ query: '?unrelated=private', loader: false }), [false, false, false, false, false]);
  assert.deepEqual(probe({ installed: true }), [true, false, true, true, false]);
});
test('native parsing is strict and malformed callbacks cannot become missing-install evidence', () => {
  assert.match(native, /it.length\(\) == 5 && \(0 until 5\).all \{ index -> it.opt\(index\) is Boolean \}/);
  assert.match(native, /bits == null -> "LSH_PRESENTATION_PROBE_INVALID"/);
  assert.match(native, /!mobileMode -> "LSH_MOBILE_MODE_REQUIRED"/);
  assert.match(native, /if \(mobileMode && installed && mounted\)/);
  assert.match(native, /generation != pageGeneration/);
  assert.match(native, /30_000L/);
  assert.match(native, /40_000L/);
});
test('diagnostics are fixed labels with no general console or JS bridge', () => {
  const logLines = native.split('\n').filter(line => line.includes('Log.i('));
  assert.equal(logLines.length, 8);
  assert(logLines.every(line => /"(?:readiness|deadline|capability)=" \+ presentationDiagnostic|"lease=retired"|"revalidation=(?:timeout|stale_lifecycle)"|if \(render\) "renderer=resumed" else "renderer=paused"/.test(line)));
  assert.doesNotMatch(native, /onConsoleMessage|addJavascriptInterface|Log\.[a-z]\([^\n]*raw/);
  for (const label of ['probe_invalid', 'mobile_mode_missing', 'module_loader_missing', 'version_marker_missing', 'mobile_plugin_not_installed', 'root_not_mounted']) assert(native.includes('"' + label + '"'));
});
test('the error text no longer asserts the desktop integration is absent', () => {
  assert(surface.includes('LSH_PRESENTATION_PROBE_INVALID'));
  assert(surface.includes('LSH_MOBILE_MODE_REQUIRED'));
  assert(!surface.includes('请先接入桌面的手机 LightSeek 配套界面'));
});

test('an overlay, empty root, settling state or renderer failure cannot masquerade as ready', () => {
  for (const change of [{ mounted:false,overlay:true },{body:false},{phase:'settling'},{phase:'unknown'},{seat:false},{composer:false},{card:false},{input:false},{scroll:false},{error:true},{overlay:false}]) {
    assert.equal(probe({installed:true,mounted:true,...change})[1],false,JSON.stringify(change));
  }
  assert.equal(probe({installed:true,mounted:true,phase:'hero'})[1],true);
});
test('official conversation body is allowed for swipe, but only in opt-in mobile page', () => {
  assert(native.includes('html[data-luckyray-mobile="1"] [data-slot="main.conversation"] [data-conversation-content]'));
  assert(native.includes('Color.rgb(241, 242, 245)'));
});
