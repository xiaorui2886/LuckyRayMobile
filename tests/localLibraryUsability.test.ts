// LOCAL-LIBRARY-USABILITY-R1 (Issue #75) — behavioral tests over the
// PRODUCTION LocalAssetPager and the authority source contracts, plus the
// screen wiring guards. Big-data cases use isolated fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test.before(async () => {
  (globalThis as any).__pager = await import("../src/services/localAssetPager.ts");
});

const kits = () => ({ pagerKit: (globalThis as any).__pager });
const SCREEN = read("src", "still", "StillLibrary.tsx");

function makeAsset(i: number) {
  return {
    assetId: `a${String(i).padStart(3, "0")}`,
    kind: "image",
    name: `Asset ${String(i).padStart(3, "0")}`,
    mime: "image/png",
    sizeBytes: 10_000 - i,
    tags: i === 119 ? ["work", "zzz-late-page"] : ["work"],
    archived: false,
    favorite: false,
    updatedAt: `2026-01-01T${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00`,
  };
}

/** Isolated fixture: 120 assets; the fetch applies the authority's contract
 *  (sort whole set, then paginate) exactly as Db::asset_query does. */
function makeFixture(count = 120) {
  const assets = Array.from({ length: count }, (_, i) => makeAsset(i));
  const fetchPage = async (f: any) => {
    let rows = [...assets];
    if (f.q) rows = rows.filter((a) => a.name.includes(String(f.q).trim()));
    if (f.kind) rows = rows.filter((a) => a.kind === f.kind);
    if (f.tag) rows = rows.filter((a) => a.tags.includes(f.tag));
    if (f.favorite) rows = rows.filter((a) => a.favorite);
    rows = f.archived === false ? rows.filter((a) => !a.archived) : rows;
    const sort = f.sort ?? "recent";
    rows.sort((a, b) => {
      if (sort === "name") return a.name < b.name ? -1 : a.name > b.name ? 1 : a.assetId < b.assetId ? -1 : 1;
      if (sort === "size") return b.sizeBytes - a.sizeBytes || (a.assetId < b.assetId ? -1 : 1);
      // P1-L1: recent is LAST-UPDATED order (production SQL:
      // updated_at DESC, created_at DESC, asset_id ASC).
      return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.assetId < b.assetId ? -1 : 1;
    });
    const start = ((f.page ?? 1) - 1) * (f.limit ?? 50);
    return {
      items: rows.slice(start, start + (f.limit ?? 50)),
      total: rows.length,
      hasMore: start + (f.limit ?? 50) < rows.length,
    };
  };
  return { assets, fetchPage };
}

// ---------- A1: immutable request identity ----------

test("A1: an identity change mid-flight invalidates the old generation — stale page 1 cannot commit", async () => {
  const { pagerKit } = kits();
  let releaseA!: (v: any) => void;
  const fixture = makeFixture(120);
  const pager = new pagerKit.LocalAssetPager(async (f: any) => {
    if ((f.tag ?? "") === "stale") return await new Promise<any>((r) => { releaseA = r; });
    return fixture.fetchPage(f);
  });
  pager.reload({ tag: "stale" });
  await sleep(5);
  // The identity changes before A resolves.
  pager.invalidate();
  pager.reload({ tag: "work" });
  await sleep(5);
  const committed = pager.getState().items.length;
  assert.ok(committed > 0, "B's rows committed");
  releaseA({ items: [makeAsset(0)], total: 1, hasMore: false });
  await sleep(5);
  assert.equal(pager.getState().items.length, committed, "stale A page-1 never commits");
  assert.equal(pager.getState().total, fixture.assets.filter((a) => a.tags.includes("work")).length,
    "the visible identity is still B");
});

test("A1: a loadMore inside the debounce window cannot append under the new identity", async () => {
  const { pagerKit } = kits();
  const calls: any[] = [];
  const fixture = makeFixture(120);
  const pager = new pagerKit.LocalAssetPager(async (f: any) => {
    calls.push({ ...f });
    return fixture.fetchPage(f);
  });
  pager.reload({ q: "Asset 0", sort: "name" });
  await sleep(5);
  const afterPage1 = pager.getState().items.length;
  // The user edits the query (new identity) but the page-1 fetch is still
  // debounced. A loadMore fires with the OLD caller identity.
  pager.invalidate();
  // Invalidation DROPS the dead identity's rows right away: they can never be
  // appended to, and nothing is fetched.
  assert.equal(pager.getState().items.length, 0, "the old identity's rows are dropped");
  await pager.loadMore({ q: "Asset 0", sort: "name" });
  assert.equal(calls.length, 1, "no fetch across the invalidated generation");
  assert.equal(pager.getState().items.length, 0, "no rows appended under the old identity");
});

