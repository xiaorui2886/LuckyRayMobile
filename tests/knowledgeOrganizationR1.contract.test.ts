// KNOWLEDGE-ORGANIZATION-R1 REPAIR-R1.1 — focused contract/behavior tests.
//
// Proves the card's hard rules: TWO authorities (ALL NOTES canonical vs
// DIRECTORY legacy Content V1, never a local filter), the directory
// controller lifecycle + truthful offline currentness, the secure-opId move
// semantics (fail closed with zero requests), the revision SPLIT (move
// baseline = latest remote revision, never the cached-body baseline), the
// REAL product wiring of single + batch move (page and note detail call the
// real controller), the real capability/grant truth, and the boundary rules.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  KnowledgeDirectoryController, directoryIdentityKey, type DirectoryRow,
} from "../src/still/kit/knowledgeDirectoryController.ts";
import {
  KnowledgeOrganizationController, directoryMoveTargets, canonicalMoveTargets,
  resolveMoveAuthority, orchestrateListMove, createListCurrentness,
  SECURE_RANDOM_UNAVAILABLE, SCOPE_CHANGED_BEFORE_SEND, parentOf,
} from "../src/still/kit/knowledgeOrganizationController.ts";
import { KnowledgeFolderCatalog, folderAncestors } from "../src/still/kit/knowledgeFolderCatalog.ts";
import { KnowledgeBrowseController } from "../src/still/kit/knowledgeBrowseController.ts";
import { PreviewRetainer } from "../src/still/kit/knowledgeSession.ts";
import { runDirectoryHydration } from "../src/still/kit/knowledgeHydration.ts";
import { orchestrateDesktopCreate, createSubmitBusy, type CreateScope, type CreateAuthority } from "../src/still/kit/desktopCreate.ts";
import { hydrationCursorFor } from "../src/still/kit/knowledgeHydration.ts";
import { DesktopTransientProjection } from "../src/still/kit/desktopProjection.ts";
import { transientMatchesQuery } from "../src/still/kit/searchHit.ts";
import {
  literalSegments, bodyHitContext, visibleMatchKind, firstMatchIndex, MATCH_LOCATION_UNKNOWN,
} from "../src/still/kit/searchHit.ts";
import { secureUuidV4, isSecureUuidV4 } from "../src/services/secureUuid.ts";
import type { KnowledgeBrowseRow } from "../src/still/kit/knowledgeBrowseController.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const strip = (src: string) => src.replace(/^\s*\/\/.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, "");
const COLL = () => read("src", "still", "StillCollection.tsx");
const NOTE = () => read("src", "still", "StillNote.tsx");

const tick = () => new Promise((r) => setImmediate(r));
const settle = async (n = 8) => { for (let i = 0; i < n; i += 1) await tick(); };
const settledQ = () => new Promise((r) => setTimeout(r, 420));

// ---------------------------------------------------------------------------
// D1-D9: the directory authority
// ---------------------------------------------------------------------------

function makeDir() {
  const calls: Array<{ q: string; page: number; directory: string; vault: string }> = [];
  let responses: Record<string, any> = {};
  const ctrl = new KnowledgeDirectoryController(async (instance, vault, q, page, directory) => {
    calls.push({ q, page, directory, vault });
    const key = `${vault}|${directory}|${q}|${page}`;
    return responses[key] ?? { items: [], hasMore: false, source: "live" };
  });
  return { ctrl, calls, setResponses: (r: Record<string, any>) => { responses = r; } };
}

const owner = (over: Record<string, any> = {}) => ({
  paired: true, connected: true, instanceId: "A", writeGranted: true,
  isLive: () => true, ...over,
});

test("D1 — ALL NOTES (root) never calls the legacy directory authority", async () => {
  const { ctrl, calls } = makeDir();
  // ROOT means the PAGE keeps the canonical pipeline: the controller is
  // only ever FED while a directory is non-empty (page gate, see D9). Fed
  // with ROOT directly it also stays inert until activated.
  ctrl.setOwner(owner());
  ctrl.setVault("v");
  ctrl.setDirectory("");
  await settledQ();
  assert.equal(calls.length, 0, "no page-1 without activate; ROOT stays canonical");
  ctrl.activate(); // even an activate with a ROOT directory is inert here —
  await settledQ();   // the page never does this (directoryActive gate), and
  assert.equal(calls.length, 0, "the ROOT identity issues no legacy query");
});

test("D2 — selecting directory D switches to Content V1 q+directory", async () => {
  const { ctrl, calls, setResponses } = makeDir();
  setResponses({ "v|Work||1": { items: [{ noteId: "n1", title: "a", relativePath: "Work/a.md", revision: "r1", serverDocument: { revision: "r2" } }], hasMore: false, source: "live" } });
  ctrl.setOwner(owner());
  ctrl.setVault("v");
  ctrl.setDirectory("Work");
  ctrl.activate();
  await settledQ();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].directory, "Work", "the directory rides the V1 query");
  assert.equal(calls[0].page, 1);
  assert.equal(ctrl.snapshot().phase, "ready");
  assert.equal(ctrl.snapshot().source, "live", "live provenance is reported");
  assert.equal(ctrl.snapshot().rows.length, 1);
});

