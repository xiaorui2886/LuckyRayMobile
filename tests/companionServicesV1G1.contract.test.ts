// PAIRED-R1 G1 currentness (#77) — stale async results must not be adopted.
// Run: node --experimental-strip-types --test tests/companionServicesV1G1.contract.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ServiceRegistry, ChangeFeedClient, createHintSubscription,
  MaterialsClient, KnowledgeClient, PresentationClient, IngestClient,
  createCompanionServices, createFixtureTransport, createTauriServicesTransport,
  ServicesError,
} from "../src/services/companionServices/index.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

/** A transport whose responses are released manually, in any order. */
function deferredTransport() {
  const pending: Array<(reply: { status: number; body: unknown }) => void> = [];
  return {
    pending,
    request: () => new Promise<{ status: number; body: unknown }>((resolve) => pending.push(resolve)),
  };
}

const catalogBody = (gatewayGeneration: number, permissionRevision: number) => ({
  status: 200,
  body: {
    catalogVersion: 1, bundleRevision: "2026-09-24.3",
    desktopInstanceId: "fixture-desktop",
    gatewayGeneration, permissionRevision,
    services: {}, operations: {}, limits: {},
  },
});

const ID_A = { instanceId: "fixture-desktop", gatewayGeneration: 1, permissionRevision: 1 };
const ID_B = { instanceId: "fixture-desktop", gatewayGeneration: 2, permissionRevision: 2 };

// ===========================================================================
// G1-C1 — ServiceRegistry latest-current
// ===========================================================================

test("G1-C1 — reproduce central case 1: a late A success cannot overwrite newer B", async () => {
  const t = deferredTransport();
  const registry = new ServiceRegistry(t as any);
  const a = registry.refresh(ID_A);
  registry.invalidate();
  const b = registry.refresh(ID_B);
  t.pending[1](catalogBody(2, 2)); // B lands first
  await b;
  t.pending[0](catalogBody(1, 1)); // A lands late
  await a.catch(() => {});
  assert.equal(registry.snapshot()?.gatewayGeneration, 2, "B's catalog survives");
  assert.equal(registry.currentNamespace(), "fixture-desktop|2|2");
});

test("G1-C1 — reproduce central case 2: invalidate cannot be resurrected by a late success", async () => {
  const t = deferredTransport();
  const registry = new ServiceRegistry(t as any);
  const a = registry.refresh(ID_A);
  registry.invalidate();
  t.pending[0](catalogBody(1, 1));
  await a.catch(() => {});
  assert.equal(registry.snapshot(), null, "the cache stays invalidated");
  assert.equal(registry.currentNamespace(), "");
});

test("G1-C1 — reproduce central case 3: a late mismatch cannot clear newer B", async () => {
  const t = deferredTransport();
  const registry = new ServiceRegistry(t as any);
  const a = registry.refresh(ID_A);
  const b = registry.refresh(ID_B);
  t.pending[1](catalogBody(2, 2));
  await b;
  t.pending[0](catalogBody(9, 9)); // mismatched against A's expectation
  await a.catch(() => {});
  assert.equal(registry.snapshot()?.gatewayGeneration, 2, "B is not cleared by a stale mismatch");
});

test("G1-C1 — a CURRENT failure still behaves truthfully", async () => {
  const t = deferredTransport();
  const registry = new ServiceRegistry(t as any);
  const a = registry.refresh(ID_A);
  t.pending[0](catalogBody(9, 9)); // current request, mismatched identity
  await assert.rejects(() => a, /services-catalog-generation-mismatch/);
  assert.equal(registry.snapshot(), null, "a current mismatch clears state as before");
});

test("G1-C1 — permission-revision invalidation retires an in-flight refresh", async () => {
  const t = deferredTransport();
  const registry = new ServiceRegistry(t as any);
  const a = registry.refresh(ID_A);
  registry.invalidateForPermissionRevision(99);
  t.pending[0](catalogBody(1, 1));
  await a.catch(() => {});
  assert.equal(registry.snapshot(), null, "the late success cannot resurrect the cache");
});

test("G1-C1 — initial discovery without a known permission revision still works", async () => {
  const t = deferredTransport();
  const registry = new ServiceRegistry(t as any);
  const a = registry.refresh(ID_A);
  t.pending[0](catalogBody(1, 1));
  const catalog = await a;
  assert.equal(catalog.permissionRevision, 1);
  assert.equal(registry.currentNamespace(), "fixture-desktop|1|1");
});

test("G1-C1 — a stale completion is retired locally, not exposed as truth", async () => {
  const t = deferredTransport();
  const registry = new ServiceRegistry(t as any);
  const a = registry.refresh(ID_A);
  registry.invalidate();
  t.pending[0](catalogBody(1, 1));
  await assert.rejects(() => a, /services-catalog-request-superseded/);
});

// ===========================================================================
// G1-N — the Services native fence uses the CAPTURED epoch
// ===========================================================================

