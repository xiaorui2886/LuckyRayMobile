/** Scheduling metadata only: never bodies, grants, tokens, or credentials. */
export interface ManagedSyncTarget { instanceId: string; vaultId: string; localVaultId: string; pendingCount: number }
export interface ScheduleStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
type Position = { authBlocked?: boolean; priorityCursor: string; cursor: string; turn: number; globalUntil: number; slots: Record<string, { until: number; failures: number; blocked?: boolean }> };
const key = (t: ManagedSyncTarget) => JSON.stringify([t.localVaultId, t.vaultId]);
export class ManagedSyncSchedule {
  private positions = new Map<string, Position>();
  private storage?: ScheduleStorage;
  private now: () => number;
  constructor(storage?: ScheduleStorage, now: () => number = Date.now) { this.storage = storage; this.now = now; }
  private state(instance: string): Position {
    let state = this.positions.get(instance);
    if (!state) {
      state = { priorityCursor: "", cursor: "", turn: 0, globalUntil: 0, slots: {} };
      try {
        const saved = JSON.parse(this.storage?.getItem(`luckyray.managed-sync.v1.${encodeURIComponent(instance)}`) || "null");
        if (saved && typeof saved.cursor === "string" && Number.isSafeInteger(saved.turn) && Number.isFinite(saved.globalUntil) && saved.slots && typeof saved.slots === "object") {
          state.authBlocked = saved.authBlocked === true; state.cursor = saved.cursor; state.priorityCursor = typeof saved.priorityCursor === "string" ? saved.priorityCursor : ""; state.turn = saved.turn; state.globalUntil = saved.globalUntil;
          for (const [id, slot] of Object.entries(saved.slots)) {
            const s = slot as { until: number; failures: number; blocked?: boolean };
            if (s && Number.isFinite(s.until) && Number.isSafeInteger(s.failures) && s.failures >= 0) state.slots[id] = s;
          }
        }
      } catch { /* Corrupt/unavailable preferences are not sync authority. */ }
      this.positions.set(instance, state);
    }
    return state;
  }
  private save(instance: string): void {
    try { this.storage?.setItem(`luckyray.managed-sync.v1.${encodeURIComponent(instance)}`, JSON.stringify(this.state(instance))); } catch { /* in-memory fairness remains */ }
  }
  choose(instance: string, targets: ManagedSyncTarget[]): ManagedSyncTarget | undefined {
    const s = this.state(instance), now = this.now();
    if (s.authBlocked || s.globalUntil > now) return;
    const all = targets.filter(t => t.instanceId === instance && t.localVaultId && t.vaultId).sort((a,b) => key(a).localeCompare(key(b)));
    // Prune retired bindings. Enumeration is native authority, persisted state is not.
    const valid = new Set(all.map(key));
    for (const id of Object.keys(s.slots)) if (!valid.has(id)) delete s.slots[id];
    const eligible = all.filter(t => !s.slots[key(t)]?.blocked && (s.slots[key(t)]?.until || 0) <= now);
    // Two priority turns, then one all-vault turn: pull-only vaults cannot starve.
    const pending = eligible.filter(t => t.pendingCount > 0);
    const priority = s.turn % 3 !== 2 && pending.length > 0;
    const pool = priority ? pending : eligible;
    const cursor = priority ? s.priorityCursor : s.cursor;
    const next = pool.find(t => key(t).localeCompare(cursor) > 0) || pool[0];
    if (next) {
      if (priority) s.priorityCursor = key(next); else s.cursor = key(next);
      s.turn = (s.turn + 1) % 3; this.save(instance);
    }
    return next;
  }
  complete(instance: string, target: ManagedSyncTarget, continuation: boolean, busy: boolean, retryAfterMs = 0): void {
    this.state(instance).slots[key(target)] = { until: this.now() + Math.max(Number.isFinite(retryAfterMs) ? retryAfterMs : 0, busy ? 1000 : continuation ? 100 : 5000), failures: 0 };
    this.save(instance);
  }
  fail(instance: string, target: ManagedSyncTarget, error: string): void {
    const s = this.state(instance), failures = Math.min((s.slots[key(target)]?.failures || 0) + 1, 6);
    const delay = Math.max(Math.min(1000 * 2 ** (failures - 1), 30000), Number(/VAULT_MOVE_RETRY_AFTER:(\d+)/.exec(error)?.[1] || 0));
    if (/(?:HTTP[_ :]|status[=: ]+)401\b|AUTH_REVOKED|PAIRING_REQUIRED/.test(error)) s.authBlocked = true;
    s.slots[key(target)] = { until: this.now() + delay, failures, blocked: /(?:HTTP[_ :]|status[=: ]+)(401|403)\b|AUTH_REVOKED|GRANT_REQUIRED|PAIRING_REQUIRED/.test(error) };
    // Native HTTP policy also enforces Retry-After; this prevents other vaults
    // spinning against the same rate-limited connection in the meantime.
    if (/429|RATE_LIMIT|COOLDOWN/.test(error)) s.globalUntil = this.now() + Math.max(30000, Number(/retryAfterMs[=: ]+(\d+)/.exec(error)?.[1] || 0));
    this.save(instance);
  }
  authorizationChanged(instance: string): void {
    const s = this.state(instance);
    s.authBlocked = false;
    for (const slot of Object.values(s.slots)) if (slot.blocked) { slot.blocked = false; slot.until = 0; slot.failures = 0; }
    this.save(instance);
  }
  delay(instance: string, targets: ManagedSyncTarget[]): number | undefined {
    const s = this.state(instance), eligible = targets.filter(t => t.instanceId === instance && !s.slots[key(t)]?.blocked);
    if (s.authBlocked || !eligible.length) return;
    return Math.max(100, s.globalUntil - this.now(), Math.min(...eligible.map(t => (s.slots[key(t)]?.until || 0) - this.now())));
  }
}
