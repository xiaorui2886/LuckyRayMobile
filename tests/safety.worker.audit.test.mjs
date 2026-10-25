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
test('real CM6 live preview document, gestures, source mode and task transactions',async t=>{
 const dom=new JSDOM('<div class="st-app"><div class="st-note-surface" data-current="true"><div id="host"></div></div></div>',{url:'https://test.invalid/',pretendToBeVisual:true});
 const names=['window','Window','document','navigator','HTMLElement','Element','Node','Event','MouseEvent','KeyboardEvent','CustomEvent','MutationObserver','DOMRect','getComputedStyle'];const old=new Map(names.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 for(const key of names)Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:key==='getComputedStyle'?dom.window.getComputedStyle.bind(dom.window):dom.window[key]});
 globalThis.requestAnimationFrame=dom.window.requestAnimationFrame.bind(dom.window);globalThis.cancelAnimationFrame=dom.window.cancelAnimationFrame.bind(dom.window);
 const rect={left:0,right:600,top:0,bottom:24,width:600,height:24,x:0,y:0,toJSON(){return this}};
 dom.window.Range.prototype.getClientRects=()=>[rect];dom.window.Range.prototype.getBoundingClientRect=()=>rect;
 dom.window.document.elementFromPoint=()=>document.getElementById('host');
 const dir=mkdtempSync(join(tmpdir(),'lr-live-preview-'));let view;const calls=[];globalThis.__lpApi={contentCachedResource:async(...args)=>{calls.push(['cache',...args]);return {path:'/verified/cache',mime:'text/plain'}},contentOpenResource:async(...args)=>{calls.push(['open',...args])},contentCancel:async()=>{}};
 try{
 const out=join(dir,'entry.cjs');await build({stdin:{contents:`export {EditorState,Compartment,Transaction} from '@codemirror/state'; export {EditorView} from '@codemirror/view'; export {history,undo,redo} from '@codemirror/commands'; export {cmInlineImages,editorImageRanges} from './src/presentation/still01/editor/cmInlineImages'; export {cmLivePreview} from './src/presentation/still01/editor/cmLivePreview'; export {mobileLivePreviewModel} from './src/presentation/still01/editor/mobileLivePreviewModel';`,resolveDir:root,loader:'ts'},outfile:out,bundle:true,platform:'node',format:'cjs',define:{'import.meta.url':JSON.stringify('file://'+root+'/src/presentation/still01/editor/markdownParseClient.ts')},plugins:[{name:'native-boundary',setup(b){b.onResolve({filter:/services\/client$/},()=>({path:'client',namespace:'lp-mock'}));b.onLoad({filter:/.*/,namespace:'lp-mock'},()=>({contents:'export const api=globalThis.__lpApi;',loader:'js'}))}}]});
 const {EditorState,EditorView,Compartment,history,undo,redo,cmInlineImages,editorImageRanges,cmLivePreview,mobileLivePreviewModel}=require(out);const wait=ms=>new Promise(r=>setTimeout(r,ms));let opens=[],enabled=true,changed=0;let mode;
 const make=(doc,extra={})=>{view?.destroy();document.getElementById('host').replaceChildren();mode=new Compartment();opens=[];enabled=true;changed=0;const options={enabled:()=>enabled,onWikiLink:r=>opens.push(r),...extra};view=new EditorView({state:EditorState.create({doc,selection:{anchor:doc.length},extensions:[history(),extra.imageExtension?cmInlineImages(extra.imageExtension):[],mode.of(cmLivePreview(options)),EditorView.updateListener.of(u=>{if(u.docChanged)changed++})]}),parent:document.getElementById('host')});return options};
 const click=el=>{assert.ok(el,'click target');el.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}))};
 await t.test('ordinary preview hides syntax visually without changing Markdown bytes',()=>{const source='# Heading\n\n**bold** *italic* ~~gone~~ `code` ==mark== [[Target|Alias]]\n\nend';make(source);assert.equal(view.state.doc.toString(),source);assert.equal(changed,0);assert.equal(document.querySelector('.cm-lp-link').textContent,'Alias');assert.ok(document.querySelector('.cm-lp-heading'));assert.ok(document.querySelector('.cm-lp-strong'));assert.ok(document.querySelector('.cm-lp-highlight'));assert.doesNotMatch(view.contentDOM.textContent,/\*\*|\[\[Target/)});
 await t.test('only intersected token reveals source, others remain preview',()=>{const source='**one** and **two**\nend';make(source);view.focus();view.dispatch({selection:{anchor:3}});assert.match(view.contentDOM.textContent,/\*\*one\*\*/);assert.doesNotMatch(view.contentDOM.textContent,/\*\*two\*\*/);assert.equal(changed,0)});
 await t.test('source-mode compartment roundtrip retains document, selection and undo',()=>{const source='**one**\nend',options=make(source);view.dispatch({changes:{from:source.length,insert:'!'}});const state=view.state;view.dispatch({effects:mode.reconfigure([])});assert.match(view.contentDOM.textContent,/\*\*one\*\*/);assert.deepEqual(view.state.selection.toJSON(),state.selection.toJSON());view.dispatch({effects:mode.reconfigure(cmLivePreview(options))});assert.equal(view.state.doc.toString(),source+'!');assert.equal(undo(view),true);assert.equal(view.state.doc.toString(),source)});
 await t.test('exact alias click forwards original resolver target, never rewrites source',()=>{const source='[[Old#中文|Alias]]\nend';make(source);click(document.querySelector('.cm-lp-link'));assert.equal(opens.length,1);assert.equal(opens[0].target,'Old#中文');assert.equal(opens[0].from,0);assert.equal(view.state.doc.toString(),source);assert.equal(changed,0)});
 await t.test('long-press menu edits only current link and does not navigate',()=>{const source='[[First|A]] [[Second|B]]\nend';make(source);document.querySelector('.cm-lp-link').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));const edit=[...document.querySelectorAll('.cm-lp-link-menu button')].find(b=>b.textContent==='编辑链接');click(edit);assert.equal(opens.length,0);assert.match(view.contentDOM.textContent,/\[\[First\|A\]\]/);assert.doesNotMatch(view.contentDOM.textContent,/\[\[Second/);assert.equal(view.state.selection.main.head,2);assert.equal(changed,0)});
 await t.test('scroll gesture and pointer cancel never navigate',()=>{make('[[Target|Alias]]\nend');const b=document.querySelector('.cm-lp-link');b.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,clientX:10,clientY:10}));b.dispatchEvent(new MouseEvent('pointermove',{bubbles:true,clientX:10,clientY:70}));b.dispatchEvent(new MouseEvent('pointerup',{bubbles:true,clientX:10,clientY:70}));click(b);assert.equal(opens.length,0);b.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true}));b.dispatchEvent(new MouseEvent('pointercancel',{bubbles:true}));click(b);assert.equal(opens.length,0)});
 await t.test('task toggle is one document transaction and exactly one undo/redo',()=>{const source='- [ ] one\n- [x] two\nend';make(source);click(document.querySelector('.cm-lp-task'));assert.equal(view.state.doc.toString(),'- [x] one\n- [x] two\nend');assert.equal(changed,1);assert.equal(undo(view),true);assert.equal(view.state.doc.toString(),source);assert.equal(redo(view),true);assert.equal(view.state.doc.toString(),'- [x] one\n- [x] two\nend')});
 await t.test('table preview cell opens exact original source without mutation',()=>{const source='| A | B |\n| --- | --- |\n| 中文 | 2 |\n\nend';make(source);assert.equal(document.querySelectorAll('.cm-lp-table tr').length,2);click([...document.querySelectorAll('.cm-lp-table td')][0]);assert.ok(view.state.selection.main.head>=source.indexOf('中文')-1);assert.match(view.contentDOM.textContent,/\| A \| B \|/);assert.equal(changed,0)});
 await t.test('table inline format and wiki link keep source and resolver authority',()=>{const source='| A | B |\n| --- | --- |\n| **bold** ==mark== `code` | [[Old]] |\n\nend';make(source);assert.ok(document.querySelector('.cm-lp-table strong'));assert.ok(document.querySelector('.cm-lp-table mark'));assert.ok(document.querySelector('.cm-lp-table code'));const link=document.querySelector('.cm-lp-table .cm-lp-link');assert.ok(link);click(link);assert.equal(opens.length,1);assert.equal(view.state.doc.toString(),source);assert.equal(changed,0)});
 await t.test('link menu participates in page Back overlay and unregisters',()=>{let dismiss,released=0;make('[[Target|Alias]]\nend',{registerOverlay:callback=>{dismiss=callback;return()=>released++}});document.querySelector('.cm-lp-link').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));assert.ok(document.querySelector('.cm-lp-link-menu'));dismiss();assert.equal(document.querySelector('.cm-lp-link-menu'),null);assert.equal(released,1);assert.equal(opens.length,0)});
 await t.test('code block is visually styled without interpreting inner Markdown',()=>{const source='```js\n**literal** [[NoLink]]\n```\n\nend';make(source);assert.ok(document.querySelector('.cm-lp-code'));assert.equal(document.querySelector('.cm-lp-link'),null);assert.match(view.contentDOM.textContent,/\*\*literal\*\*/);assert.doesNotMatch(view.contentDOM.textContent,/```/);assert.equal(view.state.doc.toString(),source)});
 await t.test('disabled or stale source widgets cannot act',()=>{make('[[Target|Alias]]\nend');const oldButton=document.querySelector('.cm-lp-link');enabled=false;click(oldButton);assert.equal(opens.length,0);enabled=true;view.dispatch({changes:{from:0,to:16,insert:'changed'}});click(oldButton);assert.equal(opens.length,0)});
 await t.test('resource label uses scoped IDs; no raw target path passed to native open',async()=>{const resource={resourceId:'resource-id',target:'attachments/%E4%B8%AD%E6%96%87.txt',status:'resolved',mimeType:'text/plain'};make(`[long](${resource.target})\nend`,{imageScope:{instance:'desktop',vault:'vault',note:'note',online:true,resources:[resource]}});await wait(10);const b=document.querySelector('.cm-lp-file');assert.match(b.textContent,/中文\.txt/);click(b);await wait(10);assert.deepEqual(calls.find(x=>x[0]==='open'),['open','desktop','resource-id','vault','note']);assert.equal(changed,0)});
 await t.test('HTML and dangerous URL do not produce executable DOM',()=>{make('<script>alert(1)</script>\n\n[x](javascript:alert) ![x](https://bad.example/x.png)\nend');assert.equal(view.contentDOM.querySelector('script,img,a'),null);assert.equal(document.querySelector('.cm-lp-link'),null)});
 await t.test('composition maps decorations and preserves document/selection authority',async()=>{make('**one**\nend');view.focus();view.contentDOM.dispatchEvent(new Event('compositionstart',{bubbles:true}));view.dispatch({changes:{from:view.state.doc.length,insert:'中'},userEvent:'input.type.compose'});assert.equal(view.state.doc.toString(),'**one**\nend中');assert.equal(changed,1);view.contentDOM.dispatchEvent(new Event('compositionend',{bubbles:true}));await wait(70);assert.equal(view.state.doc.toString(),'**one**\nend中')});
 await t.test('long note without Worker stays editable with truthful fallback',async()=>{const source='**one**\n'+'plain text\n'.repeat(1300);make(source);assert.equal(document.querySelector('.cm-lp-strong'),null);view.dispatch({changes:{from:source.length,insert:'!'}});await wait(190);assert.equal(view.state.doc.toString(),source+'!');assert.match(document.querySelector('.cm-lp-preview-status').textContent,/暂不可后台预览/);assert.equal(changed,1)});
 await t.test('worker result is revision guarded, composition deferred and retired on destroy',async()=>{
  const workers=[];globalThis.Worker=class {onmessage=null;onerror=null;messages=[];terminated=false;constructor(){workers.push(this)}postMessage(job){this.messages.push(job)}terminate(){this.terminated=true}reply(job){this.onmessage?.({data:{id:job.id,result:mobileLivePreviewModel(job.source,job.resources)}})}};
  try{const source='**one**\n'+'plain text\n'.repeat(1300);make(source);await wait(190);const worker=workers[0],first=worker.messages[0];assert.ok(first);view.dispatch({changes:{from:2,to:5,insert:'two'}});worker.reply(first);assert.equal(document.querySelector('.cm-lp-strong'),null);await wait(190);const latest=worker.messages.at(-1);assert.notEqual(latest.id,first.id);view.contentDOM.dispatchEvent(new Event('compositionstart',{bubbles:true}));worker.reply(latest);assert.equal(document.querySelector('.cm-lp-strong'),null);view.contentDOM.dispatchEvent(new Event('compositionend',{bubbles:true}));await wait(70);assert.equal(document.querySelector('.cm-lp-strong').textContent,'two');assert.equal(view.state.doc.toString(),source.replace('one','two'));view.destroy();view=null;assert.equal(worker.terminated,true)}finally{delete globalThis.Worker}
 });
 await t.test('retiring editor clears hold menu timer',async()=>{make('[[Target|Alias]]\nend');document.querySelector('.cm-lp-link').dispatchEvent(new MouseEvent('pointerdown',{bubbles:true}));view.destroy();view=null;await wait(550);assert.equal(document.querySelector('.cm-lp-link-menu'),null);assert.equal(opens.length,0)});

 await t.test('AUDIT oversized fallback clears old hidden syntax',()=>{
   make('[[Target|Alias]]\nend');
   assert.ok(document.querySelector('.cm-lp-link'));
   view.dispatch({changes:{from:view.state.doc.length,insert:'x'.repeat(250001)}});
   assert.equal(document.querySelector('.cm-lp-link'),null,'lightweight source fallback must remove old replacement');
 });
 await t.test('AUDIT unavailable worker clears old hidden syntax',async()=>{
   make('[[Target|Alias]]\nend');
   view.dispatch({changes:{from:view.state.doc.length,insert:'x'.repeat(13000)}});
   await wait(220);
   assert.equal(document.querySelector('.cm-lp-link'),null,'unavailable worker must leave editable source');
 });

 await t.test('AUDIT cancelled old worker error must not mark a short current note unavailable',async()=>{
   const workers=[];globalThis.Worker=class {messages=[];terminated=false;constructor(){workers.push(this)}postMessage(job){this.messages.push(job)}terminate(){this.terminated=true}};
   try{make('**one**\n'+'plain text\n'.repeat(1300));await wait(190);const worker=workers[0],job=worker.messages[0];
    view.dispatch({changes:{from:0,to:view.state.doc.length,insert:'short'}});
    worker.onmessage({data:{id:job.id,error:true}});
    assert.equal(document.querySelector('.cm-lp-preview-status').textContent,'','old cancelled parse must not affect current short note');
   }finally{delete globalThis.Worker}
 });
 await t.test('AUDIT retired owner rejects delayed reply',async()=>{
   const workers=[];globalThis.Worker=class {messages=[];terminated=false;constructor(){workers.push(this)}postMessage(job){this.messages.push(job)}terminate(){this.terminated=true}};
   try{make('**one**\n'+'plain text\n'.repeat(1300));await wait(190);const worker=workers[0],job=worker.messages[0];
    make('new owner');assert.equal(worker.terminated,true);
    worker.onmessage({data:{id:job.id,result:mobileLivePreviewModel(job.source)}});
    assert.equal(view.state.doc.toString(),'new owner');assert.equal(document.querySelector('.cm-lp-strong'),null);
   }finally{delete globalThis.Worker}
 });

 await t.test('AUDIT fallback during composition defers DOM replacement until composition ends',async()=>{
   const workers=[];globalThis.Worker=class {messages=[];terminated=false;constructor(){workers.push(this)}postMessage(job){this.messages.push(job)}terminate(){this.terminated=true}};
   try{make('[[Target|Alias]]\nend');const old=document.querySelector('.cm-lp-link');
    view.contentDOM.dispatchEvent(new Event('compositionstart',{bubbles:true}));
    view.dispatch({changes:{from:view.state.doc.length,insert:'x'.repeat(13000)},userEvent:'input.type.compose'});await wait(190);
    const worker=workers[0],job=worker.messages[0];worker.onmessage({data:{id:job.id,error:true}});
    assert.equal(document.querySelector('.cm-lp-link'),old,'keep host DOM during IME');
    view.contentDOM.dispatchEvent(new Event('compositionend',{bubbles:true}));await wait(70);
    assert.equal(document.querySelector('.cm-lp-link'),null,'fallback applies after IME');
   }finally{delete globalThis.Worker}
 });
 await t.test('AUDIT table inline HTML and dangerous schemes are inert',()=>{
   make('| A | B |\n| --- | --- |\n| <img src=x onerror=alert(1)> [bad](javascript:alert) | [file](file:///etc/passwd) |\n\nend');
   assert.ok(document.querySelector('.cm-lp-table'));assert.equal(document.querySelector('.cm-lp-table img,.cm-lp-table script,.cm-lp-table a,.cm-lp-table .cm-lp-link'),null);
 });

 await t.test('AUDIT cancelled old worker runtime error does not poison current owner',async()=>{
   const workers=[];globalThis.Worker=class {messages=[];terminated=false;constructor(){workers.push(this)}postMessage(job){this.messages.push(job)}terminate(){this.terminated=true}};
   try{make('**one**\n'+'plain text\n'.repeat(1300));await wait(190);const worker=workers[0];
    view.dispatch({changes:{from:0,to:view.state.doc.length,insert:'short'}});
    worker.onerror({message:'late runtime error'});
    assert.equal(document.querySelector('.cm-lp-preview-status').textContent,'');
   }finally{delete globalThis.Worker}
 });

 await t.test('AUDIT image worker discards stale result and defers current result through composition',async()=>{
   const workers=[];globalThis.Worker=class {messages=[];terminated=false;constructor(){workers.push(this)}postMessage(job){this.messages.push(job)}terminate(){this.terminated=true}};
   const scope={instance:'desktop',vault:'vault',note:'note',online:false,resources:[{resourceId:'image-id',target:'attachments/img.png',status:'resolved',mimeType:'image/png'}]};
   try{make('![x](attachments/img.png)\n'+'plain text\n'.repeat(1300),{imageExtension:scope});await wait(190);
    const worker=workers.find(w=>w.messages[0].kind==='images'),first=worker.messages[0];assert.ok(worker);
    view.dispatch({changes:{from:view.state.doc.length,insert:'!'}});
    worker.onmessage({data:{id:first.id,result:editorImageRanges(first.source,first.resources)}});
    assert.equal(document.querySelector('.st-editor-image'),null);await wait(190);const latest=worker.messages.at(-1);
    view.contentDOM.dispatchEvent(new Event('compositionstart',{bubbles:true}));
    worker.onmessage({data:{id:latest.id,result:editorImageRanges(latest.source,latest.resources)}});
    assert.equal(document.querySelector('.st-editor-image'),null);
    view.contentDOM.dispatchEvent(new Event('compositionend',{bubbles:true}));await wait(70);
    assert.ok(document.querySelector('.st-editor-image'));view.destroy();view=null;assert.equal(worker.terminated,true);
   }finally{delete globalThis.Worker}
 });

 await t.test('AUDIT worker deadline falls back without synchronously parsing long source',async()=>{
   const workers=[];globalThis.Worker=class {messages=[];terminated=false;constructor(){workers.push(this)}postMessage(job){this.messages.push(job)}terminate(){this.terminated=true}};
   const realTimeout=globalThis.setTimeout;let deadline;
   globalThis.setTimeout=(fn,ms,...args)=>{if(ms===15000)deadline=()=>fn(...args);return realTimeout(fn,ms,...args)};
   try{make('[[Target|Alias]]\nend');view.dispatch({changes:{from:view.state.doc.length,insert:'x'.repeat(13000)}});await wait(190);
    assert.equal(typeof deadline,'function');deadline();assert.equal(workers[0].terminated,true);
    assert.equal(document.querySelector('.cm-lp-link'),null);assert.match(document.querySelector('.cm-lp-preview-status').textContent,/暂不可后台预览/);
    const source=view.state.doc.toString();view.dispatch({changes:{from:view.state.doc.length,insert:'!'}});assert.equal(view.state.doc.toString(),source+'!');
   }finally{globalThis.setTimeout=realTimeout;delete globalThis.Worker}
 });
 }finally{view?.destroy();stop();rmSync(dir,{recursive:true,force:true});dom.window.close();for(const [key,descriptor]of old){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key]}delete globalThis.__lpApi;}
});
