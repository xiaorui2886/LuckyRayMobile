import test from 'node:test';
import assert from 'node:assert/strict';
import { managedVault, subscribeManagedVaultMutations, type ManagedVaultMutation } from '../src/services/managedVault.ts';
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
const note={localVaultId:'managed-a',noteId:'n',revision:'r',remote:{instanceId:'owner-a',vaultId:'vault-a'}};
test('committed mutations notify deferred exact native scope without performing a network operation',async()=>{
 const calls:string[]=[];let resolve!: (value:unknown)=>void;let emit=true;
 (globalThis as any).window={__TAURI_INTERNALS__:{invoke:(cmd:string)=>{calls.push(cmd);return new Promise(done=>resolve=done);}}};
 const events:ManagedVaultMutation[]=[];const unsubscribe=subscribeManagedVaultMutations(event=>{if(emit)events.push(event);});
 const saving=managedVault.save('managed-a','n','prior','title','body',[]);assert.equal(events.length,0);resolve(note);await saving;assert.equal(events.length,0);await tick();
 assert.deepEqual(events,[{kind:'save',localVaultId:'managed-a',noteId:'n',instanceId:'owner-a',vaultId:'vault-a'}]);assert.deepEqual(calls,['managed_vault_note_save']);unsubscribe();emit=false;
});
test('failed mutation emits nothing and subscriber errors never reject an already committed save',async()=>{
 const events:ManagedVaultMutation[]=[];const unsubscribe=subscribeManagedVaultMutations(e=>events.push(e));
 (globalThis as any).window={__TAURI_INTERNALS__:{invoke:()=>Promise.reject(Error('CAS conflict'))}};
 await assert.rejects(managedVault.save('managed-a','n','bad','t','c',[]));await tick();assert.equal(events.length,0);
 const stopBroken=subscribeManagedVaultMutations(()=>{throw Error('observer failed');});
 (globalThis as any).window.__TAURI_INTERNALS__.invoke=()=>Promise.resolve(note);
 assert.equal((await managedVault.save('managed-a','n','r','t','c',[])).noteId,'n');await tick();assert.equal(events.length,1);stopBroken();unsubscribe();
});
test('void trash uses exact previously read vault binding and standalone mutation has no remote identity',async()=>{
 (globalThis as any).window={__TAURI_INTERNALS__:{invoke:(cmd:string)=>Promise.resolve(cmd==='managed_vault_list'?{items:[{localVaultId:'managed-a',binding:{instanceId:'owner-a',remoteVaultId:'vault-a'}},{localVaultId:'local',binding:null}],selectedVaultId:'local'}:undefined)}};
 await managedVault.list();const events:ManagedVaultMutation[]=[];const unsubscribe=subscribeManagedVaultMutations(e=>events.push(e));
 await managedVault.trash('managed-a','n','r');await managedVault.createFolder('local','Folder');await tick();assert.equal(events[0].instanceId,'owner-a');assert.equal(events[0].vaultId,'vault-a');assert.equal(events[1].instanceId,null);assert.equal(events[1].vaultId,null);unsubscribe();
});


test('managed operation guidance distinguishes local conflicts, pending sync and changed migration plans',async()=>{
 const {failureCopy}=await import('../src/services/feedback.ts');
 assert.match(failureCopy('VAULT_MOVE_WAIT_FOR_SYNC'),/同步完成后再移动/);
 assert.match(failureCopy('VAULT_TRANSFER_SOURCE_CHANGED'),/重新检查计划/);
 assert.match(failureCopy('VAULT_REVISION_CONFLICT'),/本地笔记已变化/);
 assert.match(failureCopy('VAULT_MIGRATION_RECOVERY_CONFLICT'),/两份内容均已保留/);
 assert.doesNotMatch(failureCopy('VAULT_MIGRATION_RECOVERY_CONFLICT'),/重试/);
 assert.doesNotMatch(failureCopy('VAULT_UNKNOWN'),/VAULT_/);
});
