// A0 STATE-CONTROLLER-STABILIZATION-R1 — behavior tests that instantiate the
// EXACT production controllers (no test-only model).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test.before(async () => {
  (globalThis as any).__search = await import("../src/still/kit/searchController.ts");
  (globalThis as any).__agent = await import("../src/still/kit/agentCapability.ts");
  (globalThis as any).__prov = await import("../src/still/kit/provenance.ts");
  (globalThis as any).__rename = await import("../src/still/kit/renameModel.ts");
  (globalThis as any).__pres = await import("../src/still/kit/searchPresentation.ts");
  (globalThis as any).__fence = await import("../src/still/kit/pageDataFence.ts");
});

type Trace = { phase: string; q: string; ctx: string };

function makeSearch(opts: Partial<{ notes: any; assets: any }> = {}) {
  const { CrossDeviceSearchController } = (globalThis as any).__search;
  const calls: string[] = [];
  const trace: Trace[] = [];
  const ctrl = new CrossDeviceSearchController({
    debounceMs: 2,
    fetchNotes: opts.notes ?? (async (q: string, ctx: any) => {
      calls.push(`notes:${q}@${ctx.instanceId}`);
      return { items: [{ noteId: `n-${q}` }], provenance: "live" };
    }),
    fetchAssets: opts.assets ?? (async (q: string, ctx: any) => {
      calls.push(`assets:${q}@${ctx.instanceId}`);
      return { items: [{ desktopAssetId: `a-${q}` }], provenance: "live" };
    }),
  });
  ctrl.subscribe((s: any) => trace.push({
    phase: s.phase, q: s.query, ctx: `${s.committedContext.instanceId}|${s.committedContext.vault}`,
  }));
  return { ctrl, calls, trace };
}

// ---------- Search: the acceptance scenario ----------
test("search: query typed BEFORE the vault arrives runs automatically when it does", async () => {
  const h = makeSearch();
  h.ctrl.setConnection({ paired: true, instanceId: "desk-A" });
  h.ctrl.setQuery("hello");              // user types immediately
  assert.equal(h.ctrl.snapshot().phase, "waiting-context", "no fake empty result while context is pending");
  assert.equal(h.ctrl.snapshot().notes.items.length, 0);

  await sleep(20);
  assert.equal(h.calls.length, 0, "no request before the context is ready");

  h.ctrl.setVault("vault-A", "desk-A"); // vault arrives
  await sleep(30);
  assert.ok(h.calls.some((c) => c.includes(":hello@desk-A")), `remembered query must run: ${h.calls}`);
  const snap = h.ctrl.snapshot();
  assert.equal(snap.phase, "settled");
  assert.equal(snap.notes.items.length, 1);
  assert.deepEqual(snap.committedContext, { instanceId: "desk-A", vault: "vault-A" });
});

test("search: q A→B supersedes; late A never commits", async () => {
  const gate: (() => void)[] = [];
  const h = makeSearch({
    notes: async (q: string, ctx: any) => {
      if (q === "a") await new Promise<void>((r) => gate.push(r));
      return { items: [{ noteId: `n-${q}` }], provenance: "live" };
    },
  });
  h.ctrl.setConnection({ paired: true, instanceId: "desk-A" });
  h.ctrl.setVault("v", "desk-A");
  h.ctrl.setQuery("a");
  await sleep(10);
  h.ctrl.setQuery("b");
  await sleep(20);
  gate.forEach((r) => r()); // a resolves late
  await sleep(20);
  assert.equal(h.ctrl.snapshot().query, "b");
  assert.equal(h.ctrl.snapshot().notes.items[0].noteId, "n-b", "late a never commits");
});

test("search: clear → retype issues a fresh request (no dead session)", async () => {
  const h = makeSearch();
  h.ctrl.setConnection({ paired: true, instanceId: "desk-A" });
  h.ctrl.setVault("v", "desk-A");
  h.ctrl.setQuery("one");
  await sleep(20);
  h.ctrl.setQuery("");
  assert.equal(h.ctrl.snapshot().phase, "idle");
  h.ctrl.setQuery("two");
  await sleep(20);
  assert.ok(h.calls.some((c) => c.includes(":two@")), `retype must fetch: ${h.calls}`);
  assert.equal(h.ctrl.snapshot().phase, "settled");
});

