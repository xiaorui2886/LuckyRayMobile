// Production React rail, side panel, MobileCmEditor and table widget. JSDOM
// cannot certify Android compositor/IME pixels. Native IPC is mocked and
// geometry is deterministic; native event dispatch exercises the real owners.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
const root=process.env.LR_RAIL_SOURCE_ROOT||fileURLToPath(new URL('..',import.meta.url));
const require=createRequire(import.meta.url),tools=process.env.LR_DOM_TEST_TOOLS?createRequire(join(resolve(process.env.LR_DOM_TEST_TOOLS),'__harness__.cjs')):require;
const {JSDOM}=tools('jsdom'),{build,stop}=createRequire(require.resolve('vite/package.json'))('esbuild');
test('paper gesture survives production availability refresh and touch target lifecycle',async t=>{
 const dom=new JSDOM('<div class="st-app"><div id="host"></div></div>',{url:'https://test.invalid',pretendToBeVisual:true});
 const keys=['window','Window','document','navigator','HTMLElement','Element','Node','Event','MouseEvent','KeyboardEvent','MutationObserver','DOMRect','getComputedStyle','requestAnimationFrame','cancelAnimationFrame'];const old=new Map(keys.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 for(const key of keys)Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:['getComputedStyle','requestAnimationFrame','cancelAnimationFrame'].includes(key)?dom.window[key].bind(dom.window):dom.window[key]});
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 const rect={left:0,right:400,top:0,bottom:700,width:400,height:700,x:0,y:0,toJSON(){return this}};
 const originalRect=dom.window.HTMLElement.prototype.getBoundingClientRect;dom.window.HTMLElement.prototype.getBoundingClientRect=function(){return this.classList.contains('st-note-paper-viewport')?rect:originalRect.call(this)};
 dom.window.Range.prototype.getClientRects=()=>[{...rect,height:24,bottom:24}];dom.window.Range.prototype.getBoundingClientRect=()=>({...rect,height:24,bottom:24});
 const channels=[],MC=globalThis.MessageChannel;globalThis.MessageChannel=class extends MC{constructor(){super();channels.push(this)}};
 const dir=mkdtempSync(join(tmpdir(),'lr-paper-cm-'));let app,api;
 try{
  const out=join(dir,'entry.cjs');await build({stdin:{contents:`
import React,{useState} from 'react';import {NotePaperRail} from './src/still/kit/NotePaperRail';import {NoteSidePanel} from './src/still/kit/NoteSidePanel';import {MobileCmEditor} from './src/presentation/still01/editor/MobileCmEditor';import {SafeNoteMarkdown} from './src/components/SafeNoteMarkdown';
export {act,createElement} from 'react';export {createRoot} from 'react-dom/client';export {peekCmView,destroyAllCmViews} from './src/presentation/still01/editor/cmEditorSessions';
const body=${JSON.stringify('# Paper\n\n\x60\x60\x60css\n.example { color: red; }\n\x60\x60\x60\n\n| A | B |\n| --- | --- |\n| one | two |\n\nTail')};
const status=()=> 'resolved';export function Harness(){const [panel,setPanel]=useState(null),[source,setSource]=useState(false),[value,setValue]=useState(body);window.__panel=setPanel;window.__source=setSource;window.__body=setValue;return <NotePaperRail panel={panel} onPanelChange={setPanel}><div className="st-note-surface" data-viewport-blocked={Boolean(panel)}><button id="open" onClick={()=>setPanel('left')}>open</button><MobileCmEditor scope="paper:cm" value={value} onChange={setValue} sourceMode={source} assistActive={!panel} linkStatus={reference => panel ? 'unknown' : status(reference)}/><div id="reader"><SafeNoteMarkdown content={value}/></div></div>{panel?<NoteSidePanel side={panel} title={panel} registerOverlay={()=>()=>{}} onClose={()=>setPanel(null)}><p id="panel-text">panel</p><button id="panel-control">control</button></NoteSidePanel>:null}</NotePaperRail>}`,resolveDir:root,loader:'tsx'},outfile:out,bundle:true,platform:'node',format:'cjs',loader:{'.css':'empty'},define:{'import.meta.url':JSON.stringify('file://'+root+'/src/presentation/still01/editor/markdownParseClient.ts')},plugins:[{name:'native-boundary',setup(b){b.onResolve({filter:/services\/client$/},()=>({path:'client',namespace:'mock'}));b.onResolve({filter:/StillImports$/},()=>({path:'ui',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:args.path==='client'?'export const api={};':'import React from "react";export const IconButton=({label,onClick})=>React.createElement("button",{onClick,"aria-label":label},label);',loader:'js',resolveDir:root})) }}]});
  api=require(out);app=api.createRoot(document.getElementById('host'));await api.act(async()=>app.render(api.createElement(api.Harness)));
  const view=api.peekCmView('paper:cm'),rail=()=>document.querySelector('.st-note-paper-viewport');assert.ok(view);assert.ok(document.querySelector('.cm-lp-table'));
  const touch=async(target,type,x,y=150)=>{await api.act(async()=>{const e=new Event(type,{bubbles:true,cancelable:true});const points=type==='touchend'||type==='touchcancel'?[]:[{identifier:1,clientX:x,clientY:y}];Object.defineProperties(e,{touches:{value:points},targetTouches:{value:points},changedTouches:{value:[{identifier:1,clientX:x,clientY:y}]}});target.dispatchEvent(e);await new Promise(r=>setTimeout(r,1))})};
  const close=async()=>{await api.act(async()=>{document.querySelector('.st-note-paper-return')?.click();await new Promise(r=>setTimeout(r,280))})};
  await t.test('root-target tap and canceled drag retain permanent rail listeners',async()=>{
   await touch(rail(),'touchstart',100);await touch(rail(),'touchend',100);
   await touch(rail(),'touchstart',100);await touch(rail(),'touchmove',114);await touch(rail(),'touchcancel',114);
   const cell=view.contentDOM.querySelector('.cm-lp-table td');
   try {await touch(cell,'touchstart',100);await touch(cell,'touchmove',290);await touch(cell,'touchend',290);assert.equal(rail().dataset.panel,'left');assert.equal(document.querySelector('.st-note-paper-track').style.transform,'translate3d(344px,0,0)');}
   finally {await api.act(async()=>window.__panel(null));await close()}
  });
  await t.test('availability updates keep the original table target throughout slow left and right drags',async()=>{
   for(const [start,first,end,side] of [[100,114,290,'left'],[290,276,100,'right']]){
    const cell=view.contentDOM.querySelector('.cm-lp-table td'),table=cell.closest('table'),viewport=table.parentElement;
    try { await touch(cell,'touchstart',start);await touch(cell,'touchmove',first);
    assert.equal(rail().dataset.panel,side);
    assert.equal(cell.isConnected,true,'first directional move must not replace native touch target');
    assert.equal(view.contentDOM.querySelector('.cm-lp-table'),table,'availability is not a table redraw');
    assert.equal(table.parentElement,viewport);
    await touch(cell,'touchmove',(first+end)/2);await touch(cell,'touchmove',end);
    assert.equal(document.querySelector('.st-note-paper-track').style.transform,`translate3d(${end-start}px,0,0)`);
    await touch(cell,'touchend',end);
    assert.equal(document.querySelector('.st-note-paper-track').style.transform,`translate3d(${side==='left'?344:-344}px,0,0)`);
    } finally { await api.act(async()=>window.__panel(null)); await close(); }
   }
  });
  await t.test('real source replacement cannot strand a detached original touch stream',async()=>{
   const before=view.state.doc.toString();
   for(const [start,first,end,side] of [[100,114,290,'left'],[290,276,100,'right']]){
    const cell=view.contentDOM.querySelector('.cm-lp-table td');
    try {
     await touch(cell,'touchstart',start);await touch(cell,'touchmove',first);
     await api.act(async()=>window.__body(before.replace('one','changed cell')));
     assert.equal(cell.isConnected,false,'exercise a real replaced table target, not a different live node');
     await touch(cell,'touchmove',end);await touch(cell,'touchend',end);
     assert.equal(rail().dataset.panel,side);
     assert.equal(document.querySelector('.st-note-paper-track').style.transform,`translate3d(${side==='left'?344:-344}px,0,0)`);
     assert.equal(rail().classList.contains('is-dragging'),false);
     assert.match(view.state.doc.toString(),/changed cell/);
    } finally { await api.act(async()=>{window.__panel(null);window.__body(before)}); await close(); }
   }
  });
  await t.test('legitimate wiki-status changes still refresh table presentation without losing the stream',async()=>{
   const before=view.state.doc.toString();await api.act(async()=>window.__body(before.replace('one','[[Target]]')));
   const cell=view.contentDOM.querySelector('.cm-lp-table td');assert.ok(cell.querySelector('.cm-lp-link.is-resolved'));
   try {
    await touch(cell,'touchstart',100);await touch(cell,'touchmove',114);
    assert.ok(view.contentDOM.querySelector('.cm-lp-table .cm-lp-link.is-unknown'),'new status not suppressed by identity optimization');
    await touch(cell,'touchmove',290);await touch(cell,'touchend',290);
    assert.equal(document.querySelector('.st-note-paper-track').style.transform,'translate3d(344px,0,0)');
    await close();assert.ok(view.contentDOM.querySelector('.cm-lp-table .cm-lp-link.is-resolved'));
   } finally { await api.act(async()=>{window.__panel(null);window.__body(before)});await close(); }
  });
  await t.test('horizontal code gesture holds vertical pixels through native cancellation and sidebar return',async()=>{
   const code=view.contentDOM.querySelector('.cm-lp-code');
   for(const [start,end,side] of [[100,280,'left'],[280,100,'right']]){
    try { view.scrollDOM.dispatchEvent(new Event('wheel',{bubbles:true}));view.scrollDOM.scrollTop=312;
    await touch(code,'touchstart',start);await touch(code,'touchmove',end);
    await api.act(async()=>{code.dispatchEvent(new Event('pointercancel',{bubbles:true}));view.scrollDOM.scrollTop=30;view.scrollDOM.dispatchEvent(new Event('scroll'));await new Promise(r=>setTimeout(r,45))});
    assert.equal(view.scrollDOM.scrollTop,312,'horizontal gesture does not grant vertical navigation');
    await touch(code,'touchend',end);assert.equal(rail().dataset.panel,side);
    const drawer=document.querySelector('#panel-text');await touch(drawer,'touchstart',end);await touch(drawer,'touchmove',start);
    await api.act(async()=>{view.scrollDOM.scrollTop=20;view.scrollDOM.dispatchEvent(new Event('scroll'));await new Promise(r=>setTimeout(r,45))});
    assert.equal(view.scrollDOM.scrollTop,312,'return gesture retains the same viewport owner');
    await touch(drawer,'touchend',start);await api.act(async()=>new Promise(r=>setTimeout(r,280)));assert.equal(rail().dataset.panel,'none');
    } finally { await api.act(async()=>window.__panel(null)); await close(); }
   }
  });
  await t.test('cell input, table handle and composition keep editing ownership',async()=>{await api.act(async()=>new Promise(r=>setTimeout(r,480)));const cell=view.contentDOM.querySelector('.cm-lp-table td');await api.act(async()=>cell.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1})));const input=view.scrollDOM.querySelector('.cm-lp-table-input');assert.ok(input);for(const target of [input,view.contentDOM.querySelector('[data-table-grip]')]){assert.ok(target);await touch(target,'touchstart',110);await touch(target,'touchmove',290);await touch(target,'touchcancel',290);assert.equal(rail().dataset.panel,'none')}
   await api.act(async()=>input.dispatchEvent(new Event('compositionstart',{bubbles:true})));await touch(cell,'touchstart',110);await touch(cell,'touchmove',290);await touch(cell,'touchend',290);assert.equal(rail().dataset.panel,'none');await api.act(async()=>input.dispatchEvent(new Event('compositionend',{bubbles:true})));await api.act(async()=>new Promise(r=>setTimeout(r,40)));
  });
  await t.test('source mode toggles keep CM instance; narrow code remains swipeable',async()=>{await api.act(async()=>{document.getElementById('open').focus();window.__source(true)});assert.equal(api.peekCmView('paper:cm')===view,true);await touch(view.contentDOM,'touchstart',290);await touch(view.contentDOM,'touchmove',100);await touch(view.contentDOM,'touchend',100);assert.equal(rail().dataset.panel,'right');await close();await api.act(async()=>window.__source(false));assert.equal(api.peekCmView('paper:cm')===view,true);assert.ok(view.contentDOM.querySelector('.cm-lp-table'));});
  await t.test('actual read-mode table and wide/narrow code preserve directional content scrolling',async()=>{await api.act(async()=>document.getElementById('open').focus());const table=document.querySelector('#reader td');assert.ok(table);await touch(table,'touchstart',110);await touch(table,'touchmove',290);await touch(table,'touchend',290);assert.equal(rail().dataset.panel,'left');await close();
   const code=document.querySelector('#reader pre');assert.ok(code);code.style.overflowX='auto';Object.defineProperties(code,{clientWidth:{configurable:true,value:300},scrollWidth:{configurable:true,value:700}});code.scrollLeft=100;
   await touch(code,'touchstart',110);await touch(code,'touchmove',290);await touch(code,'touchend',290);assert.equal(rail().dataset.panel,'none','overflow code consumes its own horizontal pan');
   code.scrollLeft=0;await touch(code,'touchstart',110);await touch(code,'touchmove',290);await touch(code,'touchend',290);assert.equal(rail().dataset.panel,'left','outward new gesture at code boundary reaches panel');await close();Object.defineProperty(code,'scrollWidth',{configurable:true,value:300});await touch(code,'touchstart',290);await touch(code,'touchmove',110);await touch(code,'touchend',110);assert.equal(rail().dataset.panel,'right','fitting code does not trap gesture');await close();delete code.scrollWidth;delete code.clientWidth;
  });
  await t.test('external source update while sidebar is open keeps its authoritative CM owner',async()=>{const code=view.contentDOM.querySelector('.cm-lp-code'),before=view.state.doc.toString();await touch(code,'touchstart',110);await touch(code,'touchmove',290);await touch(code,'touchend',290);await api.act(async()=>window.__body(before+'\nExternal appended'));assert.equal(api.peekCmView('paper:cm')===view,true);assert.equal(view.state.doc.toString(),before+'\nExternal appended');await close();assert.equal(view.state.doc.toString(),before+'\nExternal appended');assert.ok(view.contentDOM.querySelector('.cm-lp-table'));assert.equal(document.querySelector('.cm-lp-preview-status')?.hidden,true)});
  await t.test('explicit button opening still supports dialog keyboard focus',async()=>{await api.act(async()=>{document.getElementById('open').focus();document.getElementById('open').click()});assert.equal(document.activeElement.classList.contains('st-note-drawer'),true);await close();assert.equal(document.activeElement.id,'open')});
 }finally{if(app&&api)await api.act(async()=>app.unmount());api?.destroyAllCmViews();stop();for(const c of channels){c.port1.close();c.port2.close()}globalThis.MessageChannel=MC;dom.window.close();for(const [k,v]of old)if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k];delete globalThis.IS_REACT_ACT_ENVIRONMENT;rmSync(dir,{recursive:true,force:true})}
});
