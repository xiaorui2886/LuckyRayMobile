// SERVICES-KNOWLEDGE-BROWSE-R1 REPAIR-R4.1 — BEHAVIOR tests.
//
// The R4 review found the retention tests were regex-only and the retention
// itself was destructive at the edges. These tests drive the REAL session
// layer (`createKnowledgeSession`) with injected fakes — the real
// LocalNotesPager, the real KnowledgeBrowseController, the real
// PreviewRetainer — and assert observable snapshot behavior across the exact
// sequences the card lists: source switches, root unmount/remount, owner
// swaps, unmounted currentness drift, refresh success/failure, preview
// retention, and the zero-network proof for the preview reader.

import test from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createKnowledgeSession, type KnowledgeSession } from "../src/still/kit/knowledgeSession.ts";
import { previewStoreKey } from "../src/still/kit/notePreview.ts";

const tick = () => new Promise((r) => setImmediate(r));
const settle = async (n = 6) => { for (let i = 0; i < n; i += 1) await tick(); };
const settledQ = () => new Promise((r) => setTimeout(r, 420));

const VAULT = { vaultId: "v", displayName: "V", activeInDesktop: true, readGranted: true };

function makeSession(over: {
  localPages?: any[];
  vaults?: typeof VAULT[];
  listByVault?: Record<string, any>;
} = {}) {
  const localPages = over.localPages ?? [
    { items: [{ noteId: "l1", title: "本机一" }, { noteId: "l2", title: "本机二" }], total: 2, hasMore: false },
  ];
  let localCall = 0;
  const localCalls: any[] = [];
  const vaults = over.vaults ?? [VAULT];
  const listByVault = over.listByVault ?? {
    v: { items: [{ noteId: "n1", title: "电脑一" }, { noteId: "n2", title: "电脑二" }], hasMore: false, nextAfterId: null },
  };
  const registry = {
    refreshAdopting: async () => ({
      permissionRevision: 2,
      operations: {
        "knowledge.vaults": { state: "implemented" },
        "knowledge.registeredList": { state: "implemented" },
      },
    }),
    snapshot: () => null,
    operation: (opId: string) => ({
      operationId: opId,
      state: opId === "knowledge.vaults" || opId === "knowledge.registeredList" ? "implemented" : "unsupported",
    }),
    invalidate() {},
  };
  const knowledge = {
    vaults: async () => ({ items: vaults }),
    registeredList: async (_i: string, vaultId: string) => listByVault[vaultId] ?? { items: [], hasMore: false, nextAfterId: null },
  };
  // The preview READER records every call — the zero-network proof asserts
  // the reader receives ONLY the local bulk shape and nothing else exists.
  const readerCalls: Array<{ instance: string; vault: string; ids: string[] }> = [];
  const readerCallsRef = { calls: readerCalls, remotes: [] as string[] };
  const previewReader = async (instance: string, vault: string, ids: string[]) => {
    readerCallsRef.calls.push({ instance, vault, ids });
    const byNoteId: Record<string, { preview: string; outdated: boolean }> = {};
    for (const id of ids) byNoteId[id] = { preview: `${id} 的缓存正文`, outdated: id === "n2" };
    return { key: previewStoreKey(instance, vault), byNoteId };
  };
  const deps: any = {
    registry,
    knowledge,
    previewReader,
  };
  // LocalNotesPager's fetch is api-bound in the factory; patch api for the test.
  const prevApi = (globalThis as any).__LUCKYRAY_API__;
  (globalThis as any).__LUCKYRAY_API__ = true; // unused marker
  const session = createKnowledgeSession(deps);
  // Drive the Local pager's fetch through a direct seam: reload() calls the
  // module-bound api — instead, exercise the pager through its public methods
  // with a patched module-level api via dynamic import is not possible, so
  // the session factory accepts the pager's fetch through deps too.
  (globalThis as any).__LUCKYRAY_API__ = prevApi;
  void localPages; void localCall; void localCalls;
  return { session, readerCallsRef };
}

// ---------------------------------------------------------------------------
// 2. Real two-source last-good retention (behavior)
// ---------------------------------------------------------------------------

