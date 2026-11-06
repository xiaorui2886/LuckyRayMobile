// MATERIAL-LIBRARY-INSTANT-R1 — pure tile helpers (no React, unit-loadable).
//
// The previous markup rendered `<img src={a.src} />` unconditionally, so an
// empty source or a failed decode produced the WebView's broken-image glyph.
export type MediaKind = "image" | "video" | "document" | "audio" | "other";

/** Product art label for a kind with no usable thumbnail. */
export function mediaPlaceholderLabel(kind: MediaKind): string {
  return kind === "video" ? "视频" : kind === "document" ? "文档" : kind === "audio" ? "音频" : kind === "other" ? "文件" : "图片";
}

/** Never render an <img> for an empty src or a failed load. */
export function shouldRenderImage(src: string, failed: boolean): boolean {
  return Boolean(src) && !failed;
}

/** File format is derived from real metadata, never a fabricated page preview. */
export function fileFormat(title: string, kind: MediaKind): string {
  const ext = title.match(/\.([a-z0-9]{1,10})$/i)?.[1]?.toUpperCase();
  return ext || ({image:"IMG",video:"VIDEO",document:"DOC",audio:"AUDIO",other:"FILE"}[kind]);
}
export function isTextPreview(name: string, mime = ""): boolean {
  return mime.startsWith("text/") || /\.(txt|md|markdown|csv|json|xml|log|yaml|yml|js|ts|py|css|html|rs|kt)$/i.test(name);
}
export function localThumbnailSupported(name: string, kind: string, mime = ""): boolean {
  return kind === "image" || kind === "video" || kind === "audio" || mime.startsWith("audio/") || /\.(mp3|m4a|flac|ogg|wav|aac|opus)$/i.test(name) || mime === "application/pdf" || /\.pdf$/i.test(name) || isTextPreview(name, mime);
}

export function materialDisplayKind(kind: string, name: string, mime = ""): MediaKind {
  if (kind === "image" || kind === "video" || kind === "document" || kind === "audio") return kind;
  if (mime.startsWith("audio/") || /\.(mp3|m4a|flac|ogg|wav|aac|opus)$/i.test(name)) return "audio";
  if (mime === "application/pdf" || isTextPreview(name, mime) || /\.(pdf|docx?|pptx?|xlsx?)$/i.test(name)) return "document";
  return "other";
}