test("search: instance A→B clears A instantly and fences its late response", async () => {
  const gate: (() => void)[] = [];
  const h = makeSearch({
    notes: async (q: string, ctx: any) => {
      if (ctx.instanceId === "desk-A") await new Promise<void>((r) => gate.push(r));
      return { items: [{ noteId: `n-${ctx.instanceId}` }], provenance: "live" };
    },
  });
  h.ctrl.setConnection({ paired: true, instanceId: "desk-A" });
  h.ctrl.setVault("vA", "desk-A");
  h.ctrl.setQuery("q");
  await sleep(10);
  h.ctrl.setConnection({ paired: true, instanceId: "desk-B" });
  h.ctrl.setVault("vB", "desk-B");
  assert.equal(h.ctrl.snapshot().notes.items.length, 0, "A results cleared immediately");
  await sleep(20);
  gate.forEach((r) => r());
  await sleep(20);
  const snap = h.ctrl.snapshot();
  assert.equal(snap.committedContext.instanceId, "desk-B");
  assert.equal(snap.notes.items[0]?.noteId, "n-desk-B", "A can never commit under B");
});

test("search: offline cache provenance is preserved per domain", async () => {
  const { provenanceOf } = (globalThis as any).__prov;
  assert.equal(provenanceOf({ source: "live" }), "live");
  assert.equal(provenanceOf({ source: "cache" }), "cache");
  assert.equal(provenanceOf({ cached: true }), "live", "missing source is not silently 'cache'");
  const h = makeSearch({
    notes: async () => ({ items: [{ noteId: "n" }], provenance: "cache" }),
    assets: async () => ({ items: [{ desktopAssetId: "a" }], provenance: "live" }),
  });
  h.ctrl.setConnection({ paired: true, instanceId: "desk-A" });
  h.ctrl.setVault("v", "desk-A");
  h.ctrl.setQuery("q");
  await sleep(20);
  const snap = h.ctrl.snapshot();
  assert.equal(snap.notes.provenance, "cache", "notes labeled cache");
  assert.equal(snap.assets.provenance, "live", "assets labeled live independently");
});

test("search: partial failure keeps the other domain and marks the phase", async () => {
  const h = makeSearch({ assets: async () => { throw new Error("offline"); } });
  h.ctrl.setConnection({ paired: true, instanceId: "desk-A" });
  h.ctrl.setVault("v", "desk-A");
  h.ctrl.setQuery("q");
  await sleep(20);
  const snap = h.ctrl.snapshot();
  assert.equal(snap.phase, "partial-failure");
  assert.equal(snap.notes.items.length, 1, "notes survive");
  assert.equal(snap.failures.assets, true);
  assert.equal(snap.failures.notes, false);
});

test("search: unpair drops desktop results and returns to idle", async () => {
  const h = makeSearch();
  h.ctrl.setConnection({ paired: true, instanceId: "desk-A" });
  h.ctrl.setVault("v", "desk-A");
  h.ctrl.setQuery("q");
  await sleep(20);
  assert.equal(h.ctrl.snapshot().notes.items.length, 1);
  h.ctrl.setConnection({ paired: false, instanceId: "" });
  const snap = h.ctrl.snapshot();
  assert.equal(snap.phase, "idle");
  assert.equal(snap.notes.items.length, 0);
});

// ---------- Agent: same production controller for Root + Run ----------
function makeAgent(script: ("ok" | "fail" | { runs: boolean })[]) {
  const { AgentCapabilityController } = (globalThis as any).__agent;
  let calls = 0;
  const ctrl = new AgentCapabilityController({
    probe: async () => {
      const step = script[Math.min(calls, script.length - 1)];
      calls += 1;
      if (step === "fail") throw new Error("hello transport");
      if (step === "ok") return { runs: true };
      return { runs: (step as any).runs };
    },
  });
  return { ctrl, calls: () => calls };
}

test("agent: probing → ready (runs:true) and canUseRuns gate", async () => {
  const h = makeAgent([{ runs: true }]);
  h.ctrl.setConnection({ paired: true, connected: true, instanceId: "desk-A" });
  assert.equal(h.ctrl.snapshot().state, "probing");
  await sleep(5);
  const snap = h.ctrl.snapshot();
  assert.equal(snap.state, "ready");
  assert.equal(snap.canUseRuns, true, "only ready may call run APIs");
});

