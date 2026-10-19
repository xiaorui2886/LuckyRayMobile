// SERVICES-KNOWLEDGE-BROWSE-R1 — focused tests for the canonical read-side
// Knowledge browse controller: discovery → the ACTIVE read-granted vault →
// registeredList with canonical q / afterId / nextAfterId, full currentness,
// truthful offline/grant phases, and exact instance+vault+note row identity.

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

const tick = () => new Promise((r) => setImmediate(r));
/** Long enough to pass the controller's 260ms query debounce. */
const settledQ = () => new Promise((r) => setTimeout(r, 400));

type Ctl = {
  vaults: Array<{ vaultId: string; displayName: string; activeInDesktop: boolean; readGranted: boolean }>;
  pages: Array<{ items: Array<{ noteId: string; title?: string; parentRelativePath?: string; revision?: string }>; hasMore: boolean; nextAfterId: string | null }>;
  failList: boolean;
  calls: Array<{ afterId?: string; limit?: number; q?: string }>;
};
function makeDeps(catalogState: string = "implemented", catalogRevision = 2) {
  const ctl: Ctl = { vaults: [], pages: [], failList: false, calls: [] };
  // R2-3: both required operations default to implemented; the registry mock
  // mirrors `operation(op).state` (unknown -> unsupported).
  const ops: Record<string, string> = {
    "knowledge.vaults": "implemented",
    "knowledge.registeredList": catalogState,
  };
  const deps = {
    registry: {
      refreshAdopting: async () => {
        return {
          permissionRevision: catalogRevision,
          operations: Object.fromEntries(Object.entries(ops).map(([k, v]) => [k, { state: v }])),
        };
      },
      snapshot: () => ({
        permissionRevision: catalogRevision,
        operations: Object.fromEntries(Object.entries(ops).map(([k, v]) => [k, { state: v }])),
      }),
      operation(opId: string) {
        return { operationId: opId, state: ops[opId] ?? "unsupported" };
      },
      invalidate: () => {},
    },
    knowledge: {
      vaults: async () => ({ items: ctl.vaults }),
      registeredList: async (_i: string, _v: string, o: any) => {
        ctl.calls.push(o ?? {});
        if (ctl.failList) throw new Error("gateway 503");
        return ctl.pages[ctl.calls.length - 1];
      },
    },
  } as any;
  return { deps, ctl };
}

function binding(over: Partial<KnowledgeBrowseBinding> = {}): KnowledgeBrowseBinding {
  return { paired: true, connected: true, instanceId: "A", isLive: () => true, ...over };
}

async function settled(ctrl: KnowledgeBrowseController) {
  await tick(); await tick(); await tick();
}

// The core happy path: discover → the ACTIVE read-granted vault → page-1.
test("K1 — discovery picks the ACTIVE read-granted vault and lists page-1", async () => {
  const { deps, ctl } = makeDeps();
  ctl.vaults = [
    { vaultId: "v-other", displayName: "别的库", activeInDesktop: false, readGranted: true },
    { vaultId: "v-main", displayName: "我的知识库", activeInDesktop: true, readGranted: true },
    { vaultId: "v-ng", displayName: "未授权", activeInDesktop: true, readGranted: false },
  ];
  ctl.pages = [{
    items: [
      { noteId: "n1", title: "第一篇", parentRelativePath: "notes/one.md", revision: "r1" },
      { noteId: "n2", title: "", parentRelativePath: "notes/two.md", revision: "r2" },
    ],
    hasMore: false, nextAfterId: null,
  }];
  const ctrl = new KnowledgeBrowseController(deps);
  const seen: any[] = [];
  ctrl.subscribe((s) => seen.push(s));
  ctrl.setConnection(binding());
  await settled();

  const last = ctrl.snapshot();
  assert.equal(last.phase, "ready");
  assert.equal(last.vaultId, "v-main", "the ACTIVE + readGranted vault wins");
  assert.equal(last.vaultName, "我的知识库");
  assert.equal(last.rows.length, 2, "server order preserved");
  assert.equal(last.rows[0].title, "第一篇");
  assert.equal(last.rows[1].title, "无标题笔记", "empty title gets the product fallback");
  // Exact row identity.
  assert.deepEqual(
    last.rows.map((r) => `${r.instanceId}|${r.vaultId}|${r.noteId}`),
    ["A|v-main|n1", "A|v-main|n2"],
  );
  assert.equal(last.rows[0].parentRelativePath, "notes/one.md", "canonical row metadata");
});

