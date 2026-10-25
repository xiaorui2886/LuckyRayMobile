import { desktopLibraries } from "./desktopLibraries.ts";
// SyncCoordinator — single-flight durable sync with exponential backoff.
// Triggers: cold start, pairing, foreground, WS reconnect, outbox enqueue,
// manual pull. WS is a hint only; durable cursor sync is the source of truth.
// Cursor advances only after the SQLite transaction commits (Rust side).

import { api } from "./client.ts";
import { dataStore } from "./dataStore.ts";
import { managedVault, subscribeManagedVaultMutations } from "./managedVault.ts";
import { ManagedSyncSchedule, type ManagedSyncTarget, type ScheduleStorage } from "./managedSyncSchedule.ts";

export interface ManagedSyncOptions {
  targets(instance: string): Promise<{ items: ManagedSyncTarget[]; legacyFallback?: boolean }>;
  storage?: ScheduleStorage;
  now?: () => number;
}

export type SyncStatus = "idle" | "syncing" | "offline" | "error";

export interface SyncSnapshot {
  status: SyncStatus;
  error: string | null;
  pendingOutbox: number;
  desktopBusyNotes: readonly string[];
}

type RunFn = (instance?: string, vault?: string) => Promise<unknown>;

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
  private managed?: ManagedSyncOptions;
  private schedule: ManagedSyncSchedule;
  private disposed = false;
  private mutationTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    runFn: RunFn = () => api.syncRun(),
    opts?: { foundationBlocked?: boolean; contentOnly?: boolean; managed?: ManagedSyncOptions }
  ) {
    this.runFn = runFn;
    this.managed = opts?.managed;
    this.schedule = new ManagedSyncSchedule(opts?.managed?.storage, opts?.managed?.now);
    // Keep the historical sync_run/capture/AI path opt-in for test callers.
    this.foundationBlocked = opts?.foundationBlocked ?? true;
    this.contentOnly = opts?.contentOnly ?? false;
  }

  /** Single-flight: concurrent calls share the in-flight run. */
  run(): Promise<unknown> {
    if (this.foundationBlocked || this.disposed || (this.managed && !this.owner)) return Promise.resolve(null); // P1-1 gate
    if (this.inflight) return this.inflight;
    const ownerEpoch = this.ownerEpoch;
    this.setStatus("syncing");
    this.error = null;
    this.notify();
    const owner = this.owner;
    let vault: string | undefined;
    let target: ManagedSyncTarget | undefined;
    let targets: ManagedSyncTarget[] = [];
    let managedRound = false;
    const current = () => ownerEpoch === this.ownerEpoch && !this.disposed;
    const execute = async () => {
      if (this.managed) {
        const batch = await this.managed.targets(owner);
        if (!current()) return null;
        targets = batch.items.filter(t => t.instanceId === owner);
        managedRound = !batch.legacyFallback;
        if (managedRound) {
          this.pendingOutbox = targets.reduce((sum, t) => sum + Math.max(0, t.pendingCount), 0);
          target = this.schedule.choose(owner, targets);
          if (!target) return null;
          vault = target.vaultId;
        }
      }
      if (!managedRound) {
        const selected = desktopLibraries.snapshot(owner);
        vault = selected.catalog?.scopeSelectionVersion === 1 ? selected.vault : undefined;
      }
      if (!current()) return null;
      return this.runFn(owner || undefined, vault);
    };
    const p = execute()
      .then(async (result) => {
        if (!current()) return;
        this.status = "idle";
        this.backoffMs = 1000;
        if (this.contentOnly) {
          const content = result as { continuation?: boolean; applied?: number; pushed?: number; instanceId?: string; vaultId?: string; desktopBusyNoteIds?: string[]; attentionRequired?: boolean; pairingReviewRequired?: boolean; warningCode?: string; retryAfterMs?: number } | null;
          if (this.owner && content?.instanceId && content.instanceId !== this.owner) return;
          if (target && content && (content.instanceId !== owner || content.vaultId !== target.vaultId)) throw new Error("CONTENT_SCOPE_MISMATCH");
          if (target) this.schedule.complete(owner, target, !!content?.continuation, !!content?.desktopBusyNoteIds?.length, content?.retryAfterMs);
          if (content?.instanceId && content.vaultId) {
            const retained = managedRound ? this.desktopBusyNotes.filter(value => {
              const [instance, scope] = JSON.parse(value);
              return instance === owner && scope !== content.vaultId;
            }) : [];
            this.desktopBusyNotes = [...retained, ...(content.desktopBusyNoteIds ?? []).map(id => JSON.stringify([content.instanceId, content.vaultId, id]))];
          }
          if (content?.pairingReviewRequired === true) {
            this.status = "error";
            this.error = "CONTENT_PAIRING_REVIEW_REQUIRED";
          } else if (content?.attentionRequired === true) {
            this.status = "error";
            this.error = "CONTENT_SYNC_REQUIRES_ATTENTION";
          }
          if (content?.applied || content?.pushed || content?.continuation) dataStore.bump();
          // The local file views do not subscribe to the legacy SQLite list store.
          // Only a validated completed managed scope may announce a refresh; the
          // native commit can also update attachment completeness without text changes.
          if (target && content && typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("luckyray:managed-vault-change", {detail: {localVaultId: target.localVaultId}}));
          }
          if (!managedRound && content?.continuation && !this.retryTimer) this.retryTimer = setTimeout(() => { this.retryTimer = null; this.trigger(); }, 100);
        } else await this.refreshOutboxStatus();
      })
      .catch((e: any) => {
        if (!current()) return;
        const msg = String(e ?? "");
        this.error = msg;
        // offline-ish errors -> backoff retry; other errors also retry with backoff
        this.status = /offline|connection|timed out|failed to send/i.test(msg) ? "offline" : "error";
        if (target) this.schedule.fail(owner, target, msg);
        else this.scheduleRetry();
      })
      .finally(() => {
        this.inflight = null;
        if (current() && managedRound && !this.retryTimer) {
          const delay = this.schedule.delay(owner, targets);
          if (delay !== undefined) this.retryTimer = setTimeout(() => { this.retryTimer = null; this.trigger(); }, delay);
        }
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

  /** Only an authenticated reconnect/grant-change hint clears authorization retirement. */
  authorizationChanged(instance: string): void {
    if (!instance || instance !== this.owner) return;
    this.ownerEpoch += 1;
    this.desktopBusyNotes = [];
    this.schedule.authorizationChanged(instance);
    this.wake();
  }

  /** Post-local-commit hint, never synchronous network or one HTTP per keystroke. */
  localMutation(instance: string | null): void {
    if (!this.owner || (instance && instance !== this.owner) || this.disposed) return;
    if (this.mutationTimer) clearTimeout(this.mutationTimer);
    const epoch = this.ownerEpoch;
    this.mutationTimer = setTimeout(() => {
      this.mutationTimer = null;
      if (epoch === this.ownerEpoch) this.wake();
    }, 700);
  }

  /** Runtime projection only; a retired Desktop cannot report busy on its successor. */
  setOwner(instance: string): void {
    if (this.owner === instance) return;
    this.owner = instance;
    this.ownerEpoch += 1;
    if (this.mutationTimer) { clearTimeout(this.mutationTimer); this.mutationTimer = null; }
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
    this.disposed = true;
    this.ownerEpoch += 1;
    if (this.mutationTimer) { clearTimeout(this.mutationTimer); this.mutationTimer = null; }
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
export const syncCoordinator = new SyncCoordinator((instance,vault) => api.contentSync(instance,vault), {
  foundationBlocked: false, contentOnly: true,
  managed: {
    targets: async instance => {
      const result = await managedVault.syncTargets(instance);
      if (result.items.length) return result;
      const migration = await managedVault.migrationStatus();
      return { ...result, legacyFallback: migration.state !== "ready" };
    },
    storage: {
      getItem: key => { try { return localStorage.getItem(key); } catch { return null; } },
      setItem: (key, value) => { try { localStorage.setItem(key, value); } catch { /* optional mirror */ } },
    },
  },
});

subscribeManagedVaultMutations(event => syncCoordinator.localMutation(event.instanceId));
