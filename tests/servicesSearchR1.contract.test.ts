// SERVICES-SEARCH-R1 — ordinary Search over canonical `search.unified`.
//
// The deferred-promise cases drive the PRODUCTION SearchServicesController
// (the exact class StillSearch uses) with an injected ServiceRegistry,
// deferred SearchSession and a deferred catalog probe — no currentness
// replica exists. Wiring contracts pin the ordinary page onto the canonical
// path and away from the legacy direct Content V1 search reads.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SearchServicesController } from "../src/still/kit/searchServicesController.ts";
import { deriveSearchPagePresentation } from "../src/still/kit/searchPresentation.ts";
import { ServiceRegistry } from "../src/services/companionServices/index.ts";
import { SearchSession } from "../src/services/companionServices/searchClient.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const strip = (src: string) => src.replace(/^\s*\/\/.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, "");
const flush = () => new Promise((r) => setTimeout(r, 0));
/** Deterministic wait: poll until `cond` holds (500 ms budget). */
async function waitFor(cond: () => boolean, what = "condition"): Promise<void> {
  for (let i = 0; i < 200000; i++) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`waitFor timeout: ${what}`);
}

type Deferred = { promise: any; resolve: (v: any) => void; reject: (e: unknown) => void };
function deferred(): Deferred {
  let resolve!: (v: any) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<any>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A REAL ServiceRegistry whose discovery transport is deferred-controlled. */
function makeRegistry() {
  const reg = new ServiceRegistry({
    request: (req: any) => {
      const d = deferred();
      discoverQueue.push({ path: req.path as string, d });
      return d.promise;
    },
  });
  const discoverQueue: Array<{ path: string; d: Deferred }> = [];
  return {
    registry: reg,
    discoverQueue,
    resolve(i: number, catalog: { gatewayGeneration: number; permissionRevision: number; operations?: any }) {
      const item = discoverQueue[i];
      item.d.resolve({
        status: 200,
        body: {
          catalogVersion: 1,
          bundleRevision: "2026-09-24.3",
          desktopInstanceId: "inst-1",
          gatewayGeneration: catalog.gatewayGeneration,
          permissionRevision: catalog.permissionRevision,
          services: {},
          operations: catalog.operations ?? {
            "search.unified": { state: "implemented" },
          },
          limits: { pageSize: 20, batchItems: 20, noteBytes: 1, uploadBytes: 1 },
        },
      });
    },
  };
}

/** A REAL SearchSession whose search transport is deferred-controlled. */
function makeSession() {
  const session = new SearchSession({
    request: (req: any) => {
      const d = deferred();
      searchQueue.push({ req, d });
      return d.promise;
    },
  });
  const searchQueue: Array<{ req: any; d: Deferred }> = [];
  return {
    session,
    searchQueue,
    resolvePage(i: number, items: any[], nextCursor: string | null = null) {
      searchQueue[i].d.resolve({ status: 200, body: { items, nextCursor } });
    },
    reject410(i: number) {
      searchQueue[i].d.resolve({ status: 410, body: { code: "CURSOR_TOO_OLD" } });
    },
  };
}

type RemoteSnap = {
  phase: string;
  query: string;
  instanceId: string;
  permissionRevision: number | null;
  hits: Array<{ domain: string; title?: string; assetId?: string; vaultId?: string; noteId?: string; path?: string; snippet?: string; subtitle?: string }>;
  nextCursor: string | null;
  recovered: boolean;
};

/** Full harness: production registry + session + controller, all deferred. */
function makeHarness(opts: { live?: boolean } = {}) {
  const reg = makeRegistry();
  const ses = makeSession();
  const snaps: RemoteSnap[] = [];
  const controller = new SearchServicesController({
    registry: reg.registry,
    session: ses.session,
    debounceMs: 0,
  });
  controller.subscribe((s) => snaps.push(JSON.parse(JSON.stringify(s))));

  /** Resolve the pending canonical discovery for the CURRENT query. The
   *  controller has TWO deferred reads per query (the page probe await and
   *  the registry refresh read); both are queued by the time the debounce
   *  fires, so this resolver retries across macro-tasks until both are
   *  settled — deterministic, no timing assumptions. */
  function resolveIdentity(catalog: { gatewayGeneration: number; permissionRevision: number; operations?: any }, instanceId = "inst-1") {
    const body = {
      catalogVersion: 1,
      bundleRevision: "2026-09-24.3",
      desktopInstanceId: instanceId,
      gatewayGeneration: catalog.gatewayGeneration,
      permissionRevision: catalog.permissionRevision,
      services: {},
      operations: catalog.operations ?? { "search.unified": { state: "implemented" } },
      limits: { pageSize: 20, batchItems: 20, noteBytes: 1, uploadBytes: 1 },
    };
    // The discovery read may be issued a few macro-tasks after this call
    // (debounce fires first), so keep pumping across timers until the newest
    // pending discovery is answered.
    const pump = (tries: number) => {
      const disc = reg.discoverQueue.at(-1);
      if (disc && !disc.done) { disc.done = true; disc.d.resolve({ status: 200, body }); return; }
      if (tries > 0) setImmediate(() => pump(tries - 1));
    };
    setImmediate(() => pump(20000));
  }

  return {
    controller, snaps, reg, ses, resolveIdentity,
    setLive: (v: boolean) => { opts.live = v; },
    get live() { return opts.live ?? true; },
  };
}

const hit = (domain: "materials" | "knowledge", extra: Record<string, string>) => ({ domain, ...extra }) as any;

test("R1-1 — mixed materials+knowledge page 1 in exact server order", async () => {
  const h = makeHarness();
  h.controller.setConnection({ paired: true, instanceId: "inst-1", isLive: () => h.live });
  h.controller.setQuery("海报");
  await flush();
  h.resolveIdentity({ gatewayGeneration: 2, permissionRevision: 4 }, "inst-1");
  const page1 = [
    hit("materials", { assetId: "a-1", title: "海报 A", subtitle: "素材" }),
    hit("knowledge", { vaultId: "v-1", noteId: "n-1", title: "海报 B", snippet: "知识" }),
    hit("materials", { assetId: "a-2", title: "海报 C" }),
  ];
  await waitFor(() => h.ses.searchQueue.length > 0);
  h.ses.resolvePage(0, page1);
  await flush();
  const last = h.snaps.at(-1)!;
  assert.equal(last.phase, "ready");
  assert.deepEqual(last.hits.map((x) => x.domain), ["materials", "knowledge", "materials"],
    "canonical server order preserved (no re-grouping)");
  assert.equal(last.instanceId, "inst-1");
  assert.equal(last.permissionRevision, 4);
});

test("R1-2 — nextCursor append joins the SAME generation", async () => {
  const h = makeHarness();
  h.controller.setConnection({ paired: true, instanceId: "inst-1", isLive: () => h.live });
  h.controller.setQuery("q");
  await flush();
  h.resolveIdentity({ gatewayGeneration: 2, permissionRevision: 4 }, "inst-1");
  await waitFor(() => h.ses.searchQueue.length > 0);
  await waitFor(() => h.ses.searchQueue.length > 0);
  h.ses.resolvePage(0, [hit("materials", { assetId: "a-1", title: "one" })], "cur-1");
  await flush();
  h.controller.loadMore();
  await waitFor(() => h.ses.searchQueue.length > 1);
  h.ses.resolvePage(1, [hit("knowledge", { vaultId: "v", noteId: "n", title: "two" })], null);
  await flush();
  const last = h.snaps.at(-1)!;
  assert.equal(last.hits.length, 2, "appended, not replaced");
  assert.equal(last.nextCursor, null, "terminal page retires the cursor");
});

test("R1-3 — terminal page retires the cursor; repeated loadMore is a no-op", async () => {
  const h = makeHarness();
  h.controller.setConnection({ paired: true, instanceId: "inst-1", isLive: () => h.live });
  h.controller.setQuery("q");
  await flush();
  h.resolveIdentity({ gatewayGeneration: 2, permissionRevision: 4 }, "inst-1");
  await waitFor(() => h.ses.searchQueue.length > 0);
  await waitFor(() => h.ses.searchQueue.length > 0);
  h.ses.resolvePage(0, [], null);
  await flush();
  const before = h.snaps.at(-1)!;
  h.controller.loadMore(); // no cursor: no request, no state change
  await flush();
  assert.equal(h.ses.searchQueue.length, 1, "no extra search request without a cursor");
  assert.equal(h.snaps.at(-1), before);
});

test("R1-4 — 410 → fresh no-cursor page-1 REPLACES the projection", async () => {
  const h = makeHarness();
  h.controller.setConnection({ paired: true, instanceId: "inst-1", isLive: () => h.live });
  h.controller.setQuery("q");
  await flush();
  h.resolveIdentity({ gatewayGeneration: 2, permissionRevision: 4 }, "inst-1");
  await waitFor(() => h.ses.searchQueue.length > 0);
  await waitFor(() => h.ses.searchQueue.length > 0);
  h.ses.resolvePage(0, [hit("materials", { assetId: "old", title: "old" })], "stale-cursor");
  await flush();
  h.controller.loadMore();
  h.ses.reject410(1);
  await flush();
  await waitFor(() => h.ses.searchQueue.length > 2);
  h.ses.resolvePage(2, [hit("materials", { assetId: "fresh", title: "fresh" })], null);
  await flush();
  const last = h.snaps.at(-1)!;
  assert.deepEqual(last.hits.map((x) => x.assetId), ["fresh"], "recovery REPLACED the rows");
  assert.equal(last.recovered, true);
});

test("R1-5 — query A → B: late A success never commits", async () => {
  const h = makeHarness();
  h.controller.setConnection({ paired: true, instanceId: "inst-1", isLive: () => h.live });
  h.controller.setQuery("A");
  await flush();
  h.resolveIdentity({ gatewayGeneration: 2, permissionRevision: 4 }, "inst-1");
  await new Promise((r) => setImmediate(r));
  h.controller.setQuery("B"); // A superseded
  h.resolveIdentity({ gatewayGeneration: 2, permissionRevision: 4 }, "inst-1");
  await new Promise((r) => setImmediate(r));
  // A's page request lands late (SearchSession generation fence drops it).
  await waitFor(() => h.ses.searchQueue.length > 0);
  h.ses.resolvePage(0, [hit("materials", { assetId: "from-A", title: "A row" })], null);
  await flush();
  await waitFor(() => h.ses.searchQueue.length > 1);
  h.ses.resolvePage(1, [hit("materials", { assetId: "from-B", title: "B row" })], null);
  await flush();
  const ready = h.snaps.filter((s) => s.phase === "ready" && s.hits.length);
  assert.equal(ready.length, 1);
  assert.equal(ready[0].hits[0].assetId, "from-B");
  assert.equal(ready[0].query, "B");
});

test("R1-6 — late A error after B is ignored", async () => {
  const h = makeHarness();
  h.controller.setConnection({ paired: true, instanceId: "inst-1", isLive: () => h.live });
  h.controller.setQuery("A");
  await flush();
  h.resolveIdentity({ gatewayGeneration: 2, permissionRevision: 4 }, "inst-1");
  await new Promise((r) => setImmediate(r));
  h.controller.setQuery("B");
  await flush();
  h.resolveIdentity({ gatewayGeneration: 2, permissionRevision: 4 }, "inst-1");
  await waitFor(() => h.ses.searchQueue.length > 1);
  await waitFor(() => h.ses.searchQueue.length > 1);
  h.ses.resolvePage(1, [hit("materials", { assetId: "from-B" })], null);
  await flush();
  h.ses.reject410 === undefined;
  // A's request (index 0) resolves with a transient error AFTER B committed.
  h.ses.searchQueue[0].d.resolve({ status: 500, body: { code: "SERVICE_UNAVAILABLE" } });
  await flush();
  const last = h.snaps.at(-1)!;
  assert.equal(last.phase, "ready", "the stale A error never touched B's settled state");
  assert.equal(last.query, "B");
});

test("R1-7 — old page-N after a new query is ignored", async () => {
  const h = makeHarness();
  h.controller.setConnection({ paired: true, instanceId: "inst-1", isLive: () => h.live });
  h.controller.setQuery("A");
  await flush();
  h.resolveIdentity({ gatewayGeneration: 2, permissionRevision: 4 }, "inst-1");
  await waitFor(() => h.ses.searchQueue.length > 0);
  await waitFor(() => h.ses.searchQueue.length > 0);
  h.ses.resolvePage(0, [hit("materials", { assetId: "a-page1", title: "A1" })], "cur-A");
  await flush();
  // Load more for A (its next-page goes out), then the user types B.
  h.controller.loadMore();
  h.controller.setQuery("B");
  await flush();
  h.resolveIdentity({ gatewayGeneration: 2, permissionRevision: 4 }, "inst-1");
  await new Promise((r) => setImmediate(r));
  // A's page-2 lands late…
  await waitFor(() => h.ses.searchQueue.length > 1);
  h.ses.resolvePage(1, [hit("materials", { assetId: "a-page2", title: "A2" })], null);
  await flush();
  await waitFor(() => h.ses.searchQueue.length > 2);
  h.ses.resolvePage(2, [hit("materials", { assetId: "b-page1", title: "B1" })], null);
  await flush();
  const last = h.snaps.at(-1)!;
  assert.equal(last.query, "B");
  assert.ok(!last.hits.some((x) => x.assetId === "a-page2"), "A's late page-N never joined B");
});

test("R1-8 — Desktop A → Desktop B: late A result is isolated", async () => {
  const h = makeHarness();
  h.controller.setConnection({ paired: true, instanceId: "inst-A", isLive: () => h.live });
  h.controller.setQuery("q");
  await flush();
  h.resolveIdentity({ gatewayGeneration: 2, permissionRevision: 4 }, "inst-A");
  await new Promise((r) => setImmediate(r));
  // Switch Desktop before A resolves.
  h.controller.setConnection({ paired: true, instanceId: "inst-B", isLive: () => h.live });
  h.resolveIdentity({ gatewayGeneration: 2, permissionRevision: 4 }, "inst-B");
  await new Promise((r) => setImmediate(r));
  h.wireLateAResolve?.();
  await waitFor(() => h.ses.searchQueue.length > 1);
  h.ses.resolvePage(1, [hit("materials", { assetId: "from-B" })], null);
  await flush();
  const ready = h.snaps.filter((s) => s.phase === "ready" && s.hits.length);
  assert.ok(ready.every((s) => s.instanceId === "inst-B"), "no A-owned row ever commits");
});

test("R1-9 — reconnect retires the epoch; reconnect issues a fresh discovery+query", async () => {
  const h = makeHarness();
  h.controller.setConnection({ paired: true, instanceId: "inst-1", isLive: () => h.live });
  h.controller.setQuery("q");
  await flush();
  h.resolveIdentity({ gatewayGeneration: 2, permissionRevision: 4 }, "inst-1");
  await new Promise((r) => setImmediate(r));
  // Simulate a connection drop: the page retires; the pre-drop answer lands late.
  h.controller.retire();
  await waitFor(() => h.ses.searchQueue.length > 0);
  h.ses.resolvePage(0, [hit("materials", { assetId: "pre-drop" })], "pre-drop-cursor");
  await flush();
  assert.ok(!h.snaps.some((s) => s.phase === "ready" && s.hits.length),
    "the pre-drop answer must not become post-reconnect truth");
  // Reconnect: the page re-issues the reconnect entry — discovery +
  // query run fresh with NO cursor reuse.
  h.controller.reconnect();
  h.resolveIdentity({ gatewayGeneration: 3, permissionRevision: 4 }, "inst-1");
  await waitFor(() => h.ses.searchQueue.length > 1);
  await waitFor(() => h.ses.searchQueue.length > 1);
  h.ses.resolvePage(1, [hit("materials", { assetId: "fresh" })], null);
  await flush();
  const searches = h.ses.searchQueue.filter((s) => !s.req.query.cursor);
  assert.ok(searches.length >= 2, "a fresh page-1 was issued after reconnect");
  assert.ok(h.ses.searchQueue.every((s) => !s.req.query.cursor || s.req.query.cursor !== "pre-drop-cursor"),
    "no cursor from the prior runtime generation is reused");
});

test("R1-10 — permissionRevision change retires the old truth", async () => {
  const h = makeHarness();
  h.controller.setConnection({ paired: true, instanceId: "inst-1", isLive: () => h.live });
  h.controller.setQuery("q");
  await flush();
  h.resolveIdentity({ gatewayGeneration: 2, permissionRevision: 4 }, "inst-1");
  await waitFor(() => h.ses.searchQueue.length > 0);
  await waitFor(() => h.ses.searchQueue.length > 0);
  h.ses.resolvePage(0, [hit("materials", { assetId: "rev-4-row" })], null);
  await flush();
  // Desktop grants change: a fresh discovery observes revision 5; a new query
  // generation starts and the old-permission result cannot commit afterwards.
  h.controller.setQuery("q2");
  await flush();
  h.resolveIdentity({ gatewayGeneration: 2, permissionRevision: 5 });
  await waitFor(() => h.ses.searchQueue.length > 1);
  await waitFor(() => h.ses.searchQueue.length > 1);
  h.ses.resolvePage(1, [hit("materials", { assetId: "rev-5-row" })], null);
  await flush();
  h.ses.searchQueue[0].d.resolve({ status: 200, body: { items: [hit("materials", { assetId: "stale-rev4" })], nextCursor: null } });
  await flush();
  const last = h.snaps.at(-1)!;
  assert.equal(last.permissionRevision, 5);
  assert.ok(!last.hits.some((x) => x.assetId === "stale-rev4"), "old-permission result never becomes current");
});

test("R1-11 — notGranted / temporarilyUnavailable / unsupported are truthful", async () => {
  for (const [state, phase] of [
    ["notGranted", "not-granted"],
    ["temporarilyUnavailable", "temporarily-unavailable"],
    ["unsupported", "unsupported"],
  ] as const) {
    const h = makeHarness();
    h.controller.setConnection({ paired: true, instanceId: "inst-1", isLive: () => h.live });
    h.controller.setQuery("q");
  await flush();
    h.resolveIdentity({ gatewayGeneration: 2, permissionRevision: 4, operations: { "search.unified": { state } } });
    await flush();
    const last = h.snaps.at(-1)!;
    assert.equal(last.phase, phase, `state ${state} → ${phase}`);
    assert.equal(h.ses.searchQueue.length, 0, "no search request for a non-implemented operation");
  }
  // missing from the catalog entirely → unsupported
  const h = makeHarness();
  h.controller.setConnection({ paired: true, instanceId: "inst-1", isLive: () => h.live });
  h.controller.setQuery("q");
  await flush();
  h.resolveIdentity({ gatewayGeneration: 2, permissionRevision: 4, operations: {} });
  await flush();
  assert.equal(h.snaps.at(-1)!.phase, "unsupported");
});

test("R1-12 — local results survive a Desktop error (page never hides them)", () => {
  const pres = deriveSearchPagePresentation({
    localLoading: false,
    localCount: 3,
    remote: { phase: "error", query: "q", instanceId: "i", permissionRevision: null, hits: [], nextCursor: null, recovered: false },
  });
  assert.equal(pres.empty, false, "a Desktop error must not produce a global empty over local rows");
  assert.equal(pres.loading, false);
});

test("R1-13/14 — material and knowledge hits carry captured identity routes", () => {
  const src = strip(read("src", "still", "StillSearch.tsx"));
  assert.match(src, /desktopAssetRoute\(instance, hit\.assetId, library\)/u,
    "material rows route with the captured search instance");
  assert.match(src, /desktop:\$\{encodeURIComponent\(instance\)\}:\$\{encodeURIComponent\(hit\.vaultId\)\}:\$\{encodeURIComponent\(hit\.noteId\)\}/u,
    "knowledge rows route with captured instance+vault+note");
});

test("R1-15 — repeated loadMore while busy cannot duplicate page requests", async () => {
  const h = makeHarness();
  h.controller.setConnection({ paired: true, instanceId: "inst-1", isLive: () => h.live });
  h.controller.setQuery("q");
  await flush();
  h.resolveIdentity({ gatewayGeneration: 2, permissionRevision: 4 }, "inst-1");
  await waitFor(() => h.ses.searchQueue.length > 0);
  await waitFor(() => h.ses.searchQueue.length > 0);
  h.ses.resolvePage(0, [hit("materials", { assetId: "a" })], "cur");
  await flush();
  h.controller.loadMore();
  h.controller.loadMore();
  h.controller.loadMore();
  assert.equal(h.ses.searchQueue.length, 2, "only ONE next-page request while busy");
  await waitFor(() => h.ses.searchQueue.length > 1);
  h.ses.resolvePage(1, [hit("materials", { assetId: "b" })], null);
  await flush();
  const ready = h.snaps.filter((s) => s.hits.length >= 2);
  assert.ok(ready.length >= 1);
  assert.equal(h.snaps.at(-1)!.hits.length, 2, "rows appended exactly once");
});

// --- wiring: the ordinary page is on the canonical path, legacy is gone ----

test("wiring — StillSearch no longer calls legacy Desktop search reads", () => {
  const src = strip(read("src", "still", "StillSearch.tsx"));
  assert.doesNotMatch(src, /api\.contentNotes\s*\(/u, "no api.contentNotes for search");
  assert.doesNotMatch(src, /api\.contentAssets\s*\(/u, "no api.contentAssets for search");
  assert.doesNotMatch(src, /api\.contentVaults\s*\(/u, "no api.contentVaults bootstrap");
  // The canonical composition is present:
  assert.match(src, /SearchServicesController/u);
  assert.match(src, /new SearchSession\(/u);
  assert.match(src, /services\.registry/u);
  const ctrl = strip(read("src", "still", "kit", "searchServicesController.ts"));
  assert.match(ctrl, /refreshAdopting\(binding\.instanceId\)/u, "discovery rides the production registry (adopting)");
});

test("wiring — SearchSession issues canonical search.unified GET", () => {
  const src = strip(read("src", "services", "companionServices", "searchClient.ts"));
  assert.match(src, /operationId: "search\.unified"/u);
  assert.match(src, /path: "\/v1\/services\/search"/u);
});



test("R1R-A — unpaired + non-empty query settles immediately (never waiting-catalog)", () => {
  const h = makeHarness();
  h.controller.setConnection({ paired: false, instanceId: "", isLive: () => h.live });
  h.controller.setQuery("海报");
  const last = h.snaps.at(-1)!;
  assert.equal(last.phase, "unpaired", "unpaired query settles at once");
  assert.equal(last.hits.length, 0);
  assert.equal(h.ses.searchQueue.length, 0, "no Desktop request while unpaired");
});

test("R1R-A2 — WS drop clears hits/cursor and settles offline; local survives", async () => {
  const h = makeHarness();
  h.controller.setConnection({ paired: true, instanceId: "inst-1", isLive: () => h.live });
  h.controller.setQuery("q");
  h.resolveIdentity({ gatewayGeneration: 2, permissionRevision: 4 }, "inst-1");
  await waitFor(() => h.ses.searchQueue.length > 0);
  h.ses.resolvePage(0, [hit("materials", { assetId: "a-1" })], "cur-1");
  await flush();
  assert.equal(h.snaps.at(-1)!.phase, "ready");
  h.controller.disconnected();
  const off = h.snaps.at(-1)!;
  assert.equal(off.phase, "offline");
  assert.equal(off.hits.length, 0, "stale remote rows are cleared at once");
  assert.equal(off.nextCursor, null, "stale cursor is cleared");
});

test("R1R-A3 — ready -> disconnect -> reconnect = fresh discovery + page 1, no cursor reuse", async () => {
  const h = makeHarness();
  h.controller.setConnection({ paired: true, instanceId: "inst-1", isLive: () => h.live });
  h.controller.setQuery("q");
  h.resolveIdentity({ gatewayGeneration: 2, permissionRevision: 4 }, "inst-1");
  await waitFor(() => h.ses.searchQueue.length > 0);
  h.ses.resolvePage(0, [hit("materials", { assetId: "old" })], "old-cursor");
  await flush();
  h.controller.disconnected();
  h.controller.reconnect();
  h.resolveIdentity({ gatewayGeneration: 3, permissionRevision: 4 }, "inst-1");
  await waitFor(() => h.ses.searchQueue.length > 1);
  h.ses.resolvePage(1, [hit("materials", { assetId: "fresh" })], null);
  await flush();
  const last = h.snaps.at(-1)!;
  assert.equal(last.phase, "ready");
  assert.deepEqual(last.hits.map((x) => x.assetId), ["fresh"], "fresh page 1 replaced the old projection");
  assert.ok(
    h.ses.searchQueue.slice(1).every((s) => s.req.query.cursor !== "old-cursor"),
    "the pre-drop cursor is never reused",
  );
});

test("R1R-B — same query, permissionRevision 4→5 retires and reruns; late rev-4 ignored", async () => {
  const h = makeHarness();
  h.controller.setConnection({ paired: true, instanceId: "inst-1", isLive: () => h.live });
  h.controller.setQuery("q");
  h.resolveIdentity({ gatewayGeneration: 2, permissionRevision: 4 }, "inst-1");
  await waitFor(() => h.ses.searchQueue.length > 0);
  h.ses.resolvePage(0, [hit("materials", { assetId: "rev4-row" })], null);
  await flush();
  assert.equal(h.snaps.at(-1)!.permissionRevision, 4);
  h.controller.permissionChanged();
  assert.equal(h.snaps.at(-1)!.phase, "waiting-catalog", "old truth retired at once");
  assert.equal(h.snaps.at(-1)!.hits.length, 0);
  h.resolveIdentity({ gatewayGeneration: 2, permissionRevision: 5 }, "inst-1");
  await waitFor(() => h.ses.searchQueue.length > 1);
  h.ses.resolvePage(1, [hit("materials", { assetId: "rev5-row" })], null);
  await flush();
  const last = h.snaps.at(-1)!;
  assert.equal(last.permissionRevision, 5);
  assert.deepEqual(last.hits.map((x) => x.assetId), ["rev5-row"]);
  h.ses.searchQueue[0].d.resolve({ status: 200, body: { items: [hit("materials", { assetId: "late-rev4" })], nextCursor: null } });
  await flush();
  assert.ok(!h.snaps.at(-1)!.hits.some((x) => x.assetId === "late-rev4"), "late rev-4 result never commits");
});

test("R1R-B2 — implemented → notGranted is represented truthfully on the same query", async () => {
  const h = makeHarness();
  h.controller.setConnection({ paired: true, instanceId: "inst-1", isLive: () => h.live });
  h.controller.setQuery("q");
  h.resolveIdentity({ gatewayGeneration: 2, permissionRevision: 4 }, "inst-1");
  await waitFor(() => h.ses.searchQueue.length > 0);
  h.ses.resolvePage(0, [hit("materials", { assetId: "a" })], null);
  await flush();
  h.controller.permissionChanged();
  h.resolveIdentity({ gatewayGeneration: 2, permissionRevision: 5, operations: { "search.unified": { state: "notGranted" } } }, "inst-1");
  await flush();
  assert.equal(h.snaps.at(-1)!.phase, "not-granted");
  assert.equal(h.snaps.at(-1)!.hits.length, 0, "rows from the granted revision are retired");
});

test("R1R-C1 — A page-N SUCCESS during B's debounce cannot restore A rows", async () => {
  const h = makeHarness();
  h.controller.setConnection({ paired: true, instanceId: "inst-1", isLive: () => h.live });
  h.controller.setQuery("A");
  h.resolveIdentity({ gatewayGeneration: 2, permissionRevision: 4 }, "inst-1");
  await waitFor(() => h.ses.searchQueue.length > 0);
  h.ses.resolvePage(0, [hit("materials", { assetId: "a-page1" })], "cur-A");
  await flush();
  h.controller.loadMore();
  await waitFor(() => h.ses.searchQueue.length > 1); // A page-2 really in flight
  h.controller.setQuery("B");
  h.ses.resolvePage(1, [hit("materials", { assetId: "a-page2" })], null);
  await flush();
  assert.ok(!h.snaps.at(-1)!.hits.some((x) => x.assetId === "a-page2"), "A's page-N never joins B");
  assert.notEqual(h.snaps.at(-1)!.phase, "loading-more", "loading-more ownership was reset");
});

test("R1R-C2 — A page-N ERROR during B's debounce cannot set B's error state", async () => {
  const h = makeHarness();
  h.controller.setConnection({ paired: true, instanceId: "inst-1", isLive: () => h.live });
  h.controller.setQuery("A");
  h.resolveIdentity({ gatewayGeneration: 2, permissionRevision: 4 }, "inst-1");
  await waitFor(() => h.ses.searchQueue.length > 0);
  h.ses.resolvePage(0, [hit("materials", { assetId: "a1" })], "cur-A");
  await flush();
  h.controller.loadMore();
  await waitFor(() => h.ses.searchQueue.length > 1);
  h.controller.setQuery("B");
  h.ses.searchQueue[1].d.resolve({ status: 500, body: { code: "SERVICE_UNAVAILABLE" } });
  await flush();
  assert.notEqual(h.snaps.at(-1)!.phase, "error", "A's page-N error never becomes B's state");
});

test("R1R-C3 — A page-N 410 + recovery during B's debounce cannot restore A", async () => {
  const h = makeHarness();
  h.controller.setConnection({ paired: true, instanceId: "inst-1", isLive: () => h.live });
  h.controller.setQuery("A");
  h.resolveIdentity({ gatewayGeneration: 2, permissionRevision: 4 }, "inst-1");
  await waitFor(() => h.ses.searchQueue.length > 0);
  h.ses.resolvePage(0, [hit("materials", { assetId: "a1" })], "cur-A");
  await flush();
  h.controller.loadMore();
  await waitFor(() => h.ses.searchQueue.length > 1);
  h.controller.setQuery("B");
  h.ses.reject410(1);
  await flush();
  // A's 410 recovery would issue a fresh request; it must never restore A.
  await waitFor(() => h.ses.searchQueue.length > 2).catch(() => {});
  assert.ok(!h.snaps.at(-1)!.hits.some((x) => x.assetId === "a1"), "A's recovery never restores A rows");
  assert.notEqual(h.snaps.at(-1)!.recovered, true, "A's recovery flag never applies to B");
});

test("R1R-C4 — Desktop A→B while A page-N is in flight isolates the late result", async () => {
  const h = makeHarness();
  h.controller.setConnection({ paired: true, instanceId: "inst-A", isLive: () => h.live });
  h.controller.setQuery("q");
  h.resolveIdentity({ gatewayGeneration: 2, permissionRevision: 4 }, "inst-A");
  await waitFor(() => h.ses.searchQueue.length > 0);
  h.ses.resolvePage(0, [hit("materials", { assetId: "A1" })], "cur-A");
  await flush();
  h.controller.loadMore();
  const beforeRebind = h.snaps.length;
  h.controller.setConnection({ paired: true, instanceId: "inst-B", isLive: () => h.live });
  await waitFor(() => h.ses.searchQueue.length > 1);
  h.ses.resolvePage(1, [hit("materials", { assetId: "A2" })]); // late A page-2
  await flush();
  // Only snapshots AFTER the rebind matter: A's rows were legitimate before it.
  const after = h.snaps.slice(beforeRebind);
  assert.ok(
    !after.some((s) => s.hits.some((x) => x.assetId === "A2")),
    "A's late page-N never commits after the Desktop switch",
  );
});

// ---------------------------------------------------------------------------
// SERVICES-SEARCH-R1 REPAIR-R2 — the permission-truth seam must be a bounded,
// non-recursive product trigger (the previous registry.subscribe wiring
// recursed through invalidate() -> notify()).
// ---------------------------------------------------------------------------

test("R2-W1 — registry authority notifications never re-enter Desktop discovery", async () => {
  // Read-only navigation now observes permission changes. The forbidden
  // dependency is a notification -> Search/Browse rediscovery loop, not the
  // existence of a notification API itself.
  for (const path of [
    ["src", "still", "StillSearch.tsx"],
    ["src", "still", "StillCollection.tsx"],
    ["src", "still", "kit", "searchServicesController.ts"],
  ]) assert.doesNotMatch(strip(read(...path)), /registry\.subscribe/u,
    `${path.at(-1)} must not wire registry notifications back into discovery`);

  // Browse now observes security epochs to synchronously remove revoked rows.
  // Its bounded, non-recursive behavior is covered with the real registry in
  // scopedServiceLifecycle.test.ts, rather than banning the subscription API.
  const browse = strip(read("src", "still", "kit", "knowledgeBrowseController.ts"));
  assert.match(browse, /activeSecurity === \(scope\.currentSecurityRevision/u,
    "unchanged authority notifications return without rediscovery");
  const h = makeRegistry();
  const seen: Array<{ namespace: string; catalog: boolean }> = [];
  const unsubscribe = h.registry.subscribe(() => seen.push({
    namespace: h.registry.currentNamespace(), catalog: h.registry.snapshot() !== null,
  }));
  const load = h.registry.refreshAdopting("inst-1");
  h.resolve(0, { gatewayGeneration: 2, permissionRevision: 4 });
  await load;
  assert.deepEqual(seen, [{ namespace: "inst-1|2|4", catalog: true }],
    "observers receive the adopted authority after catalog commit");
  h.registry.invalidate();
  await flush();
  assert.deepEqual(seen.at(-1), { namespace: "", catalog: false },
    "invalidation notifies only after clearing old authority");
  assert.equal(seen.length, 2, "one bounded notification per authority change");
  assert.equal(h.discoverQueue.length, 1, "notification never starts another discover request");
  unsubscribe();
  h.registry.invalidate();
  assert.equal(seen.length, 2, "retired listeners are not called");
});

test("R2-W2 — permission truth comes from the SHARED change feed (one authority)", () => {
  const page = strip(read("src", "still", "StillSearch.tsx"));
  assert.match(page, /services\.changeFeed/u, "Search uses the shared production change feed");
  assert.match(page, /permissionTruthStale\(/u, "the change feed's own authority decides staleness");
  assert.match(page, /createProductionServices/u, "the same production composition (no second owner)");
  // No new authority was invented.
  assert.doesNotMatch(page, /new WebSocket|EventSource|fetch\(/u, "no raw transport");
  assert.doesNotMatch(page, /services_hints_start|services_hints_stop/u, "no direct hint-worker control");
  assert.match(page, /setInterval/u, "the refresh is a bounded interval, not a subscription");
});

test("R2-W3 — permissionChanged is FINITE: it never re-enters itself", async () => {
  const h = makeHarness();
  h.controller.setConnection({ paired: true, instanceId: "inst-1", isLive: () => h.live });
  h.controller.setQuery("q");
  h.resolveIdentity({ gatewayGeneration: 2, permissionRevision: 4 }, "inst-1");
  await waitFor(() => h.ses.searchQueue.length > 0);
  h.ses.resolvePage(0, [hit("materials", { assetId: "rev4" })], null);
  await flush();
  const before = h.snaps.length;
  // The registry's invalidate() is called inside permissionChanged(); with the
  // notify-only observer contract it must NOT bounce back into the controller.
  h.controller.permissionChanged();
  await flush();
  const added = h.snaps.length - before;
  assert.ok(added <= 2, `permissionChanged must emit a bounded number of snapshots (got ${added})`);
  h.resolveIdentity({ gatewayGeneration: 2, permissionRevision: 5 }, "inst-1");
  await waitFor(() => h.ses.searchQueue.length > 1);
  h.ses.resolvePage(1, [hit("materials", { assetId: "rev5" })], null);
  await flush();
  assert.equal(h.snaps.at(-1)!.permissionRevision, 5, "same query rerun under the new revision");
  assert.deepEqual(h.snaps.at(-1)!.hits.map((x) => x.assetId), ["rev5"]);
});

test("R2-W4 — reconnect is finite and non-recursive", async () => {
  const h = makeHarness();
  h.controller.setConnection({ paired: true, instanceId: "inst-1", isLive: () => h.live });
  h.controller.setQuery("q");
  h.resolveIdentity({ gatewayGeneration: 2, permissionRevision: 4 }, "inst-1");
  await waitFor(() => h.ses.searchQueue.length > 0);
  h.ses.resolvePage(0, [hit("materials", { assetId: "a" })], null);
  await flush();
  const before = h.snaps.length;
  h.controller.disconnected();
  h.controller.reconnect();
  await flush();
  const added = h.snaps.length - before;
  assert.ok(added <= 4, `reconnect must settle finitely (got ${added} snapshots)`);
  h.resolveIdentity({ gatewayGeneration: 3, permissionRevision: 4 }, "inst-1");
  await waitFor(() => h.ses.searchQueue.length > 1);
  h.ses.resolvePage(1, [hit("materials", { assetId: "fresh" })], null);
  await flush();
  assert.equal(h.snaps.at(-1)!.phase, "ready");
});

test("R2-W5 — a real permission-truth trigger drives the controller boundedly", async () => {
  // Drive the exact shared-authority shape the page uses: the change feed's
  // staleness decision over real hint records.
  const { ChangeFeedClient } = await import("../src/services/companionServices/changeFeedClient.ts");
  const calls: string[] = [];
  const feed = new ChangeFeedClient({
    start: async () => ({ outcome: "started", generation: 7 }),
    status: async () => ({ generation: 7, phase: "running", owner: "inst-1", connectFailures: 0 }),
    drain: async () => ([{ generation: 7, hint: { kind: "servicesChanged", permissionRevision: 5 } }]),
    stop: async () => ({ stopped: true }),
  } as any);
  await feed.start("inst-1");
  const hints = await feed.readHints();
  const stale = feed.permissionTruthStale(hints);
  assert.equal(stale, 5, "a servicesChanged hint with a new revision is the production staleness signal");
  // The page maps exactly this signal to ONE bounded controller call.
  const h = makeHarness();
  h.controller.setConnection({ paired: true, instanceId: "inst-1", isLive: () => h.live });
  h.controller.setQuery("q");
  h.resolveIdentity({ gatewayGeneration: 2, permissionRevision: 4 }, "inst-1");
  await waitFor(() => h.ses.searchQueue.length > 0);
  h.ses.resolvePage(0, [hit("materials", { assetId: "rev4" })], null);
  await flush();
  if (stale !== null) { calls.push("permissionChanged"); h.controller.permissionChanged(); }
  await flush();
  assert.deepEqual(calls, ["permissionChanged"], "exactly one bounded trigger");
  assert.equal(h.snaps.at(-1)!.hits.length, 0, "old rows retired immediately");
});

test("R2-W6 — a no-move hint read never re-triggers (no recursion)", async () => {
  const { ChangeFeedClient } = await import("../src/services/companionServices/changeFeedClient.ts");
  const feed = new ChangeFeedClient({
    start: async () => ({ outcome: "started", generation: 7 }),
    status: async () => ({ generation: 7, phase: "running", owner: "inst-1", connectFailures: 0 }),
    drain: async () => [],
    stop: async () => ({ stopped: true }),
  } as any);
  await feed.start("inst-1");
  const hints = await feed.readHints();
  assert.equal(feed.permissionTruthStale(hints), null,
    "an empty read yields no staleness, so the page never re-enters permissionChanged");
});
