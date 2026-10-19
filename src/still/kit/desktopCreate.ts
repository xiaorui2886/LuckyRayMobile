// KNOWLEDGE-ORGANIZATION-R1 R1.5.1 — the generation-safe Desktop create
// orchestrator.
//
// Creating a note is a Content V1 write: the authority is
// `contentVersion 1 + capabilities.noteWrite === true` over the EXACT
// current Desktop and vault — never the canonical knowledge.move operation
// state. The create scope (exact instance + vault + ROOT/current existing
// directory + connection incarnation + a monotonic generation) is captured
// BEFORE the first await and re-proven after EVERY async boundary, so a
// stale or ABA completion issues ZERO creates.

export type CreateScope = {
  instance: string;
  vault: string;
  /** "" = ROOT; otherwise the CURRENT EXISTING directory. */
  parent: string;
  generation: number;
};

export type CreateCurrentness = {
  instance: () => string;
  vault: () => string;
  parent: () => string;
  generation: () => number;
  connected: () => boolean;
};

export type CreateAuthority = { usable: boolean; reason?: string };

export type CreateResult =
  | { kind: "busy" }
  | { kind: "stale" }
  | { kind: "denied"; reason: string }
  /**
   * R1.5.2: a successful local stage is DURABLE original-scope work — the
   * existing sync authority publishes it either way. "created-current" may
   * navigate the captured route; "created-stale" must not open the old
   * route or show old-scope UI, and must NEVER roll the pending create
   * back.
   */
  | { kind: "created-current"; noteId: string; scope: CreateScope }
  | { kind: "created-stale"; noteId: string; scope: CreateScope };

/**
 * ONE guarded Desktop create. The scope is captured on the FIRST line (no
 * awaits before it); the authority resolution is awaited with the ORIGINAL
 * scope re-proven afterwards; the create itself runs only while that exact
 * incarnation is still current. A stale completion is reported as
 * { kind: "stale" } and the page applies nothing.
 */
// ---------------------------------------------------------------------------
// R1.5.3 — the SYNCHRONOUS duplicate-submit lock. React state cannot guard a
// double invoke (both taps can run before the re-render), so the submit path
// holds a plain synchronous flag acquired BEFORE the first await and released
// on EVERY terminal (denied / stale / busy / created-current / created-stale
// / thrown error).
// ---------------------------------------------------------------------------

let createSubmitLocked = false;

/** True while a Desktop create submit is in flight (synchronous truth). */
export function createSubmitBusy(): boolean {
  return createSubmitLocked;
}

export async function orchestrateDesktopCreate(opts: {
  resolveAuthority: () => Promise<CreateAuthority>;
  create: (scope: CreateScope) => Promise<string>;
  currentness: CreateCurrentness;
}): Promise<CreateResult> {
  // The synchronous lock: a second invoke during the first's async window
  // returns immediately and stages NOTHING.
  if (createSubmitLocked) return { kind: "busy" };
  createSubmitLocked = true;
  try {
    return await orchestrateDesktopCreateInner(opts);
  } finally {
    createSubmitLocked = false;
  }
}

async function orchestrateDesktopCreateInner(opts: {
  resolveAuthority: () => Promise<CreateAuthority>;
  create: (scope: CreateScope) => Promise<string>;
  currentness: CreateCurrentness;
}): Promise<CreateResult> {
  // The route-lifetime token FIRST — before any await.
  const captured: CreateScope = {
    instance: opts.currentness.instance(),
    vault: opts.currentness.vault(),
    parent: opts.currentness.parent(),
    generation: opts.currentness.generation(),
  };
  const stillCurrent = () =>
    opts.currentness.connected()
    && opts.currentness.generation() === captured.generation
    && opts.currentness.instance() === captured.instance
    && opts.currentness.vault() === captured.vault
    && opts.currentness.parent() === captured.parent;

  const authority = await opts.resolveAuthority().catch(() => null);
  // The capability resolve can straddle an owner/vault/directory/connection
  // change — re-prove the ORIGINAL incarnation before anything is created.
  if (!stillCurrent()) return { kind: "stale" };
  if (!authority || !authority.usable) {
    return { kind: "denied", reason: authority?.reason || "CONTENT_UPGRADE_REQUIRED" };
  }
  const noteId = await opts.create(captured).catch(() => null);
  if (!noteId) return { kind: "denied", reason: "新建笔记失败" };
  // R1.5.2: re-prove the captured incarnation AFTER the staging await. The
  // staged create is real durable work regardless; only the VISIBLE
  // navigation/UI depends on currentness.
  if (stillCurrent()) return { kind: "created-current", noteId, scope: captured };
  return { kind: "created-stale", noteId, scope: captured };
}
