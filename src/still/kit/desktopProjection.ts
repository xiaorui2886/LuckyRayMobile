// KNOWLEDGE-ORGANIZATION-R1 R1.6-B — the TRANSIENT Mobile Desktop-note
// projection.
//
// The user's physical finding: after creating/editing a Desktop note on
// Mobile, returning to the list required a manual Refresh, because the
// canonical retained list has no Mobile-mutation projection. This store is a
// bounded, session/UI-scoped transient overlay (NEVER a business-DB
// authority, never a generic dataStore → full rediscovery):
//
//   - a successful local create stage registers a pending Desktop row keyed
//     by the EXACT instance+vault+noteId — ALL NOTES shows it immediately;
//     DIRECTORY mode shows it only when its parent IS the current directory
//     (no fabricated membership);
//   - successful local edits update the row's title/preview;
//   - on reconciliation (Content V1 ack / server observation), the page runs
//     ONE mutation-specific same-vault fast revalidate (registeredList
//     ONLY), retires the transient only once the canonical row is present
//     (dedupe by exact noteId — no duplicate, no absent-flash gap);
//   - rows never fabricate a canonical remote revision.

export type TransientDesktopRow = {
  instanceId: string;
  vaultId: string;
  noteId: string;
  title: string;
  /** The intended parent directory ("" = ROOT). */
  parent: string;
  /** True while the local pending create has not been acknowledged. */
  pending: boolean;
  /** A safe local preview ("" keeps the truthful fallback). */
  preview: string;
  /**
   * R1.6.2-1/R1.6.3-1: the projection's origin. "create" rows retire once
   * the canonical exact noteId appears — but ONLY when no newer local draft
   * remains dirty; "edit" rows retire only on the ACK TARGET.
   */
  origin: "create" | "edit";
  /**
   * R1.6.3-1: the revision the CURRENT projected draft was acknowledged at
   * (the local serverDocument.revision once the exact draft is clean).
   * Absent while the draft is still dirty/unsynced — no retirement then,
   * and retirement requires the authority revision to EQUAL it (never
   * inequality guessing; the revision is opaque).
   */
  targetRemoteRevision?: string;
  /** R1.6.2-1: the local draft generation the projection reflects. */
  localGeneration?: number;
  /** R1.6.3-4: the create-collision exhausted truth (same-name retries bound). */
  blocked?: boolean;
};

type Listener = () => void;

export class DesktopTransientProjection {
  private readonly byScope = new Map<string, Map<string, TransientDesktopRow>>();
  /** R1.6.1-3: the stable per-scope snapshot cache (Object.is-stable). */
  private readonly snapshotCache = new Map<string, TransientDesktopRow[]>();
  private readonly listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private scopeKey(instanceId: string, vaultId: string): string {
    return `${instanceId}|${vaultId}`;
  }

  /**
   * R1.6.1-3: the STABLE snapshot for the exact scope — the SAME array
   * reference until this scope's rows change (an unrelated scope's mutation
   * never churns it), so useSyncExternalStore never loops.
   */
  rowsFor(instanceId: string, vaultId: string): TransientDesktopRow[] {
    const key = this.scopeKey(instanceId, vaultId);
    const cached = this.snapshotCache.get(key);
    if (cached) return cached;
    const rows = this.byScope.get(key);
    const snapshot = rows ? [...rows.values()] : [];
    this.snapshotCache.set(key, snapshot);
    return snapshot;
  }

  private invalidate(key: string): void {
    this.snapshotCache.delete(key);
  }

  /** Register/update a pending Desktop row after a successful local stage/edit. */
  upsert(row: TransientDesktopRow): void {
    const key = this.scopeKey(row.instanceId, row.vaultId);
    let rows = this.byScope.get(key);
    if (!rows) { rows = new Map(); this.byScope.set(key, rows); }
    rows.set(row.noteId, row);
    this.invalidate(key);
    this.emit();
  }

  /** Patch an existing transient row (edit/rename follow-up). */
  update(instanceId: string, vaultId: string, noteId: string, patch: Partial<Pick<TransientDesktopRow, "title" | "preview" | "pending" | "targetRemoteRevision" | "origin" | "blocked">>): void {
    const key = this.scopeKey(instanceId, vaultId);
    const rows = this.byScope.get(key);
    const row = rows?.get(noteId);
    if (!row || !rows) return;
    rows.set(noteId, { ...row, ...patch });
    this.invalidate(key);
    this.emit();
  }

  /**
   * R1.6.1-1/R1.6.2-1/R1.6.3-1/2: retire the transient ONLY when the CURRENT
   * authority has CONVERGED on the projected draft. origin=create retires on
   * canonical presence — but ONLY when no NEWER local draft remains dirty
   * (a create ack for B while the phone already holds a dirty C keeps the
   * projection; the edit lifecycle with C's target takes over). origin=edit
   * (or any row carrying a target) requires the ACK TARGET: the projected
   * draft must be acknowledged (targetRemoteRevision recorded from the
   * local serverDocument) and the CURRENT authority revision must EQUAL
   * that target — `revision != base` guessing is forbidden (the revision is
   * opaque) — and the authority title must equal the projected title.
   */
  retireIfPresent(
    instanceId: string,
    vaultId: string,
    noteId: string,
    canonical: Map<string, { revision: string; title: string }>,
  ): boolean {
    const key = this.scopeKey(instanceId, vaultId);
    const rows = this.byScope.get(key);
    const row = rows?.get(noteId);
    if (!row || !rows) return false;
    const remote = canonical.get(noteId);
    if (!remote) return false; // not present at all: keep (no gap)
    if (row.origin === "edit" || row.targetRemoteRevision !== undefined) {
      // No target yet (still dirty/unsynced) => never retire; with a target,
      // the authority revision must EQUAL it (never inequality guessing).
      if (row.targetRemoteRevision === undefined) return false;
      if (remote.revision !== row.targetRemoteRevision) return false;
      if (remote.title !== row.title) return false;
    } else if (row.origin === "create" && row.pending) {
      // R1.6.3-2: a create whose ack landed while a NEWER local draft is
      // still dirty keeps its projection (pending stays true until the
      // newest draft is acknowledged — see the ack-target recording).
      return false;
    }
    rows.delete(noteId);
    if (rows.size === 0) this.byScope.delete(key);
    this.invalidate(key);
    this.emit();
    return true;
  }

  /** Direct retirement (e.g. the pending create was deleted locally). */
  retire(instanceId: string, vaultId: string, noteId: string): void {
    const key = this.scopeKey(instanceId, vaultId);
    const rows = this.byScope.get(key);
    if (!rows?.delete(noteId)) return;
    if (rows.size === 0) this.byScope.delete(key);
    this.invalidate(key);
    this.emit();
  }
}