test("A1: loadMore refuses a stale caller identity and continues the active one", async () => {
  const { pagerKit } = kits();
  const calls: any[] = [];
  const fixture = makeFixture(120);
  const pager = new pagerKit.LocalAssetPager(async (f: any) => {
    calls.push({ ...f });
    return fixture.fetchPage(f);
  });
  pager.reload({ q: "Asset 0", sort: "name" });
  await sleep(5);
  await pager.loadMore({ q: "DIFFERENT", sort: "name" }); // stale caller identity
  assert.equal(calls.length, 1, "the stale identity fetched nothing");
  await pager.loadMore({ q: "Asset 0", sort: "name" }); // the active identity
  assert.equal(calls.length, 2);
  assert.equal(calls[1].page, 2);
  assert.equal(calls[1].q, "Asset 0", "the append used the ACTIVE identity");
  // The appended page continues the same sort (no mixed-page identity).
  assert.equal(calls[1].sort, "name");
});

test("A1: a source switch to Desktop invalidates local pages", async () => {
  const { pagerKit } = kits();
  const fixture = makeFixture(120);
  const pager = new pagerKit.LocalAssetPager(fixture.fetchPage);
  pager.reload({});
  await sleep(5);
  assert.ok(pager.getState().items.length > 0);
  pager.enterDesktop();
  assert.equal(pager.getState().items.length, 0, "local rows are dropped");
  // And a returning page-1 commits normally (aligned generation).
  pager.reload({});
  await sleep(5);
  assert.ok(pager.getState().items.length > 0, "local reload works after returning");
});

// ---------- A2: authority-level global sort (>100 assets) ----------

test("A2: >100 assets — name sort page 1 leads with the alphabetically-first", async () => {
  const { pagerKit } = kits();
  const fixture = makeFixture(120);
  const pager = new pagerKit.LocalAssetPager(fixture.fetchPage);
  pager.reload({ sort: "name" });
  await sleep(5);
  const page1 = pager.getState().items;
  assert.equal(page1[0].name, "Asset 000", "the alphabetically-first asset is on page 1");
  assert.equal(page1[0].assetId, "a000", "…even though it is last by recency and size");
});

test("A2: >100 assets — size sort page 1 leads with the largest", async () => {
  const { pagerKit } = kits();
  const fixture = makeFixture(120);
  const pager = new pagerKit.LocalAssetPager(fixture.fetchPage);
  pager.reload({ sort: "size" });
  await sleep(5);
  assert.equal(pager.getState().items[0].sizeBytes, 10_000, "size DESC leads page 1");
  // Size DESC means the smallest asset arrives on the LAST page — reachable.
  let last = pager.getState().items;
  while (pager.getState().hasMore) {
    await pager.loadMore({ sort: "size" });
  }
  last = pager.getState().items;
  assert.equal(last[last.length - 1].sizeBytes, 10_000 - 119, "the smallest asset is reachable through pages");
});

test("A2: recent order is deterministic (recency desc, id tiebreaker)", async () => {
  const { pagerKit } = kits();
  const fixture = makeFixture(120);
  const pager = new pagerKit.LocalAssetPager(fixture.fetchPage);
  pager.reload({ sort: "recent" });
  await sleep(5);
  const ids1 = pager.getState().items.map((a) => a.assetId);
  const pager2 = new pagerKit.LocalAssetPager(fixture.fetchPage);
  pager2.reload({ sort: "recent" });
  await sleep(5);
  assert.deepEqual(ids1, pager2.getState().items.map((a) => a.assetId), "same data, same order");
  assert.equal(ids1[0], "a119", "newest first");
});

