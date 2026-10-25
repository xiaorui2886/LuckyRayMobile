import test from "node:test";
import assert from "node:assert/strict";
import { ServiceRegistry } from "../src/services/companionServices/serviceRegistry.ts";
import { ServicesReadCoordinator } from "../src/services/companionServices/readCoordinator.ts";
import { withReadBackoff } from "../src/services/companionServices/readBackoff.ts";
import { createKnowledgeEditingEffects } from "../src/services/knowledgeEditingEffects.ts";
import type { KnowledgeClient } from "../src/services/companionServices/knowledgeClient.ts";
import type { ServicesRequest, ServicesResponse } from "../src/services/companionServices/transport.ts";
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value:T) => void; const promise = new Promise<T>(r => {resolve=r;}); return {promise,resolve}; }
function catalog(instance = "desktop", permissionRevision = 1) {
  return {desktopInstanceId:instance,gatewayGeneration:1,permissionRevision,services:{knowledge:{version:1}},operations:{"knowledge.editing":{state:"implemented"}}};
}
const response = (instance = "desktop", revision = 1): ServicesResponse => ({status:200,body:catalog(instance,revision)});
const request = (operationId: string, vault = "A"): ServicesRequest => ({instance:"desktop",vault,operationId,method:"GET",path:`/v1/${operationId}`});

test("concurrent A and B discovery do not supersede each other, exact A coalesces", async () => {
  const a=deferred<ServicesResponse>(), b=deferred<ServicesResponse>(); let calls=0;
  const root=new ServiceRegistry({request:req=>{calls++;return req.vault==="A"?a.promise:b.promise;}});
  const A=root.forScope("desktop",{vault:"A"}), B=root.forScope("desktop",{vault:"B"});
  assert.equal(A,root.forScope("desktop",{vault:"A"}));
  const pa=A.refreshAdopting("desktop",{vault:"A"});
  assert.equal(pa,A.refreshAdopting("desktop",{vault:"A"}));
  const pb=B.refreshAdopting("desktop",{vault:"B"});
  b.resolve(response()); await pb; a.resolve(response()); await pa;
  assert.equal(calls,2); assert.ok(A.snapshot()); assert.ok(B.snapshot());
  assert.notEqual(A.currentNamespace(),B.currentNamespace());
  await A.ensureAdopting("desktop",{vault:"A"}); assert.equal(calls,2);
  assert.throws(()=>A.refreshAdopting("desktop",{vault:"B"}),{code:"SOURCE_CHANGED"});
});

test("same vault id on different desktops and material domain never share catalogs", async () => {
  const root=new ServiceRegistry({request:async req=>response(req.instance)});
  const entries=[root.forScope("desktop",{vault:"A"}),root.forScope("other",{vault:"A"}),root.forScope("desktop",{library:"A"})];
  await Promise.all(entries.map((entry,i)=>entry.refreshAdopting(i===1?"other":"desktop",i===2?{library:"A"}:{vault:"A"})));
  root.revoke("desktop",{vault:"A"});
  assert.equal(entries[0].snapshot(),null); assert.ok(entries[1].snapshot()); assert.ok(entries[2].snapshot());
  assert.equal(entries[0].currentRevocationRevision(),1);
});

test("permission revision change retires an older cold sibling discovery", async () => {
  const pending=deferred<ServicesResponse>(); let revision=1;
  const root=new ServiceRegistry({request:async req=>req.vault==="B"?pending.promise:response("desktop",revision)});
  const A=root.forScope("desktop",{vault:"A"}),B=root.forScope("desktop",{vault:"B"});
  await A.refreshAdopting("desktop",{vault:"A"});
  const old=B.refreshAdopting("desktop",{vault:"B"});
  const rejected=assert.rejects(old,/superseded/);
  revision=2; await A.refreshAdopting("desktop",{vault:"A"}); pending.resolve(response()); await rejected;
  assert.equal(B.snapshot(),null); assert.equal(A.permissionRevision(),2);
});

test("caller mutation after discovery launch cannot retarget adopted scope", async () => {
  const pending=deferred<ServicesResponse>(); const root=new ServiceRegistry({request:()=>pending.promise});
  const scope={vault:"A"}; const A=root.forScope("desktop",scope); const read=A.refreshAdopting("desktop",scope);
  scope.vault="B"; pending.resolve(response()); await read;
  assert.ok(A.scopeMatches({vault:"A"})); assert.equal(A.scopeMatches(scope),false);
});

