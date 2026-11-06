import { withLocalNoteAttachments, type LocalNoteAttachment } from './localNoteAttachments.ts';
import type { NoteResource } from './noteResourceSession.ts';
/** Descriptors select native manifest lookup keys, never file paths or URLs.
 * The native resolver rechecks vault + note + revision + target and file hash. */
export function managedNoteResources(note: { revision: string; remote?: unknown } | null): NoteResource[] {
  const remote = note?.remote as { localAttachments?: (LocalNoteAttachment & {sha256: string})[]; replica?: { resources?: unknown[] } } | undefined;
  if (!note) return [];
  const resources: NoteResource[] = (Array.isArray(remote?.replica?.resources) ? remote.replica.resources : []).flatMap(raw => {
    const item = raw as Record<string, unknown> | null;
    if (!item || typeof item.resourceId !== 'string' || typeof item.target !== 'string' || typeof item.status !== 'string') return [];
    return [{ resourceId: item.resourceId, target: item.target, status: item.status === "ambiguous" ? "ambiguous" : item.status === "verified" && item.localStatus === "verified" ? "resolved" : "missing",
      mimeType: typeof item.mimeType === 'string' ? item.mimeType : undefined,
      version: JSON.stringify([note.revision, item.target, item.sha256, item.version]), localOnly: true }];
  });
  const attachments = (Array.isArray(remote?.localAttachments) ? remote.localAttachments : []).flatMap(row => {
    if (!row || typeof row.opId !== 'string' || typeof row.sha256 !== 'string' || typeof row.mimeType !== 'string') return [];
    return [{ opId: row.opId, name: typeof row.name === 'string' ? row.name : '', mimeType: row.mimeType,
      version: row.sha256, publicationMarkdown: typeof row.publicationMarkdown === 'string' ? row.publicationMarkdown : undefined }];
  });
  return withLocalNoteAttachments(resources, attachments);
}