// Canonical q, fenced by the epoch.
test("K2 — query A→B retires A: only B's rows commit", async () => {
  const { deps, ctl } = makeDeps();
  ctl.vaults = [{ vaultId: "v", displayName: "V", activeInDesktop: true, readGranted: true }];
  const pages: Record<string, any> = {
    "": { items: [{ noteId: "all" }], hasMore: false, nextAfterId: null },
    "rust": { items: [{ noteId: "rust-1" }, { noteId: "rust-2" }], hasMore: false, nextAfterId: null },
  };
  ctl.pages = [];
  deps.knowledge.registeredList = async (_i: string, _v: string, o: any) => {
    ctl.calls.push(o ?? {});
    return pages[o?.q ?? ""] ?? { items: [], hasMore: false, nextAfterId: null };
  };
  // A in flight, then B: A's slow response must never commit. The HANGING
  // page-1 hook is installed first so A's request is genuinely outstanding
  // when the user retypes.
  let releaseA: (() => void) | null = null;
  deps.knowledge.registeredList = (_i: string, _v: string, o: any) => {
    ctl.calls.push(o ?? {});
    if ((o?.q ?? "") === "") {
      return new Promise((res) => { releaseA = () => res({ items: [{ noteId: "all-stale" }], hasMore: false, nextAfterId: null }); });
    }
    return Promise.resolve(pages[o?.q ?? ""] ?? { items: [], hasMore: false, nextAfterId: null });
  };
  const ctrl = new KnowledgeBrowseController(deps);
  ctrl.setConnection(binding());
  await tick(); await tick();
  assert.ok(releaseA, "A's page-1 is genuinely in flight");
  assert.equal(ctrl.snapshot().phase, "loading");

  ctrl.setQuery("rust");
  await settledQ();
  assert.equal(ctrl.snapshot().query, "rust");
  assert.deepEqual(ctrl.snapshot().rows.map((r) => r.noteId), ["rust-1", "rust-2"]);
  releaseA!();
  await tick(); await tick();
  assert.deepEqual(ctrl.snapshot().rows.map((r) => r.noteId), ["rust-1", "rust-2"],
    "the late A response was dropped");
  // Canonical q key actually sent.
  assert.ok(ctl.calls.some((c) => c.q === "rust"), "canonical `q` used");
});

// Canonical afterId paging.
test("K3 — loadMore pages via nextAfterId and appends in server order", async () => {
  const { deps, ctl } = makeDeps();
  ctl.vaults = [{ vaultId: "v", displayName: "V", activeInDesktop: true, readGranted: true }];
  ctl.pages = [
    { items: [{ noteId: "n1" }, { noteId: "n2" }], hasMore: true, nextAfterId: "n2" },
    { items: [{ noteId: "n3" }], hasMore: false, nextAfterId: null },
  ];
  const ctrl = new KnowledgeBrowseController(deps);
  ctrl.setConnection(binding());
  await settled();
  assert.deepEqual(ctrl.snapshot().rows.map((r) => r.noteId), ["n1", "n2"]);
  assert.equal(ctrl.snapshot().hasMore, true);

  ctrl.loadMore();
  await settled();
  const snap = ctrl.snapshot();
  assert.deepEqual(snap.rows.map((r) => r.noteId), ["n1", "n2", "n3"], "server order preserved");
  assert.equal(snap.hasMore, false);
  assert.equal(ctl.calls[1].afterId, "n2", "canonical afterId key");
  assert.equal(ctl.calls[1].limit, 50, "bounded page size");
  // Exhausted: loadMore is a no-op.
  ctrl.loadMore();
  await settled();
  assert.equal(ctl.calls.length, 2, "no request after hasMore=false");
});

