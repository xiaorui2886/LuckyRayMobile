// Mobile Companion Storage & Export policy (M2.11) — dependency-free pure
// logic so the exact contract is unit-testable without the Tauri client or a
// device:
//
//  - destination classification: image → Pictures, video → Movies,
//    document/general/ambiguous → Downloads (system MediaStore collections);
//  - export filename sanitization: preserves useful Unicode/CJK, blocks path
//    traversal and control characters;
//  - explicit copy semantics text (system copy vs already-saved);
//  - share MIME classification with a safe fallback for unknown types;
//  - storage category classification + the cache-cleanup allow-list (user
//    owned data vs disposable derived cache).
//
// Scope H: this file is the small file/stream-oriented source abstraction —
// a future M3 Desktop stream/on-demand file can reuse classify/ sanitize/
// share classification without any Desktop code today.

export type ExportCollection = "Pictures" | "Movies" | "Downloads";

export type ExportStatus = "created" | "already_exists" | "error";

export type ExportResult = {
  status: ExportStatus;
  destination?: string;
  displayName?: string;
  uri?: string;
  bytes?: number;
  message?: string;
};

/** MediaStore destination for a Mobile-owned file.
 *  image/photo → Pictures; video → Movies; everything else (including
 *  ambiguous MIME) → Downloads. Never misclassifies binary content. */
export function classifyExportDestination(kind: string, mime: string): ExportCollection {
  if (kind === "image" || mime.startsWith("image/")) return "Pictures";
  if (kind === "video" || mime.startsWith("video/")) return "Movies";
  return "Downloads";
}

/** User-visible destination label for the chosen collection. */
export function destinationLabel(collection: ExportCollection): string {
  switch (collection) {
    case "Pictures":
      return "相册";
    case "Movies":
      return "视频";
    default:
      return "Downloads";
  }
}

/** Action label for the detail-level save button. */
export function exportActionLabel(kind: string): string {
  if (kind === "image") return "保存到相册";
  if (kind === "video") return "保存到视频";
  return "保存到下载";
}

/**
 * Sanitize an export display name: preserves Unicode/CJK, replaces path
 * separators and C0/C1 control characters, trims leading dots (no hidden
 * dotfiles / ".."), and guarantees a non-empty result. Extension is kept.
 */
export function sanitizeExportFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/\u0000-\u001f\u007f]/g, "_")
    .trim()
    .replace(/^\.+/, "");
  return cleaned || "export";
}

/** Explicit copy-semantics success text (never implies the source moved). */
export function exportCopyText(status: "created" | "already_exists", collection: ExportCollection): string {
  const label = destinationLabel(collection);
  if (status === "created") {
    return `已保存到系统${label}（系统副本）`;
  }
  return `已存在于系统${label}，未重复保存`;
}

/** Share MIME: the source MIME when plausible, else a safe generic fallback. */
export function shareMimeFor(kind: string, mime: string): string {
  const m = (mime || "").trim();
  if (m.includes("/") && !m.includes(" ") && m.length <= 128) return m;
  if (kind === "image") return "image/*";
  if (kind === "video") return "video/*";
  return "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Storage transparency (Scope F) — pure classification
// ---------------------------------------------------------------------------

export type StorageCategory = "inbox" | "assetOriginals" | "thumbs" | "outbox" | "other";

/** Classify a filesDir-relative path into a storage category. */
export function classifyStorageCategory(relativePath: string): StorageCategory {
  if (relativePath.startsWith("local-inbox/")) return "inbox";
  if (relativePath.startsWith("local-assets/originals/")) return "assetOriginals";
  if (relativePath.startsWith("local-assets/thumbs/")) return "thumbs";
  if (relativePath.startsWith("capture-outbox/")) return "outbox";
  return "other";
}

export const storageCategoryLabel: Record<StorageCategory, string> = {
  inbox: "本地收集附件",
  assetOriginals: "本机素材原件",
  thumbs: "预览/缩略图缓存",
  outbox: "待推送 Desktop",
  other: "其他",
};

/**
 * Cache-cleanup allow-list: the ONLY disposable derived-cache roots a cleanup
 * may touch (relative to filesDir). The native bridge mirrors this exact list
 * plus the `cacheDir/thumb-*.img` pattern. Never originals / inbox
 * attachments / staging / capture outbox / DB / Keystore.
 */
export const CACHE_CLEANUP_ROOTS: readonly string[] = ["local-assets/thumbs"];

export function isCacheCleanupAllowed(relativePath: string): boolean {
  // A cleanup action can never traverse — any `..` segment is refused outright
  // (the native bridge only lists the fixed roots; this is defense in depth).
  if (relativePath.split("/").includes("..")) return false;
  return CACHE_CLEANUP_ROOTS.some(
    (root) => relativePath === root || relativePath.startsWith(root + "/")
  );
}
