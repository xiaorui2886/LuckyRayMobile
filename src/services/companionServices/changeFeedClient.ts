// ChangeFeedClient (Issue #77 §3.7 / REPAIR-R2 P1-W2) — durable cursors are truth.
//
// IMPORTANT: `/v1/services/events/stream` is a WEBSOCKET on Desktop `.3`, NOT a
// JSON GET. The previous implementation issued a normal HTTP GET at that route,
// which a real Desktop answers with 400 INPUT_INVALID — the fixture's 426 only
// ever exercised the fallback branch. That HTTP GET is GONE.
//
// Hints now arrive through the Rust-owned pinned subscription
// (`hintSubscription.ts`), which keeps the bearer in Rust and buffers typed
// hints. This client therefore:
//   * never performs a WebSocket or an HTTP GET for hints;
//   * treats hints as WAKE-UP TARGETS only — the durable cursor is never
//     advanced from a hint;
//   * keeps durable catch-up working whether or not the hint worker runs, so an
//     unavailable stream degrades to polling without disabling anything.

import type { DrainedHint, Hint, HintSubscription } from "./hintSubscription.ts";

export type FeedMode = "hints" | "polling";

export class ChangeFeedClient {
  private subscription: HintSubscription | null;
  private mode: FeedMode;
  /** The last permission revision the registry was told about. */
  private permissionRevision = -1;
  /**
   * Local subscription-consumption context (G1-C2).
   *
   * `epoch` is a LOCAL counter that retires every earlier drain: stop, a new
   * start, or an owner change all bump it. `instance` and `generation` record
   * WHICH subscription a record must belong to. These are deliberately not
   * compared against the Desktop gatewayGeneration.
   */
  private epoch = 0;
  /**
   * The bound subscription context. `activeInstance` is empty and
   * `workerGeneration` is null until a successful `start(instance)` binds a real
   * owner + generation that is actually running (G1H).
   *
   * `null` is deliberately NOT `-1`: a sentinel would act as a wildcard that
   * accepts any drained record, which is exactly the unbound-adoption bug.
   */
  private activeInstance = "";
  private workerGeneration: number | null = null;

  /**
   * @param subscription the Rust-owned hint subscription, or null for
   *   polling-only operation (durable catch-up is unaffected either way).
   */
  constructor(subscription: HintSubscription | null = null) {
    this.subscription = subscription;
    // A fresh client is POLLING and UNBOUND: nothing has proved that a live
    // worker owns the instance this client cares about. Entering `hints` here
    // would let a pre-start `readHints()` drain the global native buffer as if
    // the records were ours (G1H H2).
    this.mode = "polling";
  }

  /** Current feed mode: `hints` when the Rust worker is available. */
  currentMode(): FeedMode {
    return this.mode;
  }

  /**
   * Start the hint worker for a Desktop.
   *
   * This NEVER assumes hints are live just because the start call succeeded: the
   * dial happens in a spawned Rust task, so the command returning only means the
   * task was queued (REPAIR-R3 P1-H2). The mode is `hints` only once the worker
   * actually reports `running`; until then — and after any failure — it stays
   * `polling`, which is fully functional because durable cursors are truth.
   */
  async start(instance: string): Promise<void> {
    if (!this.subscription) {
      this.mode = "polling";
      return;
    }
    // A new start retires every earlier subscription context immediately, so a
    // drain that resolves late can no longer be adopted.
    const epoch = ++this.epoch;
    this.activeInstance = "";
    this.workerGeneration = null;
    this.mode = "polling";
    try {
      const outcome = await this.subscription.start(instance);
      const status = await this.subscription.status();
      // A superseded start must not bind anything.
      if (this.epoch !== epoch) return;
      // The native worker is PROCESS-GLOBAL while clients are not, so another
      // client may have switched it to a different Desktop while we awaited.
      // Only a status that explicitly reports OUR instance may be adopted.
      if (status.owner !== instance) {
        // Stay polling and UNBOUND. Deliberately do NOT stop the native worker:
        // it belongs to whoever started it, not to this observing client.
        this.mode = "polling";
        return;
      }
      const generation = typeof status.generation === "number" && status.generation >= 0
        ? status.generation
        : (typeof outcome.generation === "number" && outcome.generation >= 0 ? outcome.generation : null);
      if (generation === null) {
        // No valid generation means there is nothing to bind to.
        this.mode = "polling";
        return;
      }
      this.workerGeneration = generation;
      this.activeInstance = instance;
      this.mode = status.phase === "running" ? "hints" : "polling";
    } catch {
      // The stream is an optimisation, never a hard dependency.
      if (this.epoch === epoch) {
        this.mode = "polling";
        this.activeInstance = "";
        this.workerGeneration = null;
      }
    }
  }

  /** The currently bound worker generation, or null when unbound. */
  boundGeneration(): number | null {
    return this.workerGeneration;
  }

  /** The local subscription epoch (exposed for bounded tests). */
  currentEpoch(): number {
    return this.epoch;
  }

