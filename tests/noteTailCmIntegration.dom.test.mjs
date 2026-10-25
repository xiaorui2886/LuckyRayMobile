// Real CodeMirror state/view/widgets in jsdom; only native resource IPC is mocked.
// Not a substitute for Android IME, touch or WebView pixel verification.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
const root=process.env.LR_CARET_SOURCE_ROOT?resolve(process.env.LR_CARET_SOURCE_ROOT):fileURLToPath(new URL('..',import.meta.url)),require=createRequire(import.meta.url);
const tools=process.env.LR_DOM_TEST_TOOLS?createRequire(join(resolve(process.env.LR_DOM_TEST_TOOLS),'__harness__.cjs')):require;
const {JSDOM}=tools('jsdom'),{build,stop}=createRequire(require.resolve('vite/package.json'))('esbuild');
test('tail reveal uses actual CM source/live-preview and native table caret ownership',async t=>{
 const dom=new JSDOM('<div class="st-app"><div class="st-note-surface" data-current="true"><div id="host"></div><div class="st-reader-bottom"></div></div></div>',{url:'https://test.invalid/',pretendToBeVisual:true});
 const names=['window','Window','document','navigator','HTMLElement','Element','Node','Event','MouseEvent','KeyboardEvent','CustomEvent','MutationObserver','DOMRect','getComputedStyle'];const old=new Map(names.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 for(const key of names)Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:key==='getComputedStyle'?dom.window.getComputedStyle.bind(dom.window):dom.window[key]});
 globalThis.requestAnimationFrame=dom.window.requestAnimationFrame.bind(dom.window);globalThis.cancelAnimationFrame=dom.window.cancelAnimationFrame.bind(dom.window);
 const rect={left:0,right:600,top:0,bottom:24,width:600,height:24,x:0,y:0,toJSON(){return this}};
 dom.window.Range.prototype.getClientRects=()=>[rect];dom.window.Range.prototype.getBoundingClientRect=()=>rect;
 dom.window.document.elementFromPoint=()=>document.getElementById('host');
 const dir=mkdtempSync(join(tmpdir(),'lr-live-preview-'));let view;const calls=[];globalThis.__lpApi={contentCachedResource:async(...args)=>{calls.push(['cache',...args]);return {path:'/verified/cache',mime:'text/plain'}},contentOpenResource:async(...args)=>{calls.push(['open',...args])},contentCancel:async()=>{}};
 try{
 const out=join(dir,'entry.cjs');await build({stdin:{contents:`export {EditorState,Compartment,Transaction} from '@codemirror/state'; export {EditorView} from '@codemirror/view'; export {cmCaretVisibility,noteScrollNavigation} from './src/presentation/still01/editor/cmCaretVisibility'; export {nativeTableInput,ownsTableScroll,tableStructureHistory,runTableHistory} from './src/presentation/still01/editor/tableFocus'; export {history,undo,redo} from '@codemirror/commands'; export {runEditorCommand} from './src/presentation/still01/editor/editorCommands'; export {cmLivePreview,refreshLivePreview} from './src/presentation/still01/editor/cmLivePreview'; export {mobileLivePreviewModel} from './src/presentation/still01/editor/mobileLivePreviewModel';`,resolveDir:root,loader:'ts'},outfile:out,bundle:true,platform:'node',format:'cjs',nodePaths:[join(fileURLToPath(new URL('..',import.meta.url)),'node_modules')],define:{'import.meta.url':JSON.stringify('file://'+root+'/src/presentation/still01/editor/markdownParseClient.ts')},plugins:[{name:'native-boundary',setup(b){b.onResolve({filter:/services\/client$/},()=>({path:'client',namespace:'lp-mock'}));b.onLoad({filter:/.*/,namespace:'lp-mock'},()=>({contents:'export const api=globalThis.__lpApi;',loader:'js'}))}}]});
 const {EditorState,EditorView,Compartment,Transaction,history,undo,redo,cmLivePreview,refreshLivePreview,mobileLivePreviewModel,runEditorCommand,nativeTableInput,ownsTableScroll,tableStructureHistory,cmCaretVisibility,noteScrollNavigation,runTableHistory}=require(out);const wait=ms=>new Promise(r=>setTimeout(r,ms));let opens=[],enabled=true,changed=0;let mode;
 const make=(doc,extra={})=>{view?.destroy();document.getElementById('host').replaceChildren();mode=new Compartment();opens=[];enabled=true;changed=0;const options={enabled:()=>enabled,onWikiLink:r=>opens.push(r),...extra};view=new EditorView({state:EditorState.create({doc,selection:{anchor:doc.length},extensions:[history(),tableStructureHistory,cmCaretVisibility,mode.of(cmLivePreview(options)),EditorView.updateListener.of(u=>{if(u.docChanged)changed++})]}),parent:document.getElementById('host')});return options};
 const click=el=>{assert.ok(el,'click target');el.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:0}))};

 const host=document.querySelector('.st-note-surface'),bar=document.querySelector('.st-reader-bottom');let height=800,reduced=true;
 Object.defineProperty(window,'innerHeight',{value:800,configurable:true});
 window.matchMedia=()=>({get matches(){return reduced},addEventListener(){},removeEventListener(){}});
 const bounds=(top,bottom)=>({top,bottom,height:bottom-top,left:0,right:400,width:400,x:0,y:top,toJSON(){return this}});
 host.getBoundingClientRect=()=>bounds(0,height);bar.getBoundingClientRect=()=>bounds(height-60,height);
 const geometry=()=>{const scroller=view.scrollDOM;scroller.getBoundingClientRect=()=>bounds(0,height);Object.defineProperties(scroller,{scrollHeight:{get:()=>1800},clientHeight:{get:()=>height}});scroller.scrollTop=300;
  view.coordsAtPos=()=>bounds(460-(scroller.scrollTop-300),480-(scroller.scrollTop-300));
  Object.defineProperty(view,'documentTop',{get:()=>-(scroller.scrollTop-300),configurable:true});view.lineBlockAt=()=>({bottom:500,top:480,from:0,to:view.state.doc.length,height:20});
 };
 const tap=element=>{element.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,clientX:20,clientY:480}));element.dispatchEvent(new MouseEvent('pointerup',{bubbles:true,clientX:20,clientY:480}))};
 const shrink=()=>{height=500;window.dispatchEvent(new Event('resize'))};
 await t.test('IME resize and restored native scroll invalidate retained CM geometry even without observer callbacks',async()=>{
  height=800;const text='TOP\n'+('paragraph body\n'.repeat(150))+'TAIL-10\nQA-END';make(text);geometry();view.focus();await wait(50);view.dispatch({selection:{anchor:0,head:3}});
  const retained=view,doc=view.state.doc,selection=view.state.selection;
  const requests=[],original=view.requestMeasure.bind(view);
  view.requestMeasure=(...args)=>{requests.push(view.scrollDOM.scrollTop);return original(...args)};
  // DOM geometry here is deterministic, but owner events, CM plugin, view,
  // document and selection are production objects. No observer callback is
  // delivered: old WebViews can coalesce resize/scroll after focused input.
  tap(view.contentDOM);shrink();await wait(70);
  assert.ok(requests.length>0,'IME owner must explicitly invalidate retained CM viewport');
  requests.length=0;view.scrollDOM.scrollTop=900;
  view.scrollDOM.dispatchEvent(new Event('scroll'));await wait(40);
  assert.ok(requests.includes(300),'measurement must run after restoring the native scroll, not just before it');
  assert.equal(view,retained);assert.equal(view.state.doc,doc);assert.equal(view.state.selection,selection);
  view.destroy();view=undefined;
 });
 await t.test('source and live-preview final blank line after table reveal without content/selection changes',async()=>{
  for(const sourceMode of [false,true]){height=800;const text='prefix\n\n| A | B |\n| --- | --- |\n| one | two |\n\n';make(text);if(sourceMode)view.dispatch({effects:mode.reconfigure([])});geometry();view.focus();await wait(30);view.dispatch({selection:{anchor:text.length}});const selection=view.state.selection.main.toJSON();tap(view.contentDOM);shrink();await wait(200);assert.equal(view.scrollDOM.scrollTop,352);assert.equal(view.state.doc.toString(),text);assert.deepEqual(view.state.selection.main.toJSON(),selection);assert.equal(changed,0)}
 });


 await t.test('actual CM visible mid-note caret and noncollapsed range stay put',async()=>{
  for(const kind of ['middle','range']){height=800;const text='first\n\nlast';make(text);geometry();view.focus();await wait(30);view.dispatch({selection:kind==='range'?{anchor:0,head:text.length}:{anchor:0}});if(kind==='middle'){view.lineBlockAt=()=>({bottom:1500,top:1480,from:0,to:text.length,height:20});view.coordsAtPos=()=>bounds(200,220)}tap(view.contentDOM);shrink();await wait(220);assert.equal(view.scrollDOM.scrollTop,300,kind);assert.equal(view.state.doc.toString(),text)}
 });
 await t.test('actual CM range selection or moving away from the tail cancels buffered movement',async()=>{
  for(const kind of ['range','middle']){height=800;reduced=false;const text='first\n\nlast';make(text);geometry();view.focus();await wait(30);view.dispatch({selection:{anchor:text.length}});tap(view.contentDOM);shrink();await wait(160);assert.ok(view.scrollDOM.scrollTop>300&&view.scrollDOM.scrollTop<352);if(kind==='range')view.dispatch({selection:{anchor:0,head:text.length}});else {view.dispatch({selection:{anchor:0}});view.coordsAtPos=()=>bounds(200,220);view.lineBlockAt=()=>({bottom:1500,top:1480,from:0,to:text.length,height:20})}const top=view.scrollDOM.scrollTop;await wait(250);assert.equal(view.scrollDOM.scrollTop,top,kind)}reduced=true;
 });
 await t.test('covered CM caret in long document middle never triggers app reveal, source and preview',async()=>{
  for(const sourceMode of [false,true]){height=800;const text='before\n\n```css\n'+'.item { color: red; }\n'.repeat(80)+'```\n';make(text);if(sourceMode)view.dispatch({effects:mode.reconfigure([])});geometry();view.lineBlockAt=()=>({bottom:5000,top:4980,from:0,to:text.length,height:20});view.focus();await wait(30);view.dispatch({selection:{anchor:7}});tap(view.contentDOM);shrink();await wait(200);assert.equal(view.scrollDOM.scrollTop,300);assert.equal(view.state.doc.toString(),text);assert.equal(view.state.selection.main.head,7)}
 });
 await t.test('actual CM input, undo and redo outside the tail retain scroll ownership',async()=>{
  height=800;const text='first\n'+('middle paragraph\n'.repeat(180))+'last';make(text);geometry();view.lineBlockAt=()=>({bottom:5000,top:4980,from:0,to:view.state.doc.length,height:20});view.focus();await wait(30);view.dispatch({selection:{anchor:7}});shrink();
  view.dispatch({changes:{from:7,insert:'中'},selection:{anchor:8},userEvent:'input.type',scrollIntoView:true});view.contentDOM.dispatchEvent(new Event('input',{bubbles:true}));await wait(250);assert.equal(view.scrollDOM.scrollTop,300);assert.ok(undo(view));await wait(80);assert.equal(view.scrollDOM.scrollTop,300);assert.ok(redo(view));await wait(80);assert.equal(view.scrollDOM.scrollTop,300);
 });
 await t.test('real off-viewport CM document end excludes decorative tail padding',async()=>{
  height=800;const text=('long paragraph\n'.repeat(200))+'last';make(text);const end=view.lineBlockAt(text.length),first=view.lineBlockAt(0);assert.ok(end.bottom>first.bottom+800,'height map includes off-viewport document, not merely rendered DOM');
  view.contentDOM.style.paddingBottom='900px';view.requestMeasure();await wait(80);assert.equal(view.lineBlockAt(text.length).bottom,end.bottom,'decorative tail must not expand content end');
 });
 await t.test('shorter actual CM scroller clips the visible bottom independently of root chrome',async()=>{
  height=800;const text='last';make(text);geometry();view.scrollDOM.getBoundingClientRect=()=>bounds(0,440);view.focus();await wait(30);view.dispatch({selection:{anchor:text.length}});tap(view.contentDOM);await wait(200);assert.equal(view.scrollDOM.scrollTop,352);assert.equal(view.state.doc.toString(),text);
 });
 await t.test('actual live-preview table textarea reveals its caret while retaining composition and undo',async()=>{
  height=800;make('prefix\n\n| A | B |\n| --- | --- |\n| one | two |\n\n');geometry();const cell=document.querySelector('.cm-lp-table td');tap(cell);click(cell);const input=nativeTableInput(view);assert.ok(input);assert.equal(document.activeElement,input);
  input.style.lineHeight='20px';input.style.fontSize='15px';input.getBoundingClientRect=()=>bounds(460-(view.scrollDOM.scrollTop-300),480-(view.scrollDOM.scrollTop-300));
  // Native mirror has a real DOM node, with deterministic glyph layout only.
  const proto=dom.window.HTMLElement.prototype,original=proto.getClientRects;proto.getClientRects=function(){return this.tagName==='SPAN'&&this.parentElement?.style.left==='-10000px'?[bounds(0,20)]:original.call(this)};
  input.dispatchEvent(new Event('compositionstart',{bubbles:true}));input.value='中文';input.dispatchEvent(new Event('input',{bubbles:true}));shrink();await wait(200);
  assert.equal(view.scrollDOM.scrollTop,352);assert.equal(nativeTableInput(view),input);assert.equal(input.isConnected,true);assert.equal(document.activeElement,input);assert.equal(input.value,'中文');
  input.dispatchEvent(new Event('compositionend',{bubbles:true}));await wait(0);assert.match(view.state.doc.toString(),/中文/);assert.equal(runTableHistory(view,false),true);assert.equal(input.value,'one');proto.getClientRects=original;
 });
 await t.test('covered middle-table textarea input never reveals while retaining composition and undo',async()=>{
  height=800;make('prefix\n\n| A | B |\n| --- | --- |\n| one | two |\n\n');geometry();view.lineBlockAt=()=>({bottom:1500,top:1480,from:0,to:view.state.doc.length,height:20});const cell=document.querySelector('.cm-lp-table td');tap(cell);click(cell);const input=nativeTableInput(view);assert.ok(input);assert.equal(document.activeElement,input);
  input.style.lineHeight='20px';input.style.fontSize='15px';input.getBoundingClientRect=()=>bounds(460-(view.scrollDOM.scrollTop-300),480-(view.scrollDOM.scrollTop-300));
  // Native mirror has a real DOM node, with deterministic glyph layout only.
  const proto=dom.window.HTMLElement.prototype,original=proto.getClientRects;proto.getClientRects=function(){return this.tagName==='SPAN'&&this.parentElement?.style.left==='-10000px'?[bounds(0,20)]:original.call(this)};
  input.dispatchEvent(new Event('compositionstart',{bubbles:true}));input.value='中文';input.dispatchEvent(new Event('input',{bubbles:true}));shrink();await wait(200);
  assert.equal(view.scrollDOM.scrollTop,300);assert.equal(nativeTableInput(view),input);assert.equal(input.isConnected,true);assert.equal(document.activeElement,input);assert.equal(input.value,'中文');
  input.dispatchEvent(new Event('compositionend',{bubbles:true}));await wait(0);assert.match(view.state.doc.toString(),/中文/);assert.equal(runTableHistory(view,false),true);assert.equal(input.value,'one');proto.getClientRects=original;
 });
 }finally{view?.destroy();stop();rmSync(dir,{recursive:true,force:true});dom.window.close();for(const [key,descriptor]of old){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key]}delete globalThis.__lpApi;}
});
