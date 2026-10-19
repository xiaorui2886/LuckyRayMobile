// SyncCoordinator unit tests (injectable runFn, no Tauri).
// Run: node --experimental-strip-types --test tests/syncCoordinator.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SyncCoordinator } from "../src/services/syncCoordinator.ts";

// Legacy (M2) behavior tests run UNGATED — the foundation gate is tested separately.
function ungated(fn: Parameters<typeof SyncCoordinator>[0]): SyncCoordinator {
  return new SyncCoordinator(fn, { foundationBlocked: false });
}
import { refreshConnectionStateOnDataCommit } from "../src/services/connectionStateRefresh.ts";

test("other notes can progress while persisted local attention never reports an idle completed round", async () => {
  let attention = true;
  const c = new SyncCoordinator(async () => ({ instanceId: "A", vaultId: "v", pushed: 1, attentionRequired: attention }), { foundationBlocked: false, contentOnly: true });
  c.setOwner("A");
  await c.run();
  assert.equal(c.snapshot().status, "error");
  assert.equal(c.snapshot().error, "CONTENT_SYNC_REQUIRES_ATTENTION");
  attention = false;
  await c.run();
  assert.equal(c.snapshot().status, "idle");
  assert.equal(c.snapshot().error, null);
  c.dispose();
});

test("single-flight: concurrent run() calls share one execution", async () => {
  let calls = 0;
  const c = ungated(async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 30));
  });
  await Promise.all([c.run(), c.run(), c.run()]);
  assert.equal(calls, 1, "runFn executed once");
  assert.equal(c.snapshot().status, "idle");
});

test("success resets backoff and clears error", async () => {
  let calls = 0;
  const c = ungated(async () => {
    calls++;
    if (calls === 1) throw new Error("connection refused");
  });
  await c.run();
  assert.equal(c.snapshot().status, "offline", "offline-ish error mapped");
  // second run succeeds
  await c.run();
  assert.equal(c.snapshot().status, "idle");
  assert.equal(c.snapshot().error, null);
});

test("trigger() coalesces while inflight", async () => {
  let calls = 0;
  const c = ungated(async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 20));
  });
  c.trigger();
  c.trigger(); // while inflight -> dropped
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls, 1, "coalesced to one run");
});

test("offline error maps to offline status and schedules backoff retry", async () => {
  const c = ungated(async () => {
    throw new Error("failed to send request");
  });
  await c.run();
  assert.equal(c.snapshot().status, "offline");
  assert.equal(c["backoffMs"], 2000, "backoff doubled after failure");
  assert.ok(c["retryTimer"] !== null, "retry scheduled");
  c.dispose();
});

test("foreground+ws+manual multi-trigger coalesces to one sync", async () => {
  let calls = 0;
  const c = ungated(async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 25));
  });
  // simulate: foreground, ws reconnect, manual refresh fired near-simultaneously
  c.trigger();
  c.trigger();
  c.trigger();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(calls, 1, "multi-trigger coalesced to a single sync run");
});

test("pendingOutbox refreshed after successful run", async () => {
  let outboxValue = 3;
  const c = ungated(async () => undefined);
  c["refreshOutbox"] = async () => {
    c["pendingOutbox"] = outboxValue;
  };
  await c.run();
  assert.equal(c.snapshot().pendingOutbox, 3);
});

test("successful sync refreshes Settings connection stats through the data-commit event", async () => {
  let durableStats = { assets: 1, notes: 1, outbox: 2, runs: 0, sync_cursor: 4 };
  let displayedStats: typeof durableStats | null = null;
  let refreshes = 0;
  const stop = refreshConnectionStateOnDataCommit(async () => {
    refreshes += 1;
    displayedStats = { ...durableStats };
  });
  const c = ungated(async () => undefined);
  c["refreshOutbox"] = async () => {
    c["pendingOutbox"] = 0;
  };

  durableStats = { assets: 6, notes: 3, outbox: 0, runs: 2, sync_cursor: 56 };
  await c.run();

  assert.equal(refreshes, 1, "one durable sync commit triggers one connection-state reload");
  assert.deepEqual(displayedStats, durableStats, "Settings sees fresh stats without an interval or restart");
  stop();
  c.dispose();
});