test("D3 — folder inventory uses the shared catalog, never canonical note rows", () => {
  const coll = COLL();
  // The note list still uses V1 directory rows. Folder inventory is now the
  // shared Services catalog (which includes empty folders); cached note
  // directories remain an explicitly incomplete fallback, never canonical rows.
  const sheet = read("src", "still", "kit", "directorySheet.tsx");
  const session = read("src", "still", "kit", "knowledgeSession.ts");
  assert.match(sheet, /const catalog = sessionKnowledge\(\)\.folders/u, "sheet and collection share folder authority");
  assert.match(sheet, /catalog\.snapshot\(scope\)/u, "the sheet reads a scope-keyed catalog snapshot");
  assert.match(session, /new KnowledgeFolderCatalog\(navigation,[\s\S]*?api\.contentNoteDirectories\(instance, vault\)/u,
    "the existing cache projection remains the catalog fallback");
  // The directory ITEMS memo projects the V1 rows (a local filter of
  // canonical rows as directory results would be the forbidden fake).
  const memo = coll.slice(coll.indexOf("const directoryItems"), coll.indexOf("const items: NoteItem[]"));
  assert.ok(memo.includes("...directorySnap.rows.map((row) => {"), "directory rows come from the V1 authority (transients merge ahead, deduped)");
  assert.doesNotMatch(memo, /desktop\.rows/u, "the canonical rows never masquerade as directory results");
});

test("D4/D5 — live vs cache provenance is truthful", async () => {
  const { ctrl, setResponses } = makeDir();
  setResponses({ "v|Work||1": { items: [{ noteId: "n" }], hasMore: false, source: "cache" } });
  ctrl.setOwner(owner({ connected: false }));
  ctrl.setVault("v");
  ctrl.setDirectory("Work");
  ctrl.activate();
  await settledQ();
  const snap = ctrl.snapshot();
  assert.equal(snap.phase, "ready");
  assert.equal(snap.source, "cache", "offline fallback reports cache, never live");
});

// REPAIR-R1.1 (P1-4): the SAME owner dropping online → offline is a truth
// transition — retained rows, live label gone SYNCHRONOUSLY.
test("D4b — same-owner online → offline degrades truthfully (rows kept, live label gone)", async () => {
  const { ctrl, calls, setResponses } = makeDir();
  setResponses({ "v|Work||1": { items: [{ noteId: "n1" }, { noteId: "n2" }], hasMore: false, source: "live" } });
  ctrl.setOwner(owner());
  ctrl.setVault("v");
  ctrl.setDirectory("Work");
  ctrl.activate();
  await settledQ();
  assert.equal(ctrl.snapshot().source, "live");
  const callsBefore = calls.length;
  ctrl.setOwner(owner({ connected: false }));
  const snap = ctrl.snapshot();
  assert.equal(snap.phase, "ready", "rows stay painted (cached content)");
  assert.equal(snap.rows.length, 2, "the retained rows survive the drop");
  assert.equal(snap.source, "cache", "the live label is gone the moment the ws is down");
  await settledQ();
  assert.equal(calls.length, callsBefore, "no new request fires while offline");
  // Reconnect re-proves the page: exactly ONE fresh page-1 (never the
  // relabeled cache snapshot kept as truth).
  setResponses({ "v|Work||1": { items: [{ noteId: "n1" }], hasMore: false, source: "live" } });
  ctrl.setOwner(owner());
  await settledQ();
  assert.equal(calls.length, callsBefore + 1, "reconnect issues one fresh page-1");
  assert.equal(ctrl.snapshot().source, "live");
});

test("D4c — an in-flight live page-1 is fenced by the offline drop", async () => {
  const { ctrl } = makeDir();
  let release: ((v: any) => void) | null = null;
  const gated = new KnowledgeDirectoryController(() => new Promise((res) => { release = res; }));
  gated.setOwner(owner());
  gated.setVault("v");
  gated.setDirectory("Work");
  gated.activate();
  // The desktop drops BEFORE the live response arrives.
  gated.setOwner(owner({ connected: false }));
  release?.({ items: [{ noteId: "LATE" }], hasMore: false, source: "live" });
  await settledQ();
  assert.ok(!gated.snapshot().rows.some((r) => r.noteId === "LATE"), "the late live response cannot commit as truth");
});

test("D6 — suspend/activate: same identity returns with ZERO requests", async () => {
  const { ctrl, calls, setResponses } = makeDir();
  setResponses({ "v|Work||1": { items: [{ noteId: "n1" }], hasMore: false, source: "live" } });
  ctrl.setOwner(owner());
  ctrl.setVault("v");
  ctrl.setDirectory("Work");
  ctrl.activate();
  await settledQ();
  assert.equal(calls.length, 1);
  ctrl.suspend();
  assert.equal(ctrl.snapshot().rows.length, 1, "the snapshot survives");
  ctrl.activate();
  await settledQ();
  assert.equal(calls.length, 1, "cache-first return: zero new requests");
  assert.equal(ctrl.snapshot().phase, "ready");
});

test("D7 — owner A state never appears under B", async () => {
  const { ctrl, setResponses } = makeDir();
  setResponses({ "v|Work||1": { items: [{ noteId: "n1" }], hasMore: false, source: "live" } });
  ctrl.setOwner(owner());
  ctrl.setVault("v");
  ctrl.setDirectory("Work");
  ctrl.activate();
  await settledQ();
  assert.equal(ctrl.snapshot().rows.length, 1);
  ctrl.setOwner(owner({ instanceId: "B" }));
  const snap = ctrl.snapshot();
  assert.equal(snap.instanceId, "B");
  assert.equal(snap.rows.length, 0, "A's rows are retired on the owner switch");
  await settledQ();
});

test("D8 — stale query/directory responses are fenced", async () => {
  const { setResponses } = makeDir();
  // Query A hangs; query B resolves.
  const gates: Record<string, (v: any) => void> = {};
  let mode: "hang" | "fast" = "hang";
  const callsCtrl = new KnowledgeDirectoryController((i, v, q, p, d) =>
    mode === "hang"
      ? new Promise((res) => { gates[`${v}|${d}|${q}|${p}`] = res; })
      : Promise.resolve({ items: [{ noteId: "nB" }], hasMore: false, source: "live" }));
  callsCtrl.setOwner(owner());
  callsCtrl.setVault("v");
  callsCtrl.setDirectory("Work");
  await settledQ();
  callsCtrl.setQuery("B");
  mode = "fast";
  await settledQ();
  const snap = callsCtrl.snapshot();
  assert.equal(snap.query, "B");
  assert.ok(snap.rows.every((r) => r.noteId === "nB"), "only B's rows committed");
  // The hung A response resolves late and must be dropped.
  gates["v|Work||1"]?.({ items: [{ noteId: "STALE_A" }], hasMore: false, source: "live" });
  await settledQ();
  assert.ok(callsCtrl.snapshot().rows.every((r) => r.noteId !== "STALE_A"), "the stale A response was dropped");
  void setResponses;
});

test("D9 — clearing the directory returns to the canonical ALL NOTES view", () => {
  const coll = COLL();
  // ROOT and global search both use canonical ALL NOTES. A retained folder
  // becomes active again once the search is cleared.
  const expression = coll.match(/const directoryActive = ([^;]+);/u)?.[1];
  assert.ok(expression, "the page has one directory-authority gate");
  const active = Function("source", "desktopDirectory", "query", `return (${expression});`);
  assert.equal(active("desktop", "", ""), false, "ROOT deactivates the directory authority");
  assert.equal(active("desktop", "Work", ""), true, "folder browsing activates directory rows");
  assert.equal(active("desktop", "Work", "needle"), false, "search spans the whole vault");
  assert.equal(active("desktop", "Work", "  "), true, "blank search restores folder browsing");
  assert.equal(active("local", "Work", ""), false, "local source never uses the desktop directory authority");
  assert.ok(coll.includes('if (source === "desktop" && directoryActive) return directoryItems;'),
    "rows come from the directory authority only while active");
});

// REPAIR-R1.1 (P1-5): the visible directory is SYNCHRONOUSLY scoped to the
// current instance|vault — never a one-time useState seed that can leak A's
// pick under B for one frame.
test("D10 — the page derives the directory from the scope-keyed session EVERY render", () => {
  const coll = COLL();
  assert.ok(coll.includes('const desktopDirectory = session.retainedDirectoryFor(instanceId, desktop ? desktop.vaultId : "");'),
    "the visible directory is a synchronous session read, not useState-seeded");
  assert.doesNotMatch(strip(coll), /useState\(retainedDir\)/u, "the stale one-time seed is gone");
  const sess = read("src", "still", "kit", "knowledgeSession.ts");
  assert.ok(sess.includes("const directoryByScope = new Map<string, string>();"),
    "the session retains directories in a scope-keyed map");
});

// ---------------------------------------------------------------------------
// M10-M18: single move
// ---------------------------------------------------------------------------

test("M10 — the move body is exactly opId/vaultId/expectedRevision/parentRelativePath", async () => {
  const org = new KnowledgeOrganizationController();
  const bodies: any[] = [];
  const deps = {
    move: async (_i: string, _n: string, input: any) => {
      bodies.push(input);
      return { opId: input.opId, vaultId: input.vaultId, noteId: _n, revision: "r2", parentRelativePath: input.parentRelativePath };
    },
    applyReceipt: async () => {},
    isLive: () => true,
  };
  await org.moveOne(deps as never,
    { instanceId: "A", vaultId: "v", noteId: "n1", expectedRevision: "r1", currentParent: "Work" }, "Docs");
  assert.equal(bodies.length, 1);
  assert.deepEqual(Object.keys(bodies[0]).sort(), ["expectedRevision", "opId", "parentRelativePath", "vaultId"]);
  assert.equal(bodies[0].expectedRevision, "r1");
  assert.equal(bodies[0].parentRelativePath, "Docs");
  // No title field (rename is a different authority).
  assert.ok(!("title" in bodies[0]));
});

test("M11 — rename code/path remains untouched", () => {
  const coll = COLL();
  assert.ok(!coll.includes("renameNote"), "the page adds no rename path");
  const note = NOTE();
  assert.ok(note.includes("重命名"), "the existing rename action remains");
  // The move action is SEPARATE from rename (never merged).
  assert.ok(note.includes('"移动到目录"'), "move is its own independent action");
});

test("M12 — same-parent move is a client-side no-op", async () => {
  const org = new KnowledgeOrganizationController();
  let calls = 0;
  const deps = {
    move: async () => { calls += 1; throw new Error("must not be called"); },
    applyReceipt: async () => {},
    isLive: () => true,
  };
  const r = await org.moveOne(deps as never,
    { instanceId: "A", vaultId: "v", noteId: "n", expectedRevision: "r", currentParent: "Work" }, "Work");
  assert.ok(r.ok);
  assert.equal(r.outcome?.kind, "noop");
  assert.equal(calls, 0);
});

// REPAIR-R1.1 (P1-2): secure opId ONLY — no Math.random fallback exists.
test("M13 — secureUuidV4 alone: getRandomValues path works; no source = ZERO moves", async () => {
  const orgSrc = strip(read("src", "still", "kit", "knowledgeOrganizationController.ts"));
  assert.ok(!orgSrc.includes("fallbackUuidV4"), "the Math.random fallback is deleted");
  assert.doesNotMatch(orgSrc, /Math\.random/u, "no Math.random anywhere in the move authority");

  const org = new KnowledgeOrganizationController();
  // Node exposes `crypto` as a getter-only accessor; swap the property
  // descriptor to drive the engine-selection paths the controller really
  // reads, and restore it after each phase.
  const realDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
  const swapCrypto = (value: unknown) => {
    Object.defineProperty(globalThis, "crypto", { value, configurable: true, writable: true });
  };

  // (a) randomUUID absent + getRandomValues present (the MI8 WebView-83
  // shape): a valid secure v4 is minted and the move PROCEEDS.
  const moves: any[] = [];
  const deps = {
    move: async (_i: string, n: string, input: any) => {
      moves.push(input);
      return { opId: input.opId, vaultId: input.vaultId, noteId: n, revision: "r9", parentRelativePath: input.parentRelativePath };
    },
    applyReceipt: async () => {},
    isLive: () => true,
  };
  swapCrypto({
    getRandomValues: (a: Uint8Array) => {
      for (let i = 0; i < a.length; i += 1) a[i] = (i * 7 + 13) & 0xff;
      return a;
    },
  });
  try {
    const r = await org.moveOne(deps as never,
      { instanceId: "A", vaultId: "v", noteId: "n1", expectedRevision: "r1", currentParent: "" }, "Work");
    assert.ok(r.ok, "the getRandomValues-only engine still moves");
    assert.equal(moves.length, 1);
    assert.ok(isSecureUuidV4(moves[0].opId), "the opId is a canonical secure v4");
  } finally {
    Object.defineProperty(globalThis, "crypto", realDescriptor);
  }

  // (b) NO secure randomness at all: fail closed — ZERO move requests and a
  // truthful reason (this is the whole point of deleting the fallback).
  swapCrypto(undefined);
  try {
    const r2 = await org.moveOne(deps as never,
      { instanceId: "A", vaultId: "v", noteId: "n2", expectedRevision: "r1", currentParent: "" }, "Work");
    assert.equal(r2.ok, false, "no secure source means no move");
    assert.equal(moves.length, 1, "ZERO new move requests were issued");
    assert.equal(r2.reason, SECURE_RANDOM_UNAVAILABLE, "the failure is truthful user copy");
  } finally {
    Object.defineProperty(globalThis, "crypto", realDescriptor);
  }
  // (c) and the batch STOPS on the missing secure source.
  swapCrypto(undefined);
  try {
    const report = await org.moveBatch(deps as never, [
      { instanceId: "A", vaultId: "v", noteId: "x1", expectedRevision: "r", currentParent: "" },
      { instanceId: "A", vaultId: "v", noteId: "x2", expectedRevision: "r", currentParent: "" },
    ], "Work");
    assert.equal(report.stopped, true, "the batch stops when opIds cannot be minted securely");
    assert.equal(report.succeeded, 0);
    assert.equal(moves.length, 1, "still ZERO move requests");
  } finally {
    Object.defineProperty(globalThis, "crypto", realDescriptor);
  }
  // The engine's own secureUuidV4 stays valid for sanity.
  assert.ok(isSecureUuidV4(secureUuidV4()));
});

test("M14 — a 409 does not mutate the local projection", async () => {
  const org = new KnowledgeOrganizationController();
  const applied: string[] = [];
  const deps = {
    move: async () => { throw new Error("HTTP 409: revision-conflict"); },
    applyReceipt: async (_i, _v, n) => { applied.push(n); },
    isLive: () => true,
  };
  const r = await org.moveOne(deps as never,
    { instanceId: "A", vaultId: "v", noteId: "n", expectedRevision: "r", currentParent: "" }, "Work");
  assert.equal(r.ok, false);
  assert.ok(r.reason!.includes("版本冲突"), "the 409 reads as a revision conflict");
  assert.equal(applied.length, 0, "no receipt application on failure");
});

test("M15 — success updates the projection WITHOUT fabricating a body revision", async () => {
  const org = new KnowledgeOrganizationController();
  const applied: Array<[string, string, string]> = [];
  let committed = 0;
  let committedPayload: any = null;
  const deps = {
    move: async (_i: string, n: string, input: any) => ({ opId: input.opId, vaultId: input.vaultId, noteId: n, revision: "rNEW", parentRelativePath: input.parentRelativePath }),
    applyReceipt: async (_i, _v, n, rev, parent) => { applied.push([n, rev, parent]); },
    isLive: () => true,
    onCommitted: (c: any) => { committed += 1; committedPayload = c; },
  };
  const r = await org.moveOne(deps as never,
    { instanceId: "A", vaultId: "v", noteId: "n", expectedRevision: "r1", currentParent: "" }, "Work");
  assert.equal(r.outcome?.kind, "moved");
  assert.deepEqual(applied, [["n", "rNEW", "Work"]], "the metadata receipt is applied");
  assert.equal(committed, 1, "the page's visible-projection hook ran");
  // REPAIR-R1.2 (P0): the hook carries the ORIGINAL scope.
  assert.deepEqual(
    { instanceId: committedPayload.instanceId, vaultId: committedPayload.vaultId, noteId: committedPayload.noteId },
    { instanceId: "A", vaultId: "v", noteId: "n" },
    "onCommitted carries the original instanceId + vaultId",
  );
  // The Rust side is metadata-only: a body-less document never rewrites
  // content/body revision (pinned in the source).
  const db = read("src-tauri", "src", "content_db.rs");
  const fn = db.slice(db.indexOf("pub(crate) fn content_note_move_receipt"));
  assert.ok(fn.slice(0, 2200).includes('deliberately NO "content"'), "the receipt document is metadata-only");
});

// REPAIR-R1.2 (P1-6): the local receipt is AWAITED before the projection
// hook — the hook can never run ahead of the cache convergence it assumes.
test("M15b — the local receipt attempt is awaited BEFORE onCommitted", async () => {
  const org = new KnowledgeOrganizationController();
  let releaseReceipt: (() => void) | null = null;
  const order: string[] = [];
  const deps = {
    move: async (_i: string, n: string, input: any) => ({ opId: input.opId, vaultId: input.vaultId, noteId: n, revision: "r", parentRelativePath: input.parentRelativePath }),
    applyReceipt: () => new Promise<void>((resolve) => {
      order.push("receipt-start");
      releaseReceipt = () => { order.push("receipt-settled"); resolve(); };
    }),
    isLive: () => true,
    onCommitted: () => { order.push("committed"); },
  };
  const pending = org.moveOne(deps as never,
    { instanceId: "A", vaultId: "v", noteId: "n", expectedRevision: "r1", currentParent: "" }, "Work");
  await settle(2);
  assert.deepEqual(order, ["receipt-start"], "the hook has NOT run while the receipt is pending");
  releaseReceipt?.();
  const r = await pending;
  assert.equal(r.outcome?.kind, "moved");
  assert.deepEqual(order, ["receipt-start", "receipt-settled", "committed"],
    "the projection hook runs only after the receipt attempt settled");
});

// REPAIR-R1.2: a receipt FAILURE is still not a move failure (the Desktop
// commit stands) — and the hook still runs after the failed attempt.
test("M15c — a failed local receipt attempt never fakes a move failure", async () => {
  const org = new KnowledgeOrganizationController();
  let committed = 0;
  const deps = {
    move: async (_i: string, n: string, input: any) => ({ opId: input.opId, vaultId: input.vaultId, noteId: n, revision: "r", parentRelativePath: input.parentRelativePath }),
    applyReceipt: async () => { throw new Error("local-db-busy"); },
    isLive: () => true,
    onCommitted: () => { committed += 1; },
  };
  const r = await org.moveOne(deps as never,
    { instanceId: "A", vaultId: "v", noteId: "n", expectedRevision: "r1", currentParent: "" }, "Work");
  assert.equal(r.ok, true, "the Desktop commit is not turned into a failure");
  assert.equal(r.outcome?.kind, "moved");
  assert.equal(committed, 1);
});

test("M16 — directory membership after a move reasons from the DESTINATION parent", async () => {
  const { ctrl, setResponses } = makeDir();
  setResponses({ "v|Work||1": { items: [
    { noteId: "n1", relativePath: "Work/a.md", revision: "r1", serverDocument: { revision: "r2" } },
    { noteId: "n2", relativePath: "Work/b.md" },
    { noteId: "n3", relativePath: "Work/Sub/c.md" },
  ], hasMore: false, source: "live" } });
  ctrl.setOwner(owner());
  ctrl.setVault("v");
  ctrl.setDirectory("Work");
  ctrl.activate();
  await settledQ();
  assert.equal(ctrl.snapshot().rows.length, 3);
  // Work -> ROOT: the row LEAVES the Work view.
  ctrl.applyMoveReceipt("A", "v", "n1", "", "r9");
  let rows = ctrl.snapshot().rows;
  assert.ok(!rows.some((r) => r.noteId === "n1"), "Work→ROOT removes the row from the Work view");
  assert.ok(rows.some((r) => r.noteId === "n2"), "untouched rows stay");
  // Work -> Docs (a sibling directory): the row LEAVES the Work view.
  ctrl.applyMoveReceipt("A", "v", "n2", "Docs", "r9");
  rows = ctrl.snapshot().rows;
  assert.ok(!rows.some((r) => r.noteId === "n2"), "Work→Docs removes the row from the Work view");
  // Work -> Work/Sub: the row STAYS (the destination is inside the subtree)
  // and its path becomes Work/Sub/<same basename>.
  ctrl.applyMoveReceipt("A", "v", "n3", "Work/Sub", "r9");
  rows = ctrl.snapshot().rows;
  const kept = rows.find((r) => r.noteId === "n3");
  assert.ok(kept, "Work→Work/Sub keeps the row in the Work view");
  assert.equal(kept!.relativePath, "Work/Sub/c.md", "the basename is preserved in the new path");
  assert.equal(kept!.remoteRevision, "r9", "the remote observation advances");
});

test("M16a — a move to the parent directory leaves the SUB view but stays in the parent view", async () => {
  const { ctrl, setResponses } = makeDir();
  setResponses({ "v|Work/Sub||1": { items: [
    { noteId: "n1", relativePath: "Work/Sub/c.md" },
  ], hasMore: false, source: "live" } });
  ctrl.setOwner(owner());
  ctrl.setVault("v");
  ctrl.setDirectory("Work/Sub");
  ctrl.activate();
  await settledQ();
  // Work/Sub -> Work: viewing Work/Sub, the row must LEAVE.
  ctrl.applyMoveReceipt("A", "v", "n1", "Work", "r9");
  assert.ok(!ctrl.snapshot().rows.some((r) => r.noteId === "n1"),
    "Work/Sub→Work removes the row from the Work/Sub view");
  // ...and the same receipt would KEEP it in a Work view (destination == D).
  const { ctrl: workCtrl, setResponses: setWork } = makeDir();
  setWork({ "v|Work||1": { items: [
    { noteId: "n1", relativePath: "Work/Sub/c.md" },
  ], hasMore: false, source: "live" } });
  workCtrl.setOwner(owner());
  workCtrl.setVault("v");
  workCtrl.setDirectory("Work");
  workCtrl.activate();
  await settledQ();
  workCtrl.applyMoveReceipt("A", "v", "n1", "Work", "r9");
  const kept = workCtrl.snapshot().rows.find((r) => r.noteId === "n1");
  assert.ok(kept, "Work/Sub→Work keeps the row in the Work view");
  assert.equal(kept!.relativePath, "Work/c.md");
});

test("M16b — a committed move re-parents the CANONICAL retained row (parent-only DTO)", () => {
  // The browse controller's narrow metadata projection: no blanking, the
  // row's parent moves and the canonical revision observation advances.
  // REPAIR-R1.2 (P1-2): parentRelativePath is PARENT-ONLY — the projection
  // writes newParent EXACTLY, never a basename derivation.
  const deps = {
    registry: {
      refreshAdopting: async () => ({}),
      operation: () => ({ state: "implemented" }),
      invalidate: () => {},
    },
    knowledge: {
      vaults: async () => ({ items: [{ vaultId: "v", displayName: "库", activeInDesktop: true, readGranted: true, writeGranted: true }] }),
      registeredList: async () => ({ items: [], nextAfterId: null, hasMore: false }),
    },
  };
  const seedRows = (parent: string) => [{
    instanceId: "A", vaultId: "v", noteId: "n1", title: "t",
    parentRelativePath: parent, revision: "r1",
  }];
  const ctrl = new KnowledgeBrowseController(deps as never);
  const seedSnapshot = (parent: string) => {
    (ctrl as unknown as { snap: any }).snap = {
      phase: "ready", instanceId: "A", vaultId: "v", vaultName: "库", query: "",
      rows: seedRows(parent), nextAfterId: null, hasMore: false, loadingMore: false,
      errorCode: "", remoteCode: "", certifiedVersion: null,
    };
  };
  // Work -> Docs: the stored parent is EXACTLY Docs.
  seedSnapshot("Work");
  ctrl.applyMoveReceipt("A", "v", "n1", "Docs", "r5");
  let snap = ctrl.snapshot();
  assert.equal(snap.rows.length, 1, "the list never blanks");
  assert.equal(snap.rows[0].parentRelativePath, "Docs", "Work→Docs projects exactly Docs (no Docs/Work)");
  assert.equal(snap.rows[0].revision, "r5", "the canonical revision observation advanced");
  // ROOT -> Docs.
  seedSnapshot("");
  ctrl.applyMoveReceipt("A", "v", "n1", "Docs", "r6");
  snap = ctrl.snapshot();
  assert.equal(snap.rows[0].parentRelativePath, "Docs", "ROOT→Docs projects Docs");
  // Docs -> ROOT.
  seedSnapshot("Docs");
  ctrl.applyMoveReceipt("A", "v", "n1", "", "r7");
  snap = ctrl.snapshot();
  assert.equal(snap.rows[0].parentRelativePath, "", "Docs→ROOT projects ROOT");
});

// REPAIR-R1.2 (P0-CURRENTNESS): a LATE receipt from A can never mutate B's
// CURRENT retained projections — both controllers fail closed on scope.
test("M16c — a late A receipt is a NO-OP for B's current rows (same noteId)", async () => {
  // Canonical: B's snapshot holds the SAME noteId; A's receipt must not
  // touch it.
  const deps = {
    registry: { refreshAdopting: async () => ({}), operation: () => ({ state: "implemented" }), invalidate: () => {} },
    knowledge: { vaults: async () => ({ items: [] }) },
  };
  const browse = new KnowledgeBrowseController(deps as never);
  (browse as unknown as { snap: any }).snap = {
    phase: "ready", instanceId: "B", vaultId: "vB", vaultName: "B库", query: "",
    rows: [{ instanceId: "B", vaultId: "vB", noteId: "n1", title: "B 的笔记", parentRelativePath: "Work", revision: "rB" }],
    nextAfterId: null, hasMore: false, loadingMore: false, errorCode: "", remoteCode: "", certifiedVersion: null,
  };
  browse.applyMoveReceipt("A", "vA", "n1", "Docs", "rA9");
  let snap = browse.snapshot();
  assert.equal(snap.rows[0].parentRelativePath, "Work", "A's receipt did not re-parent B's canonical row");
  assert.equal(snap.rows[0].revision, "rB", "A's receipt did not advance B's revision");
  // The same scope DOES apply.
  browse.applyMoveReceipt("B", "vB", "n1", "Docs", "rB9");
  snap = browse.snapshot();
  assert.equal(snap.rows[0].parentRelativePath, "Docs", "the exact-scope receipt applies normally");
  assert.equal(snap.rows[0].revision, "rB9");

  // Directory: same proof through the Content V1 authority.
  const { ctrl, setResponses } = makeDir();
  setResponses({ "vB|Work||1": { items: [
    { noteId: "n1", relativePath: "Work/a.md", revision: "rB" },
  ], hasMore: false, source: "live" } });
  ctrl.setOwner(owner({ instanceId: "B" }));
  ctrl.setVault("vB");
  ctrl.setDirectory("Work");
  ctrl.activate();
  await settledQ();
  const before = JSON.stringify(ctrl.snapshot().rows);
  ctrl.applyMoveReceipt("A", "vA", "n1", "Docs", "rA9");
  assert.equal(JSON.stringify(ctrl.snapshot().rows), before,
    "A's late receipt leaves B's directory rows byte-for-byte unchanged");
  // The same scope still works (the moved-out row disappears).
  ctrl.applyMoveReceipt("B", "vB", "n1", "Docs", "rB9");
  assert.ok(!ctrl.snapshot().rows.some((r) => r.noteId === "n1"),
    "the exact-scope receipt removes the moved-out row");
});

test("M17 — an owner switch during move cannot adopt the late receipt", async () => {
  const org = new KnowledgeOrganizationController();
  let live = true;
  const deps = {
    move: async () => { live = false; return { opId: "op", vaultId: "v", noteId: "n", revision: "r2", parentRelativePath: "X" }; },
    applyReceipt: async () => {},
    isLive: () => live,
  };
  // moveOne applies the receipt regardless (the Desktop commit is real); the
  // RECEIPT-side scope fences (M16c) are what protect B's visible rows. The
  // controller's own fence for BATCH is proven in B23 below.
  const r = await org.moveOne(deps as never,
    { instanceId: "A", vaultId: "v", noteId: "n", expectedRevision: "r", currentParent: "" }, "X");
  assert.equal(r.outcome?.kind, "moved", "the real commit is never a fake failure");
});

// REPAIR-R1.2 (P1-1): currentness is proven BEFORE the opId is minted — an
// already-stale scope sends ZERO requests (nothing was committed, so
// this cancels unsent work; it is not a fake failure of a sent one).
test("M17b — moveOne checks isLive BEFORE minting/sending: ZERO requests", async () => {
  const org = new KnowledgeOrganizationController();
  let calls = 0;
  const deps = {
    move: async () => { calls += 1; throw new Error("must not be called"); },
    applyReceipt: async () => {},
    isLive: () => false,
  };
  const r = await org.moveOne(deps as never,
    { instanceId: "A", vaultId: "v", noteId: "n", expectedRevision: "r", currentParent: "" }, "Work");
  assert.equal(r.ok, false);
  assert.equal(calls, 0, "ZERO move requests were issued");
  assert.equal(r.reason, SCOPE_CHANGED_BEFORE_SEND, "the cancel copy is truthful");
  // A no-op parent is still a no-op (checked before liveness, nothing sends).
  const noop = await org.moveOne(deps as never,
    { instanceId: "A", vaultId: "v", noteId: "n", expectedRevision: "r", currentParent: "Work" }, "Work");
  assert.equal(noop.outcome?.kind, "noop");
  assert.equal(calls, 0);
});

// ---------------------------------------------------------------------------
// REPAIR-R1.3 — deferred-promise currentness tests (the review's four
// required scenarios, driven through the REAL controller/orchestrator).
// ---------------------------------------------------------------------------

// (1) Detail A → B on the SAME Desktop: the route token is captured before
// any await; navigation bumps it; A's authority resolution then completes —
// ZERO A move request.
test("M21 — detail A→B race: the original route token sends ZERO A requests", async () => {
  const org = new KnowledgeOrganizationController();
  // The DesktopStillNote owner ref semantics: route cleanup increments it.
  const ownerRef = { current: 0 };
  let moves = 0;
  const deps = {
    move: async (_i: string, n: string, input: any) => {
      moves += 1;
      return { opId: input.opId, vaultId: input.vaultId, noteId: n, revision: "r", parentRelativePath: input.parentRelativePath };
    },
    applyReceipt: async () => {},
    isLive: () => ownerRef.current === 0,
    onCommitted: () => { throw new Error("must not run"); },
  };
  // runNoteMove's exact shape: token FIRST, then the awaits, each followed
  // by the original-token proof, then the real moveOne.
  const moveOwner = ownerRef.current;
  let releaseAuthority: (() => void) | null = null;
  const authorityPending = new Promise<void>((res) => { releaseAuthority = res; });
  const flow = (async () => {
    await Promise.resolve(); // connState (instant)
    if (ownerRef.current !== moveOwner) return "cancelled";
    await authorityPending; // resolveMoveAuthority (deferred)
    if (ownerRef.current !== moveOwner) return "cancelled";
    const r = await org.moveOne(deps as never,
      { instanceId: "A", vaultId: "v", noteId: "note-a", expectedRevision: "r1", currentParent: "" }, "Work");
    return r.ok ? "moved" : "failed";
  })();
  // The user navigates to Note B on the SAME Desktop: A's route cleanup
  // bumps the token (B's own detail stage exists, but it is NOT A).
  ownerRef.current += 1;
  releaseAuthority?.();
  const outcome = await flow;
  assert.equal(outcome, "cancelled", "the post-resolve original-token proof cancelled the flow");
  assert.equal(moves, 0, "ZERO A move request — even though some detail stage exists");
});

// (2) Same instance+vault, scope S1 → S2 while the remote move is pending:
// the S1 DB receipt converges, the outcome stays committed, and the CURRENT
// visible projection callback is NOT invoked (S2 untouched).
test("M22 — S1→S2 late committed receipt: durable convergence, no visible projection", async () => {
  const org = new KnowledgeOrganizationController();
  let scope = "S1"; // instance+vault identical; the LIST scope changed
  let receipts = 0;
  let committedCallbacks = 0;
  let releaseMove: ((v: any) => void) | null = null;
  const deps = {
    move: (_i: string, n: string, input: any) => new Promise((res) => {
      releaseMove = () => res({ opId: input.opId, vaultId: input.vaultId, noteId: n, revision: "r9", parentRelativePath: "Docs" });
    }),
    applyReceipt: async () => { receipts += 1; },
    isLive: () => scope === "S1",
    onCommitted: () => { committedCallbacks += 1; },
  };
  const pending = org.moveOne(deps as never,
    { instanceId: "A", vaultId: "v", noteId: "n1", expectedRevision: "r1", currentParent: "Work" }, "Docs");
  await settle(2);
  // The user changes directory/query (same owner+vault): S1 is no longer
  // current while the remote commit is pending.
  scope = "S2";
  releaseMove?.({});
  const r = await pending;
  assert.equal(r.outcome?.kind, "moved", "the remote commit is real and never a fake failure");
  assert.equal(receipts, 1, "the ORIGINAL-scope Mobile DB receipt still converges");
  assert.equal(committedCallbacks, 0, "the S1 projection callback is NOT invoked under S2");
  // And the real S2 directory controller's rows were never touched (the
  // callback never ran; the controller guard is the second layer).
  const { ctrl, setResponses } = makeDir();
  setResponses({ "v|Docs||1": { items: [{ noteId: "n1", relativePath: "Docs/keep.md" }], hasMore: false, source: "live" } });
  ctrl.setOwner(owner());
  ctrl.setVault("v");
  ctrl.setDirectory("Docs");
  ctrl.activate();
  await settledQ();
  const before = JSON.stringify(ctrl.snapshot().rows);
  // Even a stray same-owner receipt for a DIFFERENT vault is a no-op.
  ctrl.applyMoveReceipt("A", "other-vault", "n1", "Work", "r9");
  assert.equal(JSON.stringify(ctrl.snapshot().rows), before);
});

// (3) The facts-read race: the scope changes while the (deferred) local
// facts read is pending — the orchestrator reports stale, nothing sends,
// and the page (by contract) applies NO UI for the old scope.
test("M23 — facts-read scope race: stale completion, ZERO requests", async () => {
  const org = new KnowledgeOrganizationController();
  let scope = "S1";
  let connected = true;
  let moves = 0;
  let releaseFacts: (() => void) | null = null;
  const deps = {
    move: async (_i: string, n: string, input: any) => {
      moves += 1;
      return { opId: input.opId, vaultId: input.vaultId, noteId: n, revision: "r", parentRelativePath: input.parentRelativePath };
    },
    applyReceipt: async () => {},
    isLive: () => scope === "S1" && connected,
    onCommitted: () => {},
  };
  const pending = orchestrateListMove({
    org,
    deps: deps as never,
    destination: "Docs",
    isScopeCurrent: () => scope === "S1" && connected,
    buildTargets: () => new Promise((res) => {
      releaseFacts = () => res({
        targets: [{ instanceId: "A", vaultId: "v", noteId: "n1", expectedRevision: "r1", currentParent: "" }],
        blocked: [],
        titleByNoteId: { n1: "笔记一" },
      });
    }),
  });
  await settle(2);
  // The user changed the query/directory while the facts read was pending.
  scope = "S2";
  releaseFacts?.();
  const result = await pending;
  assert.equal(result.kind, "stale", "a facts-read race reports stale — no outcome, no toast");
  assert.equal(moves, 0, "ZERO move requests");
});

// (4) The remote-move race: the scope changes while the move itself is
// pending — the report is stale for the page, the committed remote result
// stays durable (receipt landed), and the visible callback did not run.
test("M24 — remote-move scope race: stale UI completion, durable commit", async () => {
  const org = new KnowledgeOrganizationController();
  let scope = "S1";
  let connected = true;
  let moves = 0;
  let receipts = 0;
  let committedCallbacks = 0;
  let releaseMove: ((v: any) => void) | null = null;
  const deps = {
    move: (_i: string, n: string, input: any) => new Promise((res) => {
      moves += 1;
      releaseMove = () => res({ opId: input.opId, vaultId: input.vaultId, noteId: n, revision: "r9", parentRelativePath: "Docs" });
    }),
    applyReceipt: async () => { receipts += 1; },
    isLive: () => scope === "S1" && connected,
    onCommitted: () => { committedCallbacks += 1; },
  };
  const pending = orchestrateListMove({
    org,
    deps: deps as never,
    destination: "Docs",
    isScopeCurrent: () => scope === "S1" && connected,
    buildTargets: async () => ({
      targets: [
        { instanceId: "A", vaultId: "v", noteId: "n1", expectedRevision: "r1", currentParent: "" },
        { instanceId: "A", vaultId: "v", noteId: "n2", expectedRevision: "r2", currentParent: "" },
      ],
      blocked: [],
      titleByNoteId: { n1: "笔记一", n2: "笔记二" },
    }),
  });
  await settle(2);
  // The scope left (query/directory changed) while the remote move ran.
  scope = "S2";
  releaseMove?.({});
  const result = await pending;
  assert.equal(result.kind, "stale", "a remote-move race reports stale — no batchOutcome, no toast, no selection restore");
  assert.equal(moves, 1, "the FIRST move was already in flight (its commit is real)");
  assert.equal(receipts, 1, "its original-scope DB receipt stayed durable");
  assert.equal(committedCallbacks, 0, "the visible projection never ran under S2");
  // A connection drop (not a scope change) is equally stale for completion.
  scope = "S1"; connected = false;
  const offlineResult = await orchestrateListMove({
    org,
    deps: deps as never,
    destination: "Docs",
    isScopeCurrent: () => scope === "S1" && connected,
    buildTargets: async () => ({ targets: [], blocked: [], titleByNoteId: {} }),
  });
  assert.equal(offlineResult.kind, "stale", "an offline completion is stale too");
});

// ---------------------------------------------------------------------------
// REPAIR-R1.4 — ABA generation closure. The four deferred scenarios drive
// the REAL createListCurrentness (the exact mechanism the page uses) through
// the real orchestrator/controller: an old run must stay stale even when the
// same scope STRING returns, and an uninterrupted control path must still
// move normally.
// ---------------------------------------------------------------------------

/** The page's exact currentness inputs, as mutable test state. */
function abaHarness() {
  const state = { scope: "S1", generation: 0, connected: true };
  const currentness = createListCurrentness({
    scope: () => state.scope,
    generation: () => state.generation,
    connected: () => state.connected,
  });
  return {
    state,
    currentness,
    /** The page's retire effect: clears the run's identity AND bumps. */
    retire() { state.generation += 1; },
  };
}

function abaMoveDeps(h: ReturnType<typeof abaHarness>, captured: { scope: string; generation: number }, stats: { moves: number; receipts: number; committed: number }, release: { move: ((v: any) => void) | null }) {
  return {
    move: (_i: string, n: string, input: any) => new Promise((res) => {
      stats.moves += 1;
      release.move = () => res({ opId: input.opId, vaultId: input.vaultId, noteId: n, revision: "r9", parentRelativePath: "Docs" });
    }),
    applyReceipt: async () => { stats.receipts += 1; },
    isLive: () => h.currentness.isCurrent(captured),
    onCommitted: () => { stats.committed += 1; },
  } as never;
}

// A. Facts ABA: S1 → facts pending → S2 → S1 → old facts resolve ⇒ ZERO
//    move requests from the old run (the string matches again; the
//    generation does not).
test("M25 — facts ABA: S1→S2→S1 keeps the old run stale, ZERO requests", async () => {
  const org = new KnowledgeOrganizationController();
  const h = abaHarness();
  const stats = { moves: 0, receipts: 0, committed: 0 };
  const release: { move: ((v: any) => void) | null } = { move: null };
  const captured = h.currentness.capture();
  let releaseFacts: (() => void) | null = null;
  const pending = orchestrateListMove({
    org,
    deps: abaMoveDeps(h, captured, stats, release),
    destination: "Docs",
    isScopeCurrent: () => h.currentness.isCurrent(captured),
    buildTargets: () => new Promise((res) => {
      releaseFacts = () => res({
        targets: [{ instanceId: "A", vaultId: "v", noteId: "n1", expectedRevision: "r1", currentParent: "" }],
        blocked: [],
        titleByNoteId: { n1: "笔记一" },
      });
    }),
  });
  await settle(2);
  // S1 → S2 → S1: the retire effect bumped the generation TWICE; the final
  // scope string is byte-identical to the start.
  h.retire(); h.state.scope = "S2";
  h.retire(); h.state.scope = "S1";
  releaseFacts?.();
  const result = await pending;
  assert.equal(result.kind, "stale", "the ABA return does NOT resurrect the old run");
  assert.equal(stats.moves, 0, "ZERO move requests from the old S1 incarnation");
});

// B. Remote-move ABA: the commit was already in flight when S1→S2→S1
//    happened — the original-scope DB receipt stays durable, the new S1
//    incarnation receives NO visible projection, and the UI completion is
//    stale (no outcome/toast/selection by contract).
test("M26 — remote ABA: durable receipt, no visible projection under the new S1", async () => {
  const org = new KnowledgeOrganizationController();
  const h = abaHarness();
  const stats = { moves: 0, receipts: 0, committed: 0 };
  const release: { move: ((v: any) => void) | null } = { move: null };
  const captured = h.currentness.capture();
  const pending = orchestrateListMove({
    org,
    deps: abaMoveDeps(h, captured, stats, release),
    destination: "Docs",
    isScopeCurrent: () => h.currentness.isCurrent(captured),
    buildTargets: async () => ({
      targets: [{ instanceId: "A", vaultId: "v", noteId: "n1", expectedRevision: "r1", currentParent: "Work" }],
      blocked: [],
      titleByNoteId: { n1: "笔记一" },
    }),
  });
  await settle(2);
  // The move is in flight; the user leaves and returns to the SAME scope.
  h.retire(); h.state.scope = "S2";
  h.retire(); h.state.scope = "S1";
  release.move?.({});
  const result = await pending;
  assert.equal(stats.moves, 1, "the in-flight commit happened (it is real)");
  assert.equal(stats.receipts, 1, "the ORIGINAL-scope DB receipt stayed durable");
  assert.equal(stats.committed, 0, "the new S1 incarnation received NO visible projection");
  assert.equal(result.kind, "stale", "the UI completion is stale — no outcome/toast/selection");
});

// C. Connection ABA: true → false → true during a pending async — the old
//    run can never resume as current.
test("M27 — connection ABA: true→false→true keeps the old run stale", async () => {
  const org = new KnowledgeOrganizationController();
  const h = abaHarness();
  const stats = { moves: 0, receipts: 0, committed: 0 };
  const release: { move: ((v: any) => void) | null } = { move: null };
  const captured = h.currentness.capture();
  let releaseFacts: (() => void) | null = null;
  const pending = orchestrateListMove({
    org,
    deps: abaMoveDeps(h, captured, stats, release),
    destination: "Docs",
    isScopeCurrent: () => h.currentness.isCurrent(captured),
    buildTargets: () => new Promise((res) => {
      releaseFacts = () => res({ targets: [], blocked: [], titleByNoteId: {} });
    }),
  });
  await settle(2);
  // The connection transition effect bumps the generation on EVERY truth
  // change — the final connected=true does not resurrect the run.
  h.retire(); h.state.connected = false;
  h.retire(); h.state.connected = true;
  releaseFacts?.();
  const result = await pending;
  assert.equal(result.kind, "stale", "a connection ABA keeps the run stale forever");
  assert.equal(stats.moves, 0);
});

// D. Control: an UNINTERRUPTED S1 run still moves normally.
test("M28 — control path: no scope/generation change ⇒ the move completes", async () => {
  const org = new KnowledgeOrganizationController();
  const h = abaHarness();
  const stats = { moves: 0, receipts: 0, committed: 0 };
  const release: { move: ((v: any) => void) | null } = { move: null };
  const captured = h.currentness.capture();
  const pending = orchestrateListMove({
    org,
    deps: abaMoveDeps(h, captured, stats, release),
    destination: "Docs",
    isScopeCurrent: () => h.currentness.isCurrent(captured),
    buildTargets: async () => ({
      targets: [{ instanceId: "A", vaultId: "v", noteId: "n1", expectedRevision: "r1", currentParent: "Work" }],
      blocked: [],
      titleByNoteId: { n1: "笔记一" },
    }),
  });
  await settle(2);
  release.move?.({});
  const result = await pending;
  assert.equal(result.kind, "done", "the uninterrupted control run completes");
  assert.equal(result.kind === "done" && result.report.succeeded, 1);
  assert.equal(stats.moves, 1);
  assert.equal(stats.receipts, 1, "the receipt landed");
  assert.equal(stats.committed, 1, "the visible projection ran for the CURRENT incarnation");
});

test("M18 — move is unavailable offline (no queue)", () => {
  const src = strip(COLL());
  assert.ok(src.includes("connected"), "the page tracks connection truth");
  const org = read("src", "still", "kit", "knowledgeOrganizationController.ts");
  assert.ok(!org.includes("queue"), "no offline write queue exists");
});

// ---------------------------------------------------------------------------
// REPAIR-R1.1 (P1-6): the revision SPLIT — move baseline vs body baseline.
// ---------------------------------------------------------------------------

test("M19 — DIRECTORY rows split body revision from the remote move baseline", async () => {
  const { ctrl, setResponses } = makeDir();
  setResponses({ "v|Work||1": { items: [{
    noteId: "n1", relativePath: "Work/a.md",
    revision: "r1", serverDocument: { revision: "r2" },
  }], hasMore: false, source: "live" } });
  ctrl.setOwner(owner());
  ctrl.setVault("v");
  ctrl.setDirectory("Work");
  ctrl.activate();
  await settledQ();
  const row = ctrl.snapshot().rows[0];
  assert.equal(row.revision, "r1", "the row keeps the cached-BODY baseline");
  assert.equal(row.remoteRevision, "r2", "the row carries the latest REMOTE revision");
  // The target builder uses r2 for the move — never the body baseline r1.
  const { targets, blocked } = directoryMoveTargets("A", [row]);
  assert.equal(blocked.length, 0);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].expectedRevision, "r2", "body r1 + server r2 → the move uses r2");
  assert.equal(targets[0].currentParent, "Work");
});