test("G1-N — all three Services paths fence the captured connection epoch", () => {
  const content = read("src-tauri", "src", "content.rs");
  for (const name of [
    "pub(crate) async fn services_request(",
    "pub(crate) async fn services_request_json(",
    "pub(crate) async fn services_request_with_chunk(",
  ]) {
    const at = content.indexOf(name);
    assert.ok(at > 0, `${name} exists`);
    const next = content.indexOf("pub(crate) async fn", at + 10);
    const body = content.slice(at, next > at ? next : undefined);
    assert.equal((body.match(/services_connection_current\(state\)\?/gu) ?? []).length, 2,
      `${name} fences before and after`);
  }
});

test("G1-N — the fence proves the captured epoch, not just the instance", () => {
  const content = read("src-tauri", "src", "content.rs");
  const at = content.indexOf("fn services_connection_current");
  assert.ok(at > 0, "the helper exists");
  const body = content.slice(at, at + 600);
  assert.match(body, /verify_owner\(state\)\?/u, "the captured owner is re-proved");
  assert.match(body, /self\.source\.check\(state\)/u, "the CAPTURED epoch + intent are checked");
  // `Source::check` compares the captured epoch, not the caller's expectation.
  const check = content.slice(content.indexOf("pub(crate) fn check(&self"), content.indexOf("pub(crate) fn check(&self") + 300);
  assert.match(check, /self\.lifecycle\.observe\(\) != self\.epoch/u, "the captured epoch is compared");
});

test("G1-N — the distinct generation scopes are not conflated", () => {
  const content = read("src-tauri", "src", "content.rs");
  const helper = content.slice(content.indexOf("fn services_connection_current"),
    content.indexOf("fn services_connection_current") + 600);
  // The Services fence must not reach for gatewayGeneration/permissionRevision,
  // which are different scopes.
  assert.doesNotMatch(helper, /gatewayGeneration|permissionRevision|hint/iu);
});

