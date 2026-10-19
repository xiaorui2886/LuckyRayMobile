// Real production page navigation. Native external IPC/resources are synthetic;
// this does not claim to reproduce or accept an old Android compositor in Edge.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
const { chromium } = createRequire(import.meta.url)(process.env.LUCKYRAY_QA_PLAYWRIGHT || "playwright");
const built = resolve(process.env.LUCKYRAY_QA_BUNDLE || "output/playwright/mobile-materials-r1/production");
const out = resolve(process.env.LUCKYRAY_QA_OUT || "output/playwright/mobile-materials-r1/pages");
const report = {kind: "production-StillApp-materials-synthetic-native-boundary-not-Android-UAT", cases: [], errors: []};
const active = '.st-detail-stage[data-current="true"]';
let browser, server, url;
mkdirSync(out, {recursive: true});
before(async () => {
  const assets = new Map([
    ["/bundle.js", [resolve(built, "bundle.js"), "text/javascript"]],
    ["/luckyray-mobile.css", [resolve(built, "luckyray-mobile.css"), "text/css"]],
    ["/production-base.css", [resolve(dirname(built), "production-base.css"), "text/css"]],
  ]);
  server = createServer((req, res) => {
    const u = new URL(req.url, "http://localhost");
    const a = assets.get(u.pathname);
    if (a) {res.setHeader("Content-Type", a[1]); res.end(readFileSync(a[0])); return;}
    if (/^\/synthetic-image\/asset-\d+$/.test(u.pathname)) {
      res.setHeader("Content-Type", "image/svg+xml");
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="#688b80"/><circle cx="200" cy="180" r="85" fill="#f0d0a3"/><path d="M0 400 390 85 640 400Z" fill="#284c52"/></svg>'); return;
    }
    if (u.pathname !== "/") {res.writeHead(404); res.end(); return;}
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/production-base.css"><link rel="stylesheet" href="/luckyray-mobile.css"></head><body><div id="root"></div><script>window.__materialsQa={dark:${u.searchParams.get("dark") === "1"},reduced:${u.searchParams.get("reduced") !== "0"}};</script><script src="/bundle.js"></script></body></html>`);
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({headless: true, executablePath: process.env.LUCKYRAY_QA_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"});
});
after(async () => {
  try {await browser?.close();} finally {if (server) await new Promise(r => server.close(r)); writeFileSync(resolve(out, "page-report.json"), JSON.stringify(report, null, 2));}
});
async function runCase(name, run, {width = 392, height = 800, dark = false, reduced = true, legacyMicrotaskLoss = false, webViewChrome = 83} = {}) {
  const context = await browser.newContext({viewport: {width, height}, deviceScaleFactor: 1, hasTouch: true,
    ...(legacyMicrotaskLoss ? {userAgent: `Mozilla/5.0 (Linux; Android 10; MI 8 Build/QKQ1.190828.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/${webViewChrome}.0.4103.101 Mobile Safari/537.36`} : {})});
  if (legacyMicrotaskLoss) await context.addInitScript(() => {
    // OS/browser boundary only: discard one queued callback, as the covered
    // native-return symptom suggests. Real React, shell and detail stay intact.
    const nativeQueue = window.queueMicrotask.bind(window);
    let delayed;
    const platform = window.__materialsMicrotasks = {dropNext: false, dropped: 0,
      replayOriginal() {if (delayed) {nativeQueue(delayed); delayed = undefined;}}};
    window.queueMicrotask = callback => {
      if (platform.dropNext) {platform.dropNext = false; platform.dropped++; delayed = callback; return;}
      nativeQueue(callback);
    };
  });
  context.setDefaultTimeout(8000);
  const page = await context.newPage(); const result = {name, outcome: "RUNNING", evidence: {}}; report.cases.push(result);
  page.on("pageerror", e => report.errors.push(String(e)));
  try {
    await page.goto(`${url}/?dark=${dark ? 1 : 0}&reduced=${reduced ? 1 : 0}`);
    await page.getByRole("button", {name: "电脑", exact: true}).click();
    await page.locator('[data-asset-id="asset-0"]').waitFor();
    await run(page, result.evidence);
    assert.deepEqual(report.errors, [], "no production render error"); result.outcome = "PASS";
  } catch (e) {result.outcome = "FAIL"; result.error = String(e); await page.screenshot({path: resolve(out, name + "-failure.png")}); throw e;}
  finally {await context.close();}
}
async function openAsset(page, id = "asset-0") {
  await page.evaluate(id => window.__materialsQa.openAsset(id), id);
  await page.locator(active + " .st-asset-caption strong").waitFor();
  await page.waitForTimeout(400); // actual production page enter must have settled
}

test("R1: a settled asset masks retained list labels, late thumbnails and data while Back keeps its scroll", async () => {
  await runCase("R1-retained-underlay", async (page, evidence) => {
    const root = page.locator(".st-root-stage");
    const scroller = root.locator(".st-scroll");
    await scroller.evaluate(el => {el.scrollTop = 230;});
    const before = await scroller.evaluate(el => el.scrollTop);
    await openAsset(page);
    await page.evaluate(() => {window.__materialsQa.releaseThumbnails(); window.__materialsQa.bump();});
    await page.locator(active + " .st-asset-area img").waitFor();
    evidence.probe = await page.evaluate(() => {
      const root = document.querySelector(".st-root-stage"), stage = document.querySelector('.st-detail-stage[data-current="true"]');
      return {rootVisibility: getComputedStyle(root).visibility, stageBackground: getComputedStyle(stage).backgroundColor, stageOpacity: getComputedStyle(stage).opacity,
        caption: stage.querySelector(".st-asset-caption").textContent, captionsInCurrentDetail: stage.querySelectorAll(".st-asset-caption").length,
        retainedListLabelCount: root.querySelectorAll("[data-asset-id] strong").length};
    });
    await page.screenshot({path: resolve(out, "R1-detail.png")});
    assert.equal(await root.locator('[data-asset-id="asset-3"] strong').isVisible(), false, "inactive retained list text must not be painted behind a settled detail, even after async list work");
    assert.equal(await root.locator("[data-asset-id]").count(), 30, "retain the real list, not delete its captions");
    assert.equal(evidence.probe.captionsInCurrentDetail, 1);
    assert.match(evidence.probe.caption, /^Pinterest\.png/);
    await page.locator(active).getByRole("button", {name: "返回素材库", exact: true}).click();
    await page.locator(active).waitFor({state: "detached"});
    await root.locator('[data-asset-id="asset-3"] strong').waitFor({state: "visible"});
    assert.equal(await root.locator('[data-asset-id="asset-3"] strong').isVisible(), true);
    assert.equal(await scroller.evaluate(el => el.scrollTop), before, "Back preserves the mounted list and its scroll");
    evidence.retainedScroll = before;
  });
});

test("R2: a compact source preserves its exact URL and grouped 44px actions without flex gap", async () => {
  await runCase("R2-compact-source-no-flex-gap", async (page, evidence) => {
    await openAsset(page);
    await page.evaluate(() => window.__materialsQa.releaseThumbnails());
    const canonical = await page.evaluate(() => window.__materialsQa.pageUrl);
    const primary = page.locator(active + ' [data-testid="source-url"]');
    assert.equal(await primary.getAttribute("href"), canonical);
    assert.equal(await primary.textContent(), "采集页面 · example.org", "main media area shows one concise source link, not two repeated long URLs");
    assert.equal(await page.locator(active).getByRole("button", {name: "复制链接", exact: true}).count(), 0, "source operations live in the existing information sheet");
    await page.locator(active).getByRole("button", {name: "素材信息", exact: true}).click();
    const sheet = page.locator(".st-sheet");
    await sheet.waitFor();
    await page.addStyleTag({content: ".st-source-head,.st-source-actions{gap:0!important}"});
    const link = sheet.locator('[data-testid="source-url"]');
    assert.equal(await link.getAttribute("href"), canonical);
    assert.equal(await link.textContent(), canonical, "full canonical URL remains available in info");
    const actions = sheet.locator(".st-source-actions .st-button");
    assert.equal(await actions.count(), 3);
    const boxes = await actions.evaluateAll(buttons => buttons.map(b => {const r = b.getBoundingClientRect(); return {text: b.textContent, x: r.x, y: r.y, right: r.right, bottom: r.bottom, height: r.height};}));
    for (const b of boxes) assert.ok(b.height >= 44, `${b.text} has a 44px target`);
    for (let i = 1; i < boxes.length; i++) {
      const a = boxes[i - 1], b = boxes[i];
      assert.ok(Math.abs(a.y - b.y) < 2 ? b.x - a.right >= 9 : b.y - a.bottom >= 9, "buttons retain a real gap even on an engine with no flex-gap support");
    }
    evidence.actions = boxes;
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {origin: url});
    await sheet.getByRole("button", {name: "复制链接", exact: true}).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), canonical, "copy uses the canonical bytes, not the displayed hostname");
    await sheet.getByRole("button", {name: "在浏览器打开", exact: true}).click();
    assert.equal(await page.evaluate(() => window.__materialsQa.calls.filter(c => c.cmd === "plugin:opener|open_url").at(-1).args.url), canonical);
    await sheet.getByRole("button", {name: "在电脑打开", exact: true}).click();
    await sheet.locator('[data-testid="presentation-feedback"]').waitFor();
    assert.equal(await sheet.locator('[data-testid="presentation-feedback"]').textContent(), "已交给电脑处理，正在打开", "a handoff is not a confirmed display");
    evidence.canonical = canonical;
    await page.screenshot({path: resolve(out, "R2-source-info.png")});
  }, {width: 360});
});

test("R3: successive assets replace the detail without stale captions and reveal their retained list on Back", async () => {
  await runCase("R3-replaced-details-motion-dark", async (page, evidence) => {
    await openAsset(page, "asset-0");
    await openAsset(page, "asset-1");
    await page.evaluate(() => window.__materialsQa.releaseThumbnails());
    assert.equal(await page.locator(".st-detail-stage").count(), 1, "production navigation replaces an asset, never invent a stacked asset history");
    assert.equal(await page.locator(active + " .st-asset-caption strong").textContent(), "180 4K.mp4");
    assert.equal(await page.locator(".st-root-stage [data-asset-id] strong").first().isVisible(), false);
    await page.setViewportSize({width: 800, height: 392});
    assert.equal(await page.locator(".st-root-stage [data-asset-id] strong").first().isVisible(), false);
    await page.setViewportSize({width: 392, height: 800});
    await page.locator(active).getByRole("button", {name: "返回素材库", exact: true}).click();
    await page.locator(".st-root-stage [data-asset-id] strong").first().waitFor({state: "visible"});
    await page.locator(".st-detail-stage").waitFor({state: "detached"});
    assert.equal(await page.locator(".st-root-stage [data-asset-id]").count(), 30);
    evidence.returnedLabel = await page.locator('.st-root-stage [data-asset-id="asset-0"] strong').textContent();
    await page.screenshot({path: resolve(out, "R3-returned-list-dark.png")});
  }, {dark: true, reduced: false});
});

test("R4: no-source stays quiet in media, while a permission failure has an explicit working retry", async () => {
  await runCase("R4-source-empty-and-retry", async (page, evidence) => {
    await page.evaluate(() => {window.__materialsQa.noSource = true;});
    await openAsset(page);
    assert.equal(await page.locator(active + ' [data-testid="asset-source-block"]').count(), 0);
    await page.locator(active).getByRole("button", {name: "返回素材库", exact: true}).click();
    await page.locator(active).waitFor({state: "detached"});
    await page.evaluate(() => {window.__materialsQa.noSource = false; window.__materialsQa.sourceError = true;});
    await openAsset(page, "asset-2");
    const retry = page.locator(active).getByRole("button", {name: "重试来源", exact: true});
    await retry.waitFor();
    await page.evaluate(() => {window.__materialsQa.sourceError = false;});
    await retry.click();
    await page.locator(active + ' [data-testid="source-url"]').waitFor();
    assert.equal(await retry.count(), 0);
    evidence.recoveredSource = await page.locator(active + ' [data-testid="source-url"]').getAttribute("href");
  }, {width: 360});
});

test("R5: opt-in native playback is owner-bound, does not acquire a whole file and resumes its returned position", async () => {
  await runCase("R5-native-entry-boundary", async (page, evidence) => {
    await openAsset(page, "asset-1");
    await page.evaluate(() => window.__materialsQa.releaseThumbnails());
    const stage = page.locator(active + " .st-asset-area");
    await stage.getByRole("button", {name: "播放视频", exact: true}).click();
    await stage.getByRole("status").waitFor();
    const launch = await page.evaluate(() => window.__materialsQa.calls.filter(c => c.cmd === "content_video_play").at(-1));
    assert.equal(launch.args.instance, "synthetic-materials-pc");
    assert.equal(launch.args.id, "asset-1");
    assert.equal(launch.args.startPositionMs, 0);
    assert.equal(await page.evaluate(() => window.__materialsQa.calls.some(c => c.cmd === "content_asset_file")), false, "watching has no full-download prerequisite");
    assert.equal(Object.hasOwn(launch.args, "url"), false, "native authority, not a free URL proxy");
    await page.evaluate(() => window.__materialsQa.closeNative({reason: "back", positionMs: 42500, durationMs: 120000, firstFrameMs: 780, remoteBytesBeforeFirstFrame: 8388608, remoteBytes: 8388608, sizeBytes: 2412888064, transport: "lan", completeOffline: false, format: {videoMime: "video/avc", audioMime: "audio/mp4a-latm", videoDecoder: "synthetic.avc", audioDecoder: "synthetic.aac", width: 1920, height: 1080, audioAdvancing: true, rangeRetries: 0}}));
    await stage.getByRole("button", {name: "播放视频", exact: true}).waitFor();
    await page.locator(active).getByRole("button", {name: "素材信息", exact: true}).click();
    assert.match(await page.locator(".st-sheet").textContent(), /原文件尚未保存到手机/, "partial playback never becomes offline-complete");
    const receipt = await page.locator(".st-sheet").textContent();
    assert.match(receipt, /8388608 \/ 2412888064 B/, "development receipt preserves exact received bytes and source length");
    assert.match(receipt, /video\/avc · 1920×1080/);
    assert.match(receipt, /synthetic\.aac/);
    assert.match(receipt, /音轨推进（不代表实听）/, "decoder progress is never mislabeled as a human sound check");
    await page.locator(".st-sheet").getByRole("button", {name: "收起素材信息", exact: true}).click();
    await page.locator(".st-sheet").waitFor({state: "detached"});
    await stage.getByRole("button", {name: "播放视频", exact: true}).click();
    assert.equal(await page.evaluate(() => window.__materialsQa.nativeSession.args.startPositionMs), 42500);
    await page.evaluate(() => window.__materialsQa.back());
    await page.locator(active).waitFor({state: "detached"});
    assert.equal(await page.evaluate(() => window.__materialsQa.calls.some(c => c.cmd === "content_cancel" && c.args.jobId === window.__materialsQa.calls.filter(c => c.cmd === "content_video_play").at(-1).args.jobId)), true);
    evidence.launch = launch.args; evidence.closedPositionMs = 42500;
  });
});

test("R12: normal playback returns to clean original Info and source actions without requiring a full save", async () => {
  await runCase("R12-normal-native-clean-info", async (page, evidence) => {
    await openAsset(page, "asset-1");
    await page.evaluate(() => window.__materialsQa.releaseThumbnails());
    const stage = page.locator(active + " .st-asset-area");
    await stage.getByRole("button", {name: "播放视频", exact: true}).click();
    await stage.getByRole("status").waitFor();
    const launch = await page.evaluate(() => window.__materialsQa.nativeSession.args);
    assert.equal(launch.instance, "synthetic-materials-pc");
    assert.equal(launch.id, "asset-1");
    assert.equal(Object.hasOwn(launch, "url"), false, "normal playback keeps the native owner-bound authority");
    assert.equal(await page.evaluate(() => window.__materialsQa.calls.some(c => c.cmd === "content_asset_file")), false);
    await page.evaluate(() => window.__materialsQa.closeNative({reason: "back", positionMs: 42500,
      durationMs: 120000, firstFrameMs: 780, remoteBytesBeforeFirstFrame: 8388608, remoteBytes: 12582912,
      sizeBytes: 2412888064, rangeRequests: 3, transport: "lan", completeOffline: false,
      format: {videoMime: "video/avc", videoDecoder: "synthetic.avc", audioDecoder: "synthetic.aac",
        width: 1920, height: 1080, audioAdvancing: true, rangeRetries: 0}}));
    await stage.getByRole("button", {name: "播放视频", exact: true}).waitFor();
    await page.locator(active).getByRole("button", {name: "素材信息", exact: true}).click();
    const sheet = page.locator(".st-sheet");
    await sheet.waitFor({state: "visible"});
    const info = await sheet.textContent();
    assert.match(info, /原文件尚未保存到手机/, "partial playback is still not an offline original");
    assert.equal(await sheet.locator(".st-metadata-row").count(), 5, "only the original useful metadata rows remain");
    assert.doesNotMatch(info, /试验|首帧|远端读取|传输回执|Range|解码器|音轨推进|关闭位置|8388608|12582912|42500|synthetic\.avc/);
    const canonical = await page.evaluate(() => window.__materialsQa.pageUrl);
    assert.equal(await sheet.locator('[data-testid="source-url"]').getAttribute("href"), canonical);
    assert.equal(await sheet.locator(".st-source-actions .st-button").count(), 3);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {origin: url});
    await sheet.getByRole("button", {name: "复制链接", exact: true}).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), canonical);
    await sheet.getByRole("button", {name: "在浏览器打开", exact: true}).click();
    assert.equal(await page.evaluate(() => window.__materialsQa.calls.filter(c => c.cmd === "plugin:opener|open_url").at(-1).args.url), canonical);
    await page.screenshot({path: resolve(out, "R12-normal-info.png")});
    await sheet.getByRole("button", {name: "收起素材信息", exact: true}).click();
    await sheet.waitFor({state: "detached"});
    await page.locator(active).getByRole("button", {name: "素材更多操作", exact: true}).first().click();
    await page.locator(".st-sheet").getByRole("button", {name: "完整保存视频供离线使用", exact: true}).waitFor();
    await page.locator(".st-sheet").getByRole("button", {name: "收起素材操作", exact: true}).click();
    await page.locator(".st-sheet").waitFor({state: "detached"});
    await stage.getByRole("button", {name: "播放视频", exact: true}).click();
    await stage.getByRole("status").waitFor();
    assert.equal(await page.evaluate(() => window.__materialsQa.nativeSession.args.startPositionMs), 42500);
    await page.evaluate(() => window.__materialsQa.closeNative({reason: "back", positionMs: 44000, durationMs: 120000}));
    await stage.getByRole("button", {name: "播放视频", exact: true}).waitFor();
    await page.locator(active).getByRole("button", {name: "返回素材库", exact: true}).click();
    await page.locator(active).waitFor({state: "detached"});
    await page.locator('.st-root-stage [data-asset-id="asset-1"]').waitFor({state: "visible"});
    evidence.nativeOwner = launch.instance; evidence.cleanInfo = info;
    evidence.resumedPositionMs = 42500; evidence.fullSaveNotRequired = true;
  });
});