test("whole-instance revocation retires all scopes including pending discovery", async () => {
  const pending=deferred<ServicesResponse>(); const root=new ServiceRegistry({request:()=>pending.promise});
  const A=root.forScope("desktop",{vault:"A"}); const read=A.refreshAdopting("desktop",{vault:"A"});
  const rejected=assert.rejects(read,/superseded/); root.revoke("desktop",undefined,true);
  pending.resolve(response()); await rejected; assert.equal(A.snapshot(),null);
});

test("presence reads reuse valid scoped capability, not forced discovery every tick", async () => {
  let discoveries=0, reads=0;
  const registry=new ServiceRegistry({request:async()=>{discoveries++; return response();}});
  const effects=createKnowledgeEditingEffects({registry,knowledge:{editing:async()=>{reads++;return {desktopEditing:false};}} as unknown as KnowledgeClient,isLive:()=>true,observe:()=>{}});
  const scope={instance:"desktop",vault:"A",note:"n"};
  await effects.readDesktop(scope); await effects.readDesktop(scope); await effects.readDesktop(scope);
  assert.equal(discoveries,1); assert.equal(reads,3);
  registry.invalidateForPermissionRevision(2,"desktop"); await effects.readDesktop(scope); assert.equal(discoveries,2);
});

test("background reads reserve a visible-navigation slot and exact reads coalesce", async () => {
  const gate=deferred<ServicesResponse>(); const starts:string[]=[];
  const coordinator=new ServicesReadCoordinator(); const transport=coordinator.wrap({request:async req=>{starts.push(req.operationId+req.vault);return gate.promise;}});
  const bg=transport.request(request("knowledge.editing"));
  assert.equal(bg,transport.request(request("knowledge.editing")));
  const bg2=transport.request(request("knowledge.relations"));
  const visible=transport.request(request("knowledge.list","B"));
  await turn(); assert.deepEqual(starts,["knowledge.editingA","knowledge.listB"]);
  gate.resolve(response()); await Promise.all([bg,bg2,visible]);
  assert.equal(starts[2],"knowledge.relationsA");
});

test("queued foreground starts before waiting background and scope remains immutable", async () => {
  const gate=deferred<ServicesResponse>(); const starts:string[]=[]; let calls=0;
  const transport=new ServicesReadCoordinator().wrap({request:async req=>{starts.push(req.operationId+req.vault);return ++calls<=2?gate.promise:response();}});
  const first=transport.request(request("knowledge.editing")); const second=transport.request(request("knowledge.list"));
  const third=transport.request(request("knowledge.relations")); const mutable=request("knowledge.directories","B"); const fourth=transport.request(mutable); mutable.vault="C";
  await turn(); gate.resolve(response()); await Promise.all([first,second,third,fourth]);
  assert.equal(starts[2],"knowledge.directoriesB");
});

test("mutations are never deduplicated or retried", async () => {
  let calls=0; const transport=new ServicesReadCoordinator().wrap(withReadBackoff({request:async()=>{calls++;return {status:429,body:{code:"RATE_LIMITED"}};}}));
  const req={...request("knowledge.editingSet"),method:"PUT" as const};
  await Promise.all([transport.request(req),transport.request(req)]); assert.equal(calls,2);
});

test("429 Retry-After is honored, bounded to one retry, longer waits surface without premature retry", async () => {
  let now=0,calls=0;const sleeps:number[]=[];
  const transport=withReadBackoff({request:async()=>{calls++;return {status:429,body:{code:"RATE_LIMITED"},retryAfterMs:3500};}},{now:()=>now,sleep:async ms=>{sleeps.push(ms);now+=ms;}});
  assert.equal((await transport.request(request("knowledge.list"))).status,429);assert.equal(calls,2);assert.deepEqual(sleeps,[3500]);
  calls=0; const long=withReadBackoff({request:async()=>{calls++;return {status:429,body:{},retryAfterMs:45000};}});
  await long.request(request("knowledge.list"));assert.equal(calls,1);
  await assert.rejects(long.request(request("knowledge.editing")), {code:"RATE_LIMITED"});assert.equal(calls,1);
});

