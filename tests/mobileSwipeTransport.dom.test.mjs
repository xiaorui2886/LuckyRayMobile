// Exercise actual React event wiring and native TouchEvent-shaped transport.
// JSDOM cannot certify Android dispatch/arbitration or explain the MI 8 failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const tools = process.env.LR_DOM_TEST_TOOLS
  ? createRequire(join(resolve(process.env.LR_DOM_TEST_TOOLS), '__harness__.cjs')) : require;
const { JSDOM } = tools('jsdom');
const { build, stop } = createRequire(require.resolve('vite/package.json'))('esbuild');
// Run this same regression against the immutable base without editing either hook.
const hook = resolve(process.env.LR_SWIPE_HOOK || join(root, 'src/still/kit/useHorizontalSwipe.ts'));

test('source/root swipe transport preserves one gesture and navigation authority', async t => {
  const dom = new JSDOM('<div id="host"></div>', { url: 'https://test.invalid/', pretendToBeVisual: true });
  const names = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver'];
  const old = new Map(names.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  for (const k of names) Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: dom.window[k] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const channels = [], OriginalMessageChannel = globalThis.MessageChannel;
  globalThis.MessageChannel = class extends OriginalMessageChannel { constructor() { super(); channels.push(this); } };
  const dir = mkdtempSync(join(tmpdir(), 'lr-swipe-transport-'));
  let app, lib;
  try {
    const out = join(dir, 'entry.cjs');
    await build({
      stdin: { contents: `
        import React from 'react';
        import {RootSwipeContext,useHorizontalSwipe,useSourceSwipe} from ${JSON.stringify(hook)};
        export {act,createElement} from 'react';
        export {createRoot} from 'react-dom/client';
        function Source(p) {
          const swipe=useSourceSwipe(p.source,x=>p.record('source:'+x),{disabled:p.disabled});
          return <section data-swipe-owner="sources" {...swipe}>
            <p id="source">source header</p><button id="row" onClick={()=>p.record('row-click')}>row</button>
            <input id="input"/><textarea id="textarea"/><select id="select"/>
            <div id="editable" contentEditable suppressContentEditableWarning>editable text</div>
            <div className="cm-lp-table-wrap"><span id="table">cell</span></div>
            <div id="seek" role="slider"/><video id="video"/><audio id="audio"/>
            <div data-no-swipe><span id="no-swipe">protected</span></div>
            <div id="scroll" style={{overflowX:'auto'}}><span id="scroll-child">wide</span></div>
          </section>;
        }
        export function Harness(p) {
          const swipe=useHorizontalSwipe(d=>p.record('outer:'+d),{disabled:p.disabled,canStart:p.canNavigate,systemEdgeInset:16});
          return <RootSwipeContext.Provider value={{canNavigate:p.canNavigate,navigate:d=>p.record('root:'+d)}}>
            <main data-swipe-owner="root" {...swipe}><Source {...p}/><h2 id="root-body">root header</h2></main>
          </RootSwipeContext.Provider>;
        }
      `, resolveDir: root, loader: 'tsx' },
      outfile: out, bundle: true, platform: 'node', format: 'cjs',
      nodePaths: [join(root, 'node_modules')],
    });
    lib = require(out);
    const { act, createElement: h, createRoot, Harness } = lib;
    app = createRoot(document.getElementById('host'));
    const calls = [];
    let allowed = true, key = 0;
    let props = { source: 'local', record: x => calls.push(x), canNavigate: () => allowed, disabled: false };
    const render = async patch => {
      props = { ...props, ...patch };
      await act(async () => app.render(h(Harness, { ...props, key })));
      for (const owner of document.querySelectorAll('[data-swipe-owner]')) owner.getBoundingClientRect = () => ({ left: 0, right: 400 });
    };
    const reset = async patch => {
      key++; allowed = true; calls.length = 0;
      document.getSelection().removeAllRanges();
      await render({ source: 'local', disabled: false, canNavigate: () => allowed, ...patch });
      // Consume any previous document-wide trailing-click guard.
      document.body.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, detail: 1 }));
    };
    const element = id => document.getElementById(id);
    const pointer = async (target, type, x = 280, y = 100, values = {}) => {
      const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
      for (const [k, v] of Object.entries({ pointerId: 11, pointerType: 'touch', isPrimary: true, button: 0, clientX: x, clientY: y, ...values })) Object.defineProperty(event, k, { value: v });
      await act(async () => target.dispatchEvent(event));
      return event;
    };
    const finger = (target, x = 280, y = 100, identifier = 7) => ({ identifier, target, clientX: x, clientY: y, screenX: x, screenY: y, pageX: x, pageY: y });
    const touch = async (target, type, x = 280, y = 100, options = {}) => {
      const changed = options.changedTouches || [finger(target, x, y, options.identifier ?? 7)];
      const touches = options.touches ?? (type === 'touchend' || type === 'touchcancel' ? [] : changed);
      const event = new dom.window.TouchEvent(type, { bubbles: true, cancelable: true, touches, targetTouches: touches, changedTouches: changed });
      await act(async () => target.dispatchEvent(event));
      return event;
    };
    const swipe = async (id, from = 280, to = 100) => {
      const target = element(id);
      await touch(target, 'touchstart', from);
      await touch(target, 'touchmove', to);
      await touch(target, 'touchend', to);
    };
    const trackMoves = (owner, eventType = 'touchmove') => {
      const registrations = [], active = new Set();
      const add = owner.addEventListener, remove = owner.removeEventListener;
      owner.addEventListener = function(type, fn, options) {
        if (type === eventType) { registrations.push(options); active.add(fn); }
        return add.call(this, type, fn, options);
      };
      owner.removeEventListener = function(type, fn, options) {
        if (type === eventType) active.delete(fn);
        return remove.call(this, type, fn, options);
      };
      return { registrations, active, restore: () => { owner.addEventListener = add; owner.removeEventListener = remove; } };
    };

    await t.test('touch-only source neighbors, source boundaries and plain root each change one level', async () => {
      await reset(); await swipe('source'); assert.deepEqual(calls, ['source:desktop']);
      await reset({ source: 'desktop' }); await swipe('source', 100, 280); assert.deepEqual(calls, ['source:local']);
      await reset({ source: 'desktop' }); await swipe('source'); assert.deepEqual(calls, ['root:left']);
      await reset(); await swipe('source', 100, 280); assert.deepEqual(calls, ['root:right']);
      await reset(); await swipe('root-body'); assert.deepEqual(calls, ['outer:left']);
    });
    await t.test('mixed transports in either start/end order commit once', async () => {
      for (const touchFirst of [false, true]) for (const touchEndsFirst of [false, true]) {
        await reset(); const target = element('source');
        if (touchFirst) { await touch(target, 'touchstart'); await pointer(target, 'pointerdown'); }
        else { await pointer(target, 'pointerdown'); await touch(target, 'touchstart'); }
        await pointer(target, 'pointermove', 100); await touch(target, 'touchmove', 100);
        if (touchEndsFirst) { await touch(target, 'touchend', 100); await pointer(target, 'pointerup', 100); }
        else { await pointer(target, 'pointerup', 100); await touch(target, 'touchend', 100); }
        assert.deepEqual(calls, ['source:desktop'], `touchFirst=${touchFirst}, touchEndsFirst=${touchEndsFirst}`);
      }
    });
    await t.test('mixed pointercancel/lostcapture retires only pointer transport; active touch can finish', async () => {
      for (const kind of ['pointercancel', 'lostpointercapture']) {
        await reset(); const target = element('source');
        await pointer(target, 'pointerdown'); await touch(target, 'touchstart');
        await touch(target, 'touchmove', 100); await pointer(target, kind, 100);
        await touch(target, 'touchend', 100); await pointer(target, 'pointerup', 100);
        assert.deepEqual(calls, ['source:desktop'], kind);
      }
    });
    await t.test('pointer-only cancellation and genuine touchcancel cannot commit', async () => {
      for (const kind of ['pointercancel', 'lostpointercapture', 'touchcancel']) {
        await reset(); const target = element('source');
        await pointer(target, 'pointerdown'); await pointer(target, 'pointermove', 100);
        if (kind === 'touchcancel') await touch(target, kind); else await pointer(target, kind, 100);
        await pointer(target, 'pointerup', 100); assert.deepEqual(calls, [], kind);
      }
      await reset(); const target = element('source');
      await pointer(target, 'pointerdown'); await touch(target, 'touchstart');
      await touch(target, 'touchmove', 100); await touch(target, 'touchcancel', 100);
      await pointer(target, 'pointerup', 100); await touch(target, 'touchend', 100);
      assert.deepEqual(calls, []);
    });
    await t.test('only nearest owner installs a local nonpassive move listener and removes it at end', async () => {
      await reset(); const target = element('source');
      const inner = trackMoves(target.closest('[data-swipe-owner]'));
      const outer = trackMoves(element('root-body').closest('[data-swipe-owner]'));
      await touch(target, 'touchstart');
      assert.equal(inner.active.size, 1); assert.equal(outer.active.size, 0);
      assert.equal(inner.registrations[0]?.passive, false);
      assert.equal((await touch(target, 'touchmove', 100)).defaultPrevented, true);
      await touch(target, 'touchend', 100);
      assert.equal(inner.active.size, 0); assert.deepEqual(calls, ['source:desktop']);
    });
    await t.test('vertical scrolling cannot turn into horizontal navigation later in the gesture', async () => {
      await reset(); const target = element('source'); const listeners = trackMoves(target.closest('[data-swipe-owner]'));
      await touch(target, 'touchstart');
      assert.equal((await touch(target, 'touchmove', 278, 130)).defaultPrevented, false);
      assert.equal(listeners.active.size, 0);
      await touch(target, 'touchmove', 100, 132); await touch(target, 'touchend', 100, 132);
      assert.deepEqual(calls, []);
    });
    await t.test('input, editable selection, table, media, no-swipe and horizontal scroll descendants retain ownership', async () => {
      await reset(); Object.defineProperties(element('scroll'), { scrollWidth: { value: 500 }, clientWidth: { value: 100 } });
      for (const id of ['input', 'textarea', 'select', 'editable', 'table', 'seek', 'video', 'audio', 'no-swipe', 'scroll-child']) await swipe(id);
      assert.deepEqual(calls, []);
      const range = document.createRange(); range.selectNodeContents(element('source')); document.getSelection().addRange(range);
      await swipe('source'); assert.deepEqual(calls, []);
      document.getSelection().removeAllRanges();
      const target = element('source'); await touch(target, 'touchstart'); await touch(target, 'touchmove', 100);
      document.getSelection().addRange(range); await touch(target, 'touchend', 100); assert.deepEqual(calls, []);
    });
    await t.test('system edges, multi-touch, wrong touch identifier and IME composition veto navigation', async () => {
      await reset(); await swipe('source', 5, 200); await swipe('source', 395, 200); assert.deepEqual(calls, []);
      const target = element('source');
      await touch(target, 'touchstart');
      await touch(target, 'touchstart', 260, 100, { touches: [finger(target), finger(target, 260, 100, 8)] });
      await touch(target, 'touchmove', 100); await touch(target, 'touchend', 100); assert.deepEqual(calls, []);
      await touch(target, 'touchstart'); await touch(target, 'touchmove', 100, 100, { identifier: 8 });
      await touch(target, 'touchend', 100); assert.deepEqual(calls, []);
      await act(async () => target.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true })));
      await swipe('source'); assert.deepEqual(calls, []);
      await act(async () => target.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true })));
      await swipe('source'); assert.deepEqual(calls, ['source:desktop']);
    });
    await t.test('disabled/overlay/stale-route authority is rechecked and active listeners are retired', async () => {
      await reset({ disabled: true }); await swipe('source'); await swipe('root-body'); assert.deepEqual(calls, []);
      await reset(); allowed = false; await swipe('source'); await swipe('root-body'); assert.deepEqual(calls, []);
      for (const revoke of ['disabled', 'canNavigate']) {
        await reset(); const target = element('source'); const listeners = trackMoves(target.closest('[data-swipe-owner]'));
        await touch(target, 'touchstart'); await touch(target, 'touchmove', 100);
        if (revoke === 'disabled') await render({ disabled: true }); else { allowed = false; await render({}); }
        assert.equal(listeners.active.size, 0, revoke);
        await touch(target, 'touchend', 100); assert.deepEqual(calls, []);
      }
      await reset(); const target = element('source'); await touch(target, 'touchstart'); await touch(target, 'touchmove', 100);
      allowed = false; await touch(target, 'touchend', 100); assert.deepEqual(calls, []);
    });
    await t.test('external source changes and disabled-then-enabled cannot revive an old finger', async () => {
      for (const change of ['source', 'disabled']) {
        await reset(); const target = element('source'); const listeners = trackMoves(target.closest('[data-swipe-owner]'));
        await touch(target, 'touchstart');
        if (change === 'source') await render({ source: 'desktop' });
        else { await render({ disabled: true }); await render({ disabled: false }); }
        assert.equal(listeners.active.size, 0);
        await touch(target, 'touchmove', 100); await touch(target, 'touchend', 100);
        assert.deepEqual(calls, [], change);
      }
    });
    await t.test('a second finger outside the source owner cancels without blocking its event', async () => {
      await reset(); const target = element('source'), outside = element('root-body');
      const listeners = trackMoves(target.closest('[data-swipe-owner]'));
      await touch(target, 'touchstart');
      const second = finger(outside, 300, 100, 8);
      assert.equal((await touch(outside, 'touchstart', 300, 100, { touches: [finger(target), second], changedTouches: [second] })).defaultPrevented, false);
      assert.equal(listeners.active.size, 0);
      await touch(outside, 'touchend', 300, 100, { touches: [finger(target)], changedTouches: [second] });
      await touch(target, 'touchmove', 100); await touch(target, 'touchend', 100);
      assert.deepEqual(calls, []);
    });
    await t.test('old route authority cannot be replaced by a newly allowed callback', async () => {
      const first = {}, next = {}; let current = first;
      await reset({ canNavigate: () => current === first }); const target = element('source');
      await touch(target, 'touchstart'); await touch(target, 'touchmove', 100);
      current = next; await render({ canNavigate: () => current === next });
      await touch(target, 'touchend', 100); assert.deepEqual(calls, []);
    });
    await t.test('a child that owns its move propagation is not claimed from end coordinates alone', async () => {
      await reset(); const target = element('source');
      const stopMove = event => event.stopPropagation(); target.addEventListener('touchmove', stopMove);
      await swipe('source'); assert.deepEqual(calls, []);
      target.removeEventListener('touchmove', stopMove);
      await swipe('source'); assert.deepEqual(calls, ['source:desktop']);
    });
    await t.test('document contact-count observer is passive and removed on every retirement path', async () => {
      for (const outcome of ['finish', 'cancel', 'vertical', 'disabled', 'scope', 'unmount']) {
        await reset(); const target = element('source'); const listeners = trackMoves(document, 'touchstart');
        try {
          await touch(target, 'touchstart'); assert.equal(listeners.active.size, 1, outcome);
          assert.deepEqual(listeners.registrations[0], { capture: true, passive: true });
          if (outcome === 'finish') { await touch(target, 'touchmove', 100); await touch(target, 'touchend', 100); }
          else if (outcome === 'cancel') await touch(target, 'touchcancel');
          else if (outcome === 'vertical') await touch(target, 'touchmove', 279, 160);
          else if (outcome === 'disabled') await render({ disabled: true });
          else if (outcome === 'scope') await render({ source: 'desktop' });
          else await act(async () => app.render(null));
          assert.equal(listeners.active.size, 0, outcome);
        } finally { listeners.restore(); }
      }
    });
    await t.test('detached owner cannot finish before effect cleanup', async () => {
      await reset(); const target = element('source'), owner = target.closest('[data-swipe-owner]'), parent = owner.parentNode;
      await touch(target, 'touchstart'); await touch(target, 'touchmove', 100);
      // Detach during dispatch: the precomputed event path still reaches React,
      // unlike dispatching on an already detached element (which is vacuous).
      target.addEventListener('touchend', () => owner.remove(), { once: true });
      await touch(target, 'touchend', 100); assert.deepEqual(calls, []);
      parent.prepend(owner);
    });
    await t.test('long hold, small movement and trailing row clicks never add navigation', async () => {
      await reset(); const target = element('row'); const originalNow = Date.now; let now = originalNow();
      Date.now = () => now;
      try {
        await touch(target, 'touchstart'); now += 651; await touch(target, 'touchmove', 100); await touch(target, 'touchend', 100); assert.deepEqual(calls, []);
        await swipe('row', 280, 250); assert.deepEqual(calls, []);
        await swipe('row'); assert.deepEqual(calls, ['source:desktop']);
        await act(async () => target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })));
        assert.deepEqual(calls, ['source:desktop']);
        await act(async () => target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 })));
        assert.deepEqual(calls, ['source:desktop', 'row-click']);
      } finally { Date.now = originalNow; }
    });
    await t.test('unmount clears the local move listener and cannot navigate from a detached owner', async () => {
      await reset(); const target = element('source'); const listeners = trackMoves(target.closest('[data-swipe-owner]'));
      await touch(target, 'touchstart'); assert.equal(listeners.active.size, 1);
      await act(async () => app.render(null)); assert.equal(listeners.active.size, 0);
      await touch(target, 'touchmove', 100); await touch(target, 'touchend', 100); assert.deepEqual(calls, []);
    });
  } finally {
    if (app) await lib.act(async () => app.unmount());
    stop(); for (const c of channels) { c.port1.close(); c.port2.close(); }
    globalThis.MessageChannel = OriginalMessageChannel;
    dom.window.close(); for (const [k, v] of old) if (v) Object.defineProperty(globalThis, k, v); else delete globalThis[k];
    delete globalThis.IS_REACT_ACT_ENVIRONMENT; rmSync(dir, { recursive: true, force: true });
  }
});
