// Production Services V1 transport (Issue #77 §2 / REPAIR-R1 P1-T1).
//
// The ONE production implementation of `ServicesTransport`. It does NOT talk to
// a Desktop itself: it hands the request to the Rust authority, which captures
// the expected owner, reuses the pinned Companion gateway (rustls + pinned
// fingerprint + the existing Bearer), and enforces the closed operation
// allowlist BEFORE any wire send.
//
// Consequences that matter:
//  - no fetch/WebSocket from TS, and no Desktop origin is ever constructed here;
//  - no certificate, token or pairing state exists on this side;
//  - the canonical HTTP status and error code come back verbatim, so a caller
//    can branch on CURSOR_TOO_OLD / OP_ID_REUSED / handshake states;
//  - a request the Rust allowlist refuses surfaces as a `ServicesError` with the
//    refusal code and NO status, i.e. it never reached the network.

import { invoke } from "@tauri-apps/api/core";
import {
  ServicesError, mapLocalRefusal, errorCodeOf, type ServicesRequest,
  type ServicesResponse, type ServicesTransport,
} from "./transport.ts";
import { createKnowledgeDiagnostics, nativeKnowledgeTraceSink } from "./knowledgeDiagnostics.ts";

const knowledgeDiagnostics = createKnowledgeDiagnostics(import.meta.env?.VITE_LR_KNOWLEDGE_DIAGNOSTICS === "1", {sink: nativeKnowledgeTraceSink(invoke)});

/** Raw shape the Rust command returns (mirrors `ServicesResponse`). */
type RustReply = { status: number; body: unknown; retry_after_ms?: number };

/** Raw shape a pre-wire refusal returns (`ServicesRefusal`). */
type RustRefusal = { code: string };

function isRefusal(value: unknown): value is RustRefusal {
  return Boolean(value) && typeof value === "object" && typeof (value as any).code === "string"
    && (value as any).status === undefined;
}

/** Base64 of one bounded chunk, without Node APIs. */
export function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Production transport over the Tauri command.
 *
 * `invokeRef` is injectable so tests can drive this exact adapter with a fake
 * authority (no live Desktop, no real Tauri runtime) while exercising the same
 * request shaping and the same refusal/status handling as production.
 */
export function createTauriServicesTransport(
  invokeRef: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> = invoke,
  scope?: Readonly<{library?: string; vault?: string}>,
): ServicesTransport {
  const capturedScope = scope ? {...scope} : undefined;
  return {
    async request(req: ServicesRequest): Promise<ServicesResponse> {
      const finishTrace = knowledgeDiagnostics.begin(req.operationId, req.vault ?? capturedScope?.vault);
      const payload: Record<string, unknown> = {
        instance: req.instance,
        library: req.library ?? capturedScope?.library,
        vault: req.vault ?? capturedScope?.vault,
        operationId: req.operationId,
        method: req.method,
        path: req.path,
        query: req.query
          ? Object.fromEntries(
              Object.entries(req.query)
                .filter(([, v]) => v !== undefined)
                .map(([k, v]) => [k, String(v)]),
            )
          : {},
        body: req.body ?? null,
        chunk: req.chunk
          ? {
              offset: req.chunk.offset,
              bytes_base64: base64Of(req.chunk.bytes),
              sha256: req.chunk.sha256,
            }
          : null,
      };
      let reply: unknown;
      try {
        reply = await invokeRef("services_v1_request", { request: payload });
      } catch (error) {
        // The command rejected: either a pre-wire refusal (an object with a
        // code) or an infrastructure failure (a string). Both are faithful
        // failures — never a silent empty success. A pre-wire refusal carries
        // status 0 so it can never be mistaken for a Desktop HTTP answer.
        if (isRefusal(error)) {
          // ONE mapping boundary: internal Rust vocabulary -> canonical client
          // vocabulary. No unchecked cast can reach a caller.
          const code = mapLocalRefusal(error.code);
          finishTrace({phase: "refusal", status: 0, code});
          throw new ServicesError(code, 0);
        }
        finishTrace({phase: "refusal", status: 0, code: "TRANSPORT_FAILED"});
        throw new ServicesError("TRANSPORT_FAILED", 0);
      }
      const typed = reply as RustReply;
      if (!typed || typeof typed.status !== "number") {
        finishTrace({phase: "invalid-reply", status: 0, code: "MALFORMED_RESPONSE"});
        throw new ServicesError("MALFORMED_RESPONSE", 0);
      }
      finishTrace({phase: "reply", status: typed.status,
        code: typed.status >= 200 && typed.status < 300 ? undefined : errorCodeOf(typed.body), body: typed.body});
      return { status: typed.status, body: typed.body, ...(typeof typed.retry_after_ms === "number" && Number.isFinite(typed.retry_after_ms) && typed.retry_after_ms >= 0 ? {retryAfterMs: typed.retry_after_ms} : {}) };
    },
  };
}