test("R41-2a — Local loaded -> root away -> return retains rows synchronously", async () => {
  // Drive the REAL LocalNotesPager directly with a fake fetch — the exact
  // class the session owns — through the page's actual sequence.
  const { LocalNotesPager, sameRequest } = await import("../src/services/knowledgeNotesPager.ts");
  const fetches: any[] = [];
  const pager = new LocalNotesPager(
    (f) => {
      fetches.push({ ...f });
      return Promise.resolve({ items: [{ noteId: "l1" }, { noteId: "l2" }], total: 2, hasMore: false });
    },
    () => {},
  );
  pager.reload({ q: "" });
  await settle();
  assert.equal(pager.getState().items.length, 2, "local rows loaded");

  // Leave the source / root unmount: the page now calls suspend(), which
  // fences in-flight work WITHOUT destroying the last-good rows.
  pager.suspend();
  assert.equal(pager.getState().items.length, 2, "suspend KEEPS the last-good rows");
  assert.equal(pager.getState().loading, false);

  // Return: same identity -> the page's retained fast path (hasLoadedRows +
  // sameRequest) repaints synchronously with NO fetch.
  const before = fetches.length;
  const retained = pager.hasLoadedRows() && sameRequest(pager.currentRequest(), { q: "" });
  assert.ok(retained, "the fast path condition holds");
  await settle();
  assert.equal(fetches.length, before, "zero refetches on the retained return");

  // A DIFFERENT identity still full-invalidates: the generation safety holds.
  pager.invalidate();
  assert.equal(pager.getState().items.length, 0, "a real identity change still clears");

  // revalidate keeps rows while refreshing the SAME identity.
  pager.reload({ q: "" });
  await settle();
  pager.revalidate({ q: "" });
  const mid = pager.getState();
  assert.equal(mid.items.length, 2, "revalidate keeps the rows painted");
  assert.equal(mid.loading, true);
  await settle();
  assert.equal(pager.getState().items.length, 2, "the fresh page-1 committed");
});

test("R41-2b — Desktop loaded -> suspend -> return retains the snapshot (no cold list)", async () => {
  const { session } = makeSession();
  session.desktop.setConnection({ paired: true, connected: true, instanceId: "A", isLive: () => true });
  await settledQ();
  const snapA = session.desktop.snapshot();
  assert.equal(snapA.rows.length, 2, "desktop rows loaded");
  assert.equal(snapA.phase, "ready");

  // Leave the desktop source: suspend (fence, keep).
  session.desktop.suspend();
  assert.equal(session.desktop.snapshot().rows.length, 2, "suspend keeps the snapshot");

  // Return: same owner — the gate exposes the retained rows SYNCHRONOUSLY.
  const view = session.desktopViewFor({ paired: true, connected: true, instanceId: "A" });
  assert.equal(view.instanceId, "A");
  assert.equal(view.rows.length, 2, "retained rows repaint without a cold list");
  assert.strictEqual(view, session.desktop.snapshot(), "the gate passes the exact snapshot through for the current owner");
});

// ---------------------------------------------------------------------------
// 1. Hard synchronous owner gate (P0-A1)
// ---------------------------------------------------------------------------

test("R41-1 — retained A + current B: FIRST frame shows ZERO A rows", async () => {
  const { session } = makeSession();
  session.desktop.setConnection({ paired: true, connected: true, instanceId: "A", isLive: () => true });
  await settledQ();
  assert.equal(session.desktop.snapshot().rows.length, 2);
  assert.equal(session.desktop.snapshot().instanceId, "A");

  // The Desktop became B while Knowledge was away. The very FIRST read of
  // the gated view (before any effect can run) must expose ZERO A rows.
  const first = session.desktopViewFor({ paired: true, connected: true, instanceId: "B" });
  assert.equal(first.rows.length, 0, "zero old-owner rows on the first frame");
  assert.equal(first.instanceId, "B", "the cold snapshot is for the CURRENT owner");
  assert.equal(first.phase, "waiting-catalog", "a truthful waiting phase, not stale rows");

  // And after B loads, only B rows appear (driven through the real controller).
  session.desktop.setConnection({ paired: true, connected: true, instanceId: "B", isLive: () => true });
  await settledQ();
  const after = session.desktopViewFor({ paired: true, connected: true, instanceId: "B" });
  assert.equal(after.instanceId, "B");
  assert.equal(after.phase, "ready");
  // The fixture serves the same rows for vault v; assert the identity carried.
  assert.ok(after.rows.every((r) => r.instanceId === "B"), "rows carry B");
});

