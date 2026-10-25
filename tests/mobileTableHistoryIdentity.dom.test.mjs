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
test('table history restores logical cells using real CM6',async t=>{
 const dom=new JSDOM('<div class="st-app"><div class="st-note-surface" data-current="true"><div id="host"></div></div></div>',{url:'https://test.invalid/',pretendToBeVisual:true});
 const names=['window','Window','document','navigator','HTMLElement','Element','Node','Event','MouseEvent','KeyboardEvent','CustomEvent','MutationObserver','DOMRect','getComputedStyle'];const old=new Map(names.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 for(const key of names)Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:key==='getComputedStyle'?dom.window.getComputedStyle.bind(dom.window):dom.window[key]});
 globalThis.requestAnimationFrame=dom.window.requestAnimationFrame.bind(dom.window);globalThis.cancelAnimationFrame=dom.window.cancelAnimationFrame.bind(dom.window);
 const rect={left:0,right:600,top:0,bottom:24,width:600,height:24,x:0,y:0,toJSON(){return this}};
 dom.window.Range.prototype.getClientRects=()=>[rect];dom.window.Range.prototype.getBoundingClientRect=()=>rect;
 dom.window.document.elementFromPoint=()=>document.getElementById('host');
 const dir=mkdtempSync(join(tmpdir(),'lr-live-preview-'));let view;const calls=[];globalThis.__lpApi={contentCachedResource:async(...args)=>{calls.push(['cache',...args]);return {path:'/verified/cache',mime:'text/plain'}},contentOpenResource:async(...args)=>{calls.push(['open',...args])},contentCancel:async()=>{}};
 try{
 const out=join(dir,'entry.cjs');await build({stdin:{contents:`export {EditorState,Compartment,Transaction} from '@codemirror/state'; export {EditorView} from '@codemirror/view'; export {cmCaretVisibility,noteScrollNavigation} from './src/presentation/still01/editor/cmCaretVisibility'; export {nativeTableInput,ownsTableScroll,tableStructureHistory} from './src/presentation/still01/editor/tableFocus'; export {history,undo,redo} from '@codemirror/commands'; export {runEditorCommand} from './src/presentation/still01/editor/editorCommands'; export {cmLivePreview,refreshLivePreview} from './src/presentation/still01/editor/cmLivePreview'; export {mobileLivePreviewModel} from './src/presentation/still01/editor/mobileLivePreviewModel';`,resolveDir:root,loader:'ts'},outfile:out,bundle:true,platform:'node',format:'cjs',define:{'import.meta.url':JSON.stringify('file://'+root+'/src/presentation/still01/editor/markdownParseClient.ts')},plugins:[{name:'native-boundary',setup(b){b.onResolve({filter:/services\/client$/},()=>({path:'client',namespace:'lp-mock'}));b.onLoad({filter:/.*/,namespace:'lp-mock'},()=>({contents:'export const api=globalThis.__lpApi;',loader:'js'}))}}]});
 const {EditorState,EditorView,Compartment,Transaction,history,undo,redo,cmLivePreview,refreshLivePreview,mobileLivePreviewModel,runEditorCommand,nativeTableInput,ownsTableScroll,tableStructureHistory,cmCaretVisibility,noteScrollNavigation}=require(out);const wait=ms=>new Promise(r=>setTimeout(r,ms));let opens=[],enabled=true,changed=0;let mode;
 const make=(doc,extra={})=>{view?.destroy();document.getElementById('host').replaceChildren();mode=new Compartment();opens=[];enabled=true;changed=0;const options={enabled:()=>enabled,onWikiLink:r=>opens.push(r),...extra};view=new EditorView({state:EditorState.create({doc,selection:{anchor:doc.length},extensions:[history(),tableStructureHistory,cmCaretVisibility,mode.of(cmLivePreview(options)),EditorView.updateListener.of(u=>{if(u.docChanged)changed++})]}),parent:document.getElementById('host')});return options};
 const click=el=>{assert.ok(el,'click target');el.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}))};
 await t.test('Beta insert-right undo redo undo does not jump to Gamma',async()=>{
  const source='prefix\n\n| Rank | Label | Notes |\n| --- | --- | --- |\n| 1 | Alpha | 第一行中文 |\n| 2 | Beta | 第二行中文 |\n| 3 | Gamma | 第三行中文 |\n\nsuffix';make(source);
  click([...document.querySelectorAll('.cm-lp-table td')].find(cell=>cell.textContent==='Beta'));
  const input=nativeTableInput(view);let blurs=0;input.addEventListener('blur',()=>blurs++);view.scrollDOM.scrollTop=145;
  const trace=[];const record=step=>trace.push({step,value:input.value,label:input.getAttribute('aria-label'),selection:view.state.selection.main.toJSON(),same:nativeTableInput(view)===input,focus:document.activeElement===input,scroll:view.scrollDOM.scrollTop});
  record('Beta');click(document.querySelector('[aria-label="添加列"]'));record('insert');
  assert.equal(runEditorCommand(view,'undo'),true);record('undo');
  assert.equal(runEditorCommand(view,'redo'),true);record('redo');
  assert.equal(runEditorCommand(view,'undo'),true);record('undoAgain');
  console.log('TABLE_IDENTITY_TRACE',JSON.stringify(trace));
  assert.deepEqual(trace.map(x=>x.value),['Beta','','Beta','','Beta']);
  assert.deepEqual(trace.map(x=>x.label),['表格第 3 行第 2 列','表格第 3 行第 3 列','表格第 3 行第 2 列','表格第 3 行第 3 列','表格第 3 行第 2 列']);
  assert.ok(trace.every(x=>x.same&&x.focus&&x.scroll===145));await wait(0);assert.equal(blurs,0);
 });
 await t.test('queued selection events and repeated history preserve the same row',async()=>{
  make('| Rank | Label | Notes |\n| --- | --- | --- |\n| 1 | Alpha | 第一行中文 |\n| 2 | Beta | 第二行中文 |\n| 3 | Gamma | 第三行中文 |\n\nend');
  click([...document.querySelectorAll('.cm-lp-table td')].find(cell=>cell.textContent==='Beta'));const input=nativeTableInput(view);click(document.querySelector('[aria-label="添加列"]'));await wait(0);
  for(let n=0;n<3;n++){assert.equal(runEditorCommand(view,'undo'),true);await wait(0);assert.equal(input.value,'Beta');assert.equal(input.getAttribute('aria-label'),'表格第 3 行第 2 列');assert.equal(runEditorCommand(view,'redo'),true);await wait(0);assert.equal(input.value,'');assert.equal(input.getAttribute('aria-label'),'表格第 3 行第 3 列')}
 });
 await t.test('sorting follows the selected row identity, including equal values',()=>{
  const source='| Rank | Label |\n| --- | --- |\n| 3 | same |\n| 1 | same |\n| 2 | same |\n\nend';make(source);
  click(document.querySelectorAll('.cm-lp-table tr')[2].children[0]);const input=nativeTableInput(view);click(document.querySelector('[aria-label="当前列操作"]'));click(document.querySelector('[aria-label="按列升序排列"]'));
  assert.equal(input.value,'1');assert.equal(input.getAttribute('aria-label'),'表格第 2 行第 1 列');
  // Menus intentionally dismiss text entry; a cell tap explicitly resumes it.
  click(document.querySelectorAll('.cm-lp-table tr')[1].children[0]);
  for(let n=0;n<2;n++){assert.equal(runEditorCommand(view,'undo'),true);assert.equal(input.value,'1');assert.equal(input.getAttribute('aria-label'),'表格第 3 行第 1 列');assert.equal(runEditorCommand(view,'redo'),true);assert.equal(input.value,'1');assert.equal(input.getAttribute('aria-label'),'表格第 2 行第 1 列')}
 });
 await t.test('history metadata maps with non-history edits before its table',()=>{
  const source='prefix\n\n| A | B |\n| --- | --- |\n| one | Beta |\n| three | Gamma |\n\nend';make(source);click(document.querySelectorAll('.cm-lp-table td')[1]);const input=nativeTableInput(view);click(document.querySelector('[aria-label="添加列"]'));
  view.dispatch({changes:{from:0,insert:'shift\n'},annotations:Transaction.addToHistory.of(false)});
  for(let n=0;n<2;n++){assert.equal(runEditorCommand(view,'undo'),true);assert.equal(input.value,'Beta');assert.equal(input.getAttribute('aria-label'),'表格第 2 行第 2 列');assert.equal(runEditorCommand(view,'redo'),true);assert.equal(input.value,'');assert.equal(input.getAttribute('aria-label'),'表格第 2 行第 3 列')}
 });
 await t.test('last body row deletion restores its cell rather than a header substitute',()=>{
  make('| A | B |\n| --- | --- |\n| one | Beta |\n\nend');click(document.querySelectorAll('.cm-lp-table td')[1]);const input=nativeTableInput(view);click(document.querySelector('[aria-label="当前行操作"]'));click(document.querySelector('[aria-label="删除当前行"]'));assert.equal(input.value,'B');
  click(document.querySelectorAll('.cm-lp-table th')[1]);
  for(let n=0;n<2;n++){assert.equal(runEditorCommand(view,'undo'),true);assert.equal(input.value,'Beta');assert.equal(input.getAttribute('aria-label'),'表格第 2 行第 2 列');assert.equal(runEditorCommand(view,'redo'),true);assert.equal(input.value,'B');assert.equal(input.getAttribute('aria-label'),'表格第 1 行第 2 列')}
 });
 await t.test('delayed Worker does not replace the immediate logical history target',async()=>{
  const workers=[];globalThis.Worker=class{onmessage=null;messages=[];constructor(){workers.push(this)}postMessage(job){this.messages.push(job)}terminate(){}reply(job){this.onmessage?.({data:{id:job.id,result:mobileLivePreviewModel(job.source,job.resources)}})}};
  try{make('| Rank | Label | Notes |\n| --- | --- | --- |\n| 1 | Alpha | 第一行中文 |\n| 2 | Beta | 第二行中文 |\n| 3 | Gamma | 第三行中文 |\n\n'+'plain text\n'.repeat(1300));await wait(190);const worker=workers[0];worker.reply(worker.messages[0]);click([...document.querySelectorAll('.cm-lp-table td')].find(cell=>cell.textContent==='Beta'));const input=nativeTableInput(view);click(document.querySelector('[aria-label="添加列"]'));
   for(let n=0;n<2;n++){assert.equal(runEditorCommand(view,'undo'),true);assert.equal(input.value,'Beta');assert.equal(runEditorCommand(view,'redo'),true);assert.equal(input.value,'');assert.equal(input.getAttribute('aria-label'),'表格第 3 行第 3 列')}
   await wait(190);worker.reply(worker.messages.at(-1));await wait(0);assert.equal(nativeTableInput(view),input);assert.equal(document.activeElement,input);assert.equal(input.value,'');assert.equal(input.getAttribute('aria-label'),'表格第 3 行第 3 列');
  }finally{delete globalThis.Worker}
 });
 }finally{view?.destroy();stop();rmSync(dir,{recursive:true,force:true});dom.window.close();for(const [key,descriptor]of old){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key]}delete globalThis.__lpApi;}
});
