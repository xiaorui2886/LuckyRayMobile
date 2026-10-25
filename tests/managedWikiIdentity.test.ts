import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocalWiki, localWikiDisplayStatus, type LocalWikiNote } from '../src/still/kit/localWiki.ts';
import { wikiChoiceRows } from '../src/still/kit/wikiChoiceRows.ts';
const ref = (target: string) => ({ target, label: target, from: 0, to: target.length, line: 0 });
const row = (id: string, title: string, managedIdentity = true): LocalWikiNote => ({ noteId: id, title, folder: '', historicalNames: [], managedIdentity });
const client = (items: LocalWikiNote[]) => ({ managedScope: items.every(item => item.managedIdentity) ? true as const : undefined, catalog: async () => ({items}), get: async (id: string) => items.find(item => item.noteId === id)! });
test('managed completion inserts an explicit scoped identity, never an arbitrary title', async () => {
 const items = [row('desktop_123', 'Name')];
 const choices = wikiChoiceRows(items, '', undefined, true);
 assert.equal(choices[0].target, '@id/desktop_123');
 assert.equal((await resolveLocalWiki(ref(choices[0].target), client(items))).notes[0].noteId, 'desktop_123');
 items[0].title = 'Renamed';
 assert.equal((await resolveLocalWiki(ref(choices[0].target), client(items))).notes[0].noteId, 'desktop_123');
});
test('deleted managed identities never fall back to a title and foreign catalogs cannot resolve them', async () => {
 const items = [row('other', '@id/deleted'), row('another', 'deleted')];
 assert.equal((await resolveLocalWiki(ref('@id/deleted'), client(items))).kind, 'missing');
 assert.equal(localWikiDisplayStatus(ref('@id/note-local'), [row('note-local', 'local', false)]), 'missing');
});
test('ordinary local catalogs still reject desktop IDs and unsafe managed suggestions', async () => {
 await assert.rejects(resolveLocalWiki(ref('Name'), client([row('desktop_123', 'Name', false)])), /LOCAL_WIKI_CHANGED/);
 assert.equal(wikiChoiceRows([row('../escape', 'Bad')], '', undefined, true).length, 0);
 assert.equal(wikiChoiceRows([row('desktop_123', 'Name')], '').length, 0);
});
