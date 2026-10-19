// SERVICES-KNOWLEDGE-BROWSE-R1 REPAIR-R1 (4) — the REAL Desktop knowledge
// status line. Every canonical browse phase lands here as product copy,
// inside the view flow (between the toolbar and the notes), so a QA sweep of
// this component IS the product presentation. The Desktop source never falls
// through to the local "给想法留个位置 / 新建笔记" empty composition.

import { Button } from "./StillImports";
import type { KnowledgeBrowseSnapshot } from "./knowledgeBrowseController";

export function DesktopKnowledgeStatus({ snapshot: s, onConnect, quiet = false }: {
  quiet?: boolean; snapshot: KnowledgeBrowseSnapshot;
  onConnect: () => void;
}) {
  if (quiet && (s.phase === "searching" || s.phase === "loading-more"
    || s.rows.length > 0 && ["offline", "loading", "waiting-catalog", "discovering-vault"].includes(s.phase))) return null;
  let copy: { tone: string; text: string; connect?: boolean } | null = null;
  switch (s.phase) {
    case "waiting-catalog":
    case "discovering-vault":
      copy = { tone: "pending", text: "正在连接电脑知识库…" };
      break;
    case "loading":
      copy = { tone: "pending", text: `正在从电脑读取${s.vaultName || ""}…` };
      break;
    case "searching":
      // R1.5-C: a certified same-vault query refinement — the last-good rows
      // stay painted; this is never a re-connection phase.
      copy = { tone: "quiet", text: "正在搜索…" };
      break;
    case "loading-more":
      copy = { tone: "pending", text: "正在加载更多…" };
      break;
    case "offline":
      copy = s.replica
        ? { tone: "quiet", text: "电脑暂未连接 · 已保存的笔记可用", connect: true }
        : { tone: "pending", text: "电脑暂未连接 · 本机知识库仍可用", connect: true };
      break;
    case "not-granted":
      copy = {
        tone: "danger",
        text: s.remoteCode
          ? "未获电脑知识库读取授权（可在电脑端开启后重试）"
          : "未获电脑知识库读取授权 · 可在电脑端开启「知识库读取」",
        connect: true,
      };
      break;
    case "temporarily-unavailable":
      copy = { tone: "danger", text: "电脑知识库暂时不可用，请稍后重试", connect: true };
      break;
    case "unsupported":
      copy = { tone: "danger", text: "当前电脑版本不支持知识库读取" };
      break;
    case "error":
      if (s.errorCode.includes("RATE_LIMITED")) {
        copy = { tone: "quiet", text: s.rows.length ? "电脑响应繁忙 · 保留上次内容，请稍后刷新" : "电脑响应繁忙，请稍后刷新" };
        break;
      }
      copy = {
        tone: "danger",
        text: `电脑知识库暂时不可用${s.errorCode ? `（${s.errorCode}）` : ""}`,
        connect: true,
      };
      break;
    case "ready":
      if (s.rows.length === 0) copy = { tone: "quiet", text: `电脑知识库没有匹配的笔记${s.query ? "" : "，还没有笔记同步到手机"}` };
      break;
    default:
      copy = null;
  }
  if (!copy) return null;
  return (
    <div className={"st-kb-status is-" + copy.tone} role="status">
      <span>{copy.text}</span>
      {copy.connect ? (
        <Button kind="quiet" onClick={onConnect}>查看连接</Button>
      ) : null}
    </div>
  );
}
