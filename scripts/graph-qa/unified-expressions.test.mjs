import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {seedUnifiedExpression} from './unified-expressions.mjs';
const id='vault-'+'a'.repeat(64);
test('native seed validates identity and bounds',()=>{
 for(const args of [['local','Synthetic-A',20],[id,'user-data',20],[id,'Synthetic-A',101]])assert.throws(()=>seedUnifiedExpression(...args));
});
test('native seed writes real IPC scoped notes without migration or DB injection',async()=>{
 const calls=[],notes=[];const invoke=async(command,args)=>{calls.push({command,args});if(command==='managed_vault_list')return {items:[{localVaultId:id,binding:null,migrationState:'ready'}]};if(command==='managed_vault_note_list')return {total:notes.length,items:notes};if(command==='managed_vault_note_create'){notes.push({...args,noteId:'n'+notes.length});return notes.at(-1);}throw Error(command);};
 const result=await vm.runInNewContext(seedUnifiedExpression(id,'Synthetic-A',20),{window:{__TAURI_INTERNALS__:{invoke},dispatchEvent(){}},Event:class{}});
 assert.equal(result.total,20);assert.equal(notes[0].content,'# Synthetic-A-000\n\n[[Synthetic-A-001]]\nSynthetic unified vault fixture.');assert.ok(notes.every(n=>n.localVaultId===id));assert.ok(!calls.some(c=>/migration|sync|sqlite/.test(c.command)));
});
test('nonempty or bound vault refuses seed, no silent retries',async()=>{
 for(const binding of [null,{instanceId:'test',remoteVaultId:'test'}]){
 const invoke=async(command)=>command==='managed_vault_list'?{items:[{localVaultId:id,binding,migrationState:'ready'}]}:{total:1};
 await assert.rejects(vm.runInNewContext(seedUnifiedExpression(id,'Synthetic-B'),{window:{__TAURI_INTERNALS__:{invoke}},Event:class{}}));
 }
});
