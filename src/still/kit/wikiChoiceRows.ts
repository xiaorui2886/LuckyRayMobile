import { assertNoteSearchScope } from './noteSearch.ts';
import { localWikiChoiceDetail, localWikiId } from './localWiki.ts';
import { safeWikiTarget } from './wikiSyntax.ts';
import type { WikiChoice } from '../../presentation/still01/editor/wikiCompletion.ts';

export type WikiChoiceScope = { instance: string; vault: string };
export type WikiChoiceRow = {
  noteId?: string; title?: string; relativePath?: string;
  instanceId?: string; vaultId?: string; folder?: string;
  content?: string; preview?: string; updatedAt?: string;
};
/** Presentation only. Keep IDs/paths exact; labels never become resolver authority. */
export function wikiChoiceRows(rows: WikiChoiceRow[], query: string, scope?: WikiChoiceScope, managed = false): WikiChoice[] {
  if (scope) assertNoteSearchScope(rows, { ...scope, directory: '' });
  const q = query.normalize('NFC').toLocaleLowerCase();
  const items: WikiChoice[] = [];
  for (const row of rows) {
    if (typeof row.title !== 'string' || typeof row.noteId !== 'string') continue;
    if (managed && !/^[A-Za-z0-9_-]{1,160}$/.test(row.noteId)) continue;
    const target = scope ? row.relativePath : managed ? `@id/${row.noteId}` : row.noteId;
    if (typeof target !== 'string' || !safeWikiTarget(target) || (!scope && !managed && !localWikiId(target))) continue;
    if (!row.title.normalize('NFC').toLocaleLowerCase().includes(q) && !target.normalize('NFC').toLocaleLowerCase().includes(q)) continue;
    items.push({ id: row.noteId, title: row.title || '未命名笔记', target,
      // Local folders are descriptive, not a path namespace. Desktop paths stay
      // scoped to the selected vault; do not use potentially stale body previews.
      detail: scope ? row.relativePath : localWikiChoiceDetail({ ...row, noteId: row.noteId, title: row.title, folder: row.folder ?? '' }),
    });
  }
  return items;
}
