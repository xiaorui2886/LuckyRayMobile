import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AgentCapabilityController } from "../src/still/kit/agentCapability.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const library = read("src/still/StillLibrary.tsx");
const views = read("src/presentation/still01/Views.tsx");
const agent = read("src/still/StillAgent.tsx");
const css = read("src/presentation/still01/still.css");
const folders = library.slice(library.indexOf("function DesktopBrowseSheet("), library.indexOf("function DesktopFilterSheet("));
const filters = library.slice(library.indexOf("function DesktopFilterSheet("), library.indexOf("/** REAL Still Filter Sheet:"));

test("R8 directory panel stays tag-free inside directory/library sheet", () => {
  assert.match(folders, /<DirectoryLibrarySheet instance=\{owner\} kind="materials"/);
  assert.match(folders, /directory=\{<>/);
  assert.match(folders, /label="全部目录"/);
  assert.doesNotMatch(folders, /onTag|全部标签|nav\?\.tags/);
  assert.match(filters, /全部标签/);
  assert.match(filters, /label=\{"#" \+ t\.name\}/);
  assert.match(views, /p\.source==='desktop'\?'目录':library\?'浏览本机素材':'选择知识库'/);
});

test("R8 tag choices come from owner navigation, not loaded material rows", () => {
  assert.match(filters, /scopedApi\.contentNavigation\(owner\)/);
  assert.match(filters, /if \(alive\) setTags/);
  assert.match(filters, /return \(\) => \{ alive = false; \}/);
  assert.match(filters, /\}, \[owner, scopedApi\]\)/);
  assert.match(library, /<DesktopFilterSheet key=\{committedDesktopOwner\}/);
});

test("R8 desktop filters are drafts; only Apply changes the request axes", () => {
  assert.match(filters, /useState\(kind\)/);
  assert.match(filters, /useState\(tag\)/);
  assert.match(filters, /onClick=\{\(\) => setTagDraft\(t\.id\)\}/);
  assert.match(filters, /setKindDraft\(""\); setTagDraft\(""\);/);
  assert.equal((filters.match(/onApply\(kindDraft, tagDraft/g) || []).length, 1);
  assert.match(library, /setDesktopKind\(kind\); setDesktopTag\(tag\);/);
  assert.match(library, /tag: source\.tag \|\| undefined/);
  assert.match(library, /onSource=\{\(s\) => \{ setFiltersOpen\(false\); setBrowseOpen\(false\);/);
});

test("R8 refresh keeps one visible loading indicator and an accessible skeleton", () => {
  assert.match(views, /p\.refreshing\?\(p\.retained\?' · 正在同步':' · 正在读取'\)/);
  assert.match(views, /role="status" aria-label=\{p\.source==='local'\?'正在读取本机素材':'正在从电脑读取素材'\}/);
  assert.doesNotMatch(views, /<p[^>]*>\{p\.source==='local'\?'正在读取本机素材':'正在从电脑读取素材'\}<\/p>/);
  assert.match(views, /p\.source==='local'\?<p className="st-loading-caption">正在读取本机素材<\/p>:null/);
  assert.match(views, /st-skel-card/);
});

test("R8 all non-ready Agent states share the centered page container", () => {
  const page = agent.slice(agent.indexOf('className="st-scroll st-lsh-home st-agent-state"'), agent.indexOf("/** 执行过程 page:"));
  for (const state of ["unavailable", "probe-error", "offline", "probing"]) {
    assert.ok(page.includes(`snap.state === "${state}"`));
  }
  assert.match(page, /电脑暂时不在线/);
  assert.match(page, /连接电脑/);
  assert.match(css, /\.st-lsh-home\{[^}]*justify-content:center/);
  assert.match(css, /\.st-agent-state>\.st-empty\{padding:24px 8px\}/);
});

test("R8 centering never promotes offline state or enables LSH while probing", async () => {
  let finish!: (value: { runs: boolean; lshRemoteSurface: boolean }) => void;
  const controller = new AgentCapabilityController({ probe: () => new Promise(resolve => { finish = resolve; }) });
  controller.setConnection({ paired: true, connected: false, instanceId: "A" });
  assert.equal(controller.snapshot().state, "offline");
  assert.equal(controller.snapshot().canUseLsh, false);
  controller.setConnection({ paired: true, connected: true, instanceId: "A" });
  assert.equal(controller.snapshot().state, "probing");
  assert.equal(controller.snapshot().canUseLsh, false);
  controller.setConnection({ paired: true, connected: false, instanceId: "A" });
  finish({ runs: true, lshRemoteSurface: true });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(controller.snapshot().state, "offline");
  assert.equal(controller.snapshot().canUseRuns, false);
  assert.equal(controller.snapshot().canUseLsh, false);
});
