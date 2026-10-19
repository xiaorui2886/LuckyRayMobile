// ServiceRegistry (Issue #77 §3.1) — the ONE owner of Services V1 capability
// truth for a given Desktop.
//
// Rules enforced here:
//  - the cache namespace is (desktopInstanceId, gatewayGeneration,
//    permissionRevision): any of them moving invalidates the catalog;
//  - state is PER OPERATION. `services.<domain>.granted` is never used to infer
//    whether an operation is available;
//  - an absent/unknown operation fails closed as `unsupported`;
//  - `materials.restore` is unsupported by contract and is never invented.
//
// The registry performs no retries of its own: a caller re-reads after an
// identity/generation/permission change.

import { callServices, type ServicesTransport } from "./transport.ts";
import type { OperationState, ServiceCatalog, OperationStatus } from "../../../shared/companion-services-v1/types.ts";

export type RegistryIdentity = {
  instanceId: string;
  gatewayGeneration: number;
  permissionRevision: number;
};

export type OperationView = {
  operationId: string;
  state: OperationState;
  capability: string;
  grant: string | null;
  /** Canonical scope (asset/catalog/registeredVault/ownedJob/...). */
  scope: OperationStatus["scope"] | null;
};

/** An operation absent from the catalog is unsupported, never "maybe". */
export function stateOf(catalog: ServiceCatalog | null, operationId: string): OperationState {
  const entry = catalog?.operations?.[operationId];
  return entry?.state ?? "unsupported";
}

export class ServiceRegistry {
  private transport: ServicesTransport;
  private catalog: ServiceCatalog | null = null;
  private namespace = "";
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit() { for (const listener of this.listeners) listener(); }
  /**
   * Local request currentness token (G1-C1).
   *
   * Every refresh captures the value at its start; a newer refresh, an
   * `invalidate()` or a permission-revision invalidation bumps it. After the
   * await, a refresh may only adopt/clear state when its token is STILL the
   * current one — so a stale success, a stale error or a stale identity
   * mismatch can never mutate the current catalog.
   *
   * This is deliberately a LOCAL counter. It is a different scope from the
   * Desktop `gatewayGeneration`, the catalog `permissionRevision`, the
   * connection epoch and the hint-worker generation; those are never compared
   * against each other.
   */
  private requestToken = 0;
  private adopting: { instance: string; token: number; task: Promise<ServiceCatalog> } | null = null;

  constructor(transport: ServicesTransport) {
    this.transport = transport;
  }

  /** The current local request token (exposed for bounded tests). */
  currentRequestToken(): number {
    return this.requestToken;
  }

  /** Retire every in-flight refresh, keeping the token semantics explicit. */
  private retireInflight(): void {
    this.requestToken += 1;
  }

  /** Snapshot for UI/tests; null means "never successfully read". */
  snapshot(): ServiceCatalog | null {
    return this.catalog;
  }



  /**
   * Namespace string for the CURRENT cache. Exposed so tests can prove that a
   * generation or permission change really does invalidate the cache.
   */
  currentNamespace(): string {
    return this.namespace;
  }

  private namespaceOf(identity: RegistryIdentity): string {
    return [identity.instanceId, identity.gatewayGeneration, identity.permissionRevision].join("|");
  }

  /**
   * Refresh the catalog for `identity`.
   *
   * The canonical catalog reports desktopInstanceId / gatewayGeneration /
   * permissionRevision itself:
   *  - the CATALOG's permissionRevision is what the namespace uses (never the
   *    caller's belief — otherwise a new catalog could be cached under a stale
   *    revision);
   *  - `expectedPermissionRevision` is OPTIONAL. Initial discovery does not
   *    require knowing a revision; when a caller DOES supply one (e.g. from a
   *    servicesChanged hint) a mismatch fails closed;
   *  - a stale Desktop/gateway generation is never adopted as current truth.
   */
  /**
   * SERVICES-SEARCH-R1: cold-client discovery for an EXACT Desktop instance.
   *
   * Issues ONE canonical `services.discover` read and adopts the returned
   * catalog when its `desktopInstanceId` matches `instanceId` — the catalog
   * itself is the only source of `gatewayGeneration`/`permissionRevision`
   * for a client that has never discovered this Desktop before (the
   * caller-supplied-identity form of `refresh` cannot run cold, since it
   * must pre-state the generation it expects). Same token fence and
   * adopt-or-clear semantics as `refresh`.
   */
  refreshAdopting(instanceId: string): Promise<ServiceCatalog> {
    if (this.adopting?.instance === instanceId && this.adopting.token === this.requestToken) return this.adopting.task;
    const token = ++this.requestToken;
    const task = this.discoverAdopting(instanceId, token).finally(() => {
      if (this.adopting?.task === task) this.adopting = null;
    });
    this.adopting = { instance: instanceId, token, task };
    return task;
  }

