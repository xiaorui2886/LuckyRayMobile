// Companion Services V1 — transport seam (Issue #77).
//
// PRODUCTION: the only implementation is the pinned Desktop gateway reached
// through the existing Rust authority (TS -> Tauri command -> Rust captured
// expected Desktop -> pinned GatewayClient -> Bearer HTTPS). This module owns
// NO credential, NO certificate and NO pairing state of its own: it is a thin
// request shape that the Rust side fills with the captured pinned gateway.
//
// TESTS: the vendored canonical fixture is adapted to this same seam, so the
// exact same clients run against fixture and production. There is deliberately
// no second "test-only client implementation".
//
// Canonical wire detail (paths, error codes, DTOs) lives in the vendored
// `shared/companion-services-v1/**` — it is never re-invented here.

export type ServicesRequest = {
  /** Bound to the Desktop instance the caller proved before the send. */
  instance: string;
  library?: string;
  vault?: string;
  /** Canonical operation id (operations.json), used for diagnostics only. */
  operationId: string;
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Canonical path WITHOUT the origin, e.g. /v1/services/materials/changes */
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /**
   * Raw chunk transport (ingest). Never a Desktop filesystem path and never the
   * whole file: the caller hands over ONE bounded slice with its offset and its
   * own SHA-256, exactly as the canonical ingest chunk contract requires.
   */
  chunk?: { offset: number; bytes: Uint8Array; sha256: string };
};

export type ServicesResponse = {
  /** Parsed by the pinned native response boundary; bounded by retry policy. */
  retryAfterMs?: number;
  status: number;
  body: unknown;
};

export type ServicesTransport = {
  invalidate?: (instance?: string, scope?: Readonly<{library?: string; vault?: string}>) => void;
  request: (req: ServicesRequest) => Promise<ServicesResponse>;
};

/** Canonical error code carried by every non-2xx Services response. */
export type ServicesErrorCode =
  | "AUTH_REVOKED" | "PAIRING_REQUIRED" | "GRANT_REQUIRED" | "SCOPE_DENIED"
  | "SERVICE_UNAVAILABLE" | "VERSION_UNSUPPORTED" | "REVISION_CONFLICT"
  | "OP_ID_REUSED" | "RECEIPT_EXPIRED" | "CURSOR_TOO_OLD" | "ENTITY_NOT_FOUND"
  | "SOURCE_CHANGED" | "PAYLOAD_TOO_LARGE" | "NOTE_TOO_LARGE" | "RATE_LIMITED" | "DESKTOP_DRAFT_BUSY"
  | "UPLOAD_OFFSET_MISMATCH" | "UPLOAD_HASH_MISMATCH" | "UPLOAD_INCOMPLETE"
  | "JOB_NOT_OWNED" | "INPUT_INVALID" | "METHOD_NOT_ALLOWED" | "PRESENTATION_BUSY"
  | "TRANSPORT_FAILED" | "MALFORMED_RESPONSE";

/**
 * A faithful Services failure. The canonical code is preserved verbatim so a
 * caller can branch on `CURSOR_TOO_OLD` / `OP_ID_REUSED` / `handoffStarted`
 * semantics instead of guessing from a status number.
 */
export class ServicesError extends Error {
  readonly code: ServicesErrorCode;
  readonly status: number;
  constructor(code: ServicesErrorCode, status: number) {
    super(`${code} (HTTP ${status})`);
    this.name = "ServicesError";
    this.code = code;
    this.status = status;
  }
}

/**
 * The canonical vocabulary a Desktop may legitimately return.
 *
 * Anything outside this set becomes MALFORMED_RESPONSE: the wire is not
 * trusted to invent a code the client would then branch on.
 */
export const CANONICAL_REMOTE_CODES: readonly ServicesErrorCode[] = Object.freeze([
  "AUTH_REVOKED", "PAIRING_REQUIRED", "GRANT_REQUIRED", "SCOPE_DENIED",
  "SERVICE_UNAVAILABLE", "VERSION_UNSUPPORTED", "REVISION_CONFLICT",
  "OP_ID_REUSED", "RECEIPT_EXPIRED", "CURSOR_TOO_OLD", "ENTITY_NOT_FOUND",
  "SOURCE_CHANGED", "PAYLOAD_TOO_LARGE", "NOTE_TOO_LARGE", "RATE_LIMITED", "DESKTOP_DRAFT_BUSY",
  "UPLOAD_OFFSET_MISMATCH", "UPLOAD_HASH_MISMATCH", "UPLOAD_INCOMPLETE",
  "JOB_NOT_OWNED", "INPUT_INVALID", "METHOD_NOT_ALLOWED", "PRESENTATION_BUSY",
]);