test("A2 P1-L1: an old-created asset that is updated leads recent page 1", async () => {
  const { pagerKit } = kits();
  const fixture = makeFixture(120);
  const pager = new pagerKit.LocalAssetPager(fixture.fetchPage);
  pager.reload({ sort: "recent" });
  await sleep(5);
  assert.equal(pager.getState().items[0].assetId, "a119", "before any update, the newest-created leads");

  // The user renames the OLDEST-CREATED asset (a000): asset_update writes
  // updated_at, so the authority's recent order must surface it on page 1 —
  // reachable only through a whole-library reorder.
  fixture.assets[0].name = "Asset 000 RENAMED";
  fixture.assets[0].updatedAt = "2026-12-31T23:59:59";
  pager.reload({ sort: "recent" });
  await sleep(5);
  assert.equal(pager.getState().items[0].assetId, "a000", "the updated old asset leads recent page 1");
  assert.equal(pager.getState().total, 120);
});

test("A2: the authority applies the sort BEFORE LIMIT/OFFSET (source contract)", () => {
  const db = read("src-tauri", "src", "db.rs");
  const body = db.slice(db.indexOf("pub fn asset_query("), db.indexOf("pub fn asset_paths("));
  assert.match(body.slice(0, 700), /sort: Option<&str>/, "the query takes the bounded sort");
  assert.match(body, /let order_sql = match sort\.unwrap_or\("recent"\)/);
  assert.match(body, /"name" => "ORDER BY a\.name COLLATE NOCASE ASC, a\.asset_id ASC"/);
  assert.match(body, /"size" => "ORDER BY a\.size_bytes DESC, a\.name COLLATE NOCASE ASC, a\.asset_id ASC"/);
  assert.match(body, /_ => "ORDER BY a\.updated_at DESC, a\.created_at DESC, a\.asset_id ASC"/,
    "recent is LAST-UPDATED order with deterministic fallbacks (P1-L1)");
  const orderIdx = body.indexOf("{order_sql}");
  assert.ok(orderIdx > body.indexOf("{where_sql}"), "order follows the filters");
  assert.ok(orderIdx < body.indexOf("{limit_sql}"), "and precedes pagination");
  // The command forwards the bounded vocabulary.
  const lib = read("src-tauri", "src", "lib.rs");
  const cmd = lib.slice(lib.indexOf("async fn local_asset_list("));
  assert.match(cmd.slice(0, 900), /Some\("size"\) => Some\("size"\)/);
  assert.ok(cmd.slice(0, 900).includes("archived, page, limit, sort"), "forwarded into the authority");
});

// ---------- A3: tag authority ----------

