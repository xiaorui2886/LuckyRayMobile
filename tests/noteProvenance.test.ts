// STABILITY-FIX-R1 Finding A — cached body provenance helpers.
//
// The editor must decide readability from the CACHED BODY, never from the
// latest remote summary. These tests pin that boundary, including the case
// that caused the original defect: a bodyless summary making a readable
// offline note look uncached.
import test from "node:test";
import assert from "node:assert/strict";
import {
  cachedBodyNotice,
  cachedResources,
  hasReadableBody,
  missingBodyMessage,
  bodyRevision,
  noteStatus,
  noteStatusClass,
} from "../src/services/noteProvenance.ts";

test("a durably saved invalid-title draft is readable but needs correction, never synced", () => {
  const draft = { dirty: true, content: "body retained", titleNeedsCorrection: true };
  assert.equal(hasReadableBody(draft), true);
  assert.equal(noteStatus(draft).key, "title-required");
  assert.equal(noteStatus(draft).isSynced, false);
  assert.match(noteStatus(draft).headerLabel, /已保存在手机/);
  assert.equal(draft.content, "body retained");
  assert.equal(noteStatus({ ...draft, titleNeedsCorrection: false }).key, "pending");
});

test("a paused old intent remains visibly pending after its later draft gets a valid title", () => {
  const draft = { dirty: true, content: "later body", operationPaused: true, titleNeedsCorrection: false };
  assert.equal(noteStatus(draft).key, "operation-paused");
  assert.match(noteStatus(draft).headerLabel, /已保存在手机/);
  assert.equal(noteStatus(draft).isSynced, false);
  assert.equal(hasReadableBody(draft), true);
  assert.equal(noteStatus({ ...draft, operationPaused: false }).key, "pending");
  assert.equal(noteStatus({ ...draft, conflictDocument: { content: "other" } }).key, "conflict");
});

test("provenance — a bodyless summary does NOT make a cached body unreadable", () => {
  const note = {
    content: "旧正文",
    revision: "r1",
    dirty: false,
    serverDocument: { revision: "r2" }, // summary, no content
    cachedDocument: { revision: "r1", content: "旧正文", resources: [] },
    bodyOutdated: true,
  };
  assert.equal(hasReadableBody(note), true, "仍可离线阅读旧正文");
  assert.equal(bodyRevision(note), "r1", "基线仍是正文真实版本 r1");
  assert.equal(missingBodyMessage(note), null, "不得误报未缓存");
  assert.ok(cachedBodyNotice(note)?.includes("电脑上已更新"));
});

test("provenance — a never-cached summary-only note IS reported as missing", () => {
  const note = {
    content: "",
    revision: "",
    dirty: false,
    serverDocument: { revision: "r9", title: "只有摘要" },
    cachedDocument: null,
    bodyOutdated: false,
  };
  assert.equal(hasReadableBody(note), false, "没有正文就不可读");
  assert.equal(missingBodyMessage(note), "正文尚未缓存，请连接电脑后再打开。");
  assert.equal(cachedBodyNotice(note), null, "无可读正文时不谎报落后");
});

test("provenance — an explicitly empty body is a REAL readable body", () => {
  const note = {
    content: "",
    revision: "r2",
    dirty: false,
    serverDocument: { revision: "r2", content: "" },
    cachedDocument: { revision: "r2", content: "", resources: [] },
    bodyOutdated: false,
  };
  assert.equal(hasReadableBody(note), true, "content:'' 是真实完整的空正文");
  assert.equal(missingBodyMessage(note), null);
  assert.equal(cachedBodyNotice(note), null, "正文与远端一致，无提示");
});

test("provenance — a dirty draft is always readable, even with no cached document", () => {
  const note = {
    content: "手机草稿",
    revision: "r1",
    dirty: true,
    serverDocument: { revision: "r2" },
    cachedDocument: null,
    bodyOutdated: false,
  };
  assert.equal(hasReadableBody(note), true, "草稿输入永远可读");
  assert.equal(missingBodyMessage(note), null);
  assert.equal(cachedBodyNotice(note), null, "草稿状态由编辑器自己的提示表达");
});

test("provenance — resources come from the cached BODY, not the summary", () => {
  const resources = [{ resourceId: "res-1", target: "图.png" }];
  const note = {
    content: "旧正文",
    revision: "r1",
    serverDocument: { revision: "r2" }, // summary carries no resources
    cachedDocument: { revision: "r1", content: "旧正文", resources },
    bodyOutdated: true,
  };
  assert.deepEqual(cachedResources(note), resources, "附件呈现必须来自缓存正文版本");
  assert.deepEqual(cachedResources({ ...note, cachedDocument: null }), [], "无缓存正文时没有资源可渲染");
  assert.deepEqual(cachedResources(null), []);
});

test("provenance — null note is handled without throwing", () => {
  assert.equal(hasReadableBody(null), false);
  assert.equal(cachedBodyNotice(null), null);
  assert.equal(bodyRevision(null), "");
  assert.deepEqual(cachedResources(null), []);
});

