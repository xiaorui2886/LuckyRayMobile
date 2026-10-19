// Opt-in actual React/CM6 UI regression. Native IPC uses the existing S1
// synthetic fixture; this is NOT Rust/Android, process-kill or device evidence.
// Build: node scripts/qa/buildReplicaS1Qa.mjs output/playwright/knowledge-continuity/production
// Run: LUCKYRAY_QA_PLAYWRIGHT=<playwright module> LUCKYRAY_QA_BROWSER=<browser executable> node --test scripts/qa/knowledgeReadingPosition.test.mjs
import { waitForVisibleSearchHit } from "./knowledgeContinuityGeometry.mjs";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
const { chromium } = createRequire(import.meta.url)(process.env.LUCKYRAY_QA_PLAYWRIGHT || "playwright");
const built = resolve(process.env.LUCKYRAY_QA_BUNDLE || "output/playwright/knowledge-continuity/production");
const out = resolve(process.env.LUCKYRAY_QA_OUT || "output/playwright/knowledge-continuity/behavior");
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
  const context = await browser.newContext({ viewport: { width: 360, height: 800 }, reducedMotion: reducedMotion ? "reduce" : "no-preference" });
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
async function desktop(page, noteId = "n000") {
  await page.evaluate(id => window.__replicaQa.openRead(id), noteId);
  await page.locator(active + " .st-note-prose").waitFor();
}
async function search(page, query) {
  await page.locator(active).getByRole("button", { name: "打开笔记列表", exact: true }).click();
  await page.getByPlaceholder("搜索标题和完整正文").fill(query);
  await page.locator('.st-sheet .st-note-row').first().waitFor();
}
const edits = page => page.evaluate(() => window.__replicaQa.calls.filter(call => call.cmd === "content_note_edit" || call.cmd === "local_note_update").length);


async function readingGeometry(page, text) {
  return page.locator(active + " .st-note-paper").evaluate((paper, text) => {
    const viewport = paper.getBoundingClientRect();
    const walker = document.createTreeWalker(paper.querySelector(".st-note-prose"), NodeFilter.SHOW_TEXT);
    const hits = [];
    for (let node; node = walker.nextNode();) {
      let from = node.textContent.indexOf(text);
      while (from >= 0) {
        const range = document.createRange(); range.setStart(node, from); range.setEnd(node, from + text.length);
        for (const box of range.getClientRects()) hits.push({top:box.top, bottom:box.bottom,
          visible:box.bottom > viewport.top && box.top < viewport.bottom});
        from = node.textContent.indexOf(text, from + text.length);
      }
    }
    return { scrollTop:paper.scrollTop, viewport:{top:viewport.top,bottom:viewport.bottom,height:viewport.height}, hits };
  }, text);
}
const section = (label, count) => Array.from({length: count}, (_, i) =>
  i % 4 === 0 ? `### ${label}标题 ${i}\n\n这是**加粗内容**和[安全链接](https://example.com)，用于保持源码与阅读高度不同。\n\n` :
  i % 4 === 1 ? `- ${label}列表 ${i}\n- 第二条记录\n\n` :
  i % 4 === 2 ? `> ${label}引用 ${i}\n> 引用续行\n\n` :
  `\`\`\`text\n${label}代码 ${i}\n保留文本\n\`\`\`\n\n`).join("");
const longBody = section("开头", 36) + "第一处 独有命中\n\n" + section("中间", 36) +
  "第二处 独有命中\n\n" + section("后段", 36) + "第三处 独有命中\n\n" + section("尾部", 20);

test("R1 tapping the third rendered occurrence edits that source position without resetting on blur", async () => {
  await run("R1-third-hit-tap-position", async (page, evidence) => {
    await page.evaluate(content => {
      const n = window.__replicaQa.records[0]; n.content = content;
      n.cachedDocument.content = content; n.serverDocument.content = content;
    }, longBody);
    await desktop(page);
    const before = await edits(page);
    const target = page.locator(active + ' .st-note-prose').getByText("第三处 独有命中", {exact: true});
    await target.scrollIntoViewIfNeeded();
    evidence.reading = await readingGeometry(page,"第三处 独有命中");
    assert.ok(evidence.reading.hits.some(hit => hit.visible));
    await target.click({position: {x: 12, y: 8}});
    await page.locator(active + " .cm-content").waitFor();
    const entered = await waitForVisibleSearchHit(page, {selector:active,text:"第三处 独有命中",kind:"text-line"}, evidence.enteredGeometry = {});
    const from = longBody.indexOf("第三处 独有命中");
    assert.ok(entered.selection.start >= from && entered.selection.start <= from + "第三处 独有命中".length,
      "the caret belongs to the tapped THIRD occurrence, not the retained/default caret");
    await page.locator(active + " .cm-content").evaluate(input => input.blur());
    const blurred = await waitForVisibleSearchHit(page, {selector:active,text:"第三处 独有命中",kind:"text-line"}, evidence.blurredGeometry = {});
    assert.ok(Math.abs(blurred.cmScrollTop-entered.cmScrollTop)<2,"closing keyboard focus does not reset reading position");
    assert.deepEqual(blurred.selection,entered.selection);
    assert.equal(await edits(page),before,"tap/focus/blur never edit or save the note");
    assert.equal(await page.locator(active).getByRole("button",{name:"完成",exact:true}).count(),0);
    assert.equal(await page.locator(active).getByRole("button",{name:"编辑笔记",exact:true}).count(),0);
  });
});
