// Still Sheet drag decision (pure, unit-testable).
//
// The authority Sheet closes a drag when it travels past 72 CSS px, or when a
// short flick exceeds 0.6 px/ms. Android WebViews may lose the pointer
// (setPointerCapture arbitration → pointercancel) mid-drag; the compatibility
// Sheet treats a CANCELLED gesture that already passed the distance threshold
// as an intentional dismissal, and anything less springs back.

export type DragDecision = "dismiss" | "spring-back";

export const DRAG_DISMISS_DISTANCE = 72;
export const DRAG_FLICK_DISTANCE = 20;
export const DRAG_FLICK_VELOCITY = 0.6;

export function dragDismissDecision(dy: number, dtMs: number, cancelled = false): DragDecision {
  if (dy > DRAG_DISMISS_DISTANCE) return "dismiss";
  if (dy > DRAG_FLICK_DISTANCE && dy / Math.max(dtMs, 1) > DRAG_FLICK_VELOCITY) return "dismiss";
  if (cancelled && dy > DRAG_DISMISS_DISTANCE) return "dismiss";
  return "spring-back";
}
