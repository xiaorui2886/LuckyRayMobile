/** Native source contracts, not Android runtime or compilation evidence. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const native = fs.readFileSync(path.join(__dirname, '../scripts/android-src/LshEmbeddedSurface.kt'), 'utf8');
const between = (start, end) => native.slice(native.indexOf(start), native.indexOf(end, native.indexOf(start)));
const sync = between('private fun syncPresentationActivity()', 'private fun probePresentation(');

test('load and readiness budgets retain finite active-time limits, not background elapsed time', () => {
  assert.match(native, /deadlineBegan = activeTime.elapsed\(\)/);
  assert.match(native, /40_000L - \(activeTime.elapsed\(\) - deadlineBegan\)/);
  assert.match(native, /activeTime.elapsed\(\) - probeBegan >= 30_000L/);
  assert.match(native, /if \(probeBegan < 0L\) probeBegan = activeTime.elapsed\(\)/);
  assert.doesNotMatch(native, /elapsedRealtime\(\) - began/);
  assert.match(native, /accumulated \+ \(since\?\.let/);
  assert.match(native, /accumulated = elapsed\(\); since = null/);
});

test('hidden surfaces park deadline and poll callbacks without recreating the WebView', () => {
  const inactive = between('        if (!active) {', '        view ?: return');
  assert.match(inactive, /probeEpoch \+= 1/);
  for (const task of ['deadlineTask', 'probeTask']) {
    assert.ok(inactive.includes(`${task}?.let { presentationHandler.removeCallbacks(it) }; ${task} = null`));
  }
  assert.match(inactive, /host\?\.visibility = if \(authorized && foreground && wantedVisible && suspended && ready && !failed\) View.VISIBLE else View.GONE/);
  assert.doesNotMatch(inactive, /view\?\.onPause\(\)/);
  assert.match(sync, /val render = authorized && foreground && wantedVisible && !failed && \(active \|\| \(suspended && ready\)\)/);
  assert.match(sync, /if \(render\) view\?\.onResume\(\) else view\?\.onPause\(\)/);
  assert.doesNotMatch(inactive, /destroy\(|loadUrl\(|loadData|ready = false/);
  assert.match(sync, /activeTime.setActive\(active\)/);
});

test('resume and layout cannot reveal cached ready content before the lease gate', () => {
  assert.match(sync, /authorized = view != null && LshSurfaceBridge.isLeaseCurrent\(lease\)/);
  assert.match(sync, /if \(view != null && !authorized\) \{\s*[\s\S]*?destroy\(\)\s+return/);
  assert.match(sync, /active = authorized && foreground && wantedVisible && !failed/);
  assert.ok(sync.indexOf('if (!active)') < sync.indexOf('View.VISIBLE'));
  assert.equal((native.match(/\.onResume\(\)/g) || []).length, 1, 'all resumes pass through the gate');
  assert.match(native, /wantedVisible = foreground && width > 0 && height > 0/);
  assert.match(native, /if \(wantedVisible && ready && !failed\) suspendInput\(\);[\s\S]*?foreground = false; syncPresentationActivity\(\)/);
});

test('stale readiness callbacks are fenced across pause, replacement and navigation', () => {
  const probe = between('private fun probePresentation(', 'private fun probeCapabilities(');
  assert.equal((probe.match(/generation != pageGeneration \|\| epoch != probeEpoch \|\| failed \|\| !presentationActive/g) || []).length, 2);
  assert.match(sync, /changed && probeBegan >= 0L && !ready/);
  assert.match(native, /deadline == deadlineGeneration && presentationActive && !ready && !failed/);
  const destroy = between('private fun destroy()', '/** Monotonic presentation-only clock.');
  assert.match(destroy, /deadlineGeneration \+= 1; probeEpoch \+= 1; probeBegan = -1L/);
  assert.match(destroy, /removeCallbacks/);
});

test('readiness still requires real mounted UI and does not add bridge or renewal authority', () => {
  assert.match(native, /if \(mobileMode && installed && mounted\)/);
  assert.match(native, /data-composer-card/);
  assert.doesNotMatch(native, /addJavascriptInterface|pauseTimers\(|resumeTimers\(/);
  assert.equal((native.match(/ready = true/g) || []).length, 1);
  assert.match(native, /LshSurfaceBridge.retire\(oldLease\)/);
});

test('Activity resume sends only a fixed app-host lifecycle event, not arbitrary page evaluation', () => {
 const resume = between('fun resumeFor(a: Activity)', 'fun pause()');
 assert.match(resume, /findMain\(content\)\?\.evaluateJavascript/);
 assert.match(resume, /window.dispatchEvent\(new Event\('luckyray:foreground'\)\)/);
 assert.doesNotMatch(resume, /sessionUrl|cookie|token|loadUrl/);
});