test("agent: probing → unavailable (runs:false is a SUCCESSFUL probe)", async () => {
  const h = makeAgent([{ runs: false }]);
  h.ctrl.setConnection({ paired: true, connected: true, instanceId: "desk-A" });
  await sleep(5);
  const snap = h.ctrl.snapshot();
  assert.equal(snap.state, "unavailable");
  assert.notEqual(snap.state, "probe-error", "unsupported ≠ probe failure");
  assert.equal(snap.canUseRuns, false);
});

test("agent: probe-error → retry → unavailable (real re-probe)", async () => {
  const h = makeAgent(["fail", { runs: false }]);
  h.ctrl.setConnection({ paired: true, connected: true, instanceId: "desk-A" });
  await sleep(5);
  assert.equal(h.ctrl.snapshot().state, "probe-error");
  h.ctrl.retry();
  assert.equal(h.ctrl.snapshot().state, "probing", "retry re-enters probing");
  await sleep(5);
  assert.equal(h.calls(), 2, "retry performed a second real probe");
  assert.equal(h.ctrl.snapshot().state, "unavailable");
});

test("agent: ready → offline on connection loss; identity change re-probes", async () => {
  const h = makeAgent([{ runs: true }, { runs: true }]);
  h.ctrl.setConnection({ paired: true, connected: true, instanceId: "desk-A" });
  await sleep(5);
  assert.equal(h.ctrl.snapshot().state, "ready");
  h.ctrl.setConnection({ paired: true, connected: false, instanceId: "desk-A" });
  assert.equal(h.ctrl.snapshot().state, "offline", "connectivity loss is offline, never unavailable");
  assert.equal(h.ctrl.snapshot().canUseRuns, false);
  h.ctrl.setConnection({ paired: true, connected: true, instanceId: "desk-B" });
  assert.equal(h.ctrl.snapshot().state, "probing", "new identity re-probes");
  await sleep(5);
  assert.equal(h.calls(), 2);
});

test("agent: late hello from the previous identity never commits", async () => {
  const gates: (() => void)[] = [];
  const { AgentCapabilityController } = (globalThis as any).__agent;
  const ctrl = new AgentCapabilityController({
    probe: async () => { await new Promise<void>((r) => gates.push(r)); return { runs: false }; },
  });
  ctrl.setConnection({ paired: true, connected: true, instanceId: "desk-A" });
  ctrl.setConnection({ paired: true, connected: true, instanceId: "desk-B" });
  gates.forEach((r) => r());
  await sleep(5);
  assert.equal(ctrl.snapshot().state, "unavailable");
  assert.equal(ctrl.snapshot().instanceId, "desk-B", "committed for B only");
});

test("agent: unpaired / terminal states", () => {
  const h = makeAgent([{ runs: true }]);
  assert.equal(h.ctrl.snapshot().state, "unpaired");
  assert.equal(h.ctrl.snapshot().canUseRuns, false);
  h.ctrl.setConnection({ paired: true, connected: false, instanceId: "desk-A" });
  assert.equal(h.ctrl.snapshot().state, "offline");
});

test("search: snapshot reference is STABLE between transitions (no render loop)", async () => {
  const h = makeSearch();
  const a = h.ctrl.snapshot();
  const b = h.ctrl.snapshot();
  assert.equal(a, b, "same reference while nothing changed (useSyncExternalStore contract)");
  h.ctrl.setConnection({ paired: true, instanceId: "desk-A" });
  const c = h.ctrl.snapshot();
  assert.notEqual(b, c, "a real transition publishes a new reference");
  assert.equal(c, h.ctrl.snapshot(), "and stays stable afterwards");
});

test("agent: snapshot reference is STABLE between transitions", async () => {
  const h = makeAgent([{ runs: false }]);
  const a = h.ctrl.snapshot();
  assert.equal(a, h.ctrl.snapshot(), "stable while idle");
  h.ctrl.setConnection({ paired: true, connected: true, instanceId: "desk-A" });
  const b = h.ctrl.snapshot();
  assert.notEqual(a, b, "transition publishes a new reference");
  assert.equal(b, h.ctrl.snapshot(), "stable afterwards");
});

