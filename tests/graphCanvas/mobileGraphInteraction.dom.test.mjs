// Production Canvas orchestration with deterministic delayed-worker replies.
// Real-worker/browser evidence is a separate test; no device data is used here.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),dir=await mkdtemp(path.join(repo,'tests/.graph-interaction-'));
const require=createRequire(repo+'/package.json'),{build}=createRequire(require.resolve('vite/package.json'))('esbuild');
const {JSDOM}=(process.env.LR_DOM_TEST_TOOLS?createRequire(path.join(process.env.LR_DOM_TEST_TOOLS,'__test.cjs')):require)('jsdom');
const dom=new JSDOM('<div id="root"></div>',{url:'https://synthetic.invalid',pretendToBeVisual:true});
for(const key of ['window','document','HTMLElement','Event','MouseEvent','localStorage','navigator'])Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;globalThis.getComputedStyle=()=>({getPropertyValue:()=>''});
let frameId=0,time=0,raf=new Map(),arcs=[],lines=[],labels=[],workers=[],disposed=0;
globalThis.requestAnimationFrame=fn=>{raf.set(++frameId,fn);return frameId;};globalThis.cancelAnimationFrame=id=>raf.delete(id);
globalThis.ResizeObserver=class{observe(){}disconnect(){}};globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.Worker=class{constructor(){this.requests=[];workers.push(this);}postMessage(request){this.requests.push(request);}terminate(){disposed++;}};
const ctx=new Proxy({arc:(...args)=>arcs.push(args),lineTo:(...args)=>lines.push(args),fillText:(text,x,y)=>labels.push({text,x,y,font:ctx.font,color:ctx.fillStyle}),measureText:text=>({width:text.length*7})},{get:(obj,key)=>key in obj?obj[key]:()=>{},set:(obj,key,value)=>(obj[key]=value,true)});
dom.window.HTMLCanvasElement.prototype.getContext=()=>ctx;dom.window.HTMLCanvasElement.prototype.getBoundingClientRect=()=>({width:400,height:600,left:0,top:0});
const capture=new Set();dom.window.HTMLCanvasElement.prototype.setPointerCapture=id=>capture.add(id);dom.window.HTMLCanvasElement.prototype.hasPointerCapture=id=>capture.has(id);dom.window.HTMLCanvasElement.prototype.releasePointerCapture=function(id){capture.delete(id);const e=new MouseEvent('lostpointercapture');Object.defineProperty(e,'pointerId',{value:id});this.dispatchEvent(e);};
try{
 await build({entryPoints:[repo+'/src/features/graph/MobileGraphCanvas.tsx'],outfile:dir+'/canvas.mjs',bundle:true,format:'esm',platform:'node',jsx:'automatic',plugins:[{name:'react',setup(b){b.onResolve({filter:/^(react|react\/jsx-runtime)$/},a=>({path:pathToFileURL(require.resolve(a.path)).href,external:true}));}}]});
 const React=await import(pathToFileURL(require.resolve('react')).href),{act}=React,{createRoot}=await import(pathToFileURL(require.resolve('react-dom/client')).href),{MobileGraphCanvas}=await import(pathToFileURL(dir+'/canvas.mjs').href);
 const root=createRoot(document.getElementById('root')),ref=React.createRef(),selections=[],opens=[],saved=[],cameras=[],cameraSettled=[];
 const seed={nodes:[{id:1,key:'one',label:'First full title',type:'note'},{id:2,key:'two',label:'Second full title',type:'note'},{id:3,key:'three',label:'Third full title',type:'note'}],edges:[[1,2],[2,3]],source:'real'};
 const positions=seed.nodes.map((n,i)=>({key:n.key,x:100+i*100,y:100,vx:0,vy:0}));
 let props={ref,seed,positions,settings:{},camera:{scale:1,panX:0,panY:0},onSelect:k=>selections.push(k),onOpen:k=>opens.push(k),onPositionsChange:p=>saved.push(p),onCameraChange:(c,settled)=>{cameras.push(c);cameraSettled.push(settled);}};
 const render=async patch=>{props={...props,...patch};await act(async()=>root.render(React.createElement(MobileGraphCanvas,props)));};
 const flush=()=>{arcs=[];lines=[];labels=[];const work=[...raf.values()];raf.clear();time+=16;for(const fn of work)fn(time);};
 const reply=(change,alpha=0)=>{const worker=workers.at(-1),request=worker.requests.shift();assert.ok(request,'one worker request pending');const state=new Float64Array(request.state);change?.(state,request);worker.onmessage({data:{type:'step-result',requestId:request.requestId,generation:request.generation,mutationRevision:request.mutationRevision,topologyRevision:request.topologyRevision,state,alpha,workTime:1}});return request;};
 const settle=()=>{for(let i=0;i<8;i++){flush();if(workers.at(-1).requests.length)reply();else break;}flush();};
 const pointer=(type,x,y,{id=1,pointerType='touch',button=0,buttons=type==='pointerup'?0:1}={})=>{const event=new MouseEvent(type,{clientX:x,clientY:y,button,buttons,bubbles:true,cancelable:true});Object.defineProperty(event,'pointerId',{value:id});Object.defineProperty(event,'pointerType',{value:pointerType});document.querySelector('canvas').dispatchEvent(event);};
 await render({});settle();assert.equal(ref.current.captureLayout()[0].x,100,'restores by stable key');
 pointer('pointerdown',100,100);pointer('pointerup',100,100);settle();assert.deepEqual(opens,['one'],'single tap opens once, lost capture cannot duplicate');assert.equal(selections.at(-1),'one');
 pointer('pointerdown',100,100);flush();const dragRequest=workers.at(-1).requests[0];pointer('pointermove',145,125);flush();reply(state=>{state[0]=101;state[1]=101;state[4]=220;state[5]=110;},.25);flush();
 let layout=ref.current.captureLayout();assert.equal(layout[0].x,145,'held node stays at pointer despite old worker coordinates');assert.equal(layout[1].x,220,'same delayed response advances neighbour during drag');assert.equal(workers.at(-1).requests[0].mutationRevision,dragRequest.mutationRevision,'pointer move does not invalidate every neighbour reply');
 pointer('pointerup',145,125);settle();assert.equal(opens.length,1,'drag does not open');assert.equal(saved.at(-1)[0].x,145,'release publishes current positions');
 pointer('pointerdown',145,125);await act(async()=>new Promise(r=>setTimeout(r,420)));pointer('pointerup',145,125);settle();assert.equal(opens.length,1,'long hold selects actions without opening');assert.equal(selections.at(-1),'one');
 document.querySelector('canvas').dispatchEvent(new MouseEvent('contextmenu',{clientX:220,clientY:110,bubbles:true,cancelable:true}));settle();assert.equal(selections.at(-1),'two','right click retains node actions');assert.equal(opens.length,1);
 pointer('pointerdown',5,5);pointer('pointerup',5,5);settle();assert.equal(selections.at(-1),null,'blank tap clears selection');
 const panBefore={...cameras.at(-1)};pointer('pointerdown',5,5);pointer('pointermove',7,5);pointer('pointermove',15,15);assert.equal(cameras.at(-1).panX-panBefore.panX,10,'crossing movement slop does not lose the initial pan delta');assert.equal(cameraSettled.at(-1),false,'movement camera update is not a storage flush');pointer('pointercancel',15,15);assert.equal(cameraSettled.at(-1),true,'release/cancel flushes final camera');settle();await render({camera:{scale:1,panX:0,panY:0}});settle();
 pointer('pointerdown',145,125);pointer('pointercancel',145,125);settle();assert.equal(opens.length,1,'cancel never opens');assert.equal(capture.size,0,'cancel releases capture');
 pointer('pointerdown',145,125);pointer('pointerdown',220,110,{id:2});pointer('pointermove',240,110,{id:2});pointer('pointerup',145,125);pointer('pointerup',240,110,{id:2});settle();assert.equal(opens.length,1,'pinch-to-one transition never opens');
 // Return to a known camera; hover at zoom overview must keep the focused title readable.
 await render({camera:{scale:.5,panX:0,panY:0}});settle();const target=ref.current.captureLayout()[1];pointer('pointermove',target.x*.5,target.y*.5,{pointerType:'mouse',buttons:0});flush();assert.ok(labels.some(l=>l.text==='Second full title'&&parseFloat(l.font)>=12),'focused overview label >=12px');
 // Reheat with a settings change to make the background body move under a stationary mouse.
 await render({settings:{repulsionForce:60}});flush();reply(state=>{state[4]+=150;state[5]+=150;},0);flush();assert.equal(labels.length,0,'hover clears on live physics geometry without another mousemove');settle();assert.equal(raf.size,0,'settled graph does not poll hover or worker');
 const beforeFit={...cameras.at(-1)};ref.current.fit();assert.deepEqual(cameras.at(-1),beforeFit,'fit starts a transition rather than jumping synchronously');flush();assert.notDeepEqual(cameras.at(-1),beforeFit);for(let i=0;i<60&&raf.size;i++)flush();assert.equal(raf.size,0,'fit transition settles');assert.equal(cameraSettled.at(-1),true,'last animation frame flushes camera once settled');
 await render({reducedMotion:true});settle();const beforeZoom={...cameras.at(-1)};ref.current.zoomBy(1.25);assert.ok(cameras.at(-1).scale>beforeZoom.scale,'reduced zoom publishes final camera immediately');settle();assert.equal(raf.size,0);
 // Exercise the real draw loop during birth (not just its endpoint helper).
 await render({reducedMotion:false,playback:{playing:true,progress:.25}});flush();
 let birthEdges=0;for(const progress of [.3,.4,.5,.6]){await render({playback:{playing:true,progress}});flush();for(const [x,y] of lines){assert.ok(arcs.some(([ax,ay])=>Math.hypot(ax-x,ay-y)<1e-8),'birth edge endpoint must be the live node centre');birthEdges++;}}
 assert.ok(birthEdges>0,'fixture actually drew birth edges');
 await render({playback:{playing:false}});settle();
 await render({reducedMotion:true});settle();
 const progresses=[];await render({playback:{playing:true},onPlaybackProgress:p=>progresses.push(p)});flush();assert.equal(progresses.at(-1),1,'reduced playback avoids spring and camera motion');
 await render({playback:{playing:false},paused:true});const persisted=saved.length;assert.ok(persisted>0);const pending=raf.size;assert.equal(pending,0,'pause has no animation frame');
 pointer('pointerdown',100,100);pointer('pointerup',100,100);assert.equal(opens.length,1,'paused canvas rejects input');
 await act(async()=>root.unmount());assert.ok(disposed>0);assert.equal(raf.size,0);assert.equal(capture.size,0);assert.ok(saved.length>=persisted,'dispose flushes layout');
 console.log('PASS Canvas orchestration: single open, direct drag/worker neighbour merge, hold/right-click actions, cancel/pinch, hover retest, label readability, layout restore/flush, smooth fit, reduced motion, idle/pause/unmount.');
}finally{dom.window.close();await rm(dir,{recursive:true,force:true});}
process.exit(0);
