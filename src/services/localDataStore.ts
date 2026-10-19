// Event-driven Mobile-local data invalidation (M2.10 Scope D + FIX-V1 P1-3).
//
// One lightweight mutation bus for successful Mobile-local mutations. Screens
// (Home / Settings / visible Local lists / Library) subscribe and refresh
// bounded data when a relevant domain changes — no polling, no app restart,
// no tab remount.
//
// Contract:
//  - publish(domain) is called ONLY after a Mobile-local mutation API promise
//    resolves successfully (failed mutations must not publish);
//  - listeners receive the domain so a subscriber can react to exactly the
//    mutations it cares about (e.g. Library reloads only on `asset`);
//  - the event carries no private user content — domain + monotonic version
//    is sufficient;
//  - publishing never triggers a Desktop network call or a sync invocation;
//  - subscription cleanup is a plain unsubscribe that is safe under React
//    StrictMode/HMR remounts.

export type LocalDomain = "inbox" | "note" | "asset";

type Listener = (domain: LocalDomain) => void;

class LocalDataStore {
  private version = 0;
  private listeners = new Set<Listener>();

  /** Publish a successful Mobile-local mutation for a domain. */
  publish(domain: LocalDomain): void {
    this.version += 1;
    for (const fn of this.listeners) fn(domain);
  }

  getVersion(): number {
    return this.version;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}

export const localDataStore = new LocalDataStore();

/**
 * Publish `domain` ONLY after `p` resolves successfully. A rejected promise
 * publishes nothing and rethrows, so callers surface the error normally.
 * (FIX-V1 P1-3D: flag toggles / deletes publish only on success.)
 */
export async function publishAfter<T>(domain: LocalDomain, p: Promise<T>): Promise<T> {
  const r = await p;
  localDataStore.publish(domain);
  return r;
}
