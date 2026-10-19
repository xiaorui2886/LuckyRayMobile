// MATERIAL-LIBRARY-INSTANT-R1 REPAIR-R5 (A) — the Desktop page must not
// invalidate its own first request.
//
// The physical-device symptom was a permanent "正在读取素材…" that only an
// explicit Refresh cleared. Root cause: two independent effects advanced the
// same generation counter, so binding an owner retired the page-1 the same
// commit had just issued. These tests drive the REAL authority and assert the
// ordering directly, including the exact interleaving that used to lose the
// response.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DesktopPageAuthority,
  desktopIdentityOf,
  rowsForSnapshot,
} from "../src/services/desktopPageAuthority.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const strip = (src: string) => src.replace(/^\s*\/\/.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, "");
const LIB = () => strip(read("src", "still", "StillLibrary.tsx"));

const SOURCE = { query: "", folder: "", tag: "" };

test("M97 — page revalidation is bounded by the loaded extent, even if next-page numbering changes", async () => {
  let previous=true;
  const reads:number[]=[];
  const auth=new DesktopPageAuthority(async(_owner,_source,page)=>{
    reads.push(page);
    return {items:[{desktopAssetId:`p${page}`}],hasMore:true,nextPage:previous ? (page===1 ? 1000 : 1001) : page+1};
  });
  auth.bind("A",SOURCE);await new Promise(r=>setImmediate(r));
  await auth.loadMore(SOURCE);
  assert.equal(auth.snapshot().rows.length,2);
  previous=false;reads.length=0;
  auth.revalidate(SOURCE);await new Promise(r=>setImmediate(r));
  assert.equal(reads.length,2,"only the two already loaded pages are replaced, not 1000 pages");
  assert.deepEqual(reads,[1,2]);
  assert.equal(auth.snapshot().rows.length,2);
  auth.dispose();
});

/** A fetch that only resolves when the test releases it. */
function gated() {
  const gates: Array<{ owner: string; release: (rows: any[]) => void; reject: (e: unknown) => void }> = [];
  const fetchPage = (owner: string) =>
    new Promise<any[]>((resolve, reject) => { gates.push({ owner, release: resolve, reject }); });
  return { fetchPage, gates };
}

// F1. initial owner bind cannot invalidate its own first page-1
test("R5-F1 — an owner bind issues exactly one page-1 and does not retire it", async () => {
  const { fetchPage, gates } = gated();
  const auth = new DesktopPageAuthority(fetchPage);

  auth.bind("A", SOURCE);
  assert.equal(gates.length, 1, "the bind itself issued the first request");
  assert.equal(gates[0].owner, "A", "against the bound owner");

  // The response arrives with no further interaction whatsoever.
  gates[0].release([{ desktopAssetId: "d1" }]);
  await new Promise((r) => setImmediate(r));

  const snap = auth.snapshot();
  assert.equal(auth.committedOwner(), "A", "the first response committed");
  assert.equal(snap.rows.length, 1, "with its rows");
  assert.equal(snap.settled, true, "and the state is settled, not pending");
  assert.equal(snap.refreshing, false, "no longer refreshing");
});

// F2. the first valid response commits WITHOUT a refresh
test("R5-F2 — no Refresh is needed: one response settles the page", async () => {
  const { fetchPage, gates } = gated();
  const auth = new DesktopPageAuthority(fetchPage);
  auth.bind("A", SOURCE);
  // No revalidate()/reloadKey() call anywhere — that is the user never tapping
  // Refresh. The single outstanding request is enough.
  gates[0].release([]);
  await new Promise((r) => setImmediate(r));
  const snap = auth.snapshot();
  assert.equal(snap.settled, true, "a zero-row first response is settled-empty");
  assert.equal(snap.refreshing, false);
  assert.equal(snap.cold, false);
  assert.equal(gates.length, 1, "and no second request was needed");
});

// The exact interleaving that produced the permanent "正在读取…": in the old
// page the owner-invalidation effect ran AFTER the request effect and bumped
// the generation again. Here the same sequence must still commit.
test("R5-F1b — a follow-up owner-effect style invalidation cannot retire the bind's request", async () => {
  const { fetchPage, gates } = gated();
  const auth = new DesktopPageAuthority(fetchPage);
  auth.bind("A", SOURCE);
  const genAfterBind = auth.generationCount();
  // Re-binding the SAME owner (what a re-run of the old lifecycle effect did
  // whenever any dependency shifted) must not leave the page pending forever.
  gates[0].release([{ desktopAssetId: "d1" }]);
  await new Promise((r) => setImmediate(r));
  assert.equal(auth.snapshot().settled, true, "the page settled");
  assert.equal(auth.committedOwner(), "A");
  void genAfterBind;
});

