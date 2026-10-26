/** The graph's one Desktop-cache reader. No Content browse, preview, body
 * hydrate, recovery, sync or migration entry point is used here. */
import { api } from './client.ts';
import type { CachedNote } from './noteProvenance.ts';
import { safeWikiTarget } from '../still/kit/wikiSyntax.ts';
import { splitWikiHeading } from '../still/kit/noteHeadings.ts';
import type { MobileGraphNote } from './mobileGraph.ts';
import type { WikiReference } from '../still/kit/knowledgeRelations.ts';
export type DesktopGraphLibrary = {
  instanceId: string; vaultId: string; name: string; confirmed: boolean;
  metadataReady: boolean; writeState: string; paused: boolean; waitingCurrent: boolean;
};
export type DesktopGraphNote = CachedNote & {
  instanceId: string; vaultId: string; noteId: string; title: string;
  relativePath?: string | null; updatedAt?: string; bodyState?: string;
  cachedDocument?: (NonNullable<CachedNote['cachedDocument']> & {noteId?: string; vaultId?: string}) | null;
};
export type DesktopGraphCache = {
  instanceId: string; vaultId: string | null; libraries: DesktopGraphLibrary[];
  status: 'catalog' | 'ready' | 'not-saved' | 'revoked';
  items: DesktopGraphNote[]; total: number; hasMore: boolean; stamp: string;
};
export const desktopGraphCache = {
  read: (instance: string, vault?: string, page = 1): Promise<DesktopGraphCache> => api.contentGraphCache(instance, vault, page),
};
export const DESKTOP_GRAPH_SAVE_HELP = '请返回笔记，打开电脑知识库的目录，在“手机保存”中选择“在手机保存此知识库”；图谱不会自动下载或迁移。';

export function desktopGraphPath(path: unknown): path is string {
  return typeof path === 'string' && safeWikiTarget(path) && !/[\\#|\[\]:]/.test(path)
    && path.split('/').every(part => part && part !== '.' && part !== '..') && /\.md$/i.test(path);
}
/** The same exact root/source-relative/basename union as Desktop paths. No
 * title fallback, synthetic phone ID, foreign scope or ambiguous choice. */
export function resolveDesktopGraphReference(notes: MobileGraphNote[], from: MobileGraphNote, reference: WikiReference): { id: string | null; ambiguous: boolean } {
  const none = { id: null, ambiguous: false };
  if (!desktopGraphPath(from.relativePath) || !safeWikiTarget(reference.target)) return none;
  const split = splitWikiHeading(reference.target);
  if (!split?.noteTarget || split.noteTarget.includes(':') || split.noteTarget.startsWith('@id/')) return none;
  const target = split.noteTarget.trim().replace(/\\/g, '/');
  const path = /\.md$/i.test(target) ? target : `${target}.md`;
  const parts = from.relativePath.split('/').slice(0, -1);
  let relative = true;
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) { relative = false; break; } parts.pop(); } else parts.push(part);
  }
  const key = (value: string) => value.replace(/[A-Z]/g, char => char.toLowerCase()).replace(/\.md$/, '');
  const keys = new Set([path, ...(relative ? [parts.join('/')] : [])].map(key));
  const basename = target.includes('/') ? null : key(path);
  const matches = notes.filter(note => desktopGraphPath(note.relativePath)
    && (keys.has(key(note.relativePath)) || basename !== null && key(note.relativePath.split('/').pop()!) === basename));
  return { id: matches.length === 1 ? matches[0].noteId : null, ambiguous: matches.length > 1 };
}
