import type { ChangeFeedClient } from "./companionServices/changeFeedClient.ts";

/** App-owned local hint drain; the existing durable sync owns all network/cursors. */
export class KnowledgeLiveSync {
  private epoch = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private feed: ChangeFeedClient;
  private wake: () => void;
  private permissionsChanged: (instance: string, revision: number) => void;
  constructor(feed: ChangeFeedClient, wake: () => void,
    permissionsChanged: (instance: string, revision: number) => void = () => {}) {
    this.feed = feed; this.wake = wake; this.permissionsChanged = permissionsChanged;
  }

  bind(instance: string): () => void {
    const epoch = ++this.epoch;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    let draining = false;
    let nextStart = 0;
    const ready = this.feed.stop().then(async () => {
      if (epoch === this.epoch && instance) {
        await this.feed.start(instance);
        nextStart = Date.now() + 5000;
      }
    });
    const drain = async () => {
      if (draining || epoch !== this.epoch || !instance) return;
      draining = true;
      try {
        await ready;
        if (epoch !== this.epoch) return;
        if (this.feed.boundGeneration() === null && Date.now() >= nextStart) {
          nextStart = Date.now() + 5000;
          await this.feed.start(instance);
        }
        await this.feed.refreshMode();
        if (epoch !== this.epoch) return;
        const hints = await this.feed.readHints();
        if (epoch !== this.epoch) return;
        for (const hint of hints) if (hint.kind === "servicesChanged") this.permissionsChanged(instance, hint.permissionRevision);
        if (hints.some(h => h.kind === "knowledgeChanged")) this.wake();
      } catch { /* durable visible-app fallback remains available */ }
      finally { draining = false; }
    };
    if (instance) this.timer = setInterval(() => void drain(), 400);
    return () => {
      if (epoch !== this.epoch) return;
      ++this.epoch;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      void this.feed.stop();
    };
  }
}
