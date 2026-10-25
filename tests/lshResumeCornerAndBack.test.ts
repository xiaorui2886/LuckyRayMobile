import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LshEmbeddedController, type LshEmbedReceipt } from '../src/still/kit/lshEmbedded.ts';
const bounds={x:0,y:24,width:360,height:600,viewportWidth:360};
const ready:LshEmbedReceipt={opened:true,visible:true,ready:true,canGoBack:false};
const tick=async()=>{for(let i=0;i<20;i++)await Promise.resolve()};
for(const interruption of ['hide','suspend','close','replace','same-owner-return'] as const){
 test(`old Back is consumed after ${interruption}`,async()=>{
  let release!:(value:LshEmbedReceipt)=>void;
  const c=new LshEmbeddedController({bootstrap:async()=>({sessionUrl:'fixture'}),embed:async r=>r.action==='back'?new Promise(resolve=>{release=resolve}):ready});
  await c.attach('A',bounds,false);const back=c.back();await tick();assert.equal(typeof release,'function');
  const next=interruption==='hide'?c.hide():interruption==='suspend'?c.suspend('A',bounds,false):interruption==='close'?c.close():interruption==='replace'?c.attach('B',bounds,false):Promise.all([c.hide(),c.attach('A',bounds,false)]);
  release({...ready,backHandled:false});assert.equal(await back,true,'obsolete Back must not navigate a new visit');await next;
 });
}
test('Back queued behind status cannot navigate after hiding',async()=>{
 let release!:(v:LshEmbedReceipt)=>void;let calls=0;
 const c=new LshEmbeddedController({bootstrap:async()=>({sessionUrl:'fixture'}),embed:async r=>{if(r.action==='status')return new Promise(resolve=>{release=resolve});if(r.action==='back')calls++;return ready}});
 await c.attach('A',bounds,false);const poll=c.poll();await tick();const back=c.back(),hide=c.hide();release(ready);await poll;assert.equal(await back,true);await hide;assert.equal(calls,0);
});
test('timeout cleanup cannot publish or navigate after a newer activation',async()=>{
 let now=0,release!:(v:LshEmbedReceipt)=>void;const states:string[]=[];
 const c=new LshEmbeddedController({bootstrap:async()=>({sessionUrl:'fixture'}),embed:async r=>{if(r.action==='hide')return new Promise(resolve=>{release=resolve});return {...ready,ready:r.expectedInstance==='B',backHandled:false}}},1000,()=>now);
 await c.attach('A',bounds,false);now=1500;const back=c.back();await tick();assert.equal(typeof release,'function');
 c.subscribe(()=>states.push(c.snapshot().error));const next=c.attach('B',bounds,false);release(ready);
 assert.equal(await back,true);await next;assert.ok(!states.includes('LSH_PRESENTATION_TIMEOUT'));assert.equal(c.isReadyFor('B'),true);
});
test('current unhandled Back remains available to root navigation',async()=>{
 const c=new LshEmbeddedController({bootstrap:async()=>({sessionUrl:'fixture'}),embed:async()=>({...ready,backHandled:false})});await c.attach('A',bounds,false);assert.equal(await c.back(),false);
});
test('unknown native Back failure is consumed without double navigation',async()=>{
 const c=new LshEmbeddedController({bootstrap:async()=>({sessionUrl:'fixture'}),embed:async r=>{if(r.action==='back')throw Error('fixture');return ready}});await c.attach('A',bounds,false);assert.equal(await c.back(),true);
});
test('resume label anchors inside the bottom-right native content bounds',()=>{
 const source=readFileSync(new URL('../scripts/android-src/LshEmbeddedSurface.kt',import.meta.url),'utf8');
 assert.match(source,/frame\.addView\(suspensionLabel, FrameLayout\.LayoutParams\(-2, -2, android\.view\.Gravity\.BOTTOM or android\.view\.Gravity\.END\)/);
 assert.match(source,/marginEnd = inset; bottomMargin = inset/);
 assert.match(source,/maxWidth = \(width - 2 \* inset\)\.coerceAtLeast\(1\)/);
 assert.match(source,/now - suspensionBegan >= 700L/,'preserve quiet delayed presentation');
 assert.match(source,/ACCESSIBILITY_LIVE_REGION_POLITE/);
});
