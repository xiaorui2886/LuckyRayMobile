// KNOWLEDGE-ORGANIZATION-R1 (ORG-1B) — the note-move authority.
//
// Canonical `knowledge.move` changes the PARENT DIRECTORY only. The DTO is
// exactly { opId, vaultId, expectedRevision, parentRelativePath } — no title
// (rename stays on the Content V1 editor authority). One secure opId per note
// (secureUuidV4 ONLY: randomUUID, else getRandomValues — REPAIR-R1.1 deleted
// the Math.random fallback; with no secure randomness the move FAILS CLOSED
// with zero requests); each note carries its OWN expectedRevision; execution
// is sequential/bounded (never an unbounded parallel blast); partial success
// is first-class (one failure never pretends earlier commits rolled back);
// owner/vault/offline transitions stop the remaining unsent operations; a
// receipt from A can never be applied under B.
//
// A COMMITTED move is applied to the Mobile-local cache projection through
// the metadata-only receipt command: the path metadata moves, the file
// basename is preserved, the remote revision is recorded as the latest server
// observation WITHOUT claiming the cached body bytes are that revision, and a
// committed move is never reported as a fake local failure. NO per-note
// remote detail fetch follows the batch (zero N+1).
//
// REVISION SPLIT (REPAIR-R1.1 P1-6): `expectedRevision` is the LATEST REMOTE
// revision for the note — for DIRECTORY rows that is the serverDocument
// observation (`remoteRevision`), NOT the cached-body baseline `revision`;
// for canonical ALL-NOTES rows it is the canonical summary revision. Rows
// whose remote revision is unproven, or that carry a local dirty/pending/
// conflict write, are BLOCKED from moving by the target builders below.

import { secureUuidV4, SecureUuidUnavailableError } from "../../services/secureUuid.ts";
import type { ServiceRegistry } from "../../services/companionServices/serviceRegistry.ts";
import type { KnowledgeClient } from "../../services/companionServices/knowledgeClient.ts";
import type { OperationState } from "../../../shared/companion-services-v1/types.ts";
import type { DirectoryRow } from "./knowledgeDirectoryController.ts";
import type { KnowledgeBrowseRow } from "./knowledgeBrowseController.ts";

export type MoveTarget = {
  instanceId: string;
  vaultId: string;
  noteId: string;
  /** The LATEST REMOTE revision (never the cached-body baseline). */
  expectedRevision: string;
  /** The row's current parent (a same-parent move is a no-op client-side). */
  currentParent: string;
};

export type MoveOutcome =
  | { kind: "noop"; noteId: string }
  | { kind: "moved"; noteId: string; revision: string; parentRelativePath: string };

export type BatchReport = {
  succeeded: number;
  noop: number;
  failed: number;
  failures: Array<{ noteId: string; reason: string }>;
  /** True when the run stopped early (owner/vault/offline transition). */
  stopped: boolean;
};

export type MoveDeps = {
  /** The canonical knowledge.move client call (owner-fenced by transport). */
  move: (instanceId: string, noteId: string, input: {
    opId: string; vaultId: string; expectedRevision: string; parentRelativePath: string;
  }) => Promise<{ opId: string; vaultId: string; noteId: string; revision: string; parentRelativePath: string }>;
  /** The Mobile-local metadata receipt application. */
  applyReceipt: (instanceId: string, vaultId: string, noteId: string, revision: string, parentRelativePath: string) => Promise<void>;
  /** Liveness fence owned by the page. */
  isLive: () => boolean;
  /**
   * REPAIR-R1.1: the page's visible-projection hook for a COMMITTED move,
   * invoked only AFTER the Mobile-local receipt attempt settles. Carries the
   * ORIGINAL scope (instanceId + vaultId) so the receiving controllers can
   * fail closed against their CURRENT owner — a late A receipt can converge
   * A's cache but must be a NO-OP for B's visible projection. A throw here is
   * swallowed — a committed Desktop move is never a fake local failure.
   */
  onCommitted?: (committed: MoveCommitted) => void;
};

/** The committed-move facts handed to the visible-projection hook. */
export type MoveCommitted = {
  /** The Desktop the move was issued against (the ORIGINAL scope). */
  instanceId: string;
  vaultId: string;
  noteId: string;
  revision: string;
  parentRelativePath: string;
};

