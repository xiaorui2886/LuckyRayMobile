import test from 'node:test';
import assert from 'node:assert/strict';
import {buildKnowledgeVaultCatalog,availableDesktopVaults,knowledgeBindingKey} from '../src/services/knowledgeVaultCatalog.ts';
import type {ManagedVault} from '../src/services/managedVault.ts';
const v=(id:string,owner:string|null=null,remote='v'):ManagedVault=>({localVaultId:id,name:'同名笔记',binding:owner?{instanceId:owner,remoteVaultId:remote}:null,migrationState:'ready',noteCount:2});
const build=(items:ManagedVault[],selection:any=null)=>buildKnowledgeVaultCatalog({items,selectedVaultId:null},selection);
test('identity is exact owner+vault, never name or a delimiter collision',()=>{
 const result=build([v('one','A'),v('two','B')],{kind:'desktop',instanceId:'B',vaultId:'v'});
 assert.equal(result.items.length,2);assert.equal(result.selectedVaultId,'two');
 assert.deepEqual(result.selection,{kind:'managed',localVaultId:'two'});
 assert.notEqual(knowledgeBindingKey({instanceId:'a:b',remoteVaultId:'c'}),knowledgeBindingKey({instanceId:'a',remoteVaultId:'b:c'}));
});
test('ambiguous bindings remain distinct read-only and are not chosen by remote intent',()=>{
 const result=build([v('one','A'),v('two','A')],{kind:'desktop',instanceId:'A',vaultId:'v'});
 assert.equal(result.selectionState,'ambiguous');assert.equal(result.selectedVaultId,null);
 assert(result.items.every(i=>i.readOnly));assert.equal(result.issues[0].kind,'ambiguous-binding');
});
test('missing persisted selection and incomplete remote intent never pick another library',()=>{
 assert.equal(buildKnowledgeVaultCatalog({items:[v('one')],selectedVaultId:'missing'}).selectionState,'missing');
 for(const selection of [{kind:'managed',localVaultId:'missing'},{kind:'desktop',instanceId:'',vaultId:'v'},{kind:'desktop',instanceId:'A',vaultId:''}])
  assert.equal(build([v('one','A')],selection).selectedVaultId,null);
});
test('completed transfer entries disappear but pending and invalid entries cannot write',()=>{
 const result=build([{...v('old'),transferState:'completed'},{...v('pending'),transferState:'pending'},v('bad','A','')]);
 assert.deepEqual(result.items.map(v=>v.id),['pending','bad']);assert(result.items.every(i=>i.readOnly));
});
test('duplicate local identity fails closed rather than silently deduplicating',()=>{
 const result=build([v('one','A'),v('one','B')]);assert.equal(result.items.length,0);assert.equal(result.issues[0].kind,'duplicate-local-id');
});
test('available sync candidates exclude registered scopes but not merely equal names',()=>{
 const row=(id:string)=>({vaultId:id,displayName:'同名笔记',available:true,readGranted:true,writeGranted:true,ingestGranted:true,activeInDesktop:false});
 const state:any={instance:'A',catalog:{scopeSelectionVersion:1,knowledge:[row('v'),row('other'),{...row('denied'),readGranted:false}]}};
 assert.deepEqual(availableDesktopVaults(build([v('one','A')]),state).map(x=>x.vaultId),['other']);
});
test('same-name display numbering is stable across discovery order without renaming identity',()=>{
 const rows=[v('z-last','A'),v('a-first','B'),{...v('unique'),name:'独立库'}];
 const first=build(rows),reordered=build([...rows].reverse());
 for(const item of first.items){
  assert.equal(item.displayName,reordered.items.find(other=>other.id===item.id)!.displayName);
  assert.equal(item.name,rows.find(row=>row.localVaultId===item.id)!.name);
 }
 assert.equal(first.items.find(i=>i.id==='z-last')!.displayName,'同名笔记（2）');
 assert.equal(first.items.find(i=>i.id==='a-first')!.displayName,'同名笔记（1）');
 assert.equal(first.items.find(i=>i.id==='unique')!.displayName,'独立库');
 assert.notEqual(first.items[0].detailLabel,first.items[1].detailLabel);
 assert.equal(build(rows,{kind:'managed',localVaultId:'z-last'}).selectedVaultId,'z-last');
});
