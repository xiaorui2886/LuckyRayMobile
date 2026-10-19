// MATERIAL-LIBRARY-INSTANT-R1 REPAIR-R7c — mainstream album RANGE select.
//
// R7/R7b's drag grew the selection append-only ("whatever the finger touched
// joins, forever"). The album semantics users expect are a RANGE: the long
// press fixes an ANCHOR, the drag (or the auto-scroll it drives) moves an
// ENDPOINT, and the selection is always
//
//     baseline ∪ orderedIds[min(anchor, endpoint) .. max(anchor, endpoint)]
//
// so dragging further grows the range, dragging back SHRINKS it, items the
// finger never crossed (e.g. the other grid column) still join, and items the
// user had picked manually before the drag stay picked. Whitespace keeps the
// last valid endpoint; finger-up freezes the range (afterwards plain taps
// toggle individually again).
//
// Pure on purpose: grid and list share this ONE helper and the tests drive
// every branch directly.

export type RangeDrag = {
  /** The ordered position of the long-pressed anchor asset. */
  anchorIndex: number;
  /** The selection as it was when the drag began (manual picks survive). */
  baseline: string[];
};

/**
 * Recompute the live selection for a drag whose endpoint is
 * `endpointIndex` over `orderedIds`. A null endpoint keeps the anchor-only
 * range (the drag just began, or nothing valid has been crossed yet — the
 * CALLER keeps the last valid endpoint across whitespace, so this null only
 * happens at drag start).
 */
export function selectionWithRange(
  drag: RangeDrag,
  endpointIndex: number | null,
  orderedIds: string[],
): string[] {
  const end = endpointIndex == null ? drag.anchorIndex : endpointIndex;
  const lo = Math.max(0, Math.min(drag.anchorIndex, end));
  const hi = Math.min(orderedIds.length - 1, Math.max(drag.anchorIndex, end));
  const set = new Set(drag.baseline);
  for (let i = lo; i <= hi; i += 1) {
    const id = orderedIds[i];
    if (id != null) set.add(id);
  }
  return [...set];
}

/** The index of `id` in the page's rendered order, or null when absent. */
export function indexOfId(orderedIds: string[], id: string): number | null {
  const i = orderedIds.indexOf(id);
  return i === -1 ? null : i;
}
