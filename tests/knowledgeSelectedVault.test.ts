import test from "node:test";
import assert from "node:assert/strict";
import { KnowledgeBrowseController } from "../src/still/kit/knowledgeBrowseController.ts";
import { ServiceRegistry } from "../src/services/companionServices/serviceRegistry.ts";
import { createFixtureTransport } from "../src/services/companionServices/fixtureTransport.ts";
const settle=()=>new Promise(r=>setImmediate(r));
function setup() {
 const calls:any[]=[];const vaults=[{vaultId:"active",displayName:"Active",activeInDesktop:true,readGranted:true,writeGranted:true},{vaultId:"selected",displayName:"Selected",activeInDesktop:false,readGranted:true,writeGranted:false}];
 const controller=new KnowledgeBrowseController({registry:{refreshAdopting:async(i:string,scope:any)=>{calls.push({discovery:scope});return {};},operation:()=>({state:"implemented"}),invalidate:()=>{}},knowledge:{vaults:async()=>({items:vaults}),registeredList:async(_i:string,v:string)=>{calls.push({vault:v});return {items:[{noteId:"same",title:v}],hasMore:false,nextAfterId:null};}}} as any);
 return {controller,calls,vaults};
}
test("inactive selected vault owns rows and write guard; desktop active is never substituted",async()=>{
 const {controller,calls}=setup();controller.selectVault("selected");controller.setConnection({paired:true,connected:true,instanceId:"desktop",isLive:()=>true});await settle();await settle();
 assert.equal(controller.snapshot().vaultId,"selected");assert.equal(controller.snapshot().rows[0].vaultId,"selected");assert.equal(controller.moveAuthority().writeGranted,false);
 assert.ok(calls.some(c=>c.discovery?.vault==="selected"));assert.ok(calls.filter(c=>c.vault).every(c=>c.vault==="selected"));
 controller.selectVault("missing");await settle();await settle();assert.equal(controller.snapshot().rows.length,0);assert.ok(calls.filter(c=>c.vault).every(c=>c.vault!=="active"));
});
test("read grant withdrawal clears selected rows without issuing another list",async()=>{
 const {controller,calls}=setup();controller.selectVault("selected");controller.setConnection({paired:true,connected:true,instanceId:"desktop",isLive:()=>true});await settle();await settle();const reads=calls.filter(c=>c.vault).length;
 controller.selectVault("selected",false);controller.refresh();await settle();assert.equal(controller.snapshot().rows.length,0);assert.equal(calls.filter(c=>c.vault).length,reads);
});
test("scoped discoveries do not coalesce across vaults or share cached namespaces",async()=>{
 const fixture=createFixtureTransport();const requests:any[]=[];
 const registry=new ServiceRegistry({request:async req=>{requests.push(req);return fixture.request(req);}});
 await registry.refreshAdopting("fixture-desktop-1",{vault:"a"});const a=registry.currentNamespace();await registry.refreshAdopting("fixture-desktop-1",{vault:"b"});
 assert.notEqual(registry.currentNamespace(),a);assert.equal(registry.scopeMatches({vault:"b"}),true);assert.deepEqual(requests.map(r=>r.vault),["a","b"]);
});

test('selected cold browse and directory reads carry saved-vault scope through the production Tauri payload',async()=>{
 const {createTauriServicesTransport}=await import('../src/services/companionServices/productionTransport.ts');
 const {KnowledgeClient}=await import('../src/services/companionServices/knowledgeClient.ts');
 const sent:any[]=[];
 const transport=createTauriServicesTransport(async(_cmd,args)=>{
  const req=(args as any).request;sent.push(req);
  // Actual Desktop routing selects the saved vault only from request scope
  // headers. A vault in the URL alone does not select an inactive library.
  const vault=req.vault || 'active';
  if(req.operationId==='services.discover')return {status:200,body:{desktopInstanceId:'desktop',gatewayGeneration:1,permissionRevision:1,operations:{'knowledge.vaults':{state:'implemented'},'knowledge.registeredList':{state:'implemented'}}}};
  if(req.operationId==='knowledge.vaults')return {status:200,body:{items:[{vaultId:vault,displayName:vault,activeInDesktop:vault==='active',readGranted:true}]}};
  if(req.path.includes('/selected/') && vault!=='selected')return {status:503,body:{code:'SERVICE_UNAVAILABLE'}};
  if(req.operationId==='knowledge.directories')return {status:200,body:{vaultId:vault,items:[],hasMore:false,nextAfterPath:null}};
  return {status:200,body:{items:[{noteId:'n',vaultId:vault,title:vault}],hasMore:false,nextAfterId:null}};
 });
 const knowledge=new KnowledgeClient(transport),registry=new ServiceRegistry(transport);
 const controller=new KnowledgeBrowseController({registry,knowledge});
 controller.selectVault('selected');controller.setConnection({paired:true,connected:true,instanceId:'desktop',isLive:()=>true});
 for(let i=0;i<8;i++)await settle();
 assert.equal(controller.snapshot().phase,'ready');assert.equal(controller.snapshot().vaultId,'selected');
 assert.equal(controller.snapshot().rows[0].vaultId,'selected');
 await knowledge.directories('desktop','selected');
 for(const op of ['services.discover','knowledge.vaults','knowledge.registeredList','knowledge.directories']){
  assert.equal(sent.find(req=>req.operationId===op)?.vault,'selected',op+' must carry request-local scope');
 }
});