test("invalidation partitions in-flight dedup and fences stale queued reads", async () => {
  const gate=deferred<ServicesResponse>(); let calls=0;
  const transport=new ServicesReadCoordinator().wrap({request:async()=>{calls++;return calls===1?gate.promise:response();}});
  const old=transport.request(request("knowledge.list")); const rejected=assert.rejects(old,{code:"SOURCE_CHANGED"});
  await turn(); transport.invalidate?.("desktop",{vault:"A"});
  const fresh=transport.request(request("knowledge.list")); assert.notEqual(old,fresh); await fresh;
  gate.resolve(response()); await rejected; assert.equal(calls,2);
});

test("invalidation while waiting Retry-After prevents the old retry send", async () => {
  const gate=deferred<void>();let calls=0, now=0;
  const transport=withReadBackoff({request:async()=>{calls++;return {status:429,body:{},retryAfterMs:1000};}},
    {now:()=>now,sleep:async ms=>{await gate.promise;now+=ms;}});
  const old=transport.request(request("knowledge.list"));const rejected=assert.rejects(old,{code:"SOURCE_CHANGED"});
  await turn();transport.invalidate?.("desktop",{vault:"A"});gate.resolve();await rejected;assert.equal(calls,1);
});

test("GET body-bearing requests are not incorrectly merged", async () => {
  let calls=0;const transport=new ServicesReadCoordinator().wrap({request:async()=>{calls++;return response();}});
  await Promise.all([transport.request({...request("knowledge.list"),body:{predicate:"one"}}),
    transport.request({...request("knowledge.list"),body:{predicate:"two"}})]);
  assert.equal(calls,2);
});

import { createTauriServicesTransport } from "../src/services/companionServices/productionTransport.ts";
import { KnowledgeClient as RealKnowledgeClient } from "../src/services/companionServices/knowledgeClient.ts";

test("real registry and knowledge client preserve scope through scheduler and production Tauri payload", async () => {
  const sent: Array<{command:string; payload:any}> = [];
  const native = createTauriServicesTransport(async (command,args) => {
    const payload=args!.request as any; sent.push({command,payload});
    if (payload.operationId === "services.discover") return response(payload.instance);
    return {status:200,body:{vaultId:payload.vault,items:[{parentRelativePath:payload.vault}],hasMore:false,nextAfterPath:null}};
  });
  const scheduled = new ServicesReadCoordinator().wrap(withReadBackoff(native));
  const root = new ServiceRegistry(scheduled), knowledge = new RealKnowledgeClient(scheduled);
  await Promise.all(["A","B"].map(async vault => {
    await root.forScope("desktop",{vault}).refreshAdopting("desktop",{vault});
    const result=await knowledge.directories("desktop",vault,{limit:10,afterPath:""});
    assert.equal(result.vaultId,vault); assert.equal(result.items[0].parentRelativePath,vault);
  }));
  assert.equal(sent.length,4);
  for (const {command,payload} of sent) {
    assert.equal(command,"services_v1_request"); assert.equal(payload.instance,"desktop");
    assert.ok(["A","B"].includes(payload.vault)); assert.equal(payload.library,undefined);
    if (payload.operationId === "knowledge.directories") {
      assert.equal(payload.path,`/v1/services/knowledge/vaults/${payload.vault}/directories`);
      assert.deepEqual(payload.query,{limit:"10",afterPath:""});
    }
  }
});

test("production native Retry-After bridge feeds bounded shared GET cooldown", async () => {
  let now=0,calls=0;const sleeps:number[]=[];
  const native=createTauriServicesTransport(async()=>{calls++;return calls===1?{status:429,body:{code:"RATE_LIMITED"},retry_after_ms:2500}:response();});
  const scheduled=new ServicesReadCoordinator().wrap(withReadBackoff(native,{now:()=>now,sleep:async ms=>{sleeps.push(ms);now+=ms;}}));
  assert.equal((await scheduled.request(request("knowledge.list"))).status,200);
  assert.equal(calls,2);assert.deepEqual(sleeps,[2500]);
});

test("a stalled desktop cannot consume another desktop's visible read lanes", async () => {
  const gate=deferred<ServicesResponse>();const starts:string[]=[];
  const transport=new ServicesReadCoordinator().wrap({request:async req=>{starts.push(req.instance);return req.instance==="desktop"?gate.promise:response(req.instance);}});
  const a=transport.request(request("knowledge.list")), b=transport.request(request("knowledge.directories"));
  await turn(); const other=transport.request({...request("knowledge.list"),instance:"other"});
  await other; assert.deepEqual(starts,["desktop","desktop","other"]);
  gate.resolve(response());await Promise.all([a,b]);
});

