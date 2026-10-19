// KnowledgeClient (Issue #77 §3.3) — registered-vault operations.
//
// Scope discipline: old Content V1 note create/update/delete/attachment stays
// the authority for current-vault work. This client adds the canonical .3
// registered-vault discovery / list / changes / move.
//
// Hard rule: reading another registered vault NEVER switches the Desktop's
// active vault. The client only carries the vaultId it was asked about.

import { callServices, ServicesError, type ServicesTransport } from "./transport.ts";
import type {
  KnowledgeChange, KnowledgeChangePage, KnowledgeMove, KnowledgeMoveReceipt,
  KnowledgeNotePage, VaultPage,
  KnowledgeEditingLease, KnowledgeEditingSet, KnowledgeEditingStatus,
  KnowledgeUniqueCreate, KnowledgeUniqueReceipt,
  KnowledgeDirectoryPage, KnowledgeRelationPage, KnowledgeMaterialReferencePage, KnowledgeRelation,
} from "../../../shared/companion-services-v1/types.ts";

function safeRelative(value: unknown): value is string {
  return typeof value === "string" && new TextEncoder().encode(value).length <= 1024
    && !value.startsWith("/") && !/[\\:\u0000-\u001f\u007f]/.test(value)
    && value.split("/").every(part => part !== "." && part !== "..");
}

const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
// Relation targets are display/resolution text, never filesystem access paths.
function relationTarget(value: unknown): value is string {
  return typeof value === "string" && !!value && new TextEncoder().encode(value).length <= 1024
    && !/^[\\/]/.test(value) && !/[:\u0000-\u001f\u007f]/.test(value);
}
function relation(item: KnowledgeRelation): boolean {
  if (!item || !relationTarget(item.target)) return false;
  if (item.kind === "material") return identifier(item.assetId);
  if (item.kind !== "wikiLink" && item.kind !== "backlink") return false;
  return Number.isSafeInteger(item.line) && item.line >= 1 && ["resolved", "ambiguous", "unresolved"].includes(item.status)
    && Array.isArray(item.noteIds) && item.noteIds.every(identifier)
    && (item.kind !== "backlink" || identifier(item.sourceNoteId));
}

function paged(page: { items: unknown[]; hasMore: boolean; nextAfter: string | null }): boolean {
  return Array.isArray(page.items) && page.items.length <= 100 && typeof page.hasMore === "boolean"
    && (page.hasMore ? typeof page.nextAfter === "string" && !!page.nextAfter : page.nextAfter === null);
}

export type VaultProjection = {
  generation: number;
  vaultId: string;
  items: KnowledgeChange[];
  nextCursor: string | null;
  recovered: boolean;
};

/** One vault's local request/recovery context (G1-C3). */
type VaultContext = {
  generation: number;
  /** The Desktop the projection belongs to — a bare vaultId is not enough. */
  instance: string;
  /** Local request token; a newer request retires the older one. */
  requestToken: number;
};

export class KnowledgeClient {
  private transport: ServicesTransport;
  private generations = new Map<string, number>();
  private projections = new Map<string, VaultProjection>();
  /**
   * Per-vault currentness context, keyed by `instanceId|vaultId` so the SAME
   * vaultId on two Desktops can never share a scope.
   */
  private contexts = new Map<string, VaultContext>();

  /** The scope key: Desktop instance + vault. */
  private scopeOf(instance: string, vaultId: string): string {
    return `${instance}|${vaultId}`;
  }

  constructor(transport: ServicesTransport) {
    this.transport = transport;
  }

  /** Exact immutable caller payload; durable retry ownership stays in Content. */
  async createUnique(instance: string, input: KnowledgeUniqueCreate): Promise<KnowledgeUniqueReceipt> {
    const receipt = await callServices<KnowledgeUniqueReceipt>(this.transport, {
      instance, operationId: "knowledge.createUnique", method: "POST",
      path: "/v1/services/knowledge/notes", body: input,
    });
    const document = receipt?.document;
    if (!receipt || receipt.opId !== input.opId || !document || document.vaultId !== input.vaultId
      || (input.noteId !== undefined && document.noteId !== input.noteId)
      || typeof document.noteId !== "string" || !document.noteId
      || typeof document.revision !== "string" || !document.revision || typeof document.title !== "string"
      || typeof document.relativePath !== "string" || typeof document.content !== "string"
      || !Array.isArray(document.resources) || document.deleted === true) {
      throw new ServicesError("MALFORMED_RESPONSE", 200);
    }
    return receipt;
  }

  /** Non-idempotent inert reservation; never stored in a durable outbox. */
  async editingOpen(instance: string, vaultId: string, noteId: string): Promise<KnowledgeEditingLease> {
    const lease = await callServices<KnowledgeEditingLease>(this.transport, {
      instance, operationId: "knowledge.editingOpen", method: "POST",
      path: `/v1/services/knowledge/notes/${encodeURIComponent(noteId)}/editing`,
      body: { vaultId },
    });
    if (!lease || lease.vaultId !== vaultId || lease.noteId !== noteId
      || !/^[a-f0-9]{32}$/.test(lease.sessionId) || lease.generation !== 0
      || lease.editing !== false || lease.leaseMs !== 15000) {
      throw new ServicesError("MALFORMED_RESPONSE", 200);
    }
    return lease;
  }

