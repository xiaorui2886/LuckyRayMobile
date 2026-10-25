/** Optional dev QA: LR_JSDOM_MODULE=/path/to/jsdom node scripts/qa/mobileR6Editor.dom.cjs
 * Bundles real production CodeMirror extensions. Only native IPC/file URL adapters
 * are stubbed; no product dependency or generated artifact is added to the repo.
 */
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createRequire}=require('node:module');
const {JSDOM}=require(process.env.LR_JSDOM_MODULE||'jsdom');
const root=path.resolve(__dirname,'../..');
const projectRequire=createRequire(path.join(root,'package.json'));
const esbuild=createRequire(projectRequire.resolve('vite/package.json'))('esbuild');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'luckyray-r6-editor-'));
(async()=>{
let w;
try {
const bundle=path.join(temp,'bundle.cjs');
await esbuild.build({stdin:{contents:`export {EditorState,Compartment} from '@codemirror/state';export {EditorView} from '@codemirror/view';export * from './src/presentation/still01/editor/cmInlineImages';export * from './src/presentation/still01/editor/cmCaretVisibility';export {tailRevealDelta} from './src/presentation/still01/editor/noteTailClearance';export * from './src/presentation/still01/editor/cmWikiCompletion';`,resolveDir:root},bundle:true,platform:'node',format:'cjs',outfile:bundle,plugins:[{name:'native-test-adapters',setup(b){
b.onResolve({filter:/services\/client$/},()=>({path:'api',namespace:'test-adapter'}));
b.onResolve({filter:/^@tauri-apps\/api\/core$/},()=>({path:'core',namespace:'test-adapter'}));
b.onLoad({filter:/.*/,namespace:'test-adapter'},args=>({contents:args.path==='core'?`export const convertFileSrc=p=>'http://localhost'+p;`:`export const api={contentCachedResource:async()=>({path:'/fake.png',mime:'image/png'}),contentNoteResource:async()=>({path:'/fake.png',mime:'image/png'}),contentCancel:async()=>{}};`,loader:'js'}));
}}]});
const d=new JSDOM('<!doctype html><body></body>',{pretendToBeVisual:true,url:'http://localhost'});w=d.window;
for(const k of ['Window','window','document','navigator','MutationObserver','Node','HTMLElement','HTMLImageElement','getComputedStyle','DOMRect','Range'])Object.defineProperty(global,k,{value:k==='window'?w:k==='document'?w.document:w[k],configurable:true,writable:true});
global.requestAnimationFrame=w.requestAnimationFrame.bind(w);global.cancelAnimationFrame=w.cancelAnimationFrame.bind(w);
w.Range.prototype.getClientRects=()=>[];w.Range.prototype.getBoundingClientRect=()=>new w.DOMRect(0,0,1,20);
const {EditorState,EditorView,Compartment,cmInlineImages,cmCaretVisibility,tailRevealDelta,cmWikiCompletion}=require(bundle);
const scope={instance:'i',vault:'v',note:'n',online:false,resources:['a.png','b.png'].map(target=>({target,resourceId:target,status:'resolved',mimeType:'image/png'}))};
let count=0,failures=0;function check(name,fn){try{fn();console.log('PASS',name);count++}catch(e){failures++;console.error('FAIL',name,e.stack)}}
function make(doc){const compartment=new Compartment;const v=new EditorView({state:EditorState.create({doc,extensions:[compartment.of(cmInlineImages(scope)),cmCaretVisibility]}),parent:document.body});return [v,compartment]}
check('standalone block renders without invalid decoration',()=>{const[v]=make('before\n![[a.png]]\nafter');assert.equal(v.dom.querySelectorAll('.st-editor-image').length,1);assert(!v.contentDOM.textContent.includes('![['));v.destroy()});
check('two same-line attachments preserve intervening text',()=>{const[v]=make('x ![[a.png]] gap ![[b.png]] y');assert.equal(v.dom.querySelectorAll('.st-editor-image').length,2);assert(v.contentDOM.textContent.includes(' gap '));v.focus();v.dispatch({selection:{anchor:5}});assert(v.contentDOM.textContent.includes('![[a.png]]'));assert(!v.contentDOM.textContent.includes('![[b.png]]'));v.destroy()});
check('image click reveals only clicked source and preserves document',()=>{const doc='before\n![[a.png]]\n![[b.png]]\nafter';const[v]=make(doc);const img=v.dom.querySelectorAll('.st-editor-image')[1];img.dispatchEvent(new w.MouseEvent('click',{bubbles:true}));assert(v.hasFocus);assert(v.contentDOM.textContent.includes('![[b.png]]'));assert(!v.contentDOM.textContent.includes('![[a.png]]'));assert.equal(v.state.doc.toString(),doc);v.destroy()});
check('focus blur and source reconfigure preserve selection and draft',()=>{const[v,c]=make('before\n![[a.png]]\nafter');v.focus();v.dispatch({selection:{anchor:10},changes:{from:0,insert:'new '}});const doc=v.state.doc.toString(),sel=v.state.selection.main.head;v.dispatch({effects:c.reconfigure([])});assert(v.contentDOM.textContent.includes('![[a.png]]'));v.dispatch({effects:c.reconfigure(cmInlineImages(scope,v.hasFocus))});assert.equal(v.state.doc.toString(),doc);assert.equal(v.state.selection.main.head,sel);v.contentDOM.blur();assert.equal(v.dom.querySelectorAll('.st-editor-image').length,1);v.destroy()});
check('composition insertion safely maps replacement decorations',()=>{const[v]=make('before\n![[a.png]]\nafter');v.focus();v.dispatch({changes:{from:0,insert:'汉'},selection:{anchor:1},userEvent:'input.type.compose'});assert.equal(v.dom.querySelectorAll('.st-editor-image').length,1);assert(v.state.doc.toString().startsWith('汉'));v.destroy()});
check('ordinary image-target links preserve prose instead of replacing it',()=>{const doc='[some important text](a.png)';const[v]=make(doc);assert.equal(v.dom.querySelectorAll('.st-editor-image').length,0);assert(v.contentDOM.textContent.includes('some important text'));assert.equal(v.state.doc.toString(),doc);v.destroy()});
check('linked thumbnail uses inner image rather than enclosing destination',()=>{const doc='[![thumb](a.png)](b.png)';const[v]=make(doc);const images=v.dom.querySelectorAll('.st-editor-image img');assert.equal(images.length,1);assert.equal(images[0].alt,'a.png');assert(v.contentDOM.textContent.includes('(b.png)'));assert.equal(v.state.doc.toString(),doc);v.destroy()});
check('markdown reference image and trailing source not destroyed',()=>{const[v]=make('![x][a]\n\n[a]: a.png');assert.equal(v.dom.querySelectorAll('.st-editor-image').length,1);assert(v.state.doc.toString().includes('[a]: a.png'));v.destroy()});
// Only an explicitly armed, collapsed lower-obscured caret may move. Resize
// alone is not a navigation request; actual CM input/IME ownership is covered
// by tests/noteTailCmIntegration.dom.test.mjs in the same workflow lane.
check('caret delta preserves visible and range positions and bounds occlusion reveal',()=>{
 const caret=(top,bottom,endBottom=bottom,collapsed=true)=>({top,bottom,endBottom,collapsed});
 const measuredTailRange=120;
 assert.equal(tailRevealDelta(caret(30,50),0,100,500,measuredTailRange),0);
 assert.equal(tailRevealDelta(caret(90,110),0,100,500,measuredTailRange),22);
 assert.equal(tailRevealDelta(caret(0,20),10,100,500,measuredTailRange),0);
 assert.equal(tailRevealDelta(caret(90,110,400),0,100,500,measuredTailRange),0,'covered middle caret outside measured tail remains stationary');
 assert.equal(tailRevealDelta(caret(90,110,110,false),0,100,500,measuredTailRange),0);
 assert.equal(tailRevealDelta(caret(90,110),0,100,8,measuredTailRange),8);
 assert.equal(tailRevealDelta(caret(90,99),0,100,500,measuredTailRange),0,'visible comfort-margin caret does not initiate reveal');
});
check('active source remains visible after focused image extension reconfigure',()=>{const[v,c]=make('before\n![[a.png]]\nafter');v.focus();v.dispatch({selection:{anchor:10}});assert(v.contentDOM.textContent.includes('![[a.png]]'));v.dispatch({effects:c.reconfigure(cmInlineImages(scope,v.hasFocus))});assert(v.hasFocus);assert(v.contentDOM.textContent.includes('![[a.png]]'),'Active source unexpectedly replaced while editor remains focused');v.destroy()});

// Browser layout is deliberately supplied here; jsdom has no physical IME.
const [caretView]=make('line one\nline two');
caretView.focus();caretView.scrollDOM.getBoundingClientRect=()=>new w.DOMRect(0,0,300,100);
caretView.coordsAtPos=()=>({left:0,right:1,top:90,bottom:110});
caretView.scrollDOM.scrollTop=0;window.dispatchEvent(new w.Event('resize'));
await new Promise(r=>setTimeout(r,70));
check('focused resize alone preserves viewport, source and selection',()=>{assert.equal(caretView.scrollDOM.scrollTop,0);assert.equal(caretView.state.doc.toString(),'line one\nline two');assert.equal(caretView.state.selection.main.head,0)});
caretView.contentDOM.blur();caretView.scrollDOM.scrollTop=0;window.dispatchEvent(new w.Event('resize'));
await new Promise(r=>setTimeout(r,40));
check('blurred viewport resize does not drag reading position',()=>assert.equal(caretView.scrollDOM.scrollTop,0));caretView.destroy();
let captured;const v=new EditorView({state:EditorState.create({doc:'![[a',selection:{anchor:4},extensions:[cmWikiCompletion(async(q,embed)=>{captured={q,embed};return {items:[{id:'a',title:'Image A',target:'a.png'}],partial:false}},()=>true)]}),parent:document.body});
v.focus();await new Promise(r=>setTimeout(r,260));
check('actual attachment autocomplete tooltip and insertion',()=>{assert.deepEqual(captured,{q:'a',embed:true});const button=document.querySelector('.st-wiki-completion button');assert(button,'Actual tooltip button rendered');button.dispatchEvent(new w.MouseEvent('click',{bubbles:true}));assert.equal(v.state.doc.toString(),'![[a.png]]');assert.equal(v.state.selection.main.head,10);assert(v.hasFocus)});v.destroy();
console.log(`${count} passed, ${failures} failed`);if(failures)process.exitCode=1;
} finally {w?.close();fs.rmSync(temp,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1});
