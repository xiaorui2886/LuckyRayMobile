import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const css = read('src/presentation/still01/editor/noteTypography.css');
// These are flat CSS contract checks, not a rendering/Android geometry test.
const rules = source => [...source.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => ({ selector: match[1].trim(), body: match[2] }));
const sheet = rules(css);
function declarations(selector) {
  const result = {};
  sheet.forEach(rule => {
    if (rule.selector.split(/,\n/).map(s => s.trim()).includes(selector)) {
      for (const declaration of rule.body.split(';')) { const colon = declaration.indexOf(':'); if (colon >= 0) result[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim(); }
    }
  });
  return result;
}

test('shared body typography is scoped to note surfaces, not settings or toolbars', () => {
  sheet.forEach(rule => {
    assert.ok(rule.selector.split(/,\n/).every(s => (s.trim().startsWith('.st-note-surface') || s.trim() === '.st-app[data-mode=dark] .st-note-surface')), rule.selector);
    assert.doesNotMatch(rule.selector, /st-reader-tools|st-editor-tools|st-note-title|st-header/);
  });
  assert.match(read('src/components/SafeNoteMarkdown.tsx'), /import "\.\.\/presentation\/still01\/editor\/noteTypography\.css"/);
});

test('rendered Markdown collapses renderer whitespace while code preserves source whitespace', () => {
  assert.equal(declarations('.st-note-surface .st-safe-note-markdown')['white-space'], 'normal');
  assert.equal(declarations('.st-note-surface .st-safe-note-markdown pre')['white-space'], 'pre-wrap');
  assert.equal(declarations('.st-note-surface .st-safe-note-markdown pre code')['white-space'], 'inherit');
});

test('reading and live-preview headings share sizes; title-only rules do not leak into body H1', () => {
  for (let level = 1; level <= 4; level++) {
    const reader = declarations(`.st-note-surface .st-safe-note-markdown h${level}`);
    const editor = declarations(`.st-note-surface .st-note-editor.is-cm .cm-line.cm-lp-h${level}`);
    assert.equal(reader['font-size'], `var(--note-h${level})`);
    assert.equal(reader['font-size'], editor['font-size']);
  }
  const base = read('src/presentation/still01/still.css');
  assert.doesNotMatch(base, /\.st-note-paper\s+h1/);
  assert.match(base, /\.st-note-paper > h1/);
});

test('quotes have a shared theme-accent border and no filled panel; code shares font and background', () => {
  for (const selector of ['.st-note-surface .st-safe-note-markdown blockquote', '.st-note-surface .st-note-editor.is-cm .cm-line.cm-lp-quote']) {
    const rule = declarations(selector);
    assert.equal(rule.background, 'transparent');
    assert.equal(rule['border-left'], '3px solid var(--st-accent,#6554c0)');
  }
  const reader = declarations('.st-note-surface .st-safe-note-markdown pre');
  const editor = declarations('.st-note-surface .st-note-editor.is-cm .cm-line.cm-lp-code');
  for (const property of ['font-family', 'font-size', 'line-height', 'background']) assert.equal(reader[property], editor[property]);
});

test('CodeMirror virtualization gaps are not hidden or resized by application CSS', () => {
  for (const path of ['src/presentation/still01/still.css', 'src/presentation/still01/editor/cmLivePreview.css', 'src/presentation/still01/editor/noteTypography.css']) {
    rules(read(path)).forEach(rule => assert.doesNotMatch(rule.selector, /\.cm-gap\b/, path));
  }
});


test('note styles retain Chrome 83 selectors and matching wrapped code', () => {
  assert.doesNotMatch(css, /:(?:is|where|has)\(/);
  assert.doesNotMatch(css, /@(?:container|layer)|color-mix\(|\b(?:subgrid|text-wrap|overflow:clip)\b/);
  const reader = declarations('.st-note-surface .st-safe-note-markdown pre');
  const editor = declarations('.st-note-surface .st-note-editor.is-cm .cm-line.cm-lp-code');
  for (const property of ['white-space', 'overflow-wrap', 'word-break']) assert.equal(reader[property], editor[property]);
  assert.equal(reader['white-space'], 'pre-wrap');
});
