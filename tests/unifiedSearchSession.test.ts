// Unified search session tests (M2.10 FIX-V1 P1-1):
// ONE request-epoch authority. setQuery invalidates the previous query
// IMMEDIATELY at input-change time (before the debounce fires); responses
// never write the user's draft text; errors settle without desynchronizing
// the epoch; clearing invalidates everything; refresh() never resurrects an
// older active query over a newer draft.
import test from "node:test";
import assert from "node:assert/strict";
import { UnifiedSearchSession } from "../src/services/unifiedSearchSession.ts";

type FetchCall = {
  q: string;
  page: number;
  limit: number;
  resolve: (r: any) => void;
  reject: (e: any) => void;
};

/** Session whose fetches never resolve until the test releases them. */
function controlledSession() {
  const calls: FetchCall[] = [];
  const session = new UnifiedSearchSession(
    (q, page, limit) =>
      new Promise<any>((resolve, reject) => {
        calls.push({ q, page, limit, resolve, reject });
      }),
    0
  );
  return { session, calls };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function result(id: string) {
  return { resultType: "note", id, title: `r-${id}`, snippet: "", kind: "text" };
}
const ids = (s: any) => s.items.map((i: any) => i.id);

test("search — draft A in flight → user types B → late A ignored BEFORE B debounce fires", async () => {
  const { session, calls } = controlledSession();
  session.setQuery("a");
  await flush(); // debounce fires -> request A issued
  assert.equal(calls.length, 1);
  assert.equal(calls[0].q, "a");

  session.setQuery("ab"); // epoch advances immediately — A is stale NOW
  calls[0].resolve({ results: [result("a1")], total: 99, hasMore: false });
  await Promise.resolve(); // A's late success resolves before B's debounce

  let st = session.getState();
  assert.equal(st.query, "ab", "draft stays B — a response never rewrites the input");
  assert.equal(st.items.length, 0, "A rows never commit");
  assert.equal(st.error, "");

  await flush(); // B's debounce fires
  assert.equal(calls.length, 2);
  assert.equal(calls[1].q, "ab");
  calls[1].resolve({ results: [result("b1")], total: 1, hasMore: false });
  await flush();
  st = session.getState();
  assert.deepEqual(ids(st), ["b1"], "B commits normally");
  assert.equal(st.query, "ab");
  assert.equal(st.activeQuery, "ab");
});

test("search — A load-more in flight → user types B → A rows hidden immediately; late A page-N ignored", async () => {
  const { session, calls } = controlledSession();
  session.setQuery("a");
  await flush();
  calls[0].resolve({ results: [result("a1")], total: 120, hasMore: true });
  await flush(); // A page-1 committed (50-cap page but 1 row fixture is fine)

  const lm = session.loadMore(); // request B: page 2 of "a"
  assert.equal(calls.length, 2);
  assert.equal(calls[1].q, "a");
  assert.equal(calls[1].page, 2);

  session.setQuery("b"); // epoch advances — A load-more is stale NOW
  let st = session.getState();
  assert.equal(st.query, "b");
  assert.equal(st.items.length, 0, "A rows not visible/clickable under B (FIX-V1B P1-A)");
  assert.equal(st.total, 0);
  assert.equal(st.hasMore, false);
  assert.equal(st.loading, true, "pending state while B's debounce waits");

  calls[1].resolve({ results: [result("a51")], total: 120, hasMore: true });
  await Promise.resolve(); // late A page-N resolves before B's debounce
  st = session.getState();
  assert.equal(st.items.length, 0, "late A page-N never appended");
  await lm; // the stale load-more settles without error

  await flush(); // B's debounce fires -> fresh page-1
  assert.equal(calls.length, 3);
  assert.equal(calls[2].q, "b");
  assert.equal(calls[2].page, 1);
});

test("search — A active request fails → error shown → typing B succeeds and commits", async () => {
  const { session, calls } = controlledSession();
  session.setQuery("a");
  await flush();
  calls[0].reject(new Error("boom"));
  await flush();

  let st = session.getState();
  assert.ok(st.error.includes("搜索失败"), "current-query error is shown");
  assert.equal(st.loading, false, "settled error state");
  assert.equal(st.items.length, 0);

  session.setQuery("b"); // after an error a new query works normally
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].q, "b");
  calls[1].resolve({ results: [result("b1")], total: 1, hasMore: false });
  await flush();
  st = session.getState();
  assert.deepEqual(ids(st), ["b1"], "B commits — the epoch never drifted apart");
  assert.equal(st.error, "");
});

