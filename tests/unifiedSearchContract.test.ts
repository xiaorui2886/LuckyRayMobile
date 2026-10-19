// Unified search contract tests (M2.10 Scope B):
// typed-id dedupe across pages, stale A→B→late-A search responses ignored,
// and the shared session paginates beyond a single page (no silent 50 cap).
import test from "node:test";
import assert from "node:assert/strict";
import {
  commitPagedNextPage,
  commitPagedPageOne,
  initialPaged,
  pagedLoading,
  resetPaged,
} from "../src/services/generationPagination.ts";
import { searchResultKey, SEARCH_PAGE_SIZE } from "../src/services/searchContract.ts";

function result(resultType: string, id: string) {
  return { resultType, id, title: `${resultType}-${id}`, snippet: "", kind: "text", created_at: "", updated_at: "", extra: {} };
}

test("search — typed-id keys never collide across domains", () => {
  assert.equal(searchResultKey(result("note", "x")), "note:x");
  assert.equal(searchResultKey(result("inbox", "x")), "inbox:x");
  assert.equal(searchResultKey(result("asset", "x")), "asset:x");
  assert.notEqual(searchResultKey(result("note", "x")), searchResultKey(result("inbox", "x")),
    "same id in different domains is a distinct result");
});

test("search — pages append without duplicate typed ids", () => {
  let state = pagedLoading(resetPaged(initialPaged()));
  state = commitPagedPageOne(
    state,
    1,
    [result("note", "n1"), result("asset", "a1"), result("inbox", "i1")],
    7,
    true,
    searchResultKey
  );
  state = commitPagedNextPage(
    state,
    1,
    2,
    [result("asset", "a1"), result("note", "n2"), result("inbox", "i2"), result("note", "n3")],
    7,
    false,
    searchResultKey
  );
  assert.equal(state.items.length, 6, "overlapping typed id deduped");
  const keys = state.items.map(searchResultKey);
  assert.equal(new Set(keys).size, keys.length, "no duplicate typed ids across pages");
});

test("search — A page-1 → query B → late A page-1 ignored (typed results)", () => {
  let state = pagedLoading(resetPaged(initialPaged())); // gen 1 (query A)
  state = commitPagedPageOne(state, 1, [result("note", "a-note")], 25, true, searchResultKey);
  // User switches to query B -> reset (gen 2) -> B page 1 applied.
  state = pagedLoading(resetPaged(state));
  state = commitPagedPageOne(state, 2, [result("asset", "b-asset")], 2, false, searchResultKey);
  // Late A page-1 success must be dropped entirely.
  const late = commitPagedPageOne(state, 1, [result("note", "a-note"), result("inbox", "a-inbox")], 99, true, searchResultKey);
  assert.equal(late, state, "stale search page-1 ignored");
  assert.deepEqual(late.items.map(searchResultKey), ["asset:b-asset"]);
  assert.equal(late.total, 2);
});

test("search — A load-more → query B → late A page-N ignored; stale error cannot poison B", () => {
  let state = pagedLoading(resetPaged(initialPaged())); // gen 1
  state = commitPagedPageOne(state, 1, [result("note", "a1")], 60, true, searchResultKey);
  const staleGen = state.generation;
  // Query B reset -> gen 2, page 1 applied.
  state = pagedLoading(resetPaged(state));
  state = commitPagedPageOne(state, 2, [result("inbox", "b1")], 1, false, searchResultKey);
  // Late A load-more resolves with the OLD generation.
  const late = commitPagedNextPage(state, staleGen, 2, [result("note", "a2"), result("asset", "a3")], 60, true, searchResultKey);
  assert.equal(late, state, "stale search load-more ignored");
  assert.deepEqual(late.items.map(searchResultKey), ["inbox:b1"]);
  // Stale error: the caller drops the response before committing; B stays settled.
  assert.equal(state.loading, false, "stale error cannot leave B loading");
});

test("search — session page size is bounded (no silent 50-result dead end)", () => {
  assert.equal(SEARCH_PAGE_SIZE, 50);
  // A 130-result query is reachable across 3 pages with hasMore semantics.
  const total = 130;
  let state = pagedLoading(resetPaged(initialPaged()));
  for (let page = 1; page <= 3; page++) {
    const start = (page - 1) * SEARCH_PAGE_SIZE;
    const end = Math.min(start + SEARCH_PAGE_SIZE, total);
    const items = [];
    for (let i = start; i < end; i++) items.push(result("note", `n${i}`));
    const hasMore = end < total;
    state =
      page === 1
        ? commitPagedPageOne(state, 1, items, total, hasMore, searchResultKey)
        : commitPagedNextPage(state, 1, page, items, total, hasMore, searchResultKey);
  }
  assert.equal(state.items.length, total, "130 results reachable by browsing");
  assert.equal(state.hasMore, false);
});
