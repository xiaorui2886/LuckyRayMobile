import {MarkdownParseClient, SYNC_MARKDOWN_LIMIT} from '../../presentation/still01/editor/markdownParseClient.ts';
import {localWikiReferences, type LocalWikiNote} from './localWiki.ts';
import {localBacklinkForReferences, type LocalBacklink} from './localBacklinks.ts';
import type {WikiReference} from './knowledgeRelations.ts';
/** Paginated local-only backlink scanning. Large articles use the same bounded,
 * cancellable worker transport as Live Preview; never freeze the input thread
 * or turn a worker failure into a false “no incoming links” result. */
export function scanLocalBacklinks(source: string, rows: readonly LocalWikiNote[], catalog: LocalWikiNote[], resolve?: (reference: WikiReference, note: LocalWikiNote, catalog: LocalWikiNote[]) => string | null) {
 let cancelled=false, rejectActive: ((error: Error)=>void)|undefined;
 let accept: ((refs: WikiReference[])=>void)|undefined;
 const worker=new MarkdownParseClient<WikiReference[]>('wiki', refs=>accept?.(refs),()=>rejectActive?.(new Error('无法完成长笔记入链解析，请重试')));
 const promise=(async()=>{
  const result: LocalBacklink[]=[];
  for (const note of rows) {
   if (cancelled) throw new Error('scan cancelled');
   if (note.noteId===source || typeof note.content!=='string') continue;
   const refs=note.content.length<=SYNC_MARKDOWN_LIMIT ? localWikiReferences(note.content) : await new Promise<WikiReference[]>((resolve,reject)=>{accept=resolve;rejectActive=reject;worker.request(note.content!,[],true)});
   if (cancelled) throw new Error('scan cancelled');
   result.push(...localBacklinkForReferences(source,note,catalog,refs,resolve));
   await new Promise<void>(resolve=>setTimeout(resolve,0));
  }
  if (cancelled) throw new Error('scan cancelled');
  return result;
 })().finally(()=>{accept=undefined;rejectActive=undefined;worker.destroy()});
 return {promise,cancel(){cancelled=true;rejectActive?.(new Error('scan cancelled'));worker.destroy()}};
}
