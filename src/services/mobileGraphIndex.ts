import { mobileGraphFrontmatterTags } from './mobileGraphFrontmatter.ts';
import { desktopGraphPath, resolveDesktopGraphReference } from './desktopGraphCache.ts';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { wikiSyntax, safeWikiTarget } from '../still/kit/wikiSyntax.ts';
import { localWikiResolvedId, localWikiDisplayStatus, type LocalWikiNote } from '../still/kit/localWiki.ts';
import { managedBoundWikiMatches, verifiedManagedWikiPath } from '../still/kit/managedWiki.ts';
import type { WikiReference } from '../still/kit/knowledgeRelations.ts';
import { managedNoteResources } from './managedNoteResources.ts';
import { realVaultMissingDocumentLocation } from '../features/graph/core/wikiTargets.ts';
import type { GraphSeedNode, GraphEdgeKind, GraphEdgeDirection } from '../features/graph/core/graphTypes.ts';
import { assertMobileGraphActive, graphYield, mobileGraphCatalogSignature, mobileGraphNoteKey, type MobileGraphNote, type MobileGraphSource, type MobileGraphSnapshot, type MobileGraphLoadOptions } from './mobileGraph.ts';

/** Blank YAML metadata in place; relation offsets remain valid for CAS edits. */
export function mobileGraphProse(content: string): string {
  const header = /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.exec(content);
  return header ? header[0].replace(/[^\r\n]/g, ' ') + content.slice(header[0].length) : content;
}
export type GraphParsedBody = { references: WikiReference[]; embeds: { target: string; from: number; to: number }[] };
export function parseMobileGraphBody(content: string): GraphParsedBody {
  const prose = mobileGraphProse(content), refs = new Map<string, WikiReference>();
  const parser = unified().use(remarkParse).use(remarkGfm).use(wikiSyntax(prose, refs));
  const tree = parser.runSync(parser.parse(prose));
  const embeds: GraphParsedBody['embeds'] = [];
  const definitions = new Map<string,string>();
  const collect = (node:any) => { if(node.type==='definition' && typeof node.identifier==='string' && typeof node.url==='string') definitions.set(node.identifier.toLowerCase(),node.url); if(Array.isArray(node.children))node.children.forEach(collect); };
  collect(tree);
  const walk = (node: any) => {
    if ((node.type === 'imageReference' || node.type === 'linkReference') && typeof node.identifier === 'string') {
      const url = definitions.get(node.identifier.toLowerCase());
      if (url) node = { ...node, type: node.type === 'imageReference' ? 'image' : 'link', url };
    }
    if ((node.type === 'image' || node.type === 'link' && !node.url?.startsWith('#luckyray-wiki-') && !/\.md(?:#.*)?$/i.test(node.url || '')) && typeof node.url === 'string' && Number.isInteger(node.position?.start?.offset) && Number.isInteger(node.position?.end?.offset)) {
      embeds.push({ target: node.url, from: node.position.start.offset, to: node.position.end.offset });
    }
    if (Array.isArray(node.children)) node.children.forEach(walk);
  };
  walk(tree);
  return { references: [...refs.values()], embeds };
}
export function graphReference(target: string): WikiReference { return { target, label: target, line: 1, from: 0, to: 0 }; }
const catalogs = new WeakMap<MobileGraphNote[], { local: LocalWikiNote[]; managed: NonNullable<MobileGraphNote['managed']>[] }>();
function catalogFor(notes: MobileGraphNote[], managed: boolean) {
  let entry = catalogs.get(notes);
  if (!entry) { entry = { local: notes.map(n => ({ ...n, managedIdentity: managed })), managed: notes.flatMap(n => n.managed ? [n.managed] : []) }; catalogs.set(notes, entry); }
  return entry;
}
export function mobileGraphResolve(source: MobileGraphSource, notes: MobileGraphNote[], from: MobileGraphNote, reference: WikiReference): { id: string | null; ambiguous: boolean } {
  if (source.kind === 'desktop') return resolveDesktopGraphReference(notes, from, reference);
  if (source.binding && from.managed) {
    try {
      const matches = managedBoundWikiMatches(reference, catalogFor(notes,true).managed, from.noteId, { localVaultId: source.id, binding: source.binding }).notes;
      return { id: matches.length === 1 ? matches[0].noteId : null, ambiguous: matches.length > 1 };
    } catch { return { id: null, ambiguous: false }; }
  }
  const catalog = catalogFor(notes, source.kind === 'managed').local;
  return { id: localWikiResolvedId(reference, catalog), ambiguous: localWikiDisplayStatus(reference, catalog) === 'ambiguous' };
}
function graphPath(source:MobileGraphSource,note:MobileGraphNote):string {
  return source.binding && note.managed ? verifiedManagedWikiPath(note.managed,{localVaultId:source.id,binding:source.binding}) || note.relativePath : note.relativePath;
}
const edgeKey = (a: number, b: number) => `${Math.min(a,b)}:${Math.max(a,b)}`;
function localAssetTarget(target: string): string | null {
  // Graph never resolves URLs or local filesystem paths. Only in-vault logical references.
  if (!safeWikiTarget(target) || /^(?:data|https?|file|javascript):/i.test(target)) return null;
  const clean = target.split('#')[0].trim();
  return clean || null;
}

function localAssetPath(target: string, source: string): string | null {
  if (!safeWikiTarget(target)) return null;
  const parts = source.split('/').slice(0,-1);
  for (const part of target.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(part);
  }
  return parts.join('/') || null;
}
export async function buildMobileGraphSnapshot(source: MobileGraphSource, notes: MobileGraphNote[], options: MobileGraphLoadOptions = {}): Promise<MobileGraphSnapshot> {
  const snapshot: MobileGraphSnapshot = { source: { ...source }, seed: { source: notes.length ? 'real' : 'empty', sourceKind: 'real-vault', nodes: [], edges: [], edgeKinds: {}, edgeDirections: {} }, notesByKey: new Map(), resourcesByKey: new Map(), tagsByKey: new Map(), warnings: [], signal: options.signal, complete: true, catalogStamp: mobileGraphCatalogSignature(notes.map(n=>n.managed||n)) };
  const { seed } = snapshot;
  const addResource = (key:string, resource: Omit<import('./mobileGraph.ts').MobileGraphResource,'references'>) => {
    const old=snapshot.resourcesByKey.get(key);
    const reference={noteKey:resource.noteKey,noteId:resource.noteId,target:resource.target,openRoute:resource.openRoute};
    const refs=old?.references || [];
    if(!refs.some(r=>r.noteId===reference.noteId&&r.target===reference.target))refs.push(reference);
    snapshot.resourcesByKey.set(key,{...(old||resource),references:refs});
  };
  const ids = new Map<string, number>(), pairs = new Map<string, [number, number]>();
  const addNode = (node: Omit<GraphSeedNode, 'id'>): number => {
    const existing = ids.get(node.key);
    if (existing !== undefined) {
      if (node.timelineAt !== undefined && (seed.nodes[existing].timelineAt === undefined || node.timelineAt < seed.nodes[existing].timelineAt!)) seed.nodes[existing].timelineAt = node.timelineAt;
      return existing;
    }
    const id = seed.nodes.length; ids.set(node.key, id); seed.nodes.push({ ...node, id }); return id;
  };
  const addEdge = (a: number, b: number, kind: GraphEdgeKind) => {
    if (a === b) return;
    const key = edgeKey(a,b), existing = pairs.get(key);
    const direction: GraphEdgeDirection = !existing || existing[0] === a ? 'forward' : 'reverse';
    if (existing) {
      if (seed.edgeDirections![key] !== direction) seed.edgeDirections![key] = 'bidirectional';
      return;
    }
    const pair: [number,number] = [a,b]; pairs.set(key,pair); seed.edges.push(pair); seed.edgeKinds![key] = kind; seed.edgeDirections![key] = direction;
  };
  for (const note of notes) {
    const key = mobileGraphNoteKey(source,note.noteId), time = Date.parse(note.updatedAt);
    const tags=[...new Set([...note.tags,...mobileGraphFrontmatterTags(note.content || '')])];
    snapshot.notesByKey.set(key,{...note,tags});
    addNode({ key, entityId: note.noteId, label: note.title || '未命名笔记', type: 'note', timelineAt: Number.isFinite(time) ? time : undefined, relativePath: graphPath(source,note), tags });
  }
  let missingBody = 0, conflictBody = 0, ambiguous = 0, unindexedResources = 0, unavailableResources = 0, unverifiedPaths = 0;
  for (let i = 0; i < notes.length; i++) {
    if (i % 20 === 0) await graphYield(options.signal);
    assertMobileGraphActive(options.signal);
    const note = notes[i], key = mobileGraphNoteKey(source,note.noteId), id = ids.get(key)!, timelineAt = seed.nodes[id].timelineAt;
    // Desktop uses frontmatter tags. Phone metadata tags are retained as a compatibility union; never inline #words.
    for (const raw of [...note.tags, ...mobileGraphFrontmatterTags(note.content || '')]) {
      const tag = raw.trim().replace(/^#+/, '').trim(); if (!tag) continue;
      const tagKey = `tag:mobile:${encodeURIComponent(source.id)}:${encodeURIComponent(tag.normalize('NFC').toLowerCase())}`;
      snapshot.tagsByKey.set(tagKey,tag);
      addEdge(id, addNode({ key: tagKey, entityId: tag, label: tag, type: 'tag', timelineAt }), 'tag');
    }
    if (typeof note.content !== 'string' || note.bodyState === 'missing') { missingBody++; continue; }
    if (note.bodyState === 'conflict') conflictBody++;
    const parsed = parseMobileGraphBody(note.content);
    if (source.kind === 'desktop' && !desktopGraphPath(note.relativePath)) {
      if (parsed.references.length || parsed.embeds.length) unverifiedPaths++;
      continue;
    }
    if (source.binding && note.managed && !verifiedManagedWikiPath(note.managed,{localVaultId:source.id,binding:source.binding})) {
      if (parsed.references.length || parsed.embeds.length) unverifiedPaths++;
      continue;
    }
    for (const reference of parsed.references) {
      const resolution = mobileGraphResolve(source, notes, note, reference);
      if (resolution.id) { addEdge(id, ids.get(mobileGraphNoteKey(source,resolution.id))!, 'wiki-link'); continue; }
      if (resolution.ambiguous) { ambiguous++; continue; }
      // A stable ID is identity, not a filename that may be created under a guessed title.
      if (!safeWikiTarget(reference.target) || reference.target.startsWith('@id/')) continue;
      const missing = realVaultMissingDocumentLocation(reference.target, source.binding || source.kind === 'desktop' ? graphPath(source,note) : '', { defaultParent: 'root' });
      if (!missing) continue;
      const missingKey = `note:missing-mobile:${encodeURIComponent(source.id)}:${encodeURIComponent(graphPath(source,note).toLocaleLowerCase())}:${encodeURIComponent(missing.relativePath.toLocaleLowerCase())}`;
      addEdge(id, addNode({ key: missingKey, entityId: null, type: 'note', label: missing.title, status: 'missing', timelineAt,
        missingTarget: { ...missing, rawTarget: reference.target, sourceRelativePath: graphPath(source,note) } }), 'wiki-link');
    }
    const descriptors = managedNoteResources(note.managed || null);
    for (const embed of parsed.embeds) {
      const localAsset = /^luckyray-local-asset:([A-Za-z0-9_-]{1,160})$/.exec(embed.target);
      if (localAsset) {
        const asset = await options.resolveLocalAsset?.(localAsset[1]); assertMobileGraphActive(options.signal);
        if (!asset) {
          if (options.resolveLocalAsset) unavailableResources++; else unindexedResources++;
          continue;
        }
        const resourceKey=`material:mobile:${encodeURIComponent(source.id)}:local-asset:${asset.id}`;
        addResource(resourceKey,{noteKey:key,noteId:note.noteId,target:embed.target,available:true,openRoute:note.openRoute});
        addEdge(id,addNode({key:resourceKey,entityId:asset.id,type:'material',label:asset.name,timelineAt}),'embed-asset');
        continue;
      }
      const target = localAssetTarget(embed.target); if (!target) continue;
      const resolution = mobileGraphResolve(source,notes,note,graphReference(target));
      if (resolution.id) { addEdge(id,ids.get(mobileGraphNoteKey(source,resolution.id))!,'embed-document'); continue; }
      if (resolution.ambiguous) { ambiguous++; continue; }
      if (/\.md$/i.test(target)) continue;
      const descriptor = descriptors.find(r => r.target === embed.target);
      // Resource IDs are per-note scoped, not globally trusted asset identifiers.
      const available = descriptor?.status === 'resolved';
      if (!available) {
        if (descriptor) unavailableResources++; else unindexedResources++;
        continue;
      }
      const confirmedSource = source.binding && note.managed ? verifiedManagedWikiPath(note.managed,{localVaultId:source.id,binding:source.binding}) : null;
      const canonical = confirmedSource ? localAssetPath(target, confirmedSource) : null;
      const resourceKey = canonical ? `material:mobile:${encodeURIComponent(source.id)}:path:${encodeURIComponent(canonical)}` : `material:mobile:${encodeURIComponent(source.id)}:${encodeURIComponent(note.noteId)}:${encodeURIComponent(target)}`;
      addResource(resourceKey, { noteKey: key, noteId: note.noteId, target: embed.target, available, openRoute: note.openRoute });
      addEdge(id,addNode({ key: resourceKey, entityId: descriptor?.resourceId || target, type: 'material', label: target.split('/').pop() || target, timelineAt, relativePath: target }),'embed-vault-asset');
    }
  }
  if (unverifiedPaths) snapshot.warnings.push(`${unverifiedPaths} 篇笔记的链接路径尚未确认，相关连线暂未显示。`);
  if (missingBody) snapshot.warnings.push(`${missingBody} 篇笔记正文未保存在手机，暂时只显示笔记节点，无法显示完整连线。`);
  if (conflictBody) snapshot.warnings.push(`${conflictBody} 篇笔记有本地冲突，图谱仅依据当前本机正文。`);
  if (ambiguous) snapshot.warnings.push(`${ambiguous} 处链接名称不唯一，相关连线暂未显示；请在来源笔记中明确目标。`);
  const unresolvedResources = unindexedResources + unavailableResources;
  if (unresolvedResources) {
    const reasons = [
      unindexedResources ? `${unindexedResources} 处未找到附件索引` : '',
      unavailableResources ? `${unavailableResources} 处附件尚未通过本机可用性检查` : '',
    ].filter(Boolean).join('，');
    snapshot.warnings.push(`${unresolvedResources} 处附件引用暂未显示在图谱中：${reasons}。这是引用次数，不代表丢失的文件数；请打开来源笔记检查附件。`);
  }
  return snapshot;
}
