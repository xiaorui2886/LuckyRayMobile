// KNOWLEDGE-ORGANIZATION-R1 R1.5-D — search match presentation helpers.
//
// Canonical KnowledgeNoteSummary carries title/revision/parentRelativePath
// but NO server hit ranges or snippet. Mobile may therefore highlight only
// what it can PROVE locally: a literal title match, a literal parent-path
// match, or a match inside the CACHED body preview. Everything here is
// LITERAL string matching (indexOf on a case-folded copy) — the user's query
// is never treated as a regex and never injected as HTML; rendering happens
// through React nodes built from these plain segments.

export type HitSegment = { text: string; hit: boolean };

/** Case-fold for literal Unicode matching (toLowerCase; no locale folding). */
function fold(text: string): string {
  return text.toLowerCase();
}

/**
 * Split `text` into literal segments around every case-insensitive
 * occurrence of `q`. An empty/whitespace query returns one plain segment.
 * Regex metacharacters in `q` are matched literally by construction.
 */
export function literalSegments(text: string, q: string): HitSegment[] {
  if (!text) return [];
  const needle = q.trim();
  if (!needle) return [{ text, hit: false }];
  const haystack = fold(text);
  const lower = fold(needle);
  const segments: HitSegment[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(lower, from);
    if (at < 0) break;
    if (at > from) segments.push({ text: text.slice(from, at), hit: false });
    segments.push({ text: text.slice(at, at + needle.length), hit: true });
    from = at + needle.length;
  }
  if (from < text.length) segments.push({ text: text.slice(from), hit: false });
  return segments.length ? segments : [{ text, hit: false }];
}

/** The first literal case-insensitive match index, or -1. */
export function firstMatchIndex(text: string, q: string): number {
  const needle = q.trim();
  if (!needle || !text) return -1;
  return fold(text).indexOf(fold(needle));
}

/** How many characters of context flank the highlighted hit in a snippet. */
const SNIPPET_RADIUS = 14;

export type BodyHit = {
  segments: HitSegment[];
  /** A short context window around the FIRST cached-body match. */
  snippet: string;
};

/**
 * A proven match inside the CACHED body preview: a short context window
 * around the first literal occurrence, segmented for highlighting. Returns
 * null when the preview does not contain the query (nothing may be invented
 * for an uncached body).
 */
export function bodyHitContext(previewText: string, q: string): BodyHit | null {
  const at = firstMatchIndex(previewText, q);
  if (at < 0) return null;
  const needle = q.trim();
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(previewText.length, at + needle.length + SNIPPET_RADIUS);
  const snippet = (start > 0 ? "…" : "") + previewText.slice(start, end) + (end < previewText.length ? "…" : "");
  return { segments: literalSegments(snippet, needle), snippet };
}

/** What Mobile can PROVE about a search result's visible match. */
export type VisibleMatchKind = "title" | "path" | "body" | "none";

export function visibleMatchKind(row: {
  title: string;
  parentRelativePath: string;
}, cachedPreview: string | undefined, q: string): VisibleMatchKind {
  if (!q.trim()) return "none";
  if (firstMatchIndex(row.title, q) >= 0) return "title";
  if (row.parentRelativePath && firstMatchIndex(row.parentRelativePath, q) >= 0) return "path";
  if (cachedPreview !== undefined && firstMatchIndex(cachedPreview, q) >= 0) return "body";
  return "none";
}

/** The truthful fallback when no visible match can be proven locally. */
export const MATCH_LOCATION_UNKNOWN = "匹配位置需打开笔记查看";

/**
 * R1.6.1-6: an ACTIVE query shows a transient/overlay row ONLY when a LOCAL
 * fact proves the match — a literal title hit, a literal parent-path hit, or
 * a hit inside the local preview. No Desktop detail N+1, no fabricated body.
 */
export function transientMatchesQuery(row: { title: string; parent: string; preview: string }, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  if (row.title.toLowerCase().includes(needle)) return true;
  if (row.parent.toLowerCase().includes(needle)) return true;
  if (row.preview.toLowerCase().includes(needle)) return true;
  return false;
}
