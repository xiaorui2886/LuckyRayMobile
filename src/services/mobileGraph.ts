/** Local-only graph authority. No hydrate, connection, sync, or network API is used. */
import { api } from './client.ts';
import { managedVault, managedNoteRoute, subscribeManagedVaultMutations, type ManagedNote, type VaultBinding } from './managedVault.ts';
import type { GraphSeed } from '../features/graph/core/graphTypes.ts';
import { buildMobileGraphSnapshot } from './mobileGraphIndex.ts';

export type MobileGraphSource = { id: string; name: string; kind: 'managed' | 'legacy'; readOnly: boolean; binding?: VaultBinding | null };
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
  warnings: string[]; signal?: AbortSignal; complete: true; catalogStamp: string;
};
export type MobileGraphLoadOptions = { signal?: AbortSignal; onProgress?: (loaded: number, total: number) => void; resolveLocalAsset?: (id:string) => Promise<{id:string;name:string}|null> };
export const LEGACY_GRAPH_SOURCE = 'legacy-local';
export function assertMobileGraphActive(signal?: AbortSignal): void {
  if (signal?.aborted) { const error = new Error('图谱读取已取消'); error.name = 'AbortError'; throw error; }
}
export function graphYield(signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0)).then(() => assertMobileGraphActive(signal));
}
export async function listMobileGraphSources(): Promise<{ sources: MobileGraphSource[]; selectedSourceId: string }> {
  const [catalog, migration] = await Promise.all([managedVault.list(), managedVault.migrationStatus()]);
  const sources: MobileGraphSource[] = catalog.items.filter(v => v.migrationState === 'ready' && v.transferState !== 'completed').map(v => ({
    id: v.localVaultId, name: v.name, kind: 'managed', readOnly: v.transferState === 'pending', binding: v.binding,
  }));
  // The old on-device library remains usable without migration. No transfer is initiated.
  if (migration.state !== 'ready') sources.unshift({ id: LEGACY_GRAPH_SOURCE, name: '本机笔记（未整理，只读图谱）', kind: 'legacy', readOnly: true });
  return { sources, selectedSourceId: sources.some(s => s.id === catalog.selectedVaultId) ? catalog.selectedVaultId! : sources[0]?.id || '' };
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
/** All pages or an error, never a first-page graph masquerading as complete. */
export async function loadMobileGraphSnapshot(source: MobileGraphSource, options: MobileGraphLoadOptions = {}): Promise<MobileGraphSnapshot> {
  const { signal, onProgress } = options;
  assertMobileGraphActive(signal);
  let changed = false;
  const unsubscribe = subscribeManagedVaultMutations(event => { if (source.kind === 'managed' && event.localVaultId === source.id) changed = true; });
  try {
    const catalog = () => source.kind === 'managed' ? managedVault.linkCatalog(source.id) : api.localNoteLinkCatalog();
    const first = await catalog(); assertMobileGraphActive(signal);
    const firstById = new Map(first.items.map(item => [item.noteId, item]));
    const signature = mobileGraphCatalogSignature(first.items), rows: MobileGraphNote[] = [], seen = new Set<string>();
    let total: number | undefined;
    for (let page = 1; ; page++) {
      assertMobileGraphActive(signal);
      const result = source.kind === 'managed'
        ? await managedVault.notes({ localVaultId: source.id, page, limit: 200, sort: 'name' })
        : await api.localNoteList({ page, limit: 200, sort: 'name' });
      assertMobileGraphActive(signal);
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
    const last = await catalog(); assertMobileGraphActive(signal);
    if (changed || signature !== mobileGraphCatalogSignature(last.items) || rows.length !== last.items.length) throw Error('图谱读取期间笔记已变化，请重试');
    const localAssets = new Map<string,Promise<{id:string;name:string}|null>>();
    const resolveLocalAsset = (id:string) => {
      let result=localAssets.get(id);
      if(!result){ result=(async()=>{
        try {
          const asset=await api.localAssetGet(id); assertMobileGraphActive(signal);
          const proof=await api.localAssetIntegrity(id,false); assertMobileGraphActive(signal);
          return asset?.assetId===id && proof.assetId===id && proof.exists && proof.isFile && proof.sizeMatches ? {id,name:typeof asset.name==='string'?asset.name:id} : null;
        } catch(error) { assertMobileGraphActive(signal); return null; }
      })();localAssets.set(id,result); }
      return result;
    };
    const snapshot = await buildMobileGraphSnapshot(source, rows, {...options,resolveLocalAsset});
    snapshot.catalogStamp=signature;
    if(source.kind==='legacy'){
      const fingerprint=(n:any)=>JSON.stringify([n.noteId,n.title,n.folder||'',n.content,n.updatedAt,n.tags]);
      for(let page=1, offset=0;offset<rows.length;page++){
        const check=await api.localNoteList({page,limit:200,sort:'name'});assertMobileGraphActive(signal);
        if(check.total!==rows.length||!check.items.length||check.items.some((item:any,i:number)=>!rows[offset+i]||fingerprint(item)!==fingerprint(rows[offset+i])))throw Error('本机笔记正文已变化，请刷新图谱');
        offset+=check.items.length;await graphYield(signal);
      }
    }
    const finalCatalog=await catalog();assertMobileGraphActive(signal);
    if(signature!==mobileGraphCatalogSignature(finalCatalog.items))throw Error('图谱构建期间笔记目录已变化，请重试');
    if (changed) throw Error('图谱读取期间笔记已变化，请重试');
    return snapshot;
  } finally { unsubscribe(); }
}
export function subscribeMobileGraphChanges(source: MobileGraphSource, listener: () => void): () => void {
  const off = subscribeManagedVaultMutations(e => { if (source.kind === 'managed' && e.localVaultId === source.id) listener(); });
  const changed = () => listener();
  if (typeof window !== 'undefined') {
    window.addEventListener('luckyray:managed-vault-change', changed);
    window.addEventListener('luckyray:local-notes-change', changed);
  }
  return () => { off(); if (typeof window !== 'undefined') { window.removeEventListener('luckyray:managed-vault-change', changed); window.removeEventListener('luckyray:local-notes-change', changed); } };
}
export { createMobileGraphNote, linkMobileGraphNodes, unlinkMobileGraphNodes, setMobileGraphNoteTags } from './mobileGraphMutations.ts';
