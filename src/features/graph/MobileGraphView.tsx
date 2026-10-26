import { managedVault } from "../../services/managedVault";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { localAssetRoute } from '../../still/kit/materialOrganization';
import { useStillNav } from '../../still/StillShell';
import { Sheet } from '../../still/kit/Sheet';
import { listMobileGraphSources, loadMobileGraphSnapshot, subscribeMobileGraphChanges, createMobileGraphNote, linkMobileGraphNodes, unlinkMobileGraphNodes, setMobileGraphNoteTags, type MobileGraphSnapshot, type MobileGraphSource } from '../../services/mobileGraph';
import { mobileGraphRelationDisabledReason } from '../../services/mobileGraphMutations';
import { api, type ConnState } from '../../services/client';
import { noteSourceSelection, noteSourceKey, type NoteSourceSelection } from '../../services/noteSourceSelection';
import { desktopLibraries } from '../../services/desktopLibraries';
import { toast } from '../../services/toast';
import { copyTextExact } from '../../services/clipboardText';
import { exportGraphPng } from '../../services/mobileGraphExport';
import { MobileGraphSettings, defaultMobileGraphSettings } from './MobileGraphSettings';
import { MobileGraphCanvas, type MobileGraphCanvasHandle } from './MobileGraphCanvas';
import { buildGraphSearchResults, graphSearchScopeKeys, filteredGraph, normalizeGraphView, type GraphSearchResult } from './core/graphSemantics';
import { newMobileGraphTab, readMobileGraphSession, saveMobileGraphSession, type MobileGraphSession, type MobileGraphTab } from './mobileGraphSessions';
import type { GraphSeed } from './core/graphTypes';
import { mobileGraphNodeQuestion } from './mobileGraphPrompt';
import { MobileGraphIcon } from './MobileGraphIcon';
import './mobileGraph.css';

const EMPTY_SEED: GraphSeed = { nodes: [], edges: [], source: 'empty' };
const errorText = (e: unknown) => { const text = e instanceof Error ? e.message : typeof e === 'string' ? e : ''; return /[\u3400-\u9fff]/.test(text) ? text.slice(0, 200) : '暂时无法读取或更新本地图谱，请重试。'; };
type EditAction = 'create' | 'link' | 'unlink' | 'tags' | null;

