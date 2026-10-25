/** Run against an existing headless Chrome CDP endpoint and Vite. Synthetic data only.
 * node tests/graphCanvas/MobileGraphCanvas.browser.test.mjs http://127.0.0.1:9224 http://127.0.0.1:1423
 * This is a real Canvas + real Worker integration test, not a mocked rendering test. */
import assert from 'node:assert/strict';
const endpoint=process.argv[2]||'http://127.0.0.1:9224',origin=process.argv[3]||'http://127.0.0.1:1423';
const targets=await fetch(endpoint+'/json/list').then(r=>r.json());const target=targets.find(t=>t.type==='page');assert.ok(target,'CDP needs a page target');
const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
let id=0;const pending=new Map(),errors=[];ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);if(m.error)p?.reject(Error(JSON.stringify(m.error)));else p?.resolve(m.result);}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);};
const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let bounds;
// Coordinates below are fixture-local fractions, always projected through actual DOM bounds.
const touch=(type,points=[])=>send('Input.dispatchTouchEvent',{type,touchPoints:points.map(([id,x,y])=>({id,x:bounds.left+x/400*bounds.width,y:bounds.top+y/600*bounds.height,radiusX:1,radiusY:1,force:1}))});
try{
 await send('Runtime.enable');await send('Page.enable');await send('Emulation.setDeviceMetricsOverride',{width:400,height:750,deviceScaleFactor:2,mobile:true});await send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
 await send('Page.navigate',{url:origin+'/tests/graphCanvas/MobileGraphCanvas.browser.html'});
 for(let attempt=0;attempt<100;attempt++){if(await evaluate("!!document.querySelector('canvas') && !!document.querySelector('#camera')?.textContent"))break;await sleep(100);}
 assert.equal(await evaluate("document.querySelectorAll('canvas').length"),1);await sleep(400);
 bounds=await evaluate("(()=>{const r=document.querySelector('canvas').getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height};})()");assert.ok(bounds.width>0&&bounds.height>0);assert.ok(Math.abs(bounds.width-400)<=1&&Math.abs(bounds.height-600)<=1,'fixture must use its declared 400×600 CSS-pixel stage with production Canvas CSS');
 await evaluate("(()=>{window.__graphGestureLog=[];const canvas=document.querySelector('canvas');for(const type of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(type,event=>{window.__graphGestureLog.push({type:event.type,id:event.pointerId,x:event.clientX,y:event.clientY,pointerType:event.pointerType,buttons:event.buttons});if(window.__graphGestureLog.length>64)window.__graphGestureLog.shift();});})()");
 const camera=()=>evaluate("JSON.parse(document.querySelector('#camera').textContent)");
 const initial=await camera();console.log(JSON.stringify({check:'initial-layout',bounds,camera:initial}));assert.ok(initial.scale>0);assert.equal(await evaluate("document.querySelector('.mg-canvas-warning')?.textContent||''"),'','real worker must initialize');
 await touch('touchStart',[[0,200,300]]);await touch('touchEnd');await sleep(100);assert.equal(await evaluate("document.querySelector('#selected').textContent"),'synthetic-one');
 await touch('touchStart',[[0,200,300]]);await touch('touchEnd');await sleep(100);assert.equal(await evaluate("document.querySelector('#opens').textContent"),'1');
 // Fit is the production API: the single synthetic node projects to the actual stage centre.
 await evaluate("document.querySelector('#fit').click()");await sleep(80);const beforeNodeSlide=await camera();
 await touch('touchStart',[[0,200,300]]);await touch('touchMove',[[0,240,330]]);await touch('touchEnd');await sleep(100);const afterNodeSlide=await camera();
 console.log(JSON.stringify({check:'node-start-short-slide',beforeNodeSlide,afterNodeSlide,bounds}));assert.ok(Math.abs(afterNodeSlide.panX-beforeNodeSlide.panX-40/400*bounds.width)<=2);assert.ok(Math.abs(afterNodeSlide.panY-beforeNodeSlide.panY-30/600*bounds.height)<=2);
 await evaluate("document.querySelector('#fit').click()");await sleep(80);const beforeHold=await camera();
 await touch('touchStart',[[0,210,300]]);await sleep(450);await touch('touchMove',[[0,250,330]]);await sleep(100);const duringHold=await camera();
 assert.ok(Math.abs(duringHold.panX-beforeHold.panX)<.1&&Math.abs(duringHold.panY-beforeHold.panY)<.1,'long-held node drag must not pan camera');
 const dragPixels=await evaluate("(()=>{const c=document.querySelector('canvas'),r=c.getBoundingClientRect(),ctx=c.getContext('2d');const brightness=(x,y)=>{const p=ctx.getImageData(Math.round(x/400*c.width),Math.round(y/600*c.height),1,1).data;return p[0]+p[1]+p[2];};return {old:brightness(200,300),moved:brightness(240,330),width:r.width,height:r.height};})()");console.log(JSON.stringify({check:'held-node-drag',beforeHold,duringHold,dragPixels}));assert.ok(dragPixels.moved>250&&dragPixels.old<150,'real canvas node moved by pointer delta while retaining 10px grab offset');await touch('touchEnd');
 await evaluate("document.querySelector('#fit').click()");await sleep(80);
 const beforePan=await camera();await touch('touchStart',[[0,20,20]]);await touch('touchMove',[[0,80,90]]);await touch('touchEnd');await sleep(150);const afterPan=await camera();const expectedPan={x:60/400*bounds.width,y:70/600*bounds.height};const actualPan={x:afterPan.panX-beforePan.panX,y:afterPan.panY-beforePan.panY};console.log(JSON.stringify({check:'pan',bounds,beforePan,afterPan,expectedPan,actualPan,events:await evaluate('window.__graphGestureLog')}));assert.ok(Math.abs(actualPan.x-expectedPan.x)<=2,'pan X must equal actual DOM-mapped pointer delta within 2 CSS px');assert.ok(Math.abs(actualPan.y-expectedPan.y)<=2,'pan Y must equal actual DOM-mapped pointer delta within 2 CSS px');
 await touch('touchStart',[[0,100,100],[1,200,100]]);await touch('touchMove',[[0,80,100],[1,220,100]]);await touch('touchEnd');await sleep(150);const afterPinch=await camera();console.log(JSON.stringify({check:'pinch',bounds,before:afterPan,after:afterPinch,expectedRatio:1.4}));assert.ok(afterPinch.scale>afterPan.scale*1.2);
 await touch('touchStart',[[0,10,10]]);await touch('touchCancel');await sleep(50);assert.equal(await evaluate("document.querySelector('#opens').textContent"),'1');
 await evaluate("document.querySelector('#fit').click()");await sleep(100);await evaluate("document.querySelector('#capture').click()");await sleep(100);assert.ok(Number(await evaluate("document.querySelector('#capture').getAttribute('data-size')"))>100);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({status:'PASS',checks:['real-worker-init','tap-select','double-tap-open','real-touch-pan','node-start-slide-pans','long-hold-node-drag-preserves-offset','real-touch-pinch','touchcancel-no-open','fit','PNG-capture','no-runtime-exceptions'],device:'local Chromium emulation, not physical Android'},null,2));
}catch(error){try{console.error(JSON.stringify({status:'FAIL',message:String(error),diagnostics:await evaluate("({camera:document.querySelector('#camera')?.textContent,events:window.__graphGestureLog,bounds:(()=>{const r=document.querySelector('canvas')?.getBoundingClientRect();return r?{left:r.left,top:r.top,width:r.width,height:r.height}:null;})(),warning:document.querySelector('.mg-canvas-warning')?.textContent})")}));}catch{}throw error;}finally{ws.close();}
