import test from 'node:test';
import assert from 'node:assert/strict';
import { NoteSourceSelectionStore, noteSourceSelection, noteSourceKey } from '../src/services/noteSourceSelection.ts';
import { desktopGraphCache, type DesktopGraphCache, type DesktopGraphNote } from '../src/services/desktopGraphCache.ts';
import { desktopLibraries } from '../src/services/desktopLibraries.ts';
import { listMobileGraphSources, loadMobileGraphSnapshot, mobileGraphNoteKey, type MobileGraphSource } from '../src/services/mobileGraph.ts';
import { managedVault } from '../src/services/managedVault.ts';
import { api, type ConnState } from '../src/services/client.ts';

const source = (instanceId = 'A', vaultId = 'v'): MobileGraphSource => ({id:noteSourceKey({kind:'desktop',instanceId,vaultId}),name:'电脑',kind:'desktop',readOnly:true,desktop:{instanceId,vaultId},availability:'ready'});
const row = (id:string, content:string|undefined='', extra:Partial<DesktopGraphNote>={}): DesktopGraphNote => ({instanceId:'A',vaultId:'v',noteId:id,title:id,relativePath:`${id}.md`,revision:'r1',content,dirty:false,bodyState:content===undefined?'missing':'ready',cachedDocument:content===undefined?null:{noteId:id,vaultId:'v',revision:'r1',content},...extra});
const cache = (items:DesktopGraphNote[], extra:Partial<DesktopGraphCache>={}): DesktopGraphCache => ({instanceId:'A',vaultId:'v',libraries:[{instanceId:'A',vaultId:'v',name:'电脑已保存库',confirmed:true,metadataReady:true,writeState:'readonly',paused:false,waitingCurrent:false}],status:'ready',items,total:items.length,hasMore:false,stamp:'1:1',...extra});
const connection = (instanceId='A') => ({paired:true,identity:{instanceId},ws:{state:'disconnected'}} as ConnState);

test('shared selection is exact-scope, stable, and stale asynchronous selections cannot win',()=>{
  const store=new NoteSourceSelectionStore();let updates=0;store.subscribe(()=>updates++);
  store.select({kind:'legacy'});const before=store.snapshot();
  store.select({kind:'desktop',instanceId:'one:a',vaultId:'v:b'});
  assert.equal(store.select({kind:'managed',localVaultId:'old'},before.version),false);
  assert.equal(updates,2);
  const current=store.snapshot();store.select({...current.selection!});assert.equal(store.snapshot(),current);
  assert.notEqual(noteSourceKey({kind:'desktop',instanceId:'one:a',vaultId:'b'}),noteSourceKey({kind:'desktop',instanceId:'one',vaultId:'a:b'}));
  assert.notEqual(mobileGraphNoteKey(source('A','v'),'same'),mobileGraphNoteKey(source('B','v'),'same'));
  assert.notEqual(mobileGraphNoteKey(source('A','v'),'same'),mobileGraphNoteKey(source('A','other'),'same'));
  store.select(null);assert.equal(store.snapshot().selection,null);
});

test('bound Desktop selection resolves to the one owned library without cache discovery',async()=>{
  const old={read:desktopGraphCache.read,list:managedVault.list};
  noteSourceSelection.select({kind:'desktop',instanceId:'A',vaultId:'v'});
  managedVault.list=async()=>({items:[{localVaultId:'owned',name:'My notes',binding:{instanceId:'A',remoteVaultId:'v'},migrationState:'ready',noteCount:0}],selectedVaultId:null});
  desktopGraphCache.read=async()=>{throw Error('must not scan legacy cache');};
  try {
    const result=await listMobileGraphSources({conn:connection()});
    assert.equal(result.selectedSourceId,'owned');assert.equal(result.sources.length,1);
    assert.equal(result.sources[0].kind,'managed');
    assert.deepEqual(noteSourceSelection.snapshot().selection,{kind:'managed',localVaultId:'owned'});
  } finally {Object.assign(managedVault,{list:old.list});desktopGraphCache.read=old.read;noteSourceSelection.select(null);}
});

