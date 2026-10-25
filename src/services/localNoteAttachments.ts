import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { wikiSyntax } from '../still/kit/wikiSyntax.ts';
import type { NoteResource } from './noteResourceSession.ts';

export type LocalNoteAttachment = {
  opId: string; name: string; mimeType: string; version: string; publicationMarkdown?: string | null;
};

/** Parse only the native persisted publication receipt, never guess filenames.
 * Targets are lookup keys, not filesystem authority. Native IPC still binds op
 * to instance + vault + note before returning any pixels. */
export function publicationTarget(markdown: string): string | null {
  if (!markdown || markdown.length > 8192) return null;
  const references = new Map();
  const parser = unified().use(remarkParse).use(wikiSyntax(markdown, references));
  const tree: any = parser.runSync(parser.parse(markdown));
  const paragraph = tree.children?.length === 1 && tree.children[0];
  const node = paragraph?.type === 'paragraph' && paragraph.children?.length === 1 && paragraph.children[0];
  return node && ['image', 'link'].includes(node.type) && typeof node.url === 'string' ? references.get(node.url)?.target || node.url : null;
}

export function withLocalNoteAttachments(resources: NoteResource[], attachments: LocalNoteAttachment[] = []): NoteResource[] {
  if (!attachments.length) return resources;
  const result = resources.map(resource => ({ ...resource }));
  const occupied = new Set(result.map(resource => resource.target));
  const publishedTargets = attachments.map(attachment => publicationTarget(attachment.publicationMarkdown || ''));
  const versions = new Map<string, Set<string>>();
  attachments.forEach((attachment, index) => {
    const target = publishedTargets[index];
    if (target) {
      const hashes = versions.get(target) || new Set<string>();
      hashes.add(attachment.version);
      versions.set(target, hashes);
    }
  });
  for (const [index, attachment] of attachments.entries()) {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(attachment.opId)) continue;
    const targets = [`luckyray-attachment:${attachment.opId}`];
    const published = publishedTargets[index];
    // Different receipts for the same path cannot establish which bytes are
    // current. Keep unique pending op aliases, but require Desktop resolution.
    if (published && versions.get(published)?.size === 1) targets.push(published);
    for (const target of targets) {
      if (occupied.has(target)) {
        // The Desktop descriptor wins, including missing/denied. Its version
        // is size + mtime, NOT a digest: a matching target cannot prove it is
        // still the uploaded bytes. Never relabel a local original as a newer
        // remote image. The ordinary resource session fetches/caches it online.
        continue;
      } else {
        occupied.add(target);
        result.push({ resourceId: `local-attachment-${attachment.opId}`, target, status: 'resolved',
        mimeType: attachment.mimeType, version: attachment.version, localAttachmentId: attachment.opId, localOnly: true });
      }
    }
  }
  return result;
}
