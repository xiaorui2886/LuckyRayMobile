// LshSurfaceController — the Mobile-side adapter for the Desktop LSH remote
// surface (Issue #72, M1 parallel phase).
//
// Mobile never runs a second LightSeek and never holds DSH authority: the
// Desktop is the only Agent/session/runtime authority, and everything here is
// a narrow seam over two calls:
//   1. bootstrap — ask the PAIRED desktop (named by instance id) for a session
//      URL of its authenticated LSH web surface;
//   2. open — hand that URL to the dedicated Android WebView shell.
//
// FREEZE (parallel phase): the final bootstrap path, cookie names/values, the
// upstream DSH launch token, the proxy WS path list and the exact capability
// payload shape belong to the Desktop #166 contract. This adapter invents none
// of them — `sessionUrl` is opaque, and the Rust bootstrap fails closed with
// LSH_GATEWAY_NOT_PROVIDED until the Desktop handoff binds the real call.
/**
 * The ONLY capability spelling this adapter accepts. A Desktop that does not
 * advertise the flag (older build, or the field absent) is UNAVAILABLE —
 * absence is never read as `true`.
 */
export function lshRemoteSurfaceAvailable(hello: unknown): boolean {
  const caps = (hello as any)?.capabilities;
  return caps?.lshRemoteSurface === true;
}

/**
 * LuckyRay-owned presentation seam. The CARRIER applies it on the post-auth
 * 302 landing (`/?luckyrayMobile=1`), i.e. only AFTER the one-time launch
 * capability has been exchanged — it is never attached to a capability URL
 * (P1-F6). This is LuckyRay UI vocabulary, not DSH protocol: it names
 * neither a DSH route, a cookie, nor a token.
 */
export const LSH_PRESENTATION_MARKER = "luckyrayMobile=1";

/** The landing the carrier redirects to after the launch exchange. */
export const LSH_POST_AUTH_LANDING = `/?${LSH_PRESENTATION_MARKER}`;

/** The dedicated Android shell launch request. */
export type LshLaunchRequest = {
  /** Exact session URL from bootstrap (same origin only). */
  sessionUrl: string;
  /** The Desktop instance this surface belongs to (source fencing). */
  ownerInstanceId: string;
  /** Human title for the shell window. */
  title: string;
};

/** Transport seam: production passes `api`, tests pass a stub. */
export type LshSurfaceTransport = {
  /** Desktop per-device permission + runtime truth for the named owner. */
  state(expectedInstance: string): Promise<{ granted: boolean; runtimeAvailable: boolean }>;
  /** Ask the named Desktop for an authenticated LSH session URL. */
  bootstrap(expectedInstance: string): Promise<{ sessionUrl: string }>;
  /** Hand the session URL to the dedicated Android WebView shell. */
  open(request: LshLaunchRequest): Promise<{ opened: boolean }>;
};

export type LshSnapshot = {
  busy: boolean;
  /** Capability truth from the current hello (mirrors `canUseLsh`). */
  available: boolean;
  /** The Desktop this controller is currently bound to ("" = unbound). */
  identity: string;
  /** Phase-4 truth: the Desktop per-device LSH grant is ON. */
  granted: boolean;
  /** Granted AND the Desktop runtime is currently available. */
  runtimeAvailable: boolean;
};

export class LshSurfaceController {
  private transport: LshSurfaceTransport;
  private listeners = new Set<(s: LshSnapshot) => void>();

  private available = false;
  private busy = false;
  private granted = false;
  private runtimeAvailable = false;
  /** The Desktop the surface flow is bound to (source fencing). */
  private identity = "";
  private snapshotCache: LshSnapshot | null = null;

  constructor(transport: LshSurfaceTransport) {
    this.transport = transport;
  }

  subscribe(fn: (s: LshSnapshot) => void): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  /** Stable reference between transitions (useSyncExternalStore contract). */
  snapshot(): LshSnapshot {
    if (!this.snapshotCache) {
      this.snapshotCache = {
        busy: this.busy,
        available: this.available,
        identity: this.identity,
        granted: this.granted,
        runtimeAvailable: this.runtimeAvailable,
      };
    }
    return this.snapshotCache;
  }

