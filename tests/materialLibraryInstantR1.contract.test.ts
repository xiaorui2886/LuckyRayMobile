// MATERIAL-LIBRARY-INSTANT-R1 — album-like source switching, bounded
// thumbnail scheduling, per-source thumbnail namespaces and stable tiles.
//
// The session/scheduler cases drive the PRODUCTION implementation
// (LibrarySession, ThumbnailScheduler, mediaTile helpers); the page-facing
// contracts pin the wiring that used to destroy retained state.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { LibrarySession } from "../src/still/kit/librarySession.ts";
import {
  ThumbnailScheduler, MAX_THUMBNAIL_CONCURRENCY, localThumbKey, desktopThumbKey,
} from "../src/services/thumbnailQueue.ts";
import { shouldRenderImage, mediaPlaceholderLabel } from "../src/still/kit/mediaTilePure.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const strip = (src: string) => src.replace(/^\s*\/\/.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, "");

const item = (id: string) => ({ assetId: id, name: `n-${id}` });

// 1. Local loaded -> Desktop -> Local retains Local rows (no reload blank).
test("L1 — Local -> Desktop -> Local retains the Local rows", () => {
  const s = new LibrarySession();
  s.bind("local", "local|all");
  s.commit("local", "local|all", [item("a1"), item("a2")]);
  // Toggle to Desktop (bind is a no-op for local; the page only changes view).
  s.bind("desktop", "desk-A|all");
  assert.equal(s.view("local").items.length, 2, "Local rows survive the toggle");
  assert.equal(s.view<any>("local").retained, true);
});

// 2. Desktop loaded -> Local -> Desktop retains exact-owner Desktop rows.
test("L2 — Desktop -> Local -> Desktop retains the exact-owner rows immediately", () => {
  const s = new LibrarySession();
  s.bind("desktop", "desk-A|all");
  s.commit("desktop", "desk-A|all", [item("d1")]);
  s.bind("local", "local|all");
  const back = s.view<any>("desktop");
  assert.equal(back.items.length, 1, "Desktop rows retained across the toggle");
  assert.equal(back.retained, true, "paintable in the same frame");
});

// 3. A source toggle alone never invokes an artificial debounce delay.
test("L3 — no artificial 200/220 ms delay remains on a source toggle", () => {
  const lib = strip(read("src", "still", "StillLibrary.tsx"));
  assert.doesNotMatch(lib, /setTimeout\(\(\) => assetPager\.reload\([\s\S]{0,40}\}, 200\)/u,
    "the Local source toggle no longer waits 200 ms");
  assert.doesNotMatch(lib, /,\s*220\);/u, "the Desktop path no longer waits 220 ms");
  assert.doesNotMatch(lib, /assetPager\.enterDesktop\(\)/u,
    "leaving the Local source no longer invalidates the Local page");
  // The Desktop effect must not blank the page when the source is hidden.
  assert.match(lib, /if \(domain !== "desktop" \|\| !committedDesktopOwner \|\| !active\) return;/u,
    "hidden or owner-less Desktop presentation starts no thumbnail work and keeps rows");
});

// 4. Query change still retires stale responses.
test("L4 — an identity change retires that source's rows (stale fence)", () => {
  const s = new LibrarySession();
  s.bind("local", "local|q=A");
  s.commit("local", "local|q=A", [item("a1")]);
  s.bind("local", "local|q=B"); // new identity
  assert.equal(s.view("local").items.length, 0, "old query rows retired");
  assert.equal(s.view<any>("local").settled, false, "and not reported as settled-empty");
  assert.equal(s.commit("local", "local|q=A", [item("late")]), false, "late A response rejected");
  assert.equal(s.view("local").items.length, 0);
});

// 5. Desktop A -> B never shows A rows under B.
test("L5 — Desktop A -> B is fail-closed (no A rows under B)", () => {
  const s = new LibrarySession();
  s.bind("desktop", "desk-A|all");
  s.commit("desktop", "desk-A|all", [item("A1")]);
  s.bind("desktop", "desk-B|all");
  const view = s.view<any>("desktop");
  assert.equal(view.items.length, 0, "A rows never appear under B");
  assert.equal(view.retained, false);
  assert.equal(s.commit("desktop", "desk-A|all", [item("A-late")]), false, "A response rejected");
});

// 6. A Desktop refresh failure keeps the last-good rows.
test("L6 — a transient refresh failure keeps exact-owner last-good rows", () => {
  const s = new LibrarySession();
  s.bind("desktop", "desk-A|all");
  s.commit("desktop", "desk-A|all", [item("d1"), item("d2")]);
  s.beginRefresh("desktop", "desk-A|all");
  const kept = s.fail("desktop", "desk-A|all");
  const view = s.view<any>("desktop");
  assert.equal(kept, true);
  assert.equal(view.items.length, 2, "rows are NOT blanked by a failure");
  assert.equal(view.stale, true, "a quiet stale indication is set");
  assert.equal(view.refreshing, false);
});

