import type { KnowledgeClient } from "./companionServices/knowledgeClient.ts";
import type { ServiceRegistry } from "./companionServices/serviceRegistry.ts";
import { ServicesError } from "./companionServices/transport.ts";
export type KnowledgeNavigationReader = Pick<KnowledgeClient, "directories" | "relations"> & {
  subscribe: (listener: () => void) => () => void;
  authorityKey: (instance: string, operation: "directories" | "relations", vault?: string) => string;
  denied: (instance: string, operation: "directories" | "relations", vault?: string) => boolean;
  refresh: (instance: string, vault?: string) => Promise<void>;
  securityRevision: (instance: string, vault: string) => number;
};
/** Exact immutable vault handle; background work never changes another view's authority. */
export function createKnowledgeNavigationReader(knowledge: KnowledgeClient, registry: ServiceRegistry): KnowledgeNavigationReader {
  const scoped = (instance: string, vault?: string) => vault ? registry.forScope?.(instance, {vault}) ?? registry : registry;
  const authorityKey = (instance: string, operation: "directories" | "relations", vault?: string) => {
    const owner = scoped(instance, vault);
    return owner.snapshot()?.desktopInstanceId === instance
      ? `${owner.currentNamespace()}|${owner.operation(`knowledge.${operation}`).state}` : "unknown";
  };
  const check = (owner: ServiceRegistry, instance: string, operation: string) => {
    if (owner.snapshot()?.desktopInstanceId !== instance) throw new ServicesError("SOURCE_CHANGED", 409);
    if (owner.snapshot()?.services?.knowledge?.version !== 1) throw new ServicesError("VERSION_UNSUPPORTED", 426);
    const state = owner.operation(operation).state;
    if (state === "implemented") return;
    if (state === "notGranted") throw new ServicesError("GRANT_REQUIRED", 403);
    if (state === "temporarilyUnavailable") throw new ServicesError("SERVICE_UNAVAILABLE", 503);
    throw new ServicesError("VERSION_UNSUPPORTED", 426);
  };
  const ready = async (instance: string, operation: string, vault: string) => {
    const owner = scoped(instance, vault);
    if (owner.ensureAdopting) await owner.ensureAdopting(instance, {vault});
    else if (owner.snapshot()?.desktopInstanceId !== instance || owner.scopeMatches?.({vault}) === false)
      await owner.refreshAdopting(instance, {vault});
    check(owner, instance, operation);
    return { owner, namespace: owner.currentNamespace(), revision: owner.currentSecurityRevision?.() };
  };
  return {
    subscribe: listener => registry.subscribe?.(listener) || (() => {}), authorityKey,
    securityRevision: (instance, vault) => scoped(instance,vault).currentSecurityRevision?.() ?? 0,
    refresh: async (instance,vault) => { await scoped(instance,vault).refreshAdopting(instance, vault ? {vault} : undefined); },
    denied: (instance, operation, vault) => {
      const owner = scoped(instance,vault);
      return owner.snapshot()?.desktopInstanceId === instance && owner.operation(`knowledge.${operation}`).state === "notGranted";
    },
    async directories(instance, vault, options) {
      const {owner, namespace, revision} = await ready(instance, "knowledge.directories", vault);
      const page = await knowledge.directories(instance, vault, options);
      check(owner, instance, "knowledge.directories");
      if (owner.currentNamespace() !== namespace || owner.currentSecurityRevision?.() !== revision) throw new ServicesError("SOURCE_CHANGED", 409);
      return page;
    },
    async relations(instance, vault, note, options) {
      const {owner, namespace, revision} = await ready(instance, "knowledge.relations", vault);
      const page = await knowledge.relations(instance, vault, note, options);
      check(owner, instance, "knowledge.relations");
      if (owner.currentNamespace() !== namespace || owner.currentSecurityRevision?.() !== revision) throw new ServicesError("SOURCE_CHANGED", 409);
      return page;
    },
  };
}
