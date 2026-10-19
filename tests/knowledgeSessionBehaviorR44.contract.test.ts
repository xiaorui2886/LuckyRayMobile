// SERVICES-KNOWLEDGE-BROWSE-R1 REPAIR-R4.4 — CURRENTNESS/PREVIEW DECOUPLING.
//
// The coarse Desktop-domain dataStore version (bumped by EVERY sync/note/
// material/cache commit) was feeding the active-vault currentness machinery:
// opening a Desktop note and backing out bumped it, which re-gated the
// retained list and re-ran vaults+registeredList — recreating the user's
// original "回来就要加载" complaint. The decoupling:
//   - the synchronous gate is owner + connection ONLY;
//   - the dataStore signal survives ONLY as note-cache freshness for the
//     local preview bulk store;
//   - canonical list refresh stays owned by owner/pairing change, connection
//     flips, query changes, and the explicit user Refresh.
//
// These tests drive the REAL session/controller/retainer through the exact
// user path and the generic-bump paths.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createKnowledgeSession } from "../src/still/kit/knowledgeSession.ts";
import { previewStoreKey } from "../src/still/kit/notePreview.ts";

const tick = () => new Promise((r) => setImmediate(r));
const settle = async (n = 8) => { for (let i = 0; i < n; i += 1) await tick(); };
const settledQ = () => new Promise((r) => setTimeout(r, 420));

const VAULT = { vaultId: "v", displayName: "V", activeInDesktop: true, readGranted: true };

function makeSession(over: { withBody?: (id: string) => boolean } = {}) {
  const withBody = over.withBody ?? (() => true);
  let vaultCalls = 0;
  let listCalls = 0;
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
    vaults: async () => { vaultCalls += 1; return { items: [VAULT] }; },
    registeredList: async () => {
      listCalls += 1;
      return { items: [{ noteId: "n1" }, { noteId: "n2" }], hasMore: false, nextAfterId: null };
    },
  };
  const readerCalls: Array<{ instance: string; vault: string; ids: string[] }> = [];
  const previewReader = async (instance: string, vault: string, ids: string[]) => {
    readerCalls.push({ instance, vault, ids });
    const byNoteId: Record<string, { preview: string; outdated: boolean }> = {};
    for (const id of ids) if (withBody(id)) byNoteId[id] = { preview: `${id} 正文`, outdated: false };
    return { key: previewStoreKey(instance, vault), byNoteId };
  };
  const session = createKnowledgeSession({ registry, knowledge, previewReader } as never);
  return { session, readerCalls, counts: () => ({ vaultCalls, listCalls }) };
}

const online = (instanceId: string) => ({ paired: true, connected: true, instanceId, isLive: () => true });

// ---------------------------------------------------------------------------
// The USER path: READY -> open note -> note-cache bump -> Back
// ---------------------------------------------------------------------------

test("R44-1 — note detail bump: ZERO vault/list calls, list retained, preview reread ONCE, body appears", async () => {
  let n1HasBody = false;
  const { session, readerCalls, counts } = makeSession({ withBody: (id) => (id === "n1" ? n1HasBody : true) });

  // READY, certified list under the coarse version 7.
  session.desktop.setConnection(online("A"));
  await settledQ();
  assert.equal(session.desktop.snapshot().phase, "ready");
  const afterLoad = counts();
  assert.equal(afterLoad.vaultCalls, 1);
  assert.equal(afterLoad.listCalls, 1);

  // The page's preview effect under freshness 7.
  session.observeNoteCacheVersion(7);
  session.previews.ensure("A", "v", ["n1", "n2"], session.previewReader, session.noteCacheVersion());
  await settle();
  assert.equal(readerCalls.length, 1);
  assert.equal(session.previews.snapshotFor("A", "v").byNoteId.n1, undefined, "n1 shows 正文尚未缓存");

  // ---- The user opens n1; its detail refresh caches the body; backing out
  // ---- bumps the coarse dataStore. The page's ONLY reaction is preview
  // ---- freshness — the gated view keeps the retained list SYNCHRONOUSLY.
  n1HasBody = true;
  session.observeNoteCacheVersion(8); // dataStore.bump() from the note cleanup
  const view = session.desktopViewFor({ paired: true, connected: true, instanceId: "A" });
  assert.equal(view.phase, "ready", "NO waiting/loading from the note-cache bump");
  assert.equal(view.rows.length, 2, "the SAME retained list rows are still visible");
  assert.strictEqual(view, session.desktop.snapshot(), "the retained snapshot object itself (scroll state intact)");

  // The preview effect fires with the new freshness: ONE local bulk reread.
  session.previews.ensure("A", "v", ["n1", "n2"], session.previewReader, session.noteCacheVersion());
  await settle();
  assert.equal(readerCalls.length, 2, "preview reread exactly once");
  assert.ok(session.previews.snapshotFor("A", "v").byNoteId.n1, "the newly cached body is in the preview store");

  // And ZERO canonical traffic was caused by the bump.
  const after = counts();
  assert.equal(after.vaultCalls, 1, "zero knowledge.vaults calls from the bump");
  assert.equal(after.listCalls, 1, "zero registeredList calls from the bump");

  // Unchanged return after absorption: zero again.
  session.previews.ensure("A", "v", ["n1", "n2"], session.previewReader, session.noteCacheVersion());
  await settle();
  assert.equal(readerCalls.length, 2);
});

