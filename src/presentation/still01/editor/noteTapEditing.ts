/** An explicit body tap, scoped to the exact retained editor owner. Opening
 * a route or restoring a retained view never creates one of these requests. */
export type NoteBodyFocusRequest = { scope: string; offset: number };
const consumedFocusRequests = new WeakSet<NoteBodyFocusRequest>();

/** Intent identity, not view identity: eviction/recreation cannot replay a tap. */
export function consumeBodyFocusRequest(request: NoteBodyFocusRequest | undefined, scope: string): boolean {
  if (!request || request.scope !== scope || consumedFocusRequests.has(request)) return false;
  consumedFocusRequests.add(request);
  return true;
}

/** DOM offsets and CM positions are UTF-16; CM alone normalizes CR/CRLF. */
export function editorOffsetAtSource(body: string, offset: number): number {
  let at = Math.max(0, Math.min(body.length, offset));
  // A rendered glyph must not place the caret inside a surrogate pair.
  if (at > 0 && /[\uD800-\uDBFF]/.test(body[at - 1]) && /[\uDC00-\uDFFF]/.test(body[at] ?? "")) at--;
  return body.slice(0, at).replace(/\r\n?/g, "\n").length;
}

/** Links, media and controls keep their ordinary reading actions. */
export function isReadingControl(target: Element | null, root: HTMLElement): boolean {
  const control = target?.closest('a,button,input,textarea,select,video,audio,img,[role="button"],[contenteditable="true"]');
  return Boolean(control && root.contains(control));
}

/** Resolve the browser's tapped text position using the reader's existing
 * source markers. Repeated text is never searched globally. Transformed
 * Markdown text (entities/escapes) uses the same bounded span approximation
 * as the accepted editor→reader handoff. Blank space uses its closest block.
 */
export function readingOffsetAtPoint(root: HTMLElement, body: string, x: number, y: number): number {
  const doc = root.ownerDocument as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = doc.caretPositionFromPoint?.(x, y);
  const range = position ? null : doc.caretRangeFromPoint?.(x, y);
  const node = position?.offsetNode ?? range?.startContainer;
  const offset = position?.offset ?? range?.startOffset ?? 0;
  const element = node?.nodeType === 1 ? node as Element : node?.parentElement;
  const marker = element?.closest<HTMLElement>("[data-note-source-start][data-note-source-end]");
  if (node && marker && root.contains(marker)) {
    const from = Number(marker.dataset.noteSourceStart), to = Number(marker.dataset.noteSourceEnd);
    if (Number.isFinite(from) && Number.isFinite(to) && from >= 0 && to >= from && to <= body.length) {
      const before = doc.createRange();
      before.selectNodeContents(marker); before.setEnd(node, offset);
      const rendered = marker.textContent ?? "", prefixLength = before.toString().length;
      const source = body.slice(from, to);
      const relative = source === rendered ? prefixLength
        : Math.round(prefixLength / Math.max(1, rendered.length) * source.length);
      return Math.max(from, Math.min(to, from + relative));
    }
  }
  let closest = 0, distance = Infinity;
  for (const span of root.querySelectorAll<HTMLElement>("[data-note-source-start][data-note-source-end]")) {
    const box = span.getBoundingClientRect();
    const gap = Math.max(box.top - y, y - box.bottom, 0);
    const candidate = Number(y > box.bottom ? span.dataset.noteSourceEnd : span.dataset.noteSourceStart);
    if (Number.isFinite(candidate) && candidate >= 0 && candidate <= body.length && gap < distance) {
      distance = gap; closest = candidate;
    }
  }
  return closest;
}
