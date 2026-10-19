// MATERIAL-LIBRARY-INSTANT-R1 REPAIR-R5 (C/D) — long-press authority, PURE core.
//
// Kept free of React and of the DOM so the gesture's decision table can be
// driven directly by node's strip-types test runner. The component wrapper in
// `pressGesture.ts` is a thin adapter over this reducer; neither the grid tile
// nor the list row implements its own timer, so the two can never diverge.
//
// The states are deliberately explicit. The bug this prevents is the classic
// long-press double-activation: the browser fires a `click` after the press
// completes, and a naive implementation both opens the asset AND enters
// selection. `held` is the latch that makes the trailing click inert.

export type PressConfig = {
  /** Hold duration that counts as a long press (ms). */
  threshold: number;
  /** Movement (px) beyond which the press is treated as a scroll/drag. */
  slop: number;
};

/** 450–550ms as required by the task card, settled at the midpoint. */
export const LONG_PRESS_THRESHOLD = 500;
/** A finger that moves more than this is scrolling, not pressing. */
export const LONG_PRESS_SLOP = 10;

export const DEFAULT_PRESS_CONFIG: PressConfig = {
  threshold: LONG_PRESS_THRESHOLD,
  slop: LONG_PRESS_SLOP,
};

export type PressState = {
  /** "idle" -> nothing touched; "armed" -> pointer down, timer running;
   *  "held"  -> the long press already fired for this gesture;
   *  "moved" -> cancelled by movement/scroll; "cancelled" -> cancelled by the
   *  platform (pointercancel / lost capture). */
  phase: "idle" | "armed" | "held" | "moved" | "cancelled";
  originX: number;
  originY: number;
};

export function initialPressState(): PressState {
  return { phase: "idle", originX: 0, originY: 0 };
}

export type PressEvent =
  | { type: "down"; x: number; y: number }
  | { type: "move"; x: number; y: number }
  | { type: "up" }
  | { type: "cancel" }
  /** The platform timer elapsed (the caller owns the timer itself). */
  | { type: "timeout" };

export type PressEffect =
  /** Start the caller's long-press timer. */
  | { type: "arm" }
  /** Stop the caller's long-press timer. */
  | { type: "disarm" }
  /** The long press fired: enter selection and select this asset. */
  | { type: "longpress" }
  /** A genuine short tap: open the asset. */
  | { type: "activate" }
  | { type: "none" };

/**
 * The gesture decision table.
 *
 * The critical rows:
 *  - `armed` + `timeout`      -> longpress (and latch into `held`)
 *  - `held`  + `up`           -> none (the trailing click must NOT also open)
 *  - `armed` + any movement beyond slop -> disarm + `moved`
 *  - `moved`/`cancelled` + `up` -> none (no accidental open after a scroll)
 */
export function reducePress(
  state: PressState,
  event: PressEvent,
  config: PressConfig = DEFAULT_PRESS_CONFIG,
): { state: PressState; effect: PressEffect } {
  switch (event.type) {
    case "down":
      // A new gesture always starts clean, whatever the previous one left.
      return {
        state: { phase: "armed", originX: event.x, originY: event.y },
        effect: { type: "arm" },
      };
    case "move": {
      if (state.phase !== "armed") return { state, effect: { type: "none" } };
      const dx = event.x - state.originX;
      const dy = event.y - state.originY;
      if (Math.sqrt(dx * dx + dy * dy) <= config.slop) {
        return { state, effect: { type: "none" } };
      }
      // Movement past the slop means the user is scrolling: the long press must
      // be abandoned so a scroll never enters selection mode.
      return { state: { ...state, phase: "moved" }, effect: { type: "disarm" } };
    }
    case "timeout":
      if (state.phase !== "armed") return { state, effect: { type: "none" } };
      return { state: { ...state, phase: "held" }, effect: { type: "longpress" } };
    case "cancel":
      if (state.phase !== "armed") return { state, effect: { type: "none" } };
      return { state: { ...state, phase: "cancelled" }, effect: { type: "disarm" } };
    case "up":
      if (state.phase === "armed") {
        // Released before the threshold: a genuine short tap.
        return { state: initialPressState(), effect: { type: "activate" } };
      }
      // `held` -> the long press already acted, so the trailing click is
      // swallowed. `moved`/`cancelled` -> the gesture was abandoned, so no
      // activation either. In all three cases the gesture simply ends.
      return { state: initialPressState(), effect: { type: "none" } };
    default:
      return { state, effect: { type: "none" } };
  }
}

/** True while the gesture must swallow a trailing click (long press already acted). */
export function suppressesClick(state: PressState): boolean {
  return state.phase === "held";
}

/** True when the wrapper should keep a long-press timer running. */
export function isArmed(state: PressState): boolean {
  return state.phase === "armed";
}