/** Truthful copy when currentness was lost before the send (nothing sent). */
export const SCOPE_CHANGED_BEFORE_SEND = "电脑或所选范围已变化，已取消移动";

// ---------------------------------------------------------------------------
// REPAIR-R1.3 (P1-3) — the list move orchestrator. The selection scope is
// re-proven after EVERY await that can straddle a scope change (the local
// facts read inside buildTargets, then the remote move run). A stale
// completion is reported as { kind: "stale" } and the page applies NO UI
// state for the old scope — no outcome block, no success/partial toast, no
// selection restore. Committed remote results stay real and the
// ORIGINAL-scope DB receipts stay durable either way.
// ---------------------------------------------------------------------------

export type ListMoveResult =
  | { kind: "stale" }
  | { kind: "no-targets"; blocked: BlockedNote[]; titleByNoteId: Record<string, string> }
  | { kind: "done"; report: BatchReport; blocked: BlockedNote[]; titleByNoteId: Record<string, string> };

// ---------------------------------------------------------------------------
// REPAIR-R1.4 — the ABA-safe list currentness. A semantic scope STRING alone
// cannot distinguish incarnations: S1 → S2 → S1 (or connected true → false →
// true) restores the same string and would resurrect a stale run. Every run
// therefore captures BOTH the semantic key AND a MONOTONIC generation token
// (a plain incrementing counter — deterministic, never a timestamp or
// random), and is current only while the SAME generation is still live.
// The page bumps the generation on every retirement event: instance/vault/
// query/directory/source change, connection truth transition, and explicit
// selection retirement/cancel.
// ---------------------------------------------------------------------------

export type CapturedListScope = { scope: string; generation: number };

export type ListCurrentness = {
  /** Captured ONCE at run start (semantic key + generation token). */
  capture(): CapturedListScope;
  /**
   * True only while the SAME incarnation is still current: the generation is
   * unchanged AND the semantic scope still matches AND the connection truth
   * is live. (The page layers the Desktop-page lifetime on top.)
   */
  isCurrent(captured: CapturedListScope): boolean;
};

export function createListCurrentness(read: {
  scope: () => string;
  generation: () => number;
  connected: () => boolean;
}): ListCurrentness {
  return {
    capture: () => ({ scope: read.scope(), generation: read.generation() }),
    isCurrent: (c) => read.generation() === c.generation && read.scope() === c.scope && read.connected(),
  };
}

export async function orchestrateListMove(opts: {
  org: KnowledgeOrganizationController;
  deps: MoveDeps;
  destination: string;
  /** The exact selection-scope currentness (scope ref + connection). */
  isScopeCurrent: () => boolean;
  /** The page's target builder (includes the bounded local facts read). */
  buildTargets: () => Promise<{ targets: MoveTarget[]; blocked: BlockedNote[]; titleByNoteId: Record<string, string> }>;
}): Promise<ListMoveResult> {
  const built = await opts.buildTargets();
  // The facts read (or any await inside the builder) can straddle a scope
  // change — re-prove before ANY blocked-only UI is derived.
  if (!opts.isScopeCurrent()) return { kind: "stale" };
  if (built.targets.length === 0) {
    return { kind: "no-targets", blocked: built.blocked, titleByNoteId: built.titleByNoteId };
  }
  let report: BatchReport;
  if (built.targets.length === 1) {
    // One selected note: the SAME single-move flow as the detail page.
    const r = await opts.org.moveOne(opts.deps, built.targets[0], opts.destination);
    report = r.ok && r.outcome
      ? {
          succeeded: r.outcome.kind === "moved" ? 1 : 0,
          noop: r.outcome.kind === "noop" ? 1 : 0,
          failed: 0, failures: [], stopped: false,
        }
      : {
          succeeded: 0, noop: 0, failed: 1,
          failures: [{ noteId: built.targets[0].noteId, reason: r.reason ?? "移动失败" }],
          stopped: false,
        };
  } else {
    report = await opts.org.moveBatch(opts.deps, built.targets, opts.destination);
  }
  // The remote move(s) can straddle a scope change — re-prove before the
  // page applies ANY outcome/selection/toast. Committed remote results stay
  // real; the original-scope DB receipts already landed inside the run.
  if (!opts.isScopeCurrent()) return { kind: "stale" };
  return { kind: "done", report, blocked: built.blocked, titleByNoteId: built.titleByNoteId };
}