// Late page-N failure must not blank a newer identity.
test("K4 — a late page-N failure neither blanks rows nor errors a newer identity", async () => {
  const { deps, ctl } = makeDeps();
  ctl.vaults = [{ vaultId: "v", displayName: "V", activeInDesktop: true, readGranted: true }];
  ctl.pages = [{ items: [{ noteId: "n1" }], hasMore: true, nextAfterId: "n1" }];
  const ctrl = new KnowledgeBrowseController(deps);
  ctrl.setConnection(binding());
  await settled();
  assert.deepEqual(ctrl.snapshot().rows.map((r) => r.noteId), ["n1"]);

  // Page-2 fails, but a new epoch (query) supersedes it before it lands.
  let rejectP2: ((e: unknown) => void) | null = null;
  deps.knowledge.registeredList = (_i: string, _v: string, o: any) => {
    if (o?.afterId === "n1") {
      return new Promise((_res, rej) => { rejectP2 = rej; });
    }
    ctl.calls.push(o ?? {});
    return Promise.resolve({ items: [{ noteId: "fresh" }], hasMore: false, nextAfterId: null });
  };
  ctrl.loadMore();
  ctrl.setQuery("fresh"); // a new epoch while page-2 is in flight
  await settledQ();
  assert.equal(ctrl.snapshot().phase, "ready", "the newer identity is ready");
  assert.deepEqual(ctrl.snapshot().rows.map((r) => r.noteId), ["fresh"]);
  rejectP2!(new Error("gateway 503"));
  await tick(); await tick();
  assert.equal(ctrl.snapshot().phase, "ready", "the late failure changed nothing");
  assert.deepEqual(ctrl.snapshot().rows.map((r) => r.noteId), ["fresh"]);
});

// Desktop A→B isolation.
test("K5 — Desktop A→B drops A's rows and re-discovers under B", async () => {
  const { deps, ctl } = makeDeps();
  ctl.vaults = [{ vaultId: "v", displayName: "V", activeInDesktop: true, readGranted: true }];
  const pagesByInstance: Record<string, any> = {
    A: { items: [{ noteId: "on-a" }], hasMore: false, nextAfterId: null },
    B: { items: [{ noteId: "on-b" }], hasMore: false, nextAfterId: null },
  };
  deps.knowledge.registeredList = async (instanceId: string) => pagesByInstance[instanceId];
  const ctrl = new KnowledgeBrowseController(deps);
  ctrl.setConnection(binding({ instanceId: "A" }));
  await settled();
  assert.deepEqual(ctrl.snapshot().rows.map((r) => r.noteId), ["on-a"]);

  ctrl.setConnection(binding({ instanceId: "B" }));
  await settled();
  const snap = ctrl.snapshot();
  assert.equal(snap.instanceId, "B");
  assert.deepEqual(snap.rows.map((r) => r.noteId), ["on-b"], "B's rows only");
  assert.deepEqual(snap.rows.map((r) => r.instanceId), ["B"], "row identity carries B");
  assert.equal(snap.rows[0].vaultId, "v", "and the same canonical vaultId key");
});

// Reconnect re-discovers from scratch.
test("K6 — a same-instance reconnect re-discovers and re-lists", async () => {
  const { deps, ctl } = makeDeps();
  ctl.vaults = [{ vaultId: "v", displayName: "V", activeInDesktop: true, readGranted: true }];
  ctl.pages = [{ items: [{ noteId: "first" }], hasMore: false, nextAfterId: null }];
  const ctrl = new KnowledgeBrowseController(deps);
  ctrl.setConnection(binding());
  await settled();
  assert.deepEqual(ctrl.snapshot().rows.map((r) => r.noteId), ["first"]);

  ctl.pages = [{ items: [{ noteId: "first" }, { noteId: "second" }], hasMore: false, nextAfterId: null }];
  ctl.calls.length = 0;
  ctrl.reconnect();
  await settled();
  assert.deepEqual(ctrl.snapshot().rows.map((r) => r.noteId), ["first", "second"],
    "fresh page-1 after reconnect");
});

