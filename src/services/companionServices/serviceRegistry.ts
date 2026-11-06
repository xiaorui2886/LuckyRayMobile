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

import { callServices, ServicesError, type ServicesTransport } from "./transport.ts";
import type { OperationState, ServiceCatalog, OperationStatus } from "../../../shared/companion-services-v1/types.ts";

export type RegistryScope = Readonly<{ library?: string; vault?: string }>;

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
  private readonly scoped = new Map<string, ServiceRegistry>();
  private readonly identities = new Map<string, string>();
  private parent: ServiceRegistry | null = null;
  private target: Readonly<{ instance: string; scope: RegistryScope }> | null = null;
  private refreshedAt = 0;
  private securityRevision = 0;
  private revocationRevision = 0;

  /** Immutable capability owner. Different libraries never supersede one another. */
  forScope(instance: string, scope: RegistryScope = {}): ServiceRegistry {
    const root = this.parent ?? this;
    const captured = Object.freeze({ library: scope.library || undefined, vault: scope.vault || undefined });
    const key = JSON.stringify([instance, captured.library || "", captured.vault || ""]);
    let entry = root.scoped.get(key);
    if (!entry) {
      entry = new ServiceRegistry(root.transport);
      entry.parent = root;
      entry.target = Object.freeze({ instance, scope: captured });
      // Compatibility for a caller that discovered this exact scope before
      // acquiring its immutable handle. Never seed from another library.
      if (root.catalog?.desktopInstanceId === instance && root.scopeMatches(captured)) {
        entry.catalog = root.catalog;
        entry.namespace = root.namespace;
        entry.adoptedScope = root.adoptedScope;
        entry.refreshedAt = root.refreshedAt;
      }
      root.scoped.set(key, entry);
    }
    return entry;
  }

  /** Not authorization: every actual operation remains server-authorized. */
  ensureAdopting(instance: string, scope?: RegistryScope, maxAgeMs = 30000): Promise<ServiceCatalog> {
    if (this.catalog?.desktopInstanceId === instance && this.scopeMatches(scope)
      && Date.now() - this.refreshedAt < maxAgeMs) return Promise.resolve(this.catalog);
    return this.refreshAdopting(instance, scope);
  }

  /** Monotone local fence for retained UI, distinct from server permissionRevision. */
  currentSecurityRevision(): number { return this.securityRevision; }
  currentRevocationRevision(): number { return this.revocationRevision; }

  /** A failed authorization retires cached permission proof, not only the request. */
  revoke(instance: string, scope?: RegistryScope, wholeInstance = false): void {
    const root = this.parent ?? this;
    for (const entry of [root, ...root.scoped.values()]) {
      const owner = entry.target?.instance ?? entry.catalog?.desktopInstanceId;
      if (owner !== instance) continue;
      if (!wholeInstance && (entry.target ? !entry.scopeMatchesTarget(scope) : !entry.scopeMatches(scope))) continue;
      entry.securityRevision++;
      entry.revocationRevision++;
      entry.clearOwn();
    }
  }

  /** Canonical denial of one write operation does not revoke independent reads. */
  denyOperation(instance: string, scope: RegistryScope, operationId: string): void {
    const root = this.parent ?? this;
    for (const entry of [root, ...root.scoped.values()]) {
      if (entry.catalog?.desktopInstanceId !== instance || !entry.scopeMatches(scope)) continue;
      const operation = entry.catalog.operations?.[operationId];
      if (!operation) continue; // absent operations already fail closed
      entry.catalog = { ...entry.catalog, operations: { ...entry.catalog.operations,
        [operationId]: { ...operation, state: "notGranted" } } };
      entry.retireInflight();
      entry.emit();
    }
  }

  private scopeMatchesTarget(scope?: RegistryScope): boolean {
    return JSON.stringify([this.target?.scope.library || "", this.target?.scope.vault || ""])
      === JSON.stringify([scope?.library || "", scope?.vault || ""]);
  }

  private assertTarget(instance: string, scope?: RegistryScope): void {
    if (this.target && (this.target.instance !== instance || !this.scopeMatchesTarget(scope)))
      throw new ServicesError("SOURCE_CHANGED", 409);
  }

  private identityAtStart(instance: string): string | undefined {
    return (this.parent ?? this).identities.get(instance);
  }

  private adopted(catalog: ServiceCatalog, startedIdentity: string | undefined): void {
    const root = this.parent ?? this;
    const identity = this.namespaceOf({instanceId: catalog.desktopInstanceId,
      gatewayGeneration: catalog.gatewayGeneration, permissionRevision: catalog.permissionRevision});
    const known = root.identities.get(catalog.desktopInstanceId);
    if (known !== undefined && known !== startedIdentity && known !== identity)
      throw new Error("services-catalog-request-superseded");
    if (known !== undefined && known !== identity) {
      this.securityRevision++;
      // Retire even siblings with no catalog yet: an older cold discovery may
      // otherwise resurrect the previous generation after this one commits.
      for (const entry of [root, ...root.scoped.values()]) {
        if (entry === this) continue;
        const owner = entry.target?.instance ?? entry.catalog?.desktopInstanceId;
        if (owner === catalog.desktopInstanceId) {
          entry.securityRevision++;
          entry.clearOwn();
        }
      }
    }
    root.identities.set(catalog.desktopInstanceId, identity);

    this.refreshedAt = Date.now();
  }
  private catalog: ServiceCatalog | null = null;
  private namespace = "";
  private listeners = new Set<() => void>();
  private suppressChildEmits = false;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit() { for (const listener of this.listeners) listener(); if (this.parent && !this.parent.suppressChildEmits) this.parent.emit(); }
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
  private adoptedScope = "";
  scopeMatches(scope?: {library?: string; vault?: string}): boolean { return this.adoptedScope === JSON.stringify([scope?.library || "",scope?.vault || ""]); }
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
  refreshAdopting(instanceId: string, scope?: {library?: string; vault?: string}): Promise<ServiceCatalog> {
    scope = scope ? Object.freeze({ ...scope }) : undefined;
    this.assertTarget(instanceId, scope);
    const scopeKey = JSON.stringify([scope?.library || "",scope?.vault || ""]);
    const requestKey = instanceId + "|" + scopeKey;
    if (this.adopting?.instance === requestKey && this.adopting.token === this.requestToken) return this.adopting.task;
    const token = ++this.requestToken;
    const task = this.discoverAdopting(instanceId, token, scope).finally(() => {
      if (this.adopting?.task === task) this.adopting = null;
    });
    this.adopting = { instance: requestKey, token, task };
    return task;
  }

  private async discoverAdopting(instanceId: string, token: number, scope?: {library?: string; vault?: string}): Promise<ServiceCatalog> {
    const isCurrent = () => this.requestToken === token;
    const startedIdentity = this.identityAtStart(instanceId);
    const catalog = await callServices<ServiceCatalog>(this.transport, {
      instance: instanceId,
      ...scope,
      operationId: "services.discover",
      method: "GET",
      path: "/v1/services",
    });
    if (!isCurrent()) throw new Error("services-catalog-request-superseded");
    if (catalog?.desktopInstanceId !== instanceId || !Number.isSafeInteger(catalog?.gatewayGeneration)
      || catalog.gatewayGeneration < 0 || !Number.isSafeInteger(catalog?.permissionRevision) || catalog.permissionRevision < 0) {
      this.invalidate();
      throw new Error("services-catalog-generation-mismatch");
    }
    this.adopted(catalog, startedIdentity);
    this.adoptedScope = JSON.stringify([scope?.library || "",scope?.vault || ""]);
    this.catalog = catalog;
    this.namespace = this.namespaceOf({
      instanceId: catalog.desktopInstanceId,
      gatewayGeneration: catalog.gatewayGeneration,
      permissionRevision: catalog.permissionRevision,
    });
    if (scope?.library || scope?.vault) this.namespace += "|scope:" + this.adoptedScope;
    this.emit();
    return catalog;
  }

  async refresh(
    identity: RegistryIdentity,
    expectedPermissionRevision?: number,
  ): Promise<ServiceCatalog> {
    identity = Object.freeze({...identity});
    this.assertTarget(identity.instanceId);
    // Capture local currentness. A newer refresh or an invalidate bumps the
    // token, which retires THIS request (G1-C1).
    const token = ++this.requestToken;
    const isCurrent = () => this.requestToken === token;
    const startedIdentity = this.identityAtStart(identity.instanceId);

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
      this.invalidate();
      throw new Error("services-catalog-generation-mismatch");
    }
    if (
      expectedPermissionRevision !== undefined &&
      catalog.permissionRevision !== expectedPermissionRevision
    ) {
      this.revocationRevision++;
      this.invalidate();
      throw new Error("services-catalog-permission-revision-mismatch");
    }
    this.adopted(catalog, startedIdentity);
    this.catalog = catalog;
    this.adoptedScope = JSON.stringify(["", ""]);
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
  invalidateForPermissionRevision(permissionRevision: number, instance?: string): boolean {
    let changed = false;
    if (!this.parent) for (const entry of this.scoped.values()) {
      if (instance && entry.target?.instance !== instance) continue;
      if (entry.catalog?.permissionRevision === permissionRevision) continue;
      entry.securityRevision++;
      entry.revocationRevision++;
      entry.clearOwn();
      changed = true;
    }
    if (instance && this.catalog?.desktopInstanceId !== instance) return changed;
    if (!this.catalog) {
      this.securityRevision++;
      this.revocationRevision++;
      this.transport.invalidate?.(this.target?.instance ?? instance, this.target?.scope);
      // Nothing cached: still retire any refresh that started before the hint.
      this.retireInflight();
      this.emit();
      return true;
    }
    if (this.catalog.permissionRevision === permissionRevision) return changed;
    this.securityRevision++;
    this.revocationRevision++;
    this.transport.invalidate?.(this.target?.instance ?? this.catalog.desktopInstanceId, this.target?.scope);
    this.catalog = null;
    this.namespace = "";
    this.retireInflight();
    this.emit();
    return true;
  }

  /** Desktop identity or gateway generation moved: drop everything. */
  invalidate(): void {
    this.suppressChildEmits = true;
    if (!this.parent) for (const entry of this.scoped.values()) {
      entry.securityRevision++;
      entry.clearOwn();
    }
    this.suppressChildEmits = false;
    this.securityRevision++;
    this.clearOwn();
  }

  private clearOwn(): void {
    this.transport.invalidate?.(this.target?.instance ?? this.catalog?.desktopInstanceId, this.target?.scope);
    this.refreshedAt = 0;
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
