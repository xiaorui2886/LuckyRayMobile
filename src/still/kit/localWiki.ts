import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { wikiSyntax, safeWikiTarget } from "./wikiSyntax.ts";
import type { WikiReference } from "./knowledgeRelations.ts";

/** The very same parsed-text grammar as Desktop. Local reading still renders
 * plain source except these proven tokens; code/HTML/escaped syntax stays literal.
 */
export function localWikiReferences(body: string): WikiReference[] {
  const references = new Map<string, WikiReference>();
  const parser = unified().use(remarkParse).use(remarkGfm).use(wikiSyntax(body, references));
  parser.runSync(parser.parse(body));
  return [...references.values()];
}

export type LocalWikiNote = { noteId: string; title: string; content?: string; preview?: string; updatedAt?: string };
/** A bounded plain-text label from the already returned local catalog; no extra reads. */
export function localWikiPreview(value: unknown): string {
  return typeof value === "string" ? Array.from(value.slice(0, 1200).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim()).slice(0, 90).join("") : "";
}
export function localWikiChoiceDetail(note: LocalWikiNote): string {
  const preview = localWikiPreview(note.preview);
  const date = typeof note.updatedAt === "string" && /^\d{4}-\d{2}-\d{2}T/.test(note.updatedAt) && Number.isFinite(Date.parse(note.updatedAt))
    ? new Date(note.updatedAt).toLocaleDateString("zh-CN") : "";
  return [preview || "暂无摘要", date ? `更新于 ${date}` : "", `编号 ${note.noteId.slice(-8)}`].filter(Boolean).join(" · ");
}
export type LocalWikiClient = {
  list: (options: { page: number; limit: number; sort: "name" }) => Promise<{ items: LocalWikiNote[]; total: number; hasMore: boolean }>;
  get: (noteId: string) => Promise<LocalWikiNote>;
};
export type LocalWikiResult = { kind: "resolved" | "ambiguous" | "missing"; notes: LocalWikiNote[] };
export function localWikiId(value: string): boolean { return /^note-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value); }
const titleKey = (title: string) => title.trim().replace(/\.md$/i, "").normalize("NFC").toLowerCase();

/** Stable IDs are the only navigation output. A complete, native ordered
 * catalog is required before declaring a title unique (never first-page guessing).
 * A changed/incomplete catalog fails closed; the save authority is not involved.
 */
export async function resolveLocalWiki(reference: WikiReference, client: LocalWikiClient): Promise<LocalWikiResult> {
  if (!safeWikiTarget(reference.target)) throw Error("LOCAL_WIKI_UNSUPPORTED");
  // Local notes are flat records, not files in a Desktop vault. ./ names the
  // local root; a .md suffix is a spelling, never an on-disk path to open.
  const target = reference.target.replace(/^(?:\.\/)+/, "");
  if (target.includes("#")) throw Error("LOCAL_WIKI_ANCHOR_UNSUPPORTED");
  if (!target || /[\\/]/.test(target) || target === "." || target === "..") throw Error("LOCAL_WIKI_PATH_UNSUPPORTED");
  const notes: LocalWikiNote[] = [], seen = new Set<string>(); let total: number | undefined;
  for (let page = 1; page <= 500; page++) {
    const result = await client.list({ page, limit: 200, sort: "name" });
    if (!Array.isArray(result.items) || !Number.isSafeInteger(result.total) || result.total < 0
      || typeof result.hasMore !== "boolean" || total !== undefined && total !== result.total) throw Error("LOCAL_WIKI_CHANGED");
    total = result.total;
    for (const note of result.items) {
      if (!localWikiId(note.noteId) || typeof note.title !== "string" || seen.has(note.noteId)) throw Error("LOCAL_WIKI_CHANGED");
      seen.add(note.noteId);
      const preview = localWikiPreview(note.content);
      notes.push({ noteId: note.noteId, title: note.title, ...(preview ? { preview } : {}),
        ...(typeof note.updatedAt === "string" ? { updatedAt: note.updatedAt.slice(0, 40) } : {}) });
    }
    if (!result.hasMore) {
      if (notes.length !== total) throw Error("LOCAL_WIKI_CHANGED");
      const found = notes.filter(note => localWikiId(target)
        ? note.noteId === target : titleKey(note.title) === titleKey(target));
      if (found.length !== 1) return { kind: found.length ? "ambiguous" : "missing", notes: found };
      const actual = await client.get(found[0].noteId);
      if (actual?.noteId !== found[0].noteId || actual.title !== found[0].title) throw Error("LOCAL_WIKI_CHANGED");
      return { kind: "resolved", notes: found };
    }
    if (!result.items.length || notes.length >= total) throw Error("LOCAL_WIKI_CHANGED");
  }
  throw Error("LOCAL_WIKI_CHANGED");
}