  async editing(instance: string, vaultId: string, noteId: string): Promise<KnowledgeEditingStatus> {
    const status = await callServices<KnowledgeEditingStatus>(this.transport, {
      instance, operationId: "knowledge.editing", method: "GET",
      path: `/v1/services/knowledge/notes/${encodeURIComponent(noteId)}/editing`, query: { vault: vaultId },
    });
    if (!status || status.vaultId !== vaultId || status.noteId !== noteId || status.leaseMs !== 15000
      || typeof status.desktopEditing !== "boolean" || typeof status.mobileEditing !== "boolean") {
      throw new ServicesError("MALFORMED_RESPONSE", 200);
    }
    return status;
  }

  async editingSet(instance: string, noteId: string, input: KnowledgeEditingSet): Promise<KnowledgeEditingLease> {
    if (!Number.isSafeInteger(input.generation) || input.generation <= 0
      || !/^[a-f0-9]{32}$/.test(input.sessionId) || typeof input.editing !== "boolean") {
      throw new ServicesError("INPUT_INVALID", 400);
    }
    const lease = await callServices<KnowledgeEditingLease>(this.transport, {
      instance, operationId: "knowledge.editingSet", method: "PUT",
      path: `/v1/services/knowledge/notes/${encodeURIComponent(noteId)}/editing`, body: input,
    });
    if (!lease || lease.vaultId !== input.vaultId || lease.noteId !== noteId || lease.sessionId !== input.sessionId
      || !Number.isSafeInteger(lease.generation) || lease.generation < input.generation
      || typeof lease.editing !== "boolean" || lease.leaseMs !== 15000) {
      throw new ServicesError("MALFORMED_RESPONSE", 200);
    }
    return lease;
  }

  async directories(instance: string, vaultId: string, options: { limit?: number; afterPath?: string } = {}): Promise<KnowledgeDirectoryPage> {
    const page = await callServices<KnowledgeDirectoryPage>(this.transport, {
      instance, operationId: "knowledge.directories", method: "GET",
      path: `/v1/services/knowledge/vaults/${encodeURIComponent(vaultId)}/directories`, query: options,
    });
    if (!page || page.vaultId !== vaultId || !Array.isArray(page.items) || page.items.length > 100
      || typeof page.hasMore !== "boolean" || (page.hasMore ? typeof page.nextAfterPath !== "string" : page.nextAfterPath !== null)
      || page.items.some(item => !safeRelative(item?.parentRelativePath))) throw new ServicesError("MALFORMED_RESPONSE", 200);
    return page;
  }

  async relations(instance: string, vaultId: string, noteId: string, options: { limit?: number; after?: string } = {}): Promise<KnowledgeRelationPage> {
    const page = await callServices<KnowledgeRelationPage>(this.transport, {
      instance, operationId: "knowledge.relations", method: "GET",
      path: `/v1/services/knowledge/notes/${encodeURIComponent(noteId)}/relations`, query: { vault: vaultId, ...options },
    });
    if (!page || page.vaultId !== vaultId || page.noteId !== noteId || typeof page.revision !== "string"
      || !paged(page) || page.items.some(item => !relation(item))) throw new ServicesError("MALFORMED_RESPONSE", 200);
    return page;
  }

  async materialReferences(instance: string, vaultId: string, assetId: string, options: { limit?: number; after?: string } = {}): Promise<KnowledgeMaterialReferencePage> {
    const page = await callServices<KnowledgeMaterialReferencePage>(this.transport, {
      instance, operationId: "knowledge.materialReferences", method: "GET",
      path: `/v1/services/knowledge/materials/${encodeURIComponent(assetId)}/references`, query: { vault: vaultId, ...options },
    });
    if (!page || page.vaultId !== vaultId || page.assetId !== assetId || !paged(page)
      || page.items.some(item => !identifier(item?.noteId) || !relationTarget(item.target))) {
      throw new ServicesError("MALFORMED_RESPONSE", 200);
    }
    return page;
  }

  /** Registered vault discovery (never implies an active-vault switch). */
  async vaults(instance: string): Promise<VaultPage> {
    return callServices<VaultPage>(this.transport, {
      instance,
      operationId: "knowledge.vaults",
      method: "GET",
      path: "/v1/services/knowledge/vaults",
    });
  }

  /**
   * Registered vault note list.
   *
   * Canonical query keys are exactly `limit | afterId | q` — NOT `after`. The
   * canonical response carries `nextAfterId`, which is the key the next page
   * must be requested with.
   */
  async registeredList(
    instance: string,
    vaultId: string,
    options: { afterId?: string; limit?: number; q?: string } = {},
  ): Promise<KnowledgeNotePage> {
    return callServices<KnowledgeNotePage>(this.transport, {
      instance,
      operationId: "knowledge.registeredList",
      method: "GET",
      path: `/v1/services/knowledge/vaults/${encodeURIComponent(vaultId)}/notes`,
      query: { afterId: options.afterId, limit: options.limit, q: options.q },
    });
  }

