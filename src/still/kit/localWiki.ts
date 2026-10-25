import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { wikiSyntax, safeWikiTarget } from "./wikiSyntax.ts";
import { splitWikiHeading } from "./noteHeadings.ts";
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

export type LocalWikiNote = { managedIdentity?: boolean; noteId: string; title: string; content?: string; preview?: string; updatedAt?: string; folder?: string; historicalNames?: string[]; matchedHistoricalName?: string };
/** A bounded plain-text label from the already returned local catalog; no extra reads. */
export function localWikiPreview(value: unknown): string {
  return typeof value === "string" ? Array.from(value.slice(0, 1200).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim()).slice(0, 90).join("") : "";
}
export function localWikiChoiceDetail(note: LocalWikiNote): string {
  const preview = localWikiPreview(note.preview) || localWikiPreview(note.content);
  const folder = typeof note.folder === "string" ? `文件夹：${localWikiPreview(note.folder) || "根目录"}` : "";
  const date = typeof note.updatedAt === "string" && /^\d{4}-\d{2}-\d{2}T/.test(note.updatedAt) && Number.isFinite(Date.parse(note.updatedAt))
    ? new Date(note.updatedAt).toLocaleDateString("zh-CN") : "";
  return [folder, note.matchedHistoricalName ? `旧名称：${localWikiPreview(note.matchedHistoricalName)}` : "", preview || "暂无摘要", date ? `更新于 ${date}` : "", `编号 ${note.noteId.slice(-8)}`].filter(Boolean).join(" · ");
}
export type LocalWikiClient = {
  /** Set only by the explicit managed-vault adapter, never by catalog rows. */
  managedScope?: true;
  /** Production always supplies the atomic body-free catalog. The list adapter
   * exists only for older callers that explicitly omit this method. */
  catalog?: () => Promise<{ items: LocalWikiNote[] }>;
  list?: (options: { page: number; limit: number; sort: "name" }) => Promise<{ items: LocalWikiNote[]; total: number; hasMore: boolean }>;
  get: (noteId: string) => Promise<LocalWikiNote>;
};
export type LocalWikiResult = { kind: "resolved" | "ambiguous" | "missing"; notes: LocalWikiNote[]; heading?: string };
export function localWikiId(value: string): boolean { return /^note-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value); }
const titleKey = (title: string) => title.trim().replace(/\.md$/i, "").normalize("NFC").toLowerCase();

type Claim = { managedId?: string; name: string; folder?: string; id?: string; heading?: string };
/** Logical root-relative catalog names only, never filesystem paths. A move
 * changes the folder claim; old folders are deliberately not invented/history. */
function localWikiClaim(reference: WikiReference): Claim {
  if (!safeWikiTarget(reference.target)) throw Error("LOCAL_WIKI_UNSUPPORTED");
  const split = splitWikiHeading(reference.target);
  if (!split) throw Error("LOCAL_WIKI_ANCHOR_UNSUPPORTED");
  const { noteTarget: target, heading } = split;
  if (!target || /[\\]/.test(target) || /^[\/]/.test(target) || /[:\u0000-\u001f\u007f]/.test(target)) throw Error("LOCAL_WIKI_PATH_UNSUPPORTED");
  if (target.startsWith("@id/")) {
    const id = target.slice(4);
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw Error("LOCAL_WIKI_PATH_UNSUPPORTED");
    return { name: id, managedId: id, heading };
  }
  const qualified = target.includes("/");
  const parts: string[] = [];
  for (const part of target.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!parts.length) throw Error("LOCAL_WIKI_PATH_UNSUPPORTED"); parts.pop(); }
    else parts.push(part);
  }
  const name = parts.pop();
  if (!name || target.endsWith("/") || /(?:^|\/)\.{1,2}$/.test(target)) throw Error("LOCAL_WIKI_PATH_UNSUPPORTED");
  // Preserve the accepted ./note-ID global identity spelling. Actual folder
  // paths still constrain identity; ./ordinary-title keeps logical-root scope.
  const legacyGlobalId = localWikiId(target.replace(/^(?:\.\/)+/, ""));
  return { name, ...(qualified && !legacyGlobalId ? { folder: parts.join("/").normalize("NFC") } : {}),
    ...(localWikiId(name) ? { id: name } : {}), ...(heading !== undefined ? { heading } : {}) };
}

