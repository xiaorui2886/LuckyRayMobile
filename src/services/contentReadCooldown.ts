/** Parse only status/code tokens: retry delay digits must never become a denial. */
export function isContentReadDenied(error: unknown): boolean {
  return /CONTENT_HTTP_(?:401|403|404|410)\b|\bhttp\s+(?:401|403|404|410)\b|FORBIDDEN|REVOKED|NOT_FOUND|SOURCE_CHANGED/.test(String(error));
}

/** Only the native transport verdicts can be retried on a new foreground or
 * reconnect. A source/permission change, rate limit or unknown HTTP failure
 * still needs its existing explicit/budgeted recovery path. */
export function isContentReadTransportFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /^(?:Error:\s*)?CONTENT_(?:OFFLINE|TIMEOUT)$/.test(message.trim());
}

/** Rate-limit scheduling only. Never a permission/protocol proof or content cache. */
export function rateLimitDelay(error: unknown): number | null {
  const message = String(error);
  if (!/CONTENT_HTTP_429\b|\bhttp 429\b|\bRATE_LIMITED\b/.test(message)) return null;
  const hint = /(?:^|\s)retryAfterMs=(\d+)(?=\s|$)/.exec(message);
  // Missing/malformed hints get a short local backoff, not a guessed server window.
  if (!hint) return 3000;
  const value = Number(hint[1]);
  // Never shorten an explicitly huge positive server window or overflow timers.
  return Number.isSafeInteger(value) ? value : Number.MAX_SAFE_INTEGER;
}

export class ContentReadCooldown {
  private deadlines = new Map<string, number>();
  private recoveryAttempts = new Map<string, number>();
  /** Shared across route replacements: A → B → C is not a new retry budget. */
  claimRecovery(key: string): boolean {
    const attempts = this.recoveryAttempts.get(key) || 0;
    if (attempts >= 3 || this.remaining(key) > 0) return false;
    this.recoveryAttempts.set(key, attempts + 1);
    return true;
  }
  recoveryAvailable(key: string): boolean { return (this.recoveryAttempts.get(key) || 0) < 3; }
  recovered(key: string): void { this.recoveryAttempts.delete(key); }
  private now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }
  key(owner: string, library?: string): string { return JSON.stringify([owner, library ?? null]); }
  remaining(key: string): number {
    const now = this.now();
    for (const [scope, deadline] of this.deadlines) if (deadline <= now) this.deadlines.delete(scope);
    const remaining = Math.max(0, (this.deadlines.get(key) || 0) - now);
    if (!remaining) this.deadlines.delete(key);
    return remaining;
  }
  observe(key: string, error: unknown): number {
    const delay = rateLimitDelay(error);
    if (delay === null) return 0;
    const deadline = Math.min(Number.MAX_SAFE_INTEGER, this.now() + delay);
    this.deadlines.set(key, Math.max(this.deadlines.get(key) || 0, deadline));
    return this.remaining(key);
  }
}
export const contentReadCooldown = new ContentReadCooldown();
// One UI wakeup, never a polling loop. Oversized server windows require manual
// intervention; do not overflow browser timers or repeatedly wake for years.
export const cooldownWakeDelay = (remaining: number): number | null => remaining > 2_147_483_647 ? null : remaining;
