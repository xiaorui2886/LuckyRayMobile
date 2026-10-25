// Actual shared React hooks, CM6 view/live table input and native DOM events.
// Viewport dimensions are deterministic fixtures, not Android IME pixel QA.
import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url)),require=createRequire(import.meta.url),tools=process.env.LR_DOM_TEST_TOOLS?createRequire(join(resolve(process.env.LR_DOM_TEST_TOOLS),'__harness__.cjs')):require;
const {JSDOM}=tools('jsdom'),{build,stop}=createRequire(require.resolve('vite/package.json'))('esbuild');
test('edit-mode chrome follows the shared keyboard lifecycle without requiring blur',async t=>{
 const dom=new JSDOM('<div id="host"></div>',{url:'https://test.invalid/',pretendToBeVisual:true});
 const names=['window','Window','document','navigator','HTMLElement','Element','Node','Event','MouseEvent','KeyboardEvent','CustomEvent','MutationObserver','DOMRect','getComputedStyle','requestAnimationFrame','cancelAnimationFrame'];const old=new Map(names.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));for(const key of names)Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:['getComputedStyle','requestAnimationFrame','cancelAnimationFrame'].includes(key)?dom.window[key].bind(dom.window):dom.window[key]});
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;const channels=[],OriginalMessageChannel=globalThis.MessageChannel;globalThis.MessageChannel=class extends OriginalMessageChannel{constructor(){super();channels.push(this)}};
 const rect={left:0,right:400,top:0,bottom:24,width:400,height:24,x:0,y:0,toJSON(){return this}};dom.window.Range.prototype.getClientRects=()=>[rect];dom.window.Range.prototype.getBoundingClientRect=()=>rect;
 let layoutHeight=800,visualHeight=800,coarse=true;Object.defineProperty(window,'innerHeight',{get:()=>layoutHeight,configurable:true});const visual=new dom.window.EventTarget();Object.defineProperties(visual,{height:{get:()=>visualHeight},offsetTop:{value:0}});Object.defineProperty(window,'visualViewport',{value:visual,configurable:true});window.matchMedia=()=>({matches:coarse,addEventListener(){},removeEventListener(){}});
 const dir=mkdtempSync(join(tmpdir(),'lr-edit-chrome-'));let app,lib;
 try{
  const out=join(dir,'entry.cjs');await build({stdin:{contents:`import {createElement as h,useRef,useLayoutEffect} from 'react';import {useNoteChrome} from './src/presentation/still01/editor/useNoteChrome';import {useEditorTools} from './src/presentation/still01/editor/useEditorTools';import {EditorView} from '@codemirror/view';import {EditorState} from '@codemirror/state';import {cmLivePreview} from './src/presentation/still01/editor/cmLivePreview';export {NoteSurface} from './src/presentation/still01/Still';export function EditorBody(){const mount=useRef(null);useLayoutEffect(()=>{view=new EditorView({state:EditorState.create({doc:'first\\nlast'}),parent:mount.current});return()=>view.destroy()},[]);return h('div',{ref:mount,className:'st-note-editor is-cm'})}export {nativeTableInput} from './src/presentation/still01/editor/tableFocus';export {act,createElement} from 'react';export {createRoot} from 'react-dom/client';export let view;export function App(p){const tools=useEditorTools(),mount=useRef(null);useNoteChrome(tools.root,{scope:p.scope,mode:p.mode,blocked:p.blocked,keyboardOpen:tools.keyboardOpen});useLayoutEffect(()=>{view=new EditorView({state:EditorState.create({doc:'first\\n\\n| A | B |\\n| --- | --- |\\n| one | two |\\n\\nlast',extensions:[cmLivePreview({enabled:()=>true})]}),parent:mount.current});if(p.initialFocus==='title')tools.root.current.querySelector('.st-note-title').focus();else if(p.initialFocus)view.focus();return()=>view.destroy()},[p.scope]);return h('section',{'data-current':String(p.current!==false)},h('div',{ref:tools.root,'data-keyboard':String(tools.keyboardOpen),className:'st-note-surface'+(tools.expanded?' has-editor-tools':'')},h('header',null,h('button',null,'菜单')),h('main',{className:'st-note-paper'},h('input',{className:'st-note-title'}),h('div',{ref:mount,className:'st-note-editor is-cm'})),h('footer',{className:'st-reader-bottom'},'工具栏')))}`,resolveDir:root,loader:'tsx'},outfile:out,bundle:true,platform:'node',format:'cjs',define:{'import.meta.url':JSON.stringify('file://'+root+'/src/presentation/still01/editor/markdownParseClient.ts')},plugins:[{name:'native-boundary',setup(b){b.onResolve({filter:/services\/client$/},()=>({path:'client',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const api={};',loader:'js'}))}}]});
  lib=require(out);const {act,createElement:h,createRoot,App,nativeTableInput}=lib;app=createRoot(document.getElementById('host'));let props={scope:'a',mode:'edit',initialFocus:false};
  const render=async(p={})=>{props={...props,...p};await act(async()=>app.render(h(App,props)))};
  const fire=async(type,target,values={})=>act(async()=>{const e=new dom.window.Event(type,{bubbles:true});for(const[k,v]of Object.entries(values))Object.defineProperty(e,k,{value:v});target.dispatchEvent(e)});
  const host=()=>document.querySelector('.st-note-surface'),hidden=()=>host().dataset.chromeHidden==='true',keyboard=()=>host().dataset.keyboard;
  const scroller=()=>lib.view.scrollDOM;
  const scroll=async top=>{scroller().scrollTop=top;await fire('scroll',scroller())};
  const wheel=()=>fire('wheel',scroller(),{deltaY:100,deltaX:0});
  const resize=async(height,visualOnly=false)=>{visualHeight=height;if(!visualOnly)layoutHeight=height;await fire('resize',visualOnly?visual:window)};
  const tap=async target=>{await fire('pointerdown',target,{clientX:20,clientY:200});await fire('pointerup',target,{clientX:20,clientY:200})};
  const reset=async(initialFocus=false,height=800)=>{layoutHeight=visualHeight=height;coarse=true;document.getSelection().removeAllRanges();await act(async()=>app.unmount());app=createRoot(document.getElementById('host'));await render({scope:props.scope+'x',mode:'edit',blocked:false,current:true,initialFocus});Object.defineProperties(scroller(),{scrollHeight:{value:3000,configurable:true},clientHeight:{get:()=>visualHeight,configurable:true}});scroller().scrollTop=100};
  await render();
  await t.test('CM and real table input: open, close without blur, scroll down, reverse, tap and reopen',async()=>{
   for(const table of [false,true]){await reset();await act(async()=>{if(table)document.querySelector('.cm-lp-table td').dispatchEvent(new MouseEvent('click',{bubbles:true}));else lib.view.focus()});const focused=table?nativeTableInput(lib.view):lib.view.contentDOM;assert.equal(document.activeElement,focused);
    await resize(500);assert.equal(keyboard(),'true');await wheel();await scroll(200);assert.equal(hidden(),false);
    await resize(620);assert.equal(keyboard(),'true','IME overshoot remains open');await wheel();await scroll(300);assert.equal(hidden(),false);
    await resize(800);assert.equal(keyboard(),'false');assert.equal(document.activeElement,focused);await wheel();await scroll(400);assert.equal(hidden(),true);
    await wheel();await scroll(380);assert.equal(hidden(),false);await wheel();await scroll(480);assert.equal(hidden(),true);
    await tap(focused);assert.equal(hidden(),false);assert.equal(document.activeElement,focused);await resize(500);await wheel();await scroll(600);assert.equal(hidden(),false);
   }
  });
  await t.test('visualViewport-only keyboard resizing shares the same visibility signal',async()=>{
   await reset();await act(async()=>lib.view.focus());await resize(500,true);assert.equal(layoutHeight,800);assert.equal(keyboard(),'true');await wheel();await scroll(200);assert.equal(hidden(),false);await resize(800,true);await wheel();await scroll(300);assert.equal(hidden(),true);
  });
  await t.test('initial already-open focused editor stays unknown until observed gradual keyboard close',async()=>{
   await reset(true,500);assert.equal(keyboard(),'null');await wheel();await scroll(200);assert.equal(hidden(),false);for(const height of [530,560,600,700,800])await resize(height);assert.equal(keyboard(),'false');await wheel();await scroll(300);assert.equal(hidden(),true);
  });
  await t.test('initial title IME stays unknown when focus moves into body without another resize',async()=>{
   await reset('title',500);assert.equal(keyboard(),'null');assert.ok(document.activeElement.matches('.st-note-title'));await act(async()=>lib.view.focus());assert.equal(keyboard(),'null');await wheel();await scroll(250);assert.equal(hidden(),false);await resize(800);await wheel();await scroll(350);assert.equal(hidden(),true);
  });
  await t.test('closed IME does not allow composition, textarea ranges, dialog or blocked-page hiding',async()=>{
   await reset();await act(async()=>document.querySelector('.cm-lp-table td').dispatchEvent(new MouseEvent('click',{bubbles:true})));const input=nativeTableInput(lib.view);await resize(500);await resize(800);
   await fire('compositionstart',input);await wheel();await scroll(200);assert.equal(hidden(),false);await fire('compositionend',input);
   await act(async()=>input.setSelectionRange(0,2));await wheel();await scroll(300);assert.equal(hidden(),false);await act(async()=>input.setSelectionRange(2,2));
   const dialog=document.createElement('div');dialog.setAttribute('role','dialog');document.body.append(dialog);await wheel();await scroll(400);assert.equal(hidden(),false);dialog.remove();
   await render({blocked:true});await wheel();await scroll(500);assert.equal(hidden(),false);await render({blocked:false});await wheel();await scroll(600);assert.equal(hidden(),true);
   await fire('input',input);assert.equal(hidden(),false);assert.equal(input.isConnected,true);
  });
  await t.test('programmatic scrolling, mode changes, taps and horizontal drags never masquerade as reading pan',async()=>{
   await reset();await act(async()=>lib.view.focus());await resize(500);await resize(800);await scroll(250);assert.equal(hidden(),false);
   await tap(lib.view.contentDOM);await scroll(350);assert.equal(hidden(),false);
   await fire('pointerdown',lib.view.contentDOM,{clientX:10,clientY:200});await fire('pointermove',lib.view.contentDOM,{clientX:150,clientY:195});await scroll(450);assert.equal(hidden(),false);await fire('pointerup',lib.view.contentDOM);await wheel();await scroll(550);assert.equal(hidden(),true);
   await render({mode:'read'});assert.equal(hidden(),false);await scroll(650);assert.equal(hidden(),false);
  });
  await t.test('vertical pan hides after close, pointercancel preserves momentum, desktop focus remains protected',async()=>{
   await reset();await act(async()=>lib.view.focus());await resize(500);await resize(800);await fire('pointerdown',lib.view.contentDOM,{clientX:10,clientY:300});await fire('pointermove',lib.view.contentDOM,{clientX:10,clientY:200});await fire('pointercancel',lib.view.contentDOM);await scroll(250);assert.equal(hidden(),true);
   await reset();coarse=false;await act(async()=>lib.view.focus());await wheel();await scroll(250);assert.equal(hidden(),false);
  });
  await t.test('toolbar drag and wheel do not authorize programmatic document scrolling',async()=>{
   await reset();await act(async()=>lib.view.focus());await resize(500);await resize(800);const bar=document.querySelector('footer');await fire('pointerdown',bar,{clientX:10,clientY:300});await fire('pointermove',bar,{clientX:10,clientY:200});await scroll(250);assert.equal(hidden(),false);await fire('pointerup',bar);await fire('wheel',bar,{deltaY:100,deltaX:0});await scroll(350);assert.equal(hidden(),false);
  });

  await t.test('actual NoteSurface wires keyboard close to both toolbars and removes their hit targets',async()=>{
   await act(async()=>app.unmount());app=createRoot(document.getElementById('host'));layoutHeight=visualHeight=800;coarse=true;
   const noop=()=>{},props={title:'Title',body:'first\nlast',notebook:'Test',mode:'edit',state:'local',onBack:noop,onBrowse:noop,onMore:noop,onNew:noop,onEdit:noop,onRead:noop,onChange:noop,onFormat:noop,onSearch:noop,onState:noop,onCommand:noop,bodyEditor:h(lib.EditorBody)};
   await act(async()=>app.render(h('div',{className:'st-app'},h(lib.NoteSurface,props))));
   Object.defineProperties(scroller(),{scrollHeight:{value:3000,configurable:true},clientHeight:{get:()=>visualHeight,configurable:true}});scroller().scrollTop=100;
   const style=document.createElement('style');style.textContent=readFileSync(join(root,'src/still/kit/noteExperience.css'),'utf8');document.head.append(style);
   await act(async()=>lib.view.focus());const focused=lib.view.contentDOM;await resize(500);await wheel();await scroll(200);assert.equal(hidden(),false);assert.ok(host().classList.contains('has-editor-tools'));
   await resize(800);assert.equal(document.activeElement,focused);await wheel();await scroll(300);assert.equal(hidden(),true);
   for(const target of [host().querySelector('.st-header'),host().querySelector('.st-reader-bottom')]){assert.equal(getComputedStyle(target).visibility,'hidden');assert.equal(getComputedStyle(target).pointerEvents,'none')}
   assert.equal(getComputedStyle(host().querySelector('.st-reader-tools')).pointerEvents,'none');
   await tap(focused);assert.equal(hidden(),false);assert.equal(getComputedStyle(host().querySelector('.st-header')).visibility,'visible');
   await wheel();await scroll(400);assert.equal(hidden(),true);await fire('input',focused);assert.equal(hidden(),false);assert.equal(document.activeElement,focused);style.remove();
  });
  await t.test('production wiring uses the shared signal and hidden chrome removes hit targets without resizing',()=>{
   assert.match(readFileSync(join(root,'src/presentation/still01/Still.tsx'),'utf8'),/useNoteChrome\(tools.root,\{scope:p.editorScope,mode:p.mode,blocked:p.chromeBlocked\|\|hasWarning,keyboardOpen:tools.keyboardOpen\}\)/);
   const css=readFileSync(join(root,'src/still/kit/noteExperience.css'),'utf8');assert.match(css,/data-chrome-hidden="true"\]>.st-header[^}]*visibility:hidden;pointer-events:none/);assert.match(css,/data-chrome-hidden="true"\]>.st-reader-bottom[^}]*visibility:hidden;pointer-events:none/);assert.match(css,/data-chrome-hidden="true"\]>.st-reader-bottom .st-reader-tools\{pointer-events:none/);
  });
 }finally{if(app&&lib)await lib.act(async()=>app.unmount());stop();for(const c of channels){c.port1.close();c.port2.close()}globalThis.MessageChannel=OriginalMessageChannel;dom.window.close();for(const[k,v]of old){if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k]}delete globalThis.IS_REACT_ACT_ENVIRONMENT;rmSync(dir,{recursive:true,force:true})}
});
