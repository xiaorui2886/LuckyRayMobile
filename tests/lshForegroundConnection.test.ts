import test from 'node:test';
import assert from 'node:assert/strict';
import { foregroundConnection } from '../src/services/foregroundConnection.ts';
import { LshEmbeddedController } from '../src/still/kit/lshEmbedded.ts';
const bounds={x:0,y:24,width:360,height:600,viewportWidth:360};
const ready={opened:true,visible:true,ready:true,canGoBack:false};
test('overlapping focus and visibility share native intent-gated resume and read back afterward',async()=>{
 let release!:()=>void;const calls:string[]=[];
 const resume=foregroundConnection(async()=>{calls.push('conn_resume');await new Promise<void>(r=>release=r);return{status:'skipped_manual_stop'}},async()=>{calls.push('read_state')});
 const a=resume(),b=resume();assert.equal(a,b);assert.deepEqual(calls,['conn_resume']);release();await a;assert.deepEqual(calls,['conn_resume','read_state']);
 const c=resume();release();await c;assert.equal(calls.length,4);
});
test('resume transport error still reads real state and is retryable on next foreground',async()=>{
 let reads=0;const resume=foregroundConnection(async()=>{throw Error('offline')},async()=>{reads++});await resume();await resume();assert.equal(reads,2);
});
test('hidden time cannot exhaust the finite presentation budget',async()=>{
 let now=0;const c=new LshEmbeddedController({bootstrap:async()=>({sessionUrl:'opaque'}),embed:async()=>({...ready,ready:false})},100,()=>now);
 await c.attach('A',bounds,false);now=30;await c.hide();now=10000;await c.attach('A',bounds,false);assert.equal(c.snapshot().phase,'loading');now=10069;await c.poll();assert.equal(c.snapshot().phase,'loading');now=10071;await c.poll();assert.equal(c.snapshot().error,'LSH_PRESENTATION_TIMEOUT');
});
test('fresh authorized activation rebuilds one failed page but does not retry capability failure',async()=>{
 const calls:string[]=[];let failed=false,boots=0;
 const c=new LshEmbeddedController({bootstrap:async()=>{boots++;return{sessionUrl:'opaque'}},embed:async r=>{calls.push(r.action);return failed?{...ready,error:'LSH_PAGE_LOAD_FAILED'}:ready}});
 await c.attach('A',bounds,false);await c.hide();failed=true;await c.attach('A',bounds,false);assert.equal(boots,2);assert.equal(c.snapshot().phase,'error');await c.attach('A',{...bounds,height:500},false);assert.equal(boots,2,'same activation cannot loop');
 const cap=new LshEmbeddedController({bootstrap:async()=>({sessionUrl:'opaque'}),embed:async()=>({...ready,error:'LSH_WEBVIEW_UPDATE_REQUIRED'})});await cap.attach('A',bounds,false);await cap.hide();await cap.attach('A',bounds,false);assert.equal(cap.snapshot().error,'LSH_WEBVIEW_UPDATE_REQUIRED');
});
