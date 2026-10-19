// MATERIAL-LIBRARY-INSTANT-R1 REPAIR-R5b — first Desktop entry must issue ONE
// page-1, not three.
//
// On the physical device the first tap on 电脑 could burn three page-1 reads:
// the owner bind issued #1, the query/folder/tag identity effect issued #2 and
// the Desktop-domain store effect issued #3. Because each call took a new
// generation, the later calls retired the earlier ones, so #1 and #2 were
// discarded on arrival and their responses were never committed.
//
// The fix belongs in the authority rather than in each effect, so these tests
// drive the REAL authority through the exact production call sequence.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DesktopPageAuthority,
  desktopIdentityOf,
} from "../src/services/desktopPageAuthority.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const strip = (src: string) => src.replace(/^\s*\/\/.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, "");
const LIB = () => strip(read("src", "still", "StillLibrary.tsx"));

const SOURCE = { query: "", folder: "", tag: "" };
const OTHER = { query: "b", folder: "", tag: "" };

/** Counts calls and lets the test release each response explicitly. */
function counter() {
  const gates: Array<{ owner: string; query: string; release: (rows: any[]) => void; reject: (e: unknown) => void }> = [];
  const fetchPage = (owner: string, source: { query: string }) =>
    new Promise<any[]>((resolve, reject) => {
      gates.push({ owner, query: source.query, release: resolve, reject });
    });
  return { fetchPage, gates, count: () => gates.length };
}

// The exact production burst on first entry into 电脑.
test("R5b-1 — first entry issues exactly ONE page-1 across bind + identity + store effects", async () => {
  const { fetchPage, gates } = counter();
  const auth = new DesktopPageAuthority(fetchPage);

  // This is the real first-mount sequence the page performs, in order.
  auth.bind("A", SOURCE);          // owner bind
  auth.request(SOURCE);            // query/folder/tag identity effect
  auth.revalidate(SOURCE);         // Desktop-domain store effect

  assert.equal(gates.length, 1, "only ONE page-1 reaches the wire for one identity");
  assert.equal(gates[0].owner, "A");

  // The single outstanding response commits directly — no Refresh needed.
  gates[0].release([{ desktopAssetId: "d1" }]);
  await new Promise((r) => setImmediate(r));
  const snap = auth.snapshot();
  assert.equal(snap.settled, true, "the first response settled the page");
  assert.equal(snap.rows.length, 1, "with its rows committed");
  assert.equal(auth.committedOwner(), "A", "against the bound owner");
  assert.equal(snap.refreshing, false, "and nothing is left refreshing");
});

// Once settled, a further revalidate IS a real request.
test("R5b-2 — after settling, a revalidate issues a new request", async () => {
  const { fetchPage, gates } = counter();
  const auth = new DesktopPageAuthority(fetchPage);
  auth.bind("A", SOURCE);
  gates[0].release([{ desktopAssetId: "d1" }]);
  await new Promise((r) => setImmediate(r));
  assert.equal(auth.snapshot().settled, true);

  auth.revalidate(SOURCE);
  assert.equal(gates.length, 2, "a settled page re-reads on demand");
  gates[1].release([{ desktopAssetId: "d1" }, { desktopAssetId: "d2" }]);
  await new Promise((r) => setImmediate(r));
  assert.equal(auth.snapshot().rows.length, 2, "and the fresh page swaps in");
});

// A real identity change is never coalesced.
test("R5b-3 — a query identity change still issues its own request", async () => {
  const { fetchPage, gates } = counter();
  const auth = new DesktopPageAuthority(fetchPage);
  auth.bind("A", SOURCE);
  assert.equal(gates.length, 1);

  // Different query while #1 is still in flight: this is a DIFFERENT identity,
  // so it must not be swallowed by the coalescing rule.
  auth.request(OTHER);
  assert.equal(gates.length, 2, "the new query issues a real request");
  assert.equal(gates[1].query, "b");

  // The retired identity's late response commits nothing.
  gates[0].release([{ desktopAssetId: "old" }]);
  await new Promise((r) => setImmediate(r));
  assert.equal(auth.committedOwner(), "", "the retired query never commits");
  gates[1].release([{ desktopAssetId: "new" }]);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(auth.snapshot().rows.map((r: any) => r.desktopAssetId), ["new"]);
});

