// Opt-in actual React/CM6 UI regression. Native IPC uses the existing S1
// synthetic fixture; this is NOT Rust/Android, process-kill or device evidence.
// Build: node scripts/qa/buildReplicaS1Qa.mjs output/playwright/knowledge-continuity/production
// Run: LUCKYRAY_QA_PLAYWRIGHT=<playwright module> LUCKYRAY_QA_BROWSER=<browser executable> node --test scripts/qa/knowledgeContinuity.test.mjs
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

// #99 changes search entry to reading. The CM continuity gates below still
// exercise every original selection/composition/viewport assertion, but input
// must now begin through an actual body tap, never an automatic result focus.
async function startInputFromSearchReading(page, evidence, entry = "body") {
  const reader = page.locator(active + " .st-note-prose");
  await reader.waitFor();
  evidence.searchEntry = { reader: await reader.count(),
    editor: await page.locator(active + " .cm-content").count(),
    editableFocus: await page.evaluate(() => document.activeElement.matches('input,textarea,[contenteditable="true"]')) };
  assert.deepEqual(evidence.searchEntry, { reader: 1, editor: 0, editableFocus: false });
  evidence.inputEntry = entry;
  if (entry === "title") await page.locator(active).getByRole("textbox", { name: "笔记标题", exact: true }).click();
  else await reader.locator(".st-note-find-hit.is-current").click();
  await page.locator(active + " .cm-content").waitFor();
}

test("K1 full-vault body search beyond 80 chars and first page carries ranges without saving", async () => {
  await run("K1-full-body-no-save", async (page, evidence) => {
    await page.evaluate(() => {
      const n = window.__replicaQa.records[111];
      n.relativePath = "其他目录/n111.md";
      n.content = "序言\n".repeat(100) + "独有命中\n" + "中段\n".repeat(70) + "独有命中\n" + "后段\n".repeat(70) + "独有命中";
      n.cachedDocument = { ...n.cachedDocument, content: n.content, relativePath: n.relativePath };
      n.serverDocument = { ...n.serverDocument, content: n.content, relativePath: n.relativePath };
    });
    await desktop(page); const before = await edits(page);
    await search(page, "独有命中");
    const sheet = page.locator(".st-sheet");
    assert.equal(await sheet.locator(".st-note-row").count(), 1);
    await sheet.locator(".st-note-row").click();
    await page.locator(active + " .st-note-find-count").filter({ hasText: "1 / 3" }).waitFor();
    // Preserve the original CM gate's selection (no deliberate body caret
    // relocation). A body-entry/refocus observation is retained separately in
    // #99 raw run-5Cesht: the browser reveals that intentionally placed caret.
    await startInputFromSearchReading(page, evidence, "title");
    const first = await waitForVisibleSearchHit(page, { selector: active, text: "独有命中" }, evidence.firstGeometry = {});
    assert.ok(first.cmScrollTop > 100, "the CM scroller itself must reach the long-tail match");
    assert.ok(first.visibleHits.some(hit => hit.before.includes("序言") && hit.after.includes("中段")), "first hit has actual first-hit context");
    await page.screenshot({ path: resolve(out, "K1-first-hit-settled.png") });
    const selection = await page.locator(active + " .st-note-editor").evaluate(host => host.__cmHandle.getSelection());
    await page.getByRole("button", { name: "下一处匹配" }).click();
    await page.locator(active + " .st-note-find-count").filter({ hasText: "2 / 3" }).waitFor();
    const second = await waitForVisibleSearchHit(page, { selector: active, text: "独有命中" }, evidence.secondGeometry = {});
    assert.ok(second.cmScrollTop > first.cmScrollTop + 500, "next must advance the inner viewport, not only its counter or outer paper");
    assert.ok(second.visibleHits.some(hit => hit.before.includes("中段") && hit.after.includes("后段")), "second hit has actual second-hit context");
    await page.screenshot({ path: resolve(out, "K1-second-hit-settled.png") });
    assert.deepEqual(await page.locator(active + " .st-note-editor").evaluate(host => host.__cmHandle.getSelection()), selection);
    assert.equal(await edits(page), before);
    await page.getByRole("button", { name: "关闭正文查找" }).click();
    await page.locator(active + " .st-note-find").waitFor({ state: "detached" });
    const closed = await waitForVisibleSearchHit(page, { selector: active, text: "独有命中", kind: "text-line" }, evidence.closedGeometry = {});
    assert.ok(Math.abs(closed.cmScrollTop - second.cmScrollTop) < 2, "closing search preserves the same inner document position");
    assert.ok(closed.visibleHits.some(hit => hit.before.includes("中段") && hit.after.includes("后段")), "closing search retains the second hit, not another occurrence");
    assert.deepEqual(closed.selection, selection);
    await page.screenshot({ path: resolve(out, "K1-closed-search-settled.png") });
    await page.locator(active + " .cm-content").evaluate(input => input.blur());
    await page.locator(active + " .cm-content").focus();
    const returned = await waitForVisibleSearchHit(page, { selector: active, text: "独有命中", kind: "text-line" }, evidence.returnedGeometry = {});
    assert.ok(Math.abs(returned.cmScrollTop - closed.cmScrollTop) < 2, "keyboard blur/refocus retains the same inner document position");
    assert.deepEqual(returned.selection, selection);
    assert.equal(await edits(page), before);
    await page.screenshot({ path: resolve(out, "K1-refocus-settled.png") });
    evidence.calls = await page.evaluate(() => window.__replicaQa.calls.filter(call => call.cmd === "content_offline_notes"));
    assert.ok(evidence.calls.every(call => call.args.instance === "synthetic-pc" && call.args.vault === "synthetic-vault" && call.args.directory === ""));
    assert.equal(await page.evaluate(() => window.__replicaQa.calls.some(call => call.cmd === "notes_list")), false);
  });
});

