// Local Asset pager (LOCAL-LIBRARY-USABILITY-R1) — the ONE request-epoch
// authority for the Still Library's local list. Mirrors the Local Notes pager
// (#73 CLOSURE-R1): the request identity is immutable, a filter/query change
// invalidates the current generation BEFORE any debounced page-1 fetch, and
// loadMore can only continue the ACTIVE identity — so a load-more that lands
// inside the debounce window can never append under the previous request.
//
// Reuses the shared generationPagination primitives (no second pagination
// authority, no generic framework).

import {
  commitPagedNextPage,
  commitPagedPageOne,
  initialPaged,
  pagedLoading,
  pagedStart,
  resetPagedTo,
  type PagedState,
} from "./generationPagination.ts";

export type AssetFilters = {
  /** Search text — part of the request identity. */
  q?: string;
  kind?: string;
  /** Local tag filter — Local-only, never leaked into Desktop queries. */
  tag?: string;
  favorite?: boolean;
  archived?: boolean;
  /** Bounded sort vocabulary applied by the AUTHORITY before LIMIT/OFFSET. */
  sort?: "recent" | "name" | "size";
};

export type AssetPageResponse = {
  items?: any[];
  total?: number;
  hasMore?: boolean;
};

export type FetchAssetPage = (f: AssetFilters & { page: number; limit: number }) => Promise<AssetPageResponse>;

export const ASSET_PAGE_SIZE = 50;

/**
 * Truthful loaded-vs-total text for a partially loaded list: `null` when
 * nothing is loaded or the filter is fully loaded — never a fake partial claim.
 */
export function assetsLoadedText(loaded: number, total: number): string | null {
  if (total <= 0 || loaded <= 0 || loaded >= total) return null;
  return `已加载 ${loaded} / 共 ${total}`;
}

/** True when two filter sets describe the SAME pager request identity. */
export function sameAssetRequest(a: AssetFilters, b: AssetFilters): boolean {
  return (a.q ?? "") === (b.q ?? "")
    && (a.kind ?? "") === (b.kind ?? "")
    && (a.tag ?? "") === (b.tag ?? "")
    && a.favorite === b.favorite
    && a.archived === b.archived
    && (a.sort ?? "recent") === (b.sort ?? "recent");
}

export class LocalAssetPager {
  private gen = 0;
  private state: PagedState<any> = initialPaged();
  /** The immutable request identity of the ACTIVE generation. */
  private request: AssetFilters = {};
  /** Outcome of the last page-1 attempt (REPAIR-R3). */
  private outcome: "pending" | "settled" | "error" = "pending";
  private listeners = new Set<(s: PagedState<any>) => void>();
  private fetchPage: FetchAssetPage;
  private onError: (e: any) => void;
  private keyOf: (a: any) => string;

  constructor(
    fetchPage: FetchAssetPage,
    onError: (e: any) => void = () => {},
    keyOf: (a: any) => string = (a) => a?.assetId ?? ""
  ) {
    this.fetchPage = fetchPage;
    this.onError = onError;
    this.keyOf = keyOf;
  }

  getState(): PagedState<any> {
    return this.state;
  }

