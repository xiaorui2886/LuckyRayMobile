// Unified search session (M2.10 FIX-V1 P1-1) — dependency-free controller.
//
// One deterministic request-epoch authority for a shared search session, so
// every A → B → late-A transition is unit-testable without React.
//
// The M2.10 hook kept TWO counters (state.generation vs queryGenRef) and only
// invalidated the old query when the debounce actually fired:
//  - Bug A: a late response from query A could overwrite the user's newer
//    draft B inside the debounce window (the success handler wrote
//    `query: A`, reverting the input and cancelling B's debounce);
//  - Bug B: an active-query error bumped state.generation while the ref
//    stayed put, so the next request could reject its own success forever.
//
// This session fixes both with ONE epoch:
//  - `setQuery(draft)` advances the epoch IMMEDIATELY at input-change time —
//    before B's debounce fires, A's in-flight response is already stale;
//  - the debounced request captures that already-issued epoch;
//  - state.generation is always aligned to the epoch (never two counters);
//  - responses NEVER write the draft text (`query` is input-owned);
//  - an error settles the state WITHOUT advancing the epoch, so typing a new
//    query works normally afterwards;
//  - clearing the input clears rows/error and invalidates every old request;
//  - `refresh()` (local-data invalidation) re-runs only the ACTIVE query and
//    never resurrects an older query over a newer draft.
//
// FIX-V1B additions:
//  - P1-A: on A → B input change the visible result state becomes truthful
//    immediately — A's committed rows/total/hasMore are cleared and the
//    session enters a pending state, so old rows can never be seen/clicked
//    under draft B during the debounce window;
//  - P1-B: `refresh()` advances the epoch, so every q request issued before a
//    local-data refresh is stale and cannot commit afterwards (draft + active
//    query preserved).
//
// Backend page order remains the ranking authority — no client re-ranking.

import {
  commitPagedNextPage,
  commitPagedPageOne,
  initialPaged,
  pagedStart,
  type PagedState,
} from "./generationPagination.ts";
import { SEARCH_DEBOUNCE_MS, SEARCH_PAGE_SIZE, searchResultKey } from "./searchContract.ts";

export type SearchPageResponse = {
  results?: any[];
  total?: number;
  hasMore?: boolean;
};

export type FetchSearchPage = (q: string, page: number, limit: number) => Promise<SearchPageResponse>;

export type UnifiedSearchState = PagedState<any> & {
  /** Draft/input query — owned by the user's typing; NEVER written by a response. */
  query: string;
  /** Committed/active query — the query the in-flight/last request ran for. */
  activeQuery: string;
  error: string;
};

const initialSearchState: UnifiedSearchState = {
  ...initialPaged(),
  query: "",
  activeQuery: "",
  error: "",
};

export class UnifiedSearchSession {
  private gen = 0;
  private state: UnifiedSearchState = initialSearchState;
  private activeQuery = "";
  private listeners = new Set<(s: UnifiedSearchState) => void>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  // Explicit fields (no TS parameter properties — the node
  // --experimental-strip-types test runner only accepts erasable syntax).
  private fetchPage: FetchSearchPage;
  private debounceMs: number;

  constructor(fetchPage: FetchSearchPage, debounceMs: number = SEARCH_DEBOUNCE_MS) {
    this.fetchPage = fetchPage;
    this.debounceMs = debounceMs;
  }

  getState(): UnifiedSearchState {
    return this.state;
  }

