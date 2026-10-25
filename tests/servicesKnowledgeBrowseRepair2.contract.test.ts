// SERVICES-KNOWLEDGE-BROWSE-R1 REPAIR-R2 — four fixes:
//   1. the canonical status and load-more are INSIDE the visible scroll
//      (no more off-screen blocks after the full-height view);
//   2. offline→online re-discovery has ONE authority, and an initial non-zero
//      desktopVersion cannot kill the first request;
//   3. a required operation MISSING from the catalog = unsupported, 0 calls;
//   4. the Desktop knowledge toolbar shows only the canonical vault label —
//      the local filter labels never leak.

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
const COLL_RAW = () => read("src", "still", "StillCollection.tsx");
const VIEWS = () => strip(read("src", "presentation", "still01", "Views.tsx"));

const tick = () => new Promise((r) => setImmediate(r));
const settled = () => Promise.all([tick(), tick(), tick()]);
const settledQ = () => new Promise((r) => setTimeout(r, 400));

function makeDeps(catalog: Record<string, string> = {
  "knowledge.vaults": "implemented", "knowledge.registeredList": "implemented",
}) {
  const ctl: {
    vaults: Array<{ vaultId: string; displayName: string; activeInDesktop: boolean; readGranted: boolean }>;
    vaultCalls: number;
    listCalls: number;
    listByVault: Record<string, any>;
  } = { vaults: [], vaultCalls: 0, listCalls: 0, listByVault: {} };
  const deps = {
    registry: {
      // R2-3: the registry itself maps MISSING operations to unsupported —
      // the mock mirrors `registry.operation(op).state` semantics.
      operations: catalog,
      refreshAdopting: async () => ({
        permissionRevision: 2,
        operations: Object.fromEntries(Object.entries(catalog).map(([k, v]) => [k, { state: v }])),
      }),
      snapshot: () => null as any,
      operation(opId: string) {
        return { operationId: opId, state: (catalog as any)[opId] ?? "unsupported" };
      },
      invalidate() {},
    },
    knowledge: {
      vaults: async () => { ctl.vaultCalls += 1; return { items: ctl.vaults }; },
      registeredList: async (_i: string, vaultId: string) => {
        ctl.listCalls += 1;
        return ctl.listByVault[vaultId] ?? { items: [], hasMore: false, nextAfterId: null };
      },
    },
  } as any;
  return { deps, ctl };
}

function binding(over: Partial<KnowledgeBrowseBinding> = {}): KnowledgeBrowseBinding {
  return { paired: true, connected: true, instanceId: "A", isLive: () => true, ...over };
}

const VAULT = [{ vaultId: "v", displayName: "V", activeInDesktop: true, readGranted: true }];

// ---------------------------------------------------------------------------
// 2. reconnect/currentness de-duplication (controller-level semantics)
// ---------------------------------------------------------------------------

test("R2-2 — offline→online via setConnection re-discovers exactly once", async () => {
  const { deps, ctl } = makeDeps();
  ctl.vaults = VAULT;
  ctl.listByVault.v = { items: [{ noteId: "n1" }], hasMore: false, nextAfterId: null };
  const ctrl = new KnowledgeBrowseController(deps);
  ctrl.setConnection(binding());
  await settled();
  assert.deepEqual(ctrl.snapshot().rows.map((r) => r.noteId), ["n1"]);
  const listsAfterFirst = ctl.listCalls;

  // The ws drops, then comes back — the FLIP is the only signal.
  ctrl.setConnection(binding({ connected: false }));
  await settled();
  assert.equal(ctrl.snapshot().phase, "offline");
  ctrl.setConnection(binding()); // back online
  await settled();
  assert.deepEqual(ctrl.snapshot().rows.map((r) => r.noteId), ["n1"], "fresh list");
  assert.equal(ctl.listCalls, listsAfterFirst + 1,
    "exactly ONE fresh discover/list for one offline→online flip");
});

