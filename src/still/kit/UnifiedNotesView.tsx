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
import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { managedVault, managedNoteRoute, type ManagedVault, type ManagedNote, type ManagedMigrationStatus, type ManagedTransferPreview } from "../../services/managedVault";
import { KnowledgeModeSwitch, type KnowledgeMode } from "./KnowledgeModeSwitch";
import { Button, Empty, Icon, IconButton, Option, SearchField, Sheet } from "./StillImports";
import { FolderBreadcrumbs } from "./knowledgeFolders";
import { useStillNav } from "../StillShell";

const MobileGraphView = lazy(() => import("../../features/graph/MobileGraphView"));

let rememberedMode: KnowledgeMode = "notes";
type BrowseState = { query: string; folder: string; sort: "name" | "recent"; range: "all" | "pinned" | "favorite" | "archived"; tag: string; scroll: number };
const retained = new Map<string, BrowseState>();
const blankBrowse = (): BrowseState => ({ query: "", folder: "", sort: "recent", range: "all", tag: "", scroll: 0 });
export type LegacyNotesRenderer = (modeSwitch: ReactNode, management: ReactNode) => ReactNode;

/** Graph never mounts the Notes loader. Session retention is separate from effects. */
export function UnifiedNotesRoot({ legacy, active = true, conn = null }: { legacy: LegacyNotesRenderer; active?: boolean; conn?: ConnState | null }) {
  const [mode, setMode] = useState<KnowledgeMode>(rememberedMode);
  const changeMode = (next: KnowledgeMode) => { rememberedMode = next; setMode(next); };
  const modeSwitch = <KnowledgeModeSwitch value={mode} onChange={changeMode} />;
  if (mode === "graph") return <Suspense fallback={<div className="st-view st-knowledge-view"><div className="st-collection-head">{modeSwitch}</div><p role="status">正在打开图谱…</p></div>}><MobileGraphView modeSwitch={modeSwitch} active={active} conn={conn} onManageVaults={() => changeMode("notes")} /></Suspense>;
  return <NotesAuthority modeSwitch={modeSwitch} legacy={legacy} active={active} conn={conn} />;
}

