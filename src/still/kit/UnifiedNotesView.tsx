import "./unifiedNotesPolish.css";
import { rememberNotesSort } from "./notesSortPreference";
import { CompactNoteRow, NotesActionIcon, NotesInlineFolders } from "./NotesInlineTree";
import { SwipeProgressDock } from "./SwipeProgressDock";
import { MobileGraphLoading } from "../../features/graph/MobileGraphLoading";
import { secureUuidV4 } from "../../services/secureUuid";
import { buildKnowledgeVaultCatalog, availableDesktopVaults } from "../../services/knowledgeVaultCatalog";
import { useDesktopLibraries } from "./DesktopLibraryPicker";
import { syncCoordinator } from "../../services/syncCoordinator";
import { api, type ConnState } from "../../services/client";
import type { KnowledgeReplicaLibrary } from "../../services/knowledgeReplica";
import { noteSourceSelection } from "../../services/noteSourceSelection";
import { managedWikiProof } from "./managedWikiProof";
import { failureCopy } from "../../services/feedback";
import { pickLocalNoteFile } from "./LocalNoteImportBridge";
import { setManagedImportTarget, invalidateManagedImportTarget } from "../../services/managedImportIntents";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { managedVault, managedNoteRoute, type ManagedVault, type ManagedVaultCatalog, type ManagedNote, type ManagedMigrationStatus, type ManagedTransferPreview } from "../../services/managedVault";
import { KnowledgeModeSwitch, type KnowledgeMode } from "./KnowledgeModeSwitch";
import { Button, Empty, IconButton, Option, SearchField, Sheet } from "./StillImports";
import { useStillNav } from "../StillShell";

const MobileGraphView = lazy(() => import("../../features/graph/MobileGraphView"));

let rememberedMode: KnowledgeMode = "notes";
type BrowseState = { query: string; folder: string; sort: "name" | "recent"; range: "all" | "pinned" | "favorite" | "archived"; tag: string; scroll: number };
const retained = new Map<string, BrowseState>();
// Presentation preference only; never changes the download/upload operation.
const dismissedSyncDocks = new Set<string>();
const blankBrowse = (): BrowseState => ({ query: "", folder: "", sort: "recent", range: "all", tag: "", scroll: 0 });
export type LegacyNotesRenderer = (modeSwitch: ReactNode, management: ReactNode) => ReactNode;

/** Graph never mounts the Notes loader. Session retention is separate from effects. */
export function UnifiedNotesRoot({ legacy, active = true, conn = null }: { legacy: LegacyNotesRenderer; active?: boolean; conn?: ConnState | null }) {
  const [mode, setMode] = useState<KnowledgeMode>(rememberedMode);
  const changeMode = (next: KnowledgeMode) => { rememberedMode = next; setMode(next); };
  const modeSwitch = <KnowledgeModeSwitch value={mode} onChange={changeMode} />;
  if (mode === "graph") return <Suspense fallback={<div className="st-view st-knowledge-view mg-view"><div className="st-collection-head">{modeSwitch}</div><div className="mg-stage"><MobileGraphLoading /></div></div>}><MobileGraphView modeSwitch={modeSwitch} active={active} conn={conn} onManageVaults={() => changeMode("notes")} /></Suspense>;
  return <NotesAuthority modeSwitch={modeSwitch} legacy={legacy} active={active} conn={conn} />;
}

