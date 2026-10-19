// Home local-first model tests (M2.10 Scope A):
// paired=false still works, counts come from local stats (never Desktop),
// recent route mapping is exact.
import test from "node:test";
import assert from "node:assert/strict";
import {
  homeAssetRoute,
  homeDesktopOnline,
  homeInboxRoute,
  homeInboxTitle,
  homeLocalStats,
  homeNoteRoute,
  homeRecentLimitCheck,
  recentSlice,
} from "../src/services/homeLocalModel.ts";

test("home — local stats are the authority and work with paired=false", () => {
  const stats = homeLocalStats({ total: 7 }, { total: 3 }, { total: 2 });
  assert.deepEqual(stats, { inbox: 7, notes: 3, assets: 2 });
  // No Desktop stats are involved in the model at all.
  const zero = homeLocalStats(null, null, null);
  assert.deepEqual(zero, { inbox: 0, notes: 0, assets: 0 });
});

test("home — recent slices are bounded (never hundreds of rows)", () => {
  const many = Array.from({ length: 120 }, (_, i) => ({ id: `x${i}` }));
  assert.equal(recentSlice(many).length, 3, "recent slice stays small");
  assert.equal(recentSlice([]).length, 0);
  assert.equal(homeRecentLimitCheck(), 3);
});

test("home — recent route mapping is exact", () => {
  assert.equal(homeAssetRoute("asset-abc"), "local:asset-abc", "Local Asset -> local detail route");
  assert.equal(homeNoteRoute("note-1"), "note-1", "Local Note -> NoteEditor id");
  assert.equal(homeInboxRoute("item-9"), "item-9", "Local Inbox -> Inbox detail id");
});

test("home — inbox link rows prefer item.url before the generic fallback (FIX-V1 P2)", () => {
  assert.equal(homeInboxTitle({ kind: "link", url: "https://example.com/a" }), "https://example.com/a",
    "Link row without a title uses the URL");
  assert.equal(homeInboxTitle({ kind: "link", url: "https://example.com/a", title: "T" }), "T",
    "title still wins when present");
  assert.equal(homeInboxTitle({ kind: "text", text: "hello world" }), "hello world");
  assert.equal(homeInboxTitle({ kind: "file", attachment: { fileName: "f.pdf" } }), "f.pdf");
  assert.equal(homeInboxTitle({}), "本地收集", "generic fallback only when nothing else exists");
});

test("home — desktop hint dot is truthful: online only from actual WS state (FIX-V1 P2)", () => {
  assert.equal(homeDesktopOnline("connected"), true);
  assert.equal(homeDesktopOnline("connecting"), true);
  assert.equal(homeDesktopOnline("disconnected"), false);
  assert.equal(homeDesktopOnline(""), false, "pairing metadata alone is never 'online'");
});

// ---------------------------------------------------------------------------
// UI-REFRESH-R1 — unified 最近 timeline
// ---------------------------------------------------------------------------
test("ui-refresh-r1 — mergeRecent interleaves the three local domains newest-first", async () => {
  const { mergeRecent } = await import("../src/services/homeLocalModel.ts");
  const entries = mergeRecent({
    assets: [{ assetId: "a1", name: "图", kind: "image", updatedAt: "2026-09-01T10:00:00Z" }],
    notes: [{ noteId: "n1", title: "笔记", updatedAt: "2026-09-03T10:00:00Z" }],
    inbox: [{ itemId: "i1", kind: "text", text: "想法", updatedAt: "2026-09-02T10:00:00Z" }],
  });
  assert.deepEqual(entries.map((e) => e.id), ["n1", "i1", "a1"]);
  assert.deepEqual(entries.map((e) => e.domain), ["note", "inbox", "asset"]);
});

test("ui-refresh-r1 — mergeRecent never lets a local item read as Desktop content", async () => {
  const { mergeRecent } = await import("../src/services/homeLocalModel.ts");
  const entries = mergeRecent({
    assets: [{ assetId: "a1", name: "图", kind: "image", source: "inbox", updatedAt: "2026-09-01T10:00:00Z" }],
    notes: [{ noteId: "n1", title: "笔记", updatedAt: "2026-09-01T10:00:00Z" }],
    inbox: [{ itemId: "i1", kind: "link", url: "https://x.test", updatedAt: "2026-09-01T10:00:00Z" }],
  });
  for (const e of entries) {
    assert.ok(!/Desktop|电脑/.test(e.sourceLabel), `${e.sourceLabel} must not claim Desktop origin`);
    assert.ok(["本机", "收集箱"].includes(e.sourceLabel), `${e.sourceLabel} is an explicit local source`);
  }
  // A Link inbox row prefers its URL over the generic fallback.
  assert.equal(entries.find((e) => e.domain === "inbox")?.title, "https://x.test");
});

test("ui-refresh-r1 — mergeRecent is bounded and tolerates missing timestamps", async () => {
  const { mergeRecent, HOME_TIMELINE_LIMIT } = await import("../src/services/homeLocalModel.ts");
  const many = Array.from({ length: 20 }, (_, i) => ({ noteId: `n${i}`, title: `t${i}`, updatedAt: `2026-09-${String((i % 9) + 1).padStart(2, "0")}T00:00:00Z` }));
  const entries = mergeRecent({ notes: many });
  assert.equal(entries.length, HOME_TIMELINE_LIMIT, "the timeline is bounded");
  // A row with no timestamp sorts after the timestamped ones instead of jumping to the top.
  const mixed = mergeRecent({ notes: [{ noteId: "noTime", title: "无时间" }, { noteId: "timed", title: "有时间", updatedAt: "2026-01-01T00:00:00Z" }] });
  assert.equal(mixed[0].id, "timed");
  assert.equal(mixed[1].id, "noTime");
});
