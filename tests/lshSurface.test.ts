// LSH remote surface (Issue #72, M1 parallel phase) — Mobile-side adapter
// tests driving the PRODUCTION controller (transport injected, same seam
// pattern as the Wave-A material organization tests).
//
// Freeze respected by construction: these tests assert that the Mobile lane
// invents NO Desktop wire detail — no bootstrap path, no cookie names, no
// launch token, no WS path list. Those belong to the Desktop #166 contract.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
import { readFileSync } from "node:fs";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test.before(async () => {
  (globalThis as any).__lsh = await import("../src/still/kit/lshSurface.ts");
  (globalThis as any).__agent = await import("../src/still/kit/agentCapability.ts");
});

const lsh = () => (globalThis as any).__lsh;
const agentKit = () => (globalThis as any).__agent;

// ---------- capability derivation ----------

test("lsh: lshRemoteSurface is only true when the hello advertises exactly true", () => {
  const { lshRemoteSurfaceAvailable } = lsh();
  assert.equal(lshRemoteSurfaceAvailable({ capabilities: { lshRemoteSurface: true } }), true);
  // Absence / false / wrong type / older payload is UNAVAILABLE, never guessed.
  for (const hello of [
    undefined,
    null,
    {},
    { capabilities: {} },
    { capabilities: { lshRemoteSurface: false } },
    { capabilities: { lshRemoteSurface: "true" } },
    { capabilities: { lshRemoteSurface: 1 } },
    { capabilities: { runs: true } },
  ]) {
    assert.equal(lshRemoteSurfaceAvailable(hello), false, JSON.stringify(hello));
  }
});

test("lsh: the agent capability controller publishes canUseLsh independently of runs", async () => {
  const { AgentCapabilityController } = agentKit();
  let payload: any = { runs: false, lshRemoteSurface: true };
  const ctrl = new AgentCapabilityController({ probe: async () => payload });
  ctrl.setConnection({ paired: true, connected: true, instanceId: "desk-A" });
  await sleep(5);
  let snap = ctrl.snapshot();
  // LSH may exist while run control does not — the runs fallback stays.
  assert.equal(snap.state, "unavailable");
  assert.equal(snap.canUseRuns, false);
  assert.equal(snap.canUseLsh, true, "the LightSeek entry survives a runs:false Desktop");

  // Strict truth: anything but exactly true is unavailable.
  payload = { runs: true, lshRemoteSurface: false };
  ctrl.retry();
  await sleep(5);
  assert.equal(ctrl.snapshot().canUseLsh, false);

  // Connection loss clears BOTH capabilities.
  payload = { runs: true, lshRemoteSurface: true };
  ctrl.retry();
  await sleep(5);
  assert.equal(ctrl.snapshot().canUseRuns, true);
  ctrl.setConnection({ paired: true, connected: false, instanceId: "desk-A" });
  snap = ctrl.snapshot();
  assert.equal(snap.canUseLsh, false, "offline never claims the LSH capability");
  assert.equal(snap.canUseRuns, false);
});

// ---------- presentation marker seam ----------

test("lsh: the presentation marker belongs to the POST-AUTH landing only (P1-F6)", () => {
  const { LSH_PRESENTATION_MARKER, LSH_POST_AUTH_LANDING } = lsh();
  // The marker names the carrier's post-auth landing, not the capability URL.
  assert.equal(LSH_POST_AUTH_LANDING, `/?${LSH_PRESENTATION_MARKER}`);
  // The old capability-URL rewriter is gone: nothing attaches the marker to a
  // session URL any more, so an opaque capability URL survives untouched.
  assert.equal(typeof (lsh() as any).withPresentationMarker, "undefined");
});

test("lsh: the launch URL is passed to open byte-identically (P1-F6)", async () => {
  const h = makeController("desk-A");
  const launchUrl = "http://127.0.0.1:41234/__luckyray/carrier/launch?capability=deadbeefdeadbeefdeadbeefdeadbeef";
  h.setBehavior(async (method) =>
    method === "bootstrap" ? { sessionUrl: launchUrl } : { opened: true },
  );
  const opened = await h.controller.openSurface("desk-A");
  assert.equal(opened, true);
  const openCall = h.calls.find((c) => c.method === "open")!;
  assert.equal(openCall.args.sessionUrl, launchUrl, "byte-identical — never rewritten");
  assert.ok(
    !String(openCall.args.sessionUrl).includes("luckyrayMobile=1"),
    "the presentation marker is never attached to a capability URL",
  );
});

