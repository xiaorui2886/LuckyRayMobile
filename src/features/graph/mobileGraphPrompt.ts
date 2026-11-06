import type { GraphSeed, GraphSeedNode } from './core/graphTypes';
/** Explicit user-requested clipboard context only; never sends a model request. */
export function mobileGraphNodeQuestion(seed: GraphSeed, selected: GraphSeedNode): string {
  const ids = new Set<number>();
  for (const [a, b] of seed.edges) { if (a === selected.id) ids.add(b); if (b === selected.id) ids.add(a); }
  const clean = (value: string, length: number) => value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, length);
  const neighbors = seed.nodes.filter(n => ids.has(n.id));
  const labels = neighbors.slice(0, 20).map(n => `- ${clean(n.label, 100)}`).join('\n');
  return `请帮我分析这张本地图谱中“${clean(selected.label, 180)}”的关联，说明可以如何整理和继续研究。\n\n中心节点：${clean(selected.label, 180)}\n相邻节点（仅标题，不含笔记正文）：\n${labels || '暂无直接关联节点'}${neighbors.length > 20 ? `\n（另有 ${neighbors.length - 20} 个相邻节点未列出）` : ''}\n\n这些只是图谱中的节点名称和连接，不代表内容已被验证。请区分已知关联与推测，不要假装读过笔记正文。`;
}