  private async discoverAdopting(instanceId: string, token: number): Promise<ServiceCatalog> {
    const isCurrent = () => this.requestToken === token;
    const catalog = await callServices<ServiceCatalog>(this.transport, {
      instance: instanceId,
      operationId: "services.discover",
      method: "GET",
      path: "/v1/services",
    });
    if (!isCurrent()) throw new Error("services-catalog-request-superseded");
    if (catalog?.desktopInstanceId !== instanceId || typeof catalog?.gatewayGeneration !== "number") {
      this.catalog = null;
      this.namespace = "";
      this.emit();
      throw new Error("services-catalog-generation-mismatch");
    }
    this.catalog = catalog;
    this.namespace = this.namespaceOf({
      instanceId: catalog.desktopInstanceId,
      gatewayGeneration: catalog.gatewayGeneration,
      permissionRevision: catalog.permissionRevision,
    });
    this.emit();
    return catalog;
  }

  async refresh(
    identity: RegistryIdentity,
    expectedPermissionRevision?: number,
  ): Promise<ServiceCatalog> {
    // Capture local currentness. A newer refresh or an invalidate bumps the
    // token, which retires THIS request (G1-C1).
    const token = ++this.requestToken;
    const isCurrent = () => this.requestToken === token;

    const catalog = await callServices<ServiceCatalog>(this.transport, {
      instance: identity.instanceId,
      operationId: "services.discover",
      method: "GET",
      path: "/v1/services",
    });

    // A stale completion must not touch the current catalog — not even to clear
    // it. The caller still learns its own request was retired.
    if (!isCurrent()) {
      throw new Error("services-catalog-request-superseded");
    }

    const agrees =
      catalog?.desktopInstanceId === identity.instanceId &&
      catalog?.gatewayGeneration === identity.gatewayGeneration;
    if (!agrees) {
      // Only the CURRENT request may clear state on a mismatch.
      this.catalog = null;
      this.namespace = "";
      this.emit();
      throw new Error("services-catalog-generation-mismatch");
    }
    if (
      expectedPermissionRevision !== undefined &&
      catalog.permissionRevision !== expectedPermissionRevision
    ) {
      this.catalog = null;
      this.namespace = "";
      this.emit();
      throw new Error("services-catalog-permission-revision-mismatch");
    }
    this.catalog = catalog;
    // Namespace from the ADOPTED catalog, not from caller belief.
    this.namespace = this.namespaceOf({
      instanceId: catalog.desktopInstanceId,
      gatewayGeneration: catalog.gatewayGeneration,
      permissionRevision: catalog.permissionRevision,
    });
    this.emit();
    return catalog;
  }

  /**
   * A `servicesChanged` hint carrying a NEW permission revision invalidates the
   * cache. Returns true when the caller must refresh.
   */
  invalidateForPermissionRevision(permissionRevision: number): boolean {
    if (!this.catalog) {
      // Nothing cached: still retire any refresh that started before the hint.
      this.retireInflight();
      this.emit();
      return true;
    }
    if (this.catalog.permissionRevision === permissionRevision) return false;
    this.catalog = null;
    this.namespace = "";
    this.retireInflight();
    this.emit();
    return true;
  }

  /** Desktop identity or gateway generation moved: drop everything. */
  invalidate(): void {
    this.catalog = null;
    this.namespace = "";
    // Retire in-flight refreshes so a late success cannot resurrect the cache.
    this.retireInflight();
    this.emit();
  }

  /** Per-operation view; unknown operations resolve to `unsupported`. */
  operation(operationId: string): OperationView {
    const entry: OperationStatus | undefined = this.catalog?.operations?.[operationId];
    return {
      operationId,
      state: entry?.state ?? "unsupported",
      capability: entry?.capability ?? "",
      grant: entry?.grant ?? null,
      scope: entry?.scope ?? null,
    };
  }

  /** The permission revision actually carried by the adopted catalog. */
  permissionRevision(): number | null {
    return this.catalog?.permissionRevision ?? null;
  }

  /** True only when the operation is explicitly `implemented` for this device. */
  canCall(operationId: string): boolean {
    return this.operation(operationId).state === "implemented";
  }

  /** Canonical limits for chunking/upload decisions, or null when unread. */
  limits() {
    return this.catalog?.limits ?? null;
  }
}
