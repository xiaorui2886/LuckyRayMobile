import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LocalNotesPager, sameRequest } from "../src/services/knowledgeNotesPager.ts";
import { folderAncestors, folderChildren } from "../src/still/kit/knowledgeFolderCatalog.ts";
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test("folder membership is part of local request identity and load-more cannot mix directories", async () => {
  assert.equal(sameRequest({ folder: "Work" }, { folder: "Work/Ideas" }), false);
  assert.equal(sameRequest({ folder: "" }, {}), false);
  const calls: { filters: any; resolve: (result: any) => void }[] = [];
  const pager = new LocalNotesPager(filters => new Promise(resolve => calls.push({ filters, resolve })));
  pager.reload({ folder: "Work" });
  calls[0].resolve({ items: [{ noteId: "a" }], total: 2, hasMore: true }); await tick();
  await pager.loadMore({ folder: "Work/Ideas" });
  assert.equal(calls.length, 1);
  const oldMore = pager.loadMore({ folder: "Work" });
  assert.equal(calls[1].filters.folder, "Work");
  pager.reload({ folder: "Work/Ideas" });
  calls[2].resolve({ items: [{ noteId: "child" }], total: 1, hasMore: false }); await tick();
  calls[1].resolve({ items: [{ noteId: "old" }], total: 2, hasMore: false }); await oldMore;
  assert.deepEqual(pager.getState().items.map(n => n.noteId), ["child"]);
});

test("local and desktop use the same nested folder primitives", () => {
  assert.deepEqual(folderAncestors("Work/Ideas"), ["", "Work", "Work/Ideas"]);
  assert.deepEqual(folderChildren(["Work", "Work/Ideas", "Work/Ideas/Next", "Other"], "Work"), ["Work/Ideas"]);
});

test("directory Back is below overlay, selection, and pushed detail guards", () => {
  const app = read("src/App.tsx");
  assert.ok(app.indexOf("overlayStack.dismissTop()") < app.indexOf('new Event("luckyray:selection-back"'));
  assert.ok(app.indexOf('new Event("luckyray:selection-back"') < app.indexOf("stillNav.back()"));
  const shell = read("src/still/StillShell.tsx");
  const back = shell.slice(shell.indexOf("function back(): boolean"), shell.indexOf("// Hand the guarded Back"));
  assert.ok(back.indexOf("if (top)") < back.indexOf('new Event("luckyray:directory-back"'));
  assert.ok(back.indexOf('new Event("luckyray:directory-back"') < back.indexOf("return navigation.goBack()"));
});

test("compact controls use durable local APIs and truthful desktop capability copy", () => {
  const view = read("src/still/StillCollection.tsx");
  assert.equal((view.match(/st-compact-toolbar st-knowledge-toolbar/g) || []).length, 2);
  for (const token of ["api.localNoteCreateFolder(name, directory)", "api.localNoteSetFolder(actionNote.noteId, path)", 'folder: q.trim() ? undefined : directory || undefined', '电脑接口暂不支持按置顶或收藏筛选', '当前电脑知识库接口尚不支持从手机新建文件夹']) assert.ok(view.includes(token), token);
  assert.ok(!read("src/still/StillLibrary.tsx").includes("可继续加载"));
  assert.ok(read("src/still/StillLibrary.tsx").includes('onClick={loadMore}'));
  const style = read("src/still/kit/knowledgeNavigation.css");
  assert.ok(style.includes("font-size:11px;font-weight:400"));
  assert.ok(style.includes("stroke-width:1.5;fill:none"));
});