test("search — stale A error after B draft cannot clear/poison B", async () => {
  const { session, calls } = controlledSession();
  session.setQuery("a");
  await flush();
  session.setQuery("b"); // A invalidated before its error arrives
  calls[0].reject(new Error("boom"));
  await Promise.resolve(); // stale A error resolves before B's debounce

  let st = session.getState();
  assert.equal(st.error, "", "stale A error cannot poison B");
  assert.equal(st.query, "b");
  // B's request is pending (loading is the pending-B flag, not A's error).

  await flush(); // B's debounce fires and commits normally
  assert.equal(calls.length, 2);
  calls[1].resolve({ results: [result("b1")], total: 1, hasMore: false });
  await flush();
  st = session.getState();
  assert.deepEqual(ids(st), ["b1"]);
  assert.equal(st.error, "");
  assert.equal(st.loading, false);
});

test("search — clearing the query clears results/error and invalidates in-flight requests", async () => {
  const { session, calls } = controlledSession();
  session.setQuery("a");
  await flush(); // request A in flight
  session.setQuery(""); // clear

  let st = session.getState();
  assert.equal(st.query, "");
  assert.equal(st.activeQuery, "");
  assert.equal(st.error, "");
  assert.equal(st.items.length, 0);

  calls[0].resolve({ results: [result("a1")], total: 1, hasMore: false });
  await flush();
  st = session.getState();
  assert.equal(st.items.length, 0, "late A ignored after clear");
  assert.equal(calls.length, 1, "no request issued for the cleared query");
});

test("search — local-data refresh never restores an older active query over a newer draft", async () => {
  const { session, calls } = controlledSession();
  session.setQuery("a");
  await flush();
  calls[0].resolve({ results: [result("a1")], total: 1, hasMore: false });
  await flush();
  assert.equal(session.getState().activeQuery, "a");

  session.setQuery("ab"); // newer draft pending (debounce not fired)
  const before = calls.length;
  session.refresh(); // a local mutation lands now — must NOT re-run "a"
  await Promise.resolve();
  assert.equal(calls.length, before, "refresh never resurrects the older active query");

  await flush(); // the pending debounce owns the draft
  assert.equal(calls[before].q, "ab");
  calls[before].resolve({ results: [result("ab1")], total: 1, hasMore: false });
  await flush();

  const c2 = calls.length;
  session.refresh(); // draft === active now -> re-runs the ACTIVE query
  assert.equal(calls.length, c2 + 1, "refresh re-runs the committed active query");
  assert.equal(calls[c2].q, "ab");
});

test("search — state generation stays aligned to the request epoch across error + retry", async () => {
  const { session, calls } = controlledSession();
  session.setQuery("a");
  await flush();
  const epochA = session.getState().generation;
  calls[0].reject(new Error("x"));
  await flush();
  assert.equal(session.getState().generation, epochA, "error settles WITHOUT advancing the epoch");
  // After a retry (new query), the state generation moves exactly with the epoch.
  session.setQuery("a");
  await flush();
  calls[1].resolve({ results: [result("a1")], total: 1, hasMore: false });
  await flush();
  const st = session.getState();
  assert.equal(st.generation, epochA + 1);
  assert.deepEqual(ids(st), ["a1"]);
});

