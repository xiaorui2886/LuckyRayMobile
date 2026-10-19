import type { KnowledgeClient } from "./companionServices/knowledgeClient.ts";
import type { ServiceRegistry } from "./companionServices/serviceRegistry.ts";
import { ServicesError } from "./companionServices/transport.ts";
export type KnowledgeNavigationReader = Pick<KnowledgeClient, "directories" | "relations"> & {
  subscribe: (listener: () => void) => () => void;
  authorityKey: (instance: string, operation: "directories" | "relations") => string;
  denied: (instance: string, operation: "directories" | "relations") => boolean;
  refresh: (instance: string) => Promise<void>;
};
/** Existing registry, existing pinned transport. No service-wide grant inference. */
export function createKnowledgeNavigationReader(knowledge: KnowledgeClient, registry: ServiceRegistry): KnowledgeNavigationReader {
  const authorityKey = (instance: string, operation: "directories" | "relations") =>
    registry.snapshot()?.desktopInstanceId === instance
      ? `${registry.currentNamespace()}|${registry.operation(`knowledge.${operation}`).state}` : "unknown";
  const check = (instance: string, operation: string) => {
    if (registry.snapshot()?.desktopInstanceId !== instance) throw new ServicesError("SOURCE_CHANGED", 409);
    if (registry.snapshot()?.services?.knowledge?.version !== 1) throw new ServicesError("VERSION_UNSUPPORTED", 426);
    const state = registry.operation(operation).state;
    if (state === "implemented") return;
    if (state === "notGranted") throw new ServicesError("GRANT_REQUIRED", 403);
    if (state === "temporarilyUnavailable") throw new ServicesError("SERVICE_UNAVAILABLE", 503);
    throw new ServicesError("VERSION_UNSUPPORTED", 426);
  };
  const ready = async (instance: string, operation: string) => {
    if (registry.snapshot()?.desktopInstanceId !== instance) {
      try { await registry.refreshAdopting(instance); }
      catch (error) { if (registry.snapshot()?.desktopInstanceId !== instance) throw error; }
    }
    check(instance, operation);
    return registry.currentNamespace();
  };
  return {
    subscribe: listener => registry.subscribe?.(listener) || (() => {}), authorityKey,
    refresh: async instance => { await registry.refreshAdopting(instance); },
    denied: (instance, operation) => registry.snapshot()?.desktopInstanceId === instance && registry.operation(`knowledge.${operation}`).state === "notGranted",
    async directories(instance, vault, options) {
      const namespace = await ready(instance, "knowledge.directories");
      const page = await knowledge.directories(instance, vault, options);
      check(instance, "knowledge.directories");
      if (registry.currentNamespace() !== namespace) throw new ServicesError("SOURCE_CHANGED", 409);
      return page;
    },
    async relations(instance, vault, note, options) {
      const namespace = await ready(instance, "knowledge.relations");
      const page = await knowledge.relations(instance, vault, note, options);
      check(instance, "knowledge.relations");
      if (registry.currentNamespace() !== namespace) throw new ServicesError("SOURCE_CHANGED", 409);
      return page;
    },
  };
}
