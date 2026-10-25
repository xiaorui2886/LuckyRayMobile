import { decodedSource } from './wikiSyntax.ts';
import { markdownSourcePosition } from "./markdownSourcePosition.ts";

type Point = { offset: number; line: number; column: number };
type Ast = { type: string; value?: string; children?: Ast[]; position?: { start: Point; end: Point }; data?: Record<string, unknown> };
const excluded = new Set(['code', 'inlineCode', 'html', 'image', 'imageReference', 'definition', 'highlight']);

function escaped(raw: string, offset: number) {
  let n = 0; while (offset > 0 && raw[--offset] === '\\') n++;
  return n % 2 === 1;
}
/** Shared reader/editor AST transform. Delimiters must be literal source ==,
 * never escaped/entity-decoded equals. Does not rewrite the stored Markdown.
 * Matching stays inside one inline parent; code/HTML/destinations are untouched.
 */
export function highlightSyntax(source: string) {
  return () => (tree: Ast) => transformHighlights(tree, source);
}
export function remarkHighlight() {
  return (tree: Ast, file: { value?: unknown }) => transformHighlights(tree, String(file?.value ?? ''));
}
export function transformHighlights(tree: Ast, source: string): void {
  const point = markdownSourcePosition(source);
  const visit = (parent: Ast) => {
    if (excluded.has(parent.type) || !parent.children) return;
    parent.children.forEach(visit);
    const pieces: { node: Ast; delimiter?: boolean }[] = [];
    for (const child of parent.children) {
      const from = child.position?.start.offset, end = child.position?.end.offset;
      if (child.type !== 'text' || from === undefined || end === undefined) { pieces.push({ node: child }); continue; }
      const raw = source.slice(from, end), value = child.value ?? '', map = decodedSource(raw, value);
      if (!map) { pieces.push({ node: child }); continue; }
      let consumed = 0;
      const text = (start: number, stop: number): Ast => ({ type: 'text', value: value.slice(start, stop), position: { start: point(from + map[start]), end: point(from + map[stop]) } });
      for (let i = 0; i < value.length - 1; i++) {
        if (value.slice(i, i + 2) !== '==' || value[i - 1] === '=' || value[i + 2] === '=') continue;
        const at = map[i], stop = map[i + 2];
        if (raw.slice(at, stop) !== '==' || escaped(raw, at)) continue;
        if (i > consumed) pieces.push({ node: text(consumed, i) });
        pieces.push({ node: text(i, i + 2), delimiter: true });
        consumed = i + 2; i++;
      }
      if (consumed < value.length) pieces.push({ node: text(consumed, value.length) });
      else if (!consumed) pieces.push({ node: child });
    }
    const output: Ast[] = [];
    for (let i = 0; i < pieces.length; i++) {
      if (!pieces[i].delimiter) { output.push(pieces[i].node); continue; }
      let close = i + 1;
      while (close < pieces.length && !pieces[close].delimiter) close++;
      const start = pieces[i].node.position!, finish = pieces[close]?.node.position;
      const content = finish ? source.slice(start.end.offset, finish.start.offset) : '';
      if (!finish || !content.trim() || /^\s|\s$/.test(content)) { output.push(pieces[i].node); continue; }
      output.push({ type: 'highlight', children: pieces.slice(i + 1, close).map(p => p.node),
        position: { start: start.start, end: finish.end }, data: { hName: 'mark' } });
      i = close;
    }
    parent.children = output;
  };
  visit(tree);
}
