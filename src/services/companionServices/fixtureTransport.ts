// Canonical fixture -> ServicesTransport adapter (Issue #77 tests).
//
// This is NOT a second client implementation: it satisfies the SAME
// `ServicesTransport` seam production uses, so every domain client under
// `src/services/companionServices/**` is exercised identically in tests and in
// production. It only translates a request into the vendored canonical
// fixture's `request()` call.
//
// It must never be imported by production code paths.

import { createFixture as createFixtureFn } from "../../../shared/companion-services-v1/fixture.mjs";
import type { ServicesResponse, ServicesRequest, ServicesTransport } from "./transport.ts";

type FixtureRequest = {
  method: string;
  path: string;
  deviceId?: string;
  body?: unknown;
  headers?: Record<string, string>;
};

type FixtureResult = { status: number; body: unknown };

type Fixture = {
  request: (req: FixtureRequest) => FixtureResult;
  snapshot: () => any;
  reconnect: () => number;
  revoke: (deviceId: string) => void;
  grant: (deviceId: string, grantClass: string, enabled: boolean) => void;
  setBusy: (v: boolean) => void;
  expireSearch: () => void;
  setCursorFloor: (domain: "materials" | "knowledge", floor: number) => void;
  hints: (deviceId?: string) => unknown[];
};

export type FixtureTransport = ServicesTransport & {
  fixture: Fixture;
};

/**
 * Adapt the vendored canonical fixture to the production transport seam.
 *
 * `deviceId` selects which paired device the fixture authenticates as, so the
 * same client code can be driven as a full-grant device, a read-only device or
 * a revoked device without any client-side branching.
 */
export function createFixtureTransport(
  options: { deviceId?: string; snapshot?: unknown } = {},
): FixtureTransport {
  const fixture = (createFixtureFn as (snapshot?: unknown) => Fixture)(options.snapshot);
  const deviceId = options.deviceId ?? "device-a";
  return {
    fixture,
    async request(req: ServicesRequest): Promise<ServicesResponse> {
      // Canonical paths only: the client never builds an origin, and a raw
      // chunk is passed through untouched (bounded transport).
      const path = req.path + queryOf(req);
      const result = fixture.request({
        method: req.method,
        path,
        deviceId,
        body: req.chunk ? req.chunk.bytes : req.body,
        ...(req.chunk
          ? { headers: { "x-chunk-offset": String(req.chunk.offset), "x-chunk-sha256": req.chunk.sha256 } }
          : {}),
      });
      return { status: result.status, body: result.body };
    },
  };
}

function queryOf(req: ServicesRequest): string {
  if (!req.query) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(req.query)) {
    if (value === undefined) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}
