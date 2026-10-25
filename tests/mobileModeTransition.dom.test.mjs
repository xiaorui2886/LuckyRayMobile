// Real React + CodeMirror, manually delayed local Worker transport.
// Visibility contracts are DOM-level; Android pixels/IME remain a device gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url)),require=createRequire(import.meta.url);
const tools=process.env.LR_DOM_TEST_TOOLS?createRequire(join(resolve(process.env.LR_DOM_TEST_TOOLS),'__harness__.cjs')):require;
const {JSDOM}=tools('jsdom'),{build,stop}=createRequire(require.resolve('vite/package.json'))('esbuild');
test('read to edit handoff owns its first decorated frame',async t=>{
 const dom=new JSDOM('<div class="st-app"><main class="st-note-paper" id="host"></main></div>',{url:'https://test.invalid/',pretendToBeVisual:true});
 const names=['window','Window','document','navigator','HTMLElement','Element','Node','Event','MouseEvent','KeyboardEvent','CustomEvent','MutationObserver','DOMRect','getComputedStyle'];const old=new Map(names.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 for(const key of names)Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:key==='getComputedStyle'?dom.window.getComputedStyle.bind(dom.window):dom.window[key]});
 globalThis.requestAnimationFrame=dom.window.requestAnimationFrame.bind(dom.window);globalThis.cancelAnimationFrame=dom.window.cancelAnimationFrame.bind(dom.window);globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 const rect={left:0,right:600,top:0,bottom:24,width:600,height:24,x:0,y:0,toJSON(){return this}};dom.window.Range.prototype.getClientRects=()=>[rect];dom.window.Range.prototype.getBoundingClientRect=()=>rect;
 const channels=[],OriginalMessageChannel=globalThis.MessageChannel;globalThis.MessageChannel=class extends OriginalMessageChannel{constructor(){super();channels.push(this)}};
 const dir=mkdtempSync(join(tmpdir(),'lr-mode-transition-'));let rootView,lib,props,readRenders=0;const workers=[],saves=[];
 try{
  const out=join(dir,'entry.cjs');await build({stdin:{contents:`export {createElement,act} from 'react';export {createRoot} from 'react-dom/client';export {undo} from '@codemirror/commands';export {MobileCmEditor} from './src/presentation/still01/editor/MobileCmEditor';export {NoteBodyTransition} from './src/presentation/still01/editor/NoteBodyTransition';export {mobileLivePreviewModel} from './src/presentation/still01/editor/mobileLivePreviewModel';export {editorImageRanges} from './src/presentation/still01/editor/editorImageRanges';export {peekCmView,destroyAllCmViews} from './src/presentation/still01/editor/cmEditorSessions';`,resolveDir:root,loader:'tsx'},outfile:out,bundle:true,platform:'node',format:'cjs',loader:{'.css':'empty'},define:{'import.meta.url':JSON.stringify('file://'+root+'/src/presentation/still01/editor/markdownParseClient.ts')},plugins:[{name:'native-boundary',setup(b){b.onResolve({filter:/services\/client$/},()=>({path:'client',namespace:'lp-mock'}));b.onLoad({filter:/.*/,namespace:'lp-mock'},()=>({contents:'export const api={contentCachedResource:async()=>null,contentCancel:async()=>{}};',loader:'js'}))}}]});
  lib=require(out);const {act,createElement:h,createRoot,MobileCmEditor,NoteBodyTransition,peekCmView,mobileLivePreviewModel,editorImageRanges}=lib;
  globalThis.Worker=class {onmessage=null;onerror=null;messages=[];terminated=false;constructor(){workers.push(this)}postMessage(job){this.messages.push(job)}terminate(){this.terminated=true}reply(job=this.messages.at(-1)){this.onmessage?.({data:{id:job.id,result:job.kind==='images'?editorImageRanges(job.source,job.resources):mobileLivePreviewModel(job.source,job.resources)}})}};
  const delay=async(ms=12)=>act(async()=>new Promise(r=>setTimeout(r,ms)));
  const Reader=({body})=>{readRenders++;return h('article',{'data-reader':'true'},h('strong',null,body.slice(2,6)),h('button',{onClick:()=>{throw new Error('temporary reader control must not act')}},'Reader link'))};
  rootView=createRoot(document.getElementById('host'));
  const source='**bold**\n'+'plain text\n'.repeat(1300);
  const render=async patch=>{props={...props,...patch};await act(async()=>rootView.render(h(NoteBodyTransition,{heading:props.testHeading?h('input',{className:'st-note-title',defaultValue:'标题', 'aria-label':'笔记标题'}):undefined,mode:props.mode,scope:props.scope,body:props.value,editor:h(MobileCmEditor,{...props,onChange:next=>saves.push(next)})},h(Reader,{body:props.value}))))};
  let sequence=0;
  const start=async(value=source,extra={})=>{await act(async()=>rootView.render(null));lib.destroyAllCmViews();workers.length=0;saves.length=0;props={scope:'local:transition-'+(++sequence),mode:'read',value,...extra};await render({});return document.querySelector('[data-reader]')};
  const visible=()=>document.querySelector('[data-preview-handoff]')?.dataset.previewHandoff;
  const respond=async(worker,job)=>act(async()=>worker.reply(job));
  const latest=kind=>workers.filter(w=>!w.terminated&&w.messages.some(j=>j.kind===kind)).at(-1);
  await t.test('same reader DOM is retained without reparsing until current decorations exist',async()=>{
   const reader=await start(),count=readRenders;await render({mode:'edit'});await delay();assert.equal(visible(),'pending');assert.equal(document.querySelector('[data-reader]'),reader);assert.equal(readRenders,count);assert.equal(document.querySelector('[data-preview-handoff]').style.opacity,'0');assert.equal(document.querySelector('.cm-lp-strong'),null);
   await respond(latest('preview'));assert.equal(visible(),'ready');assert.ok(document.querySelector('.cm-lp-strong'));assert.equal(document.querySelector('[data-reader]'),null);assert.equal(peekCmView(props.scope).state.doc.toString(),source);assert.equal(saves.length,0);assert.equal(document.querySelector('[data-preview-handoff]').style.display,'contents');
  });
  await t.test('title shares CM scroll viewport only after preview settles and never changes source',async()=>{
   await start(source,{testHeading:true});const title=document.querySelector('.st-note-title');title.focus();title.setSelectionRange(1,2);await act(async()=>title.dispatchEvent(new Event('compositionstart',{bubbles:true})));
   await render({mode:'edit'});await delay();assert.equal(visible(),'pending');assert.equal(document.querySelector('.cm-scroller .st-note-title'),null);assert.equal(document.querySelectorAll('.st-note-title').length,1);
   await respond(latest('preview'));assert.equal(visible(),'ready');const view=peekCmView(props.scope);
   assert.equal(document.querySelectorAll('.st-note-title').length,1);assert.equal(document.querySelector('.st-note-title'),title);assert.equal(view.scrollDOM.querySelector('.st-note-title'),null);assert.equal(view.contentDOM.contains(document.querySelector('.st-note-title')),false);
   assert.equal(document.activeElement,document.querySelector('.st-note-title'));assert.equal(document.activeElement.selectionStart,1);assert.equal(document.activeElement.selectionEnd,2);
   await act(async()=>title.dispatchEvent(new Event('compositionend',{bubbles:true})));assert.equal(document.querySelector('.st-note-title'),title);await act(async()=>title.blur());assert.equal(view.scrollDOM.querySelector('.st-note-title'),title);
   assert.equal(view.state.doc.toString(),source);assert.equal(saves.length,0);
   await render({mode:'read'});assert.equal(document.querySelectorAll('.st-note-title').length,1);assert.equal(document.querySelector('.cm-scroller'),null);
   await render({mode:'edit'});await delay();if(visible()==='pending')await respond(latest('preview'));
   assert.equal(document.querySelectorAll('.st-note-title').length,1);assert.equal(view.scrollDOM.querySelectorAll('.st-note-heading').length,1);assert.equal(view.state.doc.toString(),source);assert.equal(saves.length,0);
  });
  await t.test('rapid mode generations reject retired Worker callbacks',async()=>{
   await start();await render({mode:'edit'});await delay();const old=latest('preview'),job=old.messages[0];await render({mode:'read'});await render({mode:'edit'});await delay();await respond(old,job);assert.equal(visible(),'pending');await respond(latest('preview'));assert.equal(visible(),'ready');
  });
  await t.test('scope change never covers new editor with an old identical note',async()=>{
   await start();await render({mode:'edit'});await delay();const old=latest('preview');await render({scope:'local:other-owner'});assert.equal(visible(),'pending');assert.equal(document.querySelector('[data-reader]'),null);await respond(old);assert.equal(visible(),'pending');await delay();await respond(latest('preview'));assert.equal(peekCmView(props.scope).state.doc.toString(),source);
  });
  await t.test('authoritative newer body releases obsolete reader and rejects old result',async()=>{
   await start();await render({mode:'edit'});await delay();const worker=latest('preview'),old=worker.messages[0];const newer=source.replace('bold','new!');await render({value:newer});assert.equal(document.querySelector('[data-reader]'),null);await respond(worker,old);assert.equal(document.querySelector('.cm-lp-strong'),null);await delay(180);await respond(worker);assert.equal(document.querySelector('.cm-lp-strong').textContent,'new!');assert.equal(saves.length,0);
  });
  await t.test('CRLF original source can hand off without mutation or deadlock',async()=>{
   const crlf=source.replaceAll('\n','\r\n');await start(crlf);await render({mode:'edit'});await delay();await respond(latest('preview'));assert.equal(visible(),'ready');assert.equal(peekCmView(props.scope).state.doc.toString(),source);assert.equal(saves.length,0);
  });
  await t.test('explicit source mode bypasses the pending preview',async()=>{
   await start();await render({mode:'edit'});await delay();await render({sourceMode:true});assert.equal(visible(),'ready');assert.match(peekCmView(props.scope).contentDOM.textContent,/\*\*bold\*\*/);assert.equal(saves.length,0);
  });
  await t.test('pending reader suppresses temporary link sessions but explicit body focus still opens editing',async()=>{
   await start();await render({mode:'edit'});await delay();await act(async()=>document.querySelector('[data-reader] button').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})));assert.equal(visible(),'pending');await render({focusRequest:{scope:props.scope,offset:3}});assert.equal(peekCmView(props.scope).hasFocus,true);assert.equal(peekCmView(props.scope).state.selection.main.head,3);await act(async()=>peekCmView(props.scope).contentDOM.dispatchEvent(new Event('compositionstart',{bubbles:true})));assert.equal(visible(),'ready');
  });
  await t.test('native WebView beforeinput releases the cover before a text mutation',async()=>{
   await start();await render({mode:'edit'});await delay();const view=peekCmView(props.scope);await act(async()=>view.contentDOM.dispatchEvent(new dom.window.InputEvent('beforeinput',{bubbles:true,inputType:'insertText',data:'x'})));assert.equal(visible(),'ready');assert.equal(view.state.doc.toString(),source);assert.equal(saves.length,0);
  });
  await t.test('composition begins visibly without forced focus or lost source',async()=>{
   await start();await render({mode:'edit'});await delay();const view=peekCmView(props.scope);await act(async()=>{view.focus();view.contentDOM.dispatchEvent(new Event('compositionstart',{bubbles:true}));});assert.equal(visible(),'ready');assert.equal(view.hasFocus,true);await act(async()=>view.dispatch({changes:{from:source.length,insert:'中'},userEvent:'input.type.compose'}));assert.equal(view.state.doc.toString(),source+'中');assert.equal(saves.length,1);await act(async()=>view.contentDOM.dispatchEvent(new Event('compositionend',{bubbles:true})));await delay(70);
  });
  await t.test('missing Worker reveals truthful fallback rather than permanent cover',async()=>{
   const Worker=globalThis.Worker;delete globalThis.Worker;try{await start();await render({mode:'edit'});await delay();assert.equal(visible(),'pending');assert.match(document.querySelector('.st-note-preview-unavailable').textContent,/原文已保留/);await act(async()=>document.querySelector('.st-note-preview-unavailable button').click());assert.equal(visible(),'ready')}finally{globalThis.Worker=Worker}
  });
  await t.test('both transport failures release reader with explicit fallback',async()=>{
   await start();await render({mode:'edit'});await delay();await act(async()=>latest('preview').onerror());await delay(180);await act(async()=>latest('preview').onerror());await delay(180);assert.equal(visible(),'pending');assert.ok(document.querySelector('.st-note-preview-unavailable'));await act(async()=>document.querySelector('.st-note-preview-unavailable button').click());assert.equal(visible(),'ready');
  });
  await t.test('image parser must also settle before editor is revealed',async()=>{
   await start(source,{imageScope:{instance:'d',vault:'v',note:'n',resources:[],online:false}});await render({mode:'edit'});await delay();await respond(latest('preview'));assert.equal(visible(),'pending');await respond(latest('images'));assert.equal(visible(),'ready');
  });
  await t.test('link-status refresh during image wait does not lose image readiness',async()=>{
   await start(source,{imageScope:{instance:'d',vault:'v',note:'n',resources:[],online:false}});await render({mode:'edit'});await delay();await respond(latest('images'));await render({linkStatus:()=> 'resolved'});await delay();await respond(latest('preview'));assert.equal(visible(),'ready');
  });
  await t.test('preview-first link refresh never discards decorated text during image wait',async()=>{
   await start(source,{imageScope:{instance:'d',vault:'v',note:'n',resources:[],online:false}});await render({mode:'edit'});await delay();await respond(latest('preview'));const worker=latest('preview');assert.equal(visible(),'pending');await render({linkStatus:()=> 'resolved'});assert.ok(document.querySelector('.cm-lp-strong'));assert.equal(latest('preview'),worker);await respond(latest('images'));assert.equal(visible(),'ready');assert.ok(document.querySelector('.cm-lp-strong'));
  });
  if(process.env.LR_ORIGINAL_MD) await t.test('owner original handoff uses real production Worker and preserves exact source and undo',async()=>{
   const {readFileSync,readdirSync}=require('node:fs'),vm=require('node:vm'),{createHash}=require('node:crypto');
   const original=readFileSync(process.env.LR_ORIGINAL_MD,'utf8'),hash=s=>createHash('sha256').update(s).digest('hex'),before=hash(original);
   const artifact=readdirSync(join(root,'dist/assets')).find(name=>/^markdownPreview\.worker-.*\.js$/.test(name));const code=readFileSync(join(root,'dist/assets',artifact),'utf8');
   await start(original);const reader=document.querySelector('[data-reader]');await render({mode:'edit'});await delay();assert.equal(visible(),'pending');assert.equal(document.querySelector('[data-reader]'),reader);
   const worker=latest('preview'),job=worker.messages.at(-1);let response;const context={self:{postMessage:data=>{response=data}},URL,URLSearchParams,TextEncoder,TextDecoder};vm.createContext(context);vm.runInContext(code,context,{timeout:5000});context.self.onmessage({data:job});assert.ok(response.result);await act(async()=>worker.onmessage({data:response}));assert.equal(visible(),'ready');assert.ok(document.querySelector('.cm-lp-h1'));const view=peekCmView(props.scope);assert.equal(hash(view.state.doc.toString()),before);assert.equal(saves.length,0);await act(async()=>{view.dispatch({changes:{from:original.length,insert:'临时校验'}});assert.equal(lib.undo(view),true)});assert.equal(hash(view.state.doc.toString()),before);assert.equal(hash(readFileSync(process.env.LR_ORIGINAL_MD,'utf8')),before);
   await start(original,{mode:'edit'});assert.equal(visible(),'pending');assert.equal(document.querySelector('[data-reader]'),null);await delay();const cold=latest('preview');context.self.onmessage({data:cold.messages.at(-1)});await act(async()=>cold.onmessage({data:response}));assert.equal(visible(),'ready');assert.ok(document.querySelector('.cm-lp-h1'));assert.equal(hash(peekCmView(props.scope).state.doc.toString()),before);assert.equal(saves.length,0);
  });
  await t.test('short and empty notes settle without a background wait',async()=>{
   for(const value of ['**short**','']){await start(value);await render({mode:'edit'});assert.equal(visible(),'ready');assert.equal(saves.length,0)}
  });
  await t.test('late cold hydration invalidates previously ready empty editor before paint',async()=>{
   await start('',{mode:'edit'});assert.equal(visible(),'ready');await render({value:source});assert.equal(visible(),'pending');assert.ok(document.querySelector('.st-note-opening'));await delay(180);await respond(latest('preview'));assert.equal(visible(),'ready');assert.equal(saves.length,0);
  });
  await t.test('cold image note waits for both owners and retired scope cannot release it',async()=>{
   await start(source,{mode:'edit',imageScope:{instance:'a',vault:'v',note:'a',resources:[],online:false}});await delay();const old=latest('preview');await render({scope:'desktop:b:v:b',imageScope:{instance:'b',vault:'v',note:'b',resources:[],online:false}});await delay();await respond(old);assert.equal(visible(),'pending');await respond(latest('preview'));assert.equal(visible(),'pending');await respond(latest('images'));assert.equal(visible(),'ready');assert.equal(saves.length,0);
  });
  await t.test('explicit source preference accepts late remote body without waiting for a nonexistent parser',async()=>{
   await start('',{mode:'edit',sourceMode:true});assert.equal(visible(),'ready');await render({value:source});assert.equal(visible(),'ready');assert.match(peekCmView(props.scope).contentDOM.textContent,/\*\*bold\*\*/);assert.equal(saves.length,0);
  });
  await t.test('cold source mode stays an explicit immediate entry',async()=>{
   await start(source,{mode:'edit',sourceMode:true});assert.equal(visible(),'ready');assert.equal(document.querySelector('.st-note-opening'),null);assert.match(peekCmView(props.scope).contentDOM.textContent,/\*\*bold\*\*/);assert.equal(saves.length,0);
  });
  await t.test('returning from explicit source mode prepares preview without raw first frame',async()=>{
   await start(source,{mode:'edit',sourceMode:true});assert.equal(visible(),'ready');await render({sourceMode:false});assert.equal(visible(),'pending');await delay();await respond(latest('preview'));assert.equal(visible(),'ready');assert.ok(document.querySelector('.cm-lp-strong'));
  });
  await t.test('cold long-note parser failure keeps source hidden until explicit choice',async()=>{
   const Worker=globalThis.Worker;delete globalThis.Worker;try{await start(source,{mode:'edit'});await delay();assert.equal(visible(),'pending');assert.ok(document.querySelector('.st-note-preview-unavailable'));assert.equal(document.querySelector('[data-preview-handoff]').getAttribute('aria-hidden'),'true');await act(async()=>document.querySelector('.st-note-preview-unavailable button').click());assert.equal(visible(),'ready');assert.equal(saves.length,0)}finally{globalThis.Worker=Worker}
  });
  await t.test('over-limit entry is explicit source fallback, not silent raw presentation',async()=>{
   await start('x'.repeat(250001),{mode:'edit'});assert.equal(visible(),'pending');assert.ok(document.querySelector('.st-note-preview-unavailable'));await act(async()=>document.querySelector('.st-note-preview-unavailable button').click());assert.equal(visible(),'ready');assert.equal(saves.length,0);
  });
  await t.test('cold retained reentry preserves editor scroll instead of skeleton anchor',async()=>{
   await start(source,{mode:'edit'});await delay();await respond(latest('preview'));
   const view=peekCmView(props.scope),paper=document.querySelector('.st-note-paper');
   const originalRect=paper.getBoundingClientRect;
   paper.getBoundingClientRect=()=>({left:0,right:600,top:0,bottom:700,width:600,height:700});
   try {
    view.scrollDOM.scrollTop=460;
    await act(async()=>rootView.render(null));
    await render({mode:'edit'});assert.equal(peekCmView(props.scope),view);assert.equal(view.scrollDOM.scrollTop,460);assert.equal(visible(),'pending');
    await delay();await respond(latest('preview'));assert.equal(visible(),'ready');assert.equal(view.scrollDOM.scrollTop,460);
   }finally{paper.getBoundingClientRect=originalRect}
  });
  await t.test('synchronous short notes recover from failed long workers including image scope',async()=>{
   const Worker=globalThis.Worker;delete globalThis.Worker;
   try{for(const imageScope of [undefined,{instance:'a',vault:'v',note:'n',resources:[],online:false}]){
    await start(source,{mode:'edit',imageScope});await delay();assert.ok(document.querySelector('.st-note-preview-unavailable'));
    await render({value:'**short**'});assert.ok(document.querySelector('.cm-lp-strong'));assert.equal(visible(),'ready');assert.equal(saves.length,0);
   }}finally{globalThis.Worker=Worker}
  });
  await t.test('focused title keeps visibility and caret until newest hydration applies after blur',async()=>{
   await start('**short**',{mode:'edit',testHeading:true});assert.equal(visible(),'ready');
   const title=document.querySelector('.st-note-title'),view=peekCmView(props.scope);title.focus();title.setSelectionRange(1,2);
   await render({value:source});assert.equal(visible(),'ready');assert.equal(document.activeElement,title);assert.equal(title.selectionStart,1);assert.equal(Boolean(title.closest('[aria-hidden="true"]')),false);assert.equal(view.state.doc.toString(),'**short**');
   await render({value:source+'newest'});await act(async()=>title.blur());assert.equal(visible(),'pending');assert.equal(view.state.doc.toString(),source+'newest');await delay(180);await respond(latest('preview'));assert.equal(visible(),'ready');assert.equal(saves.length,0);
  });
  await t.test('pending title hydration is cancelled on scope replacement',async()=>{
   await start('**short**',{mode:'edit',testHeading:true});const oldView=peekCmView(props.scope),title=document.querySelector('.st-note-title');title.focus();
   await render({value:source});assert.equal(oldView.state.doc.toString(),'**short**');
   await render({scope:'local:review-new-owner',value:'**new owner**'});assert.equal(visible(),'ready');assert.equal(peekCmView(props.scope).state.doc.toString(),'**new owner**');
   await act(async()=>title.dispatchEvent(new Event('blur')));assert.equal(oldView.state.doc.toString(),'**short**');assert.equal(peekCmView(props.scope).state.doc.toString(),'**new owner**');assert.equal(saves.length,0);
  });
  await t.test('read switch retires pending title hydration and reentry gets authoritative body',async()=>{
   await start('**short**',{mode:'edit',testHeading:true});const view=peekCmView(props.scope),title=document.querySelector('.st-note-title');title.focus();
   await render({value:source});await render({mode:'read'});await act(async()=>title.dispatchEvent(new Event('blur')));
   assert.equal(view.state.doc.toString(),'**short**');assert.equal(view.dom.isConnected,false);
   await render({mode:'edit'});assert.equal(view.state.doc.toString(),source);await delay(180);await respond(latest('preview'));assert.equal(visible(),'ready');assert.equal(saves.length,0);
  });
  await t.test('superseded deferred body and source changes do not leak after title blur',async()=>{
   await start('**short**',{mode:'edit',testHeading:true});const view=peekCmView(props.scope),title=document.querySelector('.st-note-title');title.focus();
   await render({value:source,sourceMode:true});assert.equal(visible(),'ready');assert.equal(view.state.doc.toString(),'**short**');assert.ok(document.querySelector('.cm-lp-strong'));
   await render({value:'**short**',sourceMode:false});await act(async()=>title.blur());assert.equal(visible(),'ready');assert.equal(view.state.doc.toString(),'**short**');assert.ok(document.querySelector('.cm-lp-strong'));assert.equal(saves.length,0);
  });
  await t.test('editor container does not flatten its title and embedded controls into a second textbox',async()=>{
   await start('**short**',{mode:'edit',testHeading:true});const view=peekCmView(props.scope);assert.equal(view.dom.getAttribute('role'),'group');assert.equal(view.contentDOM.getAttribute('role'),'textbox');assert.equal(view.contentDOM.getAttribute('aria-label'),'笔记正文');assert.equal(document.querySelector('.st-note-title').closest('[role="textbox"]'),null);assert.equal(saves.length,0);
  });
  await t.test('cold edit entry waits for real decorations without parsing a second reader',async()=>{
   await start();await act(async()=>rootView.render(null));const count=readRenders;await render({mode:'edit'});assert.equal(visible(),'pending');assert.equal(document.querySelector('[data-reader]'),null);assert.equal(readRenders,count);assert.ok(document.querySelector('.st-note-opening'));assert.equal(document.querySelector('[data-preview-handoff]').getAttribute('aria-hidden'),'true');await delay();await respond(latest('preview'));assert.equal(visible(),'ready');assert.ok(document.querySelector('.cm-lp-strong'));assert.equal(saves.length,0);
  });
 }finally{if(rootView&&lib)await lib.act(async()=>rootView.unmount());lib?.destroyAllCmViews();delete globalThis.Worker;stop();rmSync(dir,{recursive:true,force:true});dom.window.close();for(const [key,descriptor]of old){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key]}delete globalThis.IS_REACT_ACT_ENVIRONMENT;for(const channel of channels){channel.port1.close();channel.port2.close()}globalThis.MessageChannel=OriginalMessageChannel;}
});
