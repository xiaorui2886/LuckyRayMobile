// STILL-01.1 — AI root (AgentView) + 执行过程 page.
// Capability stays runs / events / refresh / stop — no chat composer, no
// prompt input, no agent creation. Real events are rendered as-is; the UI
// never invents execution history.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AgentView, type RunItem } from "../presentation/still01/Views";
import { Header, IconButton, Button, Sheet, Empty, Icon } from "./kit/StillImports";
import { api, type ConnState } from "../services/client";import { AGENT_CAPABILITY_LABEL } from "../services/productShell";
import { failureCopy } from "../services/feedback";
import { toast } from "../services/toast";
import { relativeDay } from "./stillData";
import { AgentCapabilityController, type AgentSnapshot } from "./kit/agentCapability";
import { LshSurfaceController, lshErrorCopy } from "./kit/lshSurface";
import { PageDataFence } from "./kit/pageDataFence";
import { useStillNav } from "./StillShell";


/** The SINGLE capability owner: one controller per page, no derived copies. */
function useAgentCapability(conn: ConnState | null): { snap: AgentSnapshot; retry: () => void } {
  const ref = useRef<AgentCapabilityController | null>(null);
  if (!ref.current) {
    ref.current = new AgentCapabilityController({
      probe: async () => {
        const hello: any = await api.connHello();
        return {
          runs: hello?.capabilities?.runs === true,
          lshRemoteSurface: hello?.capabilities?.lshRemoteSurface === true,
        };
      },
    });
  }
  const controller = ref.current;
  const paired = Boolean(conn?.paired);
  const connected = Boolean(conn?.paired && conn?.ws?.state === "connected");
  const instanceId = conn?.identity?.instanceId || "";
  useEffect(() => {
    controller.setConnection({ paired, connected, instanceId });
  }, [controller, paired, connected, instanceId]);
  const snap = useSyncExternalStore<AgentSnapshot>(
    (fn) => controller.subscribe(fn),
    () => controller.snapshot()
  );
  return { snap, retry: () => controller.retry() };
}

function stillStatus(status: string): RunItem["status"] {
  if (status === "running" || status === "stopping") return "running";
  if (status === "completed") return "completed";
  return "stopped";
}

function stateCopy(status: string): string {
  switch (status) {
    case "running": return "进行中";
    case "stopping": return "正在停止";
    case "completed": return "已完成";
    case "failed": return "失败";
    case "cancelled": return "已停止";
    default: return status || "";
  }
}

