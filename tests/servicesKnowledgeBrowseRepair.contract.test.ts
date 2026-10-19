// SERVICES-KNOWLEDGE-BROWSE-R1 REPAIR-R1 — the five repair groups:
//   1. paged search keeps the SAME q (q + afterId + limit);
//   2. same-Desktop online→offline hard-retires the old rows;
//   3. per-operation capability truth (vaults AND registeredList),
//      readGranted=false never lists, canonical ServicesError classification;
//   4. the REAL phase lands in the product UI (status component inside the
//      view; QA drives the real component, no copy appended behind it);
//   5. the desktop 新建 affordance is genuinely disabled and the inert sort
//      affordance is hidden (local filter/new unchanged).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  KnowledgeBrowseController, type KnowledgeBrowseBinding,
} from "../src/still/kit/knowledgeBrowseController.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const strip = (src: string) => src.replace(/^\s*\/\/.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, "");
const COLL = () => strip(read("src", "still", "StillCollection.tsx"));
const VIEWS = () => strip(read("src", "presentation", "still01", "Views.tsx"));
const CTRL = () => strip(read("src", "still", "kit", "knowledgeBrowseController.ts"));
const CSS = () => read("src", "presentation", "still01", "still.css");
const QA_ENTRY = () => strip(read("scripts", "qa", "servicesKnowledgeBrowse.entry.tsx"));

const tick = () => new Promise((r) => setImmediate(r));
const settledQ = () => new Promise((r) => setTimeout(r, 400));

function makeDeps(catalogStates: Record<string, string> = { "knowledge.vaults": "implemented", "knowledge.registeredList": "implemented" }) {
  const ctl: {
    vaults: Array<{ vaultId: string; displayName: string; activeInDesktop: boolean; readGranted: boolean }>;
    calls: Array<Record<string, any>>;
    listByVault: Record<string, any>;
    failVaultsWith?: Error;
  } = { vaults: [], calls: [], listByVault: {} };
  const deps = {
    registry: {
      refreshAdopting: async () => ({
        permissionRevision: 2,
        operations: Object.fromEntries(Object.entries(catalogStates).map(([k, v]) => [k, { state: v }])),
      }),
      snapshot: () => ({ operations: Object.fromEntries(Object.entries(catalogStates).map(([k, v]) => [k, { state: v }])) }),
      // R2-3: the controller asks the registry per operation; an entry absent
      // from the mock resolves to unsupported, exactly like the real one.
      operation(opId: string) {
        return { operationId: opId, state: (catalogStates as any)[opId] ?? "unsupported" };
      },
      invalidateCount: 0,
      invalidate() { (this as any).invalidateCount = ((this as any).invalidateCount ?? 0) + 1; },
    },
    knowledge: {
      vaults: async () => {
        if (ctl.failVaultsWith) throw ctl.failVaultsWith;
        return { items: ctl.vaults };
      },
      registeredList: async (_i: string, vaultId: string, o: any) => {
        ctl.calls.push({ ...o });
        return ctl.listByVault[vaultId] ?? { items: [], hasMore: false, nextAfterId: null };
      },
    },
  } as any;
  return { deps, ctl };
}

function binding(over: Partial<KnowledgeBrowseBinding> = {}): KnowledgeBrowseBinding {
  return { paired: true, connected: true, instanceId: "A", isLive: () => true, ...over };
}

const settled = () => Promise.all([tick(), tick(), tick()]);

const VAULT = [{ vaultId: "v", displayName: "V", activeInDesktop: true, readGranted: true }];

// ---------------------------------------------------------------------------
// 1. paged search keeps the SAME q
// ---------------------------------------------------------------------------

