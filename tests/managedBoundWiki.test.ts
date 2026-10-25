import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {managedBoundWikiChoices, managedBoundWikiMatches, resolveManagedBoundWiki, verifiedManagedWikiPath} from '../src/still/kit/managedWiki.ts';
import type {ManagedNote} from '../src/services/managedVault.ts';
import {localBacklinkForReferences} from '../src/still/kit/localBacklinks.ts';
const scope={localVaultId:'phone-v',binding:{instanceId:'desktop-a',remoteVaultId:'desktop-v'}};
const note=(noteId:string,path:string,title='Same'):ManagedNote=>({localVaultId:'phone-v',noteId,title,relativePath:'private-title--'+noteId+'.md',folder:'private-folder',revision:'file-hash',bodyState:'ready',content:'body',tags:[],pinned:false,favorite:false,archived:false,createdAt:'',updatedAt:'',historicalNames:[],syncState:'synced',remote:{instanceId:'desktop-a',vaultId:'desktop-v',relativePath:path,revision:'r1',pendingKind:'',conflictDocument:null,serverDocument:{noteId,vaultId:'desktop-v',relativePath:path,revision:'r1',deleted:false}}});
const ref=(target:string)=>({target,label:target,from:0,to:target.length,line:0});
test('bound completion emits explicit source-relative Desktop paths, never private filename or @id',()=>{
 const source=note('source','Scenes/Shot.md'),a=note('a','People/Same.md'),b=note('b','Scenes/Same.md');
 const items=managedBoundWikiChoices(source,[a,b],'same',scope);
 assert.deepEqual(items.map(row=>row.target),['../People/Same.md','./Same.md']);
 assert.equal(managedBoundWikiChoices(note('root','Root.md'),[a],'',scope)[0].target,'./People/Same.md');
 assert.equal(items.some(row=>row.target.includes('@id/')||row.target.includes('private-')),false);
 for(const item of items) assert.equal(managedBoundWikiMatches(ref(item.target),[source,a,b],source.noteId,scope).notes[0].noteId,item.id);
});
test('pending, moved, foreign or mismatched source/target provenance never produces usable choices',()=>{
 const source=note('source','A/Source.md');
 const mutations=[
  (n:ManagedNote)=>{n.syncState='pending';},
  (n:ManagedNote)=>{(n.remote as any).pendingKind='move';},
  (n:ManagedNote)=>{(n.remote as any).relativePath='Pending/New.md';},
  (n:ManagedNote)=>{(n.remote as any).serverDocument.noteId='other';},
  (n:ManagedNote)=>{(n.remote as any).serverDocument.vaultId='foreign';},
  (n:ManagedNote)=>{(n.remote as any).instanceId='foreign';},
  (n:ManagedNote)=>{n.localVaultId='foreign';},
  (n:ManagedNote)=>{(n.remote as any).serverDocument.revision='different';},
  (n:ManagedNote)=>{(n.remote as any).serverDocument.deleted=true;},
  (n:ManagedNote)=>{(n.remote as any).conflictDocument={revision:'r2'};},
  (n:ManagedNote)=>{(n.remote as any).serverDocument=null;},
 ];
 for(const mutate of mutations){const target=note('target','B/Target.md');mutate(target);assert.deepEqual(managedBoundWikiChoices(source,[target],'',scope),[]);}
 const moved=note('source','A/Source.md');(moved.remote as any).pendingKind='move';
 assert.deepEqual(managedBoundWikiChoices(moved,[note('t','T.md')],'',scope),[]);
 assert.equal(verifiedManagedWikiPath(note('t','../Unsafe.md'),scope),null);
});
test('bound offline resolution keeps duplicate basenames ambiguous and exact relative paths scoped',async()=>{
 const source=note('source','A/Source.md'),a=note('a','A/Same.md'),b=note('b','B/Same.md');const rows=[source,a,b];
 const client={catalog:async()=>({items:rows}),get:async(id:string)=>rows.find(n=>n.noteId===id)!};
 assert.equal((await resolveManagedBoundWiki(ref('Same'),source.noteId,scope,client)).kind,'ambiguous');
 const exact=await resolveManagedBoundWiki(ref('../B/Same.md#Heading'),source.noteId,scope,client);
 assert.equal(exact.kind,'resolved');assert.equal(exact.notes[0].noteId,'b');assert.equal(exact.heading,'Heading');
 assert.equal((await resolveManagedBoundWiki(ref('@id/b'),source.noteId,scope,client)).kind,'missing');
 assert.equal((await resolveManagedBoundWiki(ref('../../B/Same.md'),source.noteId,scope,client)).kind,'missing');
 const chosen=await resolveManagedBoundWiki(ref('Same'),source.noteId,scope,client,{noteId:'b',expectedIds:['a','b']});assert.equal(chosen.notes[0].noteId,'b');
 await assert.rejects(resolveManagedBoundWiki(ref('../B/Same.md'),source.noteId,scope,{...client,get:async()=>({...b,noteId:'wrong'})}),/LOCAL_WIKI_CHANGED/);
});
test('fresh path changes invalidate a chooser and backlinks use each source note folder',async()=>{
 const source=note('source','A/Source.md'),target=note('target','B/Target.md');let count=0;
 await assert.rejects(resolveManagedBoundWiki(ref('../B/Target.md'),'source',scope,{catalog:async()=>({items:++count===1?[source,target]:[source,note('other','B/Target.md')]}),get:async()=>target}),/LOCAL_WIKI_CHANGED/);
 source.content='[[../B/Target.md]]';
 const links=localBacklinkForReferences('target',source,[source,target],[ref('../B/Target.md')],(reference,row,catalog)=>{const hits=managedBoundWikiMatches(reference,catalog as ManagedNote[],row.noteId,scope).notes;return hits.length===1?hits[0].noteId:null;});
 assert.equal(links.length,1);
 const editor=readFileSync(new URL('../src/still/StillNote.tsx',import.meta.url),'utf8');
 assert.match(editor,/managedInfo\?\.binding \? managedBoundWikiChoices\(managedRecord\.current/);
 assert.match(editor,/binding=\{managedInfo\?\.binding \|\| undefined\}/);
});


test('bound resolver mirrors Desktop ASCII-only path comparison and unnormalized root candidate',()=>{
 const source=note('s','A/Source.md'),unicode=note('u','B/Ä.md'),ascii=note('a','B/ABC.md');
 assert.equal(managedBoundWikiMatches(ref('../B/abc'),[source,ascii],'s',scope).notes[0].noteId,'a');
 assert.equal(managedBoundWikiMatches(ref('../B/ä'),[source,unicode],'s',scope).notes.length,0);
 const root=note('root','Target.md'),relative=note('relative','A/Target.md');
 assert.deepEqual(managedBoundWikiMatches(ref('B/../Target'),[source,root,relative],'s',scope).notes.map(n=>n.noteId),['relative']);
 assert.deepEqual(managedBoundWikiMatches(ref('./Target'),[source,root,relative],'s',scope).notes.map(n=>n.noteId),['relative']);
});
