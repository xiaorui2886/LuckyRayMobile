import { useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api } from '../../services/client';
import { useStillNav } from '../StillShell';
import { Button, Empty } from './StillImports';
import { LshEmbeddedController, usableLshBounds } from './lshEmbedded';
import { lshErrorCopy, lshDiagnosticCode } from './lshSurface';
import './embeddedLsh.css';
import { RootSwipeContext } from './useHorizontalSwipe';
import { overlayStack } from '../../services/overlayStack';

// Retain the native view between tab visits, not a second copy of chat data.
const surface = new LshEmbeddedController({ bootstrap: api.lshSurfaceBootstrap, embed: api.lshSurfaceEmbed });
export function EmbeddedLshView({ owner, active = true, suspended = false, onReady, onRevalidationRequired }: { owner: string; active?: boolean; suspended?: boolean; onReady?: (owner: string) => void; onRevalidationRequired?: () => void }) {
  const { mode, registerOverlay, back: returnToApp } = useStillNav();
  const rootSwipe = useContext(RootSwipeContext);
  const backOwner = useRef<(() => void) | null>(null);
  const placeholder = useRef<HTMLDivElement>(null);
  const state = useSyncExternalStore(surface.subscribe, surface.snapshot);
  const [attempt, setAttempt] = useState(0);
  const [slow, setSlow] = useState(false);
  const [layoutError, setLayoutError] = useState(false);
  useEffect(() => () => { void surface.hide(); }, []);
  useEffect(() => {
    if (active && !suspended && state.revalidationRequired) onRevalidationRequired?.();
  }, [active, suspended, state.revalidationRequired, onRevalidationRequired]);
  useEffect(() => { if (state.phase === 'ready' && !suspended && surface.isReadyFor(owner)) onReady?.(owner); }, [state, suspended, owner, onReady]);
  useEffect(() => {
    if (!active) { void surface.hide(); return; }
    let frame = 0, last = '', alive = true;
    let validLayout = false;
    setLayoutError(false);
    const place = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const el = placeholder.current;
        if (!alive || !el || document.visibilityState === 'hidden') return;
        const r = el.getBoundingClientRect();
        const dock = document.querySelector<HTMLElement>('.st-tab-wrap');
        const dockVisible = dock && getComputedStyle(dock).visibility !== 'hidden';
        const bottom = dockVisible ? Math.min(r.bottom, dock.getBoundingClientRect().top - 8) : r.bottom;
        const x = Math.max(0, r.left), y = Math.max(0, r.top);
        const bounds = { x, y, width: Math.max(0, Math.min(r.right, window.innerWidth) - x), height: Math.max(0, Math.min(bottom, window.innerHeight) - y), viewportWidth: window.innerWidth };
        // A transformed/zero-sized first frame is not a valid launch. ResizeObserver
        // does not observe position changes, so the periodic pass remeasures.
        if (!usableLshBounds(bounds)) return;
        validLayout = true; setLayoutError(false);
        const key = JSON.stringify([bounds, mode]);
        if (key === last) return;
        last = key;
        void (suspended ? surface.suspend(owner, bounds, mode === 'dark') : surface.attach(owner, bounds, mode === 'dark'));
      });
    };
    const visibility = () => {
      if (document.visibilityState === 'hidden') void surface.hide();
      else { last = ''; place(); }
    };
    const resize = new ResizeObserver(place);
    if (placeholder.current) resize.observe(placeholder.current);
    const app = document.querySelector('.st-app');
    const mutation = new MutationObserver(place);
    if (app) mutation.observe(app, { attributes: true, attributeFilter: ['data-text-entry', 'data-mode'] });
    window.addEventListener('resize', place);
    window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    document.addEventListener('visibilitychange', visibility);
    place();
    const timer = window.setInterval(() => { place(); if (!suspended) void surface.poll(); }, 1500);
    const layoutTimer = window.setTimeout(() => { if (!validLayout) setLayoutError(true); }, 12000);
    return () => {
      alive = false; cancelAnimationFrame(frame); resize.disconnect(); mutation.disconnect(); clearInterval(timer); clearTimeout(layoutTimer);
      window.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('scroll', place);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [owner, active, suspended, mode, attempt]);
  useEffect(() => {
    if (!active || suspended || state.phase !== 'ready') return;
    let dispose: () => void, pending = false, gone = false;
    const back = () => {
      // Keep native presentation history/modal dismissal ahead of root Back.
      dispose = registerOverlay(back);
      if (pending) return;
      pending = true;
      void surface.back().then(handled => {
        if (!gone && !handled) { dispose(); returnToApp(); }
      }).finally(() => { pending = false; });
    };
    backOwner.current = back;
    dispose = registerOverlay(back);
    return () => { backOwner.current = null; gone = true; dispose(); };
  }, [active, suspended, state.phase, registerOverlay, returnToApp]);
  useEffect(() => {
    setSlow(false);
    if (state.phase !== 'loading' && state.phase !== 'idle') return;
    const timer = window.setTimeout(() => setSlow(true), 12000);
    return () => clearTimeout(timer);
  }, [state.phase, attempt]);
  useEffect(() => {
    const swipe = (event: Event) => {
      if (!active || suspended || document.visibilityState === 'hidden') return;
      const owner = backOwner.current;
      if (!owner || !overlayStack.isOnly(owner)) return;
      const direction = surface.consumeTabSwipe((event as CustomEvent).detail);
      if (direction) rootSwipe?.navigateLsh?.(direction, owner);
    };
    window.addEventListener('luckyray-lsh-tab-swipe', swipe);
    return () => window.removeEventListener('luckyray-lsh-tab-swipe', swipe);
  }, [active, suspended, rootSwipe]);
  const retry = async () => { await surface.close(); setAttempt(n => n + 1); };
  return <div className="st-lsh-embedded" ref={placeholder} data-swipe-owner="lsh" data-lsh-suspended={suspended || undefined} data-lsh-phase={layoutError ? "error" : state.phase} data-lsh-error={lshDiagnosticCode(layoutError ? "LSH_LAYOUT_NOT_READY" : state.error) || undefined} aria-label="LightSeek 对话">
    {state.phase === 'error' || layoutError ? <div className="st-lsh-embedded-state" role="status">
      <Empty icon="ai" title="暂时未能打开 LightSeek" body={lshErrorCopy(layoutError ? 'LSH_LAYOUT_NOT_READY' : state.error)}>
        <Button kind="quiet" onClick={() => void retry()}>重新连接</Button>
      </Empty>
      <details className="st-lsh-diagnostic"><summary>查看诊断</summary><small>{lshDiagnosticCode(layoutError ? "LSH_LAYOUT_NOT_READY" : state.error)}</small></details>
    </div> : state.phase !== 'ready' ? <div className="st-lsh-embedded-state" role="status">
      <span className="st-lsh-loading-mark" aria-hidden="true" />
      <p>{slow ? '连接时间较长，正在等待对话界面' : '正在连接 LightSeek…'}</p>
      {slow ? <Button kind="quiet" onClick={() => void retry()}>重新连接</Button> : null}
    </div> : null}
  </div>;
}
/** Connection/capability loss must clear the retained native surface. */
export function retireEmbeddedLsh() { return surface.close(); }
export function hideEmbeddedLsh() { return surface.hide(); }

export function prepareEmbeddedLshRevalidation(owner: string) { return surface.prepareRevalidation(owner); }
export function confirmEmbeddedLshRevalidation(owner: string, generation: number | null) { surface.confirmRevalidation(owner, generation); }
