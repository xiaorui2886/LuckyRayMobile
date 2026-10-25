import { test } from "node:test";
import assert from "node:assert/strict";
import { createKnowledgeDiagnostics, nativeKnowledgeTraceSink } from "../src/services/companionServices/knowledgeDiagnostics.ts";

const parse = (lines: string[]) => lines.map(line => JSON.parse(line.slice("[LR-KNOW-DIAG] ".length)));
test("knowledge diagnostics are quiet by default and reject unrelated operations", () => {
  const lines: string[] = [];
  createKnowledgeDiagnostics(false, {sink: line => lines.push(line)}).begin("knowledge.vaults", "v")({phase:"reply",status:200});
  createKnowledgeDiagnostics(true, {sink: line => lines.push(line)}).begin("terminal.execute", "v")({phase:"reply",status:200});
  assert.deepEqual(lines, []);
});
test("live vault catalog records exact selected active metadata without serializing private data", () => {
  const lines: string[] = []; let now = 1000;
  const d = createKnowledgeDiagnostics(true, {sink: line => lines.push(line), now: () => now});
  const done = d.begin("knowledge.vaults", "selected-private-vault-id"); now = 1250;
  done({phase:"reply",status:200,body:{items:[{vaultId:"other",activeInDesktop:true},{vaultId:"selected-private-vault-id",activeInDesktop:false,displayName:"private title",token:"private-token",content:"private body"}]}});
  const [start, end] = parse(lines);
  assert.equal(start.phase, "request"); assert.equal(end.id, start.id); assert.equal(end.elapsedMs, 250);
  assert.equal(end.selectedTargetFound, true); assert.equal(end.selectedIsDesktopActive, false);
  assert.equal(end.scope, "explicit"); assert.match(end.targetRef, /^[0-9a-f]{8}$/);
  for (const secret of ["selected-private-vault-id", "private title", "private-token", "private body"]) assert(!lines.join().includes(secret));
});
test("active selected and missing target are distinct from unselected discovery", () => {
  const lines: string[] = []; const d = createKnowledgeDiagnostics(true, {sink: line => lines.push(line)});
  d.begin("knowledge.vaults", "v")({phase:"reply",status:200,body:{items:[{vaultId:"v",activeInDesktop:true}]}});
  d.begin("knowledge.vaults", "missing")({phase:"reply",status:200,body:{items:[{vaultId:"v",activeInDesktop:true}]}});
  d.begin("knowledge.vaults")({phase:"reply",status:200,body:{items:[{vaultId:"v",activeInDesktop:true}]}});
  const rows = parse(lines); assert.equal(rows[1].selectedIsDesktopActive,true);
  assert.equal(rows[3].selectedTargetFound,false); assert(!("selectedIsDesktopActive" in rows[3]));
  assert.equal(rows[5].scope,"unselected"); assert.equal(rows[5].targetRef,null); assert(!("selectedTargetFound" in rows[5]));
});
test("HTTP replies and local refusals remain distinct and unknown error strings are removed", () => {
  const lines: string[] = []; const d = createKnowledgeDiagnostics(true, {sink: line => lines.push(line)});
  d.begin("knowledge.directories","v")({phase:"reply",status:503,code:"SERVICE_UNAVAILABLE",body:{secret:"not logged"}});
  d.begin("services.discover","v")({phase:"refusal",status:0,code:"TRANSPORT_FAILED"});
  d.begin("services.discover","v")({phase:"invalid-reply",status:NaN,code:"secret arbitrary error"});
  const rows=parse(lines); assert.equal(rows[1].httpStatus,503); assert.equal(rows[1].code,"SERVICE_UNAVAILABLE");
  assert.equal(rows[3].httpStatus,0); assert.equal(rows[3].phase,"refusal");
  assert.equal(rows[5].httpStatus,0); assert.equal(rows[5].code,"UNKNOWN");
  assert(!lines.join().includes("secret"));
});
test("diagnostics cannot grow indefinitely or turn response content into logs", () => {
  const lines: string[] = []; const d=createKnowledgeDiagnostics(true,{limit:3,sink:line=>lines.push(line)});
  const body: Record<string,unknown>={private:"do not serialize"};body.self=body;
  for(let i=0;i<20;i++)d.begin("knowledge.registeredList","v")({phase:"reply",status:200,body});
  assert.equal(lines.length,3);assert(!lines.join().includes("do not serialize"));
});
test("diagnostic sink failure never changes successful request control flow", () => {
  const d=createKnowledgeDiagnostics(true,{sink:()=>{throw Error("unavailable console")}});
  assert.doesNotThrow(()=>d.begin("knowledge.vaults","v")({phase:"reply",status:200,body:{items:[]}}));
});
test("release diagnostics reuse native logging with only sanitized metadata", async () => {
  const calls: {command: string; args: Record<string, unknown>}[] = [];
  const sink=nativeKnowledgeTraceSink(async (command,args)=>{calls.push({command,args});return "ok"});
  createKnowledgeDiagnostics(true,{sink}).begin("knowledge.vaults","private-id")({phase:"reply",status:200,body:{items:[],private:"private body"}});
  await Promise.resolve();assert.equal(calls.length,2);assert(calls.every(x=>x.command==="mq_log"));
  assert(!JSON.stringify(calls).includes("private-id"));assert(!JSON.stringify(calls).includes("private body"));
});
test("rejected native logging is consumed without changing request outcome", async () => {
  const sink=nativeKnowledgeTraceSink(async()=>{throw Error("native view retired")});
  assert.doesNotThrow(()=>createKnowledgeDiagnostics(true,{sink}).begin("services.discover","v")({phase:"refusal",status:0,code:"TRANSPORT_FAILED"}));
  await new Promise(resolve=>setTimeout(resolve,0));
});
