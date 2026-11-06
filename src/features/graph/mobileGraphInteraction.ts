/** Desktop graph interaction orchestration, independent of DOM and React. */
import type { GraphPhysicsNode } from './core/graphPhysics';
import type { GraphPlaybackPlan } from './core/graphPlayback';

export type MobileGraphPosition = { key: string; x: number; y: number; vx: number; vy: number };
export const graphPositionIsFinite = (value: MobileGraphPosition) =>
  !!value && typeof value.key === 'string' && [value.x, value.y, value.vx, value.vy].every(Number.isFinite);

/** Pointer input owns only the grabbed body. Accept the same worker step for its
 * neighbours, rather than invalidating all results on every pointer move. */
export function mergeGraphWorkerPositions(nodes: GraphPhysicsNode[], state: Float64Array, draggedId: number | null): boolean {
  if (state.length !== nodes.length * 4) return false;
  for (let i = 0; i < nodes.length; i++) {
    const offset = i * 4;
    if (!Number.isFinite(state[offset]) || !Number.isFinite(state[offset + 1]) || !Number.isFinite(state[offset + 2]) || !Number.isFinite(state[offset + 3])) return false;
  }
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].id === draggedId) continue;
    const offset = i * 4;
    Object.assign(nodes[i], { x: state[offset], y: state[offset + 1], vx: state[offset + 2], vy: state[offset + 3] });
  }
  return true;
}

/** Same birth state as GraphPage.activateGraphRevealNodes: children enter near
 * the live parent, not at their final layout coordinates. */
export function activateGraphPlaybackBodies(timeline: GraphPlaybackPlan, elapsed: number,
  nodes: ReadonlyArray<{ id: number; links: number }>, bodies: Map<number, GraphPhysicsNode>, active: Set<number>) {
  let changed = false;
  for (const node of nodes) {
    const plan = timeline.nodes.get(node.id), body = bodies.get(node.id);
    if (!plan || !body || active.has(node.id) || elapsed < plan.startAt) continue;
    let x = plan.spawnX, y = plan.spawnY;
    const parent = plan.parentId === null ? null : bodies.get(plan.parentId);
    if (parent && active.has(parent.id)) {
      const angle = (node.id * 2.399963229728653) % (Math.PI * 2), separation = Math.min(4.2, 1.8 + node.links * .12);
      x = parent.x + Math.cos(angle) * separation; y = parent.y + Math.sin(angle) * separation;
    }
    plan.spawnX = x; plan.spawnY = y; body.x = x; body.y = y;
    const dx = plan.targetX - x, dy = plan.targetY - y, distance = Math.max(1, Math.hypot(dx, dy));
    body.vx = dx / distance * 1.45; body.vy = dy / distance * 1.45;
    active.add(node.id); changed = true;
  }
  return changed;
}

export function dragGraphPlaybackBody(timeline: GraphPlaybackPlan | null, id: number, elapsed: number,
  point: { x: number; y: number }, previous: { x: number; y: number }) {
  const plan = timeline?.nodes.get(id);
  if (!timeline || !plan) return;
  plan.spawnX = plan.targetX = point.x; plan.spawnY = plan.targetY = point.y;
  plan.startAt = elapsed - plan.duration;
  for (const child of timeline.nodes.values()) {
    if (child.parentId !== id || child.startAt <= elapsed) continue;
    child.spawnX += point.x - previous.x; child.spawnY += point.y - previous.y;
  }
}

/** Both normal and tree edges follow their actual visual endpoints. Progress is
 * opacity; multiplying the endpoint again disconnects a newborn child. */
export function graphVisualEdgeEndpoint<T extends { x: number; y: number }>(_from: T, to: T): T { return to; }

export function graphPointerMoved(start: { x: number; y: number }, point: { x: number; y: number }): boolean {
  return Math.hypot(point.x - start.x, point.y - start.y) > 4;
}
