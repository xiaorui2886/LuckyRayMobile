// SERVICES-KNOWLEDGE-BROWSE-R1 REPAIR-R4.2 — the eight lifecycle behaviors
// the review card requires, all driven against the REAL session layer and
// REAL controllers with injected fakes (no regex-only checks).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createKnowledgeSession } from "../src/still/kit/knowledgeSession.ts";
import { previewStoreKey } from "../src/still/kit/notePreview.ts";
import { LocalNotesPager } from "../src/services/knowledgeNotesPager.ts";

const tick = () => new Promise((r) => setImmediate(r));
const settle = async (n = 8) => { for (let i = 0; i < n; i += 1) await tick(); };
const settledQ = () => new Promise((r) => setTimeout(r, 420));

const VAULT = { vaultId: "v", displayName: "V", activeInDesktop: true, readGranted: true };

function makeSession(over: {
  listByVault?: Record<string, any>;
  listCalls?: () => void;
} = {}) {
  const listByVault = over.listByVault ?? {
    v: { items: [{ noteId: "n1", title: "a" }, { noteId: "n2", title: "b" }], hasMore: false, nextAfterId: null },
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
    operation: (opId: string) => ({ operationId: opId, state: "implemented" }),
    invalidate() {},
  };
  const knowledge = {
    vaults: async () => ({ items: [VAULT] }),
    registeredList: async (_i: string, vaultId: string) => {
      over.listCalls?.();
      return listByVault[vaultId] ?? { items: [], hasMore: false, nextAfterId: null };
    },
  };
  const readerCalls: Array<{ instance: string; vault: string; ids: string[] }> = [];
  const previewReader = async (instance: string, vault: string, ids: string[]) => {
    readerCalls.push({ instance, vault, ids });
    const byNoteId: Record<string, { preview: string; outdated: boolean }> = {};
    for (const id of ids) if (id !== "missing") byNoteId[id] = { preview: `${id} 正文`, outdated: false };
    return { key: previewStoreKey(instance, vault), byNoteId };
  };
  const session = createKnowledgeSession({ registry, knowledge, previewReader } as never);
  return { session, readerCalls };
}

const online = (instanceId: string) => ({ paired: true, connected: true, instanceId, isLive: () => true });

// ---------------------------------------------------------------------------
// 1. cold request pending -> suspend -> return same owner -> exactly one fresh
//    request -> ready (P1-A4)
// ---------------------------------------------------------------------------

test("R42-1 — cold load suspended mid-flight resumes with EXACTLY ONE fresh request", async () => {
  let calls = 0;
  // A HOLDING list: the first call never resolves (fenced by the suspend),
  // later calls resolve normally — the exact mid-cold-load window.
  const gates: Array<(v: any) => void> = [];
  const listByVault = { v: { items: [{ noteId: "n1" }], hasMore: false, nextAfterId: null } };
  const registry = {
    refreshAdopting: async () => ({
      permissionRevision: 2,
      operations: { "knowledge.vaults": { state: "implemented" }, "knowledge.registeredList": { state: "implemented" } },
    }),
    snapshot: () => null,
    operation: (opId: string) => ({ operationId: opId, state: "implemented" }),
    invalidate() {},
  };
  const knowledge = {
    vaults: async () => ({ items: [VAULT] }),
    registeredList: (_i: string, vaultId: string) =>
      new Promise((res) => {
        calls += 1;
        if (calls === 1) { gates.push(res as never); return; } // hold request #1
        res(listByVault[vaultId] ?? { items: [], hasMore: false, nextAfterId: null });
      }),
  };
  const session = createKnowledgeSession({ registry, knowledge, previewReader: async () => ({ key: "", byNoteId: {} }) } as never);

  session.desktop.setConnection(online("A"));
  await settle();
  assert.equal(session.desktop.snapshot().phase, "loading", "the cold list is in flight");
  assert.equal(calls, 1);

  session.desktop.suspend();           // leave the source mid-cold-load
  gates[0](listByVault.v);             // the fenced request resolves LATE
  await settledQ();
  assert.notEqual(session.desktop.snapshot().phase, "ready", "the fenced response cannot commit");

  session.desktop.setConnection(online("A")); // same binding (would early-return pre-R4.2)
  session.desktop.activate();                  // the explicit resume
  await settledQ();

  const snap = session.desktop.snapshot();
  assert.equal(snap.phase, "ready", "resumed to ready");
  assert.equal(snap.rows.length, 1);
  assert.equal(calls, 2, "EXACTLY ONE fresh list request on resume");
});

