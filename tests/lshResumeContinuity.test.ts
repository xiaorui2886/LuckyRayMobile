import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {LshEmbeddedController, type LshEmbedRequest} from '../src/still/kit/lshEmbedded.ts';
const bounds={x:0,y:24,width:360,height:600,viewportWidth:360};
const ready={opened:true,visible:true,ready:true,canGoBack:false};
const native=readFileSync(new URL('../scripts/android-src/LshEmbeddedSurface.kt',import.meta.url),'utf8');
const part=(a:string,b:string)=>native.slice(native.indexOf(a),native.indexOf(b,native.indexOf(a)));
test('only fresh permission ticket can end a lifecycle suspension; stale layout cannot regain gestures',async()=>{
 let generation=0,suspended=false;const calls:LshEmbedRequest[]=[];
 const c=new LshEmbeddedController({bootstrap:async()=>({sessionUrl:'opaque'}),embed:async r=>{
  calls.push(r);
  if(r.action==='suspend'&&!suspended){suspended=true;generation++;}
  if(r.action==='layout'&&r.lifecycleGeneration===generation)suspended=false;
  return {...ready,suspended,lifecycleGeneration:generation};
 }});
 await c.attach('A',bounds,false);
 const ticket=await c.prepareRevalidation('A');assert.equal(ticket,1);
 // Native background/pause occurs while permission request is pending.
 generation++;
 c.confirmRevalidation('A',ticket);await c.attach('A',bounds,false);
 assert.equal(calls.at(-1)?.lifecycleGeneration,1);assert.equal(suspended,true);
 assert.equal(c.snapshot().revalidationRequired,true);assert.equal(c.isReadyFor('A'),false);
 const last=calls.at(-1)!;
 assert.equal(c.consumeTabSwipe({presentationId:last.presentationId,presentationActivation:last.presentationActivation,gestureId:1,direction:'left'}),null);
 const fresh=await c.prepareRevalidation('A');c.confirmRevalidation('A',fresh);await c.attach('A',bounds,false);
 assert.equal(suspended,false);assert.equal(calls.at(-1)?.lifecycleGeneration,2);assert.equal(c.snapshot().revalidationRequired,false);assert.equal(c.isReadyFor('A'),true);
 await c.close();
});
test('render-only suspension cannot silently upgrade a validated ticket',async()=>{
 let generation=0;const calls:LshEmbedRequest[]=[];
 const c=new LshEmbeddedController({bootstrap:async()=>({sessionUrl:'opaque'}),embed:async r=>{calls.push(r);return {...ready,lifecycleGeneration:generation,suspended:r.action==='suspend'}}});
 await c.attach('A',bounds,false);generation=7;
 await c.suspend('A',bounds,false);await c.attach('A',bounds,false);
 assert.equal(calls.at(-1)?.lifecycleGeneration,0);
 await c.close();
});
test('unseen owner cannot borrow another owner ready state or bootstrap from suspension',async()=>{
 let finish!:(r:{sessionUrl:string})=>void;let starts=0;
 const c=new LshEmbeddedController({bootstrap:async owner=>{starts++;return owner==='B'?new Promise(r=>finish=r):{sessionUrl:'opaque'}},embed:async()=>ready});
 await c.suspend('A',bounds,false);assert.equal(starts,0);
 await c.attach('A',bounds,false);assert.equal(c.isReadyFor('A'),true);assert.equal(c.isReadyFor('B'),false);
 const opening=c.attach('B',bounds,false);for(let i=0;i<20;i++)await Promise.resolve();
 assert.equal(c.isReadyFor('B'),false);finish({sessionUrl:'opaque-B'});await opening;assert.equal(c.isReadyFor('B'),true);await c.close();
});
test('native suspension is lease-gated and bounded by one non-renewable monotonic deadline',()=>{
 const hold=part('private fun checkSuspension()','private var activity:');
 assert.match(hold,/if \(!LshSurfaceBridge.isLeaseCurrent\(lease\)\) \{ Log.i\("LshPresentationDiag", "lease=retired"\); destroy\(\); return \}/);
 assert.match(hold,/if \(suspensionBegan < 0L\) suspensionBegan = now/);
 assert.match(hold,/now - suspensionBegan >= 20_000L/);
 assert.match(hold,/LSH_REVALIDATION_TIMEOUT/);assert.match(hold,/postDelayed\(task, 200L\)/);
 const sync=part('private fun syncPresentationActivity()','private fun probePresentation(');
 assert.ok(sync.indexOf('!authorized')<sync.indexOf('View.VISIBLE'));
 assert.match(sync,/wantedVisible && suspended && ready && !failed/);
 assert.doesNotMatch(native,/Bitmap\.create|drawToBitmap|capturePicture|addJavascriptInterface/);
});
test('native layout requires the permission-captured lifecycle ticket before restoring input',()=>{
 const layout=part('"layout" ->','"hide" ->');
 assert.ok(layout.indexOf('!= lifecycleGeneration')<layout.indexOf('endSuspension()'));
 assert.match(native,/fun pause\(\) \{ lifecycleGeneration \+= 1/);
 const rust=readFileSync(new URL('../src-tauri/src/lsh_surface.rs',import.meta.url),'utf8');
 assert.match(rust,/if action != "close" && action != "hide" \{\s*crate::content::require_expected_source/);
 assert.match(rust,/"status" \| "suspend"/);
});
test('blocked native input covers touch, keys, accessibility, chooser, back and external navigation',()=>{
 assert.match(native,/onInterceptTouchEvent.*!inputAllowed\(\)/);
 assert.match(native,/dispatchKeyEvent.*!inputAllowed\(\)/);
 assert.match(native,/IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS/);
 assert.match(native,/if \(!inputAllowed\(\) \|\| web !== view/);
 const back=part('private fun back(','private fun error(');
 assert.equal((back.match(/!inputAllowed\(\)/g)||[]).length,2);
 assert.match(native,/if \(inputAllowed\(\) && req.isForMainFrame/);
});
test('file chooser survives pause but delivery waits for fresh input authority and same document',()=>{
 assert.doesNotMatch(part('private fun suspendInput()','private fun endSuspension()'),/fileCallback|pendingFileRequest/);
 const deliver=part('private fun deliverPendingFile()','private fun checkSuspension()');
 assert.match(deliver,/if \(!fileResultReady \|\| !inputAllowed\(\)\) return/);
 assert.match(deliver,/filePageGeneration == pageGeneration/);
 assert.match(part('fun onActivityResult(','fun imeChanged('),/fileResultReady = true\s+deliverPendingFile\(\)/);
 assert.match(part('private fun destroy()','/** Monotonic'),/pendingFileResult = null; fileResultReady = false/);
});

test('a queued revalidation is cancelled by newer tab hide before native dispatch',async()=>{
 const calls:LshEmbedRequest[]=[];let release!:(v:typeof ready)=>void;let block=false;
 const c=new LshEmbeddedController({bootstrap:async()=>({sessionUrl:'opaque'}),embed:async r=>{calls.push(r);if(block&&r.action==='status')return new Promise(resolve=>release=resolve);return ready}});
 await c.attach('A',bounds,false);block=true;const poll=c.poll();for(let i=0;i<10;i++)await Promise.resolve();
 const pending=c.prepareRevalidation('A');const hidden=c.hide();release(ready);await Promise.all([poll,pending,hidden]);
 assert.equal(calls.filter(r=>r.action==='suspend').length,0);assert.equal(await pending,null);assert.equal(calls.at(-1)?.action,'hide');await c.close();
});
test('native tab hide fences previously dispatched layout and back callbacks across resumed activations',()=>{
 assert.match(native,/"hide" -> \{ lifecycleGeneration \+= 1/);
 const back=part('private fun back(','private fun error(');
 assert.match(back,/val lifecycle = lifecycleGeneration/);assert.match(back,/lifecycle != lifecycleGeneration/);
});

test('tab and background interruptions during first loading capture a fresh hidden lifecycle ticket',async()=>{
 let generation=3,visible=false,loaded=false,bootstraps=0;const calls:LshEmbedRequest[]=[];
 const c=new LshEmbeddedController({bootstrap:async()=>{bootstraps++;return{sessionUrl:'opaque'}},embed:async r=>{
  calls.push(r);
  if(r.action==='open')visible=true;
  if(r.action==='hide'){generation++;visible=false;}
  if(r.action==='layout'&&r.lifecycleGeneration===generation)visible=true;
  return {...ready,ready:loaded,visible,lifecycleGeneration:generation};
 }});
 await c.attach('A',bounds,false);assert.equal(c.snapshot().phase,'loading');
 await c.hide();generation++; // Additional native Activity pause.
 const ticket=await c.prepareRevalidation('A');assert.equal(ticket,5);assert.equal(calls.at(-1)?.action,'status');assert.equal(visible,false);
 c.confirmRevalidation('A',ticket);await c.attach('A',bounds,false);assert.equal(visible,true);assert.equal(bootstraps,1);
 loaded=true;await c.poll();assert.equal(c.snapshot().phase,'ready');await c.close();
});

test('native pending touch sequence remains swallowed even if permission arrives before UP',()=>{
 const touch=part('override fun dispatchTouchEvent(', 'override fun onInterceptTouchEvent(');
 assert.match(touch,/ACTION_DOWN\) blockedTouchSequence = !inputAllowed\(\)/);
 assert.match(touch,/if \(!inputAllowed\(\)\) blockedTouchSequence = true/);
 assert.ok(touch.indexOf('val blocked = blockedTouchSequence') < touch.indexOf('ACTION_UP'));
 assert.match(touch,/return if \(blocked\) true else super.dispatchTouchEvent\(event\)/);
});
test('confirmation is a delayed bottom-right rounded status with dark theme, not a top banner',()=>{
 assert.match(native,/FrameLayout.LayoutParams\(-2, -2, android.view.Gravity.BOTTOM or android.view.Gravity.END\)/);
 assert.doesNotMatch(native,/android.view.Gravity.TOP or android.view.Gravity.CENTER_HORIZONTAL/);
 assert.match(native,/now - suspensionBegan >= 700L/);
 assert.match(native,/background = GradientDrawable\(\).apply/);
 assert.match(native,/cornerRadius = 22 \* resources.displayMetrics.density/);
 assert.match(native,/setColor\(if \(dark\)/);
});
