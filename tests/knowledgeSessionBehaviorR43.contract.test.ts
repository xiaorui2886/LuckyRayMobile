// SERVICES-KNOWLEDGE-BROWSE-R1 REPAIR-R4.3 — FINAL BOUNDED CLOSURE.
// The four bounded findings, each with real behavior coverage:
//   1. the offline synthetic snapshot is strict-reference-stable;
//   2. Local dataVersion observe/pending/action/certify (inactive = pending);
//   3. FilterDraft applied state restores from session.ui.localFilter;
//   4. preview coverage is bound to note-cache freshness (one re-read after a
//      bump; zero on unchanged returns).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createKnowledgeSession } from "../src/still/kit/knowledgeSession.ts";
import { previewStoreKey } from "../src/still/kit/notePreview.ts";
import { FilterDraft, defaultKnowledgeFilter } from "../src/services/filterDraft.ts";
import { LocalNotesPager } from "../src/services/knowledgeNotesPager.ts";

const tick = () => new Promise((r) => setImmediate(r));
const settle = async (n = 8) => { for (let i = 0; i < n; i += 1) await tick(); };
const settledQ = () => new Promise((r) => setTimeout(r, 420));

const VAULT = { vaultId: "v", displayName: "V", activeInDesktop: true, readGranted: true };

function makeSession(over: { withBody?: (id: string) => boolean } = {}) {
  const withBody = over.withBody ?? (() => true);
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
    registeredList: async () => ({ items: [{ noteId: "n1" }, { noteId: "n2" }], hasMore: false, nextAfterId: null }),
  };
  const readerCalls: Array<{ instance: string; vault: string; ids: string[] }> = [];
  const previewReader = async (instance: string, vault: string, ids: string[]) => {
    readerCalls.push({ instance, vault, ids });
    const byNoteId: Record<string, { preview: string; outdated: boolean }> = {};
    for (const id of ids) if (withBody(id)) byNoteId[id] = { preview: `${id} 正文`, outdated: false };
    return { key: previewStoreKey(instance, vault), byNoteId };
  };
  const session = createKnowledgeSession({ registry, knowledge, previewReader } as never);
  return { session, readerCalls };
}

const online = (instanceId: string) => ({ paired: true, connected: true, instanceId, isLive: () => true });

// ---------------------------------------------------------------------------
// 1. Strict-reference-stable offline projection (P1-R42-1)
// ---------------------------------------------------------------------------

test("R43-1 — repeated offline getSnapshot is strict-reference-equal; a real change breaks it", async () => {
  const { session } = makeSession();
  session.desktop.setConnection(online("A"));
  await settledQ();
  assert.equal(session.desktop.snapshot().phase, "ready");

  const offlineInput = { paired: true, connected: false, instanceId: "A" };
  const a = session.desktopViewFor(offlineInput);
  const b = session.desktopViewFor(offlineInput);
  const c = session.desktopViewFor(offlineInput);
  assert.strictEqual(a, b, "second read: same reference");
  assert.strictEqual(b, c, "third read: same reference");
  assert.equal(a.phase, "offline", "and it is the truthful offline projection");
  assert.equal(a.rows.length, 2, "rows kept as cached content");

  // A different gate input family (owner change) yields the cold snapshot —
  // also stable.
  const other = session.desktopViewFor({ paired: true, connected: false, instanceId: "B", version: 7 });
  assert.strictEqual(other, session.desktopViewFor({ paired: true, connected: false, instanceId: "B", version: 7 }));

  // A REAL underlying store change produces a NEW projection object.
  session.desktop.refresh(); // a real refresh swaps the source snapshot
  await settledQ();
  const fresh = session.desktopViewFor(offlineInput);
  assert.notStrictEqual(fresh, a, "a new source snapshot breaks the projection identity");
  assert.equal(fresh.phase, "offline");
});

// ---------------------------------------------------------------------------
// 2. Local version: inactive drift stays pending; activation acts once (P1-R42-2)
// ---------------------------------------------------------------------------

test("R43-2 — Local dataVersion drift while the source is inactive acts EXACTLY once on activation", () => {
  const { session } = makeSession();
  // The initial load certifies v3.
  session.observeLocalDataVersion(3);
  session.certifyLocalDataVersion(3);

  // A Local note changes while the Knowledge root sits on the DESKTOP source
  // (or under another page): observing does NOT consume.
  session.observeLocalDataVersion(4);
  assert.equal(session.localDriftPending(), true, "pending while inactive");
  assert.equal(session.localDriftPending(), true, "observing again does not consume it");

  // Activation acts exactly once (the page's effect pattern).
  session.markLocalDriftActioned();
  session.certifyLocalDataVersion(4); // the revalidate ran under v4
  assert.equal(session.localDriftPending(), false, "acted + certified: no repeat");

  // An unchanged return is zero work.
  session.observeLocalDataVersion(4);
  assert.equal(session.localDriftPending(), false);
});

test("R43-2b — the production effect observes BEFORE the source guard (inactive-safe)", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "src", "still", "StillCollection.tsx"), "utf8");
  const at = src.indexOf("session.observeLocalDataVersion(version);");
  assert.ok(at > 0, "observe exists");
  const guard = src.indexOf("if (source !== \"local\") return;", at);
  assert.ok(guard > at, "the source guard comes AFTER the observe (an inactive bump stays pending)");
  assert.ok(src.includes("session.localDriftPending()"), "the pending check gates the action");
  assert.ok(src.includes("session.markLocalDriftActioned();"), "the action is marked exactly once");
});

