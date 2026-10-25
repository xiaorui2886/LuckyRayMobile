import "./settingsPages.css";
import { KnowledgeCacheSheet } from "./kit/KnowledgeCacheSheet";
// STILL-01.1 — Settings root + its child pages (Still authority compositions,
// production behaviour): 偏好 (外观 = Still · 静面, 存储与数据), 内容与支持
// (收集箱 / 连接诊断 / 恢复与修复). Destructive erases keep the explicit
// acknowledgement gate and the real erase authorities.
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { SettingsView, AppearanceView, InboxView, type Entry } from "../presentation/still01/Views";
import { Header, IconButton, Button, Sheet, Option, Row, SectionTitle, Empty } from "./kit/StillImports";
import { api, type ConnState } from "../services/client";
import { overlayStack } from "../services/overlayStack";
import { readColorMode } from "../services/appearance";
import { localDataStore } from "../services/localDataStore";
import { failureCopy } from "../services/feedback";
import { toast } from "../services/toast";
import { fmtBytes } from "./stillData";
import { useStillNav } from "./StillShell";
import { displayTitle, kindLabel } from "../screens/Inbox";
import { syncCoordinator } from "../services/syncCoordinator";
import { contentSyncDiagnostic } from "../services/contentSyncDiagnostic";

// --- Settings root -----------------------------------------------------------

export function StillSettingsRoot({ conn }: { conn: ConnState | null }) {
  const { open, mode } = useStillNav();
  return (
    <SettingsView
      open={(page) => open(page === "connect" ? "connect" : page)}
      connected={Boolean(conn?.paired && conn?.ws?.state === "connected")}
      mode={mode}
    />
  );
}

// --- 偏好 / 设备 (pushed page from Home or Settings) ---------------------------

export function StillPreferences() {
  const { back, open } = useStillNav();
  return (
    <div className="st-view st-settings-page">
      <Header title="设置" left={<IconButton icon="back" label="返回上一页" onClick={back} />} />
      <div className="st-scroll">
        <SectionTitle>偏好</SectionTitle>
        <div className="st-settings-group">
          <Row title="外观" meta="LuckyRay · 默认" onClick={() => open("appearance")} />
          <Row title="存储与数据" onClick={() => open("storage")} />
        </div>
        <SectionTitle>设备</SectionTitle>
        <div className="st-settings-group">
          <Row title="连接电脑" onClick={() => open("connect")} />
          <Row title="连接诊断" onClick={() => open("diagnostics")} />
        </div>
      </div>
    </div>
  );
}

// --- 外观 (Still · 静面) -------------------------------------------------------

export function StillAppearance() {
  const { back, mode, setMode, reduced, setReduced } = useStillNav();
  return (
    <AppearanceView
      mode={mode}
      onChange={(m) => setMode(m)}
      onBack={back}
      reduced={reduced}
      onReduced={() => setReduced(!reduced)}
    />
  );
}

// --- 存储与数据 ----------------------------------------------------------------

type EraseKind = "inbox" | "notes" | "assets";

