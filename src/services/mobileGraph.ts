/** Local-only graph authority. No hydrate, connection, sync, or network API is used. */
import { api, type ConnState } from './client.ts';
import { managedVault, managedNoteRoute, subscribeManagedVaultMutations, type ManagedNote, type VaultBinding } from './managedVault.ts';
import type { GraphSeed } from '../features/graph/core/graphTypes.ts';
import { buildMobileGraphSnapshot } from './mobileGraphIndex.ts';
import { desktopLibraries } from './desktopLibraries.ts';
import { desktopGraphCache, desktopGraphPath, DESKTOP_GRAPH_SAVE_HELP, type DesktopGraphCache } from './desktopGraphCache.ts';
import { hasReadableBody } from './noteProvenance.ts';
import { desktopNoteRoute } from '../still/kit/noteSearch.ts';
import { dataStore } from './dataStore.ts';
import { buildKnowledgeVaultCatalog } from './knowledgeVaultCatalog.ts';
import { noteSourceKey, noteSourceSelection, type NoteSourceSelection } from './noteSourceSelection.ts';

export type MobileGraphSource = { id: string; name: string; kind: 'managed' | 'legacy' | 'desktop'; readOnly: boolean; binding?: VaultBinding | null;
  desktop?: { instanceId: string; vaultId: string }; availability?: 'ready' | 'not-saved' | 'revoked' | 'unavailable'; notice?: string };
export type MobileGraphNote = {
  noteId: string; title: string; content?: string; folder: string; relativePath: string; revision: string;
  tags: string[]; historicalNames: string[]; updatedAt: string; openRoute: string; bodyState: string;
  managed?: ManagedNote;
};
export type MobileGraphResourceReference = {noteId:string;noteKey:string;target:string;openRoute:string};
export type MobileGraphResource = { references?: MobileGraphResourceReference[]; noteKey: string; noteId: string; target: string; available: boolean; openRoute: string };
export type MobileGraphSnapshot = {
  seed: GraphSeed; source: MobileGraphSource; notesByKey: Map<string, MobileGraphNote>;
  resourcesByKey: Map<string, MobileGraphResource>; tagsByKey: Map<string, string>;
  warnings: string[]; signal?: AbortSignal; complete: boolean; catalogStamp: string;
};
export type MobileGraphLoadOptions = { signal?: AbortSignal; onProgress?: (loaded: number, total: number) => void; resolveLocalAsset?: (id:string) => Promise<{id:string;name:string}|null> };
export const LEGACY_GRAPH_SOURCE = 'legacy-local';
export function assertMobileGraphActive(signal?: AbortSignal): void {
  if (signal?.aborted) { const error = new Error('图谱读取已取消'); error.name = 'AbortError'; throw error; }
}
export function graphYield(signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0)).then(() => assertMobileGraphActive(signal));
}
export function mobileGraphSourceSelection(source: MobileGraphSource): NoteSourceSelection {
  if (source.kind === 'desktop') return { kind: 'desktop', instanceId: source.desktop?.instanceId || '', vaultId: source.desktop?.vaultId || '' };
  return source.kind === 'managed' ? { kind: 'managed', localVaultId: source.id } : { kind: 'legacy' };
}
export async function listMobileGraphSources(options: { conn?: ConnState | null } = {}): Promise<{ sources: MobileGraphSource[]; selectedSourceId: string }> {
  // Registry identity, not the remote cache/name, is the browsing authority.
  // No migration, registration, cache scan, or network activity on graph open.
  void options;
  const started = noteSourceSelection.snapshot();
  const raw = await managedVault.list();
  const current = noteSourceSelection.snapshot();
  const catalog = buildKnowledgeVaultCatalog(raw, current.selection);
  if (current.version === started.version && catalog.selection?.kind === 'managed')
    noteSourceSelection.select(catalog.selection, started.version);
  const sources: MobileGraphSource[] = catalog.items.map(item => ({
    id:item.id,name:item.displayName,kind:'managed',readOnly:item.readOnly,binding:item.binding,
  }));
  // Explicit recovery navigation only; never advertise a parallel legacy mode.
  if (current.selection?.kind === 'legacy') sources.push({id:LEGACY_GRAPH_SOURCE,
    name:'旧版笔记恢复（只读）',kind:'legacy',readOnly:true});
  const finalSelection = noteSourceSelection.snapshot().selection;
  return {sources,selectedSourceId:finalSelection ? noteSourceKey(finalSelection) : catalog.selectedVaultId || ''};
}

