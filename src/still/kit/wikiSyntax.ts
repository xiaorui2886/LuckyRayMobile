import type { WikiReference } from "./knowledgeRelations.ts";
import { decodeString } from "micromark-util-decode-string";

type Position = { offset: number; line: number; column: number };
/** Resolver text only, never a path to open. The Desktop resolves relative
 * ./ and ../ references against the source note and enforces the vault root. */
export function safeWikiTarget(target: string): boolean {
  return Boolean(target) && new TextEncoder().encode(target).length <= 1024
    && !/^[\\/]|[:\u0000-\u001f\u007f]/.test(target);
}
function escaped(raw: string, at: number): boolean {
  let count = 0; while (at > 0 && raw[--at] === "\\") count++;
  return count % 2 === 1;
}
function position(source: string, at: number): Position {
  const before = source.slice(0, at), lines = before.split(/\r\n|\r|\n/);
  return { offset: at, line: lines.length, column: lines[lines.length - 1].length + 1 };
}
/** Map Markdown-decoded text boundaries back to their exact source atoms.
 * A transformed token is kept literal; neighboring plain tokens still work. */
export function decodedSource(raw: string, text: string): number[] | null {
  const atoms = /\\[!-/:-@[-`{-~]|&(?:#(?:\d{1,7}|x[\da-f]{1,6})|[\da-z]{1,31});|\r\n?|[\s\S]/gi;
  const boundaries = [0]; let decoded = "";
  for (const match of raw.matchAll(atoms)) {
    const start = match.index!, atom = match[0], value = decodeString(atom);
    // Interior entity boundaries are deliberately source-start, so a token
    // beginning within an expansion cannot be mistaken for literal source.
    for (let i = 0; i < value.length; i++) boundaries.push(i === value.length - 1 ? start + atom.length : start);
    decoded += value;
  }
  return decoded === text ? boundaries : null;
}
/** Operates on parsed text, not Markdown source globally: code, raw HTML,
 * existing links and images keep their own meaning. Exact source ranges on
 * every new node preserve accepted reader→editor and editor→reader mapping.
 */
export function wikiSyntax(source: string, references: Map<string, WikiReference>) {
  return () => (tree: any) => {
    const visit = (node: any) => {
      if (["code", "inlineCode", "html", "link", "linkReference", "image", "imageReference"].includes(node.type) || !Array.isArray(node.children)) return;
      node.children = node.children.flatMap((child: any) => {
        if (child.type !== "text") { visit(child); return [child]; }
        const from = child.position?.start?.offset, to = child.position?.end?.offset;
        if (typeof from !== "number" || typeof to !== "number") return [child];
        const raw = source.slice(from, to), text = String(child.value), out: any[] = [];
        const boundaries = decodedSource(raw, text);
        if (!boundaries) return [child];
        let consumedText = 0, consumedRaw = 0;
        const span = (type: string, value: string, start: number, end: number) => ({ type, value,
          position: { start: position(source, from + start), end: position(source, from + end) } });
        for (const match of text.matchAll(/!?\[\[([^\]\n\r]+)\]\]/g)) {
          const value = match[0], index = match.index!;
          const at = boundaries[index], end = boundaries[index + value.length];
          // Never pair an entity-decoded token with a later literal token.
          if (raw.slice(at, end) !== value) continue;
          if (escaped(raw, at)) continue;
          const embed = value.startsWith("!");
          const [destination, ...aliases] = match[1].split("|");
          const target = destination.trim(), label = aliases.join("|").trim() || target;
          if (!embed && !safeWikiTarget(target)) continue;
          if (index > consumedText) out.push(span("text", text.slice(consumedText, index), consumedRaw, at));
          const tokenPosition = { start: position(source, from + at), end: position(source, from + at + value.length) };
          if (embed) out.push({ type: "image", url: target, alt: label, position: tokenPosition });
          else {
            const ref: WikiReference = { target, label, line: tokenPosition.start.line, from: from + at, to: from + at + value.length,
              heading: target.includes("#") ? target.slice(target.indexOf("#") + 1) : undefined };
            const url = `#luckyray-wiki-${ref.from}`; references.set(url, ref);
            out.push({ type: "link", url, position: tokenPosition,
              data: { hProperties: { "data-wiki-start": ref.from } },
              children: [{ type: "text", value: label, position: tokenPosition }] });
          }
          consumedText = index + value.length; consumedRaw = end;
        }
        if (!out.length) return [child];
        if (consumedText < text.length) out.push(span("text", text.slice(consumedText), consumedRaw, raw.length));
        return out;
      });
    };
    visit(tree);
  };
}
