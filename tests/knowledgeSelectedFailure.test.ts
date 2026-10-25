import test from 'node:test';
import assert from 'node:assert/strict';
import {createKnowledgeSession} from '../src/still/kit/knowledgeSession.ts';
import {ServicesError} from '../src/services/companionServices/transport.ts';
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));};
const binding={paired:true,connected:true,instanceId:'desktop',isLive:()=>true};
const view=(vaultId='A')=>({...binding,vaultId});
function make(read:()=>Promise<unknown>){
 return createKnowledgeSession({registry:{refreshAdopting:read,operation:()=>({state:'implemented'}),invalidate(){}},knowledge:{vaults:async()=>({items:[{vaultId:'A',displayName:'A',activeInDesktop:true,readGranted:true}]}),registeredList:async()=>({items:[{noteId:'n'}],hasMore:false})},previewReader:async()=>({byNoteId:{}})} as any);
}
for(const [error,phase] of [[new ServicesError('TRANSPORT_FAILED',0),'error'],[new ServicesError('GRANT_REQUIRED',403),'not-granted'],[new ServicesError('SERVICE_UNAVAILABLE',503),'temporarily-unavailable'],[new ServicesError('VERSION_UNSUPPORTED',426),'unsupported']] as const){
 test(`selected vault completed ${phase} is not projected as eternal connecting`,async()=>{
  const s=make(async()=>{throw error});s.desktop.selectVault('A');s.desktop.setConnection(binding);await settle();
  assert.equal(s.desktop.snapshot().phase,phase);
  const result=s.desktopViewFor(view());assert.equal(result.phase,phase);assert.deepEqual(result.rows,[]);
  assert.strictEqual(result,s.desktopViewFor(view()),'getSnapshot remains stable');
  assert.equal(s.desktopViewFor(view('B')).phase,'waiting-catalog','failure cannot migrate to another selection');
  assert.equal(s.desktopViewFor({...view(),instanceId:'other'}).phase,'waiting-catalog','failure cannot migrate to another desktop');
 });
}
test('old ready rows remain fenced on selection change and late failure cannot replace newer result',async()=>{
 let rejectOld:(e:unknown)=>void=()=>{};let calls=0;
 const s=make(()=>++calls===1?new Promise((_,reject)=>rejectOld=reject):Promise.resolve({}));
 s.desktop.selectVault('B');s.desktop.setConnection(binding);await settle();s.desktop.selectVault('A');await settle();
 assert.equal(s.desktopViewFor(view()).phase,'ready');assert.equal(s.desktopViewFor(view()).rows.length,1);
 rejectOld(new ServicesError('GRANT_REQUIRED',403));await settle();
 assert.equal(s.desktopViewFor(view()).phase,'ready');assert.equal(s.desktopViewFor(view('B')).rows.length,0);
});
test('request diagnostic cannot certify data, resolved foreign vault, replica, or another owner',async()=>{
 const s=make(async()=>{throw new ServicesError('SOURCE_CHANGED',409)});
 s.desktop.selectVault('A');s.desktop.setConnection(binding);await settle();
 assert.equal(s.desktopViewFor(view()).phase,'error');
 const snap=s.desktop.snapshot();
 snap.rows=[{instanceId:'desktop',vaultId:'B',noteId:'secret',title:'B',parentRelativePath:'',revision:''}];
 assert.equal(s.desktopViewFor(view()).phase,'waiting-catalog');assert.deepEqual(s.desktopViewFor(view()).rows,[]);
 snap.rows=[];snap.vaultId='B';assert.equal(s.desktopViewFor(view()).phase,'waiting-catalog');
 snap.vaultId='';snap.replica={} as any;assert.equal(s.desktopViewFor(view()).phase,'waiting-catalog');
});
test('missing explicitly selected vault settles unavailable rather than an endless connecting projection',async()=>{
 const s=make(async()=>({}));s.desktop.selectVault('missing');s.desktop.setConnection(binding);await settle();
 const raw=s.desktop.snapshot();
 assert.equal(s.desktopViewFor(view('missing')).phase,'temporarily-unavailable');
 assert.equal(raw.phase,'temporarily-unavailable');
 assert.equal(raw.vaultId,'');assert.deepEqual(raw.rows,[]);
 assert.equal(s.desktopViewFor(view('missing')).phase,'temporarily-unavailable');
 assert.equal(s.desktopViewFor(view('A')).phase,'waiting-catalog');
});
test('unselected discovery with no active vault remains an honest empty result',async()=>{
 const s=createKnowledgeSession({registry:{refreshAdopting:async()=>({}),operation:()=>({state:'implemented'}),invalidate(){}},knowledge:{vaults:async()=>({items:[]}),registeredList:async()=>{throw Error('must not list');}},previewReader:async()=>({byNoteId:{}})} as any);
 s.desktop.setConnection(binding);await settle();
 assert.equal(s.desktop.snapshot().phase,'ready');assert.equal(s.desktopViewFor({...binding}).phase,'ready');
 assert.deepEqual(s.desktop.snapshot().rows,[]);
});
test('a late missing-target discovery cannot overwrite the newer selected vault',async()=>{
 let resolveOld:(value:unknown)=>void=()=>{};let calls=0;
 const s=createKnowledgeSession({registry:{refreshAdopting:async()=>({}),operation:()=>({state:'implemented'}),invalidate(){}},knowledge:{vaults:async()=>++calls===1?new Promise(resolve=>resolveOld=resolve):{items:[{vaultId:'A',displayName:'A',readGranted:true}]},registeredList:async()=>({items:[{noteId:'n'}],hasMore:false})},previewReader:async()=>({byNoteId:{}})} as any);
 s.desktop.selectVault('missing');s.desktop.setConnection(binding);await settle();
 s.desktop.selectVault('A');await settle();resolveOld({items:[]});await settle();
 assert.equal(s.desktopViewFor(view()).phase,'ready');assert.equal(s.desktopViewFor(view()).rows.length,1);
 assert.equal(s.desktopViewFor(view('missing')).phase,'waiting-catalog');
});
