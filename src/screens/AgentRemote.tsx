// AgentRemote.tsx (STITCH-R6) — AI / Agent, a PERMANENT bottom-nav root.
//
// Visual source: R6 `function ai(mode)` — status row → ai-hero → 最近任务 run
// rows; plus the intentional unpaired and connected-empty states.
//
// The tab exists in EVERY connection state (DESIGN.md §6). Unpaired shows
// Connect Computer guidance; offline is truthful; connected shows real runs.
// Capability stays exactly runs / events / refresh / stop — no chat composer,
// no prompt input, no model select, no agent creation (FEATURE_PARITY.md).
import { useEffect, useState } from "react";
import { api, type ConnState } from "../services/client";
import { IconAi, IconRefresh, IconStop } from "../components/icons";
import { AGENT_CAPABILITY_LABEL } from "../services/productShell";
import { failureCopy } from "../services/feedback";
import { toast } from "../services/toast";
import { BackHeader, EmptyState, Notice, SectionTitle } from "../components/ui";
import type { Tab } from "../App";

type Props = { conn: ConnState | null; go?: (tab: Tab, detail?: string) => void };

export default function AgentRemote({ conn, go }: Props) {
  const [runs, setRuns] = useState<any[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  async function loadRuns() {
    if (!conn?.paired) return;
    try {
      setRuns(await api.agentRuns());
    } catch {
      /* unreachable Desktop simply yields no runs; the empty state explains */
    } finally {
      setReady(true);
    }
  }

  useEffect(() => {
    loadRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn?.paired]);

  async function openRun(runId: string) {
    setActive(runId);
    setEvents([]);
    setMessage("");
    try {
      const r = await api.agentEvents(runId);
      setEvents(r.events || []);
    } catch (e: any) {
      setMessage(failureCopy(e, "暂时读不到这个任务的事件。"));
    }
  }

  async function stop(runId: string) {
    setBusy(true);
    try {
      await api.agentStop(runId);
      toast.success("已请求停止");
      await loadRuns();
    } catch (e: any) {
      toast.error(failureCopy(e, "停止失败，请重试。"));
    } finally {
      setBusy(false);
    }
  }

  // ---- Agent event detail (pushed child) --------------------------------
  if (active) {
    const run = runs.find((r) => r.runId === active);
    return (
      <>
        <BackHeader
          title="执行事件"
          backLabel="返回任务列表"
          onBack={() => setActive(null)}
          right={
            <button className="nav-action" aria-label="刷新事件" onClick={() => openRun(active)}>
              <IconRefresh size={18} />
            </button>
          }
        />
        <div className="subline" style={{ marginBottom: 8 }}>
          <span className={`dot${run?.status === "running" ? "" : " idle"}`} />
          {run?.status === "running" ? "运行中" : run?.status || "—"} · {(run?.runId || "").slice(0, 12)}…
        </div>
        {message ? <Notice tone="warn">{message}</Notice> : null}
        <SectionTitle title="事件" meta={String(events.length)} />
        {events.length === 0 ? (
          <EmptyState title="暂无事件" body="任务还没有产生可查看的执行事件。" />
        ) : (
          <div>
            {events.map((e) => (
              <div key={e.seq} className="event">
                <span className="seq">#{e.seq}</span>
                <div>
                  <b>{e.type}</b>
                  <pre>{JSON.stringify(e.payload, null, 2)}</pre>
                </div>
              </div>
            ))}
          </div>
        )}
        <button
          className="quiet btn-block"
          style={{ marginTop: 18, color: "var(--danger)" }}
          disabled={busy}
          onClick={() => stop(active)}
        >
          <IconStop size={16} /> 停止任务
        </button>
      </>
    );
  }

  // ---- Unpaired: AI stays visible, shows Connect Computer guidance -------
  if (!conn?.paired) {
    return (
      <>
        <div className="root-content-start" />
        <EmptyState
          icon={<IconAi size={20} />}
          title="连接电脑后查看 Agent"
          body="这里用于查看电脑上正在执行或已经完成的 Agent 任务。手机端不会创建本地 AI，也不会伪造聊天能力。"
          action={
            go ? (
              <button className="primary" onClick={() => go("settings", "connect-computer")}>
                连接电脑
              </button>
            ) : undefined
          }
        />
      </>
    );
  }

  const running = runs.filter((r) => r.status === "running").length;
  const online = conn.ws?.state === "connected";

  return (
    <>
      <div className="root-status-row">
        <div className="subline">
          <span className={"dot" + (online ? "" : " idle")} />
          {online ? "电脑已连接 · Agent 可用" : "已配对 · 未实时连接"}
        </div>
        <button className="nav-action" aria-label="刷新 Agent 任务" onClick={() => void loadRuns()}>
          <IconRefresh size={18} />
        </button>
      </div>

      {runs.length === 0 ? (
        <EmptyState
          icon={<IconAi size={20} />}
          title={ready ? "暂无 Agent 任务" : "正在读取…"}
          body={ready ? "在电脑上发起 Agent 任务后，会在这里出现执行状态与事件。" : undefined}
        />
      ) : (
        <>
          <div className="ai-hero">
            <strong>{running ? `${running} 个任务正在运行` : "暂无运行中的任务"}</strong>
            <p>{AGENT_CAPABILITY_LABEL}</p>
          </div>
          <SectionTitle title="最近任务" />
          <div>
            {runs.map((r) => (
              <button key={r.runId} className="run-row tappable" onClick={() => openRun(r.runId)}>
                <span className="run-top">
                  <span className={"run-status" + (r.status === "running" ? "" : " idle")} style={r.status === "running" ? undefined : { background: "var(--tertiary)" }} />
                  <span className="run-title">{r.summary || "Agent 任务"}</span>
                  <span className={"row-state" + (r.status === "running" ? "" : " muted")}>{runStateLabel(r.status)}</span>
                </span>
                <span className="run-meta">
                  {(r.startedAt || "").replace("T", " ").slice(0, 16)}
                  {r.status === "running" ? (
                    <>
                      {" · "}
                      <span
                        role="button"
                        tabIndex={0}
                        style={{ color: "var(--danger)" }}
                        onClick={(e) => {
                          e.stopPropagation();
                          stop(r.runId);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.stopPropagation();
                            stop(r.runId);
                          }
                        }}
                      >
                        停止
                      </span>
                    </>
                  ) : null}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function runStateLabel(status: string): string {
  switch (status) {
    case "running":
      return "运行中";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    case "stopping":
      return "正在停止";
    default:
      return status || "";
  }
}