  /**
   * Re-check whether the worker is still live. A dead worker that TS has not
   * noticed yet must not keep the feed claiming `hints`.
   */
  async refreshMode(): Promise<FeedMode> {
    if (!this.subscription) {
      this.mode = "polling";
      return this.mode;
    }
    // Capture the local context so a late status cannot re-enable hints that a
    // stop or a new start already retired (G1H H3).
    const epoch = this.epoch;
    const instance = this.activeInstance;
    const boundGeneration = this.workerGeneration;
    if (!instance || boundGeneration === null) {
      this.mode = "polling";
      return this.mode;
    }
    let status;
    try {
      status = await this.subscription.status();
    } catch {
      if (this.epoch === epoch) this.mode = "polling";
      return this.mode;
    }
    // A stale completion must not change mode OR generation.
    if (this.epoch !== epoch) return this.mode;
    if (this.activeInstance !== instance) return this.mode;
    // The worker must still belong to the instance this client bound to.
    if (status.owner !== instance) {
      this.mode = "polling";
      return this.mode;
    }
    if (status.phase !== "running") {
      this.mode = "polling";
      return this.mode;
    }
    const statusGeneration = typeof status.generation === "number" && status.generation >= 0
      ? status.generation
      : null;
    if (statusGeneration === null) {
      this.mode = "polling";
      return this.mode;
    }
    if (statusGeneration !== boundGeneration) {
      // A same-owner generation change is being adopted: retire any in-flight
      // drain from the OLD generation before switching.
      this.epoch += 1;
      this.workerGeneration = statusGeneration;
    }
    this.mode = "hints";
    return this.mode;
  }

  /**
   * Retire the hint worker (revoke / pairing switch / explicit stop).
   *
   * The bound scope is captured BEFORE the local context is cleared, so the
   * native scoped retirement targets exactly the worker we were bound to. An
   * unbound client never issues an unscoped global retirement (G1H-STOP).
   */
  async stop(): Promise<void> {
    // Retire the local context FIRST: any drain already in flight is now stale
    // even if Rust has not yet cleared its buffer.
    const boundInstance = this.activeInstance;
    const boundGeneration = this.workerGeneration;
    this.epoch += 1;
    this.activeInstance = "";
    this.workerGeneration = null;
    this.mode = "polling";
    // A scoped native stop only when a real binding existed; an unbound or
    // polling client has nothing of ours to retire.
    if (this.subscription && boundInstance && boundGeneration !== null) {
      try {
        await this.subscription.stop({ instance: boundInstance, generation: boundGeneration });
      } catch {
        // Local retirement is already complete; a scoped-stop failure must not
        // resurrect the binding or throw past the caller.
      }
    }
  }

  /**
   * Read pending hints.
   *
   * Returns whatever the Rust worker buffered. In polling mode it returns an
   * empty list — durable catch-up is what actually moves the cursor, so callers
   * keep working with no hints at all.
   */
  async readHints(): Promise<Hint[]> {
    // Unbound (no successful start, a stopped client, or polling) means there is
    // no subscription these records could belong to. Refuse BEFORE draining.
    if (!this.subscription || this.mode !== "hints") return [];
    if (!this.activeInstance || this.workerGeneration === null) return [];
    // Capture the context BEFORE the await so the result can be validated after.
    const epoch = this.epoch;
    const instance = this.activeInstance;
    const generation = this.workerGeneration;
    let records: DrainedHint[];
    try {
      // The expected owner + generation travel WITH the call, so the native
      // side refuses — atomically — if we lost the worker while draining.
      records = await this.subscription.drain({ instance, generation });
    } catch {
      if (this.epoch === epoch) this.mode = "polling";
      return [];
    }
    // Adopt only if NOTHING about the subscription moved while draining. A
    // stop/new-start/owner change retires every earlier drain; Rust clearing its
    // buffer later cannot revoke bytes already copied into this response, so the
    // decision has to be made here.
    if (this.epoch !== epoch) return [];
    if (this.activeInstance !== instance) return [];
    if (this.workerGeneration !== generation) return [];
    const out: Hint[] = [];
    for (const record of records) {
      // EXACT generation only — never a wildcard acceptance of anything drained.
      if (record.generation !== generation) continue;
      out.push(record.hint);
    }
    return out;
  }

  /**
   * Whether a `servicesChanged` hint makes the registry permission truth stale.
   *
   * A hint only ever INVALIDATES; it never becomes the new truth by itself.
   */
  permissionTruthStale(hints: Hint[]): number | null {
    for (const hint of hints) {
      if (hint.kind === "servicesChanged" && hint.permissionRevision !== this.permissionRevision) {
        return hint.permissionRevision;
      }
    }
    return null;
  }

  /**
   * The cursor a catch-up must actually continue from.
   *
   * A hint's cursor is advisory ONLY: the durable cursor wins. This is the one
   * place that decision is made, so no caller can jump the queue.
   */
  resumeCursor(durableCursor: string | null, hint?: Hint): string | null {
    void hint; // deliberately ignored: hints never advance the cursor by themselves
    return durableCursor;
  }
}
