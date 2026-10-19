// Node.js tests for Library domain filter semantics (M2.9):
// 全部 / 本机 / Desktop exact ownership separation + kind mapping.
import test from "node:test";
import assert from "node:assert/strict";
import {
  filterLibraryAssets,
  localKindFilter,
  type LocalAsset,
  type DesktopAsset,
} from "../src/services/libraryFilter.ts";

const localAssets: LocalAsset[] = [
  {
    assetId: "asset-1",
    kind: "image",
    name: "photo.jpg",
    mime: "image/jpeg",
    sizeBytes: 10,
    contentHash: "h1",
    localPath: "/assets/originals/asset-1.jpg",
    source: "direct_import",
    archived: false,
    favorite: true,
    createdAt: "2026-08-11 01:00:00",
    updatedAt: "2026-08-11 01:00:00",
    tags: ["trip"],
  },
  {
    assetId: "asset-2",
    kind: "video",
    name: "clip.mp4",
    mime: "video/mp4",
    sizeBytes: 20,
    contentHash: "h2",
    localPath: "/assets/originals/asset-2.mp4",
    source: "inbox",
    sourceInboxId: "in-9",
    archived: true,
    favorite: false,
    createdAt: "2026-08-11 02:00:00",
    updatedAt: "2026-08-11 02:00:00",
    tags: [],
  },
  {
    assetId: "asset-3",
    kind: "document",
    name: "report.pdf",
    mime: "application/pdf",
    sizeBytes: 30,
    contentHash: "h3",
    localPath: "/assets/originals/asset-3.pdf",
    source: "direct_import",
    archived: false,
    favorite: false,
    createdAt: "2026-08-11 03:00:00",
    updatedAt: "2026-08-11 03:00:00",
    tags: ["work"],
  },
];

const desktopAssets: DesktopAsset[] = [
  { desktopAssetId: "desk-1", name: "Desktop Image", kind: "image", mimeType: "image/png", sizeBytes: 5 },
  { desktopAssetId: "desk-2", name: "Desktop Doc", kind: "document", mimeType: "application/pdf", sizeBytes: 6 },
];

test("libraryFilter — all mode merges local + desktop when paired", () => {
  const res = filterLibraryAssets({ domain: "all", kind: "全部", localAssets, desktopAssets, isPaired: true });
  assert.equal(res.localItems.length, 3);
  assert.equal(res.desktopItems.length, 2);
  assert.equal(res.subtitleText, "全部素材 · 5");
});

test("libraryFilter — all mode hides desktop when unpaired", () => {
  const res = filterLibraryAssets({ domain: "all", kind: "全部", localAssets, desktopAssets, isPaired: false });
  assert.equal(res.localItems.length, 3);
  assert.equal(res.desktopItems.length, 0, "no Desktop domain without pairing");
  assert.equal(res.subtitleText, "全部素材 · 3");
});

test("libraryFilter — local mode shows local assets only", () => {
  const res = filterLibraryAssets({ domain: "local", kind: "全部", localAssets, desktopAssets, isPaired: true });
  assert.equal(res.localItems.length, 3);
  assert.equal(res.desktopItems.length, 0);
  assert.equal(res.subtitleText, "本机素材 · 3");
});

test("libraryFilter — count text distinguishes loaded from total (FIX-V1B P2)", () => {
  // Backend total 430 with only page 1 (50) loaded -> truthful loaded/total.
  const res = filterLibraryAssets({
    domain: "local",
    kind: "全部",
    localAssets: localAssets.slice(0, 2),
    desktopAssets,
    isPaired: true,
    localTotal: 430,
  });
  assert.equal(res.subtitleText, "已加载 2 / 共 430");
  // All rows loaded -> single truthful total, never "已加载 X / 共 X".
  const full = filterLibraryAssets({
    domain: "local",
    kind: "全部",
    localAssets,
    desktopAssets,
    isPaired: true,
    localTotal: 3,
  });
  assert.equal(full.subtitleText, "本机素材 · 3");
  // No backend total -> falls back to loaded count.
  const noTotal = filterLibraryAssets({ domain: "local", kind: "全部", localAssets, desktopAssets, isPaired: true });
  assert.equal(noTotal.subtitleText, "本机素材 · 3");
});

test("libraryFilter — desktop mode shows cached desktop only", () => {
  const res = filterLibraryAssets({ domain: "desktop", kind: "全部", localAssets, desktopAssets, isPaired: true });
  assert.equal(res.localItems.length, 0);
  assert.equal(res.desktopItems.length, 2);
  assert.equal(res.subtitleText, "Desktop 缓存 · 2");
  const unpaired = filterLibraryAssets({ domain: "desktop", kind: "全部", localAssets, desktopAssets, isPaired: false });
  assert.equal(unpaired.desktopItems.length, 0);
  assert.equal(unpaired.subtitleText, "未连接 Desktop");
});

test("libraryFilter — kind chips map exactly to local asset kinds", () => {
  assert.equal(localKindFilter("图片"), "image");
  assert.equal(localKindFilter("视频"), "video");
  assert.equal(localKindFilter("文档"), "document");
  assert.equal(localKindFilter("文件"), "file");
  assert.equal(localKindFilter("全部"), undefined);

  // FIX-V1 P1-2: Local Assets arrive already kind-filtered by SQL, so the pure
  // domain filter passes them through untouched (no client-side kind filter
  // can silently drop later pages); the Desktop cache domain still filters by
  // kind client-side.
  const images = filterLibraryAssets({ domain: "local", kind: "图片", localAssets, desktopAssets, isPaired: true });
  assert.deepEqual(images.localItems.map((a) => a.kind), ["image", "video", "document"], "local rows pass through SQL-filtered");
  const docs = filterLibraryAssets({ domain: "all", kind: "文档", localAssets, desktopAssets, isPaired: true });
  assert.deepEqual(docs.localItems.map((a) => a.kind), ["image", "video", "document"], "local rows untouched by client kind filter");
  assert.deepEqual(docs.desktopItems.map((a) => a.kind), ["document"], "desktop cache still kind-filtered");
  const videos = filterLibraryAssets({ domain: "all", kind: "视频", localAssets, desktopAssets, isPaired: true });
  assert.equal(videos.desktopItems.length, 0, "no desktop videos in the sample");
});
