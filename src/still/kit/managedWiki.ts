import type { ManagedNote, VaultBinding } from '../../services/managedVault.ts';
import type { WikiChoice } from '../../presentation/still01/editor/wikiCompletion.ts';
import type { WikiReference } from './knowledgeRelations.ts';
import { splitWikiHeading } from './noteHeadings.ts';
import { safeWikiTarget } from './wikiSyntax.ts';

export type ManagedWikiScope = { localVaultId: string; binding: VaultBinding };
/** A phone filename contains a private identity suffix. Only confirmed Desktop
 * paths can be serialized into a cross-device link. This is never a file opener. */
export function verifiedManagedWikiPath(note: ManagedNote, scope: ManagedWikiScope, target = false): string | null {
  const remote = note.remote as Record<string, any> | undefined;
  const server = remote?.serverDocument;
  if (note.localVaultId !== scope.localVaultId || remote?.instanceId !== scope.binding.instanceId || remote?.vaultId !== scope.binding.remoteVaultId
    || !server || server.noteId !== note.noteId || server.vaultId !== scope.binding.remoteVaultId
    || server.instanceId !== undefined && server.instanceId !== scope.binding.instanceId
    || server.deleted === true || typeof server.revision !== 'string' || !server.revision
    || remote.revision !== server.revision || remote.conflictDocument
    || remote.pendingKind === 'create' || remote.pendingKind === 'move'
    || note.bodyState === 'conflict' || note.syncState === 'conflict'
    || target && (note.syncState === 'pending' || remote.pendingKind)) return null;
  const path = server.relativePath;
  if (typeof path !== 'string' || path !== remote.relativePath || !safeWikiTarget(path)
    || /[\\#|\[\]]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..') || !/\.md$/i.test(path)) return null;
  return path;
}
export function managedRelativeWikiTarget(source: string, target: string): string {
  const from = source.split('/').slice(0, -1), to = target.split('/');
  let common = 0; while (common < from.length && common < to.length && from[common] === to[common]) common++;
  const prefix = '../'.repeat(from.length - common);
  return (prefix || './') + to.slice(common).join('/');
}
export function managedBoundWikiChoices(source: ManagedNote | null, notes: ManagedNote[], query: string, scope: ManagedWikiScope): WikiChoice[] {
  const from = source && verifiedManagedWikiPath(source, scope);
  if (!from) return [];
  const q = query.normalize('NFC').toLowerCase();
  const verified = notes.map(note => ({note,path:verifiedManagedWikiPath(note,scope,true)}));
  return verified.flatMap(({note,path}) => {
    if (!path || verified.filter(row => row.path && pathKey(row.path) === pathKey(path)).length !== 1 || !note.title.normalize('NFC').toLowerCase().includes(q) && !path.normalize('NFC').toLowerCase().includes(q)) return [];
    return [{id:note.noteId,title:note.title || '未命名笔记',target:managedRelativeWikiTarget(from,path),detail:path}];
  });
}
function normalizePath(value: string, base: string[] = []): string | null {
  const parts = [...base];
  for (const part of value.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else parts.push(part);
  }
  return parts.length ? parts.join('/') : null;
}
const asciiLower = (value: string) => value.replace(/[A-Z]/g, character => character.toLowerCase());
const pathKey = (path: string) => asciiLower(path).replace(/\.md$/,'');
/** Exact confirmed-path mapping scoped to one replica; never phone paths/IDs. */
export function managedBoundWikiMatches(reference: WikiReference, notes: ManagedNote[], sourceId: string, scope: ManagedWikiScope): {notes: ManagedNote[]; heading?: string} {
  if (!safeWikiTarget(reference.target)) throw Error('LOCAL_WIKI_UNSUPPORTED');
  const split = splitWikiHeading(reference.target);
  if (!split || !split.noteTarget || split.noteTarget.includes(':') || split.noteTarget.startsWith('@id/')) return {notes:[],heading:split?.heading};
  const source = notes.find(note => note.noteId === sourceId);
  const from = source && verifiedManagedWikiPath(source,scope);
  if (!from) return {notes:[],heading:split.heading};
  const target = split.noteTarget.trim().replace(/\\/g,'/');
  const withExtension = /\.md$/i.test(target) ? target : `${target}.md`;
  const relative = normalizePath(withExtension,from.split('/').slice(0,-1));
  // Desktop compares the unnormalized root spelling as well as the normalized
  // source-relative path. ./ and ../ never accidentally match a root basename.
  const root = withExtension;
  const keys = new Set([relative,root].filter((value):value is string => Boolean(value)).map(pathKey));
  const basename = !target.includes('/') ? pathKey(withExtension) : null;
  return {notes:notes.filter(note=>{
    const path=verifiedManagedWikiPath(note,scope,true);
    return path !== null && (keys.has(pathKey(path)) || basename !== null && pathKey(path.split('/').pop()!)===basename);
  }).sort((a,b)=>{const pa=verifiedManagedWikiPath(a,scope,true)!,pb=verifiedManagedWikiPath(b,scope,true)!;return pa<pb?-1:pa>pb?1:0;}),heading:split.heading};
}
export type ManagedWikiClient = {catalog:()=>Promise<{items:ManagedNote[]}>; get:(noteId:string)=>Promise<ManagedNote>};
export async function resolveManagedBoundWiki(reference:WikiReference,sourceId:string,scope:ManagedWikiScope,client:ManagedWikiClient,choice?:{noteId:string;expectedIds:string[]}) {
  const first=managedBoundWikiMatches(reference,(await client.catalog()).items,sourceId,scope);
  const checkChoice=(notes:ManagedNote[])=>{
    if (choice && (notes.length!==choice.expectedIds.length || notes.some(note=>!choice.expectedIds.includes(note.noteId)))) throw Error('LOCAL_WIKI_CHANGED');
    return choice ? notes.find(note=>note.noteId===choice.noteId) : notes.length===1?notes[0]:undefined;
  };
  const selected=checkChoice(first.notes);
  if (!selected) {
    if(choice) throw Error('LOCAL_WIKI_CHANGED');
    return {kind:first.notes.length?'ambiguous':'missing',notes:first.notes,heading:first.heading} as const;
  }
  const actual=await client.get(selected.noteId);
  if(actual.noteId!==selected.noteId || verifiedManagedWikiPath(actual,scope,true)!==verifiedManagedWikiPath(selected,scope,true)) throw Error('LOCAL_WIKI_CHANGED');
  const fresh=managedBoundWikiMatches(reference,(await client.catalog()).items,sourceId,scope);
  const verified=checkChoice(fresh.notes);
  if(!verified || verified.noteId!==selected.noteId) throw Error('LOCAL_WIKI_CHANGED');
  return {kind:'resolved',notes:[verified],heading:fresh.heading} as const;
}
