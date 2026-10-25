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
test('source swipes arbitrate one level before handing off to root tabs',async t=>{
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
  await t.test('source neighbors and root order are bounded, never wrap',()=>{
   assert.equal(sourceSwipeTarget('local','left'),'desktop');assert.equal(sourceSwipeTarget('desktop','right'),'local');assert.equal(sourceSwipeTarget('local','right'),null);assert.equal(sourceSwipeTarget('desktop','left'),null);
   const order=['home','library','ai','knowledge','settings'];order.forEach((x,i)=>{assert.equal(rootSwipeTarget(x,'left'),order[i+1]??null);assert.equal(rootSwipeTarget(x,'right'),order[i-1]??null)});assert.equal(rootSwipeTarget('note','left'),null);
  });
  await t.test('local-left switches source only, not knowledge to settings',async()=>{await reset();await swipe('source');assert.deepEqual(calls,['source:desktop']);});
  await t.test('desktop-right returns local only; boundary delegates to root once',async()=>{await reset({source:'desktop'});await swipe('source','right');assert.deepEqual(calls,['source:local']);calls.length=0;await swipe('source','left');assert.deepEqual(calls,['root:left']);await reset();await swipe('source','right');assert.deepEqual(calls,['root:right']);});
  await t.test('plain root body remains navigable',async()=>{await reset();await swipe('root-body');assert.deepEqual(calls,['outer:left']);});
  await t.test('selection, text entry, tables, seek and horizontal scroller keep their own gestures',async()=>{
   await reset();const scroll=document.getElementById('scroll');Object.defineProperties(scroll,{scrollWidth:{value:500},clientWidth:{value:100}});
   for(const id of ['input','table','editable','seek','scroll-child'])await swipe(id);assert.deepEqual(calls,[]);
   const range=document.createRange();range.selectNodeContents(document.getElementById('source'));document.getSelection().addRange(range);await swipe('source');assert.deepEqual(calls,[]);
  });
  await t.test('system edge gestures are not stolen by source navigation',async()=>{
   await reset();const e=document.getElementById('source');for(const x of [5,395]){await fire(e,'pointerdown',{...base,clientX:x});await fire(e,'pointermove',{...base,clientX:200});await fire(e,'pointerup',{...base,clientX:200});}assert.deepEqual(calls,[]);
  });
  await t.test('source selection and revoked detail/overlay/input authority prevent navigation',async()=>{
   await reset({disabled:true});await swipe('source');assert.deepEqual(calls,[]);await reset();allowed=false;await swipe('source');await swipe('root-body');assert.deepEqual(calls,[]);
   await reset();const e=document.getElementById('source');await fire(e,'pointerdown',{...base,clientX:280});await fire(e,'pointermove',{...base,clientX:100});allowed=false;await fire(e,'pointerup',{...base,clientX:100});assert.deepEqual(calls,[]);
  });
  await t.test('vertical intent and pointer cancellation cannot become tab navigation',async()=>{
   await reset();const e=document.getElementById('source');await fire(e,'pointerdown',{...base,clientX:280});assert.equal((await fire(e,'pointermove',{...base,clientX:278,clientY:180})).defaultPrevented,false);await fire(e,'pointerup',{...base,clientX:100,clientY:180});assert.deepEqual(calls,[]);
   for(const kind of ['pointercancel','lostpointercapture','touchcancel']){await fire(e,'pointerdown',{...base,clientX:280});await fire(e,'pointermove',{...base,clientX:100});await fire(e,kind,{...base,touches:[]});await fire(e,'pointerup',{...base,clientX:100});assert.deepEqual(calls,[])}
  });
  await t.test('both real source branches are wired and root grants include native IME/detail/overlay gates',()=>{
   const collection=readFileSync(join(root,'src/still/StillCollection.tsx'),'utf8');assert.match(collection,/const localSourceSwipe = useSourceSwipe\(source, setSource, \{ disabled: !active \|\| selecting \|\| Boolean\(sheet\) \}\)/);assert.match(collection,/className="st-view st-knowledge-view" data-swipe-owner="sources" \{\.\.\.localSourceSwipe\}/);
   const views=readFileSync(join(root,'src/presentation/still01/Views.tsx'),'utf8');assert.match(views,/useSourceSwipe\(p.source,p.onSource,\{disabled:Boolean\(p.selecting\)\}\)/);
   const scrollCss=readFileSync(join(root,'src/still/kit/rootSwipe.css'),'utf8');assert.match(scrollCss,/\.st-root-stage\[data-swipe-owner="root"\] \.st-scroll\s*\{\s*touch-action: pan-y;/);
   const shell=readFileSync(join(root,'src/still/StillShell.tsx'),'utf8');assert.match(shell,/!top && !editingText && !lshIme && !overlayStack.depth\(\) && !navigating.current/);assert.match(shell,/RootSwipeContext.Provider value=\{\{ canNavigate: canSwipeRoot, navigate: navigateRootSwipe, navigateLsh: navigateLshSwipe \}\}/);
  });
 }finally{if(app)await lib.act(async()=>app.unmount());stop();for(const c of channels){c.port1.close();c.port2.close()}globalThis.MessageChannel=OriginalMessageChannel;dom.window.close();for(const [k,v]of old)if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k];delete globalThis.IS_REACT_ACT_ENVIRONMENT;rmSync(dir,{recursive:true,force:true})}
});
