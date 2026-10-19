// ORG-1A — the directory-mode status line (the same in-scroll slot contract
// as DesktopKnowledgeStatus). Quiet product copy per phase, with the Content
// V1 live/cache provenance explicit.
import React from "react";
import type { DirectorySnapshot } from "./knowledgeDirectoryController";

export function DirectoryStatusLine({ snapshot, onConnect, quiet = false }: {
  quiet?: boolean; snapshot: DirectorySnapshot;
  onConnect: () => void;
}) {
  if (quiet && (snapshot.phase === "ready" && snapshot.rows.length > 0
    || snapshot.phase === "loading-more"
    || snapshot.rows.length > 0 && (snapshot.phase === "offline" || snapshot.phase === "loading"))) return null;
  let copy: { tone: string; text: string; connect?: boolean } | null = null;
  switch (snapshot.phase) {
    case "loading": copy = { tone: "pending", text: `正在读取 ${snapshot.directory || "目录"}…` }; break;
    case "loading-more": copy = { tone: "pending", text: "正在加载更多…" }; break;
    case "offline": copy = { tone: "pending", text: "电脑暂未连接 · 显示已同步目录内容", connect: true }; break;
    case "error": copy = { tone: "danger", text: `目录读取失败${snapshot.errorCode ? `（${snapshot.errorCode}）` : ""}`, connect: true }; break;
    case "ready":
      if (snapshot.rows.length === 0) copy = { tone: "quiet", text: "暂无笔记" };
      else if (snapshot.source === "cache") copy = { tone: "quiet", text: "已缓存目录 · 电脑暂未连接" };
      break;
    default: copy = null;
  }
  if (!copy) return null;
  return (
    <div className={"st-kb-status is-" + copy.tone} role="status">
      <span>{copy.text}</span>
      {copy.connect ? (
        <button type="button" className="st-button st-button--quiet" onClick={onConnect}>查看连接</button>
      ) : null}
    </div>
  );
}