export function StillAgent({ conn }: { conn: ConnState | null }) {
  const { open } = useStillNav();
  const [runs, setRuns] = useState<RunItem[]>([]);
  const { snap, retry } = useAgentCapability(conn);
  const paired = snap.paired;
  const connected = snap.connected;

  // LSH remote surface (Issue #72): ONE adapter for the AI page. The entry is
  // capability-gated from the same hello probe, and the surface is bound to
  // the Desktop instance CURRENT at tap time — never re-derived later.
  const lshRef = useRef<LshSurfaceController | null>(null);
  if (!lshRef.current) {
    lshRef.current = new LshSurfaceController({
      state: (expectedInstance) => api.lshSurfaceState(expectedInstance),
      bootstrap: (expectedInstance) => api.lshSurfaceBootstrap(expectedInstance),
      open: (request) => api.lshSurfaceOpen(request),
    });
  }
  const lsh = lshRef.current;
  useEffect(() => {
    lsh.setContext({ instanceId: snap.instanceId, available: snap.canUseLsh });
  }, [lsh, snap.instanceId, snap.canUseLsh]);
  // Phase-4: once capability is advertised, ask the Desktop for the real
  // per-device grant/runtime truth — capability alone never means 可以使用.
  useEffect(() => {
    if (!snap.canUseLsh || !snap.instanceId) return;
    let alive = true;
    api
      .lshSurfaceState(snap.instanceId)
      .then((r) => {
        if (alive) lsh.setPermissionTruth(r?.granted === true, r?.runtimeAvailable === true);
      })
      .catch(() => { if (alive) lsh.setPermissionTruth(false, false); });
    return () => { alive = false; };
  }, [lsh, snap.instanceId, snap.canUseLsh]);
  const lshSnap = useSyncExternalStore(
    (fn) => lsh.subscribe(fn),
    () => lsh.snapshot()
  );
  const [lshLaunching, setLshLaunching] = useState(false);
  async function enterLsh() {
    if (lshLaunching) return;
    setLshLaunching(true);
    try {
      await lsh.openSurface(snap.instanceId);
    } catch (e) {
      toast.error(lshErrorCopy(e));
    } finally {
      setLshLaunching(false);
    }
  }
  // Page data is fenced by the Desktop identity/capability epoch.
  const fence = useRef(new PageDataFence());

  const canUseRuns = snap.canUseRuns;
  const load = useCallback(async () => {
    if (!canUseRuns) return;
    const token = fence.current.beginRun();
    try {
      const raw = await api.agentRuns();
      if (!fence.current.isRunCurrent(token)) return; // superseded identity or request
      setRuns((raw || []).map((r: any) => ({
        id: r.runId,
        title: r.summary || AGENT_CAPABILITY_LABEL || "Agent 任务",
        status: stillStatus(r.status),
        meta: r.status === "completed"
          ? `${relativeDay(r.startedAt)} · 任务已完成`
          : `${(r.startedAt || "").slice(11, 16)} 开始 · ${stateCopy(r.status)}`,
      })));
    } catch { /* unreachable Desktop simply yields no runs */ }
  }, [canUseRuns]);

  // Root page-data lifecycle — declared BEFORE the automatic load so React
  // runs it first on every commit. It invalidates exactly when the previous
  // authority stops being valid:
  //   * the Desktop identity changed, or
  //   * run capability was LOST (ready → offline/probing/unavailable).
  // Acquiring capability (false → true) deliberately does NOT bump: the fresh
  // token taken by the load effect below must stay valid.
  const previousIdentity = useRef(snap.instanceId);
  const previousCanUseRuns = useRef(canUseRuns);
  useEffect(() => {
    const identityChanged = previousIdentity.current !== snap.instanceId;
    const lostCapability = previousCanUseRuns.current && !canUseRuns;
    previousIdentity.current = snap.instanceId;
    previousCanUseRuns.current = canUseRuns;
    if (identityChanged || lostCapability) {
      fence.current.bumpEpoch();
      setRuns([]);
    }
  }, [snap.instanceId, canUseRuns]);

  useEffect(() => { void load(); }, [load]);

  // UX-POLISH-R1 §2 — one truth per page state. Agent Runs and the LSH remote
  // surface are TWO independent capabilities; the page leads with whichever is
  // actually usable and never lets the Runs-unsupported empty state dominate
  // when LightSeek is ready.
  //
  //   A unpaired            → connect-computer primary state (below)
  //   B paired, offline     → offline state (below)
  //   C connected, neither capability → Runs-unsupported empty IS the page
  //   D capability, grant OFF   → LightSeek panel, waiting-for-grant
  //   E grant ON, runtime down  → LightSeek panel, starting/unavailable
  //   F grant ON + runtime up   → LightSeek panel IS the page, primary entry
  const lshReady = snap.canUseLsh && lshSnap.granted && lshSnap.runtimeAvailable;

  // ONE structured LightSeek section for EVERY canUseLsh state, independent of
  // Runs availability (REPAIR-R1 P1-AI1). The old gating
  // (`canUseLsh && !canUseRuns`) fell back to the orphaned inline button block
  // whenever a Desktop advertised BOTH capabilities, reintroducing the exact
  // defect this task removed.
  const lshLine = !lshSnap.granted
    ? "这台电脑还没有授权本手机使用 LightSeek 远程面。请在电脑的「LSH 远程」设置里为这台手机开启权限。"
    : !lshSnap.runtimeAvailable
      ? "电脑端 LightSeek 正在启动或暂时不可用，稍后可再试。"
      : "电脑上正在运行的 LightSeek 会话，在手机上直接查看与操作（同一会话）。";
  const lshSection = (
    <div className="st-lsh-panel">
      <span className="st-lsh-mark" aria-hidden="true"><Icon name="ai" size={30} /></span>
      <h2>LightSeek</h2>
      <p>{lshLine}</p>
      {lshReady ? (
        <Button disabled={lshSnap.busy || lshLaunching} onClick={() => void enterLsh()}>
          {lshSnap.busy || lshLaunching ? "正在进入…" : "进入 LightSeek"}
        </Button>
      ) : !lshSnap.granted ? (
        <Button kind="quiet" disabled onClick={() => {}}>等待电脑授权</Button>
      ) : (
        <Button kind="quiet" disabled onClick={() => {}}>暂时不可用</Button>
      )}
    </div>
  );

  // Runs-unsupported: LightSeek leads and Runs is a footnote.
  if (snap.canUseLsh && !snap.canUseRuns) {
    return (
      <div className="st-view">
        <div className="st-scroll st-lsh-home">
          {lshSection}
          <p className="st-lsh-subnote">
            手机任务控制尚未被当前桌面版本开放；开放后，电脑上运行的 Agent 任务会显示在这里。
          </p>
        </div>
      </div>
    );
  }

  // BOTH capabilities: the SAME section leads, and the Agent Runs list renders
  // BELOW it (never the old inline top button).
  if (snap.canUseLsh && snap.canUseRuns) {
    return (
      <div className="st-view">
        <div className="st-scroll">
          <div className="st-lsh-home">{lshSection}</div>
          <div className="st-lsh-runs-head">电脑上的 Agent 任务</div>
          <AgentView
            paired={paired}
            connected={connected}
            runs={runs}
            onOpen={(id) => open("run", id)}
            onConnect={() => open("connect")}
            onRefresh={() => { void load(); if (!connected) toast.info("电脑未连接，暂时读不到新任务"); }}
          />
        </div>
      </div>
    );
  }

  return (
    <>
      {snap.state === "unavailable" ? (
        <Empty icon="ai" title="当前桌面版本尚未开放手机任务控制"
          body="这台电脑的 LuckyRay 版本还没有开放手机端任务查看与控制；后续版本将通过 Desktop Agent Gateway 提供。本机内容不受影响。">
          <Button kind="quiet" onClick={() => open("connect")}>查看电脑连接</Button>
        </Empty>
      ) : snap.state === "probe-error" ? (
        <Empty icon="ai" title="暂时无法确认电脑任务能力"
          body="连接中断或电脑暂时没有响应。恢复连接后可再试。">
          <Button kind="quiet" onClick={retry}>重试</Button>
        </Empty>
      ) : snap.state === "offline" ? (
        <Empty icon="monitor" title="电脑暂时不在线"
          body="重新连接后再查看任务；当前不会显示为“没有任务”。">
          <Button kind="quiet" onClick={() => open("connect")}>查看连接</Button>
        </Empty>
      ) : snap.state === "probing" ? (
        <Empty icon="ai" title="正在确认电脑能力…" />
      ) : (
      <AgentView
        paired={paired}
        connected={connected}
        runs={runs}
        onOpen={(id) => open("run", id)}
        onConnect={() => open("connect")}
        onRefresh={() => { void load(); if (!connected) toast.info("电脑未连接，暂时读不到新任务"); }}
      />
      )}
    </>
  );
}