test("R13: normal native failures keep bounded retry guidance without adding a diagnostic panel", async () => {
  await runCase("R13-normal-native-failure", async (page, evidence) => {
    await openAsset(page, "asset-1");
    const stage = page.locator(active + " .st-asset-area");
    for (const [code, copy] of [["MEDIA_CODEC_UNSUPPORTED", "暂不受本机支持"], ["MEDIA_RANGE_HTTP_403", "没有读取这段视频的权限"]]) {
      await stage.getByRole("button", {name: "播放视频", exact: true}).click();
      await stage.getByRole("status").waitFor();
      await page.evaluate(errorCode => window.__materialsQa.closeNative({reason: "unsupported", errorCode,
        positionMs: 0, durationMs: 0, transport: "lan", completeOffline: false, sizeBytes: 2412888064, remoteBytes: 4194304}), code);
      await stage.getByRole("status").filter({hasText: copy}).waitFor();
      await stage.getByRole("button", {name: "播放视频", exact: true}).waitFor();
      await page.locator(active).getByRole("button", {name: "素材信息", exact: true}).click();
      const sheet = page.locator(".st-sheet");
      await sheet.waitFor({state: "visible"});
      assert.equal(await sheet.locator(".st-metadata-row").count(), 5);
      assert.doesNotMatch(await sheet.textContent(), /试验|首帧|远端读取|Range|解码器|4194304/);
      await sheet.getByRole("button", {name: "收起素材信息", exact: true}).click();
      await sheet.waitFor({state: "detached"});
    }
    assert.equal(await page.evaluate(() => window.__materialsQa.calls.some(c => c.cmd === "content_asset_file")), false);
    evidence.codecAndPermissionGuidanceRetained = true; evidence.normalInfoRows = 5;
    await page.screenshot({path: resolve(out, "R13-normal-permission.png")});
  });
});

