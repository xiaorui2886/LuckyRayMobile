// Opt-in real-browser regression over production StillApp → StillNote → CM6.
// The existing replicaS1 fixture replaces native IPC only; no editor/pool/
// autosave controllers are mocked. All records in this page are synthetic.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";

const { chromium } = createRequire(import.meta.url)(process.env.LUCKYRAY_QA_PLAYWRIGHT || "playwright");
const built = resolve(process.env.LUCKYRAY_QA_BUNDLE || "output/playwright/cm6-review/production");
const out = resolve(process.env.LUCKYRAY_QA_OUT || "output/playwright/cm6-review/lifecycle");
const motionMode = process.env.LUCKYRAY_QA_REDUCED || "on";
assert.ok(["on", "off"].includes(motionMode), "LUCKYRAY_QA_REDUCED must be on or off");
const reducedMotion = motionMode === "on";
const report = { kind: "real-React-CM6-production-StillApp-synthetic-IPC-not-device-UAT", reducedMotion, cases: [], errors: [] };
let browser, server, url;
const active = '.st-detail-stage[data-current="true"]';
const cm = active + " .cm-content";
mkdirSync(out, { recursive: true });

before(async () => {
  const assets = new Map([
    ["/bundle.js", [resolve(built, "bundle.js"), "text/javascript"]],
    ["/luckyray-mobile.css", [resolve(built, "luckyray-mobile.css"), "text/css"]],
    ["/production-base.css", [resolve(dirname(built), "production-base.css"), "text/css"]],
  ]);
  // Ephemeral loopback server/profile owned by this test, never Main or a
  // phone binding. No directory listing or arbitrary filesystem route.
  server = createServer((req, res) => {
    const requestUrl = new URL(req.url, "http://localhost");
    const path = requestUrl.pathname;
    const asset = assets.get(path);
    if (asset) { res.setHeader("Content-Type", asset[1]); res.end(readFileSync(asset[0])); return; }
    if (path !== "/") { res.writeHead(404); res.end(); return; }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/production-base.css"><link rel="stylesheet" href="/luckyray-mobile.css"></head><body><div id="root"></div><script>window.__replicaQa={online:true,confirmed:true,reducedMotion:${reducedMotion},dark:${requestUrl.searchParams.get("dark") === "1"}};</script><script src="/bundle.js"></script></body></html>`);
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.LUCKYRAY_QA_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" });
  report.browserVersion = browser.version();
});

after(async () => {
  try { if (browser) await browser.close(); }
  finally {
    if (server) await new Promise(r => server.close(r));
    writeFileSync(resolve(out, "lifecycle-report.json"), JSON.stringify(report, null, 2));
  }
});

async function runCase(name, run, {width = 392, height = 800, dark = false, hasTouch = false} = {}) {
  // The current touch strip expands after a real viewport reduction, not from
  // a page that was already short before mount. This is browser geometry ONLY,
  // never synthetic proof of Android keyboard insets or physical preedit.
  const context = await browser.newContext({ viewport: { width, height: hasTouch ? 800 : height }, deviceScaleFactor: 1, hasTouch, reducedMotion: reducedMotion ? "reduce" : "no-preference" });
  context.setDefaultTimeout(8000);
  const page = await context.newPage();
  const entry = { name, outcome: "RUNNING", evidence: {} };
  report.cases.push(entry);
  page.on("pageerror", error => report.errors.push(String(error)));
  try {
    await page.goto(url + (dark ? "?dark=1" : ""), { waitUntil: "networkidle" });
    await page.locator(".st-note-row").first().waitFor();
    entry.evidence.mode = await page.evaluate(() => ({ appReduced: document.querySelector(".st-app")?.getAttribute("data-reduced") === "true",
      mediaReduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
      traceEnabled: typeof window.__replicaQa?.startCmSearchTrace === "function", coordinateProbeEnabled: window.__cmScrollCoordinateEvidence !== undefined }));
    assert.deepEqual(entry.evidence.mode, { appReduced: reducedMotion, mediaReduced: reducedMotion, traceEnabled: false, coordinateProbeEnabled: false });
    await run(page, entry.evidence);
    assert.equal(await page.evaluate(() => window.__cmScrollCoordinateEvidence !== undefined), false, "formal gate must not load the coordinate probe");
    assert.deepEqual(report.errors, [], "no uncaught production render errors");
    entry.outcome = "PASS";
  } catch (error) {
    entry.outcome = "FAIL"; entry.error = String(error);
    await page.screenshot({ path: resolve(out, name + "-failure.png") });
    throw error;
  } finally { await context.close(); }
}

async function openLocal(page, id = "note-qa-local-0") {
  await page.evaluate(id => window.__replicaQa.openLocal(id), id);
  // A legitimate empty read body has zero height; attachment, not visible
  // pixels, is the readiness condition. The subsequent button awaits load.
  await page.locator(active + " .st-note-prose").waitFor({state: "attached"});
}
async function openDesktop(page, id = "n000") {
  await page.evaluate(id => window.__replicaQa.openRead(id), id);
  await page.locator(active + " .st-note-prose").waitFor();
}
async function enterEdit(page) {
  const editor = page.locator(cm);
  if (await editor.count()) await editor.focus();
  else await page.locator(active + " .st-note-prose").click({position: {x: 12, y: 12}});
  await editor.waitFor();
  if (await page.evaluate(() => matchMedia("(pointer: coarse)").matches)) {
    await page.setViewportSize({ width: page.viewportSize().width, height: 440 });
    await page.locator(active + " .st-editor-tools").waitFor();
  }
}
async function typeEnd(page, text) {
  await page.locator(cm).click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(text);
}
// TAP-EDIT-R1 has no Done/read-mode toggle. Releasing keyboard focus keeps
// the ONE view mounted; wait for the existing save authority's real receipt.
async function done(page) {
  const snapshot = await page.locator(active + " .st-note-editor").evaluate(host => {
    const route = window.__replicaQa.currentRoute().detail;
    const source = route.startsWith('note-') ? 'local' : 'desktop';
    const id = source === 'local' ? route : decodeURIComponent(route.split(':')[3]);
    return {body:host.__cmHandle.getValue(),title:host.closest('.st-note-paper').querySelector('.st-note-title').value,source,id};
  });
  await page.locator(cm).evaluate(input => input.blur());
  await page.waitForFunction(({body,title,source,id}) => {
    const note = (source === 'local' ? window.__replicaQa.localRecords : window.__replicaQa.records).find(note => note.noteId === id);
    return note?.content === body && note.title === title;
  }, snapshot);
}

test("R1: local body saves once across repeated keyboard blur/refocus", async () => {
  await runCase("R1-local-refocus-save", async (page, evidence) => {
    await openLocal(page);
    const initial = await page.evaluate(() => window.__replicaQa.localRecords[0].content);
    for (const [round, suffix] of ["A", "B", "C"].entries()) {
      await enterEdit(page);
      await typeEnd(page, suffix);
      const expected = initial + "ABC".slice(0, round + 1);
      await page.screenshot({ path: resolve(out, `R1-edit-round-${round}.png`) });
      await done(page);
      const saved = await page.evaluate(() => ({body: window.__replicaQa.localRecords[0].content, writes: window.__replicaQa.calls.filter(c => c.cmd === "local_note_update").map(c => c.args)}));
      evidence[`round${round}`] = saved;
      assert.equal(saved.body, expected, "visible user text must reach the existing autosave authority");
      assert.equal(saved.writes.length, round + 1, "one exact save per single-key edit, no hydrate/re-entry echo");
      assert.equal(saved.writes.at(-1).content, expected);
    }
  });
});

test("R2: a remote body received in read mode is visible before the first re-entry mutation", async () => {
  await runCase("R2-remote-reentry-base", async (page, evidence) => {
    await openDesktop(page);
    await enterEdit(page); // Create the view; blur keeps it mounted.
    await done(page);
    const remote = "ONLY_R2_REMOTE\n阅读期间收到的新正文，不得被旧视图覆盖。";
    await page.evaluate(body => window.__replicaQa.updateRemote("n000", body), remote);
    await page.waitForFunction(body => document.querySelector('.st-detail-stage[data-current="true"] .st-note-editor')?.__cmHandle.getValue().includes(body), remote);
    const before = await page.evaluate(() => window.__replicaQa.calls.filter(c => c.cmd === "content_note_edit").length);
    assert.equal(before, 0, "a read-mode remote apply must not echo into editing");
    // No read/edit remount exists anymore: verify the same mounted view has
    // accepted the authoritative body before an explicit refocus/input.
    await page.evaluate(() => {
      const host = document.querySelector('.st-detail-stage[data-current="true"] .st-note-editor');
      window.__cmFirstBody = host.__cmHandle.getValue();
    });
    await enterEdit(page);
    const visible = await page.locator(active + " .st-note-editor").evaluate(host => host.__cmHandle.getValue());
    evidence.firstAttachedBody = await page.evaluate(() => window.__cmFirstBody);
    evidence.reenteredBody = visible;
    await page.screenshot({ path: resolve(out, "R2-before-first-input.png") });
    await typeEnd(page, "Z");
    await page.waitForFunction(() => window.__replicaQa.calls.some(c => c.cmd === "content_note_edit"));
    evidence.mutations = await page.evaluate(() => window.__replicaQa.calls.filter(c => c.cmd === "content_note_edit").map(c => c.args));
    assert.equal(visible, remote, "retained old text must not be rendered under the new displayed base");
    assert.equal(evidence.firstAttachedBody, remote, "the first observable attached document is already authoritative");
    assert.equal(evidence.mutations.length, 1, "one first input, no authoritative-apply save echo");
    assert.equal(evidence.mutations[0].content, remote + "Z");
    assert.equal(evidence.mutations[0].expectedRevision, "remote-1", "first mutation uses the revision of its visible full body");
  });
});

test("R3: a format command cannot replace text in an active composition", async () => {
  await runCase("R3-format-composition-guard", async (page, evidence) => {
    await openDesktop(page);
    await enterEdit(page);
    evidence.command = await page.locator(active + " .st-note-editor").evaluate(host => {
      const editor = host.__cmHandle;
      const input = host.querySelector(".cm-content");
      const before = editor.getValue();
      input.dispatchEvent(new CompositionEvent("compositionstart", {bubbles: true, data: "zhong"}));
      const started = editor.compositionStarted();
      editor.replaceRange("**", {start: 0, end: 0});
      return {before, after: editor.getValue(), started, stillStarted: editor.compositionStarted()};
    });
    evidence.mutations = await page.evaluate(() => window.__replicaQa.calls.filter(c => c.cmd === "content_note_edit").map(c => c.args));
    assert.equal(evidence.command.started, true, "the real CM view received the synthetic browser compositionstart");
    assert.equal(evidence.command.after, evidence.command.before, "format must not overwrite an IME-owned buffer");
    assert.equal(evidence.command.stillStarted, true, "a command must not force composition to end");
    assert.equal(evidence.mutations.length, 0, "no mutation or autosave for a blocked command");
    await page.locator(active).getByRole("button", {name: "更多文本格式", exact: true}).click();
    assert.equal(await page.locator(".st-sheet").count(), 0, "toolbar does not steal composition focus to open a format sheet");
    await page.locator(cm).evaluate(input => input.dispatchEvent(new CompositionEvent("compositionend", {bubbles: true, data: "中"})));
    await page.waitForFunction(() => !document.querySelector('.st-detail-stage[data-current="true"] .st-note-editor').__cmHandle.compositionStarted());
    await page.locator(active + " .st-note-editor").evaluate(host => host.__cmHandle.setSelection({start: 5, end: 5}));
    await page.locator(active).getByRole("button", {name: "更多文本格式", exact: true}).click();
    await page.locator(".st-sheet").getByRole("button", {name: "小标题", exact: true}).click();
    evidence.normalFormat = await page.locator(active + " .st-note-editor").evaluate(host => ({body: host.__cmHandle.getValue(), selection: host.__cmHandle.getSelection()}));
    evidence.normalMutations = await page.evaluate(() => window.__replicaQa.calls.filter(c => c.cmd === "content_note_edit").map(c => c.args));
    assert.equal(evidence.normalFormat.body, evidence.command.before.slice(0,5) + "\n\n## " + evidence.command.before.slice(5));
    assert.deepEqual(evidence.normalFormat.selection, {start: 10, end: 10});
    assert.equal(evidence.normalMutations.length, 1, "normal toolbar format still saves exactly once after composition ends");
  });
});

test("R9: touch formatting keeps the body input connection when preedit is opaque to the DOM", async () => {
  // Real Android Sogou can hold its candidate in the IME, before any browser
  // composition event. This regression covers the observable focus boundary,
  // not the native candidate itself; the latter must be verified on MI8.
  for (const source of ["local", "desktop"]) {
    await runCase(`R9-opaque-ime-format-${source}`, async (page, evidence) => {
      await (source === "local" ? openLocal(page) : openDesktop(page));
      await enterEdit(page);
      await page.locator(cm).tap();
      evidence.before = await page.locator(active + " .st-note-editor").evaluate(host => {
        const handle = host.__cmHandle;
        handle.setSelection({start: handle.getValue().length, end: handle.getValue().length});
        window.__opaqueImeBlurs = 0;
        host.querySelector(".cm-content").addEventListener("blur", () => { window.__opaqueImeBlurs++; });
        return {body: handle.getValue(), selection: handle.getSelection(), focused: handle.hasFocus(), composing: handle.compositionStarted()};
      });
      assert.equal(evidence.before.focused, true);
      assert.equal(evidence.before.composing, false, "no fabricated DOM composition signal for an opaque native buffer");
      await page.locator(active).getByRole("button", {name: "更多文本格式", exact: true}).tap();
      await page.locator(".st-modal.is-shown .st-sheet").waitFor();
      evidence.open = await page.locator(active + " .st-note-editor").evaluate(host => ({
        body: host.__cmHandle.getValue(), selection: host.__cmHandle.getSelection(), focused: host.__cmHandle.hasFocus(), blurs: window.__opaqueImeBlurs,
      }));
      await page.screenshot({path: resolve(out, `R9-${source}-format-open.png`)});
      assert.equal(evidence.open.focused, true, "opening format must not reset the native input connection");
      assert.equal(evidence.open.blurs, 0, "opaque preedit must not be discarded by a format-sheet autofocus");
      assert.equal(evidence.open.body, evidence.before.body);
      assert.deepEqual(evidence.open.selection, evidence.before.selection);
      await page.locator(".st-sheet").getByRole("button", {name: "小标题", exact: true}).tap();
      await page.locator(".st-sheet").waitFor({state: "detached"});
      evidence.insert = await page.locator(active + " .st-note-editor").evaluate(host => ({
        body: host.__cmHandle.getValue(), focused: host.__cmHandle.hasFocus(), blurs: window.__opaqueImeBlurs,
      }));
      assert.equal(evidence.insert.body, evidence.before.body + "\n\n## ");
      assert.equal(evidence.insert.focused, true);
      assert.equal(evidence.insert.blurs, 0, "touching a format choice must not reset the same input connection");
      await done(page);
      const cmd = source === "local" ? "local_note_update" : "content_note_edit";
      evidence.saves = await page.evaluate(cmd => window.__replicaQa.calls.filter(c => c.cmd === cmd).map(c => c.args), cmd);
      assert.equal(evidence.saves.length, 1, "one normal save authority, not an additional formatting writer");
      assert.equal(evidence.saves[0].content, evidence.insert.body);
      await enterEdit(page);
      await page.locator(active).getByRole("button", {name: "笔记更多操作", exact: true}).first().tap();
      await page.locator('.st-modal.is-shown .st-sheet[aria-modal="true"]').waitFor();
      evidence.otherSheet = await page.locator(".st-sheet").evaluate(sheet => ({modal: sheet.getAttribute("aria-modal"), focused: document.activeElement === sheet}));
      assert.deepEqual(evidence.otherSheet, {modal: "true", focused: true}, "ordinary sheets still receive modal focus");
    }, {hasTouch: true, height: 440});
  }
});

test("R10: formatting a selected body keeps its text and is one undoable user edit", async () => {
  for (const source of ["local", "desktop"]) {
    await runCase(`R10-selected-format-${source}`, async (page, evidence) => {
      const selected = "SELECTED_中文_WORD";
      const initial = `BEFORE\n${selected}\nAFTER`;
      await page.evaluate(({source, initial}) => {
        if (source === "local") window.__replicaQa.localRecords[0].content = initial;
        else window.__replicaQa.updateRemote("n000", initial, false);
      }, {source, initial});
      await (source === "local" ? openLocal(page) : openDesktop(page));
      await enterEdit(page);
      await page.locator(cm).tap();
      evidence.before = await page.locator(active + " .st-note-editor").evaluate((host, selected) => {
        const handle = host.__cmHandle;
        const start = handle.getValue().indexOf(selected);
        handle.setSelection({start, end: start + selected.length});
        return {body: handle.getValue(), selection: handle.getSelection(), composing: handle.compositionStarted()};
      }, selected);
      assert.equal(evidence.before.body, initial);
      assert.equal(evidence.before.composing, false);
      await page.locator(active).getByRole("button", {name: "更多文本格式", exact: true}).tap();
      await page.locator(".st-sheet").getByRole("button", {name: "引用", exact: true}).tap();
      await page.locator(".st-sheet").waitFor({state: "detached"});
      evidence.formatted = await page.locator(active + " .st-note-editor").evaluate(host => ({
        body: host.__cmHandle.getValue(), selection: host.__cmHandle.getSelection(),
      }));
      await page.screenshot({path: resolve(out, `R10-${source}-formatted.png`)});
      const expected = `BEFORE\n\n> ${selected}\nAFTER`;
      assert.equal(evidence.formatted.body, expected, "a formatting marker must not discard selected user text");
      const caret = evidence.before.selection.start + "\n> ".length + selected.length;
      assert.deepEqual(evidence.formatted.selection, {start: caret, end: caret});
      await done(page);
      const cmd = source === "local" ? "local_note_update" : "content_note_edit";
      evidence.saves = await page.evaluate(cmd => window.__replicaQa.calls.filter(c => c.cmd === cmd).map(c => c.args), cmd);
      assert.equal(evidence.saves.length, 1, "formatting uses the existing save authority once");
      assert.equal(evidence.saves[0].content, expected);
      await enterEdit(page);
      await page.keyboard.press("Control+z");
      evidence.undo = await page.locator(active + " .st-note-editor").evaluate(host => host.__cmHandle.getValue());
      assert.equal(evidence.undo, initial, "one undo restores the entire selected-text formatting edit");
      await done(page);
    }, {hasTouch: true, height: 440});
  }
});

test("R11: selected text becomes the link label without changing its literal characters", async () => {
  await runCase("R11-selected-link-label", async (page, evidence) => {
    const selected = "$&中文";
    const initial = `BEFORE ${selected} AFTER`;
    await page.evaluate(body => { window.__replicaQa.localRecords[0].content = body; }, initial);
    await openLocal(page);
    await enterEdit(page);
    await page.locator(cm).tap();
    await page.locator(active + " .st-note-editor").evaluate((host, selected) => {
      const handle = host.__cmHandle;
      const start = handle.getValue().indexOf(selected);
      handle.setSelection({start, end: start + selected.length});
    }, selected);
    await page.locator(active).getByRole("button", {name: "更多文本格式", exact: true}).tap();
    await page.locator(".st-sheet").getByRole("button", {name: "链接", exact: true}).tap();
    await page.locator(".st-sheet").waitFor({state: "detached"});
    evidence.body = await page.locator(active + " .st-note-editor").evaluate(host => host.__cmHandle.getValue());
    assert.equal(evidence.body, `BEFORE \n[${selected}](https://) AFTER`);
    await done(page);
  }, {hasTouch: true, height: 440});
});

test("R4: external re-entry maps selection and preserves user undo without a save echo", async () => {
  await runCase("R4-undo-selection-scroll", async (page, evidence) => {
    const initial = Array.from({length: 80}, (_, i) => `LINE ${String(i).padStart(3,"0")} original text`).join("\n");
    await page.evaluate(body => window.__replicaQa.updateRemote("n000", body, false), initial);
    await openDesktop(page);
    await enterEdit(page);
    await typeEnd(page, "U");
    await page.locator(active + " .st-note-editor").evaluate(host => {
      host.__cmHandle.setSelection({start: 400, end: 405}); host.__cmHandle.scrollTo(120);
    });
    await page.waitForTimeout(60);
    evidence.before = await page.locator(active + " .st-note-editor").evaluate(host => ({selection: host.__cmHandle.getSelection(), scroll: host.__cmHandle.scrollTop()}));
    assert.ok(evidence.before.scroll > 0, "nonzero real CM scroll position");
    await done(page);
    const prefix = "REMOTE ";
    await page.evaluate(body => window.__replicaQa.updateRemote("n000", body), prefix + initial + "U");
    await page.waitForFunction(() => document.querySelector('.st-detail-stage[data-current="true"] .st-note-editor')?.__cmHandle.getValue().startsWith("REMOTE "));
    await enterEdit(page);
    evidence.after = await page.locator(active + " .st-note-editor").evaluate(host => ({body: host.__cmHandle.getValue(), selection: host.__cmHandle.getSelection(), scroll: host.__cmHandle.scrollTop()}));
    const callsBeforeUndo = await page.evaluate(() => window.__replicaQa.calls.filter(c => c.cmd === "content_note_edit").length);
    assert.equal(evidence.after.body, prefix + initial + "U");
    assert.deepEqual(evidence.after.selection, {start: 407, end: 412}, "selection maps through the inserted external prefix");
    assert.equal(evidence.after.scroll, evidence.before.scroll, "read-edit reattachment does not reset nonzero scroll");
    assert.equal(callsBeforeUndo, 1, "remote application does not create another save");
    await page.keyboard.press("Control+z");
    evidence.undo = await page.locator(active + " .st-note-editor").evaluate(host => host.__cmHandle.getValue());
    evidence.mutations = await page.evaluate(() => window.__replicaQa.calls.filter(c => c.cmd === "content_note_edit").map(c => c.args));
    assert.equal(evidence.undo, prefix + initial, "undo removes only the user edit, not the external prefix");
    assert.equal(evidence.mutations.length, 2, "user undo goes through the normal save once");
  });
});

test("R5: changing note/source cannot route a late save receipt or callback into the new editor", async () => {
  await runCase("R5-scope-late-receipt", async (page, evidence) => {
    await openDesktop(page);
    await enterEdit(page);
    await page.evaluate(() => { window.__replicaQa.deferNextEdit = true; });
    await typeEnd(page, "D");
    await page.waitForFunction(() => typeof window.__replicaQa.releaseEdit === "function");
    await page.evaluate(() => window.__replicaQa.leaveNote());
    await page.locator(active).waitFor({state: "detached"});
    await openLocal(page);
    await enterEdit(page);
    const localBefore = await page.locator(active + " .st-note-editor").evaluate(host => host.__cmHandle.getValue());
    await page.evaluate(() => window.__replicaQa.releaseEdit());
    await page.waitForTimeout(60);
    assert.equal(await page.locator(active + " .st-note-editor").evaluate(host => host.__cmHandle.getValue()), localBefore, "retired Desktop receipt does not alter local scope");
    await typeEnd(page, "L");
    await done(page);
    evidence.calls = await page.evaluate(() => window.__replicaQa.calls.filter(c => ["content_note_edit", "local_note_update"].includes(c.cmd)));
    assert.equal(evidence.calls.filter(c => c.cmd === "content_note_edit").length, 1);
    assert.equal(evidence.calls.filter(c => c.cmd === "local_note_update").length, 1);
    assert.equal(evidence.calls.at(-1).args.noteId, "note-qa-local-0");
    assert.equal(evidence.calls.at(-1).args.content, localBefore + "L");
  });
});

test("R6: attachment waits for the pending save and its native placeholder applies without an edit echo", async () => {
  await runCase("R6-attachment-save-drain", async (page, evidence) => {
    await openDesktop(page);
    await enterEdit(page);
    const initial = await page.locator(active + " .st-note-editor").evaluate(host => host.__cmHandle.getValue());
    await page.evaluate(() => { window.__replicaQa.deferNextEdit = true; });
    await typeEnd(page, "A");
    await page.waitForFunction(() => typeof window.__replicaQa.releaseEdit === "function");
    await page.locator(active).getByRole("button", {name: "插入附件", exact: true}).click();
    await page.getByRole("button", {name: "图片", exact: true}).click();
    await page.waitForTimeout(60);
    assert.equal(await page.evaluate(() => window.__replicaQa.calls.filter(c => c.cmd === "content_note_attach").length), 0,
      "attachment cannot race the unfinished local save");
    await page.evaluate(() => window.__replicaQa.releaseEdit());
    const expected = initial + "A\n![附件待同步](luckyray-attachment:qa-resource)";
    await page.waitForFunction(body => document.querySelector('.st-detail-stage[data-current="true"] .st-note-editor')?.__cmHandle?.getValue() === body, expected);
    evidence.body = await page.locator(active + " .st-note-editor").evaluate(host => host.__cmHandle.getValue());
    evidence.calls = await page.evaluate(() => window.__replicaQa.calls.filter(c => ["content_note_edit", "content_note_attach"].includes(c.cmd)));
    assert.deepEqual(evidence.calls.map(c => c.cmd), ["content_note_edit", "content_note_attach"]);
    assert.equal(evidence.calls[0].args.content, initial + "A");
    assert.equal(evidence.calls[1].args.kind, "image");
    await page.screenshot({path: resolve(out, "R6-attachment-placeholder.png")});
    await done(page);
    await enterEdit(page);
    assert.equal(await page.locator(active + " .st-note-editor").evaluate(host => host.__cmHandle.getValue()), expected);
    assert.equal(await page.evaluate(() => window.__replicaQa.calls.filter(c => c.cmd === "content_note_edit").length), 1,
      "native placeholder and subsequent re-entry are not another user edit");
  });
});

test("R7: real CM composition/focus defers a received remote body until safe blur", async () => {
  await runCase("R7-renderer-composition-remote", async (page, evidence) => {
    const initial = Array.from({length: 80}, (_, i) => `IME LINE ${i} original text`).join("\n");
    await page.evaluate(body => window.__replicaQa.updateRemote("n000", body, false), initial);
    await openDesktop(page);
    await enterEdit(page);
    await page.locator(cm).click();
    await page.keyboard.press("Control+End");
    await page.waitForTimeout(60); // settle the entry autofocus/scroll measurement
    await page.locator(active + " .st-note-editor").evaluate(host => {
      host.__cmHandle.setSelection({start: 400, end: 405});
      host.querySelector(".cm-content").dispatchEvent(new CompositionEvent("compositionstart", {bubbles: true, data: "zhong"}));
    });
    await page.waitForTimeout(60);
    await page.locator(active + " .st-note-editor").evaluate(host => host.__cmHandle.scrollTo(120));
    const snapshot = () => page.locator(active + " .st-note-editor").evaluate(host => ({
      body: host.__cmHandle.getValue(), selection: host.__cmHandle.getSelection(), scroll: host.__cmHandle.scrollTop(),
      focused: host.__cmHandle.hasFocus(), started: host.__cmHandle.compositionStarted(),
    }));
    evidence.before = await snapshot();
    assert.equal(evidence.before.started, true);
    assert.equal(evidence.before.focused, true);
    assert.ok(evidence.before.scroll > 0);
    const gets = await page.evaluate(() => window.__replicaQa.calls.filter(c => c.cmd === "content_note_get").length);
    const remote = "REMOTE SAFE\n" + initial;
    await page.evaluate(body => window.__replicaQa.updateRemote("n000", body), remote);
    await page.waitForFunction(count => window.__replicaQa.calls.filter(c => c.cmd === "content_note_get").length > count, gets);
    await page.waitForTimeout(60);
    evidence.during = await snapshot();
    assert.deepEqual(evidence.during, evidence.before, "received remote body cannot disturb a composing real CM view");
    await page.locator(cm).evaluate(input => input.dispatchEvent(new CompositionEvent("compositionend", {bubbles: true, data: "中"})));
    await page.waitForFunction(() => !document.querySelector('.st-detail-stage[data-current="true"] .st-note-editor').__cmHandle.compositionStarted());
    assert.equal((await snapshot()).body, initial, "composition end alone cannot replace a still-focused editor");
    await page.locator(active + " .st-note-footnote").click();
    await page.waitForFunction(body => document.querySelector('.st-detail-stage[data-current="true"] .st-note-editor')?.__cmHandle?.getValue() === body, remote);
    evidence.afterSafeBlur = await snapshot();
    assert.equal(await page.evaluate(() => window.__replicaQa.calls.filter(c => c.cmd === "content_note_edit").length), 0,
      "deferred remote application never becomes a user mutation");
    await page.screenshot({path: resolve(out, "R7-safe-remote-applied.png")});
  });
});

test("R8: production empty/tap/blur/save interaction at both narrow widths and themes", async () => {
  for (const width of [360, 392]) for (const dark of [false, true]) {
    const name = `R8-production-${width}-${dark ? "dark" : "light"}`;
    await runCase(name, async (page, evidence) => {
      await openLocal(page, "note-qa-local-3");
      await enterEdit(page);
      assert.equal(await page.locator(active + " .st-note-editor").evaluate(host => host.__cmHandle.getValue()), "");
      assert.equal(await page.locator(active + " .cm-placeholder").textContent(), "写下第一个想法…");
      assert.equal(await page.locator(".st-app").getAttribute("data-mode"), dark ? "dark" : "light");
      await page.screenshot({path: resolve(out, name + "-empty.png")});
      await typeEnd(page, "A");
      await done(page);
      assert.equal(await page.locator(active + " .st-note-editor").evaluate(host => host.__cmHandle.getValue()), "A");
      evidence.save = await page.evaluate(() => window.__replicaQa.calls.filter(c => c.cmd === "local_note_update").map(c => c.args));
      assert.equal(evidence.save.length, 1);
      assert.equal(evidence.save[0].noteId, "note-qa-local-3");
      assert.equal(evidence.save[0].content, "A");
      evidence.geometry = await page.locator(active).evaluate(stage => ({
        overflows: [...stage.querySelectorAll(".st-note-surface,.st-note-paper")].map(el => el.scrollWidth - el.clientWidth),
        tools: [...stage.querySelectorAll(".st-reader-tools button")].filter(el => el.getClientRects().length > 0)
          .map(el => ({label: el.getAttribute("aria-label"), width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height})),
      }));
      assert.ok(evidence.geometry.overflows.every(extra => extra <= 1), "production paper stays within the viewport");
      assert.ok(evidence.geometry.tools.length >= 4 && evidence.geometry.tools.every(tool => tool.width >= 44 && tool.height >= 44), "visible tool hit areas remain accessible; intentionally collapsed controls are not hit targets");
      await page.screenshot({path: resolve(out, name + "-saved-read.png")});
    }, {width, dark});
  }
});