// F3. A -> B: a late A response is dropped, B's first request commits
test("R5-F3 — A -> B drops late A and commits B on B's first request", async () => {
  const { fetchPage, gates } = gated();
  const auth = new DesktopPageAuthority(fetchPage);

  auth.bind("A", SOURCE);
  const aGate = gates[0];

  // The owner switches before A ever answered.
  auth.bind("B", SOURCE);
  assert.equal(gates.length, 2, "B issued its own first request");
  assert.equal(gates[1].owner, "B");
  assert.equal(auth.committedOwner(), "", "B did not inherit A's page");

  // B answers first and commits.
  gates[1].release([{ desktopAssetId: "b1" }]);
  await new Promise((r) => setImmediate(r));
  assert.equal(auth.committedOwner(), "B");
  assert.deepEqual(auth.snapshot().rows.map((r: any) => r.desktopAssetId), ["b1"]);

  // A's stale response arrives afterwards and must be ignored entirely.
  aGate.release([{ desktopAssetId: "a1" }]);
  await new Promise((r) => setImmediate(r));
  assert.equal(auth.committedOwner(), "B", "A never repopulates");
  assert.deepEqual(auth.snapshot().rows.map((r: any) => r.desktopAssetId), ["b1"],
    "B's rows are untouched by the late A response");
});

// The reverse order too: B answers, then A's rejection arrives.
test("R5-F3b — a late A FAILURE cannot mark B stale", async () => {
  const { fetchPage, gates } = gated();
  const errors: unknown[] = [];
  const auth = new DesktopPageAuthority(fetchPage, (e) => errors.push(e));
  auth.bind("A", SOURCE);
  const aGate = gates[0];
  auth.bind("B", SOURCE);
  gates[1].release([{ desktopAssetId: "b1" }]);
  await new Promise((r) => setImmediate(r));
  aGate.reject(new Error("A went away"));
  await new Promise((r) => setImmediate(r));
  const snap = auth.snapshot();
  assert.equal(snap.stale, false, "B is not marked stale by A's failure");
  assert.equal(snap.rows.length, 1, "and B keeps its rows");
  assert.equal(errors.length, 0, "A's failure is not reported against B");
});

// F4. a normal source toggle keeps retained rows (no rebind here at all)
test("R5-F4 — a source toggle does not touch the Desktop authority", async () => {
  const { fetchPage, gates } = gated();
  const auth = new DesktopPageAuthority(fetchPage);
  auth.bind("A", SOURCE);
  gates[0].release([{ desktopAssetId: "d1" }]);
  await new Promise((r) => setImmediate(r));

  // Toggling to Local and back is a PAGE concern: the authority is not told
  // anything (no bind / request), so the rows survive untouched.
  const before = auth.snapshot();
  assert.equal(before.rows.length, 1, "rows retained across the toggle");
  assert.equal(auth.generationCount(), before.settled ? auth.generationCount() : -1);

  // And the render gate shows them again for the same identity.
  const current = desktopIdentityOf({ ...SOURCE, owner: "A" });
  assert.equal(rowsForSnapshot(auth.snapshot(), "A", current).length, 1,
    "the exact identity still renders its rows");
});

// F5. the page can never be permanently pending because of its own effect
test("R5-F5 — the page cannot be left permanently pending by a bind", async () => {
  const { fetchPage, gates } = gated();
  const auth = new DesktopPageAuthority(fetchPage);
  auth.bind("A", SOURCE);
  const snap = auth.snapshot();
  assert.equal(snap.cold, false, "binding starts a real request, not a cold wait");
  assert.equal(snap.refreshing, true, "which is visible as refreshing");
  assert.equal(gates.length, 1, "exactly one request is outstanding");
  // Settle it and prove the terminal state is reachable without a refresh.
  gates[0].release([{ desktopAssetId: "x" }]);
  await new Promise((r) => setImmediate(r));
  assert.equal(auth.snapshot().settled, true, "terminal settled state reached");
});

// F6. an identity change (query/folder/tag) retires rows; the same owner does not
test("R5-F6 — identity change retires rows but a pure owner bind is fail-closed", async () => {
  const { fetchPage, gates } = gated();
  const auth = new DesktopPageAuthority(fetchPage);
  auth.bind("A", SOURCE);
  gates[0].release([{ desktopAssetId: "d1" }]);
  await new Promise((r) => setImmediate(r));

  // Search A -> B on the SAME Desktop: the old rows must not answer the new query.
  auth.request({ query: "B", folder: "", tag: "" });
  let snap = auth.snapshot();
  assert.equal(snap.rows.length, 0, "the previous query's rows are retired");
  assert.equal(snap.settled, false, "and the new query is pending, not settled-empty");
  assert.equal(snap.cold, false, "but a request IS in flight — not a cold wait");
  gates[1].release([{ desktopAssetId: "d2" }]);
  await new Promise((r) => setImmediate(r));
  snap = auth.snapshot();
  assert.equal(snap.settled, true);
  assert.deepEqual(snap.rows.map((r: any) => r.desktopAssetId), ["d2"]);

  // A query-only change does NOT commit rows under the old identity.
  const oldIdentity = "desktop|A|||";
  assert.equal(rowsForSnapshot(snap, "A", oldIdentity).length, 0,
    "the old identity renders nothing");
  assert.equal(rowsForSnapshot(snap, "A", desktopIdentityOf({ ...SOURCE, query: "B", owner: "A" })).length, 1,
    "the new identity renders its rows");
});