test("R6: 360/392 light/dark complete details keep long names and enlarged text inside the original page", async () => {
  for (const width of [360, 392]) for (const dark of [false, true]) {
    await runCase(`R6-${width}-${dark ? "dark" : "light"}-large-text`, async (page, evidence) => {
      const name = "LongUnbrokenOriginalFilenameWithoutAnySeparators".repeat(3) + ".png";
      await page.evaluate(name => {window.__materialsQa.records[0].name = name;}, name);
      await openAsset(page);
      await page.evaluate(() => window.__materialsQa.releaseThumbnails());
      await page.addStyleTag({content: ".st-asset-caption strong{font-size:22px!important}.st-asset-caption small{font-size:16px!important}.st-source-link{font-size:20px!important}.st-source-actions .st-button{font-size:20px!important;gap:0!important}"});
      const caption = await page.locator(active + " .st-asset-caption").evaluate(el => ({width: el.clientWidth, scroll: el.scrollWidth, text: el.querySelector("strong").textContent}));
      assert.equal(caption.text, name);
      assert.ok(caption.scroll <= caption.width + 1, "a long unbroken file name must wrap, not escape the full detail");
      const fontFit=await page.locator(active+" .st-asset-caption").evaluate(el=>{
        const title=el.querySelector("strong"), meta=el.querySelector("small");
        const range=document.createRange();range.selectNodeContents(meta);
        return {lineHeight:parseFloat(getComputedStyle(title).lineHeight),fontSize:parseFloat(getComputedStyle(title).fontSize),captionBottom:el.getBoundingClientRect().bottom,metaBottom:range.getBoundingClientRect().bottom};
      });
      assert.ok(fontFit.lineHeight>=fontFit.fontSize,"enlarged title lines do not overlap");
      assert.ok(fontFit.metaBottom<=fontFit.captionBottom,"metadata is not clipped out of the fixed caption");
      assert.equal(await page.locator(active + " .st-asset-caption").count(), 1);
      assert.ok((await page.locator(active + " .st-asset-area").boundingBox()).height >= 120, "media remains the primary area");
      await page.screenshot({path: resolve(out, `R6-${width}-${dark ? "dark" : "light"}-detail.png`)});
      await page.locator(active).getByRole("button", {name: "素材信息", exact: true}).click();
      await page.locator(".st-sheet").waitFor();
      const body = page.locator(".st-sheet-body");
      await body.evaluate(el => {el.scrollTop = el.scrollHeight;});
      const overflow = await body.evaluate(el => ({width: el.clientWidth, scroll: el.scrollWidth}));
      assert.ok(overflow.scroll <= overflow.width + 1, "source info and enlarged actions stay inside the existing scrollable sheet");
      assert.equal(await page.locator(".st-sheet .st-source-actions .st-button").count(), 3);
      evidence.caption = caption; evidence.sheet = overflow;
      await page.screenshot({path: resolve(out, `R6-${width}-${dark ? "dark" : "light"}-info.png`)});
    }, {width, dark});
  }
});

