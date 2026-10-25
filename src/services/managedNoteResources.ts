import type { NoteResource } from './noteResourceSession.ts';
/** Descriptors select native manifest lookup keys, never file paths or URLs.
 * The native resolver rechecks vault + note + revision + target and file hash. */
export function managedNoteResources(note: { revision: string; remote?: unknown } | null): NoteResource[] {
  const remote = note?.remote as { replica?: { resources?: unknown[] } } | undefined;
  if (!note || !Array.isArray(remote?.replica?.resources)) return [];
  return remote.replica.resources.flatMap(raw => {
    const item = raw as Record<string, unknown> | null;
    if (!item || typeof item.resourceId !== 'string' || typeof item.target !== 'string' || typeof item.status !== 'string') return [];
    return [{ resourceId: item.resourceId, target: item.target, status: item.status === "verified" && item.localStatus === "verified" ? "resolved" : "missing",
      mimeType: typeof item.mimeType === 'string' ? item.mimeType : undefined,
      version: JSON.stringify([note.revision, item.target, item.sha256, item.version]), localOnly: true }];
  });
}
