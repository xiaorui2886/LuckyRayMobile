// MATERIAL-LIBRARY-INSTANT-R1 REPAIR-R5 — ONE authority for the Desktop page.
//
// The permanent "正在读取素材…" on the physical device had a single root cause:
// the page had TWO independent effects that both advanced the same generation
// counter. The page-1 request effect ran `++gen` and issued its request, and the
// owner-lifecycle effect then ran `++gen` again to invalidate the page. Whichever
// order React happened to run them in, the owner bind could retire the request
// the SAME commit had just started, so the response was dropped on arrival and
// nothing re-issued it — the page stayed pending until the user pressed Refresh,
// which changed `reloadKey` and started a fresh request.
//
// The fix is structural rather than a reordering: ONE object owns the Desktop
// owner lifecycle AND the request sequencing, and the ordering that used to be
// left to effect declaration order is now an explicit, testable transition
// inside it:
//
//   bind(owner)   -- retire the previous page and its rows immediately
//                 -- THEN start the current identity's page-1, as the FIRST
//                    request for the new owner, which nothing can retire
//   request(...)  -- ordinary page-1 for the CURRENT identity (query/folder/tag
//                    change, explicit refresh, Desktop-domain store event)
//   loadMore(...) -- append, only while the caller's identity is still active
//
// Currentness is fail-closed exactly as before: a request may only commit while
// BOTH its own generation and the live owner match. Desktop A -> B therefore
// drops any late A response and lets B's first request commit on its own.
//
// The authority owns no React state and no timers: it is an ordinary object the
// page subscribes to, which is what makes the ordering directly testable.

export type DesktopSource = {
  /** Required: the Desktop instance the request is issued against. */
  owner: string;
  query: string;
  folder: string;
  tag: string;
  kind?: string;
};

export type DesktopRow = any;
export type DesktopPage = { items: DesktopRow[]; page?: number; hasMore: boolean; nextPage?: number | null; cached?: boolean; source?: string };

export type DesktopSnapshot = {
  /** The owner that produced `rows`. "" means "no committed page". */
  owner: string;
  /** The exact identity (owner+query+folder+tag) that produced `rows`. */
  identity: string;
  rows: DesktopRow[];
  /** A request for the CURRENT identity is in flight. */
  refreshing: boolean;
  /** The last request for the current identity failed (rows are last-good). */
  stale: boolean;
  /** A request for the current identity returned — including a zero-row page. */
  settled: boolean;
  /** True while no request for the current identity has ever been issued. */
  cold: boolean;
  page: number;
  hasMore: boolean;
  error: string;
};

/** The identity string every request and every commit is keyed by. */
export function desktopIdentityOf(source: DesktopSource): string {
  const axes=["desktop", source.owner, (source.query || "").trim(), source.folder || "", source.tag || ""];
  if(source.kind) axes.push(`kind:${source.kind}`);
  return axes.join("|");
}

export class DesktopPageAuthority {
  private generation = 0;
  /** The BOUND owner: whose page this authority is currently responsible for. */
  private owner = "";
  /** The COMMITTED owner: whose rows are currently held ("" = none). */
  private committed = "";
  private identity = "";
  private rows: DesktopRow[] = [];
  private refreshing = false;
  private stale = false;
  private settled = false;
  private cold = true;
  private page = 0;
  private loadedExtent = 0;
  private hasMore = false;
  private nextPage: number | null = null;
  private error = "";
  private source: Omit<DesktopSource, "owner"> = { query: "", folder: "", tag: "" };
  /** A listener set, so the page can subscribe with useSyncExternalStore. */
  private listeners = new Set<() => void>();
  /** Stable snapshot identity for React: only replaced when truth changes. */
  private cached: DesktopSnapshot | null = null;

  /** The real Desktop page-1 read: (owner, source) -> rows. */
  private readonly fetchPage: (owner: string, source: DesktopSource, page: number) => Promise<DesktopRow[] | DesktopPage>;
  /** Reported when a request for the CURRENT identity fails. */
  private readonly onError: (error: unknown) => void;

