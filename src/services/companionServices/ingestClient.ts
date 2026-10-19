// IngestClient (Issue #77 §3.4) — canonical bounded ingest.
//
// Rules enforced:
//  - the CALLER supplies a persistent opId; it is never rotated just because a
//    gateway generation changed (reconnect must resume the same job);
//  - the exact same opId+payload replays/resumes; OP_ID_REUSED is terminal;
//  - chunk size is bounded by the canonical catalog limit and chunks are sent
//    through the transport seam — a large file is NEVER read into JS memory as
//    one buffer;
//  - only a bounded chunk seam is exposed: no arbitrary Desktop path API.

import { callServices, type ServicesTransport } from "./transport.ts";
import type { IngestBegin, IngestJob, IngestReceipt } from "../../../shared/companion-services-v1/types.ts";

/** Default bound when the catalog has not been read yet. */
export const INGEST_CHUNK_BYTES = 262144;

/**
 * SHA-256 of one bounded slice, via WebCrypto.
 *
 * WebCrypto is available in the Tauri webview and in Node, so the client stays
 * free of Node-only APIs (the Mobile bundle has no `node:crypto`). Only the
 * slice handed in is hashed — never a whole file.
 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const view = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.slice().buffer;
  const digest = await crypto.subtle.digest("SHA-256", view as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export type ChunkSource = {
  /** Total size in bytes; the caller knows this before streaming. */
  sizeBytes: number;
  /** Read exactly one bounded slice. The seam never hands over the whole file. */
  read: (offset: number, length: number) => Promise<Uint8Array>;
};

export class IngestClient {
  private transport: ServicesTransport;
  private chunkBytes: number;

  constructor(transport: ServicesTransport, chunkBytes: number = INGEST_CHUNK_BYTES) {
    this.transport = transport;
    this.chunkBytes = chunkBytes;
  }

  /** Inline text/url begin (payload carried in the canonical body). */
  async begin(instance: string, input: IngestBegin): Promise<IngestJob> {
    return callServices<IngestJob>(this.transport, {
      instance,
      operationId: "ingest.begin",
      method: "POST",
      path: "/v1/services/ingest/jobs",
      body: input,
    });
  }

  async status(instance: string, jobId: string): Promise<IngestJob> {
    return callServices<IngestJob>(this.transport, {
      instance,
      operationId: "ingest.status",
      method: "GET",
      path: `/v1/services/ingest/jobs/${encodeURIComponent(jobId)}`,
    });
  }

  /**
   * Send ONE bounded chunk at `offset`.
   *
   * The canonical contract requires the slice's own SHA-256 on the request; it
   * is computed here from the exact bytes being sent, so a caller can never
   * declare a hash for different content.
   */
  async chunk(
    instance: string,
    jobId: string,
    offset: number,
    bytes: Uint8Array,
  ): Promise<IngestJob> {
    if (bytes.byteLength > this.chunkBytes) {
      throw new Error("ingest-chunk-exceeds-canonical-limit");
    }
    const sha256 = await sha256Hex(bytes);
    return callServices<IngestJob>(this.transport, {
      instance,
      operationId: "ingest.chunk",
      method: "PUT",
      path: `/v1/services/ingest/jobs/${encodeURIComponent(jobId)}/chunks`,
      chunk: { offset, bytes, sha256 },
    });
  }

  /**
   * Stream `source` in bounded chunks. Resumes from `committedBytes` so a
   * reconnect continues the SAME job/opId instead of restarting.
   */
  async streamChunks(
    instance: string,
    jobId: string,
    source: ChunkSource,
    committedBytes: number,
  ): Promise<IngestJob> {
    if (!Number.isInteger(committedBytes) || committedBytes < 0 || committedBytes > source.sizeBytes) {
      throw new Error("ingest-resume-offset-invalid");
    }
    let offset = committedBytes;
    let last: IngestJob | null = null;
    while (offset < source.sizeBytes) {
      const want = Math.min(this.chunkBytes, source.sizeBytes - offset);
      const bytes = await source.read(offset, want);
      // The loop advances BY `bytes.byteLength`, so a source that returns fewer
      // bytes than asked (or none at all) either stalls forever or silently
      // skips bytes. Both are refused instead of trusted.
      if (!bytes || bytes.byteLength === 0) {
        throw new Error("ingest-source-read-empty");
      }
      if (bytes.byteLength > want) {
        throw new Error("ingest-source-read-oversized");
      }
      if (bytes.byteLength !== want) {
        throw new Error("ingest-source-read-short");
      }
      // Defence in depth: the canonical chunk contract hashes the exact slice,
      // so a source that mutated the bytes between read and send is caught.
      last = await this.chunk(instance, jobId, offset, bytes);
      offset += bytes.byteLength;
    }
    return last ?? this.status(instance, jobId);
  }

  /**
   * Complete the job.
   *
   * The canonical response is the finished JOB carrying its receipt (the job
   * stays replayable), so the receipt is unwrapped here rather than pretending
   * the wire shape is the receipt itself. A replayed complete returns the same
   * job/receipt — it is not a second ingest.
   */
  async complete(instance: string, jobId: string): Promise<IngestReceipt> {
    const job = await callServices<IngestJob>(this.transport, {
      instance,
      operationId: "ingest.complete",
      method: "POST",
      path: `/v1/services/ingest/jobs/${encodeURIComponent(jobId)}/complete`,
      body: {},
    });
    if (!job?.receipt) throw new Error("ingest-complete-without-receipt");
    return job.receipt;
  }

  async cancel(instance: string, jobId: string): Promise<IngestJob> {
    return callServices<IngestJob>(this.transport, {
      instance,
      operationId: "ingest.cancel",
      method: "POST",
      path: `/v1/services/ingest/jobs/${encodeURIComponent(jobId)}/cancel`,
      body: {},
    });
  }
}
