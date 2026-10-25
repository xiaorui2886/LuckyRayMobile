import { managedWikiProof } from "./managedWikiProof";
import { failureCopy } from "../../services/feedback";
import { pickLocalNoteFile } from "./LocalNoteImportBridge";
import { setManagedImportTarget, invalidateManagedImportTarget } from "../../services/managedImportIntents";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { managedVault, managedNoteRoute, type ManagedVault, type ManagedNote, type ManagedMigrationStatus, type ManagedTransferPreview } from "../../services/managedVault";
import { KnowledgeModeSwitch, type KnowledgeMode } from "./KnowledgeModeSwitch";
import { Button, Empty, Icon, IconButton, Option, SearchField, Sheet } from "./StillImports";
import { FolderBreadcrumbs } from "./knowledgeFolders";
import { useStillNav } from "../StillShell";

let rememberedMode: KnowledgeMode = "notes";
type BrowseState = { query: string; folder: string; sort: "name" | "recent"; range: "all" | "pinned" | "favorite" | "archived"; tag: string; scroll: number };
const retained = new Map<string, BrowseState>();
const blankBrowse = (): BrowseState => ({ query: "", folder: "", sort: "recent", range: "all", tag: "", scroll: 0 });
export type LegacyNotesRenderer = (modeSwitch: ReactNode, management: ReactNode) => ReactNode;

/** Graph never mounts the Notes loader. Session retention is separate from effects. */
export function UnifiedNotesRoot({ legacy, active = true }: { legacy: LegacyNotesRenderer; active?: boolean }) {
  const [mode, setMode] = useState<KnowledgeMode>(rememberedMode);
  const changeMode = (next: KnowledgeMode) => { rememberedMode = next; setMode(next); };
  const modeSwitch = <KnowledgeModeSwitch value={mode} onChange={changeMode} />;
  if (mode === "graph") return <div className="st-view st-knowledge-view" aria-label="图谱"><div className="st-collection-head">{modeSwitch}</div></div>;
  return <NotesAuthority modeSwitch={modeSwitch} legacy={legacy} active={active} />;
}

function NotesAuthority({ modeSwitch, legacy, active }: { modeSwitch: ReactNode; legacy: LegacyNotesRenderer; active: boolean }) {
  const { registerOverlay } = useStillNav();
  const [catalog, setCatalog] = useState<{ items: ManagedVault[]; selectedVaultId: string | null } | null>(null);
  const [status, setStatus] = useState<ManagedMigrationStatus | null>(null);
  const [error, setError] = useState("");
  const [legacyVisible, setLegacyVisible] = useState(false);
  const [migrationOpen, setMigrationOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false), epoch = useRef(0);
  const refresh = async () => {
    const token = ++epoch.current;
    try {
      const [next, progress] = await Promise.all([managedVault.list(), managedVault.migrationStatus()]);
      if (epoch.current !== token) return;
      setCatalog(next); setStatus(progress); setError("");
    } catch (reason) { if (epoch.current === token) setError(failureCopy(reason)); }
  };
  useEffect(() => { const changed = () => void refresh(); void refresh(); window.addEventListener("luckyray:managed-vault-change", changed); return () => { epoch.current++; window.removeEventListener("luckyray:managed-vault-change", changed); }; }, []);
  const migrate = async (commit: boolean) => {
    if (pending.current || (commit && !status?.planId)) return;
    pending.current = true; setBusy(true); setError("");
    const token = epoch.current;
    try {
      const result = commit ? await managedVault.commitMigration(status!.planId!) : await managedVault.prepareMigration();
      if (epoch.current !== token) return;
      setStatus(result);
      if (commit && result.state === "ready") { await refresh(); setLegacyVisible(false); window.dispatchEvent(new Event("luckyray:managed-vault-change")); }
    } catch (reason) { if (epoch.current === token) setError(failureCopy(reason)); }
    finally { pending.current = false; setBusy(false); }
  };
  const ready = status?.state === "ready";
  const management = <>
    {ready ? <Option label="本地笔记库" icon="knowledge" onClick={() => setLegacyVisible(false)} /> : null}
    <Option label={ready ? "查看迁移记录" : "整理为本地笔记库"} icon="folder" onClick={() => setMigrationOpen(true)} />
  </>;
  const migration = migrationOpen ? <Sheet title="整理为本地笔记库" registerDismiss={registerOverlay} onClose={() => { if (!busy) setMigrationOpen(false); }} busy={busy}>
    <p className="st-sheet-copy">将手机中已有的笔记与已保存的电脑笔记复制到分开的本地库，保留来源身份和原始数据。不合并不同库，也不把上传副本视为持续同步。</p>
    <p className="st-sheet-copy">未保存到手机的正文不会补成空笔记；未下载的电脑内容仍可从原有入口访问。</p>
    {status?.state === "prepared" ? <><p className="st-sheet-copy">待整理 {status.noteCount} 篇笔记。请先检查下面的提示，再确认复制。</p>{status.warnings.map((warning, i) => <p key={i} className="st-sheet-copy" role="status">{warning}</p>)}<Button kind="quiet" disabled={busy} onClick={() => void migrate(false)}>重新检查计划</Button><Button disabled={busy} onClick={() => void migrate(true)}>{busy ? "正在复制…" : "确认复制，保留原始数据"}</Button></> : ready ? <><p className="st-sheet-copy">本地库已建立。此状态不代表所有电脑内容已下载，也不代表已同步。</p>{status?.warnings.map((warning, i) => <p key={i} className="st-sheet-copy" role="status">{warning}</p>)}</> : <Button disabled={busy} onClick={() => void migrate(false)}>{busy ? "正在检查…" : "预览整理计划"}</Button>}
    {error ? <p className="st-sheet-copy" role="alert">{error}。原有笔记入口仍然保留，请勿重复提交尚未确认结果的复制。</p> : null}
  </Sheet> : null;
  if (!catalog || !status) return <div className="st-view st-knowledge-view"><div className="st-collection-head">{modeSwitch}</div><div className="st-scroll"><p className="st-folder-status" role="status">{error || "正在读取笔记库…"}</p>{error ? <><Button onClick={() => void refresh()}>重试</Button><Button kind="quiet" onClick={() => setLegacyVisible(true)}>打开原有笔记</Button>{legacyVisible ? legacy(modeSwitch, management) : null}</> : null}</div>{migration}</div>;
  if (!ready || legacyVisible) return <>{legacy(modeSwitch, management)}{migration}</>;
  return <><ManagedNotesCollection active={active} catalog={catalog} modeSwitch={modeSwitch} management={management} onSelect={async id => {
    const token = epoch.current;
    invalidateManagedImportTarget();
    await managedVault.select(id);
    if (epoch.current === token) setCatalog(previous => previous ? { ...previous, selectedVaultId: id } : previous);
    window.dispatchEvent(new Event("luckyray:managed-vault-change"));
  }} onLegacy={() => setLegacyVisible(true)} />{migration}</>;
}