test("R44-2 — an UNRELATED generic dataStore bump never re-lists Knowledge", async () => {
  const { session, counts } = makeSession();
  session.desktop.setConnection(online("A"));
  await settledQ();
  const afterLoad = counts();

  // A material/sync/asset-cache commit bumped the global store (7 -> 99).
  session.observeNoteCacheVersion(99);
  const view = session.desktopViewFor({ paired: true, connected: true, instanceId: "A" });
  assert.equal(view.phase, "ready", "the retained list stays READY");
  assert.equal(view.rows.length, 2);

  // Give any hypothetical async path a chance; nothing canonical fires.
  await settledQ();
  const after = counts();
  assert.equal(after.vaultCalls, afterLoad.vaultCalls, "zero vaults calls");
  assert.equal(after.listCalls, afterLoad.listCalls, "zero list calls");
});

test("R44-3 — explicit Refresh still performs ONE real canonical fresh load", async () => {
  const { session, counts } = makeSession();
  session.desktop.setConnection(online("A"));
  await settledQ();
  const afterLoad = counts();

  // The user taps Refresh: refresh() is stale-while-revalidate.
  session.desktop.refresh();
  const during = session.desktop.snapshot();
  assert.ok(during.rows.length >= 1, "rows stay painted during the refresh");
  await settledQ();
  const after = counts();
  assert.equal(after.vaultCalls, afterLoad.vaultCalls + 1, "one fresh discover");
  assert.equal(after.listCalls, afterLoad.listCalls + 1, "one fresh list");
  assert.equal(session.desktop.snapshot().phase, "ready");
});

test("R44-4 — real owner change and offline still fail closed / refresh", async () => {
  const { session } = makeSession();
  session.desktop.setConnection(online("A"));
  await settledQ();

  // Offline truth still gates the first frame (R4.2 semantics preserved).
  const off = session.desktopViewFor({ paired: true, connected: false, instanceId: "A" });
  assert.equal(off.phase, "offline");

  // Owner change still isolates (R4.1 semantics preserved).
  const other = session.desktopViewFor({ paired: true, connected: true, instanceId: "B" });
  assert.equal(other.rows.length, 0);
  assert.equal(other.instanceId, "B");

  // Reconnect (offline -> online flip via setConnection) still re-lists once.
  session.desktop.setConnection({ paired: true, connected: false, instanceId: "A", isLive: () => true });
  await settle();
  session.desktop.setConnection(online("A"));
  await settledQ();
  assert.equal(session.desktop.snapshot().phase, "ready");
});

// ---------------------------------------------------------------------------
// Production wiring: the coarse signal feeds ONLY preview freshness
// ---------------------------------------------------------------------------

test("R44-5 — the page no longer wires dataStore into any vault-currentness path", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "src", "still", "StillCollection.tsx"), "utf8");
  // No activeVaultChanged call remains in the page (the only remaining owners
  // are owner/pairing/connection/refresh paths in the controller itself).
  assert.ok(!src.includes("desktopCtrl.activeVaultChanged("),
    "no dataStore-driven activeVaultChanged() in the page");
  // No desktop-version certification calls remain.
  for (const gone of ["observeDesktopVersion", "desktopDriftPending", "markDesktopDriftActioned", "certifyDesktop"]) {
    assert.ok(!src.includes(gone), `${gone} is gone from the page`);
  }
  // The coarse signal's ONLY use is preview freshness.
  assert.ok(src.includes("session.observeNoteCacheVersion(desktopVersion)"),
    "dataStore feeds note-cache freshness for previews only");
  // The gate input is owner + connection only.
  assert.ok(src.includes("session.desktopViewFor({ paired, connected, instanceId })"),
    "the synchronous gate no longer receives a version");
});

test("R44-6 — the session API no longer exposes dataStore-as-vault-currentness", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "src", "still", "kit", "knowledgeSession.ts"), "utf8");
  for (const gone of ["observeDesktopVersion", "desktopDriftPending", "markDesktopDriftActioned", "certifyDesktop"]) {
    assert.ok(!src.includes(gone), `${gone} removed from the session surface`);
  }
  assert.ok(src.includes("observeNoteCacheVersion"), "note-cache freshness remains (previews only)");
});