test('unselected vault discovery remains unscoped; explicit reads override a captured different vault',async()=>{
 const {createTauriServicesTransport}=await import('../src/services/companionServices/productionTransport.ts');
 const {KnowledgeClient}=await import('../src/services/companionServices/knowledgeClient.ts');
 const sent:any[]=[];
 const invoke=async(_cmd:string,args:any)=>{sent.push(args.request);return {status:200,body:args.request.operationId==='knowledge.directories'?{vaultId:'selected',items:[],hasMore:false,nextAfterPath:null}:{items:[],hasMore:false,nextAfterId:null}};};
 const unscoped=new KnowledgeClient(createTauriServicesTransport(invoke));
 await unscoped.vaults('desktop');assert.equal(sent.at(-1).vault,undefined);
 const scoped=new KnowledgeClient(createTauriServicesTransport(invoke,{vault:'other'}));
 await scoped.vaults('desktop','selected');assert.equal(sent.at(-1).vault,'selected');
 await scoped.registeredList('desktop','selected');assert.equal(sent.at(-1).vault,'selected');
 await scoped.directories('desktop','selected');assert.equal(sent.at(-1).vault,'selected');
});

test('all target-specific knowledge requests preserve explicit scope and payload on denied production transport',async()=>{
 const {createTauriServicesTransport}=await import('../src/services/companionServices/productionTransport.ts');
 const {KnowledgeClient}=await import('../src/services/companionServices/knowledgeClient.ts');
 const sent:any[]=[];
 const client=new KnowledgeClient(createTauriServicesTransport(async(_cmd,args)=>{sent.push((args as any).request);return {status:403,body:{code:'GRANT_REQUIRED'}};},{vault:'other'}));
 const create={vaultId:'selected',opId:'op-create',title:'synthetic',content:'synthetic'};
 const editing={vaultId:'selected',sessionId:'a'.repeat(32),generation:1,editing:true};
 const move={vaultId:'selected',opId:'op-move',expectedRevision:'rev-1',parentRelativePath:'Synthetic'};
 const cases:Array<[string,()=>Promise<unknown>,unknown?]>=[
  ['knowledge.vaults',()=>client.vaults('desktop','selected')],
  ['knowledge.registeredList',()=>client.registeredList('desktop','selected')],
  ['knowledge.directories',()=>client.directories('desktop','selected')],
  ['knowledge.relations',()=>client.relations('desktop','selected','note')],
  ['knowledge.materialReferences',()=>client.materialReferences('desktop','selected','asset')],
  ['knowledge.editing',()=>client.editing('desktop','selected','note')],
  ['knowledge.registeredChanges',()=>client.registeredChanges('desktop','selected','cursor')],
  ['knowledge.createUnique',()=>client.createUnique('desktop',create as any),create],
  ['knowledge.editingOpen',()=>client.editingOpen('desktop','selected','note'),{vaultId:'selected'}],
  ['knowledge.editingSet',()=>client.editingSet('desktop','note',editing),editing],
  ['knowledge.move',()=>client.move('desktop','note',move as any),move],
 ];
 for(const [operation,call,body] of cases){
  const before=sent.length;await assert.rejects(call,(error:any)=>error.code==='GRANT_REQUIRED' && error.status===403);
  assert.equal(sent.length,before+1,'denial must never retry');const req=sent.at(-1);
  assert.equal(req.operationId,operation);assert.equal(req.vault,'selected',operation);assert.equal(req.instance,'desktop');
  if(body)assert.deepEqual(req.body,body,'scope binding cannot rewrite mutation payload, operation ID or revision');
  if(req.query.vault)assert.equal(req.query.vault,req.vault);
  if(req.path.includes('/vaults/'))assert.ok(req.path.includes('/vaults/selected/'));
 }
 const before=sent.length;
 await assert.rejects(()=>client.editingSet('desktop','note',{...editing,generation:0}),(error:any)=>error.code==='INPUT_INVALID');
 assert.equal(sent.length,before,'invalid lease update remains pre-wire rejected');
});
test('cursor expiry recovery keeps the same explicit selected vault on both production sends',async()=>{
 const {createTauriServicesTransport}=await import('../src/services/companionServices/productionTransport.ts');
 const {KnowledgeClient}=await import('../src/services/companionServices/knowledgeClient.ts');
 const sent:any[]=[];
 const client=new KnowledgeClient(createTauriServicesTransport(async(_cmd,args)=>{sent.push((args as any).request);return sent.length===1?{status:410,body:{code:'CURSOR_TOO_OLD'}}:{status:200,body:{items:[],nextCursor:'fresh'}};},{vault:'other'}));
 const result=await client.registeredChanges('desktop','selected','old');
 assert.equal(result.recovered,true);assert.equal(sent.length,2);
 assert.deepEqual(sent.map(r=>[r.vault,r.path]),Array(2).fill(['selected','/v1/services/knowledge/vaults/selected/changes']));
 assert.deepEqual(sent.map(r=>r.query),[{after:'old'},{}]);
});

test('move capability discovery follows the explicit selected vault without inventing write permission',async()=>{
 const {resolveMoveAuthority}=await import('../src/still/kit/knowledgeOrganizationController.ts');
 const scopes:any[]=[];
 const deps={registry:{refreshAdopting:async(_instance:string,scope:any)=>{scopes.push(scope);return {};},operation:()=>({state:'implemented'})},knowledge:{vaults:async(_instance:string,vault?:string)=>{scopes.push(vault);return {items:[{vaultId:vault||'active',displayName:'synthetic',activeInDesktop:!vault,readGranted:true,writeGranted:false}]};}}};
 const selected=await resolveMoveAuthority(deps as any,'desktop','selected');
 assert.equal(selected.vaultId,'selected');assert.equal(selected.writeGranted,false);
 assert.deepEqual(scopes,[{vault:'selected'},'selected']);
 scopes.length=0;const active=await resolveMoveAuthority(deps as any,'desktop');
 assert.equal(active.vaultId,'active');assert.equal(active.writeGranted,false);assert.deepEqual(scopes,[undefined,undefined]);
});
