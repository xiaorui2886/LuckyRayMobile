// MATERIAL-LIBRARY-INSTANT-R1 REPAIR-R5c — the first mount must issue exactly
// ONE page-1.
//
// R5b let the authority coalesce duplicate page reads, but the user-refresh
// effect asks with `force` so that a real Refresh can never be swallowed. The
// effect also runs once ON MOUNT, and on mount there is no user intent behind
// it: a forced read cannot be coalesced away, so it issued a second page-1 and
// retired the one the owner bind had just started — first entry into 电脑 lost
// its response again.
//
// The fix is a mount guard on THAT effect only. It is not the race-hiding guard
// R5b removed: it separates "React mounted this effect" from "the user pressed
// Refresh", while the request ordering itself stays owned by the authority.
// These tests drive the real authority through the exact mount sequence.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DesktopPageAuthority } from "../src/services/desktopPageAuthority.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const strip = (src: string) => src.replace(/^\s*\/\/.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, "");
const LIB = () => strip(read("src", "still", "StillLibrary.tsx"));

const SOURCE = { query: "", folder: "", tag: "" };
const OTHER = { query: "q2", folder: "", tag: "" };

function counter() {
  const gates: Array<{ owner: string; query: string; release: (rows: any[]) => void; reject: (e: unknown) => void }> = [];
  const fetchPage = (owner: string, source: { query: string }) =>
    new Promise<any[]>((resolve, reject) => { gates.push({ owner, query: source.query, release: resolve, reject }); });
  return { fetchPage, gates, count: () => gates.length };
}

/**
 * Mirror the page's effects, INCLUDING the mount guard, so the sequence under
 * test is the one production actually performs. `mount` runs the effects once;
 * `clickRefresh` is a later reloadKey change.
 */
function pageHarness(fetchPage: (o: string, s: any) => Promise<any[]>) {
  const auth = new DesktopPageAuthority(fetchPage);
  let armed = false;
  return {
    auth,
    /** The mount burst: bind, then every effect's first run. */
    mount(owner = "A") {
      auth.bind(owner, SOURCE);          // owner bind -> the single page-1
      auth.request(SOURCE);              // identity effect (coalesced)
      if (!armed) { armed = true; }      // refresh effect: first run is a NO-OP
      else { auth.revalidate(SOURCE, true); }
      auth.revalidate(SOURCE);           // version effect (coalesced)
    },
    /** A later reloadKey change: a genuine user Refresh. */
    clickRefresh() { auth.revalidate(SOURCE, true); },
    /** A later query/folder/tag change. */
    changeIdentity(source = OTHER) { auth.request(source); },
    /** A Desktop-domain store event. */
    storeEvent() { auth.revalidate(SOURCE); },
  };
}

// The card's exact sequence, with the required fetch count.
test("R5c-1 — the mount sequence issues exactly ONE page-1", async () => {
  const { fetchPage, gates } = counter();
  const h = pageHarness(fetchPage);

  h.mount();   // bind(A) ; identity effect ; refresh effect = NO-OP ; version effect
  assert.equal(gates.length, 1, "fetch count after mount is 1");

  // The bind's single response commits directly — no Refresh needed.
  gates[0].release([{ desktopAssetId: "d1" }]);
  await new Promise((r) => setImmediate(r));
  const snap = h.auth.snapshot();
  assert.equal(snap.settled, true, "the first response settled the page");
  assert.equal(snap.rows.length, 1, "with its rows");
  assert.equal(h.auth.committedOwner(), "A");
  assert.equal(snap.refreshing, false);
});

// A real Refresh afterwards IS a forced request.
test("R5c-2 — a user Refresh after mount issues a second request", async () => {
  const { fetchPage, gates } = counter();
  const h = pageHarness(fetchPage);
  h.mount();
  gates[0].release([{ desktopAssetId: "d1" }]);
  await new Promise((r) => setImmediate(r));

  h.clickRefresh();
  assert.equal(gates.length, 2, "fetch count after the user Refresh is 2");
  gates[1].release([{ desktopAssetId: "d1" }, { desktopAssetId: "d2" }]);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.auth.snapshot().rows.length, 2, "and the refreshed page commits");
});

