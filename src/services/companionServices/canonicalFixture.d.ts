// Mobile-side type declaration for the VENDORED canonical fixture.
//
// The vendored directory `shared/companion-services-v1/**` is byte-identical to
// the Desktop canonical source and must never be edited locally — including to
// add a `.d.ts`. This shim lives OUTSIDE the vendor directory and only gives
// TypeScript a shape for the fixture's exported factory. The runtime behaviour
// is entirely the canonical code.

declare module "*/companion-services-v1/fixture.mjs" {
  export type FixtureDevice = {
    revoked: boolean;
    grants: string[];
    vaults: string[];
  };

  export type FixtureRequest = {
    method: string;
    path: string;
    deviceId?: string;
    body?: unknown;
    headers?: Record<string, string>;
  };

  export type FixtureResult = { status: number; body: unknown };

  export type CanonicalFixture = {
    request: (req: FixtureRequest) => FixtureResult;
    snapshot: () => any;
    reconnect: () => number;
    revoke: (deviceId: string) => void;
    grant: (deviceId: string, grantClass: string, enabled: boolean) => void;
    setBusy: (value: boolean) => void;
    expireSearch: () => void;
    setCursorFloor: (domain: "materials" | "knowledge", floor: number) => void;
    hints: (deviceId?: string) => unknown[];
  };

  export function createFixture(snapshot?: unknown): CanonicalFixture;
}