test("R7: real retained library long-press selection survives covered detail work without painting through it", async () => {
  await runCase("R7-retained-selection", async (page, evidence) => {
    const tile = page.locator('.st-root-stage [data-asset-id="asset-0"]');
    const box = await tile.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down(); await page.waitForTimeout(650); await page.mouse.up();
    assert.equal(await tile.getAttribute("aria-pressed"), "true", "real production gesture enters selection");
    const probeNav = () => page.locator('.st-root-stage .st-tab svg').evaluateAll(icons => icons.map(icon => {
      const box = icon.getBoundingClientRect(), style = getComputedStyle(icon);
      return {width: box.width, height: box.height, y: box.y, visibility: style.visibility,
        opacity: style.opacity, color: style.color, stroke: style.stroke};
    }));
    evidence.navBefore = await probeNav();
    assert.equal(evidence.navBefore.length, 5);
    await openAsset(page, "asset-1");
    await page.evaluate(() => {window.__materialsQa.releaseThumbnails(); window.__materialsQa.bump();});
    assert.equal(await tile.isVisible(), false);
    assert.equal(await tile.getAttribute("aria-pressed"), "true", "masking retains state as well as DOM");
    await page.locator(active).getByRole("button", {name: "返回素材库", exact: true}).click();
    await tile.waitFor({state: "visible"});
    await page.locator(active).waitFor({state: "detached"});
    assert.equal(await tile.getAttribute("aria-pressed"), "true");
    await page.waitForFunction(() => {
      const icons = [...document.querySelectorAll('.st-root-stage .st-tab svg')];
      return icons.length === 5 && icons.every(icon => getComputedStyle(icon).visibility === 'visible');
    }, null, {timeout: 1000});
    evidence.navAfter = await probeNav();
    assert.deepEqual(evidence.navAfter, evidence.navBefore, "original navigation paint contract is restored on Back");
    evidence.selectionRetained = true;
    await page.screenshot({path: resolve(out, "R7-returned-selection.png")});
  });
});