function ManagedNotesCollection({ catalog, modeSwitch, management, onSelect, onLegacy, active }: {
  active: boolean;
  catalog: { items: ManagedVault[]; selectedVaultId: string | null }; modeSwitch: ReactNode; management: ReactNode;
  onSelect: (id: string) => Promise<void>; onLegacy: () => void;
}) {
  const { open, registerOverlay } = useStillNav();
  const vaultId = catalog.selectedVaultId || "";
  const vault = catalog.items.find(item => item.localVaultId === vaultId);
  const [view, setViewState] = useState(() => ({ vaultId, browse: retained.get(vaultId) || blankBrowse() }));
  // Gate synchronously: a new vault must never render the previous vault's rows or query.
  const browse = view.vaultId === vaultId ? view.browse : retained.get(vaultId) || blankBrowse();
  useEffect(() => { if (active) setManagedImportTarget(vaultId, browse.folder); else invalidateManagedImportTarget(); return invalidateManagedImportTarget; }, [vaultId, browse.folder, active]);
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
  const readOnly = Boolean(vault?.transferState);
  const ready = vault?.migrationState === "ready" && !readOnly;
  return <div className="st-view st-knowledge-view">
    <div className="st-collection-head">{modeSwitch}<IconButton icon="folder" label="目录与库" onClick={() => setSheet("directory")} /><IconButton icon="file" label="导入笔记文件" disabled={!ready || busy} onClick={() => void pickLocalNoteFile()} /><IconButton icon="edit" label="新建笔记" disabled={!ready || busy} onClick={() => void create()} /></div>
    <div className="st-collection-top"><SearchField value={browse.query} onChange={query => setBrowse({ query, scroll: 0 })} placeholder="搜索笔记" /></div>
    <div className="st-scroll" ref={element => { if (element && Math.abs(element.scrollTop - (retained.get(vaultId)?.scroll || 0)) > 1) element.scrollTop = retained.get(vaultId)?.scroll || 0; }} onScroll={event => { retained.set(vaultId, { ...browse, scroll: event.currentTarget.scrollTop }); }}>
      <div className="st-compact-toolbar st-knowledge-toolbar"><span>{vault?.name || "请选择笔记库"}</span><IconButton icon="filter" label="筛选与排序" onClick={() => { setFilterDraft({ ...browse }); setSheet("filter"); }} /></div>
      <FolderBreadcrumbs current={browse.folder} onSelect={folder => setBrowse({ folder, query: "", scroll: 0 })} />
      {!browse.query.trim() ? children.map(path => <button key={path} className="st-folder-row" onClick={() => setBrowse({ folder: path, scroll: 0 })}><span className="st-folder-symbol"><Icon name="folder" size={20} /></span><span className="st-folder-name">{path.split("/").pop()}</span><Icon name="right" size={14} /></button>) : null}
      {error ? <p role="alert" className="st-folder-status">{error}<Button kind="quiet" onClick={() => setRevision(value => value + 1)}>重试</Button></p> : null}
      {items.map(note => <div className="st-local-note-entry" key={note.noteId}><button className="st-note-row" style={{ flex: 1, minWidth: 0 }} onClick={() => open("note", managedNoteRoute(vaultId, note.noteId), { edit: !readOnly && note.bodyState === "ready", noteSearch: browse.query.trim() ? { query: browse.query.trim() } : undefined })}><span className="st-knowledge-note-symbol" aria-hidden="true"><Icon name="file" size={20} /></span><strong>{note.title || "未命名笔记"}</strong><p>{note.bodyState === "ready" ? (note.content || "").slice(0, 160) : statusText(note)}</p><small><span className="st-note-meta">{statusText(note)}{note.tags.length ? " · " + note.tags.join(" / ") : ""}</span><span className="st-note-flags">{note.pinned ? <span role="img" aria-label="已置顶"><Icon name="pin" size={12} className="st-flag-pin" /></span> : null}{note.favorite ? <span role="img" aria-label="已收藏"><Icon name="heart" size={12} className="st-flag-fav is-on" /></span> : null}</span></small></button><IconButton icon="more" disabled={readOnly} label={`笔记操作：${note.title}`} onClick={() => { setAction(note); setSheet("actions"); }} /></div>)}
      {loading ? <p className="st-folder-status" role="status">正在读取笔记…</p> : !items.length && !error ? <Empty title={ready ? "没有找到笔记" : "请选择可用笔记库"} body={ready ? "新建一篇笔记，或者换一个搜索词。" : "从目录与库中选择，不会自动合并不同的库。"} /> : null}
      {result?.key === key && result.hasMore ? <Button kind="quiet" disabled={loading} onClick={() => void load(result.page + 1)}>加载更多</Button> : null}
    </div>
    {sheet === "directory" ? <Sheet headingSlot={<div className="st-source" role="group" aria-label="目录与库"><span className={"st-source-glide " + (tab === "libraries" ? "is-desktop" : "")} aria-hidden="true" />{(["directory", "libraries"] as const).map(value => <button key={value} aria-pressed={tab === value} onClick={() => setTab(value)}><span className="st-source-label">{value === "directory" ? "目录" : "库"}</span></button>)}</div>} title="目录与库" registerDismiss={registerOverlay} onClose={() => setSheet("")} busy={busy}>

      {tab === "directory" ? <><Option label="全部笔记" icon="knowledge" selected={!browse.folder} onClick={() => { setBrowse({ folder: "", query: "", scroll: 0 }); setSheet(""); }} />{paths.map(path => <Option key={path} label={path} icon="folder" selected={browse.folder === path} onClick={() => { setBrowse({ folder: path, query: "", scroll: 0 }); setSheet(""); }} />)}<fieldset disabled={readOnly} style={{border:0,padding:0,margin:0}}><Option label="新建文件夹" icon="plus" onClick={() => { if (!readOnly) { setFolderName(""); setSheet("folder"); } }} /></fieldset></> : <>{catalog.items.filter(item => item.transferState !== "completed").map(item => <Option key={item.localVaultId} label={item.name} detail={item.migrationState !== "ready" ? "尚未整理，保留原有入口" : item.binding ? "本地文件 · 保留来源关联" : "本地文件"} selected={item.localVaultId === vaultId} onClick={() => { if (item.migrationState === "ready") void run(() => onSelect(item.localVaultId)); }} />)}{!vault?.binding ? <Option label="加入同步库" icon="folder" detail="将此本地库的笔记加入一个已关联的库，原始内容保留。" onClick={() => { setTransferTarget(""); setTransferPreview(null); setSheet("transfer"); }} /> : null}<Option label="原有笔记与电脑知识库" icon="folder" detail="访问未整理或尚未下载的内容" onClick={onLegacy} />{management}</>}
      {error ? <p role="alert" className="st-sheet-copy">{error}</p> : null}
    </Sheet> : null}
    {sheet === "transfer" && !vault?.binding ? <Sheet title="加入同步库" registerDismiss={registerOverlay} onClose={() => setSheet("")} busy={busy}>
      {vault?.transferState === "pending" ? <p className="st-sheet-copy">上次加入尚未完成，请选择原目标库重新检查并继续；完成前原库保持只读。</p> : null}
      <p className="st-sheet-copy">选择一个已关联的笔记库。复制并校验完成后，后续修改在目标库中继续同步；此库的原始内容保留，不按标题合并或覆盖。</p>
      <select className="st-input" aria-label="加入的同步库" value={transferTarget} disabled={busy} onChange={event => { setTransferTarget(event.target.value); setTransferPreview(null); }}>
        <option value="">请选择同步库</option>{catalog.items.filter(item => item.binding && item.migrationState === "ready" && item.localVaultId !== vaultId && (!vault?.transferTargetVaultId || item.localVaultId === vault.transferTargetVaultId)).map(item => <option key={item.localVaultId} value={item.localVaultId}>{item.name}</option>)}
      </select>
      {!catalog.items.some(item => item.binding && item.migrationState === "ready") ? <p className="st-sheet-copy">还没有已关联的本地库，请先保存并整理一个电脑知识库。</p> : null}
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