// ---------------------------------------------------------------------------
// FINAL-CLOSURE-R1 P2-1 — ONE status authority for list + detail.
//
// The defect: a metadata-only note read 已同步 in the Desktop note LIST while
// the detail page said 仅同步元数据. Both surfaces now read `noteStatus`, so
// these tests pin the frozen priority table from #33.
// ---------------------------------------------------------------------------
import type { CachedNote } from "../src/services/noteProvenance.ts";

const FULL_CURRENT: CachedNote = {
  content: "完整正文",
  revision: "r1",
  dirty: false,
  cachedDocument: { revision: "r1", content: "完整正文", resources: [] },
  serverDocument: { revision: "r1" },
  bodyOutdated: false,
};

test("status — metadata-only clean note is NOT 已同步 (the reported defect)", () => {
  const note: CachedNote = {
    content: "",
    revision: "",
    dirty: false,
    cachedDocument: null, // body never cached
    serverDocument: { revision: "r9", title: "只有摘要" },
    bodyOutdated: false,
  };
  const status = noteStatus(note);
  assert.equal(status.label, "仅同步元数据");
  assert.equal(status.isSynced, false, "metadata-only 绝不能声称已同步");
  // The list badge and the detail header must agree (shared authority).
  assert.equal(noteStatus(note).label, status.label);
});

test("status — complete, current, clean body is 已同步", () => {
  const status = noteStatus(FULL_CURRENT);
  assert.equal(status.label, "已同步");
  assert.equal(status.isSynced, true);
});

test("status — readable body that is outdated reports 缓存版本, never 已同步", () => {
  const note: CachedNote = {
    ...FULL_CURRENT,
    revision: "r1",
    cachedDocument: { revision: "r1", content: "旧正文", resources: [] },
    serverDocument: { revision: "r2" }, // summary advanced
    bodyOutdated: true,
  };
  const status = noteStatus(note);
  assert.equal(status.label, "缓存版本");
  assert.notEqual(status.label, "已同步");
  assert.equal(status.isSynced, false);
});

test("status — an explicitly empty body is a COMPLETE body, not metadata-only", () => {
  // `content: ""` means a real, complete, empty note — it must read 已同步
  // when current and clean, never 仅同步元数据.
  const note: CachedNote = {
    content: "",
    revision: "r2",
    dirty: false,
    cachedDocument: { revision: "r2", content: "", resources: [] },
    serverDocument: { revision: "r2" },
    bodyOutdated: false,
  };
  assert.equal(hasReadableBody(note), true, "空正文仍是可读正文");
  const status = noteStatus(note);
  assert.equal(status.label, "已同步");
  assert.notEqual(status.label, "仅同步元数据");
});

test("status — priority: conflict > delete > pending > metadata-only > cached > synced", () => {
  // 1. A conflict outranks everything, including a dirty flag.
  assert.equal(
    noteStatus({ ...FULL_CURRENT, conflictDocument: { content: "电脑版" }, dirty: true }).label,
    "需处理冲突"
  );
  // 2. dirty delete outranks plain dirty.
  assert.equal(noteStatus({ ...FULL_CURRENT, dirty: true, pendingKind: "delete" }).label, "待同步删除");
  // 3. plain dirty outranks metadata-only / cached / synced.
  assert.equal(noteStatus({ ...FULL_CURRENT, dirty: true, pendingKind: "update" }).label, "待同步");
  // 4. metadata-only outranks the outdated check (nothing readable at all).
  assert.equal(
    noteStatus({ dirty: false, cachedDocument: null, bodyOutdated: true }).label,
    "仅同步元数据"
  );
  // 5. outdated outranks 已同步.
  assert.equal(noteStatus({ ...FULL_CURRENT, bodyOutdated: true }).label, "缓存版本");
  // 6. only a clean, current, complete body is 已同步.
  assert.equal(noteStatus(FULL_CURRENT).label, "已同步");
});

test("status — a dirty draft is never downgraded to metadata-only", () => {
  // A draft is readable by definition (the user typed it), even with no cached
  // document at all.
  const note: CachedNote = { content: "手机草稿", dirty: true, cachedDocument: null, revision: "r1" };
  assert.equal(hasReadableBody(note), true);
  assert.equal(noteStatus(note).label, "待同步");
});

test("status — null note is handled and never claims a sync state", () => {
  const status = noteStatus(null);
  assert.equal(status.isSynced, false);
  assert.equal(status.label, "仅同步元数据");
});

test("status — badge tone maps onto the existing meta-tag classes", () => {
  const metadataOnly: CachedNote = { dirty: false, cachedDocument: null };
  const outdated: CachedNote = { ...FULL_CURRENT, bodyOutdated: true };
  assert.equal(noteStatusClass(noteStatus(FULL_CURRENT)), "", "clean note uses the default tag");
  assert.equal(noteStatusClass(noteStatus({ ...FULL_CURRENT, dirty: true })), "warn");
  assert.equal(
    noteStatusClass(noteStatus(metadataOnly)),
    "",
    "metadata-only is informational, not a warning"
  );
  assert.equal(
    noteStatusClass(noteStatus(outdated)),
    "",
    "cached-but-outdated is informational too"
  );
  assert.equal(
    noteStatusClass(noteStatus({ ...FULL_CURRENT, conflictDocument: { content: "x" } })),
    "danger"
  );
});
