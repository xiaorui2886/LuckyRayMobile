// SERVICES-ASSET-DETAIL-R1 REPAIR-R2 — the production source-enrichment
// currentness seam for the ordinary desktop-asset detail page.
//
// This IS the implementation the page uses (no test replica): a tiny
// latest-request-wins controller around `materials.detailV1` with
//   - an independent request token;
//   - exact owner+asset binding per bind();
//   - a liveness fence (the page's route generation) on every commit;
//   - retire() for route/unmount/connection-drop;
//   - explicit retry() as the permission-change recovery path
//     (no polling, no new wire protocol).
//
// The commit callback receives bounded states only; the page maps them to UI.

import type { MaterialDetail, SafeSource } from "../../shared/companion-services-v1/types.ts";

export type SourceCommit =
  | { phase: "loading" }
  | { phase: "ready"; source: SafeSource | undefined }
  | { phase: "error"; code: string };

export type SourceEnrichmentBinding = {
  owner: string;
  assetId: string;
  /** The page's route-generation fence; a commit requires this to hold. */
  isLive: () => boolean;
};

export type SourceEnrichmentDeps = {
  detailV1: (owner: string, assetId: string) => Promise<MaterialDetail>;
  commit: (commit: SourceCommit) => void;
  /** Map a thrown failure to its canonical code (page-owned mapping). */
  errorCodeOf?: (error: unknown) => string;
};

export class SourceEnrichmentController {
  private token = 0;
  private binding: SourceEnrichmentBinding | null = null;
  private readonly deps: SourceEnrichmentDeps;

  constructor(deps: SourceEnrichmentDeps) {
    this.deps = deps;
  }

  /** Bind to a page context. Retires any outstanding request first. */
  bind(binding: SourceEnrichmentBinding): void {
    this.token += 1; // retire whatever was outstanding
    this.binding = binding;
  }

  /** Route/unmount/connection-drop: everything outstanding becomes a no-op. */
  retire(): void {
    this.token += 1;
    this.binding = null;
  }

  /**
   * Issue (or re-issue) the enrichment for the CURRENT binding.
   * Only the newest token may commit; a stale resolution is dropped whole.
   */
  load(): void {
    const binding = this.binding;
    if (!binding) return;
    const token = ++this.token;
    const committed = () =>
      token === this.token && binding.isLive();

    this.deps.commit({ phase: "loading" });
    void this.deps
      .detailV1(binding.owner, binding.assetId)
      .then((detail) => {
        if (!committed()) return;
        this.deps.commit({ phase: "ready", source: detail.source });
      })
      .catch((error) => {
        if (!committed()) return;
        const code = this.deps.errorCodeOf
          ? this.deps.errorCodeOf(error)
          : "TRANSPORT_FAILED";
        this.deps.commit({ phase: "error", code });
      });
  }
}