test("R1-1 — search page1 AND page2 both carry q; page2 only appends rust results", async () => {
  const { deps, ctl } = makeDeps();
  ctl.vaults = VAULT;
  // A bare-afterId request (missing q) would land in the WHOLE-vault bucket —
  // which must never happen. rust page-1 is the keyed page; any later rust
  // call is its page-2; the whole-vault bucket is what a lost q would return.
  let rustCalls = 0;
  deps.knowledge.registeredList = async (_i: string, vaultId: string, o: any) => {
    ctl.calls.push({ ...o });
    if (!o?.q) {
      // The whole-vault bucket: what the server returns without a q filter.
      return { items: [{ noteId: "WHOLE-VAULT-LEAK" }], hasMore: false, nextAfterId: null };
    }
    rustCalls += 1;
    if (rustCalls === 1) return { items: [{ noteId: "rust-1" }], hasMore: true, nextAfterId: "rust-1" };
    return { items: [{ noteId: "rust-2" }], hasMore: false, nextAfterId: null };
  };
  const ctrl = new KnowledgeBrowseController(deps);
  ctrl.setConnection(binding());
  await settledQ();          // unfiltered page-1 (q: undefined) — ignored
  assert.equal(ctl.calls[0]?.q, undefined, "the unfiltered browse sends no q");

  ctrl.setQuery("rust");     // the search whose pages must BOTH carry q
  await settledQ();
  assert.deepEqual(ctrl.snapshot().rows.map((r) => r.noteId), ["rust-1"]);

  ctrl.loadMore();
  await settled();
  const snap = ctrl.snapshot();
  assert.deepEqual(snap.rows.map((r) => r.noteId), ["rust-1", "rust-2"],
    "page-2 appends ONLY more rust results");
  // calls: [0] = the unfiltered initial browse, [1] = search page-1,
  // [2] = search page-2 — both search pages must carry the SAME q.
  assert.equal(ctl.calls[0].q, undefined, "the initial browse is unfiltered");
  assert.equal(ctl.calls[1].q, "rust", "search page-1 carries q");
  assert.equal(ctl.calls[2].q, "rust", "search page-2 carries the SAME q");
  assert.equal(ctl.calls[2].afterId, "rust-1", "and the canonical afterId");
  assert.ok(!ctl.calls.some((c) => c.noteId === "WHOLE-VAULT-LEAK"));
  assert.ok(!snap.rows.some((r) => r.noteId === "WHOLE-VAULT-LEAK"),
    "a lost q would have mixed whole-vault rows into the search");
});

// ---------------------------------------------------------------------------
// 2. online A -> offline A hard-retires
// ---------------------------------------------------------------------------

test("R1-2 — online A → offline A bumps the epoch, clears rows, lands offline", async () => {
  const { deps, ctl } = makeDeps();
  ctl.vaults = VAULT;
  ctl.listByVault.v = { items: [{ noteId: "live" }], hasMore: true, nextAfterId: "live" };
  const ctrl = new KnowledgeBrowseController(deps);
  ctrl.setConnection(binding());
  await settled();
  assert.deepEqual(ctrl.snapshot().rows.map((r) => r.noteId), ["live"]);

  // Late page-2 in flight while the ws drops.
  let rejectP2: ((e: unknown) => void) | null = null;
  deps.knowledge.registeredList = (_i: string, _v: string, o: any) => {
    if (o?.afterId) return new Promise((_res, rej) => { rejectP2 = rej; });
    return Promise.resolve(ctl.listByVault.v);
  };
  ctrl.loadMore();
  ctrl.setConnection(binding({ connected: false }));
  await settled();
  const snap = ctrl.snapshot();
  assert.equal(snap.phase, "offline", "truthful offline");
  assert.equal(snap.rows.length, 0, "the old rows are CLEARED, not kept");
  assert.equal(snap.vaultId, "", "the vault token is dropped too");

  // The late page-2 can neither restore rows nor error the offline state.
  rejectP2!(new Error("late"));
  await tick(); await tick();
  assert.equal(ctrl.snapshot().phase, "offline");
  assert.equal(ctrl.snapshot().rows.length, 0, "late success cannot recover old rows");

  // Reconnect gives a fresh discover/list.
  ctl.calls.length = 0;
  ctl.listByVault.v = { items: [{ noteId: "fresh" }], hasMore: false, nextAfterId: null };
  deps.knowledge.registeredList = async (_i: string, vaultId: string) => {
    ctl.calls.push({ vaultId });
    return ctl.listByVault[vaultId];
  };
  ctrl.setConnection(binding()); // back online
  await settled();
  assert.deepEqual(ctrl.snapshot().rows.map((r) => r.noteId), ["fresh"], "reconnect lists fresh");
});

// ---------------------------------------------------------------------------
// 3. per-operation capability + readGranted + canonical error codes
// ---------------------------------------------------------------------------

test("R1-3a — vaults notGranted / unsupported are truthful per operation", async () => {
  for (const [state, want] of [["notGranted", "not-granted"], ["unsupported", "unsupported"]] as const) {
    const { deps, ctl } = makeDeps({ "knowledge.vaults": state, "knowledge.registeredList": "implemented" });
    ctl.vaults = VAULT;
    const ctrl = new KnowledgeBrowseController(deps);
    ctrl.setConnection(binding());
    await settled();
    assert.equal(ctrl.snapshot().phase, want, `vaults ${state} -> ${want}`);
    assert.equal(ctl.calls.length, 0, "registeredList is never called");
  }
});

