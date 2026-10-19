// M2.11 Companion Storage & Export — pure policy tests (dependency-free).
// Covers the host-testable contract of the issue body:
//   1. destination classification (image → Pictures; video → video; doc/file
//      → Downloads);
//   2. ambiguous MIME safely falls back to the general-file destination;
//   3. export filename sanitization keeps Unicode/CJK and blocks traversal +
//      control characters;
//   4. copy semantics text (system copy vs already-saved);
//   8. share MIME/kind classification;
//  10. content-URI policy is enforced natively (Rust refuses non-Mobile-owned
//      sources; see companion_export.rs tests) — here the share classification;
//  11. export source root allow-list (Rust side, host-tested);
//  12. cache classification separates user-owned originals from disposable
//      derived cache;
//  13. cache cleanup allow-list cannot reach originals / inbox / outbox / DB;
//  15. storage stats categories do not double-count (pure classification is
//      disjoint).
import test from "node:test";
import assert from "node:assert/strict";
import {
  CACHE_CLEANUP_ROOTS,
  classifyExportDestination,
  classifyStorageCategory,
  destinationLabel,
  exportActionLabel,
  exportCopyText,
  isCacheCleanupAllowed,
  sanitizeExportFileName,
  shareMimeFor,
  type ExportCollection,
} from "../src/services/exportPolicy.ts";

test("export — destination classification: image → Pictures, video → Movies, document/file → Downloads", () => {
  assert.equal(classifyExportDestination("image", "image/jpeg"), "Pictures");
  assert.equal(classifyExportDestination("image", ""), "Pictures");
  assert.equal(classifyExportDestination("document", "image/png"), "Pictures", "mime is authoritative for images");
  assert.equal(classifyExportDestination("video", "video/mp4"), "Movies");
  assert.equal(classifyExportDestination("video", ""), "Movies");
  assert.equal(classifyExportDestination("document", "application/pdf"), "Downloads");
  assert.equal(classifyExportDestination("file", "application/zip"), "Downloads");
  assert.equal(classifyExportDestination("document", ""), "Downloads");
});

test("export — ambiguous MIME safely falls back to the general-file destination", () => {
  assert.equal(classifyExportDestination("file", "application/octet-stream"), "Downloads");
  assert.equal(classifyExportDestination("file", "binary/unknown"), "Downloads");
  assert.equal(classifyExportDestination("file", ""), "Downloads");
  assert.equal(classifyExportDestination("", "application/x-msdownload"), "Downloads");
  assert.equal(classifyExportDestination("text", "text/plain"), "Downloads", "plain text is a general file here");
});

test("export — labels and action copy are explicit about system copies", () => {
  assert.equal(destinationLabel("Pictures"), "相册");
  assert.equal(destinationLabel("Movies"), "视频");
  assert.equal(destinationLabel("Downloads"), "Downloads");
  assert.equal(exportActionLabel("image"), "保存到相册");
  assert.equal(exportActionLabel("video"), "保存到视频");
  assert.equal(exportActionLabel("document"), "保存到下载");
  assert.equal(exportActionLabel("file"), "保存到下载");
  assert.equal(exportCopyText("created", "Pictures"), "已保存到系统相册（系统副本）");
  assert.equal(exportCopyText("already_exists", "Pictures"), "已存在于系统相册，未重复保存");
  assert.equal(exportCopyText("created", "Downloads"), "已保存到系统Downloads（系统副本）");
  // The copy never implies the LuckyRay source moved.
  assert.ok(!exportCopyText("created", "Pictures").includes("移动"), "no move semantics");
});

test("export — filename sanitization keeps CJK/Unicode and blocks traversal + control chars", () => {
  assert.equal(sanitizeExportFileName("照片 01.jpg"), "照片 01.jpg", "CJK preserved");
  assert.equal(sanitizeExportFileName("m27-share-test.jpg"), "m27-share-test.jpg");
  assert.equal(sanitizeExportFileName("a/b\\c.jpg"), "a_b_c.jpg", "path separators blocked");
  assert.equal(sanitizeExportFileName(".."), "export", "dot-dot cannot survive");
  assert.equal(sanitizeExportFileName("..hidden.txt"), "hidden.txt", "leading dots stripped");
  assert.equal(sanitizeExportFileName("a\u0000b.txt"), "a_b.txt", "NUL blocked");
  assert.equal(sanitizeExportFileName("a\u001fb.txt"), "a_b.txt", "control char blocked");
  assert.equal(sanitizeExportFileName("   "), "export", "whitespace-only falls back");
  assert.equal(sanitizeExportFileName(""), "export", "empty falls back");
  assert.ok(!sanitizeExportFileName("../../etc/passwd").includes("/"), "traversal impossible");
});

