import { useLayoutEffect, useRef, type RefObject } from 'react';

/** View-only chrome. A scroll event is not evidence of a user gesture: CM's
 * caret/anchor restoration, previews and IME resize also scroll the document. */
export function useNoteChrome(root: RefObject<HTMLDivElement | null>, {
  scope, mode, blocked = false, keyboardOpen = null,
}: { scope?: string; mode: 'read' | 'edit'; blocked?: boolean; keyboardOpen?: boolean | null }) {
  const guard = useRef(blocked);
  guard.current = blocked;
  const keyboard = useRef(keyboardOpen), reveal = useRef<(() => void) | null>(null);
  keyboard.current = keyboardOpen;
  useLayoutEffect(() => { reveal.current?.(); }, [keyboardOpen]);
  useLayoutEffect(() => {
    const host = root.current;
    if (!host) return;
    host.dataset.viewportBlocked = String(blocked);
    const doc = host.ownerDocument, win = doc.defaultView!;
    let hidden = false, composing = false, gestureUntil = 0;
    let pointer: { x: number; y: number; target: EventTarget | null; moved: boolean } | null = null;
    let lastTarget: HTMLElement | null = null, lastTop = 0, distance = 0, direction = 0;
    const setHidden = (value: boolean) => {
      if (hidden === value) return;
      hidden = value;
      host.dataset.chromeHidden = String(value);
    };
    const show = () => { setHidden(false); distance = 0; direction = 0; gestureUntil = 0; };
    reveal.current = show;
    const active = () => !guard.current && host.closest('[data-current="false"]') === null;
    const protectedInteraction = () => {
      const focused = doc.activeElement;
      const selection = doc.getSelection();
      const coarse = win.matchMedia?.('(pointer: coarse)').matches === true;
      // Android retains focus after Back dismisses IME. Focus is not evidence
      // of a visible keyboard; only the shared viewport lifecycle is.
      const inputProtected = !coarse || keyboard.current !== false;
      return !active() || composing || host.classList.contains('is-title-focused')
        || (inputProtected && host.classList.contains('has-editor-tools'))
        || Boolean(focused && host.contains(focused) && focused.matches('input'))
        || (inputProtected && Boolean(focused && host.contains(focused) && focused.matches('textarea,[contenteditable="true"]')))
        || Boolean(focused instanceof win.HTMLTextAreaElement && host.contains(focused) && focused.selectionStart !== focused.selectionEnd)
        || Boolean(selection && !selection.isCollapsed && selection.anchorNode && host.contains(selection.anchorNode))
        || Boolean(doc.querySelector('[role="dialog"], [aria-modal="true"], [role="menu"]'));
    };
    const isPaper = (node: EventTarget | null): node is HTMLElement =>
      node instanceof win.HTMLElement && (node.matches('.st-note-paper') || node.matches('.cm-scroller')) && host.contains(node);
    const onScroll = (event: Event) => {
      if (!isPaper(event.target)) return;
      const target = event.target;
      const max = Math.max(0, target.scrollHeight - target.clientHeight);
      const top = Math.min(max, Math.max(0, target.scrollTop)); // iOS/Android overscroll is not direction reversal.
      if (lastTarget !== target) { lastTarget = target; lastTop = top; distance = 0; return; }
      const delta = top - lastTop; lastTop = top;
      if (top < 12 || max < 100 || protectedInteraction()) { show(); return; }
      if (performance.now() > gestureUntil) { distance = 0; return; }
      if (Math.abs(delta) < 0.5) return;
      const next = Math.sign(delta);
      if (next !== direction) { direction = next; distance = 0; }
      distance += Math.abs(delta);
      if (next < 0 && distance >= 16) setHidden(false);
      if (next > 0 && distance >= 56 && top >= 72) setHidden(true);
    };
    const onDown = (event: PointerEvent) => {
      const target = event.target instanceof win.Element ? event.target.closest<HTMLElement>('.cm-scroller,.st-note-paper') : null;
      pointer = target && host.contains(target) && !(event.target as Element).closest?.('[data-table-grip]') ? { x: event.clientX, y: event.clientY, target: event.target, moved: false } : null;
      if (pointer && target) { lastTarget = target; lastTop = Math.max(0, target.scrollTop); }
    };
    const onMove = (event: PointerEvent) => {
      if (!pointer) return;
      if (Math.hypot(event.clientX - pointer.x,event.clientY - pointer.y) > 8) pointer.moved = true;
      if (Math.abs(event.clientY - pointer.y) > 6 && Math.abs(event.clientY - pointer.y) > Math.abs(event.clientX - pointer.x))
        gestureUntil = performance.now() + 1400; // includes native momentum, not later restoration.
    };
    const onUp = (event: Event) => {
      if (event.type === 'pointerup' && pointer && !pointer.moved && pointer.target instanceof win.Element
        && pointer.target.closest('.cm-content,.cm-lp-table-input,textarea.st-note-editor')) show();
      pointer = null;
    };
    // Native Android pan may cancel PointerEvents before a large pointermove.
    // Touch movement remains passive and is evidence only inside the paper.
    let touch: { x: number; y: number } | null = null;
    const onTouchStart = (event: TouchEvent) => {
      const target = event.target instanceof win.Element ? event.target.closest<HTMLElement>('.cm-scroller,.st-note-paper') : null;
      const point = event.touches.length === 1 ? event.touches[0] : undefined;
      touch = target && host.contains(target) && !(event.target as Element).closest?.('[data-table-grip]') && point ? { x: point.clientX, y: point.clientY } : null;
      if (touch && target) { lastTarget = target; lastTop = Math.max(0, target.scrollTop); }
    };
    const onTouchMove = (event: TouchEvent) => {
      const point = event.touches.length === 1 ? event.touches[0] : undefined;
      if (!touch || !point) return;
      const dy = Math.abs(point.clientY - touch.y), dx = Math.abs(point.clientX - touch.x);
      if (dy > 6 && dy > dx) gestureUntil = performance.now() + 1400;
    };
    const onTouchEnd = () => { touch = null; };
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const target = event.target instanceof win.Element ? event.target.closest<HTMLElement>('.cm-scroller,.st-note-paper') : null;
      if (!target || !host.contains(target)) return;
      gestureUntil = performance.now() + 350;
      if (target !== lastTarget) { lastTarget = target; lastTop = Math.max(0, target.scrollTop); }
    };
    const onFocus = () => { if (host.contains(doc.activeElement)) show(); };
    const onSelection = () => { if (protectedInteraction()) show(); };
    const onKey = () => { if (active()) show(); }; // Tab/assistive navigation can always reach visible controls.
    const onCompositionStart = () => { composing = true; show(); };
    const onCompositionEnd = () => { composing = false; show(); };
    host.dataset.chromeHidden = 'false';
    host.addEventListener('scroll', onScroll, { capture: true, passive: true });
    host.addEventListener('pointerdown', onDown, { passive: true });
    host.addEventListener('pointermove', onMove, { passive: true });
    host.addEventListener('wheel', onWheel, { passive: true });
    host.addEventListener('touchstart', onTouchStart, { passive: true });
    host.addEventListener('touchmove', onTouchMove, { passive: true });
    host.addEventListener('touchend', onTouchEnd, { passive: true });
    host.addEventListener('touchcancel', onTouchEnd, { passive: true });
    host.addEventListener('select', onSelection, true);
    host.addEventListener('input', onKey, true);
    host.addEventListener('compositionstart', onCompositionStart, true);
    host.addEventListener('compositionend', onCompositionEnd, true);
    doc.addEventListener('pointerup', onUp, { passive: true });
    doc.addEventListener('pointercancel', onUp, { passive: true });
    doc.addEventListener('focusin', onFocus);
    doc.addEventListener('selectionchange', onSelection);
    doc.addEventListener('keydown', onKey);
    win.addEventListener('resize', show);
    win.visualViewport?.addEventListener('resize', show);
    // Menus/page switches may happen without a scroll or focus event.
    const observer = new MutationObserver(() => { if (protectedInteraction()) show(); });
    observer.observe(host, { attributes: true, attributeFilter: ['class'] });
    const stage = host.closest('[data-current]');
    if (stage) observer.observe(stage, { attributes: true, attributeFilter: ['data-current'] });
    return () => {
      reveal.current = null;
      delete host.dataset.chromeHidden;
      delete host.dataset.viewportBlocked;
      observer.disconnect();
      host.removeEventListener('scroll', onScroll, true);
      host.removeEventListener('pointerdown', onDown); host.removeEventListener('pointermove', onMove);
      host.removeEventListener('wheel', onWheel);
      host.removeEventListener('touchstart', onTouchStart); host.removeEventListener('touchmove', onTouchMove);
      host.removeEventListener('touchend', onTouchEnd); host.removeEventListener('touchcancel', onTouchEnd);
      host.removeEventListener('select', onSelection, true);
      host.removeEventListener('input', onKey, true);
      host.removeEventListener('compositionstart', onCompositionStart, true); host.removeEventListener('compositionend', onCompositionEnd, true);
      doc.removeEventListener('pointerup', onUp); doc.removeEventListener('pointercancel', onUp);
      doc.removeEventListener('focusin', onFocus); doc.removeEventListener('selectionchange', onSelection); doc.removeEventListener('keydown', onKey);
      win.removeEventListener('resize', show); win.visualViewport?.removeEventListener('resize', show);
    };
  }, [root, scope, mode, blocked]);
}
