// SERVICES-INTEGRATION-R5 — acceptance-only UUID v4 mint (WebView 83 compat).
//
// The MI8's Android System WebView 83 has NO `crypto.randomUUID`, so the
// acceptance driver's caller-owned opIds could not be minted there (observed:
// `ingest.begin ok=false code=crypto.randomUUID is not a function`).
//
// This helper is the SINGLE acceptance-side mint. It is deliberately NOT a
// general utility and NOT part of the product Services stack: production
// clients never mint opIds (they receive them), so nothing here applies to them.
//
// Rules:
//  - prefer `crypto.randomUUID()` when the engine provides it;
//  - otherwise 16 random bytes from `crypto.getRandomValues`, with the
//    RFC 4122 version/variant bits set;
//  - FAIL CLOSED when no secure Web Crypto randomness is available;
//  - never Math.random, never a timestamp, never a counter.

/** RFC 4122 UUID v4 in canonical lowercase hyphenated form. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export class AcceptanceUuidUnavailableError extends Error {
  constructor() {
    super("secure-randomness-unavailable");
    this.name = "AcceptanceUuidUnavailableError";
  }
}

function secureCrypto(): Crypto | null {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || typeof c !== "object") return null;
  // Both paths require real Web Crypto; a shim without either is unusable.
  const hasRandomUuid = typeof (c as { randomUUID?: unknown }).randomUUID === "function";
  const hasGetRandomValues = typeof (c as { getRandomValues?: unknown }).getRandomValues === "function";
  return hasRandomUuid || hasGetRandomValues ? c : null;
}

/** Format 16 raw bytes as a v4 UUID string, forcing the version/variant bits. */
export function formatUuidV4(bytes: Uint8Array): string {
  if (bytes.byteLength !== 16) throw new Error("uuid-needs-16-bytes");
  const b = new Uint8Array(bytes);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push(b[i].toString(16).padStart(2, "0"));
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/**
 * Mint one UUID v4 for an acceptance-owned operation id.
 *
 * @param cryptoRef injectable for tests; defaults to the engine's Web Crypto.
 * @throws AcceptanceUuidUnavailableError when no secure randomness exists.
 */
export function acceptanceUuidV4(cryptoRef?: Crypto | null): string {
  const c = cryptoRef === undefined ? secureCrypto() : cryptoRef;
  if (!c) throw new AcceptanceUuidUnavailableError();

  const native = (c as { randomUUID?: () => string }).randomUUID;
  if (typeof native === "function") {
    const value = native.call(c);
    // Trust but verify: a shim that returns a non-v4 string must not pass.
    if (typeof value === "string" && UUID_V4.test(value)) return value;
    throw new AcceptanceUuidUnavailableError();
  }

  const getRandomValues = (c as { getRandomValues?: (a: Uint8Array) => Uint8Array }).getRandomValues;
  if (typeof getRandomValues !== "function") throw new AcceptanceUuidUnavailableError();

  const bytes = new Uint8Array(16);
  const filled = getRandomValues.call(c, bytes);
  const out = filled instanceof Uint8Array ? filled : bytes;
  return formatUuidV4(out);
}

/** True when a string is a canonical v4 UUID (used by tests and callers). */
export function isUuidV4(value: unknown): boolean {
  return typeof value === "string" && UUID_V4.test(value);
}