/** Truthful copy when no secure randomness exists (fail closed, zero moves). */
export const SECURE_RANDOM_UNAVAILABLE = "本机缺少安全随机源，已取消移动";

export class KnowledgeOrganizationController {
  private token = 0;
  private busy = false;

  isBusy(): boolean {
    return this.busy;
  }

  /**
   * ONE move: noop for the current parent; secure opId; on commit, the local
   * metadata receipt is AWAITED (best-effort — its failure is not a move
   * failure) and only then the visible-projection hook runs. A failure is
   * reported with its reason; the cache is NOT mutated for a failure (a 409
   * leaves the projection alone).
   *
   * REPAIR-R1.2 (P1-1): currentness is proven BEFORE the opId is minted —
   * when the page's liveness fence is already false, ZERO requests are sent.
   */
  async moveOne(
    deps: MoveDeps,
    target: MoveTarget,
    destination: string,
  ): Promise<{ ok: boolean; outcome?: MoveOutcome; reason?: string }> {
    if (destination === target.currentParent) {
      return { ok: true, outcome: { kind: "noop", noteId: target.noteId } };
    }
    if (!deps.isLive()) {
      // Nothing has been sent: this cancels UNSENT work after currentness
      // was lost — it never fabricates a failure for a committed request.
      return { ok: false, reason: SCOPE_CHANGED_BEFORE_SEND };
    }
    let opId: string;
    try {
      opId = secureUuidV4();
    } catch (error: unknown) {
      if (error instanceof SecureUuidUnavailableError) {
        // FAIL CLOSED: no secure randomness means NO move request at all —
        // never a Math.random / timestamp / counter opId.
        return { ok: false, reason: SECURE_RANDOM_UNAVAILABLE };
      }
      throw error;
    }
    const input = {
      opId,
      vaultId: target.vaultId,
      expectedRevision: target.expectedRevision,
      parentRelativePath: destination,
    };
    try {
      const receipt = await deps.move(target.instanceId, target.noteId, input);
      return { ok: true, outcome: await this.applied(deps, target, receipt) };
    } catch (error: unknown) {
      return { ok: false, reason: moveFailureReason(error) };
    }
  }

  /**
   * The bounded batch: sequential moves, one opId/revision per note. Partial
   * success is the truth — committed successes stay committed. An owner/
   * vault/offline transition (detected via the fence or a fail-closed error)
   * stops the remaining UNSSENT operations.
   */
  async moveBatch(
    deps: MoveDeps,
    targets: MoveTarget[],
    destination: string,
    onProgress?: (report: BatchReport) => void,
  ): Promise<BatchReport> {
    const report: BatchReport = { succeeded: 0, noop: 0, failed: 0, failures: [], stopped: false };
    if (this.busy) return report;
    this.busy = true;
    this.token += 1;
    const token = this.token;
    try {
      for (const target of targets) {
        if (token !== this.token || !deps.isLive()) {
          report.stopped = true;
          break;
        }
        const r = await this.moveOne(deps, target, destination);
        if (r.ok && r.outcome) {
          if (r.outcome.kind === "noop") report.noop += 1;
          else report.succeeded += 1;
        } else {
          report.failed += 1;
          report.failures.push({ noteId: target.noteId, reason: r.reason ?? "未知失败" });
          if (r.reason === SECURE_RANDOM_UNAVAILABLE) {
            // A missing secure random source is fatal for EVERY remaining
            // opId — stop the batch truthfully instead of re-failing per note.
            report.stopped = true;
            break;
          }
          if (isFailClosedStop(r.reason ?? "")) {
            report.stopped = true;
            break;
          }
        }
        onProgress?.({ ...report, failures: [...report.failures] });
      }
    } finally {
      if (token === this.token) this.busy = false;
    }
    return report;
  }

  /** Cancel: in-flight note result is discarded, unsent ones never start. */
  cancel(): void {
    this.token += 1;
    this.busy = false;
  }