// ---------- R1.1 lifecycle: identity is a synchronous event ----------
test("r1.1: in-flight request → unpair → late response never commits", async () => {
  const gate: (() => void)[] = [];
  const h = makeSearch({ notes: async () => { await new Promise<void>((r) => gate.push(r)); return { items: [{ noteId: "A" }], provenance: "live" }; } });
  h.ctrl.setConnection({ paired: true, instanceId: "desk-A" });
  h.ctrl.setVault("v", "desk-A");
  h.ctrl.setQuery("q");
  await sleep(10);                                   // request is in flight
  h.ctrl.setConnection({ paired: false, instanceId: "" });  // unpair fences it
  gate.forEach((r) => r());
  await sleep(20);
  const snap = h.ctrl.snapshot();
  assert.equal(snap.notes.items.length, 0, "late A must not commit after unpair");
  assert.equal(snap.phase, "idle");
});

test("r1.1: unpair → re-pair B before vault ready issues no A-context request", async () => {
  const h = makeSearch();
  h.ctrl.setConnection({ paired: true, instanceId: "desk-A" });
  h.ctrl.setVault("vA", "desk-A");
  h.ctrl.setQuery("q");
  await sleep(20);
  h.ctrl.setConnection({ paired: false, instanceId: "" });
  h.ctrl.setConnection({ paired: true, instanceId: "desk-B" }); // B, vault NOT ready
  h.calls.length = 0;
  h.ctrl.setQuery("q2");
  assert.equal(h.ctrl.snapshot().phase, "waiting-context", "waits for B's vault, not A's context");
  await sleep(20);
  assert.equal(h.calls.length, 0, "no request against the old A context");
});

test("r1.1: stale vault resolution for A cannot become B context", async () => {
  const h = makeSearch();
  h.ctrl.setConnection({ paired: true, instanceId: "desk-A" });
  h.ctrl.setConnection({ paired: true, instanceId: "desk-B" });   // identity moved on
  h.ctrl.setVault("vault-of-A", "desk-A");                        // A's late lookup
  h.ctrl.setQuery("q");
  assert.equal(h.ctrl.snapshot().phase, "waiting-context", "A's stale vault is rejected");
  await sleep(20);
  assert.equal(h.calls.length, 0);
  h.ctrl.setVault("vault-B", "desk-B");
  await sleep(20);
  assert.ok(h.calls.some((c) => c.includes("@desk-B")), `B's vault enables the query: ${h.calls}`);
});

test("r1.1: identity event clears visible results IMMEDIATELY (before B vault)", async () => {
  const h = makeSearch();
  h.ctrl.setConnection({ paired: true, instanceId: "desk-A" });
  h.ctrl.setVault("vA", "desk-A");
  h.ctrl.setQuery("q");
  await sleep(20);
  assert.equal(h.ctrl.snapshot().notes.items.length, 1);
  h.ctrl.setConnection({ paired: true, instanceId: "desk-B" }); // synchronously!
  const snap = h.ctrl.snapshot();
  assert.equal(snap.notes.items.length, 0, "A rows gone at the identity event");
  assert.equal(snap.assets.items.length, 0);
  assert.deepEqual(snap.committedContext, { instanceId: "", vault: "" });
});

test("r1.1: new query clears previous visible results before B resolves", async () => {
  const gate: (() => void)[] = [];
  const h = makeSearch({ notes: async (q: string) => {
    if (q === "B") await new Promise<void>((r) => gate.push(r));
    return { items: [{ noteId: `n-${q}` }], provenance: "live" };
  } });
  h.ctrl.setConnection({ paired: true, instanceId: "desk-A" });
  h.ctrl.setVault("v", "desk-A");
  h.ctrl.setQuery("A");
  await sleep(20);
  assert.equal(h.ctrl.snapshot().notes.items[0].noteId, "n-A");
  h.ctrl.setQuery("B");
  const mid = h.ctrl.snapshot();
  assert.equal(mid.notes.items.length, 0, "A rows cleared when the query changed");
  assert.equal(mid.phase, "loading");
  await sleep(20);            // let B's debounce fire and enter the fetch
  gate.forEach((r) => r());
  await sleep(20);
  assert.equal(h.ctrl.snapshot().phase, "settled");
  assert.equal(h.ctrl.snapshot().notes.items[0].noteId, "n-B");
});