// A Refresh pressed while the mount request is STILL in flight still reaches
// the wire — the guard must not swallow a real user action.
test("R5c-3 — a Refresh during the in-flight mount request still reaches the wire", async () => {
  const { fetchPage, gates } = counter();
  const h = pageHarness(fetchPage);
  h.mount();
  assert.equal(gates.length, 1, "the mount left one request in flight");

  h.clickRefresh();   // the user is impatient
  assert.equal(gates.length, 2, "the forced refresh is not coalesced away");
  gates[1].release([{ desktopAssetId: "fresh" }]);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.auth.snapshot().rows.length, 1, "the newest response is what commits");
});

// The two coalescing effects stay coalesced on mount.
test("R5c-4 — the initial identity and version effects are coalesced", async () => {
  const { fetchPage, gates } = counter();
  const h = pageHarness(fetchPage);
  h.mount();
  assert.equal(gates.length, 1, "neither the identity nor the version effect added a request");

  // And they still work LATER, when they are genuine changes.
  gates[0].release([{ desktopAssetId: "d1" }]);
  await new Promise((r) => setImmediate(r));

  h.storeEvent();
  assert.equal(gates.length, 2, "a later store event revalidates for real");
  gates[1].release([{ desktopAssetId: "d1" }]);
  await new Promise((r) => setImmediate(r));

  h.changeIdentity();
  assert.equal(gates.length, 3, "a later query change requests for real");
  assert.equal(gates[2].query, "q2");
  gates[2].release([{ desktopAssetId: "q2" }]);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.auth.snapshot().rows.map((r: any) => r.desktopAssetId), ["q2"],
    "and the new identity's rows replace the old");
});

// A -> B on first mount of the new owner issues one request too.
test("R5c-5 — an owner switch after mount issues exactly ONE first request", async () => {
  const { fetchPage, gates } = counter();
  const h = pageHarness(fetchPage);
  h.mount();
  gates[0].release([{ desktopAssetId: "a1" }]);
  await new Promise((r) => setImmediate(r));

  const before = gates.length;
  h.auth.bind("B", SOURCE);   // the page re-runs its effects for the new owner
  h.auth.request(SOURCE);
  h.auth.revalidate(SOURCE);
  assert.equal(gates.length, before + 1, "B issued exactly one first request");
  gates[before].release([{ desktopAssetId: "b1" }]);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.auth.committedOwner(), "B");
});

// Repeated Refresh taps each reach the wire (the guard is mount-only).
test("R5c-6 — every later Refresh is real, not just the first", async () => {
  const { fetchPage, gates } = counter();
  const h = pageHarness(fetchPage);
  h.mount();
  gates[0].release([]);
  await new Promise((r) => setImmediate(r));

  for (let i = 0; i < 3; i++) {
    const before = gates.length;
    h.clickRefresh();
    assert.equal(gates.length, before + 1, `refresh ${i + 1} issued a real request`);
    gates[gates.length - 1].release([]);
    await new Promise((r) => setImmediate(r));
  }
});

