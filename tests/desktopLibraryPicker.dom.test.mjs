// Run with DOM tools available (jsdom + esbuild). For an isolated tool install:
// LR_DOM_TEST_TOOLS=/path/to/tool/node_modules node --test tests/desktopLibraryPicker.dom.test.mjs
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

test('saved libraries live inside the production directory sheet: stable selection, keyboard, refresh race and owner fences', async () => {
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
    let holdCatalog = false, catalogResolve, catalogError = false, emptyCatalog = false, failAssets = false;
    let deniedA = false;
    const longName = '参考素材'.repeat(40);
    const catalog = () => ({scopeSelectionVersion:1,materials:emptyCatalog ? [] : [
      {libraryId:'a',displayName:'日常素材',activeInDesktop:true,available:true,readGranted:!deniedA,writeGranted:true},
      {libraryId:'b',displayName:longName,activeInDesktop:false,available:true,readGranted:true,writeGranted:false},
      {libraryId:'unavailable',displayName:'已移除',available:false,readGranted:true},
      {libraryId:'denied',displayName:'未授权',available:true,readGranted:false}],
      knowledge:[{vaultId:'v1',displayName:'工作笔记',activeInDesktop:true,available:true,readGranted:true,writeGranted:true},
      {vaultId:'v2',displayName:'生活笔记',available:true,readGranted:true,writeGranted:true}]});
    globalThis.__r8Api = new Proxy({}, { get: (_, name) => async (...args) => {
      if (name === 'contentLibraryCatalog') { if(catalogError) throw Error('NETWORK'); if(holdCatalog) return new Promise(resolve=>catalogResolve=()=>resolve(catalog())); return catalog(); }
      if (name === 'localNoteList') return {items:[],total:0,hasMore:false};
      if (name === 'localNoteTags' || name === 'contentReplicaLibraries') return [];
      if (name === 'localNoteFolders') return {paths:[]};
      if (name === 'contentScopeChanged') { calls.push({retire:args}); return {}; }
      if (name === 'contentNavigation') {
        const owner = args[0];
        if (holdNavigation) return new Promise(resolve => pending.push({ owner, resolve }));
        return { folders: [{ id: owner + '-folder', name: owner + '目录' }], tags: [{ id: owner + '-tag', name: owner + '标签' }] };
      }
      if (name === 'contentAssets') { if(failAssets) throw Error('NETWORK'); calls.push({ owner: args[0], library:args[2], ...args[1] }); return { items: [], hasMore: false, page: 1 }; }
      if (name === 'localAssetList') return { items: [], total: 0, hasMore: false };
      if (name === 'localAssetTags') return { tags: [] };
      return {};
    }});
    const out = join(dir, 'entry.cjs');
    await build({ stdin: { contents: `import React, { act } from 'react'; import { createRoot } from 'react-dom/client'; import { StillLibrary } from './src/still/StillLibrary'; import { StillKnowledge } from './src/still/StillCollection'; export {desktopLibraries} from './src/services/desktopLibraries'; export { React, act, createRoot, StillLibrary, StillKnowledge };`, resolveDir: root, loader: 'tsx' }, outfile: out, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', plugins: [{ name: 'boundaries', setup(b) {
      b.onResolve({ filter: /fixture\.mjs$/ }, args => ({path:resolve(args.resolveDir,args.path),external:true}));
      b.onResolve({ filter: /services\/client$/ }, () => ({ path: 'client', namespace: 'r8-mock' }));
      b.onResolve({ filter: /StillShell$/ }, () => ({ path: 'nav', namespace: 'r8-mock' }));
      b.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'core', namespace: 'r8-mock' }));
      b.onLoad({ filter: /.*/, namespace: 'r8-mock' }, ({ path }) => ({ contents: path === 'client' ? 'export const api = globalThis.__r8Api; export const materialApi = library => new Proxy({}, {get:(_,name)=>(...args)=>api[name](...args,library)});' : path === 'nav' ? 'const nav = { open(){}, registerOverlay(){ return () => {}; } }; export const useStillNav = () => nav;' : `
        export const convertFileSrc = x => x;
        export const invoke = async command => {
          if (command === 'managed_vault_list') return {items: [], selectedVaultId: null};
          if (command === 'managed_vault_migration_status') return {state: 'not-migrated', localVaultId: 'local', noteCount: 0, warnings: []};
          throw Error('Unexpected native command in legacy saved-library regression: ' + command);
        };`, loader: 'js' }));
    }}] });
    const { React, act, createRoot, StillLibrary, StillKnowledge, desktopLibraries } = require(out);
    app = createRoot(document.getElementById('root'));
    const connection = id => ({ paired: true, identity: { instanceId: id }, ws: { state: 'connected' } });
    const render = async (id, state = 'connected') => { await act(async () => { app.render(React.createElement(StillLibrary, { conn: {...connection(id), ws: {state}} })); }); };
    const wait = async (ms = 230) => { await act(async () => { await new Promise(r => setTimeout(r, ms)); }); };
    const button = label => [...document.querySelectorAll('button')].find(b => !b.closest('[hidden]') && (b.getAttribute('aria-label') === label || b.textContent.startsWith(label)));
    const click = async label => { const el = button(label); assert.ok(el, `button ${label} exists`); await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); };
    const escape = async () => { await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }); await wait(15); };
    const selected = label => button(label)?.getAttribute('aria-pressed') === 'true';
    await render('A'); await wait(); await click('电脑'); await wait();
    assert.equal(calls.filter(c=>c.page).at(-1).library,'a');
    const beforeReconnect = calls.filter(c=>c.page).length;
    await render('A', 'disconnected'); await wait(20);
    await render('A'); await wait();
    assert.equal(calls.filter(c=>c.page).length, beforeReconnect + 1,
      'same-owner reconnect revalidates even when catalog scopes and grants did not change');
    assert.equal(calls.filter(c=>c.page).at(-1).library, 'a');
    const assertHeader = () => {
      assert.equal(document.querySelector('.st-library-choice'), null, 'no extra saved library header row');
      const header = document.querySelector('.st-collection-head');
      assert(header.nextElementSibling.classList.contains('st-collection-top'), 'search follows original header directly');
    };
    assertHeader();
    await click('目录');
    assert.deepEqual([...document.querySelectorAll('[role="tab"]')].map(b=>b.textContent), ['目录','库']);
    assert.equal(document.querySelectorAll('.st-sheet').length, 1);
    await wait(30);
    const directoryTab = document.querySelector('[role="tab"]');
    await act(async()=>directoryTab.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})));
    assert.equal(document.activeElement.textContent, '库');
    assert.equal(document.activeElement.getAttribute('aria-selected'), 'true');
    assert.ok(button(longName));
    assert.equal(button('已移除').disabled,true); assert.equal(button('未授权').disabled,true);
    await escape();
    assert.equal(document.querySelector('.st-sheet'),null,'Back dismisses directory sheet without changing library');
    assert.equal(calls.filter(c=>c.page).at(-1).library,'a');
    await click('目录');
    holdCatalog=true; await click('库');
    assert.equal(button(longName).disabled,true,'rows cannot race a pending catalog refresh');
    await act(async()=>button(longName).dispatchEvent(new MouseEvent('click',{bubbles:true})));
    assert.equal(calls.filter(c=>c.retire).length,0);
    holdCatalog=false; await act(async()=>catalogResolve());
    const stableSheet=document.querySelector('.st-sheet');
    await click(longName); await wait();
    assert.strictEqual(document.querySelector('.st-sheet'),stableSheet,'successful selection never remounts or dismisses sheet');
    assert(selected(longName)); assertHeader();
    assert.equal(calls.filter(c=>c.page).at(-1).library,'b');
    // Choose a real folder in B, then reconnect without losing that filter.
    await act(async()=>document.querySelector('[role="tab"]').dispatchEvent(new MouseEvent('click',{bubbles:true})));
    await wait(30); await click('A目录'); await wait();
    assert.equal(calls.filter(c=>c.page).at(-1).folder,'A-folder');
    // Selected B survives same-owner reconnect; never revert to desktop-active A.
    const beforeBReconnect = calls.filter(c=>c.page).length;
    await render('A', 'disconnected'); await wait(20);
    await render('A'); await wait();
    assert.equal(calls.filter(c=>c.page).length,beforeBReconnect+1);
    assert.equal(calls.filter(c=>c.page).at(-1).library,'b');
    assert.equal(calls.filter(c=>c.page).at(-1).folder,'A-folder');
    await click('目录'); await click('库');
    assert(selected(longName));
    const beforePartial = calls.filter(c=>c.page).length;
    await render('A', null); await wait(20); await render('A'); await wait(20);
    assert.equal(calls.filter(c=>c.page).length,beforePartial,'partial connection snapshots do not invent reconnect edges');
    const retireAt=calls.findIndex(c=>c.retire), readAt=calls.findIndex(c=>c.library==='b');
    assert.ok(retireAt>=0 && readAt>retireAt,'old scope retires before first selected-library read');
    await render('B'); await wait();
    assert.equal(document.querySelector('.st-sheet'),null,'owner change dismisses old scope sheet');
    assert.equal(calls.filter(c=>c.owner==='B'&&c.page).at(-1).library,'a','other desktop has independent selection');
    // A failed / unauthorized active scope must not hide the way to select another library.
    deniedA=true; failAssets=true;
    await act(async()=>desktopLibraries.refresh('B',globalThis.__r8Api.contentLibraryCatalog)); await wait();
    await click('目录'); await click('库');
    assert.equal(button('日常素材').disabled,true);
    await click(longName); await wait();
    assert(selected(longName)); assert.strictEqual(document.querySelectorAll('.st-sheet').length,1);
    catalogError=true; await click('刷新库');
    assert.ok(button('重试读取库')); assert.equal(document.querySelectorAll('.st-sheet').length,1);
    catalogError=false; emptyCatalog=true; await click('重试读取库');
    assert.match(document.querySelector('[role="tabpanel"]:not([hidden])').textContent,/还没有可用的库/);
    await escape(); emptyCatalog=false; failAssets=false; deniedA=false;
    await click('本机'); await click('浏览本机素材');
    assert.equal(document.querySelector('[role="tablist"]'),null,'local directory never offers remote libraries');
    await escape();
    // The actual Knowledge page uses the same directory sheet, not a separate picker.
    await act(async()=>app.render(React.createElement(StillKnowledge,{conn:connection('K')}))); await wait();
    await click('选择知识库'); await click('整理为本地笔记库'); await wait();
    assert.equal(document.querySelectorAll('[role="dialog"]').length,1,'migration replaces source sheet instead of leaving two focus traps');
    assert.match(document.querySelector('[role="dialog"]').textContent,/预览整理计划/);
    await escape(); await wait();
    // Notes/Graph now owns the header; legacy source selection remains in Directory.
    await click('选择知识库'); await click('LuckyRay 电脑知识库'); await wait(); assertHeader();
    await click('目录');
    assert.ok(button('本机笔记'),'source-management control retained inside directory');
    assert.match(document.querySelector('.st-sheet').textContent,/手机保存/,'replica controls retained inside directory');
    await click('库');
    assert.ok(button('生活笔记'));
    const knowledgeSheet=document.querySelector('.st-sheet');
    await click('生活笔记'); await wait();
    assert(selected('生活笔记'));
    assert.strictEqual(document.querySelector('.st-sheet'),knowledgeSheet,'knowledge selection preserves same sheet');
    assertHeader();
    await escape();
    await act(async () => app.unmount()); app = null;
  } finally {
    if (app) await require(join(dir, 'entry.cjs')).act(async()=>app.unmount());
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
