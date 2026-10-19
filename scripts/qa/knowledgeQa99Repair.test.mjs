// Real production React/CM6 UI; ONLY synthetic IPC. Never device/IME proof.
// Build with buildReplicaS1Qa.mjs; explicit verified Playwright/browser paths.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
const { chromium } = createRequire(import.meta.url)(process.env.LUCKYRAY_QA_PLAYWRIGHT || "playwright");
const built = resolve(process.env.LUCKYRAY_QA_BUNDLE || "output/playwright/qa99-repair/production");
const out = resolve(process.env.LUCKYRAY_QA_OUT || "output/playwright/qa99-repair/behavior");
const active = '.st-detail-stage[data-current="true"]';
const report = { kind: "production-React-synthetic-IPC-NOT-Android-UAT", cases: [], errors: [] };
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
    res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/base.css"><link rel="stylesheet" href="/style.css"><div id="root"></div><script>window.__replicaQa={online:true,confirmed:true,reducedMotion:true};</script><script src="/bundle.js"></script>');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.LUCKYRAY_QA_BROWSER });
  report.browserVersion = browser.version();
  report.browserSha256 = createHash("sha256").update(readFileSync(process.env.LUCKYRAY_QA_BROWSER)).digest("hex");
});
after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
  writeFileSync(resolve(out, "report.json"), JSON.stringify(report, null, 2));
});
async function run(name, callback) {
  const context = await browser.newContext({ viewport: { width: 392, height: 800 }, hasTouch: true, reducedMotion: "reduce" });
  const page = await context.newPage(); page.setDefaultTimeout(8000);
  const record = { name, outcome: "RUNNING", evidence: {} }; report.cases.push(record);
  page.on("pageerror", error => report.errors.push(String(error)));
  try {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.locator(".st-note-row").first().waitFor();
    await page.evaluate(() => { window.__qaFocusTrace = []; for (const type of ["focusin", "pointerdown", "click"]) document.addEventListener(type, e => window.__qaFocusTrace.push({ type, tag: e.target.tagName, class: e.target.className, label: e.target.getAttribute("aria-label"), x: e.clientX, y: e.clientY }), true); });
    await callback(page, record.evidence);
    assert.deepEqual(report.errors, []);
    await page.screenshot({ path: resolve(out, name + ".png") }); record.outcome = "PASS";
  } catch (error) {
    record.outcome = "FAIL"; record.error = String(error);
    await page.screenshot({ path: resolve(out, name + "-failure.png") }); throw error;
  } finally { await context.close(); }
}
const writes = page => page.evaluate(() => window.__replicaQa.calls.filter(call => ["local_note_update", "content_note_edit"].includes(call.cmd)));
async function identityNotes(page) {
  return page.evaluate(() => {
    const qa = window.__replicaQa;
    const body = Array.from({ length: 28 }, (_, i) => `P${i + 1} QA99 identity context ${i === 15 || i === 25 ? "QA99-OLD-HIT" : i === 6 ? "QA99-NEW-HIT" : "plain"}${i === 25 ? " [[QA99-Identity-B|去B]]" : ""}.`).join("\n\n");
    Object.assign(qa.localRecords[0], { title: "QA99-Identity-A", content: body });
    Object.assign(qa.localRecords[1], { title: "QA99-Identity-B", content: "QA99 B body 中文😀.\n\n[[QA99-Identity-A|回A]]" });
    return body;
  });
}
async function searchIdentityA(page, query) {
  await page.locator(active).getByRole("button", { name: "查找笔记", exact: true }).tap();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("searchbox").fill(query);
  await dialog.locator('.st-note-row[data-note-id="note-qa-local-0"]').tap();
  await dialog.waitFor({ state: "detached" });
  await page.locator(active + " .st-note-prose").waitFor();
}
async function identityOwners(page) {
  return page.locator(".st-detail-stage .st-note-title").evaluateAll(inputs => inputs.map(input => ({ title: input.value, current: input.closest(".st-detail-stage").dataset.current === "true" })));
}
async function saveIdentityEdit(page, suffix) {
  const editor = page.locator(active + ' [contenteditable="true"]');
  await editor.waitFor(); await editor.press("Control+End");
  await page.keyboard.insertText(suffix);
}

test("identity: ordinary A → same-note search A → Wiki B → Wiki A reuses one edit-prefixed owner", async () => {
  await run("I1-edit-search-wiki-cycle", async (page, evidence) => {
    const original = await identityNotes(page);
    await page.locator('.st-root-stage .st-note-row').first().tap();
    await page.locator(active + ' [contenteditable="true"]').waitFor();
    evidence.entry = await page.evaluate(() => window.__replicaQa.currentRoute());
    assert.equal(evidence.entry.detail, "edit:note-qa-local-0", "exercise the actual ordinary list entry, not a read-only test shortcut");
    assert.equal(await page.locator(active + " .st-note-title").inputValue(), "QA99-Identity-A");
    await page.evaluate(() => { window.__identityTitleA = document.querySelector('.st-detail-stage[data-current="true"] .st-note-title'); });
    const edited = original + "\nQA99-OWNER-ONE 中文😀";
    await saveIdentityEdit(page, "\nQA99-OWNER-ONE 中文😀");
    await searchIdentityA(page, "QA99-OLD-HIT");
    assert.equal(await page.locator(active + ' [contenteditable="true"]').count(), 0);
    await page.locator(active).getByRole("button", { name: "下一处匹配", exact: true }).tap();
    const hit = page.locator(active + " .st-note-find-hit.is-current");
    assert.equal(await hit.getAttribute("data-note-source-start"), String(edited.lastIndexOf("QA99-OLD-HIT")));
    await page.locator(active).getByRole("button", { name: "去B", exact: true }).waitFor();
    evidence.beforeLink = await page.locator(active + " .st-note-paper").evaluate(el => el.scrollTop);
    await page.locator(active).getByRole("button", { name: "去B", exact: true }).tap();
    await page.waitForFunction(() => document.querySelector('.st-detail-stage[data-current="true"] .st-note-title')?.value === "QA99-Identity-B");
    assert.match(await page.locator(active + " .st-note-prose").textContent(), /QA99 B body 中文😀/);
    evidence.atB = await identityOwners(page);
    assert.equal(evidence.atB.filter(owner => owner.title === "QA99-Identity-A").length, 1);
    await page.screenshot({ path: resolve(out, "I1-B-retains-one-A.png") });
    await page.locator(active).getByRole("button", { name: "回A", exact: true }).tap();
    await page.waitForFunction(() => document.querySelector('.st-detail-stage[data-current="true"] .st-note-title')?.value === "QA99-Identity-A");
    evidence.afterCycle = await identityOwners(page);
    assert.equal(evidence.afterCycle.filter(owner => owner.title === "QA99-Identity-A").length, 1, "one real note must have one mounted/save owner across edit: and read routes");
    assert.equal(await page.evaluate(() => document.querySelector('.st-detail-stage[data-current="true"] .st-note-title') === window.__identityTitleA), true, "reuse the original owner, do not unmount and recreate it");
    assert.equal(await page.locator(active + ' [contenteditable="true"]').count(), 0);
    assert.match(await page.locator(active + " .st-note-prose").textContent(), /QA99-OWNER-ONE 中文😀/);
    evidence.afterLink = await page.locator(active + " .st-note-paper").evaluate(el => el.scrollTop);
    assert.ok(Math.abs(evidence.afterLink - evidence.beforeLink) < 3, "Wiki cycle preserves A's actual reading viewport");
    assert.equal(await hit.getAttribute("data-note-source-start"), String(edited.lastIndexOf("QA99-OLD-HIT")));
    await page.screenshot({ path: resolve(out, "I1-cycle-A-keeps-return-position.png") });
    evidence.writes = await writes(page);
    assert.equal(evidence.writes.length, 1, "one explicit edit is flushed once; navigation must not create a second save owner");
    assert.equal(evidence.writes[0].args.noteId, "note-qa-local-0");
    assert.equal(evidence.writes[0].args.content, edited);
    await page.locator(active).getByRole("button", { name: "返回上一页", exact: true }).tap();
    await page.locator(active).waitFor({ state: "detached" });
    await page.locator('.st-root-stage .st-note-row').filter({ has: page.getByText("QA99-Identity-A", { exact: true }) }).tap();
    await page.locator(active + ' [contenteditable="true"]').waitFor();
    assert.equal(await page.locator(active + " .st-note-editor").evaluate(el => el.__cmHandle.getValue()), edited, "reopen through the UI reads the saved full synthetic body");
    assert.equal((await writes(page)).length, 1);
    // Preserve the prior non-query current-row behavior while unifying real
    // search intents: an empty switcher selection still returns to reading.
    await page.locator(active).getByRole("button", { name: "查找笔记", exact: true }).tap();
    await page.getByRole("dialog").locator('.st-note-row[data-note-id="note-qa-local-0"]').tap();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await page.locator(active + " .st-note-prose").waitFor();
    assert.equal(await page.locator(active + ' [contenteditable="true"]').count(), 0);
    assert.equal((await writes(page)).length, 1);
  });
});