// An explicit Refresh always reaches the wire (force bypasses coalescing).
test("R5b-4 — an explicit forced refresh always issues a request", async () => {
  const { fetchPage, gates } = counter();
  const auth = new DesktopPageAuthority(fetchPage);
  auth.bind("A", SOURCE);
  assert.equal(gates.length, 1, "the bind issued #1");

  // The user taps Refresh while #1 is STILL in flight: they mean it.
  auth.revalidate(SOURCE, true);
  assert.equal(gates.length, 2, "the forced refresh is not coalesced away");

  gates[1].release([{ desktopAssetId: "fresh" }]);
  await new Promise((r) => setImmediate(r));
  assert.equal(auth.snapshot().rows.length, 1, "and it commits");
});

// A->B: B still gets exactly one first request.
test("R5b-5 — A -> B issues only ONE first request for B", async () => {
  const { fetchPage, gates } = counter();
  const auth = new DesktopPageAuthority(fetchPage);
  auth.bind("A", SOURCE);
  const aGate = gates[0];

  auth.bind("B", SOURCE);
  // B's own first request, plus the two coalesced follow-ups the page performs.
  auth.request(SOURCE);
  auth.revalidate(SOURCE);
  assert.equal(gates.length, 2, "B issued exactly one first request");

  gates[1].release([{ desktopAssetId: "b1" }]);
  await new Promise((r) => setImmediate(r));
  assert.equal(auth.committedOwner(), "B", "B committed on its own request");
  aGate.release([{ desktopAssetId: "a1" }]);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(auth.snapshot().rows.map((r: any) => r.desktopAssetId), ["b1"],
    "the late A response never lands");
});

// A -> B -> back to A is still a real request, and still single.
test("R5b-6 — returning to A after B issues one fresh request", async () => {
  const { fetchPage, gates } = counter();
  const auth = new DesktopPageAuthority(fetchPage);
  auth.bind("A", SOURCE);
  gates[0].release([{ desktopAssetId: "a1" }]);
  await new Promise((r) => setImmediate(r));

  auth.bind("B", SOURCE);
  gates[1].release([{ desktopAssetId: "b1" }]);
  await new Promise((r) => setImmediate(r));

  const before = gates.length;
  auth.bind("A", SOURCE);   // back to A
  auth.request(SOURCE);     // the effects fire again
  auth.revalidate(SOURCE);
  assert.equal(gates.length, before + 1, "coming back to A issues exactly one request");
  gates[before].release([{ desktopAssetId: "a2" }]);
  await new Promise((r) => setImmediate(r));
  assert.equal(auth.committedOwner(), "A");
  assert.deepEqual(auth.snapshot().rows.map((r: any) => r.desktopAssetId), ["a2"],
    "A re-read its own current rows");
});

// A failed first request must not permanently block a later retry.
test("R5b-7 — a failed first request still allows a later real retry", async () => {
  const { fetchPage, gates } = counter();
  const errors: unknown[] = [];
  const auth = new DesktopPageAuthority(fetchPage, (e) => errors.push(e));
  auth.bind("A", SOURCE);
  gates[0].reject(new Error("offline"));
  await new Promise((r) => setImmediate(r));
  assert.equal(auth.snapshot().stale, true, "the failure is visible");
  assert.equal(errors.length, 1, "and reported once");

  // The page retries: refreshing is false again, so this must reach the wire.
  auth.revalidate(SOURCE);
  assert.equal(gates.length, 2, "the retry issues a real request");
  gates[1].release([{ desktopAssetId: "d1" }]);
  await new Promise((r) => setImmediate(r));
  assert.equal(auth.snapshot().settled, true, "and it settles");
});

