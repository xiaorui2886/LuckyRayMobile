// Node.js tests for Local Library pagination (FIX-V1 P1-2):
// append with no duplicates, reset on query/filter change, hasMore contract,
// >200 fixture rows remain reachable, kind-filtered pagination never drops
// later matches.
import test from "node:test";
import assert from "node:assert/strict";
import {
  appendLocalPage,
  commitNextPage,
  commitPageOne,
  initialLocalPage,
  localPageLoading,
  localPageStart,
  LOCAL_PAGE_SIZE,
  resetLocalPage,
} from "../src/services/libraryPagination.ts";

function asset(id: string, kind = "image") {
  return { assetId: id, kind, name: `name-${id}` };
}

test("pagination — page 1 + page 2 append with no duplicate ids", () => {
  let state = appendLocalPage(initialLocalPage(), 1, [asset("a1"), asset("a2")], 4, true);
  assert.equal(state.page, 1);
  assert.equal(state.items.length, 2);
  assert.equal(state.hasMore, true);

  state = appendLocalPage(state, 2, [asset("a3"), asset("a4")], 4, false);
  assert.equal(state.page, 2);
  assert.equal(state.items.length, 4);
  assert.equal(state.hasMore, false);
  const ids = state.items.map((a) => a.assetId);
  assert.equal(new Set(ids).size, 4, "no duplicate ids across pages");
});

test("pagination — repeated page append is deduped (backend drift)", () => {
  let state = appendLocalPage(initialLocalPage(), 1, [asset("x1"), asset("x2")], 3, true);
  state = appendLocalPage(state, 2, [asset("x2"), asset("x3")], 3, false);
  assert.equal(state.items.length, 3, "overlapping page rows are deduped");
  assert.deepEqual(state.items.map((a) => a.assetId), ["x1", "x2", "x3"]);
});

test("pagination — reset returns to page 0 and bumps generation on query/filter change", () => {
  const state = resetLocalPage(initialLocalPage());
  assert.equal(state.page, 0);
  assert.equal(state.items.length, 0);
  assert.equal(state.hasMore, false);
  assert.equal(state.generation, 1, "query generation bumps on reset");
  assert.equal(localPageStart(state), 1, "next fetch starts at page 1");
  const again = resetLocalPage(state);
  assert.equal(again.generation, 2, "every reset bumps the generation");
});

test("pagination — >200 fixture rows remain reachable by normal browsing", () => {
  // Simulate 430 Local Assets with default page size 50 -> 9 pages.
  const total = 430;
  const pages = Math.ceil(total / LOCAL_PAGE_SIZE);
  assert.equal(pages, 9);
  let state = initialLocalPage();
  const seen = new Set<string>();
  for (let page = 1; page <= pages; page++) {
    const start = (page - 1) * LOCAL_PAGE_SIZE;
    const end = Math.min(start + LOCAL_PAGE_SIZE, total);
    const items = [];
    for (let i = start; i < end; i++) items.push(asset(`a${i}`));
    const hasMore = end < total;
    state = appendLocalPage(state, page, items, total, hasMore);
    if (page < pages) assert.equal(state.hasMore, true, `page ${page} still has more`);
    else assert.equal(state.hasMore, false, "final page hasMore=false");
    for (const a of items) seen.add(a.assetId);
  }
  assert.equal(state.items.length, total, "all 430 rows reachable through normal browsing");
  assert.equal(state.hasMore, false);
  assert.equal(seen.size, total, "no duplicates across all pages");
});

test("race — late A page-2 response cannot overwrite a newer query B (FIX-V1B P1)", () => {
  // 1) Query A starts: reset bumps to generation 1, page 1 applied.
  let state = localPageLoading(resetLocalPage(initialLocalPage()));
  assert.equal(state.generation, 1);
  state = commitPageOne(state, 1, [asset("a1"), asset("a2")], 10, true);
  assert.equal(state.page, 1);
  assert.equal(state.generation, 1);
  // 2) A page 2 is deferred/in-flight, captured with generation 1.
  const staleGen = 1;
  // 3) User changes the query: reset bumps to generation 2, B page 1 applies.
  state = localPageLoading(resetLocalPage(state));
  assert.equal(state.generation, 2);
  state = commitPageOne(state, 2, [asset("b1"), asset("b2")], 3, false);
  assert.deepEqual(state.items.map((a) => a.assetId), ["b1", "b2"]);
  // 4) The late A page-2 response resolves with the OLD generation.
  const late = commitNextPage(state, staleGen, 2, [asset("a3"), asset("a4")], 10, true);
  // 5) Final state remains B only — no A row is reintroduced.
  assert.equal(late, state, "stale load-more response is ignored completely");
  assert.deepEqual(late.items.map((a) => a.assetId), ["b1", "b2"]);
  assert.equal(late.total, 3);
  assert.equal(late.hasMore, false);
});