test("a concurrent shorter Retry-After cannot shorten the desktop cooldown", async () => {
  const long=deferred<ServicesResponse>(),short=deferred<ServicesResponse>();let calls=0;const sleeps:number[]=[];
  const transport=withReadBackoff({request:()=>++calls===1?long.promise:short.promise},
    {now:()=>0,sleep:async ms=>{sleeps.push(ms);}});
  const a=transport.request(request("knowledge.list")), b=transport.request(request("knowledge.editing"));
  const rejected=assert.rejects(b,{code:"RATE_LIMITED"});
  long.resolve({status:429,body:{},retryAfterMs:45000});await a;
  short.resolve({status:429,body:{},retryAfterMs:1000});await rejected;
  await assert.rejects(transport.request(request("knowledge.directories")),{code:"RATE_LIMITED"});
  assert.equal(calls,2);assert.deepEqual(sleeps,[]);
});

import { createCompanionServices } from "../src/services/companionServices/index.ts";
test("actual write-only GRANT_REQUIRED denies that operation without blanking granted reads", async () => {
  const services=createCompanionServices({request:async req=> req.operationId==="services.discover"
    ? {status:200,body:{...catalog(),operations:{"knowledge.editing":{state:"implemented"},"knowledge.editingSet":{state:"implemented"}}}}
    : {status:403,body:{code:"GRANT_REQUIRED"}}});
  const owner=services.registry.forScope("desktop",{vault:"A"});await owner.refreshAdopting("desktop",{vault:"A"});
  const epoch=owner.currentSecurityRevision();
  await assert.rejects(services.knowledge.editingSet("desktop","note",{vaultId:"A",sessionId:"a".repeat(32),generation:1,editing:true}),{code:"GRANT_REQUIRED"});
  assert.equal(owner.currentSecurityRevision(),epoch);assert.equal(owner.canCall("knowledge.editing"),true);
  assert.equal(owner.operation("knowledge.editingSet").state,"notGranted");
});

test("cold scoped permission hint changes the captured security epoch before late discovery", async () => {
  const gate=deferred<ServicesResponse>();const root=new ServiceRegistry({request:()=>gate.promise});
  const owner=root.forScope("desktop",{vault:"A"});const epoch=owner.currentSecurityRevision();
  const pending=owner.refreshAdopting("desktop",{vault:"A"});const rejected=assert.rejects(pending,/superseded/);
  owner.invalidateForPermissionRevision(2);assert.notEqual(owner.currentSecurityRevision(),epoch);
  gate.resolve(response());await rejected;assert.equal(owner.snapshot(),null);
});

import { KnowledgeBrowseController } from "../src/still/kit/knowledgeBrowseController.ts";
test("real browse registry notifications are bounded and unchanged authority never re-enters discovery", async () => {
  let discoveries=0,revision=1,lists=0;
  const root=new ServiceRegistry({request:async()=>{discoveries++;return {status:200,body:{...catalog("desktop",revision),operations:{"knowledge.vaults":{state:"implemented"},"knowledge.registeredList":{state:"implemented"}}}};}});
  const controller=new KnowledgeBrowseController({registry:root,knowledge:{
    vaults:async()=>({items:[{vaultId:"A",displayName:"A",activeInDesktop:true,readGranted:true}]}),
    registeredList:async()=>{lists++;return {items:[{noteId:"a",title:"Only A"}],hasMore:false};},
  } as unknown as KnowledgeClient});
  controller.selectVault("A");controller.setConnection({paired:true,connected:true,instanceId:"desktop",isLive:()=>true});
  for(let i=0;i<4;i++)await turn();assert.equal(discoveries,1);assert.equal(lists,1);
  await root.forScope("desktop",{vault:"A"}).refreshAdopting("desktop",{vault:"A"});
  for(let i=0;i<4;i++)await turn();assert.equal(discoveries,2);assert.equal(lists,1);
  revision=2;root.invalidateForPermissionRevision(2,"desktop");
  assert.equal(controller.snapshot().rows.length,0,"permission changes clear synchronously");
  for(let i=0;i<4;i++)await turn();assert.equal(discoveries,2,"revocation notification does not recursively discover");
  controller.refresh();for(let i=0;i<6;i++)await turn();
  assert.equal(discoveries,3,"one explicit recovery shares its catalog with bounded epoch revalidation");
  assert.equal(controller.snapshot().rows[0]?.noteId,"a");
});