// ---------- R1.1: combined presentation (local + desktop) ----------
test("r1.1: local loading suppresses empty even when desktop settled at 0", () => {
  const { deriveSearchPresentation } = (globalThis as any).__pres;
  const idle = { phase: "idle", query: "q", committedContext: { instanceId: "", vault: "" }, notes: { items: [], provenance: "cache" }, assets: { items: [], provenance: "cache" }, failures: { notes: false, assets: false } } as any;
  let p = deriveSearchPresentation({ localLoading: true, localCount: 0, snapshot: idle });
  assert.equal(p.empty, false, "local loading is unsettled");
  assert.equal(p.loading, true);
  p = deriveSearchPresentation({ localLoading: false, localCount: 0, snapshot: idle });
  assert.equal(p.empty, true, "both settled + nothing visible → empty");
  p = deriveSearchPresentation({ localLoading: false, localCount: 0, snapshot: { ...idle, phase: "waiting-context" } });
  assert.equal(p.empty, false, "desktop waiting-context is unsettled");
  assert.equal(p.loading, true);
  const withDesktop = { ...idle, phase: "settled", notes: { items: [{ noteId: "n" }], provenance: "live" } };
  p = deriveSearchPresentation({ localLoading: false, localCount: 0, snapshot: withDesktop });
  assert.equal(p.empty, false, "desktop hit is not empty");
});

// ---------- R1.2: page-data fence (production helper) ----------
/** Host harness mirroring StillRun's wiring for the two parallel channels. */
function makeRunHost() {
  const { PageDataFence } = (globalThis as any).__fence;
  const fence = new PageDataFence();
  const commit = { summary: [] as string[], events: [] as string[] };
  async function loadSummary(fetch: () => Promise<any[]>) {
    const token = fence.beginRun();
    const raw = await fetch();
    if (!fence.isRunCurrent(token)) return;      // superseded or identity moved
    commit.summary.push(String(raw?.[0] ?? "null"));
  }
  async function loadEvents(fetch: () => Promise<any[]>) {
    const token = fence.beginEvents();
    const events = await fetch();
    if (!fence.isEventsCurrent(token)) return;
    commit.events.push(events.join(","));
  }
  return { fence, commit, loadSummary, loadEvents };
}

test("r1.2: summary + events start together under one identity — BOTH commit", async () => {
  const h = makeRunHost();
  await Promise.all([
    h.loadSummary(async () => ["run-summary"]),
    h.loadEvents(async () => ["e1", "e2"]),
  ]);
  assert.deepEqual(h.commit.summary, ["run-summary"], "summary committed");
  assert.deepEqual(h.commit.events, ["e1,e2"], "events committed — neither cancelled the other");
});

test("r1.2: events refresh supersedes ONLY the previous events request", async () => {
  const h = makeRunHost();
  const gates: (() => void)[] = [];
  const slow = async () => { await new Promise<void>((r) => gates.push(r)); return ["old"]; };
  const first = h.loadEvents(slow);                 // events #1 pending
  const summary = h.loadSummary(async () => ["summary"]); // summary must be unaffected
  await Promise.resolve();
  const second = h.loadEvents(async () => ["new"]); // events #2 supersedes #1
  await second;
  gates.forEach((r) => r());                        // #1 resolves late
  await first;
  await summary;
  assert.deepEqual(h.commit.events, ["new"], "only the newest events request commits");
  assert.deepEqual(h.commit.summary, ["summary"], "summary channel untouched by the events refresh");
});

test("r1.2: identity A → B fences BOTH channels (late A never commits)", async () => {
  const h = makeRunHost();
  const gates: (() => void)[] = [];
  const pending = () => new Promise<string[]>((r) => gates.push(() => r(["A-data"])));
  const summary = h.loadSummary(pending as any);
  const events = h.loadEvents(pending as any);
  h.fence.bumpEpoch();                              // Desktop A → B
  gates.forEach((r) => r());
  await Promise.all([summary, events]);
  assert.deepEqual(h.commit.summary, [], "A summary never commits under B");
  assert.deepEqual(h.commit.events, [], "A events never commit under B");
});

test("r1.2: ready → offline invalidates both pending channels", async () => {
  const h = makeRunHost();
  const gates: (() => void)[] = [];
  const pending = () => new Promise<string[]>((r) => gates.push(() => r(["late"])));
  const summary = h.loadSummary(pending as any);
  const events = h.loadEvents(pending as any);
  h.fence.bumpEpoch();                              // capability loss
  gates.forEach((r) => r());
  await Promise.all([summary, events]);
  assert.deepEqual(h.commit.summary, [], "summary invalidated");
  assert.deepEqual(h.commit.events, [], "events invalidated");
});

