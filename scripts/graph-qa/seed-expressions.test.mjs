import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {initializeExpression,seedExpression} from './seed-expressions.mjs';
function runtime(overrides={}) {
 const notes=[],calls=[],events=[];
 const ready={items:[{localVaultId:'local',binding:null,migrationState:'ready'}],selectedVaultId:'local'};
 const invoke=async(command,args)=>{calls.push([command,args]);if(command in overrides)return overrides[command](args);
 switch(command){
 case 'managed_vault_list':return ready;
 case 'managed_vault_migration_status':return {state:'not-migrated',localVaultId:'local',noteCount:0,warnings:[]};
 case 'managed_vault_migration_prepare':return {state:'prepared',localVaultId:'local',noteCount:0,planId:'synthetic-plan',warnings:[]};
 case 'managed_vault_migration_commit':assert.equal(args.planId,'synthetic-plan');return {state:'ready',localVaultId:'local',noteCount:0,warnings:[]};
 case 'managed_vault_note_list':assert.equal(args.query.localVaultId,'local');assert.equal(args.query.page,1);assert.equal(args.query.limit,1);assert.deepEqual(Object.keys(args.query).sort(),['limit','localVaultId','page']);return {items:notes.slice(0,1),total:notes.length,hasMore:notes.length>1};
 case 'managed_vault_note_create':assert.deepEqual(Object.keys(args).sort(),['content','folder','localVaultId','tags','title']);assert.equal(args.localVaultId,'local');assert.equal(args.folder,'');notes.push(args);return {noteId:'synthetic-id-'+notes.length,...args};
 default:throw Error('unexpected native command: '+command);
 }};
 return {notes,calls,events,context:vm.createContext({window:{__TAURI_INTERNALS__:{invoke},dispatchEvent:e=>events.push(e.type)},Event:class {constructor(type){this.type=type;}}})};
}
test('constructed expression evaluates actual multiline Markdown and exact native payloads for 1000 notes',async()=>{
 const r=runtime();assert.equal(await vm.runInContext(seedExpression(1000),r.context),1000);assert.equal(r.notes.length,1000);
 for(let i=0;i<1000;i++){const n=r.notes[i],next='Synthetic-'+String((i+1)%1000).padStart(4,'0');assert.deepEqual(n.content.split('\n'),['# '+n.title,'','[['+next+']]','Synthetic graph fixture only.']);assert.equal(n.content.includes('\\n'),false);assert.deepEqual(Array.from(n.tags),['synthetic','group-'+i%5]);}
 assert.deepEqual(r.events,['luckyray:managed-vault-change']);
});
test('empty migration uses Rust noteCount/localVaultId/planId fields and commits only valid plan',async()=>{const r=runtime();assert.equal((await vm.runInContext(initializeExpression(),r.context)).state,'ready');assert.deepEqual(r.calls.map(c=>c[0]),['managed_vault_list','managed_vault_migration_status','managed_vault_migration_prepare','managed_vault_migration_commit']);});
test('nonempty prepared plan cannot be committed',async()=>{const r=runtime({managed_vault_migration_prepare:()=>({state:'prepared',localVaultId:'local',noteCount:1,planId:'synthetic-plan'})});await assert.rejects(vm.runInContext(initializeExpression(),r.context),/nonempty/);assert.equal(r.calls.some(c=>c[0]==='managed_vault_migration_commit'),false);});
test('bound or nonempty native vault cannot be seeded',async()=>{
 const bound=runtime({managed_vault_list:()=>({items:[{localVaultId:'local',binding:{instanceId:'synthetic'},migrationState:'ready'}]})});await assert.rejects(vm.runInContext(seedExpression(20),bound.context),/local vault missing/);assert.equal(bound.notes.length,0);
 const full=runtime({managed_vault_note_list:()=>({total:1})});await assert.rejects(vm.runInContext(seedExpression(20),full.context),/nonempty/);assert.equal(full.notes.length,0);
});
test('seeding expression rejects invalid or injected sizes',()=>{for(const n of [0,19,5001,1.5,'1000);evil()'])assert.throws(()=>seedExpression(n));});
