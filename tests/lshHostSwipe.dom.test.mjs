// Pure React + jsdom host-event integration. No browser, socket or native view.
// Only transport, the shell hook and decorative UI are mocked. The production
// EmbeddedLshView, LshEmbeddedController, RootSwipeContext and overlayStack run.
// This does not verify Android gesture recognition or actual WebView delivery.
// LR_DOM_TEST_TOOLS=/path/to/tools/node_modules node --test tests/lshHostSwipe.dom.test.mjs
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
const ready = { opened: true, visible: true, ready: true, canGoBack: false };
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test('real LSH host accepts only current, ready, visible, sole-owner native swipe events', async t => {
  const dom = new JSDOM('<div class="st-app"><div id="root"></div></div>', {
    url: 'https://test.invalid/', pretendToBeVisual: true,
  });
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node',
    'MutationObserver', 'ResizeObserver', 'getComputedStyle', 'requestAnimationFrame',
    'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT', '__lshHostApi', '__lshHostNav'];
  const prior = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const setGlobal = (key, value) => Object.defineProperty(globalThis, key, {
    configurable: true, writable: true, value,
  });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver']) {
    setGlobal(key, dom.window[key]);
  }
  setGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  setGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const frames = new Map();
  let nextFrame = 0;
  setGlobal('requestAnimationFrame', fn => { frames.set(++nextFrame, fn); return nextFrame; });
  setGlobal('cancelAnimationFrame', id => frames.delete(id));
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // Production clears window timers through the global clear functions. Keep
  // one timer realm here so effect cleanup also cancels jsdom-hosted timers.
  dom.window.setInterval = globalThis.setInterval.bind(globalThis);
  dom.window.setTimeout = globalThis.setTimeout.bind(globalThis);
  let visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
    x: 0, y: 24, left: 0, right: 360, top: 24, bottom: 624, width: 360, height: 600,
    toJSON() { return this; },
  });
  const channels = [];
  const OriginalMessageChannel = globalThis.MessageChannel;
  globalThis.MessageChannel = class extends OriginalMessageChannel {
    constructor() { super(); channels.push(this); }
  };
  const dir = mkdtempSync(join(tmpdir(), 'lr-lsh-host-'));
  const calls = [], bootstraps = [], navigations = [], owners = [];
  const outstanding = new Set();
  let receipt = ready;
  let holdAction = null;
  let backCount = 0;
  let app, bundle;
  setGlobal('__lshHostApi', {
    async lshSurfaceBootstrap(owner) { bootstraps.push(owner); return { sessionUrl: 'opaque-test-capability' }; },
    async lshSurfaceEmbed(request) {
      calls.push(request);
      if (holdAction === request.action) {
        const held = deferred();
        outstanding.add(held);
        return held.promise.finally(() => outstanding.delete(held));
      }
      return receipt;
    },
  });
  try {
    const out = join(dir, 'entry.cjs');
    await build({
      stdin: { contents: `
        export { act, createElement } from 'react';
        export { createRoot } from 'react-dom/client';
        export { EmbeddedLshView, retireEmbeddedLsh } from './src/still/kit/EmbeddedLshView';
        export { RootSwipeContext } from './src/still/kit/useHorizontalSwipe';
        export { overlayStack } from './src/services/overlayStack';
      `, resolveDir: root, loader: 'tsx' },
      outfile: out, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic',
      loader: { '.css': 'empty' },
      plugins: [{ name: 'lsh-host-boundaries', setup(b) {
        b.onResolve({ filter: /services\/client$/ }, () => ({ path: 'api', namespace: 'lsh-host-mock' }));
        b.onResolve({ filter: /StillShell$/ }, () => ({ path: 'nav', namespace: 'lsh-host-mock' }));
        b.onResolve({ filter: /StillImports$/ }, () => ({ path: 'ui', namespace: 'lsh-host-mock' }));
        b.onLoad({ filter: /.*/, namespace: 'lsh-host-mock' }, ({ path }) => ({
          contents: path === 'api' ? 'export const api = globalThis.__lshHostApi;'
            : path === 'nav' ? 'export const useStillNav = () => globalThis.__lshHostNav;'
            : `import { createElement } from 'react';
               export const Button = ({ children, kind, ...props }) => createElement('button', props, children);
               export const Empty = ({ children, title, body }) => createElement('div', null, title, body, children);`,
          resolveDir: root, loader: 'js',
        }));
      } }],
    });
    bundle = require(out);
    const { act, createElement: h, createRoot, EmbeddedLshView, retireEmbeddedLsh, RootSwipeContext, overlayStack } = bundle;
    setGlobal('__lshHostNav', {
      mode: 'light',
      registerOverlay(owner) { owners.push(owner); return overlayStack.push(owner); },
      back() { backCount += 1; },
    });
    const rootSwipe = {
      canNavigate: () => false, // Native Back ownership makes ordinary root swipe unavailable.
      navigate() { assert.fail('native events must use the LSH-specific hand-off'); },
      navigateLsh(direction, owner) { navigations.push({ direction, owner }); },
    };
    const settle = async () => { for (let i = 0; i < 32; i++) await Promise.resolve(); };
    const flush = async () => act(async () => { await settle(); });
    const frame = async () => act(async () => {
      const pending = [...frames.values()]; frames.clear();
      for (const fn of pending) fn(0);
      await settle();
    });
    const render = async (active = true, owner = 'desktop-A') => {
      if (!app) app = createRoot(document.getElementById('root'));
      await act(async () => app.render(h(RootSwipeContext.Provider, { value: rootSwipe },
        h(EmbeddedLshView, { active, owner }))));
    };
    const phase = () => document.querySelector('.st-lsh-embedded')?.dataset.lshPhase;
    const lastPresentation = () => calls.findLast(call => call.action === 'open' || call.action === 'layout');
    const eventDetail = (gestureId = 1, direction = 'left', request = lastPresentation()) => ({
      direction, gestureId, presentationId: request?.presentationId,
      presentationActivation: request?.presentationActivation,
    });
    const swipe = async detail => act(async () => {
      window.dispatchEvent(new window.CustomEvent('luckyray-lsh-tab-swipe', { detail }));
      await settle();
    });
    const makeReady = async () => { await render(); await frame(); assert.equal(phase(), 'ready'); };
    const resolveHeld = async (result = ready) => {
      holdAction = null;
      await act(async () => { for (const held of outstanding) held.resolve(result); await settle(); });
    };
    const reset = async () => {
      await resolveHeld();
      if (app) { await act(async () => app.unmount()); app = null; }
      await act(async () => { await retireEmbeddedLsh(); });
      overlayStack.clear(); frames.clear();
      calls.length = 0; bootstraps.length = 0; navigations.length = 0; owners.length = 0;
      receipt = ready; visibility = 'visible'; backCount = 0;
    };

    await t.test('inactive and loading hosts cannot forward events; ready uses its actual Back owner', async () => {
      await render(false); await frame();
      assert.equal(phase(), 'idle'); assert.equal(bootstraps.length, 0); assert.equal(overlayStack.depth(), 0);
      await swipe(eventDetail()); assert.equal(navigations.length, 0);
      holdAction = 'open'; await render(); await frame();
      assert.equal(phase(), 'loading'); assert.equal(overlayStack.depth(), 0);
      const detail = eventDetail();
      await swipe(detail); assert.equal(navigations.length, 0);
      await resolveHeld(); assert.equal(phase(), 'ready');
      assert.equal(overlayStack.depth(), 1);
      await swipe(detail);
      assert.equal(navigations.length, 1);
      assert.equal(navigations[0].direction, 'left');
      assert.equal(navigations[0].owner, owners.at(-1));
      assert.ok(overlayStack.isOnly(navigations[0].owner));
    });
    await reset();

    await t.test('malformed, foreign, duplicate and out-of-order gestures are rejected at the real controller', async () => {
      await makeReady();
      const detail = eventDetail(3);
      for (const bad of [null, {}, { ...detail, direction: 'up' },
        { ...detail, presentationId: 'another-presentation' }, { ...detail, presentationActivation: 0 },
        { ...detail, gestureId: 0 }, { ...detail, gestureId: NaN }, { ...detail, gestureId: 1.5 },
        { ...detail, gestureId: Number.MAX_SAFE_INTEGER + 1 }]) await swipe(bad);
      assert.equal(navigations.length, 0);
      await swipe(detail); await swipe(detail); await swipe({ ...detail, gestureId: 2 });
      assert.equal(navigations.length, 1);
      await swipe({ ...detail, direction: 'right', gestureId: 4 });
      assert.deepEqual(navigations.map(item => item.direction), ['left', 'right']);
    });
    await reset();

    await t.test('hidden pages revoke acceptance; restored activation waits for a visible layout receipt', async () => {
      await makeReady(); const old = eventDetail(9);
      visibility = 'hidden';
      await swipe(old); assert.equal(navigations.length, 0, 'visibility guard works even before visibilitychange');
      await act(async () => { document.dispatchEvent(new window.Event('visibilitychange')); await settle(); });
      assert.equal(calls.at(-1).action, 'hide');
      visibility = 'visible'; holdAction = 'layout';
      await act(async () => document.dispatchEvent(new window.Event('visibilitychange')));
      await frame(); const current = eventDetail();
      assert.equal(current.presentationId, old.presentationId, 'retains the same native presentation');
      assert.notEqual(current.presentationActivation, old.presentationActivation);
      assert.equal(phase(), 'ready', 'retained phase alone must not grant the new activation');
      await swipe(old); await swipe(current); assert.equal(navigations.length, 0);
      await resolveHeld(); await swipe(old); assert.equal(navigations.length, 0);
      await swipe(current); assert.equal(navigations.length, 1);
      assert.equal(bootstraps.length, 1, 'returning does not duplicate the session bootstrap');
    });
    await reset();

    await t.test('active false retires Back ownership and old gestures; reactivation grants a new epoch', async () => {
      await makeReady(); const old = eventDetail(5);
      await render(false); await flush();
      assert.equal(overlayStack.depth(), 0);
      await swipe(old); assert.equal(navigations.length, 0);
      holdAction = 'layout'; await render(); await frame();
      const current = eventDetail();
      assert.notEqual(current.presentationActivation, old.presentationActivation);
      await swipe(old); await swipe(current); assert.equal(navigations.length, 0);
      await resolveHeld(); await swipe(old); assert.equal(navigations.length, 0);
      await swipe(current); assert.equal(navigations.length, 1);
    });
    await reset();

    await t.test('an extra overlay or a different sole owner blocks swipes without consuming their IDs', async () => {
      await makeReady(); const owner = owners.at(-1), detail = eventDetail();
      const removeOverlay = overlayStack.push(() => {});
      await swipe(detail); assert.equal(navigations.length, 0);
      removeOverlay(); await swipe(detail); assert.equal(navigations.length, 1);
      assert.equal(navigations[0].owner, owner);
      overlayStack.clear(); const removeOther = overlayStack.push(() => {});
      await swipe(eventDetail(2)); assert.equal(navigations.length, 1, 'depth one is insufficient without matching owner');
      removeOther(); await swipe(eventDetail(2)); assert.equal(navigations.length, 1, 'missing owner is also blocked');
      overlayStack.push(owner); await swipe(eventDetail(2)); assert.equal(navigations.length, 2);
    });
    await reset();

    await t.test('owner replacement rejects the old presentation before and after new readiness', async () => {
      await makeReady(); const old = eventDetail();
      holdAction = 'open'; await render(true, 'desktop-B'); await frame();
      assert.equal(phase(), 'loading'); assert.equal(overlayStack.depth(), 0);
      const current = eventDetail();
      assert.notEqual(current.presentationId, old.presentationId);
      await swipe(old); await swipe(current); assert.equal(navigations.length, 0);
      await resolveHeld(); await swipe(old); assert.equal(navigations.length, 0);
      await swipe(current); assert.equal(navigations.length, 1);
      assert.deepEqual(bootstraps, ['desktop-A', 'desktop-B']);
      assert.equal(calls.find(call => call.action === 'close').expectedInstance, 'desktop-A');
    });
    await reset();

    await t.test('native Back retains its sole owner, deduplicates pending Back and cleans up on unmount', async () => {
      await makeReady(); const owner = owners.at(-1);
      holdAction = 'back';
      await act(async () => { assert.ok(overlayStack.dismissTop()); assert.ok(overlayStack.dismissTop()); await settle(); });
      assert.equal(calls.filter(call => call.action === 'back').length, 1);
      assert.ok(overlayStack.isOnly(owner));
      await resolveHeld({ ...ready, backHandled: true });
      assert.equal(backCount, 0); assert.ok(overlayStack.isOnly(owner));
      await swipe(eventDetail()); assert.equal(navigations.at(-1).owner, owner);
      receipt = { ...ready, backHandled: false };
      await act(async () => { overlayStack.dismissTop(); await settle(); });
      assert.equal(backCount, 1); assert.equal(overlayStack.depth(), 0);
      const forwarded = navigations.length;
      await swipe(eventDetail(2)); assert.equal(navigations.length, forwarded, 'consumed Back owner cannot grant a swipe');
      await act(async () => app.unmount()); app = null;
      await swipe(eventDetail(3)); assert.equal(navigations.length, forwarded, 'unmounted host removes its listener');
      assert.equal(overlayStack.depth(), 0);
    });
    await reset();

    await t.test('a late unhandled native Back cannot navigate after the host becomes inactive', async () => {
      await makeReady(); holdAction = 'back';
      await act(async () => { overlayStack.dismissTop(); await settle(); });
      assert.equal(calls.filter(call => call.action === 'back').length, 1);
      await render(false);
      assert.equal(overlayStack.depth(), 0);
      await resolveHeld({ ...ready, backHandled: false });
      assert.equal(backCount, 0, 'effect retirement revokes pending native Back navigation');
      await swipe(eventDetail()); assert.equal(navigations.length, 0);
    });
    await reset();

    await t.test('ready-but-invisible native receipt does not grant host navigation', async () => {
      receipt = { ...ready, visible: false };
      await makeReady(); assert.equal(overlayStack.depth(), 1);
      await swipe(eventDetail()); assert.equal(navigations.length, 0);
    });
    await reset();
  } finally {
    holdAction = null;
    for (const held of outstanding) held.resolve(ready);
    if (bundle) {
      if (app) await bundle.act(async () => app.unmount());
      await bundle.act(async () => { await bundle.retireEmbeddedLsh(); });
      bundle.overlayStack.clear();
    }
    dom.window.close();
    for (const channel of channels) { channel.port1.close(); channel.port2.close(); }
    globalThis.MessageChannel = OriginalMessageChannel;
    stop(); rmSync(dir, { recursive: true, force: true });
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