  /** Bind to the current Desktop + capability truth from the AI page. */
  setContext(input: { instanceId: string; available: boolean }) {
    if (input.instanceId === this.identity && input.available === this.available) return;
    this.identity = input.instanceId;
    this.available = input.available;
    // A new identity resets the previous permission truth until probed.
    this.granted = false;
    this.runtimeAvailable = false;
    this.emit();
  }

  /** Phase-4: record the Desktop-authoritative permission/runtime truth
   *  for the bound owner (Desktop per-device permission state). */
  setPermissionTruth(granted: boolean, runtimeAvailable: boolean) {
    if (this.granted === granted && this.runtimeAvailable === runtimeAvailable) return;
    this.granted = granted;
    this.runtimeAvailable = runtimeAvailable;
    this.emit();
  }

  /**
   * Bootstrap + open the surface for ONE named Desktop. Single-flight and
   * owner-fenced: the instance is captured at entry, re-proven after the
   * awaited bootstrap, and the shell only ever receives that owner.
   */
  async openSurface(instanceId: string, title = "LightSeek"): Promise<boolean> {
    if (this.busy) return false; // single-flight: one surface flow at a time
    if (!this.available) throw new Error("LSH_UNAVAILABLE");
    if (!instanceId || instanceId !== this.identity) throw new Error("CONTENT_SOURCE_CHANGED");
    this.busy = true;
    this.emit();
    try {
      const { sessionUrl } = await this.transport.bootstrap(instanceId);
      // The identity must still hold across the awaited bootstrap.
      if (instanceId !== this.identity) throw new Error("CONTENT_SOURCE_CHANGED");
      if (!sessionUrl) throw new Error("LSH_SURFACE_DECLINED");
      const launched = await this.transport.open({
        // OPAQUE (P1-F6): byte-identical to what bootstrap returned. The
        // capability URL must not be rewritten — the carrier owns the
        // presentation marker on its post-auth 302 landing.
        sessionUrl,
        ownerInstanceId: instanceId,
        title,
      });
      if (launched?.opened === false) throw new Error("LSH_SURFACE_DECLINED");
      return true;
    } finally {
      this.busy = false;
      this.emit();
    }
  }

  private emit() {
    this.snapshotCache = {
      busy: this.busy,
      available: this.available,
      identity: this.identity,
      granted: this.granted,
      runtimeAvailable: this.runtimeAvailable,
    };
    const snapshot = this.snapshotCache;
    for (const fn of this.listeners) fn(snapshot);
  }
}

/** Truthful bounded copy: never claim success, never invent a queue. */
export function lshErrorCopy(error: unknown): string {
  const raw = String((error as any)?.message ?? error ?? "");
  if (raw.includes("LSH_UNAVAILABLE")) {
    return "当前桌面版本尚未开放 LightSeek 远程面。";
  }
  if (raw.includes("LSH_NOT_GRANTED")) {
    return "这台电脑还没有授权本手机使用 LightSeek 远程面。请在电脑的「LSH 远程」设置里为这台手机开启权限。";
  }
  if (raw.includes("LSH_RUNTIME_UNAVAILABLE")) {
    return "电脑端 LightSeek 正在启动或暂时不可用，请稍后再试。";
  }
  if (raw.includes("LSH_GATEWAY_CONTRACT_INVALID")) {
    return "电脑端 LightSeek 网关返回了无法识别的响应，请更新桌面端。";
  }
  if (raw.includes("LSH_BOOTSTRAP_FAILED")) {
    return "LightSeek 会话引导失败，请稍后重试。";
  }
  if (raw.includes("CONTENT_SOURCE_CHANGED") || raw.includes("LSH_SOURCE_CHANGED")) {
    return "电脑连接已变化，请返回后重新进入。";
  }
  if (raw.includes("CONTENT_OFFLINE") || raw.includes("CONTENT_DISCONNECTED")) {
    return "电脑未连接：LightSeek 需要在电脑在线时使用。";
  }
  if (raw.includes("LSH_SURFACE_DECLINED")) {
    return "未能打开 LightSeek 界面，请稍后重试。";
  }
  if (raw.includes("CONTENT_UPGRADE_REQUIRED")) {
    return "当前桌面版本尚未开放该能力。";
  }
  return "操作失败，请重试。";
}
