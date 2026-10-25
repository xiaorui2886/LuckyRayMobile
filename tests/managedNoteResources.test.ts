import test from 'node:test';
import assert from 'node:assert/strict';
import { NoteResourceSession } from '../src/services/noteResourceSession.ts';
import { editorImageRanges } from '../src/presentation/still01/editor/editorImageRanges.ts';
import { wikiResourceChoices } from '../src/presentation/still01/editor/wikiCompletion.ts';
import { managedNoteResources } from '../src/services/managedNoteResources.ts';
test('managed attachment lookup is exact-scope offline and never falls through to Desktop or network', async () => {
 const calls: unknown[][] = [], views: any[] = [];
 const effects = {
  managedVaultResourceGet: async (...args: string[]) => { calls.push(args); return {path:'/owned/cache/content-resources/managed/image.bin',mime:'image/png'}; },
  contentCachedResource: async()=>{throw Error('must not read Desktop cache')},
  contentNoteResource: async()=>{throw Error('must not fetch')},contentCancel:async()=>{},
 };
 const session = new NoteResourceSession({instance:'',vault:'v',note:'n',localVaultId:'v',revision:'r1'}, {resourceId:'x',target:'images/a.png',status:'resolved',mimeType:'image/png'},effects,view=>views.push(view),false);
 await session.start();assert.deepEqual(calls,[['v','n','images/a.png','r1']]);assert.equal(views.at(-1).file.mime,'image/png');session.retire();
});
test('missing, corrupted, revision-mismatched files remain unavailable without a network fallback', async()=>{
 let desktop=0;const views:any[]=[];
 const session=new NoteResourceSession({instance:'',vault:'v',note:'n',localVaultId:'v',revision:'r2'},{resourceId:'x',target:'../unknown',status:'resolved'},{managedVaultResourceGet:async()=>{throw Error('VAULT_RESOURCE_HASH_MISMATCH')},contentCachedResource:async()=>{desktop++;throw Error()},contentNoteResource:async()=>{desktop++;throw Error()},contentCancel:async()=>{}},view=>views.push(view),true);
 await session.start();await session.download();assert.equal(desktop,0);assert.equal(views.at(-1).file,null);assert.match(views.at(-1).message,/校验未通过/);session.retire();
});
test('retiring a managed attachment fences an in-flight native read', async()=>{
 let finish!: (value:{path:string;mime:string})=>void;const views:any[]=[];
 const session=new NoteResourceSession({instance:'',vault:'v',note:'n',localVaultId:'v',revision:'r'},{resourceId:'x',target:'a',status:'resolved'},{managedVaultResourceGet:()=>new Promise(resolve=>finish=resolve),contentCachedResource:async()=>{throw Error()},contentNoteResource:async()=>{throw Error()},contentCancel:async()=>{}},view=>views.push(view),false);
 const pending=session.start();session.retire();finish({path:'/owned/path',mime:'image/png'});await pending;assert.equal(views.some(view=>view.file),false);
});
test('managed descriptors carry revision identity and never expose manifest file paths',()=>{
 const note={revision:'r1',remote:{replica:{resources:[{resourceId:'x',target:'img.png',status:'verified',localStatus:'verified',mimeType:'image/png',sha256:'abc',localRelativePath:'private/path'}]}}};
 const first=managedNoteResources(note);assert.equal(first[0].localOnly,true);assert.equal(first[0].status,"resolved");assert.equal('localRelativePath' in first[0],false);note.revision='r2';assert.notEqual(first[0].version,managedNoteResources(note)[0].version);
});

test('remote verification alone and legacy resolved claims cannot become renderable local bytes',()=>{
 for(const row of [{status:'verified'}, {status:'verified',localStatus:'missing'}, {status:'resolved',localStatus:'verified'}]) {
  const resources=managedNoteResources({revision:'r',remote:{replica:{resources:[{resourceId:'a',target:'a.png',mimeType:'image/png',...row}]}}});
  assert.equal(resources[0].status,'missing');
 }
});

test('actual native verified manifest drives image ranges and attachment suggestions',()=>{
 const resources=managedNoteResources({revision:'r',remote:{replica:{resources:[{resourceId:'a',target:'a.png',status:'verified',localStatus:'verified',mimeType:'image/png'}]}}});
 assert.equal(editorImageRanges('![a](a.png)',resources).length,1);
 assert.equal(wikiResourceChoices(resources,'').length,1);
});
