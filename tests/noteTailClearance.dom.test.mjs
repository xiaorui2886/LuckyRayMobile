// Real DOM event/scroll ownership + deterministic geometry, not Android IME pixels.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url)),require=createRequire(import.meta.url);
const tools=process.env.LR_DOM_TEST_TOOLS?createRequire(join(resolve(process.env.LR_DOM_TEST_TOOLS),'__harness__.cjs')):require;
const {JSDOM}=tools('jsdom'),{build,stop}=createRequire(require.resolve('vite/package.json'))('esbuild');
test('caret reveal retains the single viewport owner and end-only space',async t=>{
 const dom=new JSDOM('<div data-current="true"><section class="st-note-surface"><main class="st-note-paper"><input class="title"><div class="cm-scroller"><div class="cm-content" contenteditable="true">last line</div></div></main><div class="st-reader-bottom"></div></section></div>',{pretendToBeVisual:true});
 const keys=['window','Element','HTMLElement','MutationObserver','requestAnimationFrame','cancelAnimationFrame'],old=new Map();for(const key of keys){old.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:key.endsWith('AnimationFrame')?dom.window[key].bind(dom.window):dom.window[key]})}
 const dir=mkdtempSync(join(tmpdir(),'lr-tail-')),wait=(ms=390)=>new Promise(r=>setTimeout(r,ms));let lease,remove;
 try{
  const out=join(dir,'entry.cjs');await build({stdin:{contents:"export * from './src/presentation/still01/editor/noteViewportStability';export * from './src/presentation/still01/editor/noteTailClearance';",resolveDir:root},outfile:out,bundle:true,platform:'node',format:'cjs'});
  const {retainNoteViewport,noteTailSpace,tailRevealDelta}=require(out),doc=dom.window.document,host=doc.querySelector('section'),scroller=doc.querySelector('.cm-scroller'),body=doc.querySelector('.cm-content'),bar=doc.querySelector('.st-reader-bottom');
  Object.defineProperty(dom.window,'innerHeight',{value:800,configurable:true});
  let visible=800,endDistance=20,collapsed=true,caretBottom=480,reduced=false;
  const bounds=(top,bottom)=>({top,bottom,height:bottom-top,left:0,right:400,width:400});host.getBoundingClientRect=()=>bounds(0,visible);bar.getBoundingClientRect=()=>bounds(visible-60,visible);scroller.getBoundingClientRect=()=>bounds(0,visible);
  Object.defineProperties(scroller,{scrollHeight:{get:()=>1800},clientHeight:{get:()=>visible}});
  dom.window.matchMedia=()=>({get matches(){return reduced},addEventListener(){},removeEventListener(){}});
  const event=(target,type,x=20,y=30)=>target.dispatchEvent(new dom.window.MouseEvent(type,{bubbles:true,clientX:x,clientY:y}));
  const reset=()=>{remove?.();lease?.release();host.dataset.viewportBlocked='false';host.dataset.chromeHidden='false';host.parentElement.dataset.current='true';visible=800;collapsed=true;endDistance=20;caretBottom=480;reduced=false;scroller.scrollTop=300;lease=retainNoteViewport(host);remove=lease.guard.setTailProvider(()=>({scroller,top:caretBottom-20-(scroller.scrollTop-300),bottom:caretBottom-(scroller.scrollTop-300),endBottom:caretBottom+endDistance-(scroller.scrollTop-300),collapsed}));};
  const tap=()=>{event(body,'pointerdown');event(body,'pointerup')};const shrink=()=>{visible=500;dom.window.dispatchEvent(new dom.window.Event('resize'))};
  await t.test('bounded fallback and actual keyboard + actual toolbar, without device constants',()=>{
   assert.equal(noteTailSpace(800,800,60),364);assert.equal(noteTailSpace(800,500,60),360);assert.equal(noteTailSpace(800,800,60,300),360);assert.equal(noteTailSpace(800,100,60),520);
   const caret={top:460,bottom:480,endBottom:500,collapsed:true};assert.equal(tailRevealDelta(caret,0,440,1000,360),52);assert.equal(tailRevealDelta({...caret,endBottom:1400},0,440,1000,360),0);assert.equal(tailRevealDelta({...caret,collapsed:false},0,440,1000,360),0);assert.equal(tailRevealDelta(caret,0,600,1000,360),0);assert.equal(tailRevealDelta(caret,0,440,20,360),20);
  });

  await t.test('initial already-short viewport uses a bounded fallback; width change resets stale keyboard memory',()=>{
   reset();lease.release();visible=500;lease=retainNoteViewport(host);assert.equal(host.style.getPropertyValue('--note-tail-clearance'),'250px');
   Object.defineProperty(dom.window,'innerWidth',{value:600,configurable:true});visible=400;dom.window.dispatchEvent(new dom.window.Event('resize'));assert.equal(host.style.getPropertyValue('--note-tail-clearance'),'212px');
  });
  await t.test('tail tap moves minimal amount with buffered frames, no resize bounce',async()=>{
   reset();tap();shrink();await wait(150);assert.ok(scroller.scrollTop>300&&scroller.scrollTop<352);await wait(260);assert.equal(scroller.scrollTop,352);assert.equal(host.style.getPropertyValue('--note-tail-clearance'),'360px');visible=460;dom.window.dispatchEvent(new dom.window.Event('resize'));await wait();assert.equal(scroller.scrollTop,352);
  });
  await t.test('selection range, visible caret, and resize without explicit input remain stable',async()=>{
   for(const kind of ['selection','visible','resize']){reset();if(kind==='middle')endDistance=900;if(kind==='selection')collapsed=false;if(kind==='visible')caretBottom=300;if(kind!=='resize')tap();shrink();await wait();assert.equal(scroller.scrollTop,300,kind)}
  });
  await t.test('covered caret moves only inside the measured keyboard plus toolbar tail range',async()=>{
   for(const distance of [220,360,361,900,19000]){reset();endDistance=distance;tap();shrink();await wait();assert.equal(scroller.scrollTop,distance<=360?352:300,`remaining rendered document=${distance}`)}
  });
  await t.test('small and tall keyboards use current measured loss, not 140px or viewport percentages',async()=>{
   for(const [height,distance,expected] of [[600,260,452],[600,261,300],[400,450,652],[400,461,300]]){reset();caretBottom=680;endDistance=distance;tap();visible=height;dom.window.dispatchEvent(new dom.window.Event('resize'));await wait();assert.ok(Math.abs(scroller.scrollTop-expected)<1e-6,`${height}/${distance}: ${scroller.scrollTop} vs ${expected}`)}
  });
  await t.test('visible caret inside the safety gap is not actually occluded',async()=>{
   reset();caretBottom=435;tap();shrink();await wait();assert.equal(scroller.scrollTop,300);
  });
  await t.test('keyboard close during pending intent cannot reuse remembered IME range',async()=>{
   reset();endDistance=200;caretBottom=790;shrink();tap();visible=800;dom.window.dispatchEvent(new dom.window.Event('resize'));await wait();assert.equal(scroller.scrollTop,300);
  });
  await t.test('candidate-bar resize changes current range without an independent reveal',async()=>{
   reset();endDistance=380;tap();shrink();await wait();assert.equal(scroller.scrollTop,300);visible=460;dom.window.dispatchEvent(new dom.window.Event('resize'));await wait();assert.equal(scroller.scrollTop,392);visible=440;dom.window.dispatchEvent(new dom.window.Event('resize'));await wait();assert.equal(scroller.scrollTop,392);
  });
  await t.test('visual viewport offset does not double count hidden toolbar or extend tail eligibility',async()=>{
   const visual=new dom.window.EventTarget();visual.height=800;visual.offsetTop=0;Object.defineProperty(dom.window,'visualViewport',{configurable:true,value:visual});
   try {reset();caretBottom=600;endDistance=301;tap();visual.height=500;visual.offsetTop=30;visual.dispatchEvent(new dom.window.Event('resize'));await wait();assert.equal(scroller.scrollTop,300);endDistance=300;tap();await wait();assert.ok(Math.abs(scroller.scrollTop-382)<1e-6);}
   finally {remove?.();lease?.release();delete dom.window.visualViewport;}
  });
  await t.test('already-open keyboard and reopen use current geometry without a second inset',async()=>{
   reset();shrink();tap();await wait();assert.equal(scroller.scrollTop,352);
   visible=800;dom.window.dispatchEvent(new dom.window.Event('resize'));await wait();assert.equal(scroller.scrollTop,352,'closing keyboard does not jump back');
   caretBottom=560;shrink();tap();await wait();assert.equal(scroller.scrollTop,432,'reopen reveals just remaining 80px');
  });
  await t.test('continuing IME resize retargets the current smooth reveal, not an obsolete bottom',async()=>{
   reset();tap();shrink();await wait(150);visible=460;dom.window.dispatchEvent(new dom.window.Event('resize'));await wait(260);assert.equal(scroller.scrollTop,392);
  });
  await t.test('visualViewport-only IME clips the layout viewport once, without subtracting its loss again',async()=>{
   const visual=new dom.window.EventTarget();visual.height=800;visual.offsetTop=0;
   Object.defineProperty(dom.window,'visualViewport',{configurable:true,value:visual});
   try {reset();caretBottom=580;tap();visual.height=500;visual.dispatchEvent(new dom.window.Event('resize'));await wait();assert.equal(scroller.scrollTop,392);}
   finally {remove?.();lease?.release();delete dom.window.visualViewport;}
  });
  await t.test('hidden toolbar does not create a phantom occlusion or double keyboard inset',async()=>{
   reset();host.dataset.chromeHidden='true';shrink();tap();await wait();assert.equal(scroller.scrollTop,300,'480px caret fits the 500px visible area without hidden toolbar');assert.equal(host.style.getPropertyValue('--note-tail-clearance'),'360px','hide does not shrink tail and clamp the scroll anchor');
  });
  await t.test('drag, wheel, touch movement, pointer cancellation abort pending reveal',async()=>{
   for(const type of ['drag','wheel','touchmove','pointercancel']){reset();event(body,'pointerdown');if(type==='drag')event(body,'pointermove',20,100);else if(type==='pointercancel')event(body,type);else body.dispatchEvent(new dom.window.Event(type,{bubbles:true}));event(body,'pointerup');shrink();await wait();assert.equal(scroller.scrollTop,300,type)}
  });
  await t.test('manual scroll cancels an in-flight animation instead of fighting the user',async()=>{
   reset();tap();shrink();await wait(150);scroller.scrollTop=450;scroller.dispatchEvent(new dom.window.Event('scroll'));await wait();assert.equal(scroller.scrollTop,450);
  });
  await t.test('side menu, inactive page and replacement provider cancel in-flight work',async()=>{
   for(const kind of ['blocked','inactive','replacement']){reset();tap();shrink();await wait(150);if(kind==='blocked')host.dataset.viewportBlocked='true';if(kind==='inactive')host.parentElement.dataset.current='false';if(kind==='replacement'){remove();remove=lease.guard.setTailProvider(()=>null)}await wait(20);const top=scroller.scrollTop;await wait();assert.equal(scroller.scrollTop,top,kind)}
  });
  await t.test('title/toolbar taps and programmatic focus never authorize a reveal',async()=>{
   for(const target of [doc.querySelector('input'),bar]){reset();event(target,'pointerdown');event(target,'pointerup');target.focus();shrink();await wait();assert.equal(scroller.scrollTop,300)}
  });
  await t.test('reduced motion makes one minimal adjustment; composition input is never rewritten',async()=>{
   reset();reduced=true;shrink();body.dispatchEvent(new dom.window.CompositionEvent('compositionstart',{bubbles:true,data:'中文'}));body.textContent='last line中文';body.dispatchEvent(new dom.window.InputEvent('input',{bubbles:true,data:'中文',isComposing:true}));await wait(150);assert.equal(scroller.scrollTop,352);assert.equal(body.textContent,'last line中文');body.dispatchEvent(new dom.window.CompositionEvent('compositionend',{bubbles:true,data:'中文'}));assert.equal(body.textContent,'last line中文');
  });
  await t.test('teardown stops animation and removes measured clearance',async()=>{
   reset();tap();shrink();await wait(150);lease.release();const top=scroller.scrollTop;await wait();assert.equal(scroller.scrollTop,top);assert.equal(host.style.getPropertyValue('--note-tail-clearance'),'');
  });

  await t.test('orientation cancels stale animation and combined production CSS keeps one measured tail',async()=>{
   reset();tap();shrink();await wait(150);Object.defineProperty(dom.window,'innerWidth',{value:1000,configurable:true});dom.window.dispatchEvent(new dom.window.Event('resize'));const top=scroller.scrollTop;await wait();assert.equal(scroller.scrollTop,top);
   const sandbox=new JSDOM('<div class="st-app"><section class="st-note-surface"><main class="st-note-paper"><div class="st-note-prose"></div><div class="st-note-editor is-cm"><div class="cm-content"></div></div></main></section></div>');
   for(const path of ['src/presentation/still01/editor/noteTypography.css','src/presentation/still01/editor/cmLivePreview.css','src/still/kit/noteExperience.css']){const style=sandbox.window.document.createElement('style');style.textContent=readFileSync(join(root,path),'utf8');sandbox.window.document.head.append(style)}
   for(const selector of ['.cm-content','.st-note-paper'])assert.match(sandbox.window.getComputedStyle(sandbox.window.document.querySelector(selector)).paddingBottom,/^var\(--note-tail-clearance/);
   assert.notEqual(sandbox.window.getComputedStyle(sandbox.window.document.querySelector('.st-note-prose')).paddingBottom,'var(--note-tail-clearance,38vh)');sandbox.window.close();
  });
  await t.test('tail CSS affects only document ends and preserves the actual final blank line',()=>{
   const css=readFileSync(join(root,'src/still/kit/noteExperience.css'),'utf8');assert.match(css,/\.st-app \.st-note-surface>\.st-note-paper\{padding-bottom:var\(--note-tail-clearance/);assert.match(css,/\.st-app \.st-note-editor\.is-cm \.cm-content\{padding-bottom:var\(--note-tail-clearance/);assert.match(css,/textarea\.st-note-editor\{padding-bottom:var\(--note-tail-clearance/);
   assert.doesNotMatch(readFileSync(join(root,'src/presentation/still01/editor/noteTypography.css'),'utf8'),/padding-bottom:var\(--note-tail-clearance/,'reader space is not added twice');
   const cm=readFileSync(join(root,'src/presentation/still01/editor/cmCaretVisibility.ts'),'utf8');assert.match(cm,/lineBlockAt\(view.state.doc.length\)/);assert.match(cm,/nativeTextareaCaretRect\(native\)/);assert.doesNotMatch(cm,/changes:|insert:/);
  });
 }finally{remove?.();lease?.release();stop();dom.window.close();rmSync(dir,{recursive:true,force:true});for(const [key,d]of old){if(d)Object.defineProperty(globalThis,key,d);else delete globalThis[key]}}
});