test('explicit legacy Notes choice remains graph-readable after managed migration is ready',async()=>{
  const old={list:managedVault.list,migrationStatus:managedVault.migrationStatus,prepareMigration:managedVault.prepareMigration,commitMigration:managedVault.commitMigration};
  noteSourceSelection.select({kind:'legacy'});
  managedVault.list=async()=>({items:[{localVaultId:'managed',name:'Managed',migrationState:'ready',binding:null,noteCount:1}],selectedVaultId:'managed'});
  managedVault.migrationStatus=async()=>({state:'ready',localVaultId:'managed',noteCount:1,warnings:[]});
  managedVault.prepareMigration=async()=>{throw Error('must not migrate');};managedVault.commitMigration=async()=>{throw Error('must not migrate');};
  try {const result=await listMobileGraphSources();assert.equal(result.selectedSourceId,'legacy-local');const legacy=result.sources.find(s=>s.id==='legacy-local')!;assert.equal(legacy.kind,'legacy');assert.equal(legacy.readOnly,true);assert(result.sources.some(s=>s.id==='managed'));}
  finally {Object.assign(managedVault,old);noteSourceSelection.select(null);}
});

test('unregistered Desktop intent is preserved for setup, never a second browsing source',async()=>{
  const old={read:desktopGraphCache.read,list:managedVault.list};
  managedVault.list=async()=>({items:[],selectedVaultId:null});
  desktopGraphCache.read=async()=>{throw Error('must not inspect old cache');};
  try {
    for(const selection of [{kind:'desktop' as const,instanceId:'A',vaultId:'unsaved'},{kind:'desktop' as const,instanceId:'',vaultId:''}]){
      noteSourceSelection.select(selection);
      const result=await listMobileGraphSources({conn:connection()});
      assert.equal(result.selectedSourceId,noteSourceKey(selection));assert.deepEqual(result.sources,[]);
      assert.deepEqual(noteSourceSelection.snapshot().selection,selection);
    }
    noteSourceSelection.select(null);
    assert.deepEqual((await listMobileGraphSources()).sources,[]);
  } finally {managedVault.list=old.list;desktopGraphCache.read=old.read;noteSourceSelection.select(null);}
});

test('all Desktop pages build path-scoped links without browse, previews, hydration or sync',async()=>{
  const old=desktopGraphCache.read;
  const forbiddenNames=['contentNotes','contentReplicaNotes','contentNotePreviews','contentNoteGet','contentHydrateDirectories','syncRun'] as const;
  const originals=new Map(forbiddenNames.map(key=>[key,api[key]]));
  for(const key of forbiddenNames)(api as any)[key]=async()=>{throw Error(`forbidden ${key}`);};
  const notes=Array.from({length:203},(_,index)=>row(`n${index}`));
  notes[0]=row('n0','[[../n202]]',{relativePath:'dir/n0.md'});notes[202]=row('n202','---\ntags: [Desktop]\n---\n',{title:'Different display title'});
  const pages:number[]=[];desktopGraphCache.read=async(instance,vault,page=1)=>{
    assert.equal(instance,'A');assert.equal(vault,'v');pages.push(page);return cache(notes.slice((page-1)*200,page*200),{total:203,hasMore:page===1});
  };
  try {const result=await loadMobileGraphSnapshot(source());assert.deepEqual(pages,[1,2,1]);assert.equal(result.notesByKey.size,203);
    assert.equal(result.seed.edges.length,2);assert(result.seed.nodes.some(n=>n.type==='tag'&&n.label==='Desktop'));
    assert.equal(result.notesByKey.values().next().value!.openRoute,'desktop:A:v:n0');assert.equal(result.complete,true);
  } finally {desktopGraphCache.read=old;for(const [key,value] of originals)(api as any)[key]=value;}
});

test('bodyless summaries are not empty complete bodies; outdated and partial cache are truthful',async()=>{
  const old=desktopGraphCache.read;
  desktopGraphCache.read=async()=>cache([row('missing','',{cachedDocument:null,bodyState:'missing'}),row('empty',''),row('old','[[empty]]',{bodyOutdated:true})]);
  try {const result=await loadMobileGraphSnapshot(source());assert.equal(result.complete,false);assert.equal(result.notesByKey.get(mobileGraphNoteKey(source(),'missing'))?.content,undefined);
    assert(result.warnings.some(w=>w.includes('正文未保存')));assert.match(result.warnings[0],/正文未缓存/);assert(result.warnings.some(w=>w.includes('旧版本正文')));assert(result.warnings.some(w=>w.includes('在手机保存此知识库')));
  } finally {desktopGraphCache.read=old;}
});

