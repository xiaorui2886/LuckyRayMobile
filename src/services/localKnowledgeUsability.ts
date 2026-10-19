// LOCAL-KNOWLEDGE-USABILITY-R1 — pure helpers for the Still knowledge root's
// local-notes surface. Framework-free so the production behavior is directly
// unit-testable (same seam as the pager / filter-draft services).

import type { KnowledgeFilterState } from "./filterDraft";

/** Tags available on the Local Note authority, derived from the loaded rows
 *  (same rule as the legacy Knowledge screen) plus the applied tag so an
 *  active tag can always be un-applied from the sheet. */
export function collectTags(notes: any[], extra: string): string[] {
  const set = new Set<string>();
  for (const n of notes) for (const t of n.tags || []) set.add(t);
  if (extra) set.add(extra);
  return [...set].slice(0, 24);
}

/**
 * Truthful empty-state matrix for the LOCAL list (USABILITY-R1 E). Pure —
 * unit-tested directly. `action` names the single low-noise next step; a real
 * empty library invites writing, every filtered state invites adjusting the
 * filter instead of re-creating notes.
 */
export function describeLocalEmpty(input: {
  mode: KnowledgeFilterState["mode"];
  tag: string;
  query: string;
}): { title: string; body: string; action: "new" | "filter" | "clear-search" } {
  if (input.mode === "archived") {
    return { title: "归档箱是空的", body: "归档的笔记会保存在这里，随时可以恢复。", action: "filter" };
  }
  if (input.mode === "pinned") {
    return { title: "还没有置顶笔记", body: "在笔记的更多操作里选择置顶，重要的想法会留在这里。", action: "filter" };
  }
  if (input.mode === "favorite") {
    return { title: "还没有收藏的笔记", body: "在笔记的更多操作里选择收藏，喜欢的想法会留在这里。", action: "filter" };
  }
  if (input.tag) {
    return { title: `#${input.tag} 下暂时没有笔记`, body: "换个标签，或清除筛选再看看。", action: "filter" };
  }
  if (input.query.trim()) {
    return { title: "没有找到匹配的笔记", body: "换个关键词，或清除搜索再看看。", action: "clear-search" };
  }
  return { title: "给想法留个位置", body: "新建一篇笔记，想到什么就写下来。", action: "new" };
}

/** The local toolbar heading: range label + applied tag, truthful to what the
 *  list is actually filtered by. */
export function localHeadingFor(applied: KnowledgeFilterState, sortLabels: { name: string }): string {
  const range = applied.mode === "archived" ? "已归档"
    : applied.mode === "pinned" ? "置顶笔记"
    : applied.mode === "favorite" ? "收藏"
    : applied.sort === "name" ? sortLabels.name
    : "";
  return (range ? range + (applied.tag ? " · " : "") : "") + (applied.tag ? `#${applied.tag}` : "");
}