  private async applied(deps: MoveDeps, target: MoveTarget, receipt: {
    revision: string; parentRelativePath: string;
  }): Promise<MoveOutcome> {
    // REPAIR-R1.2 (P1-6): the Mobile-local receipt is AWAITED (durable
    // original-scope convergence) BEFORE any visible projection or detail
    // reread runs — the detail's immediate local reread can no longer win
    // the race against the receipt command. A local convergence failure is
    // still NOT a move failure (the Desktop commit stands; the next sync
    // converges the cache).
    try {
      await deps.applyReceipt(target.instanceId, target.vaultId, target.noteId, receipt.revision, receipt.parentRelativePath);
    } catch { /* best-effort local convergence */ }
    // REPAIR-R1.3 (P1-2): the CURRENT-visible projection hook runs ONLY if
    // the ORIGINAL scope is STILL live after the receipt settled — owner+
    // vault alone is not the full list identity (query/directory may have
    // changed on the same instance+vault), and a dead route must not mutate
    // whatever is on screen now. The durable receipt above is unconditional;
    // the controller-side instance/vault guards remain as defense-in-depth.
    if (deps.isLive()) {
      try {
        deps.onCommitted?.({
          instanceId: target.instanceId,
          vaultId: target.vaultId,
          noteId: target.noteId,
          revision: receipt.revision,
          parentRelativePath: receipt.parentRelativePath,
        });
      } catch { /* a projection refresh failure never fakes a local failure */ }
    }
    return { kind: "moved", noteId: target.noteId, revision: receipt.revision, parentRelativePath: receipt.parentRelativePath };
  }
}

function moveFailureReason(error: unknown): string {
  const raw = String((error as any)?.message ?? error);
  if (raw.includes("409") || raw.includes("REVISION_CONFLICT") || raw.includes("revision-conflict")) return "笔记已在电脑上被修改（版本冲突）";
  if (raw.includes("CONTENT_SOURCE_CHANGED") || raw.includes("GRANT_REQUIRED") || raw.includes("AUTH_REVOKED")) return "电脑或授权已变化，操作被拒绝";
  if (raw.includes("CONTENT_OFFLINE") || raw.includes("NETWORK") || raw.includes("timeout")) return "电脑暂未连接";
  if (raw.includes("knowledge-not-found")) return "笔记在电脑上已不存在";
  return raw.slice(0, 60) || "移动失败";
}

function isFailClosedStop(reason: string): boolean {
  return reason.includes("授权") || reason.includes("暂未连接") || reason.includes("已变化");
}

// ---------------------------------------------------------------------------
// REPAIR-R1.1 — move TARGET builders. The revision facts are separated where
// the row authorities differ, and fail-closed per note (an unmovable note is
// REPORTED, never silently skipped or moved with a wrong baseline).
// ---------------------------------------------------------------------------

export type BlockedNote = { noteId: string; reason: string; /** REPAIR-R1.2 (P2-1): the recognizable title when known. */ title?: string };

/**
 * REPAIR-R1.2 (P1-5): the Mobile-local move-safety fact for ONE selected
 * note, read through the bounded local `content_note_move_facts` command at
 * SUBMIT time — never inferred from the preview retainer's first-100 subset.
 */
export type MoveFact = {
  /** Mobile holds an unsynced local write. */
  dirty: boolean;
  /** A pending (unsynced) Content V1 operation exists. */
  pending: boolean;
  /** An unresolved conflict document exists. */
  conflict: boolean;
};

/** The parent directory of a vault-relative path ("" = ROOT). */
export function parentOf(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/");
  const i = normalized.lastIndexOf("/");
  return i >= 0 ? normalized.slice(0, i) : "";
}

/**
 * DIRECTORY rows (legacy Content V1): `revision` stays the cached-BODY
 * baseline; the move's expectedRevision is `remoteRevision` (the
 * serverDocument observation). Dirty/pending/conflict/unproven notes are
 * blocked with truthful copy.
 */
export function directoryMoveTargets(
  instanceId: string,
  rows: DirectoryRow[],
): { targets: MoveTarget[]; blocked: BlockedNote[]; titleByNoteId: Record<string, string> } {
  const targets: MoveTarget[] = [];
  const blocked: BlockedNote[] = [];
  const titleByNoteId: Record<string, string> = {};
  for (const row of rows) {
    titleByNoteId[row.noteId] = row.title;
    if (row.conflict) { blocked.push({ noteId: row.noteId, reason: "请先处理这篇笔记的冲突", title: row.title }); continue; }
    if (row.dirty) { blocked.push({ noteId: row.noteId, reason: "先等待同步完成后再移动", title: row.title }); continue; }
    if (!row.remoteRevision) { blocked.push({ noteId: row.noteId, reason: "无法确认这篇笔记的最新版本", title: row.title }); continue; }
    targets.push({
      instanceId,
      vaultId: row.vaultId,
      noteId: row.noteId,
      expectedRevision: row.remoteRevision,
      currentParent: parentOf(row.relativePath),
    });
  }
  return { targets, blocked, titleByNoteId };
}