function NotesAuthority({ modeSwitch, legacy, active, conn }: { modeSwitch: ReactNode; legacy: LegacyNotesRenderer; active: boolean; conn: ConnState | null }) {
  const { registerOverlay } = useStillNav();
  const sourceChoice = useSyncExternalStore(noteSourceSelection.subscribe, noteSourceSelection.snapshot);
  const [catalog, setCatalog] = useState<{ items: ManagedVault[]; selectedVaultId: string | null } | null>(null);
  const [status, setStatus] = useState<ManagedMigrationStatus | null>(null);
  const [error, setError] = useState("");
  const [legacyVisible, setLegacyVisible] = useState(false);
  const [panel, setPanel] = useState<"" | "add" | "manage" | "migration">("");
  const [name, setName] = useState(() => { try { return JSON.parse(localStorage.getItem("luckyray:new-vault-intent") || "null")?.name || ""; } catch { return ""; } });
  const [busy, setBusy] = useState(false);
  const pending = useRef(false), epoch = useRef(0), alive = useRef(true);
  const selectionQueue = useRef(Promise.resolve());
  const creationIntent = useRef<{requestId: string; name: string} | null>(null);
  if (!creationIntent.current) { try { const saved = JSON.parse(localStorage.getItem("luckyray:new-vault-intent") || "null"); if (saved && typeof saved.requestId === "string" && typeof saved.name === "string") creationIntent.current = saved; } catch { /* No durable pending request. */ } }
  const instance = conn?.paired ? conn.identity?.instanceId || "" : "";
  const connected = conn?.ws.state === "connected";
  const libraries = useDesktopLibraries(instance, connected);
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
  useEffect(() => { alive.current = true; const changed = () => void refresh(); void refresh(); window.addEventListener("luckyray:managed-vault-change", changed); return () => { alive.current = false; epoch.current++; window.removeEventListener("luckyray:managed-vault-change", changed); }; }, []);
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
    setStatus(result);
    if (commit && result.state === "ready") { await select(result.localVaultId, version); await refresh(); setPanel(""); window.dispatchEvent(new Event("luckyray:managed-vault-change")); }
  });
  const management = <><Option label="添加知识库" icon="plus" onClick={() => setPanel("add")} /><Option label="知识库管理" icon="folder" onClick={() => setPanel("manage")} /></>;
  const current = unified.items.find(item => item.id === unified.selectedVaultId);
  const overlays = <>
    {panel === "add" ? <Sheet title="添加知识库" registerDismiss={registerOverlay} onClose={() => setPanel("")} busy={busy}>
      <p className="st-sheet-caption">从电脑同步</p><p className="st-sheet-copy">选择后保存在手机，笔记和图谱使用同一个库。连接电脑时自动同步。</p>
      {!connected ? <p role="status" className="st-sheet-copy">请先连接电脑，再选择要同步的知识库。</p> : libraries.phase === "loading" ? <p role="status">正在读取可同步的知识库…</p> : available.length ? available.map(row => <Option key={row.vaultId} label={row.displayName} detail="同步到手机" onClick={() => { if (!busy) void initialize(row.vaultId); }} />) : <p className="st-sheet-copy">{libraries.phase === "error" ? "知识库列表读取失败，请重新连接电脑后重试。" : "没有新的可同步知识库，已添加的库在目录中选择。"}</p>}
      <p className="st-sheet-caption">新建知识库</p><input className="st-input" aria-label="知识库名称" placeholder="我的知识库" value={name} maxLength={120} onChange={event => setName(event.target.value)} disabled={busy || !!creationIntent.current} /><Button disabled={busy} onClick={() => void initialize()}>创建知识库</Button>
      <p className="st-sheet-copy">{creationIntent.current ? `正在确认上次创建的「${creationIntent.current.name}」，重试不会重复建库。` : "新建空库不会搬移或覆盖已有笔记。"}</p>{error ? <p role="alert">{error}</p> : null}
    </Sheet> : null}
    {panel === "manage" ? <Sheet title="知识库管理" registerDismiss={registerOverlay} onClose={() => setPanel("")} busy={busy}>
      {current ? <><p className="st-sheet-caption">{current.displayName}</p><p className="st-sheet-copy">{current.detailLabel}</p><details><summary>详细信息</summary><p className="st-sheet-copy">库标识：{current.id}</p>{current.binding ? <p className="st-sheet-copy">电脑：{current.binding.instanceId}<br />来源库：{current.binding.remoteVaultId}</p> : null}</details>{current.binding ? <p className="st-sheet-copy">{connected && instance === current.binding.instanceId ? "电脑已连接。同步进度见笔记列表。" : "电脑未连接。已保存的内容可离线使用，待同步内容将在连接后重试。"}</p> : <p className="st-sheet-copy">笔记保存在手机，尚未关联电脑。</p>}</> : null}
      {unified.issues.map((issue, index) => <p key={index} role="status" className="st-sheet-copy">{issue.message}</p>)}
      <Option label={status?.state === "ready" ? "查看旧数据升级记录" : "升级已有笔记"} detail="先预览，确认后复制；原始数据保留" onClick={() => setPanel("migration")} />
      <Option label="旧数据与恢复" detail="查看升级前的笔记与保存记录" onClick={() => { setPanel(""); setLegacyVisible(true); }} />
    </Sheet> : null}
    {panel === "migration" ? <Sheet title="升级已有笔记" registerDismiss={registerOverlay} onClose={() => setPanel("")} busy={busy}>
      <p className="st-sheet-copy">将已有笔记复制到知识库。按原始库身份保留，不合并同名库，原始内容不删除。</p>
      {status?.state === "prepared" ? <><p className="st-sheet-copy">待复制 {status.noteCount} 篇笔记。</p>{status.warnings.map((warning, i) => <p key={i} role="status">{warning}</p>)}<Button kind="quiet" disabled={busy} onClick={() => void migrate(false)}>重新预览</Button><Button disabled={busy} onClick={() => void migrate(true)}>确认升级，保留原始数据</Button></> : status?.state === "ready" ? <><p className="st-sheet-copy">旧数据复制已完成。各库的笔记数量请在目录中查看。</p>{status.warnings.map((warning, i) => <p key={i} role="status">{warning}</p>)}</> : <Button disabled={busy} onClick={() => void migrate(false)}>预览升级计划</Button>}
      {error ? <p role="alert">{error}</p> : null}
    </Sheet> : null}
  </>;
  if (!catalog || !status) return <div className="st-view st-knowledge-view"><div className="st-collection-head">{modeSwitch}</div><p role="status">{error || "正在读取知识库…"}</p>{error ? <Button onClick={() => void refresh()}>重试</Button> : null}</div>;
  if (legacyVisible) return <><div className="st-legacy-recovery-heading"><Button kind="quiet" onClick={() => { setLegacyVisible(false); noteSourceSelection.select(catalog.selectedVaultId ? {kind:"managed",localVaultId:catalog.selectedVaultId} : null); }}>返回知识库</Button><span>旧数据与恢复</span></div>{legacy(modeSwitch, management)}{overlays}</>;
  if (!current) return <div className="st-view st-knowledge-view"><div className="st-collection-head">{modeSwitch}</div><div className="st-scroll"><Empty title={unified.selectionState === "missing" ? "所选知识库不可用" : "选择你的知识库"} body="从电脑同步已有库，或创建一个新库。笔记和图谱共用同一知识库。" />{unified.items.map(item => <Option key={item.id} label={item.displayName} detail={item.detailLabel} onClick={() => void operation(() => select(item.id))} />)}{management}{status.state !== "ready" ? <Option label="升级已有笔记" detail="预览并保留原始数据" onClick={() => setPanel("migration")} /> : null}{error ? <p role="alert">{error}</p> : null}</div>{overlays}</div>;
  return <><ManagedNotesCollection active={active} catalog={{ items: unified.items.map(item => item.vault), selectedVaultId: current.id }} readOnly={current.readOnly} conn={conn} modeSwitch={modeSwitch} management={management} onSelect={select} />{overlays}</>;
}

