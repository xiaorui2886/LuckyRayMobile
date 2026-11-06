import type { ManagedNote, ManagedVaultCatalog } from "./managedVault";

export interface PreparedManagedNote { note: ManagedNote; vaults: ManagedVaultCatalog }

/** Local file reads only. A link commits its route after its real surface is ready. */
export async function prepareManagedNote(
  source: { localVaultId: string; noteId: string },
  service: { get: (vault: string, note: string) => Promise<ManagedNote>; list: () => Promise<ManagedVaultCatalog> },
): Promise<PreparedManagedNote> {
  let note = await service.get(source.localVaultId, source.noteId);
  if (note.localVaultId !== source.localVaultId || note.noteId !== source.noteId) throw Error("MANAGED_NOTE_SCOPE_MISMATCH");
  const target = (note.remote as { transferredTo?: { localVaultId?: unknown; noteId?: unknown } } | undefined)?.transferredTo;
  if (target) {
    if (typeof target.localVaultId !== "string" || !target.localVaultId || typeof target.noteId !== "string" || !target.noteId
      || (target.localVaultId === source.localVaultId && target.noteId === source.noteId)) throw Error("MANAGED_TRANSFER_TARGET_INVALID");
    note = await service.get(target.localVaultId, target.noteId);
    if (note.localVaultId !== target.localVaultId || note.noteId !== target.noteId
      || (note.remote as { transferredTo?: unknown } | undefined)?.transferredTo) throw Error("MANAGED_TRANSFER_TARGET_INVALID");
  }
  const vaults = await service.list();
  if (!vaults.items.some(vault => vault.localVaultId === note.localVaultId)) throw Error("MANAGED_VAULT_UNAVAILABLE");
  return { note, vaults };
}