async function localWikiCatalog(client: LocalWikiClient): Promise<LocalWikiNote[]> {
  const seen = new Set<string>(), notes: LocalWikiNote[] = [];
  const append = (items: LocalWikiNote[], strict: boolean) => {
    if (!Array.isArray(items)) throw Error("LOCAL_WIKI_CHANGED");
    for (const note of items) {
      if (!note || !(localWikiId(note.noteId) || client.managedScope && /^[A-Za-z0-9_-]{1,160}$/.test(note.noteId)) || typeof note.title !== "string" || seen.has(note.noteId)
        || strict && (typeof note.folder !== "string" || !Array.isArray(note.historicalNames))
        || note.historicalNames !== undefined && (!Array.isArray(note.historicalNames) || note.historicalNames.some(name => typeof name !== "string"))) throw Error("LOCAL_WIKI_CHANGED");
      seen.add(note.noteId);
      const preview = strict ? "" : localWikiPreview(note.content);
      notes.push({ noteId: note.noteId, title: note.title, managedIdentity: Boolean(client.managedScope),
        ...(preview ? { preview } : {}), ...(typeof note.folder === "string" ? { folder: note.folder } : {}),
        ...(note.historicalNames ? { historicalNames: [...note.historicalNames] } : {}),
        ...(!strict && typeof note.updatedAt === "string" ? { updatedAt: note.updatedAt.slice(0, 40) } : {}) });
    }
  };
  if (client.catalog !== undefined) {
    // Never fall back after a native error or malformed snapshot.
    const result = await client.catalog(); append(result.items, true); return notes;
  }
  if (!client.list) throw Error("LOCAL_WIKI_CHANGED");
  let total: number | undefined;
  for (let page = 1; page <= 500; page++) {
    const result = await client.list({ page, limit: 200, sort: "name" });
    if (!Number.isSafeInteger(result.total) || result.total < 0 || typeof result.hasMore !== "boolean"
      || total !== undefined && total !== result.total) throw Error("LOCAL_WIKI_CHANGED");
    total = result.total; append(result.items, false);
    if (!result.hasMore) { if (notes.length !== total) throw Error("LOCAL_WIKI_CHANGED"); return notes; }
    if (!result.items.length || notes.length >= total) throw Error("LOCAL_WIKI_CHANGED");
  }
  throw Error("LOCAL_WIKI_CHANGED");
}
function matchingNotes(notes: LocalWikiNote[], claim: Claim): LocalWikiNote[] {
  if (claim.managedId) return notes.filter(note => note.managedIdentity && note.noteId === claim.managedId);
  const identity = notes.find(note => note.managedIdentity && note.noteId === claim.name);
  if (identity) return claim.folder === undefined || identity.folder === claim.folder ? [identity] : [];
  return notes.flatMap(note => {
    // A stable ID is never a title/alias claim, even when deleted.
    if (claim.folder !== undefined && (note.folder || "").normalize("NFC") !== claim.folder) return [];
    if (claim.id) return note.noteId === claim.id ? [note] : [];
    const key = titleKey(claim.name);
    if (titleKey(note.title) === key) return [note];
    const alias = note.historicalNames?.find(name => titleKey(name) === key);
    return alias !== undefined ? [{ ...note, matchedHistoricalName: alias }] : [];
  });
}
async function verifyTarget(note: LocalWikiNote, claim: Claim, client: LocalWikiClient) {
  const actual = await client.get(note.noteId);
  if (actual?.noteId !== note.noteId || !claim.id && !claim.managedId && (actual.title !== note.title
    || (actual.folder || "") !== (note.folder || ""))) throw Error("LOCAL_WIKI_CHANGED");
}
/** Complete union of current and historical title claims, never current-title
 * priority. Only stable IDs leave the resolver. */
export async function resolveLocalWiki(reference: WikiReference, client: LocalWikiClient): Promise<LocalWikiResult> {
  const claim = localWikiClaim(reference);
  const found = matchingNotes(await localWikiCatalog(client), claim);
  if (found.length !== 1) return { kind: found.length ? "ambiguous" : "missing", notes: found, heading: claim.heading };
  await verifyTarget(found[0], claim, client);
  if (client.catalog !== undefined) {
    const fresh = matchingNotes(await localWikiCatalog(client), claim);
    if (fresh.length !== 1 || fresh[0].noteId !== found[0].noteId) throw Error("LOCAL_WIKI_CHANGED");
    return { kind: "resolved", notes: fresh, heading: claim.heading };
  }
  return { kind: "resolved", notes: found, heading: claim.heading };
}
/** A chooser selects identity, not whatever now owns its former title. Recheck
 * the original claim and the displayed candidate set against a fresh snapshot. */
export async function chooseLocalWiki(reference: WikiReference, noteId: string, expectedIds: string[], client: LocalWikiClient): Promise<LocalWikiNote> {
  const claim = localWikiClaim(reference);
  const check = (found: LocalWikiNote[]) => {
    if (found.length !== expectedIds.length || found.some(note => !expectedIds.includes(note.noteId))) throw Error("LOCAL_WIKI_CHANGED");
    const selected = found.find(note => note.noteId === noteId);
    if (!selected) throw Error("LOCAL_WIKI_CHANGED"); return selected;
  };
  const selected = check(matchingNotes(await localWikiCatalog(client), claim));
  await verifyTarget(selected, claim, client);
  return client.catalog !== undefined ? check(matchingNotes(await localWikiCatalog(client), claim)) : selected;
}

/** Display hint from one body-free catalog snapshot, never navigation authority.
 * Opening and chooser acceptance still use the fresh verified resolver above. */
export function localWikiDisplayStatus(reference: WikiReference, notes: LocalWikiNote[]): "resolved" | "missing" | "ambiguous" | "unknown" {
  try {
    const claim = localWikiClaim(reference);
    const matches = matchingNotes(notes, claim);
    return matches.length === 1 ? "resolved" : matches.length > 1 ? "ambiguous" : "missing";
  } catch { return "unknown"; }
}

/** Snapshot-only backlink identity. Ambiguous names are never asserted as an
 * incoming link; actual navigation still performs resolveLocalWiki checks. */
export function localWikiResolvedId(reference: WikiReference, notes: LocalWikiNote[]): string | null {
  try { const matches = matchingNotes(notes, localWikiClaim(reference)); return matches.length === 1 ? matches[0].noteId : null; }
  catch { return null; }
}
