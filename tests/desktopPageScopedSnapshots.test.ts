import test from "node:test";
import assert from "node:assert/strict";
import {
  DesktopPageAuthority, desktopIdentityOf, rowsForSnapshot,
  type DesktopPage, type DesktopSource,
} from "../src/services/desktopPageAuthority.ts";

type Source = Omit<DesktopSource, "owner">;
const SOURCE: Source = { library: "a", query: "", folder: "", tag: "", kind: "" };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const row = (id: string) => ({ desktopAssetId: id });
const identity = (source = SOURCE, owner = "desktop") => desktopIdentityOf({ ...source, owner });
function gated() {
  const reads: Array<{
    owner: string; source: DesktopSource; page: number;
    resolve: (value: DesktopPage | any[]) => void; reject: (error: unknown) => void;
  }> = [];
  const errors: unknown[] = [];
  const auth = new DesktopPageAuthority((owner, source, page) => new Promise((resolve, reject) => {
    reads.push({ owner, source, page, resolve, reject });
  }), error => errors.push(error));
  return { auth, reads, errors };
}

test("scoped material snapshot misses and retained views are stable before navigation effects", async () => {
  const { auth, reads } = gated();
  const a = identity(), b = identity({ ...SOURCE, library: "b" });
  const cold = auth.snapshotFor(a);
  assert.strictEqual(auth.snapshotFor(a), cold);
  assert.strictEqual(auth.snapshotFor(b), cold);
  assert.equal(cold.cold, true);
  auth.bind("desktop", SOURCE);
  assert.strictEqual(auth.snapshotFor(a), auth.snapshot());
  reads[0].resolve([row("a")]); await tick();
  const settled = auth.snapshotFor(a);
  auth.bind("desktop", { ...SOURCE, library: "b" });
  assert.strictEqual(auth.snapshotFor(a), settled, "A is ready synchronously before a return-to-A effect");
  assert.strictEqual(auth.snapshotFor(a), auth.snapshotFor(a));
  assert.deepEqual(rowsForSnapshot(auth.snapshotFor(b), "desktop", b), []);
  assert.deepEqual(rowsForSnapshot(auth.snapshotFor(a), "desktop", a), [row("a")]);
  const visible: string[][] = [];
  auth.subscribe(() => visible.push(auth.snapshot().rows.map(value => value.desktopAssetId)));
  auth.bind("desktop", SOURCE);
  assert.deepEqual(visible, [["a"]], "a returning bind never publishes a blank intermediate frame");
  assert.strictEqual(auth.snapshot().rows, settled.rows);
  assert.equal(auth.snapshot().settled, true);
  assert.equal(auth.snapshot().refreshing, true);
  auth.request(SOURCE); auth.revalidate(SOURCE);
  assert.equal(reads.length, 3, "return-to-A background effects coalesce to one read");
});

test("every source axis isolates A/B/A retention, including owner, kind and opaque separators", async () => {
  const alternatives: DesktopSource[] = [
    { ...SOURCE, owner: "other" },
    { ...SOURCE, owner: "desktop", library: "b" },
    { ...SOURCE, owner: "desktop", query: "portrait" },
    { ...SOURCE, owner: "desktop", folder: "folder" },
    { ...SOURCE, owner: "desktop", tag: "tag" },
    { ...SOURCE, owner: "desktop", kind: "image" },
  ];
  for (const other of alternatives) {
    const { auth, reads } = gated();
    auth.bind("desktop", SOURCE); reads[0].resolve([row("a")]); await tick();
    auth.bind(other.owner, other);
    assert.equal(auth.snapshot().rows.length, 0);
    reads[1].resolve([row("b")]); await tick();
    assert.deepEqual(auth.snapshotFor(identity()).rows, [row("a")]);
    auth.bind("desktop", SOURCE);
    assert.deepEqual(auth.snapshot().rows, [row("a")]);
    assert.deepEqual(auth.snapshotFor(desktopIdentityOf(other)).rows, [row("b")]);
    auth.dispose();
  }
  const base = { ...SOURCE, owner: "desktop" };
  assert.notEqual(desktopIdentityOf({ ...base, query: "a|b", folder: "c" }), desktopIdentityOf({ ...base, query: "a", folder: "b|c" }));
  assert.notEqual(desktopIdentityOf({ ...base, owner: "desktop|x", query: "y" }), desktopIdentityOf({ ...base, query: "x|y" }));
  assert.notEqual(desktopIdentityOf({ ...base, tag: "|library:b", library: undefined }), desktopIdentityOf({ ...base, tag: "", library: "b" }));
  assert.notEqual(desktopIdentityOf({ ...base, library: "a|kind:image" }), desktopIdentityOf({ ...base, kind: "image" }));
  assert.notEqual(desktopIdentityOf({ ...base, folder: "%7C" }), desktopIdentityOf({ ...base, folder: "|" }));
});

