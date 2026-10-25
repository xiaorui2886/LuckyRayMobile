import { ServicesError, type ServicesRequest, type ServicesResponse, type ServicesTransport } from "./transport.ts";

type Job = { instance: string; background: boolean; run: () => Promise<ServicesResponse>; resolve: (value: ServicesResponse) => void; reject: (error: unknown) => void };
const backgroundOperations = new Set(["knowledge.editing", "knowledge.relations", "knowledge.changes", "materials.changes"]);

/** Bounded read lane: one slot remains available for visible navigation.
 * Mutations are never merged/replayed and keep their existing transaction owner.
 * Only overlapping exact reads share a promise; there is no response-data cache.
 */
export class ServicesReadCoordinator {
  private queue: Job[] = [];
  private globalEpoch = 0;
  private ownerEpochs = new Map<string, number>();
  private scopeEpochs = new Map<string, number>();
  private scopeKey(instance: string, scope: {library?: string; vault?: string}): string {
    return JSON.stringify([instance, scope.library || "", scope.vault || ""]);
  }
  private epoch(req: ServicesRequest): string {
    return `${this.globalEpoch}:${this.ownerEpochs.get(req.instance) ?? 0}:${this.scopeEpochs.get(this.scopeKey(req.instance,req)) ?? 0}`;
  }
  invalidate(instance?: string, scope?: {library?: string; vault?: string}): void {
    if (!instance) { this.globalEpoch++; return; }
    if (!scope) { this.ownerEpochs.set(instance,(this.ownerEpochs.get(instance) ?? 0)+1); return; }
    const key=this.scopeKey(instance,scope);
    this.scopeEpochs.set(key,(this.scopeEpochs.get(key) ?? 0)+1);
  }
  private active = new Map<string, number>();
  private backgroundActive = new Map<string, number>();
  private inflight = new Map<string, Promise<ServicesResponse>>();

  wrap(transport: ServicesTransport): ServicesTransport {
    return { invalidate: (instance,scope) => { this.invalidate(instance,scope); transport.invalidate?.(instance,scope); }, request: request => {
      // Capture all routing fields before yielding to a queue. Never read the
      // caller's mutable current selection when this request eventually starts.
      const captured = { ...request, query: request.query ? { ...request.query } : undefined };
      if (captured.method !== "GET" || captured.body !== undefined || captured.chunk !== undefined) return transport.request(captured);
      const epoch = this.epoch(captured);
      const key = JSON.stringify([epoch, captured.instance, captured.library || "", captured.vault || "",
        captured.operationId, captured.path, Object.entries(captured.query ?? {}).sort(([a], [b]) => a.localeCompare(b))]);
      const existing = this.inflight.get(key);
      if (existing) return existing;
      if (this.queue.length >= 64) return Promise.reject(new ServicesError("SERVICE_UNAVAILABLE", 503));
      const task = new Promise<ServicesResponse>((resolve, reject) => {
        this.queue.push({ instance: captured.instance, background: backgroundOperations.has(captured.operationId), run: async () => {
          if (this.epoch(captured) !== epoch) throw new ServicesError("SOURCE_CHANGED", 409);
          const response = await transport.request(captured);
          if (this.epoch(captured) !== epoch) throw new ServicesError("SOURCE_CHANGED", 409);
          return response;
        }, resolve, reject });
      }).finally(() => { if (this.inflight.get(key) === task) this.inflight.delete(key); });
      this.inflight.set(key, task);
      this.drain();
      return task;
    } };
  }

  private drain(): void {
    const available = (job: Job) => (this.active.get(job.instance) ?? 0) < 2;
    while (true) {
      let index = this.queue.findIndex(job => !job.background && available(job));
      if (index < 0) index = this.queue.findIndex(job => job.background && available(job)
        && (this.backgroundActive.get(job.instance) ?? 0) === 0);
      if (index < 0) return;
      const [job] = this.queue.splice(index, 1);
      this.active.set(job.instance, (this.active.get(job.instance) ?? 0) + 1);
      if (job.background) this.backgroundActive.set(job.instance, 1);
      void Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => {
        const remaining = (this.active.get(job.instance) ?? 1) - 1;
        if (remaining) this.active.set(job.instance, remaining); else this.active.delete(job.instance);
        if (job.background) this.backgroundActive.delete(job.instance);
        this.drain();
      });
    }
  }
}

export const productionReadCoordinator = new ServicesReadCoordinator();
