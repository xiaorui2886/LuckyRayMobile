import test from 'node:test';
import assert from 'node:assert/strict';
import { localWikiReferences, resolveLocalWiki, chooseLocalWiki, localWikiChoiceDetail, type LocalWikiNote, type LocalWikiClient } from '../src/still/kit/localWiki.ts';
const ref = (target: string) => ({ target, label: target, from: 0, to: target.length + 4, line: 1 });
const row = (noteId: string, title: string, folder = '', historicalNames: string[] = []): LocalWikiNote => ({noteId,title,folder,historicalNames});
const client = (rows: LocalWikiNote[]): LocalWikiClient => ({ catalog: async () => ({items: rows}), get: async id => rows.find(note => note.noteId === id)! });

test('historical names include NFC Unicode and .md spelling, without guessing unsaved/pre-upgrade names', async () => {
  const c = client([row('note-a', '新名', '', ['旧名', 'Cafe\u0301', 'intermediate'])]);
  for (const target of ['旧名', 'CAFÉ.md', 'intermediate']) assert.equal((await resolveLocalWiki(ref(target), c)).notes[0]?.noteId, 'note-a');
  assert.equal((await resolveLocalWiki(ref('never persisted'), c)).kind, 'missing');
});
test('current-title and historical-title collisions always require choice, deduplicated by identity', async () => {
  const rows = [row('note-a', 'New', '', ['Old', 'OLD.md']), row('note-b', 'Old'), row('note-c', 'Else', '', ['Old'])];
  const result = await resolveLocalWiki(ref('old'), client(rows));
  assert.equal(result.kind, 'ambiguous');
  assert.deepEqual(result.notes.map(note => note.noteId), ['note-a','note-b','note-c']);
  assert.match(localWikiChoiceDetail(result.notes[0]), /旧名称：Old/);
});
test('ID claims never fall back to current titles or historical names, including after deletion', async () => {
  const c = client([row('note-b', 'note-deleted', '', ['note-missing']), row('note-a', 'renamed')]);
  assert.equal((await resolveLocalWiki(ref('note-a'), c)).notes[0].noteId, 'note-a');
  for (const target of ['note-deleted','note-missing']) assert.equal((await resolveLocalWiki(ref(target), c)).kind, 'missing');
});
test('logical folder paths exactly disambiguate current and historical names; moving invents no path history', async () => {
  const c = client([row('note-a','Current','Work/Sub',['Old']), row('note-b','Old','Home'), row('note-c','Root')]);
  assert.equal((await resolveLocalWiki(ref('Old'), c)).kind, 'ambiguous');
  for (const path of ['Work/Sub/Old.md', './Work/Other/../Sub/Old', './Work/Sub/Current']) assert.equal((await resolveLocalWiki(ref(path), c)).notes[0].noteId, 'note-a');
  assert.equal((await resolveLocalWiki(ref('work/Sub/Old'), c)).kind,'missing');
  assert.equal((await resolveLocalWiki(ref('Previous/Sub/Old'), c)).kind,'missing');
  assert.equal((await resolveLocalWiki(ref('./Root'), c)).notes[0].noteId,'note-c');
  assert.equal((await resolveLocalWiki(ref('./Old'), c)).kind,'missing');
});
test('unsafe paths fail before reading any catalog', async () => {
  let reads = 0;
  const c = {catalog:async()=>{reads++;return {items:[]};}, get:async()=>row('note-a','a')};
  for (const path of ['../a','a/../../b','a/..','a/.','a/','/a','\\a','a\\b','C:/a','a\u0000b']) await assert.rejects(resolveLocalWiki(ref(path), c), /LOCAL_WIKI_(PATH_)?UNSUPPORTED/);
  assert.equal(reads,0);
});
test('local heading is separated without changing exact parsed source ranges or display alias', async () => {
  const source = '`[[Old#code]]`\n\n```md\n[[Old#fence]]\n```\n\n[[Old#章节|别名]]';
  const references = localWikiReferences(source);
  assert.equal(references.length,1); assert.equal(references[0].target,'Old#章节');
  assert.equal(source.slice(references[0].from,references[0].to),'[[Old#章节|别名]]');
  const result = await resolveLocalWiki(references[0],client([row('note-a','New','',['Old'])]));
  assert.equal(result.notes[0].noteId,'note-a'); assert.equal(result.heading,'章节');
});
test('production catalog errors or malformed entries never fall back to the body-bearing list', async () => {
  let lists = 0;
  const base = {get:async()=>row('note-a','a'), list:async()=>{lists++;return {items:[],total:0,hasMore:false};}};
  await assert.rejects(resolveLocalWiki(ref('a'), {...base,catalog:async()=>{throw Error('offline');}}), /offline/);
  for (const items of [[{noteId:'note-a',title:'a'}], [row('note-a','a'),row('note-a','a')], [{...row('note-a','a'),historicalNames:[5]}]]) {
    await assert.rejects(resolveLocalWiki(ref('a'),{...base,catalog:async()=>({items:items as LocalWikiNote[]})}), /LOCAL_WIKI_CHANGED/);
  }
  assert.equal(lists,0);
});
test('snapshot entries never leak bodies into the choice result', async () => {
  const rows = [{...row('note-a','Same'),content:'secret body'}, {...row('note-b','Same'),content:'another body'}];
  const result = await resolveLocalWiki(ref('Same'),client(rows));
  assert.ok(result.notes.every(note=> !('content' in note) && !('preview' in note)));
});
test('new collision between catalog and target verification fails closed', async () => {
  const rows = [row('note-a','Old')]; let catalogs=0;
  const c = {...client(rows),catalog:async()=>({items:++catalogs === 1 ? rows : [...rows,row('note-b','New','',['Old'])]})};
  await assert.rejects(resolveLocalWiki(ref('Old'), c),/LOCAL_WIKI_CHANGED/);
});
test('choice revalidates historical eligibility, allowing persisted rename but never silently retargeting', async () => {
  const rows = [row('note-a','Renamed','',['Old']),row('note-b','Old')];
  const selected = await chooseLocalWiki(ref('Old'),'note-a',['note-a','note-b'],client(rows));
  assert.equal(selected.noteId,'note-a');
  rows[0].historicalNames=[];
  await assert.rejects(chooseLocalWiki(ref('Old'),'note-a',['note-a','note-b'],client(rows)),/LOCAL_WIKI_CHANGED/);
});
test('deleted choices, moved path claims and changed candidate sets fail closed', async () => {
  const expected = ['note-a','note-b'];
  for (const rows of [[row('note-b','Old')],[row('note-a','New'),row('note-b','Old')],[row('note-a','Old'),row('note-b','Old'),row('note-c','Old')]]) {
    await assert.rejects(chooseLocalWiki(ref('Old'),'note-a',expected,client(rows)),/LOCAL_WIKI_CHANGED/);
  }
  await assert.rejects(chooseLocalWiki(ref('Work/Old'),'note-a',expected,client([row('note-a','Old','Home'),row('note-b','Old','Work')])),/LOCAL_WIKI_CHANGED/);
});
test('choice rechecks after target read rather than trusting its old visible title', async () => {
  const rows = [row('note-a','Old'),row('note-b','Old')]; let catalogs=0;
  const c = {...client(rows),catalog:async()=>({items:++catalogs === 1 ? rows : [row('note-a','New'),rows[1]]})};
  await assert.rejects(chooseLocalWiki(ref('Old'),'note-a',['note-a','note-b'],c),/LOCAL_WIKI_CHANGED/);
});

test('folder-qualified stable IDs are identity claims constrained to that folder, never title fallbacks', async () => {
  const c = client([row('note-a','Actual','Work'), row('note-b','note-a','Home',['note-missing'])]);
  assert.equal((await resolveLocalWiki(ref('Work/note-a'),c)).notes[0].noteId,'note-a');
  for (const target of ['Home/note-a','Home/note-missing']) assert.equal((await resolveLocalWiki(ref(target),c)).kind,'missing');
});

test('legacy dot-slash stable IDs remain global identities without relaxing ordinary root titles', async () => {
  const c = client([row('note-a','Actual','Work'), row('note-b','note-missing','Work',['note-deleted'])]);
  for (const target of ['note-a','./note-a','././note-a']) assert.equal((await resolveLocalWiki(ref(target),c)).notes[0].noteId,'note-a');
  for (const target of ['./note-missing','./note-deleted','./Actual']) assert.equal((await resolveLocalWiki(ref(target),c)).kind,'missing');
});