test("returned scope retains loaded extent and swaps background pages atomically", async () => {
  const { auth, reads } = gated();
  auth.bind("desktop", SOURCE);
  reads[0].resolve({ items: [row("old-1")], hasMore: true, nextPage: 1000 }); await tick();
  const more = auth.loadMore(SOURCE);
  reads[1].resolve({ items: [row("old-1000")], hasMore: true, nextPage: 1001 }); await more;
  auth.bind("desktop", { ...SOURCE, library: "b" });
  reads[2].resolve([row("b")]); await tick();
  auth.bind("desktop", SOURCE);
  const retained = auth.snapshot().rows;
  assert.equal(auth.snapshot().page, 1000);
  assert.equal(auth.snapshot().nextPage, 1001);
  reads[3].resolve({ items: [row("new-1")], hasMore: true, nextPage: 2 }); await tick();
  assert.strictEqual(auth.snapshot().rows, retained, "page 1 never replaces the whole loaded grid early");
  assert.equal(reads[4].page, 2);
  reads[4].resolve({ items: [row("new-2")], hasMore: true, nextPage: 3 }); await tick();
  assert.deepEqual(auth.snapshot().rows, [row("new-1"), row("new-2")]);
  assert.equal(auth.snapshot().page, 2);
  assert.equal(auth.snapshot().nextPage, 3);
  assert.equal(reads.length, 5, "only the two previously loaded pages are revalidated");
});

test("partial background failure preserves loaded rows and continuation across another return", async () => {
  const { auth, reads } = gated();
  auth.bind("desktop", SOURCE);
  reads[0].resolve({ items: [row("old-1")], hasMore: true, nextPage: 8 }); await tick();
  const more = auth.loadMore(SOURCE);
  reads[1].resolve({ items: [row("old-8")], hasMore: true, nextPage: 9 }); await more;
  const retained = auth.snapshot().rows;
  auth.revalidate(SOURCE);
  reads[2].resolve({ items: [row("new-1")], hasMore: true, nextPage: 2 }); await tick();
  reads[3].reject(Error("CONTENT_OFFLINE")); await tick();
  assert.strictEqual(auth.snapshot().rows, retained);
  assert.equal(auth.snapshot().settled, true);
  assert.equal(auth.snapshot().stale, true);
  assert.equal(auth.snapshot().page, 8);
  assert.equal(auth.snapshot().nextPage, 9);
  auth.request({ ...SOURCE, query: "elsewhere" }); reads[4].resolve([]); await tick();
  auth.request(SOURCE);
  assert.strictEqual(auth.snapshot().rows, retained);
  assert.equal(auth.snapshot().stale, true);
  reads[5].resolve({ items: [row("fresh-1")], hasMore: true, nextPage: 2 }); await tick();
  reads[6].resolve({ items: [row("fresh-2")], hasMore: false }); await tick();
  assert.equal(auth.snapshot().stale, false);
  assert.equal(auth.snapshot().rows.length, 2);
});