test("identity: reading A → Wiki B → search A reuses the owner and applies the new search target", async () => {
  await run("I2-retained-search-new-intent", async (page, evidence) => {
    const body = await identityNotes(page);
    await page.evaluate(() => window.__replicaQa.openLocal("note-qa-local-0"));
    await page.locator(active + " .st-note-prose").waitFor();
    await page.evaluate(() => { window.__identityTitleA = document.querySelector('.st-detail-stage[data-current="true"] .st-note-title'); });
    // An existing reading intent must not win over the later search from B.
    await searchIdentityA(page, "QA99-OLD-HIT");
    await page.locator(active).getByRole("button", { name: "下一处匹配", exact: true }).tap();
    await page.locator(active).getByRole("button", { name: "去B", exact: true }).tap();
    await page.waitForFunction(() => document.querySelector('.st-detail-stage[data-current="true"] .st-note-title')?.value === "QA99-Identity-B");
    evidence.atB = await identityOwners(page);
    await searchIdentityA(page, "QA99-NEW-HIT");
    evidence.afterSearch = await identityOwners(page);
    assert.equal(evidence.afterSearch.filter(owner => owner.title === "QA99-Identity-A").length, 1);
    assert.equal(await page.evaluate(() => document.querySelector('.st-detail-stage[data-current="true"] .st-note-title') === window.__identityTitleA), true);
    assert.equal(await page.locator(active + ' [contenteditable="true"]').count(), 0);
    const reader = page.locator(active + " .st-note-prose");
    evidence.query = await reader.locator(".st-note-find-query").textContent();
    assert.equal(evidence.query, "QA99-NEW-HIT", "a reused page must consume the new intent instead of its initial/previous search");
    const hit = reader.locator(".st-note-find-hit.is-current");
    evidence.hit = await hit.evaluate(el => ({ text: el.textContent, from: Number(el.dataset.noteSourceStart), y: el.getBoundingClientRect().top }));
    assert.equal(evidence.hit.from, body.indexOf("QA99-NEW-HIT"));
    assert.equal(evidence.hit.text, "QA99-NEW-HIT");
    assert.ok(evidence.hit.y > 120 && evidence.hit.y < 700, "the new target is actually visible, not only metadata");
    await page.screenshot({ path: resolve(out, "I2-new-search-target-visible.png") });
    assert.deepEqual(await writes(page), []);
    const passage = reader.locator("p").filter({ hasText: "P7 QA99 identity" });
    evidence.beforeClose = await passage.evaluate(el => ({ y: el.getBoundingClientRect().top, scroll: el.closest(".st-note-paper").scrollTop }));
    await reader.getByRole("button", { name: "关闭正文查找", exact: true }).tap();
    await reader.getByRole("group", { name: "正文查找" }).waitFor({ state: "detached" });
    evidence.afterClose = await passage.evaluate(el => ({ y: el.getBoundingClientRect().top, scroll: el.closest(".st-note-paper").scrollTop }));
    assert.ok(Math.abs(evidence.afterClose.y - evidence.beforeClose.y) < 3, "closing find preserves the actual visible passage (scrollTop may compensate for removed chrome)");
    await passage.tap();
    await saveIdentityEdit(page, "\nQA99-OWNER-TWO 中文😀");
    await page.locator(active).getByRole("button", { name: "返回上一页", exact: true }).tap();
    await page.locator(active).waitFor({ state: "detached" });
    evidence.writes = await writes(page);
    assert.equal(evidence.writes.length, 1);
    assert.equal(evidence.writes[0].args.noteId, "note-qa-local-0");
    assert.equal(evidence.writes[0].args.content, body + "\nQA99-OWNER-TWO 中文😀");
    await page.locator('.st-root-stage .st-note-row').filter({ has: page.getByText("QA99-Identity-A", { exact: true }) }).tap();
    await page.locator(active + ' [contenteditable="true"]').waitFor();
    assert.equal(await page.locator(active + " .st-note-editor").evaluate(el => el.__cmHandle.getValue()), body + "\nQA99-OWNER-TWO 中文😀");
    assert.equal((await writes(page)).length, 1);
  });
});
async function openSyntheticRead(page, source) {
  await page.evaluate(source => {
    const n = (source === "local" ? window.__replicaQa.localRecords : window.__replicaQa.records)[0];
    n.title = "QA99-REPAIR-Long";
    n.content = Array.from({ length: 28 }, (_, i) => `P${i + 1} synthetic read context ${i === 15 || i === 25 ? "QA99-NEEDLE" : "plain text"}.`).join("\n\n");
    if (source === "local") window.__replicaQa.openLocal(n.noteId);
    else { n.cachedDocument.content = n.content; n.serverDocument.content = n.content; window.__replicaQa.openRead(n.noteId); }
  }, source);
  await page.locator(active + " .st-note-prose").waitFor();
}

