/** Mobile-only presentation. The shared D3 solver, graph topology and saved
 * coordinates remain authoritative; this is the short gap between worker frames. */
import { mixGraphHexColors } from './core/graphRenderer.ts';

export type PresentedGraphPoint = { x: number; y: number };
export function stepMobileGraphPositions(nodes: ReadonlyArray<{ id: number; x: number; y: number }>, presented: Map<number, PresentedGraphPoint>, draggedId: number | null, elapsedMs: number, immediate: boolean): boolean {
  const amount = immediate ? 1 : 1 - Math.exp(-Math.max(1, Math.min(64, elapsedMs)) / 26);
  const live = new Set<number>(); let moving = false;
  for (const node of nodes) {
    live.add(node.id);
    const prior = presented.get(node.id);
    if (!prior || node.id === draggedId || immediate) { presented.set(node.id, { x: node.x, y: node.y }); continue; }
    const x = prior.x + (node.x - prior.x) * amount, y = prior.y + (node.y - prior.y) * amount;
    if (Math.hypot(node.x - x, node.y - y) > .035) { presented.set(node.id, { x, y }); moving = true; }
    else presented.set(node.id, { x: node.x, y: node.y });
  }
  for (const id of presented.keys()) if (!live.has(id)) presented.delete(id);
  return moving;
}

/** Stable density is based on this whole scene, never which labels pan into
 * the viewport. Sparse graphs expose their names earlier, like the reference. */
export function mobileGraphLabelDetail(scale: number, reveal: number, nodeCount: number) {
  const density = Math.min(1, Math.max(0, Math.log2(Math.max(24, nodeCount) / 24) / 5));
  const start = (.16 + density * .30) * Math.pow(2, Math.max(0, Math.min(1.6, reveal)) * .8);
  const t = Math.max(0, Math.min(1, Math.log2(Math.max(.001, scale) / start) / 1.8));
  return { alpha: .78 * t * t * (3 - 2 * t), fontSize: Math.max(8.5, Math.min(16, 10.5 * Math.pow(Math.max(.001, scale), .16))) };
}

export function mobileGraphNodeFill(input: { color: string; background: string; accent: string; focused: boolean; neighbor: boolean; focus: number; document: boolean }) {
  const focus = Math.max(0, Math.min(1, input.focus));
  const resting = input.document ? .79 : .63;
  const weight = input.focused ? resting : input.neighbor ? resting + .10 * focus : resting + (.29 - resting) * focus;
  const base = mixGraphHexColors(input.color, input.background, weight);
  return input.focused ? mixGraphHexColors(input.accent, base, .94 * focus) : base;
}
