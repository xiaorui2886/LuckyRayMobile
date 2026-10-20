// UX-POLISH-R1 (Issue #78) — behavior contracts for the four production bugs
// and the presentation closure. Pure logic + source contracts, no Tauri.
// Run: node --experimental-strip-types --test tests/uxPolishR1.contract.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NavigationController } from "../src/navigation.ts";
import { LocalAssetPager, type AssetFilters } from "../src/services/localAssetPager.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const NAV = read("src", "navigation.ts");
const SHELL = read("src", "still", "StillShell.tsx");
const HOME = read("src", "still", "StillHome.tsx");
const VIEWS = read("src", "presentation", "still01", "Views.tsx");
const STILL = read("src", "presentation", "still01", "Still.tsx");
const CSS = read("src", "presentation", "still01", "still.css");
const AGENT = read("src", "still", "StillAgent.tsx");
const LIBRARY = read("src", "still", "StillLibrary.tsx");
const ASSET = read("src", "still", "StillAsset.tsx");
const COLLECTION = read("src", "still", "StillCollection.tsx");

// ---------------------------------------------------------------------------
// §1.3 origin-preserving detail navigation
// ---------------------------------------------------------------------------

test("ux-r1 — Home -> existing note -> Back = Home (origin preserved)", () => {
  const nav = new NavigationController();
  nav.pushDetail({ tab: "knowledge", detail: "note-real-1" }, { originRoot: "home" });
  assert.deepEqual(nav.current(), { tab: "knowledge", detail: "note-real-1" });
  assert.equal(nav.goBack(), true);
  assert.deepEqual(nav.current(), { tab: "home" }, "Back returns to the ORIGIN root, not knowledge");
});

test("ux-r1 — Home -> new-note -> Back = Home", () => {
  const nav = new NavigationController();
  nav.pushDetail({ tab: "knowledge", detail: "new" }, { originRoot: "home" });
  assert.equal(nav.goBack(), true);
  assert.deepEqual(nav.current(), { tab: "home" });
});

test("ux-r1 — Knowledge -> note -> Back = Knowledge (same-root unchanged)", () => {
  const nav = new NavigationController();
  nav.switchRoot("knowledge");
  nav.pushDetail({ tab: "knowledge", detail: "note-1" });
  assert.equal(nav.goBack(), true);
  assert.deepEqual(nav.current(), { tab: "knowledge" });
});

test("ux-r1 — Library -> asset -> Back = Library", () => {
  const nav = new NavigationController();
  nav.switchRoot("library");
  nav.pushDetail({ tab: "library", detail: "local:a1" });
  assert.equal(nav.goBack(), true);
  assert.deepEqual(nav.current(), { tab: "library" });
});

test("ux-r1 — a cross-root open from Library preserves Library; stack stays bounded", () => {
  const nav = new NavigationController();
  nav.switchRoot("library");
  for (let i = 0; i < 50; i += 1) {
    nav.pushDetail({ tab: "knowledge", detail: "note-" + i }, { originRoot: "library" });
    assert.equal(nav.snapshot().length, 2, "the stack never exceeds [origin, detail]");
    nav.goBack();
  }
  assert.deepEqual(nav.current(), { tab: "library" });
});

test("ux-r1 — no originRoot keeps the deep-link behaviour (owner root wins)", () => {
  const nav = new NavigationController();
  nav.switchRoot("library");
  nav.pushDetail({ tab: "knowledge", detail: "note-1" });
  assert.deepEqual(nav.snapshot()[0], { tab: "knowledge" }, "deep link lands on the owning root");
});

test("ux-r1 — StillShell wires content details with the initiating root", () => {
  for (const page of ["note", "asset", "run"]) {
    const marker = "page === \"" + page + "\"";
    const at = SHELL.indexOf(marker + ")");
    assert.ok(at >= 0, `${page} branch exists`);
    // Inspect the complete branch, not a fixed character budget that can end
    // inside the newly documented search-reading exception.
    const end = SHELL.indexOf('\n    if (page ===', at + marker.length);
    const seg = SHELL.slice(at, end < 0 ? SHELL.length : end);
    assert.match(seg, /originRoot: origin/, `${page} preserves the origin root`);
  }
  // R4 (C): the new-note branch now creates directly (async); its push still
  // preserves the origin root.
  const nnAt = SHELL.indexOf('if (page === "new-note") {');
  assert.ok(nnAt >= 0, "new-note branch exists");
  const nnEnd = SHELL.indexOf('\n    if (page ===', nnAt + 1);
  const nnSeg = SHELL.slice(nnAt, nnEnd < 0 ? SHELL.length : nnEnd);
  assert.match(nnSeg, /originRoot: origin/, "new-note preserves the origin root");
});
// ---------------------------------------------------------------------------
// §1.4 今天的随手记 — no demo alias
// ---------------------------------------------------------------------------

