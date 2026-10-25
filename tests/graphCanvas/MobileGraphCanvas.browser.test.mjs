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
 bounds=await evaluate("(()=>{const r=document.querySelector('canvas').getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height};})()");assert.ok(bounds.width>0&&bounds.height>0);
 const camera=()=>evaluate("JSON.parse(document.querySelector('#camera').textContent)");
 const initial=await camera();assert.ok(initial.scale>0);assert.equal(await evaluate("document.querySelector('.mg-canvas-warning')?.textContent||''"),'','real worker must initialize');
 await touch('touchStart',[[0,200,300]]);await touch('touchEnd');await sleep(100);assert.equal(await evaluate("document.querySelector('#selected').textContent"),'synthetic-one');
 await touch('touchStart',[[0,200,300]]);await touch('touchEnd');await sleep(100);assert.equal(await evaluate("document.querySelector('#opens').textContent"),'1');
 const beforePan=await camera();await touch('touchStart',[[0,20,20]]);await touch('touchMove',[[0,80,90]]);await touch('touchEnd');await sleep(150);const afterPan=await camera();assert.ok(afterPan.panX-beforePan.panX>50);assert.ok(afterPan.panY-beforePan.panY>60);
 await touch('touchStart',[[0,100,100],[1,200,100]]);await touch('touchMove',[[0,80,100],[1,220,100]]);await touch('touchEnd');await sleep(150);const afterPinch=await camera();assert.ok(afterPinch.scale>afterPan.scale*1.2);
 await touch('touchStart',[[0,10,10]]);await touch('touchCancel');await sleep(50);assert.equal(await evaluate("document.querySelector('#opens').textContent"),'1');
 await evaluate("document.querySelector('#fit').click()");await sleep(100);await evaluate("document.querySelector('#capture').click()");await sleep(100);assert.ok(Number(await evaluate("document.querySelector('#capture').getAttribute('data-size')"))>100);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({status:'PASS',checks:['real-worker-init','tap-select','double-tap-open','real-touch-pan','real-touch-pinch','touchcancel-no-open','fit','PNG-capture','no-runtime-exceptions'],device:'local Chromium emulation, not physical Android'},null,2));
}finally{ws.close();}