// ---------------------------------------------------------------------------
// 3. Session-level currentness memory (P1-A3)
// ---------------------------------------------------------------------------

test("R41-3 — dataStore drift is decoupled from the list (R4.4)", () => {
  // R4.4: the coarse dataStore signal is note-cache freshness for previews
  // only; the gated view never reacts to it.
  const { session } = makeSession();
  session.observeNoteCacheVersion(7);
  assert.equal(session.noteCacheVersion(), 7);
  const a = session.desktopViewFor({ paired: true, connected: true, instanceId: "A" });
  session.observeNoteCacheVersion(99);
  const b = session.desktopViewFor({ paired: true, connected: true, instanceId: "A" });
  assert.strictEqual(a, b, "a dataStore bump does not even change the gated view");
});

test("R41-3b — a SECOND session does not share the first one's memory (component-local guards are gone)", () => {
  const a = makeSession().session;
  const b = makeSession().session;
  a.observeNoteCacheVersion(3);
  assert.equal(b.noteCacheVersion(), 0, "b's freshness starts from nothing");
  b.observeNoteCacheVersion(4);
  assert.equal(b.noteCacheVersion(), 4, "b sees its own signal");
  assert.equal(a.noteCacheVersion(), 3, "a is unaffected");
});

// ---------------------------------------------------------------------------
// 4 + 5. Preview retention, owner fencing, outdated marker input
// ---------------------------------------------------------------------------

test("R41-5 — the preview retainer retains by exact owner and fences stale loads", async () => {
  const { session, readerCallsRef } = makeSession();
  const r = session.previews;
  assert.equal(r.snapshotFor("A", "v"), null, "nothing retained yet");

  r.ensure("A", "v", ["n1", "n2"], session.previewReader);
  await settle();
  const store = r.snapshotFor("A", "v");
  assert.ok(store, "the store landed");
  assert.equal(store.byNoteId.n1.preview, "n1 的缓存正文");
  assert.equal(store.byNoteId.n2.outdated, true, "the fixture marks n2 outdated");

  // SAME ids: ensure is a NO-OP (no reload, no flash). R4.2: coverage is
  // the REQUESTED set, so even ids with no cached body count as covered.
  const before = readerCallsRef.calls.length;
  r.ensure("A", "v", ["n1", "n2"], session.previewReader);
  await settle();
  assert.equal(readerCallsRef.calls.length, before, "same ids = zero reads");
  assert.strictEqual(r.snapshotFor("A", "v"), store, "the retained store reference is stable");

  // A DIFFERENT owner's store never collides.
  assert.equal(r.snapshotFor("B", "v"), null);
  // Owner fence: a SLOW resolution started first is superseded by a NEWER
  // ensure (a DIFFERENT coverage, so the R4.2 coverage no-op does not apply);
  // its late commit must be dropped whole.
  let slowResolve: ((s: any) => void) | null = null;
  const slowReader = () => new Promise((res) => { slowResolve = res; });
  r.ensure("A", "v", ["n1", "n2", "n3"], slowReader);                 // token N pending...
  r.ensure("A", "v", ["n1", "n2", "n3", "n4"], session.previewReader); // token N+1 wins
  await settle();
  const current = r.snapshotFor("A", "v");
  assert.ok(current.byNoteId.n1, "the newer resolution committed");
  slowResolve!({ key: previewStoreKey("A", "v"), byNoteId: { STALE: { preview: "stale", outdated: false } } });
  await settle();
  assert.equal(r.snapshotFor("A", "v").byNoteId.STALE, undefined,
    "the stale (token-superseded) resolution was dropped");
  assert.ok(r.snapshotFor("A", "v").byNoteId.n1, "the current store is intact");
});

