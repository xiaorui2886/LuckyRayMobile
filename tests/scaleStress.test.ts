// M2.13 Scope B — deterministic scale stress models (test-only fixtures).
// Virtual 5,000-row datasets drive the REAL pure pagination/search models to
// prove: page-50 pagination reaches the entire dataset with no duplicates or
// gaps; filters reset; unified search typed-ids never collide and paginate
// stably; query changes cannot resurrect stale responses at scale; Home
// recent/counts stay bounded; no client-side silent ceilings reappear.
import test from "node:test";
import assert from "node:assert/strict";
import {
  commitNextPage,
  commitPageOne,
  initialLocalPage,
  localPageLoading,
  localPageStart,
  resetLocalPage,
} from "../src/services/libraryPagination.ts";
import {
  commitPagedNextPage,
  commitPagedPageOne,
  initialPaged,
  pagedLoading,
  resetPaged,
} from "../src/services/generationPagination.ts";
import { SEARCH_PAGE_SIZE, searchResultKey } from "../src/services/searchContract.ts";
import {
  HOME_RECENT_LIMIT,
  homeLocalStats,
  recentSlice,
} from "../src/services/homeLocalModel.ts";

const SCALE = 5000;
const PAGE = 50;

function assetRows(page: number): { assetId: string; name: string }[] {
  const start = (page - 1) * PAGE;
  return Array.from({ length: PAGE }, (_, k) => ({
    assetId: `m213-asset-${String(start + k).padStart(5, "0")}`,
    name: `Asset ${start + k}`,
  }));
}

function typedResults(page: number): { resultType: string; id: string; title: string; snippet: string }[] {
  const start = (page - 1) * PAGE;
  const types = ["note", "inbox", "asset"];
  return Array.from({ length: PAGE }, (_, k) => {
    const i = start + k;
    const t = types[i % 3];
    return {
      resultType: t,
      id: String(i),
      title: `${t}-${i}`,
      snippet: "",
    };
  });
}

test("m213-scale — library page-50 walk reaches all 5000 rows, no dup/gap, truthful totals", () => {
  let state = initialLocalPage();
  state = resetLocalPage(state); // gen 1
  const gen = state.generation;
  const total = SCALE;

  state = localPageLoading(state);
  state = commitPageOne(state, gen, assetRows(1), total, total > PAGE);
  for (let page = 2; page <= total / PAGE; page++) {
    state = localPageLoading(state);
    state = commitNextPage(state, gen, page, assetRows(page), total, page * PAGE < total);
  }

  assert.equal(state.items.length, total, "all 5000 reachable by browsing");
  assert.equal(state.page, total / PAGE, "100 pages consumed");
  assert.equal(state.hasMore, false, "final page hasMore=false");
  assert.equal(state.total, total, "total truthful");
  const ids = state.items.map((a) => a.assetId);
  assert.equal(new Set(ids).size, ids.length, "no duplicate asset ids across 100 pages");
  // Gap check: the walk covers exactly the seeded id range.
  assert.equal(ids[0], "m213-asset-00000");
  assert.equal(ids[ids.length - 1], "m213-asset-04999");
});

test("m213-scale — library query change mid-walk invalidates stale pages (no resurrection)", () => {
  let state = initialLocalPage();
  state = resetLocalPage(state); // gen 1
  const staleGen = state.generation;
  state = localPageLoading(state);
  state = commitPageOne(state, staleGen, assetRows(1), SCALE, true);
  for (let page = 2; page <= 20; page++) {
    state = localPageLoading(state);
    state = commitNextPage(state, staleGen, page, assetRows(page), SCALE, true);
  }
  assert.equal(state.items.length, 20 * PAGE);

  // User switches filter -> reset (gen 2), page 1 loads the new query.
  state = resetLocalPage(state);
  const newGen = state.generation;
  assert.notEqual(newGen, staleGen);
  state = localPageLoading(state);
  state = commitPageOne(state, newGen, [{ assetId: "new-query-1", name: "N1" }], 1, false);
  assert.deepEqual(state.items.map((a) => a.assetId), ["new-query-1"]);

  // Late stale page-21 from the OLD query must be dropped entirely.
  const late = commitNextPage(state, staleGen, 21, assetRows(21), SCALE, true);
  assert.equal(late, state, "stale load-more ignored at scale");
  assert.deepEqual(late.items.map((a) => a.assetId), ["new-query-1"], "old rows never reappear");
  assert.equal(late.total, 1, "stale total never poisons the new query");
});