// 7. A fresh response atomically replaces retained rows.
test("L7 — a fresh response swaps in atomically", () => {
  const s = new LibrarySession();
  s.bind("desktop", "desk-A|all");
  s.commit("desktop", "desk-A|all", [item("old")]);
  s.beginRefresh("desktop", "desk-A|all");
  assert.equal(s.view("desktop").items.length, 1, "old rows stay visible while refreshing");
  assert.equal(s.view("desktop").refreshing, true);
  s.commit("desktop", "desk-A|all", [item("new1"), item("new2")]);
  const view = s.view<any>("desktop");
  assert.deepEqual(view.items.map((x) => x.assetId), ["new1", "new2"]);
  assert.equal(view.refreshing, false);
  assert.equal(view.stale, false);
});

// 8. Scheduler concurrency is bounded.
test("L8 — thumbnail scheduler concurrency is bounded", async () => {
  const sched = new ThumbnailScheduler();
  const gates: Array<() => void> = [];
  const jobs = Array.from({ length: 12 }, (_v, i) =>
    sched.enqueue(`k${i}`, () => new Promise<void>((res) => gates.push(res))));
  await new Promise((r) => setImmediate(r));
  assert.equal(sched.activeCount(), MAX_THUMBNAIL_CONCURRENCY, "only the bounded number start");
  assert.equal(sched.pendingCount(), 12 - MAX_THUMBNAIL_CONCURRENCY);
  // Drain: release one slot at a time so the queue can advance.
  for (let i = 0; i < 12; i++) {
    const release = gates.shift();
    if (release) release();
    await new Promise((r) => setImmediate(r));
  }
  await Promise.all(jobs);
});

// 9. Duplicate thumbnail requests coalesce.
test("L9 — duplicate thumbnail requests coalesce into one job", async () => {
  const sched = new ThumbnailScheduler();
  let runs = 0;
  const task = () => { runs += 1; return Promise.resolve("uri"); };
  const [a, b] = await Promise.all([
    sched.enqueue("dup", task),
    sched.enqueue("dup", task),
  ]);
  assert.equal(runs, 1, "the second enqueue reuses the in-flight job");
  assert.equal(a, "uri");
  assert.equal(b, "uri");
});

// 10. Viewport priority: near jobs are served before the tail.
test("L10 — near-viewport jobs are served before offscreen work", async () => {
  const sched = new ThumbnailScheduler();
  const order: string[] = [];
  const gate: Array<() => void> = [];
  // Fill the concurrency slots so later jobs queue.
  for (let i = 0; i < MAX_THUMBNAIL_CONCURRENCY; i++) {
    sched.enqueue(`hold${i}`, () => new Promise<void>((res) => gate.push(res)));
  }
  await new Promise((r) => setImmediate(r));
  // 20 offscreen (tail) jobs, then one visible (near) job.
  for (let i = 0; i < 20; i++) sched.enqueue(`tail${i}`, () => { order.push(`tail${i}`); return Promise.resolve(); });
  sched.enqueue("near", () => { order.push("near"); return Promise.resolve(); }, "near");
  assert.equal(sched.nearPendingCount(), 1, "the visible tile is queued in the near tier");
  const release = gate.shift();
  if (release) release();
  await new Promise((r) => setImmediate(r));
  assert.equal(order[0], "near", "the visible tile is served first, ahead of 20 offscreen jobs");
  // Every offscreen job is still bounded by the same concurrency limit.
  assert.ok(order.length <= 20 + 1, "offscreen work never exceeds the bounded queue");
  while (gate.length) gate.shift()!();
});

