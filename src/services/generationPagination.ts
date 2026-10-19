// Reusable generation-safe pagination primitive (M2.10 Scope C/D).
//
// A small generic state machine shared by the Local Inbox list, the Local
// Notes list and the global search results. Same contract as the M2.9
// libraryPagination helper, generalized over an item-key extractor:
//
//  - page 1 initial load; 加载更多 appends page N+1 (deduped by key);
//  - every DB-affecting query/filter change resets to page 1 and bumps the
//    monotonic `generation`;
//  - page-1 / load-more responses commit ONLY when their generation still
//    matches the current state — a late response from an old query (success
//    or error) is ignored completely;
//  - commitNextPage also rejects a wrong-page response defensively;
//  - `total`/`hasMore` always reflect the backend contract.

export type PagedState<T> = {
  items: T[];
  page: number;
  total: number;
  hasMore: boolean;
  loading: boolean;
  generation: number;
};

export function initialPaged<T>(): PagedState<T> {
  return { items: [], page: 0, total: 0, hasMore: false, loading: false, generation: 0 };
}

export function pagedStart(state: PagedState<unknown>): number {
  return state.page + 1;
}

/** Reset for a NEW query: clears rows and bumps the generation. */
export function resetPaged<T>(prev: PagedState<T>): PagedState<T> {
  return { ...initialPaged<T>(), generation: prev.generation + 1 };
}

/**
 * Reset for a NEW query/epoch with an EXPLICIT generation: clears rows and
 * aligns the state to the request epoch the caller already issued. Unlike
 * `resetPaged` (relative bump), this can never drift after a mode excursion
 * that cleared rows WITHOUT a request (e.g. Knowledge entering Desktop mode
 * while an in-flight Local Note request exists) — the next commit always sees
 * `state.generation === epoch`.
 */
export function resetPagedTo<T>(prev: PagedState<T>, generation: number): PagedState<T> {
  void prev; // carries the item type for inference; only the generation is explicit
  return { ...initialPaged<T>(), generation };
}

export function pagedLoading<T>(state: PagedState<T>): PagedState<T> {
  return { ...state, loading: true };
}

function appendPaged<T>(
  state: PagedState<T>,
  page: number,
  items: T[],
  total: number,
  hasMore: boolean,
  keyOf: (item: T) => string
): PagedState<T> {
  const seen = new Set(state.items.map(keyOf));
  const fresh = items.filter((a) => a && keyOf(a) && !seen.has(keyOf(a)));
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
 * since moved to a newer generation, the response is stale and ignored.
 */
export function commitPagedPageOne<T>(
  state: PagedState<T>,
  generation: number,
  items: T[],
  total: number,
  hasMore: boolean,
  keyOf: (item: T) => string
): PagedState<T> {
  if (state.generation !== generation) {
    return state;
  }
  const base = { ...initialPaged<T>(), generation };
  return appendPaged(base, 1, items, total, hasMore, keyOf);
}

/**
 * Commit a load-more response for `generation` that must append to `page`.
 * Rejected (state unchanged) when the query moved to a newer generation or
 * the expected page no longer follows the current state.
 */
export function commitPagedNextPage<T>(
  state: PagedState<T>,
  generation: number,
  page: number,
  items: T[],
  total: number,
  hasMore: boolean,
  keyOf: (item: T) => string
): PagedState<T> {
  if (state.generation !== generation || page !== state.page + 1) {
    return state;
  }
  return appendPaged(state, page, items, total, hasMore, keyOf);
}
