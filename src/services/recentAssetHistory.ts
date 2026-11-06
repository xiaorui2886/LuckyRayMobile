import { parseAssetRoute } from "../still/kit/materialOrganization";
import type { LibrarySelection } from "./desktopLibraries";

export type RecentAsset = { route: string; title: string; kind: "image" | "video" | "document" | "audio" | "other"; visitedAt: number };
export const RECENT_ASSET_LIMIT = 50;
const KEY = "luckyray:recent-assets:v1";
type StoragePort = Pick<Storage, "getItem" | "setItem">;
const kindOf = (kind: unknown): RecentAsset["kind"] =>
  kind === "image" || kind === "video" || kind === "document" || kind === "audio" ? kind : "other";
function clean(value: any): RecentAsset | null {
  if (!value || typeof value.route !== "string" || value.route.length > 4096 || typeof value.title !== "string" || !Number.isFinite(value.visitedAt)) return null;
  const route = parseAssetRoute(value.route);
  if (route.kind === "unowned" || !route.assetId) return null;
  // A legacy desktop route has no stable library identity. Do not persist an
  // ambiguous reference that could resolve to another library after a switch.
  if (route.kind === "desktop" && !route.library) return null;
  return { route: value.route, title: value.title.slice(0, 256), kind: kindOf(value.kind), visitedAt: value.visitedAt };
}

/** Navigation metadata only. Not an asset cache, grant store or view prefetcher. */
export class RecentAssetHistory {
  private items: readonly RecentAsset[] = [];
  private listeners = new Set<() => void>();
  constructor(private storage: () => StoragePort | undefined = () => globalThis.localStorage) {
    try {
      const raw = JSON.parse(this.storage()?.getItem(KEY) || "[]");
      if (Array.isArray(raw)) {
        const seen = new Set<string>();
        this.items = raw.map(clean).filter((row): row is RecentAsset => !!row)
          .sort((a,b) => b.visitedAt - a.visitedAt)
          .filter(row => !seen.has(row.route) && !!seen.add(row.route)).slice(0, RECENT_ASSET_LIMIT);
      }
    } catch { /* corrupt/disabled storage must not block viewing */ }
  }
  snapshot = () => this.items;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  record(route: string, title: string, kind: string, now = Date.now()): void {
    const item = clean({ route, title, kind, visitedAt: Math.max(now, (this.items[0]?.visitedAt || 0) + 1) });
    if (!item) return;
    this.commit([item, ...this.items.filter(row => row.route !== route)].slice(0, RECENT_ASSET_LIMIT));
  }
  forget(route: string): void {
    if (this.items.some(row => row.route === route)) this.commit(this.items.filter(row => row.route !== route));
  }
  private commit(items: readonly RecentAsset[]): void {
    this.items = items;
    try { this.storage()?.setItem(KEY, JSON.stringify(items)); } catch { /* session history still works */ }
    for (const listener of this.listeners) listener();
  }
}
export const recentAssetHistory = new RecentAssetHistory();

/** History never grants access. Only the currently paired computer's explicit,
 * still-readable libraries can contribute cards; routes remain library-owned. */
export function recentAssetVisible(item: RecentAsset, instance: string, paired: boolean, libraries: LibrarySelection): boolean {
  const route = parseAssetRoute(item.route);
  if (route.kind === "local") return true;
  if (route.kind !== "desktop" || !paired || route.owner !== instance || !route.library || libraries.instance !== instance || libraries.phase === "error") return false;
  const row = libraries.catalog?.materials.find(row => row.libraryId === route.library);
  return libraries.catalog?.scopeSelectionVersion === 1 && row?.available === true && row.readGranted === true;
}
