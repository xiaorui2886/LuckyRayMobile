// Minimal event-driven data snapshot store (no framework): every commit
// (sync / capture / note update / asset cache update) bumps a version that
// screens subscribe to. No page-level setTimeout polling.

type Listener = () => void;

class DataStore {
  private version = 0;
  private listeners = new Set<Listener>();

  bump(): void {
    this.version += 1;
    for (const fn of this.listeners) fn();
  }

  getVersion(): number {
    return this.version;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const dataStore = new DataStore();
