import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LshEmbeddedController, lshDeadline } from '../src/still/kit/lshEmbedded.ts';
const b = { x:0,y:24,width:360,height:600,viewportWidth:360 };
const ready = {opened:true, visible:true, ready:true, canGoBack:false};
const pending = {...ready,ready:false,visible:false};
const never = () => new Promise<any>(()=>{});
const read=(p:string)=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('pending bootstrap terminates and close/retry do not queue forever', async()=>{
 let attempts=0;
 const c=new LshEmbeddedController({bootstrap:()=>++attempts===1?never():Promise.resolve({sessionUrl:'opaque'}), embed:async()=>ready},15);
 await c.attach('A',b,false);
 assert.equal(c.snapshot().error,'LSH_BOOTSTRAP_TIMEOUT');
 await c.close(); await c.attach('A',b,false);
 assert.equal(c.snapshot().phase,'ready'); assert.equal(attempts,2);
});
test('pending native open times out but still leaves owner available for cleanup',async()=>{
 const calls:string[]=[];
 const c=new LshEmbeddedController({bootstrap:async()=>({sessionUrl:'opaque'}),embed:async r=>{calls.push(r.action);return r.action==='open'?never():ready;}},15);
 await c.attach('A',b,false); assert.equal(c.snapshot().error,'LSH_NATIVE_TIMEOUT');
 await c.close(); assert.equal(c.snapshot().phase,'idle'); assert.equal(calls.at(-1),'close');
});
test('readiness never turns true just because page deadline elapsed',async()=>{
 let now=0;const c=new LshEmbeddedController({bootstrap:async()=>({sessionUrl:'opaque'}),embed:async()=>pending},100,()=>now);
 await c.attach('A',b,false); now=101; await c.poll();
 assert.equal(c.snapshot().error,'LSH_PRESENTATION_TIMEOUT');
 await c.poll(); assert.equal(c.snapshot().phase,'error');
});
test('late bootstrap receipt only asks retirement of its exact opaque launch',async()=>{
 let resolve!:(v:{sessionUrl:string})=>void; const calls:any[]=[];
 const c=new LshEmbeddedController({bootstrap:()=>new Promise(r=>resolve=r),embed:async r=>{calls.push(r);return ready;}},15);
 await c.attach('A',b,false); await c.close(); resolve({sessionUrl:'old-opaque'}); await new Promise(r=>setTimeout(r,0));
 assert.deepEqual(calls,[{action:'close',expectedInstance:'A',sessionUrl:'old-opaque'}]);
 assert.equal(c.snapshot().phase,'idle');
});
test('ordinary bridge errors propagate unchanged without leaking text into logs',async()=>{
 await assert.rejects(lshDeadline(Promise.reject(new Error('CONTENT_SOURCE_CHANGED')),10,'timeout'),/CONTENT_SOURCE_CHANGED/);
});
test('native page deadline does not depend on navigation or JS callback completing',()=>{
 const n=read('scripts/android-src/LshEmbeddedSurface.kt');
 const arm=n.indexOf('armPresentationDeadline(browser)');
 const preflight=n.indexOf('browser.loadDataWithBaseURL');
 assert(arm>=0 && preflight>arm, 'deadline is armed before even the capability page');
 assert.match(n,/val launch = pendingCapabilityUrl\s+pendingCapabilityUrl = ""\s+view.loadUrl\(launch\)/);
 assert.match(n,/LSH_WEBVIEW_UPDATE_REQUIRED/);
 assert.match(n,/deadline == deadlineGeneration && presentationActive && !ready && !failed/);
 assert.match(n,/40_000L/); assert.match(n,/task.get\(5, TimeUnit.SECONDS\)/);
 assert.match(n,/task.cancel\(false\)/); assert.match(n,/lease == request.optString\("lease"\)/);
});
test('backend cancels bootstrap and unused-launch close returns before native view mutation',()=>{
 const s=read('src-tauri/src/lsh_surface.rs');
 assert.match(s,/timeout\(std::time::Duration::from_secs\(35\), bootstrap_surface/);
 const close=s.slice(s.indexOf('if action == "close" {'),s.indexOf('let mut request = json!'));
 assert.match(close,/claim_current_launch\(url\)/);assert.match(close,/return Ok\(json!/);
});
test('idle geometry receives recovery UI and position remeasurement, preserving WV83 fallback',()=>{
 const v=read('src/still/kit/EmbeddedLshView.tsx');
 assert.match(v,/state.phase !== 'loading' && state.phase !== 'idle'/);
 assert.match(v,/place\(\); if \(!suspended\) void surface.poll\(\)/);
 assert.match(v,/LSH_LAYOUT_NOT_READY/);
 const css=read('src/still/kit/embeddedLsh.css');
 for(const side of ['top','right','bottom','left']) assert.ok(css.includes(side+': 0'));
});

test('later navigation gets a fresh presentation budget and can become ready',async()=>{
 let now=0, loading=false; const c=new LshEmbeddedController({bootstrap:async()=>({sessionUrl:'opaque'}),embed:async()=>loading?pending:ready},100,()=>now);
 await c.attach('A',b,false); now=1000; loading=true; await c.poll();
 assert.equal(c.snapshot().phase,'loading'); now=1050; loading=false; await c.poll();
 assert.equal(c.snapshot().phase,'ready');
});

test('terminal native status failure hides old view before presenting reconnect',async()=>{
 const actions:string[]=[]; const c=new LshEmbeddedController({bootstrap:async()=>({sessionUrl:'opaque'}),embed:async r=>{
 actions.push(r.action);if(r.action==='status')throw new Error('LSH_EMBED_JVM');return ready;
 }});
 await c.attach('A',b,false); await c.poll();
 assert.equal(c.snapshot().phase,'error'); assert.deepEqual(actions,['open','status','hide']);
});

test('a queued poll cannot turn a terminal error into a hidden ready view',async()=>{
 let reject!:(e:Error)=>void; const actions:string[]=[];
 const c=new LshEmbeddedController({bootstrap:async()=>({sessionUrl:'opaque'}),embed:async r=>{
 actions.push(r.action);if(r.action==='status')return new Promise((_,j)=>reject=j);return ready;
 }});
 await c.attach('A',b,false); const a=c.poll(); await Promise.resolve(); const other=c.poll();
 reject(new Error('LSH_NATIVE_TIMEOUT')); await a; await other;
 assert.equal(c.snapshot().phase,'error'); assert.deepEqual(actions,['open','status','hide']);
});
test('delayed UI open revalidates the native live lease before destroying a newer view',()=>{
 const n=read('scripts/android-src/LshEmbeddedSurface.kt');
 assert.match(n,/require\(LshSurfaceBridge.isLeaseCurrent\(request.getString\("lease"\)\)\)\s*destroy\(\)/);
 const r=read('src-tauri/src/lsh_surface.rs');
 assert.match(r,/Java_com_luckyray_mobile_LshSurfaceBridge_nativeIsLeaseCurrent/);
 assert.match(r,/current_lease\(\).as_deref\(\) == Some\(lease.as_str\(\)\)/);
});
test('old close delayed before native dispatch cannot target same-owner retry presentation',async()=>{
 let oldClose:any, current=''; let deferClose=true;
 const c=new LshEmbeddedController({bootstrap:async()=>({sessionUrl:'opaque'}),embed:async r=>{
   if(r.action==='open')current=r.presentationId!;
   if(r.action==='close' && deferClose){oldClose=r;return new Promise(()=>{});}
   return ready;
 }},15);
 await c.attach('A',b,false); const first=current; await c.close(); deferClose=false;
 await c.attach('A',b,false);
 assert.equal(oldClose.presentationId,first); assert.notEqual(current,first);
 const n=read('scripts/android-src/LshEmbeddedSurface.kt');
 assert.match(n,/require\(presentationId == request.getString\("presentationId"\)\)/);
 assert.match(n,/presentationId == request.optString\("presentationId"\)/);
});