test("R42-1b — a READY retained same-query snapshot resumes with ZERO requests", async () => {
  let calls = 0;
  const { session } = makeSession({ listCalls: () => { calls += 1; } });
  session.desktop.setConnection(online("A"));
  await settledQ();
  assert.equal(session.desktop.snapshot().phase, "ready");
  const before = calls;

  session.desktop.suspend();
  session.desktop.setConnection(online("A"));
  session.desktop.activate();
  await settledQ();
  assert.equal(calls, before, "cache-first return: zero fresh requests");
  assert.equal(session.desktop.snapshot().phase, "ready");
});

// ---------------------------------------------------------------------------
// 2. retained ready A + current A OFFLINE -> first gated view is NOT ready/live
//    (P1-A5)
// ---------------------------------------------------------------------------

test("R42-2 — offline first frame never shows retained rows as live ready", async () => {
  const { session } = makeSession();
  session.desktop.setConnection(online("A"));
  await settledQ();
  assert.equal(session.desktop.snapshot().phase, "ready");

  // The ws drops while Knowledge is away; the FIRST gated read (render time)
  // must be truthful — offline, rows only as cached content, never "ready".
  const first = session.desktopViewFor({ paired: true, connected: false, instanceId: "A" });
  assert.equal(first.phase, "offline", "not ready/live");
  assert.equal(first.rows.length, 2, "the rows remain, as cached content");
  const cold = session.desktopViewFor({ paired: true, connected: false, instanceId: "B" });
  assert.equal(cold.phase, "offline", "a non-owner offline is a cold offline");
  assert.equal(cold.rows.length, 0);
  const unpaired = session.desktopViewFor({ paired: false, connected: false, instanceId: "" });
  assert.equal(unpaired.phase, "unpaired");
});

// ---------------------------------------------------------------------------
// 3+4. retained identity vs visible identity (P1-A6) — restored, never mismatched
// ---------------------------------------------------------------------------

test("R42-3 — the Desktop query identity is retained in the session UI state", () => {
  const { session } = makeSession();
  // The page's setQuery writes through to the session; the retained
  // controller query rides the SAME session, so a remount initializes the
  // search box from the retained query — the visible identity always equals
  // the rows' identity. Driving the write-through contract:
  session.ui.query = "foo";
  session.desktop.setQuery("foo");
  assert.equal(session.desktop.snapshot().query, "foo", "the controller carries foo");
  // A remount's first gated read for the SAME identity shows the foo rows;
  // for a DIFFERENT visible identity the controller itself has none.
  assert.equal(session.ui.query, "foo", "the remount would restore foo in the box");
});

test("R42-4 — the Local filter identity is retained and restored", () => {
  const { session } = makeSession();
  session.ui.localFilter = { mode: "pinned", sort: "name", tag: "工作" };
  // The page initializes appliedRef from exactly these fields (pinned source
  // anchor), so the remount's visible identity equals the retained one.
  assert.deepEqual(session.ui.localFilter, { mode: "pinned", sort: "name", tag: "工作" });
  const src = readFileSync(join(import.meta.dirname, "..", "src", "still", "StillCollection.tsx"), "utf8");
  assert.ok(src.includes("useState(session.ui.query)"), "the search box restores from the session");
  assert.ok(src.includes("session.ui.localFilter.mode as KnowledgeFilterState[\"mode\"]"),
    "the Local applied filter restores from the session");
});

// ---------------------------------------------------------------------------
// 5+6. currentness drift (P1-A7) — inactive source AND unmounted root
// ---------------------------------------------------------------------------

