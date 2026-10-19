// SERVICES-INTEGRATION-R3 — acceptance-only production Services matrix driver.
//
// This surface exists ONLY in a build compiled with
// `VITE_LUCKYRAY_SERVICES_ACCEPTANCE=1` (see acceptanceFlag.ts / main.tsx); a
// normal build never ships this module and has no route or button to reach it.
//
// It is diagnostic plumbing, not product UI and not a second Services
// implementation:
//   - the ONE production composition (`createProductionServices()`) is
//     constructed per driver mount and every operation below calls those
//     production clients — no fetch, no WebSocket, no handcrafted HTTP/JSON;
//   - the Desktop instance comes from the app's EXISTING pairing authority
//     (`api.connState()`), the same source Content/LSH trust — there is no
//     manual origin/token field and no second pairing store;
//   - evidence rows are produced ONLY by the allowlisted redacting builder in
//     acceptanceLog.ts — credentials, raw bodies, source URLs and filesystem
//     paths cannot enter the log by construction;
//   - the stepwise controls exist so the FROZEN epoch367 real-LAN matrix can be
//     driven from the installed APK: search pagination, interrupted ingest with
//     the SAME opId/jobId resumed from the server's committedBytes, same-opId
//     presentation replay, read-only material detail evidence, and hint
//     start/read/stop as independent observations.
//
// Acceptance ownership: objects come from the in-memory acceptance sample or
// from already-returned authorized data. No user file is read, no destructive
// write is issued, no opId is ever replaced after the operation that owns it.

import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createProductionServices,
  createTauriServicesTransport,
  callServices,
  SearchSession,
  ServicesError,
  INGEST_CHUNK_BYTES,
  type CompanionServices,
  type ServicesTransport,
} from "../services/companionServices/index.ts";
import type { PresentationTarget } from "../../shared/companion-services-v1/types.ts";
import { api, type ConnState } from "../services/client.ts";
import { acceptanceEvent, formatEvent, type AcceptanceEvent } from "./acceptanceLog.ts";
import { acceptanceUuidV4 } from "./acceptanceUuid.ts";

/** Acceptance-owned sample: in-memory, bounded, >1 canonical chunk. */
const SAMPLE_CHUNKS = 3;
const SAMPLE_BYTES = SAMPLE_CHUNKS * INGEST_CHUNK_BYTES;

function acceptanceSample(): Uint8Array {
  const bytes = new Uint8Array(SAMPLE_BYTES);
  // Deterministic filler (no crypto needed for content): readable ASCII so a
  // truncated wire dump could never contain anything sensitive anyway.
  for (let i = 0; i < SAMPLE_BYTES; i++) {
    bytes[i] = 32 + ((i * 7) % 95);
  }
  return bytes;
}

async function sha256HexOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const MAX_MESSAGE = 120;

function describeError(error: unknown): { code?: string; status?: number } {
  if (error instanceof ServicesError) {
    return { code: error.code, status: error.status };
  }
  // A non-Services failure keeps its bounded message only — never a stack or body.
  return { code: String((error as Error)?.message ?? error).slice(0, MAX_MESSAGE) };
}

/** Acceptance-local ingest job identity: ONE opId for the whole acceptance action. */
type IngestState = {
  opId: string;
  sample: Uint8Array;
  jobId: string | null;
};

/** Acceptance-local presentation handle: ONE opId + ONE immutable target. */
type PresentationState = {
  opId: string;
  target: PresentationTarget;
};

