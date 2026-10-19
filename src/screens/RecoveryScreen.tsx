// RecoveryScreen (STITCH-R6) — shown when local data cannot be loaded or
// upgraded.
//
// Visual source: R6 recovery page — a centered column with one plain-language
// explanation and one primary recovery action (plus quiet/destructive
// alternatives), and the raw health JSON inside a collapsed detail.
//
// Behaviour source: production, unchanged. Same recoverable actions and same
// transactional re-run semantics as before.
import { useState } from "react";

type Props = {
  health: { schemaVersion: number; expectedVersion: number; tablesOk: boolean; recovery?: string } | null;
  onRetry: () => void;
  onExportDiagnostics: () => void;
  onResetLocalData: () => void;
};

export default function RecoveryScreen({ health, onRetry, onExportDiagnostics, onResetLocalData }: Props) {
  const [done, setDone] = useState<string>("");
  // M2.13-B4 + FIX-V1 P1-C: a DB that could not be opened due to *confirmed
  // SQLite corruption* was quarantined at startup — the complete file set
  // (main db + WAL + SHM journal) under one luckyray-mobile.db.corrupt-*
  // suffix, nothing deleted. Only confirmed corruption (not ENOSPC / I/O /
  // permission) triggers this screen.
  const isolated = health?.recovery === "corrupt_isolated";

  return (
    <div className="recovery-page">
      <h2>{isolated ? "检测到本地数据库损坏" : "无法完成本地数据升级"}</h2>
      <p>
        {isolated
          ? "本地数据库文件因损坏无法打开，已备份整个数据库文件集（含主数据库与 WAL/SHM 日志），未删除任何内容；重置后这些备份文件仍会保留。你可以导出诊断信息，或重置本地数据 —— 本机灵感、笔记与素材会保留，App 以全新状态启动。"
          : "本地数据库版本异常，App 无法安全启动。你的配对与缓存数据没有丢失，可以重试升级或导出诊断信息。"}
      </p>

      <button
        className="primary btn-block"
        onClick={() => {
          onRetry();
          setDone("已重试 — 请查看上方信息");
        }}
      >
        重试
      </button>
      <button
        className="quiet btn-block"
        style={{ marginTop: 8 }}
        onClick={() => {
          onExportDiagnostics();
          setDone("诊断信息已导出到下载目录");
        }}
      >
        导出诊断
      </button>
      <button
        className="danger-btn btn-block"
        style={{ marginTop: 8 }}
        onClick={() => {
          onResetLocalData();
          setDone("已重置本地数据 — App 将以全新状态启动");
        }}
      >
        重置本地数据（清除配对与缓存）
      </button>

      {done ? <p style={{ color: "var(--accent)", marginTop: 14 }}>{done}</p> : null}

      {health ? (
        <details className="dev-section" style={{ marginTop: 22 }}>
          <summary>技术详情</summary>
          <div className="dev-body">
            <div className="log-box">
              <pre>{JSON.stringify(health, null, 2)}</pre>
            </div>
          </div>
        </details>
      ) : null}
    </div>
  );
}
