import type { EditingEffects, EditingScope } from "./knowledgeEditingSession.ts";
import type { KnowledgeClient } from "./companionServices/knowledgeClient.ts";
import type { ServiceRegistry } from "./companionServices/serviceRegistry.ts";
import { ServicesError } from "./companionServices/transport.ts";

/** Thin composition over the existing client/registry; no transport or outbox. */
export function createKnowledgeEditingEffects(deps: {
  knowledge: KnowledgeClient;
  registry: ServiceRegistry;
  isLive: (scope: EditingScope) => boolean;
  observe: EditingEffects["observe"];
}): EditingEffects {
  let refreshing: Promise<unknown> | null = null;
  const current = (scope: EditingScope) => {
    if (!deps.isLive(scope)) throw new ServicesError("SOURCE_CHANGED", 409);
  };
  const refresh = async (scope: EditingScope) => {
    current(scope);
    if (!refreshing) {
      const request = deps.registry.refreshAdopting(scope.instance).finally(() => {
        if (refreshing === request) refreshing = null;
      });
      refreshing = request;
    }
    await refreshing;
    current(scope);
  };
  const ready = async (scope: EditingScope, operation: string, fresh = false) => {
    current(scope);
    if (fresh || deps.registry.snapshot()?.desktopInstanceId !== scope.instance) await refresh(scope);
    current(scope);
    if (deps.registry.snapshot()?.services?.knowledge?.version !== 1) throw new ServicesError("VERSION_UNSUPPORTED", 426);
    const state = deps.registry.operation(operation).state;
    if (state === "implemented") return;
    if (state === "notGranted") throw new ServicesError("GRANT_REQUIRED", 403);
    if (state === "temporarilyUnavailable") throw new ServicesError("SERVICE_UNAVAILABLE", 503);
    throw new ServicesError("VERSION_UNSUPPORTED", 426);
  };
  return {
    async open(scope) {
      await ready(scope, "knowledge.editingOpen");
      await ready(scope, "knowledge.editingSet");
      current(scope);
      const lease = await deps.knowledge.editingOpen(scope.instance, scope.vault, scope.note);
      current(scope);
      return lease.sessionId;
    },
    async readDesktop(scope) {
      // Refresh at the helper's existing5s read cadence, including revocation.
      await ready(scope, "knowledge.editing", true);
      const status = await deps.knowledge.editing(scope.instance, scope.vault, scope.note);
      current(scope);
      return status.desktopEditing;
    },
    async publish(scope, sessionId, generation, editing) {
      if (!editing) {
        // Cleanup may retire the page immediately after this call. Send only
        // this captured token's release synchronously up to the transport await;
        // native owner fences and the server's token scope remain authoritative.
        current(scope);
        if (deps.registry.snapshot()?.desktopInstanceId !== scope.instance
          || deps.registry.snapshot()?.services?.knowledge?.version !== 1 || !deps.registry.canCall("knowledge.editingSet")) return;
        await deps.knowledge.editingSet(scope.instance, scope.note, { vaultId: scope.vault, sessionId, generation, editing });
        return;
      }
      await ready(scope, "knowledge.editingSet");
      current(scope);
      const receipt = await deps.knowledge.editingSet(scope.instance, scope.note, { vaultId: scope.vault, sessionId, generation, editing });
      current(scope);
      return receipt.generation === generation && receipt.editing === editing;
    },
    observe(scope, editing) { if (deps.isLive(scope)) deps.observe(scope, editing); },
  };
}
