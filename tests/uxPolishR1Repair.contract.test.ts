// REPAIR-R1 (#78) — narrow corrections on top of UX-POLISH-R1.
// Run: node --experimental-strip-types --test tests/uxPolishR1Repair.contract.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NavigationController } from "../src/navigation.ts";
import { LocalAssetPager } from "../src/services/localAssetPager.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const LIBRARY = read("src", "still", "StillLibrary.tsx");
const VIEWS = read("src", "presentation", "still01", "Views.tsx");
const STILL = read("src", "presentation", "still01", "Still.tsx");
const CSS = read("src", "presentation", "still01", "still.css");
const AGENT = read("src", "still", "StillAgent.tsx");
const PAGER = read("src", "services", "localAssetPager.ts");
const SHELL = read("src", "still", "StillShell.tsx");

// ---------------------------------------------------------------------------
// A. the standalone Select row is gone; the entry lives in the tool row
// ---------------------------------------------------------------------------

test("repair-A — the standalone 选择素材 row is fully removed", () => {
  assert.doesNotMatch(LIBRARY, /st-select-entry/, "no standalone entry row in the host");
  assert.doesNotMatch(CSS, /\.st-select-entry/, "its CSS is deleted");
  // (justify-content:flex-end is a shared rule used by .st-header-side.end and
  // the sheet footer; the point is that no SELECT-ENTRY rule survives.)
  assert.doesNotMatch(CSS, /\.st-select-entry/, "the dead class rule is gone");
  assert.doesNotMatch(CSS, /st-select-entry/, "the class name appears nowhere in the sheet");
  // No visible-text select button anywhere.
  assert.doesNotMatch(LIBRARY, />选择素材</, "no visible-text select button in the host");
  assert.doesNotMatch(VIEWS, />选择素材</, "no visible-text select button in the view");
});

