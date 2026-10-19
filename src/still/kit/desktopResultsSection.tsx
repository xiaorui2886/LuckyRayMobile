// SERVICES-SEARCH-R1 REPAIR-R1-D — the ordinary product's Desktop search
// results presentation, extracted as a REAL component so the page and the
// visual-QA fixture render the exact same tree (no hand-copied markup).
//
// It renders the canonical `RemoteSearchSnapshot` only: truthful settled
// states (unpaired / offline / not-granted / temporarily-unavailable /
// unsupported / error), the canonical ranked 电脑结果 list in EXACT server
// order, the nextCursor-gated 加载更多电脑结果 control, and the bounded quiet
// copy. Routing stays with the page (which owns navigation).

import { Button, Row, SectionTitle } from "../../presentation/still01/Still";
import type { RemoteSearchSnapshot } from "./searchServicesController.ts";
import type { SearchHit } from "../../../shared/companion-services-v1/types.ts";

export type DesktopResultsProps = {
  remote: RemoteSearchSnapshot;
  localCount: number;
  onOpenHit: (hit: SearchHit) => void;
  onLoadMore: () => void;
};

/** Truthful bounded remote-unavailable copy (also used in the empty body). */
export function remoteSearchUnavailableText(remote: RemoteSearchSnapshot): string {
  switch (remote.phase) {
    case "unpaired": return "";
    case "offline": return "电脑暂时连不上。";
    case "not-granted": return "电脑搜索需要权限：请在电脑端开启后重试。";
    case "temporarily-unavailable": return "电脑搜索暂时不可用。";
    case "unsupported": return "当前电脑版本不支持此搜索。";
    case "error": return "电脑搜索暂时失败。";
    default: return "";
  }
}

export function searchHitTitle(hit: SearchHit): string {
  return hit.title || (hit.domain === "materials" ? "未命名素材" : "未命名笔记");
}

export function searchHitMeta(hit: SearchHit): string {
  return hit.domain === "materials"
    ? (hit.subtitle || "电脑素材")
    : [hit.path, hit.snippet].filter(Boolean).join(" · ") || "电脑笔记";
}

/** One quiet factual row (no raw error codes). */
export function QuietRow({ text }: { text: string }) {
  return (
    <div className="st-source-row st-source-quiet" role="status" style={{ padding: "10px 23px" }}>
      {text}
    </div>
  );
}

export function DesktopResultsSection({ remote, localCount, onOpenHit, onLoadMore }: DesktopResultsProps) {
  if (remote.phase === "idle") return null;
  if (remote.phase === "waiting-catalog" || remote.phase === "loading") {
    return localCount > 0 ? <SectionTitle>电脑结果 · 搜索中…</SectionTitle> : null;
  }
  if (remote.phase === "unpaired") {
    return <QuietRow text="连接电脑后可以一起搜索电脑上的内容。" />;
  }
  if (remote.phase === "offline") {
    return <QuietRow text="电脑暂时连不上：本机结果仍可用，恢复连接后会自动重新搜索。" />;
  }
  if (remote.phase === "not-granted") {
    return <QuietRow text="电脑搜索需要素材/笔记读取权限：请在电脑端开启后重试。" />;
  }
  if (remote.phase === "temporarily-unavailable") {
    return <QuietRow text="电脑搜索暂时不可用，稍后重试。" />;
  }
  if (remote.phase === "unsupported") {
    return <QuietRow text="当前电脑版本不支持此搜索。" />;
  }
  if (remote.phase === "error") {
    return localCount > 0
      ? <QuietRow text="电脑搜索暂时失败，本机结果不受影响。" />
      : <QuietRow text="电脑搜索暂时失败，请稍后重试。" />;
  }
  const loadingMore = remote.phase === "loading-more";
  return (
    <>
      <SectionTitle>
        电脑结果{remote.recovered ? " · 已刷新" : ""}{remote.hits.length ? ` · ${remote.hits.length}` : ""}
      </SectionTitle>
      {remote.hits.length === 0 ? (
        <QuietRow text="电脑上没有找到相关内容。" />
      ) : (
        remote.hits.map((hit, i) => (
          <Row
            key={`${hit.domain}-${hit.domain === "materials" ? hit.assetId : hit.noteId}-${i}`}
            title={searchHitTitle(hit)}
            meta={searchHitMeta(hit)}
            onClick={() => onOpenHit(hit)}
          />
        ))
      )}
      {remote.nextCursor ? (
        <div style={{ marginTop: 14 }}>
          <Button kind="quiet" disabled={loadingMore} onClick={onLoadMore}>
            {loadingMore ? "加载中…" : "加载更多电脑结果"}
          </Button>
        </div>
      ) : null}
    </>
  );
}
