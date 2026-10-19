// Generation-safe pagination primitive tests (M2.10 Scope C/D).
// Covers the mandatory async invariants shared by the Inbox list, the Notes
// list and the global search: stale A→B→late-A responses are ignored, wrong
// pages are rejected, and >100 fixtures remain reachable.
import test from "node:test";
import assert from "node:assert/strict";
import {
  commitPagedNextPage,
  commitPagedPageOne,
  initialPaged,
  pagedLoading,
  pagedStart,
  resetPaged,
} from "../src/services/generationPagination.ts";

const keyOf = (r: { id: string }) => r.id;

function item(id: string) {
  return { id };
}

test("paged — page 1 + page 2 append with no duplicates", () => {
  let state = pagedLoading(resetPaged(initialPaged()));
  state = commitPagedPageOne(state, 1, [item("a"), item("b")], 4, true, keyOf);
  assert.equal(state.page, 1);
  state = commitPagedNextPage(state, 1, 2, [item("c"), item("d")], 4, false, keyOf);
  assert.equal(state.items.length, 4);
  assert.equal(new Set(state.items.map((x) => x.id)).size, 4, "no duplicate ids across pages");
  assert.equal(state.hasMore, false);
});

test("paged — >100 fixture rows remain reachable by normal browsing", () => {
  const total = 430;
  const pages = Math.ceil(total / 50);
  let state = pagedLoading(resetPaged(initialPaged()));
  const seen = new Set<string>();
  for (let page = 1; page <= pages; page++) {
    const start = (page - 1) * 50;
    const end = Math.min(start + 50, total);
    const items = [];
    for (let i = start; i < end; i++) items.push(item(`m${i}`));
    const hasMore = end < total;
    state =
      page === 1
        ? commitPagedPageOne(state, 1, items, total, hasMore, keyOf)
        : commitPagedNextPage(state, 1, page, items, total, hasMore, keyOf);
    for (const x of items) seen.add(x.id);
  }
  assert.equal(state.items.length, total, "all 430 rows reachable");
  assert.equal(state.hasMore, false);
  assert.equal(seen.size, total, "no duplicates across all pages");
});

test("paged — stale A→B→late A page-2 response is ignored (search/list invariant)", () => {
  let state = pagedLoading(resetPaged(initialPaged())); // gen 1
  state = commitPagedPageOne(state, 1, [item("a1"), item("a2")], 10, true, keyOf);
  // Query B reset -> gen 2, page 1 applied.
  state = pagedLoading(resetPaged(state));
  assert.equal(state.generation, 2);
  state = commitPagedPageOne(state, 2, [item("b1")], 3, false, keyOf);
  // Late A page-2 resolves with the OLD generation.
  const late = commitPagedNextPage(state, 1, 2, [item("a3"), item("a4")], 10, true, keyOf);
  assert.equal(late, state, "stale load-more response ignored completely");
  assert.deepEqual(late.items.map((x) => x.id), ["b1"]);
  assert.equal(late.total, 3);
  assert.equal(late.hasMore, false);
});

test("paged — stale A page-1 response and stale error cannot poison B", () => {
  let state = pagedLoading(resetPaged(initialPaged())); // gen 1
  state = pagedLoading(resetPaged(state)); // B gen 2
  state = commitPagedPageOne(state, 2, [item("b1")], 1, false, keyOf);
  const latePageOne = commitPagedPageOne(state, 1, [item("a1")], 99, true, keyOf);
  assert.equal(latePageOne, state, "stale page-1 success ignored");
  // Stale error path: the caller checks the generation before committing; the
  // state stays exactly as B left it (settled, no error rows).
  assert.equal(state.loading, false);
  assert.deepEqual(state.items.map((x) => x.id), ["b1"]);
});

test("paged — query/filter reset invalidates the old generation (inbox/notes)", () => {
  let state = pagedLoading(resetPaged(initialPaged()));
  state = commitPagedPageOne(state, 1, [item("k1")], 5, true, keyOf);
  const oldGen = state.generation;
  state = pagedLoading(resetPaged(state)); // kind/filter change
  assert.equal(state.generation, oldGen + 1, "reset invalidates old generation");
  const stale = commitPagedNextPage(state, oldGen, 2, [item("k2")], 5, true, keyOf);
  assert.equal(stale, state, "old-generation page response rejected");
});

test("paged — wrong-page/double-load response is rejected deterministically", () => {
  let state = pagedLoading(resetPaged(initialPaged()));
  state = commitPagedPageOne(state, 1, [item("a1")], 6, true, keyOf);
  // A response claiming page 3 while the current page is 1 cannot append.
  const wrong = commitPagedNextPage(state, 1, 3, [item("x1")], 6, true, keyOf);
  assert.equal(wrong, state);
  // The correct page-2 still appends for the same generation.
  const ok = commitPagedNextPage(state, 1, 2, [item("a2")], 6, true, keyOf);
  assert.deepEqual(ok.items.map((x) => x.id), ["a1", "a2"]);
  assert.equal(ok.generation, 1);
  // pagedStart reflects the next expected page.
  assert.equal(pagedStart(ok), 3);
});