test("currentness: retained A cannot bypass B's delayed save on the actual Android Back broadcast", async () => {
  await run("C1-retained-local-delayed-back", async (page, evidence) => {
    await page.evaluate(() => {
      const qa = window.__replicaQa;
      Object.assign(qa.localRecords[0], { title: "QA99-Back-A", content: "QA99 A original 中文😀.\n\n[[QA99-Back-B|去B]]" });
      Object.assign(qa.localRecords[1], { title: "QA99-Back-B", content: "QA99 B original 中文😀." });
      qa.openLocal(qa.localRecords[0].noteId);
    });
    await page.locator(active + " .st-note-prose").waitFor();
    await page.locator(active).getByRole("button", { name: "去B", exact: true }).tap();
    await page.waitForFunction(() => document.querySelector('.st-detail-stage[data-current="true"] .st-note-title')?.value === "QA99-Back-B");
    assert.equal((await identityOwners(page)).filter(owner => owner.title === "QA99-Back-A").length, 1);
    await page.locator(active + " .st-note-prose p").first().tap();
    const expected = "QA99 B original 中文😀.\nQA99 delayed-save 中文😀";
    await page.evaluate(() => { window.__replicaQa.deferNextLocalSave = true; });
    await saveIdentityEdit(page, "\nQA99 delayed-save 中文😀");
    await page.waitForFunction(() => document.querySelector('.st-detail-stage[data-current="true"]')?.textContent.includes("未保存"));
    evidence.consumed = await page.evaluate(() => !window.dispatchEvent(new Event("luckyray:desktop-note-back", { cancelable: true })));
    await page.waitForFunction(() => window.__replicaQa.localSavePending === "note-qa-local-1");
    await page.waitForTimeout(450); // Longer than the production Back transition: no optimistic pop.
    evidence.waitingOwners = await identityOwners(page);
    assert.equal(evidence.consumed, true);
    assert.equal(await page.locator(active + " .st-note-title").inputValue(), "QA99-Back-B", "a hidden A listener must not pop current B while B's flush is pending");
    assert.equal(await page.locator(active + " .st-note-editor").evaluate(el => el.__cmHandle.getValue()), expected);
    await page.screenshot({ path: resolve(out, "C1-save-pending-stays-B.png") });
    await page.evaluate(() => window.dispatchEvent(new Event("luckyray:desktop-note-back", { cancelable: true })));
    assert.equal((await writes(page)).length, 1, "repeated Back shares the existing save drain");
    await page.evaluate(() => window.__replicaQa.releaseLocalSave());
    await page.waitForFunction(() => document.querySelector('.st-detail-stage[data-current="true"] .st-note-title')?.value === "QA99-Back-A");
    await page.waitForTimeout(450);
    evidence.afterSuccess = await identityOwners(page);
    assert.equal(await page.locator(active + " .st-note-title").inputValue(), "QA99-Back-A", "success pops only B once, never the retained A");
    evidence.writes = await writes(page);
    assert.equal(evidence.writes.length, 1);
    assert.equal(evidence.writes[0].args.noteId, "note-qa-local-1");
    assert.equal(evidence.writes[0].args.content, expected);
    assert.equal(await page.evaluate(() => window.__replicaQa.localRecords[1].content), expected);
    assert.equal(await page.locator(active + ' [contenteditable="true"]').count(), 0);
  });
});

test("currentness: failed B save stays on B; retry success returns once to retained A", async () => {
  await run("C2-retained-local-failed-back", async (page, evidence) => {
    await page.evaluate(() => {
      const qa = window.__replicaQa;
      Object.assign(qa.localRecords[0], { title: "QA99-Fail-A", content: "QA99 A preserved 中文😀.\n\n[[QA99-Fail-B|去B]]" });
      Object.assign(qa.localRecords[1], { title: "QA99-Fail-B", content: "QA99 B failure original 中文😀." });
      qa.openLocal(qa.localRecords[0].noteId);
    });
    await page.locator(active + " .st-note-prose").waitFor();
    await page.locator(active).getByRole("button", { name: "去B", exact: true }).tap();
    await page.waitForFunction(() => document.querySelector('.st-detail-stage[data-current="true"] .st-note-title')?.value === "QA99-Fail-B");
    await page.locator(active + " .st-note-prose p").first().tap();
    await page.evaluate(() => { window.__replicaQa.deferNextLocalSave = true; });
    const expected = "QA99 B failure original 中文😀.\nQA99 failed-retry 中文😀";
    await saveIdentityEdit(page, "\nQA99 failed-retry 中文😀");
    await page.waitForFunction(() => document.querySelector('.st-detail-stage[data-current="true"]')?.textContent.includes("未保存"));
    assert.equal(await page.evaluate(() => !window.dispatchEvent(new Event("luckyray:desktop-note-back", { cancelable: true }))), true);
    await page.waitForFunction(() => window.__replicaQa.localSavePending === "note-qa-local-1");
    await page.waitForTimeout(450);
    assert.equal(await page.locator(active + " .st-note-title").inputValue(), "QA99-Fail-B");
    await page.evaluate(() => window.__replicaQa.releaseLocalSave(false));
    await page.waitForFunction(() => document.querySelector('.st-detail-stage[data-current="true"]')?.textContent.includes("退出保存失败"));
    await page.waitForTimeout(450);
    evidence.failedOwners = await identityOwners(page);
    assert.equal(await page.locator(active + " .st-note-title").inputValue(), "QA99-Fail-B", "failure must keep B and its entire unsaved draft visible");
    assert.equal(await page.locator(active + " .st-note-editor").evaluate(el => el.__cmHandle.getValue()), expected);
    assert.equal(await page.evaluate(() => window.__replicaQa.localRecords[1].content), "QA99 B failure original 中文😀.");
    await page.screenshot({ path: resolve(out, "C2-save-failed-stays-B.png") });
    await page.evaluate(() => {
      window.__replicaQa.deferNextLocalSave = true;
      window.dispatchEvent(new Event("luckyray:desktop-note-back", { cancelable: true }));
    });
    await page.waitForFunction(() => window.__replicaQa.localSavePending === "note-qa-local-1");
    await page.evaluate(() => window.dispatchEvent(new Event("luckyray:desktop-note-back", { cancelable: true })));
    assert.equal((await writes(page)).length, 2, "failure plus exactly one retry, not multiple save owners");
    await page.evaluate(() => window.__replicaQa.releaseLocalSave());
    await page.waitForFunction(() => document.querySelector('.st-detail-stage[data-current="true"] .st-note-title')?.value === "QA99-Fail-A");
    await page.waitForTimeout(450);
    assert.equal(await page.locator(active + " .st-note-title").inputValue(), "QA99-Fail-A");
    evidence.writes = await writes(page);
    assert.equal(evidence.writes.length, 2);
    assert.ok(evidence.writes.every(call => call.args.noteId === "note-qa-local-1" && call.args.content === expected));
    assert.equal(await page.evaluate(() => window.__replicaQa.localRecords[1].content), expected);
    assert.equal(await page.locator(active + ' [contenteditable="true"]').count(), 0);
  });
});

