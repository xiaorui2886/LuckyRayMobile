import { decodedSource } from "./wikiSyntax.ts";
import type { BodyRange } from "./noteSearch.ts";

/** Highlight parsed text using the existing Markdown source-atom mapping.
 * Never search/replace HTML, rendered text globally, URLs or generated labels.
 */
export function readingFindPositions(body: string, ranges: BodyRange[], current: number) {
  return () => (tree: any) => {
    const visit = (node: any) => {
      if (!Array.isArray(node.children)) return;
      node.children = node.children.flatMap((child: any) => {
        if (child.type !== "text") { visit(child); return [child]; }
        const from = child.position?.start?.offset, to = child.position?.end?.offset;
        if (typeof from !== "number" || typeof to !== "number" || from < 0 || to > body.length) return [child];
        const text = String(child.value), boundaries = decodedSource(body.slice(from, to), text);
        if (!boundaries) return [child];
        const out: any[] = []; let consumed = 0;
        ranges.forEach((range, index) => {
          const start = Math.max(from, range.from), end = Math.min(to, range.to);
          if (end <= start) return;
          const a = boundaries.indexOf(start - from), b = boundaries.lastIndexOf(end - from);
          if (a < consumed || b <= a) return;
          if (a > consumed) out.push({ type: "text", value: text.slice(consumed, a) });
          out.push({ type: "element", tagName: "mark", properties: {
            className: ["st-note-find-hit", ...(index === current ? ["is-current"] : [])],
            "data-note-source-start": start, "data-note-source-end": end,
          }, children: [{ type: "text", value: text.slice(a, b) }] });
          consumed = b;
        });
        if (!out.length) return [child];
        if (consumed < text.length) out.push({ type: "text", value: text.slice(consumed) });
        return out;
      });
    };
    visit(tree);
  };
}
