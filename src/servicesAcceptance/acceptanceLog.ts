// SERVICES-INTEGRATION-R2 — bounded, redacted acceptance evidence.
//
// One pure builder produces every acceptance log row. It is a FIELD
// ALLOWLIST, not a scrubber: only the whitelisted diagnostic keys below can
// ever appear, so a credential, bearer, certificate material or raw response
// body is dropped by construction rather than filtered out after the fact.

/** Non-secret diagnostic fields an acceptance row may carry. */
const ALLOWED_FIELDS: readonly string[] = Object.freeze([
  // canonical outcome vocabulary
  "ok", "outcome", "state", "kind", "reason", "code", "status",
  // canonical currentness markers (explicitly allowed by the card)
  "generation", "boundGeneration", "revision", "permissionRevision",
  "gatewayGeneration", "cursor", "nextCursor", "recovered", "namespace",
  // bounded identifiers (device-authorized data the run selected, never secrets)
  "bundleRevision", "vaultId", "assetId", "jobId", "noteId", "opId",
  // counts
  "count", "operations", "hits", "committedBytes", "sizeBytes",
  // feed/binding observation and safe source-shape enums (never URLs/paths)
  "mode", "pageKind", "captureKind", "sourcePresent",
  // the acceptance instance comes from the app's own pairing authority
  "instance",
]);

/** Every value is capped so one row can never dump a payload. */
export const MAX_DETAIL_VALUE = 120;

export type AcceptanceEvent = {
  t: string;
  op: string;
  ok: boolean;
  [field: string]: string | number | boolean | undefined;
};

function cap(value: unknown): string | number | boolean {
  if (typeof value === "string") {
    return value.length > MAX_DETAIL_VALUE ? value.slice(0, MAX_DETAIL_VALUE) + "…" : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  // Non-primitive whitelist values are summarized, never inlined.
  return "[object]";
}

/**
 * Build one acceptance evidence row. Unknown or non-whitelisted fields are
 * DROPPED — a caller that accidentally passes a response body cannot leak it.
 */
export function acceptanceEvent(
  op: string,
  ok: boolean,
  fields: Record<string, unknown> = {},
): AcceptanceEvent {
  const event: AcceptanceEvent = { t: new Date().toISOString(), op, ok };
  for (const key of ALLOWED_FIELDS) {
    if (key === "ok") continue;
    const value = fields[key];
    if (value !== undefined && value !== null && value !== "") {
      event[key] = cap(value);
    }
  }
  return event;
}

/** One bounded text line per event — what the driver screen renders. */
export function formatEvent(event: AcceptanceEvent): string {
  const parts = Object.entries(event)
    .filter(([key, value]) => key !== "t" && value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`);
  return `[${event.t.slice(11, 23)}] ${parts.join(" ")}`;
}