test("R1-3b — registeredList notGranted / unsupported are truthful per operation", async () => {
  for (const [state, want] of [["notGranted", "not-granted"], ["unsupported", "unsupported"]] as const) {
    const { deps, ctl } = makeDeps({ "knowledge.vaults": "implemented", "knowledge.registeredList": state });
    ctl.vaults = VAULT;
    const ctrl = new KnowledgeBrowseController(deps);
    ctrl.setConnection(binding());
    await settled();
    assert.equal(ctrl.snapshot().phase, want, `registeredList ${state} -> ${want}`);
    assert.equal(ctl.calls.length, 0);
  }
});

test("R1-3c — active vault with readGranted=false NEVER calls registeredList", async () => {
  const { deps, ctl } = makeDeps();
  ctl.vaults = [{ vaultId: "v", displayName: "V", activeInDesktop: true, readGranted: false }];
  const ctrl = new KnowledgeBrowseController(deps);
  ctrl.setConnection(binding());
  await settled();
  const snap = ctrl.snapshot();
  assert.equal(snap.phase, "not-granted", "the real permission state");
  assert.equal(snap.remoteCode, "GRANT_REQUIRED");
  assert.equal(ctl.calls.length, 0, "registeredList was NOT called");
  assert.equal(snap.vaultId, "v", "the vault is shown as context");
  assert.equal(snap.rows.length, 0, "no actionable rows");
  // And the Desktop's active vault was not switched (no write op exists here at all).
});

test("R1-3d — pageN GRANT_REQUIRED clears stale actionable rows", async () => {
  const { deps, ctl } = makeDeps();
  ctl.vaults = VAULT;
  ctl.listByVault.v = { items: [{ noteId: "n1" }], hasMore: true, nextAfterId: "n1" };
  const ctrl = new KnowledgeBrowseController(deps);
  ctrl.setConnection(binding());
  await settled();
  assert.deepEqual(ctrl.snapshot().rows.map((r) => r.noteId), ["n1"]);

  // The grant is revoked mid-pagination: page-2 answers GRANT_REQUIRED.
  const { ServicesError } = await import("../src/services/companionServices/transport.ts");
  deps.knowledge.registeredList = async (_i: string, _v: string, o: any) => {
    if (o?.afterId) throw new ServicesError("GRANT_REQUIRED", 403);
    return ctl.listByVault.v;
  };
  ctrl.loadMore();
  await settled();
  const snap = ctrl.snapshot();
  assert.equal(snap.phase, "not-granted", "a permission fact, not a generic error");
  assert.equal(snap.remoteCode, "GRANT_REQUIRED");
  assert.equal(snap.rows.length, 0, "the stale actionable rows are CLEARED");
  assert.ok((deps.registry.invalidateCount ?? 0) >= 1, "capability truth is refreshed");
});

test("R1-3e — SERVICE_UNAVAILABLE is its own truthful phase", async () => {
  const { deps, ctl } = makeDeps();
  ctl.vaults = VAULT;
  ctl.listByVault.v = { items: [{ noteId: "n1" }], hasMore: false, nextAfterId: null };
  const { ServicesError } = await import("../src/services/companionServices/transport.ts");
  deps.knowledge.registeredList = async () => { throw new ServicesError("SERVICE_UNAVAILABLE", 503); };
  const ctrl = new KnowledgeBrowseController(deps);
  ctrl.setConnection(binding());
  await settled();
  assert.equal(ctrl.snapshot().phase, "temporarily-unavailable");
  assert.equal(ctrl.snapshot().remoteCode, "SERVICE_UNAVAILABLE");

  // VERSION_UNSUPPORTED maps to unsupported.
  const v = makeDeps();
  v.ctl.vaults = VAULT;
  v.deps.knowledge.registeredList = async () => { throw new ServicesError("VERSION_UNSUPPORTED", 400); };
  const ctrlV = new KnowledgeBrowseController(v.deps);
  ctrlV.setConnection(binding());
  await settled();
  assert.equal(ctrlV.snapshot().phase, "unsupported");
});

// ---------------------------------------------------------------------------
// 4. the REAL phase reaches the product UI
// ---------------------------------------------------------------------------

