/** Sheet-only visual state, independent of navigation, insets, and keyboard geometry. */
export class SystemBarScrim {
  private owners = new Set<object>();
  private listeners = new Set<() => void>();
  active() { return this.owners.size > 0; }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  acquire() {
    const owner = {}; this.owners.add(owner); this.emit();
    return () => { if (this.owners.delete(owner)) this.emit(); };
  }
  private emit() { for (const listener of this.listeners) listener(); }
}
export const systemBarScrim = new SystemBarScrim();

/** Serialize native requests and collapse superseded appearances, including rapid close/reopen. */
export function systemBarUpdater(send: (dark: boolean, dimmed: boolean) => Promise<unknown>) {
  let next: { dark: boolean; dimmed: boolean } | null = null;
  let running = false, disposed = false;
  async function flush() {
    if (running || disposed) return;
    running = true;
    try {
      while (next && !disposed) {
        const value = next; next = null;
        try { await send(value.dark, value.dimmed); } catch { /* No geometry fallback. */ }
      }
    } finally { running = false; }
  }
  return {
    request(dark: boolean, dimmed: boolean) { if (!disposed) { next = { dark, dimmed }; void flush(); } },
    dispose() { disposed = true; next = null; },
  };
}
