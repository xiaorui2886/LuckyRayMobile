import assert from 'node:assert/strict';
// Fresh QA browser contexts only. This models a single-document WebView host;
// it does NOT test browser/native edge-Back suppression. Never call after a pan.
export async function isolateFixtureHistory(cdp, fixtureUrl, evidence = {}) {
  const expected = new URL(fixtureUrl).href;
  const snapshot = async () => {
    const value = await cdp.send('Page.getNavigationHistory');
    return {currentIndex:value.currentIndex,entries:value.entries.map(({id,url})=>({id,url}))};
  };
  try {
    evidence.before = await snapshot();
    const {entries,currentIndex} = evidence.before;
    assert.ok(entries.length === 1 || entries.length === 2, 'unexpected QA history length');
    assert.equal(currentIndex, entries.length - 1, 'fixture must be current final entry');
    assert.equal(entries[currentIndex].url, expected, 'unexpected current fixture URL');
    if (entries.length === 2) assert.equal(entries[0].url, 'about:blank', 'refuse to prune non-fixture history');
    // Exactly one setup operation. No fallback, retries, feature flags, or reset
    // during/after gestures; all original route/URL assertions remain active.
    await cdp.send('Page.resetNavigationHistory');
    evidence.after = await snapshot();
    assert.equal(evidence.after.currentIndex, 0);
    assert.equal(evidence.after.entries.length, 1);
    assert.equal(evidence.after.entries[0].url, expected);
    assert.equal(evidence.after.entries[0].id, entries[currentIndex].id, 'current document entry must survive');
    evidence.outcome = 'READY';
    return evidence;
  } catch (error) {
    evidence.outcome = 'BLOCKED';
    throw new Error('HISTORY_ISOLATION_BLOCKED: ' + String(error));
  }
}
