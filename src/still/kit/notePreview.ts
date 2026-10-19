// SERVICES-KNOWLEDGE-BROWSE-R1 REPAIR-R4 (B) — Desktop note row previews.
//
// The canonical KnowledgeNoteSummary has title/revision/parentRelativePath but
// no body, so the page used to show the vault name under every row
// ("LuckyRay 知识库") — the user rejected that duplication. This helper
// previews the note BODY from the existing Mobile note_cache (a LOCAL DB
// read through content_note_previews — ONE bounded bulk request for the
// loaded page's ids, never one Desktop detail fetch per row).
//
// Keying is exact `instanceId + vaultId + noteId`, so the same noteId on two
// Desktops (or two vaults) can never cross-use cached text.

import { api } from "../../services/client.ts";

export type DesktopPreview = {
  /** The first meaningful body text, collapsed to one short line ("" if none). */
  preview: string;
  /** The cached body exists but the remote revision moved past it. */
  outdated: boolean;
  /**
   * ORG-1B REPAIR-R1.1: Mobile holds an unsynced local write for this note
   * (from the same bounded local read). The move authority uses it to fail
   * closed instead of racing two write authorities.
   */
  dirty?: boolean;
};

/** Strip markdown noise and collapse whitespace to one quiet preview line. */
export function previewText(content: string): string {
  if (!content) return "";
  return content
    // Normalize all line breaks/tabs to single spaces, collapse runs.
    .replace(/\r\n|\r|\n|\t/gu, " ")
    .replace(/ +/gu, " ")
    .trim()
    // Common markdown noise that reads badly as a plain preview line.
    .replace(/^#+\s*/gu, "")
    .replace(/\*\*([^*]*)\*\*/gu, "$1")
    .replace(/\*([^*]*)\*/gu, "$1")
    .replace(/`([^`]*)`/gu, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/^>\s*/gmu, "")
    .replace(/^[-*+]\s+/gmu, "")
    .trim()
    .slice(0, 80);
}

/**
 * The truthful fallback when no readable cached body exists. NEVER a
 * vault/source name.
 */
export const NO_CACHED_BODY = "正文尚未缓存";

export type PreviewStore = {
  /** The exact identity this store was loaded for. */
  key: string;
  byNoteId: Record<string, DesktopPreview>;
};

export function previewStoreKey(instanceId: string, vaultId: string): string {
  return `${instanceId}|${vaultId}`;
}

/**
 * ONE bounded local-only bulk read of the cached bodies for the given note
 * ids of exactly ONE (instance, vault). Zero Desktop network calls. A store
 * for a different key is replaced whole; the same key is refetched only when
 * the caller asks (e.g. after a list refresh).
 */
export async function loadPreviewStore(
  instanceId: string,
  vaultId: string,
  noteIds: string[],
): Promise<PreviewStore> {
  const key = previewStoreKey(instanceId, vaultId);
  if (!instanceId || !vaultId || noteIds.length === 0) {
    return { key, byNoteId: {} };
  }
  // Bounded: the loaded page's ids (the Rust side clamps to 100 as well).
  const ids = [...new Set(noteIds)];
  try {
    const byNoteId: Record<string, DesktopPreview> = {};
    // Each IPC stays bounded to 100; later loaded pages are not falsely
    // labelled uncached merely because their index is above that first chunk.
    for (let at = 0; at < ids.length; at += 100) {
      const r = await api.contentNotePreviews(instanceId, vaultId, ids.slice(at, at + 100));
      for (const item of r?.items ?? []) {
        if (!item?.noteId) continue;
        byNoteId[item.noteId] = {
          preview: previewText(item.content || ""),
          outdated: Boolean(item.bodyOutdated),
          dirty: Boolean(item.dirty),
        };
      }
    }
    return { key, byNoteId };
  } catch {
    // A local read failure leaves every row on the truthful fallback.
    return { key, byNoteId: {} };
  }
}
