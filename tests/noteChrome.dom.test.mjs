// Tests gesture arbitration and chrome state, not WebView pixel/IME behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url)),require=createRequire(import.meta.url);
const tools=process.env.LR_DOM_TEST_TOOLS?createRequire(join(resolve(process.env.LR_DOM_TEST_TOOLS),'__harness__.cjs')):require;
const {JSDOM}=tools('jsdom'),{build,stop}=createRequire(require.resolve('vite/package.json'))('esbuild');
test('note chrome follows reading gestures without following programmatic scroll',async t=>{
 const dom=new JSDOM('<div id="host"></div>',{url:'https://test.invalid/',pretendToBeVisual:true});
 const names=['window','document','navigator','HTMLElement','Element','Node','MutationObserver'];const old=new Map(names.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 for(const k of names)Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:dom.window[k]});
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 const channels=[],OriginalMessageChannel=globalThis.MessageChannel;globalThis.MessageChannel=class extends OriginalMessageChannel{constructor(){super();channels.push(this)}};
 const dir=mkdtempSync(join(tmpdir(),'lr-chrome-'));let app;
 try{
  const out=join(dir,'entry.cjs');await build({stdin:{contents:`import {createElement as h,useRef} from 'react';import {useNoteChrome} from './src/presentation/still01/editor/useNoteChrome';export {act,createElement} from 'react';export {createRoot} from 'react-dom/client';export function App(p){const root=useRef(null);useNoteChrome(root,p);return h('section',{'data-current':String(p.current!==false)},h('div',{ref:root,className:'st-note-surface'},h('header',null,h('button',null,'菜单')),h('main',{className:'st-note-paper'},h('input',{'aria-label':'标题'}),h('p',null,'正文')),h('footer',null,'工具栏')))}`,resolveDir:root,loader:'tsx'},outfile:out,bundle:true,platform:'node',format:'cjs'});
  const {act,createElement:h,createRoot,App}=require(out);app=createRoot(document.getElementById('host'));let props={scope:'a',mode:'read'};
  const render=async(p={})=>{props={...props,...p};await act(async()=>app.render(h(App,props)))};
  await render();const host=document.querySelector('.st-note-surface'),paper=document.querySelector('main');
  Object.defineProperties(paper,{scrollHeight:{value:2000,configurable:true},clientHeight:{value:600,configurable:true}});
  const fire=async(type,target=paper,values={})=>act(async()=>{const e=new dom.window.Event(type,{bubbles:true});for(const [k,v]of Object.entries(values))Object.defineProperty(e,k,{value:v});target.dispatchEvent(e)});
  const scroll=async top=>{paper.scrollTop=top;await fire('scroll')};
  const wheel=()=>fire('wheel',paper,{deltaY:100,deltaX:0});
  const hidden=()=>host.dataset.chromeHidden==='true';
  const reset=async()=>{await render({scope:props.scope+'x',blocked:false,mode:'read',current:true});paper.scrollTop=0};
  await t.test('restoration alone does not hide; user down hides and up reveals',async()=>{
   await scroll(150);assert.equal(hidden(),false);await wheel();await scroll(230);assert.equal(hidden(),true);
   await wheel();await scroll(210);assert.equal(hidden(),false);
  });
  await t.test('small movement, horizontal gestures, top and short notes do not hide',async()=>{
   await reset();await wheel();await scroll(25);assert.equal(hidden(),false);await scroll(100);assert.equal(hidden(),true);await scroll(-30);assert.equal(hidden(),false);
   await reset();await fire('pointerdown',paper,{clientX:10,clientY:100});await fire('pointermove',paper,{clientX:150,clientY:90});await scroll(180);assert.equal(hidden(),false);
   Object.defineProperty(paper,'scrollHeight',{value:650,configurable:true});await wheel();await scroll(50);assert.equal(hidden(),false);Object.defineProperty(paper,'scrollHeight',{value:2000,configurable:true});
  });
  await t.test('vertical touch and native momentum can hide; a stationary tap cannot',async()=>{
   await reset();await fire('pointerdown',paper,{clientX:10,clientY:300});await scroll(100);assert.equal(hidden(),false);
   await fire('pointermove',paper,{clientX:11,clientY:180});await fire('pointercancel');await scroll(200);assert.equal(hidden(),true);
  });
  await t.test('passive touchmove survives pointer cancellation, but taps and horizontal swipes do not',async()=>{
   await reset();await fire('touchstart',paper,{touches:[{clientX:10,clientY:300}]});await scroll(100);assert.equal(hidden(),false);
   await fire('pointercancel');await fire('touchmove',paper,{touches:[{clientX:12,clientY:220}]});await scroll(200);assert.equal(hidden(),true);await fire('touchend',paper,{touches:[]});
   await reset();await fire('touchstart',paper,{touches:[{clientX:10,clientY:300}]});await fire('touchmove',paper,{touches:[{clientX:110,clientY:295}]});await scroll(150);assert.equal(hidden(),false);
  });
  await t.test('editing focus, composition, selection, menus and keyboard keep controls available',async()=>{
   await reset();await wheel();await scroll(100);assert.equal(hidden(),true);await act(async()=>paper.querySelector('input').focus());assert.equal(hidden(),false);
   await wheel();await scroll(200);assert.equal(hidden(),false);paper.querySelector('input').blur();
   await fire('compositionstart');await wheel();await scroll(300);assert.equal(hidden(),false);await fire('compositionend');
   const selection=document.getSelection(),range=document.createRange();range.selectNodeContents(paper.querySelector('p'));selection.removeAllRanges();selection.addRange(range);assert.equal(selection.isCollapsed,false);await fire('selectionchange',document);await wheel();await scroll(400);assert.equal(hidden(),false);selection.removeAllRanges();
   const dialog=document.createElement('div');dialog.setAttribute('role','dialog');document.body.append(dialog);await wheel();await scroll(500);assert.equal(hidden(),false);dialog.remove();
   await wheel();await scroll(600);assert.equal(hidden(),true);await fire('keydown',document);assert.equal(hidden(),false);
  });
  await t.test('scope/mode/overlay/return/viewport changes reset hidden chrome',async()=>{
   for(const change of [{scope:'other'},{mode:'edit'},{blocked:true},{current:false}]){
    await reset();await wheel();await scroll(150);assert.equal(hidden(),true);await render(change);assert.equal(hidden(),false);
   }
   await reset();await wheel();await scroll(150);assert.equal(hidden(),true);await fire('resize',window);assert.equal(hidden(),false);
  });
  await t.test('CSS keeps one viewport, transform-only controls and reduced-motion support',()=>{
   const css=readFileSync(join(root,'src/still/kit/noteExperience.css'),'utf8');assert.match(css,/\.cm-scroller\.has-note-heading\{display:block!important/);assert.match(css,/prefers-reduced-motion:reduce/);assert.match(css,/data-chrome-hidden="true".*visibility:hidden/);assert.doesNotMatch(css,/data-chrome-hidden="true"[^}]+(?:height|padding):/);
  });
 }finally{if(app){const {act}=require(join(dir,'entry.cjs'));await act(async()=>app.unmount())}stop();for(const c of channels){c.port1.close();c.port2.close()}globalThis.MessageChannel=OriginalMessageChannel;dom.window.close();for(const[k,v]of old){if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k]}delete globalThis.IS_REACT_ACT_ENVIRONMENT;rmSync(dir,{recursive:true,force:true})}
});