test("repair-A/R5 — the toolbar carries NO permanent select entry; long press owns it", () => {
  // REPAIR-R5 supersedes the earlier icon-only-entry decision: the task card
  // requires the permanent 选择素材 button to be removed entirely, with
  // multi-select entered by a long press instead. The row itself must not
  // regress, and must not leave a dead control behind.
  const rowStart = VIEWS.indexOf('className="st-compact-toolbar"');
  const filterAt = VIEWS.indexOf('label="筛选与排序"', rowStart);
  const toolbar = VIEWS.slice(rowStart, VIEWS.indexOf("</div>", filterAt) + 6);
  assert.match(toolbar, /切换网格|切换列表/, "the view switch is still in the row");
  assert.match(toolbar, /label="筛选与排序"/, "filter is still in the row");
  assert.doesNotMatch(toolbar, /icon="select"/, "the select action is GONE from the row");
  assert.doesNotMatch(toolbar, /选择素材/, "and no text entry replaces it");
  assert.doesNotMatch(toolbar, /p\.select/, "no dead prop is read for it");
  const order = ["切换网格", 'label="筛选与排序"'];
  const positions = order.map((t) => toolbar.indexOf(t));
  assert.ok(positions[0] >= 0 && positions[0] < positions[1], "grid/list -> filter, unchanged order");
  // The capability is not lost: the long press is the entry, and it is wired on
  // BOTH the grid tile and the list row.
  assert.match(VIEWS, /onLongPress=\{p\.onLongPress/, "the view exposes a long-press entry");
  assert.match(VIEWS, /selecting=\{p\.selecting\}/, "and the selection mode reaches both layouts");
});

test("repair-A — a dedicated multi-select glyph exists in the Still vocabulary", () => {
  assert.match(STILL, / select:</, "the select icon is declared");
  const decl = STILL.slice(STILL.indexOf(" select:"), STILL.indexOf(" select:") + 260);
  assert.match(decl, /<rect/, "same rounded line-icon language");
  assert.match(decl, /<path/, "composed of path primitives");
  assert.doesNotMatch(decl, /fill="(?!none)/, "no filled glyph override");
});

test("repair-A — selection authority and reset behavior are unchanged", () => {
  // REPAIR-R5: the entry moved from a button to a long press, but there is
  // still exactly ONE place that can enter selection, and it starts clean.
  const entries = LIBRARY.match(/setSelecting\(true\)/gu) ?? [];
  assert.equal(entries.length, 1, "still exactly ONE explicit entry");
  // R7c: entry anchors the range — baseline ∪ [anchor].
  assert.match(LIBRARY, /setSelecting\(true\);\s*\n\s*setSelectedIds\(\(prev\) => selectionWithRange\(\{ anchorIndex: idx, baseline: prev \}, idx, orderedDesktopIds\)\);/,
    "the entry anchors the held asset");
  assert.match(LIBRARY, /onCancel: \(\) => \{ setSelecting\(false\); setSelectedIds\(\[\]\); \}/, "Cancel clears it");
  assert.match(LIBRARY, /if \(domain !== "desktop"\) \{ setSelecting\(false\); setSelectedIds\(\[\]\); \}/);
  assert.match(LIBRARY, /const \[selecting, setSelecting\] = useState\(false\);/);
  assert.doesNotMatch(LIBRARY, /rememberedSelecting/);
  // Wave A batch capability intact.
  assert.match(LIBRARY, /async function runBatch/);
  assert.match(LIBRARY, /org\.batch\(/);
});

// ---------------------------------------------------------------------------
// B. Home connection status typography
// ---------------------------------------------------------------------------

test("repair-B — the connection row reads as secondary status, tap target intact", () => {
  const rule = CSS.slice(CSS.indexOf(".st-connection{"), CSS.indexOf("}", CSS.indexOf(".st-connection{")) + 1);
  assert.match(rule, /font-size:10px/, "reduced to 10px");
  assert.match(rule, /line-height:15px/, "compact explicit line-height");
  assert.match(rule, /min-height:44px/, "hit target NOT reduced");
  assert.match(rule, /align-items:center/, "dot and chevron stay vertically centred");
  assert.match(CSS, /\.st-connection-text\{[^}]*font-size:10px/, "the text span carries the size");
  // No global font change.
  assert.match(CSS, /\.st-app\{[^}]*font-size:14px/, "the app body font is untouched");
  // Still a single whole-row tap target.
  assert.match(VIEWS, /<button type="button" className=\{'st-connection'/);
});

// ---------------------------------------------------------------------------
// C. P1-AI1 — one structured LightSeek section for EVERY canUseLsh state
// ---------------------------------------------------------------------------

test("repair-C — the LSH section is no longer gated on !canUseRuns", () => {
  assert.doesNotMatch(AGENT, /canUseLsh && !canUseRuns\)\s*\{[\s\S]{0,80}?return \(/u,
    "the panel branch is not the only LSH presentation");
  assert.match(AGENT, /const lshSection = \(/, "ONE reusable section");
  // Both branch conditions reference the SAME section.
  const uses = AGENT.match(/\{lshSection\}/gu) ?? [];
  assert.equal(uses.length, 2, "the same section serves both capability combinations");
});

test("repair-C — matrix: LSH true + Runs true renders Runs BELOW the LSH section", () => {
  const both = AGENT.slice(
    AGENT.indexOf("if (snap.canUseLsh && snap.canUseRuns)"),
    AGENT.indexOf("return (\n    <>\n", AGENT.indexOf("if (snap.canUseLsh && snap.canUseRuns)")),
  );
  assert.ok(both.length > 200, "the combined branch exists");
  const lshAt = both.indexOf("{lshSection}");
  const runsAt = both.indexOf("<AgentView");
  assert.ok(lshAt >= 0, "the structured LSH section is present");
  assert.ok(runsAt > lshAt, "Agent Runs renders AFTER/BELOW the LSH section");
  assert.match(both, /st-lsh-runs-head/, "the runs list has its own quiet heading");
  // The old orphaned inline block must not come back in this branch.
  assert.doesNotMatch(both, /margin: "14px 0 4px"/, "no inline top button block");
  assert.doesNotMatch(both, /style=\{\{ margin: "8px 0 0", fontSize: 12/, "no legacy inline copy");
});

test("repair-C — grant/runtime states still drive the same section (D/E/F)", () => {
  // One line selection covers grant-off, runtime-down and ready.
  assert.match(AGENT, /!lshSnap\.granted[\s\S]{0,200}?还没有授权/);
  assert.match(AGENT, /!lshSnap\.runtimeAvailable[\s\S]{0,160}?正在启动或暂时不可用/);
  assert.match(AGENT, /重新检查授权/, "D: grant-off action");
  assert.match(AGENT, /重新连接/, "E: runtime-down action");
  assert.match(AGENT, /lshReady \? \([\s\S]{0,240}?进入 LightSeek/, "F: ready action");
  // Authority untouched.
  assert.match(AGENT, /lsh\.openSurface\(snap\.instanceId\)/);
});

test("repair-C — no legacy inline LightSeek button block remains anywhere", () => {
  assert.doesNotMatch(AGENT, /margin: "14px 0 4px"/);
  const inlineCopies = AGENT.match(/fontSize: 12, color: "var\(--ink2\)"/gu) ?? [];
  assert.deepEqual(inlineCopies, [], "the inline copy block is gone");
});

// ---------------------------------------------------------------------------
// D. P2-R1 — revalidate/loadMore single-flight
// ---------------------------------------------------------------------------

test("repair-D — loadMore refuses while a revalidation is in flight", () => {
  const loadMore = PAGER.slice(PAGER.indexOf("async loadMore"));
  assert.match(loadMore, /if \(this\.revalidating\) return;/, "the guard is the first check");
  const guardAt = loadMore.indexOf("if (this.revalidating) return;");
  const firstAwait = loadMore.indexOf("await this.fetchPage");
  assert.ok(guardAt >= 0 && (firstAwait < 0 || guardAt < firstAwait), "guarded before any request");
  // The reverse direction remains safe.
  const revalidate = PAGER.slice(PAGER.indexOf("revalidate(filters"), PAGER.indexOf("async loadMore"));
  assert.match(revalidate, /if \(this\.state\.loading \|\| this\.revalidating\) return;/);
});

test("repair-D — real concurrency: no page-2 request during revalidate, works after", async () => {
  const calls: string[] = [];
  let releaseRevalidate: ((v: any) => void) | null = null;
  const pager = new LocalAssetPager((f) => {
    const tag = `page${f.page}`;
    calls.push(tag);
    if (tag === "page1" && calls.filter((c) => c === "page1").length === 1) {
      // First page-1: the initial load.
      return Promise.resolve({ items: [{ assetId: "a" }, { assetId: "b" }], total: 3, hasMore: true });
    }
    if (tag === "page1") {
      // Second page-1: the revalidation, held open so loadMore lands mid-flight.
      return new Promise((resolve) => { releaseRevalidate = resolve; });
    }
    return Promise.resolve({ items: [{ assetId: "c" }], total: 3, hasMore: false });
  });

  pager.reload({});
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(pager.getState().items.map((x) => x.assetId), ["a", "b"]);
  assert.equal(pager.getState().hasMore, true);

  // 2. start revalidate with a deferred promise
  pager.revalidate({});
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(releaseRevalidate, "revalidate is in flight");
  const before = calls.length;

  // 3./4. loadMore during revalidate must NOT start a page-2 request
  await pager.loadMore({});
  assert.equal(calls.length, before, "no page-2 request started during revalidate");
  assert.ok(!calls.includes("page2"), "page 2 never requested while revalidating");
  // rows stayed mounted throughout (never blanked)
  assert.deepEqual(pager.getState().items.map((x) => x.assetId), ["a", "b"], "visible rows kept mounted");

  // 5. settle the revalidation
  releaseRevalidate!({ items: [{ assetId: "a" }, { assetId: "z" }], total: 4, hasMore: true });
  await new Promise((r) => setTimeout(r, 15));
  assert.deepEqual(pager.getState().items.map((x) => x.assetId), ["a", "z"], "fresh page-1 committed");

  // 6. loadMore now works against the FRESH generation
  await pager.loadMore({});
  await new Promise((r) => setTimeout(r, 15));
  assert.ok(calls.includes("page2"), "page 2 starts after revalidate settled");
  assert.deepEqual(pager.getState().items.map((x) => x.assetId), ["a", "z", "c"]);
});

// ---------------------------------------------------------------------------
// E. P2-N1 — Search is an immediate parent
// ---------------------------------------------------------------------------

test("repair-E — Home -> Search -> Note -> Back = Search -> Back = Home", () => {
  const nav = new NavigationController();
  nav.openSearch();
  nav.pushDetail({ tab: "knowledge", detail: "note-1" });
  assert.equal(nav.snapshot().length, 3, "[home, search, detail]");
  assert.deepEqual(nav.current(), { tab: "knowledge", detail: "note-1" });
  assert.equal(nav.goBack(), true);
  assert.deepEqual(nav.current(), { tab: "search" }, "Back returns to the SEARCH results");
  assert.equal(nav.goBack(), true);
  assert.deepEqual(nav.current(), { tab: "home" });
});

test("repair-E — Home -> Search -> Asset -> Back = Search", () => {
  const nav = new NavigationController();
  nav.openSearch();
  nav.pushDetail({ tab: "library", detail: "local:a1" });
  assert.equal(nav.goBack(), true);
  assert.deepEqual(nav.current(), { tab: "search" });
});

test("repair-E — Library -> Search -> result -> Back = Search -> Back = Library", () => {
  const nav = new NavigationController();
  nav.switchRoot("library");
  nav.openSearch();
  nav.pushDetail({ tab: "knowledge", detail: "note-9" });
  assert.equal(nav.goBack(), true);
  assert.deepEqual(nav.current(), { tab: "search" });
  assert.equal(nav.goBack(), true);
  assert.deepEqual(nav.current(), { tab: "library" });
});

test("repair-E — repeated result opens stay bounded (detail layer replaced)", () => {
  const nav = new NavigationController();
  nav.openSearch();
  for (let i = 0; i < 50; i += 1) {
    nav.pushDetail({ tab: "knowledge", detail: "note-" + i });
    assert.equal(nav.snapshot().length, 3, "stack stays [root, search, detail]");
  }
  assert.deepEqual(nav.current(), { tab: "knowledge", detail: "note-49" });
  nav.goBack();
  assert.deepEqual(nav.current(), { tab: "search" });
});

test("repair-E — deep-link detail without Search keeps owner-root behavior", () => {
  const nav = new NavigationController();
  nav.switchRoot("library");
  nav.pushDetail({ tab: "knowledge", detail: "note-1" });
  assert.equal(nav.snapshot().length, 2, "[ownerRoot, detail]");
  assert.deepEqual(nav.snapshot()[0], { tab: "knowledge" });
  nav.goBack();
  assert.deepEqual(nav.current(), { tab: "knowledge" });
});

test("repair-E — StillShell routes a detail opened over Search to the search parent", () => {
  assert.match(SHELL, /navigation\.current\(\)\.tab === "search"/, "the shell detects the search parent");
  assert.match(SHELL, /const origin = searchParent\s*\?\s*undefined/, "it deliberately omits originRoot");
});

// ---------------------------------------------------------------------------
// Regression: the R1 behavior must not have been traded away
// ---------------------------------------------------------------------------

test("repair-regression — R1 semantics still hold", () => {
  // Home-origin detail still returns Home.
  const nav = new NavigationController();
  nav.pushDetail({ tab: "knowledge", detail: "n1" }, { originRoot: "home" });
  nav.goBack();
  assert.deepEqual(nav.current(), { tab: "home" });
  // The demo alias is still gone.
  assert.doesNotMatch(read("src", "still", "StillHome.tsx"), /"n2"/);
  // Desktop events still do not blank the local list.
  assert.doesNotMatch(LIBRARY, /setReloadKey\(\(k\) => k \+ 1\); \}, \[version\]\)/);
  assert.match(LIBRARY, /assetPager\.revalidate\(localFilters\(\)\);/);
});