function NotesAuthority({ modeSwitch, legacy, active, conn }: { modeSwitch: ReactNode; legacy: LegacyNotesRenderer; active: boolean; conn: ConnState | null }) {
  const { registerOverlay } = useStillNav();
  const sourceChoice = useSyncExternalStore(noteSourceSelection.subscribe, noteSourceSelection.snapshot);
  const [catalog, setCatalog] = useState<ManagedVaultCatalog | null>(null);
  const [status, setStatus] = useState<ManagedMigrationStatus | null>(null);
  const [error, setError] = useState("");
  const [legacyVisible, setLegacyVisible] = useState(false);
  const [panel, setPanel] = useState<"" | "add" | "manage" | "migration" | "remove" | "trash" | "trash-item" | "purge">("");
  const [removalTarget, setRemovalTarget] = useState<{ vault: ManagedVault; displayName: string } | null>(null);
  const [name, setName] = useState(() => { try { return JSON.parse(localStorage.getItem("luckyray:new-vault-intent") || "null")?.name || ""; } catch { return ""; } });
  const [busy, setBusy] = useState(false);
  const pending = useRef(false), epoch = useRef(0), alive = useRef(true);
  const selectionQueue = useRef(Promise.resolve());
  const creationIntent = useRef<{requestId: string; name: string} | null>(null);
  if (!creationIntent.current) { try { const saved = JSON.parse(localStorage.getItem("luckyray:new-vault-intent") || "null"); if (saved && typeof saved.requestId === "string" && typeof saved.name === "string") creationIntent.current = saved; } catch { /* No durable pending request. */ } }
  const instance = conn?.paired ? conn.identity?.instanceId || "" : "";
  const connected = conn?.ws.state === "connected";
  const libraries = useDesktopLibraries(instance, connected, false, active);
  const unified = buildKnowledgeVaultCatalog(catalog || { items: [], selectedVaultId: null }, sourceChoice.selection);
  const available = availableDesktopVaults(unified, libraries);
  const refresh = async () => {
    const token = ++epoch.current;
    try {
      const [next, progress] = await Promise.all([managedVault.list(), managedVault.migrationStatus()]);
      if (!alive.current || epoch.current !== token) return;
      setCatalog(next); setStatus(progress); setError("");
    } catch (reason) { if (alive.current && epoch.current === token) setError(failureCopy(reason)); }
  };
  useEffect(() => { alive.current = true; return () => { alive.current = false; epoch.current++; }; }, []);
  useEffect(() => {
    if (!active) return;
    const changed = () => void refresh();
    void refresh(); window.addEventListener("luckyray:managed-vault-change", changed);
    return () => window.removeEventListener("luckyray:managed-vault-change", changed);
  }, [active]);
  useEffect(() => {
    if (catalog && !legacyVisible && unified.selection?.kind === "managed" && unified.selectedVaultId)
      noteSourceSelection.select(unified.selection, sourceChoice.version);
  }, [catalog, sourceChoice.version, unified.selectedVaultId, legacyVisible]);
  const operation = async (work: () => Promise<void>) => {
    if (pending.current) return; pending.current = true; setBusy(true); setError("");
    try { await work(); } catch (reason) { if (alive.current) setError(failureCopy(reason)); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const select = (id: string, version = noteSourceSelection.snapshot().version) => {
    const work = selectionQueue.current.then(async () => {
      if (!alive.current || noteSourceSelection.snapshot().version !== version) return;
      invalidateManagedImportTarget();
      await managedVault.select(id);
      if (!alive.current) return;
      if (!noteSourceSelection.select({ kind: "managed", localVaultId: id }, version)) {
        const latest = noteSourceSelection.snapshot().selection;
        if (latest?.kind === "managed") await managedVault.select(latest.localVaultId);
        return;
      }
      setCatalog(previous => previous ? { ...previous, selectedVaultId: id } : previous);
      setLegacyVisible(false);
    });
    selectionQueue.current = work.catch(() => {});
    return work;
  };
  const initialize = (remoteVaultId?: string) => operation(async () => {
    const version = noteSourceSelection.snapshot().version;
    if (!remoteVaultId && !creationIntent.current) {
      try { creationIntent.current = JSON.parse(localStorage.getItem("luckyray:new-vault-intent") || "null"); } catch { /* No previous intent. */ }
      if (!creationIntent.current) creationIntent.current = { requestId: secureUuidV4(), name: name.trim() || "我的知识库" };
      localStorage.setItem("luckyray:new-vault-intent", JSON.stringify(creationIntent.current));
    }
    let created: ManagedVault;
    try { created = remoteVaultId ? await managedVault.syncToPhone(instance, remoteVaultId) : await managedVault.createVault(creationIntent.current!.name, creationIntent.current!.requestId); }
    catch (reason) {
      // These validation failures certify that nothing was created. Unknown
      // outcomes retain the idempotency token and original name for retry.
      if (!remoteVaultId && /VAULT_(?:REQUEST_INVALID|NAME_INVALID)/.test(String(reason instanceof Error ? reason.message : reason))) {
        creationIntent.current = null; localStorage.removeItem("luckyray:new-vault-intent");
      }
      throw reason;
    }
    if (!alive.current) return;
    await select(created.localVaultId, version); await refresh();
    const chosen = noteSourceSelection.snapshot().selection;
    if (chosen?.kind === "managed" && chosen.localVaultId === created.localVaultId) {
      if (!remoteVaultId) { creationIntent.current = null; localStorage.removeItem("luckyray:new-vault-intent"); }
      setPanel(""); setName("");
    }
    window.dispatchEvent(new Event("luckyray:managed-vault-change"));
    if (created.binding) void syncCoordinator.wake();
  });
  const migrate = (commit: boolean) => operation(async () => {
    if (commit && !status?.planId) return;
    const version = noteSourceSelection.snapshot().version;
    const result = commit ? await managedVault.commitMigration(status!.planId!) : await managedVault.prepareMigration();
    if (!alive.current) return;
    setStatus(previous => ({ ...result, hasLegacyData: previous?.hasLegacyData }));
    if (commit && result.state === "ready") { await select(result.localVaultId, version); await refresh(); setPanel(""); window.dispatchEvent(new Event("luckyray:managed-vault-change")); }
  });
  const remove = () => operation(async () => {
    const target = removalTarget;
    if (!target) return;
    await selectionQueue.current;
    const next = await managedVault.remove(target.vault.localVaultId);
    if (!alive.current) return;
    ++epoch.current;
    invalidateManagedImportTarget();
    retained.delete(target.vault.localVaultId);
    const latest = noteSourceSelection.snapshot();
    if (latest.selection?.kind === "managed" && latest.selection.localVaultId === target.vault.localVaultId)
      noteSourceSelection.select(next.selectedVaultId ? { kind: "managed", localVaultId: next.selectedVaultId } : null, latest.version);
    setCatalog(next); setRemovalTarget(null); setPanel("");
    window.dispatchEvent(new Event("luckyray:managed-vault-change"));
  });
  const restore = (localVaultId: string) => operation(async () => {
    const version = noteSourceSelection.snapshot().version;
    const restored = await managedVault.restore(localVaultId);
    if (!alive.current) return;
    await select(restored.localVaultId, version); await refresh(); setPanel("");
    window.dispatchEvent(new Event("luckyray:managed-vault-change"));
    // Existing connection intent and permissions still control background sync.
    // Restoring never resumes a disconnected computer or re-enrolls permissions.
    if (restored.binding && connected && instance === restored.binding.instanceId) void syncCoordinator.wake();
  });
  const purge = () => operation(async () => {
    const target = removalTarget;
    if (!target) return;
    let next: ManagedVaultCatalog;
    try { next = await managedVault.purge(target.vault.localVaultId); }
    catch (reason) {
      try {
        const latest = await managedVault.list();
        if (alive.current) {
          setCatalog(latest);
          const retained = latest.removedItems?.find(v => v.localVaultId === target.vault.localVaultId);
          if (retained) { setRemovalTarget({...target, vault:retained}); setPanel("trash-item"); }
        }
      } catch { /* Keep the exact confirmation target and original failure. */ }
      throw reason;
    }
    if (!alive.current) return;
    ++epoch.current;
    setCatalog(next); setRemovalTarget(null); setPanel(next.removedItems?.length ? "trash" : "manage");
    window.dispatchEvent(new Event("luckyray:managed-vault-change"));
  });
  const removed = buildKnowledgeVaultCatalog({ items: catalog?.removedItems || [], selectedVaultId: null }).items;
  const recoveryNeeded = status?.hasLegacyData === true;
  const management = <><Option label="添加知识库" icon="plus" onClick={() => setPanel("add")} /><Option label="知识库管理" icon="folder" onClick={() => setPanel("manage")} /></>;
  const current = unified.items.find(item => item.id === unified.selectedVaultId);
  const overlays = <>
    {panel === "add" ? <Sheet title="添加知识库" registerDismiss={registerOverlay} onClose={() => setPanel("")} busy={busy}>
      <p className="st-sheet-caption">从电脑同步</p><p className="st-sheet-copy">选择后保存在手机，笔记和图谱使用同一个库。连接电脑时自动同步。</p>
      {!connected ? <p role="status" className="st-sheet-copy">请先连接电脑，再选择要同步的知识库。</p> : libraries.phase === "loading" ? <p role="status">正在读取可同步的知识库…</p> : available.length ? available.map(row => <Option key={row.vaultId} label={row.displayName} detail={removed.some(item => item.vault.purgeState && item.binding?.instanceId === instance && item.binding?.remoteVaultId === row.vaultId) ? "请先在回收站完成删除" : removed.some(item => item.binding?.instanceId === instance && item.binding?.remoteVaultId === row.vaultId) ? "恢复到手机，保留原笔记" : "同步到手机"} onClick={() => { if (!busy) { if (removed.some(item => item.vault.purgeState && item.binding?.instanceId === instance && item.binding?.remoteVaultId === row.vaultId)) setPanel("trash"); else void initialize(row.vaultId); } }} />) : <p className="st-sheet-copy">{libraries.phase === "error" ? "知识库列表读取失败，请重新连接电脑后重试。" : "没有新的可同步知识库，已添加的库可在知识库列表中选择。"}</p>}
      <form className="st-vault-create-form" onSubmit={event => { event.preventDefault(); if (!busy) void initialize(); }} aria-busy={busy}>
        <label htmlFor="st-new-vault-name">新建知识库</label>
        <input id="st-new-vault-name" className="st-input" aria-label="知识库名称" aria-describedby="st-new-vault-help" placeholder="我的知识库" value={name} maxLength={120} enterKeyHint="done" autoComplete="off" onChange={event => setName(event.target.value)} disabled={busy || !!creationIntent.current} />
        <p id="st-new-vault-help" className="st-sheet-copy">{creationIntent.current ? `正在确认上次创建的「${creationIntent.current.name}」，重试不会重复建库。` : "名称留空将使用「我的知识库」。新建空库不会搬移或覆盖已有笔记。"}</p>
        <button className="st-button st-button--primary" type="submit" disabled={busy}>{busy ? "正在创建…" : creationIntent.current ? "重试创建" : "创建知识库"}</button>
        {error ? <p role="alert">{error}</p> : null}
      </form>
    </Sheet> : null}
    {panel === "manage" ? <Sheet title="知识库管理" registerDismiss={registerOverlay} onClose={() => setPanel("")} busy={busy}>
      {current ? <><p className="st-sheet-caption">{current.displayName}</p><p className="st-sheet-copy">{current.detailLabel}</p>{current.binding ? <p className="st-sheet-copy">{connected && instance === current.binding.instanceId ? "电脑已连接。同步进度见笔记列表。" : "电脑未连接。已保存的内容可离线使用，待同步内容将在连接后重试。"}</p> : <p className="st-sheet-copy">笔记保存在手机，尚未关联电脑。</p>}</> : null}
      {unified.issues.map((issue, index) => <p key={index} role="status" className="st-sheet-copy">{issue.message}</p>)}
      {current ? <Option label="删除知识库" detail="仅从此手机移除，可在回收站恢复" icon="trash" danger onClick={() => { if (!busy) { setRemovalTarget({vault: current.vault, displayName: current.displayName}); setError(""); setPanel("remove"); } }} /> : null}
      {removed.length ? <Option label="知识库回收站" detail={`${removed.length} 个知识库`} onClick={() => setPanel("trash")} /> : null}
      {recoveryNeeded ? <Option label="恢复旧版笔记" detail="有尚未整理的旧版内容，原始数据保留" onClick={() => setPanel("migration")} /> : null}
    </Sheet> : null}
    {panel === "remove" && removalTarget ? <Sheet title="移到知识库回收站？" registerDismiss={registerOverlay} onClose={() => { setPanel("manage"); setRemovalTarget(null); }} busy={busy} footer={<div className="st-vault-actions">
      <Button kind="quiet" disabled={busy} onClick={() => { setPanel("manage"); setRemovalTarget(null); }}>取消</Button>
      <Button kind="danger" disabled={busy} onClick={() => void remove()}>{busy ? "正在移除…" : "确认移到回收站"}</Button>
    </div>}>
      <p className="st-sheet-copy">将「{removalTarget.displayName}」移到软件内回收站，{removalTarget.vault.noteCount} 篇笔记及未同步修改会保留。不会删除电脑原库。</p>
      {removalTarget.vault.binding ? <p className="st-sheet-copy">移除后停止同步；已发送的修改无法撤回。恢复后沿用原同步设置。</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </Sheet> : null}
    {panel === "trash" ? <Sheet title="知识库回收站" registerDismiss={registerOverlay} onClose={() => setPanel("manage")} busy={busy}>
      <p className="st-sheet-copy">笔记和未同步修改仍保存在手机。恢复后沿用原来的同步设置，不会连接已断开的电脑。</p>
      {removed.map(item => <Option key={item.id} label={item.displayName} detail={item.vault.purgeState ? "删除未完成，点按重试" : item.detailLabel} onClick={() => { if (!busy) { setRemovalTarget({vault:item.vault,displayName:item.displayName}); setError(""); setPanel("trash-item"); } }} />)}
      {!removed.length ? <p className="st-sheet-copy">回收站为空。</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </Sheet> : null}
    {panel === "trash-item" && removalTarget ? <Sheet title="回收站知识库" registerDismiss={registerOverlay} onClose={() => setPanel("trash")} busy={busy} footer={<div className="st-vault-actions">
      {!removalTarget.vault.purgeState ? <Button disabled={busy} onClick={() => void restore(removalTarget.vault.localVaultId)}>恢复知识库</Button> : null}
      <Button kind="danger" disabled={busy} onClick={() => { setError(""); setPanel("purge"); }}>{removalTarget.vault.purgeState ? "重试彻底删除" : "彻底删除"}</Button>
    </div>}>
      <p className="st-sheet-caption">{removalTarget.displayName}</p>
      <p className="st-sheet-copy">{removalTarget.vault.purgeState ? "删除未完成 · 原有" : "软件内回收站 ·"} {removalTarget.vault.noteCount} 篇笔记</p>
      {removalTarget.vault.purgeState ? <p role="status" className="st-sheet-copy">删除尚未完成，可重试清理剩余数据。此库暂不能恢复，其他知识库不受影响。</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </Sheet> : null}
    {panel === "purge" && removalTarget ? <Sheet title="彻底删除此手机知识库？" registerDismiss={registerOverlay} onClose={() => setPanel("trash-item")} busy={busy} footer={<div className="st-vault-actions">
      <Button kind="quiet" disabled={busy} onClick={() => setPanel("trash-item")}>取消</Button>
      <Button kind="danger" disabled={busy} onClick={() => void purge()}>{busy ? "正在彻底删除…" : "确认彻底删除"}</Button>
    </div>}>
      <p className="st-sheet-copy">{removalTarget.vault.purgeState ? `将继续清除「${removalTarget.displayName}」的剩余本机数据（原有 ${removalTarget.vault.noteCount} 篇笔记）。` : `将彻底删除此手机上的「${removalTarget.displayName}」及 ${removalTarget.vault.noteCount} 篇笔记。`}未同步修改也会丢失，无法从回收站恢复。不会删除电脑原库。</p>
      <p className="st-sheet-copy">外部导入原件、旧版原始资料及共享附件不受影响。</p>
      {error ? <p role="alert">{error}</p> : null}
    </Sheet> : null}
    {panel === "migration" ? <Sheet title="恢复旧版笔记" registerDismiss={registerOverlay} onClose={() => setPanel("")} busy={busy}>
      <p className="st-sheet-copy">将已有笔记复制到知识库。按原始库身份保留，不合并同名库，原始内容不删除。</p>
      {status?.state === "prepared" ? <><p className="st-sheet-copy">待复制 {status.noteCount} 篇笔记。</p>{status.warnings.map((warning, i) => <p key={i} role="status">{warning}</p>)}<div className="st-vault-actions"><Button kind="quiet" disabled={busy} onClick={() => void migrate(false)}>重新预览</Button><Button disabled={busy} onClick={() => void migrate(true)}>确认复制，保留原始数据</Button></div></> : status?.state === "ready" ? <><p className="st-sheet-copy">已有内容整理完成；尚未整理的旧版内容可在下方查看，原始数据保留。</p>{status.warnings.map((warning, i) => <p key={i} role="status">{warning}</p>)}</> : <Button disabled={busy} onClick={() => void migrate(false)}>预览旧数据</Button>}
      {recoveryNeeded ? <Option label="查看尚未整理的原始笔记" onClick={() => { setPanel(""); setLegacyVisible(true); }} /> : null}
      {error ? <p role="alert">{error}</p> : null}
    </Sheet> : null}
  </>;
  // First load uses the same header/search geometry as the ready collection.
  // No transient loading/empty paragraph may push the page down and disappear.
  if (!catalog || !status) return <div className="st-view st-knowledge-view" aria-busy={!error}>
    <div className="st-collection-head">{modeSwitch}<IconButton icon="folder" label="知识库" disabled onClick={() => {}} /><button type="button" className="st-icon-button" aria-label="导入笔记文件" disabled><NotesActionIcon kind="import"/></button><IconButton icon="edit" label="新建笔记" disabled onClick={() => {}} /></div>
    <div className="st-collection-top"><SearchField value="" onChange={() => {}} placeholder="搜索笔记" /></div>
    <div className="st-scroll">{error ? <><p role="alert" className="st-folder-status">{error}</p><Button onClick={() => void refresh()}>重试</Button></> : null}</div>
  </div>;
  if (legacyVisible) return <><div className="st-legacy-recovery-heading"><Button kind="quiet" onClick={() => { setLegacyVisible(false); noteSourceSelection.select(catalog.selectedVaultId ? {kind:"managed",localVaultId:catalog.selectedVaultId} : null); }}>返回知识库</Button><span>尚未整理的旧版笔记</span></div>{legacy(modeSwitch, management)}{overlays}</>;
  if (!current) return <div className="st-view st-knowledge-view"><div className="st-collection-head">{modeSwitch}</div><div className="st-scroll"><Empty title={unified.selectionState === "missing" ? "所选知识库不可用" : "选择你的知识库"} body="从电脑同步已有库，或创建一个新库。笔记和图谱共用同一知识库。" />{unified.items.map(item => <Option key={item.id} label={item.displayName} detail={item.detailLabel} onClick={() => void operation(() => select(item.id))} />)}{management}{error ? <p role="alert">{error}</p> : null}</div>{overlays}</div>;
  return <><ManagedNotesCollection active={active} catalog={{ items: unified.items.map(item => item.vault), selectedVaultId: current.id }} readOnly={current.readOnly} conn={conn} modeSwitch={modeSwitch} management={management} onSelect={select} />{overlays}</>;
}

/** Coverage is scoped to the exact binding. It is not an acknowledgement of
 * uploads, so downloaded bodies never become a blanket "synced" claim. */
function VaultSyncStatus({ vault, conn, readOnly, active }: { vault?: ManagedVault; conn: ConnState | null; readOnly: boolean; active: boolean }) {
  const { registerOverlay } = useStillNav();
  const dockKey = JSON.stringify([vault?.localVaultId, vault?.binding?.instanceId, vault?.binding?.remoteVaultId]);
  const [dismissed, setDismissedState] = useState(() => dismissedSyncDocks.has(dockKey));
  const setDismissed = (value: boolean) => { if (value) dismissedSyncDocks.add(dockKey); else dismissedSyncDocks.delete(dockKey); setDismissedState(value); };
  const [detailsOpen, setDetailsOpen] = useState(false);
  const binding = vault?.binding;
  const owner = binding ? JSON.stringify([binding.instanceId, binding.remoteVaultId]) : "";
  const pairedInstance = conn?.paired ? conn.identity?.instanceId || "" : "";
  const canReadCoverage = !!binding && pairedInstance === binding.instanceId;
  const connected = canReadCoverage && conn?.ws.state === "connected";
  // Pair transitions invalidate even A -> B -> A, including transitions where
  // both computers are offline. Connection edges also require a fresh snapshot:
  // an old complete offline snapshot cannot become verified online progress.
  // Gate during render, before effect cleanup.
  const scope = JSON.stringify([owner, pairedInstance, connected]);
  const current = useRef({ scope, epoch: 0 });
  if (current.current.scope !== scope) current.current = { scope, epoch: current.current.epoch + 1 };
  const epoch = current.current.epoch;
  const [result, setResult] = useState<{ epoch: number; value: KnowledgeReplicaLibrary | null; failed: boolean } | null>(null);
  const [action, setAction] = useState<{ epoch: number; busy: boolean; error: string } | null>(null);
  const [revision, setRevision] = useState(0);
  const busy = action?.epoch === epoch && action.busy;
  const actionError = action?.epoch === epoch ? action.error : "";
  const retry = async (confirm: boolean) => {
    if (!binding || busy || readOnly || !connected || current.current.epoch !== epoch) return;
    setAction({ epoch, busy: true, error: "" });
    try {
      if (confirm) await managedVault.syncToPhone(binding.instanceId, binding.remoteVaultId);
      else await api.contentReplicaControl(binding.instanceId, binding.remoteVaultId, "resume");
      if (current.current.epoch !== epoch) return;
      syncCoordinator.wake(); window.dispatchEvent(new Event("luckyray:managed-vault-change"));
      setAction({ epoch, busy: false, error: "" });
    } catch (reason) {
      if (current.current.epoch === epoch) setAction({ epoch, busy: false, error: failureCopy(reason) });
    }
  };
  useEffect(() => {
    if (!active || !binding || !canReadCoverage) return;
    let live = true, sequence = 0;
    const load = async () => {
      if (!live || current.current.epoch !== epoch) return;
      const token = ++sequence;
      try {
        const rows = await api.contentReplicaLibraries(binding.instanceId);
        if (live && current.current.epoch === epoch && token === sequence) setResult({epoch, value: rows.find(row => row.instanceId === binding.instanceId && row.vaultId === binding.remoteVaultId) || null, failed: false});
      } catch { if (live && current.current.epoch === epoch && token === sequence) setResult({epoch, value: null, failed: true}); }
    };
    void load(); const changed = () => void load(); window.addEventListener("luckyray:managed-vault-change", changed);
    const timer = connected ? setInterval(changed, 5000) : null;
    return () => { live = false; if (timer) clearInterval(timer); window.removeEventListener("luckyray:managed-vault-change", changed); };
  }, [owner, epoch, canReadCoverage, connected, revision, active]);
  useEffect(() => { setDismissedState(dismissedSyncDocks.has(dockKey)); setDetailsOpen(false); }, [scope, dockKey]);
  if (!binding) return <div className="st-sync-control"><span className="st-sync-pill st-sync-local">仅本地</span></div>;
  const state = result?.epoch === epoch ? result : null, value = state?.value;
  const progress = !state ? "正在读取同步进度…" : state.failed ? "同步进度读取失败，已保存内容仍可使用" : !value?.confirmed ? "知识库已添加，等待确认同步状态" : !value.metadataReady ? `正在读取笔记目录 · 已保存 ${value.ready} 篇正文` : value.ready === value.total && !value.failed && !value.unverified ? `正文已保存 · ${value.ready} 篇` : `正文已保存 ${value.ready} / ${value.total} 篇${value.failed ? ` · ${value.failed} 篇需重试` : ""}${value.unverified ? ` · ${value.unverified} 篇待确认` : ""}`;
  // Coverage describes downloaded bodies, not the upload queue. Never imply
  // pending uploads (or completed synchronization) from this aggregate alone;
  // each note keeps its authoritative pending / acknowledged state below.
  const detail = value?.writeState === "revoked" ? "同步授权已撤销，需在电脑重新授权" : value?.paused ? "剩余正文下载已暂停" : value?.waitingCurrent ? "等待电脑打开此知识库" : !connected ? "电脑未连接 · 已保存笔记可离线使用" : value?.writeState === "readonly" ? "电脑已连接 · 授权为只读" : value?.confirmed && value.writeState === "granted" ? "电脑已连接 · 更改会自动同步" : "电脑已连接 · 同步权限待确认";
  const summary = !canReadCoverage ? "原电脑未连接" : !connected ? "未连接" : state?.failed || actionError || value?.failed ? "同步需重试" : value?.writeState === "revoked" ? "授权已撤销" : value?.paused ? "下载已暂停" : value?.writeState === "readonly" ? "已连接 · 只读" : "已连接";
  // Only a verified, online metadata snapshot can give a determinate fraction.
  // Download coverage is never an upload acknowledgement or a global sync tick.
  const determinate = connected && !!value?.confirmed && value.metadataReady && value.total > 0 && !value.failed && !value.unverified && !value.paused && !value.waitingCurrent && (value.writeState === "granted" || value.writeState === "readonly");
  const shortProgress = !canReadCoverage || !connected ? "等待连接" : actionError ? "同步操作失败" : state?.failed ? "进度读取失败" : !value?.confirmed ? "等待确认" : value.paused ? "下载已暂停" : value.waitingCurrent ? "等待打开知识库" : !value.metadataReady ? "正在读取目录" : `正文 ${value.ready}/${value.total}${value.failed ? " · 需重试" : value.unverified ? " · 待确认" : ""}`;
  // A status read is not a transfer. Startup/completed coverage stays quiet;
  // paused, disconnected and permission-blocked states remain in the pill.
  // Failed/unverified unfinished coverage can still use the static track.
  const pendingDownload = connected && !!value?.confirmed && !value.paused && !value.waitingCurrent && (value.writeState === "granted" || value.writeState === "readonly") && (!value.metadataReady || value.ready < value.total || value.failed > 0 || value.unverified > 0);
  const fullStatus = canReadCoverage ? `${progress} · ${detail}` : "原电脑未连接 · 可使用已保存的笔记";
  return <div className="st-sync-control">
    <button type="button" className="st-sync-pill" title={fullStatus} aria-label={`同步状态：${summary}`} onClick={() => setDetailsOpen(true)}><span className={"st-sync-dot" + (connected ? " is-connected" : "")} aria-hidden="true" />{summary}</button>
    {pendingDownload && !dismissed ? <SwipeProgressDock key={dockKey + scope} onDismiss={() => { const focused = document.activeElement?.closest(".st-sync-dock"); const pill = focused?.parentElement?.querySelector<HTMLButtonElement>(".st-sync-pill"); setDismissed(true); pill?.focus(); }}>
      <button type="button" className="st-sync-dock-summary" onClick={() => setDetailsOpen(true)}><span role="status">{shortProgress}</span>{determinate ? <progress aria-label="正文保存进度" max={value!.total} value={Math.min(value!.ready, value!.total)} /> : <span className="st-sync-track" role="progressbar" aria-label="正文保存进度" aria-valuetext={shortProgress} />}</button>
    </SwipeProgressDock> : null}
    {detailsOpen ? <Sheet title="保存与同步" registerDismiss={registerOverlay} onClose={() => setDetailsOpen(false)}>
    <div className="st-sync-details"><p role="status">{fullStatus}</p>
    <p className="st-sheet-copy">正文进度仅表示下载到手机的内容；每篇笔记的上传状态见笔记列表。收起进度不会停止同步。</p>
    {pendingDownload && dismissed ? <Button kind="quiet" onClick={() => { setDismissed(false); setDetailsOpen(false); }}>显示保存进度</Button> : null}
    {!readOnly && state && !state.failed && !value?.confirmed ? <Button kind="quiet" disabled={!connected || busy} onClick={() => void retry(true)}>{busy ? "正在确认…" : "开始同步"}</Button> : null}
    {!readOnly && value?.confirmed && (value.paused || value.failed > 0) ? <Button kind="quiet" disabled={!connected || busy} onClick={() => void retry(false)}>{busy ? "正在处理…" : value.paused ? "继续下载正文" : "重试未完成正文"}</Button> : null}
    {state?.failed ? <Button kind="quiet" onClick={() => { if (current.current.epoch === epoch) setRevision(value => value + 1); }}>重新读取同步进度</Button> : null}
    {actionError ? <p role="alert">{actionError}</p> : null}
    </div></Sheet> : null}
  </div>;
}

function ManagedNotesCollection({ catalog, modeSwitch, management, onSelect, readOnly: catalogReadOnly, active, conn }: {
  active: boolean; conn: ConnState | null;
  catalog: { items: ManagedVault[]; selectedVaultId: string | null }; modeSwitch: ReactNode; management: ReactNode;
  onSelect: (id: string) => Promise<void>; readOnly: boolean;
}) {
  const { open, registerOverlay } = useStillNav();
  const vaultId = catalog.selectedVaultId || "";
  const vault = catalog.items.find(item => item.localVaultId === vaultId);
  const [view, setViewState] = useState(() => ({ vaultId, browse: retained.get(vaultId) || blankBrowse() }));
  // Gate synchronously: a new vault must never render the previous vault's rows or query.
  const browse = view.vaultId === vaultId ? view.browse : retained.get(vaultId) || blankBrowse();
  useEffect(() => { if (active && !catalogReadOnly && !vault?.transferState) setManagedImportTarget(vaultId, browse.folder); else invalidateManagedImportTarget(); return invalidateManagedImportTarget; }, [vaultId, browse.folder, active, catalogReadOnly, vault?.transferState]);
  const scroller = useRef<HTMLDivElement>(null), scrollContent = useRef<HTMLDivElement>(null);
  const cancelScrollRestore = useRef<(() => void) | null>(null);
  const stopScrollRestore = () => cancelScrollRestore.current?.();
  const setBrowse = (patch: Partial<BrowseState>) => {
    stopScrollRestore();
    // Scrolling does not rerender. Never overwrite its latest position with the
    // older browse snapshot when a disclosure only changes the selected folder.
    const next = { ...browse, scroll: scroller.current?.scrollTop ?? retained.get(vaultId)?.scroll ?? browse.scroll, ...patch };
    rememberNotesSort(vaultId, next.sort);
    retained.set(vaultId, next); setViewState({ vaultId, browse: next });
    if (patch.scroll !== undefined && scroller.current) scroller.current.scrollTop = patch.scroll;
  };
  useLayoutEffect(() => {
    const element = scroller.current, content = scrollContent.current;
    if (!element || !content) return;
    const top = retained.get(vaultId)?.scroll || 0;
    let observer: ResizeObserver | undefined;
    const stop = () => { observer?.disconnect(); window.removeEventListener("luckyray:directory-back", stop); cancelScrollRestore.current = null; };
    const restore = () => {
      element.scrollTop = top;
      if (Math.abs(element.scrollTop - top) <= 1) stop();
    };
    cancelScrollRestore.current = stop;
    restore();
    // A returning vault's folders/notes arrive asynchronously. Restore only
    // this pending visit, not every render; any user interaction takes over.
    if (Math.abs(element.scrollTop - top) > 1) {
      observer = new ResizeObserver(restore); observer.observe(content);
      window.addEventListener("luckyray:directory-back", stop);
    }
    return stop;
  }, [vaultId]);
  const [result, setResult] = useState<{ key: string; items: ManagedNote[]; total: number; hasMore: boolean; page: number } | null>(null);
  const [folderResult, setFolders] = useState<{ vaultId: string; paths: string[] } | null>(null);
  const [sheet, setSheet] = useState<"" | "libraries" | "filter" | "folder" | "actions" | "move" | "delete" | "transfer">("");
  const [folderName, setFolderName] = useState("");
  const [knownTags, setKnownTags] = useState<{vaultId: string; tags: string[]}>({vaultId, tags: []});
  const recordTags = (tags: string[]) => setKnownTags(previous => {
    const merged = [...new Set([...(previous.vaultId === vaultId ? previous.tags : []), ...tags])].sort();
    return previous.vaultId === vaultId && merged.join("\0") === previous.tags.join("\0") ? previous : {vaultId, tags: merged};
  });
  const [transferTarget, setTransferTarget] = useState("");
  const [transferPreview, setTransferPreview] = useState<{ source: string; target: string; value: ManagedTransferPreview } | null>(null);
  const [filterDraft, setFilterDraft] = useState<BrowseState>(blankBrowse);
  const [action, setAction] = useState<ManagedNote | null>(null);
  const [error, setError] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0);
  const generation = useRef(0), mutation = useRef(false), alive = useRef(true);
  const filtered = !!browse.query.trim() || browse.range !== "all" || !!browse.tag;
  const query = { localVaultId: vaultId, q: browse.query.trim() || undefined, folder: filtered ? undefined : "", sort: browse.sort, tag: browse.tag || undefined,
    pinned: browse.range === "pinned" ? true : undefined, favorite: browse.range === "favorite" ? true : undefined, archived: browse.range === "archived", limit: 50 };
  const key = JSON.stringify(query);
  const currentKey = useRef(key); currentKey.current = key;
  const currentVault = useRef(vaultId); currentVault.current = vaultId;
  const load = async (page: number) => {
    const token = ++generation.current, requestKey = key;
    setLoading(true); setError(""); setLoadFailed(false);
    try {
      let next = await managedVault.notes({ ...query, page });
      // Revalidate the already-visible extent without collapsing page 2+ to
      // page 1 when a background commit lands. Publish one complete result.
      let publishedPage = page;
      const retainedPages = page === 1 && result?.key === requestKey ? result.page : page;
      while (publishedPage < retainedPages && next.hasMore) {
        if (!alive.current || token !== generation.current || currentKey.current !== requestKey) return;
        const following = await managedVault.notes({ ...query, page: publishedPage + 1 });
        next = { ...following, items: [...next.items, ...following.items.filter(item => !next.items.some(old => old.noteId === item.noteId))] };
        publishedPage++;
      }
      if (!alive.current || token !== generation.current || currentKey.current !== requestKey) return;
      if (next.items.some(item => item.localVaultId !== vaultId)) throw new Error("笔记库身份不匹配，已停止显示");
      setResult(previous => ({ key: requestKey, items: page > 1 && previous?.key === requestKey ? [...previous.items, ...next.items.filter(item => !previous.items.some(old => old.noteId === item.noteId))] : next.items, total: next.total, hasMore: next.hasMore, page: publishedPage }));
    } catch (reason) { if (alive.current && token === generation.current && currentKey.current === requestKey) { setError(failureCopy(reason)); setLoadFailed(true); } }
    finally { if (alive.current && token === generation.current && currentKey.current === requestKey) setLoading(false); }
  };
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  useEffect(() => { generation.current++; if (!active || !vault || vault.migrationState !== "ready") return; void load(1); return () => { generation.current++; }; }, [key, revision, vault?.migrationState, active]);
  useEffect(() => {
    let live = true; if (!active || !vaultId) return;
    managedVault.folders(vaultId).then(value => { if (live && currentVault.current === vaultId) setFolders({ vaultId, paths: value.paths }); }).catch(reason => { if (live) { setError(failureCopy(reason)); setLoadFailed(true); } });
    return () => { live = false; };
  }, [vaultId, revision, active]);
  useEffect(() => { const refresh = (event: Event) => {
    const changed = (event as CustomEvent<{localVaultId?: string}>).detail?.localVaultId;
    if (!changed || changed === currentVault.current) setRevision(value => value + 1);
  }; if (!active) return; window.addEventListener("luckyray:managed-vault-change", refresh); return () => window.removeEventListener("luckyray:managed-vault-change", refresh); }, [active]);
  useEffect(() => {
    const back = (event: Event) => { if (!active || !filtered || !browse.folder) return; event.preventDefault(); setBrowse(browse.query ? { query: "" } : { folder: browse.folder.split("/").slice(0, -1).join("/"), scroll: 0 }); };
    window.addEventListener("luckyray:directory-back", back); return () => window.removeEventListener("luckyray:directory-back", back);
  }, [vaultId, browse.folder, browse.query, active, filtered]);
  const items = result?.key === key ? result.items : [];
  const paths = folderResult?.vaultId === vaultId ? folderResult.paths : [];
  const run = async (operation: () => Promise<void>, close = true) => {
    if (mutation.current) return; mutation.current = true; setBusy(true); setError(""); setLoadFailed(false);
    const owner = vaultId;
    try { await operation(); if (alive.current && currentVault.current === owner) { if (close) setSheet(""); setRevision(value => value + 1); } }
    catch (reason) { if (alive.current && currentVault.current === owner) setError(failureCopy(reason)); }
    finally { mutation.current = false; if (alive.current) setBusy(false); }
  };
  const create = () => run(async () => { const note = await managedVault.create(vaultId, "新笔记", "", [], browse.folder); if (alive.current && currentVault.current === vaultId) open("note", managedNoteRoute(vaultId, note.noteId), { edit: true }); });
  const readOnly = catalogReadOnly || Boolean(vault?.transferState);
  const ready = vault?.migrationState === "ready" && !readOnly;
  const vaultLabel = buildKnowledgeVaultCatalog(catalog).items.find(entry => entry.id === vaultId)?.displayName || vault?.name || "请选择笔记库";
  const folderLabel = browse.folder ? `全部笔记 / ${browse.folder.split("/").join(" / ")}` : "全部笔记";
  const locationLabel = `${vaultLabel} · ${folderLabel}`;
  return <div className="st-view st-knowledge-view">
    <div className="st-collection-head">{modeSwitch}<IconButton icon="folder" label="知识库" onClick={() => setSheet("libraries")} /><button type="button" className="st-icon-button" aria-label="导入笔记文件" title="导入笔记文件" disabled={!ready || busy} onClick={() => void pickLocalNoteFile()}><NotesActionIcon kind="import"/></button><IconButton icon="edit" label="新建笔记" disabled={!ready || busy} onClick={() => void create()} /></div>
    <div className="st-collection-top"><SearchField value={browse.query} onChange={query => setBrowse({ query, scroll: 0 })} placeholder="搜索笔记" /></div>
    <div className="st-scroll" aria-busy={loading || result?.key !== key || folderResult?.vaultId !== vaultId} ref={scroller} onPointerDown={stopScrollRestore} onTouchStart={stopScrollRestore} onWheel={stopScrollRestore} onKeyDown={stopScrollRestore} onScroll={event => { if (!cancelScrollRestore.current) retained.set(vaultId, { ...browse, scroll: event.currentTarget.scrollTop }); }}>
      <div ref={scrollContent}>
      <div className="st-compact-toolbar st-knowledge-toolbar"><button type="button" className="st-notes-vault-label" title={locationLabel} aria-label={`当前位置：${locationLabel}，打开知识库`} aria-haspopup="dialog" onClick={() => setSheet("libraries")}>{browse.folder ? folderLabel : vaultLabel}</button><VaultSyncStatus key={vaultId} vault={vault} conn={conn} readOnly={readOnly} active={active} /><button type="button" className="st-icon-button st-new-folder" aria-label="新建文件夹" title="新建文件夹" disabled={!ready || busy} onClick={() => { setFolderName(""); setSheet("folder"); }}><NotesActionIcon kind="folder-add"/></button><IconButton icon="filter" label="筛选与排序" onClick={() => { setFilterDraft({ ...browse }); setSheet("filter"); }} /></div>
      {!filtered ? <NotesInlineFolders key={vaultId} vaultId={vaultId} paths={paths} active={active} onTags={recordTags} selected={browse.folder} onSelect={folder => setBrowse({folder})} sort={browse.sort} revision={revision} readOnly={readOnly} onOpen={note => open("note", managedNoteRoute(vaultId, note.noteId), {edit: !readOnly && note.bodyState === "ready"})} onActions={note => { setAction(note); setSheet("actions"); }}/> : null}
      {error ? <p role="alert" className="st-folder-status">{error}{loadFailed ? <button type="button" className="st-notes-retry-link" onClick={() => setRevision(value => value + 1)}>重新读取</button> : null}</p> : null}
      {items.map(note => <CompactNoteRow key={note.noteId} note={note} readOnly={readOnly} showPath={filtered} onOpen={note => open("note", managedNoteRoute(vaultId, note.noteId), {edit: !readOnly && note.bodyState === "ready", noteSearch: browse.query.trim() ? {query: browse.query.trim()} : undefined})} onActions={note => { setAction(note); setSheet("actions"); }}/>) }
      {!loading && result?.key === key && folderResult?.vaultId === vaultId && !items.length && !error && (filtered || !paths.length) ? <Empty title={ready ? "没有找到笔记" : "请选择可用笔记库"} body={ready ? "新建一篇笔记，或者换一个搜索词。" : "从知识库列表中选择，不会自动合并不同的库。"} /> : null}
      {result?.key === key && result.hasMore ? <Button kind="quiet" disabled={loading} onClick={() => void load(result.page + 1)}>加载更多</Button> : null}
      </div>
    </div>
    {sheet === "libraries" ? <Sheet title="知识库" registerDismiss={registerOverlay} onClose={() => setSheet("")} busy={busy}>
      <p className="st-sheet-copy st-notes-full-location">{locationLabel}</p>
      {catalog.items.filter(item => item.transferState !== "completed").map(item => <Option key={item.localVaultId} label={buildKnowledgeVaultCatalog(catalog).items.find(entry => entry.id === item.localVaultId)?.displayName || item.name} detail={buildKnowledgeVaultCatalog(catalog).items.find(entry => entry.id === item.localVaultId)?.detailLabel} selected={item.localVaultId === vaultId} onClick={() => { if (item.migrationState === "ready") void run(() => onSelect(item.localVaultId)); }} />)}
      {!vault?.binding ? <Option label="加入同步库" icon="folder" detail="将此本地库的笔记加入一个已关联的库，原始内容保留。" onClick={() => { setTransferTarget(""); setTransferPreview(null); setSheet("transfer"); }} /> : null}
      <div onClick={() => setSheet("")}>{management}</div>
      {error ? <p role="alert" className="st-sheet-copy">{error}</p> : null}
    </Sheet> : null}
    {sheet === "transfer" && !vault?.binding ? <Sheet title="加入同步库" registerDismiss={registerOverlay} onClose={() => setSheet("")} busy={busy}>
      {vault?.transferState === "pending" ? <p className="st-sheet-copy">上次加入尚未完成，请选择原目标库重新检查并继续；完成前原库保持只读。</p> : null}
      <p className="st-sheet-copy">选择一个已关联的笔记库。复制并校验完成后，后续修改在目标库中继续同步；此库的原始内容保留，不按标题合并或覆盖。</p>
      <select className="st-input" aria-label="加入的同步库" value={transferTarget} disabled={busy} onChange={event => { setTransferTarget(event.target.value); setTransferPreview(null); }}>
        <option value="">请选择同步库</option>{catalog.items.filter(item => item.binding && item.migrationState === "ready" && item.localVaultId !== vaultId && (!vault?.transferTargetVaultId || item.localVaultId === vault.transferTargetVaultId)).map(item => <option key={item.localVaultId} value={item.localVaultId}>{item.name}</option>)}
      </select>
      {!catalog.items.some(item => item.binding && item.migrationState === "ready") ? <p className="st-sheet-copy">还没有已关联的本地库，请通过添加知识库，从电脑同步一个知识库。</p> : null}
      <Button kind="quiet" disabled={busy || !catalog.items.some(item => item.localVaultId === transferTarget && item.binding && item.migrationState === "ready")} onClick={() => void run(async () => {
        const source = vaultId, target = transferTarget;
        const value = await managedVault.transferPreview(source, target);
        if (alive.current && currentVault.current === source) setTransferPreview({ source, target, value });
      }, false)}>检查加入计划</Button>
      {transferPreview?.source === vaultId && transferPreview.target === transferTarget ? <>
        <p className="st-sheet-copy">将加入 {transferPreview.value.noteCount} 篇笔记。{transferPreview.value.blockedCount > 0 ? `${transferPreview.value.blockedCount} 篇暂不能加入，请先处理缺失正文或冲突。当前不会复制任何笔记。` : "原始内容会保留。"}</p>
        <p className="st-sheet-copy">{transferPreview.value.incompleteCount ? `${transferPreview.value.incompleteCount} 篇的链接或附件尚待核对，原始正文保留，不会显示为完整同步。` : ""}</p>
        {transferPreview.value.requiresConnection ? <p className="st-sheet-copy">含笔记链接，需要连接支持链接迁移的电脑确认路径；准备成功后仍为待同步，原始内容保留。无法连接时不会锁定原库。</p> : null}
        <Button disabled={busy || !transferPreview.value.canCommit || transferPreview.value.blockedCount > 0} onClick={() => void run(async () => {
          await managedVault.transferCommit(vaultId, transferTarget, transferPreview.value.snapshotHash, transferPreview.value.parseInputs?.map(managedWikiProof));
          if (alive.current && currentVault.current === vaultId) await onSelect(transferTarget);
        })}>确认加入所选同步库</Button>
      </> : null}
      {error ? <p role="alert" className="st-sheet-copy">{error}</p> : null}
    </Sheet> : null}
    {sheet === "filter" ? <Sheet title="筛选与排序" registerDismiss={registerOverlay} onClose={() => setSheet("")} footer={<div className="st-vault-actions"><Button kind="quiet" onClick={() => setFilterDraft(blankBrowse())}>重置</Button><Button onClick={() => { setBrowse({ range: filterDraft.range, sort: filterDraft.sort, tag: filterDraft.tag, scroll: 0 }); setSheet(""); }}>应用</Button></div>}><p className="st-sheet-caption">范围</p>{([["all", "全部笔记"], ["pinned", "置顶"], ["favorite", "收藏"], ["archived", "归档"]] as const).map(([range, label]) => <Option key={range} label={label} selected={filterDraft.range === range} onClick={() => setFilterDraft(value => ({ ...value, range }))} />)}<p className="st-sheet-caption">标签</p><Option label="全部标签" selected={!filterDraft.tag} onClick={() => setFilterDraft(value => ({ ...value, tag: "" }))} />{[...new Set([...items.flatMap(note => note.tags), ...(knownTags.vaultId === vaultId ? knownTags.tags : [])])].map(tag => <Option key={tag} label={`#${tag}`} selected={filterDraft.tag === tag} onClick={() => setFilterDraft(value => ({ ...value, tag }))} />)}<p className="st-sheet-caption">排序</p>{([["recent", "最近更新"], ["name", "名称"]] as const).map(([sort, label]) => <Option key={sort} label={label} selected={filterDraft.sort === sort} onClick={() => setFilterDraft(value => ({ ...value, sort }))} />)}</Sheet> : null}
    {sheet === "folder" ? <Sheet title="新建文件夹" registerDismiss={registerOverlay} onClose={() => setSheet("")} busy={busy}><form className="st-vault-create-form" onSubmit={event => { event.preventDefault(); if (ready && !busy && folderName.trim()) void run(async () => { await managedVault.createFolder(vaultId, folderName.trim(), browse.folder); }); }} aria-busy={busy}><label htmlFor="st-new-folder-name">文件夹名称</label><input id="st-new-folder-name" className="st-input" aria-label="文件夹名称" aria-describedby="st-new-folder-parent" value={folderName} enterKeyHint="done" autoComplete="off" disabled={busy || !ready} onChange={event => setFolderName(event.target.value)} /><p id="st-new-folder-parent" className="st-sheet-copy">创建于：{browse.folder || "根目录"}</p><button type="submit" className="st-button st-button--primary" disabled={busy || !ready || !folderName.trim()}>{busy ? "正在创建…" : "创建"}</button>{error ? <p role="alert">{error}</p> : null}</form></Sheet> : null}
    {sheet === "actions" && action?.localVaultId === vaultId ? <Sheet title="笔记操作" registerDismiss={registerOverlay} onClose={() => setSheet("")} busy={busy}>{(["pinned", "favorite", "archived"] as const).map((flag, index) => <Option key={flag} label={(action[flag] ? "取消" : "") + ["置顶", "收藏", "归档"][index]} onClick={() => void run(async () => { await managedVault.setFlags(vaultId, action.noteId, action.revision, { [flag]: !action[flag] }); })} />)}<Option label="移动到目录" icon="folder" onClick={() => setSheet("move")} /><Option label={vault?.binding ? "删除并同步到此电脑知识库" : "移到废纸篓"} icon="trash" danger onClick={() => setSheet("delete")} />{error ? <p role="alert">{error}</p> : null}</Sheet> : null}
    {sheet === "move" && action?.localVaultId === vaultId ? <Sheet title="移动到目录" registerDismiss={registerOverlay} onClose={() => setSheet("")} busy={busy}>{["", ...paths].map(folder => <Option key={folder} label={folder || "根目录"} selected={folder === action.folder} onClick={() => void run(async () => { await managedVault.move(vaultId, action.noteId, action.revision, folder); })} />)}{error ? <p role="alert">{error}</p> : null}</Sheet> : null}
    {sheet === "delete" && action?.localVaultId === vaultId ? <Sheet title={vault?.binding ? "删除并同步到此电脑知识库？" : "移到废纸篓？"} registerDismiss={registerOverlay} onClose={() => setSheet("")} busy={busy}><p className="st-sheet-copy">{vault?.binding ? `将删除「${action.title}」并同步到关联电脑知识库「${vault.name}」。离线时保持待同步，不是仅清理手机缓存。手机保留的历史不代表电脑端可以撤销。` : `将「${action.title}」移到此本地库的废纸篓。`}</p><Button disabled={busy} onClick={() => void run(async () => { await managedVault.trash(vaultId, action.noteId, action.revision); })}>{vault?.binding ? "确认删除并同步" : "确认移到废纸篓"}</Button>{error ? <p role="alert">{error}</p> : null}</Sheet> : null}
  </div>;
}