test("late background successes and failures cannot alter a restored scope or its retained neighbor", async () => {
  const { auth, reads, errors } = gated();
  auth.bind("desktop", SOURCE); reads[0].resolve([row("a")]); await tick();
  auth.revalidate(SOURCE);
  auth.request({ ...SOURCE, library: "b" });
  auth.request(SOURCE);
  reads[3].resolve([row("fresh-a")]); await tick();
  const current = auth.snapshot();
  reads[1].reject(Error("AUTH_REVOKED"));
  reads[2].resolve([row("late-b")]); await tick();
  assert.strictEqual(auth.snapshot(), current);
  assert.deepEqual(auth.snapshot().rows, [row("fresh-a")]);
  assert.equal(auth.snapshotFor(identity({ ...SOURCE, library: "b" })).rows.length, 0);
  assert.deepEqual(errors, []);
});

test("abandoned append cannot pollute a restored scope and does not retain an in-flight flag", async () => {
  const { auth, reads } = gated();
  auth.bind("desktop", SOURCE);
  reads[0].resolve({ items: [row("a")], hasMore: true, nextPage: 2 }); await tick();
  const more = auth.loadMore(SOURCE);
  auth.request({ ...SOURCE, library: "b" });
  assert.equal(auth.snapshotFor(identity()).refreshing, false);
  auth.request(SOURCE);
  assert.deepEqual(auth.snapshot().rows, [row("a")]);
  reads[1].resolve({ items: [row("late-append")], hasMore: false }); await more;
  assert.deepEqual(auth.snapshot().rows, [row("a")]);
  assert.equal(auth.snapshot().refreshing, true, "only the current background refresh is pending");
  reads[3].resolve([row("fresh")]); await tick();
  assert.deepEqual(auth.snapshot().rows, [row("fresh")]);
});

async function seededScopes() {
  const helper = gated();
  const scopes = [
    { ...SOURCE, owner: "other" },
    { ...SOURCE, owner: "desktop", library: "b" },
    { ...SOURCE, owner: "desktop", query: "filtered" },
    { ...SOURCE, owner: "desktop" },
  ];
  for (const [index, scope] of scopes.entries()) {
    helper.auth.bind(scope.owner, scope);
    helper.reads[index].resolve([row(String(index))]); await tick();
  }
  return { ...helper, scopes };
}

test("explicit library revocation purges every filter in only that library and retires pending work", async () => {
  const { auth, reads, scopes } = await seededScopes();
  auth.revalidate(SOURCE);
  auth.invalidateScope("desktop", "a");
  assert.equal(auth.snapshot().rows.length, 0);
  assert.equal(auth.snapshot().refreshing, false);
  assert.equal(auth.snapshot().hasMore, false);
  assert.equal(auth.snapshotFor(desktopIdentityOf(scopes[2])).rows.length, 0);
  assert.equal(auth.snapshotFor(desktopIdentityOf(scopes[0])).rows.length, 1);
  assert.equal(auth.snapshotFor(desktopIdentityOf(scopes[1])).rows.length, 1);
  reads[4].resolve([row("too-late")]); await tick();
  assert.equal(auth.snapshot().rows.length, 0);
  auth.bind("desktop", SOURCE);
  assert.equal(auth.snapshot().rows.length, 0, "revoked rows never return while awaiting a new authorized response");
});

test("inactive invalidation notifies readers without changing the unrelated active snapshot", async () => {
  const { auth, scopes } = await seededScopes();
  const current = auth.snapshot();
  let notifications = 0; auth.subscribe(() => notifications++);
  auth.invalidateScope("other");
  assert.equal(auth.snapshotFor(desktopIdentityOf(scopes[0])).rows.length, 0);
  assert.strictEqual(auth.snapshot(), current);
  assert.equal(notifications, 1);
  auth.invalidateScope("missing");
  assert.equal(notifications, 1, "a nonexistent scope has no state change");
});