// Active vault change retires old rows.
test("K7 — the ACTIVE vault changing retires old rows and re-lists", async () => {
  const { deps, ctl } = makeDeps();
  ctl.vaults = [{ vaultId: "v1", displayName: "旧库", activeInDesktop: true, readGranted: true }];
  const pagesByVault: Record<string, any> = {
    v1: { items: [{ noteId: "old" }], hasMore: false, nextAfterId: null },
    v2: { items: [{ noteId: "new" }], hasMore: false, nextAfterId: null },
  };
  deps.knowledge.registeredList = async (_i: string, vaultId: string) => pagesByVault[vaultId];
  const ctrl = new KnowledgeBrowseController(deps);
  ctrl.setConnection(binding());
  await settled();
  assert.equal(ctrl.snapshot().vaultId, "v1");

  ctl.vaults = [{ vaultId: "v2", displayName: "新库", activeInDesktop: true, readGranted: true }];
  ctrl.activeVaultChanged();
  await settled();
  const snap = ctrl.snapshot();
  assert.equal(snap.vaultId, "v2");
  assert.equal(snap.vaultName, "新库");
  assert.deepEqual(snap.rows.map((r) => `${r.vaultId}|${r.noteId}`), ["v2|new"]);
});

// Truthful phases: unpaired, offline, grant, no active vault.
test("K8 — unpaired/offline/grant/no-active-vault are all truthful", async () => {
  const { deps, ctl } = makeDeps();
  const ctrl = new KnowledgeBrowseController(deps);

  // Unpaired.
  ctl.vaults = [{ vaultId: "v", displayName: "V", activeInDesktop: true, readGranted: true }];
  ctl.pages = [{ items: [{ noteId: "n" }], hasMore: false, nextAfterId: null }];
  ctrl.setConnection(binding({ paired: false, connected: false, instanceId: "" }));
  await settled();
  assert.equal(ctrl.snapshot().phase, "unpaired");
  assert.equal(ctrl.snapshot().rows.length, 0);

  // Paired but ws down.
  ctrl.setConnection(binding({ connected: false }));
  await settled();
  assert.equal(ctrl.snapshot().phase, "offline", "never pretends fresh while offline");
  assert.equal(ctrl.snapshot().rows.length, 0);

  // Grant withdrawn (catalog truth).
  const ng = makeDeps("notGranted");
  ng.ctl.vaults = [{ vaultId: "v", displayName: "V", activeInDesktop: true, readGranted: true }];
  const ctrlNg = new KnowledgeBrowseController(ng.deps);
  ctrlNg.setConnection(binding());
  await settled();
  assert.equal(ctrlNg.snapshot().phase, "not-granted");
  assert.equal(ctrlNg.snapshot().rows.length, 0, "stale actionable rows are cleared");

  // Unsupported operation.
  const un = makeDeps("unsupported");
  un.ctl.vaults = [{ vaultId: "v", displayName: "V", activeInDesktop: true, readGranted: true }];
  const ctrlUn = new KnowledgeBrowseController(un.deps);
  ctrlUn.setConnection(binding());
  await settled();
  assert.equal(ctrlUn.snapshot().phase, "unsupported");

  // Paired + connected but NO readable active vault.
  ctl.vaults = [{ vaultId: "v2", displayName: "别的库", activeInDesktop: false, readGranted: true }];
  const ctrl2 = new KnowledgeBrowseController(deps);
  ctrl2.setConnection(binding());
  await settled();
  assert.equal(ctrl2.snapshot().phase, "ready", "truthful empty, not an error");
  assert.equal(ctrl2.snapshot().rows.length, 0);
  assert.equal(ctrl2.snapshot().vaultId, "", "no fake vault");

  // Discovery error surfaces.
  const err = makeDeps();
  err.deps.registry.refreshAdopting = async () => { throw new Error("gateway down"); };
  const ctrlErr = new KnowledgeBrowseController(err.deps);
  ctrlErr.setConnection(binding());
  await settled();
  assert.equal(ctrlErr.snapshot().phase, "error");
});

// ---------------------------------------------------------------------------
// Production wiring: the page drives the controller; the boundaries hold.
// ---------------------------------------------------------------------------