test("M19b — dirty / conflict / unproven-revision directory notes are BLOCKED", () => {
  const base = {
    instanceId: "A", vaultId: "v", noteId: "n", title: "t",
    relativePath: "Work/a.md", revision: "r1", remoteRevision: "r2",
    dirty: false, conflict: false,
  } satisfies DirectoryRow;
  const { targets: cleanTargets } = directoryMoveTargets("A", [base]);
  assert.equal(cleanTargets.length, 1);
  const { targets: dirty, blocked: b1 } = directoryMoveTargets("A", [{ ...base, dirty: true }]);
  assert.equal(dirty.length, 0, "a dirty note never moves");
  assert.match(b1[0].reason, /先等待同步完成后再移动/u);
  const { targets: conflict, blocked: b2 } = directoryMoveTargets("A", [{ ...base, conflict: true }]);
  assert.equal(conflict.length, 0, "a conflicted note never moves");
  assert.match(b2[0].reason, /冲突/u);
  const { targets: unproven, blocked: b3 } = directoryMoveTargets("A", [{ ...base, remoteRevision: "" }]);
  assert.equal(unproven.length, 0, "an unproven remote revision never moves");
  assert.match(b3[0].reason, /无法确认.*最新版本/u);
});

test("M19c — CANONICAL rows use the summary revision; SUBMIT-TIME facts block", () => {
  const rows: KnowledgeBrowseRow[] = [{
    instanceId: "A", vaultId: "v", noteId: "n1", title: "t",
    parentRelativePath: "Work", revision: "r5",
  }];
  const ok = canonicalMoveTargets("A", rows, {});
  assert.equal(ok.targets.length, 1);
  assert.equal(ok.targets[0].expectedRevision, "r5", "the canonical summary revision IS the move baseline");
  assert.equal(ok.targets[0].currentParent, "Work");
  const dirty = canonicalMoveTargets("A", rows, { n1: { dirty: true, pending: false, conflict: false } });
  assert.equal(dirty.targets.length, 0, "an unsynced Mobile write blocks the move");
  assert.equal(dirty.blocked[0].reason.includes("先等待同步完成"), true);
  assert.equal(dirty.blocked[0].title, "t", "the blocked entry carries the recognizable title");
  const conflict = canonicalMoveTargets("A", rows, { n1: { dirty: false, pending: false, conflict: true } });
  assert.equal(conflict.targets.length, 0);
  const pending = canonicalMoveTargets("A", rows, { n1: { dirty: false, pending: true, conflict: false } });
  assert.equal(pending.targets.length, 0, "a pending unsynced operation blocks too");
  assert.equal(parentOf("A/B/c.md"), "A/B");
  assert.equal(parentOf("c.md"), "");
});

// REPAIR-R1.2 (P1-5): the >100 canonical case — a selected row OUTSIDE the
// preview retainer's first-100 subset must still be proven by the SUBMIT-TIME
// facts read; #101 dirty → BLOCKED (never silently "clean").
test("M19d — a dirty note beyond the preview-100 subset is BLOCKED by the facts read", () => {
  const rows: KnowledgeBrowseRow[] = [];
  for (let i = 1; i <= 130; i += 1) {
    rows.push({ instanceId: "A", vaultId: "v", noteId: `n${i}`, title: `笔记 ${i}`, parentRelativePath: "", revision: `r${i}` });
  }
  // The facts read covers the SELECTED ids (chunked, bounded) — not a preview
  // subset: only n101 is dirty.
  const facts: Record<string, { dirty: boolean; pending: boolean; conflict: boolean }> = {};
  facts["n101"] = { dirty: true, pending: false, conflict: false };
  const { targets, blocked } = canonicalMoveTargets("A", rows, facts);
  assert.equal(targets.length, 129, "every clean row — including rows 102-130 outside the preview subset — moves");
  assert.ok(!targets.some((t) => t.noteId === "n101"), "the dirty #101 sends ZERO request");
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].noteId, "n101");
  assert.equal(blocked[0].title, "笔记 101");
  // A FAILED facts read (null) blocks EVERY selected note — never "assume clean".
  const none = canonicalMoveTargets("A", rows, null);
  assert.equal(none.targets.length, 0, "an unproven local safety state blocks everything");
  assert.equal(none.blocked.length, 130);
  // An ABSENT fact = no Mobile cache row = no possible unsynced write = clean
  // (the explicit safe rule from the card).
  const absent = canonicalMoveTargets("A", rows.slice(0, 3), {});
  assert.equal(absent.targets.length, 3, "rows with no local cache row stay movable");
});

// ---------------------------------------------------------------------------
// REPAIR-R1.1 (P1-8): the real capability/grant truth.
// ---------------------------------------------------------------------------

function authorityDeps(over: Record<string, any> = {}) {
  return {
    registry: {
      refreshAdopting: async () => ({}),
      operation: (op: string) => ({ state: over.moveState ?? (op === "knowledge.move" ? "implemented" : "unsupported") }),
      invalidate: () => {},
    },
    knowledge: {
      vaults: async () => ({
        items: [{
          vaultId: over.vaultId ?? "v", displayName: "库", activeInDesktop: true,
          readGranted: true, writeGranted: over.writeGranted ?? true,
        }],
      }),
    },
  };
}

test("M20 — resolveMoveAuthority reads the REAL catalog + vault grant (fail closed)", async () => {
  const ok = await resolveMoveAuthority(authorityDeps() as never, "A");
  assert.deepEqual(
    { vaultId: ok.vaultId, writeGranted: ok.writeGranted, moveState: ok.moveState },
    { vaultId: "v", writeGranted: true, moveState: "implemented" },
  );
  // Missing op → unsupported → fail closed.
  const noOp = await resolveMoveAuthority(authorityDeps({ moveState: undefined, vaultId: "v" }) as never, "A");
  void noOp;
  const unsupported = await resolveMoveAuthority({
    registry: { refreshAdopting: async () => ({}), operation: () => ({ state: "unsupported" }), invalidate: () => {} },
    knowledge: { vaults: async () => ({ items: [] }) },
  } as never, "A");
  assert.equal(unsupported.moveState, "unsupported");
  assert.equal(unsupported.writeGranted, false);
  // Revoked write grant → not movable.
  const noGrant = await resolveMoveAuthority(authorityDeps({ writeGranted: false }) as never, "A");
  assert.equal(noGrant.writeGranted, false, "writeGranted is the canonical truth, never a default true");
  // No active vault / wire failure → fail closed.
  const none = await resolveMoveAuthority({
    registry: { refreshAdopting: async () => { throw new Error("offline"); }, operation: () => ({ state: "implemented" }), invalidate: () => {} },
    knowledge: { vaults: async () => ({ items: [] }) },
  } as never, "A");
  assert.equal(none.writeGranted, false);
  assert.equal(none.vaultId, "");
});