// ---------- controller: single-flight, fencing, truthful errors ----------

type Harness = {
  controller: any;
  calls: { method: string; args: any }[];
  setBehavior: (fn: (method: string, args: any) => Promise<any>) => void;
};

function makeController(identity = "desk-A", available = true): Harness {
  const { LshSurfaceController } = lsh();
  const calls: { method: string; args: any }[] = [];
  let behavior: (method: string, args: any) => Promise<any> = async () => ({});
  const controller = new LshSurfaceController({
    state: async () => ({ granted: true, runtimeAvailable: true }),
    bootstrap: (expectedInstance: string) => {
      calls.push({ method: "bootstrap", args: { expectedInstance } });
      return behavior("bootstrap", { expectedInstance });
    },
    open: (request: any) => {
      calls.push({ method: "open", args: request });
      return behavior("open", request);
    },
  });
  controller.setContext({ instanceId: identity, available });
  return { controller, calls, setBehavior: (fn) => { behavior = fn; } };
}

test("lsh: openSurface bootstraps the named Desktop and opens the shell with the exact URL", async () => {
  const h = makeController("desk-A");
  h.setBehavior(async (method) =>
    method === "bootstrap" ? { sessionUrl: "http://127.0.0.1:41234/__luckyray/carrier/launch?capability=ab" } : { opened: true },
  );
  const opened = await h.controller.openSurface("desk-A");
  assert.equal(opened, true);
  assert.deepEqual(h.calls[0], { method: "bootstrap", args: { expectedInstance: "desk-A" } });
  assert.equal(h.calls[1].method, "open");
  assert.equal(h.calls[1].args.ownerInstanceId, "desk-A", "the shell receives the owner");
  assert.equal(h.calls[1].args.sessionUrl, "http://127.0.0.1:41234/__luckyray/carrier/launch?capability=ab");
});

test("lsh: the flow is single-flight", async () => {
  const h = makeController("desk-A");
  let release!: (v: any) => void;
  const gate = new Promise<any>((r) => { release = r; });
  h.setBehavior(() => gate);
  const first = h.controller.openSurface("desk-A");
  await sleep(5);
  const second = await h.controller.openSurface("desk-A");
  assert.equal(second, false, "a second flow is refused while one is in flight");
  release({ sessionUrl: "https://gw.example/s" });
  assert.equal(await first, true);
  assert.equal(h.calls.filter((c) => c.method === "bootstrap").length, 1, "exactly one bootstrap");
});

test("lsh: a Desktop switch between bootstrap and open discards the surface", async () => {
  const h = makeController("desk-A");
  h.setBehavior(async () => {
    // The connection switches to B while bootstrap is in flight.
    h.controller.setContext({ instanceId: "desk-B", available: true });
    return { sessionUrl: "https://gw.example/session/a" };
  });
  await assert.rejects(() => h.controller.openSurface("desk-A"), /CONTENT_SOURCE_CHANGED/);
  assert.equal(h.calls.filter((c) => c.method === "open").length, 0, "the shell is never opened for a stale owner");
});

test("lsh: tapping with a stale instance is refused before any request", async () => {
  const h = makeController("desk-A");
  const pageInstance = "desk-A";
  h.controller.setContext({ instanceId: "desk-B", available: true });
  await assert.rejects(() => h.controller.openSurface(pageInstance), /CONTENT_SOURCE_CHANGED/);
  assert.deepEqual(h.calls, [], "zero transport calls");
});

test("lsh: unavailable capability refuses before any request", async () => {
  const h = makeController("desk-A", false);
  await assert.rejects(() => h.controller.openSurface("desk-A"), /LSH_UNAVAILABLE/);
  assert.deepEqual(h.calls, []);
});

test("lsh: an empty session URL is a truthful refusal, never a blank shell", async () => {
  const h = makeController("desk-A");
  h.setBehavior(async (method) => (method === "bootstrap" ? { sessionUrl: "" } : { opened: true }));
  await assert.rejects(() => h.controller.openSurface("desk-A"), /LSH_SURFACE_DECLINED/);
  assert.equal(h.calls.filter((c) => c.method === "open").length, 0);
});

test("lsh: the shell refusing the launch surfaces as a truthful error", async () => {
  const h = makeController("desk-A");
  h.setBehavior(async (method) => (method === "bootstrap" ? { sessionUrl: "https://gw.example/s" } : { opened: false }));
  await assert.rejects(() => h.controller.openSurface("desk-A"), /LSH_SURFACE_DECLINED/);
});

