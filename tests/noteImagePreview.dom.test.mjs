// LR_DOM_TEST_TOOLS=/path/to/node_modules node --test tests/noteImagePreview.dom.test.mjs
// Real React component; jsdom models dialog API only (not WebView focus layout).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
const require = process.env.LR_DOM_TEST_TOOLS ? createRequire(join(resolve(process.env.LR_DOM_TEST_TOOLS), '_test.cjs')) : createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
test('image opens separately; button, cancel, backdrop and navigation Back dismiss without replacing inline image', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://test.invalid/', pretendToBeVisual: true });
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent'];
  const prior = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const server = await createServer({ configFile: false, appType: 'custom', optimizeDeps: { noDiscovery: true, entries: [] }, server: {middlewareMode: true, watch: null, hmr: false}, esbuild: {jsx: 'automatic'} });
  let root;
  try {
    const { createElement, act } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { NoteImagePreview } = await server.ssrLoadModule('/src/components/NoteImagePreview.tsx');
    root = createRoot(document.getElementById('root'));
    let back, unregistered = 0;
    const registerOverlay = callback => { back = callback; return () => { back = undefined; unregistered++; }; };
    await act(async () => root.render(createElement(NoteImagePreview, {source: 'asset://verified/image', label: '中文.png', registerOverlay})));
    const trigger = document.querySelector('.st-note-image-trigger'), image = trigger.querySelector('img');
    let focusOptions;
    trigger.focus = options => { focusOptions = options; };
    const click = async element => { await act(async () => element.dispatchEvent(new MouseEvent('click', {bubbles: true}))); };
    for (const dismissal of ['close', 'cancel', 'backdrop', 'back']) {
      await click(trigger);
      const dialog = document.querySelector('dialog'); assert.ok(dialog?.open);
      assert.equal(trigger.querySelector('img'), image);
      assert.equal(dialog.parentNode, document.body);
      if (dismissal === 'close') await click(dialog.querySelector('button'));
      if (dismissal === 'cancel') await act(async () => dialog.dispatchEvent(new Event('cancel', {cancelable: true})));
      if (dismissal === 'backdrop') await click(dialog);
      if (dismissal === 'back') await act(async () => back());
      assert.equal(document.querySelector('dialog'), null);
      assert.equal(trigger.querySelector('img'), image);
      assert.deepEqual(focusOptions, {preventScroll: true});
    }
    assert.equal(unregistered, 4);
    delete dom.window.HTMLDialogElement.prototype.showModal;
    delete dom.window.HTMLDialogElement.prototype.close;
    await click(trigger);
    assert.equal(document.querySelector('dialog').getAttribute('data-modal-fallback'), 'true');
    await act(async () => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {key: 'Escape', bubbles: true})));
    assert.equal(document.querySelector('dialog'), null);
    assert.equal(unregistered, 5);
  } finally {
    if (root) { const { act } = await import('react'); await act(async () => root.unmount()); }
    await server.close(); dom.window.close();
    for (const [key, descriptor] of prior) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