test("R2-2b — an initial non-zero desktopVersion must not kill the first request", () => {
  // R4.4: the coarse dataStore version is fully decoupled from vault
  // currentness — no certification machinery and no dataStore-driven
  // activeVaultChanged remain in the page; preview freshness is its only use,
  // so an initial non-zero version structurally cannot retire anything.
  const raw = COLL_RAW();
  assert.doesNotMatch(raw, /firstVaultSignal/u, "no component-local guard remains");
  assert.doesNotMatch(raw, /desktopDriftPending/u, "no vault-currentness certification in the page");
  assert.doesNotMatch(raw, /desktopCtrl\.activeVaultChanged\(/u, "no dataStore-driven vault change");
});

test("R2-2c — the page no longer fires a second reconnect on the ws edge", () => {
  const raw = COLL_RAW();
  // The ws-edge reconnect block is gone; setConnection owns the flip.
  assert.doesNotMatch(raw, /desktopCtrl\.reconnect\(\);\s*\n?\s*\}, \[desktopCtrl, wsState/u,
    "no ws-edge reconnect effect");
  // R4.1: the user refresh is refresh() (stale-while-revalidate); reconnect()
  // itself has no page call sites left.
  const sites = (raw.match(/desktopCtrl\.reconnect\(\)/gu) || []).length;
  assert.equal(sites, 0, `reconnect has zero page call sites (refresh() owns the user path), got ${sites}`);
  assert.match(raw, /desktopCtrl\.refresh\(\);/u, "the user refresh is rows-retained");
});

// ---------------------------------------------------------------------------
// 3. a required operation MISSING from the catalog = unsupported
// ---------------------------------------------------------------------------

test("R2-3a — missing knowledge.vaults -> unsupported with 0 calls", async () => {
  const { deps, ctl } = makeDeps({ "knowledge.registeredList": "implemented" });
  const ctrl = new KnowledgeBrowseController(deps);
  ctrl.setConnection(binding());
  await settled();
  assert.equal(ctrl.snapshot().phase, "unsupported");
  assert.equal(ctl.vaultCalls, 0, "no vault request");
  assert.equal(ctl.listCalls, 0, "and no list request");
});

test("R2-3b — missing knowledge.registeredList -> unsupported with 0 list calls", async () => {
  const { deps, ctl } = makeDeps({ "knowledge.vaults": "implemented" });
  ctl.vaults = VAULT;
  const ctrl = new KnowledgeBrowseController(deps);
  ctrl.setConnection(binding());
  await settled();
  assert.equal(ctrl.snapshot().phase, "unsupported");
  assert.equal(ctl.vaultCalls, 0, "the short-circuit happens before ANY wire call");
  assert.equal(ctl.listCalls, 0);
});

test("R2-3c — the controller uses registry.operation (unknown -> unsupported)", () => {
  const ctrlSrc = strip(read("src", "still", "kit", "knowledgeBrowseController.ts"));
  assert.match(ctrlSrc, /registry\.operation\(op\)\.state/u,
    "the per-operation check goes through the captured scoped registry.operation");
  // No raw catalog indexing that would treat a missing op as "maybe fine".
  assert.doesNotMatch(ctrlSrc, /catalog\.operations\?\.\[op\]/u,
    "no direct catalog indexing for the capability check");
});

// ---------------------------------------------------------------------------
// 1 + 4. the visible scroll structure and the label truth (page wiring)
// ---------------------------------------------------------------------------

test("R2-1 — the status and load-more are bounded slots INSIDE the view", () => {
  const views = VIEWS();
  // The slots are CollectionView props (rendered inside .st-scroll).
  assert.match(views, /statusSlot\?:ReactNode;loadMoreSlot\?:ReactNode;/u, "the slot props exist");
  const notesAt = views.indexOf('p.notes.length?p.notes.map');
  const statusAt = views.indexOf("{p.statusSlot}");
  const moreAt = views.indexOf("{p.loadMoreSlot}");
  assert.ok(statusAt > 0 && moreAt > statusAt && notesAt > 0,
    "status -> rows -> load-more, all inside the same slot fragment");
  // The slots render before the local/library branches (inside the scroll).
  const libraryAt = views.indexOf("library?(p.assets.length");
  assert.ok(libraryAt > moreAt, "the slots live in the in-scroll region");
});

test("R2-1b — the page passes the slots and drops the trailing blocks", () => {
  const raw = COLL_RAW();
  // ORG-R1: the slot may branch (directory vs all-notes status); both arms
  // are the REAL status components rendered INSIDE the view.
  const statusSlot = raw.slice(raw.indexOf("statusSlot="), raw.indexOf("loadMoreSlot="));
  assert.match(statusSlot, /directoryActive[\s\S]*?<DirectoryStatusLine quiet snapshot=\{directorySnap\}/u,
    "the directory status is inside the status slot alongside folder navigation");
  assert.match(statusSlot, /<DesktopKnowledgeStatus quiet snapshot=\{desktop\}/u, "and the all-notes status too");
  const toolbarSlot = raw.slice(raw.indexOf("toolbarSlot="), raw.indexOf("disableNew="));
  assert.match(toolbarSlot, /<FolderBreadcrumbs/u, "folder breadcrumbs share the compact in-scroll toolbar");
  assert.ok(VIEWS().indexOf("{p.toolbarSlot}") < VIEWS().indexOf("{p.statusSlot}"), "toolbar precedes folder rows/status");
  assert.match(statusSlot, /<FolderRows/u, "folder rows remain inside the scroll slot");
  assert.match(raw, /loadMoreSlot=\{directoryActive[\s\S]{0,600}?directoryCtrl\.loadMore\(\)/u, "the directory load-more is a slot");
  assert.match(raw, /desktopCtrl\.loadMore\(\)/u, "and the all-notes load-more stays a slot");
  // No trailing status/load-more after the CollectionView anymore. (The
  // desktop RETURN branch is the SECOND `if (source === "desktop")` — the
  // first is the items memo.)
  const branchStart = raw.indexOf('if (source === "desktop") {', raw.indexOf('if (source === "desktop") {') + 1);
  const branchEnd = raw.indexOf("// Local source: the usability-closed composition");
  const tail = raw.slice(branchEnd, raw.indexOf('sheet === "filter"', branchEnd));
  assert.doesNotMatch(tail, /<DesktopKnowledgeStatus/u, "no status after the view");
  assert.doesNotMatch(tail, /desktopCtrl\.loadMore\(\)/u, "no load-more after the view");
  void branchStart;
});

test("R2-1c — the Desktop empty is the canonical one, never the local composition", () => {
  const views = VIEWS();
  // The slot branch renders canonical rows + slots; the local empty
  // (给想法留个位置 / 新建笔记) only lives in the LOCAL branch after it.
  const slotBranch = views.slice(views.indexOf("(p.statusSlot!==undefined"), views.indexOf("library?(p.assets.length"));
  assert.ok(!slotBranch.includes("给想法留个位置"), "no local empty copy in the slot branch");
  assert.ok(!slotBranch.includes("新建笔记</Button>"), "and no local new-note CTA");
  // The local branch still has its own empty copy.
  const localBranch = views.slice(views.indexOf("library?(p.assets.length"));
  assert.ok(localBranch.includes("给想法留个位置"), "the local empty stays for Local");
});

test("R2-4 — the Desktop knowledge toolbar label is ONLY the canonical vault", () => {
  const raw = COLL_RAW();
  // The desktop RETURN branch is the SECOND `if (source === "desktop") {`;
  // the first one is the items memo.
  const branchStart = raw.indexOf('if (source === "desktop") {', raw.indexOf('if (source === "desktop") {') + 1);
  const branchEnd = raw.indexOf("// Local source: the usability-closed composition");
  const desktopBranch = raw.slice(branchStart, branchEnd);
  // No `filterLabel || vaultLabel` fallback — the local labels can never leak.
  assert.doesNotMatch(desktopBranch, /filterLabel \|\| vaultLabel/u,
    "the `filterLabel ||` leak is gone");
  assert.match(desktopBranch, /filterLabel=\{vaultLabel\}/u, "the label IS the vault");
  // The local label derivation stays out of the desktop branch.
  assert.ok(!desktopBranch.includes("已归档"), "no 归档 label in the desktop branch");
  assert.ok(!desktopBranch.includes("置顶笔记"), "no 置顶 label");
  assert.ok(!desktopBranch.includes('"收藏"'), "no 收藏 label");
  // The local branch keeps its own derivation.
  const localBranch = raw.slice(branchEnd);
  assert.ok(localBranch.includes("已归档"), "the local labels stay for Local");
});

test('saved-library retirement epoch restarts same vault while duplicate epoch remains coalesced', async () => {
  const { deps, ctl } = makeDeps(); ctl.vaults = VAULT;
  ctl.listByVault.v = { items: [{ noteId: 'n1' }], hasMore: false, nextAfterId: null };
  const ctrl = new KnowledgeBrowseController(deps);
  ctrl.selectVault('v', true, 1); ctrl.setConnection(binding()); await settled();
  const initial = ctl.listCalls;
  ctrl.selectVault('v', true, 1); await settled(); assert.equal(ctl.listCalls, initial);
  ctrl.selectVault('v', true, 2); await settled(); assert.equal(ctl.listCalls, initial + 1);
  assert.equal(ctrl.snapshot().phase, 'ready'); assert.deepEqual(ctrl.snapshot().rows.map(r=>r.noteId), ['n1']);
});
