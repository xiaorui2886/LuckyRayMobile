/** Production cold-row composition. Refresh is readonly; editor epochs are
 * allocated only by the existing synchronous native begin boundary. */
export async function beginDesktopNote<T>(
  effects: { begin(): Promise<T>; refresh(): Promise<unknown> },
  isCurrent: () => boolean,
): Promise<{ cached: T; refreshed: boolean } | null> {
  if (!isCurrent()) return null;
  try {
    const cached = await effects.begin();
    return isCurrent() ? { cached, refreshed: false } : null;
  } catch (error) {
    if (!isCurrent()) return null;
    if (String(error) !== "CONTENT_NOTE_NOT_CACHED") throw error;
  }
  try {
    await effects.refresh();
    // The readonly response may arrive after this page was hidden/retired.
    // Never let that old request allocate an epoch belonging to a new editor.
    if (!isCurrent()) return null;
    const cached = await effects.begin();
    return isCurrent() ? { cached, refreshed: true } : null;
  } catch (error) {
    if (!isCurrent()) return null;
    throw error;
  }
}

/** A retained Still stack page may hide before its cold read completes.
 * Retry only unfinished opens when it becomes current again; an initialized
 * editor is never reopened/reset. Each hidden attempt is permanently retired,
 * even if its response arrives after this same page becomes visible again. */
export class DesktopNoteOpener {
  private current = false;
  private active = false;
  private disposed = false;
  private attempt = 0;
  private readonly open: (isAttemptCurrent: () => boolean) => Promise<void>;
  private readonly initialized: () => boolean;

  constructor(
    open: (isAttemptCurrent: () => boolean) => Promise<void>,
    initialized: () => boolean,
  ) {
    this.open = open;
    this.initialized = initialized;
  }

  setCurrent(current: boolean): void {
    this.current = current;
    if (this.disposed || this.initialized()) return;
    if (!current) {
      this.attempt++;
      this.active = false;
      return;
    }
    if (this.active) return;
    const attempt = ++this.attempt;
    this.active = true;
    const isAttemptCurrent = () => !this.disposed && this.current && attempt === this.attempt;
    // The caller owns error presentation; a retired page must stay inert.
    void this.open(isAttemptCurrent).finally(() => {
      if (attempt === this.attempt) this.active = false;
    }).catch(() => {});
  }

  dispose(): void {
    this.disposed = true;
    this.attempt++;
    this.active = false;
  }
}