test("R8: native failure stays in the media area, never counts a poster as first frame, and distinguishes permission from codec", async () => {
  await runCase("R8-native-failure-retry", async (page, evidence) => {
    await openAsset(page, "asset-1");
    const stage = page.locator(active + " .st-asset-area");
    await stage.getByRole("button", {name: "播放视频", exact: true}).click();
    await page.evaluate(() => window.__materialsQa.closeNative({reason: "unsupported", errorCode: "MEDIA_CODEC_UNSUPPORTED", positionMs: 0, durationMs: 0, transport: "lan", completeOffline: false, sizeBytes: 2412888064, remoteBytes: 4194304}));
    await stage.getByRole("status").filter({hasText: "暂不受本机支持"}).waitFor();
    assert.equal(await page.locator(active + " .st-notice.danger").count(), 0, "do not add a large failure banner to the original media view");
    await page.locator(active).getByRole("button", {name: "素材信息", exact: true}).click();
    assert.match(await page.locator(".st-sheet").textContent(), /未取得首帧/);
    await page.locator(".st-sheet").getByRole("button", {name: "收起素材信息", exact: true}).click();
    await page.locator(".st-sheet").waitFor({state: "detached"});
    await stage.getByRole("button", {name: "播放视频", exact: true}).click();
    await page.evaluate(() => window.__materialsQa.closeNative({reason: "cancelled", errorCode: "MEDIA_RANGE_HTTP_403", positionMs: 0, durationMs: 0, transport: "lan", completeOffline: false, sizeBytes: 2412888064, remoteBytes: 4194304}));
    await stage.getByRole("status").filter({hasText: "没有读取这段视频的权限"}).waitFor();
    evidence.permissionCopy = await stage.getByRole("status").textContent();
    await page.screenshot({path: resolve(out, "R8-permission-retry.png")});
  });
});

test("R9: native return restores detail operations after a legacy WebView loses a queued microtask", async () => {
  await runCase("R9-native-return-lost-microtask", async (page, evidence) => {
    await openAsset(page, "asset-1");
    await page.evaluate(() => window.__materialsQa.releaseThumbnails());
    const stage = page.locator(active + " .st-asset-area");
    await stage.getByRole("button", {name: "播放视频", exact: true}).click();
    await stage.getByRole("status").waitFor();
    await page.evaluate(() => {
      window.__materialsMicrotasks.dropNext = true;
      // A real external connection notification during native coverage.
      window.__materialsQa.setOnline(false);
    });
    assert.equal(await page.evaluate(() => window.__materialsMicrotasks.dropped), 1);
    await page.evaluate(() => window.__materialsQa.closeNative({reason: "back", positionMs: 42500,
      durationMs: 120000, sizeBytes: 2412888064, transport: "lan", completeOffline: false}));
    await page.waitForTimeout(50);
    assert.equal(await stage.getByRole("status").isVisible(), true,
      "fixture reproduces the pending preparing UI before the platform resumes");
    await page.evaluate(() => window.dispatchEvent(new Event("lr:main-resume")));
    await stage.getByRole("button", {name: "播放视频", exact: true}).waitFor();
    await stage.getByRole("status").waitFor({state: "detached"});
    await page.locator(active).getByRole("button", {name: "素材信息", exact: true}).click();
    const sheet = page.locator(".st-sheet");
    await sheet.waitFor({state: "visible"});
    assert.match(await sheet.textContent(), /180 4K\.mp4/);
    await sheet.getByRole("button", {name: "收起素材信息", exact: true}).click();
    await sheet.waitFor({state: "detached"});
    // Public playback boundary proves that the native result committed even
    // when ordinary Info intentionally has no diagnostic position row.
    await stage.getByRole("button", {name: "播放视频", exact: true}).click();
    await stage.getByRole("status").waitFor();
    assert.equal(await page.evaluate(() => window.__materialsQa.nativeSession.args.startPositionMs), 42500);
    await page.evaluate(() => window.__materialsQa.closeNative({reason: "back", positionMs: 44000, durationMs: 120000}));
    await stage.getByRole("button", {name: "播放视频", exact: true}).waitFor();
    await page.locator(active).getByRole("button", {name: "返回素材库", exact: true}).click();
    await page.locator(active).waitFor({state: "detached"});
    await page.locator('.st-root-stage [data-asset-id="asset-1"]').waitFor({state: "visible"});
    evidence.droppedPlatformMicrotasks = 1;
    evidence.nativeReturnRestoredPreparingInfoCloseAndNavigation = true;
    evidence.scope = "real production React root; simulated OS queue loss, not Android lifecycle proof";
    await page.screenshot({path: resolve(out, "R9-returned-library.png")});
  }, {legacyMicrotaskLoss: true});
});

test("R10: repeated legacy resume and a late original callback run outstanding work exactly once", async () => {
  await runCase("R10-resume-exact-once", async (page, evidence) => {
    evidence.jobs = await page.evaluate(async () => {
      const jobs = [], platform = window.__materialsMicrotasks;
      platform.dropNext = true;
      window.queueMicrotask(() => {
        jobs.push("retained");
        window.queueMicrotask(() => jobs.push("nested"));
      });
      window.dispatchEvent(new Event("lr:main-resume"));
      window.dispatchEvent(new Event("lr:main-resume"));
      document.dispatchEvent(new Event("visibilitychange"));
      platform.replayOriginal();
      await new Promise(resolve => setTimeout(resolve, 0));
      window.dispatchEvent(new Event("lr:main-resume"));
      await new Promise(resolve => setTimeout(resolve, 0));
      window.queueMicrotask(() => jobs.push("new"));
      await new Promise(resolve => setTimeout(resolve, 0));
      return jobs;
    });
    assert.deepEqual(evidence.jobs, ["retained", "nested", "new"]);
    assert.equal(await page.evaluate(() => window.__materialsMicrotasks.dropped), 1);
  }, {legacyMicrotaskLoss: true});
});

test("R14: opening a seen card retains its title and thumbnail before the detail network settles", async () => {
  await runCase("R14-card-continuity", async (page, evidence) => {
    await page.evaluate(() => window.__materialsQa.releaseThumbnails());
    const card = page.locator('[data-asset-id="asset-0"]');
    await card.locator("img").waitFor();
    await page.evaluate(() => { window.__materialsQa.deferDetail = true; });
    const started = performance.now();
    await card.click();
    const title = page.locator(active + " .st-asset-caption strong");
    await title.waitFor();
    assert.equal(await title.textContent(), "Pinterest.png", "known card title is visible without waiting for a new read");
    assert.equal(await page.locator(active + " .st-asset-area img").getAttribute("src"), "/synthetic-image/asset-0", "reuse the visible card thumbnail, not an empty media stage");
    evidence.seenCardVisibleMs = performance.now() - started;
    await page.evaluate(() => window.__materialsQa.releaseDetails());
    assert.equal(await title.textContent(), "Pinterest.png");
  });
});

test("R15: late source and metadata do not move the media region or bottom actions", async () => {
  await runCase("R15-stable-detail-geometry", async (page, evidence) => {
    await page.evaluate(() => { window.__materialsQa.releaseThumbnails(); window.__materialsQa.deferSource = true; window.__materialsQa.deferDetail = true; });
    await page.locator('[data-asset-id="asset-0"] img').waitFor();
    await page.locator('[data-asset-id="asset-0"]').click();
    await page.waitForFunction(() => document.querySelector('.st-detail-stage[data-current="true"]')?.classList.contains("is-entered"));
    const geometry = () => page.locator(active).evaluate(el => [".st-asset-area", ".st-asset-actions"].map(s => { const r=el.querySelector(s).getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; }));
    evidence.before = await geometry();
    await page.evaluate(() => {window.__materialsQa.releaseDetails(); window.__materialsQa.releaseSources();});
    await page.locator(active + ' [data-testid="source-url"]').waitFor();
    evidence.after = await geometry();
    assert.deepEqual(evidence.after, evidence.before, "late enrichment cannot shrink media or move reachable actions");
  }, {width:360});
});

