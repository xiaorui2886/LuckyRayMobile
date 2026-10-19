// Read-only folder inventory. Empty folders come from Services, never from a
// note page. A cache is certified only after every page in this exact scope.
import type { KnowledgeClient } from "../../services/companionServices/knowledgeClient.ts";
import type { KnowledgeNavigationReader } from "../../services/knowledgeNavigationReader.ts";

export type FolderScope = { instance: string; vault: string };
export type FolderSnapshot = FolderScope & {
  paths: string[];
  phase: "idle" | "loading" | "ready" | "offline" | "unsupported" | "denied" | "error";
  complete: boolean;
  origin: "none" | "services" | "notes";
  savedAt: number;
};
export type FolderStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const CACHE_PREFIX = "luckyray.knowledge-folders.v1:";
export const folderScopeKey = ({ instance, vault }: FolderScope) => JSON.stringify([instance, vault]);
export function safeFolderPath(value: unknown): value is string {
  return typeof value === "string" && new TextEncoder().encode(value).length <= 1024
    && !/^[\\/]|[\\:\u0000-\u001f\u007f]/.test(value)
    && (value === "" || value.split("/").every(p => Boolean(p) && p !== "." && p !== ".."));
}
export function folderChildren(paths: readonly string[], parent: string): string[] {
  if (!safeFolderPath(parent)) return [];
  const prefix = parent ? parent + "/" : "";
  return [...new Set(paths.filter(p => safeFolderPath(p) && p.startsWith(prefix) && p !== parent)
    .map(p => prefix + p.slice(prefix.length).split("/")[0]))].sort((a, b) => a.localeCompare(b));
}
export function folderAncestors(path: string): string[] {
  if (!safeFolderPath(path) || !path) return [""];
  const parts = path.split("/");
  return ["", ...parts.map((_, i) => parts.slice(0, i + 1).join("/"))];
}
function empty(scope: FolderScope): FolderSnapshot {
  return { ...scope, paths: [], phase: "idle", complete: false, origin: "none", savedAt: 0 };
}
const deniedCodes = new Set(["GRANT_REQUIRED", "SCOPE_DENIED", "AUTH_REVOKED", "PAIRING_REQUIRED"]);
export class KnowledgeFolderCatalog {
  private snapshots = new Map<string, FolderSnapshot>();
  private listeners = new Set<() => void>();
  private epoch = 0;
  private refreshToken = 0;
  private active = "";
  private online = false;
  private task: Promise<void> | null = null;
  private client: Pick<KnowledgeClient, "directories"> & Partial<Pick<KnowledgeNavigationReader, "subscribe" | "authorityKey" | "denied" | "refresh">>;
  private authority = "unknown";
  private legacy: (instance: string, vault: string) => Promise<string[]>;
  private storage?: FolderStorage;
  constructor(client: KnowledgeFolderCatalog["client"],
    legacy: (instance: string, vault: string) => Promise<string[]>,
    storage?: FolderStorage) {
    this.client = client; this.legacy = legacy; this.storage = storage;
    client.subscribe?.(() => {
      // Denial also invalidates inactive scopes so switching back cannot
      // resurrect an earlier cached inventory for the same desktop.
      for (const snapshot of this.snapshots.values()) {
        if (client.denied?.(snapshot.instance, "directories")) this.deny(snapshot);
      }
      const snapshot = this.snapshots.get(this.active);
      if (!snapshot || !this.online) return;
      const next = client.authorityKey?.(snapshot.instance, "directories") || "unknown";
      if (next === this.authority) return;
      const previous = this.authority; this.authority = next;
      if (client.denied?.(snapshot.instance, "directories")) return;
      // The first discovery belongs to the already-running request. A later
      // authority change retires all pages before starting a new read.
      if (previous === "unknown" && snapshot.phase === "loading") return;
      ++this.epoch; this.task = null;
      if (snapshot.phase !== "denied") {
        this.snapshots.set(this.active, { ...snapshot, paths: [], complete: false, phase: "loading", origin: "none" }); this.emit();
      }
      void this.activate(snapshot, true, true);
    });
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit() { for (const listener of this.listeners) listener(); }
  snapshot(scope: FolderScope): FolderSnapshot {
    const key = folderScopeKey(scope);
    let value = this.snapshots.get(key);
    if (this.client.denied?.(scope.instance, "directories") && value?.phase !== "denied") {
      this.deny(scope, false); value = this.snapshots.get(key);
    }
    if (!value) {
      value = empty(scope);
      if (scope.instance && scope.vault) {
        try {
          const cached = JSON.parse(this.storage?.getItem(CACHE_PREFIX + key) || "null");
          if (cached?.version === 1 && cached.instance === scope.instance && cached.vault === scope.vault && cached.denied === true) {
            value = { ...value, phase: "denied" };
          } else if (cached?.version === 1 && cached.instance === scope.instance && cached.vault === scope.vault
            && cached.complete === true && cached.origin === "services"
            && Array.isArray(cached.paths) && cached.paths.length <= 100000 && cached.paths.every(safeFolderPath)
            && Number.isFinite(cached.savedAt) && cached.savedAt > 0) {
            value = { ...scope, paths: [...new Set<string>(cached.paths)], complete: true,
              phase: "offline", origin: "services", savedAt: cached.savedAt };
          }
        } catch { /* unavailable/corrupt WebView storage is never an empty-success */ }
      }
      this.snapshots.set(key, value);
    }
    return value;
  }
  /** Changing source/owner/vault/connectivity retires every old in-flight page. */
  activate(scope: FolderScope, online: boolean, force = false): Promise<void> {
    const key = folderScopeKey(scope);
    const changed = key !== this.active || online !== this.online;
    if (changed) ++this.refreshToken;
    if (!changed && this.task && !force) return this.task;
    if (!changed && !force && this.snapshot(scope).phase !== "idle") return Promise.resolve();
    this.active = key; this.online = online;
    this.authority = this.client.authorityKey?.(scope.instance, "directories") || "unknown";
    const token = ++this.epoch;
    const live = () => token === this.epoch && key === this.active;
    const old = this.snapshot(scope);
    if (this.client.denied?.(scope.instance, "directories") || (!online && old.phase === "denied")) {
      this.deny(scope); return Promise.resolve();
    }
    this.snapshots.set(key, { ...old, phase: online ? "loading" : "offline" }); this.emit();
    const work = async () => {
      if (!scope.instance || !scope.vault) return;
      if (!online) {
        if (!old.complete) await this.fallback(scope, live, "offline");
        return;
      }
      try {
        const paths = new Set<string>(); const cursors = new Set<string>();
        let afterPath: string | undefined, received = 0;
        for (;;) {
          const page = await this.client.directories(scope.instance, scope.vault, { limit: 100, afterPath });
          if (!live()) return;
          for (const item of page.items) {
            if (!safeFolderPath(item.parentRelativePath)) throw new Error("MALFORMED_RESPONSE");
            paths.add(item.parentRelativePath);
          }
          received += page.items.length;
          if (received > 100000 || cursors.size > 10000) throw new Error("CATALOG_TOO_LARGE");
          if (!page.hasMore) break;
          const next = page.nextAfterPath;
          // Desktop orders by UTF-8 bytes, not JS UTF-16 string order.
          if (typeof next !== "string" || !safeFolderPath(next) || cursors.has(next)) throw new Error("MALFORMED_RESPONSE");
          cursors.add(next); afterPath = next;
        }
        if (!live()) return;
        const next: FolderSnapshot = { ...scope, paths: [...paths], phase: "ready", complete: true,
          origin: "services", savedAt: Date.now() };
        this.snapshots.set(key, next);
        try { this.storage?.setItem(CACHE_PREFIX + key, JSON.stringify({ version: 1, ...next })); } catch { /* session still works */ }
        this.emit();
      } catch (error) {
        if (!live()) return;
        const code = String((error as { code?: string })?.code || error);
        if (deniedCodes.has(code) || old.phase === "denied") { this.deny(scope); return; }
        const phase = ["VERSION_UNSUPPORTED", "METHOD_NOT_ALLOWED"].includes(code) ? "unsupported" : "error";
        if (old.complete) { this.snapshots.set(key, { ...old, phase }); this.emit(); }
        else await this.fallback(scope, live, phase);
      }
    };
    const task = work().finally(() => { if (live()) this.task = null; });
    this.task = task; return task;
  }
  suspend() { ++this.epoch; ++this.refreshToken; this.active = ""; this.task = null; }
  /** Explicit user retry refreshes capability truth, including a restored grant. */
  async refresh(scope: FolderScope, online: boolean) {
    const key = folderScopeKey(scope);
    const before = this.epoch;
    const refreshToken = ++this.refreshToken;
    if (!online || !scope.instance || !scope.vault) return this.activate(scope, online, true);
    try { await this.client.refresh?.(scope.instance); }
    catch (error) {
      if (refreshToken !== this.refreshToken || key !== this.active || !this.online) return;
      const code = String((error as { code?: string })?.code || error);
      if (deniedCodes.has(code) || this.snapshot(scope).phase === "denied") this.deny(scope);
      else { this.snapshots.set(key, { ...this.snapshot(scope), phase: "error" }); this.emit(); }
      return;
    }
    if (refreshToken === this.refreshToken && key === this.active && this.online) {
      // A new catalog namespace may already have triggered the subscribed
      // reload. Join it instead of retiring it and issuing duplicate pages.
      if (this.epoch !== before) return this.task || undefined;
      return this.activate(scope, online, true);
    }
  }
  private deny(scope: FolderScope, notify = true) {
    const key = folderScopeKey(scope);
    if (key === this.active) { ++this.epoch; ++this.refreshToken; this.task = null; }
    this.snapshots.set(key, { ...empty(scope), phase: "denied" });
    try { this.storage?.setItem(CACHE_PREFIX + key, JSON.stringify({ version: 1, instance: scope.instance, vault: scope.vault, denied: true })); } catch { /* session denial remains authoritative */ }
    if (notify) this.emit();
  }
  private async fallback(scope: FolderScope, live: () => boolean, phase: FolderSnapshot["phase"]) {
    let paths: string[] = [];
    try { paths = (await this.legacy(scope.instance, scope.vault)).filter(safeFolderPath); } catch { /* retain truthful unavailable state */ }
    if (!live()) return;
    this.snapshots.set(folderScopeKey(scope), { ...scope, paths, phase, complete: false,
      origin: paths.length ? "notes" : "none", savedAt: 0 }); this.emit();
  }
}
export function folderStatus(snapshot: FolderSnapshot, online: boolean): string {
  if (snapshot.phase === "denied") return "未获电脑目录读取授权，请在电脑端开启后刷新。";
  if (snapshot.phase === "loading" && online) return snapshot.complete ? "显示上次目录，正在更新…" : "正在读取电脑目录…";
  if (!online) return snapshot.complete ? "电脑暂未连接 · 显示上次完整目录" : "电脑暂未连接 · 仅显示已缓存笔记的目录，可能缺少空目录";
  if (snapshot.phase === "ready") return "";
  const suffix = snapshot.complete ? "显示上次完整目录" : "仅显示已缓存笔记的目录，可能缺少空目录";
  if (snapshot.phase === "unsupported") return `当前电脑版本不支持完整目录 · ${suffix}`;
  if (snapshot.phase === "error") return `目录暂时无法更新 · ${suffix}`;
  return "连接电脑后可读取完整目录";
}