test("currentness: a retained Desktop owner cannot consume current B's native Back", async () => {
  await run("C3-covered-desktop-owner-back", async (page, evidence) => {
    await page.evaluate(() => {
      const qa = window.__replicaQa, a = qa.records[0];
      Object.assign(a, { title: "QA99-Desktop-A", content: "QA99 retained Desktop A 中文😀." });
      a.cachedDocument.title = a.serverDocument.title = a.title;
      a.cachedDocument.content = a.serverDocument.content = a.content;
      Object.assign(qa.localRecords[1], { title: "QA99-Cross-B", content: "QA99 current local B 中文😀." });
      qa.openRead(a.noteId);
    });
    await page.locator(active + " .st-note-prose").waitFor();
    // Public production navigation, not a mocked controller. The supplied
    // retained stack exercises the Desktop listener independently of links.
    await page.evaluate(() => window.__replicaQa.openLocal("note-qa-local-1", true));
    await page.waitForFunction(() => document.querySelector('.st-detail-stage[data-current="true"] .st-note-title')?.value === "QA99-Cross-B");
    assert.equal((await identityOwners(page)).filter(owner => owner.title === "QA99-Desktop-A").length, 1);
    await page.locator(active + " .st-note-prose p").first().tap();
    await page.evaluate(() => { window.__replicaQa.deferNextLocalSave = true; });
    await saveIdentityEdit(page, "\nQA99 single-current Back");
    await page.waitForFunction(() => document.querySelector('.st-detail-stage[data-current="true"]')?.textContent.includes("未保存"));
    await page.evaluate(() => window.dispatchEvent(new Event("luckyray:desktop-note-back", { cancelable: true })));
    await page.waitForFunction(() => window.__replicaQa.localSavePending === "note-qa-local-1");
    await page.waitForTimeout(450);
    evidence.waitingOwners = await identityOwners(page);
    assert.equal(await page.locator(active + " .st-note-title").inputValue(), "QA99-Cross-B", "the hidden Desktop listener must ignore the global event");
    await page.evaluate(() => window.__replicaQa.releaseLocalSave());
    await page.waitForFunction(() => document.querySelector('.st-detail-stage[data-current="true"] .st-note-title')?.value === "QA99-Desktop-A");
    await page.waitForTimeout(450);
    assert.equal(await page.locator(active + " .st-note-title").inputValue(), "QA99-Desktop-A");
    evidence.writes = await writes(page);
    assert.equal(evidence.writes.length, 1);
    assert.equal(evidence.writes[0].args.noteId, "note-qa-local-1");
  });
});

test("currentness: a covered local page's late Back completion cannot navigate B", async () => {
  await run("C4-local-late-back-retired", async (page, evidence) => {
    await page.evaluate(() => {
      const qa = window.__replicaQa;
      Object.assign(qa.localRecords[0], { title: "QA99-Late-A", content: "QA99 A late-save original." });
      Object.assign(qa.localRecords[1], { title: "QA99-Late-B", content: "QA99 B must remain reading 中文😀." });
      qa.openLocal("note-qa-local-0");
    });
    await page.locator(active + " .st-note-prose p").first().tap();
    await page.evaluate(() => { window.__replicaQa.deferNextLocalSave = true; });
    await saveIdentityEdit(page, "\nQA99 A delayed completion");
    await page.waitForFunction(() => document.querySelector('.st-detail-stage[data-current="true"]')?.textContent.includes("未保存"));
    await page.evaluate(() => window.dispatchEvent(new Event("luckyray:desktop-note-back", { cancelable: true })));
    await page.waitForFunction(() => window.__replicaQa.localSavePending === "note-qa-local-0");
    await page.evaluate(() => window.__replicaQa.openLocal("note-qa-local-1", true));
    await page.waitForFunction(() => document.querySelector('.st-detail-stage[data-current="true"] .st-note-title')?.value === "QA99-Late-B");
    evidence.coveredOwners = await identityOwners(page);
    await page.evaluate(() => window.__replicaQa.releaseLocalSave());
    await page.waitForTimeout(450);
    assert.equal(await page.locator(active + " .st-note-title").inputValue(), "QA99-Late-B", "a previously current page's awaited flush cannot pop the new current page");
    assert.equal(await page.locator(active + ' [contenteditable="true"]').count(), 0);
    assert.match(await page.locator(active + " .st-note-prose").textContent(), /B must remain reading/);
    evidence.writes = await writes(page);
    assert.equal(evidence.writes.length, 1);
    assert.equal(evidence.writes[0].args.noteId, "note-qa-local-0");
    assert.equal(evidence.writes[0].args.content, "QA99 A late-save original.\nQA99 A delayed completion");
    // A normal Back still acts on actual current B after retirement of A's
    // old request; no global Back disable or lost retained owner.
    await page.evaluate(() => window.dispatchEvent(new Event("luckyray:desktop-note-back", { cancelable: true })));
    await page.waitForFunction(() => document.querySelector('.st-detail-stage[data-current="true"] .st-note-title')?.value === "QA99-Late-A");
    assert.equal((await identityOwners(page)).filter(owner => owner.title === "QA99-Late-A").length, 1);
    assert.equal((await writes(page)).length, 1);
  });
});

test("currentness: a covered local page's late new-note intent cannot navigate or enter editing", async () => {
  await run("C5-local-late-new-retired", async (page, evidence) => {
    await page.evaluate(() => {
      const qa = window.__replicaQa;
      Object.assign(qa.localRecords[0], { title: "QA99-New-A", content: "QA99 A save before new." });
      Object.assign(qa.localRecords[1], { title: "QA99-New-B", content: "QA99 B reading must survive." });
      qa.openLocal("note-qa-local-0");
    });
    await page.locator(active + " .st-note-prose p").first().tap();
    await page.evaluate(() => { window.__replicaQa.deferNextLocalSave = true; });
    await saveIdentityEdit(page, "\nQA99 delayed new intent");
    await page.waitForFunction(() => document.querySelector('.st-detail-stage[data-current="true"]')?.textContent.includes("未保存"));
    await page.locator(active).getByRole("button", { name: "新建笔记", exact: true }).tap();
    await page.waitForFunction(() => window.__replicaQa.localSavePending === "note-qa-local-0");
    await page.evaluate(() => window.__replicaQa.openLocal("note-qa-local-1", true));
    await page.waitForFunction(() => document.querySelector('.st-detail-stage[data-current="true"] .st-note-title')?.value === "QA99-New-B");
    await page.evaluate(() => window.__replicaQa.releaseLocalSave());
    await page.waitForTimeout(450);
    evidence.creates = await page.evaluate(() => window.__replicaQa.calls.filter(call => call.cmd === "local_note_add"));
    assert.deepEqual(evidence.creates, [], "a hidden page's retired new-note request must not create or enter another editor");
    assert.equal(await page.locator(active + " .st-note-title").inputValue(), "QA99-New-B");
    assert.equal(await page.locator(active + ' [contenteditable="true"]').count(), 0);
    assert.match(await page.locator(active + " .st-note-prose").textContent(), /B reading must survive/);
    evidence.writes = await writes(page);
    assert.equal(evidence.writes.length, 1);
    assert.equal(evidence.writes[0].args.noteId, "note-qa-local-0");
  });
});