export function mobileGraphNoteKey(source: MobileGraphSource, noteId: string): string {
  return `note:mobile:${encodeURIComponent(source.id)}:${encodeURIComponent(noteId)}`;
}
function normalizeNote(source: MobileGraphSource, raw: any): MobileGraphNote {
  if (!raw || typeof raw.noteId !== 'string' || typeof raw.title !== 'string') throw Error('图谱笔记数据无效，请重试');
  if (source.kind === 'managed' && raw.localVaultId !== source.id) throw Error('图谱知识库已变化，请重试');
  const folder = typeof raw.folder === 'string' ? raw.folder : '';
  return { noteId: raw.noteId, title: raw.title, content: typeof raw.content === 'string' ? raw.content : undefined,
    folder, relativePath: typeof raw.relativePath === 'string' ? raw.relativePath : `${folder ? folder + '/' : ''}${raw.title}.md`,
    revision: typeof raw.revision === 'string' ? raw.revision : '', tags: Array.isArray(raw.tags) ? raw.tags.filter((x: unknown) => typeof x === 'string') : [],
    historicalNames: Array.isArray(raw.historicalNames) ? raw.historicalNames.filter((x: unknown) => typeof x === 'string') : [],
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '', bodyState: raw.bodyState || 'ready',
    openRoute: source.kind === 'managed' ? managedNoteRoute(source.id, raw.noteId) : raw.noteId,
    ...(source.kind === 'managed' ? { managed: raw as ManagedNote } : {}),
  };
}
export function mobileGraphCatalogSignature(items: any[]): string {
  return JSON.stringify(items.map(n => [n.noteId, n.revision, n.title, n.folder, n.relativePath, n.historicalNames, n.tags, n.bodyState, n.syncState, n.remote]).sort((a,b) => String(a[0]).localeCompare(String(b[0]))));
}
async function loadDesktopGraphSnapshot(source: MobileGraphSource, options: MobileGraphLoadOptions): Promise<MobileGraphSnapshot> {
  const scope = source.desktop;
  if (!scope?.instanceId || !scope.vaultId || source.id !== noteSourceKey({kind:'desktop',...scope})) throw Error(source.notice || '请先在笔记中选择当前电脑的知识库。');
  if (source.availability && source.availability !== 'ready') throw Error(source.notice || DESKTOP_GRAPH_SAVE_HELP);
  const selectionVersion = noteSourceSelection.snapshot().version;
  const active = () => {
    assertMobileGraphActive(options.signal);
    if (noteSourceSelection.snapshot().version !== selectionVersion) { const error = Error('图谱来源已切换'); error.name = 'AbortError'; throw error; }
    const state = desktopLibraries.snapshot(scope.instanceId);
    if (state.catalog?.scopeSelectionVersion === 1) {
      const row = state.catalog.knowledge.find(row => row.vaultId === scope.vaultId);
      if (!row?.available || !row.readGranted) throw Error('此电脑知识库当前不可读，请返回笔记检查所选库及授权。');
    }
  };
  const read = async (page: number) => {
    active();
    let value: DesktopGraphCache;
    try { value = await desktopGraphCache.read(scope.instanceId, scope.vaultId, page); }
    catch (error) {
      active();
      if (String(error).includes('CONTENT_SOURCE_CHANGED')) throw Error('配对来源已变化，请返回笔记选择当前电脑的知识库。');
      throw Error('无法读取本机电脑笔记缓存，请重试；没有联网补取。');
    }
    active();
    if (value.instanceId !== scope.instanceId || value.vaultId !== scope.vaultId) throw Error('电脑笔记缓存来源已变化，请重试。');
    if (value.status === 'not-saved') throw Error(`此电脑知识库尚未确认保存在手机。${DESKTOP_GRAPH_SAVE_HELP}`);
    if (value.status === 'revoked') throw Error('此电脑知识库的读取授权已撤销，请在电脑端确认授权。');
    if (value.status !== 'ready' || !Number.isSafeInteger(value.total) || value.total < 0 || typeof value.hasMore !== 'boolean'
      || !Array.isArray(value.items) || !Array.isArray(value.libraries) || !value.stamp) throw Error('电脑笔记缓存不完整，请重试。');
    const library = value.libraries.find(row => row.instanceId === scope.instanceId && row.vaultId === scope.vaultId);
    if (!library?.confirmed || !['granted','readonly'].includes(library.writeState)) throw Error(`此电脑知识库尚未确认保存在手机。${DESKTOP_GRAPH_SAVE_HELP}`);
    return {value,library};
  };
  const rows: MobileGraphNote[] = [], ids = new Set<string>();
  let stamp = '', total = -1, metadataReady = false, outdated = 0, dirty = 0;
  for (let page = 1; ; page++) {
    const {value,library} = await read(page);
    if (page === 1) { stamp = value.stamp; total = value.total; metadataReady = library.metadataReady; }
    if (value.stamp !== stamp || value.total !== total || library.metadataReady !== metadataReady) throw Error('电脑笔记缓存读取期间已变化，请刷新图谱。');
    for (const raw of value.items) {
      if (raw.instanceId !== scope.instanceId || raw.vaultId !== scope.vaultId || typeof raw.noteId !== 'string' || !raw.noteId
        || typeof raw.title !== 'string' || ids.has(raw.noteId) || raw.deleted) throw Error('电脑笔记缓存范围或分页已变化，请重试。');
      ids.add(raw.noteId);
      const readable = typeof raw.content === 'string' && raw.bodyState !== 'missing' && hasReadableBody(raw);
      // Old cache formats may contain absolute paths. They are not graph
      // navigation authority and must not enter displayed/exported graph data.
      const relativePath = desktopGraphPath(raw.relativePath) ? raw.relativePath : '';
      rows.push({noteId:raw.noteId,title:raw.title,content:readable ? raw.content : undefined,
        folder:relativePath.split('/').slice(0,-1).join('/'),relativePath,revision:raw.revision || '',tags:[],historicalNames:[],updatedAt:raw.updatedAt || '',
        openRoute:desktopNoteRoute(scope.instanceId,scope.vaultId,raw.noteId),bodyState:!readable ? 'missing' : raw.conflictDocument ? 'conflict' : 'ready'});
      if (readable && raw.bodyOutdated) outdated++;
      if (readable && raw.dirty) dirty++;
    }
    options.onProgress?.(rows.length,total);
    if (!value.hasMore) { if (rows.length !== total) throw Error('电脑笔记缓存尚未完整读取，请重试。'); break; }
    if (!value.items.length || rows.length >= total) throw Error('电脑笔记缓存分页无效，请重试。');
    await graphYield(options.signal); active();
  }
  if (!metadataReady && !rows.length) throw Error(`电脑笔记目录尚未完整保存在手机。${DESKTOP_GRAPH_SAVE_HELP}`);
  // Attachment IDs in Desktop Markdown are not phone asset authority. No
  // local-asset resolver is supplied for this read-only Desktop graph.
  const snapshot = await buildMobileGraphSnapshot(source, rows, {signal:options.signal});
  active();
  const final = await read(1);
  if (final.value.stamp !== stamp || final.value.total !== total || final.library.metadataReady !== metadataReady) throw Error('电脑笔记缓存构建期间已变化，请刷新图谱。');
  snapshot.catalogStamp = stamp;
  const missing = rows.filter(row => row.bodyState === 'missing').length;
  const conflicts = rows.filter(row => row.bodyState === 'conflict').length;
  snapshot.complete = metadataReady && !missing && !outdated && !dirty && !conflicts;
  if (!snapshot.complete) snapshot.warnings.unshift([
    !metadataReady ? `目录尚未保存完整，仅显示本机已有 ${rows.length} 篇` : `已读取 ${rows.length} 篇本机缓存`,
    missing ? `${missing} 篇正文未缓存，出链不完整` : '', outdated ? `${outdated} 篇仍是旧版本` : '',
    conflicts ? `${conflicts} 篇存在冲突` : '', dirty ? `${dirty} 篇包含未同步修改` : '',
  ].filter(Boolean).join('；') + '。');
  if (!metadataReady) snapshot.warnings.push(`笔记目录尚未完整保存；这里只显示本机已有的 ${rows.length} 篇，不能视为整库图谱。${DESKTOP_GRAPH_SAVE_HELP}`);
  if (missing) snapshot.warnings.push(DESKTOP_GRAPH_SAVE_HELP);
  if (outdated) snapshot.warnings.push(`${outdated} 篇使用已保存的旧版本正文；电脑上的更新尚未保存在手机，图谱可能不完整。`);
  if (dirty) snapshot.warnings.push(`${dirty} 篇包含尚未同步到电脑的手机修改，图谱依据本机草稿。`);
  snapshot.warnings.push('只读图谱依据当前电脑知识库已保存在手机的缓存计算，不会联网补取。');
  return snapshot;
}
/** All pages or an error, never a first-page graph masquerading as complete. */
async function loadMobileGraphSnapshotOnce(source: MobileGraphSource, options: MobileGraphLoadOptions = {}): Promise<MobileGraphSnapshot> {
  if (source.kind === 'desktop') return loadDesktopGraphSnapshot(source, options);
  const { signal, onProgress } = options;
  const selectionVersion = noteSourceSelection.snapshot().version;
  const active = () => {
    assertMobileGraphActive(signal);
    if (noteSourceSelection.snapshot().version !== selectionVersion) {
      const error = Error('已切换知识库'); error.name = 'AbortError'; throw error;
    }
  };
  assertMobileGraphActive(signal);
  let changed = false;
  const unsubscribe = subscribeManagedVaultMutations(event => { if (source.kind === 'managed' && event.localVaultId === source.id) changed = true; });
  try {
    const catalog = () => source.kind === 'managed' ? managedVault.linkCatalog(source.id) : api.localNoteLinkCatalog();
    const first = await catalog(); active();
    const firstById = new Map(first.items.map(item => [item.noteId, item]));
    const signature = mobileGraphCatalogSignature(first.items), rows: MobileGraphNote[] = [], seen = new Set<string>();
    let total: number | undefined;
    for (let page = 1; ; page++) {
      active();
      const result = source.kind === 'managed'
        ? await managedVault.notes({ localVaultId: source.id, page, limit: 200, sort: 'name' })
        : await api.localNoteList({ page, limit: 200, sort: 'name' });
      active();
      if (changed || !Number.isSafeInteger(result.total) || result.total < 0 || !Array.isArray(result.items)
        || typeof result.hasMore !== 'boolean' || total !== undefined && total !== result.total) throw Error('图谱读取期间笔记已变化，请重试');
      total = result.total;
      for (const raw of result.items) {
        const metadata = firstById.get(raw.noteId);
        if (!metadata) throw Error('图谱笔记目录已变化，请重试');
        if(source.kind==='managed' && mobileGraphCatalogSignature([raw])!==mobileGraphCatalogSignature([metadata]))throw Error('图谱读取期间笔记元数据已变化，请重试');
        if(source.kind==='legacy' && (raw.title!==metadata.title || (raw.folder||'')!==(metadata.folder||'')))throw Error('本机笔记目录已变化，请重试');
        const note = normalizeNote(source, { ...raw, historicalNames: metadata.historicalNames });
        if (seen.has(note.noteId)) throw Error('图谱分页已变化，请重试');
        seen.add(note.noteId); rows.push(note);
      }
      onProgress?.(rows.length, total);
      if (!result.hasMore) { if (rows.length !== total) throw Error('图谱笔记尚未完整读取，请重试'); break; }
      if (!result.items.length || rows.length >= total) throw Error('图谱分页无效，请重试');
      await graphYield(signal);
    }
    const last = await catalog(); active();
    if (changed || signature !== mobileGraphCatalogSignature(last.items) || rows.length !== last.items.length) throw Error('图谱读取期间笔记已变化，请重试');
    const localAssets = new Map<string,Promise<{id:string;name:string}|null>>();
    const resolveLocalAsset = (id:string) => {
      let result=localAssets.get(id);
      if(!result){ result=(async()=>{
        try {
          const asset=await api.localAssetGet(id); active();
          const proof=await api.localAssetIntegrity(id,false); active();
          return asset?.assetId===id && proof.assetId===id && proof.exists && proof.isFile && proof.sizeMatches ? {id,name:typeof asset.name==='string'?asset.name:id} : null;
        } catch(error) { active(); return null; }
      })();localAssets.set(id,result); }
      return result;
    };
    const snapshot = await buildMobileGraphSnapshot(source, rows, {...options,resolveLocalAsset});
    snapshot.catalogStamp=signature;
    if(source.kind==='legacy'){
      const fingerprint=(n:any)=>JSON.stringify([n.noteId,n.title,n.folder||'',n.content,n.updatedAt,n.tags]);
      for(let page=1, offset=0;offset<rows.length;page++){
        const check=await api.localNoteList({page,limit:200,sort:'name'});active();
        if(check.total!==rows.length||!check.items.length||check.items.some((item:any,i:number)=>!rows[offset+i]||fingerprint(item)!==fingerprint(rows[offset+i])))throw Error('本机笔记正文已变化，请刷新图谱');
        offset+=check.items.length;await graphYield(signal);
      }
    }
    const finalCatalog=await catalog();active();
    if(signature!==mobileGraphCatalogSignature(finalCatalog.items))throw Error('图谱构建期间笔记目录已变化，请重试');
    if (changed) throw Error('图谱读取期间笔记已变化，请重试');
    return snapshot;
  } finally { unsubscribe(); }
}
/** A single concurrent local edit may settle during reading. Retry once only;
 * malformed scope/pagination and permission failures must never be retried away. */
