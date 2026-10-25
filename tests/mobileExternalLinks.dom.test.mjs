// Real CodeMirror state/view/widgets in jsdom; native opener and resource IPC are mocked.
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
test('external links use native opener and never replace the host WebView',async t=>{
 const dom=new JSDOM('<div class="st-app"><div class="st-note-surface" data-current="true"><div id="host"></div></div></div>',{url:'https://test.invalid/',pretendToBeVisual:true});
 const names=['window','Window','document','navigator','HTMLElement','Element','Node','Event','MouseEvent','KeyboardEvent','CustomEvent','MutationObserver','DOMRect','getComputedStyle'];const old=new Map(names.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 for(const key of names)Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:key==='getComputedStyle'?dom.window.getComputedStyle.bind(dom.window):dom.window[key]});
 globalThis.requestAnimationFrame=dom.window.requestAnimationFrame.bind(dom.window);globalThis.cancelAnimationFrame=dom.window.cancelAnimationFrame.bind(dom.window);
 const rect={left:0,right:600,top:0,bottom:24,width:600,height:24,x:0,y:0,toJSON(){return this}};
 dom.window.Range.prototype.getClientRects=()=>[rect];dom.window.Range.prototype.getBoundingClientRect=()=>rect;
 dom.window.document.elementFromPoint=()=>document.getElementById('host');
 const dir=mkdtempSync(join(tmpdir(),'lr-live-preview-'));let view;const calls=[];globalThis.__externalOpen=async()=>{};window.open=()=>{assert.fail('window.open must never be used')};globalThis.__lpApi={contentCachedResource:async(...args)=>{calls.push(['cache',...args]);return {path:'/verified/cache',mime:'text/plain'}},contentOpenResource:async(...args)=>{calls.push(['open',...args])},contentCancel:async()=>{}};
 try{
 const out=join(dir,'entry.cjs');await build({stdin:{contents:`export {openExternalWebLink} from './src/services/safeExternalLink'; export {EditorState,Compartment,Transaction} from '@codemirror/state'; export {EditorView} from '@codemirror/view'; export {history,undo,redo} from '@codemirror/commands'; export {cmLivePreview} from './src/presentation/still01/editor/cmLivePreview'; export {mobileLivePreviewModel} from './src/presentation/still01/editor/mobileLivePreviewModel';`,resolveDir:root,loader:'ts'},outfile:out,bundle:true,platform:'node',format:'cjs',define:{'import.meta.url':JSON.stringify('file://'+root+'/src/presentation/still01/editor/markdownParseClient.ts')},plugins:[{name:'native-boundary',setup(b){b.onResolve({filter:/^@tauri-apps\/plugin-opener$/},()=>({path:'opener',namespace:'external-mock'}));b.onLoad({filter:/.*/,namespace:'external-mock'},()=>({contents:'export const openUrl=url=>globalThis.__recordExternal(url);',loader:'js'}));b.onResolve({filter:/services\/client$/},()=>({path:'client',namespace:'lp-mock'}));b.onLoad({filter:/.*/,namespace:'lp-mock'},()=>({contents:'export const api=globalThis.__lpApi;',loader:'js'}))}}]});
 globalThis.__recordExternal=url=>{calls.push(['external',url]);return globalThis.__externalOpen(url)};
 const {openExternalWebLink,EditorState,EditorView,Compartment,history,undo,redo,cmLivePreview,mobileLivePreviewModel}=require(out);const wait=ms=>new Promise(r=>setTimeout(r,ms));let opens=[],enabled=true,changed=0;let mode;
 const make=(doc,extra={})=>{view?.destroy();document.getElementById('host').replaceChildren();mode=new Compartment();opens=[];enabled=true;changed=0;const options={enabled:()=>enabled,onWikiLink:r=>opens.push(r),...extra};view=new EditorView({state:EditorState.create({doc,selection:{anchor:doc.length},extensions:[history(),mode.of(cmLivePreview(options)),EditorView.updateListener.of(u=>{if(u.docChanged)changed++})]}),parent:document.getElementById('host')});return options};
 const click=el=>{assert.ok(el,'click target');el.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}))};
 await t.test('HTTP(S) buttons open natively, including Unicode/query/fragment, without modifying draft or selection',async()=>{
  for(const url of ['http://example.com/','https://例子.测试/路径?q=中文#章节']){
   const source=`[web](${url})\nunsaved draft`;make(source);const selection=view.state.selection.toJSON(),before=calls.length;
   click(document.querySelector('.cm-lp-link'));await wait(0);
   assert.deepEqual(calls.slice(before),[['external',url]]);assert.equal(view.state.doc.toString(),source);assert.deepEqual(view.state.selection.toJSON(),selection);assert.equal(changed,0);assert.equal(window.location.href,'https://test.invalid/');
  }
 });
 await t.test('rapid repeated activation deduplicates pending launch but allows retry after completion',async()=>{
  let resolve;globalThis.__externalOpen=()=>new Promise(r=>resolve=r);make('[web](https://example.com/)\nend');const b=document.querySelector('.cm-lp-link'),before=calls.length;
  click(b);click(b);assert.equal(calls.length,before+1);assert.equal(b.getAttribute('aria-busy'),'true');resolve();await wait(0);assert.equal(b.hasAttribute('aria-busy'),false);
  globalThis.__externalOpen=async()=>{};click(b);await wait(0);assert.equal(calls.length,before+2);
 });
 await t.test('long press Open uses same native route and releases menu Back overlay',async()=>{
  let dismiss,released=0;make('[web](https://example.com/)\nend',{registerOverlay:cb=>{dismiss=cb;return()=>released++}});const b=document.querySelector('.cm-lp-link'),before=calls.length;
  b.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true}));await wait(540);assert.ok(document.querySelector('.cm-lp-link-menu'));click(b);assert.equal(calls.length,before);
  click([...document.querySelectorAll('.cm-lp-link-menu button')].find(b=>b.textContent==='打开链接'));await wait(0);
  assert.deepEqual(calls.slice(before),[['external','https://example.com/']]);assert.equal(document.querySelector('.cm-lp-link-menu'),null);assert.equal(released,1);dismiss();assert.equal(changed,0);
 });
 await t.test('table HTTP and HTTPS both use native opener without entering cell edit',async()=>{
  const source='| A | B |\n| --- | --- |\n| [http](http://example.com/) | [https](https://example.com/?q=1#section) |\n\nend';make(source);const selection=view.state.selection.toJSON(),before=calls.length;
  for(const b of document.querySelectorAll('.cm-lp-table .cm-lp-link')){click(b);await wait(0)}
  assert.deepEqual(calls.slice(before),[['external','http://example.com/'],['external','https://example.com/?q=1#section']]);assert.equal(view.state.doc.toString(),source);assert.deepEqual(view.state.selection.toJSON(),selection);assert.equal(changed,0);
 });
 await t.test('native opener failure stays in note with a gentle message and supports retry',async()=>{
  globalThis.__externalOpen=async()=>{throw new Error('no browser')};const source='[web](https://example.com/)\nunsaved draft';make(source);const selection=view.state.selection.toJSON(),b=document.querySelector('.cm-lp-link');click(b);await wait(0);
  const status=document.querySelector('.cm-lp-link-wrap [role="status"]');assert.match(status.textContent,/无法打开网页/);assert.equal(status.hidden,false);assert.equal(window.location.href,'https://test.invalid/');assert.equal(view.state.doc.toString(),source);assert.deepEqual(view.state.selection.toJSON(),selection);assert.equal(changed,0);
  globalThis.__externalOpen=async()=>{};click(b);await wait(0);assert.equal(status.hidden,true);assert.equal(status.textContent,'');
 });
 await t.test('late failure after retiring editor does not mutate the next note',async()=>{
  let reject;globalThis.__externalOpen=()=>new Promise((_resolve,r)=>reject=r);make('[old](https://example.com/)\nend');click(document.querySelector('.cm-lp-link'));make('next draft');reject(new Error('late'));await wait(0);assert.equal(document.querySelector('.cm-lp-link-wrap'),null);assert.equal(view.state.doc.toString(),'next draft');assert.equal(changed,0);globalThis.__externalOpen=async()=>{};
 });
 await t.test('cancel, Back, scroll and detached/disabled widgets cannot launch',async()=>{
  let dismiss;make('[web](https://example.com/)\nend',{registerOverlay:cb=>{dismiss=cb;return()=>{}}});const b=document.querySelector('.cm-lp-link'),before=calls.length;
  b.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));dismiss();assert.equal(document.querySelector('.cm-lp-link-menu'),null);
  b.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));click([...document.querySelectorAll('.cm-lp-link-menu button')].find(b=>b.textContent==='取消'));
  b.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,clientX:10,clientY:10}));b.dispatchEvent(new MouseEvent('pointermove',{bubbles:true,clientX:10,clientY:70}));b.dispatchEvent(new MouseEvent('pointerup',{bubbles:true}));click(b);
  enabled=false;click(b);enabled=true;make('other');click(b);await wait(0);assert.equal(calls.length,before);
 });
 await t.test('dangerous schemes and malformed HTTP links never reach native or WebView navigation',async()=>{
  const bad=['javascript:alert(1)','data:text/html,hi','file:///private/note','content://private/note','intent://example.com','//example.com','https://','https://example.com/\\evil','https://example.com/\npath',' https://example.com/'];const before=calls.length;
  for(const url of bad)await assert.rejects(openExternalWebLink(url));
  make('[bad](javascript:alert) [bad](data:text/html,hi) [bad](file:///private/note)\nend');assert.equal(document.querySelector('.cm-lp-link'),null);assert.equal(calls.length,before);assert.equal(window.location.href,'https://test.invalid/');
 });
 await t.test('wiki/heading and scoped attachment routes stay separate from native web opener',async()=>{
  let before=calls.length;make('[[Target#Heading|Alias]]\nend');click(document.querySelector('.cm-lp-link'));assert.equal(opens[0].target,'Target#Heading');assert.equal(calls.length,before);
  const resource={resourceId:'resource-id',target:'attachments/test.txt',status:'resolved',mimeType:'text/plain'};make(`[file](${resource.target})\nend`,{imageScope:{instance:'desktop',vault:'vault',note:'note',online:true,resources:[resource]}});await wait(10);before=calls.length;click(document.querySelector('.cm-lp-file'));await wait(0);assert.deepEqual(calls.slice(before),[['open','desktop','resource-id','vault','note']]);assert.equal(changed,0);
 });
 }finally{view?.destroy();stop();rmSync(dir,{recursive:true,force:true});dom.window.close();for(const [key,descriptor]of old){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key]}delete globalThis.__lpApi;delete globalThis.__recordExternal;delete globalThis.__externalOpen;}
});
