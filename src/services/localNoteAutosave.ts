// Single-flight Local Note Autosave Coordinator with Monotonic Edit Generations & Shared Drain Promise (M2.8 P1-A)
// Ensures:
// 1. Rapid typing increments editGen and never produces overlapping/out-of-order writes.
// 2. At most one IPC/SQLite save is in flight per coordinator.
// 3. All concurrent flush() / trigger calls join a shared active Drain Promise.
// 4. The Drain Promise continues looping until lastSavedGen >= editGen, ensuring edits made
//    while a save is in flight are fully persisted BEFORE any waiting flush() resolves.
// 5. If any required save step in the drain fails, the Drain Promise rejects, allowing navigation (onBack)
//    to catch the error and keep the user in the editor with an error message instead of silently leaving.
// 6. Reset/hydrate baseline allows opening a note without incrementing editGen or triggering fake saves.
// 7. dispose()/resetBase never cancel an already-required final drain (single-flight is preserved).

export interface NoteSnapshot {
  title: string;
  content: string;
  tags: string[];
}

export type SaveStatus = "saved" | "saving" | "unsaved" | "error";

export class LocalNoteAutosaveCoordinator {
  private noteId: string;
  private saveFn: (snapshot: NoteSnapshot) => Promise<void>;
  private debounceMs: number;

  private latestSnapshot: NoteSnapshot;
  private editGen = 0;
  private lastSavedGen = 0;

  /** The single shared drain. Every flush() caller joins this promise; it is null
   *  only when no drain is running. One save IPC at a time is guaranteed because the
   *  drain loops its saves sequentially. */
  private activeDrainPromise: Promise<boolean> | null = null;

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private status: SaveStatus = "saved";
  private lastError = "";

  private statusListeners = new Set<(status: SaveStatus, error?: string) => void>();

  constructor(
    noteId: string,
    initialSnapshot: NoteSnapshot,
    saveFn: (snapshot: NoteSnapshot) => Promise<void>,
    debounceMs = 1000
  ) {
    this.noteId = noteId;
    this.latestSnapshot = { ...initialSnapshot };
    this.saveFn = saveFn;
    this.debounceMs = debounceMs;
  }

  public getNoteId(): string {
    return this.noteId;
  }

  public getStatus(): SaveStatus {
    return this.status;
  }

  public getLastError(): string {
    return this.lastError;
  }

  /** Current committed/base snapshot. Used by the editor to detect hydration echoes
   *  (loading the stored fields) so opening a note without user edits never creates a
   *  fake edit generation (FIX-V2 P1-A hydration correctness). */
  public getLatestSnapshot(): NoteSnapshot {
    return { ...this.latestSnapshot };
  }

  public isDirty(): boolean {
    return this.editGen > this.lastSavedGen;
  }

  public subscribe(listener: (status: SaveStatus, error?: string) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private notify() {
    for (const listener of this.statusListeners) {
      listener(this.status, this.lastError);
    }
  }

  private setStatus(status: SaveStatus, error = "") {
    this.status = status;
    this.lastError = error;
    this.notify();
  }

  /** Called on every user edit. Increments edit generation and schedules debounced save. */
  public updateSnapshot(snapshot: NoteSnapshot): void {
    this.latestSnapshot = { ...snapshot };
    this.editGen += 1;
    this.setStatus("unsaved");

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      // Fire-and-forget debounce drain: joins the shared drain if one is running;
      // a failed save is already reflected in status === "error".
      void this.flush().catch(() => {});
    }, this.debounceMs);
  }

  /**
   * Immediately cancels pending debounce and joins or initiates the active single-flight Drain Promise.
   * Resolves ONLY when lastSavedGen >= editGen (i.e. the newest generation is persisted).
   * Rejects if any required save in the drain fails.
   */
  public flush(): Promise<boolean> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.editGen <= this.lastSavedGen && !this.activeDrainPromise) {
      if (this.status !== "error") {
        this.setStatus("saved");
      }
      return Promise.resolve(true);
    }

    if (!this.activeDrainPromise) {
      this.activeDrainPromise = this.runDrainLoop().finally(() => {
        this.activeDrainPromise = null;
      });
    }

    return this.activeDrainPromise;
  }

  /** The single drain loop: saves sequentially until the newest edit generation is
   *  persisted. Edits arriving while a save is running are picked up by the next
   *  iteration of the SAME drain before it resolves. */
  private async runDrainLoop(): Promise<boolean> {
    while (this.editGen > this.lastSavedGen) {
      const genToSave = this.editGen;
      const snapshotToSave = { ...this.latestSnapshot };

      this.setStatus("saving");

      try {
        await this.saveFn(snapshotToSave);
        // Only advance the saved generation when no resetBase() happened mid-save
        // (resetBase sets editGen to 0, which is always < genToSave). This prevents a
        // stale completion from breaking the editGen/lastSavedGen invariant.
        if (this.editGen >= genToSave) {
          this.lastSavedGen = genToSave;
        }

        if (this.editGen <= this.lastSavedGen) {
          this.setStatus("saved");
        }
      } catch (e: any) {
        const errMsg = e?.message ?? String(e);
        this.setStatus("error", errMsg);
        throw e;
      }
    }

    return true;
  }

  /** Re-initialize baseline after note loading/hydration without incrementing editGen or marking dirty.
   *  NOTE: an already-required final drain is NEVER cancelled here and the shared drain
   *  reference is preserved, so single-flight holds even across a reload. */
  public resetBase(snapshot: NoteSnapshot): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.latestSnapshot = { ...snapshot };
    this.editGen = 0;
    this.lastSavedGen = 0;
    this.setStatus("saved");
  }

  public dispose(): void {
    // Clears the pending debounce timer and listeners only. An already-required final
    // drain keeps running to completion (FIX-V2 P1-A: dispose must not cancel it).
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.statusListeners.clear();
  }
}