for (const error of [Error("content http 403 [FORBIDDEN]"), "CONTENT_HTTP_404", "CONTENT_HTTP_410", "GRANT_REQUIRED", "SCOPE_DENIED", "LIBRARY_READ_NOT_GRANTED", { code: "GRANT_REQUIRED" }]) {
  test(`scope denial ${String(error)} purges all retained views of that library only`, async () => {
    const { auth, reads, scopes, errors } = await seededScopes();
    auth.revalidate(SOURCE); reads[4].reject(error); await tick();
    assert.equal(auth.snapshot().rows.length, 0);
    assert.equal(auth.snapshot().settled, false);
    assert.equal(auth.snapshotFor(desktopIdentityOf(scopes[2])).rows.length, 0);
    assert.equal(auth.snapshotFor(desktopIdentityOf(scopes[1])).rows.length, 1);
    assert.equal(auth.snapshotFor(desktopIdentityOf(scopes[0])).rows.length, 1);
    assert.deepEqual(errors, [error]);
  });
}

for (const error of [Error("CONTENT_HTTP_401"), "UNAUTHORIZED", "AUTH_REVOKED", "PAIRING_REQUIRED", { status: 401 }]) {
  test(`authentication loss ${String(error)} purges every protected view of that owner`, async () => {
    const { auth, reads, scopes } = await seededScopes();
    auth.revalidate(SOURCE); reads[4].reject(error); await tick();
    for (const scope of scopes.slice(1)) assert.equal(auth.snapshotFor(desktopIdentityOf(scope)).rows.length, 0);
    assert.equal(auth.snapshotFor(desktopIdentityOf(scopes[0])).rows.length, 1);
  });
}

test("append permission failure has the same protected-scope purge semantics", async () => {
  const { auth, reads } = gated();
  auth.bind("desktop", SOURCE);
  reads[0].resolve({ items: [row("a")], hasMore: true, nextPage: 2 }); await tick();
  auth.request({ ...SOURCE, query: "filtered" }); reads[1].resolve([]); await tick();
  auth.request(SOURCE);
  reads[2].resolve({ items: [row("a")], hasMore: true, nextPage: 2 }); await tick();
  const more = auth.loadMore(SOURCE); reads[3].reject(Error("SCOPE_DENIED")); await more;
  assert.equal(auth.snapshot().rows.length, 0);
  assert.equal(auth.snapshotFor(identity({ ...SOURCE, query: "filtered" })).settled, false);
  assert.equal(auth.snapshot().nextPage, null);
});

test("unpair clears all protected history and ignores late work even after same-owner re-pair", async () => {
  const { auth, reads, scopes } = await seededScopes();
  auth.revalidate(SOURCE);
  auth.bind("", SOURCE);
  for (const scope of scopes) assert.equal(auth.snapshotFor(desktopIdentityOf(scope)).rows.length, 0);
  assert.equal(auth.snapshot().cold, true);
  auth.bind("desktop", SOURCE);
  assert.equal(auth.snapshot().rows.length, 0);
  reads[4].resolve([row("before-unpair")]); await tick();
  assert.equal(auth.snapshot().rows.length, 0);
  reads[5].resolve([row("after-repair")]); await tick();
  assert.deepEqual(auth.snapshot().rows, [row("after-repair")]);
  auth.dispose();
  for (const scope of scopes) assert.equal(auth.snapshotFor(desktopIdentityOf(scope)).rows.length, 0);
});

test("settled-empty is retained as settled-empty rather than a fresh cold placeholder", async () => {
  const { auth, reads } = gated();
  auth.bind("desktop", SOURCE); reads[0].resolve([]); await tick();
  const empty = auth.snapshot();
  auth.request({ ...SOURCE, query: "other" });
  assert.strictEqual(auth.snapshotFor(identity()), empty);
  auth.request(SOURCE);
  assert.equal(auth.snapshot().settled, true);
  assert.equal(auth.snapshot().cold, false);
  assert.equal(auth.snapshot().rows.length, 0);
});

test("same-scope rebind restores rows but supersedes a native-retired request", async () => {
  const { auth, reads } = gated();
  auth.bind("desktop", SOURCE); reads[0].resolve([row("a")]); await tick();
  auth.revalidate(SOURCE);
  auth.bind("desktop", SOURCE);
  assert.equal(reads.length, 3);
  assert.deepEqual(auth.snapshot().rows, [row("a")]);
  reads[1].reject(Error("CONTENT_SOURCE_CHANGED")); await tick();
  assert.equal(auth.snapshot().stale, false);
  assert.equal(auth.snapshot().refreshing, true);
  reads[2].resolve([row("new")]); await tick();
  assert.deepEqual(auth.snapshot().rows, [row("new")]);
});

