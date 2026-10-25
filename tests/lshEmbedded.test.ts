import test from 'node:test';
import assert from 'node:assert/strict';
import { LshEmbeddedController, usableLshBounds } from '../src/still/kit/lshEmbedded.ts';
const bounds = { x:0, y:24, width:360, height:600, viewportWidth:360 };
const receipt = { opened:true, visible:true, ready:true, canGoBack:false };
function rig() {
  const calls:any[]=[];
  const controller = new LshEmbeddedController({bootstrap:async owner=>{calls.push(['bootstrap',owner]);return {sessionUrl:'http://127.0.0.1:1/opaque'};},embed:async r=>{calls.push(r);return receipt;}});
  return {controller,calls};
}
test('bounds fail closed on NaN, negative and zero content geometry',()=>{
  assert.equal(usableLshBounds(bounds),true);
  for(const value of [NaN,Infinity,-1,0]) assert.equal(usableLshBounds({...bounds,width:value}),false);
});
test('direct open uses opaque bootstrap then native view without chat protocol',async()=>{
  const {controller,calls}=rig();await controller.attach('A',bounds,false);
  assert.equal(calls[0][0],'bootstrap');assert.equal(calls[1].action,'open');
  assert.equal(controller.snapshot().phase,'ready');
});
test('tab hide retains same session and returning only lays out',async()=>{
  const {controller,calls}=rig();await controller.attach('A',bounds,false);await controller.hide();await controller.attach('A',bounds,true);
  assert.equal(calls.filter(c=>c[0]==='bootstrap').length,1);
  assert.deepEqual(calls.filter(c=>c.action).map(c=>c.action),['open','hide','layout']);
});
test('owner switch closes old view before new bootstrap',async()=>{
  const {controller,calls}=rig();await controller.attach('A',bounds,false);await controller.attach('B',bounds,false);
  assert.equal(calls[2].action,'close');assert.equal(calls[2].expectedInstance,'A');assert.deepEqual(calls[3],['bootstrap','B']);
});
test('unmount while bootstrap pending retires exact unopened launch',async()=>{
  let resolve!:(v:{sessionUrl:string})=>void;const calls:any[]=[];
  const controller=new LshEmbeddedController({bootstrap:()=>new Promise(r=>resolve=r),embed:async r=>{calls.push(r);return receipt;}});
  const attach=controller.attach('A',bounds,false);await Promise.resolve();const hidden=controller.hide();resolve({sessionUrl:'opaque'});await attach;await hidden;
  assert.equal(calls.some(c=>c.action==='open'),false);assert.deepEqual(calls[0],{action:'close',expectedInstance:'A',sessionUrl:'opaque'});
});
test('concurrent layout coalesces stale queued dimensions',async()=>{
  const {controller,calls}=rig();const a=controller.attach('A',bounds,false);const b=controller.attach('A',{...bounds,height:300},false);await a;await b;
  assert.equal(calls.filter(c=>c.action==='open').length,1);assert.equal(calls[1].bounds.height,300);
});
test('native refusal is a real error, never false ready',async()=>{
  const controller=new LshEmbeddedController({bootstrap:async()=>({sessionUrl:'opaque'}),embed:async()=>({...receipt,opened:false})});
  await controller.attach('A',bounds,false);assert.equal(controller.snapshot().phase,'error');
});
test('page load failure is surfaced without manufactured messages',async()=>{
  const controller=new LshEmbeddedController({bootstrap:async()=>({sessionUrl:'opaque'}),embed:async()=>({...receipt,error:'LSH_PAGE_LOAD_FAILED'})});
  await controller.attach('A',bounds,false);assert.equal(controller.snapshot().error,'LSH_PAGE_LOAD_FAILED');
});
test('hidden page does not poll or consume remote data',async()=>{
  const {controller,calls}=rig();await controller.attach('A',bounds,false);await controller.hide();const n=calls.length;await controller.poll();assert.equal(calls.length,n);
});
test('close resets presentation without altering desktop sessions',async()=>{
  const {controller,calls}=rig();await controller.attach('A',bounds,false);await controller.close();assert.equal(controller.snapshot().phase,'idle');assert.equal(calls.at(-1).action,'close');
});
test('native overlay Back stays in the app surface',async()=>{
 const c=new LshEmbeddedController({bootstrap:async()=>({sessionUrl:'opaque'}),embed:async()=>({...receipt,backHandled:true})});
 await c.attach('A',bounds,false);assert.equal(await c.back(),true);
});
test('unhandled native Back can return to app root',async()=>{
 const {controller}=rig();await controller.attach('A',bounds,false);assert.equal(await controller.back(),false);
});
test('unknown Back outcome never causes a second root navigation',async()=>{
 const c=new LshEmbeddedController({bootstrap:async()=>({sessionUrl:'opaque'}),embed:async r=>{if(r.action==='back') throw new Error('LSH_BACK_OUTCOME_UNKNOWN');return receipt;}});
 await c.attach('A',bounds,false);assert.equal(await c.back(),true);assert.equal(c.snapshot().phase,'ready');
});

test('ready mount is fenced to the currently paired owner, not a stale permission snapshot',async()=>{
  const {readFileSync}=await import('node:fs');
  const source=readFileSync(new URL('../src/still/StillAgent.tsx',import.meta.url),'utf8');
  assert.match(source,/const lshReady = !permissionLoading && !permissionError && foreground && conn\?\.paired === true && conn\.ws\.state === "connected" && conn\.identity\?\.instanceId === snap\.instanceId && snap\.canUseLsh && lshSnap\.identity === snap\.instanceId && lshSnap\.granted && lshSnap\.runtimeAvailable/);
});