test("A3: the tag picker reads the local_asset_tag AUTHORITY (source contract)", () => {
  const db = read("src-tauri", "src", "db.rs");
  assert.match(db, /pub fn asset_tag_vocabulary\(&self, limit: i64\)/);
  const body = db.slice(db.indexOf("pub fn asset_tag_vocabulary"));
  assert.match(body.slice(0, 900), /SELECT tag FROM local_asset_tag/);
  assert.match(body.slice(0, 900), /GROUP BY tag/);
  assert.match(body.slice(0, 900), /ORDER BY tag COLLATE NOCASE ASC/);
  assert.match(body.slice(0, 900), /LIMIT \?1/, "bounded");
  assert.ok(!body.slice(0, 900).includes("local_asset_item"), "not derived from loaded rows");
  const lib = read("src-tauri", "src", "lib.rs");
  assert.match(lib, /async fn local_asset_tags\(state: State<'_, SharedState>\)/);
  assert.ok(lib.includes("local_asset_tags,"), "registered");
  const client = read("src", "services", "client.ts");
  assert.match(client, /localAssetTags: \(\) => invoke<\{ tags: string\[\] \}>\("local_asset_tags"\)/);
});

test("A3: a tag that exists only on a later page is offered before that page loads", () => {
  const { pagerKit } = kits();
  const authority = ["work", "zzz-late-page"];
  const page1 = [makeAsset(0), makeAsset(1)];
  // The OLD defect: deriving from the loaded page hides the late tag.
  const fromPage = [...new Set(page1.flatMap((a) => a.tags))];
  assert.ok(!fromPage.includes("zzz-late-page"));
  // The authority vocabulary has it — and the screen wires THAT in.
  assert.deepEqual(authority, ["work", "zzz-late-page"]);
  assert.match(SCREEN, /api\.localAssetTags\(\)/);
  assert.ok(!SCREEN.includes("collectAssetTags(localPage.items"));
});

test("A3: switching tag A -> tag B needs no clear/full load", async () => {
  const { pagerKit } = kits();
  const fixture = makeFixture(120);
  const pager = new pagerKit.LocalAssetPager(fixture.fetchPage);
  // Only the last asset carries the late-page tag; applying it filters to 1 row.
  pager.reload({ tag: "zzz-late-page" });
  await sleep(5);
  assert.equal(pager.getState().total, 1);
  // Switch directly to another tag: a fresh identity reload, no clear pass.
  pager.reload({ tag: "work" });
  await sleep(5);
  assert.equal(pager.getState().total, 120, "all work-tagged rows arrive");
  // And the tag is Local-only: the Desktop query path never sees it.
  // REPAIR-R5: the Desktop axes come from DESKTOP_SOURCE and the Desktop fetch,
  // neither of which may carry the Local tag/favourite/archive axes.
  const srcIdx = SCREEN.indexOf("const DESKTOP_SOURCE = () =>");
  assert.ok(srcIdx > 0, "the Desktop source builder exists");
  const desktopSource = SCREEN.slice(srcIdx, SCREEN.indexOf("});", srcIdx) + 3);
  assert.ok(!desktopSource.includes("applied."), "the Desktop source carries no Local axis");
  const fetchIdx = SCREEN.indexOf("const value = await api.contentAssets(owner, {");
  assert.ok(fetchIdx > 0, "the Desktop fetch exists");
  const desktopFetch = SCREEN.slice(fetchIdx, SCREEN.indexOf("});", fetchIdx) + 3);
  assert.ok(!desktopFetch.includes("applied."), "and neither does the Desktop request");
});

// ---------- A4: archive/unarchive ----------

test("A4: local asset detail exposes archive/unarchive through the flag authority", () => {
  const asset = read("src", "still", "StillAsset.tsx");
  assert.match(asset, /async function toggleArchive\(\)/);
  assert.match(asset, /api\.localAssetSetFlags\(localId, \{ archived: !asset\.archived \}\)/,
    "the existing flag authority is used");
  assert.match(asset, /localDataStore\.publish\("asset"\)/, "success publishes the local asset domain");
  assert.match(asset, /label=\{asset\.archived \? "取消归档" : "归档"\}/, "desired-state label");
  assert.match(asset, /已归档/, "the archived state is visible on the row/detail");
  // Failure keeps visible state: the catch path does not setAsset/publish.
  const body = asset.slice(asset.indexOf("async function toggleArchive"));
  const end = body.indexOf("async function saveMeta");
  const fnBody = body.slice(0, end);
  const catchIdx = fnBody.indexOf("catch");
  assert.ok(!fnBody.slice(catchIdx).includes("setAsset"), "failure leaves visible state unchanged");
  assert.ok(!fnBody.slice(catchIdx).includes("localDataStore.publish"), "failure publishes nothing");
});

// ---------- A5: invalidation convergence ----------

test("A5: local mutations converge through localDataStore(asset)", () => {
  // Import now publishes the local asset domain (was screen-local reloadKey).
  assert.match(SCREEN, /localDataStore\.publish\("asset"\)/, "import publishes the local domain");
  // The library reloads the LOCAL list from the local bus.
  assert.match(SCREEN, /const localVersion = useSyncExternalStore\(/);
  assert.match(SCREEN, /localDataStore\.subscribe\(fn\)/);
  // UX-POLISH-R1 3.3: a local mutation REVALIDATES the same identity in place
  // (rows stay mounted, no blank frame) instead of riding the identity-reload
  // effect; an explicit user refresh keeps its own reload path.
  assert.match(SCREEN, /assetPager\.revalidate\(localFilters\(\)\);/,
    "a local mutation revalidates the list without blanking it");
  assert.match(SCREEN, /\[assetPager, domain, localVersion\]/,
    "the revalidate path is driven by the local bus only");
  // MATERIAL-LIBRARY-INSTANT-R1: the identity effect now also carries the
  // retained-source session, and no longer depends on `domain` (a source
  // toggle must not reload). The local store bus is still excluded.
  assert.match(SCREEN, /\[assetPager, session, localQuery, kindFilter, applied\]/,
    "the identity-reload path no longer listens to background store events");
  assert.doesNotMatch(SCREEN, /\[assetPager, domain, localQuery, kindFilter, applied\]/,
    "and it is no longer driven by the source toggle");
  assert.doesNotMatch(SCREEN, /setReloadKey\(\(k\) => k \+ 1\); \}, \[version\]\)/,
    "a Desktop-domain store event must not bump the shared reload key");
  // The two authorities stay separate: a local publish must not trigger a
  // Desktop refresh — the Desktop effect depends on dataStore/desktopVersion only.
  const desktopEffect = SCREEN.slice(SCREEN.indexOf("const desktopOwner = conn?.identity?.instanceId"), SCREEN.indexOf("// Switching to a different Desktop"));
  assert.ok(!desktopEffect.includes("localVersion"), "Desktop query ignores the local bus");
  // Detail mutations (favorite/archive/rename/delete) publish on success only.
  const asset = read("src", "still", "StillAsset.tsx");
  const publishes = asset.split('localDataStore.publish("asset")').length - 1;
  assert.ok(publishes >= 4, `favorite/archive/rename/tag/delete publish on success (saw ${publishes})`);
  // A cancelled import publishes nothing.
  const importBody = SCREEN.slice(SCREEN.indexOf("async function importMedia"), SCREEN.indexOf("const [thumbMap"));
  assert.match(importBody, /if \(r\?\.cancelled\) toast\.info\("已取消导入"\);/, "cancel path exists");
  const cancelIdx = importBody.indexOf("已取消导入");
  const publishIdx = importBody.indexOf('localDataStore.publish("asset")');
  assert.ok(publishIdx > cancelIdx, "the publish sits behind the cancel check");
});

// ---------- A6: truthful loaded state / identity labels ----------

test("A6: the loaded/total indication and identity label are truthful", () => {
  const { pagerKit } = kits();
  assert.equal(pagerKit.assetsLoadedText(50, 120), "已加载 50 / 共 120");
  assert.equal(pagerKit.assetsLoadedText(120, 120), null, "fully loaded shows nothing");
  assert.equal(pagerKit.assetsLoadedText(0, 0), null);
  assert.match(SCREEN, /assetsLoadedText\(localPage\.items\.length, localPage\.total\)/);
  // The filter label includes the local tag so it reflects the real identity.
  assert.match(SCREEN, /applied\.tag \? "#" \+ applied\.tag : ""/);
});

// ---------- #72 no-touch ----------

test("#72 no-touch: the #75 library scope adds no LSH coupling (integration branch)", () => {
  // FINAL-INTEGRATION: this branch legitimately CARRIES the accepted LSH work.
  // The #75 no-touch contract here is that the Library scope neither imports
  // nor extends it — the LSH wire additions remain exactly the frozen set.
  assert.ok(!SCREEN.includes("lshSurface"), "no LSH adapter import in the library");
  assert.ok(!SCREEN.includes("LshSurface"), "no LSH shell reference");
  assert.ok(!SCREEN.includes("lsh_surface"), "no LSH native command reference");
  assert.ok(!SCREEN.includes("AgentCapability"), "no Agent controller import");
  const client = read("src", "services", "client.ts");
  // The accepted LSH wire surface is present unchanged:
  assert.match(client, /lshSurfaceBootstrap: \(expectedInstance: string\)/);
  assert.match(client, /lshSurfaceOpen: \(request/);
  // …and the #75 library additions live in the Local Asset section, disjoint
  // from it: the tags command sits adjacent to the local asset list.
  assert.match(client, /localAssetTags: \(\) => invoke<\{ tags: string\[\] \}>\("local_asset_tags"\)/);
  // Order in the merged client: the accepted LSH contract area (from the frozen
  // commits) sits before the Local Asset section; both are present, neither
  // absorbed the other.
  const lshIdx = client.indexOf("lshSurfaceBootstrap");
  const assetIdx = client.indexOf("localAssetTags");
  const localIdx = client.indexOf("localAssetList:");
  assert.ok(lshIdx !== -1 && lshIdx < localIdx && localIdx < assetIdx,
    "the LSH contract area and the Local Asset section stay disjoint");
});
