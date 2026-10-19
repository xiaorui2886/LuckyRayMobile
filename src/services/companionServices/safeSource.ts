// SafeSource fidelity (Issue #77 §3.5) — the canonical source is consumed
// EXACTLY, never normalised down.
//
// Critical regressions this module exists to prevent:
//   - collapsing a work page to its origin;
//   - stripping ordinary (non-secret) query parameters or SPA fragments;
//   - reconstructing a work page from a CDN/media URL;
//   - promoting an origin-only / capture-page input into a work page.
//
// The canonical `SafeSource` DTO is already reduced and safe; the client's job
// is to carry it byte-for-byte. There is no re-derivation here at all.

import type { SafeSource } from "../../../shared/companion-services-v1/types.ts";

export type SourceFidelity = {
  captureKind: SafeSource["captureKind"];
  pageKind: SafeSource["pageKind"];
  /** Byte-for-byte as received — query and hash included. */
  pageUrl: string | undefined;
  siteOrigin: string | undefined;
};

/**
 * Carry a canonical SafeSource through the client unchanged.
 *
 * Deliberately a direct field copy: any transformation (origin reduction,
 * query stripping, media-URL promotion) would be a fidelity regression.
 */
export function carrySafeSource(source: SafeSource | undefined): SourceFidelity {
  return {
    captureKind: source?.captureKind ?? "unknown",
    pageKind: source?.pageKind,
    pageUrl: source?.pageUrl,
    siteOrigin: source?.siteOrigin,
  };
}

/** True when this is a WORK page (the only kind that owns a page URL). */
export function isWorkPage(source: { pageKind?: string } | undefined): boolean {
  return source?.pageKind === "work-page";
}

/**
 * A work page must keep its FULL safe URL. Returning false means the fidelity
 * contract was violated somewhere upstream.
 */
export function preservesWorkPageUrl(source: SafeSource | undefined): boolean {
  if (!source || source.pageKind !== "work-page") return true;
  if (typeof source.pageUrl !== "string" || source.pageUrl.length === 0) return false;
  // The URL must not have been reduced to a bare origin.
  //
  // Note the trailing slash: `new URL("https://x/").href` is "https://x/" while
  // `.origin` is "https://x", so comparing href to origin directly would never
  // match. Compare the path/query/hash carried by the URL instead: an
  // origin-only URL has none of them.
  try {
    const url = new URL(source.pageUrl);
    return url.pathname !== "/" || url.search !== "" || url.hash !== "";
  } catch {
    return false;
  }
}