export function StillStorage() {
  const { back, open, registerOverlay } = useStillNav();
  const [storage, setStorage] = useState<{
    inbox: { count: number; bytes: number };
    assetOriginals: { count: number; bytes: number };
    thumbs: { count: number; bytes: number };
    outbox: { count: number; bytes: number };
  } | null>(null);
  const [noteStats, setNoteStats] = useState<{ total: number } | null>(null);
  const [inboxStats, setInboxStats] = useState<{ total: number } | null>(null);
  const [sheet, setSheet] = useState<"" | "knowledge-cache" | "clear-cache" | "data-management" | "erase">("");
  const [eraseKind, setEraseKind] = useState<EraseKind>("inbox");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);

  const version = useSyncExternalStore(
    (fn) => localDataStore.subscribe(fn),
    () => localDataStore.getVersion()
  );

  const load = useCallback(() => {
    api.companionStorageStats().then(setStorage).catch(() => setStorage(null));
    api.localNoteStats().then(setNoteStats).catch(() => {});
    api.localInboxStats().then(setInboxStats).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load, version]);

  async function clearCache() {
    setBusy(true);
    try {
      const r = await api.companionClearCache();
      if (r.status === "error") toast.error("清理失败: " + (r.message || "未知错误"));
      else { toast.success(`已清理预览缓存：释放 ${fmtBytes(r.freedBytes)}`); load(); }
    } catch (e: any) {
      toast.error(failureCopy(e, "清理失败，请重试。"));
    } finally { setBusy(false); }
  }

  async function runErase(kind: EraseKind) {
    setBusy(true);
    try {
      if (kind === "inbox") { await api.localInboxEraseAll(); localDataStore.publish("inbox"); }
      else if (kind === "notes") { await api.localNoteEraseAll(); localDataStore.publish("note"); }
      else { await api.localAssetEraseAll(); localDataStore.publish("asset"); }
      toast.success("已清空");
      load();
    } catch (e: any) {
      toast.error(failureCopy(e, "清空失败，请重试。"));
    } finally { setBusy(false); }
  }

  return (
    <div className="st-settings-overlay-scope">
      <div className="st-view st-settings-page">
        <Header title="存储与数据" left={<IconButton icon="back" label="返回设置" onClick={back} />} />
        <div className="st-scroll">
          <SectionTitle>手机上的内容</SectionTitle>
          <div className="st-settings-group">
            <Row title="素材原件" trail={storage ? `${storage.assetOriginals.count} 项 · ${fmtBytes(storage.assetOriginals.bytes)}` : "…"} onClick={() => open("library")} />
            <Row title="本机笔记" trail={noteStats ? `${noteStats.total} 篇` : "…"} onClick={() => open("knowledge")} />
            <Row title="收集箱" trail={inboxStats ? `${inboxStats.total} 条` : "…"} onClick={() => open("inbox")} />
          </div>
          <SectionTitle>整理空间</SectionTitle>
          <div className="st-settings-group">
            <Row title="电脑知识库缓存" meta="清理手机保存的正文，保留本机笔记与未同步修改" onClick={() => setSheet("knowledge-cache")} />
            <Row title="清理预览缓存" meta="不删除素材原件或笔记" onClick={() => { setAck(false); setSheet("clear-cache"); }} />
            <Row title="管理本机数据" meta="分别清空不同内容，不合并删除" onClick={() => setSheet("data-management")} />
          </div>
          {storage ? (
            <p className="st-sheet-copy" style={{ marginTop: 24 }}>
              收集附件 {fmtBytes(storage.inbox.bytes)} · 预览缓存 {fmtBytes(storage.thumbs.bytes)}
              {storage.outbox.count ? ` · 待推送 ${storage.outbox.count} 项` : ""}
            </p>
          ) : null}
        </div>
      </div>
      {sheet === "knowledge-cache" ? <KnowledgeCacheSheet registerOverlay={registerOverlay} onClose={() => setSheet("")} /> : null}
      {sheet === "clear-cache" ? (
        <Sheet title="清理预览缓存" registerDismiss={registerOverlay} onClose={() => setSheet("")} busy={busy}
          footer={<>
            <Button kind="quiet" onClick={() => setSheet("")}>取消</Button>
            <Button disabled={busy} onClick={() => { void clearCache().then(() => setSheet("")); }}>清理</Button>
          </>}>
          <p className="st-sheet-copy">只清理可重新生成的预览缓存，不删除素材原件、笔记和待同步内容。</p>
        </Sheet>
      ) : null}
      {sheet === "data-management" ? (
        <Sheet title="管理本机数据" registerDismiss={registerOverlay} onClose={() => setSheet("")}>
          {([["inbox", "清空收集箱"], ["notes", "清空本机笔记"], ["assets", "清空本机素材"]] as const).map(([kind, t]) => (
            <Option key={kind} label={t} danger icon="trash" onClick={() => { setEraseKind(kind); setAck(false); setSheet("erase"); }} />
          ))}
        </Sheet>
      ) : null}
      {sheet === "erase" ? (
        <Sheet title="确认清空？" registerDismiss={registerOverlay} onClose={() => setSheet("")} busy={busy}
          footer={<>
            <Button kind="quiet" onClick={() => setSheet("")}>取消</Button>
            <Button kind="danger" disabled={!ack || busy} onClick={() => { void runErase(eraseKind).then(() => setSheet("")); }}>清空所选数据</Button>
          </>}>
          <p className="st-sheet-copy">不可撤销地清空所选本机数据。正式版必须明确删除范围，不能把缓存清理当成数据重置。<br/>已选择范围：{eraseKind === "inbox" ? "收集箱" : eraseKind === "notes" ? "本机笔记" : "本机素材"}。</p>
          <Option label="我已了解删除范围" selected={ack} onClick={() => setAck((v) => !v)} />
        </Sheet>
      ) : null}
    </div>
  );
}

// --- 连接诊断 ----------------------------------------------------------------

