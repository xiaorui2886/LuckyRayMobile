import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { wikiSyntax } from "./wikiSyntax.ts";
import type { WikiReference } from "./knowledgeRelations.ts";

export interface ManagedWikiParseInput { sourceNoteId: string; sourceSha256: string; content: string }
export interface ManagedWikiProof {
  sourceNoteId: string;
  sourceSha256: string;
  spans: Array<{ startByte: number; endByte: number; token: string }>;
  resourceIssues: string[];
}
const external = (url: string) => /^(?:https?:|mailto:|tel:)/i.test(url) || url.startsWith("#");
/** Parser evidence only. Native validates the source hash and exact byte spans,
 * resolves identities and owns rewriting. Never send frontend rewritten text. */
export function managedWikiProof(input: ManagedWikiParseInput): ManagedWikiProof {
  const references = new Map<string, WikiReference>();
  const parser = unified().use(remarkParse).use(remarkGfm).use(wikiSyntax(input.content, references));
  const tree: any = parser.runSync(parser.parse(input.content));
  const issues = new Set<string>();
  const definitions = new Map<string, string>();
  const collect = (node: any) => {
    if (node.type === "definition") definitions.set(String(node.identifier).toLowerCase(), String(node.url));
    for (const child of node.children ?? []) collect(child);
  };
  collect(tree);
  const visit = (node: any) => {
    if (node.type === "code" || node.type === "inlineCode") return;
    if (["image", "link", "imageReference", "linkReference"].includes(node.type)) {
      const url = node.url ?? definitions.get(String(node.identifier).toLowerCase());
      if (!url || !external(url)) issues.add(`local-resource:${node.position?.start?.offset ?? 0}`);
    }
    // Raw HTML is opaque to the Markdown parser. Resource-bearing HTML cannot
    // be proven portable here; do not reinterpret or rewrite it.
    if (node.type === "html" && /\b(?:src|href|srcset|poster|data)\s*=|<(?:img|video|audio|source|object|embed|iframe|script|link|style)\b|\burl\s*\(/i.test(node.value)) issues.add(`html-resource:${node.position?.start?.offset ?? 0}`);
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  // Markdown represents inline HTML delimiters and their contents as siblings,
  // not an HTML subtree. Do not pretend a wiki token in such a mixed run is a
  // proven Markdown link: leave the source intact and require explicit review.
  const opaqueRanges: Array<[number, number]> = [];
  const mixedHtml = (node: any) => {
    if (["paragraph", "heading", "tableCell"].includes(node.type) && node.children?.some((child: any) => child.type === "html")) {
      const from = node.position?.start?.offset, to = node.position?.end?.offset;
      if (typeof from === "number" && typeof to === "number" && [...references.values()].some(ref => ref.from >= from && ref.to <= to)) {
        opaqueRanges.push([from, to]); issues.add(`mixed-html-wiki:${from}`);
      }
    }
    for (const child of node.children ?? []) mixedHtml(child);
  };
  mixedHtml(tree);
  const encoder = new TextEncoder();
  return { sourceNoteId: input.sourceNoteId, sourceSha256: input.sourceSha256,
    spans: [...references.values()].filter(ref => !opaqueRanges.some(([from, to]) => ref.from >= from && ref.to <= to)).map(ref => ({
      startByte: encoder.encode(input.content.slice(0, ref.from)).length,
      endByte: encoder.encode(input.content.slice(0, ref.to)).length,
      token: input.content.slice(ref.from, ref.to),
    })).sort((a, b) => a.startByte - b.startByte), resourceIssues: [...issues] };
}
