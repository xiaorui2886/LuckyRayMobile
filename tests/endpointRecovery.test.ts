import test from "node:test";
import assert from "node:assert/strict";
import { createEndpointRecoveryController, recoveryError, type RecoveryPorts } from "../src/services/endpointRecovery.ts";
import type { EndpointRecoveryCancel, EndpointRecoveryPreview, EndpointRecoveryResult } from "../src/services/client.ts";
import type { QrScanResult } from "../src/services/qrScannerAdapter.ts";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, no) => { resolve = ok; reject = no; });
  return { promise, resolve, reject };
}
const preview: EndpointRecoveryPreview = {
  prepareId: "00000000-0000-4000-8000-000000000001", displayName: "Synthetic Desktop",
  currentBaseUrl: "https://192.168.1.20:7303", candidateBaseUrl: "https://192.168.1.20:12345",
  fingerprintSummary: "synthetic…test", verification: "not_yet_verified",
};
const success: EndpointRecoveryResult = { status: "updated", baseUrl: preview.candidateBaseUrl, requiresReconnect: true };
function fixture(overrides: Partial<RecoveryPorts> = {}) {
  const calls = { prepares: [] as string[], updates: [] as string[], cancels: [] as string[], scans: 0, cancelScan: 0, updated: 0 };
  const ports: RecoveryPorts = {
    prepare: async payload => { calls.prepares.push(payload); return preview; },
    update: async id => { calls.updates.push(id); return success; },
    cancel: async id => { calls.cancels.push(id); return { status: "cancelled" }; },
    scan: async () => { ++calls.scans; return { ok: true, content: "SYNTHETIC ADDRESS HINT" }; },
    cancelScan: async () => { ++calls.cancelScan; }, ...overrides,
  };
  return { controller: createEndpointRecoveryController(ports, () => ++calls.updated), calls };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test("preparation forwards hint verbatim; confirmation alone requests the native update", async () => {
  const { controller: c, calls } = fixture(); c.open();
  await c.prepare("SYNTHETIC RAW HINT");
  assert.deepEqual(calls.prepares, ["SYNTHETIC RAW HINT"]);
  assert.equal(c.snapshot().phase, "review"); assert.equal(c.snapshot().preview?.verification, "not_yet_verified");
  assert.equal(calls.updates.length, 0); assert.equal(calls.updated, 0);
  await c.confirm(); assert.deepEqual(calls.updates, [preview.prepareId]);
  assert.equal(c.snapshot().phase, "updated"); assert.equal(calls.updated, 1);
  await c.confirm(); assert.equal(calls.updates.length, 1);
});

test("rapid confirm is single-flight and never claims realtime connection", async () => {
  const update = deferred<EndpointRecoveryResult>();
  const { controller: c, calls } = fixture({ update: () => update.promise }); c.open(); await c.prepare("HINT");
  const first = c.confirm(); await c.confirm(); assert.equal(c.snapshot().phase, "verifying"); assert.equal(calls.updated, 0);
  update.resolve(success); await first; assert.equal(c.snapshot().phase, "updated");
  assert.ok(!JSON.stringify(c.snapshot()).includes('"connected"')); assert.equal(calls.updated, 1);
});

test("cancel a delayed preparation; its late opaque candidate is retired, never confirmed", async () => {
  const preparation = deferred<EndpointRecoveryPreview>();
  const { controller: c, calls } = fixture({ prepare: () => preparation.promise }); c.open();
  const pending = c.prepare("HINT"); await c.cancel();
  preparation.resolve(preview); await pending; await tick();
  assert.equal(c.snapshot().phase, "closed"); assert.deepEqual(calls.cancels, [preview.prepareId]);
  assert.equal(calls.updates.length, 0);
});

test("cancel a review invokes native retirement without pairing, write or reconnect", async () => {
  const { controller: c, calls } = fixture(); c.open(); await c.prepare("HINT"); await c.cancel();
  assert.deepEqual(calls.cancels, [preview.prepareId]); assert.equal(calls.updates.length, 0); assert.equal(calls.updated, 0);
  assert.equal(c.snapshot().phase, "closed");
});

test("cancel verification: late failure cannot replace the confirmed cancelled view", async () => {
  const update = deferred<EndpointRecoveryResult>();
  const { controller: c, calls } = fixture({ update: () => update.promise }); c.open(); await c.prepare("HINT");
  const pending = c.confirm(); await c.cancel(); update.reject("ENDPOINT_CANCELLED_OR_STALE"); await pending;
  assert.equal(c.snapshot().phase, "closed"); assert.equal(calls.updated, 0);
});

test("late cancel after durable commit truthfully reports updated, not cancellation", async () => {
  const update = deferred<EndpointRecoveryResult>();
  const { controller: c, calls } = fixture({ update: () => update.promise, cancel: async () => ({ status: "already_updated" }) });
  c.open(); await c.prepare("HINT"); const pending = c.confirm(); await c.cancel();
  assert.equal(c.snapshot().phase, "updated"); assert.equal(calls.updated, 1);
  update.resolve(success); await pending; assert.equal(calls.updated, 1);
});

test("commit still in progress is not fake cancellation; actual result wins", async () => {
  const update = deferred<EndpointRecoveryResult>();
  const { controller: c, calls } = fixture({ update: () => update.promise, cancel: async () => ({ status: "commit_in_progress" }) });
  c.open(); await c.prepare("HINT"); const pending = c.confirm(); await c.cancel();
  assert.equal(c.snapshot().phase, "cancelling"); assert.equal(calls.updated, 0);
  update.resolve(success); await pending; assert.equal(c.snapshot().phase, "updated");
});

test("unconfirmed cancel can be rechecked without starting another native update", async () => {
  let cancelled = 0;
  const { controller: c } = fixture({ cancel: async () => {
    if (++cancelled === 1) throw new Error("raw native content never shown"); return { status: "already_updated" };
  } });
  c.open(); await c.prepare("HINT"); await c.cancel();
  assert.equal(c.snapshot().phase, "cancelling"); assert.ok(!c.snapshot().message?.includes("raw native"));
  await c.cancel(); assert.equal(c.snapshot().phase, "updated");
});

test("leaving scanner ignores late QR and tears down camera", async () => {
  const scan = deferred<QrScanResult>();
  const { controller: c, calls } = fixture({ scan: () => scan.promise }); c.open(); const pending = c.scan();
  await c.cancel(); scan.resolve({ ok: true, content: "LATE SYNTHETIC HINT" }); await pending;
  assert.equal(calls.cancelScan, 1); assert.equal(calls.prepares.length, 0); assert.equal(c.snapshot().phase, "closed");
});

test("scanner denial uses safe feedback; retry preparation still needs explicit confirmation", async () => {
  const { controller: c, calls } = fixture({ scan: async () => ({ ok: false, reason: "denied", message: "RAW SECRET MUST NOT APPEAR" }) });
  c.open(); await c.scan(); assert.equal(c.snapshot().phase, "error");
  assert.ok(c.snapshot().message?.includes("没有相机权限")); assert.ok(!JSON.stringify(c.snapshot()).includes("RAW SECRET"));
  await c.prepare("HINT"); assert.equal(c.snapshot().phase, "review"); assert.equal(calls.updates.length, 0);
});

test("dispose/re-activate (StrictMode or route lifecycle) cannot revive old preparation", async () => {
  const preparation = deferred<EndpointRecoveryPreview>();
  const { controller: c, calls } = fixture({ prepare: () => preparation.promise });
  c.open(); const pending = c.prepare("OLD HINT"); c.dispose(); c.activate(); c.open();
  preparation.resolve(preview); await pending; await tick();
  assert.equal(c.snapshot().phase, "input"); assert.deepEqual(calls.cancels, [preview.prepareId]); assert.equal(calls.updated, 0);
});

test("native failures are fixed safe copy and do not offer success", async () => {
  for (const code of ["ENDPOINT_TLS_FAILED", "ENDPOINT_INSTANCE_MISMATCH", "ENDPOINT_AUTH_REJECTED", "ENDPOINT_SOURCE_CHANGED", "ENDPOINT_TIMEOUT"]) {
    const { controller: c, calls } = fixture({ update: async () => { throw code; } });
    c.open(); await c.prepare("HINT"); await c.confirm();
    assert.equal(c.snapshot().phase, "error"); assert.equal(calls.updated, 0); assert.equal(c.snapshot().preview, undefined);
  }
  assert.equal(recoveryError("secret body unknown failure"), recoveryError(null));
});

test("preparation IPC deadline retires a late native preview", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const preparation = deferred<EndpointRecoveryPreview>();
  const { controller: c, calls } = fixture({ prepare: () => preparation.promise });
  c.open(); const pending = c.prepare("HINT"); t.mock.timers.tick(5_001); await pending;
  assert.equal(c.snapshot().phase, "error");
  preparation.resolve(preview); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(calls.cancels, [preview.prepareId]); assert.equal(calls.updates.length, 0);
});

test("update IPC deadline reconciles native commit truth rather than claiming failure or cancellation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const update = deferred<EndpointRecoveryResult>();
  const { controller: c, calls } = fixture({ update: () => update.promise, cancel: async () => ({ status: "already_updated" }) });
  c.open(); await c.prepare("HINT"); const pending = c.confirm();
  t.mock.timers.tick(25_001); await pending;
  assert.equal(c.snapshot().phase, "updated"); assert.equal(calls.updated, 1);
  update.resolve(success); await Promise.resolve(); assert.equal(calls.updated, 1);
});
