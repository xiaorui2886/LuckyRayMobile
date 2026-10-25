import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {mkdtempSync,rmSync} from 'node:fs';import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url)),require=createRequire(import.meta.url),tools=process.env.LR_DOM_TEST_TOOLS?createRequire(join(resolve(process.env.LR_DOM_TEST_TOOLS),'__harness__.cjs')):require;
const {JSDOM}=tools('jsdom'),{build,stop}=createRequire(require.resolve('vite/package.json'))('esbuild');
test('real Sheet open, nested, Back, unmount, theme and rendered fade sampling',async()=>{
 const dom=new JSDOM('<style>.st-app{background:rgb(241,242,245)}.st-app[data-mode=dark]{background:rgb(10,10,12)}.st-scrim{background:rgba(29,31,40,.3);opacity:0;transition-duration:.18s;transition-delay:0s}.is-shown>.st-scrim{opacity:1}.st-app[data-mode=dark] .st-scrim{background:rgba(3,3,5,.64)}.st-app[data-reduced=true] .st-scrim{transition-duration:0s}.st-detail-stage.is-masked{visibility:hidden}</style><div id="host"></div>',{pretendToBeVisual:true}),old=new Map(),frames=new Map();let id=0;
 for(const k of ['window','document','navigator','HTMLElement','Element','Node','Event','MouseEvent','KeyboardEvent','MutationObserver','getComputedStyle','requestAnimationFrame','cancelAnimationFrame']){old.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:k==='getComputedStyle'?dom.window.getComputedStyle.bind(dom.window):k==='requestAnimationFrame'?(f)=>{frames.set(++id,f);return id}:k==='cancelAnimationFrame'?(i)=>frames.delete(i):dom.window[k]})}
 dom.window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});dom.window.HTMLElement.prototype.getClientRects=function(){return this.closest('[hidden]')?[]:[{}]};globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 const channels=[],MC=globalThis.MessageChannel;globalThis.MessageChannel=class extends MC{constructor(){super();channels.push(this)}};
 const dir=mkdtempSync(join(tmpdir(),'scrim-dom-'));let app,api,release;
 try{const out=join(dir,'entry.cjs');await build({stdin:{contents:`import React from 'react';import {Sheet} from './src/still/kit/Sheet';export {observeSystemBarAppearance,systemBarScrim} from './src/services/systemBarAppearance';export {act,createElement} from 'react';export {createRoot} from 'react-dom/client';export function Harness({count=0,dark=false,reduced=false,onClose,register}){return <div className="st-app" data-mode={dark?'dark':'light'} data-reduced={reduced?'true':'false'}>{Array.from({length:count},(_,i)=><Sheet key={i} title={'Sheet '+i} onClose={()=>onClose(i)} registerDismiss={f=>register(i,f)}><button>action</button></Sheet>)}</div>}`,resolveDir:root,loader:'tsx'},outfile:out,bundle:true,platform:'node',format:'cjs'});api=require(out);app=api.createRoot(document.getElementById('host'));
 const sent=[],backs=new Map(),closed=[];let count=0,dark=false,reduced=false;
 const render=()=>api.act(async()=>app.render(api.createElement(api.Harness,{count,dark,reduced,onClose:i=>closed.push(i),register:(i,f)=>{backs.set(i,f);return()=>backs.delete(i)}})));
 const frame=async()=>{await api.act(async()=>{const todo=[...frames.values()];frames.clear();todo.forEach(f=>f(performance.now()));await Promise.resolve()})};
 const latest=()=>sent.at(-1);await render();release=api.observeSystemBarAppearance(async(...args)=>{sent.push(args);return true});await frame();assert.deepEqual(latest(),[false,false,0xf1f2f5,0xf1f2f5]);
 count=1;await render();assert(api.systemBarScrim.active());await frame();await frame();assert.deepEqual(latest(),[false,true,0xb1b3b8,0xf1f2f5]);
 // jsdom has no CSS animation engine. Inject a computed intermediate opacity
 // to verify that we sample the rendered fade, not the boolean mount state.
 document.querySelector('.st-scrim').style.opacity='.5';await Promise.resolve();await frame();assert.equal(latest()[2],0xd1d2d6);
 document.querySelector('.st-scrim').style.opacity='';await Promise.resolve();await frame();
 count=2;await render();await frame();await frame();assert.equal(latest()[2],0x85868c);
 await api.act(async()=>backs.get(1)());await frame();assert.equal(latest()[2],0xb1b3b8);assert(api.systemBarScrim.active());
 count=1;await render();await frame();assert.equal(backs.size,1);assert.equal(latest()[2],0xb1b3b8);
 dark=true;await render();await frame();assert.deepEqual(latest(),[true,true,0x060608,0x0a0a0c]);
 reduced=true;await render();await api.act(async()=>backs.get(0)());await frame();assert.deepEqual(latest(),[true,false,0x0a0a0c,0x0a0a0c]);
 count=0;await render();await frame();assert.equal(api.systemBarScrim.active(),false);assert.equal(backs.size,0);
 count=1;await render();await frame();await frame();assert.equal(latest()[2],0x060608);
 count=0;await render();await frame();assert.equal(latest()[2],0x0a0a0c);
 // Retained covered pages have layout rects, but their hidden scrims must
 // not tint a foreground page. Stage class changes must trigger resampling.
 const stage=document.createElement('div');stage.className='st-detail-stage';stage.innerHTML='<div class="st-modal is-shown"><div class="st-scrim"></div></div>';document.querySelector('.st-app').append(stage);await Promise.resolve();await frame();assert.equal(latest()[2],0x060608);
 stage.classList.add('is-masked');await Promise.resolve();await frame();assert.equal(latest()[2],0x0a0a0c);stage.remove();await Promise.resolve();await frame();
 const retained=document.createElement('div');retained.innerHTML='<div class="st-modal is-shown"><div class="st-scrim"></div></div>';document.querySelector('.st-app').append(retained);await Promise.resolve();await frame();assert.equal(latest()[2],0x060608);
 retained.hidden=true;await Promise.resolve();await frame();assert.equal(latest()[2],0x0a0a0c);
 retained.hidden=false;await Promise.resolve();await frame();assert.equal(latest()[2],0x060608);
 retained.remove();await Promise.resolve();await frame();
 // A settled reduced-motion sheet schedules no perpetual RAF.
 await frame();assert.equal(frames.size,0);
 await api.act(async()=>app.render(null));await frame();assert.deepEqual(latest(),[false,false,undefined,undefined]);
 release();release=null;assert.equal(frames.size,0);
 }finally{release?.();if(app)await api.act(async()=>app.unmount());channels.forEach(c=>{c.port1.close();c.port2.close()});globalThis.MessageChannel=MC;dom.window.close();for(const[k,v]of old){if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k]}delete globalThis.IS_REACT_ACT_ENVIRONMENT;rmSync(dir,{recursive:true,force:true});stop()}
});
