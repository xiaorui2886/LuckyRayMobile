/** A textarea cannot safely replace a focused editing buffer's undo/IME
 * history. Unchanged bytes may certify a newer revision; different bytes
 * wait for blur/read mode. The native save carries the displayed revision. */
export function canAdoptKnowledgeBody(input: {
  current: boolean; sameGeneration: boolean; pending: number; failed: boolean;
  editing: boolean; focused: boolean; composing: boolean;
  draft: {title: string; content: string}; incoming: {title: string; content: string};
}): boolean {
  if (!input.current || !input.sameGeneration || input.pending > 0 || input.failed || input.composing) return false;
  const unchanged = input.draft.title === input.incoming.title && input.draft.content === input.incoming.content;
  return unchanged || !input.editing || !input.focused;
}