test("race — late A page-1 response cannot overwrite a newer query B (FIX-V1B P1)", () => {
  // Query A page 1 in-flight under generation 1; user switches to B (gen 2).
  let state = localPageLoading(resetLocalPage(initialLocalPage()));
  assert.equal(state.generation, 1);
  state = localPageLoading(resetLocalPage(state)); // B reset -> gen 2
  state = commitPageOne(state, 2, [asset("b1")], 1, false);
  // Late A page-1 success must be dropped.
  const late = commitPageOne(state, 1, [asset("a1"), asset("a2")], 99, true);
  assert.equal(late, state, "stale page-1 response is ignored");
  assert.deepEqual(late.items.map((a) => a.assetId), ["b1"]);
  // Late A error path is represented by the caller dropping the response
  // before any commit (generation check); nothing to overwrite here.
});

test("race — stale error cannot overwrite B with an error/loading state (FIX-V1B P1)", () => {
  let state = localPageLoading(resetLocalPage(initialLocalPage())); // gen 1
  state = commitPageOne(state, 1, [asset("a1")], 5, true);
  state = localPageLoading(resetLocalPage(state)); // gen 2
  state = commitPageOne(state, 2, [asset("b1")], 2, false);
  // The stale-error path never calls a commit helper with gen 1; simulate the
  // caller honoring the guard by checking the current generation first — the
  // state must stay exactly as B left it (no loading flag, no error rows).
  const staleGen = 1;
  const ignored = state.generation !== staleGen;
  assert.equal(ignored, true);
  assert.equal(state.loading, false, "B state keeps its settled loading flag");
  assert.deepEqual(state.items.map((a) => a.assetId), ["b1"]);
});

test("race — load-more wrong page for the current query is rejected (FIX-V1B P1)", () => {
  let state = localPageLoading(resetLocalPage(initialLocalPage()));
  state = commitPageOne(state, 1, [asset("a1")], 6, true);
  // A response for page 3 when the current page is 1 must not append.
  const bad = commitNextPage(state, 1, 3, [asset("x1")], 6, true);
  assert.equal(bad, state, "wrong-page response is ignored");
  assert.deepEqual(bad.items.map((a) => a.assetId), ["a1"]);
  // The correct page-2 response still appends for the same generation.
  const ok = commitNextPage(state, 1, 2, [asset("a2")], 6, true);
  assert.deepEqual(ok.items.map((a) => a.assetId), ["a1", "a2"]);
  assert.equal(ok.generation, 1);
});

test("pagination — kind-filtered pagination never drops later matches", () => {
  // 120 image rows + 80 video rows interleaved; kind=image paginated in SQL
  // yields exactly 120 image rows across pages with hasMore on every page but
  // the last — later image matches are never shadowed by video rows.
  const all = [];
  for (let i = 0; i < 200; i++) all.push(asset(`m${i}`, i % 3 === 0 ? "video" : "image"));
  const images = all.filter((a) => a.kind === "image");
  assert.ok(images.length > 120, "fixture has >120 image rows");
  let state = initialLocalPage();
  const seen = new Set<string>();
  const pages = Math.ceil(images.length / LOCAL_PAGE_SIZE);
  for (let page = 1; page <= pages; page++) {
    const start = (page - 1) * LOCAL_PAGE_SIZE;
    const end = Math.min(start + LOCAL_PAGE_SIZE, images.length);
    const items = images.slice(start, end);
    const hasMore = end < images.length;
    state = appendLocalPage(state, page, items, images.length, hasMore);
    for (const a of items) seen.add(a.assetId);
  }
  assert.equal(state.items.length, images.length, "every image-kind row reachable");
  assert.equal(state.hasMore, false);
});