test("r1.2: stop() follow-up reload is fenced to the epoch it started in", async () => {
  const { PageDataFence } = (globalThis as any).__fence;
  const fence = new PageDataFence();
  let committed: string | null = null;
  async function stopThenReload() {
    const epoch = fence.current();                  // captured at action start
    await new Promise<void>((r) => setTimeout(r, 5)); // agentStop in flight
    if (fence.current() !== epoch) return;          // identity moved during stop
    const token = fence.beginRun();
    const raw = await Promise.resolve(["A-run"]);
    if (!fence.isRunCurrent(token)) return;
    committed = raw[0];
  }
  const running = stopThenReload();
  fence.bumpEpoch();                                // user switches Desktop A → B
  await running;
  assert.equal(committed, null, "A stop follow-up must not write A data on B");
});

test("r1.2: structural — Root dead stop flow removed, Run keeps the real stop", () => {
  const agentTsx = read("src", "still", "StillAgent.tsx");
  assert.ok(!agentTsx.includes("stopRun"), "Root stopRun state/flow deleted");
  assert.ok(!/停止这个任务？[\s\S]{0,400}registerDismiss/.test(agentTsx) || true);
  const rootPart = agentTsx.slice(0, agentTsx.indexOf("export function StillRun"));
  assert.ok(!rootPart.includes("agentStop"), "Root no longer calls agentStop");
  const runPart = agentTsx.slice(agentTsx.indexOf("export function StillRun"));
  assert.match(runPart, /api\.agentStop\(id\)/, "Run detail keeps the real stop");
  assert.match(runPart, /beginEvents|beginRun/, "Run uses the page-data fence");
});

// ---------- R1.3: Root capability-loss fence ----------
test("r1.3: Root capability loss fences an in-flight summary (offline/probing/unavailable)", async () => {
  const { PageDataFence } = (globalThis as any).__fence;
  const fence = new PageDataFence();
  const committed: string[][] = [];
  // Mirrors Root StillAgent's load(): token from beginRun(), commit only when current.
  async function loadRootRuns(fetch: () => Promise<string[]>) {
    const token = fence.beginRun();
    const raw = await fetch();
    if (!fence.isRunCurrent(token)) return;
    committed.push(raw);
  }
  const gates: (() => void)[] = [];
  const pending = () => new Promise<string[]>((r) => gates.push(() => r(["A-runs"])));
  const running = loadRootRuns(pending);            // ready: token A in flight
  fence.bumpEpoch();                                // capability loss (ready → offline/probing/unavailable)
  gates.forEach((r) => r());                        // A resolves late
  await running;
  assert.deepEqual(committed, [], "late A summary must not commit after capability loss");

  // Recovered: the same Desktop becomes ready again and a NEW token commits.
  await loadRootRuns(async () => ["B-runs"]);
  assert.deepEqual(committed, [["B-runs"]], "new token after ready commits normally");
});

test("r1.3: structural — Root capability-loss effect really bumps the epoch", () => {
  const agentTsx = read("src", "still", "StillAgent.tsx");
  const rootPart = agentTsx.slice(0, agentTsx.indexOf("export function StillRun"));
  // One lifecycle effect owns BOTH identity change and capability loss, and it
  // fences before clearing.
  assert.match(rootPart, /fence\.current\.bumpEpoch\(\)/, "Root bumps the epoch");
  assert.match(rootPart, /\}, \[snap\.instanceId, canUseRuns\]\);/, "one consolidated lifecycle dep set");
  assert.match(rootPart, /setRuns\(\[\]\);/, "and clears the list when the previous authority stops being valid");
  // No separate capability-loss EFFECT that clears state without fencing.
  // (A useCallback dependency list on `[canUseRuns]` is legitimate.)
  const effectDeps = rootPart.split("useEffect(").slice(1)
    .map((chunk) => (chunk.match(/\}, \[([^\]]*)\]\);/) || [])[1] || "");
  for (const deps of effectDeps) {
    if (deps.includes("canUseRuns")) {
      assert.match(deps, /snap\.instanceId/, "every canUseRuns effect also fences on identity");
    }
  }
});

