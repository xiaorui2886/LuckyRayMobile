// Companion Services V1 — client foundation barrel (Issue #77).
//
// ONE transport seam, ONE registry, one client per canonical domain. Screens
// are not refactored in this batch; callers compose these directly.
//
// Production transport: the pinned Desktop gateway reached through the existing
// Rust authority. Tests: the vendored canonical fixture adapted to the SAME
// seam, so there is no test-only client implementation.

export * from "./transport.ts";
export { ServiceRegistry, stateOf, type OperationView, type RegistryIdentity } from "./serviceRegistry.ts";
export { MaterialsClient, type MaterialProjection } from "./materialsClient.ts";
export { KnowledgeClient, type VaultProjection } from "./knowledgeClient.ts";
export { IngestClient, INGEST_CHUNK_BYTES, type ChunkSource } from "./ingestClient.ts";
export { SearchSession, type SearchProjection, type SearchQuery, type SearchGeneration } from "./searchClient.ts";
export { ChangeFeedClient, type FeedMode } from "./changeFeedClient.ts";
export {
  PresentationClient, presentationCopy,
  type PresentationOutcome,
} from "./presentationClient.ts";
export { LshRemoteAdapter, LSH_OWNED_BY_72, type LshCapabilityView } from "./lshRemoteAdapter.ts";
export {
  carrySafeSource, isWorkPage, preservesWorkPageUrl, type SourceFidelity,
} from "./safeSource.ts";
export { createFixtureTransport, type FixtureTransport } from "./fixtureTransport.ts";
export { createTauriServicesTransport, base64Of } from "./productionTransport.ts";
export { createHintSubscription, toHint, type Hint, type HintRecord, type HintSubscription } from "./hintSubscription.ts";

import { productionReadCoordinator } from "./readCoordinator.ts";
import { ServicesError, errorCodeOf } from "./transport.ts";
import { withReadBackoff } from "./readBackoff.ts";
import type { ServicesTransport } from "./transport.ts";
import { createTauriServicesTransport } from "./productionTransport.ts";
import { createHintSubscription, type HintSubscription } from "./hintSubscription.ts";
import { ServiceRegistry } from "./serviceRegistry.ts";
import { MaterialsClient } from "./materialsClient.ts";
import { KnowledgeClient } from "./knowledgeClient.ts";
import { IngestClient } from "./ingestClient.ts";
import { ChangeFeedClient } from "./changeFeedClient.ts";
import { PresentationClient } from "./presentationClient.ts";
import { LshRemoteAdapter } from "./lshRemoteAdapter.ts";

/**
 * The composed Services V1 surface over ONE transport.
 *
 * `SearchSession` is intentionally NOT a member: a search session is bound to a
 * query generation and must be constructed per query by its owner.
 */
export type CompanionServices = {
  registry: ServiceRegistry;
  materials: MaterialsClient;
  knowledge: KnowledgeClient;
  ingest: IngestClient;
  changeFeed: ChangeFeedClient;
  presentation: PresentationClient;
  lsh: LshRemoteAdapter;
};

export function createCompanionServices(
  transport: ServicesTransport,
  /**
   * The Rust-owned hint subscription. Optional: without it the change feed runs
   * polling-only, which is fully functional because durable cursors are truth.
   */
  hints: HintSubscription | null = null,
): CompanionServices {
  let registry: ServiceRegistry;
  const guarded: ServicesTransport = { invalidate: (instance,scope) => transport.invalidate?.(instance,scope), async request(request) {
    const denialCode = (code: string, status: number) => status === 401 ? "AUTH_REVOKED"
      : status === 403 && !["GRANT_REQUIRED", "AUTH_REVOKED", "PAIRING_REQUIRED"].includes(code) ? "SCOPE_DENIED" : code;
    const revoke = (code: string) => {
      if (code === "GRANT_REQUIRED" && request.method !== "GET") {
        registry.denyOperation(request.instance, {library:request.library,vault:request.vault}, request.operationId);
        return;
      }
      if (["AUTH_REVOKED", "PAIRING_REQUIRED", "GRANT_REQUIRED", "SCOPE_DENIED"].includes(code))
        registry.revoke(request.instance, {library: request.library, vault: request.vault},
          code === "AUTH_REVOKED" || code === "PAIRING_REQUIRED");
    };
    try {
      const response = await transport.request(request);
      if (response.status < 200 || response.status >= 300) revoke(denialCode(errorCodeOf(response.body), response.status));
      return response;
    } catch (error) {
      if (error instanceof ServicesError) revoke(denialCode(error.code, error.status));
      throw error;
    }
  } };
  registry = new ServiceRegistry(guarded);
  return {
    registry,
    materials: new MaterialsClient(guarded),
    knowledge: new KnowledgeClient(guarded),
    ingest: new IngestClient(guarded),
    changeFeed: new ChangeFeedClient(hints),
    presentation: new PresentationClient(guarded),
    lsh: new LshRemoteAdapter(guarded),
  };
}

/**
 * The PRODUCTION composition: the same clients over the pinned Rust-backed
 * transport. Screens call this; tests call  with the
 * fixture transport. One client set, two seams.
 */
const sharedProductionTransport = productionReadCoordinator.wrap(withReadBackoff(createTauriServicesTransport()));

export function createProductionServices(scope?: Readonly<{library?: string; vault?: string}>): CompanionServices {
  const captured = scope ? Object.freeze({...scope}) : undefined;
  const scheduled = sharedProductionTransport;
  const scoped: ServicesTransport = { invalidate: (instance,scope) => scheduled.invalidate?.(instance,scope), request: req => scheduled.request({
    ...req, library: req.library ?? captured?.library, vault: req.vault ?? captured?.vault,
  }) };
  return createCompanionServices(scoped, createHintSubscription(undefined, captured));
}