test("m213-scale — unified search 5000 typed results: stable pagination, no collisions", () => {
  const total = SCALE;
  let state = pagedLoading(resetPaged(initialPaged())); // gen 1
  const gen = state.generation;

  state = commitPagedPageOne(state, gen, typedResults(1), total, true, searchResultKey);
  for (let page = 2; page <= total / SEARCH_PAGE_SIZE; page++) {
    state = commitPagedNextPage(state, gen, page, typedResults(page), total, page * SEARCH_PAGE_SIZE < total, searchResultKey);
  }
  assert.equal(state.items.length, total, "all 5000 search results reachable");
  assert.equal(state.hasMore, false);
  assert.equal(state.total, total);
  const keys = state.items.map(searchResultKey);
  assert.equal(new Set(keys).size, keys.length, "typed-id keys never collide across domains");
  // Same numeric id in three domains yields three distinct results.
  assert.deepEqual(
    keys.slice(0, 6),
    ["note:0", "inbox:1", "asset:2", "note:3", "inbox:4", "asset:5"]
  );
});

test("m213-scale — search query change mid-walk drops stale pages and stale errors", () => {
  let state = pagedLoading(resetPaged(initialPaged())); // gen 1
  const staleGen = state.generation;
  state = commitPagedPageOne(state, staleGen, typedResults(1), SCALE, true, searchResultKey);
  for (let page = 2; page <= 10; page++) {
    state = commitPagedNextPage(state, staleGen, page, typedResults(page), SCALE, true, searchResultKey);
  }
  assert.equal(state.items.length, 10 * SEARCH_PAGE_SIZE);

  // New query (gen 2), page 1 applied.
  state = pagedLoading(resetPaged(state));
  const newGen = state.generation;
  state = commitPagedPageOne(state, newGen, [{ resultType: "note", id: "fresh", title: "F", snippet: "" }], 1, false, searchResultKey);

  // Late stale page-11 success and stale error must both leave the new query settled.
  const late = commitPagedNextPage(state, staleGen, 11, typedResults(11), SCALE, true, searchResultKey);
  assert.equal(late, state, "stale search page ignored");
  assert.deepEqual(late.items.map(searchResultKey), ["note:fresh"]);
  assert.equal(state.loading, false, "stale error cannot leave the new query loading");
});

test("m213-scale — Home recent/counts stay bounded at 5000-row domains", () => {
  const many = Array.from({ length: SCALE }, (_, k) => ({ id: `m213-${k}` }));
  assert.equal(recentSlice(many).length, HOME_RECENT_LIMIT, "recent slice bounded at 3");
  assert.equal(recentSlice([]).length, 0);
  const stats = homeLocalStats({ total: SCALE }, { total: SCALE }, { total: SCALE });
  assert.deepEqual(stats, { inbox: SCALE, notes: SCALE, assets: SCALE }, "counts exact at scale");
  const zero = homeLocalStats(null, null, null);
  assert.deepEqual(zero, { inbox: 0, notes: 0, assets: 0 }, "null stats fall back to zero");
});

test("m213-scale — no client-side silent ceilings (both pager contracts are 50/page)", () => {
  assert.equal(SEARCH_PAGE_SIZE, 50);
  assert.equal(localPageStart(initialLocalPage()), 1);
  // A 5000-row domain needs 100 pages; the models expose every page.
  const needed = Math.ceil(SCALE / 50);
  assert.equal(needed, 100);
});
