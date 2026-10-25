// Actual React gesture hook and CollectionView composition. Does not simulate
// Android gesture arbitration or the separate native LSH WebView surface.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync, rmSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url)), require=createRequire(import.meta.url);
const tools=process.env.LR_DOM_TEST_TOOLS?createRequire(join(resolve(process.env.LR_DOM_TEST_TOOLS),'__harness__.cjs')):require;
const {JSDOM}=tools('jsdom'),{build,stop}=createRequire(require.resolve('vite/package.json'))('esbuild');
test('independent swipe lifecycle and dual transport review',async t=>{
 const dom=new JSDOM('<div id="host"></div>',{url:'https://test.invalid/',pretendToBeVisual:true});
 const names=['window','document','navigator','HTMLElement','Element','Node','MutationObserver','getComputedStyle','requestAnimationFrame','cancelAnimationFrame'];
 const old=new Map(names.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 for(const k of names)Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:typeof dom.window[k]==='function'&&['getComputedStyle','requestAnimationFrame','cancelAnimationFrame'].includes(k)?dom.window[k].bind(dom.window):dom.window[k]});
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 const channels=[],OriginalMessageChannel=globalThis.MessageChannel;globalThis.MessageChannel=class extends OriginalMessageChannel{constructor(){super();channels.push(this)}};
 const dir=mkdtempSync(join(tmpdir(),'lr-source-swipe-'));let app,lib;
 try{
  const out=join(dir,'entry.cjs');await build({stdin:{contents:`import React from 'react';import {RootSwipeContext,useHorizontalSwipe,useSourceSwipe} from './src/still/kit/useHorizontalSwipe';export {rootSwipeTarget,sourceSwipeTarget} from './src/still/kit/useHorizontalSwipe';export {act,createElement} from 'react';export {createRoot} from 'react-dom/client';function Source(p){const s=useSourceSwipe(p.source,x=>p.record('source:'+x),{disabled:p.disabled});return <div data-swipe-owner="sources" {...s}><p id="source">row</p><input id="input"/><div id="table" className="cm-lp-table-wrap">table</div><div id="editable" contentEditable suppressContentEditableWarning>text</div><div id="scroll" style={{overflowX:'auto'}}><span id="scroll-child">wide</span></div><input id="seek" type="range"/></div>}export function Harness(p){const s=useHorizontalSwipe(d=>p.record('outer:'+d),{canStart:p.canNavigate});return <RootSwipeContext.Provider value={{canNavigate:p.canNavigate,navigate:d=>p.record('root:'+d)}}><div data-swipe-owner="root" {...s}><Source {...p}/><p id="root-body">root</p></div></RootSwipeContext.Provider>}`,resolveDir:root,loader:'tsx'},outfile:out,bundle:true,platform:'node',format:'cjs'});
  lib=require(out);const {act,createElement:h,createRoot,Harness,rootSwipeTarget,sourceSwipeTarget}=lib;app=createRoot(document.getElementById('host'));
  const calls=[];let allowed=true;let props={source:'local',record:x=>calls.push(x),canNavigate:()=>allowed};
  const render=async patch=>{props={...props,...patch};await act(async()=>app.render(h(Harness,props)));for(const e of document.querySelectorAll('[data-swipe-owner]'))e.getBoundingClientRect=()=>({left:0,right:400});};
  const fire=async(target,type,values={})=>{let event;await act(async()=>{event=new dom.window.Event(type,{bubbles:true,cancelable:true});for(const [k,v]of Object.entries(values))Object.defineProperty(event,k,{value:v});target.dispatchEvent(event)});return event;};
  const base={pointerId:1,pointerType:'touch',isPrimary:true,button:0,clientY:100};
  const swipe=async(id,direction='left')=>{const e=document.getElementById(id),from=direction==='left'?280:100,to=direction==='left'?100:280;await fire(e,'pointerdown',{...base,clientX:from});await fire(e,'pointermove',{...base,clientX:to});await fire(e,'pointerup',{...base,clientX:to});};
  const reset=async patch=>{allowed=true;calls.length=0;document.getSelection().removeAllRanges();await render({disabled:false,source:'local',...patch});};

  const pt=(identifier,x,y=100)=>({identifier,clientX:x,clientY:y});
  const touch=(id,type,points,changed=points)=>fire(document.getElementById(id),type,{touches:points,changedTouches:changed});
  const startTouch=()=>touch('source','touchstart',[pt(11,280)]);
  const finishTouch=async()=>{await touch('source','touchmove',[pt(11,100)]);await touch('source','touchend',[],[pt(11,100)]);};
  await t.test('touch-only source and root streams each navigate once',async()=>{
   await reset();await startTouch();await finishTouch();assert.deepEqual(calls,['source:desktop']);
   await reset();await touch('root-body','touchstart',[pt(11,280)]);await touch('root-body','touchmove',[pt(11,100)]);await touch('root-body','touchend',[],[pt(11,100)]);assert.deepEqual(calls,['outer:left']);
  });
  await t.test('touch remains authoritative after compatibility pointer cancellation',async()=>{
   await reset();const e=document.getElementById('source');await fire(e,'pointerdown',{...base,clientX:280});await startTouch();await fire(e,'pointermove',{...base,clientX:230});await touch('source','touchmove',[pt(11,230)]);await fire(e,'pointercancel',{...base,clientX:230});await finishTouch();await fire(e,'pointerup',{...base,clientX:100});assert.deepEqual(calls,['source:desktop']);
  });
  await t.test('touch cancellation prevents trailing compatibility pointer commit',async()=>{
   await reset();const e=document.getElementById('source');await fire(e,'pointerdown',{...base,clientX:280});await startTouch();await touch('source','touchmove',[pt(11,100)]);await touch('source','touchcancel',[],[pt(11,100)]);await fire(e,'pointerup',{...base,clientX:100});assert.deepEqual(calls,[]);
  });
  await t.test('disabled then reenabled without movement cannot revive stale finger',async()=>{
   await reset();await startTouch();await render({disabled:true});await render({disabled:false});await finishTouch();assert.deepEqual(calls,[]);
  });
  await t.test('external source change revokes old source gesture',async()=>{
   await reset();await startTouch();await render({source:'desktop'});await finishTouch();assert.deepEqual(calls,[]);
  });
  await t.test('second finger outside nearest source owner permanently cancels first',async()=>{
   await reset();await startTouch();await touch('root-body','touchstart',[pt(11,280),pt(22,300)],[pt(22,300)]);await touch('root-body','touchend',[pt(11,280)],[pt(22,300)]);await finishTouch();assert.deepEqual(calls,[]);
  });
  await t.test('vertical intent stays native and cannot turn into final horizontal jump',async()=>{
   await reset();await startTouch();const e=await touch('source','touchmove',[pt(11,279,180)]);assert.equal(e.defaultPrevented,false);await touch('source','touchmove',[pt(11,100,180)]);await touch('source','touchend',[],[pt(11,100,180)]);assert.deepEqual(calls,[]);
  });
  await t.test('composition start while a finger is down cancels navigation',async()=>{
   await reset();await startTouch();await fire(document.getElementById('input'),'compositionstart');await fire(document.getElementById('input'),'compositionend');await finishTouch();assert.deepEqual(calls,[]);
  });
  await t.test('nested horizontal scroller input and selected text own touch transport',async()=>{
   await reset();const scroll=document.getElementById('scroll');Object.defineProperties(scroll,{scrollWidth:{value:500},clientWidth:{value:100}});
   for(const id of ['input','table','editable','seek','scroll-child']){await touch(id,'touchstart',[pt(11,280)]);await touch(id,'touchmove',[pt(11,100)]);await touch(id,'touchend',[],[pt(11,100)])}assert.deepEqual(calls,[]);
   const range=document.createRange();range.selectNodeContents(document.getElementById('source'));document.getSelection().addRange(range);await startTouch();await finishTouch();assert.deepEqual(calls,[]);
  });
  await t.test('unmount and fresh remount do not inherit in-flight gesture',async()=>{
   await reset();await startTouch();await act(async()=>app.render(null));await render({});await finishTouch();assert.deepEqual(calls,[]);
  });

 }finally{if(app)await lib.act(async()=>app.unmount());stop();for(const c of channels){c.port1.close();c.port2.close()}globalThis.MessageChannel=OriginalMessageChannel;dom.window.close();for(const [k,v]of old)if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k];delete globalThis.IS_REACT_ACT_ENVIRONMENT;rmSync(dir,{recursive:true,force:true})}
});
