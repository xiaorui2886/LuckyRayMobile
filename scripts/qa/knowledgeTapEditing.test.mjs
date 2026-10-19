// Opt-in actual React/CM6 UI regression. Native IPC uses the existing S1
// synthetic fixture; this is NOT Rust/Android, process-kill or device evidence.
// Build: node scripts/qa/buildReplicaS1Qa.mjs output/playwright/knowledge-continuity/production
// Run: LUCKYRAY_QA_PLAYWRIGHT=<playwright module> LUCKYRAY_QA_BROWSER=<browser executable> node --test scripts/qa/knowledgeTapEditing.test.mjs
import { waitForVisibleSearchHit } from "./knowledgeContinuityGeometry.mjs";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
const { chromium } = createRequire(import.meta.url)(process.env.LUCKYRAY_QA_PLAYWRIGHT || "playwright");
const built = resolve(process.env.LUCKYRAY_QA_BUNDLE || "output/playwright/knowledge-continuity/production");
const out = resolve(process.env.LUCKYRAY_QA_OUT || "output/playwright/knowledge-tap-edit/behavior");
const motionMode = process.env.LUCKYRAY_QA_REDUCED || "on";
assert.ok(["on", "off"].includes(motionMode), "LUCKYRAY_QA_REDUCED must be on or off");
const reducedMotion = motionMode === "on";
const report = { kind: "production-React-CM6-with-synthetic-native-IPC-NOT-device-UAT", reducedMotion, cases: [], errors: [] };
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
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/base.css"><link rel="stylesheet" href="/style.css"><div id="root"></div><script>window.__replicaQa={online:true,confirmed:true,reducedMotion:${reducedMotion}};</script><script src="/bundle.js"></script>`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.LUCKYRAY_QA_BROWSER });
  report.browserVersion = browser.version();
});
after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
  writeFileSync(resolve(out, "report.json"), JSON.stringify(report, null, 2));
});
async function run(name, callback) {
  const context = await browser.newContext({ viewport: { width: 360, height: 800 }, hasTouch: true, reducedMotion: reducedMotion ? "reduce" : "no-preference" });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  const record = { name, outcome: "RUNNING", evidence: {}, console: [] }; report.cases.push(record);
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
    await page.screenshot({ path: resolve(out, name + ".png") });
    record.outcome = "PASS";
  } catch (error) {
    record.outcome = "FAIL"; record.error = String(error);
    await page.screenshot({ path: resolve(out, name + "-failure.png") });
    throw error;
  } finally { await context.close(); }
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
for (const source of ["local", "desktop"]) {
  test(`T1 ${source}: open is quiet; tapping title retains that input and focus`, async () => {
    await run(`T1-${source}-title-entry`, async (page, evidence) => {
      await openRead(page, source, true);
      evidence.open = await quietOpen(page);
      assert.deepEqual(evidence.open, {focusedInput:false,titleVisible:true,bodyStartVisible:true,paperScrollTop:0});
      assert.equal((await writes(page)).length,0);
      await page.locator(active + ' .st-note-title').evaluate(input => { window.__tapTitle = input; });
      await page.locator(active + ' .st-note-title').tap();
      await page.locator(cm).waitFor();
      evidence.focus = await page.locator(active + ' .st-note-title').evaluate(input => ({same:input===window.__tapTitle,
        titleFocused:document.activeElement===input, bodyFocused:input.closest('.st-note-paper').querySelector('.cm-content')===document.activeElement}));
      assert.deepEqual(evidence.focus,{same:true,titleFocused:true,bodyFocused:false});
      await page.keyboard.insertText(" 标题");
      assert.equal(await page.locator(active + ' .st-note-title').inputValue(),"新笔记 标题");
      assert.equal(await page.locator(active).getByRole('button',{name:'完成',exact:true}).count(),0);
      assert.equal(await page.locator(active).getByRole('button',{name:'完成编辑',exact:true}).count(),0);
    });
  });
  test(`T2 ${source}: direct body entry saves exact Chinese/emoji text on Back`, async () => {
    await run(`T2-${source}-body-back-save`, async (page,evidence) => {
      await openRead(page,source,true);
      await page.locator(active+' .st-note-prose').tap({position:{x:20,y:15}});
      await page.locator(cm).waitFor();
      assert.equal(await page.locator(cm).evaluate(input=>input===document.activeElement),true);
      await page.keyboard.insertText('测试😀ABC');
      await page.locator(active).getByRole('button',{name:'返回上一页',exact:true}).tap();
      await page.locator(cm).waitFor({state:'detached'});
      evidence.saved=await page.evaluate(source=>(source==='local'?window.__replicaQa.localRecords:window.__replicaQa.records)[0].content,source);
      assert.equal(evidence.saved,'测试😀ABC');
      await openRead(page,source);
      assert.ok((await page.locator(active+' .st-note-prose').innerText()).includes('测试😀ABC'));
      assert.equal((await quietOpen(page)).focusedInput,false);
    });
  });
  test(`T3 ${source}: failed save keeps note open until a successful retry`, async () => {
    await run(`T3-${source}-failed-save-back`, async (page,evidence) => {
      await openRead(page,source,true);
      await page.evaluate(source=>{
        const invoke=window.__TAURI_INTERNALS__.invoke;
        window.__replicaQa.failSave=true;
        window.__TAURI_INTERNALS__.invoke=(cmd,args)=> window.__replicaQa.failSave && cmd===(source==='local'?'local_note_update':'content_note_edit')
          ? Promise.reject(new Error('synthetic-save-failure')) : invoke(cmd,args);
      },source);
      await page.locator(active+' .st-note-prose').tap({position:{x:20,y:15}});
      await page.keyboard.insertText('必须保留');
      await page.locator(active).getByRole('button',{name:'返回上一页',exact:true}).tap();
      await page.locator(active).getByText(/保存失败|尚未保存|未能保存/).first().waitFor();
      assert.equal(await page.locator(cm).count(),1);
      evidence.beforeRetry=await page.locator(cm).innerText();
      await page.evaluate(()=>{window.__replicaQa.failSave=false;});
      await page.locator(cm).focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('！');
      await page.locator(active).getByRole('button',{name:'返回上一页',exact:true}).tap();
      await page.locator(cm).waitFor({state:'detached'});
      const saved=await page.evaluate(source=>(source==='local'?window.__replicaQa.localRecords:window.__replicaQa.records)[0].content,source);
      assert.equal(saved,'必须保留！');
    });
  });
}
test('T4 normal/new desktop route shows title and body without an editable focus',async()=>{
  await run('T4-route-open-no-autofocus',async(page,evidence)=>{
    await page.locator('.st-note-row').first().tap();
    await page.locator(cm).waitFor();
    evidence.normal=await quietOpen(page);
    assert.deepEqual(evidence.normal,{focusedInput:false,titleVisible:true,bodyStartVisible:true,paperScrollTop:0});
    assert.equal((await writes(page)).length,0);
    await page.locator(active).getByRole('button',{name:'返回上一页',exact:true}).tap();
    await page.locator(cm).waitFor({state:'detached'});
    await openRead(page,'desktop');
    await page.locator(active).getByRole('button',{name:'新建笔记',exact:true}).tap();
    await page.locator(cm).waitFor();
    evidence.created=await quietOpen(page);
    assert.deepEqual(evidence.created,{focusedInput:false,titleVisible:true,bodyStartVisible:true,paperScrollTop:0});
    assert.equal(await page.locator(active+' .st-note-title').inputValue(),'新笔记');
    assert.equal((await writes(page)).length,0);
  });
});
test('T5 Markdown links and metadata-only notes do not enter editing',async()=>{
  await run('T5-reader-controls-and-metadata',async(page,evidence)=>{
    await page.evaluate(()=>{
      const n=window.__replicaQa.records[0]; n.content='正文 [安全链接](https://example.com)';
      n.cachedDocument.content=n.content; n.serverDocument.content=n.content;
    });
    await openRead(page,'desktop');
    const link=page.locator(active+' .st-note-prose a');
    // Keep this UI test offline: cancelling navigation at window bubble time
    // is AFTER React's reader handler, so it cannot mask that handler's gate.
    await page.evaluate(()=>window.addEventListener('click',event=>event.preventDefault(),{once:true}));
    await link.tap();
    assert.equal(await page.locator(cm).count(),0);
    assert.equal((await writes(page)).length,0);
    evidence.link=await link.getAttribute('href');
    await page.locator(active).getByRole('button',{name:'返回上一页',exact:true}).tap();
    // The ordinary animation leaves the old owner mounted until Back really
    // completes. Do not reopen that same ID inside its outgoing transition.
    await page.locator(active).waitFor({state:'detached'});
    await page.evaluate(()=>{const n=window.__replicaQa.records[0];n.cachedDocument=null;n.dirty=false;window.__replicaQa.openRead(n.noteId);});
    await page.locator(active).getByText('连接电脑后，继续阅读',{exact:true}).waitFor();
    assert.equal(await page.locator(active+' .st-note-title').count(),0);
    assert.equal(await page.locator(cm).count(),0);
  });
});
test('T6 pending desktop save delays Back until its receipt, without a Done step',async()=>{
  await run('T6-pending-save-back',async(page,evidence)=>{
    await openRead(page,'desktop',true);
    await page.locator(active+' .st-note-prose').tap({position:{x:20,y:15}});
    await page.evaluate(()=>{window.__replicaQa.deferNextEdit=true;});
    await page.keyboard.insertText('等待保存');
    await page.waitForFunction(()=>typeof window.__replicaQa.releaseEdit==='function');
    const routeBefore = await page.evaluate(()=>window.__replicaQa.currentRoute());
    await page.locator(active).getByRole('button',{name:'返回上一页',exact:true}).tap();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.deepEqual(await page.evaluate(()=>window.__replicaQa.currentRoute()),routeBefore,
      'pending save must block the actual navigation authority, not just leave an animating old layer');
    assert.equal(await page.locator('.st-detail-stage.is-leaving').count(),0);
    assert.equal(await page.locator(cm).count(),1);
    await page.evaluate(()=>window.__replicaQa.releaseEdit());
    await page.locator(cm).waitFor({state:'detached'});
    evidence.saved=await page.evaluate(()=>window.__replicaQa.records[0].content);
    assert.equal(evidence.saved,'等待保存');
  });
});
