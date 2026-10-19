// Opt-in actual React/CM6 UI regression. Native IPC uses the existing S1
// synthetic fixture; this is NOT Rust/Android, process-kill or device evidence.
// Build: node scripts/qa/buildReplicaS1Qa.mjs output/playwright/knowledge-continuity/production
// Run: LUCKYRAY_QA_PLAYWRIGHT=<playwright module> LUCKYRAY_QA_BROWSER=<browser executable> node --test scripts/qa/knowledgeNavigationRepair.test.mjs
import { isolateFixtureHistory } from "./navigationHistoryIsolation.mjs";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
const { chromium } = createRequire(import.meta.url)(process.env.LUCKYRAY_QA_PLAYWRIGHT || "playwright");
const built = resolve(process.env.LUCKYRAY_QA_BUNDLE || "output/playwright/knowledge-continuity/production");
const out = resolve(process.env.LUCKYRAY_QA_OUT || "output/playwright/knowledge-navigation-repair/behavior");
const motionMode = process.env.LUCKYRAY_QA_REDUCED || "on";
assert.ok(["on", "off"].includes(motionMode), "LUCKYRAY_QA_REDUCED must be on or off");
const historyIsolated = process.env.LUCKYRAY_QA_HISTORY_ISOLATE === "1";
const reducedMotion = motionMode === "on";
const report = { historyMode:historyIsolated?"single-document-QA-host-NOT-native-edge-Back":"browser-default",
  scriptSha256:createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex"),
  nativeEdgeBack:"NOT_RUN", runId: process.env.LUCKYRAY_QA_RUN_ID || out, startedAt:new Date().toISOString(), out, kind: "production-React-CM6-with-synthetic-native-IPC-NOT-device-UAT", reducedMotion, cases: [], errors: [] };
const active = '.st-detail-stage[data-current="true"]';
let browser, server, url;
mkdirSync(out, { recursive: true });
before(async () => {
  const assets = new Map([
    ["/bundle.js", [resolve(built, "bundle.js"), "text/javascript"]],
    ["/style.css", [resolve(built, "luckyray-mobile.css"), "text/css"]],
    ["/base.css", [resolve(dirname(built), "production-base.css"), "text/css"]],
  ]);
  server = createServer((req, res) => {
    const asset = assets.get(new URL(req.url, "http://localhost").pathname);
    if (asset) { res.setHeader("Content-Type", asset[1]); res.end(readFileSync(asset[0])); return; }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/base.css"><link rel="stylesheet" href="/style.css"><div id="root"></div><script>window.__replicaQa={online:true,confirmed:true,navigationRepair:true,reducedMotion:${reducedMotion}};</script><script src="/bundle.js"></script>`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.LUCKYRAY_QA_BROWSER });
  report.browserVersion = browser.version();
});
after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
  report.finishedAt=new Date().toISOString();
  writeFileSync(resolve(out, "report.json"), JSON.stringify(report, null, 2));
});
async function saveScreenshot(page,record,filename) {
  const path=resolve(out,filename), bytes=await page.screenshot({path});
  record.screenshot={path,sha256:createHash('sha256').update(bytes).digest('hex')};
}
async function run(name, callback) {
  const context = await browser.newContext({ viewport: { width: 360, height: 800 }, hasTouch: true, reducedMotion: reducedMotion ? "reduce" : "no-preference" });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  const record = { name, startedAt:new Date().toISOString(), outcome: "RUNNING", evidence: {}, console: [], lifecycle: [] }; report.cases.push(record);
  await page.exposeFunction('__navigationGateEvent', event => record.lifecycle.push(event));
  await page.addInitScript(() => {
    for (const type of ['pageshow', 'pagehide', 'popstate', 'hashchange']) {
      window.addEventListener(type, event => window.__navigationGateEvent({
        type, url: location.href, historyLength: history.length, persisted: event.persisted,
      }));
    }
  });
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) record.lifecycle.push({type:'main-frame',url:frame.url()}); });
  page.on('crash', () => record.lifecycle.push({type:'crash'}));
  page.on("pageerror", error => report.errors.push(String(error)));
  page.on("console", message => { if (["warning", "error"].includes(message.type())) record.console.push({ type: message.type(), text: message.text() }); });
  try {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.locator(".st-note-row").first().waitFor();
    record.evidence.mode = await page.evaluate(() => ({ appReduced: document.querySelector(".st-app")?.getAttribute("data-reduced") === "true",
      mediaReduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
      traceEnabled: typeof window.__replicaQa?.startCmSearchTrace === "function", coordinateProbeEnabled: window.__cmScrollCoordinateEvidence !== undefined }));
    assert.deepEqual(record.evidence.mode, { appReduced: reducedMotion, mediaReduced: reducedMotion, traceEnabled: false, coordinateProbeEnabled: false });
    await callback(page, record.evidence);
    assert.equal(await page.evaluate(() => window.__cmScrollCoordinateEvidence !== undefined), false, "formal gate must not load the coordinate probe");
    assert.deepEqual(report.errors, []);
    await saveScreenshot(page,record,name+".png");
    record.outcome = "PASS";
  } catch (error) {
    record.outcome = String(error).includes("HISTORY_ISOLATION_BLOCKED:") ? "BLOCKED" : "FAIL"; record.error = String(error);
    record.evidence.failure = await page.evaluate(() => ({url:location.href,historyLength:history.length,
      route:window.__replicaQa?.currentRoute?.(),rootPresent:!!document.querySelector('.st-app'),
      source:document.querySelector('.st-source button[aria-pressed="true"]')?.textContent,
      currentLayers:document.querySelectorAll('.st-detail-stage[data-current="true"]').length,
      toolbarCount:document.querySelectorAll('.st-editor-tools').length,
      focused:document.activeElement?.outerHTML?.slice(0,500),
      calls:window.__replicaQa?.calls?.slice(-30),text:document.body.innerText.slice(0,2000),
    })).catch(error => ({url:page.url(),diagnosticError:String(error)}));
    await saveScreenshot(page,record,name+"-failure.png").catch(error=>{record.screenshotError=String(error)});
    throw error;
  } finally { record.finishedAt=new Date().toISOString(); await context.close(); }
}
const cm = active + " .cm-content";
const writes = page => page.evaluate(() => window.__replicaQa.calls.filter(c => c.cmd === "content_note_edit" || c.cmd === "local_note_update"));
async function openRead(page, source, empty = false) {
  await page.evaluate(({source, empty}) => {
    const n = source === "local" ? window.__replicaQa.localRecords[0] : window.__replicaQa.records[0];
    n.title = "新笔记";
    if (empty) { n.content = ""; if (n.cachedDocument) n.cachedDocument.content = ""; if (n.serverDocument) n.serverDocument.content = ""; }
    if (source === "local") window.__replicaQa.openLocal(n.noteId); else window.__replicaQa.openRead(n.noteId);
  }, {source, empty});
  await page.locator(active + " .st-note-prose").waitFor();
}
async function quietOpen(page) {
  return page.locator(active + " .st-note-paper").evaluate(paper => {
    const title = paper.querySelector('.st-note-title'), body = paper.querySelector('.st-note-prose,.st-note-editor');
    const clip = paper.getBoundingClientRect(), t = title.getBoundingClientRect(), b = body.getBoundingClientRect();
    return {focusedInput: paper.contains(document.activeElement) && document.activeElement.matches('input,textarea,[contenteditable="true"]'),
      titleVisible: t.top >= clip.top && t.bottom <= clip.bottom, bodyStartVisible: b.top >= clip.top && b.top < clip.bottom,
      paperScrollTop: paper.scrollTop};
  });
}

