// SERVICES-ASSET-DETAIL-R1 — truthful source-block presentation semantics.
//
// Pure functions mapping a canonical Services V1 `MaterialDetail.source`
// (via `carrySafeSource()`) onto ordinary-product copy and affordances:
//   - the page URL is shown EXACTLY as canonical (never re-derived from a
//     cached path, media URL or bare origin; query/hash preserved);
//   - labels: work-page → 原作品页面, capture-page → 采集页面,
//     unknown-but-has-URL → 来源页面, no URL → quiet no-source state;
//   - `siteOrigin` is supplemental text only, never promoted into a page link.

import type { MaterialDetail } from "../../shared/companion-services-v1/types.ts";
import { carrySafeSource, type SourceFidelity } from "./companionServices/safeSource.ts";

export type SourceBlockState =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "no-source"; captureKind?: string }
  | {
      kind: "page";
      label: string;
      pageUrl: string;
      siteOrigin?: string;
      captureKind?: string;
    };

export type SourceErrorCode =
  | "GRANT_REQUIRED" | "SCOPE_DENIED" | "SERVICE_UNAVAILABLE" | "SOURCE_CHANGED"
  | "ENTITY_NOT_FOUND" | "PAIRING_REQUIRED" | string;

export type SourceLoadState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready"; source: SourceFidelity }
  | { phase: "error"; code: SourceErrorCode };

const CAPTURE_KIND_TEXT: Record<string, string> = {
  web: "网页采集",
  import: "文件导入",
  clipboard: "剪贴板",
  unknown: "未知方式",
};

/** Truthful capture-kind text, or undefined when nothing should be shown. */
export function captureKindText(captureKind: string | undefined): string | undefined {
  if (!captureKind) return undefined;
  return CAPTURE_KIND_TEXT[captureKind];
}

/**
 * Derive the source-block state from a canonical MaterialDetail.
 * The URL is carried EXACTLY (query/hash included) by `carrySafeSource`.
 */
export function sourceBlockOf(detail: MaterialDetail | null | undefined): SourceBlockState {
  if (!detail) return { kind: "loading" };
  const carried = carrySafeSource(detail.source);
  if (!carried.pageUrl) {
    return { kind: "no-source", captureKind: carried.captureKind };
  }
  let label: string;
  if (carried.pageKind === "work-page") label = "原作品页面";
  else if (carried.pageKind === "capture-page") label = "采集页面";
  else label = "来源页面";
  return {
    kind: "page",
    label,
    pageUrl: carried.pageUrl,
    siteOrigin: carried.siteOrigin,
    captureKind: carried.captureKind,
  };
}

/** The exact canonical URL handed to the system opener / clipboard. */
export function canonicalPageUrl(state: SourceBlockState): string | null {
  return state.kind === "page" ? state.pageUrl : null;
}