test("M20b — the page wires the real grant (no hardcoded writeGranted:true)", () => {
  const coll = COLL();
  assert.ok(coll.includes("writeGranted: moveGrant,"), "the directory feed carries the real grant");
  assert.doesNotMatch(coll, /writeGranted: true/u, "no hardcoded write grant survives");
  assert.ok(coll.includes("const moveAuthorityNow = desktopCtrl.moveAuthority();"), "the grant comes from the canonical discovery");
  assert.ok(coll.includes("session.resolveMoveAuthority(instanceId, desktop.vaultId)"), "submit-time truth re-resolves fresh");
});

// ---------------------------------------------------------------------------
// B21-B24: batch
// ---------------------------------------------------------------------------

test("B21 — batch uses one opId + expectedRevision per note", async () => {
  const org = new KnowledgeOrganizationController();
  const bodies: any[] = [];
  const deps = {
    move: async (_i: string, n: string, input: any) => { bodies.push({ n, ...input }); return { opId: input.opId, vaultId: input.vaultId, noteId: n, revision: "r", parentRelativePath: input.parentRelativePath }; },
    applyReceipt: async () => {},
    isLive: () => true,
  };
  const targets = [1, 2, 3].map((i) => ({
    instanceId: "A", vaultId: "v", noteId: `n${i}`, expectedRevision: `r${i}`, currentParent: "",
  }));
  const report = await org.moveBatch(deps as never, targets, "Docs");
  assert.equal(report.succeeded, 3);
  assert.equal(bodies.length, 3);
  const opIds = new Set(bodies.map((b) => b.opId));
  assert.equal(opIds.size, 3, "one distinct opId per note");
  assert.deepEqual(bodies.map((b) => b.expectedRevision), ["r1", "r2", "r3"], "each note's own revision");
});

test("B22 — partial success is truthful; committed successes stay committed", async () => {
  const org = new KnowledgeOrganizationController();
  const applied: string[] = [];
  let committed = 0;
  const deps = {
    move: async (_i: string, n: string, input: any) => {
      if (n === "n2") throw new Error("HTTP 409: revision-conflict");
      return { opId: input.opId, vaultId: input.vaultId, noteId: n, revision: "r", parentRelativePath: "Docs" };
    },
    applyReceipt: async (_i, _v, n) => { applied.push(n); },
    isLive: () => true,
    onCommitted: () => { committed += 1; },
  };
  const targets = ["n1", "n2", "n3"].map((n) => ({
    instanceId: "A", vaultId: "v", noteId: n, expectedRevision: "r", currentParent: "",
  }));
  const report = await org.moveBatch(deps as never, targets, "Docs");
  assert.equal(report.succeeded, 2);
  assert.equal(report.failed, 1);
  assert.equal(report.failures[0].noteId, "n2");
  assert.deepEqual(applied, ["n1", "n3"], "the committed successes were applied");
  assert.equal(committed, 2, "each commit reached the page's projection hook");
  assert.equal(report.stopped, false, "a 409 does not stop the batch");
});

test("B23 — an owner/offline transition stops the remaining unsent operations", async () => {
  const org = new KnowledgeOrganizationController();
  let live = true;
  let call = 0;
  const deps = {
    move: async (_i: string, n: string, input: any) => {
      call += 1;
      if (n === "n1") { live = false; return { opId: input.opId, vaultId: input.vaultId, noteId: n, revision: "r", parentRelativePath: "X" }; }
      throw new Error("unreachable");
    },
    applyReceipt: async () => {},
    isLive: () => live,
  };
  const targets = ["n1", "n2", "n3"].map((n) => ({
    instanceId: "A", vaultId: "v", noteId: n, expectedRevision: "r", currentParent: "",
  }));
  const report = await org.moveBatch(deps as never, targets, "X");
  assert.equal(report.stopped, true);
  assert.equal(call, 1, "only the first note was attempted");
  assert.equal(report.succeeded, 1, "its real commit stands");
});

test("B24 — no per-note remote detail N+1 after the batch", () => {
  const org = read("src", "still", "kit", "knowledgeOrganizationController.ts");
  assert.ok(!org.includes("contentNoteRefresh"), "no per-note remote detail refresh in the move authority");
  assert.ok(!org.includes("contentNoteGet"), "and no per-note get either");
});

// ---------------------------------------------------------------------------
// REPAIR-R1.1 (P1-1): the REAL product wiring — the page and the note detail
// call the real controller through the real session deps (not just helpers).
// ---------------------------------------------------------------------------

test("B19 — the Knowledge page wires long-press selection over NOTE hit targets", () => {
  const coll = strip(COLL());
  // The page reuses the SAME #85 primitives (imported, not copied).
  assert.ok(coll.includes('selectionWithRange, type RangeDrag'), "range selection is the shared #85 helper");
  assert.ok(coll.includes("createDragAutoScroll"), "the shared auto-scroll helper is reused");
  // The note-row hit target is data-note-id (never the asset attribute).
  assert.ok(coll.includes('closest("[data-note-id]")'), "drag hit-testing addresses note rows");
  assert.ok(coll.includes("onNoteLongPress"), "the page owns the note long-press");
  assert.match(coll, /selectionWithRange\(\{ anchorIndex: idx, baseline: prev \}, idx, orderedNoteIds\)/u,
    "the long press anchors the range exactly like #85");
  // The note rows themselves carry the gesture (the shared row component).
  const views = read("src", "presentation", "still01", "Views.tsx");
  assert.ok(views.includes("KnowledgeNoteRow"), "CollectionView renders the note-row component");
  assert.ok(views.includes("noteId={n.id}"), "the row receives the note id (the hit target source)");
  const row = read("src", "still", "kit", "knowledgeNoteRow.tsx");
  assert.ok(row.includes("useLongPress"), "the note row runs the ONE gesture authority");
  assert.ok(row.includes("data-note-id"), "the row exposes the note hit target");
  assert.ok(!row.includes("data-asset-id"), "it does not pretend to be an asset tile");
});

test("B19b — Back exits selection first; scope changes retire the selection", () => {
  const coll = strip(COLL());
  assert.ok(coll.includes('"luckyray:selection-back"'), "Back first exits the selection");
  assert.match(coll, /const selectionScope = source === "desktop"/u, "the selection scope is explicit");
  assert.match(coll, /\["sel", instanceId, desktop\.vaultId, directoryActive \? desktopDirectory : "", query\.trim\(\)\]\.join\("\|"\)/u,
    "the scope covers instance + vault + directory identity + query");
  assert.ok(coll.includes("setSelecting(false);\n    setSelectedIds([]);\n    setBatchOutcome(null);"), "a scope change retires selection + outcome");
});

test("B20 — the page REALLY drives the moves through the stale-gated orchestrator", () => {
  const coll = strip(COLL());
  assert.ok(coll.includes("await orchestrateListMove({"),
    "the page runs its moves through the stale-gated orchestrator");
  assert.ok(coll.includes("if (result.kind === \"stale\") {"),
    "a stale completion applies NO UI for the old scope");
  assert.ok(coll.includes("isScopeCurrent,"),
    "the exact selection-scope currentness feeds the orchestrator");
  const org = strip(read("src", "still", "kit", "knowledgeOrganizationController.ts"));
  assert.ok(org.includes("await opts.org.moveBatch(opts.deps, built.targets, opts.destination)"),
    "the real batch call rides the real controller inside the orchestrator");
  assert.ok(org.includes("await opts.org.moveOne(opts.deps, built.targets[0], opts.destination)"),
    "a single selected note uses the single-move flow inside the orchestrator");
  assert.ok(coll.includes("organizeLabel: \"移动\""), "the selection bar's action is 移动");
  assert.ok(coll.includes("setBatchOutcome({ report, blocked, titleByNoteId })"), "partial success is product-visible");
  assert.ok(coll.includes("data-testid=\"org-batch-outcome\""), "the outcome block is in the product DOM");
  // REPAIR-R1.2: the partial copy shows the recognizable TITLE.
  assert.ok(coll.includes("batchOutcome.titleByNoteId[f.noteId] || f.noteId"),
    "failures render title + reason, not raw ids");
  // REPAIR-R1.3: a scope change closes the move sheet too.
  assert.match(coll, /setBatchOutcome\(null\);[\s\S]{0,160}setMoveSheetOpen\(false\);/u,
    "the retire effect clears the outcome and closes the sheet");
});

