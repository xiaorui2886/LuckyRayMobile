// Real CodeMirror state/view/widgets in jsdom; only native resource IPC is mocked.
// Not a substitute for Android IME, touch or WebView pixel verification.
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
test('table cell history metadata survives real MobileCmEditor source mode changes',async()=>{
 const dom=new JSDOM('<div class="st-app"><div id="host"></div></div>',{url:'https://test.invalid/',pretendToBeVisual:true});
 const keys=['window','Window','document','navigator','HTMLElement','Element','Node','Event','MouseEvent','KeyboardEvent','MutationObserver','DOMRect','getComputedStyle'];const old=new Map(keys.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 for(const key of keys)Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:key==='getComputedStyle'?dom.window.getComputedStyle.bind(dom.window):dom.window[key]});
 globalThis.requestAnimationFrame=dom.window.requestAnimationFrame.bind(dom.window);globalThis.cancelAnimationFrame=dom.window.cancelAnimationFrame.bind(dom.window);globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 const rect={left:0,right:600,top:0,bottom:24,width:600,height:24,x:0,y:0,toJSON(){return this}};dom.window.Range.prototype.getClientRects=()=>[rect];dom.window.Range.prototype.getBoundingClientRect=()=>rect;
 const channels=[];const OriginalMessageChannel=globalThis.MessageChannel;globalThis.MessageChannel=class extends OriginalMessageChannel{constructor(){super();channels.push(this)}};
 const dir=mkdtempSync(join(tmpdir(),'lr-editor-integration-'));let rootView,lib;
 try{
  const out=join(dir,'entry.cjs');await build({stdin:{contents:`export {createElement,act} from 'react';export {createRoot} from 'react-dom/client';export {undo} from '@codemirror/commands';export {runEditorCommand} from './src/presentation/still01/editor/editorCommands';export {MobileCmEditor} from './src/presentation/still01/editor/MobileCmEditor';export {peekCmView,destroyAllCmViews} from './src/presentation/still01/editor/cmEditorSessions';`,resolveDir:root,loader:'tsx'},outfile:out,bundle:true,platform:'node',format:'cjs',loader:{'.css':'empty'},define:{'import.meta.url':JSON.stringify('file://'+root+'/src/presentation/still01/editor/markdownParseClient.ts')},plugins:[{name:'native-boundary',setup(b){b.onResolve({filter:/services\/client$/},()=>({path:'client',namespace:'lp-mock'}));b.onLoad({filter:/.*/,namespace:'lp-mock'},()=>({contents:'export const api={};',loader:'js'}))}}]});
  lib=require(out);const {act,createElement:h,createRoot,MobileCmEditor,peekCmView,undo,runEditorCommand}=lib;
  rootView=createRoot(document.getElementById('host'));const handle={current:null},source='prefix\n\n| Rank | Label | Notes |\n| --- | --- | --- |\n| 1 | Alpha | 第一行中文 |\n| 2 | Beta | 第二行中文 |\n| 3 | Gamma | 第三行中文 |\n\nsuffix';
  let props={scope:'local:table-history-mode',value:source,handleRef:handle,onChange:value=>{props={...props,value}},linkStatus:()=> 'resolved'};
  const render=async patch=>{props={...props,...patch};await act(async()=>rootView.render(h(MobileCmEditor,props)))};
  const click=async el=>{assert.ok(el);await act(async()=>el.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1})))};
  await render({});const original=peekCmView(props.scope);
  await click([...document.querySelectorAll('.cm-lp-table td')].find(cell=>cell.textContent==='Beta'));await click(document.querySelector('[aria-label="添加列"]'));
  assert.equal(document.querySelector('.cm-lp-table-input').getAttribute('aria-label'),'表格第 3 行第 3 列');
  for(let n=0;n<2;n++){
   await render({sourceMode:true});assert.equal(peekCmView(props.scope),original);assert.equal(document.querySelector('.cm-lp-table-input'),null);
   await act(async()=>{assert.equal(undo(original),true)});assert.equal(original.state.doc.toString(),source);assert.equal(document.querySelector('.cm-lp-table-input'),null,'source undo does not create a native table editor');
   await render({sourceMode:false});assert.equal(peekCmView(props.scope),original);await click([...document.querySelectorAll('.cm-lp-table td')].find(cell=>cell.textContent==='Beta'));const input=document.querySelector('.cm-lp-table-input');
   await act(async()=>{assert.equal(runEditorCommand(original,'redo'),true)});assert.equal(input.value,'');assert.equal(input.getAttribute('aria-label'),'表格第 3 行第 3 列');assert.equal(document.activeElement,input);
  }
 }finally{if(rootView&&lib)await lib.act(async()=>rootView.unmount());lib?.destroyAllCmViews();stop();rmSync(dir,{recursive:true,force:true});dom.window.close();for(const [key,descriptor]of old){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key]}delete globalThis.IS_REACT_ACT_ENVIRONMENT;for(const channel of channels){channel.port1.close();channel.port2.close()}globalThis.MessageChannel=OriginalMessageChannel;}
});
