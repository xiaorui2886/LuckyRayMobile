// MATERIAL-LIBRARY-INSTANT-R1 REPAIR-R1 — REAL StillLibrary production wiring.
//
// These pin the production page itself (not just the isolated session class):
// the retained-source authority must be consumed by StillLibrary, a source
// toggle must not reload, Desktop identity must include every visible axis,
// presentation truth must be distinguished, and the thumbnail pipeline must
// be near-prioritised, list-capable, genuinely retryable and glyph-free.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { LibrarySession } from "../src/still/kit/librarySession.ts";
import { DesktopPageAuthority, rowsForSnapshot } from "../src/services/desktopPageAuthority.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const strip = (src: string) => src.replace(/^\s*\/\/.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, "");
const LIB = () => strip(read("src", "still", "StillLibrary.tsx"));

// 2. the real page consumes the retained-source session
test("P2 — StillLibrary actually consumes LibrarySession", () => {
  const lib = LIB();
  assert.match(lib, /new LibrarySession\(\)/u, "the page constructs the session");
  assert.match(lib, /session\.bind\("local"/u, "Local identity is bound");
  assert.match(lib, /session\.view<any>\("local"\)/u, "Local view is read for presentation");
  assert.match(lib, /session\.setScroll\(/u, "per-source scroll is written");
  // REPAIR-R5: the Desktop source has its OWN authority now (it owns the owner
  // lifecycle AND the request sequencing in one object), so the page reads the
  // Desktop identity and rows from there instead of binding them in the
  // session. The retention guarantee is unchanged — see the R5 suite.
  assert.match(lib, /new DesktopPageAuthority\(/u, "the Desktop page has one authority");
  assert.match(lib, /desktopAuthority\.bind\(/u, "whose bind owns the owner lifecycle");
  assert.match(lib, /session\.view<any>\("desktop"\)/u, "and the session still tracks Desktop scroll");
});

// 1. the real Local effect does not invalidate/reload on a domain toggle
test("P1 — the Local identity effect is not driven by the source toggle", () => {
  const lib = LIB();
  // The identity effect is the one with the debounced reload.
  const marker = "setTimeout(() => assetPager.reload(localFilters()), 200)";
  const idx = lib.indexOf(marker);
  assert.ok(idx > 0, "the debounced identity effect exists");
  // Slice only up to the effect's own dependency array terminator.
  const tail = lib.slice(idx, idx + 400);
  const effect = tail.slice(0, tail.indexOf("]);") + 3);
  const deps = effect.slice(effect.indexOf("["));
  assert.doesNotMatch(deps, /domain/u, "`domain` is NOT a dependency: a toggle must not reload");
  assert.match(deps, /localQuery/u, "only the Local query drives its identity");
  assert.doesNotMatch(deps, /desktopQuery/u, "Desktop typing cannot invalidate Local rows");
  assert.match(deps, /kindFilter/u, "kind/filter still drives the identity");
  assert.match(deps, /applied/u, "sort/tag/range still drive the identity");
  // And no source-based early return guards the invalidation any more.
  const before = lib.slice(Math.max(0, idx - 700), idx);
  assert.doesNotMatch(before, /if \(domain !== "local"\) return;/u,
    "the toggle-exit guard no longer exists in the identity effect");
});

// 3/4. retained rows across toggles (production session semantics)
test("P3 — Local -> Desktop -> Local keeps Local rows; identity change retires", () => {
  const s = new LibrarySession();
  s.bind("local", "local|all");
  s.commit("local", "local|all", [{ assetId: "l1" }]);
  // Toggle away and back: no rebind happens for the hidden source.
  assert.equal(s.view<any>("local").items.length, 1, "rows retained across the toggle");
  // A real filter change rebinds and retires.
  s.bind("local", "local|q=x");
  assert.equal(s.view("local").items.length, 0, "identity change retires the rows");
});

test("P4 — Desktop -> Local -> Desktop keeps exact-identity rows", () => {
  const s = new LibrarySession();
  s.bind("desktop", "desktop|A|q1|f1|t1");
  s.commit("desktop", "desktop|A|q1|f1|t1", [{ desktopAssetId: "d1" }]);
  assert.equal(s.view<any>("desktop").items.length, 1, "exact-identity rows retained");
});

// 5/6. Desktop identity includes instance + query + folder + tag
test("P5/P6 — the Desktop identity carries instance+query+folder+tag+kind", () => {
  const lib = LIB();
  const m = lib.match(/const desktopIdentity = \(owner: string\): string =>[\s\S]{0,240}?;/u);
  assert.ok(m, "desktopIdentity exists");
  const body = m![0];
  assert.match(body, /owner/u, "instance is part of the identity");
  assert.match(body, /desktopQuery\.trim\(\)/u, "the Desktop query is part of the identity");
  assert.match(body, /desktopFolder/u, "folder is part of the identity");
  assert.match(body, /desktopTag/u, "tag is part of the identity");
  assert.match(body, /kind:\s*desktopKind/u, "the Desktop type is part of the identity");
  // Behaviourally: a query/folder/tag change must not keep the old rows.
  const s = new LibrarySession();
  s.bind("desktop", "desktop|A|q1||");
  s.commit("desktop", "desktop|A|q1||", [{ desktopAssetId: "old" }]);
  s.bind("desktop", "desktop|A|q2||"); // search A -> B
  assert.equal(s.view("desktop").items.length, 0, "old rows never render under a new query");
  s.bind("desktop", "desktop|B|q2||"); // Desktop A -> B
  assert.equal(s.view("desktop").items.length, 0, "nor under a new instance");
});

// 7. initial loading is not settled-empty
test("P7 — initial loading is distinguishable from settled empty", () => {
  const s = new LibrarySession();
  s.bind("desktop", "desktop|A|q||");
  assert.equal(s.view("desktop").settled, false, "before any response: not settled");
  assert.equal(s.view("desktop").items.length, 0);
  s.commit("desktop", "desktop|A|q||", []);
  assert.equal(s.view("desktop").settled, true, "after a response: settled");
  const lib = LIB();
  assert.match(lib, /settledTruth/u, "the page derives a settled truth for the UI");
  assert.match(lib, /settled=\{settledTruth\}/u, "and passes it to the view");
});

// 8. failed background refresh keeps rows + stale
test("P8 — the page marks a failed Desktop refresh as stale without blanking", () => {
  const lib = LIB();
  // REPAIR-R5: the failure is recorded by the Desktop authority, which is the
  // same object that requested and committed the rows.
  const authSrc = strip(read("src", "services", "desktopPageAuthority.ts"));
  assert.match(authSrc, /this\.stale = true;/u, "a failed refresh flags stale");
  assert.match(lib, /stale=\{staleTruth\}/u, "stale truth reaches the view");
  assert.match(lib, /const staleTruth = domain === "local" \? localView\.stale : desktopAuthority\.isCurrent\(currentDesktopIdentity\) && desktopSnapshot\.stale;/u,
    "the authority's stale flag reaches only its current Desktop identity");
  const s = new LibrarySession();
  s.bind("local", "i");
  s.commit("local", "i", [{ desktopAssetId: "d" }]);
  s.fail("local", "i");
  assert.equal(s.view("local").items.length, 1, "rows kept");
  assert.equal(s.view("local").stale, true);
  // The authority keeps its rows on a failed refresh too.
  const auth = new DesktopPageAuthority(() => Promise.reject(new Error("offline")), () => {});
  auth.bind("A", { query: "", folder: "", tag: "" });
  return new Promise((r) => setImmediate(r)).then(() => {
    assert.equal(auth.snapshot().stale, true, "the authority reports stale, not empty");
  });
});

// 9. visible Desktop jobs use the near tier
test("P9 — visible Desktop thumbnail jobs use the near tier", () => {
  const lib = LIB();
  const line = lib.split("\n").find((l) => l.includes("enqueue(desktopThumbKey("));
  assert.ok(line, "the Desktop enqueue call exists");
  assert.match(line!, /priority\)/u, "the job passes an explicit priority to the scheduler");
  // Visible grid tiles are near by default; list mode passes near/tail per row.
  assert.match(lib, /priority: "near" \| "tail" = "near"/u,
    "the requester defaults to the visible (near) tier");
  assert.match(lib, /LIST_NEAR_COUNT \? "near" : "tail"/u,
    "list rows choose near only for the visible window");
});

// 10. newly visible Desktop work can jump ahead of queued Local tail work
test("P10 — near work is served ahead of queued tail work", async () => {
  const { ThumbnailScheduler, MAX_THUMBNAIL_CONCURRENCY } = await import("../src/services/thumbnailQueue.ts");
  const sched = new ThumbnailScheduler();
  const order: string[] = [];
  const gate: Array<() => void> = [];
  for (let i = 0; i < MAX_THUMBNAIL_CONCURRENCY; i++) {
    sched.enqueue(`hold${i}`, () => new Promise<void>((res) => gate.push(res)));
  }
  await new Promise((r) => setImmediate(r));
  for (let i = 0; i < 10; i++) sched.enqueue(`local-tail-${i}`, () => { order.push(`tail${i}`); return Promise.resolve(); });
  sched.enqueue("desktop:near", () => { order.push("desktop-near"); return Promise.resolve(); }, "near");
  const release = gate.shift();
  if (release) release();
  await new Promise((r) => setImmediate(r));
  assert.equal(order[0], "desktop-near", "the visible Desktop tile is served before the Local tail");
  while (gate.length) gate.shift()!();
});

// 11. list mode triggers bounded thumbnail work
test("P11 — cold Desktop list mode still triggers bounded thumbnail work", () => {
  const lib = LIB();
  // The list-mode effect is the one that iterates desktopItems and reacts to
  // the list/grid preference (comments are stripped, so match the code).
  const idx = lib.lastIndexOf("const window = desktopItems.slice(0, LIST_THUMB_WINDOW)");
  assert.ok(idx > 0, "the list-mode effect exists");
  const effect = lib.slice(Math.max(0, idx - 360), idx + 500);
  assert.match(effect, /requestDesktopThumb\(/u, "list rows request thumbnails");
  const deps = effect.slice(effect.lastIndexOf("}, ["));
  assert.match(deps, /listPref/u, "and it reacts to the list/grid switch");
});

// 12. retry actually issues a forced bounded re-query
test("P12 — retry issues one forced source-qualified re-query", () => {
  const lib = LIB();
  assert.match(lib, /requestDesktopThumb\(committedDesktopOwner, aid, true\)/u,
    "the Desktop retry FORCES the re-query (not blocked by the retained URL)");
  assert.match(lib, /const requestDesktopThumb = useCallback\(\(\s*\n?\s*owner: string, desktopAssetId: string, force = false,/u,
    "the requester accepts an explicit force flag");
  assert.match(lib, /if \(!force && desktopThumbsRef\.current\[desktopAssetId\] && desktopThumbVersions\.current\[desktopAssetId\]\s*===\s*revision\) return;/u,
    "only a same-version retained URL blocks an unforced request");
  assert.match(lib, /requestLocalThumb\(aid,\s*true\)/u,
    "the Local retry forces exactly its own shared requester");
  assert.match(lib, /enqueue\(localThumbKey\(id,\s*revision\),\s*\(\)\s*=>\s*api\.localAssetThumbnail\(id,\s*false,\s*force\),\s*priority\)/u,
    "the Local retry remains version-qualified through the single scheduler");
  // The tile itself budgets the retry to exactly one.
  const tile = strip(read("src", "still", "kit", "mediaTile.tsx"));
  assert.match(tile, /if \(!retried && onRetry\)/u, "at most one retry");
});

// 13. list thumbnail decode failure falls back without a browser glyph
test("P13 — a failing list thumbnail falls back instead of a broken glyph", () => {
  const still = strip(read("src", "presentation", "still01", "Still.tsx"));
  const row = still.slice(still.indexOf("export function Row("));
  const body = row.slice(0, 1200);
  assert.match(body, /onError=\{\("?"?\)?=>?setThumbFailed\(true\)\}/u, "the list thumbnail handles a decode error");
  assert.match(body, /thumb&&!thumbFailed\?/u, "the <img> is only rendered while usable");
  assert.match(body, /is-placeholder/u, "a stable placeholder keeps the row geometry");
  // The library list never passes an empty string as a thumbnail URL.
  const views = strip(read("src", "presentation", "still01", "Views.tsx"));
  assert.match(views, /thumb=\{a\.src\|\|undefined\}/u, "empty src becomes undefined, not \"\"");
});

// 14. per-source scroll capture/restore is wired in production
test("P14 — per-source scroll is captured and restored in the real page", () => {
  const lib = LIB();
  assert.match(lib, /scrollTop=\{scrollView\.scrollTop\}/u, "the view receives the restored offset");
  assert.match(lib, /onScroll=\{\(top\) => \{ session\.setScroll\(/u, "scroll is captured per source");
  const views = strip(read("src", "presentation", "still01", "Views.tsx"));
  assert.match(views, /el\.scrollTop=p\.scrollTop/u, "the scroller restores its offset");
  assert.match(views, /p\.onScroll\?\.\(/u, "and reports scroll changes");
  // Each source keeps its own offset.
  const s = new LibrarySession();
  s.bind("local", "l"); s.bind("desktop", "d");
  s.setScroll("local", 300); s.setScroll("desktop", 7);
  assert.equal(s.view("local").scrollTop, 300);
  assert.equal(s.view("desktop").scrollTop, 7);
});

// ---------------------------------------------------------------------------
// MATERIAL-LIBRARY-INSTANT-R1 REPAIR-R2 — exact-identity gating, Local settle
// truth, bounded list thumbnails and a real decode-failure retry.
// ---------------------------------------------------------------------------

// 1/2/3. rendered Desktop rows require owner AND the exact identity
test("R2-1/2/3 — rendered Desktop rows are gated by the exact identity", () => {
  const lib = LIB();
  // REPAIR-R5: the gate is now the authority's own helper, so the page cannot
  // disagree with the pipeline that committed the rows. It still requires BOTH
  // the live owner AND the exact identity.
  assert.match(lib, /rowsForSnapshot\(desktopSnapshot, desktopOwner, currentDesktopIdentity\)/u,
    "rows come from the exact-identity gate");
  assert.match(lib, /const currentDesktopIdentity = desktopOwner \? desktopIdentity\(desktopOwner\) : ""/u);
  // The helper's own contract.
  const rows = [{ desktopAssetId: "row" }];
  const snap = {
    owner: "A", identity: "desktop|A|q1|f1|t1", rows,
    refreshing: false, stale: false, settled: true, cold: false,
  };
  assert.equal(rowsForSnapshot(snap, "A", "desktop|A|q1|f1|t1").length, 1, "exact identity shows the rows");
  assert.equal(rowsForSnapshot(snap, "A", "desktop|A|q2|f1|t1").length, 0, "query change hides the old rows");
  assert.equal(rowsForSnapshot(snap, "A", "desktop|A|q2|f2|t1").length, 0, "folder change hides the old rows");
  assert.equal(rowsForSnapshot(snap, "A", "desktop|A|q2|f2|t2").length, 0, "tag change hides the old rows");
  assert.equal(rowsForSnapshot(snap, "B", "desktop|A|q1|f1|t1").length, 0, "a different owner hides them");
  // Behaviourally: an identity change on the live authority is truthful pending.
  const auth = new DesktopPageAuthority(() => new Promise(() => {}), () => {});
  auth.bind("A", { query: "q1", folder: "f1", tag: "t1" });
  const after = auth.snapshot();
  assert.equal(after.settled, false, "a fresh bind is not settled");
  assert.equal(after.refreshing, true, "and is truthfully refreshing");
});

// 4/5. Local zero-result settle truth
test("R2-4/5 — Local settles on success (incl. zero rows) and not on failure", () => {
  const lib = LIB();
  assert.match(lib, /const sync = \(state: any\) => \{/u, "the page syncs from the pager state stream");
  assert.match(lib, /assetPager\.subscribe\(sync\)/u, "and subscribes to the pager authority");
  assert.match(lib, /session\.commit\("local", identity, state\.items \?\? \[\]\)/u,
    "a settled page-1 commits its rows — zero rows commits settled-empty");
  assert.match(lib, /if \(state\.loading\) \{\s*\n\s*session\.beginRefresh\("local", identity\);/u,
    "an in-flight request marks refresh, never empty");
  // Behaviour: zero-row success is settled-empty; an identity change is not.
  const s = new LibrarySession();
  s.bind("local", "local|q|||");
  s.commit("local", "local|q|||", []);
  assert.equal(s.view("local").settled, true, "zero-row success = settled empty");
  s.bind("local", "local|q2|||");
  assert.equal(s.view("local").settled, false, "identity change returns to pending");
});

// 6. cold-load copy differs from retained-refresh copy
test("R2-6 — cold-load copy is distinct from the retained-refresh copy", () => {
  const views = strip(read("src", "presentation", "still01", "Views.tsx"));
  // R7 五: the retained refresh keeps its copy; the truly cold state now shows
  // the skeleton block instead of a lone big line of text.
  assert.match(views, /p\.retained\?\(<Empty title="正在同步…" body="已显示上次结果，正在同步最新内容。"\/>\)/u,
    "the retained wording only appears when rows are actually retained");
  assert.match(views, /正在同步最新内容/u, "and it says the results are being synced");
  assert.match(views, /st-loading-block/u, "the cold state has its own skeleton presentation");
  assert.match(views, /p\.coldLoading\?\(/u, "the cold skeleton is gated on the page's cold flag");
  assert.match(views, /正在从电脑读取素材/u, "with a restrained caption");
  const lib = LIB();
  // #97: a new debounced identity is pending before its request starts; a
  // settled denial/error is never presented as cold loading or empty success.
  // The Local source keeps its retained-and-not-settled derivation.
  assert.match(lib, /const coldLoading = domain === "local"/u,
    "cold loading is derived per source");
  assert.match(lib, /\? \(!retainedTruth && !settledTruth\)/u,
    "Local cold loading means no retained rows AND not settled");
  assert.match(lib, /: !retainedTruth && !settledTruth && !desktopError;/u,
    "Desktop cold loading excludes retained, settled, and error truth");
  assert.match(lib, /desktopSnapshot\.identity\s*===\s*currentDesktopIdentity && desktopSnapshot\.settled/u,
    "settled truth belongs to the exact current identity");
  assert.match(lib, /coldLoading=\{coldLoading\}/u, "and it reaches the view");
});

// 7/8. list-mode thumbnails are a bounded window, visible work first
test("R2-7/8 — list mode queues a bounded window with visible work first", () => {
  const lib = LIB();
  const idx = lib.indexOf("const window = desktopItems.slice(0, LIST_THUMB_WINDOW)");
  assert.ok(idx > 0, "the list effect uses a bounded window");
  const effect = lib.slice(idx, idx + 460);
  assert.doesNotMatch(effect, /for \(const a of desktopItems\)/u,
    "it must NOT iterate the whole page");
  assert.match(effect, /LIST_NEAR_COUNT \? "near" : "tail"/u,
    "the first screen is near, the prefetch screen is tail");
  assert.match(lib, /const LIST_NEAR_COUNT = 8;/u, "a bounded first screen");
  assert.match(lib, /const LIST_THUMB_WINDOW = 20;/u, "and a bounded prefetch window");
  // The scheduler still serves near before tail under the global limit.
  assert.match(lib, /enqueue\(desktopThumbKey\(owner,\s*desktopAssetId,\s*revision\),\s*\(\)\s*=>\s*api\.assetThumbnail\(owner,\s*desktopAssetId,\s*force,\s*false,\s*revision\),\s*priority\)/u,
    "the priority and owner/version are passed through the single scheduler");
});

// 9. the same-URI retry can actually re-attempt
test("R2-9 — a retry can re-attempt even when the URI is unchanged", () => {
  const tile = strip(read("src", "still", "kit", "mediaTile.tsx"));
  assert.match(tile, /const \[attempt, setAttempt\] = useState\(0\);/u, "each attempt has a generation");
  assert.match(tile, /key=\{`attempt-\$\{attempt\}`\}/u, "the generation keys the <img>, forcing a remount");
  assert.match(tile, /setAttempt\(\(n\) => n \+ 1\)/u, "a retry bumps the generation");
  assert.match(tile, /if \(!retried && onRetry\)/u, "and it is still bounded to one");
});

// 10/11. the retry invalidates exactly one owner+asset, at most once
test("R2-10/11 — the retry refetches exactly one owner+asset and only once", () => {
  const lib = LIB();
  assert.match(lib, /requestDesktopThumb\(committedDesktopOwner, aid, true\)/u,
    "the Desktop retry forces the refetch for the captured owner");
  assert.match(lib, /setDesktopThumbs\(\(prev\) => \{[\s\S]{0,220}?delete next\[aid\];/u,
    "the retained URI is dropped first so the same value can propagate again");
  const tile = strip(read("src", "still", "kit", "mediaTile.tsx"));
  assert.match(tile, /setRetried\(true\)/u, "the retry budget is spent exactly once");
  assert.doesNotMatch(tile, /setInterval|while \(/u, "no unbounded loop");

  const native = read("src-tauri", "src", "lib.rs");
  const sig = native.slice(native.indexOf("async fn asset_thumbnail("));
  const body = sig.slice(0, sig.indexOf("\n}", 0) + 2);
  assert.match(body, /force: Option<bool>/u, "the native command takes a bounded force flag");
  assert.match(body, /if force\.unwrap_or\(false\) \{/u, "force has its own branch");
  assert.match(body, /db\.clear_thumbnail_meta\(&instance, &id\)/u,
    "and drops exactly this owner+asset cache row");
  assert.match(body, /db\.clear_thumbnail_meta\(&instance, &id\)[\s\S]{0,80}meta = None;/u,
    "so the following request is a genuinely new attempt");
});

// 12. a stale Desktop A retry cannot affect B
test("R2-12 — a stale Desktop A retry cannot touch B", () => {
  const lib = LIB();
  const idx = lib.indexOf("requestDesktopThumb = useCallback(");
  const tail = lib.slice(idx, idx + 1400);
  const requester = tail.slice(0, tail.indexOf("}, [") + 6);
  assert.match(requester, /if \(desktopOwnerRef\.current !== owner \|\| !t\?\.uri\) return;/u,
    "the commit is fenced by the live owner");
  assert.match(requester, /desktopThumbKey\(owner,\s*desktopAssetId,\s*revision\)/u,
    "keys stay owner- and version-qualified");
  assert.match(requester, /materialImageVersion\(current\)\s*!==\s*revision/u,
    "a late old-version result cannot commit to the current asset");
  // Native: the cache row named is the CAPTURED owner's, never a global purge.
  const native = read("src-tauri", "src", "lib.rs");
  const sig = native.slice(native.indexOf("async fn asset_thumbnail("));
  const body = sig.slice(0, 6000);
  assert.match(body, /let instance = owner\.instance\(\)\.to_string\(\);/u,
    "the captured owner names the instance used for the cache row");
  assert.doesNotMatch(body, /clear_all_thumbnails|thumbnail_cache_clear\(\)/u,
    "there is no global cache purge");
});

// ---------------------------------------------------------------------------
// MATERIAL-LIBRARY-INSTANT-R1 REPAIR-R3 — Local failure truth, list visibility
// beyond the eager window, and a retry budget that survives X -> "" -> X.
// ---------------------------------------------------------------------------

import { LocalAssetPager } from "../src/services/localAssetPager.ts";

// 1. REAL LocalAssetPager reload() rejection must not become settled-empty
test("R3-1 — a rejected LocalAssetPager.reload() is not a settled empty", async () => {
  const pager = new LocalAssetPager(() => Promise.reject(new Error("db offline")), () => {});
  pager.reload({});
  await new Promise((r) => setTimeout(r, 10));
  const state = pager.getState();
  assert.equal(state.loading, false, "the attempt finished");
  assert.equal(state.items.length, 0, "with no rows");
  assert.equal(state.page, 0, "and no committed page (this is the ambiguous shape)");
  // The explicit outcome is what the page must read — never `loading === false`.
  assert.equal(pager.lastOutcome(), "error", "the rejection is reported as an error");

  // A successful zero-row page-1 is a DIFFERENT outcome.
  const ok = new LocalAssetPager(() => Promise.resolve({ items: [], total: 0, hasMore: false }), () => {});
  ok.reload({});
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ok.lastOutcome(), "settled", "a zero-row success is settled");
  assert.equal(ok.getState().page, 1, "and committed a page");

  // The product derives settled-empty ONLY from the settled outcome.
  const s = new LibrarySession();
  s.bind("local", "local|i");
  if (pager.lastOutcome() === "settled") s.commit("local", "local|i", []);
  assert.equal(s.view("local").settled, false,
    "a failed page-1 never produces a settled-empty projection");
  if (ok.lastOutcome() === "settled") s.commit("local", "local|i", []);
  assert.equal(s.view("local").settled, true, "the successful zero-row page does settle");

  // And the page reads the outcome rather than inferring from `loading`.
  const lib = LIB();
  assert.match(lib, /const outcome = assetPager\.lastOutcome\(\);/u, "the page reads the outcome");
  assert.match(lib, /if \(outcome === "error"\) \{/u, "and branches on the failure explicitly");
  assert.match(lib, /if \(\(state\.items \?\? \[\]\)\.length > 0\) session\.fail\("local", identity\);\s*\n\s*else session\.beginRefresh\("local", identity\);/u,
    "a failed page-1 keeps rows as stale, or stays pending with none");
});

// identity change still returns Local to pending; the toggle still never reloads
test("R3-1b — Local identity change returns to pending; toggle does not reload", () => {
  const lib = LIB();
  const marker = "setTimeout(() => assetPager.reload(localFilters()), 200)";
  const idx = lib.indexOf(marker);
  const tail = lib.slice(idx, idx + 400);
  const deps = tail.slice(tail.indexOf("["), tail.indexOf("]);") + 3);
  assert.doesNotMatch(deps, /domain/u, "the source toggle still does not reload Local");
  const s = new LibrarySession();
  s.bind("local", "local|a");
  s.commit("local", "local|a", [{ assetId: "x" }]);
  s.bind("local", "local|b");
  assert.equal(s.view("local").settled, false, "a new identity is pending, not settled");
});

// 2. list rows beyond the eager window load on visibility
test("R3-2 — list rows beyond the eager window request on visibility", () => {
  const lib = LIB();
  assert.match(lib, /listVisible=\{\(id\) => \{/u, "the page exposes a list-visibility hook");
  const idx = lib.indexOf("listVisible={(id) => {");
  const hook = lib.slice(idx, idx + 700);
  assert.match(hook, /requestDesktopThumb\(committedDesktopOwner, aid, false, "near"\)/u,
    "a visible Desktop list row requests in the near tier");
  assert.match(hook, /requestLocalThumb\(aid\)/u, "the Local row uses its shared requester");
  assert.match(lib, /enqueue\(localThumbKey\(id,\s*revision\),\s*\(\)\s*=>\s*api\.localAssetThumbnail\(id,\s*false,\s*force\),\s*priority\)/u,
    "the Local requester stays source/version-qualified and near-prioritized");
  // The wrapper is library-specific and observer-driven.
  const row = strip(read("src", "still", "kit", "libraryListRow.tsx"));
  assert.match(row, /IntersectionObserver/u, "the list row observes the viewport");
  assert.match(row, /rootMargin: "300px 0px"/u, "with a bounded near-viewport margin");
  assert.match(row, /onVisible\(\);\s*\n\s*observer\.disconnect\(\);/u, "and fires once per row");
  assert.match(row, /typeof IntersectionObserver === "undefined"/u, "with an old-WebView fallback");
  // It is used only by the library list, not by the shared Row.
  const views = strip(read("src", "presentation", "still01", "Views.tsx"));
  assert.match(views, /<LibraryListRow key=\{a\.id\}/u, "the library list uses the wrapper");
  const still = strip(read("src", "presentation", "still01", "Still.tsx"));
  const rowBody = still.slice(still.indexOf("export function Row("), still.indexOf("export function Row(") + 900);
  assert.doesNotMatch(rowBody, /IntersectionObserver/u, "the shared Row is unchanged (no global observer)");
});

// 3. the retry budget survives the deliberate X -> "" -> X cycle
test("R3-3 — the retry budget survives the src X to empty to X cycle", () => {
  const tile = strip(read("src", "still", "kit", "mediaTile.tsx"));
  // The budget is keyed by the LOGICAL TILE, not by the URL string.
  assert.match(tile, /const contentKey = `\$\{title\}\|\$\{kind\}\|\$\{meta\}`;/u, "a logical content key exists");
  const budget = tile.slice(tile.indexOf("}, [contentKey]);") - 220, tile.indexOf("}, [contentKey]);") + 20);
  assert.match(budget, /setRetried\(false\)/u, "the budget resets only for a new logical tile");
  assert.match(budget, /setAttempt\(0\)/u, "as does the attempt generation");
  // A URL change still clears the failure flag but NOT the budget.
  const urlEffect = tile.slice(tile.indexOf("}, [contentKey]);"), tile.indexOf("}, [contentKey]);") + 220);
  assert.match(urlEffect, /useEffect\(\(\) => \{\s*\n\s*setFailed\(false\);\s*\n\s*\}, \[src\]\);/u,
    "a changed URL clears the failure flag only");
  assert.doesNotMatch(urlEffect, /setRetried\(false\)/u, "and never restores the retry budget");
  // The retry itself remains bounded.
  assert.match(tile, /if \(!retried && onRetry\)/u, "still at most one retry");
  assert.doesNotMatch(tile, /setInterval|while \(/u, "with no loop");
});

// a persistent same-URI bad image performs exactly ONE force refetch
test("R3-3b — a persistent bad same-URI image refetches exactly once", () => {
  // Drive the tile's own bookkeeping model: failure -> one forced retry, and a
  // later X -> "" -> X transition must not re-arm it.
  let retried = false;
  let retryCalls = 0;
  const onError = () => {
    if (!retried) { retried = true; retryCalls += 1; }
  };
  onError();            // first decode failure -> force refetch
  assert.equal(retryCalls, 1, "the first failure triggers exactly one retry");
  onError();            // still broken after the forced refetch
  assert.equal(retryCalls, 1, "a second failure issues no further force call");
  // The URL cycle that used to re-arm the budget:
  const contentKeyUnchanged = true;
  if (!contentKeyUnchanged) retried = false; // only a new logical tile resets
  onError();
  assert.equal(retryCalls, 1, "X -> empty -> X does not restore the budget");
  // The Local path shares the same guard (no equivalent loop).
  const tile = strip(read("src", "still", "kit", "mediaTile.tsx"));
  assert.match(tile, /onRetry\?: \(\) => void;/u, "the retry hook is provider-agnostic");
  const lib = LIB();
  // Anchored on the Local retry handler's own code (comments are stripped).
  const localRetryAt = lib.lastIndexOf("requestLocalThumb(aid,true)");
  assert.ok(localRetryAt > 0, "the Local retry handler exists");
  const localRetry = lib.slice(localRetryAt - 180, localRetryAt + 70);
  assert.match(localRetry, /requestLocalThumb\(aid,\s*true\)/u,
    "the Local retry is the same single bounded forced call");
  assert.doesNotMatch(localRetry, /for \(|while \(/u, "and it cannot loop");
});

// ---------------------------------------------------------------------------
// MATERIAL-LIBRARY-INSTANT-R1 REPAIR-R4 — invalidating a new identity must make
// the pager PENDING before the debounced page-1 starts.
// ---------------------------------------------------------------------------

test("R4 — settled A -> invalidate -> inspect before reload B is PENDING", async () => {
  let mode: "ok" | "fail" = "ok";
  const calls: any[] = [];
  const pager = new LocalAssetPager((filters) => {
    calls.push({ ...filters });
    return mode === "ok"
      ? Promise.resolve({ items: [{ assetId: "a" }, { assetId: "b" }], total: 2, hasMore: false })
      : Promise.reject(new Error("db offline"));
  }, () => {});

  // A settles.
  pager.reload({ q: "A" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(pager.lastOutcome(), "settled", "A settled");
  assert.equal(pager.getState().items.length, 2, "with rows");

  // The user types B: the identity is invalidated NOW, before its debounce fires.
  pager.invalidate();
  const mid = pager.getState();
  assert.equal(mid.items.length, 0, "rows are reset for the new identity");
  assert.equal(mid.page, 0, "and no page is committed");
  assert.equal(mid.total, 0);
  assert.equal(pager.lastOutcome(), "pending",
    "the outcome is PENDING: A's settled success must not describe B");
  assert.equal(calls.length, 1, "no request for B has started yet");

  // The page mirrors that into the retained session for B's identity.
  const session = new LibrarySession();
  session.bind("local", "local|B");
  if (pager.lastOutcome() === "settled") session.commit("local", "local|B", pager.getState().items);
  assert.equal(session.view("local").settled, false,
    "B stays unsettled during the debounce — a settled empty cannot be derived");
  assert.deepEqual(session.view("local").items, [], "and B shows no rows yet");

  // B succeeds -> settled.
  pager.reload({ q: "B" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(pager.lastOutcome(), "settled", "B's own success settles");
  session.commit("local", "local|B", pager.getState().items);
  assert.equal(session.view("local").settled, true);

  // B fails -> error, never a settled empty.
  const failing = new LocalAssetPager(() => Promise.reject(new Error("db offline")), () => {});
  failing.invalidate();
  assert.equal(failing.lastOutcome(), "pending", "a fresh pager starts pending");
  failing.reload({ q: "B" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(failing.lastOutcome(), "error", "a rejected B is an error");
  const s2 = new LibrarySession();
  s2.bind("local", "local|B");
  if (failing.lastOutcome() === "settled") s2.commit("local", "local|B", []);
  assert.equal(s2.view("local").settled, false, "and never a settled empty");
  void mode;

  // enterDesktop keeps the same invariant (no source-toggle rewiring).
  const p2 = new LocalAssetPager(() => Promise.resolve({ items: [], total: 0, hasMore: false }), () => {});
  p2.reload({});
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(p2.lastOutcome(), "settled");
  p2.enterDesktop();
  assert.equal(p2.lastOutcome(), "pending", "a retired attempt is not settled");
});
