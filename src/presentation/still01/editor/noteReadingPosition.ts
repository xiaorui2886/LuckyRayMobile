import type { EditorView } from "@codemirror/view";

/** A source position in the visible body, never the (possibly offscreen) caret. */
export type NoteReadingAnchor = { offset: number; viewportFraction: number; atStart: boolean };

/** CM normalizes CRLF/CR to LF. The reader still parses the original body,
 * so map offsets back only when line-ending normalization is the sole change.
 */
export function readingSourceOffset(editorBody: string, body: string, offset: number): number | undefined {
  let result = Math.max(0, Math.min(editorBody.length, offset));
  if (editorBody === body) return result;
  if (body.replace(/\r\n?/g, "\n") !== editorBody) return;
  for (let at = body.indexOf("\r\n"); at >= 0 && at < result; at = body.indexOf("\r\n", at + 2)) result += 1;
  return result;
}

export function captureReadingAnchor(view: EditorView): NoteReadingAnchor | undefined {
  if (!view.dom.isConnected) return;
  const scroller = view.scrollDOM.getBoundingClientRect();
  const paper = view.dom.closest<HTMLElement>(".st-note-paper");
  const paperBox = paper?.getBoundingClientRect() ?? scroller;
  const top = Math.max(scroller.top, paperBox.top), bottom = Math.min(scroller.bottom, paperBox.bottom);
  if (bottom <= top || scroller.width <= 0) return;
  const y = top + (bottom - top) / 2;
  const offset = view.posAtCoords({ x: scroller.left + Math.min(16, scroller.width / 2), y });
  if (offset === null) return;
  const box = view.coordsAtPos(offset);
  return { offset, viewportFraction: Math.max(0, Math.min(1, ((box?.top ?? y) - top) / (bottom - top))),
    atStart: view.scrollDOM.scrollTop <= 1 && (paper?.scrollTop ?? 0) <= 1 };
}

/** Preserve the exact original split and rendering, with unambiguous offsets. */
export function plainReadingBlocks(body: string): { text: string; from: number; to: number }[] {
  let from = 0;
  return body.split("\n\n").map(text => {
    const block = { text, from, to: from + text.length };
    from = block.to + 2;
    return block;
  });
}

type SourceNode = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>;
  position?: { start: { offset?: number }; end: { offset?: number } }; children?: SourceNode[] };
function sourceOffsets(node: SourceNode) {
  const from = node.position?.start.offset, to = node.position?.end.offset;
  return typeof from === "number" && typeof to === "number" && from >= 0 && to >= from
    ? { "data-note-source-start": from, "data-note-source-end": to } : undefined;
}

/** Rehype metadata only: use parser positions, never parse HTML or rewrite URLs.
 * Text spans retain exact repeated-text identity and wrapped-line geometry.
 * Whitespace-only/generated nodes stay untouched (including table separators).
 */
export function readingSourcePositions() {
  return (tree: SourceNode) => {
    const visit = (node: SourceNode) => {
      const offsets = sourceOffsets(node);
      if (node.type === "element" && offsets) node.properties = { ...node.properties, ...offsets };
      if (!node.children) return;
      node.children = node.children.map(child => {
        const position = sourceOffsets(child);
        if (child.type === "text" && child.value?.trim() && position) {
          return { type: "element", tagName: "span", properties: position, children: [child] };
        }
        visit(child);
        return child;
      });
    };
    visit(tree);
  };
}

/** Resolve in the rendered reader, whose height is independent of CM's height. */
export function restoreReadingAnchor(root: HTMLElement, anchor: NoteReadingAnchor): boolean {
  const paper = root.closest<HTMLElement>(".st-note-paper");
  if (!paper) return false;
  if (anchor.atStart) { paper.scrollTop = 0; return true; }
  let target: HTMLElement | undefined, bestDistance = Infinity, bestLength = Infinity;
  for (const element of root.querySelectorAll<HTMLElement>("[data-note-source-start][data-note-source-end]")) {
    const from = Number(element.dataset.noteSourceStart), to = Number(element.dataset.noteSourceEnd);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) continue;
    const distance = Math.max(from - anchor.offset, anchor.offset - to, 0);
    if (distance < bestDistance || distance === bestDistance && to - from < bestLength) {
      target = element; bestDistance = distance; bestLength = to - from;
    }
  }
  if (!target) return false;
  const from = Number(target.dataset.noteSourceStart), to = Number(target.dataset.noteSourceEnd);
  const fraction = Math.max(0, Math.min(1, (anchor.offset - from) / Math.max(1, to - from)));
  let y = target.getBoundingClientRect().top;
  // The smallest source span normally contains one literal text node. Ranges
  // handle wrapping; a percentage of the paragraph's height would not.
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  let remaining = Math.min(Math.max(0, (target.textContent?.length ?? 0) - 1),
    Math.floor(fraction * (target.textContent?.length ?? 0)));
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (remaining >= length) { remaining -= length; continue; }
    const range = document.createRange();
    range.setStart(node, remaining); range.setEnd(node, remaining + 1);
    const box = range.getClientRects()[0];
    if (box) y = box.top;
    break;
  }
  const viewport = paper.getBoundingClientRect();
  paper.scrollTop += y - viewport.top - viewport.height * anchor.viewportFraction;
  return true;
}