const cards = '.st-root-stage .st-note-row';
async function rootCards(page) { return page.locator(cards).count(); }
async function selectDesktopFolders(page, evidence) {
  // Each case has a fresh browser context. The production default is Local;
  // a visible local row is not readiness for the Desktop folder inventory.
  const source = page.getByRole('group', {name:'内容来源',exact:true});
  await source.getByRole('button', {name:'电脑',exact:true}).tap();
  await page.locator('.st-source button[aria-pressed="true"]').filter({hasText:'电脑'}).waitFor();
  await page.locator('.st-folder-row').filter({hasText:'attachments'}).waitFor();
  await page.locator('.st-folder-row').filter({hasText:'资料'}).waitFor();
  await page.locator(cards).first().waitFor();
  evidence.desktopSetup = await page.evaluate(() => ({
    selected:document.querySelector('.st-source button[aria-pressed="true"]')?.textContent,
    directories:window.__replicaQa.calls.filter(c=>c.args?.request?.operationId==='knowledge.directories').map(c=>c.args.request),
    folders:[...document.querySelectorAll('.st-folder-row')].map(el=>el.textContent),
  }));
  assert.equal(evidence.desktopSetup.selected,'电脑');
  assert.ok(evidence.desktopSetup.directories.length>0,'the desktop directory service was actually read');
}
async function folder(page,name) { await page.locator('.st-folder-row').filter({hasText:name}).first().tap(); }
async function goRoot(page) { await page.locator('.st-folder-breadcrumbs').getByRole('button',{name:'全部',exact:true}).tap(); }
test('N1 actual React root → empty → root → populated → nested empty → back',async()=>{
 await run('N1-folder-rerender',async(page,evidence)=>{
   await selectDesktopFolders(page,evidence);
   const count=await rootCards(page);assert.ok(count>0);
   await folder(page,'attachments');await page.getByText('暂无笔记',{exact:true}).waitFor();assert.equal(await rootCards(page),0);
   assert.equal(await page.getByText('此目录及子目录的笔记',{exact:true}).count(),0);
   await goRoot(page);await page.waitForFunction(()=>document.querySelectorAll('.st-note-row').length>0);
   assert.equal(await rootCards(page),count);
   await folder(page,'资料');await page.waitForFunction(()=>document.querySelectorAll('.st-note-row').length>0);
   await folder(page,'empty');await page.getByText('暂无笔记',{exact:true}).waitFor();assert.equal(await rootCards(page),0);
   await page.getByRole('button',{name:'返回上级目录',exact:true}).tap();await page.waitForFunction(()=>document.querySelectorAll('.st-note-row').length>0);
   evidence.rootCount=count;evidence.finalCount=await rootCards(page);
   evidence.spacing=await page.locator('.st-folder-row').first().evaluate(row=>{const icon=row.querySelector('svg').getBoundingClientRect(),label=row.querySelector('span').getBoundingClientRect();return label.left-icon.right});
   assert.ok(evidence.spacing>=12,'WebView83-compatible icon margin');
 });
});
test('N2 late folder response never replaces newer root or folder',async()=>{
 await run('N2-late-folder',async(page,evidence)=>{
   await selectDesktopFolders(page,evidence);
   await page.evaluate(()=>window.__replicaQa.deferDirectory='资料');await folder(page,'资料');
   await page.waitForFunction(()=>typeof window.__replicaQa.releaseDirectory==='function');await goRoot(page);await folder(page,'attachments');
   await page.getByText('暂无笔记',{exact:true}).waitFor();await page.evaluate(()=>window.__replicaQa.releaseDirectory());
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   assert.equal(await rootCards(page),0);assert.equal(await page.locator('.st-folder-breadcrumbs [aria-current]').innerText(),'attachments');evidence.finalFolder='attachments';
 });
});
for(const width of [360,392])test(`N3 ${width}: closed compact nav, keyboard strip, selection/history and viewport geometry`,async()=>{
 await run(`N3-toolbar-${width}`,async(page,evidence)=>{
   if(historyIsolated){
     const setupCdp=await page.context().newCDPSession(page);
     evidence.historyIsolation={};
     try{await isolateFixtureHistory(setupCdp,url,evidence.historyIsolation)}finally{await setupCdp.detach()}
   }
   await page.setViewportSize({width,height:800});await openRead(page,'desktop',true);
   evidence.open=await quietOpen(page);assert.equal(evidence.open.focusedInput,false);
   await page.locator(active).getByRole('button',{name:'双链',exact:true}).waitFor();
   await page.locator(active+' .st-note-prose').tap();await page.locator(cm).waitFor();
   await page.setViewportSize({width,height:420});
   await page.locator(active+' .st-editor-tools').waitFor({state:'visible'});
   await page.keyboard.insertText('hello');
   await page.locator(cm).evaluate(el=>{const h=el.closest('.st-note-editor').__cmHandle;h.setSelection({start:0,end:5})});
   await page.locator(active).getByRole('button',{name:'加粗',exact:true}).tap();
   assert.equal(await page.locator(cm).innerText(),'**hello**');
   await page.locator(active).getByRole('button',{name:'撤销',exact:true}).tap();assert.equal(await page.locator(cm).innerText(),'hello');
   await page.locator(active).getByRole('button',{name:'重做',exact:true}).tap();assert.equal(await page.locator(cm).innerText(),'**hello**');
   evidence.geometry=await page.locator(active).evaluate(root=>{const bar=root.querySelector('.st-editor-tools'),r=bar.getBoundingClientRect(),paper=root.querySelector('.st-note-paper').getBoundingClientRect(),content=root.querySelector('.cm-content');return{bottom:r.bottom,height:r.height,viewport:innerHeight,paperBottom:paper.bottom,barTop:r.top,overflow:bar.scrollWidth>bar.clientWidth,focused:content===document.activeElement}});
   assert.ok(evidence.geometry.bottom<=evidence.geometry.viewport);assert.ok(evidence.geometry.viewport-evidence.geometry.bottom<=10,'resized viewport bar gap is at most intended padding, NOT native IME proof');assert.ok(evidence.geometry.paperBottom<=evidence.geometry.barTop);assert.ok(evidence.geometry.overflow);assert.equal(evidence.geometry.focused,true);
   // Real Chromium touch pan, not scrollLeft assignment or dispatched DOM events.
   const before=await page.locator(cm).innerText();
   const gestureBaseline=await page.evaluate(()=>({url:location.href,route:window.__replicaQa.currentRoute(),
     historyLength:history.length,selection:document.querySelector('.st-detail-stage[data-current="true"] .st-note-editor').__cmHandle.getSelection()}));
   evidence.gestures=[];
   const cdp=await page.context().newCDPSession(page);
   async function swipe(direction) {
     const rect=await page.locator(active+' .st-editor-tools').boundingBox();
     const left=rect.x+25,right=rect.x+rect.width-25,y=rect.y+rect.height/2;
     const from=direction==='left'?right:left,to=direction==='left'?left:right;
     await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:from,y}]});
     for(let step=1;step<=12;step++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:from+(to-from)*step/12,y}]});await page.waitForTimeout(16)}
     await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(150);
     const state=await page.evaluate(()=>{
       const root=document.querySelector('.st-detail-stage[data-current="true"]'),bar=root?.querySelector('.st-editor-tools');
       const handle=root?.querySelector('.st-note-editor')?.__cmHandle;
       return {url:location.href,route:window.__replicaQa?.currentRoute?.(),historyLength:history.length,
         rootPresent:!!document.querySelector('.st-app'),toolbarPresent:!!bar,
         scrollLeft:bar?.scrollLeft,overflowBoundary:bar?getComputedStyle(bar).overscrollBehaviorX:null,
         doc:handle?.getValue(),selection:handle?.getSelection()};
     });
     evidence.gestures.push({direction,...state});
     assert.equal(state.url,gestureBaseline.url,'toolbar swipe must not navigate browser history');
     assert.deepEqual(state.route,gestureBaseline.route,'toolbar swipe must not leave the current note');
     assert.equal(state.historyLength,gestureBaseline.historyLength);
     assert.equal(state.toolbarPresent,true);assert.equal(state.doc,before,'every swipe executes zero commands');
     assert.deepEqual(state.selection,gestureBaseline.selection,'every swipe preserves selection');
   }
   for(let i=0;i<4;i++)await swipe('left');
   evidence.touchPan=await page.locator(active+' .st-editor-tools').evaluate(bar=>{
     const r=bar.getBoundingClientRect(),button=bar.querySelector('[aria-label="减少缩进"]').getBoundingClientRect();
     return{scrollLeft:bar.scrollLeft,farButtonVisible:button.left>=r.left&&button.right<=r.right};
   });
   assert.ok(evidence.touchPan.scrollLeft>0);assert.equal(evidence.touchPan.farButtonVisible,true);
   assert.equal(await page.locator(cm).innerText(),before,'touch pan executes no command');
   for(let i=0;i<4;i++)await swipe('right');
   assert.ok(evidence.gestures.at(-1).scrollLeft<=1,'reverse pan reaches the starting edge without navigation');
   await cdp.detach();
   await page.waitForTimeout(700); // settle earlier saves before the preedit window
   const cmState=()=>page.locator(cm).evaluate(el=>{const h=el.closest('.st-note-editor').__cmHandle;return{doc:h.getValue(),selection:h.getSelection()}});
   const preedit=await cmState(),writesBefore=(await writes(page)).length;
   await page.locator(cm).dispatchEvent('compositionstart',{data:'中'});
   await page.locator(active).getByRole('button',{name:'插入内部链接',exact:true}).tap();
   assert.deepEqual(await cmState(),preedit);
   await page.waitForTimeout(700);assert.deepEqual(await cmState(),preedit);assert.equal((await writes(page)).length,writesBefore);
   await page.locator(cm).dispatchEvent('compositionend',{data:''});
   await page.setViewportSize({width,height:800});await page.locator(active+' .st-note-navigation').waitFor({state:'visible'});
   assert.equal(await page.locator(active+' .st-editor-tools').isVisible(),false);
   await page.locator(active+' .st-note-title').tap();assert.equal(await page.locator(active+' .st-editor-tools').isVisible(),false);
 });
});
test('N4 visible relations from editable flow',async()=>{
 await run('N4-relations-entry',async(page,evidence)=>{
   await openRead(page,'desktop');await page.locator(active+' .st-note-title').tap();
   await page.locator(active).getByRole('button',{name:'双链',exact:true}).tap();
   await page.getByRole('heading',{name:'双向链接',exact:true}).waitFor();
   await page.getByText('还没有其他笔记引用此笔记。',{exact:true}).waitFor();
   evidence.relationReads=await page.evaluate(()=>window.__replicaQa.calls.filter(c=>c.args?.request?.operationId==='knowledge.relations').length);
   assert.ok(evidence.relationReads>=1);
 });
});

test('N5 denied relation read exposes no actionable links',async()=>{
 await run('N5-relations-denied',async(page,evidence)=>{
   await openRead(page,'desktop');
   await page.evaluate(()=>window.__replicaQa.relationsDenied=true);
   await page.locator(active).getByRole('button',{name:'双链',exact:true}).tap();
   await page.getByText('未获笔记链接读取授权。',{exact:true}).waitFor();
   assert.equal(await page.locator('.st-sheet .st-relation-row').count(),0);
   evidence.denial='GRANT_REQUIRED';
 });
});
