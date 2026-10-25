/** A view-only ordered snapshot from the originating list, never a cache authority. */
export type AssetSequenceItem = { route: string; title: string; thumbnail: string; kind: string; version?: string };
export function assetSequenceNeighbor(items: readonly AssetSequenceItem[] | undefined, route: string, direction: -1 | 1): AssetSequenceItem | undefined {
  if (!items) return;
  const index = items.findIndex(item => item.route === route);
  if (index < 0) return;
  const next = items[index + direction];
  if (!next) return;
  // Never allow a supplied snapshot to cross from Local to a different Desktop.
  const owner = (value: string) => /^local:.+/.test(value) ? 'local' : /^desktop:[^:]+:[^:]+$/.test(value) ? value.slice(0, value.lastIndexOf(':')) : undefined;
  const source = owner(route);
  return source !== undefined && owner(next.route) === source ? next : undefined;
}
export function assetSwipeDirection(dx: number, dy: number, elapsed: number): -1 | 0 | 1 {
  if (elapsed > 900 || Math.abs(dx) < 64 || Math.abs(dx) < Math.abs(dy) * 1.6) return 0;
  return dx < 0 ? 1 : -1;
}

export type AssetSequencePage = { items: readonly AssetSequenceItem[]; hasMore: boolean; nextPage?: number | null };
export type AssetSequenceSnapshot = { items: readonly AssetSequenceItem[]; hasMore: boolean; loading: boolean; error: string };
/** A viewer continuation of one immutable list query. It never writes library caches,
 * changes filters, or silently follows a newly paired desktop. */
export class AssetSequenceSession {
  private state: AssetSequenceSnapshot;
  private nextPage: number;
  private flight: Promise<void> | null = null;
  private epoch = 0;
  private retired = false;
  private listeners = new Set<() => void>();
  private readonly fetchPage: (page: number) => Promise<AssetSequencePage>;
  private readonly isCurrent: () => boolean;
  constructor(
    items: readonly AssetSequenceItem[], page: number, hasMore: boolean,
    fetchPage: (page: number) => Promise<AssetSequencePage>,
    isCurrent: () => boolean,
    nextPage?: number | null,
  ) {
    this.state = { items: [...items], hasMore: hasMore && items.length > 0, loading: false, error: '' };
    this.fetchPage = fetchPage; this.isCurrent = isCurrent;
    this.nextPage = nextPage ?? page + 1;
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private commit(patch: Partial<AssetSequenceSnapshot>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()); }
  /** Retires pending work when its source list is destroyed. */
  retire() { this.retired = true; this.epoch++; this.commit({ loading: false, hasMore: false, error: '来源已变化，请返回素材库重新打开。' }); }
  remove(route: string) { this.commit({ items: this.state.items.filter(item => item.route !== route) }); }
  loadNext(): Promise<void> {
    if (this.retired) return Promise.resolve();
    if (this.flight) return this.flight;
    if (!this.isCurrent()) { this.retire(); return Promise.resolve(); }
    if (!this.state.hasMore) return Promise.resolve();
    const epoch = this.epoch, page = this.nextPage;
    this.commit({ loading: true, error: '' });
    this.flight = (async () => {
      try {
        const result = await this.fetchPage(page);
        if (epoch !== this.epoch) return;
        if (this.retired) return;
        if (!this.isCurrent()) { this.retire(); return; }
        const first = this.state.items[0];
        const seen = new Set(this.state.items.map(item => item.route));
        const additions = result.items.filter(item => {
          if (seen.has(item.route) || !first || !assetSequenceNeighbor([first, item], first.route, 1)) return false;
          seen.add(item.route); return true;
        });
        if (result.items.some(item => first && !assetSequenceNeighbor([first, item], first.route, 1))) throw new Error('ASSET_SEQUENCE_SOURCE_MISMATCH');
        const following = result.nextPage ?? page + 1;
        if (result.hasMore && (!additions.length || !Number.isInteger(following) || following <= page)) throw new Error('ASSET_SEQUENCE_NO_PROGRESS');
        this.nextPage = following;
        this.commit({ items: [...this.state.items, ...additions], hasMore: result.hasMore, loading: false, error: '' });
      } catch {
        if (epoch === this.epoch && !this.retired) {
          if (!this.isCurrent()) this.retire();
          else this.commit({ loading: false, error: '暂时无法读取下一项，点此重试。' });
        }
      } finally { this.flight = null; }
    })();
    return this.flight;
  }
  async neighbor(route: string, direction: -1 | 1): Promise<AssetSequenceItem | undefined> {
    if (this.retired) return;
    if (!this.isCurrent()) { this.retire(); return; }
    let found = assetSequenceNeighbor(this.state.items, route, direction);
    if (!found && direction === 1 && this.state.items[this.state.items.length - 1]?.route === route) {
      await this.loadNext(); found = assetSequenceNeighbor(this.state.items, route, direction);
    }
    return found;
  }
}