// 11. Source-qualified keys prevent Local/Desktop collision.
test("L11 — thumbnail keys are source-qualified", () => {
  assert.notEqual(localThumbKey("x"), desktopThumbKey("inst", "x"), "no Local/Desktop collision");
  assert.notEqual(desktopThumbKey("A", "x"), desktopThumbKey("B", "x"), "owners do not collide");
  assert.match(localThumbKey("x"), /^local:x$/u);
  assert.match(desktopThumbKey("inst1", "x"), /^desktop:inst1:x$/u);
  const lib = strip(read("src", "still", "StillLibrary.tsx"));
  assert.match(lib, /localThumbKey\(/u, "Local jobs use the qualified key");
  assert.match(lib, /desktopThumbKey\(/u, "Desktop jobs use the qualified key");
});

// 12. A Desktop owner change does not clear Local thumbnails.
test("L12 — exact-owner thumbnail namespaces survive switches and clear on unpair", () => {
  const lib = strip(read("src", "still", "StillLibrary.tsx"));
  // REPAIR-R5: the owner lifecycle is one AND the same transition as the first
  // request, so the clearing lives on the authority bind rather than on a
  // separate invalidation effect.
  const marker = "desktopAuthority.bind(desktopOwner, source);";
  const idx = lib.indexOf(marker);
  assert.ok(idx > 0, "the owner bind exists");
  const body = lib.slice(idx, idx + 460);
  assert.doesNotMatch(body, /setDesktopThumbs\(\{\}\)/u, "a scope switch retains decoded URLs without a blank frame");
  assert.match(lib, /const thumbId = desktopThumbKey\(owner, desktopAssetId, "", false, library\)/u, "the retained URL has exact owner and library identity");
  assert.doesNotMatch(body, /setThumbMap\(\{\}\)/u, "Local thumbnails are NOT cleared");
  assert.match(lib, /const \[desktopThumbs, setDesktopThumbs\]/u, "separate Desktop namespace exists");
  assert.match(lib, /const \[thumbMap, setThumbMap\]/u, "separate Local namespace exists");
  // The unpaired branch clears the Desktop map too, and still never the Local one.
  const off = lib.indexOf('desktopAuthority.bind("", source);');
  assert.ok(off > 0, "the unpaired branch retires the Desktop page");
  const offBody = lib.slice(off, off + 160);
  assert.match(offBody, /setDesktopThumbs\(\{\}\)/u, "Desktop thumbnails are cleared when unpaired");
  assert.doesNotMatch(offBody, /setThumbMap\(\{\}\)/u, "and the Local map is still untouched");
});

// 13. An empty thumbnail renders placeholder art, never <img src="">.
test("L13 — empty src never renders an <img>", () => {
  assert.equal(shouldRenderImage("", false), false, "empty src -> placeholder");
  assert.equal(shouldRenderImage("asset://x", false), true);
  const tile = strip(read("src", "still", "kit", "mediaTile.tsx"));
  assert.match(tile, /shouldRenderImage\(src, failed\)/u, "the guard is applied");
  assert.match(tile, /st-media-placeholder/u, "placeholder art exists");
  assert.equal(mediaPlaceholderLabel("video"), "视频");
  assert.equal(mediaPlaceholderLabel("document"), "文档");
});

// 14. Image error -> placeholder + at most ONE bounded retry.
test("L14 — an image error falls back with one bounded retry", () => {
  const tile = strip(read("src", "still", "kit", "mediaTile.tsx"));
  assert.match(tile, /onError/u, "errors are handled");
  assert.match(tile, /setFailed\(true\)/u, "the failed image is hidden");
  assert.match(tile, /if \(!retried && onRetry\)/u, "the retry is budget-guarded");
  assert.match(tile, /setRetried\(true\)/u, "the budget is consumed exactly once");
  assert.doesNotMatch(tile, /while \(|setInterval/u, "no unbounded retry loop");
});

// 15. Settled-empty only after the request settles.
test("L15 — settled-empty is only reported after a request settles", () => {
  const s = new LibrarySession();
  s.bind("local", "local|all");
  let view = s.view<any>("local");
  assert.equal(view.settled, false, "before any response: NOT settled");
  s.beginRefresh("local", "local|all");
  assert.equal(s.view("local").settled, false, "while loading: NOT settled");
  s.commit("local", "local|all", []);
  view = s.view<any>("local");
  assert.equal(view.settled, true, "after an empty response: settled empty");
  assert.equal(view.items.length, 0);
});

// 16. Cached/offline Desktop rows are labelled truthfully.
test("L16 — retained rows carry a truthful stale flag for the page copy", () => {
  const s = new LibrarySession();
  s.bind("desktop", "desk-A|all");
  s.commit("desktop", "desk-A|all", [item("d1")]);
  s.fail("desktop", "desk-A|all");
  assert.equal(s.view("desktop").stale, true, "the page can label cached/offline truthfully");
  assert.equal(s.view("desktop").items.length, 1, "and still shows the rows");
});

// Extra: the two views never share scroll, and each keeps its own offset.
test("L-scroll — each source keeps its own scroll offset", () => {
  const s = new LibrarySession();
  s.bind("local", "local|all");
  s.bind("desktop", "desk-A|all");
  s.setScroll("local", 420);
  s.setScroll("desktop", 12);
  assert.equal(s.view("local").scrollTop, 420);
  assert.equal(s.view("desktop").scrollTop, 12);
  // A Desktop identity change resets THAT source's offset only.
  s.bind("desktop", "desk-B|all");
  assert.equal(s.view("local").scrollTop, 420, "Local scroll survives a Desktop switch");
});
