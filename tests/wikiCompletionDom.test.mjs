// Optional real CM6 DOM regression harness (synthetic geometry, not phone QA).
// Install jsdom@26.1.0 and tsx@4.20.6 in a disposable directory, then:
// LR_DOM_RUNTIME=/path/to/runtime node --import /path/to/runtime/node_modules/tsx/dist/loader.mjs --test tests/wikiCompletionDom.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const runtime=process.env.LR_DOM_RUNTIME;
if(!runtime)throw new Error('Set LR_DOM_RUNTIME to a disposable jsdom 26.1.0 runtime; this is not a device test.');
const {JSDOM}=createRequire(resolve(runtime,'package.json'))('jsdom');
const dom=new JSDOM('<!doctype html><body><main class="st-note-surface"><div id="editor"></div></main></body>',{pretendToBeVisual:true});
const win=dom.window;
for(const k of ['window','Window','document','MutationObserver','HTMLElement','Node','Range','DOMRect','getComputedStyle','requestAnimationFrame','cancelAnimationFrame'])globalThis[k]=['getComputedStyle','requestAnimationFrame','cancelAnimationFrame'].includes(k)?win[k].bind(win):win[k];
Object.defineProperty(globalThis,'navigator',{value:win.navigator,configurable:true});
const rect=(left=24,top=150,width=312,height=400)=>({left,top,width,height,right:left+width,bottom:top+height,x:left,y:top,toJSON(){}});
Object.defineProperty(win.document.documentElement,'clientWidth',{get:()=>360});
Object.defineProperty(win.document.documentElement,'clientHeight',{get:()=>640});
win.HTMLElement.prototype.getBoundingClientRect=function(){return this.classList.contains('st-wiki-completion')?rect(12,0,336,150):this===win.document.body?rect(0,0,360,640):rect()};
win.Range.prototype.getBoundingClientRect=()=>rect(60,300,0,22);
win.Range.prototype.getClientRects=()=>[rect(60,300,1,22)];
for(const [prop,dim] of [['offsetWidth','width'],['offsetHeight','height'],['clientWidth','width'],['clientHeight','height']])Object.defineProperty(win.HTMLElement.prototype,prop,{get(){return this.getBoundingClientRect()[dim]}});
const {EditorState}=await import('@codemirror/state');
const {EditorView}=await import('@codemirror/view');
const {cmWikiCompletion}=await import('../src/presentation/still01/editor/cmWikiCompletion.ts');
const {runEditorCommand}=await import('../src/presentation/still01/editor/editorCommands.ts');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const choice={id:'n',title:'Note',target:'Note.md'};
function makeView(doc,load=async()=>({items:[choice],partial:false})){
 const view=new EditorView({state:EditorState.create({doc,extensions:[cmWikiCompletion(load,()=>true)]}),parent:document.getElementById('editor')});
 view.focus();return view;
}
const popup=()=>document.querySelector('.st-wiki-completion');
test('toolbar inserts [[]] and candidates remain visible in an inset editor',async()=>{
 const view=makeView('hello ');
 try{view.dispatch({selection:{anchor:6}});assert.equal(runEditorCommand(view,'wiki'),true);await sleep(230);view.measure();await sleep(40);
 assert.equal(view.state.doc.toString(),'hello [[]]');assert.ok(popup());assert.ok(parseFloat(popup().style.top)>-9999,'candidate must not be clipped by viewport-left anchor');
 assert.equal(popup().querySelector('strong').textContent,'Note');
 const button=popup().querySelector('button');button.dispatchEvent(new win.MouseEvent('mousedown',{bubbles:true,cancelable:true}));button.click();
 assert.equal(view.state.doc.toString(),'hello [[Note.md|Note]]');assert.equal(view.hasFocus,true);
 }finally{view.destroy()}
});
test('stale async results cannot replace newer input or appear after destroy',async()=>{
 const waits=new Map();const view=makeView('[[a]]',query=>new Promise(r=>waits.set(query,r)));
 try{view.dispatch({selection:{anchor:3}});await sleep(190);assert.ok(waits.has('a'));
 view.dispatch({changes:{from:2,to:3,insert:'b'},selection:{anchor:3}});await sleep(190);assert.ok(waits.has('b'));
 waits.get('b')({items:[{...choice,title:'B'}],partial:false});await sleep(30);
 waits.get('a')({items:[{...choice,title:'A'}],partial:false});await sleep(30);assert.equal(popup().querySelector('strong').textContent,'B');
 }finally{view.destroy()}assert.equal(popup(),null);
});
test('editing an existing embedded link preserves its alias and trailing text',async()=>{
 const view=makeView('![[attachments/phot.jpg|240]] tail',async()=>({items:[{id:'r',title:'photo.jpg',target:'attachments/photo.jpg'}],partial:false}));
 try{view.dispatch({selection:{anchor:19}});await sleep(210);assert.ok(popup());popup().querySelector('button').click();
 assert.equal(view.state.doc.toString(),'![[attachments/photo.jpg|240]] tail');
 }finally{view.destroy()}
});
test('composition dismisses suggestions and never accepts a stale choice',async()=>{
 const view=makeView('[[]]');
 try{view.dispatch({selection:{anchor:2}});await sleep(210);const button=popup().querySelector('button');
 view.contentDOM.dispatchEvent(new win.CompositionEvent('compositionstart',{bubbles:true}));button.click();await sleep(30);
 assert.equal(view.state.doc.toString(),'[[]]');assert.equal(popup(),null);
 view.contentDOM.dispatchEvent(new win.CompositionEvent('compositionend',{bubbles:true}));
 }finally{view.destroy()}
});
test.after(()=>win.close());