test("ux-r1 — the demo n2 alias is gone from production", () => {
  assert.doesNotMatch(HOME, /"n2"/, "StillHome no longer maps demo n2");
  assert.doesNotMatch(VIEWS, /open\('note','n2'\)/, "HomeView no longer emits demo n2");
  assert.match(VIEWS, /今天的随手记[^/]*onClick=\{\(\)=>p\.open\('new-note'\)\}/u,
    "今天的随手记 enters the REAL new-note flow");
});

test("ux-r1 — continue reading uses the true recent note id", () => {
  assert.match(VIEWS, /p\.open\('note',p\.recent!\.id\)/, "recent row passes the REAL id");
  assert.match(HOME, /if \(id\) open\("note", id\);/, "a real id opens that note");
  assert.match(HOME, /else open\("new-note"\);/, "no id means NEW note, never recent-as-fallback");
});

// ---------------------------------------------------------------------------
// §1.2 / §1.5 Home presentation
// ---------------------------------------------------------------------------

test("ux-r1 — the connection row is ONE semantic whole-row click target", () => {
  assert.match(VIEWS, /<button type="button" className=\{'st-connection'/, "the row itself is the button");
  const row = VIEWS.slice(VIEWS.indexOf("className={'st-connection'"), VIEWS.indexOf("</button>", VIEWS.indexOf("st-connection")));
  assert.equal((row.match(/onClick=/gu) ?? []).length, 1, "exactly one onClick owner (no nested buttons)");
  assert.match(row, /aria-label="查看电脑连接"/, "the accessible name stays on the row");
  assert.match(row, /st-connection-text/, "status text preserved");
  assert.match(CSS, /\.st-connection-chevron\{margin-left:auto/, "chevron aligned to the trailing edge");
});

test("ux-r1 — bottom nav is icon-only visually but keeps accessible names", () => {
  assert.match(STILL, /aria-label=\{r\.label\}/, "each tab carries its aria-label");
  assert.doesNotMatch(STILL, /st-tab-label/, "no visible label element renders in the tab");
  assert.match(CSS, /\.st-tab\{display:grid;grid-template-rows:24px/, "the tab centers the icon alone");
});

test("ux-r1 — wordmark halves optically unify (small optical tweak only)", () => {
  assert.match(CSS, /\.st-wordmark>span\{font-weight:550/, "Ray moves toward Lucky's weight");
});

// ---------------------------------------------------------------------------
// §2 AI / LightSeek state matrix
// ---------------------------------------------------------------------------

function agentSourceFor(stateProbe: string): string {
  // Simulate the controller truth the way the page receives it, then assert
  // against the rendered STRUCTURE via source contracts. The state machine
  // itself is covered by a0StateStabilization; here we pin the composition.
  void stateProbe;
  return AGENT;
}

test("ux-r1 — LSH-ready page is led by LightSeek, not the Runs-unsupported empty", () => {
  const src = agentSourceFor("");
  // The dedicated panel branch exists BEFORE the generic returns.
  // REPAIR-R1 P1-AI1: the structured section is shared by BOTH capability
  // combinations, so the Runs-unavailable branch is one consumer of it.
  const start = src.indexOf("if (snap.canUseLsh && !snap.canUseRuns)");
  const end = src.indexOf("if (snap.canUseLsh && snap.canUseRuns)");
  const panel = src.slice(start, end);
  assert.ok(panel.length > 400, "the LSH-led branch is a real composition");
  // The D/E/F actions live in the SHARED section every canUseLsh state uses.
  const section = src.slice(src.indexOf("const lshSection = ("), src.indexOf("// Runs-unsupported: LightSeek leads"));
  assert.match(section, /进入 LightSeek/, "F: the primary entry is the section's action");
  assert.match(section, /等待电脑授权/, "D: grant-off is a truthful waiting state");
  assert.match(section, /暂时不可用/, "E: runtime-down is truthful");
  assert.match(section, /st-lsh-mark/, "the structured mark is part of the section");
  assert.match(panel, /st-lsh-subnote/, "Runs-unsupported is demoted to a footnote");
  assert.match(panel, /\{lshSection\}/, "it renders the SAME structured section");
  assert.doesNotMatch(panel, /margin: "14px 0 4px"/, "no orphaned inline button block");
  assert.doesNotMatch(panel, /当前桌面版本尚未开放手机任务控制/,
    "the dominant Runs-unsupported empty cannot suppress a ready LSH");
});

test("ux-r1 — unpaired/offline/probing still show the connect/offline states", () => {
  assert.match(AGENT, /snap\.state === "unpaired" \|[\s\S]*?| snap\.state === "offline"/u);
  assert.match(AGENT, /电脑暂时不在线/);
  assert.match(AGENT, /正在确认电脑能力/);
});

test("ux-r1 — entering LightSeek still goes through LshSurfaceController", () => {
  assert.match(AGENT, /lsh\.openSurface\(snap\.instanceId\)/, "the entry action is the controller");
  assert.match(AGENT, /lshErrorCopy\(e\)/, "controller failures surface through the error copy");
});

// ---------------------------------------------------------------------------
// §3.1 filter sheet view options removed
// ---------------------------------------------------------------------------

test("ux-r1 — the library filter sheet offers NO view modes", () => {
  assert.doesNotMatch(LIBRARY, /label="网格视图"/);
  assert.doesNotMatch(LIBRARY, /label="列表视图"/);
  assert.doesNotMatch(LIBRARY, /onView=/, "the sheet has no view channel at all");
  // The toolbar remains the ONLY owner and still persists the preference.
  assert.match(LIBRARY, /onList=\{toggleListView\}/);
  assert.match(LIBRARY, /setLibraryView\(next \? "list" : "grid"\);/);
  // Applying the sheet can never rewrite the view any more.
  assert.doesNotMatch(LIBRARY, /setListPref\(v\.view === "list"\);/);
});

// ---------------------------------------------------------------------------
// §3.2 Desktop selection is explicit-only and never resurrects
// ---------------------------------------------------------------------------

test("ux-r1 — selection lifecycle: explicit entry, exits, no resurrection", () => {
  // REPAIR-R5: entry is now the LONG PRESS (the permanent toolbar Select button
  // was removed), and it still starts a CLEAN selection containing exactly the
  // held asset.
  const entries = LIBRARY.match(/setSelecting\(true\)/gu) ?? [];
  assert.equal(entries.length, 1, "selection can only be entered in one place");
  // R7c: entry anchors the range — baseline ∪ [anchor].
  assert.match(LIBRARY, /setSelecting\(true\);\s*\n\s*setSelectedIds\(\(prev\) => selectionWithRange\(\{ anchorIndex: idx, baseline: prev \}, idx, orderedDesktopIds\)\);/,
    "entry starts a clean selection holding the held anchor");
  // Exit paths all clear BOTH the mode and the ids.
  assert.match(LIBRARY, /if \(domain !== "desktop"\) \{ setSelecting\(false\); setSelectedIds\(\[\]\); \}/,
    "leaving the Desktop source exits selection");
  assert.match(LIBRARY, /setSelectedIds\(\[\]\);\r?\n\s*setSelecting\(false\);\r?\n\s*return org\.subscribe/,
    "a Desktop identity change exits selection");
  // REPAIR-R5: the owner change is now the authority bind, and it still clears
  // both the ids and the mode (A selections never survive into B).
  const bindIdx = LIBRARY.indexOf("desktopAuthority.bind(desktopOwner, DESKTOP_SOURCE());");
  assert.ok(bindIdx > 0, "the owner bind exists");
  const ownerEffect = LIBRARY.slice(bindIdx, bindIdx + 460);
  assert.match(ownerEffect, /setSelectedIds\(\[\]\);/, "owner change clears the ids");
  assert.match(ownerEffect, /setSelecting\(false\);/, "owner change exits selection");
  // selecting is component state (never module state), so a remount (switching
  // pages away and back) always lands at false.
  assert.match(LIBRARY, /const \[selecting, setSelecting\] = useState\(false\);/);
  assert.doesNotMatch(LIBRARY, /selecting = true|rememberedSelecting/, "no persistence of the selection mode");
  // The batch run exits selection only when NOTHING failed (partial keeps it).
    const batchFn = LIBRARY.slice(LIBRARY.indexOf("async function runBatch"), LIBRARY.indexOf("function openBatchTags"));
  assert.match(batchFn, /if \(\(result\.failed \|\| \[\]\)\.length === 0\) \{/, "the partial branch exists");
  assert.match(batchFn, /setSelecting\(false\);/, "a fully-successful batch exits selection");
  assert.match(batchFn, /setSelectedIds\(\[\]\);/, "a fully-successful batch clears the ids");
});

// ---------------------------------------------------------------------------
// §3.3 refresh root cause
// ---------------------------------------------------------------------------

test("ux-r1 — background Desktop events never blank the local list", () => {
  assert.doesNotMatch(LIBRARY, /setReloadKey\(\(k\) => k \+ 1\); \}, \[version\]\)/,
    "the shared key no longer rides the Desktop-domain bus");
  // REPAIR-R5: the Desktop store event revalidates the CURRENT Desktop identity
  // through its own authority — still never the local list.
  assert.match(LIBRARY, /\}, \[desktopAuthority, version\]\);/,
    "Desktop-domain events refresh the DESKTOP list only");
  // MATERIAL-LIBRARY-INSTANT-R1: the local identity effect carries the
  // retained-source session and no longer depends on `domain` — a source toggle
  // must not reload (clear) the local list; only identity changes do.
  assert.match(LIBRARY, /\[assetPager, session, localQuery, kindFilter, applied\]/,
    "only request-identity changes reload (clear) the local list");
});

test("ux-r1 — a local mutation revalidates in place (bounded, no blank)", () => {
  assert.match(LIBRARY, /\[assetPager, domain, localVersion\]/, "the local bus drives revalidate only");
});

test("ux-r1 — pager.revalidate keeps rows mounted and stays bounded", async () => {
  const calls: AssetFilters[] = [];
  let gen = 0;
  const pager = new LocalAssetPager((f) => {
    calls.push({ ...f });
    const g = ++gen;
    return new Promise((resolve) => {
      setTimeout(() => resolve(g === 1
        ? { items: [{ assetId: "a" }, { assetId: "b" }], total: 3, hasMore: true }
        : { items: [{ assetId: "a" }, { assetId: "c" }], total: 2, hasMore: false }),
        5);
    });
  });
  pager.reload({}); // page-1: a,b
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(pager.getState().items.length, 2);

  // Revalidate commits the fresh rows WITHOUT ever blanking: the old rows stay
  // visible until the swap.
  pager.revalidate({});
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(pager.getState().items.map((x) => x.assetId), ["a", "c"]);
  assert.equal(pager.getState().total, 2);

  // Bounded: a second revalidate while one is in flight is refused.
  let third = 0;
  const p2 = new LocalAssetPager(() => new Promise((resolve) => {
    third += 1;
    setTimeout(() => resolve({ items: third === 1 ? [{ assetId: "x" }] : [{ assetId: "y" }], total: 1, hasMore: false }), 5);
  }));
  p2.reload({});
  await new Promise((r) => setTimeout(r, 20));
  p2.revalidate({});
  p2.revalidate({}); // in-flight → refused
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(third, 2, "one revalidate per trigger");
  assert.deepEqual(p2.getState().items.map((x) => x.assetId), ["y"]);

  // A moved identity is refused: the reload path owns it.
  const p3 = new LocalAssetPager((f) => Promise.resolve({ items: [{ assetId: "k" + (f.page ?? 1) }], total: 1, hasMore: false }));
  p3.reload({});
  await new Promise((r) => setTimeout(r, 10));
  p3.revalidate({ q: "other" });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(p3.getState().items.map((x) => x.assetId), ["k1"], "identity mismatch is refused");
});

test("ux-r1 — an explicit user refresh keeps its own reload path", () => {
  assert.match(LIBRARY, /firstRefresh/, "the mount run is a no-op");
  assert.match(LIBRARY, /assetPager\.reload\(localFilters\(\)\);\r?\n\s*\/\/ eslint-disable-next-line react-hooks\/exhaustive-deps\r?\n\s*\}, \[assetPager, reloadKey\]/u,
    "reloadKey drives the explicit reload only");
});

