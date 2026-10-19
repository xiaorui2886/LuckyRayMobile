// Production-safe UUID v4 mint (SERVICES-ASSET-DETAIL-R1).
//
// The ordinary product must mint caller-owned presentation opIds on EVERY
// supported engine, including the MI8's Android System WebView 83 which has
// NO `crypto.randomUUID`. This is the product implementation; the acceptance
// driver has its own separate helper and neither depends on the other.
//
// Rules (same as the acceptance helper, independently implemented):
//  - prefer `crypto.randomUUID()` when the engine provides it;
//  - otherwise 16 bytes from `crypto.getRandomValues` with RFC 4122
//    version (4) and variant (10xx) bits forced;
//  - canonical lowercase hyphenated output;
//  - FAIL CLOSED when no secure Web Crypto randomness exists;
//  - never Math.random, never a timestamp, never a counter.

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export class SecureUuidUnavailableError extends Error {
  constructor() {
    super("secure-randomness-unavailable");
    this.name = "SecureUuidUnavailableError";
  }
}

function engineCrypto(): Crypto | null {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || typeof c !== "object") return null;
  const hasRandomUuid = typeof (c as { randomUUID?: unknown }).randomUUID === "function";
  const hasGetRandomValues = typeof (c as { getRandomValues?: unknown }).getRandomValues === "function";
  return hasRandomUuid || hasGetRandomValues ? c : null;
}

/** Format 16 raw bytes as a v4 UUID string, forcing the version/variant bits. */
export function formatSecureUuidV4(bytes: Uint8Array): string {
  if (bytes.byteLength !== 16) throw new Error("uuid-needs-16-bytes");
  const b = new Uint8Array(bytes);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push(b[i].toString(16).padStart(2, "0"));
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/**
 * Mint one secure UUID v4.
 *
 * @param cryptoRef injectable for tests; defaults to the engine's Web Crypto.
 * @throws SecureUuidUnavailableError when no secure randomness exists.
 */
export function secureUuidV4(cryptoRef?: Crypto | null): string {
  const c = cryptoRef === undefined ? engineCrypto() : cryptoRef;
  if (!c) throw new SecureUuidUnavailableError();

  const native = (c as { randomUUID?: () => string }).randomUUID;
  if (typeof native === "function") {
    const value = native.call(c);
    if (typeof value === "string" && UUID_V4.test(value)) return value;
    throw new SecureUuidUnavailableError();
  }

  const getRandomValues = (c as { getRandomValues?: (a: Uint8Array) => Uint8Array }).getRandomValues;
  if (typeof getRandomValues !== "function") throw new SecureUuidUnavailableError();

  const bytes = new Uint8Array(16);
  const filled = getRandomValues.call(c, bytes);
  return formatSecureUuidV4(filled instanceof Uint8Array ? filled : bytes);
}

/** True when a string is a canonical v4 UUID. */
export function isSecureUuidV4(value: unknown): boolean {
  return typeof value === "string" && UUID_V4.test(value);
}
