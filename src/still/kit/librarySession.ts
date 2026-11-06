// MATERIAL-LIBRARY-INSTANT-R1 — the ordinary Material Library's presentation
// session: an album-like, cache-first source switch.
//
// Why this exists: the page used to DESTROY the hidden source's rows on a
// source toggle (`enterDesktop()` cleared the Local page; the Desktop effect
// blanked `desktopPage`) and then waited through a 200 ms / 220 ms timer before
// a cold reload — so switching 本机 <-> 电脑 behaved like a fresh page load.
//
// This controller keeps a LAST-GOOD snapshot PER SOURCE plus each source's
// scroll offset, so a toggle paints the retained rows in the same frame and the
// background refresh swaps fresh truth in atomically. It owns NO network and no
// cache of its own: it only sequences what the existing authorities return.

export type LibrarySource = "local" | "desktop";

export type SourceSnapshot<T> = {
  /** The identity these rows belong to (owner / filters / query). */
  identity: string;
  items: T[];
  /** Scroll offset to restore for this source. */
  scrollTop: number;
  /** True while a background refresh for the SAME identity is in flight. */
  refreshing: boolean;
  /** True when the last refresh failed and these rows are the last good ones. */
  stale: boolean;
  /** True once a request for this identity has settled at least once. */
  settled: boolean;
};

export type SourceView<T> = {
  items: T[];
  /** Immediately-paintable retained rows exist for the CURRENT identity. */
  retained: boolean;
  refreshing: boolean;
  stale: boolean;
  settled: boolean;
  scrollTop: number;
};

function emptySnapshot<T>(identity: string): SourceSnapshot<T> {
  return { identity, items: [], scrollTop: 0, refreshing: false, stale: false, settled: false };
}

export class LibrarySession {
  private snapshots: Record<LibrarySource, Map<string, SourceSnapshot<any>>> = {
    local: new Map(), desktop: new Map(),
  };

  private snapshot<T>(source: LibrarySource, identity = this.bound[source]): SourceSnapshot<T> {
    return this.snapshots[source].get(identity) ?? emptySnapshot<T>(identity);
  }

  private store<T>(source: LibrarySource, snapshot: SourceSnapshot<T>): void {
    this.snapshots[source].set(snapshot.identity, snapshot);
  }

  /** The identity currently bound per source (owner+filters+query). */
  private bound: Record<LibrarySource, string> = { local: "", desktop: "" };

  /**
   * What the page should paint for `source` right now.
   *
   * `retained` is true only when the stored rows belong to the CURRENT identity
   * — a Desktop A→B switch therefore never shows A's rows under B (fail-closed),
   * while a pure source toggle keeps everything.
   */
  view<T>(source: LibrarySource, identity = this.bound[source]): SourceView<T> {
    const snap = this.snapshot<T>(source, identity);
    const current = snap.identity === identity;
    return {
      items: current ? snap.items : [],
      retained: current && snap.items.length > 0,
      refreshing: current && snap.refreshing,
      stale: current && snap.stale,
      settled: current && snap.settled,
      scrollTop: current ? snap.scrollTop : 0,
    };
  }

  /**
   * Bind a source to an identity. Changing the identity RETIRES that source's
   * rows (they described a different query/owner); re-binding the SAME identity
   * (a plain source toggle) keeps them untouched.
   */
  bind(source: LibrarySource, identity: string): { changed: boolean; hasRetained: boolean } {
    const changed = this.bound[source] !== identity;
    this.bound[source] = identity;
    if (!this.snapshots[source].has(identity)) this.store(source, emptySnapshot(identity));
    return { changed, hasRetained: this.snapshot(source).items.length > 0 };
  }

  /** A refresh for this source/identity started (rows stay visible). */
  beginRefresh(source: LibrarySource, identity: string): void {
    if (this.bound[source] !== identity) return;
    this.store(source, { ...this.snapshot(source), refreshing: true });
  }

  /** Fresh rows arrived for the same identity: swap in atomically. */
  commit<T>(source: LibrarySource, identity: string, items: T[]): boolean {
    if (this.bound[source] !== identity) return false; // stale response
    this.store(source, {
      ...this.snapshot(source),
      identity,
      items,
      refreshing: false,
      stale: false,
      settled: true,
    });
    return true;
  }

  /**
   * A refresh failed. Retained rows are KEPT and marked stale (a quiet offline
   * indication) instead of blanking the grid; with no retained rows the source
   * settles as empty so the page can show a truthful settled state.
   */
  fail(source: LibrarySource, identity: string): boolean {
    if (this.bound[source] !== identity) return false;
    const had = this.snapshot(source).items.length > 0;
    this.store(source, {
      ...this.snapshot(source),
      refreshing: false,
      stale: had,
      settled: true,
    });
    return had;
  }

  /** Remember a source's scroll offset (survives source toggles). */
  setScroll(source: LibrarySource, scrollTop: number, identity = this.bound[source]): void {
    this.store(source, { ...this.snapshot(source, identity), scrollTop });
  }

  /** Explicit permission withdrawal is not a transient refresh failure. */
  discard(source: LibrarySource, identity?: string): void {
    if (identity === undefined) this.snapshots[source].clear();
    else this.snapshots[source].delete(identity);
  }

  /**
   * A local mutation refreshed the SAME local identity: keep rows visible and
   * mark a background refresh.
   */
  revalidateLocal(identity: string): void {
    this.beginRefresh("local", identity);
  }
}
