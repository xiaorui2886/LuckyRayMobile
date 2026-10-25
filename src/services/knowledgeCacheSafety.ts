/** Session-local unresolved editor writes outlive unmount; a failed write never permits cache erasure. */
const writes = new Map<string, { sequence: number; pending: number; failed: boolean }>();
export function trackKnowledgeWrite(scope: string, promise: Promise<boolean>): void {
  const state = writes.get(scope) || { sequence: 0, pending: 0, failed: false };
  writes.set(scope, state); const sequence = ++state.sequence; state.pending++;
  void promise.then(ok => { if (sequence === state.sequence) state.failed = !ok; }, () => { if (sequence === state.sequence) state.failed = true; }).finally(() => {
    state.pending--; if (!state.pending && !state.failed) writes.delete(scope);
  });
}
export function knowledgeCacheClearBlocked(): boolean { return [...writes.values()].some(state => state.pending > 0 || state.failed); }
