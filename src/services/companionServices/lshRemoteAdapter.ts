// LshRemote adapter (Issue #77 §3.9) — REUSE, do not re-create.
//
// The #72 LSH Remote Surface is the ONLY LSH authority:
//   lshSurfaceState / lshSurfaceBootstrap / LshSurfaceController
//
// This adapter exists purely so the Services registry can surface generic
// capability/grant display for the LSH operation. It opens NO session, mints NO
// token, and duplicates NO carrier/transport/cookie logic.
//
// If a caller needs to actually enter LightSeek, it must use the existing #72
// path — never this adapter.

import { callServices, type ServicesTransport } from "./transport.ts";
import type { ServiceCatalog } from "../../../shared/companion-services-v1/types.ts";

/** The spec ops that belong to #72 and must stay there. */
export const LSH_OWNED_BY_72 = Object.freeze([
  "lshSurfaceState",
  "lshSurfaceBootstrap",
  "lshSurfaceOpen",
  "lshSurfaceStop",
]);

export type LshCapabilityView = {
  /** Generic display truth from the Services catalog only. */
  state: string;
  grant: string | null;
  /** Always the #72 authority — this adapter never becomes one. */
  authority: "lsh-remote-surface-m1";
};

export class LshRemoteAdapter {
  private transport: ServicesTransport;

  constructor(transport: ServicesTransport) {
    this.transport = transport;
  }

  /**
   * Read ONLY the catalog's view of the LSH operation.
   *
   * This is capability DISPLAY. Entering the surface stays on #72's
   * `LshSurfaceController`; nothing here can open a session.
   */
  async capability(instance: string): Promise<LshCapabilityView> {
    const catalog = await callServices<ServiceCatalog>(this.transport, {
      instance,
      operationId: "services.discover",
      method: "GET",
      path: "/v1/services",
    });
    const entry = catalog?.operations?.["lsh.state"] ?? catalog?.operations?.["lsh.open"];
    return {
      state: entry?.state ?? "unsupported",
      grant: entry?.grant ?? null,
      authority: "lsh-remote-surface-m1",
    };
  }
}
