// MATERIAL-LIBRARY-INSTANT-R1 R7b — drag-follow auto-scroll for the held
// drag-select.
//
// R7/R7a let a held long press sweep-select tiles under the finger, but only
// the ones already on screen: the finger cannot scroll while it owns the
// gesture, so anything below the fold was unreachable. Albums solve this with
// an edge hot zone — when the held finger parks near the top or bottom of the
// scroller, the scroller keeps scrolling gently and the selection keeps
// growing as new tiles pass under the (stationary) finger.
//
// This module owns ONLY the scroll mechanics. The page supplies the same
// "select whatever is under this point" callback the live moves already use,
// so there is exactly ONE selection path; the loop simply re-invokes it as the
// content moves. No timers survive a stop(): the loop is rAF-based and every
// entry point clears it.

export type DragAutoScroll = {
  /** Feed the current finger position (viewport coords) + the scroller. */
  update(scroller: HTMLElement, y: number, selectAt: (x: number, y: number) => void, x: number): void;
  /** Stop scrolling and drop the loop (finger up, selection exited, unmount). */
  stop(): void;
  /** True while the auto-scroll loop is running. */
  active(): boolean;
};

/** The hot zone depth at which edge scrolling engages (CSS px). */
export const EDGE_ZONE = 84;
/** Clamp for the per-frame scroll speed at the deepest point of the zone. */
export const MAX_STEP = 13;
/** Minimum per-frame step once inside the zone (a crawl, not a jump). */
export const MIN_STEP = 2;

/**
 * Pure decision: how far to scroll THIS frame for a finger at `y` inside the
 * scroller's viewport rect. 0 outside the zones; a ramped 2..13px inside,
 * growing with depth into the zone. Exposed for tests.
 */
export function edgeScrollStep(y: number, rectTop: number, rectBottom: number): number {
  if (y < rectTop || y > rectBottom) return 0;
  const fromTop = y - rectTop;
  const fromBottom = rectBottom - y;
  let depth = 0;
  if (fromTop < EDGE_ZONE) depth = Math.max(depth, EDGE_ZONE - fromTop);
  if (fromBottom < EDGE_ZONE) depth = Math.max(depth, EDGE_ZONE - fromBottom);
  if (depth <= 0) return 0;
  const t = Math.min(1, depth / EDGE_ZONE);
  return Math.round(MIN_STEP + (MAX_STEP - MIN_STEP) * t);
}

/** Which direction the zone at `y` scrolls (viewport coords). */
export function edgeScrollDir(y: number, rectTop: number, rectBottom: number): -1 | 0 | 1 {
  const fromBottom = rectBottom - y;
  if (fromBottom < EDGE_ZONE && fromBottom <= y - rectTop) return 1;  // bottom zone scrolls down
  if (y - rectTop < EDGE_ZONE) return -1;                             // top zone scrolls up
  return 0;
}

export function createDragAutoScroll(): DragAutoScroll {
  let raf = 0;
  let scroller: HTMLElement | null = null;
  let x = 0;
  let y = 0;
  let selectAt: ((x: number, y: number) => void) | null = null;

  const tick = () => {
    raf = 0;
    if (!scroller) return;
    const r = scroller.getBoundingClientRect();
    const step = edgeScrollStep(y, r.top, r.bottom);
    if (step <= 0) return; // the finger left the zones — the loop parks
    const dir = edgeScrollDir(y, r.top, r.bottom);
    const before = scroller.scrollTop;
    scroller.scrollTop = before + dir * step;
    if (scroller.scrollTop === before && dir !== 0) return; // hit a scroll bound
    // The content moved under the stationary finger: grow the selection with
    // the SAME hit-test the live moves use.
    selectAt?.(x, y);
    raf = requestAnimationFrame(tick);
  };

  return {
    update(next: HTMLElement, nextY: number, nextSelectAt: (x: number, y: number) => void, nextX: number) {
      scroller = next;
      y = nextY;
      x = nextX;
      selectAt = nextSelectAt;
      if (!raf) raf = requestAnimationFrame(tick);
    },
    stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      scroller = null;
      selectAt = null;
    },
    active() {
      return raf !== 0;
    },
  };
}