test("K2 a new click of the same result/query resets the target; keyboard blur/refocus retains it", async () => {
  await run("K2-search-incarnation", async (page, evidence) => {
    await page.evaluate(() => { const n = window.__replicaQa.records[0]; n.content = "匹配正文\n".repeat(3); n.cachedDocument.content = n.content; n.serverDocument.content = n.content; });
    await desktop(page); await search(page, "匹配正文");
    await page.locator('.st-sheet [data-note-id="n000"]').click();
    await page.getByRole("button", { name: "下一处匹配" }).click();
    await page.getByRole("button", { name: "下一处匹配" }).click();
    await page.locator(active + " .st-note-find-count").filter({ hasText: "3 / 3" }).waitFor();
    await startInputFromSearchReading(page, evidence);
    await page.locator(active + " .cm-content").evaluate(input => input.blur());
    await page.locator(active + " .cm-content").focus();
    await page.locator(active + " .st-note-find-count").filter({ hasText: "3 / 3" }).waitFor();
    await search(page, "匹配正文"); await page.locator('.st-sheet [data-note-id="n000"]').click();
    await page.locator(active + " .st-note-find-count").filter({ hasText: "1 / 3" }).waitFor();
  });
});

test("K3 detail create offline uses the same vault and parent, never localNoteAdd", async () => {
  await run("K3-offline-sibling-create", async (page, evidence) => {
    await desktop(page); await page.evaluate(() => window.__replicaQa.setOnline(false));
    await page.locator(active).getByRole("button", { name: "新建笔记", exact: true }).click();
    await page.locator(active + " .cm-content").waitFor();
    evidence.creates = await page.evaluate(() => window.__replicaQa.calls.filter(call => call.cmd === "content_note_create"));
    assert.equal(evidence.creates.length, 1);
    assert.deepEqual(evidence.creates[0].args, { instance: "synthetic-pc", vault: "synthetic-vault", title: "新笔记", parentRelativePath: "资料" });
    assert.equal(await page.evaluate(() => window.__replicaQa.calls.some(call => call.cmd === "local_note_add")), false);
    await page.locator(active + " .cm-content").pressSequentially("离线草稿");
    await page.waitForFunction(() => window.__replicaQa.records.at(-1).content.includes("离线草稿"));
    // This proves frontend local-save wiring only. Kill-process recovery is
    // explicitly a separate native/device gate, never simulated as PASS here.
  });
});

test("K4 new input while authority is pending retires create before staging", async () => {
  await run("K4-authority-input-race", async page => {
    await desktop(page);
    await page.evaluate(() => {
      const original = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = (cmd, args) => cmd === "content_note_create_authority"
        ? new Promise(resolve => { window.__replicaQa.releaseAuthority = () => resolve({ usable: true }); })
        : original(cmd, args);
    });
    await page.locator(active).getByRole("button", { name: "新建笔记", exact: true }).click();
    await page.waitForFunction(() => typeof window.__replicaQa.releaseAuthority === "function");
    await page.locator(active + " .st-note-prose").click({position: {x: 12, y: 12}});
    await page.locator(active + " .cm-content").pressSequentially("不能被导航丢掉");
    await page.evaluate(() => window.__replicaQa.releaseAuthority());
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => window.__replicaQa.calls.filter(call => call.cmd === "content_note_create").length), 0);
    assert.ok((await page.locator(active + " .cm-content").innerText()).includes("不能被导航丢掉"));
  });
});

