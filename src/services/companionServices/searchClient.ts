// SearchClient / SearchSession (Issue #77 §3.6) — .3 lease semantics.
//
// A result page belongs to ONE immutable query generation:
//   (q, domains, desktopInstanceId, permissionRevision).
//
//  - nextCursor appends ONLY into the same generation;
//  - 410 CURSOR_TOO_OLD / reclaimed lease / expired cursor / a LOST final-page
//    response starts a NEW generation, re-issues page 1 with NO cursor for the
//    SAME query, and REPLACES the projection (fresh results never concatenate
//    onto old cursor results);
//  - 410 is NEVER surfaced as "no results";
//  - a recovery that is in flight when the query changes cannot commit;
//  - Mobile-local results/drafts/outbox are untouched (this client owns no
//    local persistence at all).

import { callServices, ServicesError, type ServicesTransport } from "./transport.ts";
import type { SearchHit, SearchPage } from "../../../shared/companion-services-v1/types.ts";

export type SearchQuery = {
  q: string;
  domains?: string;
  limit?: number;
};

export type SearchGeneration = {
  generation: number;
  query: string;
  domains: string;
  instanceId: string;
  permissionRevision: number;
  /** Page size is part of the query identity: a recovery must keep it. */
  limit: number | undefined;
};

export type SearchProjection = {
  /** Fresh results for the CURRENT generation only — never a concatenation. */
  items: SearchHit[];
  nextCursor: string | null;
  /** True when the last read was a 410 recovery that replaced the projection. */
  recovered: boolean;
};

export class SearchSession {
  private transport: ServicesTransport;
  private generation = 0;
  private current: SearchGeneration | null = null;
  private projection: SearchProjection = { items: [], nextCursor: null, recovered: false };
  private listeners = new Set<() => void>();

  constructor(transport: ServicesTransport) {
    this.transport = transport;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
  /** Cached stable reference (useSyncExternalStore contract). */
  snapshot(): SearchProjection {
    return this.projection;
  }
  currentGeneration(): SearchGeneration | null {
    return this.current;
  }
  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private identityOf(query: SearchQuery): SearchGeneration {
    return {
      generation: this.generation,
      query: query.q,
      domains: query.domains ?? "",
      instanceId: this.current?.instanceId ?? "",
      permissionRevision: this.current?.permissionRevision ?? 0,
      limit: this.current?.limit,
    };
  }

  /** Start (or restart) a query: a NEW generation with a fresh page 1. */
  async start(
    query: SearchQuery,
    identity: { instanceId: string; permissionRevision: number },
  ): Promise<SearchProjection> {
    const gen = ++this.generation;
    this.current = {
      generation: gen,
      query: query.q,
      domains: query.domains ?? "",
      instanceId: identity.instanceId,
      permissionRevision: identity.permissionRevision,
      limit: query.limit,
    };
    return this.fetchPageOne(gen, query, identity.instanceId);
  }

  /**
   * SERVICES-SEARCH-R1: retire every in-flight request and drop the current
   * generation WITHOUT issuing anything (the page's connection-drop /
   * Desktop-switch retirement). A pre-drop response landing after this is
   * discarded by the generation fence, so it can never become the truth of a
   * newer connection epoch.
   */
  invalidate(): void {
    this.generation += 1;
    this.current = null;
    this.projection = { items: [], nextCursor: null, recovered: false };
    this.emit();
  }

  /** Append the next page — only into the CURRENT generation. */
  async next(): Promise<SearchProjection> {
    const gen = this.current;
    const cursor = this.projection.nextCursor;
    if (!gen || !cursor) return this.projection;
    try {
      const page = await callServices<SearchPage>(this.transport, {
        instance: gen.instanceId,
        operationId: "search.unified",
        method: "GET",
        path: "/v1/services/search",
        query: { q: gen.query, domains: gen.domains || undefined, limit: gen.limit, cursor },
      });
      // A generation change while this was in flight discards the result.
      if (gen.generation !== this.generation) return this.projection;
      this.projection = {
        items: [...this.projection.items, ...(page.items ?? [])],
        nextCursor: page.nextCursor ?? null,
        recovered: false,
      };
      this.emit();
      return this.projection;
    } catch (error) {
      if (gen.generation !== this.generation) return this.projection;
      if (error instanceof ServicesError && error.code === "CURSOR_TOO_OLD") {
        return this.recover(gen, error);
      }
      throw error;
    }
  }

  /**
   * 410 recovery: new generation, no-cursor page 1 for the SAME query, and the
   * projection is REPLACED. Never concatenated, never reported as "no results".
   */
  private async recover(stale: SearchGeneration, cause: ServicesError): Promise<SearchProjection> {
    void cause; // the 410 is an internal recovery trigger, never a user-facing empty
    const gen = ++this.generation;
    this.current = { ...stale, generation: gen };
    const page = await callServices<SearchPage>(this.transport, {
      instance: stale.instanceId,
      operationId: "search.unified",
      method: "GET",
      path: "/v1/services/search",
      // no cursor: a fresh page 1 — with the SAME page size as the generation,
      // so the replacement projection has the identity the user was reading.
      query: { q: stale.query, domains: stale.domains || undefined, limit: stale.limit },
    });
    if (gen !== this.generation) return this.projection;
    this.projection = {
      items: page.items ?? [],
      nextCursor: page.nextCursor ?? null,
      recovered: true,
    };
    this.emit();
    return this.projection;
  }

  private async fetchPageOne(
    gen: number,
    query: SearchQuery,
    instanceId: string,
  ): Promise<SearchProjection> {
    const page = await callServices<SearchPage>(this.transport, {
      instance: instanceId,
      operationId: "search.unified",
      method: "GET",
      path: "/v1/services/search",
      query: { q: query.q, domains: query.domains || undefined, limit: query.limit },
    });
    if (gen !== this.generation) return this.projection;
    this.projection = { items: page.items ?? [], nextCursor: page.nextCursor ?? null, recovered: false };
    this.emit();
    return this.projection;
  }
}
