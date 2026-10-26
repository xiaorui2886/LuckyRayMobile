import type { ManagedWikiParseInput, ManagedWikiProof } from "../still/kit/managedWikiProof";
import { invoke } from "@tauri-apps/api/core";
import { secureUuidV4 } from "./secureUuid.ts";

/** Managed local files are authoritative. Binding grants no new network authority. */
export interface VaultBinding { instanceId: string; remoteVaultId: string }
export interface ManagedVault {
  localVaultId: string;
  name: string;
  binding: VaultBinding | null;
  migrationState: "ready" | "not-migrated";
  noteCount: number;
  transferState?: "pending" | "completed";
  transferTargetVaultId?: string;
}
export interface ManagedNote {
  localVaultId: string;
  noteId: string;
  title: string;
  relativePath: string;
  folder: string;
  revision: string;
  bodyState: "ready" | "missing" | "conflict";
  content?: string;
  tags: string[];
  pinned: boolean;
  favorite: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  historicalNames: string[];
  syncState: "local" | "pending" | "synced" | "incomplete" | "conflict";
  legacyRoute?: string;
  /** Native provenance/resource metadata; consumers must validate before use. */
  remote?: unknown;
}
export interface ManagedNoteQuery {
  localVaultId: string;
  q?: string;
  folder?: string;
  tag?: string;
  pinned?: boolean;
  favorite?: boolean;
  archived?: boolean;
  sort?: "recent" | "name";
  page?: number;
  limit?: number;
}
export interface ManagedMigrationStatus {
  state: "not-migrated" | "prepared" | "ready";
  localVaultId: string;
  noteCount: number;
  planId?: string;
  warnings: string[];
}
export interface ManagedTransferPreview {
  snapshotHash: string;
  noteCount: number;
  blockedCount: number;
  incompleteCount?: number;
  canCommit: boolean;
  requiresConnection?: boolean;
  parseInputs?: ManagedWikiParseInput[];
}
export type ManagedVaultMutation = {
  kind: "create" | "save" | "move" | "trash" | "flags" | "folder" | "import";
  localVaultId: string;
  noteId?: string;
  instanceId: string | null;
  vaultId: string | null;
};
const bindings = new Map<string, VaultBinding>();
const mutationListeners = new Set<(event: ManagedVaultMutation) => void>();
/** Notification only: this module never starts a network sync. Failed native writes emit nothing. */
export function subscribeManagedVaultMutations(listener: (event: ManagedVaultMutation) => void): () => void {
  mutationListeners.add(listener);
  return () => { mutationListeners.delete(listener); };
}
function rememberNote(note: ManagedNote): ManagedNote {
  const remote = note.remote as { instanceId?: unknown; vaultId?: unknown } | undefined;
  if (typeof remote?.instanceId === "string" && typeof remote?.vaultId === "string" && remote.instanceId && remote.vaultId) {
    bindings.set(note.localVaultId, { instanceId: remote.instanceId, remoteVaultId: remote.vaultId });
  }
  return note;
}
function committed<T>(kind: ManagedVaultMutation["kind"], localVaultId: string, promise: Promise<T>, noteId?: string): Promise<T> {
  return promise.then(value => {
    if (value && typeof value === "object" && "localVaultId" in value && "noteId" in value) {
      rememberNote(value as unknown as ManagedNote);
      noteId = (value as unknown as ManagedNote).noteId;
    }
    const binding = bindings.get(localVaultId);
    const event: ManagedVaultMutation = { kind, localVaultId, noteId, instanceId: binding?.instanceId ?? null, vaultId: binding?.remoteVaultId ?? null };
    // Native has committed. Defer observers so sync scheduling cannot delay/alter the save result.
    setTimeout(() => { for (const listener of mutationListeners) { try { listener(event); } catch { /* committed save remains successful */ } } }, 0);
    return value;
  });
}
export const managedVault = {
  createVault: (name = "笔记", requestId: string = secureUuidV4()) => invoke<ManagedVault>("managed_vault_create", { name, requestId }),
  syncToPhone: async (instance: string, vault: string): Promise<ManagedVault> => {
    const result = await invoke<ManagedVault>("managed_vault_sync_to_phone", { instance, vault });
    if (result.binding) bindings.set(result.localVaultId, result.binding);
    return result;
  },
  list: () => invoke<{ items: ManagedVault[]; selectedVaultId: string | null }>("managed_vault_list").then(result => { bindings.clear(); for (const vault of result.items) { if (vault.binding) bindings.set(vault.localVaultId, vault.binding); } return result; }),
  syncTargets: (instance: string) => invoke<{ items: Array<{ instanceId: string; vaultId: string; localVaultId: string; pendingCount: number }> }>("managed_vault_sync_targets", { instance }),
  transferPreview: (sourceVaultId: string, targetVaultId: string) => invoke<ManagedTransferPreview>("managed_vault_transfer_preview", { sourceVaultId, targetVaultId }),
  transferCommit: (sourceVaultId: string, targetVaultId: string, snapshotHash: string, wikiProofs?: ManagedWikiProof[]) => committed("import", targetVaultId, invoke<{ transferredCount?: number; preparedCount?: number; syncState?: string }>("managed_vault_transfer_commit", { sourceVaultId, targetVaultId, snapshotHash, ...(wikiProofs ? { wikiProofs } : {}) })),
  select: (localVaultId: string) => invoke<void>("managed_vault_select", { localVaultId }),
  migrationStatus: () => invoke<ManagedMigrationStatus>("managed_vault_migration_status"),
  prepareMigration: () => invoke<ManagedMigrationStatus>("managed_vault_migration_prepare"),
  commitMigration: (planId: string) => invoke<ManagedMigrationStatus>("managed_vault_migration_commit", { planId }),
  notes: (query: ManagedNoteQuery) => invoke<{ items: ManagedNote[]; total: number; hasMore: boolean }>("managed_vault_note_list", { query }),
  get: (localVaultId: string, noteId: string) => invoke<ManagedNote>("managed_vault_note_get", { localVaultId, noteId }).then(rememberNote),
  hydrate: (localVaultId: string, noteId: string) => invoke<ManagedNote>("managed_vault_note_hydrate", { localVaultId, noteId }),
  create: (localVaultId: string, title: string, content: string, tags: string[] = [], folder = "") => committed("create", localVaultId, invoke<ManagedNote>("managed_vault_note_create", { localVaultId, title, content, tags, folder })),
  save: (localVaultId: string, noteId: string, expectedRevision: string, title: string, content: string, tags: string[]) => committed("save", localVaultId, invoke<ManagedNote>("managed_vault_note_save", { localVaultId, noteId, expectedRevision, title, content, tags }), noteId),
  move: (localVaultId: string, noteId: string, expectedRevision: string, folder: string) => committed("move", localVaultId, invoke<ManagedNote>("managed_vault_note_move", { localVaultId, noteId, expectedRevision, folder }), noteId),
  trash: (localVaultId: string, noteId: string, expectedRevision: string) => committed("trash", localVaultId, invoke<void>("managed_vault_note_trash", { localVaultId, noteId, expectedRevision }), noteId),
  setFlags: (localVaultId: string, noteId: string, expectedRevision: string, flags: { pinned?: boolean; favorite?: boolean; archived?: boolean }) => committed("flags", localVaultId, invoke<ManagedNote>("managed_vault_note_flags", { localVaultId, noteId, expectedRevision, flags }), noteId),
  folders: (localVaultId: string) => invoke<{ paths: string[] }>("managed_vault_folders", { localVaultId }),
  createFolder: (localVaultId: string, name: string, parent = "") => committed("folder", localVaultId, invoke<{ path: string }>("managed_vault_folder_create", { localVaultId, name, parent })),
  linkCatalog: (localVaultId: string) => invoke<{ items: ManagedNote[] }>("managed_vault_link_catalog", { localVaultId }),
  importLegacyReceipt: (localVaultId: string, noteId: string, folder = "") => committed("import", localVaultId, invoke<ManagedNote>("managed_vault_import_legacy_receipt", { localVaultId, noteId, folder }), noteId),
  resolveLegacy: (legacyRoute: string) => invoke<{ localVaultId: string; noteId: string } | null>("managed_vault_resolve_legacy", { legacyRoute }),
};

export function managedNoteRoute(localVaultId: string, noteId: string): string {
  return `vault:${encodeURIComponent(localVaultId)}:${encodeURIComponent(noteId)}`;
}
export function parseManagedNoteRoute(route: string): { localVaultId: string; noteId: string } | null {
  const match = /^vault:([^:]+):([^:]+)$/.exec(route);
  if (!match) return null;
  try { return { localVaultId: decodeURIComponent(match[1]), noteId: decodeURIComponent(match[2]) }; } catch { return null; }
}