test("K5 query changes retire old results and the detail switcher paginates past 50", async () => {
  await run("K5-pagination-and-query", async (page, evidence) => {
    await desktop(page); await search(page, "");
    const sheet = page.locator(".st-sheet");
    assert.equal(await sheet.locator(".st-note-row").count(), 50);
    await sheet.getByRole("button", { name: "加载更多", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.st-sheet .st-note-row').length === 100);
    await sheet.getByRole("button", { name: "加载更多", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.st-sheet .st-note-row').length === 112);
    await page.getByPlaceholder("搜索标题和完整正文").fill("完全不存在");
    await page.getByText("没有找到匹配的笔记", { exact: true }).waitFor();
    assert.equal(await sheet.locator(".st-note-row").count(), 0);
    evidence.pages = await page.evaluate(() => window.__replicaQa.calls.filter(call => call.cmd === "content_offline_notes").map(call => call.args.page));
    assert.ok(evidence.pages.includes(3));
  });
});

test("K6 next-match during composition waits and never changes selection or saves", async () => {
  await run("K6-composition-find", async (page, evidence) => {
    await page.evaluate(() => { const n = window.__replicaQa.records[0]; n.content = "组合目标\n".repeat(3); n.cachedDocument.content = n.content; n.serverDocument.content = n.content; });
    await desktop(page); await search(page, "组合目标");
    await page.locator('.st-sheet [data-note-id="n000"]').click();
    await startInputFromSearchReading(page, evidence);
    const editor = page.locator(active + " .st-note-editor");
    const content = page.locator(active + " .cm-content");
    await content.focus();
    const initialSelection = await editor.evaluate(host => host.__cmHandle.getSelection());
    const before = await edits(page);
    await content.dispatchEvent("compositionstart", { data: "组" });
    assert.equal(await editor.evaluate(host => host.__cmHandle.compositionStarted()), true);
    await page.getByRole("button", { name: "下一处匹配" }).click();
    assert.equal(await page.locator(active + " .st-note-find-count").innerText(), "1 / 3");
    assert.deepEqual(await editor.evaluate(host => host.__cmHandle.getSelection()), initialSelection);
    await content.dispatchEvent("compositionend", { data: "" });
    await page.locator(active + " .st-note-find-count").filter({ hasText: "2 / 3" }).waitFor();
    assert.deepEqual(await editor.evaluate(host => host.__cmHandle.getSelection()), initialSelection);
    assert.equal(await edits(page), before);
    evidence.limit = "Synthetic DOM composition events only; physical keyboard/IME remains a device gate.";
  });
});

test("K7 retained S1 pages do not flash empty on reconnect and search Back retains result scroll", async () => {
  await run("K7-reconnect-and-scroll", async (page, evidence) => {
    await page.evaluate(() => {
      for (const n of window.__replicaQa.records) {
        n.content = "前言".repeat(100) + "全部命中";
        n.cachedDocument.content = n.content; n.serverDocument.content = n.content;
      }
    });
    const root = page.locator(".st-root-stage");
    await root.locator(".st-source button").last().click();
    await root.getByPlaceholder("搜索笔记").fill("全部命中");
    await root.locator(".st-note-hit .st-hit").first().waitFor();
    await root.getByRole("button", { name: "加载更多", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.st-root-stage .st-note-row').length === 100);
    await page.evaluate(() => {
      window.__replicaQa.observedCounts = [];
      const host = document.querySelector('.st-root-stage');
      const observer = new MutationObserver(() => window.__replicaQa.observedCounts.push(host.querySelectorAll('.st-note-row').length));
      observer.observe(host, { childList: true, subtree: true });
      window.__replicaQa.stopObserver = () => observer.disconnect();
      window.__replicaQa.setOnline(false);
    });
    await page.waitForTimeout(150);
    await page.evaluate(() => window.__replicaQa.setOnline(true));
    await page.waitForTimeout(350);
    evidence.counts = await page.evaluate(() => { window.__replicaQa.stopObserver(); return window.__replicaQa.observedCounts; });
    assert.ok(evidence.counts.every(count => count === 100));
    const row = root.locator('.st-note-row').nth(70); await row.scrollIntoViewIfNeeded();
    const scroll = await root.locator('.st-scroll').evaluate(element => element.scrollTop);
    await row.click();
    await page.locator(active + " .st-note-find-count").waitFor();
    await page.locator(active).getByRole("button", { name: "返回上一页", exact: true }).click();
    await page.locator(active).waitFor({ state: "detached" });
    assert.equal(await root.locator('.st-note-row').count(), 100);
    const after = await root.locator('.st-scroll').evaluate(element => element.scrollTop);
    assert.ok(Math.abs(after - scroll) < 2, `scroll ${scroll} -> ${after}`);
    evidence.scroll = { before: scroll, after };
  });
});