test("R16: returning from another root preserves the materials query and scroll without a cold list reload", async () => {
  await runCase("R16-root-context", async (page, evidence) => {
    const search = page.getByPlaceholder("搜索素材");
    await search.fill("Pinterest");
    // Observe the actual final query before scrolling its result. Seeing an
    // unchanged card alone can still be the pre-debounce last-good page.
    await page.waitForFunction(() => window.__materialsQa.calls.filter(c => c.cmd === "content_assets").at(-1)?.args.q === "Pinterest");
    await page.locator('[data-asset-id="asset-0"]').waitFor();
    const scroll = page.locator('.st-root-stage .st-scroll');
    evidence.queryAtScroll = await page.evaluate(() => window.__materialsQa.calls.filter(c => c.cmd === "content_assets").at(-1)?.args.q);
    await scroll.evaluate(el => new Promise(resolve => {
      el.addEventListener("scroll", () => resolve(undefined), {once:true});
      el.scrollTop=220;
    }));
    evidence.before = await scroll.evaluate(el => el.scrollTop);
    assert.equal(evidence.before, 220, "the settled query was genuinely scrolled before leaving");
    await page.evaluate(() => window.__materialsQa.switchRoot("home"));
    await page.getByText("LuckyRay", {exact:true}).waitFor();
    await page.evaluate(() => window.__materialsQa.switchRoot("library"));
    assert.equal(await search.inputValue(), "Pinterest", "Library is not reconstructed with an empty search");
    assert.equal(await page.locator('[data-asset-id="asset-0"]').count(), 1);
    assert.equal(await scroll.evaluate(el => el.scrollTop), evidence.before);
  });
});

test("R17: each source keeps its own search and rapid desktop typing issues only the final bounded read", async () => {
  await runCase("R17-source-search", async (page, evidence) => {
    const search = page.getByPlaceholder("搜索素材");
    const before = await page.evaluate(() => window.__materialsQa.calls.filter(c=>c.cmd==="content_assets").length);
    await search.pressSequentially("abc", {delay:35});
    await page.waitForFunction(() => window.__materialsQa.calls.some(c=>c.cmd==="content_assets" && c.args.q==="abc"));
    evidence.reads = await page.evaluate(before=>window.__materialsQa.calls.filter(c=>c.cmd==="content_assets").slice(before).map(c=>c.args.q), before);
    assert.deepEqual(evidence.reads, ["abc"], "typing should debounce before issuing the real read");
    await page.getByRole("button", {name:"本机",exact:true}).click();
    assert.equal(await search.inputValue(), "", "desktop query must not leak into the local source");
    await search.fill("local-query");
    await page.getByRole("button", {name:"电脑",exact:true}).click();
    assert.equal(await search.inputValue(), "abc", "return to the desktop search context");
  });
});

test("R18: desktop pagination appends deduplicated ordered rows within the same scroll context", async () => {
  await runCase("R18-desktop-pagination", async (page, evidence) => {
    await page.evaluate(() => {window.__materialsQa.paginated=true;});
    await page.getByRole("button", {name:"刷新电脑内容",exact:true}).click();
    await page.waitForFunction(() => document.querySelectorAll("[data-asset-id]").length===20);
    const scroll=page.locator('.st-root-stage .st-scroll');
    await page.getByRole("button", {name:"加载更多",exact:true}).scrollIntoViewIfNeeded();
    evidence.scroll = await scroll.evaluate(el=>el.scrollTop);
    await page.getByRole("button", {name:"加载更多",exact:true}).click();
    await page.locator('[data-asset-id="asset-29"]').waitFor();
    evidence.ids=await page.locator("[data-asset-id]").evaluateAll(rows=>rows.map(el=>el.dataset.assetId));
    assert.deepEqual(evidence.ids, Array.from({length:30},(_,i)=>`asset-${i}`), "duplicate from the next page stays in its first stable position");
    assert.equal(await scroll.evaluate(el=>el.scrollTop), evidence.scroll);
    evidence.pages=await page.evaluate(()=>window.__materialsQa.calls.filter(c=>c.cmd==="content_assets").map(c=>c.args.page));
    assert.equal(evidence.pages.at(-1),2);
  });
});

test("R19: a cached sharp image replaces its seen thumbnail only after successful decode", async () => {
  await runCase("R19-atomic-image", async (page, evidence) => {
    let release;
    const ready=new Promise(resolve=>{release=resolve;});
    await page.route("**/synthetic-image/sharp-0", async route=>{await ready; await route.fulfill({contentType:"image/svg+xml",body:'<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800"><rect width="1280" height="800" fill="#567569"/></svg>'});});
    await page.evaluate(()=>{window.__materialsQa.releaseThumbnails();window.__materialsQa.cachedResource={path:"/synthetic-image/sharp-0",mime:"image/png",etag:'"synthetic-0"'};});
    await page.locator('[data-asset-id="asset-0"] img').waitFor();
    await page.locator('[data-asset-id="asset-0"]').click();
    await page.locator(active + " .st-asset-area img").waitFor();
    evidence.pendingSrc=await page.locator(active + " .st-asset-area img").getAttribute("src");
    assert.equal(evidence.pendingSrc,"/synthetic-image/asset-0","network/cached path availability is not decode-ready: keep the existing pixels");
    release();
    await page.waitForFunction(()=>document.querySelector('.st-detail-stage[data-current="true"] .st-asset-area img')?.getAttribute("src")==="/synthetic-image/sharp-0");
    assert.equal(await page.locator(active + " .st-asset-area img").evaluate(img=>img.complete&&img.naturalWidth>0),true);
    evidence.decoded=true;
  });
});

