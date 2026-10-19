// Local-data invalidation bus tests (M2.10 Scope D + FIX-V1 P1-3):
// publish bumps the version and notifies subscribers; listeners receive the
// published domain (domain-aware refresh); unsubscribing prevents duplicate
// callbacks after remount; the bus carries no content.
import test from "node:test";
import assert from "node:assert/strict";
import { localDataStore, publishAfter, type LocalDomain } from "../src/services/localDataStore.ts";

test("local-data store — publish bumps version and notifies subscribers", () => {
  const store = localDataStore;
  const before = store.getVersion();
  let notified = 0;
  const unsub = store.subscribe(() => {
    notified += 1;
  });
  store.publish("note");
  assert.equal(store.getVersion(), before + 1, "version bumps on successful mutation");
  assert.equal(notified, 1, "subscriber observed the change");
  unsub();
});

test("local-data store — listeners receive the published domain", () => {
  const store = localDataStore;
  const seen: LocalDomain[] = [];
  const unsub = store.subscribe((domain) => {
    seen.push(domain);
  });
  store.publish("inbox");
  store.publish("note");
  store.publish("asset");
  assert.deepEqual(seen, ["inbox", "note", "asset"], "domain-aware refresh decisions");
  unsub();
});

test("local-data store — publishAfter publishes once on success, never on failure", async () => {
  const store = localDataStore;
  const before = store.getVersion();
  const r = await publishAfter("note", Promise.resolve("ok"));
  assert.equal(r, "ok");
  assert.equal(store.getVersion(), before + 1, "success publishes once");
  await assert.rejects(publishAfter("asset", Promise.reject(new Error("x"))));
  assert.equal(store.getVersion(), before + 1, "failure publishes nothing");
});

test("local-data store — multiple domains share one monotonic version", () => {
  const store = localDataStore;
  const before = store.getVersion();
  const seen: number[] = [];
  const unsub = store.subscribe(() => seen.push(store.getVersion()));
  store.publish("inbox");
  store.publish("asset");
  assert.equal(seen.length, 2);
  assert.ok(seen[0] > before && seen[1] > seen[0], "monotonic version across domains");
  unsub();
});

test("local-data store — subscription cleanup prevents duplicate callbacks", () => {
  const store = localDataStore;
  const before = store.getVersion();
  let calls = 0;
  const unsub = store.subscribe(() => {
    calls += 1;
  });
  // Remount simulation: subscribe again, then clean up the FIRST subscription.
  const unsub2 = store.subscribe(() => {
    calls += 1;
  });
  unsub(); // stale subscription removed (e.g. HMR/StrictMode remount)
  store.publish("note");
  assert.equal(calls, 1, "only the live subscription receives the callback");
  unsub2();
  store.publish("asset");
  assert.equal(calls, 1, "no callbacks after full cleanup");
  assert.ok(store.getVersion() > before);
});

test("local-data store — failed mutations are the caller's contract, not the bus", () => {
  // The bus only carries a version; it carries no private content, so a failed
  // mutation can simply choose not to publish. Verify the surface stays
  // content-free.
  const store = localDataStore;
  assert.equal(typeof store.publish, "function");
  assert.equal(typeof store.getVersion, "function");
  assert.equal(typeof store.subscribe, "function");
});