test("K-W1 — StillCollection feeds the controller and keeps the old reader retired", () => {
  const coll = COLL();
  // R4.1: the controller is the SESSION object's member.
  assert.match(coll, /const desktopCtrl = session\.desktop;/u, "the page reads the session controller");
  assert.match(coll, /desktopCtrl\.setConnection\(/u, "synchronous identity feed");
  assert.match(coll, /desktopCtrl\.setQuery\(query\)/u, "canonical q");
  assert.match(coll, /desktopCtrl\.refresh\(\)/u, "explicit refresh (R4.1: rows-retained refresh())");
  assert.match(coll, /desktopCtrl\.loadMore\(\)/u, "bounded load-more");
  assert.match(coll, /selectionWithRange|/u); // no-op guard against empty regex
  // The Content V1 desktop read-side is retired from this page.
  assert.doesNotMatch(coll, /api\.contentNotes\(/u, "no legacy desktop notes read");
  assert.doesNotMatch(coll, /api\.contentNoteDirectories\(/u, "no legacy directories read");
  assert.doesNotMatch(coll, /contentNoteDirectories/u, "the legacy directory affordance is gone");
  assert.doesNotMatch(coll, /desktopVaultId/u, "the Content V1 vault resolver is retired");
  assert.doesNotMatch(coll, /desktopItem/u, "the legacy row mapper is retired");
});

test("K-W2 — the row identity and the detail route stay exact", () => {
  const coll = COLL();
  assert.match(coll, /desktop:\$\{encodeURIComponent\(r\.instanceId\)\}:\$\{encodeURIComponent\(r\.vaultId\)\}:\$\{encodeURIComponent\(r\.noteId\)\}/u,
    "`desktop:<instance>:<vault>:<note>` route built from canonical identity");
  // R4.1 (B): the row subtitle is the BODY PREVIEW from note_cache (or the
  // truthful 正文尚未缓存 fallback, with the 缓存版本 marker when outdated) —
  // never the vault name, never the path.
  assert.match(coll, /meta: preview \|\| \(p && p\.outdated \? `缓存版本 · \$\{NO_CACHED_BODY\}` : NO_CACHED_BODY\)/u,
    "body preview with the truthful fallback");
  assert.doesNotMatch(coll, /meta: r\.parentRelativePath \|\| "LuckyRay 知识库"/u,
    "the vault-name/path subtitle is retired");
  // Still open() continues into the existing detail/editor.
  assert.match(coll, /open\("note", id, \{ noteSearch: target \}\);/u);
  assert.match(coll, /snapshot\.query !== query\.trim\(\)/u, "a new query cannot open a retained old result");
  assert.match(coll, /snapshot\.phase === "searching"/u, "searching rows cannot carry new-query metadata");
});

test("K-W3 — the directory boundary holds", () => {
  const ctrlSrc = strip(read("src", "still", "kit", "knowledgeBrowseController.ts"));
  assert.doesNotMatch(ctrlSrc, /director/u, "the controller has no directory concept at all");
  assert.match(ctrlSrc, /parentRelativePath/u, "parentRelativePath is plain row metadata");
  const views = strip(read("src", "presentation", "still01", "Views.tsx"));
  // The desktop knowledge new-affordance is disabled (read-only R1), labelled.
  assert.match(views, /disableNew\?:boolean/u, "the view takes the explicit flag");
  assert.match(views, /新建（仅本机）/u, "the disabled label says local-only");
});

test("K-W4 — no second readHints consumer; shared architecture reused", () => {
  const ctrlSrc = strip(read("src", "still", "kit", "knowledgeBrowseController.ts"));
  assert.doesNotMatch(ctrlSrc, /readHints|HintSubscription|ChangeFeedClient/u,
    "no new hint/feed consumer — permission truth comes from the registry catalog");
  // Reuses the accepted registry + KnowledgeClient.
  assert.match(ctrlSrc, /refreshAdopting/u, "registry discovery like #82");
  assert.match(ctrlSrc, /knowledge\.registeredList/u, "canonical list");
  assert.match(ctrlSrc, /knowledge\.vaults/u, "canonical vaults");
  assert.match(ctrlSrc, /nextAfterId/u, "canonical paging key");
  assert.match(ctrlSrc, /afterId/u, "canonical request key");
});
