// Local Notes pager (M2.10 FIX-V1 P1-2) — dependency-free controller for the
// Knowledge screen's Local Notes list.
//
// ONE request-epoch authority (`gen`) drives both the pagination state AND
// every request, so local → Desktop → local excursions can never drift:
//
//  - `reload(filters)` starts a local-filter page-1 load under a fresh epoch;
//  - `enterDesktop()` invalidates any in-flight Local Note request AND clears
//    the rows with an ALIGNED generation (never an unrelated zero) — the old
//    code reset to `initialPaged()` (generation 0) while the ref kept
//    counting, so the first page-1 after returning from Desktop rejected its
//    own commit and left the list empty/loading forever;
//  - late responses (success or error) from an old epoch are ignored;
//  - an error settles without advancing the state generation away from the
//    request epoch, so the next filter/query keeps working;
//  - `loadMore` appends the exact next page under the current epoch.

import {
  commitPagedNextPage,
  commitPagedPageOne,
  initialPaged,
  pagedLoading,
  pagedStart,
  resetPagedTo,
  type PagedState,
} from "./generationPagination.ts";

export type NoteFilters = {
  /** The search text is part of the REQUEST IDENTITY: a query change must
   *  invalidate the current pagination generation, otherwise a loadMore that
   *  lands inside the debounce window would fetch the new query and append it
   *  under the previous query's rows. */
  q?: string;
  tag?: string;
  pinned?: boolean;
  favorite?: boolean;
  archived?: boolean;
  /** Bounded sort vocabulary applied by the AUTHORITY before LIMIT/OFFSET. */
  sort?: "recent" | "name";
};

export type NotePageResponse = {
  items?: any[];
  total?: number;
  hasMore?: boolean;
};

export type FetchNotePage = (f: NoteFilters & { page: number; limit: number }) => Promise<NotePageResponse>;

export const NOTE_PAGE_SIZE = 50;

/**
 * Truthful loaded-vs-total text for a partially loaded local filter
 * (FIX-V1B P1-C): `null` when nothing is loaded or the filter is fully
 * loaded — never a fake partial claim.
 */
export function notesLoadedText(loaded: number, total: number): string | null {
  if (total <= 0 || loaded <= 0 || loaded >= total) return null;
  return `已加载 ${loaded} / 共 ${total}`;
}

export class LocalNotesPager {
  private gen = 0;
  private state: PagedState<any> = initialPaged();
  private listeners = new Set<(s: PagedState<any>) => void>();
  // Explicit fields (no TS parameter properties — the node
  // --experimental-strip-types test runner only accepts erasable syntax).
  private fetchPage: FetchNotePage;
  /** The immutable request identity of the ACTIVE generation. */
  private request: NoteFilters = {};
  private onError: (e: any) => void;
  private keyOf: (n: any) => string;

  constructor(
    fetchPage: FetchNotePage,
    onError: (e: any) => void = () => {},
    keyOf: (n: any) => string = (n) => n?.noteId ?? ""
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

  /** Enter Desktop mode: invalidate in-flight Local Note requests; clear rows
   * with an ALIGNED generation (same epoch authority, never an unrelated
   * zero), so returning to a local filter commits its page-1 normally. */
  enterDesktop(): void {
    this.gen += 1;
    this.state = resetPagedTo(this.state, this.gen);
    this.emit();
  }

  /**
   * R4.1: fence WITHOUT destroying. Leaving the Local source (or the whole
   * Knowledge root unmounting) must kill any in-flight request so it can
   * never commit later — but the last-good rows STAY, so returning to the
   * same identity repaints them synchronously (cache-first). A fresh
   * `reload`/`revalidate` under a new generation supersedes them normally.
   */
  suspend(): void {
    this.gen += 1;
    if (this.state.loading) {
      this.state = { ...this.state, loading: false };
      this.emit();
    }
  }

  /** The immutable request identity of the last COMMITTED (or active) load. */
  currentRequest(): NoteFilters {
    return this.request;
  }

  /** True when last-good rows are retained in state (cache-first repaint). */
  hasLoadedRows(): boolean {
    return this.state.items.length > 0;
  }

  /**
   * R4.1: a rows-retained refresh. The generation moves (in-flight work is
   * fenced) and page-1 is fetched again, but the last-good rows stay painted
   * until the fresh page-1 COMMIT swaps them — no blank frame. Used for
   * local-mutation data-version refreshes on the SAME identity.
   */
  revalidate(filters: NoteFilters): void {
    const gen = ++this.gen;
    this.request = { ...filters };
    this.state = { ...resetPagedTo(this.state, gen), items: this.state.items, page: this.state.page, total: this.state.total, hasMore: this.state.hasMore, loading: true };
    this.emit();
    this.fetchPage({ ...filters, page: 1, limit: NOTE_PAGE_SIZE })
      .then((r) => {
        if (gen !== this.gen) return;
        this.state = commitPagedPageOne(this.state, gen, r.items || [], r.total || 0, Boolean(r.hasMore), this.keyOf);
        this.emit();
      })
      .catch((e: any) => {
        if (gen !== this.gen) return;
        this.state = { ...this.state, loading: false };
        this.emit();
        this.onError(e);
      });
  }

  /**
   * A filter/query change: invalidate the CURRENT generation immediately so no
   * in-flight or subsequent `loadMore` can continue the previous request, then
   * start the fresh page-1. Used when the page-1 fetch is debounced: the
   * caller inactivates now and reloads when the debounce settles.
   */
  invalidate(): void {
    this.gen += 1;
    this.state = resetPagedTo(this.state, this.gen);
    this.emit();
  }

  /** Local-filter page-1 (initial load, filter change, or local mutation). */
  reload(filters: NoteFilters): void {
    const gen = ++this.gen;
    this.request = { ...filters };
    this.state = pagedLoading(resetPagedTo(this.state, gen));
    this.emit();
    this.fetchPage({ ...filters, page: 1, limit: NOTE_PAGE_SIZE })
      .then((r) => {
        if (gen !== this.gen) return; // stale success: ignore
        this.state = commitPagedPageOne(this.state, gen, r.items || [], r.total || 0, Boolean(r.hasMore), this.keyOf);
        this.emit();
      })
      .catch((e: any) => {
        if (gen !== this.gen) return; // stale error: ignore
        // Settled error without advancing the epoch: rows cleared, state
        // generation stays aligned so the next reload always commits.
        this.state = resetPagedTo(this.state, gen);
        this.emit();
        this.onError(e);
      });
  }

  /**
   * 加载更多 — appends page N+1 of the CURRENT request identity
   * (single-flight). `identity` is the same immutable filter/query object the
   * active page-1 used; a mismatch means the caller is holding a stale set of
   * filters, so nothing is fetched (no mixed page can ever be appended).
   */
  async loadMore(identity?: NoteFilters): Promise<void> {
    const st = this.state;
    if (st.loading || !st.hasMore) return;
    if (identity && !sameRequest(this.request, identity)) return;
    const gen = this.gen;
    const page = pagedStart(st);
    this.state = { ...st, loading: true };
    this.emit();
    try {
      const r = await this.fetchPage({ ...this.request, page, limit: NOTE_PAGE_SIZE });
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

/** True when two filter sets describe the SAME pager request identity. */
export function sameRequest(a: NoteFilters, b: NoteFilters): boolean {
  return (a.q ?? "") === (b.q ?? "")
    && (a.tag ?? "") === (b.tag ?? "")
    && a.pinned === b.pinned
    && a.favorite === b.favorite
    && a.archived === b.archived
    && (a.sort ?? "recent") === (b.sort ?? "recent");
}
