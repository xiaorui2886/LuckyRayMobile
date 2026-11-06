/** Candidate-only, opt-in timing. No arguments, data, identifiers or errors are retained.
 * Normal builds fold the gate away. The bounded memory ring flushes only when
 * leaving the app; no per-frame console I/O or additional native polling. */
export const graphQaTimingEnabled = import.meta.env?.VITE_LUCKYRAY_GRAPH_TIMING === '1';
type Row = { command: string; start: number; end: number; status: 'ok' | 'fail' };
const ring: Row[] = [];
const cap = 8192;
const now = () => performance.timeOrigin + performance.now();
export function graphQaStart(): number { return graphQaTimingEnabled ? now() : 0; }
export function graphQaEnd(command: string, start: number, ok = true): void {
  if (!graphQaTimingEnabled || !start) return;
  // Callers supply static operation names only. Native args/results never enter here.
  if (!/^[a-zA-Z0-9_.:|]+$/.test(command)) return;
  if (ring.length === cap) ring.shift();
  ring.push({ command, start, end: now(), status: ok ? 'ok' : 'fail' });
}
export async function graphQaSpan<T>(command: string, work: () => Promise<T>): Promise<T> {
  const start = graphQaStart();
  try { const value = await work(); graphQaEnd(command, start); return value; }
  catch (error) { graphQaEnd(command, start, false); throw error; }
}
/** Build-time SDK adapter only. Never assign to Tauri's immutable bridge. */
export function graphQaInvoke(original: (...args: unknown[]) => Promise<unknown>, ...args: unknown[]): Promise<unknown> {
  const start = graphQaStart(), command = typeof args[0] === 'string' ? args[0] : 'unknown';
  try {
    return original(...args).then(value => { graphQaEnd('invoke.' + command, start); return value; }, error => { graphQaEnd('invoke.' + command, start, false); throw error; });
  } catch (error) { graphQaEnd('invoke.' + command, start, false); throw error; }
}
if (graphQaTimingEnabled && typeof window !== 'undefined') {
  document.addEventListener('visibilitychange', async () => {
    if (!document.hidden) return;
    // Android release deliberately suppresses WebChromeClient console logs.
    // Reuse the existing local log command only after the activity is hidden.
    // Read the immutable bridge; never replace it. Payload is this allowlisted
    // metadata, not an observed command's arguments or response.
    const internal = (window as unknown as { __TAURI_INTERNALS__?: { invoke: (command: string, args: {msg: string}) => Promise<unknown> } }).__TAURI_INTERNALS__;
    if (!internal) return;
    const batch = ring.splice(0), start = graphQaStart();
    try {
      while (batch.length) await internal.invoke('mq_log', {msg: '[LR-GRAPH-META] ' + JSON.stringify(batch.splice(0, 12))});
      await internal.invoke('mq_log', {msg: '[LR-GRAPH-META] ' + JSON.stringify([{command:'diagnostics.flush',start,end:now(),status:'ok'}])});
    } catch { /* Diagnostic export never changes app state or a command result. */ }
  });
}
