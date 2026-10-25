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
test('table menu suspension and compact preview lifecycle using real CM6',async t=>{
 const dom=new JSDOM('<div class="st-app"><div class="st-note-surface" data-current="true"><div id="host"></div></div></div>',{url:'https://test.invalid/',pretendToBeVisual:true});
 const names=['window','Window','document','navigator','HTMLElement','Element','Node','Event','MouseEvent','KeyboardEvent','CustomEvent','MutationObserver','DOMRect','getComputedStyle'];const old=new Map(names.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 for(const key of names)Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:key==='getComputedStyle'?dom.window.getComputedStyle.bind(dom.window):dom.window[key]});
 globalThis.requestAnimationFrame=dom.window.requestAnimationFrame.bind(dom.window);globalThis.cancelAnimationFrame=dom.window.cancelAnimationFrame.bind(dom.window);
 const rect={left:0,right:600,top:0,bottom:24,width:600,height:24,x:0,y:0,toJSON(){return this}};
 dom.window.Range.prototype.getClientRects=()=>[rect];dom.window.Range.prototype.getBoundingClientRect=()=>rect;
 dom.window.document.elementFromPoint=()=>document.getElementById('host');
 const dir=mkdtempSync(join(tmpdir(),'lr-live-preview-'));let view;const calls=[];globalThis.__lpApi={contentCachedResource:async(...args)=>{calls.push(['cache',...args]);return {path:'/verified/cache',mime:'text/plain'}},contentOpenResource:async(...args)=>{calls.push(['open',...args])},contentCancel:async()=>{}};
 try{
 const out=join(dir,'entry.cjs');await build({stdin:{contents:`export {EditorState,Compartment,Transaction} from '@codemirror/state'; export {EditorView} from '@codemirror/view'; export {cmCaretVisibility,noteScrollNavigation} from './src/presentation/still01/editor/cmCaretVisibility'; export {nativeTableInput,ownsTableScroll,tableStructureHistory,runTableHistory} from './src/presentation/still01/editor/tableFocus'; export {history,undo,redo} from '@codemirror/commands'; export {runEditorCommand} from './src/presentation/still01/editor/editorCommands'; export {cmLivePreview,refreshLivePreview} from './src/presentation/still01/editor/cmLivePreview'; export {mobileLivePreviewModel} from './src/presentation/still01/editor/mobileLivePreviewModel';`,resolveDir:root,loader:'ts'},outfile:out,bundle:true,platform:'node',format:'cjs',define:{'import.meta.url':JSON.stringify('file://'+root+'/src/presentation/still01/editor/markdownParseClient.ts')},plugins:[{name:'native-boundary',setup(b){b.onResolve({filter:/services\/client$/},()=>({path:'client',namespace:'lp-mock'}));b.onLoad({filter:/.*/,namespace:'lp-mock'},()=>({contents:'export const api=globalThis.__lpApi;',loader:'js'}))}}]});
 const {EditorState,EditorView,Compartment,Transaction,history,undo,redo,cmLivePreview,refreshLivePreview,mobileLivePreviewModel,runEditorCommand,nativeTableInput,ownsTableScroll,tableStructureHistory,cmCaretVisibility,noteScrollNavigation,runTableHistory}=require(out);const wait=ms=>new Promise(r=>setTimeout(r,ms));let opens=[],enabled=true,changed=0;let mode;
 const make=(doc,extra={})=>{view?.destroy();document.getElementById('host').replaceChildren();mode=new Compartment();opens=[];enabled=true;changed=0;const options={enabled:()=>enabled,onWikiLink:r=>opens.push(r),...extra};view=new EditorView({state:EditorState.create({doc,selection:{anchor:doc.length},extensions:[history(),tableStructureHistory,cmCaretVisibility,mode.of(cmLivePreview(options)),EditorView.updateListener.of(u=>{if(u.docChanged)changed++})]}),parent:document.getElementById('host')});return options};
 const click=el=>{assert.ok(el,'click target');el.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:0}))};
 const source='prefix\n\n| Rank | Label |\n| --- | --- |\n| 2 | Beta |\n| 1 | Alpha |\n\nsuffix';
 await t.test('controls are absent until a cell edit, and disappear after outside departure',async()=>{
  make(source);const tools=document.querySelector('.cm-lp-table-tools');assert.equal(tools.hidden,true);
  click(document.querySelector('.cm-lp-table td'));assert.equal(tools.hidden,false);
  document.body.dispatchEvent(new Event('pointerdown',{bubbles:true}));await wait(0);
  assert.equal(tools.hidden,true);assert.equal(document.querySelector('.cm-lp-table-input'),null);
  click(document.querySelector('.cm-lp-table td'));assert.equal(tools.hidden,false);
  view.dispatch({effects:mode.reconfigure([])});assert.equal(document.querySelector('.cm-lp-table-tools'),null);
 });
 await t.test('focus and menu suspension do not change grid widths or wrapping authority',async()=>{
  make('| 项 | 长说明 |\n| --- | --- |\n| 短 | 很长的中文说明和 https://example.invalid/very-long-url 自动换行 |\n\nend');
  const box=document.querySelector('.cm-lp-table-wrap'),table=box.querySelector('table'),widths=()=>[...box.querySelectorAll('col')].map(c=>c.style.width);const before=widths(),style=box.getAttribute('style');
  click(box.querySelector('td'));assert.deepEqual(widths(),before);assert.equal(box.getAttribute('style'),style);assert.equal(box.querySelector('table'),table);
  click(box.querySelector('[aria-label="当前列操作"]'));await wait(0);assert.deepEqual(widths(),before);assert.equal(box.getAttribute('style'),style);assert.equal(box.querySelector('table'),table);
  document.body.dispatchEvent(new Event('pointerdown',{bubbles:true}));await wait(0);assert.deepEqual(widths(),before);assert.equal(box.getAttribute('style'),style);
 });
 await t.test('long-press menu blurs native input, preserves selection/scroll and never reopens IME on action or dismissal',async()=>{
  let dismiss;make(source,{registerOverlay:close=>{dismiss=close;return()=>{}}});view.scrollDOM.dispatchEvent(new Event('wheel',{bubbles:true}));
  view.scrollDOM.scrollTop=145;click(document.querySelectorAll('.cm-lp-table td')[1]);const input=nativeTableInput(view),selection=view.state.selection.main.toJSON();let blurs=0;input.addEventListener('blur',()=>blurs++);view.scrollDOM.scrollTop=145;
  document.querySelector('[aria-label="当前列操作"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));await wait(0);
  assert.equal(blurs,1);assert.equal(input.hidden,true);assert.equal(view.dom.contains(document.activeElement),false,'format toolbar focus predicate is false');assert.deepEqual(view.state.selection.main.toJSON(),selection);assert.equal(view.scrollDOM.scrollTop,145);
  click(document.querySelector('[aria-label="右侧插入列"]'));await wait(0);
  assert.equal(nativeTableInput(view),input);assert.equal(input.hidden,true);assert.notEqual(document.activeElement,input);assert.equal(document.querySelector('.cm-lp-table-tools').hidden,true);assert.equal(view.scrollDOM.scrollTop,145);
  assert.equal(runTableHistory(view,false),true);assert.equal(input.value,'Beta');assert.equal(input.hidden,true);assert.notEqual(document.activeElement,input);assert.equal(view.scrollDOM.scrollTop,145);
  assert.equal(runTableHistory(view,true),true);assert.equal(input.value,'');assert.equal(input.hidden,true);
  click(document.querySelectorAll('.cm-lp-table tr')[1].children[2]);assert.equal(nativeTableInput(view),input);assert.equal(document.activeElement,input);assert.equal(input.hidden,false);
  click(document.querySelector('[aria-label="当前行操作"]'));dismiss();await wait(0);assert.notEqual(document.activeElement,input);assert.equal(input.hidden,true);assert.equal(document.querySelector('.cm-lp-table-tools').hidden,true);
  click(document.querySelectorAll('.cm-lp-table tr')[1].children[2]);click(document.querySelector('[aria-label="当前行操作"]'));
  document.querySelector('.cm-lp-table-menu').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await wait(0);assert.equal(document.querySelector('.cm-lp-table-menu'),null);assert.notEqual(document.activeElement,input);
 });
 await t.test('menu waits for native composition commit or cancellation before acting',async()=>{
  for(const cancel of [false,true]){
   make(source);click(document.querySelectorAll('.cm-lp-table td')[1]);const input=nativeTableInput(view);input.dispatchEvent(new Event('compositionstart'));input.value='中文候选';
   document.querySelector('[aria-label="当前列操作"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
   assert.equal(document.querySelector('.cm-lp-table-menu'),null,'no structural operations mid-composition');assert.equal(input.isConnected,true);
   input.value=cancel?'Beta':'中文确认';input.dispatchEvent(new Event('compositionend'));await wait(0);
   assert.ok(document.querySelector('.cm-lp-table-menu'));assert.ok(view.state.doc.toString().includes(cancel?'Beta':'中文确认'));assert.ok(!view.state.doc.toString().includes('中文候选'));assert.notEqual(document.activeElement,input);assert.equal(input.hidden,true);
   if(!cancel){assert.equal(runTableHistory(view,false),true);assert.equal(input.value,'Beta');assert.equal(input.hidden,true)}
  }
 });
 await t.test('outside departure cancels pending composition menu and retains final native input',async()=>{
  make(source);click(document.querySelectorAll('.cm-lp-table td')[1]);const input=nativeTableInput(view);input.dispatchEvent(new Event('compositionstart'));
  document.querySelector('[aria-label="当前列操作"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
  document.body.dispatchEvent(new Event('pointerdown',{bubbles:true}));input.value='中文';input.dispatchEvent(new Event('compositionend'));input.value='中文最终';input.dispatchEvent(new Event('input'));await wait(0);
  assert.ok(view.state.doc.toString().includes('中文最终'));assert.equal(document.querySelector('.cm-lp-table-menu'),null);assert.equal(document.querySelector('.cm-lp-table-input'),null);
 });
 await t.test('loose and nested list interiors, and leading/trailing source blanks retain their geometry',()=>{
  const text='\n\n# Title\n\n- first paragraph\n\n  second paragraph\n\n  - nested first\n\n    nested continuation\n\n- next item\n\nend\n\n';
  const model=mobileLivePreviewModel(text),blanks=model.lines.filter(l=>l.className==='cm-lp-blank-separator');
  assert.equal(blanks.length,2,'only title-to-list and list-to-paragraph separators');
  assert.ok(blanks.every(l=>l.from>=text.indexOf('# Title')&&l.from<text.indexOf('end')));
  assert.ok(!blanks.some(l=>l.from>text.indexOf('- first')&&l.from<text.indexOf('- next item')+'- next item'.length));
  make(text);assert.equal(view.state.doc.toString(),text);view.dispatch({effects:mode.reconfigure([])});assert.equal(view.state.doc.toString(),text);
 });
 await t.test('caret and selection expose full blank-line editing geometry, indented code is untouched',()=>{
  const text='paragraph\n\nsecond\n\n    code first\n\n    code second\n\nend';make(text);
  const model=mobileLivePreviewModel(text),blanks=model.lines.filter(l=>l.className==='cm-lp-blank-separator');
  assert.ok(!blanks.some(l=>l.from>text.indexOf('    code first')&&l.from<text.indexOf('    code second')));
  const blank=text.indexOf('\n\n')+1;const compactAt=()=>{const node=view.domAtPos(blank).node;return Boolean((node.nodeType===1?node:node.parentElement)?.closest('.cm-lp-blank-separator'))};assert.equal(compactAt(),true);view.focus();view.dispatch({selection:{anchor:blank}});
  assert.equal(compactAt(),false);
  view.dispatch({selection:{anchor:blank-1,head:blank+1}});assert.equal(compactAt(),false);
  view.dispatch({selection:{anchor:0}});assert.equal(compactAt(),true);assert.equal(view.state.doc.toString(),text);
 });
 await t.test('compact marks only decorate actual inter-block blanks, never code/HTML or native viewport gaps',()=>{
  const text='# Title\n\nparagraph\n\n---\n\n| A | B |\n| --- | --- |\n| one | two |\n\n```txt\nkeep\n\nblank\n```\n\n<div>\n\nhtml\n</div>\n\nend';
  make(text);const model=mobileLivePreviewModel(text),blanks=model.lines.filter(l=>l.className==='cm-lp-blank-separator');
  assert.ok(blanks.length>=4);for(const mark of blanks)assert.match(text.slice(mark.from,mark.to),/^[ \t]*$/);
  assert.ok(!blanks.some(l=>l.from>text.indexOf('```txt')&&l.from<text.indexOf('```',text.indexOf('```txt')+3)));
  assert.ok(!blanks.some(l=>l.from>text.indexOf('<div>')&&l.from<text.indexOf('</div>')));
  assert.ok(document.querySelector('.cm-line.cm-lp-blank-separator'));assert.ok(document.querySelector('.cm-line.cm-lp-rule-line'));assert.equal(view.state.doc.toString(),text);
  view.dispatch({effects:mode.reconfigure([])});assert.equal(document.querySelector('.cm-lp-blank-separator'),null);assert.equal(view.state.doc.toString(),text);
 });
 }finally{view?.destroy();stop();rmSync(dir,{recursive:true,force:true});dom.window.close();for(const [key,descriptor]of old){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key]}delete globalThis.__lpApi;}
});
