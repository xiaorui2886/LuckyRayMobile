// MATERIAL-LIBRARY-INSTANT-R1 REPAIR-R5 (C/D) — the long-press React adapter.
//
// ONE hook, used by BOTH the grid tile and the list row, so the two cannot
// drift into divergent timers. It owns the real timer and the DOM listeners and
// delegates every decision to the pure reducer in `pressGesturePure.ts`.
//
// Old-WebView safety (the MI 8 runs System WebView 83):
//  - Pointer Events are used when available; when they are not, the hook falls
//    back to touch events so a long press still works at all.
//  - `touchmove` is registered NON-passively so the browser cannot also run a
//    native long-press / context menu in parallel with ours.
//  - `contextmenu` is suppressed on the element, which is the only way to stop
//    Android's text-selection / callout artifact on a long press.
//  - The timer is cleared on every terminal transition and on unmount, and the
//    hook is keyed per element, so an unmounted row cannot fire a stale press.

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_PRESS_CONFIG, initialPressState, reducePress,
  type PressConfig, type PressState,
} from "./pressGesturePure";

export type PressHandlers = {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onPointerCancel: (e: React.PointerEvent) => void;
  onPointerLeave: (e: React.PointerEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onTouchEnd: (e: React.TouchEvent) => void;
  onTouchCancel: (e: React.TouchEvent) => void;
  onClick: (e: React.MouseEvent) => void;
};

export type PressGesture = {
  handlers: PressHandlers;
  /** Whether a long press has fired for the in-flight gesture. */
  held: boolean;
};

/** Whether this environment can deliver Pointer Events at all. */
function hasPointerEvents(): boolean {
  return typeof window !== "undefined" && "PointerEvent" in window;
}

export function useLongPress(options: {
  /** Fired once when the press passes the threshold. */
  onLongPress: () => void;
  /** Fired on a genuine short tap. */
  onTap?: () => void;
  /** Disable the gesture entirely (normal-mode taps still work via onTap). */
  enabled?: boolean;
  config?: PressConfig;
  /**
   * PHYSICAL-POLISH-R7 (B1): fired for every move WHILE the press is held
   * past the threshold — i.e. after the long press entered selection and the
   * finger stays down. The page uses the coordinates to hit-test which tile is
   * under the finger and grow the selection, the way photo albums do. The
   * gesture authority stays the single owner: this is the SAME gesture, whose
   * held phase now also reports its position.
   */
  onDragSelect?: (x: number, y: number) => void;
  /**
   * R7b: fired ONCE when a gesture that had latched `held` ends (finger up,
   * or the hook tears down / the gesture is disabled mid-hold). The page uses
   * it to stop the drag-follow auto-scroll. Never fires for a plain tap.
   */
  onDragEnd?: () => void;
  /**
   * R7a: the element the handlers are spread on. The adapter attaches the
   * non-passive held-phase guard to it (see useNonPassivePressGuard), so a
   * started drag-select cannot be taken over by the WebView's default scroll.
   */
  hostRef?: React.RefObject<HTMLElement | null>;
}): PressGesture {
  const { onLongPress, onTap, enabled = true, config = DEFAULT_PRESS_CONFIG, onDragSelect, onDragEnd, hostRef } = options;
  const stateRef = useRef<PressState>(initialPressState());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [held, setHeld] = useState(false);
  // R7b: latched once a gesture reaches `held`, so its END can be reported
  // exactly once however it ends.
  const hadHeldRef = useRef(false);
  // Both callbacks are read through refs so the handlers can stay stable across
  // renders: a re-render mid-gesture must never swap the timer's callback.
  const longPressRef = useRef(onLongPress);
  const tapRef = useRef(onTap);
  const dragSelectRef = useRef(onDragSelect);
  const dragEndRef = useRef(onDragEnd);
  useEffect(() => { longPressRef.current = onLongPress; }, [onLongPress]);
  useEffect(() => { tapRef.current = onTap; }, [onTap]);
  useEffect(() => { dragSelectRef.current = onDragSelect; }, [onDragSelect]);
  useEffect(() => { dragEndRef.current = onDragEnd; }, [onDragEnd]);

  /** Fires onDragEnd once, only for a gesture that had latched held. */
  const reportDragEnd = useCallback(() => {
    if (!hadHeldRef.current) return;
    hadHeldRef.current = false;
    dragEndRef.current?.();
  }, []);
  // The gesture authority must never leak a live drag past its lifetime.
  useEffect(() => reportDragEnd, [reportDragEnd]);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => clearTimer, [clearTimer]);
  // Leaving the mode disarms any in-flight gesture (and ends a live drag).
  useEffect(() => {
    if (!enabled) {
      clearTimer();
      stateRef.current = initialPressState();
      setHeld(false);
      reportDragEnd();
    }
  }, [enabled, clearTimer, reportDragEnd]);

  const dispatch = useCallback((event: Parameters<typeof reducePress>[1]) => {
    const { state, effect } = reducePress(stateRef.current, event, config);
    stateRef.current = state;
    switch (effect.type) {
      case "arm":
        clearTimer();
        // REPAIR-R5b: when the gesture is DISABLED there is no long press, so no
        // timer is armed. The down/up pair still runs through the SAME reducer,
        // which means the release lands on the normal `activate` path — a plain
        // tap keeps working instead of being swallowed. (Local materials have
        // no multi-select, so `enabled` is false for them and they previously
        // lost their only activation path.)
        if (!enabled) break;
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          const r = reducePress(stateRef.current, { type: "timeout" }, config);
          stateRef.current = r.state;
          if (r.effect.type === "longpress") {
            // Latch BEFORE notifying, so a click arriving in the same tick is
            // already suppressed.
            setHeld(true);
            hadHeldRef.current = true;
            longPressRef.current();
          }
        }, config.threshold);
        break;
      case "disarm":
        clearTimer();
        setHeld(false);
        break;
      case "longpress":
        setHeld(true);
        hadHeldRef.current = true;
        longPressRef.current();
        break;
      case "activate":
        setHeld(false);
        tapRef.current?.();
        break;
      default:
        break;
    }
  }, [clearTimer, config, enabled]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // Ignore secondary buttons / a second finger arriving mid-gesture.
    if (e.button !== undefined && e.button !== 0) return;
    if (stateRef.current.phase === "armed") return;
    if (enabled) {
      try { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); } catch { /* not fatal */ }
    }
    dispatch({ type: "down", x: e.clientX, y: e.clientY });
  }, [dispatch, enabled]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    dispatch({ type: "move", x: e.clientX, y: e.clientY });
    // R7 (B1): once the long press has latched (selection mode entered), every
    // further move reports the finger's position for drag-selection. The
    // reducer keeps the phase `held` through moves, so this cannot re-arm or
    // cancel anything.
    if (stateRef.current.phase === "held") {
      // R7a: the held gesture owns the move — stop the default pan where the
      // platform honours pointer-event cancellation. (Chromium's scrolling is
      // ultimately driven by the TOUCH events the non-passive guard cancels;
      // this keeps the pointer path honest on platforms that differ.)
      if (e.cancelable) e.preventDefault();
      dragSelectRef.current?.(e.clientX, e.clientY);
    }
  }, [dispatch]);

  const endPointer = useCallback(() => {
    dispatch({ type: "up" });
    // R7b: a held drag ends here (finger up). A plain tap never latched
    // `held`, so this reports nothing for it.
    reportDragEnd();
  }, [dispatch, reportDragEnd]);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (enabled) {
      try { (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId); } catch { /* not fatal */ }
    }
    endPointer();
  }, [enabled, endPointer]);

  const onPointerCancel = useCallback(() => { dispatch({ type: "cancel" }); }, [dispatch]);
  const onPointerLeave = useCallback(() => { dispatch({ type: "cancel" }); }, [dispatch]);

  // Android's callout / text-selection artifact. Suppressing it here is what
  // keeps a long press from also popping the system menu.
  const onContextMenu = useCallback((e: React.MouseEvent) => { e.preventDefault(); }, []);

  // Touch fallback for WebViews without Pointer Events. Registered through
  // React; the non-passive scroll guard below is the one that cannot be
  // synthetic.
  const touchStart = useCallback((e: React.TouchEvent) => {
    if (hasPointerEvents()) return;
    if (stateRef.current.phase === "armed") return;
    const t = e.touches[0];
    if (!t) return;
    dispatch({ type: "down", x: t.clientX, y: t.clientY });
  }, [dispatch]);
  const touchMove = useCallback((e: React.TouchEvent) => {
    if (hasPointerEvents()) return;
    const t = e.touches[0];
    if (!t) return;
    dispatch({ type: "move", x: t.clientX, y: t.clientY });
    // R7 (B1): the old-WebView touch fallback reports held-phase moves too.
    // R7a: NO preventDefault here — React registers synthetic touchmove
    // passively at the root, so it would be a no-op (and warn). The
    // non-passive native guard below owns scroll suppression on this path.
    if (stateRef.current.phase === "held") {
      dragSelectRef.current?.(t.clientX, t.clientY);
    }
  }, [dispatch]);
  const touchEnd = useCallback(() => {
    if (hasPointerEvents()) return;
    dispatch({ type: "up" });
    reportDragEnd();
  }, [dispatch, reportDragEnd]);
  const touchCancel = useCallback(() => {
    if (hasPointerEvents()) return;
    dispatch({ type: "cancel" });
  }, [dispatch]);

  const onClick = useCallback((e: React.MouseEvent) => {
    // The trailing click after a long press (or after an abandoned gesture) is
    // swallowed: without this the asset would ALSO open. This applies whether
    // or not the gesture is enabled — a disabled tile cannot be `held`, so it
    // simply falls through to the exactly-once no-op below.
    if (held || stateRef.current.phase === "held") {
      e.preventDefault();
      e.stopPropagation();
      setHeld(false);
      stateRef.current = initialPressState();
      return;
    }
    // A short tap was already handled as `activate` on pointer/touch up (in
    // both the enabled and disabled cases); making the click a no-op here keeps
    // activation exactly-once on every WebView.
    e.preventDefault();
    e.stopPropagation();
  }, [held]);

  const handlers: PressHandlers = {
    onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onPointerLeave,
    onContextMenu,
    onTouchStart: touchStart, onTouchMove: touchMove, onTouchEnd: touchEnd, onTouchCancel: touchCancel,
    onClick,
  };
  // R7a: the REAL scroll-takeover guard, attached natively (React's synthetic
  // touchmove cannot opt out of passivity). Both layouts get it through this
  // one call: each tile passes its host element's ref into the hook.
  useNonPassivePressGuard(hostRef, stateRef, (x, y) => {
    if (stateRef.current.phase === "held") dragSelectRef.current?.(x, y);
  });
  return { handlers, held };
}