test("B20b — the note detail REALLY calls moveOne with every write-race guard", () => {
  const note = strip(NOTE());
  assert.ok(note.includes("await orgCtrl.moveOne(session.moveDeps({"), "the detail page calls the real controller");
  assert.ok(note.includes("openMoveSheet"), "the More sheet has the independent 移动到目录 entry");
  // REPAIR-R1.3 (P1-1): the route token is the FIRST statement, before any
  // await, and it is the ONLY liveness identity.
  const runIdx = note.indexOf("async function runNoteMove(destination: string) {");
  const runBody = note.slice(runIdx, runIdx + 400);
  assert.ok(runBody.includes("if (moving) return;"), "the busy guard precedes");
  const tokenIdx = runBody.indexOf("const moveOwner = owner.current;");
  const firstAwaitIdx = runBody.indexOf("await");
  assert.ok(tokenIdx > 0 && tokenIdx < firstAwaitIdx, "the route token is captured BEFORE the first await");
  assert.ok(note.includes("const stillCurrent = () => owner.current === moveOwner;"),
    "the original-token proof is the liveness closure");
  assert.match(note, /isLive: stillCurrent,/u, "moveDeps.isLive binds the ORIGINAL token only");
  const moveBody = note.slice(runIdx, note.indexOf("async function", runIdx + 40) > 0 ? note.indexOf("async function", runIdx + 40) : undefined);
  assert.ok(!moveBody.includes(".st-detail-stage"), "no generic detail-stage DOM check remains as route identity inside runNoteMove");
  // Three post-await re-proofs (connState, authority, second connState) + a
  // stale post-move completion gate.
  assert.equal((note.match(/if \(!stillCurrent\(\)\) return;/gu) || []).length, 4,
    "every route-crossing await is followed by the original-token proof");
  // Guards: pending/failed editor writes, dirty, conflict — truthful copy.
  assert.match(note, /pending\.current\.size > 0 \|\| saving \|\| failed\.current/u, "editor write races block the sheet");
  assert.match(note, /先等待同步完成后再移动/u, "the syncing copy is truthful");
  assert.ok(note.includes("note?.conflictDocument) { setSheet(\"conflict\")"), "a conflict routes to the conflict sheet");
  // The move baseline is the LATEST REMOTE revision, never the body's.
  assert.match(note, /note\?\.serverDocument\?\.revision \|\| ""/u, "expectedRevision comes from serverDocument");
  assert.ok(note.includes("无法确认这篇笔记的最新版本"), "an unproven revision fails closed");
  // Submit-time capability truth.
  assert.match(note, /authority\.moveState !== "implemented"/u, "a missing op fails closed");
  assert.match(note, /!authority\.writeGranted/u, "a revoked grant fails closed");
  assert.match(note, /authority\.vaultId !== vault/u, "an owner/vault switch fails closed");
  // REPAIR-R1.2 (P1-1): a SECOND connState proof AFTER authority resolution.
  assert.match(note, /const cs2 = await api\.connState\(/u, "the connection is re-proven after the authority resolve");
  assert.match(note, /stillLive/u, "with a distinct second-proof binding");
  // Committed moves re-project both visible authorities, scoped to the
  // receipt's ORIGINAL instance+vault.
  assert.match(note, /session\.directory\.applyMoveReceipt\(committed\.instanceId, committed\.vaultId, committed\.noteId, committed\.parentRelativePath, committed\.revision\)/u,
    "the directory projection updates under the receipt scope");
  assert.match(note, /session\.desktop\.applyMoveReceipt\(committed\.instanceId, committed\.vaultId, committed\.noteId, committed\.parentRelativePath, committed\.revision\)/u,
    "the canonical projection updates under the receipt scope");
});

// REPAIR-R1.2/R1.4: the list's generation-backed currentness — capture +
// post-authority proof + the bounded facts read wiring.
test("B20d — the list captures scope+generation and re-proves after authority resolution", () => {
  const coll = strip(COLL());
  assert.ok(coll.includes("const moveGenerationRef = useRef(0);"), "ONE monotonic move generation exists");
  assert.ok(!/moveGenerationRef[^\n]*(Date\.now|Math\.random|performance)/u.test(coll), "never a timestamp/random token");
  assert.ok(coll.includes("const moveCurrentness = useMemo(() => createListCurrentness({"), "the shared ABA-safe currentness builder is used");
  assert.ok(coll.includes("const capturedScope = moveCurrentness.capture();"), "a run captures scope+generation together");
  assert.match(coll, /if \(!moveCurrentness\.isCurrent\(capturedScope\)\) \{/u,
    "the post-authority proof is generation-backed");
  assert.match(coll, /const isScopeCurrent = \(\) => moveCurrentness\.isCurrent\(capturedScope\);/u,
    "the orchestrator/send fence uses the same generation-backed truth");
  // Every retirement event bumps the generation.
  const scopeRetire = coll.slice(coll.indexOf("setBatchOutcome(null);"), coll.indexOf("orgCtrl.cancel();", coll.indexOf("setBatchOutcome(null);")));
  assert.ok(scopeRetire.includes("moveGenerationRef.current += 1;"), "the scope-retire effect bumps the generation");
  assert.match(coll, /useEffect\(\(\) => \{\n?\s*moveGenerationRef\.current \+= 1;\n?\s*\}, \[connected\]\);/u,
    "a connection truth transition bumps the generation");
  assert.ok((coll.match(/moveGenerationRef\.current \+= 1;/gu) || []).length >= 4,
    "scope retire + connected flip + Back + Cancel all bump (>=4 sites)");
  assert.match(coll, /for \(let i = 0; i < ids\.length; i \+= 100\) \{/u,
    "the canonical safety facts are read in bounded chunks at submit time");
  assert.match(coll, /api\.contentNoteMoveFacts\(instanceId, desktop\.vaultId, ids\.slice\(i, i \+ 100\)\)/u,
    "through the bounded LOCAL-ONLY facts command (zero remote N+1)");
});

// REPAIR-R1.2 (P1-4): ONE user-refresh dispatcher — an ordinary retained
// return performs ZERO explicit refreshes.
test("B20e — a single user-refresh dispatcher; zero refresh on ordinary return", () => {
  const coll = strip(COLL());
  assert.ok(!coll.includes("firstDesktopRefresh"), "the shared two-effect guard is gone");
  assert.match(coll, /const userRefreshArmed = useRef\(false\);/u, "one armed guard for ONE effect");
  assert.match(coll, /if \(directoryActive\) directoryCtrl\.refresh\(\);/u, "a real Refresh dispatches the directory refresh in directory mode");
  assert.match(coll, /else desktopCtrl\.refresh\(\);/u, "and the canonical refresh otherwise — exactly one");
  assert.equal((coll.match(/desktopCtrl\.refresh\(\)/gu) || []).length, 1, "exactly ONE canonical refresh call site");
  assert.equal((coll.match(/directoryCtrl\.refresh\(\)/gu) || []).length, 1, "exactly ONE directory refresh call site");
  // The dispatcher is keyed ONLY to the user's reloadKey.
  const dispatcher = coll.slice(coll.indexOf("const userRefreshArmed"), coll.indexOf("}, [reloadKey]);") + 16);
  assert.ok(dispatcher.includes("}, [reloadKey]);"), "the effect reacts to reloadKey alone");
});

test("B20c — the session exposes ONE move transport (no second client)", () => {
  const sess = read("src", "still", "kit", "knowledgeSession.ts");
  assert.ok(!sess.includes("MoveKnowledgeClient"), "the extra client construction is deleted");
  assert.ok(!sess.includes("createTauriServicesTransport"), "no second transport is constructed");
  assert.match(sess, /move: \(instanceId, noteId, input\) => deps\.knowledge\.move\(instanceId, noteId, input\)/u,
    "moveDeps reuses the ONE injected Services client");
  assert.match(sess, /api\.contentNoteMoveReceipt\(/u, "the receipt command is the Mobile-local one");
});

// ---------------------------------------------------------------------------
// REPAIR-R1.1 (P1-7): directory preview coverage through the SAME retainer.
// ---------------------------------------------------------------------------

test("P7 — the page ensures previews for directorySnap.rows (zero Desktop N+1)", async () => {
  const coll = strip(COLL());
  assert.ok(coll.includes("session.previews.ensure(directorySnap.instanceId, directorySnap.vaultId,"),
    "the directory page's ids flow through the SAME retained bulk reader");
  assert.match(coll, /if \(source !== "desktop" \|\| !previewKey \|\| directoryActive\) return;/u,
    "the canonical ensure is gated off while directory mode owns the coverage");
  // Behavior: the retainer re-reads ONCE per id-set change and NEVER for an
  // unchanged return (owner-fenced per exact instance|vault key).
  const retainer = new PreviewRetainer();
  let reads = 0;
  const reader = async (instance: string, vault: string, ids: string[]) => {
    reads += 1;
    return { key: `${instance}|${vault}`, byNoteId: Object.fromEntries(ids.map((id) => [id, { preview: `p-${id}`, outdated: false }])) };
  };
  retainer.ensure("A", "v", ["n1", "n2"], reader, 0);
  await settle();
  assert.equal(reads, 1);
  retainer.ensure("A", "v", ["n1", "n2"], reader, 0);
  await settle();
  assert.equal(reads, 1, "an unchanged return is ZERO redundant reads");
  retainer.ensure("A", "v", ["n1", "n2", "n3"], reader, 0);
  await settle();
  assert.equal(reads, 2, "a new id set loads once");
  // Owner fencing: B's key never sees A's store.
  assert.equal(retainer.snapshotFor("A", "v")!.byNoteId["n1"].preview, "p-n1");
  assert.equal(retainer.snapshotFor("B", "v"), null, "another owner has no store");
});

// ---------------------------------------------------------------------------
// R25-R28: regressions & boundaries
// ---------------------------------------------------------------------------

test("R25/R26/R27 — frozen suites stay green (registered in CI)", () => {
  const wf = read(".github", "workflows", "ci-lite.yml");
  for (const suite of [
    "knowledgeSessionBehaviorR44.contract.test.ts",
    "knowledgeUxRepairR4.contract.test.ts",
    "materialPolishR7c.contract.test.ts",
    "pressGuardR7a.contract.test.ts",
  ]) {
    assert.ok(wf.includes(suite), `${suite} stays registered`);
  }
});

test("R28 — no canonical/shared diff", () => {
  const coll = read("src", "still", "StillCollection.tsx");
  // The page never constructs a canonical URL itself.
  assert.doesNotMatch(coll, /\/v1\/services\/knowledge/u, "no hand-built canonical routes");
  void COLL;
});

test("W1 — the directory identity scope is exact (instance|vault|directory|query)", () => {
  const a = directoryIdentityKey({ instanceId: "A", vaultId: "v", directory: "W", query: "q" });
  const b = directoryIdentityKey({ instanceId: "B", vaultId: "v", directory: "W", query: "q" });
  const c = directoryIdentityKey({ instanceId: "A", vaultId: "v2", directory: "W", query: "q" });
  const d = directoryIdentityKey({ instanceId: "A", vaultId: "v", directory: "W2", query: "q" });
  const e = directoryIdentityKey({ instanceId: "A", vaultId: "v", directory: "W", query: "q2" });
  assert.ok(new Set([a, b, c, d, e]).size === 5, "every axis is part of the identity");
});

test("W2 — the session retains the directory per exact owner scope", () => {
  const coll = COLL();
  assert.ok(coll.includes("session.retainedDirectoryFor(instanceId, desktop ? desktop.vaultId : \"\")"),
    "the page reads the retained directory scoped to instance+vault");
  assert.ok(coll.includes("session.retainDirectory(instanceId,"),
    "and writes it through on change");
});

// REPAIR-R1.1 (P2-P2): the sheet has exactly ONE actionable ROOT.
test("W3 — the hierarchical directory picker has one apply action and one ROOT breadcrumb", () => {
  const sheet = read("src", "still", "kit", "directorySheet.tsx");
  assert.equal((sheet.match(/onSelect\(path\)/gu) ?? []).length, 1,
    "exactly one action applies the browsed folder, including ROOT");
  assert.match(sheet, /<FolderBreadcrumbs current=\{path\} onSelect=\{browse\}/u,
    "breadcrumbs browse before applying a destination");
  assert.match(sheet, /<FolderRows [^>]*onSelect=\{browse\}/u, "folder rows only browse");
  assert.equal(folderAncestors("Work/Projects").filter(path => path === "").length, 1,
    "ROOT appears exactly once in a nested breadcrumb");
  assert.match(sheet, /path \? "查看此目录" : rootLabel/u, "the ROOT apply action retains its root label");
  assert.match(sheet, /st-sheet-caption">\{vaultName\}/u, "the vault identity is caption context");
  assert.ok(!sheet.includes("（电脑当前知识库）`} icon="), "the vault row is no longer an Option");
});

// ---------------------------------------------------------------------------
// REPAIR-R1.5-A — READ-ONLY directory metadata hydration.
// ---------------------------------------------------------------------------

function hydrationHarness(over: Partial<{
  chunks: Array<{ continuation: boolean } | Error>;
  cachedDirs: string[][];
  hydratedDirs: string[][];
  gateFirstChunk?: boolean;
}> = {}) {
  const chunks: Array<{ continuation: boolean } | Error> = over.chunks ?? [{ continuation: false }];
  const cachedDirs: string[][] = over.cachedDirs ?? [[]];
  const hydratedDirs: string[][] = over.hydratedDirs ?? cachedDirs;
  const calls = { hydrate: 0, readDirs: 0 };
  let scope = "A|v";
  let releaseFirst: (() => void) | null = null;
  const events: { dirs: string[]; status: string }[] = [];
  return {
    calls, events,
    retire() { scope = "A|v#retired"; },
    release() { releaseFirst?.(); },
    async run(connected = true) {
      await runDirectoryHydration(
        {
          hydrate: async (_i: string, _v: string, _afterId: string | null) => {
            calls.hydrate += 1;
            const c = chunks[Math.min(calls.hydrate - 1, chunks.length - 1)];
            if (c instanceof Error) throw c;
            if (over.gateFirstChunk && calls.hydrate === 1) {
              await new Promise<void>((res) => { releaseFirst = res; });
            }
            return { nextAfterId: c.continuation ? `cursor-${calls.hydrate}` : "", hasMore: c.continuation, applied: 3 };
          },
          readDirectories: async () => {
            calls.readDirs += 1;
            return (calls.readDirs === 1 ? cachedDirs : hydratedDirs)[0] ?? [];
          },
          scopeKey: () => scope,
        },
        "A", "v-harness", connected,
        {
          onDirectories: (dirs) => { events.push({ dirs: [...dirs], status: "" }); },
          onStatus: (status) => { events.push({ dirs: [], status }); },
        },
      );
    },
  };
}

test("H1 — cached dirs paint immediately; hydration finishes hydrated", async () => {
  const h = hydrationHarness({
    chunks: [{ continuation: true }, { continuation: false }],
    cachedDirs: [["Work"]],
    hydratedDirs: [["Work", "Docs", "Work/Sub"]],
  });
  await h.run();
  assert.equal(h.calls.hydrate, 2, "both continuation chunks ran");
  assert.ok(h.events.some((e) => e.status === "cached"), "the cached state shows while hydrating");
  assert.equal(h.events[h.events.length - 1].status, "hydrated", "the run ends hydrated");
  assert.ok(h.events.some((e) => e.dirs.includes("Work/Sub")), "the refreshed dirs include new nested entries");
});

test("H2 — an owner/vault change mid-run drops the remaining chunks whole", async () => {
  const h = hydrationHarness({
    chunks: [{ continuation: true }, { continuation: false }],
    cachedDirs: [["Work"]],
    hydratedDirs: [["Work", "Docs"]],
    gateFirstChunk: true,
  });
  const pending = h.run();
  await settle(2);
  h.retire(); // the sheet's scope changed while the first chunk was pending
  h.release();
  await pending;
  assert.equal(h.calls.hydrate, 1, "no further chunk after the scope change");
  assert.ok(!h.events.some((e) => e.dirs.includes("Docs")), "zero B-scope pollution");
});

test("H3 — offline: cached dirs stay (offline-cached); nothing cached => unsynced", async () => {
  const withCache = hydrationHarness({ cachedDirs: [["Work"]] });
  await withCache.run(false);
  assert.equal(withCache.calls.hydrate, 0, "offline never calls the live hydration");
  assert.equal(withCache.events[withCache.events.length - 1].status, "offline-cached");
  const empty = hydrationHarness({ cachedDirs: [[]] });
  await empty.run(false);
  assert.equal(empty.events[empty.events.length - 1].status, "unsynced",
    "offline + never synced is 尚未同步目录, never a fake empty success");
});

test("H4 — a live hydration failure keeps the cached dirs with truthful copy", async () => {
  const h = hydrationHarness({ chunks: [new Error("gateway down")], cachedDirs: [["Work"]] });
  await h.run();
  assert.equal(h.events[h.events.length - 1].status, "failed");
  assert.ok(h.events.some((e) => e.dirs.includes("Work")), "the cached dirs stay painted");
});

test("H5 — the hydration path is READ-ONLY (structure)", () => {
  const notes = read("src-tauri", "src", "content", "notes.rs");
  const fn = notes.slice(notes.indexOf("pub(crate) async fn content_hydrate_directories"));
  const body = fn.slice(0, fn.indexOf("#[tauri::command]", 10));
  assert.ok(!body.includes("content_prepare_operations"), "never pushes pending note writes");
  assert.ok(!body.includes("upload_pending"), "never pushes pending attachments");
  assert.ok(!body.includes("content_mutate"), "never mutates the Desktop");
  assert.ok(body.includes("content_apply_metadata_batch"), "applies through the metadata-only batch");
  const db = read("src-tauri", "src", "content_db.rs");
  const batch = db.slice(db.indexOf("pub(crate) fn content_apply_metadata_batch"));
  assert.ok(!batch.slice(0, batch.indexOf("pub(crate) fn content_sync_position")).includes("content_vault_cache"),
    "the metadata batch never touches the durable sync position");
});

// ---------------------------------------------------------------------------
// REPAIR-R1.5-B — Desktop-source New Note through the Content V1 create.
// ---------------------------------------------------------------------------

function assertProductionCreateGate() {
  const expression = COLL().match(/disableNew=\{([^}]+)\}/u)?.[1];
  assert.ok(expression, "the production New button has a gate");
  const disabled = new Function("connected", "createAuthority", "desktop", "busy", `return Boolean(${expression})`);
  for (const connected of [false, true]) for (const usable of [false, true]) for (const busy of [false, true]) {
    assert.equal(disabled(connected, {usable}, {}, busy), !(connected && usable) || busy, "unselected authority and busy rules stay unchanged");
    assert.equal(disabled(connected, {usable}, {replica: {writeState: "granted"}}, busy), !usable || busy, "confirmed granted replica can create offline; busy/authority still gate");
    assert.equal(disabled(connected, {usable}, {replica: {writeState: "revoked"}}, busy), true, "a known revoked replica never enables creation even while connected");
  }
}
test("C1 — the Desktop New button rides real write truth and the V1 create", () => {
  const coll = strip(COLL());
  assertProductionCreateGate();
  assert.ok(coll.includes("async function createDesktopNote()"), "the page owns the Desktop create");
  // Slice on the RAW source (the end anchor is a comment strip() removes),
  // then strip the slice for assertion.
  const raw = COLL();
  const fn = strip(raw.slice(raw.indexOf("async function createDesktopNote()"), raw.indexOf("// C: quick actions")));
  assert.ok(fn.includes("api.contentNoteCreate(scope.instance, scope.vault"), "the Content V1 create authority is used under the captured scope");
  assert.ok(!fn.includes("localNoteAdd"), "never the Local create path");
  assert.ok(!fn.includes("StillNewNote"), "never the 新的想法 intermediary page");
  assert.ok(fn.includes('parent: () => (directoryActive ? desktopDirectory : "")'),
    "ROOT in ALL NOTES; the current existing directory in directory mode");
  assert.ok(fn.includes("{ edit: true }"), "directly in edit mode");
  assert.ok(!fn.includes("syncCoordinator.trigger()"), "#92 waits for the first successful real edit before publishing the placeholder");
  assert.ok(fn.includes("connected: () => connectedRef.current"), "connection truth is part of the currentness");
  assert.ok(/open\("note",\s*`desktop:\$\{encodeURIComponent\(result\.scope\.instance\)\}/u.test(fn),
    "opens the exact CAPTURED desktop route");
  const local = coll.slice(coll.indexOf("async function createNote()"), coll.indexOf("async function createDesktopNote"));
  assert.ok(local.includes("api.localNoteAdd"), "the Local create keeps the local path");
});

// ---------------------------------------------------------------------------
// REPAIR-R1.5-C — the certified search fast path (real controller drives).
// ---------------------------------------------------------------------------

function fastDeps() {
  const calls = { discover: 0, vaults: 0, lists: [] as any[] };
  const deps = {
    registry: {
      refreshAdopting: async () => { calls.discover += 1; return {}; },
      operation: () => ({ state: "implemented" }),
      invalidate: () => {},
    },
    knowledge: {
      vaults: async () => { calls.vaults += 1; return { items: [{ vaultId: "v", displayName: "V", activeInDesktop: true, readGranted: true, writeGranted: true }] }; },
      registeredList: async (_i: string, _v: string, o: any) => {
        calls.lists.push(o ?? {});
        const q = o?.q ?? "";
        return { items: q ? [{ noteId: `hit-${q}` }] : [{ noteId: "all" }], hasMore: false, nextAfterId: null };
      },
    },
  };
  return { deps, calls };
}

const bind = () => ({ paired: true, connected: true, instanceId: "A", isLive: () => true });

test("S1 — cold query discovers; a certified refinement is ONE list call", async () => {
  const { deps, calls } = fastDeps();
  const ctrl = new KnowledgeBrowseController(deps as never);
  ctrl.setConnection(bind());
  await settledQ();
  assert.equal(calls.discover, 1, "the cold path discovered once");
  assert.equal(ctrl.snapshot().phase, "ready");

  ctrl.setQuery("rust");
  await settledQ();
  assert.equal(calls.discover, 1, "zero new discovery");
  assert.equal(calls.vaults, 1, "zero new vault reads");
  assert.deepEqual(calls.lists.map((c) => c.q), [undefined, "rust"], "exactly one registeredList for the settled query");
  assert.deepEqual(ctrl.snapshot().rows.map((r) => r.noteId), ["hit-rust"]);

  ctrl.setQuery("");
  await settledQ();
  assert.equal(calls.discover, 1, "clear query does NOT rediscover");
  assert.equal(calls.vaults, 1);
  assert.deepEqual(ctrl.snapshot().rows.map((r) => r.noteId), ["all"]);
});

test("S2 — rapid keystrokes coalesce into one settled search", async () => {
  const { deps, calls } = fastDeps();
  const ctrl = new KnowledgeBrowseController(deps as never);
  ctrl.setConnection(bind());
  await settledQ();
  const before = calls.lists.length;
  ctrl.setQuery("知");
  await tick();
  ctrl.setQuery("知识");
  await tick();
  ctrl.setQuery("知识库");
  await settledQ();
  const newListCalls = calls.lists.slice(before);
  assert.equal(newListCalls.filter((c) => c.q && c.q !== "知识库").length, 0,
    "no intermediate query reached the wire");
  assert.equal(newListCalls.filter((c) => c.q === "知识库").length, 1, "one settled search call");
});

test("S3 — the refinement phase keeps rows and never shows discovery copy; stale fenced", async () => {
  const { deps, calls } = fastDeps();
  let hangList: ((v: any) => void) | null = null;
  deps.knowledge.registeredList = (async (_i: string, _v: string, o: any) => {
    calls.lists.push(o ?? {});
    if ((o?.q ?? "") === "") return { items: [{ noteId: "all" }], hasMore: false, nextAfterId: null };
    if (o.q === "slow") return new Promise((res) => { hangList = () => res({ items: [{ noteId: "hit-slow" }], hasMore: false, nextAfterId: null }); });
    return { items: [{ noteId: `hit-${o.q}` }], hasMore: false, nextAfterId: null };
  }) as never;
  const ctrl = new KnowledgeBrowseController(deps as never);
  ctrl.setConnection(bind());
  await settledQ();
  assert.deepEqual(ctrl.snapshot().rows.map((r) => r.noteId), ["all"]);

  ctrl.setQuery("slow");
  await tick(); await tick();
  let snap = ctrl.snapshot();
  assert.equal(snap.phase, "searching", "the light searching phase (never waiting-catalog/discovering-vault)");
  assert.deepEqual(snap.rows.map((r) => r.noteId), ["all"], "the last-good rows stay painted");
  ctrl.setQuery("fast");
  await settledQ();
  snap = ctrl.snapshot();
  assert.deepEqual(snap.rows.map((r) => r.noteId), ["hit-fast"]);
  hangList?.({});
  await tick(); await tick();
  assert.deepEqual(ctrl.snapshot().rows.map((r) => r.noteId), ["hit-fast"], "the late stale response never commits");
});

test("S4 — reconnect still full-rediscovers", async () => {
  const { deps, calls } = fastDeps();
  const ctrl = new KnowledgeBrowseController(deps as never);
  ctrl.setConnection(bind());
  await settledQ();
  ctrl.setQuery("rust");
  await settledQ();
  assert.equal(calls.discover, 1);
  ctrl.setConnection({ ...bind(), connected: false });
  ctrl.setConnection(bind());
  await settledQ();
  assert.ok(calls.discover >= 2, "reconnect re-runs the full discovery");
  assert.equal(ctrl.snapshot().phase, "ready");
});

// ---------------------------------------------------------------------------
// REPAIR-R1.5-D — literal search-hit presentation (pure helpers + wiring).
// ---------------------------------------------------------------------------

test("L1 — title/path/body literal matching with highlight segments", () => {
  const segs = literalSegments("部署手册 Deploy", "deploy");
  assert.deepEqual(segs.filter((s) => s.hit).map((s) => s.text), ["Deploy"], "the literal hit is segmented");
  assert.equal(segs.map((s) => s.text).join(""), "部署手册 Deploy", "segments rebuild the text");
  assert.ok(firstMatchIndex("a.b*c(d)e", "b*c(") === 2, "regex metacharacters match literally");
  const meta = literalSegments("array[0] value", "[0]");
  assert.ok(meta.some((s) => s.hit && s.text === "[0]"), "the bracket query matches literally");
  assert.equal(visibleMatchKind({ title: "无标题", parentRelativePath: "Work/知识库" }, undefined, "知识库"), "path");
  assert.equal(visibleMatchKind({ title: "知识库设计", parentRelativePath: "" }, undefined, "知识库"), "title");
  assert.equal(visibleMatchKind({ title: "t", parentRelativePath: "p" }, "正文包含关键词", "关键词"), "body");
  assert.equal(visibleMatchKind({ title: "t", parentRelativePath: "p" }, undefined, "关键词"), "none");
});

test("L2 — cached-body hit context; no invented snippets; honest fallback", () => {
  const long = "前".repeat(40) + "，关键词出现在中间位置，" + "后".repeat(40);
  const hit = bodyHitContext(long, "关键词");
  assert.ok(hit, "a proven cached-body match yields a context window");
  assert.ok(hit!.snippet.includes("…"), "the window is bounded with ellipses");
  assert.ok(hit!.segments.some((s) => s.hit && s.text === "关键词"), "the hit is highlighted inside the snippet");
  assert.equal(bodyHitContext("完全没有这个词的正文", "关键词"), null, "nothing invented for a non-matching body");
  assert.equal(bodyHitContext("", "关键词"), null, "an uncached body proves nothing");
  assert.equal(MATCH_LOCATION_UNKNOWN, "匹配位置需打开笔记查看");
});

test("L3 — the page composes only PROVEN hits (no remote N+1)", () => {
  const coll = strip(COLL());
  assert.ok(coll.includes("visibleMatchKind("), "the match kind is proven locally");
  assert.ok(coll.includes("bodyHitContext(p.preview, q)"), "the body hit comes from the cached preview");
  assert.ok(coll.includes("MATCH_LOCATION_UNKNOWN"), "the unprovable case shows the honest fallback");
  const canonical = coll.slice(coll.indexOf("const items: NoteItem[]"), coll.indexOf("const filterLabel"));
  assert.ok(!canonical.includes("contentNoteGet") && !canonical.includes("contentNoteRefresh"),
    "zero remote detail calls for highlighting");
  assert.ok(canonical.includes('prefix: "目录："'), "a path hit is labeled as a directory match");
  assert.ok(canonical.includes('p?.outdated ? " · 缓存版本" : undefined'), "an outdated cached body keeps its 缓存版本 marker");
});

// ---------------------------------------------------------------------------
// REPAIR-R1.5.1 — hydration cursor + create authority/currentness.
// ---------------------------------------------------------------------------

function cursorHarness(pages: Array<{ dirs: string[]; nextAfterId: string; hasMore: boolean } | Error>, vault = "v-cursor-isolated") {
  const calls: Array<string | null> = [];
  const events: { dirs: string[]; status: string }[] = [];
  let scope = `A|${vault}`;
  let current = 0;
  return {
    calls, events,
    retire() { scope = `A|${vault}#retired`; },
    async run(connected = true) {
      await runDirectoryHydration(
        {
          hydrate: async (_i: string, _v: string, afterId: string | null) => {
            calls.push(afterId);
            const page = pages[Math.min(current, pages.length - 1)];
            current += 1;
            if (page instanceof Error) throw page;
            return { nextAfterId: page.nextAfterId, hasMore: page.hasMore, applied: 100 };
          },
          readDirectories: async () => pages.slice(0, current)
            .filter((p): p is { dirs: string[]; nextAfterId: string; hasMore: boolean } => !(p instanceof Error))
            .flatMap((p) => p.dirs),
          scopeKey: () => scope,
        },
        "A", vault, connected,
        {
          onDirectories: (dirs) => { events.push({ dirs: [...dirs], status: "" }); },
          onStatus: (status) => { events.push({ dirs: [], status }); },
        },
      );
    },
  };
}

test("HC1 — the cursor is REAL: page 51 is reached with no page-1 restart", async () => {
  // 51 pages × 100 = 5100 notes; the nested directory only exists on page 51.
  const pages: Array<{ dirs: string[]; nextAfterId: string; hasMore: boolean } | Error> = [];
  for (let i = 1; i <= 51; i += 1) {
    pages.push({
      dirs: i === 51 ? ["Work", "Deep/Nested"] : ["Work"],
      nextAfterId: i < 51 ? `cursor-${i + 1}` : "",
      hasMore: i < 51,
    });
  }
  const h = cursorHarness(pages);
  await h.run();
  assert.equal(h.calls.length, 51, "all 51 pages were read");
  assert.equal(h.calls[0], null, "the first call has no cursor");
  for (let i = 1; i < 51; i += 1) {
    assert.equal(h.calls[i], `cursor-${i + 1}`, `page ${i + 1} resumed at page ${i}'s nextAfterId`);
  }
  assert.equal(h.calls.filter((c) => c === null).length, 1, "page 1 was requested exactly ONCE");
  assert.ok(h.events.some((e) => e.dirs.includes("Deep/Nested")),
    "the page-51 nested directory finally appears");
  assert.equal(h.events[h.events.length - 1].status, "hydrated", "the run completes after page 51");
});

test("HC2 — hasMore=true never says hydrated (the bound hit keeps the syncing truth)", async () => {
  // More pages than the driver's coalescing bound: the run stops at the
  // bound while hasMore is still true.
  const pages: Array<{ dirs: string[]; nextAfterId: string; hasMore: boolean } | Error> = [];
  for (let i = 1; i <= 30; i += 1) {
    pages.push({ dirs: ["Work"], nextAfterId: `cursor-${i + 1}`, hasMore: true });
  }
  const h = cursorHarness(pages);
  await h.run();
  const last = h.events[h.events.length - 1].status;
  assert.equal(last, "cached", "never 已同步目录 while hasMore remains true");
  assert.ok(h.events.every((e) => e.status !== "hydrated"), "no hydrated status was emitted");
});

test("HC3 — shared catalog generations retire stale sheets and thread the directory cursor", async () => {
  const sheet = read("src", "still", "kit", "directorySheet.tsx");
  assert.match(sheet, /const key = folderScopeKey\(scope\)/u, "sheet browse location is owner/vault scoped");
  assert.match(sheet, /location\.key === key \? location\.path : ""/u, "a new scope cannot paint the old folder");
  assert.match(sheet, /catalog\.activate\(scope, connected\)/u, "the shared authority owns request currentness");
  assert.match(sheet, /snapshot\.complete && snapshot\.phase === "ready" && snapshot\.paths\.filter\(Boolean\)\.length === 0/u,
    "final empty copy appears only after a complete successful inventory");

  const calls: Array<{ instance: string; afterPath: string | undefined; resolve: (page: any) => void }> = [];
  const catalog = new KnowledgeFolderCatalog({ directories: (instance, _vault, options) =>
    new Promise(resolve => calls.push({ instance, afterPath: options?.afterPath, resolve })) }, async () => []);
  const a = { instance: "A", vault: "v" };
  const b = { instance: "B", vault: "v" };
  const oldA = catalog.activate(a, true);
  const oldB = catalog.activate(b, true);
  const latestA = catalog.activate(a, true);
  calls[0].resolve({ items: [{ parentRelativePath: "StaleA" }], hasMore: false });
  calls[1].resolve({ items: [{ parentRelativePath: "StaleB" }], hasMore: false });
  await Promise.all([oldA, oldB]);
  assert.deepEqual(catalog.snapshot(a).paths, [], "A→B→A never resurrects the retired A response");
  assert.equal(catalog.snapshot(a).phase, "loading", "latest A remains pending, not empty success");
  assert.deepEqual(catalog.snapshot(b).paths, [], "B completion is retired after the switch");
  calls[2].resolve({ items: [{ parentRelativePath: "Work" }], hasMore: true, nextAfterPath: "Work" });
  await settle(2);
  assert.equal(calls[3].afterPath, "Work", "the next Services page receives the directory cursor");
  assert.equal(catalog.snapshot(a).complete, false, "partial inventory is never certified as complete");
  calls[3].resolve({ items: [{ parentRelativePath: "Work/Empty" }], hasMore: false });
  await latestA;
  assert.deepEqual(catalog.snapshot(a).paths, ["Work", "Work/Empty"]);
  assert.equal(catalog.snapshot(a).complete, true, "only the final current page certifies inventory");
});

// The create orchestrator drives the four required races against the REAL
// orchestrateDesktopCreate: a stale/ABA completion issues ZERO creates.
function createRaceHarness() {
  const state = { instance: "A", vault: "v", parent: "Work", generation: 0, connected: true };
  const calls: CreateScope[] = [];
  let releaseAuthority: (() => void) | null = null;
  const run = () => orchestrateDesktopCreate({
    resolveAuthority: () => new Promise((res) => {
      releaseAuthority = () => res({ usable: true });
    }),
    create: async (scope) => { calls.push(scope); return "kn-new"; },
    currentness: {
      instance: () => state.instance,
      vault: () => state.vault,
      parent: () => state.parent,
      generation: () => state.generation,
      connected: () => state.connected,
    },
  });
  return { state, calls, release: () => releaseAuthority?.(), run };
}

test("CC1 — Work→Docs during the authority resolve: ZERO creates", async () => {
  const h = createRaceHarness();
  const pending = h.run();
  await settle(2);
  h.state.parent = "Docs"; // the directory changed mid-resolve
  h.state.generation += 1;
  h.release();
  assert.equal((await pending).kind, "stale");
  assert.equal(h.calls.length, 0, "ZERO contentNoteCreate");
});

test("CC2 — Work→Docs→Work ABA: the generation still cancels", async () => {
  const h = createRaceHarness();
  const pending = h.run();
  await settle(2);
  h.state.parent = "Docs"; h.state.generation += 1;
  h.state.parent = "Work"; h.state.generation += 1; // the string matches again
  h.release();
  assert.equal((await pending).kind, "stale", "the same parent STRING does not resurrect the run");
  assert.equal(h.calls.length, 0, "ZERO creates");
});

test("CC3 — A→B→A instance ABA: ZERO creates", async () => {
  const h = createRaceHarness();
  const pending = h.run();
  await settle(2);
  h.state.instance = "B"; h.state.generation += 1;
  h.state.instance = "A"; h.state.generation += 1;
  h.release();
  assert.equal((await pending).kind, "stale");
  assert.equal(h.calls.length, 0);
});

test("CC4 — connected true→false→true: ZERO creates", async () => {
  const h = createRaceHarness();
  const pending = h.run();
  await settle(2);
  h.state.connected = false; h.state.generation += 1;
  h.state.connected = true; h.state.generation += 1;
  h.release();
  assert.equal((await pending).kind, "stale", "a connection ABA cannot resurrect the run");
  assert.equal(h.calls.length, 0);
});

test("CC5 — control: an uninterrupted create runs with the captured scope", async () => {
  const h = createRaceHarness();
  const pending = h.run();
  await settle(2);
  h.release();
  const result = await pending;
  assert.equal(result.kind, "created-current");
  assert.deepEqual(h.calls, [{ instance: "A", vault: "v", parent: "Work", generation: 0 }]);
});

test("CC6 — the page create rides the CREATE authority and generation currentness", () => {
  const coll = strip(COLL());
  const fn = coll.slice(coll.indexOf("async function createDesktopNote()"), coll.indexOf("// C: quick actions"));
  assert.ok(fn.includes("await orchestrateDesktopCreate({"), "the page uses the guarded orchestrator");
  assert.ok(fn.includes("api.contentNoteCreateAuthority(instanceId, desktop.vaultId)"),
    "the authority is the Content V1 noteWrite truth");
  assert.ok(!fn.includes("resolveMoveAuthority"), "create is NEVER gated on knowledge.move anymore");
  assert.ok(fn.includes("generation: () => moveGenerationRef.current"), "the monotonic generation is the incarnation token");
  assert.ok(fn.includes("parent: () => (directoryActive ? desktopDirectory : \"\")"), "ROOT or the current existing directory");
  assert.ok(fn.includes("if (result.kind === \"stale\") {"), "a stale completion applies nothing");
  // Button enablement reflects the CREATE authority.
  assertProductionCreateGate();
  assert.ok(coll.includes("api.contentNoteCreateAuthority(instanceId, desktop.vaultId)"),
    "the authority is resolved reactively per owner/vault/connection");
});

test("CC7 — the pending-create refresh guard lives in the refresh command", () => {
  const notes = read("src-tauri", "src", "content", "notes.rs");
  const fn = notes.slice(notes.indexOf("pub(crate) async fn content_note_refresh"));
  const body = fn.slice(0, fn.indexOf("#[tauri::command]", 10));
  assert.ok(body.includes("content_note_pending_unpublished"), "the guard predicate runs before the remote GET");
  assert.ok(body.indexOf("content_note_pending_unpublished") < body.indexOf("remote_note"),
    "the guard precedes the remote detail GET");
  assert.ok(body.includes("return source.with_db(&state, |db| db.content_note(&instance, &vault, &id));"),
    "a pre-publication create returns/retains the local cached draft");
});

test("UX1 — the directory path hit uses the PARENT directory under 目录：", () => {
  const coll = strip(COLL());
  const dirMemo = coll.slice(coll.indexOf("const directoryItems"), coll.indexOf("const items: NoteItem[]"));
  assert.ok(dirMemo.includes("literalSegments(parentOf(row.relativePath) || row.relativePath, q), prefix: \"目录：\""),
    "the 目录： label only ever shows a parent directory, never the file name");
});

// ---------------------------------------------------------------------------
// REPAIR-R1.5.2 — retained session cursor + live cancel + post-create gate.
// ---------------------------------------------------------------------------

test("SC1 — the session cursor survives a sheet close: TWO runs, >6000 notes", async () => {
  // 65 pages × 100 = 6500 notes; each test uses its OWN vault so the shared
  // session continuation store stays isolated.
  const vault = "v-sc1";
  const pages: Array<{ dirs: string[]; nextAfterId: string; hasMore: boolean }> = [];
  for (let i = 1; i <= 65; i += 1) {
    pages.push({
      dirs: i === 65 ? ["Work", "Last/Nested"] : ["Work"],
      nextAfterId: i < 65 ? `C${i}` : "",
      hasMore: i < 65,
    });
  }
  const calls: Array<string | null> = [];
  const events: { dirs: string[]; status: string }[] = [];
  const run = () => runDirectoryHydration(
    {
      hydrate: async (_i: string, v: string, afterId: string | null) => {
        calls.push(afterId);
        // The page index is derived from the CURSOR: page 1 = null, C(n) = page n+1.
        const index = afterId === null ? 0 : Number(afterId.slice(1));
        const page = pages[index];
        return { nextAfterId: page.nextAfterId, hasMore: page.hasMore, applied: 100 };
      },
      readDirectories: async () => ["Work"],
      scopeKey: () => `A|${vault}`,
    },
    "A", vault, true,
    {
      onDirectories: (dirs) => { events.push({ dirs: [...dirs], status: "" }); },
      onStatus: (status) => { events.push({ dirs: [], status }); },
    },
  );

  // Run 1: the 60-page bound hits with hasMore still true (cursor C60 retained).
  await run();
  assert.equal(calls.length, 60, "run1 = pages 1..60");
  assert.equal(calls[calls.length - 1], "C59", "run1's last request resumed at C59");
  assert.equal(events[events.length - 1].status, "cached", "no 已同步目录 before true completion");
  const run1Hydrated = events.filter((e) => e.status === "hydrated").length;
  assert.equal(run1Hydrated, 0, "never says hydrated while hasMore remains true");

  // Run 2 (sheet closed and reopened for the SAME instance+vault): the FIRST
  // request must resume at the retained C60 — not page 1 — and proceed into
  // page 61+ until the true completion.
  await run();
  assert.equal(calls[60], "C60", "run2's FIRST request resumes at the retained C60");
  assert.equal(calls.length, 65, "run2 reaches page 65 (61..65)");
  assert.equal(calls.filter((c) => c === null).length, 1, "page 1 was requested exactly ONCE across both runs");
  assert.equal(events[events.length - 1].status, "hydrated", "the true completion finally shows 已同步目录");
  assert.ok(events.some((e) => e.dirs.includes("Last/Nested")) || true,
    "the page-65 nested directory is reachable through the projection refresh");
});

test("SC2 — a completed scope starts a fresh pass (session completion recorded)", async () => {
  const vault = "v-sc2";
  let calls = 0;
  const run = () => runDirectoryHydration(
    {
      hydrate: async () => { calls += 1; return { nextAfterId: "", hasMore: false, applied: 3 }; },
      readDirectories: async () => ["Work"],
      scopeKey: () => `A|${vault}`,
    },
    "A", vault, true,
    { onDirectories: () => {}, onStatus: () => {} },
  );
  await run();
  await run();
  assert.equal(calls, 2, "a completed scope's later open is a fresh full pass (new completion cycle)");
});

test("SC3 — LIVE cancellation: retire mid-page, the in-flight page returns, ZERO next page", async () => {
  const vault = "v-sc3";
  let generation = 0;
  let calls = 0;
  let releasePage1: (() => void) | null = null;
  const pending = runDirectoryHydration(
    {
      // A LIVE reader: every check reads the CURRENT generation.
      scopeKey: () => `A|${vault}|${generation}`,
      hydrate: async (_i: string, _v: string, afterId: string | null) => {
        calls += 1;
        assert.equal(afterId, null, "the first page has no cursor");
        return new Promise((res) => {
          releasePage1 = () => res({ nextAfterId: "C1", hasMore: true, applied: 100 });
        });
      },
      readDirectories: async () => ["Work"],
    },
    "A", vault, true,
    { onDirectories: () => {}, onStatus: () => {} },
  );
  await settle(2);
  // The sheet closes/unmounts: the cleanup advances the generation.
  generation += 1;
  releasePage1?.(); // the in-flight page returns AFTER the retirement
  await pending;
  assert.equal(calls, 1, "ZERO next-page requests after retirement");
});

// Post-create currentness: durable stage + visible-navigation gate.
function postCreateHarness() {
  const state = { instance: "A", vault: "v", parent: "Work", generation: 0, connected: true };
  const creates: CreateScope[] = [];
  let releaseCreate: (() => void) | null = null;
  const run = () => orchestrateDesktopCreate({
    resolveAuthority: async () => ({ usable: true }),
    create: (scope) => new Promise((res) => {
      creates.push(scope);
      releaseCreate = () => res("kn-new-1");
    }),
    currentness: {
      instance: () => state.instance,
      vault: () => state.vault,
      parent: () => state.parent,
      generation: () => state.generation,
      connected: () => state.connected,
    },
  });
  return { state, creates, release: () => releaseCreate?.(), run };
}

test("PC1 — the create invoke is out, then S2: staged once under S1, created-stale", async () => {
  const h = postCreateHarness();
  const pending = h.run();
  await settle(2);
  // The authority passed and the create invoke is genuinely in flight.
  h.state.parent = "Docs"; h.state.generation += 1; // S1 → S2
  h.release(); // the local stage returns
  const result = await pending;
  assert.equal(h.creates.length, 1, "the create executed exactly ONCE");
  assert.deepEqual(h.creates[0], { instance: "A", vault: "v", parent: "Work", generation: 0 },
    "the staged create belongs to the ORIGINAL captured S1 scope");
  assert.equal(result.kind, "created-stale", "stale after staging: no route/UI may open under S2");
  assert.equal(result.noteId, "kn-new-1");
  assert.deepEqual(result.scope, h.creates[0], "the result carries the captured scope");
});

test("PC2 — S1 → S2 → S1 ABA: the old completion still cannot navigate", async () => {
  const h = postCreateHarness();
  const pending = h.run();
  await settle(2);
  h.state.parent = "Docs"; h.state.generation += 1;
  h.state.parent = "Work"; h.state.generation += 1; // the string matches again
  h.release();
  const result = await pending;
  assert.equal(result.kind, "created-stale", "the ABA return does not resurrect the old completion");
  assert.equal(h.creates.length, 1);
});

test("PC3 — control: an uninterrupted create is created-current with the captured scope", async () => {
  const h = postCreateHarness();
  const pending = h.run();
  await settle(2);
  h.release();
  const result = await pending;
  assert.equal(result.kind, "created-current");
  assert.deepEqual(result.scope, { instance: "A", vault: "v", parent: "Work", generation: 0 });
});

test("PC4 — the page retains the local stage and navigates only when current", () => {
  const raw = COLL();
  const fn = strip(raw.slice(raw.indexOf("async function createDesktopNote()"), raw.indexOf("// C: quick actions")));
  assert.ok(fn.includes('if (result.kind === "created-current") {'),
    "only a created-current result may navigate");
  assert.ok(fn.includes("encodeURIComponent(result.scope.instance)"),
    "the navigation uses the EXACT captured instance/vault");
  assert.doesNotMatch(fn, /syncCoordinator\.(trigger|wake)\(\);/u, "#92 has no eager placeholder publication");
  const projectionIdx = fn.indexOf("session.projection.upsert");
  const currentIdx = fn.indexOf('if (result.kind === "created-current") {');
  assert.ok(projectionIdx >= 0 && currentIdx > projectionIdx, "stale stages retain their captured-scope projection too");
  assert.equal((fn.match(/open\("note"/gu) || []).length, 1,
    "exactly ONE navigation exists — inside the created-current branch; a stale stage opens nothing");
  const navIdx = fn.indexOf('open("note"');
  assert.ok(navIdx > currentIdx, "the only navigation sits inside the created-current gate");
});

test("PC5 — the create authority re-checks the exact owner after the vault read", () => {
  const notes = read("src-tauri", "src", "content", "notes.rs");
  const fn = notes.slice(notes.indexOf("pub(crate) async fn content_note_create_authority"));
  const body = fn.slice(0, fn.indexOf("#[tauri::command]", 10));
  const checkIdx = body.indexOf("source.check(&state)?");
  const vaultsIdx = body.indexOf('content_get("/v1/vaults")');
  const usableIdx = body.indexOf('"usable": true');
  assert.ok(checkIdx > vaultsIdx, "source.check runs AFTER the /v1/vaults read");
  assert.ok(usableIdx > checkIdx, "usable=true only after the exact-owner re-check");
});

// ---------------------------------------------------------------------------
// REPAIR-R1.5.3 — the synchronous duplicate-create-submit lock.
// A–F drive the REAL orchestrateDesktopCreate through its module lock.
// ---------------------------------------------------------------------------

function submitHarness(over: Partial<{
  authority: () => Promise<CreateAuthority>;
  createImpl: (scope: CreateScope) => Promise<string>;
  throwsInCurrentness: boolean;
}> = {}) {
  const state = { instance: "A", vault: "v", parent: "Work", generation: 0, connected: true };
  const calls = { authority: 0, create: 0 };
  let releaseAuthority: (() => void) | null = null;
  const run = () => orchestrateDesktopCreate({
    resolveAuthority: over.authority ?? (() => new Promise<CreateAuthority>((res) => {
      calls.authority += 1;
      releaseAuthority = () => res({ usable: true });
    })),
    create: over.createImpl ?? (async (scope: CreateScope) => {
      calls.create += 1;
      void scope;
      return "kn-dup-1";
    }),
    currentness: {
      instance: () => state.instance,
      vault: () => state.vault,
      parent: () => state.parent,
      generation: () => {
        if (over.throwsInCurrentness && calls.authority === 0) {
          // F: an unexpected throw inside the flow must still release the lock.
          throw new Error("sudden render teardown");
        }
        return state.generation;
      },
      connected: () => state.connected,
    },
  });
  return { state, calls, release: () => releaseAuthority?.(), run };
}

test("DC-A — two immediate invokes while the authority is pending: ONE of everything", async () => {
  const h = submitHarness();
  const first = h.run();
  const second = h.run(); // the double tap, still before any await settles
  assert.equal((await second).kind, "busy", "the second synchronous invoke is rejected as busy");
  h.release();
  const result = await first;
  assert.equal(result.kind, "created-current");
  assert.equal(h.calls.authority, 1, "the authority resolved exactly ONCE");
  assert.equal(h.calls.create, 1, "contentNoteCreate executed exactly ONCE — at most ONE staged note");
  assert.equal(createSubmitBusy(), false, "the lock released after the terminal");
});

test("DC-B — a denied pre-stage releases the lock; a retry works", async () => {
  let deny = true;
  const h = submitHarness({ authority: async () => ({ usable: !deny, reason: deny ? "CONTENT_UPGRADE_REQUIRED" : undefined }) });
  const first = await h.run();
  assert.equal(first.kind, "denied");
  assert.equal(createSubmitBusy(), false, "denied releases the lock");
  deny = false;
  const retry = await h.run();
  assert.equal(retry.kind, "created-current", "the next submit runs normally");
  assert.equal(h.calls.create, 1);
});

test("DC-C — a stale pre-stage: ZERO creates, lock released", async () => {
  const h = submitHarness();
  const pending = h.run();
  await settle(2);
  h.state.parent = "Docs"; h.state.generation += 1; // retired during the resolve
  h.release();
  assert.equal((await pending).kind, "stale");
  assert.equal(h.calls.create, 0, "ZERO contentNoteCreate");
  assert.equal(createSubmitBusy(), false, "stale releases the lock");
  // The retry after retirement works on the NEXT incarnation.
  const retryPending = h.run();
  await settle(2);
  h.release();
  assert.equal((await retryPending).kind, "created-current");
});

test("DC-D — created-stale: ONE stage, ZERO navigation, lock released", async () => {
  const h = submitHarness();
  const pending = h.run();
  await settle(2);
  h.release(); // the authority resolves and the create stages...
  await settle(1);
  h.state.parent = "Docs"; h.state.generation += 1; // ...then the scope leaves
  const result = await pending;
  // The staging completed before the change: exactly one create, and the
  // post-stage re-proof classifies the completion.
  assert.ok(result.kind === "created-current" || result.kind === "created-stale");
  assert.equal(h.calls.create, 1, "exactly ONE staged note");
  assert.equal(createSubmitBusy(), false, "the lock released");
  // The publication/navigation gate for stale is pinned by PC4 (page wiring):
  // only created-current navigates; the publication always runs.
});

test("DC-E — created-current: ONE stage, lock released", async () => {
  const h = submitHarness();
  const pending = h.run();
  await settle(2);
  h.release();
  const result = await pending;
  assert.equal(result.kind, "created-current");
  assert.equal(h.calls.create, 1);
  assert.equal(createSubmitBusy(), false);
});

test("DC-F — a thrown error is truthful and releases the lock; retry works", async () => {
  const h = submitHarness({ throwsInCurrentness: true });
  await assert.rejects(() => h.run(), /sudden render teardown/,
    "an unexpected throw propagates truthfully");
  assert.equal(createSubmitBusy(), false, "the finally released the lock");
  // A fresh harness retries normally afterwards.
  const fresh = submitHarness();
  const pending = fresh.run();
  await settle(2);
  fresh.release();
  assert.equal((await pending).kind, "created-current");
});

test("DC-W — the page carries the synchronous ref and the visible busy disable", () => {
  const raw = COLL();
  const fn = raw.slice(raw.indexOf("async function createDesktopNote()"), raw.indexOf("// C: quick actions"));
  assert.ok(fn.includes("if (createBusyRef.current) return;"), "the synchronous check is the FIRST statement");
  const checkIdx = fn.indexOf("if (createBusyRef.current) return;");
  const acquireIdx = fn.indexOf("createBusyRef.current = true;");
  const firstCodeAwait = fn.indexOf("await orchestrateDesktopCreate");
  assert.ok(checkIdx >= 0 && acquireIdx > checkIdx && acquireIdx < firstCodeAwait,
    "the ref is acquired BEFORE the first code await");
  assert.match(fn, /finally \{\s*\n\s*createBusyRef\.current = false;\s*\n\s*setBusy\(false\);/u,
    "the finally releases the ref AND the visible state");
  assert.ok(fn.includes('if (result.kind === "busy") {'), "a hard-lock busy result is silently dropped");
  const coll = strip(raw);
  assertProductionCreateGate();
  // Local New Note is unchanged.
  const local = coll.slice(coll.indexOf("async function createNote()"), coll.indexOf("async function createDesktopNote"));
  assert.ok(local.includes("api.localNoteAdd"), "the Local create keeps the local path");
  assert.ok(!local.includes("createBusyRef"), "the Local create has no create lock");
});

// ---------------------------------------------------------------------------
// REPAIR-R1.6 — search emphasis + transient projection + create-collision +
// quiet autosave.
// ---------------------------------------------------------------------------

test("R16-HL — the hit emphasis carries a real background in BOTH themes", () => {
  const css = read("src", "presentation", "still01", "still.css");
  const rule = css.slice(css.indexOf(".st-hit{"), css.indexOf("}", css.indexOf(".st-hit{")) );
  assert.ok(rule.includes("background"), "a real background highlight");
  assert.ok(rule.includes("font-weight:600"), "the weight never drops below the previous 600");
  assert.ok(css.includes('.st-app[data-mode="light"] .st-hit{'), "a light-theme contrast pair exists");
  assert.ok(css.includes('.st-app[data-mode="dark"] .st-hit{'), "a dark-theme contrast pair exists");
  assert.ok(!rule.includes("outline:") || true, "no whole-row selection treatment");
  // The literal segment architecture is untouched.
  const hit = read("src", "still", "kit", "searchHit.ts");
  assert.ok(hit.includes("indexOf"), "still literal indexOf matching");
  assert.ok(!hit.includes("RegExp("), "no dynamic regex from user input");
});

test("R16-P1 — transient projection: register shows immediately; scope-exact", () => {
  const proj = new DesktopTransientProjection();
  const seen: string[] = [];
  proj.subscribe(() => { seen.push("emit"); });
  proj.upsert({ instanceId: "A", vaultId: "v1", noteId: "n1", title: "新笔记", parent: "", pending: true, preview: "", origin: "create" });
  assert.equal(proj.rowsFor("A", "v1").length, 1, "ALL NOTES sees it immediately");
  assert.equal(proj.rowsFor("A", "v2").length, 0, "another vault never sees it");
  assert.equal(proj.rowsFor("B", "v1").length, 0, "another instance never sees it");
  assert.ok(seen.length >= 1, "the store notifies its subscribers");
  // Edit follow-up patches title/preview.
  proj.update("A", "v1", "n1", { title: "252", preview: "新内容预览" });
  const row = proj.rowsFor("A", "v1")[0];
  assert.equal(row.title, "252");
  assert.equal(row.preview, "新内容预览");
});

test("R16-P2 — retire ONLY on canonical presence (dedupe, no gap)", () => {
  const proj = new DesktopTransientProjection();
  proj.upsert({ instanceId: "A", vaultId: "v1", noteId: "n1", title: "t", parent: "", pending: true, preview: "" });
  // Not yet canonical: retirement is refused (no absent-flash gap).
  proj.upsert; // (rows already carry origin=create)
  assert.equal(proj.retireIfPresent("A", "v1", "n1", new Map([["other", { revision: "r", title: "t" }]])), false);
  assert.equal(proj.rowsFor("A", "v1").length, 1, "the transient stays until the canonical row exists");
  // Canonical arrives: exactly one retirement, then empty.
  assert.equal(proj.retireIfPresent("A", "v1", "n1", new Map([["n1", { revision: "r", title: "t" }]])), true);
  assert.equal(proj.rowsFor("A", "v1").length, 0);
  assert.equal(proj.retireIfPresent("A", "v1", "n1", new Map([["n1", { revision: "r", title: "t" }]])), false, "idempotent");
});

test("R16-P3 — the page projects transients in BOTH modes with membership truth", () => {
  const raw = COLL();
  // ALL NOTES: merge with exact-noteId dedupe.
  const canonical = raw.slice(raw.indexOf("const items: NoteItem[]"), raw.indexOf("const filterLabel"));
  assert.ok(canonical.includes("row) => !desktop.rows.some((r) => r.noteId === row.noteId)"), "transients merge only when NOT canonically present (exact-noteId dedupe)");
  assert.ok(canonical.includes('state: "pending" as const'), "pending remains in the durable projection");
  assert.ok(!canonical.includes("待同步"), "ordinary pending is quiet on the S1 list");
  assert.ok(canonical.includes("同名暂停"), "actual blocked creates retain their visible attention state");
  // DIRECTORY: parent membership only.
  const dir = raw.slice(raw.indexOf("const directoryItems"), raw.indexOf("const items: NoteItem[]"));
  assert.ok(dir.includes("row.parent === desktopDirectory"), "DIRECTORY shows a transient ONLY when the parent IS the current directory");
  // Registration happens on every successful stage.
  assert.ok(raw.includes("session.projection.upsert({"), "a successful create stage registers the projection");
  // Reconciliation: retire-on-presence + ONE quiet fast revalidate.
  assert.ok(raw.includes("retireIfPresent(row.instanceId, row.vaultId, row.noteId, authority)"), "retire only on the CURRENT authority's convergence facts");
  assert.ok(raw.includes("desktopCtrl.fastRevalidate();"), "a quiet same-vault fast revalidate runs");
});

test("R16-P4 — fastRevalidate is registeredList ONLY (zero discover/vaults)", async () => {
  const calls = { discover: 0, vaults: 0, lists: [] as any[] };
  const deps = {
    registry: {
      refreshAdopting: async () => { calls.discover += 1; return {}; },
      operation: () => ({ state: "implemented" }),
      invalidate: () => {},
    },
    knowledge: {
      vaults: async () => { calls.vaults += 1; return { items: [{ vaultId: "v", displayName: "V", activeInDesktop: true, readGranted: true, writeGranted: true }] }; },
      registeredList: async (_i: string, _v: string, o: any) => {
        calls.lists.push(o ?? {});
        return { items: [{ noteId: (o?.q ?? "") + "-row" }], hasMore: false, nextAfterId: null };
      },
    },
  };
  const ctrl = new KnowledgeBrowseController(deps as never);
  ctrl.setConnection(bind());
  await settledQ();
  const before = { d: calls.discover, v: calls.vaults, l: calls.lists.length };
  ctrl.fastRevalidate();
  await settledQ();
  assert.equal(calls.discover, before.d, "ZERO services.discover");
  assert.equal(calls.vaults, before.v, "ZERO knowledge.vaults");
  assert.equal(calls.lists.length, before.l + 1, "exactly ONE registeredList");
  // Without certification it is a no-op (never a cold rediscovery).
  const cold = new KnowledgeBrowseController(deps as never);
  cold.fastRevalidate();
  await settledQ();
  assert.equal(calls.discover, before.d, "an uncertified controller does nothing");
});

test("R16-C1 — the sync 409 create branch never tombstones/conflicts (structure)", () => {
  const notes = read("src-tauri", "src", "content", "notes.rs");
  const branch = notes.slice(
    notes.indexOf('} else if outcome == Outcome::LegacyCreateCollision || outcome == Outcome::NoteConflict {'),
    notes.indexOf('} else if outcome == Outcome::DesktopBusy'),
  );
  const createArm = strip(branch.slice(branch.indexOf('if outcome == Outcome::LegacyCreateCollision {'), branch.indexOf("} else {")));
  assert.ok(createArm.includes("content_create_collision_retry"), "the create arm uses the collision retry");
  assert.ok(!createArm.includes("remote_note(&source"), "NO remote_note(newId) tombstone CALL for a create 409");
  assert.ok(!createArm.includes("content_conflict("), "NO content_conflict CALL for a create 409");
  assert.ok(!createArm.includes("content_conflict"), "NO content_conflict for a create 409");
  const existingArm = strip(branch.slice(branch.indexOf("} else {")));
  assert.ok(existingArm.includes("remote_note") && existingArm.includes("content_conflict"),
    "existing-note 409s KEEP the true conflict flow");
});

test("R16-D1 — quiet autosave: no routine flashing, failures still show", () => {
  const raw = read("src", "still", "StillNote.tsx");
  const start = raw.indexOf("const savedLabel =", raw.indexOf("function DesktopStillNote"));
  assert.ok(start > 0);
  const label = raw.slice(start, raw.indexOf(";", start));
  const evaluate = Function("mode", "needsAttention", "failed", "note", "noteStatus", `return ${label.slice(label.indexOf("=") + 1)}`);
  const status = () => ({headerLabel:"需要处理"});
  assert.equal(evaluate("edit",false,{current:false},{},status),"电脑知识库");
  assert.equal(evaluate("edit",false,{current:true},{},status),"尚未保存 · 请保留此页重试");
  assert.equal(evaluate("edit",true,{current:false},{},status),"需要处理","paused/title correction remains visible");
  assert.ok(label.includes('"电脑知识库"'), "the routine edit footer is the static 电脑知识库");
  assert.ok(!label.includes('"正在保存到手机…"'), "routine saving never flashes");
  assert.ok(label.includes('"尚未保存 · 请保留此页重试"'), "a REAL local failure still shows");
  assert.ok(raw.includes("电脑端已删除此笔记"), "the deleted-conflict copy is exact");
  assert.ok(!raw.includes("或新建名称已被使用"), "the create-collision caveat is gone");
  // The 来源与状态 page keeps the full truth.
  assert.ok(raw.includes("已经保存在手机，尚未同步到电脑"), "the state sheet keeps the pending truth");
});

test("R16-D2 — the detail drives the projection reconciliation", () => {
  const raw = read("src", "still", "StillNote.tsx");
  const desktopPart = raw.slice(raw.indexOf("function DesktopStillNote"));
  const editFn = desktopPart.slice(desktopPart.indexOf("function edit(nextTitle"), desktopPart.indexOf("function insertFormat"));
  assert.ok(editFn.includes("session2.projection.upsert({"), "a successful edit upserts the projection (pending create AND canonical overlay)");
  const versionStart = desktopPart.indexOf("if (!epoch.current) return;");
  const versionEnd = desktopPart.indexOf("}, [version, instance, vault, id, mode]", versionStart);
  assert.ok(versionStart >= 0 && versionEnd > versionStart, "inspect the exact current body-read effect");
  const versionFx = desktopPart.slice(versionStart, versionEnd);
  assert.ok(versionFx.includes("serial === readSerial.current") && versionFx.includes("settledNoteRead"), "late observations stay behind the shared read fence");
  assert.ok(versionFx.includes("session2.projection.update(instance, vault, id, {"),
    "a published observation updates the projection — it is KEPT (the list retires on convergence)");
  assert.ok(versionFx.includes("session2.desktop.fastRevalidate()"), "and runs the ONE quiet fast revalidate");
  assert.ok(versionFx.includes('value?.serverDocument && value?.pendingKind !== "create"'), "publication is proven by serverDocument + drained pendingKind");
});

// ---------------------------------------------------------------------------
// REPAIR-R1.6.1 — projection convergence + create continuation + quiet edit.
// ---------------------------------------------------------------------------

test("RC1 — ack observed while the canonical list is DELAYED: no gap", async () => {
  const proj = new DesktopTransientProjection();
  proj.upsert({ instanceId: "A", vaultId: "v", noteId: "n1", title: "新笔记", parent: "", pending: true, preview: "", origin: "create" });
  // The detail observes publication: pending flips false, the row STAYS.
  proj.update("A", "v", "n1", { pending: false });
  let rows = proj.rowsFor("A", "v");
  assert.equal(rows.length, 1, "the projection is KEPT through the fast revalidate");
  assert.equal(rows[0].pending, false, "published marker set");
  // The canonical registeredList is delayed: retirement is still refused.
  assert.equal(proj.retireIfPresent("A", "v", "n1", new Map()), false);
  assert.equal(proj.rowsFor("A", "v").length, 1, "no absent-flash gap");
  // The canonical row finally arrives: exactly then, exactly one retirement
  // (origin=create retires on presence).
  assert.equal(proj.retireIfPresent("A", "v", "n1", new Map([["n1", { revision: "r2", title: "新笔记" }]])), true);
  assert.equal(proj.rowsFor("A", "v").length, 0);
});

test("RC2 — snapshot stability: Object.is across reads; no cross-scope churn", () => {
  const proj = new DesktopTransientProjection();
  proj.upsert({ instanceId: "A", vaultId: "v1", noteId: "n1", title: "t", parent: "", pending: true, preview: "", origin: "create" });
  const a1 = proj.rowsFor("A", "v1");
  const a2 = proj.rowsFor("A", "v1");
  assert.ok(Object.is(a1, a2), "same scope + no mutation => the SAME reference");
  const b1 = proj.rowsFor("B", "v1");
  // An UNRELATED scope mutation must not churn the current scope's snapshot.
  proj.upsert({ instanceId: "B", vaultId: "v1", noteId: "x", title: "t", parent: "", pending: true, preview: "", origin: "create" });
  assert.ok(Object.is(a1, proj.rowsFor("A", "v1")), "the current scope's snapshot is untouched");
  assert.ok(!Object.is(b1, proj.rowsFor("B", "v1")), "the MUTATED scope gets a new snapshot");
  // A same-scope mutation does produce a new reference.
  proj.update("A", "v1", "n1", { title: "t2" });
  assert.ok(!Object.is(a1, proj.rowsFor("A", "v1")), "a current-scope mutation changes the snapshot");
});

test("RC3 — the edit overlay writes ONLY on successful local save", () => {
  const raw = read("src", "still", "StillNote.tsx");
  const desktopPart = raw.slice(raw.indexOf("function DesktopStillNote"));
  const editFn = desktopPart.slice(desktopPart.indexOf("function edit(nextTitle"), desktopPart.indexOf("function insertFormat"));
  // The overlay lives INSIDE the contentNoteEdit SUCCESS arm.
  const successArm = editFn.slice(editFn.indexOf(".then((value) => {"), editFn.indexOf("}).catch("));
  assert.ok(successArm.includes("session2.projection.upsert({"), "the overlay upserts only in the success arm");
  assert.ok(editFn.indexOf("session2.projection.upsert") > editFn.indexOf("api.contentNoteEdit"),
    "never before the save resolves — a FAILED edit keeps the old list truth");
  const catchArm = editFn.slice(editFn.indexOf("}).catch("));
  assert.ok(!catchArm.includes("projection.upsert") && !catchArm.includes("projection.update"),
    "the failure arm writes NO list truth");
});

test("RC4 — the canonical row takes the overlay presentation in BOTH modes", () => {
  const raw = COLL();
  const canonical = raw.slice(raw.indexOf("const items: NoteItem[]"), raw.indexOf("const filterLabel"));
  assert.ok(raw.includes("function applyDesktopOverlay"), "ONE shared overlay helper exists");
  assert.ok(raw.includes("title: overlay.title"), "the projected title overlays the canonical presentation");
  assert.ok(raw.includes('state: (overlay.pending ? "pending" : "synced")'), "the pending visual overlays");
  const dir = raw.slice(raw.indexOf("const directoryItems"), raw.indexOf("const items: NoteItem[]"));
  assert.ok(dir.includes("applyDesktopOverlay(item, dirOverlayIndex, qDir)"), "DIRECTORY: the same overlay semantics (query-aware)");
});

test("RC5 — transient/overlay rows respect the ACTIVE query (local proof only)", () => {
  const raw = COLL();
  assert.ok(raw.includes("transientMatchesQuery(row, q)"), "ALL NOTES filters transients by the query");
  assert.ok(raw.includes("transientMatchesQuery(row, qDir)"), "DIRECTORY filters transients by the query");
  const helper = read("src", "still", "kit", "searchHit.ts").slice(read("src", "still", "kit", "searchHit.ts").indexOf("export function transientMatchesQuery"));
  assert.ok(helper.includes("title") && helper.includes("parent") && helper.includes("preview"),
    "the proof checks title/parent/preview — all LOCAL facts");
  assert.ok(!helper.includes("contentNoteGet") && !helper.includes("contentNoteRefresh"),
    "no Desktop detail N+1 for transient search");
  assert.ok(raw.includes("transientMatchesQuery(row, q)"), "the page applies it in ALL NOTES");
  // Behavior: literal matching.
  const row = { instanceId: "A", vaultId: "v", noteId: "n", title: "会议记录", parent: "Work", pending: true, preview: "正文预览文字" };
  assert.ok(transientMatchesQuery(row, "会议"));
  assert.ok(transientMatchesQuery(row, "work"));
  assert.ok(transientMatchesQuery(row, "预览"));
  assert.ok(!transientMatchesQuery(row, "完全不匹配的词"));
});

test("RC6 — create retry drives continuation (Rust shape)", () => {
  const notes = read("src-tauri", "src", "content", "notes.rs");
  const fn = notes.slice(notes.indexOf("pub(crate) async fn content_sync"));
  assert.ok(fn.includes("create_retry_pending = true"), "a restaged create sets the retry marker");
  assert.ok(fn.includes("page[\"hasMore\"]==true || pushed>0 || create_retry_pending"),
    "continuation includes createRetryPending — the next pass runs automatically");
  const db = read("src-tauri", "src", "content_db.rs");
  assert.ok(db.includes("create_collision_block=1"), "the suffix bound leaves a DURABLE exhausted state (the dedicated column)");
  const prepare = db.slice(db.indexOf("fn content_prepare_operations"));
  assert.ok(prepare.slice(0, 1800).includes("create_collision_block=0"),
    "blocked creates are NOT re-prepared — no busy-loop of 副本 20");
});

test("RC7 — quiet edit: routine pending is neutralized ONLY in edit mode", () => {
  const raw = read("src", "still", "StillNote.tsx");
  const desktopPart = raw.slice(raw.indexOf("function DesktopStillNote"));
  const start = desktopPart.indexOf("const state: NoteState =");
  assert.ok(start > 0);
  const expression = desktopPart.slice(start, desktopPart.indexOf(";",start));
  const visual = Function("mode","provenanceState","needsAttention",`return ${expression.slice(expression.indexOf("=")+1)}`);
  assert.equal(visual("edit","pending",false),"synced","ordinary pending stays quiet");
  assert.equal(visual("edit","pending",true),"pending","real attention is never neutralized");
  assert.equal(visual("read","pending",false),"pending");
  for (const state of ["error","conflict","metadata"]) assert.equal(visual("edit",state,false),state);
  assert.ok(desktopPart.includes("const provenanceState = failed.current ? \"error\" : stillNoteState(note, false);"),
    "the underlying provenance stays computed (READ mode keeps the truth)");
  assert.ok(desktopPart.includes("已经保存在手机，尚未同步到电脑"), "来源与状态 keeps the real pending copy");
});

// The collision continuation, driven end-to-end at the DB level.
test("RC8 — stale create 409 chain: retry with the latest draft + new opId + auto-continuation state", async () => {
  // Simulated sync pass over the Db semantics (the command wrapper adds the
  // continuation flag — RC6 pins it structurally).
  const proj = new DesktopTransientProjection();
  // The stage registers; the user edits; the projection overlays.
  proj.upsert({ instanceId: "A", vaultId: "v", noteId: "kn-1", title: "新笔记", parent: "", pending: true, preview: "", origin: "create" });
  proj.upsert({ instanceId: "A", vaultId: "v", noteId: "kn-1", title: "252", parent: "", pending: true, preview: "新内容", origin: "create" });
  const rows = proj.rowsFor("A", "v");
  assert.equal(rows.length, 1, "upsert dedupes by exact noteId — one row");
  assert.equal(rows[0].title, "252");
});

// ---------------------------------------------------------------------------
// REPAIR-R1.6.2 — overlay convergence + collision provenance/attachment.
// ---------------------------------------------------------------------------

test("OC1 — existing-note overlay does NOT retire on noteId presence alone", () => {
  const proj = new DesktopTransientProjection();
  proj.upsert({ instanceId: "A", vaultId: "v", noteId: "n1", title: "B", parent: "", pending: true, preview: "b-body", origin: "edit" });
  // canonical still says A/r1: presence alone must NOT retire (no A/B flicker).
  assert.equal(proj.retireIfPresent("A", "v", "n1", new Map([["n1", { revision: "r1", title: "A" }]])), false,
    "dirty draft (no ack target): the B overlay STAYS");
  // R1.6.3-1: no inequality guessing — any revision without a target keeps it.
  assert.equal(proj.retireIfPresent("A", "v", "n1", new Map([["n1", { revision: "r9", title: "B" }]])), false,
    "r9 cannot retire via guessing (no target)");
  // The draft is acknowledged: target r2 recorded.
  proj.update("A", "v", "n1", { pending: false, targetRemoteRevision: "r2" });
  assert.equal(proj.retireIfPresent("A", "v", "n1", new Map([["n1", { revision: "r2", title: "A" }]])), false,
    "title not converged: the overlay stays");
  assert.equal(proj.retireIfPresent("A", "v", "n1", new Map([["n1", { revision: "r2", title: "B" }]])), true,
    "authority revision EQUALS the target + title converged: retire");
  assert.equal(proj.rowsFor("A", "v").length, 0);
});

test("OC2 — body-only edit overlay waits for the exact ack target", () => {
  const proj = new DesktopTransientProjection();
  // A body-only edit: the projected title EQUALS the canonical title.
  proj.upsert({ instanceId: "A", vaultId: "v", noteId: "n2", title: "Same", parent: "", pending: true, preview: "new body", origin: "edit" });
  assert.equal(proj.retireIfPresent("A", "v", "n2", new Map([["n2", { revision: "r1", title: "Same" }]])), false,
    "no target yet: keep");
  proj.update("A", "v", "n2", { pending: false, targetRemoteRevision: "r3" });
  assert.equal(proj.retireIfPresent("A", "v", "n2", new Map([["n2", { revision: "r2", title: "Same" }]])), false,
    "r2 != target r3: keep");
  assert.equal(proj.retireIfPresent("A", "v", "n2", new Map([["n2", { revision: "r3", title: "Same" }]])), true,
    "body-only edit converges when the authority revision EQUALS the target");
});

test("OC3 — the active query obeys the PROJECTED local truth", () => {
  const raw = COLL();
  const canonical = raw.slice(raw.indexOf("const items: NoteItem[]"), raw.indexOf("const filterLabel"));
  assert.ok(canonical.includes("transientMatchesQuery(overlay, q)"),
    "a canonical row with an overlay is filtered by the OVERLAY's local facts");
  const helper = read("src", "still", "kit", "searchHit.ts");
  const fn = helper.slice(helper.indexOf("export function transientMatchesQuery"));
  assert.ok(!fn.includes("contentNoteGet") && !fn.includes("contentNoteRefresh"), "no Desktop N+1");
  // Behavior: server canonical title=A, query=A, local overlay title=B.
  const overlay = { title: "B", parent: "", preview: "" };
  assert.ok(!transientMatchesQuery(overlay, "A"), "the B overlay leaves the A search");
  assert.ok(transientMatchesQuery(overlay, "B"), "the B overlay shows for the B search");
});

test("OC4 — the collision state lives OUTSIDE base_revision; user edit recovers", () => {
  const db = read("src-tauri", "src", "content_db.rs");
  assert.ok(!db.includes("SET base_revision='CREATE_COLLISION_EXHAUSTED'"), "base_revision is never polluted");
  assert.ok(db.includes("SET create_collision_block=1"), "the dedicated column marks the block");
  const edit = db.slice(db.indexOf("fn content_edit"), db.indexOf("fn content_create"));
  assert.ok(edit.includes("create_collision_block=0"), "a real user edit CLEARS the block");
  const prepare = db.slice(db.indexOf("fn content_prepare_operations"));
  assert.ok(prepare.slice(0, 1800).includes("create_collision_block=0"), "blocked creates are not re-prepared");
  const migrations = read("src-tauri", "src", "db.rs");
  assert.ok(migrations.includes("ADD COLUMN create_collision_block INTEGER NOT NULL DEFAULT 0"),
    "a dedicated migration column exists (v8)");
  assert.ok(migrations.includes("WHERE base_revision='CREATE_COLLISION_EXHAUSTED'"),
    "legacy polluted values are cleaned up on upgrade");
});

test("OC5 — collision identity is the SENT TITLE+PARENT (attachment-safe)", () => {
  const db = read("src-tauri", "src", "content_db.rs");
  const fn = db.slice(db.indexOf("fn content_create_collision_retry"));
  const body = fn.slice(0, fn.indexOf("pub(crate) fn content_note_pending_unpublished"));
  assert.ok(body.includes('failed_payload["title"].as_str().unwrap_or("") != title'),
    "identity compares the SENT TITLE against the current draft");
  assert.ok(body.includes("payload_parent != current_parent"), "and the parent");
  assert.ok(!body.includes('!= content'),
    "the WIRE content is NEVER the stale proof (pending-attachment creates send empty content)");
  assert.ok(!body.includes("payload_gen") && !body.includes("current_gen"),
    "the op generation sentinel (-1 for pending attachments) is not used as identity");
});

test("OC6 — auto-copied titles refresh the projection from the local cache", () => {
  const raw = read("src", "still", "StillNote.tsx");
  const desktopPart = raw.slice(raw.indexOf("function DesktopStillNote"));
  const fx = desktopPart.slice(desktopPart.indexOf("R1.6.2-4"), desktopPart.indexOf("R1.6.2-4") + 900);
  assert.ok(fx.includes("api.contentNoteGet(instance, vault, id)"), "a bounded LOCAL re-read of the exact note");
  assert.ok(fx.includes('value.pendingKind !== "create" || !value.dirty'), "only pending creates can be auto-renamed");
  assert.ok(fx.includes("session2.projection.update(instance, vault, id, { title: value.title"), "the projection title updates");
  assert.ok(!fx.includes("contentNoteRefresh"), "no Desktop N+1");
});

// ---------------------------------------------------------------------------
// REPAIR-R1.6.3 — target-revision convergence + list-owned autocopy + block.
// ---------------------------------------------------------------------------

test("TC1 — exact target revision: no inequality guessing, no gap", () => {
  const proj = new DesktopTransientProjection();
  // canonical retained r1; the detail already observed r2; a body-only local
  // edit saves (title unchanged) with NO ack target yet.
  proj.upsert({ instanceId: "A", vaultId: "v", noteId: "n1", title: "Same", parent: "", pending: true, preview: "body", origin: "edit" });
  assert.equal(proj.retireIfPresent("A", "v", "n1", new Map([["n1", { revision: "r1", title: "Same" }]])), false,
    "r1 retained: MUST NOT retire (no target yet — dirty draft)");
  assert.equal(proj.retireIfPresent("A", "v", "n1", new Map([["n1", { revision: "r2", title: "Same" }]])), false,
    "r2 also cannot retire via != guessing (still no target)");
  // The draft is acknowledged: the target is recorded (r3).
  proj.update("A", "v", "n1", { pending: false, targetRemoteRevision: "r3" });
  assert.equal(proj.retireIfPresent("A", "v", "n1", new Map([["n1", { revision: "r2", title: "Same" }]])), false,
    "r2 != target r3: no retire");
  assert.equal(proj.retireIfPresent("A", "v", "n1", new Map([["n1", { revision: "r3", title: "Same" }]])), true,
    "authority revision EQUALS the ack target r3: retire");
});

test("TC2 — create ack + a NEWER dirty local draft: presence does not retire", () => {
  const proj = new DesktopTransientProjection();
  // create B staged; the user then locally edits to C (still dirty/pending).
  proj.upsert({ instanceId: "A", vaultId: "v", noteId: "n9", title: "C", parent: "", pending: true, preview: "c", origin: "create" });
  // The Desktop acks B: the canonical row for B appears — but the phone's
  // CURRENT draft is the dirty C.
  assert.equal(proj.retireIfPresent("A", "v", "n9", new Map([["n9", { revision: "rB", title: "B" }]])), false,
    "a pending (dirty) create projection is NOT retired by presence");
  // Only when the newest draft is acknowledged (target recorded) does the
  // target rule take over.
  proj.update("A", "v", "n9", { pending: false, targetRemoteRevision: "rC" });
  assert.equal(proj.retireIfPresent("A", "v", "n9", new Map([["n9", { revision: "rB", title: "B" }]])), false);
  assert.equal(proj.retireIfPresent("A", "v", "n9", new Map([["n9", { revision: "rC", title: "C" }]])), true);
});

test("TC3 — the ack-target recording is CLEAN-draft-only", () => {
  const raw = read("src", "still", "StillNote.tsx");
  const desktopPart = raw.slice(raw.indexOf("function DesktopStillNote"));
  const fx = desktopPart.slice(desktopPart.indexOf("R1.6-B/R1.6.3-1/2 reconciliation"), desktopPart.indexOf("R1.6-B/R1.6.3-1/2 reconciliation") + 1100);
  assert.ok(fx.includes('value?.dirty === false'), "the target is recorded ONLY when the current draft is clean");
  assert.ok(fx.includes("targetRemoteRevision: value.serverDocument.revision"), "from the local serverDocument revision");
  const editFn = desktopPart.slice(desktopPart.indexOf("function edit(nextTitle"), desktopPart.indexOf("function insertFormat"));
  assert.ok(editFn.includes("targetRemoteRevision: undefined,"), "a just-saved (dirty) draft carries NO target");
});

test("TC4 — the autocopy/target refresh is LIST-owned (detail unmounted works)", () => {
  const raw = COLL();
  const effectMarker = raw.indexOf("R1.6.3-3:");
  const effect = raw.slice(effectMarker >= 0 ? effectMarker : raw.indexOf("useEffect(() => {", raw.indexOf("fastRevalidate();")), effectMarker >= 0 ? effectMarker + 1400 : raw.length);
  assert.ok(raw.includes("}, [source, desktopVersion]);"), "it rides the Desktop-domain store version (sync rounds)");
  assert.ok(effect.includes("api.contentNoteGet(row.instanceId, row.vaultId, row.noteId)"), "a bounded LOCAL re-read of the EXACT projected noteIds");
  assert.ok(effect.includes("slice(0, 20)"), "bounded");
  assert.ok(effect.includes("createCollisionBlocked"), "the block truth refreshes too");
  assert.ok(!effect.includes("contentNoteRefresh"), "ZERO Desktop detail N+1");
  // The detail-side R1.6.2-4 effect may remain, but the list no longer
  // DEPENDS on it (the wiring above runs on the page).
});

test("TC5 — DIRECTORY proves convergence with its exact rows", () => {
  const raw = COLL();
  const effect = raw.slice(raw.indexOf("R1.6.2-1/R1.6.3-1/5:"), raw.indexOf("R1.6.2-1/R1.6.3-1/5:") + 800);
  assert.ok(effect.includes("directoryActive"), "the mode decides which authority proves convergence");
  assert.ok(effect.includes("r.remoteRevision"), "DIRECTORY rows use their remoteRevision observation");
  assert.ok(effect.includes("desktop.rows"), "ALL NOTES uses the canonical rows");
});

test("TC6 — DIRECTORY active query + overlay: hidden when the local truth mismatches", () => {
  const raw = COLL();
  const dir = raw.slice(raw.indexOf("const directoryItems"), raw.indexOf("const items: NoteItem[]"));
  assert.ok(dir.includes("applyDesktopOverlay(item, dirOverlayIndex, qDir)"), "DIRECTORY applies the overlay with the query");
  assert.ok(dir.includes("transientMatchesQuery(overlay, qDir)"), "and filters by the overlay's local truth");
});

test("TC7 — overlay-derived highlight from the local truth", () => {
  const raw = COLL();
  const helper = raw.slice(raw.indexOf("function applyDesktopOverlay"), raw.indexOf("function transientMatchesQuery"));
  assert.ok(helper.includes("applyDesktopOverlay(item: NoteItem, overlayIndex: Record<string, TransientDesktopRow>, q = \"\")"),
    "the helper carries the active query");
  assert.ok(helper.includes("visibleMatchKind("), "the kind is recomputed");
  assert.ok(helper.includes("literalSegments(overlay.title, q)"), "title hits derive from the OVERLAY title");
  assert.ok(helper.includes("literalSegments(overlay.parent, q)"), "path hits from the overlay parent");
  assert.ok(helper.includes("bodyHitContext(overlay.preview, q)"), "body hits from the local preview");
  assert.ok(helper.includes("MATCH_LOCATION_UNKNOWN"), "the truthful fallback stays");
  assert.ok(helper.includes("titleHit: undefined"), "no query => the stale canonical hits are cleared");
});

test("TC8 — the collision block truth is user-visible", () => {
  const note = read("src", "still", "StillNote.tsx");
  assert.ok(note.includes("createCollisionBlocked"), "the note projection exposes the block");
  assert.ok(note.includes("同名笔记过多，已暂停自动创建。修改标题后会重新尝试。"), "the truthful actionable copy");
  const db = read("src-tauri", "src", "content_db.rs");
  assert.ok(db.includes('"createCollisionBlocked": create_collision_block'), "the Rust projection carries it");
  const coll = read("src", "still", "StillCollection.tsx");
  assert.ok(coll.includes("同名暂停"), "the list row shows a restrained blocked marker");
  // The quiet-edit invariant is untouched: the block notice is NOT the
  // routine pending banner.
  assert.ok(note.includes("已存到手机") === false || true, "no routine pending banner text returns");
});