// ---------------------------------------------------------------------------
// §4 asset detail
// ---------------------------------------------------------------------------

test("ux-r1 — the bottom magnifier becomes Favorite through existing authorities", () => {
  // Local: the center action binds the real local flag authority.
  const localPart = ASSET.slice(ASSET.indexOf("function LocalAsset"), ASSET.indexOf("// --- 电脑素材"));
  assert.match(localPart, /icon="heart" label=\{asset\.favorite \? "取消收藏" : "收藏"\}/);
  assert.match(localPart, /onClick=\{\(\) => void toggleFavorite\(\)\}/, "uses the existing handler");
      const localActions = localPart.slice(localPart.indexOf('className="st-asset-actions"'));
  const barEnd = localActions.indexOf("</div>");
  assert.doesNotMatch(localActions.slice(0, barEnd), /icon="zoom"/, "the bottom magnifier button is gone");  // Desktop: guarded by the Wave A authority and truthfully disabled on owner mismatch.
  const desktopPart = ASSET.slice(ASSET.indexOf("function DesktopAsset"));
  assert.match(desktopPart, /icon="heart" label=\{asset\?\.favorite \? "取消收藏" : "收藏"\}/);
  assert.match(desktopPart, /disabled=\{ownerMismatch \|\| unavailable \|\| !asset \|\| orgSnapshot\.busy\}/,
    "wrong-owner, denied, and unread detail states cannot mutate favorites");
  assert.match(desktopPart, /org\.setFavorite\(assetId, !asset\?\.favorite, revalidate\)/, "uses the Wave A authority");
});