// The coalescing must never mask a genuine re-read of the SAME identity after
// a failure, nor turn a same-identity call into a silent no-op forever.
test("R5b-8 — coalescing only suppresses a genuinely in-flight duplicate", async () => {
  const { fetchPage, gates } = counter();
  const auth = new DesktopPageAuthority(fetchPage);
  auth.bind("A", SOURCE);
  auth.request(SOURCE);
  auth.request(SOURCE);
  auth.revalidate(SOURCE);
  assert.equal(gates.length, 1, "all in-flight duplicates collapse to one");

  gates[0].release([]);
  await new Promise((r) => setImmediate(r));

  // Now settled-empty: each new call is a real read.
  for (let i = 0; i < 3; i++) {
    const before = gates.length;
    auth.revalidate(SOURCE);
    assert.equal(gates.length, before + 1, `settled call ${i + 1} issues a real request`);
    gates[gates.length - 1].release([]);
    await new Promise((r) => setImmediate(r));
  }
});

// An unpaired authority issues nothing, and a coalesced call cannot latch state.
test("R5b-9 — no owner issues nothing; a coalesced call leaves state honest", async () => {
  const { fetchPage, gates } = counter();
  const auth = new DesktopPageAuthority(fetchPage);
  auth.bind("", SOURCE);
  auth.request(SOURCE);
  auth.revalidate(SOURCE);
  assert.equal(gates.length, 0, "an unpaired page never reaches the wire");
  assert.equal(auth.snapshot().cold, true, "and stays truthfully cold");

  auth.bind("A", SOURCE);
  const snap = auth.snapshot();
  assert.equal(snap.refreshing, true, "a real bind reports the outstanding request");
  assert.equal(snap.cold, false, "and is not cold");
  auth.request(SOURCE);
  assert.equal(gates.length, 1, "the duplicate is still coalesced");
  assert.equal(auth.snapshot().refreshing, true, "and the state is unchanged");
});

// ---------------------------------------------------------------------------
// Production wiring: the page must drive exactly these calls.
// ---------------------------------------------------------------------------

test("R5b-W1 — the page performs the bind + request + revalidate sequence", () => {
  const lib = LIB();
  assert.match(lib, /desktopAuthority\.bind\(desktopOwner, DESKTOP_SOURCE\(\)\);/u,
    "the owner bind issues the first page-1");
  assert.match(lib, /const source = DESKTOP_SOURCE\(\);/u,"capture the current axes once");
  assert.match(lib, /setTimeout\(\(\) => desktopAuthority\.request\(source\), 180\)/u,
    "the current identity read is typing-debounced, not mount-delayed");
  assert.match(lib,/return \(\) => clearTimeout\(timer\);/u,"a superseded typing read is cancelled");
  assert.match(lib, /desktopAuthority\.revalidate\(DESKTOP_SOURCE\(\)\);/u,
    "the store effect revalidates the current page");
  // The user refresh is explicitly forced, so it can never be coalesced away.
  assert.match(lib, /desktopAuthority\.revalidate\(DESKTOP_SOURCE\(\), true\);/u,
    "an explicit Refresh reaches the wire");
  // The now-redundant per-effect mount guard is gone: the authority owns it.
  assert.doesNotMatch(lib, /firstDesktopRefresh/u, "no ad-hoc first-run guard remains");
});

test("R5b-W2 — the authority coalesces before it mutates anything", () => {
  const src = strip(read("src", "services", "desktopPageAuthority.ts"));
  const req = src.slice(src.indexOf("request(source: Omit<DesktopSource"));
  const guardIdx = req.indexOf("if (!force && this.refreshing && identity === this.identity) return;");
  const genIdx = req.indexOf("const gen = ++this.generation;");
  assert.ok(guardIdx > 0, "the coalescing guard exists");
  assert.ok(genIdx > guardIdx, "and runs BEFORE the generation is taken, so a duplicate cannot retire its twin");
  // The guard requires the SAME identity, so an identity change is never swallowed.
  assert.match(req.slice(0, guardIdx), /const identity = desktopIdentityOf\(\{ \.\.\.source, owner \}\);/u,
    "the guard compares the request's own identity");
});
