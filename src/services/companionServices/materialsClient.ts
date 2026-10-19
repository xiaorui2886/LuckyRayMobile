// MaterialsClient (Issue #77 §3.2) — canonical .3 material operations.
//
// Scope discipline: the NEW .3 operations are detailV1 / metadataPatch /
// removeRecord / changes. Existing list / navigation / resource / favorite /
// tags / folder / batch stay on the Wave-A Content V1 authorities — this client
// does not duplicate them.
//
// Rules:
//  - a mutation takes an EXISTING immutable opId; this client never mints or
//    rotates one after a network/generation retry;
//  - 410 CURSOR_TOO_OLD starts a NEW projection generation and REPLACES the
//    Desktop-material projection (never append old+new, never clear Mobile-local
//    Library data);
//  - `materials.restore` is unsupported by canonical contract and is not exposed.

import { callServices, ServicesError, type ServicesTransport } from "./transport.ts";
import type {
  MaterialChange, MaterialChangePage, MaterialPatch, MaterialReceipt, MaterialRemove, MaterialDetail,
} from "../../../shared/companion-services-v1/types.ts";

export type MaterialProjection = {
  generation: number;
  items: MaterialChange[];
  nextCursor: string | null;
  recovered: boolean;
};

export class MaterialsClient {
  private transport: ServicesTransport;
  private generation = 0;
  private projection: MaterialProjection = { generation: 0, items: [], nextCursor: null, recovered: false };
  /**
   * Local request currentness token (G1-C3).
   *
   * Every `changes()` call captures it; a newer call retires the older one.
   * The 410 recovery additionally captures its own token, so a late resnapshot
   * can never commit over a newer projection.
   */
  private requestToken = 0;

  constructor(transport: ServicesTransport) {
    this.transport = transport;
  }

  snapshot(): MaterialProjection {
    return this.projection;
  }
  currentGeneration(): number {
    return this.generation;
  }

  /** Canonical .3 detail read (source fidelity comes straight from the DTO). */
  async detailV1(instance: string, assetId: string): Promise<MaterialDetail> {
    return callServices<MaterialDetail>(this.transport, {
      instance,
      operationId: "materials.detailV1",
      method: "GET",
      path: `/v1/services/materials/assets/${encodeURIComponent(assetId)}`,
    });
  }

  /** Metadata patch. `opId` is supplied by the caller and is never rotated. */
  async metadataPatch(
    instance: string,
    assetId: string,
    patch: MaterialPatch,
  ): Promise<MaterialReceipt> {
    return callServices<MaterialReceipt>(this.transport, {
      instance,
      operationId: "materials.metadataPatch",
      method: "PATCH",
      path: `/v1/services/materials/assets/${encodeURIComponent(assetId)}`,
      body: patch,
    });
  }

  /** Remove record (tombstone). Same opId contract as patch. */
  async removeRecord(
    instance: string,
    assetId: string,
    remove: MaterialRemove,
  ): Promise<MaterialReceipt> {
    return callServices<MaterialReceipt>(this.transport, {
      instance,
      operationId: "materials.removeRecord",
      method: "DELETE",
      path: `/v1/services/materials/assets/${encodeURIComponent(assetId)}`,
      body: remove,
    });
  }

  /**
   * Catch up the material change feed from a durable cursor.
   *
   * On 410 the WHOLE projection is resnapshotted into a new generation: the
   * cursor floor moved, so the old page can no longer be extended and must not
   * be concatenated with the fresh one.
   */
  async changes(instance: string, after: string | null): Promise<MaterialProjection> {
    const gen = this.generation;
    // A newer call retires this one, so a late 410 (or a late success) from a
    // superseded request cannot touch the current projection.
    const token = ++this.requestToken;
    const isCurrent = () => this.requestToken === token;

    let page: MaterialChangePage;
    try {
      page = await callServices<MaterialChangePage>(this.transport, {
        instance,
        operationId: "materials.changes",
        method: "GET",
        path: "/v1/services/materials/changes",
        query: { after: after ?? undefined },
      });
    } catch (error) {
      if (error instanceof ServicesError && error.code === "CURSOR_TOO_OLD") {
        // Only a CURRENT 410 may start a recovery; a stale one must not begin
        // work against a projection it no longer speaks for.
        if (!isCurrent()) return this.projection;
        return this.resnapshot(instance, token);
      }
      throw error;
    }
    // Stale success: keep the newer projection.
    if (!isCurrent() || gen !== this.generation) return this.projection;
    return this.commitFromPage(page, false);
  }

  /**
   * 410 recovery: new generation, resnapshot from the canonical floor and
   * REPLACE. Mobile-local Library data is not touched by this client.
   */
  private async resnapshot(instance: string, requestToken: number): Promise<MaterialProjection> {
    // The recovery carries its own generation AND the request token it belongs
    // to, so it can only commit while BOTH are still current.
    const recoveryGeneration = this.generation + 1;
    this.generation = recoveryGeneration;
    const page = await callServices<MaterialChangePage>(this.transport, {
      instance,
      operationId: "materials.changes",
      method: "GET",
      path: "/v1/services/materials/changes",
      // no cursor: the canonical snapshot position
      query: {},
    });
    // A newer request (or a newer recovery) retires this resnapshot.
    if (this.requestToken !== requestToken || this.generation !== recoveryGeneration) {
      return this.projection;
    }
    return this.commitFromPage(page, true);
  }

  private commitFromPage(page: MaterialChangePage, recovered: boolean): MaterialProjection {
    this.projection = {
      generation: this.generation,
      items: page.items ?? [],
      nextCursor: page.nextCursor ?? null,
      recovered,
    };
    return this.projection;
  }
}