test("R20: a changed material revision cannot keep its old thumbnail URL", async () => {
  await runCase("R20-version-invalidation", async (page, evidence) => {
    await page.evaluate(()=>window.__materialsQa.releaseThumbnails());
    const image=page.locator('[data-asset-id="asset-0"] img');
    await image.waitFor();
    evidence.before=await image.getAttribute("src");
    await page.evaluate(()=>{window.__materialsQa.records[0].thumbnailRevision="r2";window.__materialsQa.records[0].contentHash="h2";});
    await page.getByRole("button",{name:"刷新电脑内容",exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('[data-asset-id="asset-0"] img')?.getAttribute("src")?.includes("revision=r2"));
    evidence.after=await image.getAttribute("src");
    assert.notEqual(evidence.after,evidence.before);
  });
});

test("R21: a complete large original is displayed only through the bounded native screen derivative", async () => {
  await runCase("R21-bounded-original", async (page, evidence) => {
    await page.route("**/synthetic-image/sharp-0", route => route.fulfill({contentType:"image/svg+xml",body:'<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800"><rect width="1280" height="800" fill="#42796d"/></svg>'}));
    await page.evaluate(() => {
      window.__materialsQa.releaseThumbnails();
      window.__materialsQa.records[0].contentHash="synthetic-content-v1";
      window.__materialsQa.cachedResource={path:"/synthetic-original/huge-24000.png",mime:"image/png",etag:'"synthetic-0"'};
    });
    await openAsset(page);
    await page.waitForFunction(() => window.__materialsQa.calls.some(c=>c.cmd==="asset_thumbnail"&&c.args.preview));
    await page.waitForFunction(() => document.querySelector('.st-detail-stage[data-current="true"] .st-asset-area img')?.getAttribute("src")==="/synthetic-image/sharp-0");
    evidence.previewRead=await page.evaluate(()=>window.__materialsQa.calls.find(c=>c.cmd==="asset_thumbnail"&&c.args.preview));
    assert.equal(evidence.previewRead.args.version,"synthetic-content-v1||");
    assert.equal(await page.locator(active+" .st-asset-area img").getAttribute("src"),"/synthetic-image/sharp-0");
  });
});

test("R22: a primary material access denial retires cached pixels and explicit recovery reloads the same asset", async () => {
  await runCase("R22-access-retirement", async (page, evidence) => {
    await page.evaluate(()=>window.__materialsQa.releaseThumbnails());
    await page.locator('[data-asset-id="asset-0"] img').waitFor();
    await page.locator('[data-asset-id="asset-0"]').click();
    await page.locator(active+" .st-asset-area img").waitFor();
    await page.evaluate(()=>{window.__materialsQa.primaryError="CONTENT_HTTP_403";window.__materialsQa.bump();});
    await page.waitForFunction(()=>document.querySelector('.st-detail-stage[data-current="true"] .st-asset-area img')===null);
    assert.equal(await page.locator(active).getByRole("button",{name:"收藏素材",exact:true}).isDisabled(),true);
    await page.locator(active).getByRole("button",{name:"素材更多操作",exact:true}).first().click();
    await page.evaluate(()=>window.__materialsQa.primaryError="");
    await page.getByRole("button",{name:"重试读取素材",exact:true}).click();
    await page.locator(active+" .st-asset-area img").waitFor();
    assert.equal(await page.locator(active+" .st-asset-caption strong").textContent(),"Pinterest.png");
    evidence.deniedPixelsRetired=true;evidence.recoveredSameAsset=true;
  });
});

test("R23: desktop type filters reach its page API and survive local-source navigation", async () => {
  await runCase("R23-source-type-filter", async (page, evidence) => {
    await page.getByRole("button",{name:"筛选与排序",exact:true}).click();
    await page.locator(".st-sheet").getByRole("button",{name:"视频",exact:true}).click();
    await page.locator('.st-sheet').getByRole("button",{name:"显示结果",exact:true}).click();
    await page.waitForFunction(()=>window.__materialsQa.calls.filter(c=>c.cmd==="content_assets").at(-1).args.kind==="video");
    await page.locator('[data-asset-id="asset-1"]').waitFor();
    assert.equal(await page.locator('.st-root-stage [data-asset-id]').count(),1);
    await page.getByRole("button",{name:"本机",exact:true}).click();
    await page.getByRole("button",{name:"电脑",exact:true}).click();
    await page.locator('[data-asset-id="asset-1"]').waitFor();
    assert.equal(await page.locator('.st-root-stage [data-asset-id]').count(),1);
    evidence.kind=await page.evaluate(()=>window.__materialsQa.calls.filter(c=>c.cmd==="content_assets").at(-1).args.kind);
  });
});

test("R26: transient list failure keeps last-good rows while denied access has an explicit honest retry", async () => {
  await runCase("R26-list-error-recovery",async(page,evidence)=>{
    await page.evaluate(()=>{window.__materialsQa.listError="CONTENT_DISCONNECTED";});
    await page.getByRole("button",{name:"刷新电脑内容",exact:true}).click();
    await page.waitForFunction(()=>window.__materialsQa.calls.filter(c=>c.cmd==="content_assets").length>=2);
    assert.equal(await page.locator('.st-root-stage [data-asset-id]').count(),30,"transient failure preserves last-good content");
    await page.evaluate(()=>{window.__materialsQa.listError="CONTENT_HTTP_403";});
    await page.getByRole("button",{name:"刷新电脑内容",exact:true}).click();
    await page.getByText("暂时读不到素材",{exact:true}).waitFor();
    assert.equal(await page.locator('.st-root-stage [data-asset-id]').count(),0,"a confirmed denial is not an offline-cache bypass");
    assert.equal(await page.getByText("没有找到素材",{exact:true}).count(),0);
    await page.evaluate(()=>{window.__materialsQa.listError="";});
    await page.getByRole("button",{name:"重试读取素材",exact:true}).click();
    await page.locator('[data-asset-id="asset-0"]').waitFor();
    evidence.recoveredRows=await page.locator('.st-root-stage [data-asset-id]').count();
    assert.equal(evidence.recoveredRows,30);
  });
});

test("R27: unconfirmed legacy originals have one bounded validation and never a retry loop or offline fetch", async () => {
  for(const offline of [false,true]) await runCase(`R27-legacy-validation-${offline ? "offline" : "online"}`,async(page,evidence)=>{
    await page.evaluate(offline=>{
      window.__materialsQa.releaseThumbnails();window.__materialsQa.records[0].contentHash="known-version";
      window.__materialsQa.cachedResource={path:"/synthetic-original/old.png",mime:"image/png",etag:'"old"'};
      window.__materialsQa.previewError="CONTENT_VERSION_UNCONFIRMED";
      if(offline) window.__materialsQa.setOnline(false);
    },offline);
    await page.locator('[data-asset-id="asset-0"] img').waitFor();
    await page.locator('[data-asset-id="asset-0"]').click();
    await page.locator(active+" .st-media-feedback").waitFor();
    await page.waitForTimeout(220);
    evidence.validationReads=await page.evaluate(()=>window.__materialsQa.calls.filter(c=>c.cmd==="content_asset_file").length);
    assert.equal(evidence.validationReads,offline ? 0 : 1,"legacy metadata failure cannot silently loop or fetch while offline");
    assert.equal(await page.locator(active+" .st-asset-area img").getAttribute("src"),"/synthetic-image/asset-0");
  });
});

test("R25: a corrupted sharp derivative can be explicitly regenerated without fetching its original", async () => {
  await runCase("R25-preview-recovery", async (page, evidence) => {
    let corrupt=true;
    await page.route("**/synthetic-image/sharp-0*",route=>route.fulfill({contentType:corrupt ? "image/png" : "image/svg+xml",body:corrupt ? Buffer.from("corrupt-derived-bytes") : Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800"><rect width="1280" height="800" fill="#336658"/></svg>'),headers:{"Cache-Control":"no-store"}}));
    await page.evaluate(()=>{window.__materialsQa.releaseThumbnails();window.__materialsQa.records[0].contentHash="same-original";window.__materialsQa.cachedResource={path:"/synthetic-original/large.png",mime:"image/png",etag:'"same"'};});
    await page.locator('[data-asset-id="asset-0"] img').waitFor();
    await page.locator('[data-asset-id="asset-0"]').click();
    await page.locator(active+" .st-media-feedback").filter({hasText:"图片暂时无法显示"}).waitFor();
    assert.equal(await page.locator(active+" .st-asset-area img").getAttribute("src"),"/synthetic-image/asset-0");
    corrupt=false;
    await page.locator(active).getByRole("button",{name:"素材更多操作",exact:true}).first().click();
    await page.getByRole("button",{name:"重试清晰预览",exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.st-detail-stage[data-current="true"] .st-asset-area img')?.getAttribute("src")?.startsWith("/synthetic-image/sharp-0"));
    evidence.forced=await page.evaluate(()=>window.__materialsQa.calls.filter(c=>c.cmd==="asset_thumbnail"&&c.args.preview).at(-1).args.force);
    assert.equal(evidence.forced,true);
    assert.equal(await page.evaluate(()=>window.__materialsQa.calls.filter(c=>c.cmd==="content_asset_file").length),0);
    assert.equal(await page.locator(active+" .st-asset-area img").evaluate(img=>img.naturalWidth),1280);
  });
});

test("R24: a local video uses the same in-app playback and retains its position on return", async () => {
  await runCase("R24-local-native-video", async (page, evidence) => {
    await page.evaluate(()=>{window.__materialsQa.localRecords=[{assetId:"local-video-0",name:"本机合成视频.mp4",kind:"video",mime:"video/mp4",contentHash:"local-v1",sizeBytes:12345,localPath:"/synthetic-private/originals/asset-video.mp4",tags:[]}];});
    await page.getByRole("button",{name:"本机",exact:true}).click();
    await page.locator('[data-asset-id="local:local-video-0"]').click();
    await page.locator(active).getByRole("button",{name:"播放视频",exact:true}).click();
    await page.waitForFunction(()=>window.__materialsQa.nativeSession);
    evidence.first=await page.evaluate(()=>window.__materialsQa.nativeSession.args);
    assert.equal(evidence.first.assetId,"local-video-0");
    assert.equal(evidence.first.startPositionMs,0);
    assert.equal(evidence.first.darkMode,true);
    assert.equal(evidence.first.sourcePath,undefined,"the WebView cannot supply an arbitrary original path");
    await page.evaluate(()=>window.__materialsQa.closeNative({reason:"back",positionMs:47200,durationMs:180000,remoteBytes:0,sizeBytes:12345,transport:"cache",completeOffline:true}));
    await page.locator(active).getByRole("button",{name:"播放视频",exact:true}).click();
    await page.waitForFunction(()=>window.__materialsQa.nativeSession);
    evidence.resume=await page.evaluate(()=>window.__materialsQa.nativeSession.args.startPositionMs);
    assert.equal(evidence.resume,47200);
    await page.evaluate(()=>window.__materialsQa.closeNative({reason:"background",positionMs:47300,durationMs:180000}));
    await page.locator(active).getByRole("button",{name:"返回素材库",exact:true}).click();
    await page.locator('[data-asset-id="local:local-video-0"]').waitFor();
    assert.equal(await page.evaluate(()=>window.__materialsQa.calls.some(c=>c.cmd==="open_attachment")),false);
  },{dark:true});
});

test("R28: offline seen-card information keeps its known title and does not invent a zero-byte size", async () => {
  await runCase("R28-offline-information", async (page, evidence) => {
    await page.evaluate(() => {
      window.__materialsQa.releaseThumbnails();
      window.__materialsQa.primaryError = "CONTENT_DISCONNECTED";
      window.__materialsQa.cachedResource = {path:"/synthetic-original/saved.png",mime:"image/png",etag:'"saved"'};
      window.__materialsQa.setOnline(false);
    });
    await page.locator('[data-asset-id="asset-0"] img').waitFor();
    await page.locator('[data-asset-id="asset-0"]').click();
    await page.locator(active).getByRole("button", {name:"素材信息",exact:true}).click();
    const sheet = page.locator(".st-sheet");
    const name = sheet.locator(".st-metadata-row").filter({hasText:/^名称/}).locator("b");
    const size = sheet.locator(".st-metadata-row").filter({hasText:/^大小/}).locator("b");
    assert.equal(await name.textContent(), "Pinterest.png", "seen-card title is still known without primary metadata");
    assert.equal(await size.textContent(), "暂未取得", "missing metadata is unknown, not a fabricated zero-byte file");
    assert.equal(await sheet.getByText("原文件已完整保存", {exact:true}).count(), 1);
    evidence.offline = {name:await name.textContent(), size:await size.textContent()};
    await page.evaluate(() => {
      window.__materialsQa.primaryError = "";
      window.__materialsQa.records[0].sizeBytes = 0;
      window.__materialsQa.setOnline(true);
      window.__materialsQa.bump();
    });
    await page.waitForFunction(() => [...document.querySelectorAll(".st-sheet .st-metadata-row")].find(r => r.querySelector("span")?.textContent === "大小")?.querySelector("b")?.textContent === "0 B");
    assert.equal(await name.textContent(), "Pinterest.png");
    evidence.authoritativeZeroBytes = await size.textContent();
  });
});

test("R11: current WebViews retain their platform microtask behavior without legacy resume intervention", async () => {
  await runCase("R11-current-webview-unchanged", async (page, evidence) => {
    evidence.counts = await page.evaluate(async () => {
      let ran = 0;
      const platform = window.__materialsMicrotasks;
      platform.dropNext = true;
      window.queueMicrotask(() => {ran++;});
      window.dispatchEvent(new Event("lr:main-resume"));
      document.dispatchEvent(new Event("visibilitychange"));
      await new Promise(resolve => setTimeout(resolve, 0));
      const afterResume = ran;
      platform.replayOriginal();
      await new Promise(resolve => setTimeout(resolve, 0));
      window.dispatchEvent(new Event("lr:main-resume"));
      await new Promise(resolve => setTimeout(resolve, 0));
      return {afterResume, afterOriginal: ran};
    });
    assert.deepEqual(evidence.counts, {afterResume: 0, afterOriginal: 1});
    evidence.scope = "current Android WebView UA; platform queue remains unmodified";
  }, {legacyMicrotaskLoss: true, webViewChrome: 120});
});
