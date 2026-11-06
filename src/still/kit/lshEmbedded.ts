/** Presentation-only owner for the native embedded view. Desktop remains the
 * sole session/runtime authority. No tokens or chat content enter this store. */
export type LshBounds = { x: number; y: number; width: number; height: number; viewportWidth: number };
export type LshEmbedRequest = { expectedInstance: string; presentationId?: string; presentationActivation?: number; lifecycleGeneration?: number; action: 'open'|'layout'|'hide'|'close'|'back'|'status'|'suspend'; sessionUrl?: string; bounds?: LshBounds; dark?: boolean };
export type LshEmbedReceipt = { opened: boolean; visible: boolean; canGoBack: boolean; ready: boolean; suspended?: boolean; lifecycleGeneration?: number; error?: string; backHandled?: boolean };
export type LshEmbedTransport = {
  bootstrap(owner: string): Promise<{ sessionUrl: string }>;
  embed(request: LshEmbedRequest): Promise<LshEmbedReceipt>;
};
export type LshEmbedState = { phase: 'idle'|'loading'|'ready'|'error'; error: string; canGoBack: boolean; revalidationRequired?: boolean };
export function usableLshBounds(bounds: LshBounds): boolean {
  return Object.values(bounds).every(Number.isFinite) && bounds.x >= 0 && bounds.y >= 0
    && bounds.width >= 1 && bounds.height >= 1 && bounds.viewportWidth >= bounds.width;
}
/** Bounds every bridge stage; a timeout is not cancellation or successful readiness. */
export function lshDeadline<T>(work: Promise<T>, ms: number, code: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(code)), ms);
    work.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
