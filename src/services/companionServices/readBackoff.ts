import { ServicesError, type ServicesTransport } from "./transport.ts";

/** Shared per-Desktop cooldown, no credentials/cache and no mutation replay.
 * The original Rust transport still captures and checks the pinned owner for
 * EVERY send, including the single bounded GET retry. Catalog adoption and UI
 * epochs continue to reject superseded responses.
 */
export function withReadBackoff(transport: ServicesTransport, options: {
  now?: () => number; sleep?: (milliseconds: number) => Promise<void>;
} = {}): ServicesTransport {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let epoch = 0;
  const ownerEpochs = new Map<string, number>();
  const scopeEpochs = new Map<string, number>();
  const scopeKey = (instance: string, scope: {library?: string; vault?: string}) => JSON.stringify([instance,scope.library || "",scope.vault || ""]);
  const cooldown = new Map<string, { until: number; failures: number }>();
  return { invalidate: (instance,scope) => {
    if (!instance) epoch++;
    else if (!scope) ownerEpochs.set(instance,(ownerEpochs.get(instance) ?? 0)+1);
    else { const key=scopeKey(instance,scope); scopeEpochs.set(key,(scopeEpochs.get(key) ?? 0)+1); }
    transport.invalidate?.(instance,scope);
  }, async request(request) {
    request = {...request, query: request.query ? {...request.query} : undefined};
    const key=scopeKey(request.instance,request);
    const captured=[epoch,ownerEpochs.get(request.instance) ?? 0,scopeEpochs.get(key) ?? 0];
    const current = () => {
      if (captured[0] !== epoch || captured[1] !== (ownerEpochs.get(request.instance) ?? 0)
        || captured[2] !== (scopeEpochs.get(key) ?? 0)) throw new ServicesError("SOURCE_CHANGED",409);
    };
    const read = request.method === "GET";
    const deadline = now() + 60000;
    for (let attempt = 0; ; attempt++) {
      current();
      if (read) {
        // Another in-flight 429 can extend the owner's deadline while waiting.
        while ((cooldown.get(request.instance)?.until ?? 0) > now()) {
          current();
          if (cooldown.get(request.instance)!.until - now() > 30000) throw new ServicesError("RATE_LIMITED", 429);
          if (now() >= deadline) throw new ServicesError("RATE_LIMITED", 429);
          await sleep(Math.min(deadline - now(), cooldown.get(request.instance)!.until - now()));
        }
      }
      current();
      const observed = cooldown.get(request.instance);
      const response = await transport.request(request);
      if (read) current();
      if (response.status !== 429) {
        // A stale success cannot erase a newer concurrent rate-limit signal.
        if (response.status >= 200 && response.status < 300 && observed
          && cooldown.get(request.instance) === observed && now() >= observed.until) cooldown.delete(request.instance);
        return response;
      }
      const failures = Math.min(5, (cooldown.get(request.instance)?.failures ?? 0) + 1);
      const advertised = response.retryAfterMs;
      // Honor the server delay within this bounded read transaction. A larger
      // delay is surfaced, never shortened into a premature automatic retry.
      if (typeof advertised === "number" && Number.isFinite(advertised) && advertised > 30000) {
        cooldown.set(request.instance, {until: Math.max(cooldown.get(request.instance)?.until ?? 0, Math.min(Number.MAX_SAFE_INTEGER, now() + advertised)), failures});
        return response;
      }
      const delay = typeof advertised === "number" && Number.isFinite(advertised) && advertised >= 0
        ? Math.max(100, advertised) : Math.min(30000, 1000 * 2 ** failures);
      cooldown.set(request.instance, { until: Math.max(cooldown.get(request.instance)?.until ?? 0, now() + delay), failures });
      if (!read || attempt === 1) return response;
    }
  } };
}