// A failed mount request must still allow a real user retry.
test("R5c-7 — a failed mount request still allows a user retry", async () => {
  const { fetchPage, gates } = counter();
  const errors: unknown[] = [];
  const auth = new DesktopPageAuthority(fetchPage, (e) => errors.push(e));
  let armed = false;
  // mount
  auth.bind("A", SOURCE);
  auth.request(SOURCE);
  if (!armed) armed = true; else auth.revalidate(SOURCE, true);
  auth.revalidate(SOURCE);
  assert.equal(gates.length, 1, "mount issued one request");
  gates[0].reject(new Error("offline"));
  await new Promise((r) => setImmediate(r));
  assert.equal(auth.snapshot().stale, true, "the failure shows as stale");
  assert.equal(errors.length, 1, "reported once");

  // the user retries with Refresh
  auth.revalidate(SOURCE, true);
  assert.equal(gates.length, 2, "the retry reaches the wire");
  gates[1].release([{ desktopAssetId: "d1" }]);
  await new Promise((r) => setImmediate(r));
  assert.equal(auth.snapshot().settled, true, "and settles");
});

// ---------------------------------------------------------------------------
// Production wiring.
// ---------------------------------------------------------------------------

test("R5c-W1 — the refresh effect is guarded on its FIRST run only", () => {
  const lib = LIB();
  // The guard exists and precedes the forced read in the same effect.
  assert.match(lib, /const refreshArmed = useRef\(false\);/u, "the mount guard exists");
  const idx = lib.indexOf("const refreshArmed = useRef(false);");
  const effect = lib.slice(idx, lib.indexOf("}, [desktopAuthority, reloadKey]);", idx) + 36);
  assert.match(effect, /if \(!refreshArmed\.current\) \{ refreshArmed\.current = true; return; \}/u,
    "the first run returns before doing anything");
  assert.match(effect, /desktopAuthority\.revalidate\(DESKTOP_SOURCE\(\), true\);/u,
    "and every later run is a forced refresh");
  // Only user refresh and an explicit same-owner reconnect force a read.
  const forced = lib.match(/revalidate\(DESKTOP_SOURCE\(\), true\)/gu) ?? [];
  assert.equal(forced.length, 2, "only user refresh and reconnect force reads");
  assert.match(lib, /previous\?\.owner === owner && previous\.state !== "connected" && state === "connected"/u);
  assert.match(lib, /if \(!state\) return;/u, "partial snapshots are not reconnect edges");
});

test("R5c-W2 — the other Desktop effects are NOT mount-guarded (authority coalesces them)", () => {
  const lib = LIB();
  const bindIdx = lib.indexOf('desktopAuthority.bind(desktopOwner, source);');
  const bindEffect = lib.slice(bindIdx, lib.indexOf("}, [desktopAuthority, conn?.paired, desktopOwner, library, libraries.materialsEpoch]);", bindIdx));
  assert.doesNotMatch(bindEffect, /current\) \{|firstRun|mounted/u,
    "the owner bind issues its page-1 on mount, unguarded (that IS the first request)");
  const idIdx = lib.indexOf("desktopAuthority.request(DESKTOP_SOURCE());");
  const idEffect = lib.slice(idIdx, lib.indexOf("}, [desktopAuthority, query, desktopFolder, desktopTag]);", idIdx));
  assert.doesNotMatch(idEffect, /current\) \{|firstRun|mounted/u,
    "the identity effect relies on coalescing, not on a guard");
  const verIdx = lib.indexOf("desktopAuthority.revalidate(DESKTOP_SOURCE());");
  const verEffect = lib.slice(verIdx, lib.indexOf("}, [desktopAuthority, version]);", verIdx));
  assert.doesNotMatch(verEffect, /current\) \{|firstRun|mounted/u,
    "and so does the version effect");
});

test("R5c-W3 — the old race-hiding guard is still absent", () => {
  const lib = LIB();
  // R5b removed this because it papered over the authority's ordering; it must
  // not come back under its old name.
  assert.doesNotMatch(lib, /firstDesktopRefresh/u,
    "the R5b-removed guard name is not reintroduced");
  // The ordering authority is intact: coalescing still lives in the authority.
  const auth = strip(read("src", "services", "desktopPageAuthority.ts"));
  assert.match(auth, /if \(!force && this\.refreshing && identity === this\.identity\) return;/u,
    "the authority still coalesces a genuinely in-flight duplicate");
});
