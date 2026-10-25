import type {WikiReference} from "./knowledgeRelations.ts";
import { localWikiReferences, localWikiResolvedId, type LocalWikiNote } from "./localWiki.ts";
export type LocalBacklink = { noteId: string; title: string; excerpt: string };
export function localBacklinksFor(source: string, rows: readonly LocalWikiNote[], catalog: LocalWikiNote[]): LocalBacklink[] {
  return rows.flatMap(note => {
    if (note.noteId === source || typeof note.content !== "string") return [];
    return localBacklinkForReferences(source, note, catalog, localWikiReferences(note.content));
  });
}
export function localBacklinkForReferences(source: string, note: LocalWikiNote, catalog: LocalWikiNote[], references: WikiReference[], resolve?: (reference: WikiReference, note: LocalWikiNote, catalog: LocalWikiNote[]) => string | null): LocalBacklink[] {
    if (note.noteId === source || typeof note.content !== "string") return [];
    const reference = references.find(ref => (resolve ? resolve(ref, note, catalog) : localWikiResolvedId(ref, catalog)) === source);
    if (!reference) return [];
    const start = Math.max(0, note.content.lastIndexOf("\n", reference.from) + 1);
    const end = note.content.indexOf("\n", reference.to);
    return [{ noteId: note.noteId, title: note.title || "未命名笔记", excerpt: note.content.slice(start, end < 0 ? undefined : end).trim().slice(0, 180) }];
}