/**
 * Canonical ALL-NOTES rows: the canonical summary `revision` IS the latest
 * remote revision (the move baseline). Local unsynced writes are proven
 * through the SUBMIT-TIME `facts` read (REPAIR-R1.2 P1-5):
 *   - `facts === null`  → the local read failed → EVERY note blocked (the
 *     safety of none of them is proven — fail closed, never "assume clean");
 *   - an ABSENT fact    → Mobile has no cache row for the note → there is no
 *     possible unsynced local write → clean (the explicit safe rule);
 *   - a fact with dirty/pending/conflict → blocked.
 */
export function canonicalMoveTargets(
  instanceId: string,
  rows: KnowledgeBrowseRow[],
  facts: Record<string, MoveFact> | null = {},
): { targets: MoveTarget[]; blocked: BlockedNote[]; titleByNoteId: Record<string, string> } {
  const targets: MoveTarget[] = [];
  const blocked: BlockedNote[] = [];
  const titleByNoteId: Record<string, string> = {};
  for (const row of rows) {
    titleByNoteId[row.noteId] = row.title;
    if (facts === null) {
      blocked.push({ noteId: row.noteId, reason: "无法确认这篇笔记的本地同步状态", title: row.title });
      continue;
    }
    const fact = facts[row.noteId];
    if (fact) {
      if (fact.conflict) { blocked.push({ noteId: row.noteId, reason: "请先处理这篇笔记的冲突", title: row.title }); continue; }
      if (fact.dirty || fact.pending) { blocked.push({ noteId: row.noteId, reason: "先等待同步完成后再移动", title: row.title }); continue; }
    }
    if (!row.revision) { blocked.push({ noteId: row.noteId, reason: "无法确认这篇笔记的最新版本", title: row.title }); continue; }
    targets.push({
      instanceId,
      vaultId: row.vaultId,
      noteId: row.noteId,
      expectedRevision: row.revision,
      currentParent: row.parentRelativePath || "",
    });
  }
  return { targets, blocked, titleByNoteId };
}

// ---------------------------------------------------------------------------
// REPAIR-R1.1 (P1-8) — the real capability/grant truth for move.
// ---------------------------------------------------------------------------

export type MoveAuthority = {
  vaultId: string;
  vaultName: string;
  /** Only true when the ACTIVE vault's canonical grant says so. */
  writeGranted: boolean;
  /** The canonical operation state (missing op = unsupported = fail closed). */
  moveState: OperationState;
};

/** Fail-closed default: nothing is movable until proven otherwise. */
export const NO_MOVE_AUTHORITY: MoveAuthority = {
  vaultId: "", vaultName: "", writeGranted: false, moveState: "unsupported",
};

/**
 * Resolve the move authority through the SAME ServiceRegistry/KnowledgeClient
 * the session already injected (one transport stack, one catalog): adopt the
 * catalog, require `knowledge.move` implemented, then read the ACTIVE vault's
 * write grant. Any miss fails closed.
 */
export async function resolveMoveAuthority(deps: {
  registry: ServiceRegistry;
  knowledge: KnowledgeClient;
}, instanceId: string): Promise<MoveAuthority> {
  if (!instanceId) return NO_MOVE_AUTHORITY;
  try {
    const catalog = await deps.registry.refreshAdopting(instanceId);
    void catalog;
    const moveState = deps.registry.operation("knowledge.move").state;
    if (moveState !== "implemented") {
      return { ...NO_MOVE_AUTHORITY, moveState };
    }
    const page = await deps.knowledge.vaults(instanceId);
    const active = (page?.items ?? []).find((v) => v.activeInDesktop) ?? null;
    if (!active) return { ...NO_MOVE_AUTHORITY, moveState };
    return {
      vaultId: active.vaultId,
      vaultName: active.displayName || "LuckyRay 知识库",
      writeGranted: active.writeGranted === true,
      moveState,
    };
  } catch {
    return NO_MOVE_AUTHORITY;
  }
}