  constructor(
    fetchPage: (owner: string, source: DesktopSource, page: number) => Promise<DesktopRow[] | DesktopPage>,
    onError: (error: unknown) => void = () => {},
  ) {
    this.fetchPage = fetchPage;
    this.onError = onError;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit(): void {
    // The snapshot object is replaced only on a real truth change, so
    // useSyncExternalStore never sees a spurious new value.
    this.cached = null;
    for (const fn of this.listeners) fn();
  }

  snapshot(): DesktopSnapshot {
    if (!this.cached) {
      this.cached = {
        // `owner`/`identity` describe the COMMITTED page, which is what the
        // render gate compares against. A bound-but-unanswered owner commits
        // nothing, so it reports "" and no row can render under it.
        owner: this.committed,
        identity: this.committed ? this.identity : "",
        rows: this.rows,
        refreshing: this.refreshing,
        stale: this.stale,
        settled: this.settled,
        cold: this.cold,
        page: this.page,
        hasMore: this.hasMore,
        error: this.error,
      };
    }
    return this.cached;
  }

  /** The owner whose rows are currently committed ("" if none). */
  committedOwner(): string {
    return this.committed;
  }

  /** The owner this authority is currently bound to ("" if unpaired). */
  boundOwner(): string {
    return this.owner;
  }

  /**
   * The owner lifecycle AND the first request, in one ordered transition.
   *
   * Retire-then-request is the whole point: the invalidation happens while the
   * generation is bumped for the retirement, and the new request takes the NEXT
   * generation. No second effect can bump the counter afterwards, so the first
   * request for a freshly bound owner cannot be invalidated by its own bind.
   */
  bind(owner: string, source: Omit<DesktopSource, "owner">): boolean {
    // 1. Retire unconditionally: A's rows, A's staleness and A's identity all
    //    stop being renderable the moment the owner changes. B never inherits
    //    them, even for the one render before the new response lands.
    this.owner = owner;
    this.committed = "";
    this.identity = desktopIdentityOf({ ...source, owner });
    this.rows = [];
    this.refreshing = false;
    this.stale = false;
    this.settled = false;
    this.cold = true;
    this.page = 0; this.loadedExtent=0; this.hasMore = false; this.nextPage = null;
    this.error="";
    this.generation += 1;
    this.emit();
    // 2. Then issue the current identity's page-1 as the FIRST request for this
    //    owner. This is the request that used to get retired by step 1.
    if (!owner) return false;
    this.request(source);
    return true;
  }

  /**
   * A page-1 read for the CURRENT owner. Used for a query/folder/tag change, an
   * explicit refresh, and Desktop-domain store events — never for a bare owner
   * change (that is `bind`). Retained rows for the same identity stay painted
   * while it runs, so this is stale-while-revalidate, not a cold reload.
   *
   * REPAIR-R5b — COALESCING. Several independent page effects legitimately ask
   * for "the current Desktop page" on the same commit: the owner bind, the
   * query/folder/tag identity effect and the Desktop-domain store effect all
   * fire on first mount. Because each one took a new generation, the later
   * calls retired the earlier request, so a first entry into 电脑 could burn
   * three page-1 reads and commit none of the first two. A request for the
   * identity that is ALREADY in flight is therefore a no-op: the outstanding
   * request already answers exactly what the caller is asking for. A genuinely
   * different identity, and any call made after the current one settles, still
   * issues a real read.
   *
   * `force` is the caller saying "I mean it" — an explicit user refresh. It
   * bypasses the coalescing so the user always gets a real re-read.
   */
  request(source: Omit<DesktopSource, "owner">, force = false): void {
    const owner = this.owner;
    if (!owner) return;
    const identity = desktopIdentityOf({ ...source, owner });
    // Same owner + same identity + already in flight -> already answered.
    // Checked BEFORE mutating anything, so a coalesced call cannot retire the
    // call it is coalescing onto.
    if (!force && this.refreshing && identity === this.identity) return;
    // A request whose identity differs from the bound one is an identity
    // change: the previous rows no longer answer this request.
    if (identity !== this.identity) {
      this.identity = identity;
      this.committed = "";
      this.rows = [];
      this.settled = false;
      this.cold = true;
      this.page = 0; this.loadedExtent=0; this.hasMore = false; this.nextPage = null;
    }
    this.source = { ...source };
    const extent = Math.max(1, this.loadedExtent);
    const gen = ++this.generation;
    this.refreshing = true;
    this.error="";
    this.cold = false;
    this.emit();
    // Revalidate only the extent the user already loaded, not the whole library.
    // Swap it atomically so deleted rows disappear without dropping to page1.
    const read = async () => {
      let rows: DesktopRow[] = [], last: DesktopPage = {items:[],hasMore:false}, page=1, count=0;
      while (true) {
        if (gen !== this.generation || this.owner !== owner) return null;
        const value = await this.fetchPage(owner, { ...source, owner }, page);
        last = this.pageOf(value, page);
        count++;
        rows = this.merge(rows, last.items);
        if (count >= extent || !last.hasMore) return { ...last, items:rows, page, count };
        page = last.nextPage!;
      }
    };
    read().then((value) => {
      // Fail-closed currentness: the generation must still be the live one AND
      // the owner must still be the bound one.
      if (!value || gen !== this.generation || this.owner !== owner) return;
      this.rows = value.items;
      this.loadedExtent=value.count;
      this.page = value.page; this.hasMore = value.hasMore; this.nextPage = value.nextPage || null;
      this.identity = identity;
      this.committed = owner;
      this.refreshing = false;
      this.stale = Boolean(value.cached || value.source === "cache");
      this.settled = true;
      this.cold = false;
      this.error="";
      this.emit();
    }).catch((error: unknown) => {
      if (gen !== this.generation || this.owner !== owner) return;
      // A failed refresh KEEPS the last-good rows for this exact identity and
      // only adds a quiet stale flag — the grid is never blanked by a
      // transient error, and a failure is never reported as a settled empty.
      // `settled` describes the COMMITTED page, so a failure must not clear it:
      // retained rows are still a real, settled answer being shown.
      this.refreshing = false;
      this.stale = true;
      this.cold = false;
      this.failAccess(error);
      this.emit();
      this.onError(error);
    });
  }

  private pageOf(value: DesktopRow[] | DesktopPage, page: number): DesktopPage {
    if (Array.isArray(value)) return {items:value, page, hasMore:false, nextPage:null};
    const next = value.nextPage ?? page + 1;
    if (value.hasMore && (!Number.isInteger(next) || next <= page)) throw new Error("MATERIAL_PAGE_INVALID");
    return {...value, items:value.items || [], page, nextPage:value.hasMore ? next : null};
  }

  private failAccess(error:unknown):void {
    this.error=String(error);
    if (/401|403|404|410|FORBIDDEN|REVOKED|NOT_FOUND|SOURCE_CHANGED/.test(this.error)) {
      this.rows=[];this.committed="";this.settled=false;this.loadedExtent=0;this.page=0;this.hasMore=false;this.nextPage=null;
    }
  }

  private merge(base: DesktopRow[], next: DesktopRow[]): DesktopRow[] {
    const rows = new Map(base.map(row => [row.desktopAssetId, row]));
    for (const row of next) if (row.desktopAssetId) rows.set(row.desktopAssetId, row);
    return [...rows.values()];
  }

  /** Same authority, immutable source and generation; duplicate taps coalesce. */
  async loadMore(source: Omit<DesktopSource, "owner">): Promise<void> {
    const owner=this.owner, identity=desktopIdentityOf({...source,owner});
    if (!owner || this.refreshing || !this.hasMore || !this.nextPage || identity!==this.identity) return;
    const gen=this.generation, page=this.nextPage;
    this.refreshing=true; this.emit();
    try {
      const value=this.pageOf(await this.fetchPage(owner,{...this.source,owner},page),page);
      if (gen!==this.generation || owner!==this.owner) return;
      const rows=this.merge(this.rows,value.items);
      if (value.hasMore && rows.length===this.rows.length) throw new Error("MATERIAL_PAGE_NO_PROGRESS");
      this.rows=rows; this.page=page; this.loadedExtent++; this.hasMore=value.hasMore; this.nextPage=value.nextPage || null;
      this.refreshing=false; this.error="";this.stale=Boolean(value.cached || value.source==="cache"); this.emit();
    } catch(error) {
      if (gen!==this.generation || owner!==this.owner) return;
      this.refreshing=false; this.stale=true;this.failAccess(error); this.emit(); this.onError(error);
    }
  }

  /**
   * Re-run the CURRENT identity without changing it. Same semantics as
   * `request`, with the current source re-supplied by the caller. Coalesces
   * like `request` unless `force` is set (an explicit user refresh).
   */
  revalidate(source: Omit<DesktopSource, "owner">, force = false): void {
    this.request(source, force);
  }

  /** True while `identity` is the identity the authority is currently bound to. */
  isCurrent(identity: string): boolean {
    return identity === this.identity && this.owner !== "";
  }

  /** Test/diagnostics: number of generations issued (binds + requests). */
  generationCount(): number {
    return this.generation;
  }

  dispose(): void {
    this.generation += 1;
    this.listeners.clear();
    this.cached = null;
  }
}

/** Render gate: rows are shown only for the EXACT current identity. */
export function rowsForSnapshot(snapshot: DesktopSnapshot, currentOwner: string, currentIdentity: string): DesktopRow[] {
  if (!currentOwner) return [];
  if (snapshot.owner !== currentOwner) return [];
  if (snapshot.identity !== currentIdentity) return [];
  return snapshot.rows;
}