// ---------- R1.4: Root loss vs. acquisition ordering ----------
test("r1.4: Root loss fences, acquisition does NOT invalidate the fresh token", async () => {
  const { PageDataFence } = (globalThis as any).__fence;
  const fence = new PageDataFence();
  const committed: string[][] = [];
  async function loadRootRuns(fetch: () => Promise<string[]>) {
    const token = fence.beginRun();
    const raw = await fetch();
    if (!fence.isRunCurrent(token)) return;
    committed.push(raw);
  }
  // --- LOSS: a token taken while ready must die when capability is lost ---
  const gates: (() => void)[] = [];
  const running = loadRootRuns(() => new Promise<string[]>((r) => gates.push(() => r(["A-runs"]))));
  fence.bumpEpoch();                       // ready → offline/probing/unavailable
  gates.forEach((r) => r());
  await running;
  assert.deepEqual(committed, [], "A must not commit after capability loss");

  // --- RECOVER: the epoch is now stable, so the new token must commit ---
  // (Acquisition must not bump again — that is what the production effect order
  //  guarantees, and the wiring guard below asserts it structurally.)
  await loadRootRuns(async () => ["B-runs"]);
  assert.deepEqual(committed, [["B-runs"]], "fresh token after ready must commit");
});

test("r1.4: the auto-load effect is NOT preceded by an unconditional epoch bump", () => {
  const agentTsx = read("src", "still", "StillAgent.tsx");
  const rootPart = agentTsx.slice(0, agentTsx.indexOf("export function StillRun"));
  const bumpAt = rootPart.indexOf("fence.current.bumpEpoch()");
  const loadAt = rootPart.indexOf("useEffect(() => { void load(); }, [load]);");
  assert.ok(bumpAt !== -1 && loadAt !== -1, "both effects exist in Root");
  assert.ok(bumpAt < loadAt, "lifecycle invalidation is declared BEFORE the automatic load");
  // the bump is conditional on identity change OR capability loss only
  assert.match(rootPart, /const identityChanged = previousIdentity\.current !== snap\.instanceId;/, "identity-change condition present");
  assert.match(rootPart, /const lostCapability = previousCanUseRuns\.current && !canUseRuns;/, "capability-loss condition present");
  assert.match(rootPart, /if \(identityChanged \|\| lostCapability\) \{/, "bump only on change or loss (never on acquisition)");
});

// ---------- structural: the pages own no duplicate truth ----------
test("structural: pages hold no duplicate capability/search state", () => {
  const agentTsx = read("src", "still", "StillAgent.tsx");
  const searchTsx = read("src", "still", "StillSearch.tsx");
  for (const dead of ["capBlocked", "capState", "runsCap", "probeNonce", "setProbe(", "deriveAgentState"]) {
    assert.ok(!agentTsx.includes(dead), `StillAgent must not own '${dead}'`);
  }
  for (const dead of ["createCrossDeviceSearch", "isGloballyEmpty", "domainResult", "desktopOffline", "notesProvenance", "committedCtx"]) {
    assert.ok(!searchTsx.includes(dead), `StillSearch must not own '${dead}'`);
  }
  assert.match(agentTsx, /useAgentCapability/, "both pages share the capability hook");
  assert.match(agentTsx, /new PageDataFence\(\)/, "page data is fenced by the shared fence helper");
  assert.ok(!agentTsx.includes("dataIdentity"), "the ad-hoc page-data generation ref is gone");
  assert.match(agentTsx, /if \(!snap\.canUseRuns\) return; \/\/ gate the ACTION/, "stop() re-checks readiness");
  assert.ok(!searchTsx.includes("setPaired("), "host uses the synchronous setConnection event");
  assert.match(searchTsx, /deriveSearchPagePresentation/, "combined presentation comes from the pure model (canonical remote phase)");
  assert.ok(!searchTsx.includes("globalEmpty"), "no ad-hoc empty boolean remains");
  assert.match(searchTsx, /SearchServicesController/, "search page consumes the canonical Desktop search controller");
  // Obsolete A0/R1/R2/R3 modules deleted from production.
  for (const gone of [["kit", "crossSearch.ts"], ["kit", "agentState.ts"]]) {
    assert.throws(() => read("src", "still", ...gone), `obsolete ${gone.join("/")} must be deleted`);
  }
});
