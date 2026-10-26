// Validate the production artifact: source fallbacks alone are insufficient
// if CSS minimization removes them beside an unsupported inset shorthand.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
const assets = new URL('../dist/assets/', import.meta.url);
const names = (await readdir(assets)).filter(name => /^index-.*\.css$/.test(name));
assert.equal(names.length, 1, 'Run the production Vite build first');
const css = await readFile(new URL(names[0], assets), 'utf8');
function declarations(selector) {
  const start = css.indexOf(selector + '{');
  assert.ok(start >= 0, selector);
  const body = css.slice(start + selector.length + 1, css.indexOf('}', start));
  return new Map(body.split(';').filter(Boolean).map(item => {
    const at = item.indexOf(':');
    return [item.slice(0, at), item.slice(at + 1)];
  }));
}
const base = declarations('.st-note-drawer');
assert.equal(base.get('position'), 'absolute');
for (const side of ['top', 'bottom', 'left']) assert.equal(base.get(side), '0', side);
assert.equal(base.get('right'), 'auto');
assert.equal(base.has('inset'), false, 'Legacy drawer must keep physical edges after minimization');
const right = declarations('.side-right .st-note-drawer');
assert.equal(right.get('right'), '0');
assert.equal(right.get('left'), 'auto');
assert.equal(right.has('inset'), false);
console.log(JSON.stringify({ result: 'PASS', artifact: names[0],
  checks: ['full-height physical edges', 'right drawer anchoring', 'no unsupported multi-value inset after minification'],
  boundary: 'Production CSS artifact regression; Android layout still needs native verification' }));