test("R1-4 — the real status component renders every canonical phase", () => {
  const coll = COLL();
  // R1-REPAIR: the component lives in its OWN module (imported by the page),
  // which is also what the QA renders — one real implementation.
  const status = strip(read("src", "still", "kit", "desktopKnowledgeStatus.tsx"));
  assert.match(status, /export function DesktopKnowledgeStatus\(/u, "the production status component exists");
  for (const phase of ["waiting-catalog", "discovering-vault", "loading", "loading-more", "offline",
    "not-granted", "temporarily-unavailable", "unsupported", "error", "ready"]) {
    assert.ok(status.includes(`case "${phase}"`) || phase === "ready",
      `the status component maps ${phase}`);
  }
  assert.match(coll, /import \{ DesktopKnowledgeStatus \} from "\.\/kit\/desktopKnowledgeStatus";/u,
    "the page imports the real component");
  // Ready-empty copy is real (never the local composition).
  assert.match(status, /电脑知识库没有匹配的笔记/u);
  // It renders INSIDE the view flow (before the sheets), not appended behind.
  // The status line is part of the desktop view flow: it renders inside the
  // desktop return block, before the local branch even starts (comments are
  // stripped from `coll`, so branch boundaries come from the RAW text).
  const statusAt = coll.indexOf("<DesktopKnowledgeStatus");
  assert.ok(statusAt > 0, "the status exists");
  const raw = read("src", "still", "StillCollection.tsx");
  const localBranchAt = raw.indexOf("// Local source: the usability-closed composition");
  const desktopIfAt = raw.indexOf('if (source === "desktop") {');
  assert.ok(desktopIfAt > 0 && localBranchAt > desktopIfAt, "both branches located");
  // The raw span of the desktop branch contains the status invocation.
  const desktopSpan = raw.slice(desktopIfAt, localBranchAt);
  assert.ok(desktopSpan.includes("<DesktopKnowledgeStatus"),
    "rendered inside the desktop return, not appended at the end");
  assert.match(desktopSpan, /snapshot=\{desktop\}/u, "the real component receives the real snapshot");
  // No QA-injected fake copy anywhere in production files.
  const views = VIEWS();
  assert.doesNotMatch(views, /canonical registeredList/u, "no QA copy in production Views");
  // The Desktop empty must not fall through to the local composition: the
  // status line covers ready-empty with real copy.
  assert.match(status, /还没有笔记同步到手机/u);
});

// ---------------------------------------------------------------------------
// 5A/5B. the fake affordances
// ---------------------------------------------------------------------------

test("R1-5A — the desktop 新建 is GENUINELY disabled (any domain)", () => {
  const views = VIEWS();
  assert.match(views, /disabled=\{\(unavailable&&!library\)\|\|Boolean\(p\.disableNew\)\}/u,
    "disableNew applies regardless of domain (the &&library bug is gone)");
  assert.match(views, /disableNew\?'新建（仅本机）':'新建笔记'/u, "with the local-only label");
  assert.match(views, /disableNew\?:boolean/u, "the flag exists");
});

test("R1-5B — the desktop knowledge hides the inert sort affordance; local keeps it", () => {
  const coll = COLL();
  // The desktop branch passes onFilter={undefined} + hideFilter.
  const desktopBranch = coll.slice(coll.indexOf('if (source === "desktop") {'), coll.indexOf('// Local source:'));
  assert.match(desktopBranch, /onFilter=\{undefined\}/u, "no filter handler on desktop knowledge");
  assert.match(desktopBranch, /hideFilter/u, "and hides the affordance");
  const views = VIEWS();
  assert.match(views, /\{!p\.hideFilter&&<IconButton icon="filter"/u,
    "the filter/sort button is hidden when hideFilter is set");
  // The LOCAL branch keeps its own filter/sort untouched.
  const raw = read("src", "still", "StillCollection.tsx");
  const localBranch = raw.slice(raw.indexOf("// Local source: the usability-closed composition"));
  assert.ok(localBranch.includes('label="筛选与排序"'), "local 筛选与排序 untouched");
  assert.ok(localBranch.includes("void createNote()"), "local 新建 untouched");
  assert.ok(localBranch.includes('onClick={() => void createNote()}'), "local 新建 still wired");
});

test("R1-5C — QA drives the REAL product path (no fake copy behind the view)", () => {
  const entry = QA_ENTRY();
  // The QA entry composes the REAL CollectionView; copy lines are only the
  // status notes the production component renders.
  assert.match(entry, /<CollectionView[\s\S]*domain="knowledge"[\s\S]*source="desktop"/u,
    "the QA renders the real knowledge composition");
  // The old appended-copy hack is gone: no notes after the CollectionView
  // pretending to be phase copy.
  assert.doesNotMatch(entry, /canonical registeredList/u, "no fake QA copy");
  assert.doesNotMatch(entry, /style=\{\{ padding: "8px 23px" \}\}>正在/u,
    "no appended phase copy behind the view — the real component renders states");
  // The production page itself carries the real status component.
  assert.match(COLL(), /DesktopKnowledgeStatus/u);
});

test("R1-5D — the status styles exist and stay quiet/secondary", () => {
  const css = CSS();
  assert.match(css, /\.st-kb-status\{[^}]*font-size:11px/u, "quiet, secondary scale");
  assert.match(css, /\.st-kb-status \.st-button\{[^}]*min-height:44px/u, "44px connect target");
  assert.match(css, /\.st-kb-status\.is-danger\{[^}]*var\(--st-danger\)/u, "danger tone");
});