  subscribe(fn: (s: PagedState<any>) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.state);
  }

  /** Enter Desktop mode: invalidate in-flight Local Asset requests and clear
   *  rows with an ALIGNED generation, so returning to the local source commits
   *  its page-1 normally. */
  enterDesktop(): void {
    this.gen += 1;
    // Same reasoning as invalidate(): a retired attempt is not settled.
    this.outcome = "pending";
    this.state = resetPagedTo(this.state, this.gen);
    this.emit();
  }

  /**
   * A filter/query change: invalidate the CURRENT generation immediately (no
   * in-flight or subsequent loadMore can continue it), then start the fresh
   * page-1. The caller may debounce the reload — the invalidation already
   * closed the mixing window.
   */
  invalidate(): void {
    this.gen += 1;
    // REPAIR-R4: a new identity starts PENDING. Without this the outcome would
    // still describe the PREVIOUS identity's settled attempt, so during the
    // debounce before reload(B) the page could derive "settled empty" from a
    // stale success and flash 没有找到素材 before B was ever requested.
    this.outcome = "pending";
    this.state = resetPagedTo(this.state, this.gen);
    this.emit();
  }

  /** Local page-1 (initial load, filter/query change, or local mutation). */
  reload(filters: AssetFilters): void {
    const gen = ++this.gen;
    this.request = { ...filters };
    // REPAIR-R3 (1): the attempt outcome is explicit. `loading === false` is
    // NOT evidence of success — a rejected fetch also clears loading — so the
    // page reads this instead of inferring emptiness from pager state.
    this.outcome = "pending";
    this.state = pagedLoading(resetPagedTo(this.state, gen));
    this.emit();
    this.fetchPage({ ...filters, page: 1, limit: ASSET_PAGE_SIZE })
      .then((r) => {
        if (gen !== this.gen) return; // stale success: ignore
        this.state = commitPagedPageOne(this.state, gen, r.items || [], r.total || 0, Boolean(r.hasMore), this.keyOf);
        // A successful page-1 is settled even when it returned zero rows.
        this.outcome = "settled";
        this.emit();
      })
      .catch((e: any) => {
        if (gen !== this.gen) return; // stale error: ignore
        this.state = resetPagedTo(this.state, gen);
        this.outcome = "error";
        this.emit();
        this.onError(e);
      });
  }

  /** The last page-1 attempt's outcome for the CURRENT generation. */
  lastOutcome(): "pending" | "settled" | "error" {
    return this.outcome;
  }

  /**
   * Same-identity background refresh (UX-POLISH-R1 3.3): the visible rows
   * stay mounted and the fresh page-1 swaps in when it commits -- the list
   * never blanks. A background store/version event must NOT clear what the
   * user is looking at; only an identity change (query/filter/source) goes
   * through `reload`.
   *
   * Guards:
   *  - identity moved on: refused, the reload path owns it;
   *  - nothing loaded yet: refused, the initial reload owns it;
   *  - a page fetch or another revalidate in flight: refused (bounded:
   *    one mutation = at most one revalidate);
   *  - the generation bump fences any in-flight loadMore against stale data,
   *    and the state generation is realigned so later loadMores still work.
   */
  private revalidating = false;
  revalidate(filters: AssetFilters): void {
    if (!sameAssetRequest(this.request, filters)) return;
    if (this.state.loading || this.revalidating) return;
    if (this.state.page === 0 && this.state.items.length === 0) return;
    const gen = ++this.gen;
    this.revalidating = true;
    this.fetchPage({ ...filters, page: 1, limit: ASSET_PAGE_SIZE })
      .then((r) => {
        this.revalidating = false;
        if (gen !== this.gen) return; // superseded: reload/invalidate owns it now
        const base: PagedState<any> = { ...initialPaged(), generation: gen };
        this.state = commitPagedPageOne(base, gen, r.items || [], r.total || 0, Boolean(r.hasMore), this.keyOf);
        this.emit();
      })
      .catch(() => {
        this.revalidating = false;
        if (gen !== this.gen) return;
        // Keep the last known rows exactly as they were; realign the state to
        // the new epoch so a later loadMore continues it.
        this.state = { ...this.state, loading: false, generation: gen };
        this.emit();
      });
  }

  /**
   * 加载更多 — appends page N+1 of the ACTIVE request identity (single-flight).
   * `identity` is the same immutable filter object the caller renders with; a
   * mismatch means the caller holds a stale identity, so nothing is fetched.
   */
  async loadMore(identity?: AssetFilters): Promise<void> {
    const st = this.state;
    // REPAIR-R1 P2-R1: a revalidation is in flight, so the generation the
    // caller holds is about to be superseded — starting page N+1 now would
    // commit under a resnapshot. Refuse; the caller retries after it settles.
    if (this.revalidating) return;
    if (st.loading || !st.hasMore) return;
    if (identity && !sameAssetRequest(this.request, identity)) return;
    const gen = this.gen;
    const page = pagedStart(st);
    this.state = { ...st, loading: true };
    this.emit();
    try {
      const r = await this.fetchPage({ ...this.request, page, limit: ASSET_PAGE_SIZE });
      if (gen !== this.gen) return; // stale success: ignore
      this.state = commitPagedNextPage(this.state, gen, page, r.items || [], r.total || 0, Boolean(r.hasMore), this.keyOf);
      this.emit();
    } catch (e: any) {
      if (gen !== this.gen) return; // stale error: ignore
      this.state = { ...this.state, loading: false };
      this.emit();
      this.onError(e);
    }
  }
}