test("transport retirement and transient failures are not permission revocation", async () => {
  const { auth, reads } = gated();
  auth.bind("desktop", SOURCE); reads[0].resolve([row("a")]); await tick();
  for (const failure of ["CONTENT_SOURCE_CHANGED", "CONTENT_DISCONNECTED", "CONTENT_OFFLINE", "HTTP 503", "TIMEOUT"]) {
    auth.revalidate(SOURCE); reads.at(-1)!.reject(Error(failure)); await tick();
    assert.deepEqual(auth.snapshot().rows, [row("a")]);
    assert.equal(auth.snapshot().settled, true);
  }
});

test("scope input mutation cannot retarget a multi-page background read", async () => {
  const { auth, reads } = gated();
  const source = { ...SOURCE };
  auth.bind("desktop", source);
  source.library = "foreign";
  reads[0].resolve({ items: [row("a")], hasMore: true, nextPage: 2 }); await tick();
  const more = auth.loadMore(SOURCE);
  assert.equal(reads[1].source.library, "a");
  reads[1].resolve({ items: [row("a2")], hasMore: false }); await more;
  const refresh = { ...SOURCE };
  auth.revalidate(refresh);
  refresh.library = "foreign";
  reads[2].resolve({ items: [row("fresh")], hasMore: true, nextPage: 2 }); await tick();
  assert.equal(reads[3].source.library, "a");
  reads[3].resolve({ items: [row("fresh2")], hasMore: false }); await tick();
  assert.equal(auth.snapshot().identity, identity());
});

test("retained view cache is bounded and favors recently revisited identities", async () => {
  const auth = new DesktopPageAuthority(async (_owner, source) => [row(source.query)]);
  for (let index = 0; index < 25; index++) {
    auth.bind("desktop", { ...SOURCE, query: String(index) }); await tick();
  }
  auth.request({ ...SOURCE, query: "0" });
  assert.deepEqual(auth.snapshot().rows, [row("0")], "the oldest destination is restored before inserting the departing scope at capacity");
  await tick();
  auth.request({ ...SOURCE, query: "new" }); await tick();
  assert.equal(auth.snapshotFor(identity({ ...SOURCE, query: "0" })).settled, true);
  assert.equal(auth.snapshotFor(identity({ ...SOURCE, query: "1" })).cold, true);
  auth.dispose();
});


test("a cached page anywhere in the revalidated extent keeps stale truth until a fully fresh swap", async () => {
  const { auth, reads } = gated();
  auth.bind("desktop", SOURCE);
  reads[0].resolve({ items: [row("a")], hasMore: true, nextPage: 2 }); await tick();
  const more = auth.loadMore(SOURCE);
  reads[1].resolve({ items: [row("a2")], hasMore: false }); await more;
  auth.revalidate(SOURCE);
  reads[2].resolve({ items: [row("cached")], hasMore: true, nextPage: 2, cached: true }); await tick();
  reads[3].resolve({ items: [row("fresh")], hasMore: false }); await tick();
  assert.equal(auth.snapshot().stale, true);
  auth.revalidate(SOURCE);
  reads[4].resolve({ items: [row("fresh1")], hasMore: true, nextPage: 2 }); await tick();
  reads[5].resolve({ items: [row("fresh2")], hasMore: false }); await tick();
  assert.equal(auth.snapshot().stale, false);
});


test("a fresh append does not claim cached retained base rows are fully fresh", async () => {
  const { auth, reads } = gated();
  auth.bind("desktop", SOURCE);
  reads[0].resolve({ items: [row("cached")], hasMore: true, nextPage: 2, cached: true }); await tick();
  const more = auth.loadMore(SOURCE);
  reads[1].resolve({ items: [row("fresh")], hasMore: false }); await more;
  assert.equal(auth.snapshot().stale, true);
  assert.deepEqual(auth.snapshot().rows, [row("cached"), row("fresh")]);
});