test("currentness: live Desktop currentness preserves the retained reading owner and second search hit", async () => {
  await run("C6-desktop-reading-retained", async (page, evidence) => {
    const body = await page.evaluate(() => {
      const qa = window.__replicaQa, a = qa.records[0];
      const body = Array.from({ length: 28 }, (_, i) => `P${i + 1} QA99 Desktop reading ${i === 5 || i === 23 ? "QA99-DESK-OLD" : "plain"}.`).join("\n\n");
      Object.assign(a, { title: "QA99-Desk-Read-A", content: body });
      a.cachedDocument.title = a.serverDocument.title = a.title;
      a.cachedDocument.content = a.serverDocument.content = body;
      Object.assign(qa.localRecords[1], { title: "QA99-Desk-Read-B", content: "QA99 B reading." });
      qa.openRead(a.noteId);
      return body;
    });
    await page.locator(active + " .st-note-prose").waitFor();
    await page.locator(active).getByRole("button", { name: "查找笔记", exact: true }).tap();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("searchbox").fill("QA99-DESK-OLD");
    await dialog.locator('.st-note-row[data-note-id="n000"]').tap();
    await dialog.waitFor({ state: "detached" });
    await page.locator(active).getByRole("button", { name: "下一处匹配", exact: true }).tap();
    const hit = page.locator(active + " .st-note-find-hit.is-current");
    assert.equal(await hit.getAttribute("data-note-source-start"), String(body.lastIndexOf("QA99-DESK-OLD")));
    await page.evaluate(() => {
      window.__qaRetainedDesktopReader = document.querySelector('.st-detail-stage[data-current="true"] .st-note-prose');
      window.__qaRetainedDesktopHit = document.querySelector('.st-detail-stage[data-current="true"] .st-note-find-hit.is-current');
    });
    evidence.before = await page.locator(active + " .st-note-paper").evaluate(el => el.scrollTop);
    await page.evaluate(() => window.__replicaQa.openLocal("note-qa-local-1", true));
    await page.waitForFunction(() => document.querySelector('.st-detail-stage[data-current="true"] .st-note-title')?.value === "QA99-Desk-Read-B");
    assert.equal(await page.evaluate(() => document.contains(window.__qaRetainedDesktopHit)), true, "covered Desktop A retains actual parsed reading children, not just its outer paper");
    await page.evaluate(() => window.dispatchEvent(new Event("luckyray:desktop-note-back", { cancelable: true })));
    await page.waitForFunction(() => document.querySelector('.st-detail-stage[data-current="true"] .st-note-title')?.value === "QA99-Desk-Read-A");
    assert.equal(await page.evaluate(() => document.querySelector('.st-detail-stage[data-current="true"] .st-note-prose') === window.__qaRetainedDesktopReader), true, "live page identity must not unmount frozen reading contents");
    assert.equal(await page.evaluate(() => document.querySelector('.st-detail-stage[data-current="true"] .st-note-find-hit.is-current') === window.__qaRetainedDesktopHit), true);
    assert.equal(await hit.getAttribute("data-note-source-start"), String(body.lastIndexOf("QA99-DESK-OLD")));
    evidence.after = await page.locator(active + " .st-note-paper").evaluate(el => el.scrollTop);
    assert.ok(Math.abs(evidence.before - evidence.after) < 3);
    assert.deepEqual(await writes(page), []);
  });
});

test("currentness: current Desktop B keeps delayed and failed saves, then returns once after a successful explicit retry", async () => {
  await run("C7-desktop-delayed-failed-back", async (page, evidence) => {
    await page.evaluate(() => {
      const qa = window.__replicaQa, b = qa.records[0];
      Object.assign(qa.localRecords[0], { title: "QA99-Desk-Save-A", content: "QA99 retained A untouched." });
      Object.assign(b, { title: "QA99-Desk-Save-B", content: "QA99 desktop B original 中文😀." });
      b.cachedDocument.title = b.serverDocument.title = b.title;
      b.cachedDocument.content = b.serverDocument.content = b.content;
      qa.openLocal("note-qa-local-0");
    });
    await page.locator(active + " .st-note-prose").waitFor();
    await page.evaluate(() => window.__replicaQa.openRead("n000", true));
    await page.waitForFunction(() => document.querySelector('.st-detail-stage[data-current="true"] .st-note-title')?.value === "QA99-Desk-Save-B");
    await page.locator(active + " .st-note-prose p").first().tap();
    await page.evaluate(() => { window.__replicaQa.deferNextEdit = true; });
    const draft = "QA99 desktop B original 中文😀.\nQA99 desktop delayed";
    await saveIdentityEdit(page, "\nQA99 desktop delayed");
    await page.waitForFunction(() => window.__replicaQa.desktopSavePending === "n000");
    assert.equal(await page.evaluate(() => !window.dispatchEvent(new Event("luckyray:desktop-note-back", { cancelable: true }))), true);
    await page.waitForTimeout(450);
    assert.equal(await page.locator(active + " .st-note-title").inputValue(), "QA99-Desk-Save-B");
    assert.equal(await page.locator(active + " .st-note-editor").evaluate(el => el.__cmHandle.getValue()), draft);
    await page.evaluate(() => window.__replicaQa.releaseEdit(false));
    await page.waitForFunction(() => document.querySelector('.st-detail-stage[data-current="true"]')?.textContent.includes("手机尚未保存成功"));
    await page.waitForTimeout(450);
    assert.equal(await page.locator(active + " .st-note-title").inputValue(), "QA99-Desk-Save-B");
    await page.screenshot({ path: resolve(out, "C7-desktop-failure-stays-B.png") });
    // Desktop's existing save contract retries by a new explicit edit, not by
    // silently treating a failed receipt as saved on Back.
    await page.evaluate(() => { window.__replicaQa.deferNextEdit = true; });
    await saveIdentityEdit(page, " QA99 retry");
    await page.waitForFunction(() => window.__replicaQa.desktopSavePending === "n000");
    await page.evaluate(() => {
      window.dispatchEvent(new Event("luckyray:desktop-note-back", { cancelable: true }));
      window.dispatchEvent(new Event("luckyray:desktop-note-back", { cancelable: true }));
    });
    await page.evaluate(() => window.__replicaQa.releaseEdit());
    await page.waitForFunction(() => document.querySelector('.st-detail-stage[data-current="true"] .st-note-title')?.value === "QA99-Desk-Save-A");
    await page.waitForTimeout(450);
    assert.equal(await page.locator(active + " .st-note-title").inputValue(), "QA99-Desk-Save-A");
    evidence.writes = await writes(page);
    assert.equal(evidence.writes.length, 2);
    assert.ok(evidence.writes.every(call => call.cmd === "content_note_edit" && call.args.id === "n000"));
    assert.equal(evidence.writes[0].args.content, draft);
    assert.equal(evidence.writes[1].args.content, draft + " QA99 retry");
    assert.equal(await page.evaluate(() => window.__replicaQa.records[0].content), draft + " QA99 retry");
  });
});