export function AcceptanceDriver() {
  const servicesRef = useRef<CompanionServices | null>(null);
  if (!servicesRef.current) servicesRef.current = createProductionServices();
  const services = servicesRef.current;

  const transportRef = useRef<ServicesTransport | null>(null);
  if (!transportRef.current) transportRef.current = createTauriServicesTransport();
  // SearchSession is intentionally per-owner (never a registry member); the
  // driver owns ONE session whose projection survives between start/next
  // presses, so the real pagination/recovery matrix runs on the production
  // transport seam.
  const sessionRef = useRef<SearchSession | null>(null);

  const [conn, setConn] = useState<ConnState | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<AcceptanceEvent[]>([]);

  // Acceptance-owned state, kept across presses so each step of the frozen
  // matrix can run as its own button.
  const ingestRef = useRef<IngestState | null>(null);
  const ingestAssetIdRef = useRef<string>("");
  const presentationRef = useRef<PresentationState | null>(null);
  const materialAssetRef = useRef<string>("");

  const push = (event: AcceptanceEvent) => setLog((prev) => [event, ...prev].slice(0, 200));

  const instance = conn?.identity?.instanceId ?? "";
  const paired = Boolean(conn?.paired) && instance !== "";

  /** The presentation target: the acceptance-owned ingest asset when present. */
  const selectedAssetId = (): string => ingestAssetIdRef.current || materialAssetRef.current;

  const refreshConn = async () => {
    try {
      const state = await api.connState();
      setConn(state);
      push(acceptanceEvent("connState", true, {
        instance: state.identity?.instanceId ?? "",
        state: state.ws?.state ?? "",
        kind: state.paired ? "paired" : "unpaired",
      }));
    } catch (error) {
      push(acceptanceEvent("connState", false, describeError(error)));
    }
  };

  const run = (op: string, step: (instance: string) => Promise<void>) => {
    if (busy) return;
    if (!paired) {
      push(acceptanceEvent(op, false, { code: "PAIRING_REQUIRED" }));
      return;
    }
    setBusy(true);
    void (async () => {
      try {
        await step(instance);
      } catch (error) {
        push(acceptanceEvent(op, false, describeError(error)));
      } finally {
        setBusy(false);
      }
    })();
  };

  // --- discovery / currentness ---------------------------------------------

  const runDiscover = () => run("services.discover", async (inst) => {
    // A cold client learns the gateway generation from the canonical catalog
    // itself: one bounded services.discover through the SAME production
    // transport the registry uses, then the registry re-reads and ADOPTS the
    // catalog under the learned identity (its mismatch guards stay intact).
    // Re-running this after a Desktop restart / grant change re-reads
    // gatewayGeneration and permissionRevision through the production path.
    const probe = await callServices<Record<string, unknown>>(transportRef.current!, {
      instance: inst,
      operationId: "services.discover",
      method: "GET",
      path: "/v1/services",
    });
    const catalog = await services.registry.refresh({
      instanceId: inst,
      gatewayGeneration: Number(probe?.gatewayGeneration ?? 0),
      permissionRevision: Number(probe?.permissionRevision ?? 0),
    });
    push(acceptanceEvent("services.discover", true, {
      gatewayGeneration: catalog.gatewayGeneration,
      permissionRevision: catalog.permissionRevision,
      bundleRevision: catalog.bundleRevision,
      namespace: services.registry.currentNamespace(),
      operations: Object.keys(catalog.operations ?? {}).length,
    }));
  });

  // --- materials -------------------------------------------------------------

  const runMaterials = () => run("materials.changes", async (inst) => {
    const snapshot = await services.materials.changes(inst, null);
    // Fallback presentation/detail target: the first LIVE authorized item this
    // run actually received — never an invented id.
    materialAssetRef.current = snapshot.items.find((i) => !i.tombstone)?.assetId ?? "";
    push(acceptanceEvent("materials.changes", true, {
      generation: snapshot.generation,
      count: snapshot.items.length,
      nextCursor: snapshot.nextCursor ?? "",
      recovered: snapshot.recovered,
      assetId: materialAssetRef.current,
    }));
    const catchUp = await services.materials.changes(inst, snapshot.nextCursor);
    push(acceptanceEvent("materials.changes:catch-up", true, {
      generation: catchUp.generation,
      count: catchUp.items.length,
      cursor: catchUp.nextCursor ?? "",
    }));
  });

  const runMaterialDetail = () => run("materials.detailV1", async (inst) => {
    const assetId = selectedAssetId();
    if (!assetId) {
      push(acceptanceEvent("materials.detailV1", false, { code: "ENTITY_NOT_FOUND" }));
      return;
    }
    const detail = await services.materials.detailV1(inst, assetId);
    // Bounded non-secret evidence ONLY: identifiers, revision, and the safe
    // source-shape booleans. The full source URL / raw body / any filesystem
    // path can never pass the allowlist builder.
    push(acceptanceEvent("materials.detailV1", true, {
      assetId: detail.assetId,
      revision: detail.revision,
      kind: detail.kind,
      sizeBytes: detail.sizeBytes,
      captureKind: detail.source?.captureKind ?? "absent",
      pageKind: detail.source?.pageKind ?? "absent",
      sourcePresent: Boolean(detail.source),
    }));
  });

  // --- knowledge ---------------------------------------------------------------

  const runKnowledge = () => run("knowledge.vaults", async (inst) => {
    const vaults = await services.knowledge.vaults(inst);
    const vaultId = vaults.items[0]?.vaultId ?? "";
    push(acceptanceEvent("knowledge.vaults", true, { count: vaults.items.length, vaultId }));
    if (!vaultId) return; // nothing registered: the read itself is the evidence
    const page = await services.knowledge.registeredList(inst, vaultId, { limit: 5 });
    push(acceptanceEvent("knowledge.registeredList", true, { count: page.items.length, noteId: page.items[0]?.noteId ?? "" }));
    const changes = await services.knowledge.registeredChanges(inst, vaultId, null);
    push(acceptanceEvent("knowledge.registeredChanges", true, {
      generation: changes.generation,
      count: changes.items.length,
      nextCursor: changes.nextCursor ?? "",
    }));
  });

  // --- hints: start / refresh-read / scoped stop are INDEPENDENT controls ----

  const runHintsStart = () => run("hints.start", async (inst) => {
    await services.changeFeed.start(inst);
    const mode = services.changeFeed.currentMode();
    push(acceptanceEvent("hints.start", true, {
      mode,
      boundGeneration: services.changeFeed.boundGeneration() ?? -1,
    }));
  });

  const runHintsRead = () => run("hints.read", async () => {
    // Observation ONLY: refreshMode() re-validates the existing binding
    // (owner/generation) and readHints() drains it — neither can START a new
    // worker or adopt a foreign scope.
    const mode = await services.changeFeed.refreshMode();
    const records = await services.changeFeed.readHints();
    push(acceptanceEvent("hints.read", true, {
      mode,
      boundGeneration: services.changeFeed.boundGeneration() ?? -1,
      count: records.length,
      kind: records.map((h) => h.kind).join(",") || "none",
    }));
  });

  const runHintsStop = () => run("hints.stop", async () => {
    await services.changeFeed.stop();
    push(acceptanceEvent("hints.stop", true, { mode: services.changeFeed.currentMode() }));
  });

  // --- stepwise resumable ingest (acceptance-owned sample) -------------------

  const runIngestBegin = () => run("ingest.begin", async (inst) => {
    if (ingestRef.current?.jobId) {
      push(acceptanceEvent("ingest.begin", false, { code: "OP_ID_REUSED" }));
      return;
    }
    if (!ingestRef.current) {
      // ONE caller-minted opId owns this acceptance action until reset. The
      // mint is WebView-83 compatible (no crypto.randomUUID there).
      ingestRef.current = { opId: acceptanceUuidV4(), sample: acceptanceSample(), jobId: null };
    }
    const state = ingestRef.current;
    const job = await services.ingest.begin(inst, {
      opId: state.opId,
      kind: "file",
      target: { domain: "materials" },
      name: "luckyray-acceptance-sample.txt",
      mimeType: "text/plain",
      sizeBytes: state.sample.byteLength,
      sha256: await sha256HexOf(state.sample),
    });
    state.jobId = job.jobId;
    push(acceptanceEvent("ingest.begin", true, {
      jobId: job.jobId,
      state: job.state,
      committedBytes: job.committedBytes,
      sizeBytes: state.sample.byteLength,
    }));
  });

  const runIngestStatus = () => run("ingest.status", async (inst) => {
    const state = ingestRef.current;
    if (!state?.jobId) {
      push(acceptanceEvent("ingest.status", false, { code: "ENTITY_NOT_FOUND" }));
      return;
    }
    const job = await services.ingest.status(inst, state.jobId);
    push(acceptanceEvent("ingest.status", true, {
      jobId: job.jobId,
      state: job.state,
      committedBytes: job.committedBytes,
    }));
  });

  const runIngestNextChunk = () => run("ingest.next-chunk", async (inst) => {
    const state = ingestRef.current;
    if (!state?.jobId) {
      push(acceptanceEvent("ingest.next-chunk", false, { code: "ENTITY_NOT_FOUND" }));
      return;
    }
    // Ask the SERVER how much it holds, then send exactly ONE more bounded
    // canonical chunk from that offset. After a controlled interruption this
    // is the same job, the same opId, resumed by offset/hash — never a new job.
    const job = await services.ingest.status(inst, state.jobId);
    if (job.state !== "staging") {
      push(acceptanceEvent("ingest.next-chunk", true, {
        jobId: job.jobId, state: job.state, committedBytes: job.committedBytes,
      }));
      return;
    }
    const offset = job.committedBytes;
    if (offset >= state.sample.byteLength) {
      push(acceptanceEvent("ingest.next-chunk", true, {
        jobId: job.jobId, state: job.state, committedBytes: offset,
      }));
      return;
    }
    const length = Math.min(INGEST_CHUNK_BYTES, state.sample.byteLength - offset);
    const updated = await services.ingest.chunk(
      inst, state.jobId, offset, state.sample.subarray(offset, offset + length),
    );
    push(acceptanceEvent("ingest.next-chunk", true, {
      jobId: updated.jobId,
      state: updated.state,
      committedBytes: updated.committedBytes,
      sizeBytes: state.sample.byteLength,
    }));
  });

  const runIngestResume = () => run("ingest.resume", async (inst) => {
    const state = ingestRef.current;
    if (!state?.jobId) {
      push(acceptanceEvent("ingest.resume", false, { code: "ENTITY_NOT_FOUND" }));
      return;
    }
    // SAME job: read the server's committedBytes and stream the remainder.
    // streamChunks resumes from the returned offset and never mints anything.
    const job = await services.ingest.status(inst, state.jobId);
    const finished = job.state === "completed"
      ? job
      : await services.ingest.streamChunks(inst, job.jobId, {
        sizeBytes: state.sample.byteLength,
        read: async (offset, length) => state.sample.subarray(offset, offset + length),
      }, job.committedBytes);
    push(acceptanceEvent("ingest.resume", true, {
      jobId: finished.jobId,
      state: finished.state,
      committedBytes: finished.committedBytes,
    }));
  });

  const runIngestComplete = () => run("ingest.complete", async (inst) => {
    const state = ingestRef.current;
    if (!state?.jobId) {
      push(acceptanceEvent("ingest.complete", false, { code: "ENTITY_NOT_FOUND" }));
      return;
    }
    // complete() unwraps the canonical finished job into its durable receipt;
    // a replayed complete returns the same receipt (idempotent same-op).
    const receipt = await services.ingest.complete(inst, state.jobId);
    ingestAssetIdRef.current = receipt.assetId ?? "";
    push(acceptanceEvent("ingest.complete", true, {
      jobId: state.jobId,
      opId: state.opId,
      assetId: receipt.assetId ?? "",
      outcome: receipt.domain,
    }));
  });

  const runIngestReset = () => {
    // Acceptance-local reset ONLY, allowed once the action is terminal; no
    // Desktop job is cancelled or restarted here.
    if (ingestRef.current?.jobId) {
      push(acceptanceEvent("ingest.reset", false, { code: "INPUT_INVALID" }));
      return;
    }
    ingestRef.current = null;
    ingestAssetIdRef.current = "";
    push(acceptanceEvent("ingest.reset", true, { kind: "cleared" }));
  };

  // --- presentation: open once, then replay the SAME op ----------------------

  const presentationTarget = (): PresentationTarget | null => {
    const assetId = selectedAssetId();
    return assetId ? { domain: "materials", assetId } : null;
  };

  const runPresentationOpen = () => run("presentation.open", async (inst) => {
    const target = presentationTarget();
    if (!target) {
      push(acceptanceEvent("presentation.open", false, { code: "ENTITY_NOT_FOUND" }));
      return;
    }
    if (!presentationRef.current) {
      // ONE acceptance opId + ONE immutable target, retained for replay. The
      // mint is WebView-83 compatible (no crypto.randomUUID there).
      presentationRef.current = { opId: acceptanceUuidV4(), target };
    }
    const handle = presentationRef.current;
    const outcome = await services.presentation.open(inst, handle.opId, handle.target);
    push(acceptanceEvent("presentation.open", true, {
      outcome: outcome.kind,
      state: "state" in outcome ? outcome.state : "",
      reason: outcome.kind === "refused" ? outcome.reason ?? "" : "",
      opId: handle.opId,
      assetId: "assetId" in handle.target ? handle.target.assetId : "",
    }));
  });

  const runPresentationReplay = () => run("presentation.replay", async (inst) => {
    const handle = presentationRef.current;
    if (!handle) {
      push(acceptanceEvent("presentation.replay", false, { code: "ENTITY_NOT_FOUND" }));
      return;
    }
    // SAME opId + SAME target — the lost-ACK / late-ACK path. replay() never
    // mints a second opId (and the driver would refuse to anyway).
    const outcome = await services.presentation.replay(inst, handle.opId, handle.target);
    push(acceptanceEvent("presentation.replay", true, {
      outcome: outcome.kind,
      state: "state" in outcome ? outcome.state : "",
      reason: outcome.kind === "refused" ? outcome.reason ?? "" : "",
      opId: handle.opId,
      assetId: "assetId" in handle.target ? handle.target.assetId : "",
    }));
  });

  // --- search: ONE session, start and next as separate controls --------------

  const runSearchStart = () => run("search.start", async (inst) => {
    if (!sessionRef.current) sessionRef.current = new SearchSession(transportRef.current!);
    const projection = await sessionRef.current.start(
      { q: "luckyray", limit: 5 },
      { instanceId: inst, permissionRevision: services.registry.permissionRevision() ?? 0 },
    );
    push(acceptanceEvent("search.start", true, {
      count: projection.items.length,
      nextCursor: projection.nextCursor ?? "",
      recovered: projection.recovered,
    }));
  });

  const runSearchNext = () => run("search.next", async () => {
    // The RETAINED session: `next()` appends into the CURRENT generation and
    // exercises the production cursor/final-page/410-recovery paths.
    if (!sessionRef.current) {
      push(acceptanceEvent("search.next", false, { code: "ENTITY_NOT_FOUND" }));
      return;
    }
    const projection = await sessionRef.current.next();
    push(acceptanceEvent("search.next", true, {
      count: projection.items.length,
      nextCursor: projection.nextCursor ?? "",
      recovered: projection.recovered,
    }));
  });

  // --- minimal diagnostic shell ----------------------------------------------

  const button = (label: string, onClick: () => void) => (
    <button key={label} onClick={onClick} disabled={busy || !paired}
      style={styles.button}>{label}</button>
  );

  return (
    <div style={styles.page}>
      <h2 style={styles.heading}>Services V1 acceptance matrix driver</h2>
      <p style={styles.caption}>
        build-flag VITE_LUCKYRAY_SERVICES_ACCEPTANCE=1 — acceptance-only, not part of the product
      </p>
      <div style={styles.row}>
        <button onClick={() => void refreshConn()} disabled={busy} style={styles.button}>connState</button>
        <span style={styles.state}>
          {paired ? `paired ${instance}` : "not paired — pair through the product flow first"}
        </span>
      </div>
      <div style={styles.row}>
        {button("discover", runDiscover)}
        {button("materials changes", runMaterials)}
        {button("materials detail", runMaterialDetail)}
        {button("knowledge", runKnowledge)}
      </div>
      <div style={styles.row}>
        {button("hints start", runHintsStart)}
        {button("hints read", runHintsRead)}
        {button("hints stop", runHintsStop)}
      </div>
      <div style={styles.row}>
        {button("ingest begin", runIngestBegin)}
        {button("ingest status", runIngestStatus)}
        {button("ingest next chunk", runIngestNextChunk)}
        {button("ingest resume", runIngestResume)}
        {button("ingest complete", runIngestComplete)}
        {button("ingest reset", runIngestReset)}
      </div>
      <div style={styles.row}>
        {button("presentation open", runPresentationOpen)}
        {button("presentation replay", runPresentationReplay)}
        {button("search start", runSearchStart)}
        {button("search next", runSearchNext)}
      </div>
      <div style={styles.log}>
        {log.map((event, index) => (
          <div key={`${event.t}-${index}`} style={styles.logLine}>{formatEvent(event)}</div>
        ))}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: { fontFamily: "monospace", padding: 16, background: "#111", color: "#ddd", minHeight: "100vh" },
  heading: { fontSize: 16, margin: "0 0 4px" },
  caption: { fontSize: 11, color: "#8a8", margin: "0 0 12px" },
  row: { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 12 },
  button: { fontFamily: "monospace", fontSize: 12, padding: "6px 10px", background: "#243", color: "#dfd", border: "1px solid #465", borderRadius: 4 },
  state: { fontSize: 12, color: "#aaa" },
  log: { fontSize: 11, lineHeight: 1.5, wordBreak: "break-all" },
  logLine: { whiteSpace: "pre-wrap" },
};

/** Entry used by main.tsx under the acceptance flag; the product never mounts. */
export function mountAcceptanceDriver(): void {
  const host = document.getElementById("root");
  if (!host) return;
  createRoot(host).render(<AcceptanceDriver />);
}
