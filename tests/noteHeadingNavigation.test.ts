import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as headings from '../src/still/kit/noteHeadings.ts';

// Execute the real hook with a tiny deterministic effect/state scheduler.
// This does not claim DOM geometry or device IME coverage.
function harness() {
  const slots: any[] = [], effects: (() => void)[] = [], listeners = new Map(), frames = new Map();
  let index = 0, frameId = 0;
  const react = {
    useRef(value: any) { const at = index++; return slots[at] ??= { current: value }; },
    useState(value: any) { const at = index++; if (!(at in slots)) slots[at] = value; return [slots[at], (v: any) => { slots[at] = v; }]; },
    useEffect(callback: () => void, deps: any[]) {
      const at = index++, old = slots[at];
      if (!old || deps.some((v, i) => v !== old[i])) { slots[at] = deps; effects.push(callback); }
    },
  };
  class Target { closest() { return true; } }
  const source = readFileSync(new URL('../src/still/kit/useNoteHeadingNavigation.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} as any };
  Function('require', 'module', 'exports', 'document', 'Element', 'requestAnimationFrame', 'cancelAnimationFrame', code)(
    (id: string) => id === 'react' ? react : headings, module, module.exports,
    { addEventListener: (event: string, fn: any) => listeners.set(event, fn), removeEventListener: (event: string) => listeners.delete(event) }, Target,
    (fn: () => void) => { frames.set(++frameId, fn); return frameId; }, (id: number) => frames.delete(id));
  let clears = 0, closes = 0; const notices: string[] = [], scrolls: number[] = [];
  const options: any = { body: '# First\r\n\r\n## 中文', current: true, ready: true, mode: 'read', composing: () => false,
    editor: () => ({ getValue: () => '# First\n\n## 中文', isComposing: () => false, compositionStarted: () => false,
      scrollToSource: (value: number) => scrolls.push(value) }),
    clearSearch: () => clears++, closeSheet: () => closes++, notice: (value: string) => notices.push(value) };
  return { options, notices, scrolls, pendingFrames: () => frames.size, counts: () => [clears, closes],
    render() { index = 0; const result = module.exports.useNoteHeadingNavigation(options); effects.splice(0).forEach(fn => fn()); return result; },
    end() { listeners.get('compositionend')?.({ target: new Target() }); },
    tick() { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); },
  };
}
test('heading read intent is consumed once, not replayed by body update or Back reveal', () => {
  const h = harness(); h.options.intent = { fragment: '中文' }; h.render();
  const read = h.render(); assert.equal(read.readingHeading.offset, h.options.body.indexOf('##'));
  read.consumeReadingHeading(); h.options.current = false; h.render();
  h.options.body += '\nmore'; h.options.current = true; assert.equal(h.render().readingHeading, undefined);
  assert.deepEqual(h.counts(), [1, 1]);
});
test('edit heading scroll maps CRLF but never changes mode, document or selection', () => {
  const h = harness(); h.options.mode = 'edit'; h.options.intent = { fragment: '中文' }; h.render();
  assert.deepEqual(h.scrolls, [9]); assert.equal(h.options.mode, 'edit'); assert.deepEqual(h.counts(), [1, 1]);
});
test('IME end retries without a body change and honors the latest intent', () => {
  const h = harness(); let composing = true; h.options.composing = () => composing;
  h.options.intent = { fragment: 'First' }; h.render(); h.end(); h.tick(); assert.deepEqual(h.counts(), [0, 0]);
  h.options.intent = { fragment: '中文' }; h.render(); composing = false; h.tick();
  assert.equal(h.render().readingHeading.offset, h.options.body.indexOf('##')); assert.deepEqual(h.counts(), [1, 1]);
});
test('inactive or unloaded owners cannot scroll; missing heading reports truth without jumping', () => {
  const h = harness(); h.options.current = false; h.options.intent = { fragment: 'missing' }; h.render();
  assert.equal(h.notices.length, 0); h.options.current = true; h.options.ready = false; h.render(); assert.equal(h.notices.length, 0);
  h.options.ready = true; h.render(); assert.equal(h.notices.length, 1); assert.equal(h.render().readingHeading, undefined);
  assert.deepEqual(h.counts(), [0, 0]);
});

test('stuck composition stops after two frames, and a later legitimate end can retry', () => {
  const h = harness(); let composing = true; h.options.composing = () => composing;
  h.options.intent = { fragment: 'First' }; h.render(); h.end();
  for (let i = 0; i < 100; i++) h.tick();
  assert.equal(h.pendingFrames(), 0); assert.deepEqual(h.counts(), [0, 0]); assert.equal(h.notices.length, 1);
  composing = false; h.end(); h.tick(); assert.equal(h.render().readingHeading.offset, 0);
});
test('temporarily missing editor does not consume the route intent', () => {
  const h = harness(); h.options.mode = 'edit'; const editor = h.options.editor;
  h.options.editor = () => null; h.options.intent = { fragment: 'First' }; h.render();
  assert.deepEqual(h.counts(), [0, 0]); assert.equal(h.scrolls.length, 0);
  h.options.ready = false; h.render(); h.options.editor = editor; h.options.ready = true; h.render();
  assert.deepEqual(h.scrolls, [0]); assert.deepEqual(h.counts(), [1, 1]);
});
