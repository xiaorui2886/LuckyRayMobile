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
test('real MobileCmEditor React integration retains save authority, mode history and owner',async()=>{
 const dom=new JSDOM('<div class="st-app"><div id="host"></div></div>',{url:'https://test.invalid/',pretendToBeVisual:true});
 const keys=['window','Window','document','navigator','HTMLElement','Element','Node','Event','MouseEvent','KeyboardEvent','MutationObserver','DOMRect','getComputedStyle'];const old=new Map(keys.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 for(const key of keys)Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:key==='getComputedStyle'?dom.window.getComputedStyle.bind(dom.window):dom.window[key]});
 globalThis.requestAnimationFrame=dom.window.requestAnimationFrame.bind(dom.window);globalThis.cancelAnimationFrame=dom.window.cancelAnimationFrame.bind(dom.window);globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 const rect={left:0,right:600,top:0,bottom:24,width:600,height:24,x:0,y:0,toJSON(){return this}};dom.window.Range.prototype.getClientRects=()=>[rect];dom.window.Range.prototype.getBoundingClientRect=()=>rect;
 const channels=[];const OriginalMessageChannel=globalThis.MessageChannel;globalThis.MessageChannel=class extends OriginalMessageChannel{constructor(){super();channels.push(this)}};
 const dir=mkdtempSync(join(tmpdir(),'lr-editor-integration-'));let rootView,lib;
 try{
  const out=join(dir,'entry.cjs');await build({stdin:{contents:`export {createElement,act} from 'react';export {createRoot} from 'react-dom/client';export {undo} from '@codemirror/commands';export {MobileCmEditor} from './src/presentation/still01/editor/MobileCmEditor';export {peekCmView,destroyAllCmViews} from './src/presentation/still01/editor/cmEditorSessions';`,resolveDir:root,loader:'tsx'},outfile:out,bundle:true,platform:'node',format:'cjs',loader:{'.css':'empty'},define:{'import.meta.url':JSON.stringify('file://'+root+'/src/presentation/still01/editor/markdownParseClient.ts')},plugins:[{name:'native-boundary',setup(b){b.onResolve({filter:/services\/client$/},()=>({path:'client',namespace:'lp-mock'}));b.onLoad({filter:/.*/,namespace:'lp-mock'},()=>({contents:'export const api={};',loader:'js'}))}}]});
  lib=require(out);const {act,createElement:h,createRoot,MobileCmEditor,peekCmView,undo}=lib;
  rootView=createRoot(document.getElementById('host'));const saves=[],opens=[],handle={current:null};let value='**bold** [[Target|Alias]]\nend';
  let props={scope:'local:test-preview',value,handleRef:handle,onChange:next=>saves.push(next),onWikiLink:r=>opens.push(r),linkStatus:()=> 'resolved'};
  const render=async patch=>{props={...props,...patch};await act(async()=>rootView.render(h(MobileCmEditor,props)))};
  await render({});const original=peekCmView(props.scope);assert.ok(document.querySelector('.cm-lp-link'));assert.equal(saves.length,0);
  await act(async()=>handle.current.replaceRange('!',{start:value.length,end:value.length}));value+='!';assert.deepEqual(saves,[value]);
  await render({value,sourceMode:true});assert.equal(peekCmView(props.scope),original);assert.match(original.contentDOM.textContent,/\*\*bold\*\*/);
  await render({sourceMode:false});assert.equal(peekCmView(props.scope),original);assert.equal(saves.length,1);
  await act(async()=>{assert.equal(undo(original),true)});assert.equal(handle.current.getValue(),value.slice(0,-1));assert.equal(saves.length,2);
  await render({value:'**external**\nend'});assert.equal(saves.length,2);assert.equal(handle.current.getValue(),'**external**\nend');
  await render({scope:'local:other-preview',value:'[[Other|Other alias]]\nend'});const next=peekCmView(props.scope);assert.notEqual(next,original);assert.equal(original.dom.isConnected,false);
  await act(async()=>document.querySelector('.cm-lp-link').dispatchEvent(new MouseEvent('click',{bubbles:true})));assert.equal(opens.at(-1).target,'Other');
  const oldButton=document.querySelector('.cm-lp-link');await render({assistActive:false});await act(async()=>oldButton.dispatchEvent(new MouseEvent('click',{bubbles:true})));assert.equal(opens.length,1);
 }finally{if(rootView&&lib)await lib.act(async()=>rootView.unmount());lib?.destroyAllCmViews();stop();rmSync(dir,{recursive:true,force:true});dom.window.close();for(const [key,descriptor]of old){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key]}delete globalThis.IS_REACT_ACT_ENVIRONMENT;for(const channel of channels){channel.port1.close();channel.port2.close()}globalThis.MessageChannel=OriginalMessageChannel;}
});