/** 执行过程 page: real agent events, rendered verbatim. */
export function StillRun({ id }: { id: string }) {
  const { conn, back, open: openPage, registerOverlay } = useStillNav();
  const { snap, retry } = useAgentCapability(conn);
  const [run, setRun] = useState<any>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [message, setMessage] = useState("");
  const [stopOpen, setStopOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Page data uses ONE identity/capability epoch plus TWO latest-wins request
  // sequences: the run summary and the events are legitimate parallel channels
  // under the same Desktop, so neither may cancel the other.
  const fence = useRef(new PageDataFence());
  const canUseRuns = snap.canUseRuns;

  const loadEvents = useCallback(async () => {
    if (!canUseRuns) return; // CURRENT readiness, re-read on every call
    const token = fence.current.beginEvents();
    try {
      const r = await api.agentEvents(id);
      if (!fence.current.isEventsCurrent(token)) return; // superseded or identity moved on
      setEvents(r.events || []);
      setMessage("");
    } catch (e: any) {
      if (!fence.current.isEventsCurrent(token)) return;
      setMessage(failureCopy(e, "暂时读不到这个任务的事件。"));
    }
  }, [id, canUseRuns]);

  const loadSummary = useCallback(async () => {
    if (!canUseRuns) return;
    const token = fence.current.beginRun();
    try {
      const raw = await api.agentRuns();
      if (!fence.current.isRunCurrent(token)) return;
      setRun((raw || []).find((r: any) => r.runId === id) || null);
    } catch { /* unreachable Desktop yields no summary */ }
  }, [id, canUseRuns]);

  // Ready: BOTH channels start concurrently and both may commit.
  useEffect(() => {
    if (!canUseRuns) return;
    void loadSummary();
    void loadEvents();
  }, [loadSummary, loadEvents, canUseRuns]);

  // Identity change or capability loss: invalidate every channel and clear.
  useEffect(() => {
    fence.current.bumpEpoch();
  }, [snap.instanceId]);
  useEffect(() => {
    if (!snap.canUseRuns) {
      fence.current.bumpEpoch();
      setRun(null);
      setEvents([]);
      setStopOpen(false);
    }
  }, [snap.canUseRuns]);

  async function stop() {
    if (!snap.canUseRuns) return; // gate the ACTION, not just the button
    // Capture the epoch this action belongs to; every follow-up commit checks it.
    const epoch = fence.current.current();
    setBusy(true);
    try {
      await api.agentStop(id);
      if (fence.current.current() !== epoch) return; // identity moved during stop
      toast.success("已请求停止");
      setStopOpen(false);
      const token = fence.current.beginRun();
      const raw = await api.agentRuns().catch(() => []);
      if (!fence.current.isRunCurrent(token)) return; // late A data never lands on B
      setRun((raw || []).find((r: any) => r.runId === id) || null);
      void loadEvents();
    } catch (e: any) {
      if (fence.current.current() !== epoch) return;
      toast.error(failureCopy(e, "停止失败，请重试。"));
    } finally { setBusy(false); }
  }

  const running = run?.status === "running" || run?.status === "stopping";
  const summary = !run ? "正在读取…"
    : running ? (run.status === "stopping" ? "已请求停止 · 等待电脑确认" : "正在电脑上运行")
    : stateCopy(run.status) || "已结束";

  if (snap.state !== "ready") {
    const copy = snap.state === "unpaired"
      ? { title: "连接电脑后查看执行过程", body: "任务在电脑上运行，配对后可以在这里查看。", action: "查看连接" }
      : snap.state === "offline"
        ? { title: "电脑暂时不在线", body: "重新连接后再查看这个任务；当前不会显示为“没有任务”。", action: "查看连接" }
        : snap.state === "probe-error"
          ? { title: "暂时无法确认电脑任务能力", body: "连接中断或电脑暂时没有响应。恢复连接后可再试。", action: "重试" }
          : snap.state === "probing"
            ? { title: "正在确认电脑能力…", body: "", action: "" }
            : { title: "当前桌面版本尚未开放手机任务控制", body: "后续版本将通过 Desktop Agent Gateway 提供。", action: "" };
    return (
      <div className="st-view">
        <Header title="执行过程" left={<IconButton icon="back" label="返回任务" onClick={back} />} />
        <div className="st-scroll">
          <Empty icon="ai" title={copy.title} body={copy.body || undefined}>
            {copy.action === "重试" ? <Button kind="quiet" onClick={retry}>重试</Button> : null}
            {copy.action === "查看连接" ? <Button kind="quiet" onClick={() => openPage("connect")} >查看连接</Button> : null}
          </Empty>
        </div>
      </div>
    );
  }
  return (
    <>
      <div className="st-view">
        <Header title="执行过程" left={<IconButton icon="back" label="返回任务" onClick={back} />}
          right={<IconButton icon="refresh" label="刷新事件" onClick={() => void loadEvents()} />} />
        <div className="st-scroll" style={{ paddingBottom: 24 }}>
          <div className="st-run-summary">
            <strong>{run?.summary || "Agent 任务"}</strong>
            <p>{summary}</p>
          </div>
          {events.length === 0 && !message ? (
            <Empty title="暂无事件" body="任务还没有产生可查看的执行事件。" />
          ) : null}
          {message ? <div className="st-notice danger" role="status">{message}</div> : null}
          {events.map((e) => (
            <div className="st-event" key={e.seq}>
              <time>#{e.seq}</time>
              <div>
                <strong>{e.type}</strong>
                <p>{JSON.stringify(e.payload ?? null)}</p>
              </div>
            </div>
          ))}
          {running ? (
            <div style={{ paddingTop: 25 }}>
              <Button kind="quiet" disabled={busy} onClick={() => setStopOpen(true)}>
                {run?.status === "stopping" ? "等待电脑确认" : "停止任务"}
              </Button>
            </div>
          ) : null}
          <p className="st-sheet-copy" style={{ marginTop: 20 }}>事件来自电脑端，原样保留；不由手机编造或改写。</p>
        </div>
      </div>
      {stopOpen ? (
        <Sheet title="停止这个任务？" registerDismiss={registerOverlay} onClose={() => setStopOpen(false)} busy={busy}
          footer={<>
            <Button kind="quiet" onClick={() => setStopOpen(false)}>继续运行</Button>
            <Button kind="danger" disabled={busy} onClick={() => void stop()}>请求停止</Button>
          </>}>
          <p className="st-sheet-copy">向电脑请求停止正在运行的任务。已完成的结果不会被撤销。</p>
        </Sheet>
      ) : null}
    </>
  );
}