test("export — FIX-V1 P1-4: editable display names with separators/controls export safely", () => {
  // Local Asset display names are editable and may legitimately contain `/`,
  // `\` and control characters; sanitization (mirroring the authoritative
  // Rust sanitize_export_name) must turn them into a safe system filename
  // while preserving CJK.
  assert.equal(sanitizeExportFileName("旅行/照片\\\u0001A.jpg"), "旅行_照片__A.jpg");
  assert.equal(sanitizeExportFileName("a/b\\c\u0000d.txt"), "a_b_c_d.txt");
  // The sanitized result never contains a path separator or control char.
  for (const bad of ["旅行/照片\u0001A.jpg", "../../etc/passwd", "a\u0000b"]) {
    const s = sanitizeExportFileName(bad);
    assert.ok(!s.includes("/") && !s.includes("\\"), `${bad} -> ${s} has no separators`);
    assert.ok(!/[\u0000-\u001f\u007f]/.test(s), `${bad} -> ${s} has no control chars`);
  }
});

test("export — share MIME classification with safe fallback", () => {
  assert.equal(shareMimeFor("image", "image/jpeg"), "image/jpeg");
  assert.equal(shareMimeFor("video", "video/mp4"), "video/mp4");
  assert.equal(shareMimeFor("file", "application/pdf"), "application/pdf");
  assert.equal(shareMimeFor("image", ""), "image/*", "kind fallback for images");
  assert.equal(shareMimeFor("video", ""), "video/*", "kind fallback for video");
  assert.equal(shareMimeFor("file", ""), "application/octet-stream", "generic fallback for unknown types");
  assert.equal(shareMimeFor("file", "not a mime"), "application/octet-stream", "malformed mime rejected");
});

test("storage — classification separates user-owned originals from disposable derived cache", () => {
  assert.equal(classifyStorageCategory("local-inbox/att-1.jpg"), "inbox");
  assert.equal(classifyStorageCategory("local-assets/originals/asset-1.jpg"), "assetOriginals");
  assert.equal(classifyStorageCategory("local-assets/thumbs/thumb-1.jpg"), "thumbs");
  assert.equal(classifyStorageCategory("capture-outbox/ref-1.bin"), "outbox");
  assert.equal(classifyStorageCategory("local-assets/staging/stage-1.part"), "other", "staging is transient, not user data");
  assert.equal(classifyStorageCategory("luckyray-mobile.db"), "other", "DB is not a storage category");
  // The four user-visible categories are pairwise disjoint (no double counting
  // of the same path).
  const visible = new Set(["inbox", "assetOriginals", "thumbs", "outbox"]);
  for (const a of visible) {
    for (const b of visible) {
      if (a !== b) {
        const pa = pathForCategory(a);
        assert.equal(classifyStorageCategory(pa), a, `${pa} → ${a}`);
        assert.notEqual(classifyStorageCategory(pa), b, `no collision between ${a} and ${b}`);
      }
    }
  }
});

function pathForCategory(c: string): string {
  switch (c) {
    case "inbox":
      return "local-inbox/att-1.jpg";
    case "assetOriginals":
      return "local-assets/originals/asset-1.jpg";
    case "thumbs":
      return "local-assets/thumbs/thumb-1.jpg";
    default:
      return "capture-outbox/ref-1.bin";
  }
}

test("storage — cache cleanup allow-list can only reach disposable thumbs", () => {
  assert.ok(CACHE_CLEANUP_ROOTS.includes("local-assets/thumbs"), "exact disposable root listed");
  assert.equal(isCacheCleanupAllowed("local-assets/thumbs"), true);
  assert.equal(isCacheCleanupAllowed("local-assets/thumbs/thumb-1.jpg"), true);
  assert.equal(isCacheCleanupAllowed("local-assets/originals/asset-1.jpg"), false, "originals protected");
  assert.equal(isCacheCleanupAllowed("local-inbox/att-1.jpg"), false, "inbox attachments protected");
  assert.equal(isCacheCleanupAllowed("capture-outbox/ref-1.bin"), false, "pending outbox protected");
  assert.equal(isCacheCleanupAllowed("local-assets/staging/stage-1.part"), false, "staging protected");
  assert.equal(isCacheCleanupAllowed("luckyray-mobile.db"), false, "DB protected");
  assert.equal(isCacheCleanupAllowed("local-assets"), false, "parent dir not wholesale-cleanable");
  assert.equal(isCacheCleanupAllowed("local-assets/thumbs/../originals/asset-1.jpg"), false, "traversal cannot reach originals");
});
