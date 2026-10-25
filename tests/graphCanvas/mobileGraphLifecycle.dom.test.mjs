import assert from 'node:assert/strict';
import {createRequire} from 'node:module';import {pathToFileURL,fileURLToPath} from 'node:url';import path from 'node:path';import {mkdtemp,rm} from 'node:fs/promises';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),dir=await mkdtemp(path.join(repo,'tests/.graph-canvas-'));
const require=createRequire(repo+'/package.json');const {build}=createRequire(require.resolve('vite/package.json'))('esbuild');const {JSDOM}=(process.env.LR_DOM_TEST_TOOLS?createRequire(path.join(process.env.LR_DOM_TEST_TOOLS,'__test.cjs')):require)('jsdom');
const dom=new JSDOM('<div id="root"></div>',{url:'https://synthetic.invalid',pretendToBeVisual:true});
for(const key of ['window','document','HTMLElement','Event','MouseEvent','localStorage','navigator'])Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;globalThis.getComputedStyle=()=>({getPropertyValue:()=>''});
let w=400,h=600,lastArcs=[],raf=new Map(),id=0,observer;
globalThis.requestAnimationFrame=f=>{raf.set(++id,f);return id};globalThis.cancelAnimationFrame=id=>raf.delete(id);
globalThis.Worker=class{postMessage(){}terminate(){}};
globalThis.ResizeObserver=class{constructor(f){observer=f}observe(){}disconnect(){}};
globalThis.MutationObserver=class{observe(){}disconnect(){}};
const ctx=new Proxy({arc:(...a)=>lastArcs.push(a),measureText:()=>({width:60})},{get:(o,k)=>k in o?o[k]:()=>{},set:(o,k,v)=>(o[k]=v,true)});
dom.window.HTMLCanvasElement.prototype.getContext=()=>ctx;
dom.window.HTMLCanvasElement.prototype.getBoundingClientRect=()=>({width:w,height:h,left:0,top:0});
await build({entryPoints:[repo+'/src/features/graph/MobileGraphCanvas.tsx'],outfile:dir+'/canvas.mjs',bundle:true,format:'esm',platform:'node',jsx:'automatic',plugins:[{name:'react',setup(b){b.onResolve({filter:/^(react|react\/jsx-runtime)$/},a=>({path:pathToFileURL(require.resolve(a.path)).href,external:true}))}}]});
const React=await import(pathToFileURL(require.resolve('react')).href),{createRoot}=await import(pathToFileURL(require.resolve('react-dom/client')).href);const {MobileGraphCanvas}=await import(pathToFileURL(dir+'/canvas.mjs').href);const {act}=React;
const root=createRoot(document.getElementById('root')),seed={nodes:[{id:1,key:'one',label:'Synthetic',type:'note'}],edges:[],source:'real'};
const selections=[];const props={seed,settings:{},camera:{scale:1,panX:0,panY:0},onSelect(key){selections.push(key)},onOpen(){}};
const flush=()=>{lastArcs=[];const pending=[...raf.values()];raf.clear();for(const fn of pending)fn(performance.now());return lastArcs[0]?.[0]};
await act(async()=>root.render(React.createElement(MobileGraphCanvas,props)));const before=flush();
w=600;await act(async()=>observer());const afterResize=flush();
await act(async()=>root.render(React.createElement(MobileGraphCanvas,{...props,selectedKey:'one'})));const afterSelect=flush();
console.log(JSON.stringify({before,afterResize,afterSelect,expected:'afterSelect equals afterResize; same camera prop must not overwrite internal resize'}));
assert.ok(Number.isFinite(afterResize));assert.equal(afterSelect,afterResize,'selection must not undo resize-centered camera');


const canvas=document.querySelector('canvas');
const pointer=(type,x,y)=>{const event=new dom.window.MouseEvent(type,{clientX:x,clientY:y,button:0,bubbles:true});Object.defineProperty(event,'pointerId',{value:1});Object.defineProperty(event,'pointerType',{value:'touch'});canvas.dispatchEvent(event);};
const x=lastArcs[0][0],y=lastArcs[0][1];pointer('pointerdown',x,y);
await act(async()=>root.render(React.createElement(MobileGraphCanvas,{...props,seed:{...seed,nodes:[{...seed.nodes[0],key:'different-key'}]}})));flush();pointer('pointerup',x,y);assert.deepEqual(selections,[],'seed replacement must cancel old held node gesture');
const nx=lastArcs[0][0],ny=lastArcs[0][1];pointer('pointerdown',nx,ny);
await act(async()=>root.render(React.createElement(MobileGraphCanvas,{...props,paused:true})));pointer('pointerup',nx,ny);assert.deepEqual(selections,[],'pause must cancel held node gesture');
await act(async()=>root.unmount());dom.window.close();await rm(dir,{recursive:true,force:true});console.log('PASS actual Canvas: resize camera retained; seed and pause cancel held pointers (mocked rendering/worker, not device proof).');

// D3 imports a browser scheduler; mocked RAF intentionally never runs its global queue.
process.exit(0);