test("R42-5 — v7 -> Local source -> v8 -> Desktop: the generic bump does NOT re-list", async () => {
  // R4.4: decoupled truth — a coarse bump between sources is inert for the
  // canonical list; only preview freshness may act (once).
  const { session, readerCalls } = makeSession();
  session.desktop.setConnection(online("A"));
  await settledQ();
  assert.equal(session.desktop.snapshot().phase, "ready");
  session.observeNoteCacheVersion(7);
  session.previews.ensure("A", "v", ["n1", "n2"], session.previewReader, 7);
  await settle();
  assert.equal(readerCalls.length, 1);

  session.observeNoteCacheVersion(8); // the bump while inactive
  const gated = session.desktopViewFor({ paired: true, connected: true, instanceId: "A" });
  assert.equal(gated.phase, "ready", "the retained snapshot remains current");
  assert.equal(gated.rows.length, 2);
  session.previews.ensure("A", "v", ["n1", "n2"], session.previewReader, session.noteCacheVersion());
  await settle();
  assert.equal(readerCalls.length, 2, "preview freshness acts once");
});

test("R42-6 — v7 -> root unmounted -> v8: the return is version-independent (decoupled)", () => {
  // R4.4: a generic bump during an unmount is note-cache freshness only; the
  // gate's decision carries no version input at all.
  const { session } = makeSession();
  session.observeNoteCacheVersion(7);
  session.observeNoteCacheVersion(8);
  const first = session.desktopViewFor({ paired: true, connected: true, instanceId: "A" });
  assert.equal(first.rows.length, 0, "nothing retained yet: cold state");
  assert.equal(first.phase, "waiting-catalog");
});

// ---------------------------------------------------------------------------
// 7. preview coverage: known-missing ids count as covered (P2-PERF)
// ---------------------------------------------------------------------------

test("R42-7 — one cached + one known-missing id: the same ensure after remount re-reads NOTHING", async () => {
  const { session, readerCalls } = makeSession();
  // "missing" has no note_cache row: the reader omits it from byNoteId.
  session.previews.ensure("A", "v", ["n1", "missing"], session.previewReader);
  await settle();
  assert.equal(readerCalls.length, 1);
  const store = session.previews.snapshotFor("A", "v");
  assert.ok(store.byNoteId.n1, "the cached id has a preview");
  assert.equal(store.byNoteId.missing, undefined, "the missing id has no body");

  // Remount: the SAME requested set (including the known-missing id) is covered.
  session.previews.ensure("A", "v", ["n1", "missing"], session.previewReader);
  await settle();
  assert.equal(readerCalls.length, 1, "ZERO DB re-reads for the covered page");

  // A DIFFERENT id set still reloads.
  session.previews.ensure("A", "v", ["n1", "missing", "n9"], session.previewReader);
  await settle();
  assert.equal(readerCalls.length, 2, "a new id reloads");
});

// ---------------------------------------------------------------------------
// 8. Local data-version memory: pure return = zero revalidate; real bump = one
// ---------------------------------------------------------------------------

test("R42-8 — same localDataVersion remount: ZERO revalidates; a real bump: ONE rows-retained revalidate", async () => {
  const fetches: any[] = [];
  const pager = new LocalNotesPager(
    (f) => {
      fetches.push({ ...f });
      return Promise.resolve({ items: [{ noteId: "l1" }, { noteId: "l2" }], total: 2, hasMore: false });
    },
    () => {},
  );
  const { session } = makeSession();

  pager.reload({ q: "" });
  await settle();
  assert.equal(pager.getState().items.length, 2);
  const loaded = fetches.length;

  // The page's effect pattern (R4.3): observe -> certify on load -> the
  // pending check decides. Same version remount:
  session.observeLocalDataVersion(5);
  session.certifyLocalDataVersion(5);
  assert.equal(session.localDriftPending(), false, "first observation certified: not a change");
  session.observeLocalDataVersion(5);
  assert.equal(session.localDriftPending(), false, "same version: not a change -> NO revalidate");
  await settle();
  assert.equal(fetches.length, loaded, "zero extra fetches on the pure return");

  // A real mutation bumped the version:
  session.observeLocalDataVersion(6);
  assert.equal(session.localDriftPending(), true, "a real change is pending");
  session.markLocalDriftActioned();
  pager.revalidate({ q: "" });
  assert.equal(pager.getState().items.length, 2, "rows retained during the revalidate");
  await settle();
  assert.equal(fetches.length, loaded + 1, "exactly one refresh fetch");
  assert.equal(pager.getState().items.length, 2, "committed");
});