export function StillDiagnostics() {
  const { conn, back, open } = useStillNav();
  const [exportMsg, setExportMsg] = useState("");
  const online = Boolean(conn?.paired && conn?.ws?.state === "connected");
  const sync = useSyncExternalStore((fn) => syncCoordinator.subscribe(fn), () => syncCoordinator.snapshot());
  const contentSync = contentSyncDiagnostic(sync);
  return (
    <div className="st-view st-settings-page">
      <Header title="连接诊断" left={<IconButton icon="back" label="返回上一页" onClick={back} />} />
      <div className="st-scroll">
        <SectionTitle>状态</SectionTitle>
        <div className="st-settings-group">
          <Row title="电脑连接" trail={online ? "已连接" : conn?.paired ? "已配对 · 未实时连接" : "未配对"} onClick={() => open("connect")} />
        </div>
        <SectionTitle>内容同步</SectionTitle>
        <div className="st-settings-card st-settings-diagnostics">
          <p className="st-sheet-copy">同步状态：{contentSync.status}</p>
          {contentSync.errorCode ? <p className="st-sheet-copy">诊断代码：{contentSync.errorCode}</p> : null}
          {contentSync.httpStatus !== null ? <p className="st-sheet-copy">HTTP 状态：{contentSync.httpStatus}</p> : null}
          {contentSync.refusalCode ? <p className="st-sheet-copy">拒绝代码：{contentSync.refusalCode}</p> : null}
          {contentSync.operationKind ? <p className="st-sheet-copy">操作类别：{contentSync.operationKind}</p> : null}
          {contentSync.routeKind ? <p className="st-sheet-copy">路由类别：{contentSync.routeKind}</p> : null}
          {contentSync.receiverHttps ? <>
            <p className="st-sheet-copy">捕获端点 HTTPS：{contentSync.receiverHttps}；有效端口：{contentSync.receiverPort}</p>
            <p className="st-sheet-copy">同轮 catalog 与配对实例：{contentSync.receiverCatalog}。MATCH 仅表示实例一致，不证明桌面构建版本或进程身份；端口可能为协议默认值。</p>
          </> : null}
          {contentSync.preparedShape ? <>
            <p className="st-sheet-copy">以下仅检查本地不可变待发载荷；本地检查通过不代表远端已校验通过，也不证明接收方构建身份。</p>
            <p className="st-sheet-copy">载荷形状：{contentSync.preparedShape}；额外字段：{contentSync.preparedExtra}；必填字段：{contentSync.preparedRequired}</p>
            <p className="st-sheet-copy">字段类型：{contentSync.preparedTypes}（固定顺序 opId、noteId、vaultId、kind、expectedRevision、title、content、parent；S 字符串，N 空值，M 缺失，X 其他）</p>
            <p className="st-sheet-copy">正文 noteId 格式：{contentSync.preparedBodyId}；派生路由 ID 格式：{contentSync.preparedRouteId}</p>
            <p className="st-sheet-copy">标题类别：{contentSync.preparedTitle}；本地检查结论：{contentSync.preparedChecks}</p>
          </> : null}
          <p className="st-sheet-copy">连接正常不代表内容已同步。这里显示最近一轮内容同步状态；未完成的笔记仍保存在手机，请以笔记的来源与状态为准。</p>
          <p className="st-sheet-copy">这里展示诊断入口和版式。正式版复用现有诊断信息，不在普通页面展示配对凭据。</p>
        </div>
        <SectionTitle>诊断文件</SectionTitle>
        <div className="st-settings-card">
          <Button kind="quiet" onClick={() => {
            api.dbExportDiagnostics()
              .then((p: string) => { setExportMsg(`诊断已导出：${p}`); toast.success("诊断已导出"); })
              .catch((e: any) => setExportMsg(failureCopy(e, "导出失败")));
          }}>导出诊断信息</Button>
          {exportMsg ? <p className="st-sheet-copy" role="status">{exportMsg}</p> : null}
        </div>
      </div>
    </div>
  );
}

// --- 恢复与修复 ----------------------------------------------------------------

export function StillRecoveryPage() {
  const { back, open, registerOverlay } = useStillNav();
  const [ack, setAck] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <div className="st-view st-settings-page">
      <Header title="恢复与修复" left={<IconButton icon="back" label="返回上一页" onClick={back} />} />
      <div className="st-scroll">
        <Empty icon="archive" title="先保护内容，再处理问题" body="先导出诊断，重试读取。不会默认清空数据。">
          <Button kind="quiet" onClick={() => {
            api.dbHealth()
              .then((h) => toast[h.ok ? "success" : "error"](h.ok ? "本机数据读取正常" : `数据库异常（schema ${h.schemaVersion}/${h.expectedVersion}）`))
              .catch((e: any) => toast.error(failureCopy(e, "读取失败")));
          }}>重新读取</Button>
        </Empty>
        <SectionTitle>更多处理方式</SectionTitle>
        <div className="st-settings-group">
          <Row title="导出诊断信息" onClick={() => open("diagnostics")} />
          <Row title="重置本机数据" onClick={() => { setAck(false); setConfirmOpen(true); }} />
        </div>
      </div>
      {confirmOpen ? (
        <Sheet title="确认重置？" registerDismiss={registerOverlay} onClose={() => setConfirmOpen(false)} busy={busy}
          footer={<>
            <Button kind="quiet" onClick={() => setConfirmOpen(false)}>取消</Button>
            <Button kind="danger" disabled={!ack || busy} onClick={() => {
              setBusy(true);
              api.dbResetFull()
                .then(() => { setConfirmOpen(false); toast.success("本机数据已重置"); })
                .catch((e: any) => toast.error(failureCopy(e, "重置失败")))
                .finally(() => setBusy(false));
            }}>重置本机数据</Button>
          </>}>
          <p className="st-sheet-copy">不可撤销地清空本机数据库并重建。不会修改电脑上的内容。</p>
          <Option label="我已了解删除范围" selected={ack} onClick={() => setAck((v) => !v)} />
        </Sheet>
      ) : null}
    </div>
  );
}

