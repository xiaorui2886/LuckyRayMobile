import { contentReadCooldown, type ContentReadCooldown } from './contentReadCooldown.ts';

type Job = { scope: string; epoch: number; current: () => boolean; run: () => Promise<unknown>; resolve: (value: any) => void; reject: (error: unknown) => void };
const scopeDenied = (error: unknown) => /CONTENT_HTTP_(?:401|403)\b|\bhttp\s+(?:401|403)\b|FORBIDDEN|REVOKED/.test(String(error));

/** Only primary material-detail IPC. Not a content/auth cache, not the Services
 * or note lane. Already-issued native reads cannot be revoked by this queue.
 * Each owner has two active slots and at most ONE latest foreground candidate.
 */
export class ContentDetailReadCoordinator {
  private active = new Map<string, number>();
  private pending = new Map<string, Job>();
  // Fences cancellation batches only; stores no permission decision or response.
  private epochs = new Map<string, number>();
  private cooldown: ContentReadCooldown;
  constructor(cooldown: ContentReadCooldown = contentReadCooldown) { this.cooldown = cooldown; }

  /** An explicit recheck starts a fresh batch; older failures cannot poison it. */
  allowManual(scope: string): void { this.epochs.set(scope, (this.epochs.get(scope) || 0) + 1); }

  read<T>(owner: string, scope: string, current: () => boolean, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: Job = {scope, epoch: this.epochs.get(scope) || 0, current, run, resolve, reject};
      if (!current()) { reject('CONTENT_READ_RETIRED'); return; }
      if ((this.active.get(owner) || 0) < 2) this.start(owner, job);
      else {
        // New navigation supersedes, rather than accumulates behind, stale pages.
        this.pending.get(owner)?.reject('CONTENT_READ_RETIRED');
        this.pending.set(owner, job);
      }
    });
  }

  private start(owner: string, job: Job): void {
    this.active.set(owner, (this.active.get(owner) || 0) + 1);
    void Promise.resolve().then(async () => {
      if (!job.current()) throw 'CONTENT_READ_RETIRED';
      const wait = this.cooldown.remaining(job.scope);
      if (wait) throw `CONTENT_HTTP_429 retryAfterMs=${wait}`;
      // A candidate waiting across a successful verification joins the current
      // cancellation batch only when it actually enters native.
      job.epoch = this.epochs.get(job.scope) || 0;
      let value: unknown;
      try { value = await job.run(); }
      catch (error) {
        // Server feedback remains useful even when its page was replaced.
        // Record it BEFORE freeing a slot, so the latest candidate cannot race it.
        this.cooldown.observe(job.scope, error);
        if (scopeDenied(error) && job.epoch === (this.epochs.get(job.scope) || 0)) {
          const queued = this.pending.get(owner);
          if (queued?.scope === job.scope && queued.epoch === job.epoch) {
            this.pending.delete(owner); queued.reject(error);
          }
        }
        throw error;
      }
      // A real native 200 is newer authority evidence, never discarded because
      // another page failed. It fences later failures from the old batch.
      if (job.epoch === (this.epochs.get(job.scope) || 0)) this.allowManual(job.scope);
      if (!job.current()) throw 'CONTENT_READ_RETIRED';
      return value;
    }).then(job.resolve, job.reject).finally(() => {
      const count = (this.active.get(owner) || 1) - 1;
      if (count) this.active.set(owner, count); else this.active.delete(owner);
      const next = this.pending.get(owner);
      if (next) { this.pending.delete(owner); this.start(owner, next); }
    });
  }
}
export const contentDetailReads = new ContentDetailReadCoordinator();
