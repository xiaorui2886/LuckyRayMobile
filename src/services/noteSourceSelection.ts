/** Session-only selection shared by Notes and Graph. This is not a grant, a
 * sync owner, or a persisted library mutation. Desktop identity is exact. */
export type NoteSourceSelection =
  | { kind: 'managed'; localVaultId: string }
  | { kind: 'legacy' }
  | { kind: 'desktop'; instanceId: string; vaultId: string };
export type NoteSourceSnapshot = { selection: NoteSourceSelection | null; version: number };

export function noteSourceKey(selection: NoteSourceSelection): string {
  if (selection.kind === 'managed') return selection.localVaultId;
  if (selection.kind === 'legacy') return 'legacy-local';
  return `desktop:${encodeURIComponent(selection.instanceId)}:${encodeURIComponent(selection.vaultId)}`;
}

export class NoteSourceSelectionStore {
  private value: NoteSourceSnapshot = { selection: null, version: 0 };
  private listeners = new Set<() => void>();
  snapshot = (): NoteSourceSnapshot => this.value;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  /** Capture snapshot().version BEFORE async work and pass it on completion.
   * A newer choice wins even if the older native/library read finishes later. */
  select(selection: NoteSourceSelection | null, expectedVersion?: number): boolean {
    if (expectedVersion !== undefined && expectedVersion !== this.value.version) return false;
    if (selection?.kind === 'managed' && !selection.localVaultId) return false;
    // Empty owner+vault means an explicit Desktop choice awaiting pairing;
    // empty vault alone awaits a scoped catalog. Neither is a read wildcard.
    if (selection?.kind === 'desktop' && !selection.instanceId && selection.vaultId) return false;
    if (selection === null && this.value.selection === null || selection && this.value.selection
      && selection.kind === this.value.selection.kind && noteSourceKey(selection) === noteSourceKey(this.value.selection)) return true;
    this.value = { selection: selection ? Object.freeze({ ...selection }) : null, version: this.value.version + 1 };
    for (const listener of this.listeners) listener();
    return true;
  }
}

export const noteSourceSelection = new NoteSourceSelectionStore();
