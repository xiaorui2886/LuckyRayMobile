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
  const cooldown = new Map<string, { until: number; failures: number }>();
  return { async request(request) {
    const read = request.method === "GET";
    const deadline = now() + 60000;
    for (let attempt = 0; ; attempt++) {
      if (read) {
        // Another in-flight 429 can extend the owner's deadline while waiting.
        while ((cooldown.get(request.instance)?.until ?? 0) > now()) {
          if (now() >= deadline) throw new ServicesError("RATE_LIMITED", 429);
          await sleep(Math.min(deadline - now(), cooldown.get(request.instance)!.until - now()));
        }
      }
      const observed = cooldown.get(request.instance);
      const response = await transport.request(request);
      if (response.status !== 429) {
        // A stale success cannot erase a newer concurrent rate-limit signal.
        if (response.status >= 200 && response.status < 300 && observed
          && cooldown.get(request.instance) === observed && now() >= observed.until) cooldown.delete(request.instance);
        return response;
      }
      const failures = Math.min(5, (cooldown.get(request.instance)?.failures ?? 0) + 1);
      cooldown.set(request.instance, { until: now() + Math.min(30000, 1000 * 2 ** failures), failures });
      if (!read || attempt === 1) return response;
    }
  } };
}
