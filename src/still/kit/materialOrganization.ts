// MaterialOrganizationController — the single owner of Wave-A Desktop material
// organization requests on Mobile.
//
// Desktop remains the ONLY authority for favorites/tags/folders; this
// controller never keeps a local copy of that truth. It owns exactly:
//   * the one in-flight organization request (single-flight),
//   * the Desktop identity it was issued for (source fencing),
//   * the truthful busy/error/partial-failure state the UI renders,
//   * capability gating (an older Desktop fails before any write).
//
// Offline behaviour is deliberate: Desktop organization mutations require a
// currently connected Desktop. There is NO local mutation queue and no fake
// pending work — the action fails truthfully instead.
/** Transport seam: the production host passes the real `api`; tests pass a
 *  stub. Keeping the controller free of a hard client import is what makes it
 *  directly unit-testable (same pattern as the other kit modules). */
export type OrganizationTransport = {
  setFavorite(instance: string, assetId: string, favorited: boolean): Promise<any>;
  setTags(instance: string, assetId: string, patch: { set?: string[]; add?: string[]; remove?: string[] }): Promise<any>;
  setFolder(instance: string, assetId: string, folderId: string | null): Promise<any>;
  createTag(instance: string, name: string): Promise<any>;
  createFolder(instance: string, name: string): Promise<any>;
  batch(instance: string, input: { assetIds: string[]; favorited?: boolean; add?: string[]; remove?: string[]; folderChange: boolean; folderId?: string | null }): Promise<any>;
};

export type OrgSnapshot = {
  busy: boolean;
  error: string;
  /** Set when a batch came back partially applied (never reported as success). */
  partial: { succeeded: number; failed: number } | null;
  /** The Desktop instance this page is currently bound to ("" = unbound). */
  identity: string;
};

// --- Desktop material route codec -------------------------------------------
//
// A Desktop material route must be able to answer "which Desktop owns this?"
// on its own — exactly like the note route `desktop:<instance>:<vault>:<id>`.
// The owner is carried in the route and fixed when the page mounts, so a page
// can never be silently retargeted at a different Desktop by a later
// connection value.

const DESKTOP_PREFIX = "desktop:";
const LOCAL_PREFIX = "local:";

export type AssetRoute =
  | { kind: "local"; assetId: string; owner: "" }
  | { kind: "desktop"; assetId: string; owner: string; library?: string }
  /** A bare Desktop asset id with no owner encoded. The owner is unprovable,
   *  so this fails closed instead of guessing from the live connection. */
  | { kind: "unowned"; assetId: string; owner: "" };

/** Build the route for a Desktop asset owned by `instanceId`. */
export function desktopAssetRoute(instanceId: string, assetId: string, library?: string): string {
  return library ? `desktop-library:${encodeURIComponent(instanceId)}:${encodeURIComponent(library)}:${encodeURIComponent(assetId)}` : `${DESKTOP_PREFIX}${encodeURIComponent(instanceId)}:${encodeURIComponent(assetId)}`;
}

/** Build the route for a local (本机) asset. */
export function localAssetRoute(assetId: string): string {
  return `${LOCAL_PREFIX}${assetId}`;
}

/**
 * Parse an asset route. Malformed input is never repaired into a guess: an
 * unreadable or owner-less Desktop route becomes `unowned`, which the caller
 * must refuse.
 */
export function parseAssetRoute(route: string): AssetRoute {
  const raw = route || "";
  if (raw.startsWith("desktop-library:")) {
    try {
      const parts = raw.slice("desktop-library:".length).split(":").map(decodeURIComponent);
      if (parts.length === 3 && parts.every(Boolean)) return {kind:"desktop",owner:parts[0],library:parts[1],assetId:parts[2]};
    } catch {}
    return {kind:"unowned",owner:"",assetId:""};
  }
  if (raw.startsWith(LOCAL_PREFIX)) {
    return { kind: "local", assetId: raw.slice(LOCAL_PREFIX.length), owner: "" };
  }
  if (!raw.startsWith(DESKTOP_PREFIX)) {
    // Legacy bare Desktop asset id: the owner cannot be proven.
    return { kind: "unowned", assetId: raw, owner: "" };
  }
  const rest = raw.slice(DESKTOP_PREFIX.length);
  const split = rest.indexOf(":");
  if (split < 0) return { kind: "unowned", assetId: rest, owner: "" };
  let owner = "";
  let assetId = "";
  try {
    owner = decodeURIComponent(rest.slice(0, split));
    assetId = decodeURIComponent(rest.slice(split + 1));
  } catch {
    // A malformed percent-encoding must not degrade into a partial owner.
    return { kind: "unowned", assetId: "", owner: "" };
  }
  if (!owner || !assetId) return { kind: "unowned", assetId, owner: "" };
  return { kind: "desktop", assetId, owner };
}

export class MaterialOrganizationController {
  private transport: OrganizationTransport;
  private identity = "";
  private busy = false;
  private error = "";
  private partial: { succeeded: number; failed: number } | null = null;
  private listeners = new Set<(s: OrgSnapshot) => void>();
  private snapshotCache: OrgSnapshot | null = null;

  constructor(transport: OrganizationTransport) {
    this.transport = transport;
  }