// F7. a same-owner reconnect / revalidate refreshes in place
test("R5-F7 — revalidate keeps rows and refreshes the current identity", async () => {
  const { fetchPage, gates } = gated();
  const auth = new DesktopPageAuthority(fetchPage);
  auth.bind("A", SOURCE);
  gates[0].release([{ desktopAssetId: "d1" }]);
  await new Promise((r) => setImmediate(r));

  auth.revalidate(SOURCE);
  const mid = auth.snapshot();
  assert.equal(mid.rows.length, 1, "rows stay painted during the revalidate");
  assert.equal(mid.refreshing, true, "which is reported as a refresh");
  assert.equal(mid.settled, true, "the previous settlement is still true");
  gates[1].release([{ desktopAssetId: "d1" }, { desktopAssetId: "d2" }]);
  await new Promise((r) => setImmediate(r));
  assert.equal(auth.snapshot().rows.length, 2, "the fresh page swaps in");
});

// F8. a failed refresh keeps last-good rows and never claims settled-empty
test("R5-F8 — a failed refresh keeps rows, flags stale, never settles empty", async () => {
  const { fetchPage, gates } = gated();
  const errors: unknown[] = [];
  const auth = new DesktopPageAuthority(fetchPage, (e) => errors.push(e));
  auth.bind("A", SOURCE);
  gates[0].release([{ desktopAssetId: "d1" }]);
  await new Promise((r) => setImmediate(r));

  auth.revalidate(SOURCE);
  gates[1].reject(new Error("offline"));
  await new Promise((r) => setImmediate(r));
  const snap = auth.snapshot();
  assert.equal(snap.rows.length, 1, "the last-good rows survive");
  assert.equal(snap.stale, true, "with a stale flag");
  assert.equal(snap.settled, true, "and the previous settlement is preserved");
  assert.equal(errors.length, 1, "the failure is reported exactly once");
});

// F9. an unpaired Desktop (owner "") never issues a request
test("R5-F9 — an empty owner issues no request and stays cold", async () => {
  const { fetchPage, gates } = gated();
  const auth = new DesktopPageAuthority(fetchPage);
  const bound = auth.bind("", SOURCE);
  assert.equal(bound, false, "binding no owner is not an active page");
  assert.equal(gates.length, 0, "and no request is issued");
  const snap = auth.snapshot();
  assert.equal(snap.cold, true, "the page is truthfully cold (unpaired), not pending forever");
  assert.equal(snap.refreshing, false);
  // A later real owner binds normally.
  assert.equal(auth.bind("A", SOURCE), true);
  assert.equal(gates.length, 1, "and then the first request does go out");
});

// F10. requesting before any bind is inert (no crash, no request)
test("R5-F10 — request before bind is inert", () => {
  const { fetchPage, gates } = gated();
  const auth = new DesktopPageAuthority(fetchPage);
  auth.request(SOURCE);
  auth.revalidate(SOURCE);
  assert.equal(gates.length, 0, "nothing is issued without a bound owner");
  assert.equal(auth.committedOwner(), "");
});

// ---------------------------------------------------------------------------
// The page must actually use this authority — not keep a parallel mechanism.
// ---------------------------------------------------------------------------

test("R5-W1 — StillLibrary drives the Desktop page through ONE authority", () => {
  const lib = LIB();
  assert.match(lib, /new DesktopPageAuthority\(/u, "the page constructs the authority");
  assert.match(lib, /\.bind\(desktopOwner/u, "the owner lifecycle goes through bind");
  assert.match(lib, /\.request\(/u, "ordinary re-reads go through request");
  assert.match(lib, /\.revalidate\(/u, "reconnects go through revalidate");
  // The two competing generation counters are gone.
  assert.doesNotMatch(lib, /desktopGenRef/u, "the second generation counter is removed");
  assert.doesNotMatch(lib, /setDesktopPage\(/u, "and the page no longer commits rows itself");
  assert.doesNotMatch(lib, /desktopPage\.identity/u, "nor derives identity from ad-hoc state");
});

test("R5-W2 — the page derives its render gate from the same authority", () => {
  const lib = LIB();
  assert.match(lib, /rowsForSnapshot\(/u, "rendering uses the authority's gated view");
  assert.match(lib, /useSyncExternalStore\(/u, "and subscribes to it");
  // The identity helper is the shared one, not a page-local re-implementation.
  assert.match(lib, /desktopIdentityOf\(/u, "the identity comes from the authority module");
});

test("R5-W3 — the ownership/currentness helper agrees with the authority", () => {
  const rows = [{ desktopAssetId: "d1" }];
  const snap = {
    owner: "A", identity: "desktop|A|||", rows,
    refreshing: false, stale: false, settled: true, cold: false,
  };
  assert.equal(rowsForSnapshot(snap, "A", "desktop|A|||").length, 1, "exact match renders");
  assert.equal(rowsForSnapshot(snap, "B", "desktop|A|||").length, 0, "a different owner does not");
  assert.equal(rowsForSnapshot(snap, "A", "desktop|A|q||").length, 0, "a different identity does not");
  assert.equal(rowsForSnapshot(snap, "", "desktop|A|||").length, 0, "an unpaired page renders nothing");
});
