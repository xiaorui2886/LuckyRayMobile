// Shared Local Asset thumbnail scheduler (FIX-V1 P1-3).
//
// Every mounted grid card used to call localAssetThumbnail immediately; with
// a 200-item page that could start many concurrent JNI/Bitmap decodes on the
// old MI 8. This scheduler bounds aggregate concurrency:
//
//  - hard maximum of MAX_CONCURRENT (3) thumbnail-generation jobs at once;
//  - one asset id is coalesced: concurrent enqueues share one promise, so a
//    job never runs twice for the same asset;
//  - a failed job releases its slot and later jobs continue (art/icon
//    fallback is handled by the caller);
//  - unmounting a card never corrupts queue accounting — the caller only
//    ignores the result; the scheduler's slot bookkeeping is independent of
//    component lifetime.
//
// No polling; no media framework. Already-cached thumbnail requests resolve
// through the normal (fast) backend path.

export const MAX_THUMBNAIL_CONCURRENCY = 3;

type Job = {
  key: string;
  run: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
};

export class ThumbnailScheduler {
  private queue: Job[] = [];
  /** Visible / near-viewport jobs — always served before the tail. */
  private nearQueue: Job[] = [];
  private inflight = new Map<string, Promise<unknown>>();
  private active = 0;

  /** Max concurrent jobs observed since the last reset (test/diagnostics). */
  maxActiveObserved = 0;

  /**
   * @param priority "near" jobs (visible / near-viewport tiles) are served
   *   before the "tail" queue, so the first screen fills first and a 100-row
   *   page never starts all of its thumbnail work at once.
   */
  enqueue<T>(key: string, task: () => Promise<T>, priority: "near" | "tail" = "tail"): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) {
      if (priority === "near") {
        const index=this.queue.findIndex(job=>job.key===key);
        if (index>=0) this.nearQueue.push(...this.queue.splice(index,1));
      }
      return existing as Promise<T>;
    }
    const promise = new Promise<T>((resolve, reject) => {
      const job = { key, run: task, resolve: resolve as (v: unknown) => void, reject };
      if (priority === "near") this.nearQueue.push(job);
      else this.queue.push(job);
    });
    this.inflight.set(key, promise);
    this.pump();
    return promise;
  }

  private pump(): void {
    while (this.active < MAX_THUMBNAIL_CONCURRENCY && (this.nearQueue.length > 0 || this.queue.length > 0)) {
      const job = (this.nearQueue.shift() ?? this.queue.shift())!;
      this.active += 1;
      this.maxActiveObserved = Math.max(this.maxActiveObserved, this.active);
      Promise.resolve()
        .then(job.run)
        .then(
          (value) => job.resolve(value),
          (error) => job.reject(error)
        )
        .finally(() => {
          this.active -= 1;
          this.inflight.delete(job.key);
          this.pump();
        });
    }
  }

  /** Test helper: current in-flight count. */
  activeCount(): number {
    return this.active;
  }

  /** Test helper: jobs still waiting (near + tail). */
  pendingCount(): number {
    return this.nearQueue.length + this.queue.length;
  }

  /** Retire only queued work; started native reads remain bounded and fenced
   * by their captured owner/version. A later visible request can retry. */
  cancelPending(match: (key: string) => boolean): number {
    let count=0;
    const keep=(job:Job) => {
      if (!match(job.key)) return true;
      this.inflight.delete(job.key); job.reject(new Error("THUMBNAIL_CANCELLED")); count++; return false;
    };
    this.queue=this.queue.filter(keep); this.nearQueue=this.nearQueue.filter(keep);
    return count;
  }

  /** Test helper: how many near-viewport jobs are still queued. */
  nearPendingCount(): number {
    return this.nearQueue.length;
  }
}

export const thumbnailScheduler = new ThumbnailScheduler();

/**
 * MATERIAL-LIBRARY-INSTANT-R1 — source-qualified thumbnail keys.
 *
 * One unqualified `assetId` key let a Local asset and a Desktop asset collide
 * in the same scheduler entry (and in any caller-side map keyed by it). Every
 * thumbnail job is now namespaced by its SOURCE, and Desktop jobs additionally
 * by the producing Desktop instance, so a Desktop owner change can never
 * satisfy or erase a Local thumbnail.
 */
export function localThumbKey(localAssetId: string, version = "", preview = false): string {
  return `local:${localAssetId}${version ? ":v:"+encodeURIComponent(version) : ""}${preview ? ":screen" : ""}`;
}

export function desktopThumbKey(instanceId: string, desktopAssetId: string, version = "", preview = false): string {
  return `desktop:${instanceId}:${desktopAssetId}${version ? ":v:"+encodeURIComponent(version) : ""}${preview ? ":screen" : ""}`;
}

/** Existing Content fields only; no invented server revision semantics. */
export function materialImageVersion(row: any): string {
  const fields=[row?.contentHash||"",row?.thumbnailRevision||"",row?.updatedAt||""];
  return fields.some(Boolean) ? fields.join("|") : "";
}
