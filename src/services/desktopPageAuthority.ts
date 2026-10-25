// One authority owns both the active material-page request and retained views.
// Views are keyed by every source axis; navigation restores only that exact
// view while a generation-guarded read revalidates its already-loaded extent.
// Unpairing and verified access loss are destructive boundaries, not refreshes.

export type DesktopSource = {
  /** Required: the Desktop instance the request is issued against. */
  owner: string;
  library?: string;
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
  /** The exact identity (owner+library+query+folder+tag+kind) that produced `rows`. */
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
  /** Continuation returned by the source; may be non-consecutive. */
  nextPage: number | null;
  error: string;
};

/** The identity string every request and every commit is keyed by. */
export function desktopIdentityOf(source: DesktopSource): string {
  // Opaque source axes may contain "|" or marker-like text. Encoding every
  // axis prevents two distinct scopes from sharing a retained snapshot.
  const axes = ["desktop", ...[source.owner, (source.query || "").trim(), source.folder || "", source.tag || ""].map(encodeURIComponent)];
  if (source.library) axes.push(`library:${encodeURIComponent(source.library)}`);
  if (source.kind) axes.push(`kind:${encodeURIComponent(source.kind)}`);
  return axes.join("|");
}

type RetainedView = {
  owner: string;
  library: string;
  loadedExtent: number;
  snapshot: DesktopSnapshot;
};

