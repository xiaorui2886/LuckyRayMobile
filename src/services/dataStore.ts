// Minimal event-driven data snapshot store (no framework): every commit
// (sync / capture / note update / asset cache update) bumps a version that
// screens subscribe to. Knowledge-only commits may be ignored by material viewers;
// listeners without an argument keep the original behavior. No polling.

export type DataChange = "all" | "knowledge";
type Listener = (kind: DataChange) => void;

class DataStore {
  private version = 0;
  private listeners = new Set<Listener>();

  bump(kind: DataChange = "all"): void {
    this.version += 1;
    for (const fn of this.listeners) fn(kind);
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