let nextPresentation = 0;
const presentationEpoch = Date.now().toString(36);
export class LshEmbeddedController {
  private target: { owner: string; bounds: LshBounds; dark: boolean } | null = null;
  private lifecycleGeneration = 0;
  private lastTarget: { owner: string; bounds: LshBounds; dark: boolean } | null = null;
  private owner = '';
  private presentationId = '';
  private presentationActivation = 0;
  private lastGestureId = 0;
  private recoveredActivation = -1;
  private activationReady = false;
  private loadingBegan = 0;
  private hiddenAt: number | null = null;
  private pollPending = false;
  private serial = Promise.resolve();
  private revision = 0;
  private listeners = new Set<() => void>();
  private state: LshEmbedState = { phase: 'idle', error: '', canGoBack: false };
  private transport: LshEmbedTransport;
  private timeoutMs: number;
  private now: () => number;
  constructor(transport: LshEmbedTransport, timeoutMs = 45_000, now = () => Date.now()) { this.transport = transport; this.timeoutMs = timeoutMs; this.now = now; }
  private embed(request: LshEmbedRequest) {
    return lshDeadline(this.transport.embed(request.sessionUrl && request.action === 'close' ? request : { ...request, presentationId: this.presentationId, presentationActivation: this.presentationActivation, lifecycleGeneration: this.lifecycleGeneration }), Math.min(this.timeoutMs, 10_000), 'LSH_NATIVE_TIMEOUT');
  }
  /** Native events are presentation-only. Lease/auth checks remain native. */
  consumeTabSwipe(detail: unknown): 'left'|'right'|null {
    if (!this.target || !this.activationReady || this.state.phase !== 'ready' || !detail || typeof detail !== 'object') return null;
    const d = detail as Record<string, unknown>;
    if ((d.direction !== 'left' && d.direction !== 'right') || d.presentationId !== this.presentationId || d.presentationActivation !== this.presentationActivation || !Number.isSafeInteger(d.gestureId) || (d.gestureId as number) <= this.lastGestureId) return null;
    this.lastGestureId = d.gestureId as number;
    return d.direction;
  }
  isReadyFor = (owner: string) => this.owner === owner && this.activationReady && this.state.phase === 'ready' && !this.state.revalidationRequired;
  snapshot = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private publish(next: LshEmbedState) { this.state = next; this.listeners.forEach(fn => fn()); }
  private enqueue(work: () => Promise<void>) { this.serial = this.serial.then(work, work).catch(() => {}); return this.serial; }
  attach(owner: string, bounds: LshBounds, dark: boolean) {
    if (!owner || !usableLshBounds(bounds)) return this.hide();
    if (!this.target || this.target.owner !== owner) { this.presentationActivation += 1; this.lastGestureId = 0; this.activationReady = false; }
    if (this.hiddenAt !== null) {
      this.loadingBegan += Math.max(0, this.now() - this.hiddenAt);
      this.hiddenAt = null;
    }
    this.target = { owner, bounds, dark };
    this.lastTarget = this.target;
    const revision = ++this.revision;
    return this.enqueue(async () => {
      if (revision !== this.revision || !this.target) return;
      const target = this.target;
      try {
        if (this.owner && this.owner !== owner) {
          await this.embed({ action: 'close', expectedInstance: this.owner });
          this.owner = '';
        }
        if (this.owner) {
          const receipt = await this.embed({ action: 'layout', expectedInstance: owner, bounds: target.bounds, dark: target.dark });
          if (revision !== this.revision || !this.target) return;
          const recoverable = receipt.error === 'LSH_PAGE_LOAD_FAILED' || receipt.error === 'LSH_PAGE_TIMEOUT';
          if (recoverable && this.recoveredActivation === this.presentationActivation) {
            await this.accept(receipt); return;
          }
          if (receipt.opened && !recoverable) {
            await this.accept(receipt); return;
          }
          if (recoverable) {
            this.recoveredActivation = this.presentationActivation;
            await this.embed({ action: 'close', expectedInstance: owner });
            if (revision !== this.revision || !this.target) { this.owner = ''; return; }
          }
          // A genuinely destroyed view may be recreated once after the host's
          // fresh permission check. Never loop on a native error or fake ready.
          if (receipt.error && !recoverable) throw new Error(receipt.error);
          this.owner = '';
        }
        if (!this.owner) {
          this.loadingBegan = this.now();
          this.publish({ phase: 'loading', error: '', canGoBack: false });
          let expired = false;
          const bootstrap = this.transport.bootstrap(owner);
          // Late bootstrap must retire only its exact unused lease, not a newer
          // view. Never log or put the opaque capability URL in diagnostics.
          void bootstrap.then(result => {
            if (expired) void this.embed({ action: 'close', expectedInstance: owner, sessionUrl: result.sessionUrl }).catch(() => {});
          }, () => {});
          let sessionUrl: string;
          try { ({ sessionUrl } = await lshDeadline(bootstrap, this.timeoutMs, 'LSH_BOOTSTRAP_TIMEOUT')); }
          catch (error) { expired = true; throw error; }
          // Bootstrap may complete after a tab switch. Never display a stale
          // surface; bootstrap authority still gets retired by close.
          if (revision !== this.revision || !this.target) {
            await this.embed({ action: 'close', expectedInstance: owner, sessionUrl });
            return;
          }
          this.loadingBegan = this.now(); // navigation has its own finite budget
          this.presentationId = `${presentationEpoch}-${++nextPresentation}`;
          this.owner = owner; // allow bounded cleanup even when native completion is unknown
          const receipt = await this.embed({ action: 'open', expectedInstance: owner, sessionUrl, bounds: target.bounds, dark: target.dark });
          if (!receipt.opened) throw new Error('LSH_SURFACE_DECLINED');
          this.owner = owner;
          if (revision !== this.revision || !this.target) {
            await this.embed({ action: 'hide', expectedInstance: owner });
            return;
          }
          this.lifecycleGeneration = receipt.lifecycleGeneration ?? 0;
          await this.accept(receipt);
        }
      } catch (error) {
        await this.fail(error, revision);
      }
    });
  }
  private async fail(error: unknown, revision: number) {
    if (revision !== this.revision) return;
    this.activationReady = false;
    if (this.owner) { try { await this.embed({ action: 'hide', expectedInstance: this.owner }); } catch { /* native timeout schedules lease-fenced hiding */ } }
    if (revision === this.revision) this.publish({ phase: 'error', error: error instanceof Error ? error.message : String(error), canGoBack: false });
  }
  private async accept(receipt: LshEmbedReceipt) {
    const revision = this.revision;
    this.activationReady = Boolean(this.target && receipt.visible && receipt.ready && !receipt.suspended && !receipt.error);
    if (receipt.error) { await this.fail(new Error(receipt.error), this.revision); return; }
    if (this.state.phase === 'ready' && !receipt.ready && !receipt.error) this.loadingBegan = this.now();
    if (!receipt.ready && !receipt.error && this.now() - this.loadingBegan >= this.timeoutMs) {
      if (this.owner) { try { await this.embed({ action: 'hide', expectedInstance: this.owner }); } catch { /* bounded native teardown may still be pending */ } }
      if (revision !== this.revision) return;
      this.publish({ phase: 'error', error: 'LSH_PRESENTATION_TIMEOUT', canGoBack: false });
      return;
    }
    this.publish({ phase: receipt.error ? 'error' : receipt.ready ? 'ready' : 'loading', error: receipt.error || '', canGoBack: receipt.canGoBack, revalidationRequired: Boolean(receipt.suspended || (receipt.lifecycleGeneration !== undefined && receipt.lifecycleGeneration !== this.lifecycleGeneration)) });
  }
  /** Keep only an existing ready presentation, never bootstrap or grant access.
   * Native owns a non-renewable timeout and blocks every input path. */
  async prepareRevalidation(owner: string): Promise<number | null> {
    const last = this.lastTarget;
    if (last?.owner !== owner || this.owner !== owner || this.state.phase === 'error') return null;
    let generation: number | null = null;
    this.target = null; this.activationReady = false;
    const revision = ++this.revision;
    await this.enqueue(async () => {
      if (this.owner !== owner || revision !== this.revision) return;
      // Initial loading has no ready pixels to retain; read only its lifecycle
      // while hidden, so interrupted first load can resume under a fresh grant.
      const receipt = await this.embed({ action: this.state.phase === 'ready' ? 'suspend' : 'status', expectedInstance: owner, bounds: last.bounds, dark: last.dark });
      if (revision === this.revision && !receipt.error && receipt.opened) generation = receipt.lifecycleGeneration ?? 0;
    });
    return generation;
  }
  confirmRevalidation(owner: string, generation: number | null) {
    if (this.owner === owner && generation !== null) {
      this.lifecycleGeneration = generation;
      // A new permission probe consumed the retry request, but input/readiness
      // still wait for a matching native layout receipt.
      if (this.state.revalidationRequired) this.publish({ ...this.state, revalidationRequired: false });
    }
  }
  suspend(owner: string, bounds: LshBounds, dark: boolean) {
    if (this.target) ++this.revision;
    this.target = null;
    this.activationReady = false;
    const revision = this.revision;
    if (this.hiddenAt === null) this.hiddenAt = this.now();
    return this.enqueue(async () => {
      if (revision !== this.revision || this.owner !== owner || this.state.phase !== 'ready') return;
      try {
        const receipt = await this.embed({ action: 'suspend', expectedInstance: owner, bounds, dark });
        if (revision !== this.revision) return;
        if (receipt.error || !receipt.opened) await this.fail(new Error(receipt.error || 'LSH_SURFACE_CLOSED'), revision);
      } catch (e) { await this.fail(e, revision); }
    });
  }
  hide() {
    if (this.hiddenAt === null) this.hiddenAt = this.now();
    this.target = null;
    this.activationReady = false;
    ++this.revision;
    return this.enqueue(async () => { if (this.owner) await this.embed({ action: 'hide', expectedInstance: this.owner }); });
  }
  close() {
    this.hiddenAt = null;
    this.target = null;
    this.activationReady = false;
    ++this.revision;
    return this.enqueue(async () => {
      const owner = this.owner;
      this.owner = '';
      if (owner) { try { await this.embed({ action: 'close', expectedInstance: owner }); } catch { /* Native deadline owns eventual fenced teardown. */ } }
      this.publish({ phase: 'idle', error: '', canGoBack: false });
    });
  }
  poll() {
    const owner = this.owner, revision = this.revision;
    if (!owner || !this.target || this.state.phase === 'error' || this.pollPending) return Promise.resolve();
    this.pollPending = true;
    return this.enqueue(async () => {
      if (revision !== this.revision || !this.target || this.state.phase === 'error') return;
      try {
        const receipt = await this.embed({ action: 'status', expectedInstance: owner });
        if (revision !== this.revision) return;
        if (!receipt.opened) { this.owner = ''; throw new Error('LSH_SURFACE_CLOSED'); }
        await this.accept(receipt);
      } catch (e) {
        await this.fail(e, revision);
      }
    }).finally(() => { this.pollPending = false; });
  }
  async back(): Promise<boolean> {
    const owner = this.owner, revision = this.revision;
    let handled = false;
    await this.enqueue(async () => {
      if (revision !== this.revision || owner !== this.owner) { handled = true; return; }
      if (owner && this.target) {
        try {
          const receipt = await this.embed({ action: 'back', expectedInstance: owner });
          if (revision !== this.revision || owner !== this.owner || !this.target) { handled = true; return; }
          handled = receipt.error ? true : receipt.backHandled === true;
          if (!receipt.error) await this.accept(receipt);
          if (revision !== this.revision || owner !== this.owner || !this.target) handled = true;
        } catch {
          // Unknown native outcome must not trigger a second root navigation.
          handled = true;
        }
      }
    });
    return revision !== this.revision || owner !== this.owner ? true : handled;
  }
}