export default function MobileGraphView({ modeSwitch, active = true, conn = null, onManageVaults }: { modeSwitch: ReactNode; active?: boolean; conn?: ConnState | null; onManageVaults?: () => void }) {
  const { open, registerOverlay, mode, reduced } = useStillNav();
  const sourceChoice = useSyncExternalStore(noteSourceSelection.subscribe, noteSourceSelection.snapshot);
  const ownerId = conn?.paired ? conn.identity?.instanceId || '' : '';
  const desktopCatalog = useSyncExternalStore(desktopLibraries.subscribe, () => desktopLibraries.snapshot(ownerId));
  const selectionWrites = useRef(Promise.resolve());
  const [sources, setSources] = useState<MobileGraphSource[]>([]), [storedSourceId, setSourceId] = useState('');
  const sourceId = sourceChoice.selection ? noteSourceKey(sourceChoice.selection) : storedSourceId;
  const [snapshot, setSnapshot] = useState<MobileGraphSnapshot | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [session, setSession] = useState<MobileGraphSession>(() => readMobileGraphSession(sourceId));
  const [settingsOpen, setSettingsOpen] = useState(false), [listOpen, setListOpen] = useState(false), [nodeQuery, setNodeQuery] = useState('');
  const [persistenceWarning, setPersistenceWarning] = useState(false);
  const selectionElement = useRef<HTMLDivElement>(null), [selectionHeight, setSelectionHeight] = useState(0);
  const [copyStatus, setCopyStatus] = useState('');
  const [moreOpen, setMoreOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false), [exportStatus, setExportStatus] = useState('');
  const [editAction, setEditAction] = useState<EditAction>(null), [editText, setEditText] = useState(''), [targetKey, setTargetKey] = useState(''), [targetQuery, setTargetQuery] = useState(''), [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false), [playProgress, setPlayProgress] = useState(0), [seek, setSeek] = useState<number | undefined>();
  const [refreshKey, setRefreshKey] = useState(0), [progress, setProgress] = useState('');
  const rootElement = useRef<HTMLDivElement>(null);
  const [covered, setCovered] = useState(false);
  const canvas = useRef<MobileGraphCanvasHandle>(null), sourceEpoch = useRef(0), currentSource = useRef(sourceId);
  currentSource.current = sourceId;
  const sessionLedger = useRef(new Map<string, MobileGraphSession>());
  const retainedSession = useRef({ sourceId, session });
  if (retainedSession.current.sourceId === sourceId) { retainedSession.current.session = session; sessionLedger.current.set(sourceId, session); }
  useEffect(() => () => { const saved = retainedSession.current; if (saved.sourceId) saveMobileGraphSession(saved.sourceId, saved.session); }, []);
  const source = sources.find(s => s.id === sourceId), tab = session.tabs.find(t => t.id === session.activeId) || session.tabs[0];
  useEffect(() => setCopyStatus(''), [tab.selectedKey]);
  const bindingIdentity = JSON.stringify(source?.binding ?? null);
  const desktopGrant = source?.kind === 'desktop' && desktopCatalog.catalog?.scopeSelectionVersion === 1
    ? desktopCatalog.catalog.knowledge.some(row => row.vaultId === source.desktop?.vaultId && row.available && row.readGranted) : true;
  const sourceUsable = !!source && (source.kind !== 'desktop' || (ownerId === source.desktop?.instanceId && source.availability === 'ready' && desktopGrant));
  const settings = tab.settings, seed = sourceUsable && snapshot?.source.id === sourceId && JSON.stringify(snapshot.source.binding ?? null) === bindingIdentity ? snapshot.seed : EMPTY_SEED;
  const patchTab = useCallback((changes: Partial<MobileGraphTab>) => setSession(s => ({ ...s, tabs: s.tabs.map(t => t.id === s.activeId ? { ...t, ...changes } : t) })), []);
  const patchCanvasTab = useCallback((owner: string, tabId: string, changes: Partial<MobileGraphTab>, persist = true) => {
    const stored = sessionLedger.current.get(owner);
    if (!stored || !stored.tabs.some(t => t.id === tabId)) return;
    const next = { ...stored, tabs: stored.tabs.map(t => t.id === tabId ? { ...t, ...changes } : t) };
    sessionLedger.current.set(owner, next);
    // Final callbacks belong to the departing source/tab, never its replacement.
    if (retainedSession.current.sourceId === owner) retainedSession.current.session = next;
    if (persist) saveMobileGraphSession(owner, next);
    if (currentSource.current === owner) setSession(s => s.tabs.some(t => t.id === tabId) ? { ...s, tabs: s.tabs.map(t => t.id === tabId ? { ...t, ...changes } : t) } : s);
  }, []);
  useEffect(() => {
    const owner = rootElement.current?.closest('.st-root-stage');
    if (!owner || typeof MutationObserver === 'undefined') return;
    const update = () => setCovered(owner.getAttribute('aria-hidden') === 'true');
    const observer = new MutationObserver(update); observer.observe(owner, { attributes: true, attributeFilter: ['aria-hidden'] }); update();
    return () => observer.disconnect();
  }, []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const refresh = useCallback(() => setRefreshKey(n => n + 1), []);

  useEffect(() => {
    let alive = true, request = 0;
    const catalog = () => { const token = ++request; return listMobileGraphSources({ conn }).then(result => {
      if (!alive || token !== request) return; setSources(result.sources);
      const requested = noteSourceSelection.snapshot().selection;
      // Never silently show the phone graph while the user has selected a computer library.
      setSourceId(requested ? noteSourceKey(requested) : result.selectedSourceId);
      if (requested && !result.sources.some(s => s.id === noteSourceKey(requested))) setLoading(false);
      if (!result.sources.length) setLoading(false);
    }).catch(e => { if (alive && token === request) { setError(errorText(e)); setLoading(false); } }); };
    void catalog(); window.addEventListener('luckyray:managed-vault-change', catalog);
    return () => { alive = false; window.removeEventListener('luckyray:managed-vault-change', catalog); };
  }, [refreshKey, ownerId, conn?.paired, desktopCatalog.knowledgeEpoch, sourceChoice.version]);
  useEffect(() => {
    const previous = retainedSession.current;
    const departingSaved = !previous.sourceId || previous.sourceId === sourceId || saveMobileGraphSession(previous.sourceId, previous.session);
    const next = sessionLedger.current.get(sourceId) || readMobileGraphSession(sourceId); retainedSession.current = { sourceId, session: next }; sessionLedger.current.set(sourceId, next);
    setSession(next); setPersistenceWarning(!departingSaved); setSnapshot(null); setPlaying(false); setSettingsOpen(false); setListOpen(false); setEditAction(null); setExportOpen(false); setMoreOpen(false); setExportStatus(''); setError('');
  }, [sourceId]);
  useEffect(() => {
    if (!source || !active) return;
    const controller = new AbortController(), token = ++sourceEpoch.current;
    setLoading(true); setError(''); setProgress('');
    loadMobileGraphSnapshot(source, { signal: controller.signal, onProgress: (done, total) => { if (token === sourceEpoch.current) setProgress(`${done} / ${total}`); } }).then(next => {
      if (controller.signal.aborted || token !== sourceEpoch.current || next.source.id !== currentSource.current) return;
      setSnapshot(next); setLoading(false); setProgress('');
      setSession(s => ({ ...s, tabs: s.tabs.map(t => t.selectedKey && !next.seed.nodes.some(n => n.key === t.selectedKey) ? { ...t, selectedKey: null } : t) }));
    }).catch(e => { if (!controller.signal.aborted && token === sourceEpoch.current) { setLoading(false); setError(errorText(e)); } });
    return () => { controller.abort(); sourceEpoch.current++; };
  }, [sourceId, source?.kind, source?.readOnly, bindingIdentity, source?.availability, sourceUsable, ownerId, active, refreshKey]);
  useEffect(() => source && active ? subscribeMobileGraphChanges(source, refresh) : undefined, [sourceId, source?.kind, bindingIdentity, active, refresh]);
  useEffect(() => { const flush = () => { const current = retainedSession.current; if (current.sourceId) saveMobileGraphSession(current.sourceId, current.session); }; const hidden = () => { if (document.hidden) flush(); }; window.addEventListener('pagehide', flush); document.addEventListener('visibilitychange', hidden); return () => { flush(); window.removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', hidden); }; }, []);
  useEffect(() => { if (!sourceId) return; const timer = setTimeout(() => { if (!saveMobileGraphSession(sourceId, session)) setPersistenceWarning(true); }, 200); return () => clearTimeout(timer); }, [sourceId, session]);
  useEffect(() => { if (!active || covered) setPlaying(false); const stop = () => { if (document.hidden) setPlaying(false); else if (active) refresh(); }; document.addEventListener('visibilitychange', stop); return () => document.removeEventListener('visibilitychange', stop); }, [active, covered]);
  useEffect(() => settings.nearbyFilter && !settingsOpen && !listOpen && !editAction ? registerOverlay(() => patchTab({ settings: { ...settings, nearbyFilter: false } })) : undefined, [settings, settingsOpen, listOpen, editAction, registerOverlay, patchTab]);

  const searchResults = useMemo(() => buildGraphSearchResults(seed.nodes, settings.query), [seed, settings.query]);
  const folders = useMemo(() => Array.from(new Set(seed.nodes.flatMap(n => { const parts = (n.relativePath || '').split('/'); parts.pop(); return parts.map((_, i) => parts.slice(0, i + 1).join('/')); }))).sort(), [seed]);
  const scopeKeys = useMemo(() => {
    let keys: Set<string> | null = null;
    if (tab.scopeKey) {
      const match = tab.scopeKey.startsWith('folder:') ? ({ kind: 'folder', key: tab.scopeKey, label: '', path: tab.scopeKey.slice(7), nodeKeys: seed.nodes.filter(n => n.relativePath?.startsWith(tab.scopeKey!.slice(7) + '/')).map(n => n.key) } as GraphSearchResult) : seed.nodes.find(n => n.key === tab.scopeKey);
      if (match) keys = graphSearchScopeKeys('kind' in match ? match : { kind: 'document', key: match.key, label: match.label, path: match.relativePath || '', node: match }, seed);
    }
    if (settings.folder || settings.createdOnly) {
      const admitted = new Set(seed.nodes.filter(n => (!settings.folder || n.relativePath?.startsWith(settings.folder + '/')) && (!settings.createdOnly || n.status !== 'missing')).map(n => n.key));
      keys = keys ? new Set([...keys].filter(k => admitted.has(k))) : admitted;
    }
    return keys;
  }, [seed, tab.scopeKey, settings.folder, settings.createdOnly]);
  const changeSource = (id: string) => {
    const next = sources.find(item => item.id === id); if (!next) return;
    const selection: NoteSourceSelection = next.kind === 'managed' ? { kind: 'managed', localVaultId: next.id } : next.kind === 'desktop' && next.desktop ? { kind: 'desktop', ...next.desktop } : { kind: 'legacy' };
    noteSourceSelection.select(selection); setSourceId(id);
    if (selection.kind === 'managed') {
      const version = noteSourceSelection.snapshot().version;
      const write = selectionWrites.current.then(async () => {
        if (noteSourceSelection.snapshot().version !== version) return;
        await managedVault.select(selection.localVaultId);
        if (noteSourceSelection.snapshot().version !== version) {
          const latest = noteSourceSelection.snapshot().selection;
          if (latest?.kind === 'managed') await managedVault.select(latest.localVaultId);
        }
      });
      selectionWrites.current = write.catch(() => { if (noteSourceSelection.snapshot().version === version) setError('知识库选择尚未保存，请重新选择。当前图谱仍属于所选库。'); });
    }
  };
  const selected = seed.nodes.find(n => n.key === tab.selectedKey);
  const scene = useMemo(() => filteredGraph(seed, normalizeGraphView(settings), { scopeKeys, selectedId: selected?.id }), [seed, settings, scopeKeys, selected?.id]);
  const selectable = scene.renderedNodes.filter(n => n.label.toLocaleLowerCase().includes(nodeQuery.toLocaleLowerCase()));
  const note = selected ? snapshot?.notesByKey.get(selected.key) : null;
  const openNode = useCallback((key: string) => {
    if (!snapshot || snapshot.source.id !== currentSource.current) return;
    const route = snapshot.notesByKey.get(key)?.openRoute || snapshot.resourcesByKey.get(key)?.openRoute;
    if (route) { saveMobileGraphSession(sourceId, session); setPlaying(false); open('note', route); }
  }, [snapshot, sourceId, session, open]);
  const selectSearch = (result: GraphSearchResult) => { patchTab({ scopeKey: result.key, selectedKey: result.kind === 'document' ? result.node.key : null, settings: { ...settings, query: result.label } }); setSettingsOpen(false); };
  const beginEdit = (action: EditAction) => { setEditText(action === 'tags' ? (note?.tags || []).join(', ') : selected?.status === 'missing' && action === 'create' ? selected.missingTarget?.title || selected.label : ''); setTargetKey(''); setTargetQuery(''); setEditAction(action); setError(''); };
  const mutate = async () => {
    if (!snapshot || source?.readOnly || busy) return;
    if ((editAction === 'link' || editAction === 'unlink') && !relationTargets.some(n => n.key === targetKey)) { setError('目标节点已变化，请重新选择。'); setTargetKey(''); return; }
    const sourceAtStart = sourceId; setBusy(true); setError('');
    try {
      if (editAction === 'create') await createMobileGraphNote(snapshot, editText.trim(), { folder: selected?.missingTarget?.parentPath || settings.folder });
      else if (selected && editAction === 'link') await linkMobileGraphNodes(snapshot, selected.key, targetKey);
      else if (selected && editAction === 'unlink') await unlinkMobileGraphNodes(snapshot, selected.key, targetKey);
      else if (selected && editAction === 'tags') await setMobileGraphNoteTags(snapshot, selected.key, editText.split(/[,，\n]/).map(t => t.trim().replace(/^#/, '')).filter(Boolean));
      if (currentSource.current === sourceAtStart) { setEditAction(null); refresh(); }
    } catch (e) { if (currentSource.current === sourceAtStart) setError(errorText(e)); }
    finally { setBusy(false); }
  };
  const addView = () => { if (session.tabs.length >= 12) return; const next = newMobileGraphTab(session.tabs.length + 1); setSession(s => ({ tabs: [...s.tabs, next], activeId: next.id })); setPlaying(false); };
  const closeView = (id: string) => setSession(s => { const tabs = s.tabs.filter(t => t.id !== id); return tabs.length ? { tabs, activeId: s.activeId === id ? tabs[0].id : s.activeId } : s; });
  const startPlay = () => { setSeek(undefined); setPlayProgress(0); setPlaying(true); };
  const playbackProgress = useCallback((n: number) => { setPlayProgress(n); if (n >= 1) setPlaying(false); }, []);
  const openLocalResource = async () => {
    if (!selected || !snapshot) return;
    const resource = snapshot.resourcesByKey.get(selected.key), sourceAtStart = sourceId;
    const ref = resource?.references?.[0] || resource;
    const localAsset = /^luckyray-local-asset:([A-Za-z0-9_-]{1,160})$/.exec(resource?.target || '');
    if (resource?.available && localAsset && selected.entityId === localAsset[1] && !snapshot.signal?.aborted) { saveMobileGraphSession(sourceId, session); setPlaying(false); open('asset', localAssetRoute(localAsset[1])); return; }
    if (source?.kind !== 'managed') { setCopyStatus('此附件可从来源笔记查看。'); return; }
    const owner = ref && snapshot.notesByKey.get(ref.noteKey);
    if (!resource?.available || !ref || !owner || !owner.revision || snapshot.signal?.aborted) { setCopyStatus('附件尚未完整保存在本机，可打开来源笔记查看。'); return; }
    try { await api.managedVaultResourceOpen(sourceId, ref.noteId, ref.target, owner.revision); }
    catch { if (currentSource.current === sourceAtStart) setCopyStatus('未能打开本机附件，请检查本地文件或可用的查看应用。未联网下载。'); }
  };
  const askAboutNode = async () => {
    if (!selected) return;
    const sourceAtStart = sourceId;
    const result = await copyTextExact(mobileGraphNodeQuestion(seed, selected));
    if (sourceAtStart !== currentSource.current) return;
    if (result !== 'copied') { setCopyStatus('提问复制失败，未打开 LSH。请重试或手动复制节点名称。'); return; }
    saveMobileGraphSession(sourceId, session); setPlaying(false); toast.info('提问已复制，请在 LSH 中粘贴并确认发送。'); open('ai');
  };
  const exportImage = async (action: 'share' | 'save') => {
    if (!canvas.current || busy) return; setBusy(true); setExportStatus('');
    try { const result = await exportGraphPng(await canvas.current.capture(), action); setExportStatus(result.status === 'created' || result.status === 'already_exists' ? '图谱图片已保存到系统相册 LuckyRay。' : '已打开系统分享，请在系统面板中选择去向。'); }
    catch { setExportStatus('图片未能导出，请确认手机存储空间后重试。'); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    const element = selectionElement.current; if (!element) { setSelectionHeight(0); return; }
    const measure = () => setSelectionHeight(element.getBoundingClientRect().height);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure); observer?.observe(element); measure();
    window.addEventListener('resize', measure); return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [selected?.key, settingsOpen, copyStatus]);
  const relationTargets = seed.nodes.filter(n => snapshot && selected && n.key !== selected.key && !mobileGraphRelationDisabledReason(snapshot, selected.key, n.key) && (editAction !== 'unlink' || seed.edges.some(([a,b]) => (a === selected.id && b === n.id) || (b === selected.id && a === n.id))));

  const targetSearch = targetQuery.trim().toLocaleLowerCase();
  const matchingRelationTargets = relationTargets.filter(n => !targetSearch || n.label.toLocaleLowerCase().includes(targetSearch) || (n.relativePath || '').toLocaleLowerCase().includes(targetSearch));

  return <div ref={rootElement} className="st-view st-knowledge-view mg-view" aria-label="本地图谱">
    <div className="st-collection-head">{modeSwitch}</div>
    <div className="mg-source-row"><select aria-label="图谱知识库" value={sourceId} onChange={e => changeSource(e.target.value)}>{!source && <option value={sourceId}>{'选择知识库'}</option>}{sources.map(s => <option key={s.id} value={s.id}>{s.kind === 'legacy' ? '旧数据（恢复）' : s.name}</option>)}</select><button type="button" aria-label="刷新图谱" onClick={refresh}><MobileGraphIcon name="refresh" /></button></div>
    {session.tabs.length > 1 && <div className="mg-view-tabs" aria-label="图谱视图">{session.tabs.map(t => <div key={t.id} aria-current={t.id === session.activeId}><button type="button" onClick={() => { setSession(s => ({ ...s, activeId: t.id })); setPlaying(false); }}>{t.name}</button>{session.tabs.length > 1 && <button type="button" className="mg-tab-close" aria-label={`关闭${t.name}`} onClick={() => closeView(t.id)}>×</button>}</div>)}<button type="button" aria-label="新建图谱视图" disabled={session.tabs.length >= 12} onClick={addView}>＋</button></div>}
    {persistenceWarning && <div className="mg-notice" role="status">图谱视图暂未保存，重新打开可能恢复默认设置。笔记不受影响。</div>}
    {error && <div className="mg-notice" role="alert">{error}<button type="button" onClick={refresh}>重试</button></div>}
    {sourceUsable && snapshot?.source.id === sourceId && snapshot.warnings.length ? <div className="mg-notice" role="status">{snapshot.warnings[0]}</div> : null}
    <div className={`mg-stage${settingsOpen ? ' is-settings-open' : ''}`} data-no-swipe="true">
      <MobileGraphCanvas key={`${sourceId}:${tab.id}`} ref={canvas} seed={seed} settings={settings} selectedKey={tab.selectedKey} scopeKeys={scopeKeys} camera={tab.camera} positions={tab.positions} onPositionsChange={positions => patchCanvasTab(sourceId, tab.id, { positions })} paused={!active || covered} reducedMotion={reduced} onSelect={key => patchCanvasTab(sourceId, tab.id, { selectedKey: key })} onOpen={openNode} onCameraChange={(camera, settled = true) => patchCanvasTab(sourceId, tab.id, { camera }, settled)} playback={{ playing, progress: seek }} onPlaybackProgress={playbackProgress} />
      <div className="mg-tools"><button type="button" aria-label="打开图谱设置" aria-pressed={settingsOpen} onClick={() => setSettingsOpen(s => !s)}><MobileGraphIcon name="settings" /></button><button type="button" aria-label={playing ? '停止图谱动画' : '播放图谱动画'} onClick={playing ? () => setPlaying(false) : startPlay}><MobileGraphIcon name={playing ? 'stop' : 'play'} /></button><button type="button" aria-label="适应画布" onClick={() => canvas.current?.fit()}><MobileGraphIcon name="fit" /></button><button type="button" aria-label="更多图谱操作" onClick={() => setMoreOpen(true)}>···</button></div>
      {!source && !loading ? <div className="mg-status"><strong>请选择知识库</strong><span>笔记和图谱使用同一个库。先添加或选择知识库，再查看关联。</span>{onManageVaults && <button type="button" onClick={onManageVaults}>选择或添加知识库</button>}<button type="button" onClick={refresh}>重新检查</button></div> : error && !seed.nodes.length ? <div className="mg-status"><strong>暂时无法显示此图谱</strong><span>没有切换到其他库，你的笔记未被修改。</span></div> : loading && !seed.nodes.length ? <div className="mg-status" role="status">正在读取本地图谱{progress ? ` · ${progress}` : '…'}</div> : !seed.nodes.length ? <div className="mg-status"><strong>图谱从笔记开始</strong><span>本地笔记中的双链、标签和附件会在这里连接。</span></div> : !scene.renderedNodes.length ? <div className="mg-status"><strong>没有匹配的节点</strong><button type="button" onClick={() => patchTab({ settings: defaultMobileGraphSettings(), scopeKey: null })}>清除筛选</button></div> : null}
      {tab.scopeKey && !settingsOpen && <button type="button" className="mg-scope-chip" onClick={() => patchTab({ scopeKey: null, settings: { ...settings, query: '' } })}>清除搜索范围 ×</button>}
      {selected && !settingsOpen && <div className="mg-selection" ref={selectionElement}><div className="mg-selection-head"><strong>{selected.label}</strong><button type="button" aria-label="取消节点选择" onClick={() => patchTab({ selectedKey: null })}>×</button></div><div className="mg-selection-actions"><button type="button" onClick={() => { void copyTextExact(selected.label).then(result => setCopyStatus(result === 'copied' ? '节点名称已复制。' : '复制失败，可长按上方名称手动复制。')); }}>复制名称</button><button type="button" onClick={() => void askAboutNode()}>复制提问并打开 LSH</button>{!note && snapshot?.resourcesByKey.get(selected.key)?.available && (source?.kind === 'managed' || /^luckyray-local-asset:[A-Za-z0-9_-]{1,160}$/.test(snapshot.resourcesByKey.get(selected.key)?.target || '')) && <button type="button" onClick={() => void openLocalResource()}>打开本机附件</button>}{(note || snapshot?.resourcesByKey.has(selected.key)) && <button type="button" onClick={() => openNode(selected.key)}>{note ? '打开笔记' : '打开来源笔记'}</button>}<button type="button" onClick={() => patchTab({ settings: { ...settings, nearbyFilter: !settings.nearbyFilter } })}>{settings.nearbyFilter ? '返回全局' : '局部图谱'}</button>{!source?.readOnly && (note ? <><button type="button" onClick={() => beginEdit('link')}>添加关联</button><button type="button" onClick={() => beginEdit('unlink')}>移除关联</button><button type="button" onClick={() => beginEdit('tags')}>编辑标签</button></> : selected.status === 'missing' ? <button type="button" onClick={() => beginEdit('create')}>创建笔记</button> : null)}</div>{copyStatus && <p role="status" className="mg-hint">{copyStatus}</p>}</div>}
      {playing && <div className="mg-progress" style={{ bottom: selected ? selectionHeight + 24 : 12 }}><button type="button" aria-label="停止图谱动画" onClick={() => setPlaying(false)}>Ⅱ</button><input aria-label="图谱播放进度" type="range" min={0} max={1} step={.01} value={playProgress} onChange={e => { const n = Number(e.target.value); setSeek(n); setPlayProgress(n); }} /><span>{Math.round(playProgress * 100)}%</span></div>}
      {settingsOpen && <MobileGraphSettings value={settings} onChange={value => patchTab({ settings: value, ...(value.query !== settings.query ? { scopeKey: null } : {}) })} onClose={closeSettings} onReset={() => patchTab({ settings: defaultMobileGraphSettings(), scopeKey: null })} folders={folders} playing={playing} onPlay={startPlay} onStop={() => setPlaying(false)} focusAvailable={!!selected} registerOverlay={registerOverlay} searchResults={settings.query && <div className="mg-search-results">{searchResults.length ? searchResults.map(result => <button type="button" key={result.key} onClick={() => selectSearch(result)}>{result.kind === 'folder' ? '▱ ' : ''}{result.label}<small>{result.path}</small></button>) : <p className="mg-hint">没有匹配的文件或文件夹。</p>}</div>} />}
    </div>
    {moreOpen && <Sheet title="图谱操作" onClose={() => setMoreOpen(false)} registerDismiss={registerOverlay}><div className="mg-action-list"><button type="button" aria-label="查找图谱节点" onClick={() => { setMoreOpen(false); setListOpen(true); }}>查找节点</button><button type="button" aria-label="放大图谱" onClick={() => { canvas.current?.zoomBy(1.4); setMoreOpen(false); }}>放大</button><button type="button" aria-label="缩小图谱" onClick={() => { canvas.current?.zoomBy(1 / 1.4); setMoreOpen(false); }}>缩小</button><button type="button" aria-label="重置图谱布局" onClick={() => { canvas.current?.reset(); setMoreOpen(false); }}>重新排列图谱</button><button type="button" aria-label="新建图谱视图" disabled={session.tabs.length >= 12} onClick={() => { addView(); setMoreOpen(false); }}>新建视图</button>{source && !source.readOnly && <button type="button" aria-label="新建图谱笔记" onClick={() => { setMoreOpen(false); beginEdit('create'); }}>新建笔记</button>}<button type="button" aria-label="导出图谱图片" disabled={!seed.nodes.length} onClick={() => { setMoreOpen(false); setExportOpen(true); setExportStatus(''); }}>分享或保存图谱图片</button>{source?.readOnly && <p className="mg-hint">此来源目前为只读图谱，可以浏览和打开已有笔记。</p>}</div></Sheet>}
    {exportOpen && <Sheet title="图谱图片" onClose={() => { if (!busy) setExportOpen(false); }} registerDismiss={registerOverlay} busy={busy}><div className="mg-form"><p className="mg-hint">导出当前画布中的节点与连线，不包含设置面板。</p><button type="button" className="mg-primary" disabled={busy} onClick={() => void exportImage('share')}>分享 PNG 图片</button><button type="button" className="mg-text-button" disabled={busy} onClick={() => void exportImage('save')}>保存到系统相册</button>{exportStatus && <p role="status" className="mg-hint">{exportStatus}</p>}</div></Sheet>}
    {listOpen && <Sheet title="图谱节点" onClose={() => setListOpen(false)} registerDismiss={registerOverlay}><label className="mg-search"><input type="search" aria-label="查找节点名称" placeholder="查找节点…" value={nodeQuery} onChange={e => setNodeQuery(e.target.value)} /></label><div className="mg-node-list">{selectable.slice(0, 100).map(n => <button type="button" key={n.key} onClick={() => { patchTab({ selectedKey: n.key }); setListOpen(false); }}>{n.label}<small>{n.relativePath || ({ note: '笔记', tag: '标签', material: '附件', web: '网页' }[n.type])}</small></button>)}{selectable.length > 100 && <p className="mg-hint">还有 {selectable.length - 100} 个节点，请输入名称缩小范围。</p>}{!selectable.length && <p className="mg-hint">没有匹配的节点。</p>}</div></Sheet>}
    {editAction && <Sheet title={{ create: '新建笔记', link: '添加关联', unlink: '移除关联', tags: '编辑标签' }[editAction]} onClose={() => { if (!busy) setEditAction(null); }} registerDismiss={registerOverlay} busy={busy}><div className="mg-form">{editAction === 'link' || editAction === 'unlink' ? <><p className="mg-hint">{editAction === 'link' ? '确认后将更新当前笔记中的双链、标签或附件引用。' : '确认后仅移除当前笔记中指向目标的引用或标签，不删除笔记和附件。'}</p><label>搜索目标<input type="search" aria-label="搜索关联目标" placeholder="输入名称或路径…" value={targetQuery} onChange={e => { setTargetQuery(e.target.value); setTargetKey(''); }} /></label><p className="mg-hint" role="status">{matchingRelationTargets.length ? `匹配 ${matchingRelationTargets.length} / ${relationTargets.length} 个可选节点` : '没有匹配的节点，请更换关键词。'}</p><label>目标节点<select aria-label="选择关联目标" value={targetKey} onChange={e => setTargetKey(e.target.value)}><option value="">请选择笔记、标签或附件</option>{matchingRelationTargets.map(n => <option key={n.key} value={n.key}>{n.label}{n.relativePath ? ` · ${n.relativePath}` : ''}</option>)}</select></label></> : <label>{editAction === 'tags' ? '标签（用逗号分隔）' : '笔记名称'}<input value={editText} onChange={e => setEditText(e.target.value)} maxLength={editAction === 'tags' ? 1000 : 200} /></label>}{error && <p className="mg-hint" role="alert">{error}</p>}<div className="mg-form-actions"><button type="button" disabled={busy} onClick={() => setEditAction(null)}>取消</button><button type="button" className="mg-primary" disabled={busy || ((editAction === 'link' || editAction === 'unlink') ? !targetKey : editAction === 'create' && !editText.trim())} onClick={() => void mutate()}>{busy ? '正在保存…' : '确认保存'}</button></div></div></Sheet>}
    <span className="mg-sr-only">{mode === 'dark' ? '深色图谱' : '浅色图谱'}{reduced ? '，减少动态效果' : ''}</span>
  </div>;
}
