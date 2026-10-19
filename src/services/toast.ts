// Toast store (UI-REFRESH-R1) — the single feedback channel for transient
// confirmations and failures.
//
// Replaces the old pattern of dumping raw results/errors into a monospace
// `.log-box > pre` on the product surface. Pure and dependency-free so the
// queueing/dismissal semantics are unit-testable: a toast always auto-expires,
// duplicates of the same message collapse instead of stacking, and the most
// recent 3 are shown.
//
// Raw developer detail is NOT routed here — it stays in the Settings
// developer/diagnostics section.

export type ToastTone = "neutral" | "success" | "warning" | "danger";

export type Toast = {
  id: number;
  tone: ToastTone;
  message: string;
  /** Optional short action label (e.g. 重试); wired by the caller. */
  actionLabel?: string;
  onAction?: () => void;
};

export const TOAST_TTL_MS = 2600;
export const TOAST_MAX_VISIBLE = 3;

export type ToastInput = {
  tone?: ToastTone;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
};

export class ToastStore {
  private items: Toast[] = [];
  private listeners = new Set<() => void>();
  private nextId = 1;
  private timers = new Map<number, ReturnType<typeof setTimeout>>();

  snapshot(): Toast[] {
    return this.items;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /**
   * Show a toast. Repeating the same message while it is still visible
   * refreshes its timer instead of stacking a duplicate — a burst of the
   * same failure must not cover the screen.
   */
  push(input: ToastInput, ttlMs = TOAST_TTL_MS): number {
    const message = input.message.trim();
    if (!message) return -1;
    const existing = this.items.find((t) => t.message === message && t.tone === (input.tone ?? "neutral"));
    if (existing) {
      this.arm(existing.id, ttlMs);
      return existing.id;
    }
    const toast: Toast = {
      id: this.nextId++,
      tone: input.tone ?? "neutral",
      message,
      actionLabel: input.actionLabel,
      onAction: input.onAction,
    };
    this.items = [...this.items, toast].slice(-TOAST_MAX_VISIBLE);
    this.arm(toast.id, ttlMs);
    this.notify();
    return toast.id;
  }

  dismiss(id: number): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    const next = this.items.filter((t) => t.id !== id);
    if (next.length === this.items.length) return;
    this.items = next;
    this.notify();
  }

  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (!this.items.length) return;
    this.items = [];
    this.notify();
  }

  private arm(id: number, ttlMs: number): void {
    const prior = this.timers.get(id);
    if (prior) clearTimeout(prior);
    this.timers.set(
      id,
      setTimeout(() => this.dismiss(id), ttlMs)
    );
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }
}

export const toastStore = new ToastStore();

/** Convenience wrappers — the tone is the only difference. */
export const toast = {
  info: (message: string, extra?: Omit<ToastInput, "message" | "tone">) =>
    toastStore.push({ message, tone: "neutral", ...extra }),
  success: (message: string, extra?: Omit<ToastInput, "message" | "tone">) =>
    toastStore.push({ message, tone: "success", ...extra }),
  warn: (message: string, extra?: Omit<ToastInput, "message" | "tone">) =>
    toastStore.push({ message, tone: "warning", ...extra }),
  error: (message: string, extra?: Omit<ToastInput, "message" | "tone">) =>
    toastStore.push({ message, tone: "danger", ...extra }),
  dismiss: (id: number) => toastStore.dismiss(id),
  clear: () => toastStore.clear(),
};
