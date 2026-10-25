import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, dirname, basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = new URL('../', import.meta.url);

test('real browser: preview typography survives the retained editor line reset', () => {
  const browser = [process.env.LR_CSS_BROWSER,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']
    .find(path => path && existsSync(path));
  assert.ok(browser, 'Provide an installed Chromium browser with LR_CSS_BROWSER; no product dependency is installed');
  const preview = readFileSync(process.env.LR_CSS_PREVIEW_SOURCE || new URL('src/presentation/still01/editor/cmLivePreview.css', root), 'utf8');
  const base = readFileSync(new URL('src/presentation/still01/still.css', root), 'utf8');
  // Exercise the actual retained-CM reset that loads after the preview import.
  const resets = [...base.matchAll(/([^{}]*\.st-note-editor\.is-cm\s+\.cm-(?:content|line))\s*\{([^{}]*)\}/g)]
    .map(match => `${match[1]}{${match[2]}}`).join('\n');
  assert.ok(resets.includes('font-size:inherit'), 'The production line reset must participate');
  const work = mkdtempSync(join(tmpdir(), 'lr-preview-css-'));
  const document = `<style>${preview}</style><style>${resets}</style>
    <div class="st-note-editor is-cm"><div class="cm-content">
      <div id="h1" class="cm-line cm-lp-heading cm-lp-h1">Heading one</div>
      <div id="h2" class="cm-line cm-lp-heading cm-lp-h2">Heading two</div>
      <div id="h3" class="cm-line cm-lp-heading cm-lp-h3">Heading three</div>
      <div id="code" class="cm-line cm-lp-code">const value = 1;</div>
    </div></div><pre id="result"></pre>
    <script>
      const values = {};
      for (const id of ['h1', 'h2', 'h3', 'code']) {
        const style = getComputedStyle(document.getElementById(id));
        values[id] = {fontSize: parseFloat(style.fontSize), lineHeight: parseFloat(style.lineHeight), fontFamily: style.fontFamily};
      }
      document.getElementById('result').textContent = JSON.stringify(values);
    </script>`;
  try {
    const file = join(work, 'typography.html');
    writeFileSync(file, document);
    // Isolated headless profile; no existing browser, user profile or network page.
    const run = spawnSync(browser, ['--headless=new', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--disable-gpu', '--user-data-dir=' + join(work, 'profile'),
      '--dump-dom', pathToFileURL(file).href], {encoding: 'utf8', timeout: 30000, windowsHide: true});
    assert.equal(run.status, 0, run.error?.message || run.stderr);
    const match = /<pre id="result">([^<]+)<\/pre>/.exec(run.stdout);
    assert.ok(match, 'Browser must return actual computed style');
    const values = JSON.parse(match[1]);
    assert.ok(Math.abs(values.h1.fontSize - 26.4) < .01, JSON.stringify(values));
    assert.ok(Math.abs(values.h2.fontSize - 22.4) < .01, JSON.stringify(values));
    assert.ok(Math.abs(values.h3.fontSize - 19.2) < .01, JSON.stringify(values));
    assert.ok(Math.abs(values.h1.lineHeight / values.h1.fontSize - 1.4) < .01);
    assert.ok(values.code.fontFamily.includes('monospace'));
    assert.ok(Math.abs(values.code.fontSize - 14.72) < .01);
  } finally {
    // Only delete the unique temporary directory created by this test.
    assert.equal(dirname(resolve(work)), resolve(tmpdir()));
    assert.ok(basename(work).startsWith('lr-preview-css-'));
    assert.equal(realpathSync(work).toLowerCase(), resolve(work).toLowerCase());
    rmSync(work, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
  }
});