/** Still surface for the App-level local-data health gate. Standalone: it
 *  renders OUTSIDE the StillNav provider, so it registers its own overlay. */
export function StillHealthRecovery({ health, onRetry, onExportDiagnostics, onResetLocalData }: {
  health: { ok: boolean; schemaVersion: number; expectedVersion: number; tablesOk: boolean } | null;
  onRetry: () => void;
  onExportDiagnostics: () => void;
  onResetLocalData: () => void;
}) {
  const registerOverlay = useCallback((dismiss: () => void) => overlayStack.push(dismiss), []);
  const [ack, setAck] = useState(false);
  return (
    <div className="st-app" data-mode={readColorMode()}>
      <div className="st-root-stage">
        <div className="st-view st-settings-page">
          <Header title="恢复与修复" />
          <div className="st-scroll">
            <Empty icon="archive" title="先保护内容，再处理问题"
              body={health ? `本机数据库异常（schema ${health.schemaVersion}/${health.expectedVersion}）。先导出诊断，再重试读取。` : "先导出诊断，重试读取。不会默认清空数据。"}>
              <Button kind="quiet" onClick={onRetry}>重新读取</Button>
            </Empty>
            <SectionTitle>更多处理方式</SectionTitle>
            <div className="st-settings-group">
              <Row title="导出诊断信息" onClick={onExportDiagnostics} />
              <ResetGate ack={ack} setAck={setAck} registerOverlay={registerOverlay} onConfirm={onResetLocalData} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ResetGate({ ack, setAck, registerOverlay, onConfirm }: {
  ack: boolean; setAck: (v: boolean) => void;
  registerOverlay: (d: () => void) => () => void;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Row title="重置本机数据" onClick={() => { setAck(false); setOpen(true); }} />
      {open ? (
        <Sheet title="确认重置？" registerDismiss={registerOverlay} onClose={() => setOpen(false)}
          footer={<>
            <Button kind="quiet" onClick={() => setOpen(false)}>取消</Button>
            <Button kind="danger" disabled={!ack} onClick={() => { setOpen(false); onConfirm(); }}>重置本机数据</Button>
          </>}>
          <p className="st-sheet-copy">不可撤销地清空本机数据库并重建。不会修改电脑上的内容。</p>
          <Option label="我已了解删除范围" selected={ack} onClick={() => setAck(true)} />
        </Sheet>
      ) : null}
    </>
  );
}

// --- 收集箱 -------------------------------------------------------------------

export function StillInboxPage() {
  const { back, open } = useStillNav();
  const [items, setItems] = useState<Entry[]>([]);
  const [query, setQuery] = useState("");
  const version = useSyncExternalStore(
    (fn) => localDataStore.subscribe(fn),
    () => localDataStore.getVersion()
  );

  useEffect(() => {
    let alive = true;
    api.localInboxList({ page: 1, limit: 100 }).then((r) => {
      if (!alive) return;
      setItems((r.items || []).map((it: any) => inboxEntry(it)));
    }).catch(() => {});
    return () => { alive = false; };
  }, [version]);

  const shown = items.filter((i) => !query.trim() || (i.title + i.body).includes(query.trim()));
  return (
    <InboxView
      items={shown}
      query={query}
      onQuery={setQuery}
      onOpen={(id) => open("inbox-detail", id)}
      onBack={back}
      onCapture={() => open("capture")}
    />
  );
}

export function inboxEntry(it: any): Entry {
  const kind: Entry["kind"] = it.kind === "link" ? "link"
    : it.kind === "image" || it.kind === "video" || it.kind === "file" ? "image"
    : "text";
  return {
    id: it.entryId,
    title: displayTitle(it),
    kind,
    body: it.text || it.url || "",
    meta: `${kindLabel(it.kind)} · ${(it.createdAt || "").replace("T", " ").slice(5, 16)}`,
  };
}

// Re-export so the shell can import the whole settings family from one module.
export { StillInboxDetail } from "./StillInbox";
