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
  const ownerFor = (scope: EditingScope) => deps.registry.forScope?.(scope.instance, {vault: scope.vault}) ?? deps.registry;
  const current = (scope: EditingScope) => {
    if (!deps.isLive(scope)) throw new ServicesError("SOURCE_CHANGED", 409);
  };
  const ready = async (scope: EditingScope, operation: string) => {
    current(scope);
    const owner = ownerFor(scope);
    if (owner.ensureAdopting) await owner.ensureAdopting(scope.instance, {vault: scope.vault});
    else if (owner.snapshot()?.desktopInstanceId !== scope.instance || owner.scopeMatches?.({vault:scope.vault}) === false)
      await owner.refreshAdopting(scope.instance, {vault:scope.vault});
    current(scope);
    if (owner.snapshot()?.services?.knowledge?.version !== 1) throw new ServicesError("VERSION_UNSUPPORTED", 426);
    const state = owner.operation(operation).state;
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
      // Presence reads remain server-authorized; do not rediscover on every 5s tick.
      await ready(scope, "knowledge.editing");
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
        const owner = ownerFor(scope);
        if (owner.snapshot()?.desktopInstanceId !== scope.instance
          || owner.snapshot()?.services?.knowledge?.version !== 1 || !owner.canCall("knowledge.editingSet")) return;
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
