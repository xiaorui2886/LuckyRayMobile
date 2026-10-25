/** Bounded metadata-only tracing for an explicitly opted-in QA build.
 * Never serialize a request, response, URL, query, note, name or credential. */
import { CANONICAL_REMOTE_CODES } from "./transport.ts";

const OPERATIONS = new Set([
  "services.discover", "knowledge.vaults", "knowledge.registeredList",
  "knowledge.directories", "knowledge.registeredChanges", "knowledge.editing",
  "knowledge.relations", "knowledge.materialReferences",
]);
export type KnowledgeTraceOutcome = {
  phase: "reply" | "refusal" | "invalid-reply";
  status: number;
  code?: string;
  body?: unknown;
};
/** Release WebViews need not forward console.info. Reuse the existing native
 * log command; only the already-sanitized bounded line enters this sink. */
export function nativeKnowledgeTraceSink(invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>) {
  return (line: string) => { void invoke("mq_log", {msg: line}).catch(() => {}); };
}
function scopeRef(value: string): string {
  let hash = 2166136261;
  for (const char of value.slice(0, 256)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}
export function createKnowledgeDiagnostics(enabled: boolean, options: {
  sink?: (line: string) => void; now?: () => number; limit?: number;
} = {}) {
  const sink = options.sink ?? (line => console.info(line));
  const now = options.now ?? Date.now;
  const limit = Math.max(0, Math.min(1000, options.limit ?? 1000));
  let count = 0, sequence = 0;
  const emit = (value: Record<string, unknown>) => {
    if (count >= limit) return;
    count++;
    try { sink("[LR-KNOW-DIAG] " + JSON.stringify(value)); } catch { /* diagnostics cannot fail a request */ }
  };
  return {
    begin(operation: string, vault?: string): (outcome: KnowledgeTraceOutcome) => void {
      if (!enabled || !OPERATIONS.has(operation) || count >= limit) return () => {};
      const start = now(), id = ++sequence;
      const common = {id, operation, scope: vault ? "explicit" : "unselected", targetRef: vault ? scopeRef(vault) : null};
      emit({...common, phase: "request", atUTC: new Date(start).toISOString()});
      return outcome => {
        const at = now();
        const metadata: Record<string, boolean> = {};
        // This is live catalog metadata, never cached rows or a guessed active vault.
        if (operation === "knowledge.vaults" && vault && outcome.status >= 200 && outcome.status < 300) {
          const items = (outcome.body as {items?: unknown} | null)?.items;
          if (Array.isArray(items)) {
            const selected = items.find(item => item && typeof item === "object" && item.vaultId === vault);
            metadata.selectedTargetFound = Boolean(selected);
            if (selected && typeof selected.activeInDesktop === "boolean") metadata.selectedIsDesktopActive = selected.activeInDesktop;
          }
        }
        const code = outcome.code && ([...CANONICAL_REMOTE_CODES, "TRANSPORT_FAILED", "MALFORMED_RESPONSE"] as readonly string[]).includes(outcome.code)
          ? outcome.code : outcome.code ? "UNKNOWN" : null;
        emit({...common, phase: outcome.phase, atUTC: new Date(at).toISOString(), elapsedMs: Math.max(0, at - start),
          httpStatus: Number.isInteger(outcome.status) && outcome.status >= 100 && outcome.status <= 599 ? outcome.status : 0,
          code, ...metadata});
      };
    },
  };
}