test("manual outbox flush publishes the pending count without starting a second sync", async () => {
  let runCalls = 0;
  const c = ungated(async () => {
    runCalls += 1;
  });
  let displayedPending = -1;
  const stop = refreshConnectionStateOnDataCommit(() => {
    displayedPending = c.snapshot().pendingOutbox;
  });
  c["refreshOutbox"] = async () => {
    c["pendingOutbox"] = 0;
  };

  await c.refreshOutboxStatus();

  assert.equal(runCalls, 0, "status refresh does not create a second durable sync");
  assert.equal(displayedPending, 0, "Settings receives the flushed outbox count immediately");
  stop();
  c.dispose();
});

test("app shell reloads conn_state from commits instead of a periodic status poll", () => {
  const app = readFileSync(join(import.meta.dirname, "..", "src", "App.tsx"), "utf8");
  assert.match(app, /refreshConnectionStateOnDataCommit\(refresh\)/);
  assert.doesNotMatch(app, /setInterval\(refresh/);
});

test("Capture publishes enqueue commits to the shared sync snapshot (M2.12: no manual Desktop flush in the normal shell)", () => {
  const capture = readFileSync(join(import.meta.dirname, "..", "src", "screens", "Capture.tsx"), "utf8");
  assert.equal(
    capture.match(/await syncCoordinator\.refreshOutboxStatus\(\);/g)?.length,
    2,
    "image/file enqueue and text/link enqueue both publish their outbox state"
  );
  // M2.12 Scope C: while M3 is HOLD the normal product shell exposes NO
  // prominent Desktop push control (the backend capture-outbox is preserved
  // and surfaced only as developer diagnostics in Settings).
  assert.doesNotMatch(capture, />推送待处理</, "no prominent Desktop push button");
  assert.doesNotMatch(capture, /onClick=\{flush\}/, "no flush trigger in the normal shell");
  assert.doesNotMatch(capture, /captureFlush\(\)/, "no manual flush invoke in the normal shell");
});

// ---------------------------------------------------------------------------
// M3-M1 Phase-B R1 (P1-1): foundation route containment — the gate must keep
// the pair→WSS-connected flow free of /v1/sync/changes and every other
// business route.
// ---------------------------------------------------------------------------
test("foundation gate: connected + trigger while gated never calls runFn", async () => {
  let calls = 0;
  const c = new SyncCoordinator(async () => {
    calls++;
    return undefined;
  }); // foundationBlocked by default
  c.trigger();
  await c.trigger();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls, 0, "gated trigger must not run sync");
  assert.equal(c.snapshot().status, "idle", "gated coordinator stays idle");
});

test("foundation gate: run() while gated resolves without executing", async () => {
  let calls = 0;
  const c = new SyncCoordinator(async () => {
    calls++;
    return undefined;
  });
  await c.run();
  assert.equal(calls, 0, "gated run must not execute");
});

test("content authority: production singleton invokes only capability-negotiated content sync", async () => {
  let calls = 0;
  const injected = new SyncCoordinator(async () => {
    calls++;
    return undefined;
  }, { foundationBlocked: false });
  await injected.run();
  assert.equal(calls, 1, "constructor injection preserves legacy test coverage");

  const source = readFileSync(join(import.meta.dirname, "..", "src", "services", "syncCoordinator.ts"), "utf8");
  assert.doesNotMatch(source, /setFoundationBlocked\s*\(/, "production authority exposes no mutable sync unlock");
  assert.match(source, /export const syncCoordinator = new SyncCoordinator\(\(\) => api\.contentSync\(\), \{ foundationBlocked: false, contentOnly: true \}\)/, "production runs the scoped content adapter");
});

test("content completion never flushes legacy outbox and publishes committed changes", async () => {
  let refreshes = 0;
  let commits = 0;
  const stop = refreshConnectionStateOnDataCommit(() => { commits += 1; });
  const c = new SyncCoordinator(async () => ({ applied: 2, pushed: 1 }), { foundationBlocked: false, contentOnly: true });
  c["refreshOutbox"] = async () => { refreshes += 1; };
  await c.run();
  assert.equal(refreshes, 0);
  assert.equal(commits, 1);
  stop();
  c.dispose();
});
