import { hasReadableBody, type CachedNote } from "../../services/noteProvenance.ts";

/** Search navigation is presentation metadata, never a document mutation. */
export type BodyRange = { from: number; to: number };
export type NoteSearchTarget = { query: string; bodyRange?: BodyRange };
export type NoteSearchEvidence = NoteSearchTarget & { snippet?: string; outdated?: boolean };
export type DesktopNoteScope = { instance: string; vault: string; directory: string };

/** Literal Unicode matching. Escaping prevents query syntax from becoming regex. */
export function bodyMatchRanges(body: string, query: string): BodyRange[] {
  const needle = query.trim();
  if (!needle || !body) return [];
  const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  const ranges: BodyRange[] = [];
  for (const match of body.matchAll(pattern)) ranges.push({ from: match.index!, to: match.index! + match[0].length });
  return ranges;
}

export function noteSearchEvidence(query: string, body: unknown, outdated = false): NoteSearchEvidence | undefined {
  const q = query.trim();
  if (!q) return undefined;
  const range = typeof body === "string" ? bodyMatchRanges(body, q)[0] : undefined;
  if (!range || typeof body !== "string") return { query: q };
  const from = Math.max(0, range.from - 24), to = Math.min(body.length, range.to + 24);
  return { query: q, bodyRange: range, outdated,
    snippet: (from ? "…" : "") + body.slice(from, to) + (to < body.length ? "…" : "") };
}

export function desktopNoteRoute(instance: string, vault: string, id: string): string {
  return `desktop:${encodeURIComponent(instance)}:${encodeURIComponent(vault)}:${encodeURIComponent(id)}`;
}

/** Admission is exact-scope; unexpected rows fail closed, never get relabelled. */
export function assertNoteSearchScope(items: Array<{instanceId?: string; vaultId?: string}>, scope: DesktopNoteScope): void {
  if (items.some(row => row.instanceId !== scope.instance || row.vaultId !== scope.vault)) {
    throw new Error("CONTENT_SOURCE_CHANGED");
  }
}

/** Match evidence follows the same body provenance gate as the editor. */
export function readableNoteSearchEvidence(query: string, note: CachedNote): NoteSearchEvidence | undefined {
  return noteSearchEvidence(query, hasReadableBody(note) ? note.content : undefined, Boolean(note.bodyOutdated));
}