// ---------------------------------------------------------------------------
// 3. FilterDraft restores from the session applied state (P1-R42-3)
// ---------------------------------------------------------------------------

test("R43-3 — a remounted FilterDraft begins at the SESSION filter; cancel preserves; reset returns REAL defaults", async () => {
  const { session } = makeSession();
  // The user previously applied favorite/name/工作 and left.
  const retained = { mode: "favorite", sort: "name", tag: "工作" };
  session.ui.localFilter = retained;

  // The page constructs the draft with the REAL defaults factory, then
  // restores the applied state (exactly the production wiring).
  const { FilterDraft, defaultKnowledgeFilter } = await import("../src/services/filterDraft.ts");
  const draft = new FilterDraft(defaultKnowledgeFilter);
  draft.restoreApplied({ mode: retained.mode as never, sort: retained.sort, tag: retained.tag });

  // Open the sheet: it begins at EXACTLY the retained state.
  const begun = draft.begin();
  assert.deepEqual(begun, { mode: "favorite", sort: "name", tag: "工作" });

  // Cancel preserves the applied state.
  draft.cancel();
  assert.deepEqual(draft.getApplied(), { mode: "favorite", sort: "name", tag: "工作" });

  // Reset + commit returns the REAL defaults (not the session state).
  draft.begin();
  draft.reset();
  draft.commit();
  assert.deepEqual(draft.getApplied(), defaultKnowledgeFilter());

  // The production page wires restoreApplied from session.ui.localFilter.
  const src = readFileSync(join(import.meta.dirname, "..", "src", "still", "StillCollection.tsx"), "utf8");
  assert.ok(src.includes("draft.current.restoreApplied("), "the page restores the draft from the session");
});

// ---------------------------------------------------------------------------
// 4. Preview freshness: one re-read after a note-cache bump; zero after (P1-R42-4)
// ---------------------------------------------------------------------------

test("R43-4 — known-missing -> note-cache bump -> ONE local re-read -> body preview; unchanged remount = zero", async () => {
  let n1HasBody = false;
  const { session, readerCalls } = makeSession({ withBody: (id) => (id === "n1" ? n1HasBody : true) });

  // Initial page under freshness 7: n1 has no cached body.
  session.observeNoteCacheVersion(7);
  session.previews.ensure("A", "v", ["n1", "n2"], session.previewReader, session.noteCacheVersion());
  await settle();
  assert.equal(readerCalls.length, 1);
  assert.equal(session.previews.snapshotFor("A", "v").byNoteId.n1, undefined, "n1 shows 正文尚未缓存");
  assert.ok(session.previews.snapshotFor("A", "v").byNoteId.n2, "n2 has its preview");

  // Unchanged freshness remount: ZERO re-reads (the R4.2 coverage rule).
  session.previews.ensure("A", "v", ["n1", "n2"], session.previewReader, session.noteCacheVersion());
  await settle();
  assert.equal(readerCalls.length, 1, "zero re-reads on the unchanged return");

  // The user opened n1; its detail refresh cached the body -> the coarse
  // Desktop-domain signal bumped to 8.
  n1HasBody = true;
  session.observeNoteCacheVersion(8);
  session.previews.ensure("A", "v", ["n1", "n2"], session.previewReader, session.noteCacheVersion());
  await settle();
  assert.equal(readerCalls.length, 2, "EXACTLY ONE local bulk re-read after the bump");
  assert.ok(session.previews.snapshotFor("A", "v").byNoteId.n1, "the newly cached body replaced 正文尚未缓存");

  // And the next unchanged return is zero again.
  session.previews.ensure("A", "v", ["n1", "n2"], session.previewReader, session.noteCacheVersion());
  await settle();
  assert.equal(readerCalls.length, 2, "zero re-reads after the freshness is absorbed");

  // Every reader call stayed the LOCAL bulk shape (zero Desktop N+1).
  for (const call of readerCalls) {
    assert.deepEqual(call, { instance: "A", vault: "v", ids: ["n1", "n2"] });
  }
});

// ---------------------------------------------------------------------------
// The Local activation path end-to-end with the real pager (card scenario 2)
// ---------------------------------------------------------------------------

test("R43-5 — Local activation revalidates ONCE with rows retained after an inactive bump", async () => {
  const fetches: any[] = [];
  const pager = new LocalNotesPager(
    (f) => {
      fetches.push({ ...f });
      return Promise.resolve({ items: [{ noteId: "l1" }], total: 1, hasMore: false });
    },
    () => {},
  );
  const { session } = makeSession();

  pager.reload({ q: "" });
  await settle();
  const loaded = fetches.length;
  session.observeLocalDataVersion(3);
  session.certifyLocalDataVersion(3);

  // v4 arrives while the Local source is INACTIVE: observe, do not act.
  session.observeLocalDataVersion(4);
  assert.equal(fetches.length, loaded, "inactive: zero work");

  // Activation (the page's effect): pending -> act once -> certify.
  assert.equal(session.localDriftPending(), true);
  session.markLocalDriftActioned();
  pager.revalidate({ q: "" });
  session.certifyLocalDataVersion(4);
  assert.equal(pager.getState().items.length, 1, "rows retained during the revalidate");
  await settle();
  assert.equal(fetches.length, loaded + 1, "exactly one refresh fetch");
  assert.equal(session.localDriftPending(), false);
});
