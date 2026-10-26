// Real production settings/CSS in Chromium; synthetic fixture, not physical Android.
// node tests/graphSettings/MobileGraphSettings.browser.test.mjs <CDP endpoint> <Vite origin> [evidence dir]
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const endpoint=process.argv[2]||'http://127.0.0.1:9224',origin=process.argv[3]||'http://127.0.0.1:1423',out=process.argv[4];
if(out)await mkdir(out,{recursive:true});
const target=await fetch(endpoint+'/json/new?about:blank',{method:'PUT'}).then(r=>r.json());
const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
let id=0;const pending=new Map(),errors=[],checks=[];
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p?.reject(Error(JSON.stringify(m.error))):p?.resolve(m.result);}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);};
const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const shot=async name=>{if(out){const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));}};
const click=async selector=>{await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();e.click();})()`);await pause(50);};
// Real CDP pointer dispatch (not HTMLElement.click); handlers below are fixture
// handlers, not full LocalNoteImportBridge or native Android integration.
const pointerClick=async selector=>{
  const point=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});await pause(60);
};
const headerHits=()=>evaluate(`(()=>{
  const title=document.querySelector('.mg-settings-actions h2'),close=document.querySelector('[aria-label="关闭图谱设置"]');
  const hits=[];const walker=document.createTreeWalker(title,NodeFilter.SHOW_TEXT);
  for(let text=walker.nextNode();text;text=walker.nextNode())for(let i=0;i<text.length;i++){
    const range=document.createRange();range.setStart(text,i);range.setEnd(text,i+1);const r=range.getBoundingClientRect();
    if(r.width&&r.height){const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);hits.push({text:text.textContent[i],hit:hit?.outerHTML.slice(0,180),ok:title.contains(hit)});}
  }
  const r=close.getBoundingClientRect();return {title:hits.length>0&&hits.every(h=>h.ok),titlePoints:hits,close:close.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};
})()`);
// Whitelisted fixture diagnostics: no document text, storage, cookies or network.
const dockDiagnostic=()=>evaluate(`(()=>{
  const app=document.querySelector('.st-app'),root=document.querySelector('.st-root-stage'),dock=document.querySelector('.st-tab-wrap');
  const snapshot=e=>{const c=getComputedStyle(e),r=e.getBoundingClientRect();return {
    attrs:Object.fromEntries([...e.attributes].filter(a=>['class','style','data-text-entry','data-mode','data-reduced','aria-hidden'].includes(a.name)).map(a=>[a.name,a.value])),
    css:Object.fromEntries(['visibility','display','opacity','pointer-events','transition','position','z-index'].map(k=>[k,c.getPropertyValue(k)])),
    rect:{x:r.x,y:r.y,width:r.width,height:r.height}};};
  const rules=[];const scan=(list,context=[])=>{for(const rule of list){
    if(rule.selectorText){for(const [name,e] of [['app',app],['root',root],['dock',dock]])try{if(e.matches(rule.selectorText))rules.push({target:name,selector:rule.selectorText,css:rule.style.cssText,context});}catch{}}
    else if(rule.cssRules)scan(rule.cssRules,[...context,{condition:rule.conditionText||rule.name||'',active:rule.media?matchMedia(rule.conditionText).matches:null}]);
  }};for(const sheet of document.styleSheets)try{scan(sheet.cssRules);}catch{}
  const a=document.activeElement;return {dataset:{...app.dataset},app:snapshot(app),root:snapshot(root),dock:snapshot(dock),matchingRules:rules,
    viewport:{innerWidth,innerHeight,visualWidth:visualViewport?.width,visualHeight:visualViewport?.height},
    activeElement:a?{tag:a.tagName,className:a.className,ariaLabel:a.getAttribute('aria-label'),type:a.getAttribute('type')}:null};
})()`);
const twoFrames=()=>evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))`);
const metrics=()=>evaluate(`(()=>{const q=s=>document.querySelector(s),rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};const p=q('.mg-settings'),s=q('.mg-settings-scroll');return {bodyWidth:document.body.scrollWidth,stage:rect(q('.mg-stage')),panel:rect(p),header:rect(q('.mg-settings-actions')),scroll:rect(s),scrollHeight:s.scrollHeight,scrollTop:s.scrollTop,last:rect([...q('.mg-settings').querySelectorAll('input[type=range]')].at(-1)),overflow:getComputedStyle(s).overflowY};})()`);
try {
  await send('Runtime.enable');await send('Page.enable');await send('Emulation.setTouchEmulationEnabled',{enabled:true});
  for(const [width,height] of [[320,568],[360,740],[430,932],[740,360]]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true});
    await send('Page.navigate',{url:origin+'/tests/graphSettings/MobileGraphSettings.browser.html'});
    let ready=false;for(let n=0;n<100&&!ready;n++){await pause(50);ready=await evaluate(`!!document.querySelector('[aria-label="打开图谱设置"]')`);}assert.ok(ready);
    await shot(`chrome-light-${width}x${height}`);await click('[aria-label="打开图谱设置"]');await pause(210);
    const initial=await metrics();assert.ok(initial.panel.width<=Math.min(width*.73,300),'compact drawer width');assert.ok(initial.panel.left>=width*.24,'at least a quarter of the graph stays visible beside settings');assert.ok(initial.panel.width>=Math.min(width*.70,298),'settings retain usable control width');assert.ok(initial.panel.left>=0&&initial.panel.right<=width);if(height<=480){assert.ok(initial.panel.top>=0&&initial.panel.bottom<=height,'short drawer stays within viewport');assert.ok(initial.panel.height>=height-144,'short drawer uses viewport above the real dock, not the tiny graph stage');}else{assert.ok(initial.panel.top>=initial.stage.top&&initial.panel.bottom<=initial.stage.bottom);}assert.equal(initial.bodyWidth,width);assert.equal(initial.overflow,'auto');
    const heading=await headerHits();assert.equal(heading.title,true,'every title character paints above source tabs');assert.equal(heading.close,true,'close button receives pointer');
    for(const label of ['颜色组','力度']){await evaluate(`(()=>{const b=[...document.querySelectorAll('.mg-section-title')].find(b=>b.textContent===${JSON.stringify(label)});if(b.getAttribute('aria-expanded')!=='true')b.click();})()`);await pause(30);}
    await evaluate(`document.querySelector('.mg-settings-scroll').scrollTop=100000`);await pause(40);const end=await metrics();assert.equal(end.header.top,initial.header.top,'heading stays fixed while options scroll');assert.ok(end.last.bottom<=end.scroll.bottom+1&&end.last.top>=end.scroll.top,'last force option remains reachable');assert.ok(end.scrollTop>0);
    assert.equal(await evaluate(`(()=>{const e=[...document.querySelectorAll('.mg-settings input[type=range]')].at(-1),r=e.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===e})()`),true,'last slider receives pointer above the real bottom dock');
    assert.equal(await evaluate(`[...document.querySelectorAll('.mg-settings button,.mg-settings input,.mg-settings select')].filter(e=>e.getClientRects().length).every(e=>e.getBoundingClientRect().height>=44)`),true,'every visible settings control has 44px height');
    await evaluate(`document.querySelector('.mg-settings-scroll').scrollTop=0`);await shot(`settings-light-${width}x${height}`);
    await evaluate(`document.querySelector('.st-app').dataset.mode='dark'`);await shot(`settings-dark-${width}x${height}`);
    checks.push({width,height,initial,end,heading});
  }
  // A native-resized short viewport plus hidden dock, without a second IME inset estimate.
  await send('Emulation.setDeviceMetricsOverride',{width:360,height:380,deviceScaleFactor:1,mobile:true});
  await evaluate(`document.querySelector('.st-app').dataset.textEntry='true';document.querySelector('.mg-settings input[type=search]').focus()`);await pause(60);
  // A falsifiable RED control reproduces the old isolated auto-stacking context.
  // The old tab must really intercept title pixels; restoring the production
  // style must fix those exact pixels, not merely rename a PASS artifact.
  await evaluate(`document.querySelector('.mg-stage').style.zIndex='auto'`);
  const redHeader=await headerHits();assert.equal(redHeader.title,false,'RED: old stage stacking must reproduce title occlusion');
  await shot('settings-keyboard-short-red');
  await evaluate(`document.querySelector('.mg-stage').style.removeProperty('z-index')`);
  const greenHeader=await headerHits();assert.equal(greenHeader.title,true,'GREEN: title glyphs cover the old source tab');assert.equal(greenHeader.close,true,'GREEN: close button receives pointer');
  checks.push({shortHeaderRed:redHeader,shortHeaderGreen:greenHeader});
  const ime=await metrics();assert.ok(ime.panel.height>180);assert.equal(await evaluate(`getComputedStyle(document.querySelector('.mg-view')).paddingBottom`),'16px');
  await evaluate(`document.querySelector('.mg-settings-scroll').scrollTop=100000`);await pause(40);const imeEnd=await metrics();assert.ok(imeEnd.last.bottom<=imeEnd.scroll.bottom+1&&imeEnd.last.top>=imeEnd.scroll.top);await shot('settings-keyboard-short');checks.push({keyboardViewport:ime,lastReachable:imeEnd});
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.mg-settings')).animationName`),'none');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.mg-switch'),'::after').transitionDuration`),'0s');
  await pointerClick('[aria-label="关闭图谱设置"]');assert.equal(await evaluate(`!!document.querySelector('.mg-settings')`),false,'CDP pointer invokes real settings close handler');assert.equal(await evaluate(`document.activeElement.getAttribute('aria-label')`),'打开图谱设置');
  // Programmatic focus uses keyboard-visible focus; source keeps its rounded inset ring.
  const source=await evaluate(`(()=>{const e=document.querySelector('.mg-source-row select');e.focus();const s=getComputedStyle(e);return {radius:s.borderRadius,outline:s.outlineStyle,shadow:s.boxShadow,height:e.getBoundingClientRect().height};})()`);assert.equal(source.radius,'13px');assert.equal(source.outline,'none');assert.ok(source.height>=44);
  await send('Emulation.setEmulatedMedia',{features:[]});await evaluate(`document.querySelector('.st-app').dataset.reduced='true'`);await click('[aria-label="打开图谱设置"]');assert.equal(await evaluate(`getComputedStyle(document.querySelector('.mg-settings')).animationName`),'none');
  // Synthetic inbox-layout fixture, not full LocalNoteImportBridge. Explicitly
  // cover normal dock and IME separately; do not leak prior text-entry state.
  await click('[aria-label="关闭图谱设置"]');
  await evaluate(`window.dispatchEvent(new Event('fixture-show-inbox'))`);await pause(60);
  for (const textEntry of [false,true]) for (const width of [320,360,430]) {
    const stateBefore=await dockDiagnostic();
    await evaluate(`document.querySelector('.st-app').dataset.textEntry=${JSON.stringify(String(textEntry))}`);
    await send('Emulation.setDeviceMetricsOverride',{width,height:740,deviceScaleFactor:1,mobile:true});
    const immediatelyAfter=await dockDiagnostic();
    await twoFrames();
    const samples=[];let settled=false;
    // Bounded observation only: never force CSS or rewrite a mismatched state.
    for(let attempt=0;attempt<30;attempt++){
      const d=await dockDiagnostic();samples.push({attempt,dataset:d.dataset,viewport:d.viewport,dock:d.dock,activeElement:d.activeElement});
      if(d.dataset.textEntry===String(textEntry)&&d.viewport.innerWidth===width&&d.viewport.innerHeight===740&&d.dock.css.visibility===(textEntry?'hidden':'visible')){settled=true;break;}
      await pause(50);
    }
    const stateAfter=await dockDiagnostic();
    const stateEvidence={requested:{textEntry,width,height:740},stateBefore,immediatelyAfter,settled,samples,stateAfter};
    const caseName='import-inbox-'+(textEntry?'ime-':'dock-')+width;
    if(out)await writeFile(path.join(out,caseName+'-state.json'),JSON.stringify(stateEvidence,null,2));
    await shot(caseName+'-before-assert');
    assert.equal(stateAfter.dataset.textEntry,String(textEntry),'requested text-entry state reached DOM');
    assert.equal(settled,true,'requested viewport and actual dock state settle within bounded observation');
    checks.push({inboxState:stateEvidence});
    const inbox=await evaluate(`(()=>{
      const app=document.querySelector('.st-app');
      const entry=app.querySelector('.st-import-inbox-trigger'),card=app.querySelector('.mg-selection');
      const rect=e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height};};
      const source=app.querySelector('.mg-source-row select'),action=card.querySelector('button');
      const hit=e=>{const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));};
      const dock=app.querySelector('.st-tab-wrap');return {entry:rect(entry),source:rect(source),action:rect(action),sourceHit:hit(source),actionHit:hit(action),dock:rect(dock),dockVisibility:getComputedStyle(dock).visibility,width:document.body.scrollWidth};
    })()`);
    assert.ok(inbox.entry.bottom<=inbox.source.top,'inbox never covers vault selection');
    assert.equal(inbox.sourceHit,true,'source receives its own pointer');
    assert.equal(inbox.actionHit,true,'node action receives its own pointer');
    assert.equal(inbox.width,width,'inbox does not create horizontal overflow');
    assert.equal(inbox.dockVisibility,textEntry?'hidden':'visible','explicit dock/IME fixture state');
    if(!textEntry)assert.ok(inbox.action.bottom<=inbox.dock.top,'node action stays above visible dock');
    const before=await evaluate(`({...document.querySelector('.st-app').dataset})`);
    await pointerClick('.st-import-inbox-trigger');await pointerClick('.mg-selection button');
    const after=await evaluate(`({...document.querySelector('.st-app').dataset})`);
    assert.equal(+after.inboxClicks,+before.inboxClicks+1,'CDP inbox pointer invokes synthetic handler');
    assert.equal(+after.noteClicks,+before.noteClicks+1,'CDP note pointer invokes synthetic handler');
    checks.push({inboxWidth:width,textEntry,inbox,handlerClicks:{before,after}});await shot('import-inbox-'+(textEntry?'ime-':'dock-')+width);
  }
  assert.deepEqual(errors,[]);const result={status:'PASS',kind:'local-Chromium-synthetic-settings-not-device',checks,source,errors};if(out)await writeFile(path.join(out,'settings-browser-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
} finally {ws.close();try{await fetch(endpoint+'/json/close/'+target.id);}catch{}}
