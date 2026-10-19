// Advisory lifecycle only. Effects are supplied by the one existing Services
// client; this owns no transport, draft, durable cursor or retry queue.
import { ServicesError } from "./companionServices/transport.ts";
export type EditingScope = { instance: string; vault: string; note: string };
export type EditingHint = "disabled" | "waiting" | "sent" | "unavailable";
export function editingHintLabel(hint: EditingHint): string {
  return {disabled: "未启用", waiting: "等待提示", sent: "编辑提示已发送", unavailable: "提示暂不可用"}[hint];
}
export type EditingEffects = {
  /** Returns only the opaque token; the Services adapter validates its receipt. */
  open(scope: EditingScope): Promise<string>;
  readDesktop(scope: EditingScope): Promise<boolean>;
  /** true means the adapter validated an exact current-generation/state receipt.
   * Older void adapters remain usable but cannot claim a successfully sent hint. */
  publish(scope: EditingScope, session: string, generation: number, editing: boolean): Promise<boolean | void>;
  observe(scope: EditingScope, desktopEditing: boolean): void;
};

// Boundary adapters may refuse synchronously before a Promise is created.
function attempt<T>(effect: () => Promise<T>): Promise<T> {
  try { return effect(); } catch (error) { return Promise.reject(error); }
}

export class KnowledgeEditingSession {
  private effects: EditingEffects;
  private scope: EditingScope;
  private session: string | null = null;
  private opening: Promise<void> | null = null;
  private openBlocked = false;
  private generation = 0;
  private leaseEpoch = 0;
  private retired = false;
  private visible: boolean;
  private wanted = false;
  private announced = false;
  private readToken = 0;
  private reading = false;
  private renew: ReturnType<typeof setInterval>;
  private commitTimer: ReturnType<typeof setTimeout> | null = null;
  private observeHint?: (scope: EditingScope, hint: EditingHint) => void;

  constructor(scope: EditingScope, effects: EditingEffects, visible = true, observeHint?: (scope: EditingScope, hint: EditingHint) => void) {
    this.scope = { ...scope };
    this.effects = effects;
    this.visible = visible;
    this.observeHint = observeHint;
    this.setHint(visible ? "waiting" : "disabled");
    this.renew = setInterval(() => {
      if (this.retired || !this.visible) return;
      if (this.wanted) {
        this.openBlocked = false;
        this.send(true);
      }
      void this.read();
    }, 5000);
    if (visible) void this.read();
  }

  private setHint(hint: EditingHint): void {
    this.observeHint?.(this.scope, hint);
  }

  // Called ONLY after a successful current-owner local durable save.
  committed(): void {
    if (this.retired) return;
    this.wanted = true;
    this.cancelCommit();
    if (this.visible) this.commitTimer = setTimeout(() => {
      this.commitTimer = null;
      if (!this.retired && this.visible && this.wanted) this.send(true);
    }, 400);
  }

  setVisible(visible: boolean): void {
    if (this.retired || visible === this.visible) return;
    this.visible = visible;
    ++this.leaseEpoch;
    this.setHint(visible ? "waiting" : "disabled");
    this.cancelCommit();
    ++this.readToken;
    // A hidden read can finish later, but cannot paint or prevent a fresh read.
    this.reading = false;
    if (!visible) {
      if (this.announced) this.send(false);
    } else {
      if (this.wanted) this.send(true);
      void this.read();
    }
  }

  retire(): void {
    if (this.retired) return;
    this.cancelCommit();
    clearInterval(this.renew);
    ++this.readToken;
    ++this.leaseEpoch;
    this.setHint("disabled");
    if (this.announced) this.send(false);
    this.retired = true;
  }

  private cancelCommit(): void {
    if (this.commitTimer) clearTimeout(this.commitTimer);
    this.commitTimer = null;
  }

  private send(editing: boolean): void {
    if (!editing) this.setHint("disabled");
    if (!this.session) {
      if (editing && !this.opening && !this.openBlocked) {
        this.setHint("waiting");
        const epoch = this.leaseEpoch;
        const request = attempt(() => this.effects.open(this.scope)).then(session => {
          // A stale reservation stays inert and expires on the server.
          if (this.retired || !this.visible || epoch !== this.leaseEpoch) return;
          this.session = session;
          this.generation = 0;
          this.send(true);
        }).catch(() => {
          if (!this.retired && this.visible && epoch === this.leaseEpoch) {
            this.openBlocked = true; this.setHint("unavailable");
          }
        }).finally(() => {
          if (this.opening === request) this.opening = null;
        });
        this.opening = request;
      }
      return;
    }
    if (editing) this.setHint("waiting");
    this.announced = editing;
    // Even overlapping/delayed sends carry strictly increasing generation.
    // A failed release is bounded by the server lease, not a local retry loop.
    const generation = ++this.generation;
    const session = this.session;
    const epoch = this.leaseEpoch;
    const current = () => !this.retired && this.visible && epoch === this.leaseEpoch
      && this.session === session && this.generation === generation;
    void attempt(() => this.effects.publish(this.scope, session, generation, editing)).then(accepted => {
      if (editing && current()) this.setHint(accepted === true ? "sent" : "unavailable");
    }).catch(error => {
      if (editing && current()) this.setHint("unavailable");
      if (editing && this.session === session && error instanceof ServicesError
        && error.status === 410 && error.code === "CURSOR_TOO_OLD") {
        this.session = null;
        this.announced = false;
        this.openBlocked = true; // retry only from the existing 5s cadence
      }
    });
    if (!editing) this.session = null;
  }

  private async read(): Promise<void> {
    if (this.retired || !this.visible || this.reading) return;
    this.reading = true;
    const token = ++this.readToken;
    try {
      const editing = await this.effects.readDesktop(this.scope);
      if (!this.retired && this.visible && token === this.readToken) this.effects.observe(this.scope, editing);
    } catch {
      // Lost/unavailable advice must not remain sticky as a fabricated lock.
      if (!this.retired && this.visible && token === this.readToken) this.effects.observe(this.scope, false);
    } finally {
      if (token === this.readToken) this.reading = false;
    }
  }
}
