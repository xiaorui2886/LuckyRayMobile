import { createContext, useContext, useEffect, useRef, type PointerEvent, type MouseEvent, type TouchEvent } from "react";

const clickGuards = new WeakMap<Document, () => void>();
/** Survives the old drawer/page unmount so its synthetic click cannot land in
 * the newly revealed editor. Keyboard activation (detail=0) is untouched. */
export function suppressTrailingSwipeClick(document: Document) {
  clickGuards.get(document)?.();
  let timer: ReturnType<typeof setTimeout>;
  const clear = () => { clearTimeout(timer); document.removeEventListener("click", block, true); clickGuards.delete(document); };
  const block = (event: globalThis.MouseEvent) => { if (!event.detail) return; event.preventDefault(); event.stopImmediatePropagation(); clear(); };
  document.addEventListener("click", block, true); timer = setTimeout(clear, 450); clickGuards.set(document, clear);
}

export type SwipeDirection = "left" | "right";
export const ROOT_SWIPE_TABS = ["home", "library", "ai", "knowledge", "settings"] as const;
export function rootSwipeTarget(tab: string, direction: SwipeDirection): typeof ROOT_SWIPE_TABS[number] | null {
  const index = ROOT_SWIPE_TABS.indexOf(tab as typeof ROOT_SWIPE_TABS[number]);
  return index < 0 ? null : ROOT_SWIPE_TABS[index + (direction === "left" ? 1 : -1)] ?? null;
}
/** Explicit parent hand-off: one source gesture can change ONE navigation level.
 * A detail, sheet, or text input can revoke this authority before pointer-up. */
export const RootSwipeContext = createContext<{
  canNavigate: () => boolean;
  navigate: (direction: SwipeDirection) => void;
  navigateLsh?: (direction: SwipeDirection, backOwner: () => void) => void;
} | null>(null);

export function sourceSwipeTarget(source: "local" | "desktop", direction: SwipeDirection): "local" | "desktop" | null {
  if (source === "local" && direction === "left") return "desktop";
  if (source === "desktop" && direction === "right") return "local";
  return null;
}

export function useSourceSwipe(source: "local" | "desktop", onSource: (source: "local" | "desktop") => void, options: { disabled?: boolean } = {}) {
  const root = useContext(RootSwipeContext);
  return useHorizontalSwipe(direction => {
    if (options.disabled || root?.canNavigate() === false) return;
    const target = sourceSwipeTarget(source, direction);
    if (target) onSource(target);
    else root?.navigate(direction);
  }, { disabled: options.disabled, canStart: () => root?.canNavigate() !== false, systemEdgeInset: 16, scopeKey: source });
}

function hasHorizontalScroller(target: Element, owner: HTMLElement): boolean {
  for (let element: Element | null = target; element && element !== owner; element = element.parentElement) {
    if (element.scrollWidth <= element.clientWidth + 2) continue;
    const style = owner.ownerDocument.defaultView?.getComputedStyle(element);
    if (style && /auto|scroll/.test(style.overflowX)) return true;
  }
  return false;
}
export function horizontalIntent(dx: number, dy: number, elapsed: number): SwipeDirection | null {
  return elapsed <= 650 && Math.abs(dx) >= 52 && Math.abs(dx) > Math.abs(dy) * 1.6 ? dx < 0 ? "left" : "right" : null;
}
/** One nearest owner wins. Never turn text selection, media seeking, a long
 * press, vertical scrolling, or a multi-touch gesture into navigation. */