  subscribe(fn: (s: OrgSnapshot) => void): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  /** Stable reference between transitions (useSyncExternalStore contract). */
  snapshot(): OrgSnapshot {
    if (!this.snapshotCache) {
      this.snapshotCache = { busy: this.busy, error: this.error, partial: this.partial, identity: this.identity };
    }
    return this.snapshotCache;
  }

  /** Bind the page to the Desktop identity it belongs to. Changing it fences
   *  any in-flight request: a result for Desktop A never lands on B. */
  setIdentity(instanceId: string) {
    if (instanceId === this.identity) return;
    this.identity = instanceId;
    this.busy = false;
    this.error = "";
    this.partial = null;
    this.emit();
  }

  dispose() {
    this.listeners.clear();
  }

  private emit() {
    this.snapshotCache = { busy: this.busy, error: this.error, partial: this.partial, identity: this.identity };
    const snapshot = this.snapshotCache;
    for (const fn of this.listeners) fn(snapshot);
  }

  /** Runs one mutation under single-flight + identity fencing. `revalidate`
   *  only runs when the identity is still current, so stale data cannot be
   *  merged into a different Desktop's page. */
  private async run<T>(
    action: (instanceId: string) => Promise<T>,
    onSuccess?: () => Promise<void> | void,
  ): Promise<T | null> {
    const identity = this.identity;
    if (!identity) {
      this.error = "连接电脑后才能整理电脑上的素材。";
      this.emit();
      return null;
    }
    if (this.busy) return null; // single-flight: one organization request at a time
    this.busy = true;
    this.error = "";
    this.partial = null;
    this.emit();
    try {
      const result = await action(identity);
      if (identity !== this.identity) return null; // fenced: identity moved on
      if (onSuccess) await onSuccess();
      if (identity !== this.identity) return null;
      return result;
    } catch (e: any) {
      if (identity !== this.identity) return null;
      this.error = orgErrorCopy(e);
      return null;
    } finally {
      if (identity === this.identity) {
        this.busy = false;
        this.emit();
      }
    }
  }

  async setFavorite(assetId: string, favorited: boolean, revalidate: () => Promise<void> | void) {
    return this.run((instance) => this.transport.setFavorite(instance, assetId, favorited), revalidate);
  }

  async setTags(
    assetId: string,
    patch: { set?: string[]; add?: string[]; remove?: string[] },
    revalidate: () => Promise<void> | void,
  ) {
    return this.run((instance) => this.transport.setTags(instance, assetId, patch), revalidate);
  }

  async setFolder(assetId: string, folderId: string | null, revalidate: () => Promise<void> | void) {
    return this.run((instance) => this.transport.setFolder(instance, assetId, folderId), revalidate);
  }

  /** Create a simple tag and hand the authoritative row back (no local mirror). */
  async createTag(name: string): Promise<{ id: string; name: string } | null> {
    const value = await this.run((instance) => this.transport.createTag(instance, name));
    return value ? (value as any).tag ?? null : null;
  }

  /** Create a simple folder and hand the authoritative row back. */
  async createFolder(name: string): Promise<{ id: string; name: string } | null> {
    const value = await this.run((instance) => this.transport.createFolder(instance, name));
    return value ? (value as any).folder ?? null : null;
  }

  /** Bounded batch organization. A partial result is reported as partial —
   *  it is never presented as full success. */
  async batch(
    input: {
      assetIds: string[];
      favorited?: boolean;
      add?: string[];
      remove?: string[];
      /** Explicit presence signal — an unrelated batch must not carry a folderId. */
      folderChange: boolean;
      folderId?: string | null;
    },
    revalidate: () => Promise<void> | void,
  ) {
    const result: any = await this.run((instance) => this.transport.batch(instance, input));
    if (!result) return result;
    // A partial batch still changed the authority, so the page is revalidated
    // in BOTH cases; the partial warning is what distinguishes them.
    const failed = Array.isArray(result.failed) ? result.failed.length : 0;
    if (failed > 0) {
      this.partial = { succeeded: (result.succeeded || []).length, failed };
      this.error = "";
      this.emit();
    }
    await revalidate();
    return result;
  }
}

/** Truthful bounded copy: never claim success, never invent a queue. */
export function orgErrorCopy(error: unknown): string {
  const raw = String((error as any)?.message ?? error ?? "");
  if (raw.includes("CONTENT_OFFLINE") || raw.includes("CONTENT_DISCONNECTED")) {
    return "电脑未连接：整理操作需要在电脑在线时进行。";
  }
  if (raw.includes("CONTENT_UPGRADE_REQUIRED")) {
    return "当前桌面版本尚未开放手机整理素材。";
  }
  if (raw.includes("CONTENT_ASSET_NOT_FOUND")) return "这条素材在电脑上已不存在。";
  if (raw.includes("CONTENT_INPUT_INVALID")) return "输入无效，请检查后重试。";
  if (raw.includes("CONTENT_SOURCE_CHANGED")) return "电脑连接已变化，请重新打开后再试。";
  if (raw.includes("CONTENT_BATCH_TOO_LARGE")) return "一次最多整理 100 项素材。";
  return "操作失败，请重试。";
}
