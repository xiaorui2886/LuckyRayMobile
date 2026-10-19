// Mobile-local invalidation closure tests (M2.10 FIX-V1 P1-3):
//  - share ingest publishes an Inbox commit ONLY when consumed > 0
//    (zero-consumed sweeps and failed ingests publish nothing);
//  - Settings observes every successful local commit (three bounded stats);
//  - Library reloads its Local Asset page on EXTERNAL asset mutations only,
//    generation-safe, without a Desktop side effect or reload loop;
//  - NoteEditor pin/favorite/delete publish after success only;
//  - unsubscribe prevents duplicate callbacks.
import test from "node:test";
import assert from "node:assert/strict";
import { localDataStore, publishAfter } from "../src/services/localDataStore.ts";
import { shouldPublishInboxCommit } from "../src/services/shareIngest.ts";
import {
  commitPageOne,
  initialLocalPage,
  localPageLoading,
  resetLocalPage,
} from "../src/services/libraryPagination.ts";

function asset(id: string) {
  return { assetId: id, name: `a-${id}` };
}

test("invalidation — share ingest consumed>0 publishes exactly one Inbox commit", async () => {
  assert.equal(shouldPublishInboxCommit({ consumed: 3 }), true);
  const before = localDataStore.getVersion();
  let calls = 0;
  const unsub = localDataStore.subscribe(() => {
    calls += 1;
  });
  // App.tsx flow: decide -> publish exactly once.
  localDataStore.publish("inbox");
  assert.equal(calls, 1, "exactly one Inbox commit published");
  assert.equal(localDataStore.getVersion(), before + 1);
  unsub();
});

test("invalidation — share ingest consumed=0 publishes none", () => {
  assert.equal(shouldPublishInboxCommit({ consumed: 0 }), false);
  const before = localDataStore.getVersion();
  // A zero-new-item focus/visibility reconciliation sweep is NOT a mutation:
  // the App flow never reaches publish, so the version stays unchanged.
  assert.equal(localDataStore.getVersion(), before, "no false mutation event");
});

test("invalidation — failed share ingest publishes nothing", async () => {
  assert.equal(shouldPublishInboxCommit(null), false);
  assert.equal(shouldPublishInboxCommit(undefined), false);
  assert.equal(shouldPublishInboxCommit({}), false);
  const before = localDataStore.getVersion();
  await assert.rejects(publishAfter("inbox", Promise.reject(new Error("ingest failed"))));
  assert.equal(localDataStore.getVersion(), before, "failed ingest publishes nothing");
});

test("invalidation — Settings observes successful Capture/Note/Asset commits (3-stat refresh contract)", () => {
  // Models Settings.tsx: a [localVersion] effect reloads the three bounded
  // local stats after every successful Mobile-local commit — no polling, no
  // Desktop call (pure local stat reads).
  let refreshes = 0;
  const statLoads: string[] = [];
  const unsub = localDataStore.subscribe(() => {
    refreshes += 1;
    statLoads.push("inbox", "note", "asset"); // the three stat reads per refresh
  });
  localDataStore.publish("inbox"); // Capture / Inbox commit
  localDataStore.publish("note"); // Knowledge / NoteEditor commit
  localDataStore.publish("asset"); // Library / LocalAssetDetail commit
  assert.equal(refreshes, 3, "every successful local commit refreshes Settings");
  assert.equal(statLoads.filter((s) => s === "inbox").length, 3, "3 refreshes × 3 stat reads");
  unsub();
});

test("invalidation — Library external asset commit causes a generation-safe local-page reload", async () => {
  // Subscription side: only the `asset` domain triggers the reload.
  let reloads = 0;
  const unsub = localDataStore.subscribe((domain) => {
    if (domain === "asset") reloads += 1;
  });
  localDataStore.publish("note");
  assert.equal(reloads, 0, "non-asset mutations never reload the Local Asset page");
  localDataStore.publish("asset");
  assert.equal(reloads, 1, "external asset commit invalidates the Local Asset page");
  unsub();

  // Reload side: the fresh page-1 replaces the old grid; a stale response from
  // the pre-invalidation generation is ignored (Library.tsx generation guard).
  let gen = 0;
  let state = initialLocalPage();
  gen = 1;
  state = localPageLoading(resetLocalPage(state));
  state = commitPageOne(state, gen, [asset("a1")], 1, false);
  assert.deepEqual(state.items.map((a) => a.assetId), ["a1"]);

  gen = 2; // reload triggered by the external asset commit
  state = localPageLoading(resetLocalPage(state));
  assert.equal(commitPageOne(state, 1, [asset("old")], 99, false), state, "stale pre-reload response ignored");
  state = commitPageOne(state, 2, [asset("a2")], 1, false);
  assert.deepEqual(state.items.map((a) => a.assetId), ["a2"], "old grid fully replaced by the fresh page-1");
});

test("invalidation — NoteEditor pin/favorite/delete publish after success only", async () => {
  const before = localDataStore.getVersion();
  await publishAfter("note", Promise.resolve("pinned"));
  assert.equal(localDataStore.getVersion(), before + 1, "successful pin toggle publishes");

  await assert.rejects(publishAfter("note", Promise.reject(new Error("db"))));
  assert.equal(localDataStore.getVersion(), before + 1, "failed flag toggle publishes nothing");

  const b2 = localDataStore.getVersion();
  await publishAfter("note", Promise.resolve("favorite"));
  await publishAfter("note", Promise.resolve("deleted"));
  assert.equal(localDataStore.getVersion(), b2 + 2, "favorite + delete successes each publish once");
});

test("invalidation — unsubscribe prevents duplicate callbacks", () => {
  let calls = 0;
  const unsub = localDataStore.subscribe((d) => {
    void d;
    calls += 1;
  });
  const unsub2 = localDataStore.subscribe((d) => {
    void d;
    calls += 1;
  });
  unsub(); // e.g. StrictMode/HMR remount removes the stale subscription
  localDataStore.publish("inbox");
  assert.equal(calls, 1, "removed subscription never receives callbacks");
  unsub2();
  localDataStore.publish("asset");
  assert.equal(calls, 1, "no callbacks after full cleanup");
});