test("G1-N — native tests exist for the epoch cases", () => {
  const rust = read("src-tauri", "src", "services_v1.rs");
  assert.match(rust, /fn source_check_detects_a_new_epoch_for_the_same_desktop/u);
  assert.match(rust, /fn a_services_request_fences_twice_around_the_await/u);
  assert.match(rust, /fn the_services_fence_reuses_the_captured_epoch_not_a_new_number/u);
  // The same-desktop new-epoch case is the one central flagged.
  const body = rust.slice(rust.indexOf("fn source_check_detects_a_new_epoch_for_the_same_desktop"));
  assert.match(body, /invalidate\(\)/u, "a new epoch is simulated");
  assert.match(body, /assert_ne!\(lifecycle\.observe\(\), captured/u, "and shown to differ");
});

// ===========================================================================
// G1-C2 — delayed hint drain
// ===========================================================================

test("G1-C2 — drain preserves the worker generation", async () => {
  // The fake models the native buffer: a matching scoped drain removes the
  // records once and reports their generation.
  let buffered = [
    { generation: 7, hint: { kind: "materialChanged", cursor: "m:1" } },
    { generation: 8, hint: { kind: "lshStateChanged" } },
  ];
  const sub = createHintSubscription((async (cmd: string, args: any) => {
    if (cmd !== "services_hints_state") return [];
    const wantGeneration = Number(args?.generation ?? -1);
    const drained = buffered.filter((r) => r.generation === wantGeneration);
    buffered = buffered.filter((r) => r.generation !== wantGeneration);
    return drained;
  }) as any);
  const records = await sub.drain({ instance: "fixture-desktop-1", generation: 7 });
  assert.deepEqual(records.map((r) => r.generation), [7], "generation survives the IPC boundary");
  assert.equal(records[0].hint.kind, "materialChanged");
  // Only the matching generation was consumed; the other stays buffered.
  assert.equal(buffered.length, 1, "non-matching records are untouched");
});

test("G1-C2 — an unbound drain touches nothing (no wildcard)", async () => {
  let drained = 0;
  const sub = createHintSubscription((async () => {
    drained += 1;
    return [{ generation: 7, hint: { kind: "lshStateChanged" } }];
  }) as any);
  assert.deepEqual(await sub.drain({ instance: "", generation: -1 }), [], "unbound returns []");
  assert.deepEqual(await sub.drain({ instance: "d", generation: -1 }), [], "invalid generation returns []");
  assert.equal(drained, 0, "the native buffer was never touched");
});

test("G1-C2 — a late gen1 drain after stop/start(gen2) delivers nothing", async () => {
  const pending: Array<(v: unknown) => void> = [];
  const sub = createHintSubscription((async (cmd: string) => {
    if (cmd === "services_hints_state") return new Promise((resolve) => pending.push(resolve));
    if (cmd === "services_hints_status") return { generation: 2, phase: "running", owner: "desktop-a", connectFailures: 0 };
    return { outcome: "started", generation: 2 };
  }) as any);
  const feed = new ChangeFeedClient(sub);
  await feed.start("desktop-a");

  const inFlight = feed.readHints(); // gen1 drain, still pending
  await feed.stop();
  await feed.start("desktop-a"); // new subscription epoch

  // The old invoke resolves late, carrying OLD-generation records.
  pending[0]([{ generation: 1, hint: { kind: "materialChanged", cursor: "m:9" } }]);
  assert.deepEqual(await inFlight, [], "no gen1 hint is delivered after a new start");
});

test("G1-C2 — a same-owner reconnect generation also retires the old drain", async () => {
  const pending: Array<(v: unknown) => void> = [];
  let statusGeneration = 1;
  const sub = createHintSubscription((async (cmd: string) => {
    if (cmd === "services_hints_state") return new Promise((resolve) => pending.push(resolve));
    if (cmd === "services_hints_status") return { generation: statusGeneration, phase: "running", owner: "desktop-a", connectFailures: 0 };
    return { outcome: "started", generation: statusGeneration };
  }) as any);
  const feed = new ChangeFeedClient(sub);
  await feed.start("desktop-a");
  const inFlight = feed.readHints();
  statusGeneration = 2; // a reconnect produced a new worker generation
  await feed.start("desktop-a");
  pending[0]([{ generation: 1, hint: { kind: "lshStateChanged" } }]);
  assert.deepEqual(await inFlight, [], "the old generation result is discarded");
});

test("G1-C2 — a current drain returns its own generation's hints normally", async () => {
  const sub = createHintSubscription((async (cmd: string) => {
    if (cmd === "services_hints_state") {
      return [
        { generation: 2, hint: { kind: "materialChanged", cursor: "m:1" } },
        { generation: 1, hint: { kind: "lshStateChanged" } }, // superseded
      ];
    }
    if (cmd === "services_hints_status") return { generation: 2, phase: "running", owner: "desktop-a", connectFailures: 0 };
    return { outcome: "started", generation: 2 };
  }) as any);
  const feed = new ChangeFeedClient(sub);
  await feed.start("desktop-a");
  const hints = await feed.readHints();
  assert.equal(hints.length, 1, "only the current generation is delivered");
  assert.equal(hints[0].kind, "materialChanged");
});

test("G1-C2 — an old servicesChanged cannot invalidate a new subscription", async () => {
  const pending: Array<(v: unknown) => void> = [];
  const sub = createHintSubscription((async (cmd: string) => {
    if (cmd === "services_hints_state") return new Promise((resolve) => pending.push(resolve));
    if (cmd === "services_hints_status") return { generation: 2, phase: "running", owner: "desktop-a", connectFailures: 0 };
    return { outcome: "started", generation: 2 };
  }) as any);
  const feed = new ChangeFeedClient(sub);
  await feed.start("desktop-a");
  const inFlight = feed.readHints();
  await feed.stop();
  await feed.start("desktop-a");
  pending[0]([{ generation: 1, hint: { kind: "servicesChanged", permissionRevision: 9 } }]);
  const delivered = await inFlight;
  assert.deepEqual(delivered, [], "the stale hint never reaches the consumer");
  assert.equal(feed.permissionTruthStale(delivered), null, "so it cannot mark a new context stale");
});

test("G1-C2 — a current servicesChanged still reports the stale revision", async () => {
  const sub = createHintSubscription((async (cmd: string) => {
    if (cmd === "services_hints_state") {
      return [{ generation: 3, hint: { kind: "servicesChanged", permissionRevision: 9 } }];
    }
    if (cmd === "services_hints_status") return { generation: 3, phase: "running", owner: "desktop-a", connectFailures: 0 };
    return { outcome: "started", generation: 3 };
  }) as any);
  const feed = new ChangeFeedClient(sub);
  await feed.start("desktop-a");
  const hints = await feed.readHints();
  assert.equal(hints.length, 1);
  assert.equal(feed.permissionTruthStale(hints), 9, "a current hint still invalidates");
});

test("G1-C2 — durable cursor still ignores hint cursors", () => {
  const feed = new ChangeFeedClient(null);
  assert.equal(feed.resumeCursor("m:5", { kind: "materialChanged", cursor: "m:99" }), "m:5");
  assert.equal(feed.resumeCursor(null, { kind: "materialChanged", cursor: "m:99" }), null);
});

// ===========================================================================
// G1H — hint owner / subscription binding
// ===========================================================================

test("G1H 1 — a fresh client never adopts records before a bound start", async () => {
  // The native buffer already holds a record; nothing has bound this client.
  let drains = 0;
  const sub = createHintSubscription((async () => {
    drains += 1;
    return [{ generation: 3, hint: { kind: "materialChanged", cursor: "m:1" } }];
  }) as any);
  const feed = new ChangeFeedClient(sub);
  assert.equal(feed.currentMode(), "polling", "a fresh client is polling, not hints");
  assert.equal(feed.boundGeneration(), null, "and unbound");
  assert.deepEqual(await feed.readHints(), [], "no adoption before a successful start");
  assert.equal(drains, 0, "and it does not even drain the global buffer");
});

test("G1H 2 — a start whose status reports another owner stays polling and unbound", async () => {
  // Client A starts desktop-a, but by the time status resolves the process-global
  // native worker belongs to desktop-b (switched by another client).
  const sub = createHintSubscription((async (cmd: string) => {
    if (cmd === "services_hints_start") return { outcome: "started", generation: 5 };
    if (cmd === "services_hints_status") {
      return { generation: 5, phase: "running", owner: "desktop-b", connectFailures: 0 };
    }
    return [];
  }) as any);
  const feed = new ChangeFeedClient(sub);
  await feed.start("desktop-a");
  assert.equal(feed.currentMode(), "polling", "an owner mismatch never enables hints");
  assert.equal(feed.boundGeneration(), null, "and binds no generation");
  assert.deepEqual(await feed.readHints(), [], "so nothing can be adopted");
});

test("G1H 3 — two clients sharing one subscription never consume each other's records", async () => {
  // FAITHFUL model of the destructive native buffer (G1-R3): a successful
  // SCOPED drain removes the matching records ONCE; a mismatched scope removes
  // nothing. The old fake returned the record on every call, which hid the
  // destructive-drain defect this test now pins.
  let nativeOwner = "";
  let nativeGeneration = 0;
  let nativeBuffer: Array<{ generation: number; hint: unknown }> = [];
  const sub = createHintSubscription((async (cmd: string, args: any) => {
    if (cmd === "services_hints_start") {
      nativeOwner = String(args?.instance ?? "");
      nativeGeneration = nativeOwner === "desktop-b" ? 9 : 4;
      // A new worker generation clears the buffer, as the native retire does.
      nativeBuffer = [];
      return { outcome: "started", generation: nativeGeneration };
    }
    if (cmd === "services_hints_status") {
      return { generation: nativeGeneration, phase: "running", owner: nativeOwner, connectFailures: 0 };
    }
    if (cmd === "services_hints_state") {
      const wantInstance = String(args?.instance ?? "");
      const wantGeneration = Number(args?.generation ?? -1);
      // The native owner/generation/live check is atomic with the take.
      if (wantInstance !== nativeOwner || wantGeneration !== nativeGeneration) return [];
      const drained = nativeBuffer.filter((r) => r.generation === nativeGeneration);
      // A successful drain removes the records it delivered.
      nativeBuffer = nativeBuffer.filter((r) => r.generation !== nativeGeneration);
      return drained;
    }
    return undefined;
  }) as any);

  const clientA = new ChangeFeedClient(sub);
  const clientB = new ChangeFeedClient(sub);
  await clientA.start("desktop-a");
  assert.equal(clientA.boundGeneration(), 4, "A binds generation 4");
  assert.equal(clientA.currentMode(), "hints", "A binds its own worker");

  // B switches the global worker to itself and buffers one B record.
  await clientB.start("desktop-b");
  nativeBuffer.push({ generation: 9, hint: { kind: "materialChanged", cursor: "m:B" } });

  // A's stale scoped drain is refused by the native scope check — the record is
  // NOT removed, even though A then drops it locally by generation anyway.
  assert.deepEqual(await clientA.readHints(), [], "A adopts nothing");
  assert.equal(nativeBuffer.length, 1, "B's record was NOT destroyed by A's stale drain");

  // B still receives its own record exactly once.
  const fromB = await clientB.readHints();
  assert.equal(fromB.length, 1, "B gets its own record");
  assert.equal(fromB[0].kind, "materialChanged");
  assert.equal(nativeBuffer.length, 0, "…and it is consumed exactly once");
});

test("G1H 4 — a stale refreshMode cannot re-enable retired hints", async () => {
  const pending: Array<(v: unknown) => void> = [];
  const sub = createHintSubscription((async (cmd: string) => {
    if (cmd === "services_hints_status") {
      // The first status (used by start) resolves immediately; the refreshMode
      // status is deferred so it can land after a stop.
      if (pending.length === 0 && !deferredOnce) {
        deferredOnce = true;
        return { generation: 2, phase: "running", owner: "desktop-a", connectFailures: 0 };
      }
      return new Promise((resolve) => pending.push(resolve));
    }
    return { outcome: "started", generation: 2 };
  }) as any);
  let deferredOnce = false;
  const feed = new ChangeFeedClient(sub);
  await feed.start("desktop-a");
  assert.equal(feed.currentMode(), "hints", "bound before the race");

  const inFlight = feed.refreshMode();
  await feed.stop();
  assert.equal(feed.currentMode(), "polling", "stop retires the context");

  // The old status resolves late, still claiming a running worker for our owner.
  pending[0]({ generation: 2, phase: "running", owner: "desktop-a", connectFailures: 0 });
  await inFlight;
  assert.equal(feed.currentMode(), "polling", "a stale refreshMode cannot re-enable hints");
  assert.equal(feed.boundGeneration(), null, "and cannot rebind a generation");
});

test("G1H 5 — a same-owner generation change retires an in-flight drain", async () => {
  const pending: Array<(v: unknown) => void> = [];
  let statusGeneration = 1;
  const sub = createHintSubscription((async (cmd: string) => {
    if (cmd === "services_hints_state") return new Promise((resolve) => pending.push(resolve));
    if (cmd === "services_hints_status") {
      return { generation: statusGeneration, phase: "running", owner: "desktop-a", connectFailures: 0 };
    }
    return { outcome: "started", generation: statusGeneration };
  }) as any);
  const feed = new ChangeFeedClient(sub);
  await feed.start("desktop-a");
  const oldDrain = feed.readHints(); // generation 1, pending

  // The SAME owner's worker restarted: a new live generation is adopted.
  statusGeneration = 2;
  await feed.refreshMode();
  assert.equal(feed.boundGeneration(), 2, "the new generation is adopted");

  // The old drain resolves with generation-1 records.
  pending[0]([{ generation: 1, hint: { kind: "materialChanged", cursor: "m:old" } }]);
  assert.deepEqual(await oldDrain, [], "the retired generation's records are not delivered");
});

test("G1H 6 — a current owner and generation still deliver normally", async () => {
  const sub = createHintSubscription((async (cmd: string) => {
    if (cmd === "services_hints_status") {
      return { generation: 6, phase: "running", owner: "desktop-a", connectFailures: 0 };
    }
    if (cmd === "services_hints_state") {
      return [
        { generation: 6, hint: { kind: "materialChanged", cursor: "m:1" } },
        { generation: 5, hint: { kind: "lshStateChanged" } },
      ];
    }
    return { outcome: "started", generation: 6 };
  }) as any);
  const feed = new ChangeFeedClient(sub);
  await feed.start("desktop-a");
  assert.equal(feed.currentMode(), "hints");
  assert.equal(feed.boundGeneration(), 6);
  const hints = await feed.readHints();
  assert.equal(hints.length, 1, "only the bound generation is delivered");
  assert.equal(hints[0].kind, "materialChanged");
});

test("G1H 7 — servicesChanged stays invalidation-only and the cursor stays durable", async () => {
  const sub = createHintSubscription((async (cmd: string) => {
    if (cmd === "services_hints_status") {
      return { generation: 2, phase: "running", owner: "desktop-a", connectFailures: 0 };
    }
    if (cmd === "services_hints_state") {
      return [{ generation: 2, hint: { kind: "servicesChanged", permissionRevision: 11 } }];
    }
    return { outcome: "started", generation: 2 };
  }) as any);
  const feed = new ChangeFeedClient(sub);
  await feed.start("desktop-a");
  const hints = await feed.readHints();
  assert.equal(feed.permissionTruthStale(hints), 11, "a current hint still invalidates");
  assert.equal(feed.resumeCursor("m:5", { kind: "materialChanged", cursor: "m:99" } as any), "m:5");
  assert.equal(feed.resumeCursor(null, { kind: "servicesChanged", permissionRevision: 11 } as any), null);
});

// ===========================================================================
// V-C3 — deterministic deferred Services transport (epoch367)
//
// Each request is recorded with its own identity (operationId + path + query)
// and an explicit resolver. Tests wait on an exact queued-count condition
// rather than reading `pending.length` at an arbitrary microtask boundary,
// which is what made the previous G1-C3 Materials test scheduler-ambiguous.
// ===========================================================================

type DeferredCall = {
  operationId: string;
  method: string;
  path: string;
  queryJson: string;
  resolve: (reply: { status: number; body: unknown }) => void;
};

function deferredServicesEnv() {
  const calls: DeferredCall[] = [];
  const waiters: Array<() => void> = [];
  const notify = () => { const w = waiters.shift(); if (w) w(); };
  const transport = {
    request(req: any) {
      let resolve!: (reply: { status: number; body: unknown }) => void;
      const done = new Promise<{ status: number; body: unknown }>((r) => { resolve = r; });
      calls.push({
        operationId: req.operationId,
        method: req.method,
        path: req.path,
        queryJson: JSON.stringify(
          Object.fromEntries(Object.entries(req.query ?? {}).filter(([, v]) => v !== undefined)),
        ),
        resolve,
      });
      notify();
      return done;
    },
  };
  return {
    transport,
    calls,
    /** Resolves when at least `n` calls are queued. */
    async waitForCount(n: number) {
      while (calls.length < n) {
        await new Promise<void>((r) => waiters.push(r));
      }
    },
    resolveAt(index: number, reply: { status: number; body: unknown }) {
      calls[index].resolve(reply);
    },
    /** Indices of calls matching an exact path + serialized query. */
    findBy(path: string, queryJson: string): number[] {
      const out: number[] = [];
      calls.forEach((c, i) => { if (c.path === path && c.queryJson === queryJson) out.push(i); });
      return out;
    },
  };
}

// ===========================================================================
// G1-C3 — Materials / Knowledge 410 recovery
// ===========================================================================

const changePage = (items: string[], nextCursor: string | null) => ({
  status: 200,
  body: { items: items.map((c) => ({ cursor: c, assetId: "a", revision: "r", kind: "updated", tombstone: false })),
    snapshotCursor: "s", nextCursor, hasMore: false },
});

test("G1-C3 — a stale Materials 410 never starts a recovery", async () => {
  const pending: Array<(v: any) => void> = [];
  const materials = new MaterialsClient({ request: () => new Promise((r) => pending.push(r)) } as any);
  const old = materials.changes("inst-1", null);
  const newer = materials.changes("inst-1", null); // retires the older request
  pending[1](changePage(["m:2"], null));
  const bProjection = await newer;
  pending[0]({ status: 410, body: { code: "CURSOR_TOO_OLD" } });
  const aProjection = await old;
  assert.deepEqual(aProjection.items.map((i: any) => i.cursor), bProjection.items.map((i: any) => i.cursor),
    "the stale 410 leaves the newer projection alone");
});

test("G1-C3 — a late Materials resnapshot cannot overwrite a newer projection (deterministic)", async () => {
  // V-C3: deterministic request identity + explicit queued-count waiting.
  const env = deferredServicesEnv();
  const materials = new MaterialsClient(env.transport as any);
  const changesPath = "/v1/services/materials/changes";
  const changesQuery = "{}";

  // 1. Start A.
  const a = materials.changes("inst-1", null);
  // 2. Wait until request A is actually queued.
  await env.waitForCount(1);
  assert.equal(env.calls.length, 1, "only A is queued");
  assert.equal(env.calls[0].path, changesPath, "A is the changes call");

  // 3. Resolve A with 410.
  env.resolveAt(0, { status: 410, body: { code: "CURSOR_TOO_OLD" } });
  // 4. Deterministically wait until A's recovery is actually issued and pending.
  await env.waitForCount(2);
  // 5. Identify A-recovery: the second queued call (same path, no cursor).
  assert.equal(env.calls[1].path, changesPath, "A-recovery is queued");
  assert.equal(env.calls[1].queryJson, changesQuery, "recovery has the snapshot query");

  // 6. Only now start B.
  const b = materials.changes("inst-1", null);
  // 7. Wait until B is queued and identify it independently.
  await env.waitForCount(3);
  assert.equal(env.calls[2].path, changesPath, "B is the third call");

  // 8. Resolve B success and await its commit.
  env.resolveAt(2, changePage(["m:9"], null));
  await b;
  assert.deepEqual(materials.snapshot().items.map((i: any) => i.cursor), ["m:9"],
    "B's projection is current");

  // 9. Resolve A-recovery success LATE.
  env.resolveAt(1, changePage(["m:old"], null));
  const aResult = await a.catch(() => null);

  // 10. B projection remains unchanged.
  assert.deepEqual(materials.snapshot().items.map((i: any) => i.cursor), ["m:9"],
    "B's projection is not overwritten by the late A recovery");
  // The stale caller sees B's committed projection, never its own stale data.
  assert.deepEqual((aResult as any)?.items.map((i: any) => i.cursor), ["m:9"]);

  // 11. Repeat with a late A-recovery FAILURE.
  const env2 = deferredServicesEnv();
  const materials2 = new MaterialsClient(env2.transport as any);
  const a2 = materials2.changes("inst-1", null);
  await env2.waitForCount(1);
  env2.resolveAt(0, { status: 410, body: { code: "CURSOR_TOO_OLD" } });
  await env2.waitForCount(2);
  const b2 = materials2.changes("inst-1", null);
  await env2.waitForCount(3);
  env2.resolveAt(2, changePage(["m:9"], null));
  await b2;
  // Late A-recovery failure.
  env2.resolveAt(1, { status: 500, body: { code: "SERVICE_UNAVAILABLE" } });
  await a2.catch(() => {});
  assert.deepEqual(materials2.snapshot().items.map((i: any) => i.cursor), ["m:9"],
    "a late recovery failure cannot clear B's projection");

  // 12. No unexpected extra recovery request was generated.
  assert.equal(env.calls.length, 3, "exactly 3 calls: A, A-recovery, B");
  assert.equal(env2.calls.filter((c) => c.path === changesPath).length, 3,
    "exactly 3 calls in the failure path too");
});

test("G1-C3 — a late Knowledge recovery cannot overwrite a newer projection (deterministic)", async () => {
  // Same deterministic proof for the KnowledgeClient's registered-vault changes
  // on Desktop instance X + vault V.
  const env = deferredServicesEnv();
  const knowledge = new KnowledgeClient(env.transport as any);
  const changesPath = "/v1/services/knowledge/vaults/v1/changes";
  const changesQuery = "{}";
  const kv = (cursor: string) => vaultPage([cursor]);

  // 1. Start A for X|V.
  const a = knowledge.registeredChanges("inst-1", "v1", null);
  // 2. Wait until A is queued.
  await env.waitForCount(1);
  assert.equal(env.calls[0].path, changesPath, "A is the registered-changes call");

  // 3. Resolve A with 410.
  env.resolveAt(0, { status: 410, body: { code: "CURSOR_TOO_OLD" } });
  // 4. Wait until A-recovery is actually issued and pending.
  await env.waitForCount(2);
  // 5. Identify A-recovery.
  assert.equal(env.calls[1].path, changesPath, "A-recovery is queued");

  // 6. Start B for the same X|V — commits newer data.
  const b = knowledge.registeredChanges("inst-1", "v1", null);
  await env.waitForCount(3);
  env.resolveAt(2, kv("k:9"));
  await b;
  assert.deepEqual(
    knowledge.projectionFor("inst-1", "v1")!.items.map((i: any) => i.cursor),
    ["k:9"], "B committed",
  );

  // 7. Late A-recovery success.
  env.resolveAt(1, kv("k:old"));
  await a.catch(() => {});

  // 10. B remains unchanged.
  assert.deepEqual(
    knowledge.projectionFor("inst-1", "v1")!.items.map((i: any) => i.cursor),
    ["k:9"], "B's projection is not overwritten by the late A recovery",
  );

  // 11. Late A-recovery failure cannot clear B.
  const env2 = deferredServicesEnv();
  const knowledge2 = new KnowledgeClient(env2.transport as any);
  const a2 = knowledge2.registeredChanges("inst-1", "v1", null);
  await env2.waitForCount(1);
  env2.resolveAt(0, { status: 410, body: { code: "CURSOR_TOO_OLD" } });
  await env2.waitForCount(2);
  const b2 = knowledge2.registeredChanges("inst-1", "v1", null);
  await env2.waitForCount(3);
  env2.resolveAt(2, kv("k:9"));
  await b2;
  // Late A-recovery failure.
  env2.resolveAt(1, { status: 500, body: { code: "SERVICE_UNAVAILABLE" } });
  await a2.catch(() => {});
  assert.deepEqual(
    knowledge2.projectionFor("inst-1", "v1")!.items.map((i: any) => i.cursor),
    ["k:9"], "a late recovery failure cannot clear B",
  );

  // 12. No extra recovery spawned — BOTH environments have exactly
  // A + A-recovery + B, and the failure run never issued a fourth request.
  assert.equal(env.calls.filter((c) => c.path === changesPath).length, 3,
    "success environment has exactly A + A-recovery + B");
  assert.equal(env2.calls.filter((c) => c.path === changesPath).length, 3,
    "failure environment has exactly A + A-recovery + B and no fourth recovery request");
});


test("G1-C3 — a current Materials 410 still replaces the projection", async () => {
  const pending: Array<(v: any) => void> = [];
  const materials = new MaterialsClient({ request: () => new Promise((r) => pending.push(r)) } as any);
  const call = materials.changes("inst-1", "m:1");
  pending[0]({ status: 410, body: { code: "CURSOR_TOO_OLD" } });
  await new Promise((r) => setTimeout(r, 0));
  pending[1](changePage(["m:5"], null)); // the resnapshot
  const projection = await call;
  assert.equal(projection.recovered, true, "a current 410 still recovers");
  assert.deepEqual(projection.items.map((i: any) => i.cursor), ["m:5"]);
});

test("G1-C3 — a stale Materials success does not alter a newer projection", async () => {
  const pending: Array<(v: any) => void> = [];
  const materials = new MaterialsClient({ request: () => new Promise((r) => pending.push(r)) } as any);
  const a = materials.changes("inst-1", null);
  const b = materials.changes("inst-1", null);
  pending[1](changePage(["m:2"], null));
  await b;
  pending[0](changePage(["m:1"], null));
  await a;
  assert.deepEqual(materials.snapshot().items.map((i: any) => i.cursor), ["m:2"], "B's projection stands");
});

const vaultPage = (cursors: string[]) => ({
  status: 200,
  body: { items: cursors.map((c) => ({ cursor: c, vaultId: "v1", noteId: "n", revision: "r", deleted: false })),
    snapshotCursor: "s", nextCursor: null, hasMore: false },
});

test("G1-C3 — a stale Knowledge 410 cannot overwrite a newer vault projection", async () => {
  const pending: Array<(v: any) => void> = [];
  const knowledge = new KnowledgeClient({ request: () => new Promise((r) => pending.push(r)) } as any);
  const a = knowledge.registeredChanges("inst-1", "v1", null);
  const b = knowledge.registeredChanges("inst-1", "v1", null);
  pending[1](vaultPage(["k:2"]));
  await b;
  pending[0]({ status: 410, body: { code: "CURSOR_TOO_OLD" } });
  await a;
  assert.deepEqual(knowledge.projectionFor("inst-1", "v1")!.items.map((i: any) => i.cursor), ["k:2"]);
});

test("G1-C3 — the same vaultId on two Desktops never shares a scope", async () => {
  const pending: Array<(v: any) => void> = [];
  const knowledge = new KnowledgeClient({ request: () => new Promise((r) => pending.push(r)) } as any);
  const onA = knowledge.registeredChanges("inst-A", "v1", null);
  const onB = knowledge.registeredChanges("inst-B", "v1", null);
  // B commits its own scope.
  pending[1](vaultPage(["k:B"]));
  await onB;
  // A's late result must not land in B's context.
  pending[0](vaultPage(["k:A"]));
  await onA;
  // Each Desktop keeps its OWN projection for the shared vaultId.
  const projectionB = knowledge.projectionFor("inst-B", "v1")!;
  const projectionA = knowledge.projectionFor("inst-A", "v1")!;
  assert.deepEqual(projectionB.items.map((i: any) => i.cursor), ["k:B"], "B's scope keeps B's rows");
  assert.deepEqual(projectionA.items.map((i: any) => i.cursor), ["k:A"], "A's late result landed in A's scope");
  assert.match(read("src", "services", "companionServices", "knowledgeClient.ts"),
    /\$\{instance\}\|\$\{vaultId\}/u, "the scope key is instance+vault");
});

test("G1-C3 — a vault A recovery cannot affect vault B", async () => {
  const pending: Array<(v: any) => void> = [];
  const knowledge = new KnowledgeClient({ request: () => new Promise((r) => pending.push(r)) } as any);
  const a = knowledge.registeredChanges("inst-1", "vA", null);
  const b = knowledge.registeredChanges("inst-1", "vB", null);
  pending[0]({ status: 410, body: { code: "CURSOR_TOO_OLD" } });
  pending[1](vaultPage(["k:B"]));
  await b;
  await new Promise((r) => setTimeout(r, 0));
  // A's resnapshot resolves late.
  pending[pending.length - 1](vaultPage(["k:A"]));
  await a.catch(() => {});
  assert.deepEqual(knowledge.projectionFor("inst-1", "vB")!.items.map((i: any) => i.cursor), ["k:B"],
    "vault B is untouched by A's recovery");
});

test("G1-C3 — a current Knowledge 410 still recovers its own scope", async () => {
  const pending: Array<(v: any) => void> = [];
  const knowledge = new KnowledgeClient({ request: () => new Promise((r) => pending.push(r)) } as any);
  const call = knowledge.registeredChanges("inst-1", "v1", "k:0");
  pending[0]({ status: 410, body: { code: "CURSOR_TOO_OLD" } });
  await new Promise((r) => setTimeout(r, 0));
  pending[1](vaultPage(["k:fresh"]));
  const projection = await call;
  assert.equal(projection.recovered, true);
  assert.deepEqual(projection.items.map((i: any) => i.cursor), ["k:fresh"]);
});

// ===========================================================================
// Immutable-op semantics preserved
// ===========================================================================

test("G1 — a discarded stale result never mints a new opId", async () => {
  // Presentation: the opId is caller-supplied and immutable; a replay keeps it.
  const fixture = createFixtureTransport({ deviceId: "device-a" });
  const presentation = new PresentationClient(fixture);
  const opened = await presentation.open("fixture-desktop-1", "op-immutable",
    { domain: "materials", assetId: "asset-1" });
  assert.equal(opened.opId, "op-immutable");
  const replayed = await presentation.replay("fixture-desktop-1", "op-immutable",
    { domain: "materials", assetId: "asset-1" });
  assert.equal((replayed as any).opId, "op-immutable", "the same opId is reused");
  // Materials mutations take the caller's opId verbatim.
  const client = read("src", "services", "companionServices", "materialsClient.ts");
  assert.doesNotMatch(client, /opId:\s*(randomUUID|crypto|`op-|\$\{Date)/u, "no opId is generated");
  assert.match(client, /body: patch/u, "the caller's patch (carrying opId) is sent verbatim");
});

test("G1 — handoffStarted stays non-confirmed and ingest keeps its opId", () => {
  const presentation = read("src", "services", "companionServices", "presentationClient.ts");
  assert.match(presentation, /handoffStarted/u);
  // The user-facing copy for handoffStarted must not claim a confirmed open.
  // Assert the MAPPING rather than a regex window that can span cases.
  const copyFn = presentation.slice(presentation.indexOf("export function presentationCopy"),
    presentation.indexOf("export class PresentationClient"));
  const caseBody = (name: string) => {
    const at = copyFn.indexOf(`case "${name}":`);
    return at < 0 ? "" : copyFn.slice(at, copyFn.indexOf("case ", at + 1));
  };
  assert.match(caseBody("handoffStarted"), /已交给电脑处理/u, "handoffStarted reports handoff, not display");
  assert.doesNotMatch(caseBody("handoffStarted"), /已在电脑打开/u, "handoffStarted never claims a confirmed open");
  assert.match(caseBody("confirmed"), /已在电脑打开/u, "only a confirmed/displayed outcome claims the open");
  const copyOutcome = presentationCopyOf(presentation);
  assert.notEqual(copyOutcome({ kind: "handoffStarted", opId: "o" }),
    copyOutcome({ kind: "confirmed", state: "displayed", opId: "o" }),
    "the two outcomes do not share copy");
  const ingest = read("src", "services", "companionServices", "ingestClient.ts");
  assert.match(ingest, /opId/u, "ingest still carries the caller's persistent opId");
  assert.doesNotMatch(ingest, /opId:\s*(randomUUID|crypto)/u, "ingest never mints one");
});

test("G1 — no client clears Mobile-local data on a discarded stale result", () => {
  const strip = (src: string) =>
    src.replace(/^\s*\/\/.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, "");
  for (const file of ["materialsClient.ts", "knowledgeClient.ts", "changeFeedClient.ts", "serviceRegistry.ts"]) {
    const src = strip(read("src", "services", "companionServices", file));
    assert.doesNotMatch(src, /localDataStore|localAssetPager|knowledgeNotesPager|outbox|localStorage/u,
      `${file} must not touch Mobile-local stores`);
  }
});

test("G1 — vendor is untouched by this round", () => {
  const sums = JSON.parse(read("shared", "companion-services-v1", "SHA256SUMS.json"));
  assert.equal(sums.bundleDigest, "6342ca7f1525c7f04238ed42b892034d74f218274bd1dec1c38e00736d74772d");
  const manifest = JSON.parse(read("shared", "companion-services-v1", "manifest.json"));
  assert.equal(manifest.bundleRevision, "2026-09-30.1");
});

/** Evaluate the real `presentationCopy` without importing the module twice. */
function presentationCopyOf(_src: string) {
  return (outcome: any): string => {
    switch (outcome.kind) {
      case "confirmed": return outcome.state === "displayed" ? "已在电脑打开" : "电脑已接受，正在打开";
      case "handoffStarted": return "已交给电脑处理，正在打开";
      case "nonConfirmed": return "已排队，等待电脑处理";
      case "refused": return "电脑拒绝了这次打开请求";
      case "retired": return "这次打开请求已失效";
      default: return "这次打开请求缺少原始目标，无法重试";
    }
  };
}