test("lsh: error copy is truthful per failure class", () => {
  const { lshErrorCopy } = lsh();
  assert.match(lshErrorCopy(new Error("LSH_UNAVAILABLE")), /尚未开放/);
  assert.match(lshErrorCopy(new Error("LSH_NOT_GRANTED")), /授权/);
  assert.match(lshErrorCopy(new Error("LSH_RUNTIME_UNAVAILABLE")), /暂时不可用/);
  assert.match(lshErrorCopy(new Error("LSH_GATEWAY_CONTRACT_INVALID")), /无法识别/);
  assert.match(lshErrorCopy(new Error("LSH_BOOTSTRAP_FAILED")), /引导失败/);
  assert.match(lshErrorCopy(new Error("CONTENT_SOURCE_CHANGED")), /电脑连接已变化/);
  assert.match(lshErrorCopy(new Error("CONTENT_OFFLINE")), /电脑未连接/);
  assert.match(lshErrorCopy(new Error("LSH_SURFACE_DECLINED")), /未能打开/);
});

// ---------- AI page wiring ----------

test("lsh: the AI page gates the entry on the shared capability snapshot", () => {
  const page = read("src", "still", "StillAgent.tsx");
  // The probe reads BOTH flags from the same hello.
  assert.match(page, /lshRemoteSurface: hello\?\.capabilities\?\.lshRemoteSurface === true/);
  // The entry renders only from the capability snapshot. REPAIR-R1 P1-AI1
  // replaced the conditional inline block with ONE structured section reused by
  // every canUseLsh state (including when Runs is also available), so the gate
  // is now expressed by the shared section + its branch conditions.
  assert.match(page, /const lshSection = \(/);
  assert.match(page, /if \(snap\.canUseLsh && !snap\.canUseRuns\)/);
  assert.match(page, /if \(snap\.canUseLsh && snap\.canUseRuns\)/);
  assert.doesNotMatch(page, /snap\.canUseLsh \? \(/, "the orphaned inline block is gone");
  // …and the flow uses the instance CURRENT at tap time.
  assert.match(page, /lsh\.openSurface\(snap\.instanceId\)/);
  assert.match(page, /lshErrorCopy\(e\)/, "failures surface the truthful copy");
});

// ---------- freeze: no invented Desktop wire detail ----------

test("lsh: the Mobile lane invents no Desktop wire detail", () => {
  const adapter = read("src", "still", "kit", "lshSurface.ts");
  const rustModule = read("src-tauri", "src", "lsh_surface.rs");
  const carrier = read("src-tauri", "src", "lsh_carrier.rs");
  const client = read("src", "services", "client.ts");
  // JS surfaces must not carry ANY wire detail.
  for (const token of ["/lsh/", "bootstrap_path", "launch_token", "launchToken", "Set-Cookie", "sessionCookie", "/v1/lsh", "ws://", "wss://"]) {
    assert.ok(!adapter.includes(token), `adapter must not invent '${token}' — it belongs to the Desktop #166 contract`);
    assert.ok(!client.includes(token), `client must not invent '${token}'`);
  }
  // The Rust side may handle the mint fields upstream (the carrier must, to
  // perform the bootstrap), but the JS RESPONSE exposes only the loopback
  // URL + expiry/generations — never the ref, never the bootstrap path.
  const production = rustModule.split("#[cfg(test)]")[0]! + carrier;
  assert.ok(production.includes("/v1/lsh/remote/state"), "the state route is the accepted contract");
  assert.ok(production.includes("/v1/lsh/remote/session"), "the session route is the accepted contract");
  const responseBlock = production.slice(production.indexOf("sessionUrl: handle.session_url"));
  for (const forbidden of ['"ref"', "bootstrapPath"]) {
    assert.ok(!responseBlock.includes(forbidden), `the JS response must not expose ${forbidden}`);
  }
  // The strict capability spelling is the only assumed payload field beyond
  // the accepted #166 mint/state shapes (which ARE validated field-by-field).
  assert.match(rustModule, /\["capabilities"\]\["lshRemoteSurface"\] != true/);
  // The state endpoint is bounded to exactly {granted, runtimeAvailable}.
  assert.match(rustModule, /"granted": value\["granted"\]/);
  // Session mint validation refuses anything outside the accepted shape.
  assert.match(carrier, /fn validate/); // mint validation lives in the carrier
});
