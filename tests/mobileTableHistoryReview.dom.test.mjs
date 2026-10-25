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
test('independent table history adversarial review using real CM6',async t=>{
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
 const {Transaction,EditorState,EditorView,Compartment,history,undo,redo,cmLivePreview,refreshLivePreview,mobileLivePreviewModel,runEditorCommand,nativeTableInput,ownsTableScroll,tableStructureHistory,cmCaretVisibility,noteScrollNavigation}=require(out);const wait=ms=>new Promise(r=>setTimeout(r,ms));let opens=[],enabled=true,changed=0;let mode;
 const make=(doc,extra={})=>{view?.destroy();document.getElementById('host').replaceChildren();mode=new Compartment();opens=[];enabled=true;changed=0;const options={enabled:()=>enabled,onWikiLink:r=>opens.push(r),...extra};view=new EditorView({state:EditorState.create({doc,selection:{anchor:doc.length},extensions:[history(),tableStructureHistory,cmCaretVisibility,mode.of(cmLivePreview(options)),EditorView.updateListener.of(u=>{if(u.docChanged)changed++})]}),parent:document.getElementById('host')});return options};
 const click=el=>{assert.ok(el,'click target');el.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}))};

 const source='prefix\n\n| Rank | Label | Notes |\n| --- | --- | --- |\n| 1 | Alpha | 第一行中文 |\n| 2 | Beta | 第二行中文 |\n| 3 | Gamma | 第三行中文 |\n\nsuffix';
 const selectCell=value=>click([...document.querySelectorAll('.cm-lp-table td')].find(cell=>cell.textContent===value));
 const operation=label=>{click(document.querySelector('[aria-label="表格行列操作"]'));click(document.querySelector(`[aria-label="${label}"]`));
  // Menu actions suspend text entry. Explicitly tap the selected cell before
  // exercising the existing active-input history contract below.
  const input=nativeTableInput(view);assert.equal(input.hidden,true);assert.notEqual(document.activeElement,input);
  const [row,column]=input.getAttribute('aria-label').match(/\d+/g).map(Number);click(document.querySelectorAll('.cm-lp-table tr')[row-1].children[column-1]);
 };
 const check=(input,value,label)=>{assert.equal(nativeTableInput(view),input,'same native input');assert.equal(document.activeElement,input,'native focus');assert.equal(input.value,value);if(label)assert.equal(input.getAttribute('aria-label'),label)};
 for(const [label,target,targetLabel]of [
  ['上方插入行','','表格第 3 行第 2 列'],['下方插入行','','表格第 4 行第 2 列'],
  ['左侧插入列','','表格第 3 行第 2 列'],['右侧插入列','','表格第 3 行第 3 列'],
  ['删除当前行','Gamma','表格第 3 行第 2 列'],['删除当前列','第二行中文','表格第 3 行第 2 列'],
  ['向上移动行','Beta','表格第 2 行第 2 列'],['向下移动行','Beta','表格第 4 行第 2 列'],
  ['向左移动列','Beta','表格第 3 行第 1 列'],['向右移动列','Beta','表格第 3 行第 3 列'],
  ['复制当前行','Beta','表格第 4 行第 2 列'],['复制当前列','Beta','表格第 3 行第 3 列']
 ])await t.test(`${label} round trip keeps explicit cell target`,async()=>{
  make(source);selectCell('Beta');const input=nativeTableInput(view);input.setSelectionRange(1,3,'backward');input.dispatchEvent(new Event('select'));view.scrollDOM.scrollTop=128;view.scrollDOM.scrollLeft=9;let blurs=0;input.addEventListener('blur',()=>blurs++);
  operation(label);check(input,target,targetLabel);
  for(let n=0;n<2;n++){assert.equal(runEditorCommand(view,'undo'),true);check(input,'Beta','表格第 3 行第 2 列');assert.equal(input.selectionStart,1);assert.equal(input.selectionEnd,3);assert.equal(input.selectionDirection,'backward');assert.equal(runEditorCommand(view,'redo'),true);check(input,target,targetLabel)}
  assert.equal(view.scrollDOM.scrollTop,128);assert.equal(view.scrollDOM.scrollLeft,9);await wait(0);assert.equal(blurs,1);
 });
 await t.test('duplicate labels never substitute another logical row',()=>{
  make(source.replace('Alpha','Beta').replace('Gamma','Beta'));const labels=[...document.querySelectorAll('.cm-lp-table td')].filter(c=>c.textContent==='Beta');click(labels[1]);const input=nativeTableInput(view);operation('右侧插入列');for(let n=0;n<3;n++){assert.equal(runEditorCommand(view,'undo'),true);check(input,'Beta','表格第 3 行第 2 列');assert.equal(runEditorCommand(view,'redo'),true);check(input,'','表格第 3 行第 3 列')}
 });
 await t.test('composition refuses structure and history without replacing native input',()=>{
  make(source);selectCell('Beta');const input=nativeTableInput(view);input.dispatchEvent(new Event('compositionstart'));input.value='Beta中文';input.dispatchEvent(new Event('input'));const before=view.state.doc.toString();click(document.querySelector('[aria-label="添加列"]'));assert.equal(view.state.doc.toString(),before);assert.equal(runEditorCommand(view,'undo'),false);check(input,'Beta中文');input.dispatchEvent(new Event('compositionend'));check(input,'Beta中文');
 });
 await t.test('ordinary cell text history remains separate from structure target',()=>{
  make(source);selectCell('Beta');const input=nativeTableInput(view);input.value='Beta edited';input.setSelectionRange(11,11);input.dispatchEvent(new Event('input'));operation('右侧插入列');check(input,'');assert.equal(runEditorCommand(view,'undo'),true);check(input,'Beta edited');assert.equal(runEditorCommand(view,'undo'),true);check(input,'Beta');assert.equal(runEditorCommand(view,'redo'),true);check(input,'Beta edited');assert.equal(runEditorCommand(view,'redo'),true);check(input,'','表格第 3 行第 3 列');
 });

 await t.test('non-history prefix insertion exactly at table boundary maps history identity',()=>{
  make(source);selectCell('Beta');operation('右侧插入列');const from=view.state.doc.toString().indexOf('| Rank');view.dispatch({changes:{from,insert:'outside prefix\n\n'},annotations:Transaction.addToHistory.of(false)});const input=nativeTableInput(view);assert.ok(input,'active table input survives outside prefix');assert.equal(runEditorCommand(view,'undo'),true);check(input,'Beta','表格第 3 行第 2 列');assert.equal(runEditorCommand(view,'redo'),true);check(input,'','表格第 3 行第 3 列');assert.ok(view.state.doc.toString().includes('outside prefix'));
 });

 await t.test('history for another table retires the current owner rather than transplanting its cell',async()=>{
  const doubled=source+'\n\n'+source.replaceAll('Beta','Delta');make(doubled);selectCell('Beta');operation('右侧插入列');const firstChanged=view.state.doc.toString();selectCell('Delta');await wait(0);const second=[...document.querySelectorAll('.cm-lp-table')].find(el=>el.textContent.includes('Delta'));click(second.closest('.cm-lp-table-editable').querySelector('[aria-label="添加列"]'));const secondInput=nativeTableInput(view);check(secondInput,'','表格第 3 行第 3 列');assert.equal(runEditorCommand(view,'undo'),true);check(secondInput,'Delta','表格第 3 行第 2 列');assert.equal(view.state.doc.toString(),firstChanged);assert.equal(runEditorCommand(view,'undo'),true);assert.equal(nativeTableInput(view),null);assert.equal(view.state.doc.toString(),doubled);assert.equal(runEditorCommand(view,'redo'),true);assert.equal(nativeTableInput(view),null);assert.equal(view.state.doc.toString(),firstChanged);selectCell('Beta');const firstInput=nativeTableInput(view);assert.ok(firstInput);assert.equal(runEditorCommand(view,'redo'),true);assert.equal(nativeTableInput(view),null);assert.equal(view.state.doc.toString().split('Delta').length,2);
 });

 }finally{view?.destroy();stop();rmSync(dir,{recursive:true,force:true});dom.window.close();for(const [key,descriptor]of old){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key]}delete globalThis.__lpApi;}
});