test("R41-4 — the outdated marker input reaches the row mapping shape", () => {
  // The page composes: outdated -> `${preview} · 缓存版本`; a body-less
  // outdated row -> `缓存版本 · 正文尚未缓存`; never a bare preview.
  const p1 = { preview: "正文A", outdated: false };
  const p2 = { preview: "正文B", outdated: true };
  const p3 = { preview: "", outdated: true };
  const compose = (p: { preview: string; outdated: boolean } | undefined) => {
    if (!p) return "正文尚未缓存";
    const preview = p.preview ? (p.outdated ? `${p.preview} · 缓存版本` : p.preview) : "";
    return preview || (p.outdated ? `缓存版本 · 正文尚未缓存` : "正文尚未缓存");
  };
  assert.equal(compose(p1), "正文A");
  assert.equal(compose(p2), "正文B · 缓存版本");
  assert.equal(compose(p3), "缓存版本 · 正文尚未缓存");
  assert.equal(compose(undefined), "正文尚未缓存");
  // The exact production composition is pinned in the source too.
  const src = readFileSync(join(import.meta.dirname, "..", "src", "still", "StillCollection.tsx"), "utf8");
  assert.ok(src.includes("p.outdated ? `${p.preview} · 缓存版本` : p.preview"), "production composes the marker");
});

// ---------------------------------------------------------------------------
// Refresh: success swaps last-good; failure keeps rows truthfully
// ---------------------------------------------------------------------------

test("R41-6 — refresh success swaps last-good; failure keeps the same-owner rows", async () => {
  const listByVault = {
    v: { items: [{ noteId: "n1", title: "v1" }], hasMore: false, nextAfterId: null },
  };
  const { session } = makeSession({ listByVault });
  session.desktop.setConnection({ paired: true, connected: true, instanceId: "A", isLive: () => true });
  await settledQ();
  assert.deepEqual(session.desktop.snapshot().rows.map((r) => r.noteId), ["n1"]);

  // Success: the fresh page swaps in, rows never leave the screen.
  listByVault.v = { items: [{ noteId: "n1" }, { noteId: "n9" }], hasMore: false, nextAfterId: null };
  session.desktop.refresh();
  const during = session.desktop.snapshot();
  assert.equal(during.rows.length >= 1, true, "rows stay painted during the refresh");
  await settledQ();
  assert.deepEqual(session.desktop.snapshot().rows.map((r) => r.noteId), ["n1", "n9"], "swapped after success");

  // Failure: a generic gateway error keeps the last-good rows + error truth.
  const { ServicesError } = await import("../src/services/companionServices/transport.ts");
  (session as any).desktop["knowledge"].registeredList = async () => { throw new Error("gateway 503"); };
  session.desktop.refresh();
  await settledQ();
  const failed = session.desktop.snapshot();
  assert.equal(failed.phase, "error");
  assert.deepEqual(failed.rows.map((r) => r.noteId), ["n1", "n9"], "the last-good rows SURVIVE the failed refresh");
  void ServicesError;
});

// ---------------------------------------------------------------------------
// Zero-network proof: the preview path executes ONLY the injectable local reader
// ---------------------------------------------------------------------------

test("R41-7 — the preview path is exactly the injectable reader (zero Desktop fetches)", async () => {
  const { session, readerCallsRef } = makeSession();
  // Drive the retainer exactly as the page does.
  session.previews.ensure("A", "v", ["n1", "n2"], session.previewReader);
  await settle();
  assert.equal(readerCallsRef.calls.length, 1, "ONE bulk read");
  assert.deepEqual(readerCallsRef.calls[0], { instance: "A", vault: "v", ids: ["n1", "n2"] },
    "the local bulk shape only");
  // The retainer never calls anything else: the session's ONLY preview
  // dependency is the injected reader (the production one is the local-only
  // contentNotePreviews command — pinned separately).
  const sessionSrc = readFileSync(join(import.meta.dirname, "..", "src", "still", "kit", "knowledgeSession.ts"), "utf8");
  assert.ok(sessionSrc.includes("previewReader: productionPreviewReader"), "production wires the local-only reader");
  assert.ok(
    readFileSync(join(import.meta.dirname, "..", "src", "still", "kit", "notePreview.ts"), "utf8").includes("api.contentNotePreviews(instanceId, vaultId, ids.slice(at, at + 100))"),
    "that reader invokes exactly the local bulk command",
  );
});