/**
 * Read the canonical error code off a response body.
 *
 * A code the canonical vocabulary does not contain is MALFORMED_RESPONSE — the
 * client never branches on an unchecked cast.
 */
export function errorCodeOf(body: unknown): ServicesErrorCode {
  if (body && typeof body === "object" && typeof (body as any).code === "string") {
    const code = (body as any).code as ServicesErrorCode;
    return CANONICAL_REMOTE_CODES.includes(code) ? code : "MALFORMED_RESPONSE";
  }
  return "MALFORMED_RESPONSE";
}

/**
 * ONE boundary that maps local/internal Rust refusal vocabulary into the
 * canonical client vocabulary.
 *
 * Before this existed, `productionTransport` cast an arbitrary internal string
 * (`CONTENT_SOURCE_CHANGED`, `CONTENT_DISCONNECTED`, allowlist `SERVICES_*`, …)
 * straight into `ServicesErrorCode`, which hid a real vocabulary mismatch: those
 * strings are NOT canonical codes the client is allowed to branch on.
 *
 * Mapping rules (from the canonical error table):
 *   owner moved / source changed      -> SOURCE_CHANGED
 *   offline / disconnected / no gw    -> SERVICE_UNAVAILABLE
 *   missing pairing / credential      -> PAIRING_REQUIRED
 *   malformed local request shape     -> INPUT_INVALID
 *   anything unrecognised             -> TRANSPORT_FAILED (local) at the boundary,
 *                                        MALFORMED_RESPONSE for a wire code
 */
export function mapLocalRefusal(code: string): ServicesErrorCode {
  switch (code) {
    case "CONTENT_SOURCE_CHANGED":
    case "SOURCE_CHANGED":
      return "SOURCE_CHANGED";
    case "CONTENT_OFFLINE":
    case "CONTENT_DISCONNECTED":
    case "SERVICE_UNAVAILABLE":
      return "SERVICE_UNAVAILABLE";
    case "PAIRING_REQUIRED":
      return "PAIRING_REQUIRED";
    case "PAIRING_MISSING":
    case "PAIRING_INVALID":
      return "PAIRING_REQUIRED";
    case "SERVICES_OPERATION_NOT_ALLOWED":
    case "SERVICES_PATH_NOT_ALLOWED":
    case "SERVICES_PATH_INVALID":
    case "SERVICES_METHOD_INVALID":
    case "SERVICES_HEADER_INVALID":
    case "SERVICES_CHUNK_INVALID":
    case "SERVICES_QUERY_NOT_ALLOWED":
    case "SERVICES_QUERY_CREDENTIAL_FORBIDDEN":
    case "INPUT_INVALID":
    case "CONTENT_ID_INVALID":
      return "INPUT_INVALID";
    case "CONTENT_RESPONSE_TOO_LARGE":
    case "PAYLOAD_TOO_LARGE":
      return "PAYLOAD_TOO_LARGE";
    case "CONTENT_RESPONSE_INVALID":
      return "MALFORMED_RESPONSE";
    case "UPLOAD_HASH_MISMATCH":
      return "UPLOAD_HASH_MISMATCH";
    default:
      // A canonical code passes through; anything else is an unknown internal
      // failure the client must not branch on.
      return CANONICAL_REMOTE_CODES.includes(code as ServicesErrorCode)
        ? (code as ServicesErrorCode)
        : "TRANSPORT_FAILED";
  }
}

/**
 * Perform a canonical request and either return the parsed body or throw a
 * faithful `ServicesError`. Every client goes through here, so no caller can
 * accidentally treat a 410/409 as an empty success.
 */
export async function callServices<T>(
  transport: ServicesTransport,
  req: ServicesRequest,
): Promise<T> {
  const res = await transport.request(req);
  if (res.status >= 200 && res.status < 300) return res.body as T;
  throw new ServicesError(res.status === 429 ? "RATE_LIMITED" : errorCodeOf(res.body), res.status);
}

/** Build a canonical query string, dropping undefined values only. */
export function servicesQuery(query: ServicesRequest["query"]): string {
  if (!query) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}
