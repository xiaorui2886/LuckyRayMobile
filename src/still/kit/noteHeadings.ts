import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { wikiSyntax } from "./wikiSyntax.ts";

export type NoteHeading = { id: string; label: string; depth: number; from: number; to: number; line: number };
type HeadingNode = { type: string; value?: string; alt?: string; depth?: number; children?: HeadingNode[];
  position?: { start: { offset?: number; line: number }; end: { offset?: number } } };
const parser = unified().use(remarkParse).use(remarkGfm);
const labelKey = (value: string) => value.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
function visibleText(node: HeadingNode): string {
  if (node.type === "html") return "";
  if (node.type === "image" || node.type === "imageReference") return node.alt || "";
  if (node.children) return node.children.map(visibleText).join("");
  return node.value || "";
}
/** Unicode is retained, punctuation removed; IDs are internal navigation keys,
 * never DOM selectors or paths. Duplicate suffixes are unique even when the
 * document already contains a literal heading ending in -1. */
export function headingSlug(label: string): string {
  return labelKey(label).replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "").replace(/\s/gu, "-") || "section";
}
/** Parse actual Markdown blocks, including setext and nested headings. Fences,
 * indented code, escaped markers, HTML and inline code cannot invent headings. */
export function noteHeadings(body: string): NoteHeading[] {
  const result: NoteHeading[] = [], used = new Set<string>();
  const visit = (node: HeadingNode) => {
    if (node.type === "heading") {
      const from = node.position?.start.offset, to = node.position?.end.offset;
      if (typeof from !== "number" || typeof to !== "number") return;
      const label = visibleText(node).trim().replace(/\s+/gu, " ");
      const base = headingSlug(label); let id = base, suffix = 0;
      while (used.has(id)) id = `${base}-${++suffix}`;
      used.add(id);
      result.push({ id, label, depth: node.depth!, from, to, line: node.position!.start.line });
      return;
    }
    node.children?.forEach(visit);
  };
  const processor = parser().use(wikiSyntax(body, new Map()));
  visit(processor.runSync(processor.parse(body)) as HeadingNode);
  return result;
}
/** Literal labels win over slug spellings; repeated labels select the first
 * occurrence. Its unique slug (e.g. section-1) selects a later occurrence.
 * Decode at most once, and only after an exact literal match fails. */
export function resolveNoteHeading(headings: NoteHeading[], fragment: string): NoteHeading | undefined {
  const match = (value: string) => headings.find(item => labelKey(item.label) === labelKey(value))
    || headings.find(item => item.id === labelKey(value));
  if (!fragment.trim()) return;
  const literal = match(fragment); if (literal) return literal;
  try { const decoded = decodeURIComponent(fragment); return decoded === fragment ? undefined : match(decoded); }
  catch { return undefined; }
}
/** Split only the first #. Preserve note spelling for the existing exact-scope
 * resolver and reject empty anchors rather than silently opening the top. */
export function splitWikiHeading(target: string): { noteTarget: string; heading?: string } | undefined {
  const at = target.indexOf("#");
  if (at < 0) return { noteTarget: target };
  const heading = target.slice(at + 1).trim();
  if (!heading || /[\u0000-\u001f\u007f]/.test(heading)) return;
  return { noteTarget: target.slice(0, at).trim(), heading };
}
/** Reader offsets refer to original source; CodeMirror normalizes line ends. */
export function headingEditorOffset(source: string, editorBody: string, offset: number): number | undefined {
  if (!Number.isInteger(offset) || offset < 0 || offset > source.length) return;
  if (source === editorBody) return offset;
  if (source.replace(/\r\n?/g, "\n") !== editorBody) return;
  return source.slice(0, offset).replace(/\r\n?/g, "\n").length;
}
