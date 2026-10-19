// Local Library pagination helper (FIX-V1 P1-2 / FIX-V1B P1).
// Pure state transitions so the exact contract is unit-testable:
//  - page size 50 (bounded, keeps the grid light);
//  - page 1 initial load; 加载更多 appends page N+1;
//  - every DB-affecting query/filter change resets to page 1;
//  - hasMore comes from the backend and is false on the final page;
//  - appends never duplicate an already-loaded asset id;
//  - a monotonic `generation` identifies the current query. Page-1 and
//    load-more responses commit ONLY when their generation still matches
//    (FIX-V1B P1 stale-async-response guard): a late response from an old
//    query — success or error — is ignored completely.

export const LOCAL_PAGE_SIZE = 50;

export type LocalPageState = {
  items: any[];
  page: number;
  total: number;
  hasMore: boolean;
  loading: boolean;
  /** Monotonic query generation. Every DB-affecting query/filter change bumps
   * it via `resetLocalPage`; stale responses carry an older generation and
   * are dropped by `commitPageOne` / `commitNextPage`. */
  generation: number;
};

export function initialLocalPage(): LocalPageState {
  return { items: [], page: 0, total: 0, hasMore: false, loading: false, generation: 0 };
}

export function localPageStart(state: LocalPageState): number {
  return state.page + 1;
}

/**
 * Reset pagination for a NEW query: clears rows and bumps the generation.
 * The new generation must be captured by the caller and attached to the next
 * page-1 request so `commitPageOne` can reject late responses.
 */
export function resetLocalPage(prev: LocalPageState): LocalPageState {
  return { ...initialLocalPage(), generation: prev.generation + 1 };
}

/** Mark the state as loading (used before page-1 fetch and before load-more). */
export function localPageLoading(state: LocalPageState): LocalPageState {
  return { ...state, loading: true };
}

/** Append a fetched page (1-based `page`) to the current state, deduping by
 * assetId. `total`/`hasMore` always reflect the backend contract. Generation
 * is preserved: this is an in-query transition only. */
export function appendLocalPage(
  state: LocalPageState,
  page: number,
  items: any[],
  total: number,
  hasMore: boolean
): LocalPageState {
  const seen = new Set(state.items.map((a) => a.assetId));
  const fresh = items.filter((a) => a && a.assetId && !seen.has(a.assetId));
  return {
    ...state,
    items: [...state.items, ...fresh],
    page,
    total,
    hasMore,
    loading: false,
  };
}

/**
 * Commit a page-1 response captured under `generation`. When the state has
 * since moved to a newer generation (query/filter changed), the response is
 * stale and the current state is returned unchanged — no rows from the old
 * query are ever reintroduced.
 */
export function commitPageOne(
  state: LocalPageState,
  generation: number,
  items: any[],
  total: number,
  hasMore: boolean
): LocalPageState {
  if (state.generation !== generation) {
    return state;
  }
  // Fresh page-1 base keeps the same generation (same query, first page).
  const base = { ...initialLocalPage(), generation };
  return appendLocalPage(base, 1, items, total, hasMore);
}

/**
 * Commit a load-more response for `generation` that must append to `page`.
 * Rejected (state unchanged) when:
 *  - the query moved to a newer generation (stale response), or
 *  - the expected page no longer follows the current state (defensive:
 *    a double-tap or an unexpected reset would otherwise corrupt the list).
 */
export function commitNextPage(
  state: LocalPageState,
  generation: number,
  page: number,
  items: any[],
  total: number,
  hasMore: boolean
): LocalPageState {
  if (state.generation !== generation || page !== state.page + 1) {
    return state;
  }
  return appendLocalPage(state, page, items, total, hasMore);
}