test("search — FIX-V1B P1-A: typed B hides committed A rows immediately; late A cannot reappear; B commits", async () => {
  const { session, calls } = controlledSession();
  // 1. A page-1 committed with visible rows
  session.setQuery("a");
  await flush();
  calls[0].resolve({ results: [result("a1")], total: 120, hasMore: true });
  await flush();
  assert.equal(session.getState().items.length, 1, "A rows committed and visible");

  const lm = session.loadMore(); // A page-2 request still on A's epoch
  assert.equal(calls.length, 2);

  // 2. user types B; 3. BEFORE B's debounce fires, A rows are gone
  session.setQuery("b");
  let st = session.getState();
  assert.equal(st.items.length, 0, "A rows not visible/clickable under B");
  assert.equal(st.total, 0, "A total hidden");
  assert.equal(st.hasMore, false, "A hasMore hidden");
  assert.equal(st.loading, true, "pending/loading state until B is active");
  assert.equal(st.query, "b", "draft B preserved");

  // 4. late A response cannot reappear
  calls[1].resolve({ results: [result("a51")], total: 120, hasMore: true });
  await Promise.resolve();
  await lm;
  st = session.getState();
  assert.equal(st.items.length, 0, "late A response cannot reappear under B");
  assert.equal(st.total, 0);

  // 5. B then commits normally
  await flush();
  assert.equal(calls.length, 3);
  assert.equal(calls[2].q, "b");
  calls[2].resolve({ results: [result("b1")], total: 1, hasMore: false });
  await flush();
  st = session.getState();
  assert.deepEqual(ids(st), ["b1"]);
  assert.equal(st.query, "b");
  assert.equal(st.loading, false);
});

test("search — FIX-V1B P1-B: refresh creates a fresh epoch — old q page-1 in flight becomes stale", async () => {
  const { session, calls } = controlledSession();
  session.setQuery("q");
  await flush(); // old q page-1 in flight (epoch N)
  assert.equal(calls.length, 1);
  session.refresh(); // local-data invalidation -> fresh epoch, new page-1
  assert.equal(calls.length, 2, "refresh re-issues page-1 for the same q");
  assert.equal(session.getState().query, "q", "draft preserved");
  assert.equal(session.getState().activeQuery, "q", "active query preserved");

  calls[1].resolve({ results: [result("q2")], total: 1, hasMore: false });
  await Promise.resolve();
  assert.deepEqual(ids(session.getState()), ["q2"], "refreshed page-1 commits");

  calls[0].resolve({ results: [result("q1")], total: 99, hasMore: true }); // old resolves LATE
  await Promise.resolve();
  const st = session.getState();
  assert.deepEqual(ids(st), ["q2"], "old pre-refresh page-1 ignored");
  assert.equal(st.total, 1, "old total cannot overwrite the refreshed state");
  assert.equal(st.hasMore, false);
});

test("search — FIX-V1B P1-B: old q load-more cannot append after a refresh", async () => {
  const { session, calls } = controlledSession();
  session.setQuery("q");
  await flush();
  calls[0].resolve({ results: [result("q1")], total: 120, hasMore: true });
  await flush(); // page-1 committed
  const lm = session.loadMore(); // old q page-2 in flight
  assert.equal(calls.length, 2);

  session.refresh(); // fresh epoch + fresh page-1
  assert.equal(calls.length, 3);
  calls[2].resolve({ results: [result("q1b")], total: 1, hasMore: false });
  await Promise.resolve();
  assert.deepEqual(ids(session.getState()), ["q1b"], "refreshed page-1 replaces the list");

  calls[1].resolve({ results: [result("q51")], total: 120, hasMore: true }); // old page-2 resolves LATE
  await Promise.resolve();
  await lm;
  const st = session.getState();
  assert.deepEqual(ids(st), ["q1b"], "old page-2 never appended");
  assert.equal(st.total, 1, "old total cannot overwrite");
  assert.equal(st.hasMore, false);
});

test("search — FIX-V1B P1-B: stale pre-refresh error cannot poison refreshed q", async () => {
  const { session, calls } = controlledSession();
  session.setQuery("q");
  await flush(); // old q page-1 in flight
  session.refresh(); // fresh epoch
  calls[0].reject(new Error("boom")); // old request errors AFTER the refresh
  await Promise.resolve();
  let st = session.getState();
  assert.equal(st.error, "", "pre-refresh error cannot poison refreshed q");

  calls[1].resolve({ results: [result("q1")], total: 1, hasMore: false });
  await Promise.resolve();
  st = session.getState();
  assert.deepEqual(ids(st), ["q1"], "refreshed q commits normally");
  assert.equal(st.error, "");
});