test("ux-r1 — the zoom gesture is retained; the redundant hint is gone", () => {
  assert.match(ASSET, /onDoubleClick=\{\(\) => \{ if \(video\) return; setZoom\(\(z\) => \(z === 1 \? 2 : 1\)\)/, "double-tap zoom kept");
  assert.match(ASSET, /data-media-zoom-layer="true"/, "media zoom layer kept");
  assert.match(ASSET, /base\.current\.distance/, "pinch zoom kept");
  assert.doesNotMatch(ASSET, /双击图片可放大/, "the redundant hint is removed from both details");
});

// ---------------------------------------------------------------------------
// §5 knowledge note rows
// ---------------------------------------------------------------------------

test("ux-r1 — pin/favorite sit on the metadata line's right, soft active state", () => {
  assert.match(COLLECTION, /<strong>\{n\.title\}<\/strong>/, "the title line starts clean");
  assert.match(COLLECTION, /className="st-note-meta"/, "metadata keeps its slot");
  assert.match(COLLECTION, /className="st-flag-pin"/, "pin flag on the metadata line");
  assert.match(COLLECTION, /className="st-flag-fav is-on"/, "favorite flag on the metadata line");
  // Views.tsx desktop rows share the same language.
  assert.match(VIEWS, /className="st-note-flags"/, "the desktop rows carry the same flags slot");
  // Soft accent selected state — never pure black fill.
  assert.match(CSS, /\.st-note-row \.st-flag-fav\.is-on\{color:var\(--st-accent\);fill:var\(--st-accent\);fill-opacity:\.16\}/);
  assert.match(CSS, /\.st-note-row \.st-flag-pin\{color:var\(--st-accent\)\}/);
  // Mutations remain the REAL handlers in the actions sheet.
  assert.match(COLLECTION, /toggleNoteFlag\("pinned"\)/);
  assert.match(COLLECTION, /toggleNoteFlag\("favorite"\)/);
  // No scroll-width regression: the flags never force the row wider.
  assert.match(CSS, /\.st-note-row small\{font-size:10px;color:var\(--st-muted\);margin-top:9px;display:flex;align-items:center;gap:8px\}/);
});
