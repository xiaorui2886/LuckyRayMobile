// SERVICES-ASSET-DETAIL-R1 / REPAIR-R1 — the ordinary product's Services
// source + presentation section, extracted as a REAL component so StillAsset
// and the visual-QA fixture render the exact same tree.
//
// Content V1 stays the primary detail authority; this section is additive:
//   - canonical source fidelity (label / origin / capture-kind / exact URL);
//   - system-browser open + exact copy of the canonical URL;
//   - 「重试来源」 whenever the enrichment failed (GRANT_REQUIRED / offline /
//     unavailable / transport) — the permission-change recovery path is the
//     user's explicit retry; no polling, no new wire protocol;
//   - 「在电脑打开」 with truthful bounded feedback.

import { Button } from "./StillImports";
import { captureKindText, type SourceBlockState } from "../../services/sourceBlock";
import type { PresentFeedback } from "../../services/presentationAction";

export type ServicesSourceSectionProps = {
  /** Media-first detail; full source/actions remain in its existing info sheet. */
  compact?: boolean;
  block: SourceBlockState;
  loading: boolean;
  errorCode?: string;
  present: PresentFeedback | null;
  pendingPresent: boolean;
  copyState: "idle" | "copied" | "failed";
  onRetrySource: () => void;
  onOpenBrowser: () => void;
  onCopy: () => void;
  onOpenDesktop: () => void;
};

/** Truthful retry guidance for a failed enrichment. */
export function sourceRetryText(code: string | undefined): string {
  switch (code) {
    case "GRANT_REQUIRED":
      return "来源信息需要素材读取权限。在电脑端开启权限后，点「重试来源」即可。";
    case "SERVICE_UNAVAILABLE":
      return "电脑暂时连不上，来源信息稍后再试。";
    case "SOURCE_CHANGED":
      return "这条素材的所属电脑已变化，来源信息不可用。";
    default:
      return "来源信息暂时不可用。";
  }
}

export function ServicesSourceSection({
  compact = false,
  block, loading, errorCode, present, pendingPresent, copyState,
  onRetrySource, onOpenBrowser, onCopy, onOpenDesktop,
}: ServicesSourceSectionProps) {
  const failed = !loading && block.kind !== "page" && block.kind !== "no-source";
  const feedback = present ? (
    <div className={`st-source-row st-source-quiet${present.tone === "error" ? " st-source-error" : ""}`}
      role="status" data-testid="presentation-feedback">{present.text}</div>
  ) : null;
  if (compact) {
    if (!loading && !failed && block.kind !== "page" && !present) return null;
    let host = "来源页面";
    if (block.kind === "page") {
      try { host = new URL(block.pageUrl).host; } catch { /* safe-source gate remains authoritative */ }
    }
    return (
      <div className="st-asset-source is-compact" data-testid="asset-source-block">
        {block.kind === "page" ? (
          <a className="st-source-url" data-testid="source-url" href={block.pageUrl}
            target="_blank" rel="noreferrer noopener"
            onClick={(e) => { e.preventDefault(); onOpenBrowser(); }}>{block.label} · {host}</a>
        ) : loading ? <div className="st-source-quiet" role="status">正在读取来源信息…</div>
          : failed ? <div className="st-source-quiet" role="status">{sourceRetryText(errorCode)}</div> : null}
        {failed ? <div className="st-source-actions"><Button kind="quiet" onClick={onRetrySource}>重试来源</Button></div> : null}
        {feedback}
      </div>
    );
  }
  return (
    <div className="st-asset-source" data-testid="asset-source-block">
      {loading || block.kind === "loading" ? (
        <div className="st-source-row st-source-quiet" role="status">正在读取来源信息…</div>
      ) : block.kind === "no-source" ? (
        <div className="st-source-row st-source-quiet">
          未记录网页来源{captureKindText(block.captureKind) ? ` · ${captureKindText(block.captureKind)}` : ""}
        </div>
      ) : block.kind === "page" ? (
        <>
          <div className="st-source-head">
            <span className="st-source-label">{block.label}</span>
            {block.siteOrigin ? <span className="st-source-origin">{block.siteOrigin}</span> : null}
            {captureKindText(block.captureKind) ? (
              <span className="st-source-origin">{captureKindText(block.captureKind)}</span>
            ) : null}
          </div>
          <a
            className="st-source-url"
            data-testid="source-url"
            href={block.pageUrl}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(e) => { e.preventDefault(); onOpenBrowser(); }}
          >
            {block.pageUrl}
          </a>
          <div className="st-source-actions">
            <Button kind="quiet" onClick={onOpenBrowser}>在浏览器打开</Button>
            <Button kind="quiet" onClick={onCopy}>
              {copyState === "copied" ? "已复制" : "复制链接"}
            </Button>
            <Button kind="quiet" disabled={pendingPresent} onClick={onOpenDesktop}>在电脑打开</Button>
          </div>
        </>
      ) : failed ? (
        <div className="st-source-row st-source-quiet" role="status">
          {sourceRetryText(errorCode)}
        </div>
      ) : null}
      {failed ? (
        <div className="st-source-actions">
          <Button kind="quiet" onClick={onRetrySource}>重试来源</Button>
        </div>
      ) : null}
      {block.kind !== "page" ? <div className="st-source-actions">
        <Button kind="quiet" disabled={pendingPresent} onClick={onOpenDesktop}>
          在电脑打开
        </Button>
      </div> : null}
      {feedback}
    </div>
  );
}
