import test from "node:test";
import assert from "node:assert/strict";
import { materialApi } from "../src/services/client.ts";
const calls: Array<{command:string;args:any}> = [];
(globalThis as any).window={__TAURI_INTERNALS__:{invoke:async(command:string,args:any)=>{calls.push({command,args});return {};}}};
test("bound native adapter pins library through optional argument gaps and later selection changes",async()=>{
 const a=materialApi("a"),b=materialApi("b");
 await a.assetThumbnail("owner","id");await a.contentAssetFile("owner","id","job");await a.contentCachedResource("owner","id");await a.contentMaterialCreateTag("owner","tag");await a.contentMaterialBatch("owner",{assetIds:["id"],folderChange:false});await b.contentNavigation("owner");await a.contentVideoPlay("owner","id","job","title",0);
 assert.deepEqual(calls.map(call=>call.args.library),["a","a","a","a","a","b","a"]);
 assert.equal(calls[0].args.force,false);assert.equal(calls[0].args.preview,false);assert.equal(calls[1].args.maxBytes,undefined);assert.equal(calls[2].args.vault,undefined);assert.equal(calls[3].args.color,null);assert.equal(calls[6].args.darkMode,false);
});

test("read-only selection refuses mutations without native invocation but preserves reads",async()=>{
 const readOnly=materialApi("locked",false),before=calls.length;
 await assert.rejects(readOnly.contentMaterialSetFavorite("owner","id",true),/LIBRARY_READ_ONLY/);
 await assert.rejects(readOnly.contentMaterialBatch("owner",{assetIds:["id"],folderChange:false}),/LIBRARY_READ_ONLY/);
 assert.equal(calls.length,before);await readOnly.contentAssetDetail("owner","id");assert.equal(calls.at(-1)?.args.library,"locked");
});

import { createTauriServicesTransport } from "../src/services/companionServices/productionTransport.ts";
import { createHintSubscription, toHint } from "../src/services/companionServices/hintSubscription.ts";
test("services transport snapshots selected scopes, including later request/retry",async()=>{
 const selected={library:"a",vault:"x"},sent:any[]=[];
 const transport=createTauriServicesTransport(async(_cmd,args)=>{sent.push(args);return {status:200,body:{}};},selected);
 selected.library="b";selected.vault="y";
 await transport.request({instance:"owner",operationId:"services.discover",method:"GET",path:"/v1/services"});
 assert.equal(sent[0].request.library,"a");assert.equal(sent[0].request.vault,"x");
});
test("hint subscription retains scope IDs and drops another library, vault or job without inventing generation",async()=>{
 const selected={library:"a",vault:"x"};const sub=createHintSubscription(async(cmd)=>cmd==="services_hints_state"?[
   {generation:8,hint:{kind:"materialChanged",cursor:"1",materialLibraryId:"a"}},
   {generation:8,hint:{kind:"materialChanged",cursor:"2",materialLibraryId:"b"}},
   {generation:8,hint:{kind:"knowledgeChanged",cursor:"3",vaultId:"y"}},
   {generation:8,hint:{kind:"ingestChanged",jobId:"ok",vaultId:"x"}},
   {generation:8,hint:{kind:"ingestChanged",jobId:"foreign",materialLibraryId:"b"}},
   {hint:{kind:"materialChanged",cursor:"missing-generation",materialLibraryId:"a"}}
 ]: {},selected);selected.library="b";
 const hints=await sub.drain({instance:"owner",generation:8});assert.equal(hints.length,2);assert.ok(hints.every(x=>x.generation===8));
 assert.deepEqual(toHint({kind:"ingestChanged",jobId:"job",materialLibraryId:"a"}),{kind:"ingestChanged",jobId:"job",materialLibraryId:"a"});
});

import { failureCopy, failureIsRetryable } from "../src/services/feedback.ts";
test("re-pair parked edits have truthful copy without suggesting nonexistent review UI or destructive recovery",()=>{
 const copy=failureCopy("CONTENT_PAIRING_REVIEW_REQUIRED");assert.match(copy,/保留/);assert.match(copy,/不会自动上传/);assert.match(copy,/恢复处理/);assert.doesNotMatch(copy,/点击|重新连接|删除|清除/);assert.equal(failureIsRetryable("CONTENT_PAIRING_REVIEW_REQUIRED"),false);
});

import { SyncCoordinator } from "../src/services/syncCoordinator.ts";
test("parked pairing edits surface nonfatal attention after successful reads, not a false sync success",async()=>{
 const coordinator=new SyncCoordinator(async()=>({applied:1,pushed:0,continuation:false,pairingReviewRequired:true,warningCode:"CONTENT_PAIRING_REVIEW_REQUIRED"}),{foundationBlocked:false,contentOnly:true});
 await assert.doesNotReject(coordinator.run());assert.equal(coordinator.snapshot().error,"CONTENT_PAIRING_REVIEW_REQUIRED");assert.equal(coordinator.snapshot().status,"error");
});