/**
 * R7a — the held-drag scroll guard. ONE non-passive `touchmove` listener on
 * the gesture's host element, phase-aware against the LIVE state:
 *
 *   - armed / moved / cancelled / idle: the listener does NOTHING, so the
 *     page keeps its normal scrolling and a move past the slop still just
 *     cancels the pending press. Nothing is blocked before the threshold.
 *   - held: `preventDefault()` stops the WebView from starting its default
 *     pan (which on the MI 8's WebView 83 fires pointercancel and kills the
 *     drag), and the coordinates go to the SAME onDragSelect callback the
 *     pointer path uses.
 *
 * This is why the listener must be native and non-passive: React attaches
 * touchmove passively at the root, where preventDefault is a no-op. It is
 * attached for the gesture's whole lifetime, but it only ever acts in the
 * held phase — never a blanket touch-action:none.
 */
export function useNonPassivePressGuard(
  ref: React.RefObject<HTMLElement | null> | undefined,
  stateRef: React.RefObject<PressState>,
  onHeldMove: (x: number, y: number) => void,
): void {
  const moveRef = useRef(onHeldMove);
  useEffect(() => { moveRef.current = onHeldMove; }, [onHeldMove]);
  useEffect(() => {
    const el = ref?.current;
    if (!el) return;
    const handler = (e: TouchEvent) => {
      if (stateRef.current.phase !== "held") return; // before the threshold: scroll freely
      e.preventDefault(); // held: this gesture owns the move — no default pan
      const t = e.touches[0];
      if (t) moveRef.current(t.clientX, t.clientY);
    };
    el.addEventListener("touchmove", handler, { passive: false });
    return () => el.removeEventListener("touchmove", handler);
  }, [ref, stateRef]);
}