/** Coverage is scoped to the exact binding. It is not an acknowledgement of
 * uploads, so downloaded bodies never become a blanket "synced" claim. */
function VaultSyncStatus({ vault, conn, readOnly }: { vault?: ManagedVault; conn: ConnState | null; readOnly: boolean }) {
  const binding = vault?.binding;
  const owner = binding ? JSON.stringify([binding.instanceId, binding.remoteVaultId]) : "";
  const pairedInstance = conn?.paired ? conn.identity?.instanceId || "" : "";
  const canReadCoverage = !!binding && pairedInstance === binding.instanceId;
  const connected = canReadCoverage && conn?.ws.state === "connected";
  // Pair transitions invalidate even A -> B -> A, including transitions where
  // both computers are offline. Gate during render, before effect cleanup.
  const scope = JSON.stringify([owner, pairedInstance]);
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
    if (!binding || !canReadCoverage) return;
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
  }, [owner, epoch, canReadCoverage, connected, revision]);
  if (!binding) return null;
  if (!canReadCoverage) return <div className="st-folder-status"><p role="status">原电脑未连接 · 可使用已保存的笔记</p></div>;
  const state = result?.epoch === epoch ? result : null, value = state?.value;
  const progress = !state ? "正在读取同步进度…" : state.failed ? "同步进度读取失败，已保存内容仍可使用" : !value?.confirmed ? "知识库已添加，等待确认同步状态" : !value.metadataReady ? `正在读取笔记目录 · 已保存 ${value.ready} 篇正文` : value.ready === value.total && !value.failed && !value.unverified ? `正文已保存 · ${value.ready} 篇` : `正文已保存 ${value.ready} / ${value.total} 篇${value.failed ? ` · ${value.failed} 篇需重试` : ""}${value.unverified ? ` · ${value.unverified} 篇待确认` : ""}`;
  const detail = value?.writeState === "revoked" ? "同步授权已撤销，需在电脑重新授权" : value?.paused ? "剩余正文下载已暂停" : value?.waitingCurrent ? "等待电脑打开此知识库" : !connected ? "电脑未连接 · 待同步内容保留在手机" : value?.writeState === "readonly" ? "电脑授权为只读" : "连接电脑后自动同步更改";
  return <div className="st-folder-status"><p role="status">{progress} · {detail}</p>
    {!readOnly && state && !state.failed && !value?.confirmed ? <Button kind="quiet" disabled={!connected || busy} onClick={() => void retry(true)}>{busy ? "正在确认…" : "开始同步"}</Button> : null}
    {!readOnly && value?.confirmed && (value.paused || value.failed > 0) ? <Button kind="quiet" disabled={!connected || busy} onClick={() => void retry(false)}>{busy ? "正在处理…" : value.paused ? "继续下载正文" : "重试未完成正文"}</Button> : null}
    {state?.failed ? <Button kind="quiet" onClick={() => { if (current.current.epoch === epoch) setRevision(value => value + 1); }}>重新读取同步进度</Button> : null}
    {actionError ? <p role="alert">{actionError}</p> : null}
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
  const setBrowse = (patch: Partial<BrowseState>) => { const next = { ...browse, ...patch }; retained.set(vaultId, next); setViewState({ vaultId, browse: next }); };
  const [result, setResult] = useState<{ key: string; items: ManagedNote[]; total: number; hasMore: boolean; page: number } | null>(null);
  const [folderResult, setFolders] = useState<{ vaultId: string; paths: string[] } | null>(null);
  const [sheet, setSheet] = useState<"" | "directory" | "filter" | "folder" | "actions" | "move" | "delete" | "transfer">("");
  const [tab, setTab] = useState<"directory" | "libraries">("directory");
  const [folderName, setFolderName] = useState("");
  const [transferTarget, setTransferTarget] = useState("");
  const [transferPreview, setTransferPreview] = useState<{ source: string; target: string; value: ManagedTransferPreview } | null>(null);
  const [filterDraft, setFilterDraft] = useState<BrowseState>(blankBrowse);
  const [action, setAction] = useState<ManagedNote | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0);
  const generation = useRef(0), mutation = useRef(false), alive = useRef(true);
  const query = { localVaultId: vaultId, q: browse.query.trim() || undefined, folder: browse.query.trim() ? undefined : browse.folder || undefined, sort: browse.sort, tag: browse.tag || undefined,
    pinned: browse.range === "pinned" ? true : undefined, favorite: browse.range === "favorite" ? true : undefined, archived: browse.range === "archived", limit: 50 };
  const key = JSON.stringify(query);
  const currentKey = useRef(key); currentKey.current = key;
  const currentVault = useRef(vaultId); currentVault.current = vaultId;
  const load = async (page: number) => {
    const token = ++generation.current, requestKey = key;
    setLoading(true); setError("");
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
    } catch (reason) { if (alive.current && token === generation.current && currentKey.current === requestKey) setError(failureCopy(reason)); }
    finally { if (alive.current && token === generation.current && currentKey.current === requestKey) setLoading(false); }
  };
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  useEffect(() => { generation.current++; if (!vault || vault.migrationState !== "ready") return; void load(1); return () => { generation.current++; }; }, [key, revision, vault?.migrationState]);
  useEffect(() => {
    let live = true; if (!vaultId) return;
    managedVault.folders(vaultId).then(value => { if (live && currentVault.current === vaultId) setFolders({ vaultId, paths: value.paths }); }).catch(reason => { if (live) setError(failureCopy(reason)); });
    return () => { live = false; };
  }, [vaultId, revision]);
  useEffect(() => { const refresh = (event: Event) => {
    const changed = (event as CustomEvent<{localVaultId?: string}>).detail?.localVaultId;
    if (!changed || changed === currentVault.current) setRevision(value => value + 1);
  }; window.addEventListener("luckyray:managed-vault-change", refresh); return () => window.removeEventListener("luckyray:managed-vault-change", refresh); }, []);
  useEffect(() => {
    const back = (event: Event) => { if (!active || !browse.folder) return; event.preventDefault(); setBrowse(browse.query ? { query: "" } : { folder: browse.folder.split("/").slice(0, -1).join("/"), scroll: 0 }); };
    window.addEventListener("luckyray:directory-back", back); return () => window.removeEventListener("luckyray:directory-back", back);
  }, [vaultId, browse.folder, browse.query, active]);
  const items = result?.key === key ? result.items : [];
  const paths = folderResult?.vaultId === vaultId ? folderResult.paths : [];
  const children = paths.filter(path => path.split("/").slice(0, -1).join("/") === browse.folder);
  const run = async (operation: () => Promise<void>, close = true) => {
    if (mutation.current) return; mutation.current = true; setBusy(true); setError("");
    const owner = vaultId;
    try { await operation(); if (alive.current && currentVault.current === owner) { if (close) setSheet(""); setRevision(value => value + 1); } }
    catch (reason) { if (alive.current && currentVault.current === owner) setError(failureCopy(reason)); }
    finally { mutation.current = false; if (alive.current) setBusy(false); }
  };
  const create = () => run(async () => { const note = await managedVault.create(vaultId, "新笔记", "", [], browse.folder); if (alive.current && currentVault.current === vaultId) open("note", managedNoteRoute(vaultId, note.noteId), { edit: true }); });
  const statusText = (note: ManagedNote) => note.bodyState === "missing" ? "正文尚未保存到手机" : note.bodyState === "conflict" || note.syncState === "conflict" ? "需处理冲突" : note.syncState === "pending" ? "已保存在手机 · 待同步" : note.syncState === "incomplete" ? "内容不完整" : note.syncState === "synced" ? "已同步" : "仅保存在本地";
  const readOnly = catalogReadOnly || Boolean(vault?.transferState);
  const ready = vault?.migrationState === "ready" && !readOnly;
  return <div className="st-view st-knowledge-view">
    <div className="st-collection-head">{modeSwitch}<IconButton icon="folder" label="目录与库" onClick={() => setSheet("directory")} /><IconButton icon="file" label="导入笔记文件" disabled={!ready || busy} onClick={() => void pickLocalNoteFile()} /><IconButton icon="edit" label="新建笔记" disabled={!ready || busy} onClick={() => void create()} /></div>
    <div className="st-collection-top"><SearchField value={browse.query} onChange={query => setBrowse({ query, scroll: 0 })} placeholder="搜索笔记" /></div>
    <div className="st-scroll" ref={element => { if (element && Math.abs(element.scrollTop - (retained.get(vaultId)?.scroll || 0)) > 1) element.scrollTop = retained.get(vaultId)?.scroll || 0; }} onScroll={event => { retained.set(vaultId, { ...browse, scroll: event.currentTarget.scrollTop }); }}>
      <div className="st-compact-toolbar st-knowledge-toolbar"><span>{buildKnowledgeVaultCatalog(catalog).items.find(entry => entry.id === vaultId)?.displayName || vault?.name || "请选择笔记库"}</span><IconButton icon="filter" label="筛选与排序" onClick={() => { setFilterDraft({ ...browse }); setSheet("filter"); }} /></div>
      <VaultSyncStatus vault={vault} conn={conn} readOnly={readOnly} /><FolderBreadcrumbs current={browse.folder} onSelect={folder => setBrowse({ folder, query: "", scroll: 0 })} />
      {!browse.query.trim() ? children.map(path => <button key={path} className="st-folder-row" onClick={() => setBrowse({ folder: path, scroll: 0 })}><span className="st-folder-symbol"><Icon name="folder" size={20} /></span><span className="st-folder-name">{path.split("/").pop()}</span><Icon name="right" size={14} /></button>) : null}
      {error ? <p role="alert" className="st-folder-status">{error}<Button kind="quiet" onClick={() => setRevision(value => value + 1)}>重试</Button></p> : null}
      {items.map(note => <div className="st-local-note-entry" key={note.noteId}><button className="st-note-row" style={{ flex: 1, minWidth: 0 }} onClick={() => open("note", managedNoteRoute(vaultId, note.noteId), { edit: !readOnly && note.bodyState === "ready", noteSearch: browse.query.trim() ? { query: browse.query.trim() } : undefined })}><span className="st-knowledge-note-symbol" aria-hidden="true"><Icon name="file" size={20} /></span><strong>{note.title || "未命名笔记"}</strong><p>{note.bodyState === "ready" ? (note.content || "").slice(0, 160) : statusText(note)}</p><small><span className="st-note-meta">{statusText(note)}{note.tags.length ? " · " + note.tags.join(" / ") : ""}</span><span className="st-note-flags">{note.pinned ? <span role="img" aria-label="已置顶"><Icon name="pin" size={12} className="st-flag-pin" /></span> : null}{note.favorite ? <span role="img" aria-label="已收藏"><Icon name="heart" size={12} className="st-flag-fav is-on" /></span> : null}</span></small></button><IconButton icon="more" disabled={readOnly} label={`笔记操作：${note.title}`} onClick={() => { setAction(note); setSheet("actions"); }} /></div>)}
      {loading ? <p className="st-folder-status" role="status">正在读取笔记…</p> : !items.length && !error ? <Empty title={ready ? "没有找到笔记" : "请选择可用笔记库"} body={ready ? "新建一篇笔记，或者换一个搜索词。" : "从目录与库中选择，不会自动合并不同的库。"} /> : null}
      {result?.key === key && result.hasMore ? <Button kind="quiet" disabled={loading} onClick={() => void load(result.page + 1)}>加载更多</Button> : null}
    </div>
    {sheet === "directory" ? <Sheet headingSlot={<div className="st-source" role="group" aria-label="目录与库"><span className={"st-source-glide " + (tab === "libraries" ? "is-desktop" : "")} aria-hidden="true" />{(["directory", "libraries"] as const).map(value => <button key={value} aria-pressed={tab === value} onClick={() => setTab(value)}><span className="st-source-label">{value === "directory" ? "目录" : "库"}</span></button>)}</div>} title="目录与库" registerDismiss={registerOverlay} onClose={() => setSheet("")} busy={busy}>

      {tab === "directory" ? <><Option label="全部笔记" icon="knowledge" selected={!browse.folder} onClick={() => { setBrowse({ folder: "", query: "", scroll: 0 }); setSheet(""); }} />{paths.map(path => <Option key={path} label={path} icon="folder" selected={browse.folder === path} onClick={() => { setBrowse({ folder: path, query: "", scroll: 0 }); setSheet(""); }} />)}<fieldset disabled={readOnly} style={{border:0,padding:0,margin:0}}><Option label="新建文件夹" icon="plus" onClick={() => { if (!readOnly) { setFolderName(""); setSheet("folder"); } }} /></fieldset></> : <>{catalog.items.filter(item => item.transferState !== "completed").map(item => <Option key={item.localVaultId} label={buildKnowledgeVaultCatalog(catalog).items.find(entry => entry.id === item.localVaultId)?.displayName || item.name} detail={buildKnowledgeVaultCatalog(catalog).items.find(entry => entry.id === item.localVaultId)?.detailLabel} selected={item.localVaultId === vaultId} onClick={() => { if (item.migrationState === "ready") void run(() => onSelect(item.localVaultId)); }} />)}{!vault?.binding ? <Option label="加入同步库" icon="folder" detail="将此本地库的笔记加入一个已关联的库，原始内容保留。" onClick={() => { setTransferTarget(""); setTransferPreview(null); setSheet("transfer"); }} /> : null}<div onClick={() => setSheet("")}>{management}</div></>}
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
    {sheet === "filter" ? <Sheet title="筛选与排序" registerDismiss={registerOverlay} onClose={() => setSheet("")} footer={<><Button kind="quiet" onClick={() => setFilterDraft(blankBrowse())}>重置</Button><Button onClick={() => { setBrowse({ range: filterDraft.range, sort: filterDraft.sort, tag: filterDraft.tag, scroll: 0 }); setSheet(""); }}>应用</Button></>}><p className="st-sheet-caption">范围</p>{([["all", "全部笔记"], ["pinned", "置顶"], ["favorite", "收藏"], ["archived", "归档"]] as const).map(([range, label]) => <Option key={range} label={label} selected={filterDraft.range === range} onClick={() => setFilterDraft(value => ({ ...value, range }))} />)}<p className="st-sheet-caption">标签</p><Option label="全部标签" selected={!filterDraft.tag} onClick={() => setFilterDraft(value => ({ ...value, tag: "" }))} />{[...new Set(items.flatMap(note => note.tags))].map(tag => <Option key={tag} label={`#${tag}`} selected={filterDraft.tag === tag} onClick={() => setFilterDraft(value => ({ ...value, tag }))} />)}<p className="st-sheet-caption">排序</p>{([["recent", "最近更新"], ["name", "名称"]] as const).map(([sort, label]) => <Option key={sort} label={label} selected={filterDraft.sort === sort} onClick={() => setFilterDraft(value => ({ ...value, sort }))} />)}</Sheet> : null}
    {sheet === "folder" ? <Sheet title="新建文件夹" registerDismiss={registerOverlay} onClose={() => setSheet("")} busy={busy}><input className="st-input" aria-label="文件夹名称" value={folderName} onChange={event => setFolderName(event.target.value)} /><Button disabled={busy || !folderName.trim()} onClick={() => void run(async () => { await managedVault.createFolder(vaultId, folderName.trim(), browse.folder); })}>创建</Button>{error ? <p role="alert">{error}</p> : null}</Sheet> : null}
    {sheet === "actions" && action?.localVaultId === vaultId ? <Sheet title="笔记操作" registerDismiss={registerOverlay} onClose={() => setSheet("")} busy={busy}>{(["pinned", "favorite", "archived"] as const).map((flag, index) => <Option key={flag} label={(action[flag] ? "取消" : "") + ["置顶", "收藏", "归档"][index]} onClick={() => void run(async () => { await managedVault.setFlags(vaultId, action.noteId, action.revision, { [flag]: !action[flag] }); })} />)}<Option label="移动到目录" icon="folder" onClick={() => setSheet("move")} /><Option label={vault?.binding ? "删除并同步到此电脑知识库" : "移到废纸篓"} icon="trash" danger onClick={() => setSheet("delete")} />{error ? <p role="alert">{error}</p> : null}</Sheet> : null}
    {sheet === "move" && action?.localVaultId === vaultId ? <Sheet title="移动到目录" registerDismiss={registerOverlay} onClose={() => setSheet("")} busy={busy}>{["", ...paths].map(folder => <Option key={folder} label={folder || "根目录"} selected={folder === action.folder} onClick={() => void run(async () => { await managedVault.move(vaultId, action.noteId, action.revision, folder); })} />)}{error ? <p role="alert">{error}</p> : null}</Sheet> : null}
    {sheet === "delete" && action?.localVaultId === vaultId ? <Sheet title={vault?.binding ? "删除并同步到此电脑知识库？" : "移到废纸篓？"} registerDismiss={registerOverlay} onClose={() => setSheet("")} busy={busy}><p className="st-sheet-copy">{vault?.binding ? `将删除「${action.title}」并同步到关联电脑知识库「${vault.name}」。离线时保持待同步，不是仅清理手机缓存。手机保留的历史不代表电脑端可以撤销。` : `将「${action.title}」移到此本地库的废纸篓。`}</p><Button disabled={busy} onClick={() => void run(async () => { await managedVault.trash(vaultId, action.noteId, action.revision); })}>{vault?.binding ? "确认删除并同步" : "确认移到废纸篓"}</Button>{error ? <p role="alert">{error}</p> : null}</Sheet> : null}
  </div>;
}
