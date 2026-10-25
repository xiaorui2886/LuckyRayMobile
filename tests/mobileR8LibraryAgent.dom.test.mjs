// Run with DOM tools available (jsdom + esbuild). For an isolated tool install:
// LR_DOM_TEST_TOOLS=/path/to/tool/node_modules node --test tests/mobileR8LibraryAgent.dom.test.mjs
// Only native API and navigation boundaries are mocked; real StillLibrary,
// CollectionView, Sheet, Option, hooks, request authority, and React DOM run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const toolRequire = process.env.LR_DOM_TEST_TOOLS
  ? createRequire(join(resolve(process.env.LR_DOM_TEST_TOOLS), '__harness__.cjs')) : require;
const { JSDOM } = toolRequire('jsdom');
const { build, stop } = createRequire(require.resolve('vite/package.json'))('esbuild');

test('R8 real library filter DOM: draft/cancel/apply/reset, owner change and late vocabulary', async () => {
  const dom = new JSDOM('<div class="st-app" data-reduced="true"><div id="root"></div></div>', { url: 'https://test.invalid/', pretendToBeVisual: true });
  const channels = [];
  const OriginalMessageChannel = globalThis.MessageChannel;
  globalThis.MessageChannel = class extends OriginalMessageChannel {
    constructor() { super(); channels.push(this); }
  };
  const keys = ['window','document','navigator','HTMLElement','Element','Node','Event','MouseEvent','KeyboardEvent','CustomEvent','MutationObserver','localStorage'];
  const prior = new Map(keys.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: dom.window[key] });
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  const dir = mkdtempSync(join(tmpdir(), 'lr-r8-dom-'));
  let app;
  try {
    const calls = [];
    const pending = [];
    let holdNavigation = false;
    globalThis.__r8Api = new Proxy({}, { get: (_, name) => async (...args) => {
      if (name === 'contentLibraryCatalog') return {scopeSelectionVersion:0,materials:[],knowledge:[]};
      if (name === 'contentNavigation') {
        const owner = args[0];
        if (holdNavigation) return new Promise(resolve => pending.push({ owner, resolve }));
        return { folders: [{ id: owner + '-folder', name: owner + '目录' }], tags: [{ id: owner + '-tag', name: owner + '标签' }] };
      }
      if (name === 'contentAssets') { calls.push({ owner: args[0], ...args[1] }); return { items: [], hasMore: false, page: 1 }; }
      if (name === 'localAssetList') return { items: [], total: 0, hasMore: false };
      if (name === 'localAssetTags') return { tags: [] };
      return {};
    }});
    const out = join(dir, 'entry.cjs');
    await build({ stdin: { contents: `import React, { act } from 'react'; import { createRoot } from 'react-dom/client'; import { StillLibrary } from './src/still/StillLibrary'; export { React, act, createRoot, StillLibrary };`, resolveDir: root, loader: 'tsx' }, outfile: out, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', plugins: [{ name: 'boundaries', setup(b) {
      b.onResolve({ filter: /services\/client$/ }, () => ({ path: 'client', namespace: 'r8-mock' }));
      b.onResolve({ filter: /StillShell$/ }, () => ({ path: 'nav', namespace: 'r8-mock' }));
      b.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'core', namespace: 'r8-mock' }));
      b.onLoad({ filter: /.*/, namespace: 'r8-mock' }, ({ path }) => ({ contents: path === 'client' ? 'export const api = globalThis.__r8Api; export const materialApi = library => new Proxy({}, {get:(_,name)=>(...args)=>api[name](...args,library)});' : path === 'nav' ? 'const nav = { open(){}, registerOverlay(){ return () => {}; } }; export const useStillNav = () => nav;' : 'export const convertFileSrc = x => x; export const invoke = async () => ({});', loader: 'js' }));
    }}] });
    const { React, act, createRoot, StillLibrary } = require(out);
    app = createRoot(document.getElementById('root'));
    const connection = id => ({ paired: true, identity: { instanceId: id }, ws: { state: 'connected' } });
    const render = async id => { await act(async () => { app.render(React.createElement(StillLibrary, { conn: connection(id) })); }); };
    const wait = async (ms = 230) => { await act(async () => { await new Promise(r => setTimeout(r, ms)); }); };
    const button = label => [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === label || b.textContent === label);
    const click = async label => { const el = button(label); assert.ok(el, `button ${label} exists`); await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); };
    const escape = async () => { await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }); await wait(15); };
    const selected = label => button(label)?.getAttribute('aria-pressed') === 'true';
    await render('A'); await wait(); await click('电脑'); await wait();
    await click('筛选与排序'); await click('#A标签');
    assert.ok(selected('#A标签')); assert.ok(!calls.at(-1).tag, 'draft does not query');
    await escape(); assert.equal(document.querySelector('.st-sheet'), null);
    await click('筛选与排序'); assert.ok(selected('全部标签'), 'cancel discards draft');
    await click('#A标签'); await click('显示结果'); await wait();
    assert.equal(calls.at(-1).tag, 'A-tag'); assert.match(document.querySelector('.st-compact-toolbar').textContent, /#A标签/);
    await click('筛选与排序'); assert.ok(selected('#A标签'), 'reopen retains applied tag');
    await click('恢复默认'); assert.ok(selected('全部标签')); assert.equal(calls.at(-1).tag, 'A-tag', 'reset remains a draft');
    await escape(); await click('筛选与排序'); assert.ok(selected('#A标签'));
    await click('恢复默认'); await click('显示结果'); await wait(); assert.ok(!calls.at(-1).tag, 'apply commits reset');
    await click('目录'); assert.equal(button('全部标签'), undefined, 'directory has no tag controls'); await click('A目录'); await wait(); assert.equal(calls.at(-1).folder, 'A-folder');
    await click('筛选与排序'); await click('#A标签'); await click('显示结果'); await wait();
    holdNavigation = true; await click('筛选与排序'); assert.equal(pending.length, 1);
    await render('B'); await wait();
    assert.equal(document.querySelector('.st-sheet'), null, 'owner switch closes draft');
    const bCalls = calls.filter(c => c.owner === 'B'); assert.ok(bCalls.length > 0);
    assert.ok(bCalls.every(c => !c.tag && !c.folder), 'not even first B request receives A IDs');
    await act(async () => { pending[0].resolve({ tags: [{ id: 'late-A', name: '过期A标签' }], folders: [] }); });
    holdNavigation = false; await click('筛选与排序');
    assert.ok(selected('全部标签')); assert.ok(button('#B标签')); assert.equal(button('#A标签'), undefined); assert.equal(button('#过期A标签'), undefined);
    await act(async () => app.unmount()); app = null;
  } finally {
    if (app) app.unmount();
    dom.window.close();
    // React act creates MessageChannels in its browser build; close only the
    // channels this test created, after all work and unmount have completed.
    for (const channel of channels) { channel.port1.close(); channel.port2.close(); }
    globalThis.MessageChannel = OriginalMessageChannel;
    stop(); rmSync(dir, { recursive: true, force: true });
    for (const key of keys) { const old = prior.get(key); if (old) Object.defineProperty(globalThis, key, old); else delete globalThis[key]; }
    delete globalThis.__r8Api; delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
