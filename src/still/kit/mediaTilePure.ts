// MATERIAL-LIBRARY-INSTANT-R1 — pure tile helpers (no React, unit-loadable).
//
// The previous markup rendered `<img src={a.src} />` unconditionally, so an
// empty source or a failed decode produced the WebView's broken-image glyph.
export type MediaKind = "image" | "video" | "document";

/** Product art label for a kind with no usable thumbnail. */
export function mediaPlaceholderLabel(kind: MediaKind): string {
  return kind === "video" ? "视频" : kind === "document" ? "文档" : "图片";
}

/** Never render an <img> for an empty src or a failed load. */
export function shouldRenderImage(src: string, failed: boolean): boolean {
  return Boolean(src) && !failed;
}