test("currentness: a durable create finishing after its origin is covered cannot steal B's page or focus", async () => {
  await run("C8-late-created-note-no-navigation", async (page, evidence) => {
    await page.evaluate(() => {
      const qa = window.__replicaQa;
      Object.assign(qa.localRecords[0], { title: "QA99-Create-A", content: "QA99 origin A clean." });
      Object.assign(qa.localRecords[1], { title: "QA99-Create-B", content: "QA99 B keeps reading 中文😀." });
      qa.openLocal("note-qa-local-0");
    });
    await page.locator(active + " .st-note-prose").waitFor();
    await page.evaluate(() => { window.__replicaQa.deferNextCreate = true; });
    await page.locator(active).getByRole("button", { name: "新建笔记", exact: true }).tap();
    await page.waitForFunction(() => window.__replicaQa.createPending === true);
    await page.evaluate(() => window.__replicaQa.openLocal("note-qa-local-1", true));
    await page.waitForFunction(() => document.querySelector('.st-detail-stage[data-current="true"] .st-note-title')?.value === "QA99-Create-B");
    await page.evaluate(() => window.__replicaQa.releaseCreate());
    await page.waitForTimeout(450);
    assert.equal(await page.locator(active + " .st-note-title").inputValue(), "QA99-Create-B", "saving a created note does not authorize a hidden origin to navigate or enter editing");
    assert.equal(await page.locator(active + ' [contenteditable="true"]').count(), 0);
    assert.match(await page.locator(active + " .st-note-prose").textContent(), /B keeps reading/);
    evidence.creates = await page.evaluate(() => window.__replicaQa.calls.filter(call => call.cmd === "local_note_add"));
    assert.equal(evidence.creates.length, 1);
    assert.equal(await page.evaluate(() => window.__replicaQa.localRecords.filter(n => n.noteId === "note-qa-created-5").length), 1, "the already committed QA note remains; no save rollback or data loss");
    assert.deepEqual(await writes(page), []);
    await page.evaluate(() => window.dispatchEvent(new Event("luckyray:desktop-note-back", { cancelable: true })));
    await page.waitForFunction(() => document.querySelector('.st-detail-stage[data-current="true"] .st-note-title')?.value === "QA99-Create-A");
    assert.equal((await identityOwners(page)).filter(owner => owner.title === "QA99-Create-A").length, 1);
  });
});
test("search: picking the current local note stays in reading at its body match, no editable focus", async () => {
  await run("S1-local-same-note-reading", async (page, evidence) => {
    await openSyntheticRead(page, "local");
    await page.locator(active).getByRole("button", { name: "查找笔记", exact: true }).tap();
    await page.getByRole("dialog").getByRole("searchbox").fill("QA99-NEEDLE");
    await page.getByRole("dialog").locator(".st-note-row").first().tap();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    evidence.readerCount = await page.locator(active + " .st-note-prose").count();
    evidence.focusTrace = await page.evaluate(() => window.__qaFocusTrace);
    evidence.focus = await page.evaluate(() => ({ tag: document.activeElement.tagName, editable: document.activeElement.matches('input,textarea,[contenteditable="true"]') }));
    evidence.writes = await writes(page);
    assert.equal(evidence.readerCount, 1, "search must not replace reading with the editor");
    assert.equal(evidence.focus.editable, false, "a result is a reading intent, not a keyboard request");
    assert.deepEqual(evidence.writes, []);
  });
});
test("search: reading highlights and previous/next reveal the body match without entering input", async () => {
  await run("S2-reading-match-navigation", async (page, evidence) => {
    await openSyntheticRead(page, "local");
    await page.locator(active).getByRole("button", { name: "查找笔记", exact: true }).tap();
    await page.getByRole("dialog").getByRole("searchbox").fill("QA99-NEEDLE");
    await page.getByRole("dialog").locator(".st-note-row").first().tap();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    const reader = page.locator(active + " .st-note-prose");
    assert.equal(await reader.getByRole("group", { name: "正文查找" }).count(), 1);
    const hit = reader.locator(".st-note-find-hit.is-current");
    await hit.waitFor();
    evidence.first = await hit.evaluate(el => ({ text: el.textContent, from: Number(el.dataset.noteSourceStart), y: el.getBoundingClientRect().top }));
    assert.equal(evidence.first.text, "QA99-NEEDLE"); assert.ok(evidence.first.y > 120 && evidence.first.y < 700);
    await reader.getByRole("button", { name: "下一处匹配", exact: true }).tap();
    evidence.next = await hit.evaluate(el => ({ from: Number(el.dataset.noteSourceStart), y: el.getBoundingClientRect().top }));
    assert.ok(evidence.next.from > evidence.first.from); assert.ok(evidence.next.y > 120 && evidence.next.y < 700);
    await reader.getByRole("button", { name: "上一处匹配", exact: true }).tap();
    assert.equal(await hit.getAttribute("data-note-source-start"), String(evidence.first.from));
    assert.equal(await page.locator(active + ' [contenteditable="true"]').count(), 0);
    assert.deepEqual(await writes(page), []);
  });
});
test("search: scoped Desktop reading preserves highlight and previous/next without editor focus", async () => {
  await run("S3-desktop-reading-match", async (page, evidence) => {
    await openSyntheticRead(page, "desktop");
    await page.locator(active).getByRole("button", { name: "查找笔记", exact: true }).tap();
    await page.getByRole("dialog").getByRole("searchbox").fill("QA99-NEEDLE");
    await page.getByRole("dialog").locator(".st-note-row").first().tap();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    const reader = page.locator(active + " .st-note-prose");
    assert.equal(await reader.count(), 1);
    assert.equal(await reader.getByRole("group", { name: "正文查找" }).count(), 1);
    const hit = reader.locator(".st-note-find-hit.is-current");
    await hit.waitFor();
    evidence.first = await hit.getAttribute("data-note-source-start");
    await reader.getByRole("button", { name: "下一处匹配", exact: true }).tap();
    evidence.next = await hit.getAttribute("data-note-source-start");
    assert.ok(Number(evidence.next) > Number(evidence.first));
    assert.equal(await page.locator(active + ' [contenteditable="true"]').count(), 0);
    assert.deepEqual(await writes(page), []);
  });
});
test("search: a title-only result with an empty body stays reading and explains the match", async () => {
  await run("S4-empty-title-hit", async (page, evidence) => {
    await openSyntheticRead(page, "local");
    await page.evaluate(() => Object.assign(window.__replicaQa.localRecords[1], { title: "QA99-ONLY-TITLE", content: "" }));
    await page.locator(active).getByRole("button", { name: "查找笔记", exact: true }).tap();
    await page.getByRole("dialog").getByRole("searchbox").fill("QA99-ONLY-TITLE");
    await page.getByRole("dialog").locator(".st-note-row").first().tap();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    const reader = page.locator(active + " .st-note-prose");
    await reader.waitFor();
    evidence.copy = await reader.textContent();
    assert.match(evidence.copy, /仅标题命中/);
    assert.equal(await reader.getByRole("button", { name: "下一处匹配", exact: true }).isDisabled(), true);
    assert.equal(await page.locator(active + ' [contenteditable="true"]').count(), 0);
    await page.locator(active).getByRole("textbox", { name: "笔记标题", exact: true }).tap();
    assert.equal(await page.locator(active + ' .st-note-title').evaluate(el => el === document.activeElement), true);
    assert.equal(await page.locator(active + ' [contenteditable="true"]').count(), 1);
    assert.deepEqual(await writes(page), []);
  });
});
test("search: another local result opens reading; closing find retains the visible passage, body tap alone starts input", async () => {
  await run("S5-other-note-close-and-tap", async (page, evidence) => {
    await openSyntheticRead(page, "local");
    await page.evaluate(() => {
      const qa = window.__replicaQa;
      Object.assign(qa.localRecords[1], { title: "QA99-Other-Long", content: qa.localRecords[0].content });
      qa.localRecords[0].content = "QA99 original source without query";
    });
    await page.locator(active).getByRole("button", { name: "查找笔记", exact: true }).tap();
    await page.getByRole("dialog").getByRole("searchbox").fill("QA99-NEEDLE");
    await page.getByRole("dialog").locator('.st-note-row[data-note-id="note-qa-local-1"]').tap();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    const reader = page.locator(active + " .st-note-prose"); await reader.waitFor();
    assert.equal(await page.locator(active + ' .st-note-title').inputValue(), "QA99-Other-Long");
    const passage = reader.locator("p").filter({ hasText: "P16 synthetic" });
    evidence.beforeCloseY = await passage.evaluate(el => el.getBoundingClientRect().top);
    await reader.getByRole("button", { name: "关闭正文查找", exact: true }).tap();
    await reader.getByRole("group", { name: "正文查找" }).waitFor({ state: "detached" });
    evidence.afterCloseY = await passage.evaluate(el => el.getBoundingClientRect().top);
    assert.ok(Math.abs(evidence.afterCloseY - evidence.beforeCloseY) < 3, "closing find must not move the visible reading passage");
    assert.equal(await page.locator(active + ' [contenteditable="true"]').count(), 0);
    await passage.tap();
    await page.locator(active + ' [contenteditable="true"]').waitFor();
    evidence.editor = await page.locator(active + ' .st-note-editor').evaluate(el => ({ focus: el.__cmHandle.hasFocus(), selection: el.__cmHandle.getSelection(), body: el.__cmHandle.getValue() }));
    assert.equal(evidence.editor.focus, true);
    const paragraph = evidence.editor.body.indexOf("P16 synthetic");
    assert.ok(evidence.editor.selection.start >= paragraph && evidence.editor.selection.start < paragraph + 80);
    assert.deepEqual(await writes(page), []);
  });
});
test("local Wiki: parsed display alias opens the stable target in reading and Back returns to the same source", async () => {
  await run("W1-local-alias-navigation", async (page, evidence) => {
    await page.evaluate(() => {
      const qa = window.__replicaQa;
      Object.assign(qa.localRecords[0], { title: "QA99-Wiki-Source", content: "QA99 source.\n\n[[QA99-Wiki-Target|本机目标别名]]\n\nQA99 source end." });
      Object.assign(qa.localRecords[1], { title: "QA99-Wiki-Target", content: "QA99 target body 中文😀" });
      Object.assign(qa.localRecords[2], { title: "本机目标别名", content: "QA99 decoy, must NOT resolve display alias as identity." });
      qa.openLocal(qa.localRecords[0].noteId);
    });
    await page.locator(active + " .st-note-prose").waitFor();
    await page.locator(active).getByRole("button", { name: "本机目标别名", exact: true }).tap();
    await page.waitForFunction(() => document.querySelector('.st-detail-stage[data-current="true"] .st-note-title')?.value === "QA99-Wiki-Target");
    evidence.route = await page.evaluate(() => window.__replicaQa.currentRoute());
    assert.equal(evidence.route.detail, "note-qa-local-1");
    assert.equal(await page.locator(active + ' [contenteditable="true"]').count(), 0);
    assert.match(await page.locator(active + " .st-note-prose").textContent(), /QA99 target body 中文😀/);
    await page.locator(active).getByRole("button", { name: "返回上一页", exact: true }).tap();
    await page.waitForFunction(() => document.querySelector('.st-detail-stage[data-current="true"] .st-note-title')?.value === "QA99-Wiki-Source");
    await page.locator(active).getByRole("button", { name: "本机目标别名", exact: true }).waitFor({ state: "visible" });
    assert.equal(await page.locator(active).getByRole("button", { name: "本机目标别名", exact: true }).count(), 1);
    assert.deepEqual(await writes(page), []);
  });
});
test("local Wiki: duplicate titles require an identity choice, never silently pick the first note", async () => {
  await run("W2-local-duplicate-choice", async (page, evidence) => {
    await page.evaluate(() => {
      const qa = window.__replicaQa;
      Object.assign(qa.localRecords[0], { title: "QA99-Wiki-Source", content: "QA99 [[QA99-Duplicate]] source." });
      Object.assign(qa.localRecords[1], { title: "QA99-Duplicate", content: "QA99 DUPLICATE A" });
      Object.assign(qa.localRecords[2], { title: "QA99-Duplicate", content: "QA99 DUPLICATE B" });
      qa.openLocal(qa.localRecords[0].noteId);
    });
    await page.locator(active + " .st-note-prose").waitFor();
    await page.locator(active).getByRole("button", { name: "QA99-Duplicate", exact: true }).tap();
    const chooser = page.getByRole("dialog", { name: "选择本机笔记", exact: true });
    await chooser.waitFor();
    assert.equal(await page.locator(active + ' .st-note-title').inputValue(), "QA99-Wiki-Source");
    evidence.options = await chooser.locator(".st-option").allTextContents();
    assert.equal(evidence.options.length, 2);
    await page.screenshot({ path: resolve(out, "W2-ambiguity-identities.png") });
    await chooser.getByRole("button", { name: "QA99-Duplicate 本机 · note-qa-local-2", exact: true }).tap();
    await page.waitForFunction(() => window.__replicaQa.currentRoute().detail === "note-qa-local-2");
    assert.match(await page.locator(active + " .st-note-prose").textContent(), /QA99 DUPLICATE B/);
    assert.equal(await page.locator(active + ' [contenteditable="true"]').count(), 0);
    assert.deepEqual(await writes(page), []);
  });
});
test("local Wiki: missing and unsupported directory/anchor targets explain the boundary without input or creation", async () => {
  await run("W3-missing-and-unsupported", async (page, evidence) => {
    await page.evaluate(() => {
      const qa = window.__replicaQa;
      Object.assign(qa.localRecords[0], { title: "QA99-Wiki-Source", content: "QA99 [[QA99-Missing]]\n\n[[folder/QA99-Missing]]\n\n[[QA99-Missing#Heading]]" });
      qa.openLocal(qa.localRecords[0].noteId);
    });
    const reader = page.locator(active + " .st-note-prose"); await reader.waitFor();
    for (const [label, copy] of [["QA99-Missing", "未找到"], ["folder/QA99-Missing", "本机笔记没有目录路径"], ["QA99-Missing#Heading", "暂不支持章节或块定位"]]) {
      await reader.getByRole("button", { name: label, exact: true }).tap();
      await reader.getByRole("status").filter({ hasText: copy }).waitFor();
      assert.equal(await page.locator(active + ' [contenteditable="true"]').count(), 0);
      assert.equal(await page.locator(active + ' .st-note-title').inputValue(), "QA99-Wiki-Source");
    }
    evidence.calls = await page.evaluate(() => window.__replicaQa.calls.filter(c => /local_note_(add|update|delete)/.test(c.cmd)));
    assert.deepEqual(evidence.calls, []);
  });
});
test("local Wiki: root-relative navigation retains a long source passage; explicit stable ID also opens that target", async () => {
  await run("W4-relative-position-and-id", async (page, evidence) => {
    await page.evaluate(() => {
      const qa = window.__replicaQa;
      const paragraphs = Array.from({ length: 35 }, (_, i) => `QA99 Wiki source paragraph P${i + 1}. Read without losing position.`);
      paragraphs[20] += " [[./QA99-Wiki-Target.md|根目录目标]] [[note-qa-local-1|稳定身份目标]]";
      Object.assign(qa.localRecords[0], { title: "QA99-Wiki-Source", content: paragraphs.join("\n\n") });
      Object.assign(qa.localRecords[1], { title: "QA99-Wiki-Target", content: "QA99 true target." });
      qa.openLocal(qa.localRecords[0].noteId);
    });
    const link = page.locator(active).getByRole("button", { name: "根目录目标", exact: true }); await link.scrollIntoViewIfNeeded();
    evidence.before = await page.locator(active + ' .st-note-paper').evaluate(el => el.scrollTop);
    assert.ok(evidence.before > 600);
    await link.tap();
    await page.waitForFunction(() => document.querySelector('.st-detail-stage[data-current="true"] .st-note-title')?.value === "QA99-Wiki-Target");
    await page.locator(active).getByRole("button", { name: "返回上一页", exact: true }).tap();
    await link.waitFor({ state: "visible" });
    evidence.after = await page.locator(active + ' .st-note-paper').evaluate(el => el.scrollTop);
    assert.ok(Math.abs(evidence.before - evidence.after) < 3);
    await page.locator(active).getByRole("button", { name: "稳定身份目标", exact: true }).tap();
    await page.waitForFunction(() => document.querySelector('.st-detail-stage[data-current="true"] .st-note-title')?.value === "QA99-Wiki-Target");
    assert.equal(await page.locator(active + ' [contenteditable="true"]').count(), 0);
    assert.deepEqual(await writes(page), []);
  });
});
test("toolbar: visible touch strip leaves an edge gutter, internal pan preserves selection/focus; intentional collapse remains allowed", async () => {
  await run("G1-toolbar-safe-gutter", async (page, evidence) => {
    await openSyntheticRead(page, "local");
    await page.locator(active + " .st-note-prose p").first().tap();
    await page.locator(active + ' [contenteditable="true"]').waitFor();
    await page.setViewportSize({ width: 392, height: 450 }); // Browser compact viewport, NOT native IME proof.
    const toolbar = page.locator(active).getByRole("toolbar", { name: "编辑工具，可左右滑动", exact: true });
    await toolbar.waitFor();
    evidence.bounds = await toolbar.boundingBox();
    assert.ok(evidence.bounds.x >= 24, "a visible strip must not invite a pan inside the observed MI8 system edge zone");
    const editor = page.locator(active + ' .st-note-editor');
    await editor.evaluate(el => el.__cmHandle.setSelection({ start: 4, end: 12 }));
    const snapshot = () => editor.evaluate(el => ({ body: el.__cmHandle.getValue(), selection: el.__cmHandle.getSelection(), focus: el.__cmHandle.hasFocus() }));
    evidence.before = await snapshot();
    await page.screenshot({ path: resolve(out, "G1-toolbar-before-pan.png") });
    const session = await page.context().newCDPSession(page), box = evidence.bounds, y = box.y + box.height / 2;
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width - 20, y }] });
    for (const fraction of [.75, .5, .25, .05]) await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: box.x + box.width * fraction, y }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await session.detach();
    await page.waitForFunction(() => document.querySelector('.st-detail-stage[data-current="true"] .st-editor-tools')?.scrollLeft > 50);
    evidence.after = await snapshot();
    await page.screenshot({ path: resolve(out, "G1-toolbar-after-pan.png") });
    assert.deepEqual(evidence.after, evidence.before);
    assert.equal(await page.locator(active + ' .st-note-title').inputValue(), "QA99-REPAIR-Long");
    await toolbar.getByRole("button", { name: "收起编辑工具", exact: true }).tap();
    await toolbar.waitFor({ state: "hidden" });
    assert.equal((await snapshot()).focus, false);
    assert.equal(await page.locator(active + ' .st-note-title').inputValue(), "QA99-REPAIR-Long");
    assert.deepEqual(await writes(page), []);
  });
});
test("local Wiki: leaving the source retires a delayed catalog read before target fetch or navigation", async () => {
  await run("W5-retired-local-source", async (page, evidence) => {
    await page.evaluate(() => {
      const qa = window.__replicaQa;
      Object.assign(qa.localRecords[0], { title: "QA99-Wiki-Source", content: "QA99 [[QA99-Wiki-Target]] source." });
      Object.assign(qa.localRecords[1], { title: "QA99-Wiki-Target", content: "QA99 target" });
      qa.openLocal(qa.localRecords[0].noteId);
    });
    await page.locator(active + " .st-note-prose").waitFor();
    await page.evaluate(() => { window.__replicaQa.deferLocalWikiList = true; });
    await page.locator(active).getByRole("button", { name: "QA99-Wiki-Target", exact: true }).tap();
    await page.waitForFunction(() => typeof window.__replicaQa.releaseLocalWikiList === "function");
    await page.locator(active).getByRole("button", { name: "返回上一页", exact: true }).tap();
    await page.waitForFunction(() => !window.__replicaQa.currentRoute().detail);
    await page.evaluate(async () => { window.__replicaQa.releaseLocalWikiList(); await new Promise(requestAnimationFrame); });
    evidence.route = await page.evaluate(() => window.__replicaQa.currentRoute());
    evidence.targetGets = await page.evaluate(() => window.__replicaQa.calls.filter(c => c.cmd === "local_note_get" && c.args.noteId === "note-qa-local-1"));
    assert.equal(evidence.route.detail, undefined);
    assert.deepEqual(evidence.targetGets, []);
    assert.deepEqual(await writes(page), []);
  });
});
test("local Wiki: dismissing an ambiguity chooser does not fall through into body editing", async () => {
  await run("W6-choice-cancel-keeps-reading", async (page, evidence) => {
    await page.evaluate(() => {
      const qa = window.__replicaQa;
      Object.assign(qa.localRecords[0], { title: "QA99-Wiki-Source", content: "QA99 [[QA99-Duplicate]] source." });
      for (const n of qa.localRecords.slice(1, 3)) Object.assign(n, { title: "QA99-Duplicate", content: "QA99 duplicate" });
      qa.openLocal(qa.localRecords[0].noteId);
    });
    await page.locator(active).getByRole("button", { name: "QA99-Duplicate", exact: true }).tap();
    await page.getByRole("dialog", { name: "选择本机笔记", exact: true }).waitFor();
    await page.locator(active + " .st-scrim").tap({ position: { x: 50, y: 80 } });
    await page.getByRole("dialog").waitFor({ state: "detached" });
    evidence.readerCount = await page.locator(active + " .st-note-prose").count();
    assert.equal(evidence.readerCount, 1);
    assert.equal(await page.locator(active + ' [contenteditable="true"]').count(), 0);
    assert.deepEqual(await writes(page), []);
  });
});