export function useHorizontalSwipe(onSwipe: (direction: SwipeDirection) => void, options: { disabled?: boolean; edgeOnly?: boolean; editableEdge?: boolean; canStart?: () => boolean; systemEdgeInset?: number; scopeKey?: string } = {}) {
  type Gesture = {
    pointerId: number | null; touchId: number | null;
    x: number; y: number; at: number; locked: boolean; owner: HTMLElement;
    canStart?: () => boolean; scopeKey?: string;
  };
  const start = useRef<Gesture | null>(null);
  const removeTouchListeners = useRef<(() => void) | null>(null);
  const latest = useRef({ onSwipe, options }); latest.current = { onSwipe, options };
  const suppress = useRef(0);
  const composing = useRef(false);
  const cancel = () => {
    start.current = null;
    removeTouchListeners.current?.(); removeTouchListeners.current = null;
  };
  const allowed = (s?: Gesture | null) => {
    const current = latest.current.options;
    return !current.disabled && !composing.current && current.canStart?.() !== false &&
      (!s || s.owner.isConnected && s.scopeKey === current.scopeKey && s.canStart?.() !== false);
  };
  // A committed disabled/authority change permanently retires the old gesture,
  // even if it is enabled again before the next move/up event.
  useEffect(() => { if (!allowed(start.current)) cancel(); });
  useEffect(() => () => cancel(), []);

  const begin = (target: EventTarget, owner: HTMLElement, x: number, y: number): Gesture | null => {
    const current = latest.current.options;
    if (!(target instanceof Element) || !allowed()) return null;
    const rect = owner.getBoundingClientRect();
    const atEdge = x - rect.left <= 28 || rect.right - x <= 28;
    const systemEdge = current.systemEdgeInset ?? 0;
    const selection = owner.ownerDocument.getSelection();
    if (systemEdge > 0 && (x - rect.left < systemEdge || rect.right - x < systemEdge)) return null;
    if (target.closest('[data-swipe-owner]') !== owner || hasHorizontalScroller(target, owner) ||
        target.closest('input,textarea,select,video,audio,[role="slider"],input[type="range"],[data-no-swipe],.cm-lp-table,.cm-lp-table-editable,.cm-lp-table-wrap,.cm-lp-table-menu,[data-table-grip],.st-editor-tools') ||
        (target.closest('[contenteditable="true"]') && !(current.editableEdge && atEdge)) ||
        (selection && !selection.isCollapsed && Boolean(selection.toString())) ||
        (current.edgeOnly && !atEdge)) return null;
    return { pointerId: null, touchId: null, x, y, at: Date.now(), locked: false, owner,
      canStart: current.canStart, scopeKey: current.scopeKey };
  };
  const move = (event: { cancelable: boolean; preventDefault: () => void }, s: Gesture, x: number, y: number) => {
    if (!allowed(s)) { cancel(); return; }
    const dx = x - s.x, dy = y - s.y;
    // Once vertical scrolling wins, later horizontal movement cannot revive it.
    if (!s.locked && (Math.abs(dy) > 12 && Math.abs(dy) >= Math.abs(dx) || Date.now() - s.at > 650)) { cancel(); return; }
    if (Math.abs(dx) > 16 && Math.abs(dx) > Math.abs(dy) * 1.6) {
      s.locked = true;
      if (event.cancelable) event.preventDefault();
    }
  };
  const finish = (event: { preventDefault: () => void; stopPropagation: () => void }, s: Gesture, x: number, y: number) => {
    cancel();
    if (!allowed(s)) return;
    const direction = horizontalIntent(x - s.x, y - s.y, Date.now() - s.at);
    const selection = s.owner.ownerDocument.getSelection();
    if (selection && !selection.isCollapsed) return;
    if (direction) {
      suppress.current = Date.now() + 450;
      suppressTrailingSwipeClick(s.owner.ownerDocument);
      event.preventDefault(); event.stopPropagation(); latest.current.onSwipe(direction);
    } else if (s.locked) suppress.current = Date.now() + 450;
  };
  const retirePointer = () => {
    const s = start.current;
    // The browser can retire a pointer while the same finger's TouchEvent
    // sequence is still live. Only touchcancel cancels that active transport.
    if (s?.touchId != null) s.pointerId = null;
    else cancel();
  };
  return {
    onCompositionStartCapture() { composing.current = true; cancel(); },
    onCompositionEndCapture() { composing.current = false; },
    onTouchStart(event: TouchEvent<HTMLElement>) {
      if (event.touches.length !== 1) { cancel(); return; }
      const touch = event.touches[0];
      let s = start.current;
      if (s && (!allowed(s) || s.owner !== event.currentTarget)) { cancel(); return; }
      if (s?.touchId != null) { if (s.touchId !== touch.identifier) cancel(); return; }
      if (!s) s = begin(event.target, event.currentTarget, touch.clientX, touch.clientY);
      if (!s) return;
      s.touchId = touch.identifier; start.current = s;
      const owner = s.owner;
      // React delegates touchmove passively. A listener scoped to the winning
      // owner and this gesture can prevent only an established horizontal drag.
      const touchMove = (native: globalThis.TouchEvent) => {
        const active = start.current;
        if (!active || native.touches.length !== 1) { cancel(); return; }
        const point = native.touches[0];
        if (point.identifier !== active.touchId) { cancel(); return; }
        move(native, active, point.clientX, point.clientY);
      };
      // A second finger may land outside this owner. Observe only contact
      // count for the lifetime of this gesture, without intercepting that event.
      const otherTouch = (native: globalThis.TouchEvent) => { if (native.touches.length !== 1) cancel(); };
      owner.addEventListener("touchmove", touchMove, { passive: false });
      owner.ownerDocument.addEventListener("touchstart", otherTouch, { capture: true, passive: true });
      removeTouchListeners.current = () => {
        owner.removeEventListener("touchmove", touchMove);
        owner.ownerDocument.removeEventListener("touchstart", otherTouch, true);
      };
    },
    onTouchEnd(event: TouchEvent<HTMLElement>) {
      const s = start.current;
      if (!s || s.touchId == null) return;
      const touch = Array.from(event.changedTouches).find(point => point.identifier === s.touchId);
      if (event.touches.length || !touch || !s.locked) { cancel(); return; }
      finish(event, s, touch.clientX, touch.clientY);
    },
    onTouchCancel: cancel,
    onPointerDown(event: PointerEvent<HTMLElement>) {
      if (!event.isPrimary || event.pointerType === "mouse" || event.button !== 0) { cancel(); return; }
      const s = start.current;
      // Touch and pointer IDs need not match. Both transports belong to the
      // one active finger, and TouchEvent owns its completion once present.
      if (s?.touchId != null) {
        if (!allowed(s) || event.pointerType !== "touch") { cancel(); return; }
        s.pointerId = event.pointerId; return;
      }
      cancel();
      const next = begin(event.target, event.currentTarget, event.clientX, event.clientY);
      if (next) { next.pointerId = event.pointerId; start.current = next; }
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      const s = start.current;
      if (!s || s.pointerId !== event.pointerId || s.touchId != null) return;
      move(event, s, event.clientX, event.clientY);
      if (start.current === s && s.locked) {
        try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* The browser may have retired the pointer. */ }
      }
    },
    onPointerUp(event: PointerEvent<HTMLElement>) {
      const s = start.current;
      if (!s || s.pointerId !== event.pointerId) return;
      if (s.touchId != null) { s.pointerId = null; return; }
      finish(event, s, event.clientX, event.clientY);
      try {
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      } catch { /* Cancellation can release capture before the compatibility up. */ }
    },
    onPointerCancel: retirePointer,
    onLostPointerCapture: retirePointer,
    onClickCapture(event: MouseEvent<HTMLElement>) {
      if (event.detail !== 0 && Date.now() < suppress.current) { event.preventDefault(); event.stopPropagation(); }
    },
  };
}