// A shared stable miss is important for useSyncExternalStore before effects
// bind the selected identity. Never return the active scope's unrelated rows.
const COLD_SNAPSHOT: DesktopSnapshot = {
  owner: "", identity: "", rows: [], refreshing: false, stale: false,
  settled: false, cold: true, page: 0, hasMore: false, nextPage: null, error: "",
};
const MAX_RETAINED_VIEWS = 24;

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
  /** Settled, inactive views in navigation-recency order; never persisted. */
  private retained = new Map<string, RetainedView>();

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

  private emit(invalidateCurrent = true): void {
    // The snapshot object is replaced only on a real truth change, so
    // useSyncExternalStore never sees a spurious new value.
    if (invalidateCurrent) this.cached = null;
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
        nextPage: this.nextPage,
        error: this.error,
      };
    }
    return this.cached;
  }

  /** Synchronous render gate, including the render BEFORE a navigation effect. */
  snapshotFor(identity: string): DesktopSnapshot {
    if (identity && identity === this.identity && this.owner) return this.snapshot();
    return this.retained.get(identity)?.snapshot || COLD_SNAPSHOT;
  }

  private remember(): void {
    if (!this.committed || !this.settled) return;
    const snapshot = this.snapshot();
    this.retained.delete(this.identity);
    this.retained.set(this.identity, {
      owner: this.owner,
      library: this.source.library || "",
      loadedExtent: this.loadedExtent,
      // The request is retired by navigation, so do not retain a stuck spinner.
      snapshot: snapshot.refreshing ? { ...snapshot, refreshing: false } : snapshot,
    });
    while (this.retained.size > MAX_RETAINED_VIEWS) {
      this.retained.delete(this.retained.keys().next().value!);
    }
  }

  private resetPage(): void {
    this.committed = "";
    this.rows = [];
    this.refreshing = false;
    this.stale = false;
    this.settled = false;
    this.cold = true;
    this.page = 0;
    this.loadedExtent = 0;
    this.hasMore = false;
    this.nextPage = null;
    this.error = "";
    this.cached = null;
  }

  private activate(owner: string, source: Omit<DesktopSource, "owner">): void {
    const identity = desktopIdentityOf({ ...source, owner });
    // Pin the destination before saving the old view: at capacity the view
    // being revisited may itself be the oldest retained entry.
    const destination = this.retained.get(identity);
    if (destination) this.retained.delete(identity);
    this.remember();
    this.owner = owner;
    this.identity = identity;
    this.source = { ...source };
    this.resetPage();
    const retained = destination || this.retained.get(this.identity);
    if (!retained) return;
    const snapshot = retained.snapshot;
    this.committed = snapshot.owner;
    this.rows = snapshot.rows;
    this.stale = snapshot.stale;
    this.settled = snapshot.settled;
    this.cold = snapshot.cold;
    this.page = snapshot.page;
    this.loadedExtent = retained.loadedExtent;
    this.hasMore = snapshot.hasMore;
    this.nextPage = snapshot.nextPage;
    this.error = snapshot.error;
    this.cached = snapshot;
    // The live view is held in the active fields, not twice in the LRU.
    this.retained.delete(this.identity);
  }

  private purgeScope(owner: string, library?: string): boolean {
    let changed = false;
    for (const [identity, view] of this.retained) {
      if (view.owner === owner && (library === undefined || view.library === library)) {
        this.retained.delete(identity);
        changed = true;
      }
    }
    if (owner && this.owner === owner && (library === undefined || (this.source.library || "") === library)) {
      this.generation += 1;
      this.resetPage();
      changed = true;
    }
    return changed;
  }

  /** Revoke all views of an owner, or only one exact library (including ""). */
  invalidateScope(owner: string, library?: string): void {
    if (this.purgeScope(owner, library)) this.emit(false);
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
   * Retire old work before starting the newly bound scope. Even a same-scope
   * bind reissues work because native retirement may have cancelled its read.
   * Only an unpair clears protected history; ordinary navigation retains it.
   */
  bind(owner: string, source: Omit<DesktopSource, "owner">): boolean {
    this.generation += 1;
    if (!owner) {
      this.retained.clear();
      this.owner = "";
      this.identity = "";
      this.source = { ...source };
      this.resetPage();
      this.emit();
      return false;
    }
    this.activate(owner, source);
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
    // Restore an exact visited view, never carry rows across identity axes.
    if (identity !== this.identity) this.activate(owner, source);
    // Capture inputs: later caller mutation cannot retarget subsequent pages.
    source = { ...source };
    this.source = source;
    const extent = Math.max(1, this.loadedExtent);
    const gen = ++this.generation;
    this.refreshing = true;
    this.error="";
    this.cold = false;
    this.emit();
    // Revalidate only the extent the user already loaded, not the whole library.
    // Swap it atomically so deleted rows disappear without dropping to page1.
    const read = async () => {
      let rows: DesktopRow[] = [], last: DesktopPage = {items:[],hasMore:false}, page=1, count=0, cached=false;
      while (true) {
        if (gen !== this.generation || this.owner !== owner) return null;
        const value = await this.fetchPage(owner, { ...source, owner }, page);
        if (gen !== this.generation || this.owner !== owner || this.identity !== identity) return null;
        last = this.pageOf(value, page);
        count++;
        cached ||= Boolean(last.cached || last.source === "cache");
        rows = this.merge(rows, last.items);
        if (count >= extent || !last.hasMore) return { ...last, items:rows, page, count, cached };
        page = last.nextPage!;
      }
    };
    read().then((value) => {
      // Fail-closed currentness: the generation must still be the live one AND
      // the owner must still be the bound one.
      if (!value || gen !== this.generation || this.owner !== owner || this.identity !== identity) return;
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
      if (gen !== this.generation || this.owner !== owner || this.identity !== identity) return;
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

  private failAccess(error: unknown): void {
    const message = String(error);
    // Transport failures may be Errors, strings, or structured service errors.
    const details = error && typeof error === "object" ? error as { code?: unknown; status?: unknown; httpStatus?: unknown } : {};
    const code = [message, details.code, details.status, details.httpStatus].join(" ").toUpperCase();
    const authDenied = /(?:^|\D)401(?:\D|$)|UNAUTHORIZED|AUTH_REVOKED|PAIRING_REQUIRED|NOT_PAIRED/.test(code);
    const scopeDenied = /(?:^|\D)(?:403|404|410)(?:\D|$)|FORBIDDEN|REVOKED|NOT_FOUND|READ_NOT_GRANTED|GRANT_REQUIRED|SCOPE_DENIED|SCOPE_UNAVAILABLE|LIBRARY_NOT_AVAILABLE|PERMISSION_REQUIRED/.test(code);
    if (authDenied || scopeDenied) {
      this.purgeScope(this.owner, authDenied ? undefined : this.source.library || "");
      this.refreshing = false;
      this.stale = true;
      this.cold = false;
    }
    this.error = message;
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
      if (gen!==this.generation || owner!==this.owner || identity!==this.identity) return;
      const rows=this.merge(this.rows,value.items);
      if (value.hasMore && rows.length===this.rows.length) throw new Error("MATERIAL_PAGE_NO_PROGRESS");
      this.rows=rows; this.page=page; this.loadedExtent++; this.hasMore=value.hasMore; this.nextPage=value.nextPage || null;
      this.refreshing=false; this.error="";this.stale=this.stale || Boolean(value.cached || value.source==="cache"); this.emit();
    } catch(error) {
      if (gen!==this.generation || owner!==this.owner || identity!==this.identity) return;
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
    this.retained.clear();
    this.owner = "";
    this.identity = "";
    this.resetPage();
  }
}

/** Render gate: rows are shown only for the EXACT current identity. */
export function rowsForSnapshot(snapshot: DesktopSnapshot, currentOwner: string, currentIdentity: string): DesktopRow[] {
  if (!currentOwner) return [];
  if (snapshot.owner !== currentOwner) return [];
  if (snapshot.identity !== currentIdentity) return [];
  return snapshot.rows;
}