  subscribe(fn: (s: UnifiedSearchState) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.state);
  }

  /**
   * User typed / cleared the input. The epoch advances synchronously, so any
   * in-flight response from the previous query is stale IMMEDIATELY — before
   * the debounce timer for the new draft even fires.
   *
   * FIX-V1B P1-A: the visible result state is ALSO made truthful immediately —
   * the previous query's committed rows/total/hasMore are cleared and the
   * session enters a pending (loading) state, so old rows can never be seen
   * or clicked under the new draft during the debounce window.
   */
  setQuery(draft: string): void {
    this.gen += 1;
    this.clearPendingDebounce();
    if (!draft.trim()) {
      // Clearing: rows/error cleared, all old requests invalidated.
      this.state = { ...initialSearchState, generation: this.gen };
      this.emit();
      return;
    }
    this.state = {
      ...initialPaged(),
      query: draft,
      activeQuery: this.activeQuery,
      error: "",
      loading: true, // pending: B's debounce has not fired yet
      generation: this.gen,
    };
    this.emit();
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.runPageOne(draft);
    }, this.debounceMs);
  }

  /**
   * Local-data invalidation refresh: re-runs only the ACTIVE (already
   * committed) query. When the user has typed a newer draft, the pending
   * debounce owns the session and refresh does nothing — it must never
   * restore the older active query over the newer draft.
   *
   * FIX-V1B P1-B: refresh creates a FRESH request epoch — every q request
   * (page-1, load-more, or error) issued before this refresh is stale and may
   * not commit afterwards, while draft + active query stay the same.
   */
  refresh(): void {
    const q = this.activeQuery;
    if (!q) return;
    if (this.state.query.trim() !== q) return;
    this.clearPendingDebounce();
    this.gen += 1;
    this.runPageOne(q); // captures the already-advanced epoch
  }

  /** Debounced page-1 for the CURRENT draft, capturing the already-issued epoch. */
  private runPageOne(q: string): void {
    const trimmed = q.trim();
    if (!trimmed) return;
    const gen = this.gen; // the epoch setQuery already issued — same authority
    this.activeQuery = trimmed;
    this.state = {
      ...initialPaged(),
      query: this.state.query,
      activeQuery: trimmed,
      error: "",
      loading: true,
      generation: gen,
    };
    this.emit();
    this.fetchPage(trimmed, 1, SEARCH_PAGE_SIZE)
      .then((r) => this.commitPageOne(gen, r))
      .catch((e: any) => this.commitError(gen, e));
  }

  private commitPageOne(gen: number, r: SearchPageResponse): void {
    if (gen !== this.gen) return; // stale success (A after B): ignore
    this.state = {
      ...commitPagedPageOne(this.state, gen, r.results || [], r.total || 0, Boolean(r.hasMore), searchResultKey),
      query: this.state.query, // draft NEVER overwritten by a response
      activeQuery: this.activeQuery,
      error: "",
    };
    this.emit();
  }

  private commitError(gen: number, e: any): void {
    if (gen !== this.gen) return; // stale error: cannot poison the newer query
    // Settled error WITHOUT advancing the epoch: state.generation stays at
    // `gen`, so the next query (which bumps the epoch again) always commits.
    this.state = {
      ...initialPaged(),
      query: this.state.query,
      activeQuery: this.activeQuery,
      error: "搜索失败: " + e,
      generation: gen,
    };
    this.emit();
  }

  /** 加载更多 — appends page N+1 of the ACTIVE query (bounded). */
  async loadMore(): Promise<void> {
    const q = this.activeQuery;
    if (!q) return;
    const st = this.state;
    if (st.loading || !st.hasMore) return;
    if (st.query.trim() !== q) return; // a newer draft owns the session
    const gen = this.gen;
    const page = pagedStart(st);
    this.state = { ...st, loading: true };
    this.emit();
    try {
      const r = await this.fetchPage(q, page, SEARCH_PAGE_SIZE);
      if (gen !== this.gen) return; // stale success: ignore
      this.state = {
        ...commitPagedNextPage(this.state, gen, page, r.results || [], r.total || 0, Boolean(r.hasMore), searchResultKey),
        query: this.state.query,
        activeQuery: this.activeQuery,
        error: "",
      };
      this.emit();
    } catch (e: any) {
      if (gen !== this.gen) return; // stale error: ignore
      this.state = { ...this.state, loading: false, error: "加载更多失败: " + e };
      this.emit();
    }
  }

  /** Clear the pending debounce (StrictMode/HMR-safe unmount). */
  dispose(): void {
    this.clearPendingDebounce();
    this.listeners.clear();
  }

  private clearPendingDebounce(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}