  /** Move a note. `opId` + `expectedRevision` are canonical-required. */
  async move(
    instance: string,
    noteId: string,
    move: KnowledgeMove,
  ): Promise<KnowledgeMoveReceipt> {
    return callServices<KnowledgeMoveReceipt>(this.transport, {
      instance,
      operationId: "knowledge.move",
      method: "PATCH",
      path: `/v1/services/knowledge/notes/${encodeURIComponent(noteId)}/move`,
      body: move,
    });
  }

  /**
   * Per-vault durable projection snapshot.
   *
   * `vaultId` alone is ambiguous across Desktops, so this requires the instance
   * and delegates to the scope-keyed lookup.
   */
  projectionFor(instance: string, vaultId: string): VaultProjection | null {
    return this.projections.get(this.scopeOf(instance, vaultId)) ?? null;
  }

  /**
   * Registered changes for ONE vault.
   *
   * A 410 replaces only THAT vault's projection generation. Mobile-local notes,
   * offline drafts, the existing outbox and unsynced attachments are owned by
   * other authorities and are never cleared from here.
   */
  async registeredChanges(
    instance: string,
    vaultId: string,
    after: string | null,
  ): Promise<VaultProjection> {
    const scope = this.scopeOf(instance, vaultId);
    const previous = this.contexts.get(scope);
    const gen = previous?.generation ?? this.generations.get(this.scopeOf(instance, vaultId)) ?? 0;
    // A newer request for this scope retires the older one.
    const requestToken = (previous?.requestToken ?? 0) + 1;
    this.contexts.set(scope, { generation: gen, instance, requestToken });
    const isCurrent = () => {
      const now = this.contexts.get(scope);
      return Boolean(now) && now!.requestToken === requestToken && now!.instance === instance;
    };

    let page: KnowledgeChangePage;
    try {
      page = await callServices<KnowledgeChangePage>(this.transport, {
        instance,
        operationId: "knowledge.registeredChanges",
        method: "GET",
        path: `/v1/services/knowledge/vaults/${encodeURIComponent(vaultId)}/changes`,
        query: { after: after ?? undefined },
      });
    } catch (error) {
      if (error instanceof ServicesError && error.code === "CURSOR_TOO_OLD") {
        // A stale 410 must not begin a recovery for a scope it no longer owns.
        if (!isCurrent()) return this.projectionOr(instance, vaultId);
        return this.resnapshot(instance, vaultId, gen, requestToken);
      }
      throw error;
    }
    if (!isCurrent() || (this.generations.get(this.scopeOf(instance, vaultId)) ?? 0) !== gen) {
      return this.projectionOr(instance, vaultId);
    }
    return this.commit(instance, vaultId, page, false);
  }

  private projectionOr(instance: string, vaultId: string): VaultProjection {
    const scope = this.scopeOf(instance, vaultId);
    return this.projections.get(scope) ?? {
      generation: this.generations.get(this.scopeOf(instance, vaultId)) ?? 0,
      vaultId, items: [], nextCursor: null, recovered: false,
    };
  }

  private async resnapshot(
    instance: string,
    vaultId: string,
    previousGeneration: number,
    requestToken: number,
  ): Promise<VaultProjection> {
    const scope = this.scopeOf(instance, vaultId);
    const recoveryGeneration = previousGeneration + 1;
    this.generations.set(this.scopeOf(instance, vaultId), recoveryGeneration);
    this.contexts.set(scope, { generation: recoveryGeneration, instance, requestToken });
    const page = await callServices<KnowledgeChangePage>(this.transport, {
      instance,
      operationId: "knowledge.registeredChanges",
      method: "GET",
      path: `/v1/services/knowledge/vaults/${encodeURIComponent(vaultId)}/changes`,
      query: {},
    });
    // Commit only while BOTH the scope's request token AND the recovery
    // generation are still current — a newer refresh or a different scope wins.
    const now = this.contexts.get(scope);
    if (
      !now || now.requestToken !== requestToken || now.instance !== instance ||
      this.generations.get(this.scopeOf(instance, vaultId)) !== recoveryGeneration
    ) {
      return this.projectionOr(instance, vaultId);
    }
    return this.commit(instance, vaultId, page, true);
  }

  private commit(instance: string, vaultId: string, page: KnowledgeChangePage, recovered: boolean): VaultProjection {
    const projection: VaultProjection = {
      generation: this.generations.get(this.scopeOf(instance, vaultId)) ?? 0,
      vaultId,
      items: page.items ?? [],
      nextCursor: page.nextCursor ?? null,
      recovered,
    };
    // Keyed by SCOPE: the same vaultId on another Desktop is a different slot.
    this.projections.set(this.scopeOf(instance, vaultId), projection);
    return projection;
  }

  /** Read a projection for an explicit Desktop+vault scope. */
  projectionForScope(instance: string, vaultId: string): VaultProjection | null {
    return this.projections.get(this.scopeOf(instance, vaultId)) ?? null;
  }
}