test('mixed owner/vault, duplicate pages, and changed cache stamps fail closed',async()=>{
  const old=desktopGraphCache.read;
  try {
    desktopGraphCache.read=async()=>cache([row('n','secret',{instanceId:'B'})]);await assert.rejects(()=>loadMobileGraphSnapshot(source()),/范围或分页/);
    desktopGraphCache.read=async()=>cache([row('n','secret',{vaultId:'other'})]);await assert.rejects(()=>loadMobileGraphSnapshot(source()),/范围或分页/);
    desktopGraphCache.read=async(_i,_v,page=1)=>cache([row('n')],{total:2,hasMore:page===1});await assert.rejects(()=>loadMobileGraphSnapshot(source()),/范围或分页/);
    let calls=0;desktopGraphCache.read=async()=>cache([row('n')],{stamp:`s${calls++}`});await assert.rejects(()=>loadMobileGraphSnapshot(source()),/构建期间已变化/);
  } finally {desktopGraphCache.read=old;}
});

test('newer selection aborts an old cache response, including rapid A→phone→A',async()=>{
  const old=desktopGraphCache.read;noteSourceSelection.select({kind:'desktop',instanceId:'A',vaultId:'v'});
  let release!:(value:DesktopGraphCache)=>void;desktopGraphCache.read=()=>new Promise(resolve=>{release=resolve;});
  try {const pending=loadMobileGraphSnapshot(source());noteSourceSelection.select({kind:'legacy'});noteSourceSelection.select({kind:'desktop',instanceId:'A',vaultId:'v'});release(cache([row('n')]));await assert.rejects(()=>pending,{name:'AbortError'});}
  finally {desktopGraphCache.read=old;noteSourceSelection.select(null);}
});

test('current library permission withdrawal blocks a cached graph',async()=>{
  const old=desktopGraphCache.read;
  await desktopLibraries.refresh('Denied',async()=>({scopeSelectionVersion:1,materials:[],knowledge:[{vaultId:'v',displayName:'Denied',activeInDesktop:true,available:true,readGranted:false,writeGranted:false,ingestGranted:false}]}));
  let reads=0;desktopGraphCache.read=async()=>{reads++;return cache([]);};
  try {await assert.rejects(()=>loadMobileGraphSnapshot(source('Denied')),/当前不可读/);assert.equal(reads,0);}finally{desktopGraphCache.read=old;}
});

test('partial metadata, drafts, conflicts and unverified paths cannot claim a complete Desktop graph',async()=>{
  const old=desktopGraphCache.read;
  try {
    desktopGraphCache.read=async()=>cache([row('draft','[[target]]',{dirty:true,cachedDocument:null}),row('conflict','body',{conflictDocument:{content:'other'}}),row('unsafe','[[target]]',{relativePath:'C:/private/notes.md'})]);
    const draft=await loadMobileGraphSnapshot(source());assert.equal(draft.complete,false);assert.match(draft.warnings[0],/冲突.*未同步/);
    assert.equal(draft.notesByKey.get(mobileGraphNoteKey(source(),'unsafe'))!.relativePath,'');assert(!JSON.stringify(draft.seed).includes('C:/private'));
    desktopGraphCache.read=async()=>{const value=cache([row('one')]);value.libraries[0].metadataReady=false;return value;};
    const partial=await loadMobileGraphSnapshot(source());assert.equal(partial.complete,false);assert.match(partial.warnings[0],/目录尚未保存完整/);
    desktopGraphCache.read=async()=>{const value=cache([]);value.libraries[0].metadataReady=false;return value;};
    await assert.rejects(()=>loadMobileGraphSnapshot(source()),/目录尚未完整保存在手机/);
  } finally {desktopGraphCache.read=old;}
});

test('late source discovery cannot overwrite a newer library choice',async()=>{
  const old=managedVault.list;
  noteSourceSelection.select({kind:'desktop',instanceId:'A',vaultId:'v'});
  let release!:(value:Awaited<ReturnType<typeof managedVault.list>>)=>void;
  managedVault.list=()=>new Promise(resolve=>{release=resolve;});
  try {
    const pending=listMobileGraphSources({conn:connection()});
    noteSourceSelection.select({kind:'managed',localVaultId:'new'});
    release({items:[{localVaultId:'old',name:'Old',binding:{instanceId:'A',remoteVaultId:'v'},migrationState:'ready',noteCount:0}],selectedVaultId:null});
    const result=await pending;assert.equal(result.selectedSourceId,'new');
    assert.deepEqual(noteSourceSelection.snapshot().selection,{kind:'managed',localVaultId:'new'});
  } finally {managedVault.list=old;noteSourceSelection.select(null);}
});
