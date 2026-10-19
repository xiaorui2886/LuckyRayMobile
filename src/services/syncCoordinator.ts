// SyncCoordinator — single-flight durable sync with exponential backoff.
// Triggers: cold start, pairing, foreground, WS reconnect, outbox enqueue,
// manual pull. WS is a hint only; durable cursor sync is the source of truth.
// Cursor advances only after the SQLite transaction commits (Rust side).

import { api } from "./client.ts";
import { dataStore } from "./dataStore.ts";

export type SyncStatus = "idle" | "syncing" | "offline" | "error";

export interface SyncSnapshot {
  status: SyncStatus;
  error: string | null;
  pendingOutbox: number;
  desktopBusyNotes: readonly string[];
}

type RunFn = () => Promise<unknown>;

export class SyncCoordinator {
  private inflight: Promise<unknown> | null = null;
  private status: SyncStatus = "idle";
  private error: string | null = null;
  private pendingOutbox = 0;
  private backoffMs = 1000;
  private listeners = new Set<() => void>();
  private runFn: RunFn;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private cached: SyncSnapshot | null = null;
  private wakePending = false;
  private owner = "";
  private ownerEpoch = 0;
  private desktopBusyNotes: readonly string[] = [];
  // Legacy sync remains gated by default. Production injects the authorized
  // content adapter, which negotiates capabilities before accessing notes.
  private foundationBlocked = true;
  private contentOnly: boolean;

  constructor(
    runFn: RunFn = () => api.syncRun(),
    opts?: { foundationBlocked?: boolean; contentOnly?: boolean }
  ) {
    this.runFn = runFn;
    // Keep the historical sync_run/capture/AI path opt-in for test callers.
    this.foundationBlocked = opts?.foundationBlocked ?? true;
    this.contentOnly = opts?.contentOnly ?? false;
  }

  /** Single-flight: concurrent calls share the in-flight run. */
  run(): Promise<unknown> {
    if (this.foundationBlocked) return Promise.resolve(null); // P1-1 gate
    if (this.inflight) return this.inflight;
    const ownerEpoch = this.ownerEpoch;
    this.setStatus("syncing");
    this.error = null;
    this.notify();
    const p = this.runFn()
      .then(async (result) => {
        if (ownerEpoch !== this.ownerEpoch) return;
        this.status = "idle";
        this.backoffMs = 1000;
        if (this.contentOnly) {
          const content = result as { continuation?: boolean; applied?: number; pushed?: number; instanceId?: string; vaultId?: string; desktopBusyNoteIds?: string[]; attentionRequired?: boolean } | null;
          if (this.owner && content?.instanceId && content.instanceId !== this.owner) return;
          this.desktopBusyNotes = content?.instanceId && content.vaultId
            ? (content.desktopBusyNoteIds ?? []).map(id => JSON.stringify([content.instanceId, content.vaultId, id])) : [];
          if (content?.attentionRequired === true) {
            this.status = "error";
            this.error = "CONTENT_SYNC_REQUIRES_ATTENTION";
          }
          if (content?.applied || content?.pushed || content?.continuation) dataStore.bump();
          if (content?.continuation && !this.retryTimer) this.retryTimer = setTimeout(() => { this.retryTimer = null; this.trigger(); }, 100);
        } else await this.refreshOutboxStatus();
      })
      .catch((e: any) => {
        if (ownerEpoch !== this.ownerEpoch) return;
        const msg = String(e ?? "");
        this.error = msg;
        // offline-ish errors -> backoff retry; other errors also retry with backoff
        this.status = /offline|connection|timed out|failed to send/i.test(msg) ? "offline" : "error";
        this.scheduleRetry();
      })
      .finally(() => {
        this.inflight = null;
        this.notify();
        if (this.wakePending) {
          this.wakePending = false;
          this.trigger();
        }
      });
    this.inflight = p;
    this.notify();
    return p;
  }

  /** Coalesced trigger: if already syncing, drop; otherwise run once. */
  trigger(): void {
    if (this.foundationBlocked) return; // P1-1: routes not authorized yet
    if (this.inflight) return; // coalesce
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    void this.run();
  }

  /** Event/local-commit wake: retain one follow-up pass behind an active run. */
  wake(): void {
    if (this.foundationBlocked) return;
    if (this.inflight) { this.wakePending = true; return; }
    this.trigger();
  }

  /** Runtime projection only; a retired Desktop cannot report busy on its successor. */
  setOwner(instance: string): void {
    if (this.owner === instance) return;
    this.owner = instance;
    this.ownerEpoch += 1;
    this.wakePending = false;
    this.desktopBusyNotes = [];
    this.status = "idle";
    this.error = null;
    this.backoffMs = 1000;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.notify();
  }

  /**
   * Publish a local outbox mutation (enqueue/flush) to Settings/Home without
   * initiating another durable sync. Capture uses this after its own command
   * has committed, and run() uses it after a successful sync.
   */
  async refreshOutboxStatus(): Promise<void> {
    await this.refreshOutbox();
    this.notify();
    dataStore.bump();
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.run();
    }, delay);
  }

  private async refreshOutbox(): Promise<void> {
    try {
      const list = await api.captureList();
      this.pendingOutbox = list.filter((o) => o.state !== "completed").length;
    } catch {
      /* keep last known */
    }
  }

  snapshot(): SyncSnapshot {
    // stable reference for useSyncExternalStore (same state -> same object)
    if (
      this.cached &&
      this.cached.status === this.status &&
      this.cached.error === this.error &&
      this.cached.pendingOutbox === this.pendingOutbox
      && this.cached.desktopBusyNotes === this.desktopBusyNotes
    ) {
      return this.cached;
    }
    this.cached = { status: this.status, error: this.error, pendingOutbox: this.pendingOutbox, desktopBusyNotes: this.desktopBusyNotes };
    return this.cached;
  }

  /** Clear scheduled retry (used by tests / teardown). */
  dispose(): void {
    this.wakePending = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private setStatus(s: SyncStatus): void {
    this.status = s;
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }
}

// Native content_sync negotiates domain capabilities and never calls the legacy
// sync_run/capture/AI paths. The class's legacy/test gate remains explicit.
export const syncCoordinator = new SyncCoordinator(() => api.contentSync(), { foundationBlocked: false, contentOnly: true });
