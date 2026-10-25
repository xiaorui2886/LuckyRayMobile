// Synthetic DOM scroll/focus contract. Does not claim Android IME pixel QA.
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
test('one note viewport authority covers editor, title, fallback and ancestor scroll',async t=>{
 const dom=new JSDOM('<section class="st-note-surface"><div class="st-note-paper"><input class="title"><textarea class="st-note-editor"></textarea><div class="cm-scroller"><div contenteditable="true">body</div><button data-table-grip="column">grip</button></div></div></section>',{pretendToBeVisual:true});
 const old=new Map();for(const key of ['window','Element','HTMLElement','requestAnimationFrame','cancelAnimationFrame']){old.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:key.endsWith('AnimationFrame')?dom.window[key].bind(dom.window):dom.window[key]})}
 const dir=mkdtempSync(join(tmpdir(),'lr-note-viewport-')),wait=()=>new Promise(resolve=>setTimeout(resolve,35));
 let lease;
 try{
  const out=join(dir,'entry.cjs');await build({entryPoints:[join(root,'src/presentation/still01/editor/noteViewportStability.ts')],outfile:out,bundle:true,platform:'node',format:'cjs'});
  const {retainNoteViewport,allowNoteViewportNavigation,preserveNoteViewportNavigation}=require(out),doc=dom.window.document,host=doc.querySelector('section'),paper=doc.querySelector('.st-note-paper'),scroller=doc.querySelector('.cm-scroller'),input=doc.querySelector('input'),fallback=doc.querySelector('textarea'),body=scroller.firstElementChild,grip=scroller.querySelector('button');
  const event=(target,type,x=20,y=30)=>target.dispatchEvent(new dom.window.MouseEvent(type,{bubbles:true,clientX:x,clientY:y}));
  const scroll=element=>element.dispatchEvent(new dom.window.Event('scroll'));const reset=()=>{lease?.release();lease=retainNoteViewport(host);paper.scrollTop=80;scroller.scrollTop=180;fallback.scrollTop=25};
  await t.test('late native scroll after pointerup and keyboard resize restores both ancestors',async()=>{
   reset();event(body,'pointerdown');event(body,'pointerup');paper.scrollTop=190;scroller.scrollTop=340;scroll(paper);scroll(scroller);dom.window.dispatchEvent(new dom.window.Event('resize'));await wait();assert.equal(paper.scrollTop,80);assert.equal(scroller.scrollTop,180);
  });
  await t.test('title and textarea focus use the same policy, including local textarea scrolling',async()=>{
   reset();event(input,'pointerdown');input.focus();paper.scrollTop=210;scroll(paper);await wait();assert.equal(paper.scrollTop,80);
   event(fallback,'pointerdown');fallback.focus();fallback.scrollTop=90;paper.scrollTop=230;scroll(fallback);scroll(paper);await wait();assert.equal(fallback.scrollTop,25);assert.equal(paper.scrollTop,80);
  });
  await t.test('drag and wheel cancel queued restoration immediately and keep inertia free',async()=>{
   reset();event(body,'pointerdown');scroller.scrollTop=220;scroll(scroller);event(body,'pointermove',20,80);await wait();assert.equal(scroller.scrollTop,220);scroller.scrollTop=280;scroll(scroller);await wait();assert.equal(scroller.scrollTop,280);
   event(body,'pointerdown');scroller.dispatchEvent(new dom.window.Event('wheel',{bubbles:true}));scroller.scrollTop=330;scroll(scroller);await wait();assert.equal(scroller.scrollTop,330);
  });
  await t.test('table handle drag never becomes document pan',async()=>{
   reset();event(grip,'pointerdown');event(grip,'pointermove',150,30);grip.dispatchEvent(new dom.window.Event('touchmove',{bubbles:true}));scroller.scrollTop=400;scroll(scroller);await wait();assert.equal(scroller.scrollTop,180);
  });
  await t.test('explicit search/navigation cancels old guard; next caret gesture locks new position',async()=>{
   reset();event(body,'pointerdown');allowNoteViewportNavigation(scroller);scroller.scrollTop=500;scroll(scroller);await wait();assert.equal(scroller.scrollTop,500);
   event(body,'pointerdown');scroller.scrollTop=720;scroll(scroller);await wait();assert.equal(scroller.scrollTop,500);
  });
  await t.test('horizontal panel preservation takes current anchor without authorizing document navigation',async()=>{
   reset();event(body,'pointerdown');scroller.scrollTop=260;preserveNoteViewportNavigation(scroller);
   scroller.scrollTop=420;scroll(scroller);await wait();assert.equal(scroller.scrollTop,260);
   body.dispatchEvent(new dom.window.Event('wheel',{bubbles:true}));scroller.scrollTop=520;scroll(scroller);await wait();assert.equal(scroller.scrollTop,520,'subsequent real navigation still releases the lock');
  });
  await t.test('claimed paper touch keeps its anchor through compatibility pointercancel',async()=>{
   reset();const rail=doc.createElement('div');rail.className='st-note-paper-viewport is-dragging';host.before(rail);rail.append(host);
   try {event(body,'pointerdown');preserveNoteViewportNavigation(scroller);event(body,'pointercancel');scroller.scrollTop=440;scroll(scroller);await wait();assert.equal(scroller.scrollTop,180);
    rail.classList.remove('is-dragging');event(body,'pointercancel');scroller.scrollTop=510;scroll(scroller);await wait();assert.equal(scroller.scrollTop,510,'ordinary cancellation still releases');
   } finally {rail.before(host);rail.remove()}
  });
  await t.test('CM and surface lease share one owner; only final release disposes',async()=>{
   reset();const other=retainNoteViewport(host);assert.equal(other.guard,lease.guard);other.release();event(body,'pointerdown');paper.scrollTop=250;scroll(paper);await wait();assert.equal(paper.scrollTop,80);
   lease.release();lease.release();paper.scrollTop=300;scroll(paper);await wait();assert.equal(paper.scrollTop,300);
  });
  await t.test('teardown cancels pending frames without touching a replacement note',async()=>{
   reset();event(body,'pointerdown');paper.scrollTop=200;scroll(paper);lease.release();await wait();assert.equal(paper.scrollTop,200);
  });
 }finally{lease?.release();stop();dom.window.close();rmSync(dir,{recursive:true,force:true});for(const [key,descriptor]of old){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key]}}
});
