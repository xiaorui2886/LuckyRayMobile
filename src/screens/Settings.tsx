// Settings.tsx (STITCH-R6) — 我的.
//
// Visual source: R6 `function settings()` — connection row first, then 偏好 /
// 支持 groups; and `function storage()` / `function appearance()` as pushed
// children.
//
// Behaviour source: production, unchanged. All authorities, commands and the
// truthful connection semantics are preserved; destructive erases still require
// a ConfirmSheet with an explicit acknowledgement.
//
// STITCH-R6 adds the Appearance page: Interface Style (Quiet Dock / Content
// Ledger / Night Shelf) and Color Mode (Light / Dark) — presentation-only,
// Mobile-local preferences (see services/appearance.ts).
import { useCallback, useEffect, useRef, useSyncExternalStore, useState } from "react";
import { api, type ConnState } from "../services/client";
import { IconChevronRight } from "../components/icons";
import type { Tab } from "../App";
import { localDataStore } from "../services/localDataStore";
import { DEVELOPER_SECTION_TITLE, connectionSummary } from "../services/productShell";
import { failureCopy } from "../services/feedback";
import { toast } from "../services/toast";
import {
  applyColorMode,
  applyInterfaceStyle,
  INTERFACE_STYLES,
  readColorMode,
  readInterfaceStyle,
  STYLE_DESCRIPTIONS,
  STYLE_LABELS,
  type ColorMode,
  type InterfaceStyle,
} from "../services/appearance";
import { BackHeader, ConfirmSheet, Notice, OptionRow, SectionTitle } from "../components/ui";
import { overlayStack } from "../services/overlayStack";

type Props = {
  conn: ConnState | null;
  ws: { state: string; last_seq: number; current: string };
  refresh: () => void;
  go: (tab: Tab, detail?: string) => void;
};

type EraseKind = "inbox" | "notes" | "assets";

const ERASE_COPY: Record<EraseKind, { title: string; body: string; confirm: string }> = {
  inbox: {
    title: "清空本地收集箱",
    body: "会永久删除手机上的全部本地收集内容（文本、链接、图片、文件）。此操作不可撤销，且不会影响笔记与素材。",
    confirm: "永久清空收集箱",
  },
  notes: {
    title: "清空本地笔记",
    body: "会永久删除手机上的全部本地笔记。此操作不可撤销，收集箱与素材不受影响。",
    confirm: "永久清空笔记",
  },
  assets: {
    title: "清空本机素材",
    body: "会永久删除手机上的全部本机素材及其原始文件。此操作不可撤销，收集箱与笔记不受影响。",
    confirm: "永久清空素材",
  },
};