export async function loadMobileGraphSnapshot(source: MobileGraphSource, options: MobileGraphLoadOptions = {}): Promise<MobileGraphSnapshot> {
  const version = noteSourceSelection.snapshot().version;
  for (let attempt = 0; ; attempt++) {
    try { return await loadMobileGraphSnapshotOnce(source, options); }
    catch (error) {
      assertMobileGraphActive(options.signal);
      if (noteSourceSelection.snapshot().version !== version) {
        const aborted = Error('已切换知识库'); aborted.name = 'AbortError'; throw aborted;
      }
      const transient = error instanceof Error && /^图谱(?:读取期间笔记(?:元数据)?|构建期间笔记目录)已变化/.test(error.message);
      if (attempt !== 0 || !transient) throw error;
      await graphYield(options.signal);
    }
  }
}
export function subscribeMobileGraphChanges(source: MobileGraphSource, listener: () => void): () => void {
  const off = subscribeManagedVaultMutations(e => { if (source.kind === 'managed' && e.localVaultId === source.id) listener(); });
  const changed = () => listener();
  const offData = source.kind === 'desktop' ? dataStore.subscribe(listener) : () => {};
  const offLibraries = source.kind === 'desktop' ? desktopLibraries.subscribe(listener) : () => {};
  if (typeof window !== 'undefined') {
    window.addEventListener('luckyray:managed-vault-change', changed);
    window.addEventListener('luckyray:local-notes-change', changed);
  }
  return () => { off(); offData(); offLibraries(); if (typeof window !== 'undefined') { window.removeEventListener('luckyray:managed-vault-change', changed); window.removeEventListener('luckyray:local-notes-change', changed); } };
}
export { createMobileGraphNote, linkMobileGraphNodes, unlinkMobileGraphNodes, setMobileGraphNoteTags } from './mobileGraphMutations.ts';
