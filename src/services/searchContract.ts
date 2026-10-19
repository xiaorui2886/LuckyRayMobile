// Unified search contract constants/helpers (M2.10 Scope B).
// Dependency-free so the exact contract is unit-testable without the Tauri
// client: page size, debounce, and the typed result key.
// The session hook (`unifiedSearch.ts`) implements the async generation-safe
// behavior on top of these.

export const SEARCH_PAGE_SIZE = 50;
export const SEARCH_DEBOUNCE_MS = 250;

/** Stable identity of a unified-search result row (typed id). */
export function searchResultKey(r: { resultType: string; id: string }): string {
  return `${r.resultType}:${r.id}`;
}