export default function Settings({ conn, ws, refresh, go }: Props) {
  const [style, setStyle] = useState<InterfaceStyle>(readInterfaceStyle);
  const [mode, setMode] = useState<ColorMode>(readColorMode);
  const [view, setView] = useState<"root" | "appearance" | "storage" | "support">("root");
  // INTERACTION-CLOSURE-R1: a Settings child view participates in the
  // Back chain - Android Back returns to the Settings root, never Home.
  useEffect(() => {
    if (view === "root") return;
    return overlayStack.push(() => setView("root"));
  }, [view]);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [secureOk, setSecureOk] = useState<string>("");
  const [inboxStats, setInboxStats] = useState<{ total: number; archived: number; favorites: number; bytes: number } | null>(null);
  const [noteStats, setNoteStats] = useState<{ total: number; archived: number; favorites: number; pinned: number } | null>(null);
  const [assetStats, setAssetStats] = useState<{ total: number; archived: number; favorites: number; bytes: number } | null>(null);
  const [storage, setStorage] = useState<{
    inbox: { count: number; bytes: number };
    assetOriginals: { count: number; bytes: number };
    thumbs: { count: number; bytes: number };
    outbox: { count: number; bytes: number };
  } | null>(null);
  const [cacheMsg, setCacheMsg] = useState("");
  const [outboxPending, setOutboxPending] = useState<number | null>(null);
  const [eraseKind, setEraseKind] = useState<EraseKind | null>(null);

  const localVersion = useSyncExternalStore(
    (fn) => localDataStore.subscribe(fn),
    () => localDataStore.getVersion()
  );

  const statsGenRef = useRef(0);
  const reloadStats = useCallback(() => {
    const gen = ++statsGenRef.current;
    api.localInboxStats().then((r) => { if (gen === statsGenRef.current) setInboxStats(r); }).catch(() => {});
    api.localNoteStats().then((r) => { if (gen === statsGenRef.current) setNoteStats(r); }).catch(() => {});
    api.localAssetStats().then((r) => { if (gen === statsGenRef.current) setAssetStats(r); }).catch(() => {});
  }, []);

  useEffect(() => {
    reloadStats();
  }, [localVersion, reloadStats]);

  const loadStorage = useCallback(() => {
    api.companionStorageStats().then(setStorage).catch(() => setStorage(null));
  }, []);
  useEffect(() => {
    loadStorage();
  }, [loadStorage, localVersion]);

  useEffect(() => {
    api
      .captureList()
      .then((items) => setOutboxPending((items || []).filter((o) => o.state !== "completed").length))
      .catch(() => setOutboxPending(null));
  }, [localVersion]);

  async function clearPreviewCache() {
    setBusy(true);
    setCacheMsg("正在清理…");
    try {
      const r = await api.companionClearCache();
      if (r.status === "error") {
        setCacheMsg("清理失败: " + (r.message || "未知错误"));
      } else {
        setCacheMsg(`已清理预览缓存：释放 ${fmtBytes(r.freedBytes)}（${r.filesRemoved} 个文件）`);
        loadStorage();
        toast.success("预览缓存已清理");
      }
    } catch (e: any) {
      setCacheMsg(failureCopy(e, "清理失败，请重试。"));
    } finally {
      setBusy(false);
    }
  }

  const logl = (s: string) => setLog((p) => [...p.slice(-60), s]);

  async function testSecure() {
    try {
      const r = await api.secureTest();
      setSecureOk(r);
      logl(`安全存储: ${r}`);
    } catch (e: any) {
      setSecureOk("fail");
      logl(`安全存储失败: ${e}`);
    }
  }

  async function runErase(kind: EraseKind) {
    setEraseKind(null);
    setBusy(true);
    try {
      if (kind === "inbox") {
        logl(await api.localInboxEraseAll());
        setInboxStats(await api.localInboxStats());
        localDataStore.publish("inbox");
        toast.success("收集箱已清空");
      } else if (kind === "notes") {
        logl(await api.localNoteEraseAll());
        setNoteStats(await api.localNoteStats());
        localDataStore.publish("note");
        toast.success("本地笔记已清空");
      } else {
        logl(await api.localAssetEraseAll());
        setAssetStats(await api.localAssetStats());
        localDataStore.publish("asset");
        toast.success("本机素材已清空");
      }
    } catch (e: any) {
      toast.error(failureCopy(e, "清空失败，请重试。"));
      logl(`清空失败: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  const paired = conn?.paired;
  const erase = eraseKind ? ERASE_COPY[eraseKind] : null;
  const totalBytes = storage
    ? storage.inbox.bytes + storage.assetOriginals.bytes + storage.thumbs.bytes
    : null;

  /* ---- Appearance (pushed child) ------------------------------------- */
  if (view === "appearance") {
    return (
      <>
        <BackHeader title="外观" backLabel="返回我的" onBack={() => setView("root")} />
        <div className="detail-scroll">
          <SectionTitle title="界面风格" />
          {INTERFACE_STYLES.map((s) => (
            <OptionRow
              key={s}
              label={STYLE_LABELS[s]}
              hint={STYLE_DESCRIPTIONS[s]}
              active={style === s}
              onClick={() => setStyle(applyInterfaceStyle(s))}
            />
          ))}
          <SectionTitle title="颜色模式" />
          <OptionRow label="浅色" active={mode === "light"} onClick={() => setMode(applyColorMode("light"))} />
          <OptionRow label="深色" active={mode === "dark"} onClick={() => setMode(applyColorMode("dark"))} />
          <p className="list-foot" style={{ textAlign: "left" }}>
            界面风格与颜色模式只改变外观，不影响内容、来源、同步状态或任何数据。
          </p>
        </div>
      </>
    );
  }

  /* ---- Storage / Data (pushed child) --------------------------------- */
  if (view === "storage") {
    return (
      <>
        <BackHeader title="存储与数据" backLabel="返回我的" onBack={() => setView("root")} />
        <div className="detail-scroll">
          <SectionTitle title="本机占用" meta={totalBytes === null ? "…" : fmtBytes(totalBytes)} />
          <div className="list">
            <div className="setting-row static">
              <span className="sr-label">收集附件</span>
              <small>{storage ? `${storage.inbox.count} 项 · ${fmtBytes(storage.inbox.bytes)}` : "…"}</small>
            </div>
            <div className="setting-row static">
              <span className="sr-label">素材原件</span>
              <small>{storage ? `${storage.assetOriginals.count} 项 · ${fmtBytes(storage.assetOriginals.bytes)}` : "…"}</small>
            </div>
            <div className="setting-row static">
              <span className="sr-label">预览缓存</span>
              <small>{storage ? `${storage.thumbs.count} 项 · ${fmtBytes(storage.thumbs.bytes)}` : "…"}</small>
            </div>
          </div>
          <button className="quiet btn-block" style={{ marginTop: 14 }} disabled={busy} onClick={clearPreviewCache}>
            清理预览缓存
          </button>
          {cacheMsg ? <p className="list-foot">{cacheMsg}</p> : null}
          <p className="list-foot" style={{ textAlign: "left" }}>
            本机素材是机内私有副本；保存到系统相册会生成一份独立的系统副本。删除其中一份不影响另一份。
          </p>

          <SectionTitle title="数据管理" />
          <Notice>以下操作只影响手机本机数据，不会修改电脑上的内容。</Notice>
          <div className="list">
            <button className="setting-row danger-row tappable" disabled={busy} onClick={() => setEraseKind("inbox")}>
              <span className="sr-label">清空本地收集箱</span>
              <IconChevronRight size={14} className="i row-chev" />
            </button>
            <button className="setting-row danger-row tappable" disabled={busy} onClick={() => setEraseKind("notes")}>
              <span className="sr-label">清空本地笔记</span>
              <IconChevronRight size={14} className="i row-chev" />
            </button>
            <button className="setting-row danger-row tappable" disabled={busy} onClick={() => setEraseKind("assets")}>
              <span className="sr-label">清空本机素材</span>
              <IconChevronRight size={14} className="i row-chev" />
            </button>
          </div>
        </div>

        <ConfirmSheet
          open={Boolean(eraseKind)}
          title={erase?.title ?? ""}
          body={erase?.body ?? ""}
          confirmLabel={erase?.confirm ?? "确认"}
          busy={busy}
          onConfirm={() => eraseKind && runErase(eraseKind)}
          onCancel={() => setEraseKind(null)}
        />
      </>
    );
  }

  /* ---- Support / diagnostics (pushed child) -------------------------- */
  if (view === "support") {
    return (
      <>
        <BackHeader title="支持" backLabel="返回我的" onBack={() => setView("root")} />
        <div className="detail-scroll">
          <SectionTitle title="连接诊断" />
          {paired && conn?.identity ? (
            <div className="meta-stack" style={{ marginTop: 0 }}>
              <div className="meta-line"><span>设备</span><b>{conn.identity.displayName}</b></div>
              <div className="meta-line"><span>实例</span><b className="mono">{conn.identity.instanceId.slice(0, 16)}…</b></div>
              <div className="meta-line"><span>地址</span><b className="mono">{conn.identity.baseUrl}</b></div>
              <div className="meta-line"><span>指纹</span><b className="mono">{conn.identity.certificateFingerprint.slice(0, 24)}…</b></div>
            </div>
          ) : (
            <Notice>配对入口在「连接电脑」。本区仅保留连接诊断。</Notice>
          )}
          <div className="list" style={{ marginTop: 14 }}>
            {ws.state === "re_pair_required" ? (
              <button className="setting-row tappable" onClick={() => go("settings", "connect-computer")}>
                <span className="sr-label">重新配对</span>
                <IconChevronRight size={14} className="i row-chev" />
              </button>
            ) : (
              <button className="setting-row tappable" onClick={() => { api.wsStart().then(refresh); }}>
                <span className="sr-label">连接实时</span>
                <IconChevronRight size={14} className="i row-chev" />
              </button>
            )}
            <button className="setting-row tappable" onClick={async () => {
              try {
                const p = await api.dbExportDiagnostics();
                logl(`诊断已导出: ${p}`);
              } catch (e: any) {
                logl(`导出失败: ${e}`);
              }
            }}>
              <span className="sr-label">导出诊断</span>
              <small>Downloads</small>
            </button>
            <button className="setting-row tappable" onClick={testSecure}>
              <span className="sr-label">安全存储</span>
              <small>{secureOk || "Keystore"}</small>
            </button>
            <div className="setting-row static">
              <span className="sr-label">Desktop 内容同步</span>
              <small>按电脑能力启用</small>
            </div>
            <div className="setting-row static">
              <span className="sr-label">Desktop AI</span>
              <small>连接基础阶段未开放</small>
            </div>
            <div className="setting-row static">
              <span className="sr-label">待推送 Desktop</span>
              <small>{outboxPending === null ? "…" : `${outboxPending} 项（保留，未推送）`}</small>
            </div>
          </div>
          <details className="dev-section">
            <summary>{DEVELOPER_SECTION_TITLE}</summary>
            <div className="dev-body">
              <div className="log-box">
                <pre>{log.length ? log.join("\n") : "（连接日志）"}</pre>
              </div>
            </div>
          </details>
        </div>
      </>
    );
  }

  /* ---- Root ----------------------------------------------------------- */
  return (
    <>
      <div className="settings-root-start" />

      <div className="connection-box">
        <button className="setting-row tappable" onClick={() => go("settings", "connect-computer")}>
          <span>
            <b>{conn?.identity?.displayName || "LuckyRay Desktop"}</b>
            <br />
            <small>{connectionSummary(Boolean(paired), ws.state)}</small>
          </span>
          <IconChevronRight size={14} className="i row-chev" />
        </button>
      </div>

      <SectionTitle title="偏好" />
      <div className="list">
        <button className="setting-row tappable" onClick={() => setView("appearance")}>
          <span className="sr-label">外观</span>
          <small>{mode === "dark" ? "深色" : "浅色"} · {STYLE_LABELS[style]}</small>
          <IconChevronRight size={14} className="i row-chev" />
        </button>
        <button className="setting-row tappable" onClick={() => setView("storage")}>
          <span className="sr-label">存储与数据</span>
          <small>{totalBytes === null ? "…" : fmtBytes(totalBytes)}</small>
          <IconChevronRight size={14} className="i row-chev" />
        </button>
      </div>

      <SectionTitle title="支持" />
      <div className="list">
        <button className="setting-row tappable" onClick={() => setView("support")}>
          <span className="sr-label">连接诊断</span>
          <IconChevronRight size={14} className="i row-chev" />
        </button>
        <button className="setting-row tappable" onClick={() => setView("storage")}>
          <span className="sr-label">恢复与修复</span>
          <IconChevronRight size={14} className="i row-chev" />
        </button>
        <div className="setting-row static">
          <span className="sr-label">关于 LuckyRay</span>
          <small>0.2.0</small>
        </div>
      </div>

      <SectionTitle title="我的内容" />
      <div className="list">
        <button className="setting-row tappable" onClick={() => go("capture")}>
          <span className="sr-label">本地收集箱</span>
          <small>{inboxStats ? `${inboxStats.total} 条 · ${fmtBytes(inboxStats.bytes)}` : "…"}</small>
          <IconChevronRight size={14} className="i row-chev" />
        </button>
        <button className="setting-row tappable" onClick={() => go("knowledge")}>
          <span className="sr-label">本地笔记库</span>
          <small>{noteStats ? `${noteStats.total} 篇 · ${noteStats.pinned} 置顶` : "…"}</small>
          <IconChevronRight size={14} className="i row-chev" />
        </button>
        <button className="setting-row tappable" onClick={() => go("library")}>
          <span className="sr-label">本机素材库</span>
          <small>{assetStats ? `${assetStats.total} 项 · ${fmtBytes(assetStats.bytes)}` : "…"}</small>
          <IconChevronRight size={14} className="i row-chev" />
        </button>
      </div>

      <ConfirmSheet
        open={Boolean(eraseKind)}
        title={erase?.title ?? ""}
        body={erase?.body ?? ""}
        confirmLabel={erase?.confirm ?? "确认"}
        busy={busy}
        onConfirm={() => eraseKind && runErase(eraseKind)}
        onCancel={() => setEraseKind(null)}
      />
    </>
  );
}

function fmtBytes(n: number) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}
