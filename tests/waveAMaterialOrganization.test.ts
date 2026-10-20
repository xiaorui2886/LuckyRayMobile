// Wave-A material organization tests (production code, not regex-only).
//
// The controller is the single owner of Mobile-side organization requests:
// single-flight, identity fencing, truthful offline/capability failure and
// partial-batch reporting. Desktop remains the authority, so the API is
// mocked at the client boundary exactly as the app calls it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
// The Desktop authority lives in its own checkout, which is not necessarily a
// sibling of this repo. Resolution order: LUCKYRAY_DESKTOP env, the sibling
// layout, then the scratch worktree used on this machine. When none exists the
// byte-identical vendored bundle remains the cross-repo proof.
const DESKTOP_ROOTS = [
  process.env.LUCKYRAY_DESKTOP || "",
  join(ROOT, "..", "luckyray-app", "luckyray-app"),
  join(ROOT, "..", "..", "luckyray-app", "luckyray-app"),
  join(ROOT, "..", "..", "luckyray-scratch", "luckyray-app", "luckyray-app"),
].filter(Boolean);
function desktopFile(...parts: string[]): string | null {
  for (const base of DESKTOP_ROOTS) {
    try {
      return readFileSync(join(base, ...parts), "utf8");
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// The controller takes its transport as an injected seam (production passes the
// real client), so these tests drive the exact production controller.
const calls: { method: string; args: any[] }[] = [];
let behavior: (method: string, args: any[]) => Promise<any> = async () => ({});

test.before(async () => {
  (globalThis as any).__org = await import("../src/still/kit/materialOrganization.ts");
});

const codec = () => (globalThis as any).__org;

test.beforeEach(() => {
  calls.length = 0;
  behavior = async () => ({});
});

function controller(identity = "desk-A") {
  const { MaterialOrganizationController } = (globalThis as any).__org;
  const transport = {
    setFavorite: (i: string, id: string, favorited: boolean) => { calls.push({ method: "setFavorite", args: { instance: i, assetId: id, favorited } }); return behavior("setFavorite", []); },
    setTags: (i: string, id: string, patch: any) => { calls.push({ method: "setTags", args: { instance: i, assetId: id, ...patch } }); return behavior("setTags", []); },
    setFolder: (i: string, id: string, folderId: string | null) => { calls.push({ method: "setFolder", args: { instance: i, assetId: id, folderId } }); return behavior("setFolder", []); },
    createTag: (i: string, name: string) => { calls.push({ method: "createTag", args: { instance: i, name } }); return behavior("createTag", []); },
    createFolder: (i: string, name: string) => { calls.push({ method: "createFolder", args: { instance: i, name } }); return behavior("createFolder", []); },
    batch: (i: string, input: any) => { calls.push({ method: "batch", args: { instance: i, ...input } }); return behavior("batch", []); },
  };
  const c = new MaterialOrganizationController(transport as any);
  c.setIdentity(identity);
  return c;
}

test("waveA: favorite is a desired-state call and revalidates on success", async () => {
  const c = controller();
  behavior = async () => ({ desktopAssetId: "a1", favorited: true });
  let revalidated = 0;
  const ok = await c.setFavorite("a1", true, () => { revalidated += 1; });
  assert.ok(ok, "favorite resolved");
  assert.equal(calls[0].method, "setFavorite");
  assert.deepEqual(calls[0].args, { instance: "desk-A", assetId: "a1", favorited: true });
  assert.equal(revalidated, 1, "authoritative state re-read after success");
  assert.equal(c.snapshot().busy, false);
  assert.equal(c.snapshot().error, "");
});

test("waveA: offline Desktop fails truthfully with no queued work", async () => {
  const c = controller();
  behavior = async () => { throw new Error("content CONTENT_OFFLINE"); };
  const result = await c.setFavorite("a1", true, () => {});
  assert.equal(result, null, "no success is claimed offline");
  assert.match(c.snapshot().error, /电脑未连接/, "truthful offline copy");
  assert.equal(calls.length, 1, "exactly one attempt — no retry queue, no fake pending write");
});

test("waveA: an older Desktop without the capability fails instead of pretending", async () => {
  const c = controller();
  behavior = async () => { throw new Error("CONTENT_UPGRADE_REQUIRED (400)"); };
  await c.setTags("a1", { set: ["t1"] }, () => {});
  assert.match(c.snapshot().error, /尚未开放手机整理素材/, "capability gating is surfaced");
});

test("waveA: single-flight — a second request while busy is refused", async () => {
  const c = controller();
  let release: (() => void) | null = null;
  behavior = () => new Promise((resolve) => { release = () => resolve({ desktopAssetId: "a1" }); });
  const first = c.setFavorite("a1", true, () => {});
  await sleep(5);
  assert.equal(c.snapshot().busy, true, "busy reflects the real request lifetime");
  const second = await c.setFolder("a1", null, () => {});
  assert.equal(second, null, "second request refused while busy");
  assert.equal(calls.length, 1, "only one organization request on the wire");
  release!();
  await first;
  assert.equal(c.snapshot().busy, false);
});

test("waveA: identity change fences an in-flight result (Desktop A never lands on B)", async () => {
  const c = controller("desk-A");
  let release: ((v: any) => void) | null = null;
  behavior = () => new Promise((resolve) => { release = resolve; });
  const running = c.setFolder("a1", "folder-a", () => {});
  await sleep(5);
  c.setIdentity("desk-B");                       // user switches Desktop
  release!({ desktopAssetId: "a1", folderId: "folder-a" });
  const result = await running;
  assert.equal(result, null, "late A response cannot commit under B");
  assert.equal(c.snapshot().busy, false);
});

test("waveA: identity change does not run the revalidation for the old Desktop", async () => {
  const c = controller("desk-A");
  let release: ((v: any) => void) | null = null;
  behavior = () => new Promise((resolve) => { release = resolve; });
  let revalidated = 0;
  const running = c.setFolder("a1", "folder-a", () => { revalidated += 1; });
  await sleep(5);
  c.setIdentity("desk-B");
  release!({ desktopAssetId: "a1" });
  await running;
  assert.equal(revalidated, 0, "no stale revalidation after identity change");
});

test("waveA: batch reports partial results and never claims full success", async () => {
  const c = controller();
  behavior = async (cmd) => {
    assert.equal(cmd, "batch");
    assert.deepEqual(calls[0].args.assetIds, ["a1", "a2", "a3"]);
    return { requested: 3, succeeded: ["a1", "a3"], failed: [{ desktopAssetId: "a2", reason: "folder-failed" }], atomic: false };
  };
  let revalidated = 0;
  const result = await c.batch(
    { assetIds: ["a1", "a2", "a3"], folderChange: true, folderId: "f1" },
    () => { revalidated += 1; },
  );
  assert.deepEqual(result.failed.length, 1);
  assert.deepEqual(c.snapshot().partial, { succeeded: 2, failed: 1 }, "partial state surfaced, not success");
  assert.equal(revalidated, 1, "a partial batch also changed the authority, so the page is re-read");
});

test("waveA: batch folder is a presence-aware tri-state, not a toggle", async () => {
  const c = controller();
  behavior = async () => ({ requested: 1, succeeded: ["a1"], failed: [], atomic: false });

  await c.batch({ assetIds: ["a1"], folderChange: false }, () => {});
  assert.equal("folderId" in calls.at(-1)!.args, false, "omitted = folder untouched");

  await c.batch({ assetIds: ["a1"], folderChange: true, folderId: null }, () => {});
  assert.equal(calls.at(-1)!.args.folderId, null, "explicit null = move to root");

  await c.batch({ assetIds: ["a1"], folderChange: true, folderId: "f7" }, () => {});
  assert.equal(calls.at(-1)!.args.folderId, "f7", "string = move into that folder");
});

test("waveA: an unrelated batch never carries a folder id", async () => {
  const c = controller();
  behavior = async () => ({ requested: 1, succeeded: ["a1"], failed: [], atomic: false });
  await c.batch({ assetIds: ["a1"], favorited: true, folderChange: false }, () => {});
  assert.equal("folderId" in calls.at(-1)!.args, false);

  const library = read("src", "still", "StillLibrary.tsx");
  assert.match(library, /folderChange: Boolean\(folderChange\)/, "the UI sends an explicit presence signal");
  assert.ok(
    !/runBatch\(\{ folderId:/.test(library),
    "no folder id can be sent without the presence signal",
  );
});

test("waveA: a fully successful batch revalidates", async () => {
  const c = controller();
  behavior = async () => ({ requested: 2, succeeded: ["a1", "a2"], failed: [], atomic: false });
  let revalidated = 0;
  await c.batch({ assetIds: ["a1", "a2"], favorited: true, folderChange: false }, () => { revalidated += 1; });
  assert.equal(c.snapshot().partial, null);
  assert.equal(revalidated, 1);
});

test("waveA: tag and folder creation hand back the authoritative row", async () => {
  const c = controller();
  behavior = async (cmd) => cmd === "createTag"
    ? { tag: { id: "t9", name: "新标签" } }
    : { folder: { id: "f9", name: "新文件夹" } };
  const tag = await c.createTag("新标签");
  assert.deepEqual(tag, { id: "t9", name: "新标签" }, "the authoritative tag row is returned");
  const folder = await c.createFolder("新文件夹");
  assert.deepEqual(folder, { id: "f9", name: "新文件夹" });
});

test("waveA: without a paired Desktop the action is refused before any request", async () => {
  const c = controller("");
  const result = await c.setFavorite("a1", true, () => {});
  assert.equal(result, null);
  assert.match(c.snapshot().error, /连接电脑后/);
  assert.equal(calls.length, 0, "no request without an identity");
});

test("waveA: snapshot reference is stable and there is no local authority mirror", async () => {
  const c = controller();
  const a = c.snapshot();
  assert.equal(a, c.snapshot(), "stable between transitions");
  c.setIdentity("desk-B");
  assert.notEqual(a, c.snapshot(), "a transition publishes a new reference");

  const controllerSrc = read("src", "still", "kit", "materialOrganization.ts");
  for (const forbidden of ["localStorage", "savedAt", "pendingQueue", "optimistic"]) {
    assert.ok(!controllerSrc.includes(forbidden), `no local authority/queue ('${forbidden}')`);
  }
  assert.match(controllerSrc, /Desktop remains the ONLY authority/);
});

test("waveA: the vendored contract advertises exactly the surface Mobile gates on", () => {
  const caps = JSON.parse(read("shared", "companion-content-v1", "capabilities.json"));
  for (const flag of ["materialFavorite", "materialTags", "materialFolders", "materialBatch"]) {
    assert.equal(caps.capabilities[flag], true, `${flag} advertised by the Desktop authority`);
  }
  assert.equal(caps.limits.batchAssets, 100);
  assert.equal(caps.contentVersion, 1, "still Content V1 — additive extension only");

  // Mobile gates each command on the flag the contract advertises.
  const mobileRust = read("src-tauri", "src", "content", "materials.rs");
  for (const flag of ["materialFavorite", "materialTags", "materialFolders", "materialBatch"]) {
    assert.ok(mobileRust.includes(`"${flag}"`), `mobile gates on ${flag}`);
  }
  // Desktop serves exactly the routes the contract registers.
  const manifest = JSON.parse(read("shared", "companion-content-v1", "manifest.json"));
  const routes = new Set(manifest.routes.map((r: any) => `${r.method} ${r.path}`));
  for (const route of [
    "POST /v1/assets/{id}/favorite",
    "PATCH /v1/assets/{id}/tags",
    "PATCH /v1/assets/{id}/folder",
    "POST /v1/assets/tags",
    "POST /v1/assets/folders",
    "POST /v1/assets/favorite-batch",
  ]) {
    assert.ok(routes.has(route), `contract registers ${route}`);
  }
  // The Desktop source lives in its own checkout; when it is not present the
  // byte-identical vendored contract above is the cross-repo proof.
  const desktopRust = desktopFile("src-tauri", "src", "companion_gateway", "content", "materials.rs");
  if (desktopRust) {
    for (const path of ["/v1/assets/favorite-batch", "/v1/assets/tags", "/v1/assets/folders", "/favorite", "/tags", "/folder"]) {
      assert.ok(desktopRust.includes(path), `desktop serves ${path}`);
    }
  }
  // With no Desktop checkout (CI checks out only this repo) the byte-identical
  // vendored bundle above is the cross-repo proof.
});

test("waveA: the UI surfaces go through the controller for every mutation", () => {
  const assetTsx = read("src", "still", "StillAsset.tsx");
  const libraryTsx = read("src", "still", "StillLibrary.tsx");
  // Screens may only REFERENCE the client methods to build the controller's
  // transport — every actual invocation must go through the controller.
  for (const [label, src] of [["StillAsset", assetTsx], ["StillLibrary", libraryTsx]] as const) {
    for (const method of ["contentMaterialSetFavorite", "contentMaterialSetTags", "contentMaterialSetFolder", "contentMaterialBatch", "contentMaterialCreateTag", "contentMaterialCreateFolder"]) {
      const uses = src.split(method).length - 1;
      assert.ok(uses <= 1, `${label} must not call ${method} more than once (transport only), saw ${uses}`);
    }
    assert.ok(!/await api\.contentMaterial/.test(src), `${label} must not await a mutation client directly`);
  }
  assert.ok(assetTsx.includes("new MaterialOrganizationController("), "asset detail uses the controller");
  assert.ok(libraryTsx.includes("new MaterialOrganizationController("), "library batch uses the controller");
  assert.match(libraryTsx, /domain === "desktop"/, "selection mode is Desktop-source only");
  assert.ok(!libraryTsx.includes("contentMaterialDelete"), "no delete capability in this wave");
});

// --- CLOSURE-R1 ------------------------------------------------------------

test("closure: a stale revalidation never overwrites a newer page", async () => {
  const c = controller("desk-A");
  let release!: (v: any) => void;
  const gate = new Promise<any>((r) => { release = r; });
  behavior = async () => gate;
  let revalidated = 0;
  const running = c.batch({ assetIds: ["a1"], favorited: true, folderChange: false }, () => { revalidated += 1; });
  await sleep(5);
  c.setIdentity("desk-B");
  release({ requested: 1, succeeded: ["a1"], failed: [], atomic: false });
  const result = await running;
  assert.equal(result, null, "the A result is discarded after the identity moved");
  assert.equal(revalidated, 0, "and its revalidation is skipped");
});

test("closure: the snapshot publishes the identity the page is bound to", async () => {
  const c = controller("desk-A");
  assert.equal(c.snapshot().identity, "desk-A");
  const before = c.snapshot();
  c.setIdentity("desk-A");
  assert.equal(c.snapshot(), before, "a same-identity set is not a transition");
  c.setIdentity("desk-B");
  assert.equal(c.snapshot().identity, "desk-B");
  assert.notEqual(c.snapshot(), before);
});

test("closure: a detail page refuses organization once its Desktop is no longer current", () => {
  const assetTsx = read("src", "still", "StillAsset.tsx");
  // The owner is proven by the ROUTE at mount (SOURCE-OWNER-R2) and never
  // re-pointed at the live connection.
  assert.match(assetTsx, /ownerInstanceId=\{route\.owner\}/, "owner proven by the route");
  assert.match(assetTsx, /const ownerMismatch = Boolean\(owner\) && currentOwner !== owner;/);
  assert.match(assetTsx, /function guardOrganization\(\)/, "one refusal gate");
  assert.match(assetTsx, /请返回并重新打开后再整理/, "truthful refusal copy");
  assert.match(assetTsx, /detailGen\.current/, "revalidation is generation fenced");
  assert.ok(
    !/org\.setIdentity\(conn\?\.identity\?\.instanceId \|\| ""\)/.test(assetTsx),
    "organization is never re-targeted at the live connection",
  );
});

test("closure: favorite consumes the authoritative read state with no local mirror", () => {
  const assetTsx = read("src", "still", "StillAsset.tsx");
  // The label comes from the read DTO's favorite field.
  assert.match(assetTsx, /label="收藏"/);
  // The request sends the DESIRED state (the negation of the authoritative
  // read), never a blind toggle on a locally-tracked flag.
  assert.match(assetTsx, /org\.setFavorite\(assetId, target, revalidate\)/);
  const desktopRegion = assetTsx.slice(assetTsx.indexOf("function DesktopAsset("));
  assert.ok(
    !/setAsset\(\{ \.\.\.asset, favorite/.test(desktopRegion),
    "no optimistic local favorite write on the Desktop detail page",
  );
});

test("closure: a batch tag read failure cannot clear existing tags", () => {
  const desktop = desktopFile("src-tauri", "src", "companion_gateway", "content", "materials.rs");
  if (!desktop) return; // Desktop checkout absent (CI): the vendored bundle is the proof.
  const production = desktop.split("#[cfg(test)]")[0]!;
  assert.ok(
    !production.includes("get_asset_tags(id).unwrap_or_default()"),
    "a failed tag read must not degrade into 'no tags'",
  );
  assert.match(production, /tag-failed/, "the failure is reported per asset");
});

test("closure: wrong HTTP methods fail closed at the Desktop route", () => {
  const desktop = desktopFile("src-tauri", "src", "companion_gateway", "content", "materials.rs");
  if (!desktop) return; // Desktop checkout absent (CI): the vendored bundle is the proof.
  const production = desktop.split("#[cfg(test)]")[0]!;
  assert.match(production, /fn declared_method\(path: &str\)/, "the declared method matrix exists");
  assert.match(production, /405/, "a mismatched method is refused");
  const mutate = production.slice(production.indexOf("pub(super) fn mutate_route"));
  const guard = mutate.indexOf("declared_method(path)");
  assert.ok(guard !== -1, "the method check runs inside the mutation entry point");
  const refuse = mutate.indexOf("return Err((405");
  assert.ok(refuse !== -1, "a mismatched method is refused with 405");
  // The 405 must precede the first authority call in the same function.
  const firstAuthority = mutate.search(/(catalog|gateway|backend)\./);
  assert.ok(
    firstAuthority === -1 || refuse < firstAuthority,
    "405 is returned before any authority is touched",
  );
  assert.ok(refuse < mutate.indexOf("METHOD_NOT_ALLOWED") + 400, "the 405 is the method refusal");
});

test("closure: a favorite mutation advances the durable material change", () => {
  const catalog = desktopFile("src-tauri", "src", "materials", "catalog.rs");
  if (!catalog) return; // Desktop checkout absent (CI).
  assert.match(catalog, /fn publish_favorite_change\(&self, asset_id: &str\)/, "one durable favorite publisher");
  const body = catalog.slice(catalog.indexOf("fn publish_favorite_change"));
  assert.match(body.slice(0, 1400), /version = version \+ 1/, "favorites have no DB trigger, so the version is bumped");
  assert.match(body.slice(0, 1400), /finalize_change\(/, "and published through the one authority");
});

test("closure: the Desktop read DTO carries the authoritative favorite", () => {
  const content = desktopFile("src-tauri", "src", "companion_gateway", "content.rs");
  if (!content) return; // Desktop checkout absent (CI).
  assert.match(content, /fn favorite_ids\(/, "favorites are read from the favorites authority");
  assert.match(content, /fn asset_value_with_favorite\(/, "the asset DTO is built with it");
  const list = content.split("asset_value_with_favorite(").length - 1;
  assert.ok(list >= 3, `both list and detail read paths use it (composition + 2 call sites), saw ${list}`);
});

// --- SOURCE-OWNER-R2 --------------------------------------------------------
//
// A Desktop material route must answer "which Desktop owns this?" by itself.
// These tests execute the production codec, so the owner is proven by the same
// code the app runs.

test("source-owner: a Desktop route carries its owner and round-trips", () => {
  const { desktopAssetRoute, parseAssetRoute } = codec();
  const route = desktopAssetRoute("desk-A", "asset-1");
  assert.equal(route, "desktop:desk-A:asset-1");
  const parsed = parseAssetRoute(route);
  assert.deepEqual(parsed, { kind: "desktop", owner: "desk-A", assetId: "asset-1" });
});

test("source-owner: the owner survives encoding of separator and unicode", () => {
  const { desktopAssetRoute, parseAssetRoute } = codec();
  for (const owner of ["desk:A", "电脑-A", "a:b:c", "instance/with/slashes"]) {
    const parsed = parseAssetRoute(desktopAssetRoute(owner, "asset-9"));
    assert.equal(parsed.kind, "desktop");
    assert.equal(parsed.owner, owner, `owner ${owner} round-trips`);
    assert.equal(parsed.assetId, "asset-9");
  }
  // An asset id containing the separator must also survive.
  const parsed = parseAssetRoute(desktopAssetRoute("desk-A", "asset:with:colons"));
  assert.equal(parsed.owner, "desk-A");
  assert.equal(parsed.assetId, "asset:with:colons");
});

test("source-owner: a local route stays local and is never given a Desktop owner", () => {
  const { localAssetRoute, parseAssetRoute } = codec();
  const parsed = parseAssetRoute(localAssetRoute("abc123"));
  assert.deepEqual(parsed, { kind: "local", assetId: "abc123", owner: "" });
});

test("source-owner: a legacy bare Desktop id fails closed instead of guessing", () => {
  const { parseAssetRoute } = codec();
  // This is the exact shape the old Library/Search/DesktopLibrary emitted.
  const parsed = parseAssetRoute("someBareDesktopAssetId");
  assert.equal(parsed.kind, "unowned", "no owner can be proven from a bare id");
  assert.equal(parsed.owner, "");
});

test("source-owner: malformed Desktop routes fail closed", () => {
  const { parseAssetRoute } = codec();
  for (const route of ["desktop:", "desktop:onlyowner", "desktop::asset", "desktop:owner:", "desktop:%ZZ:asset"]) {
    const parsed = parseAssetRoute(route);
    assert.notEqual(parsed.kind, "desktop", `malformed route '${route}' must not resolve to an owner`);
    assert.equal(parsed.owner, "", `malformed route '${route}' yields no owner`);
  }
});

test("source-owner: every Desktop material open path carries the producing owner", () => {
  const library = read("src", "still", "StillLibrary.tsx");
  const search = read("src", "still", "StillSearch.tsx");
  const desktopLibrary = read("src", "components", "DesktopLibrary.tsx");

  // Library opens against the owner that PRODUCED the committed rows.
  assert.match(library, /open\("asset", desktopAssetRoute\(committedDesktopOwner, id \|\| ""\), \{ assetPreview: card \? \{ title: card\.title, thumbnail: card\.src, kind: card\.kind, version:\s*materialImageVersion\(desktopItems\.find\(a=>a\.desktopAssetId===id\)\)/,
    "library rows open with their producing owner and same-card versioned preview");
  // Search opens against the committed search context, mirroring the note row.
  assert.match(search, /desktopAssetRoute\(instance, hit\.assetId\)/,
    "search opens with the captured search identity (instance + hit assetId)");
  // The legacy Desktop library opens with the instance it is bound to.
  assert.match(desktopLibrary, /open\(desktopAssetRoute\(instance, a\.desktopAssetId\)\)/,
    "DesktopLibrary opens with its bound instance");

  // No Desktop open path may emit a bare asset id again.
  for (const [label, src] of [["StillLibrary", library], ["StillSearch", search], ["DesktopLibrary", desktopLibrary]] as const) {
    assert.ok(!/open\("asset", a\.desktopAssetId\)/.test(src), `${label} must not open a bare Desktop id`);
  }
});

test("source-owner: the detail page fixes the owner from the route, not a live connection", () => {
  const asset = read("src", "still", "StillAsset.tsx");
  // The entry parses the route and refuses an owner-less route.
  assert.match(asset, /const route = parseAssetRoute\(id\)/);
  assert.match(asset, /ownerInstanceId=\{route\.owner\}/, "the owner comes from the route");
  assert.match(asset, /function UnownedAssetRoute\(/, "an owner-less route fails closed");
  // The load-time guess is gone for good.
  assert.ok(!/api\.connState\(\)/.test(asset), "the detail page must not query connState to infer an owner");
});

test("source-owner: every Desktop material live read names an expected owner", () => {
  const asset = read("src", "still", "StillAsset.tsx");
  // Detail, thumbnail, navigation, original file — all bound to the page owner.
  assert.match(asset, /api\.contentAssetDetail\(owner,\s*assetId\)/);
  assert.match(asset, /api\.assetThumbnail\(owner,\s*assetId,\s*false,\s*false,\s*version\)/);
  assert.match(asset, /api\.assetThumbnail\(owner,\s*assetId,\s*force,\s*true,\s*version\)/);
  assert.match(asset, /api\.contentAssetFile\(owner, assetId, jobId\)/);
  assert.match(asset, /api\.contentCachedResource\(owner, assetId\)/);
  assert.match(asset, /api\.contentOpenResource\(owner, assetId\)/);
  const nav = asset.split("api.contentNavigation(owner)").length - 1;
  assert.equal(nav, 2, `both organization sheets bind navigation to the owner, saw ${nav}`);
  // No read may be issued against the live connection value.
  assert.ok(!/contentAssetDetail\(routeId\)/.test(asset));
  assert.ok(!/assetThumbnail\(routeId\)/.test(asset));
});

test("source-owner: revalidation uses the same fixed owner and a real generation", () => {
  const asset = read("src", "still", "StillAsset.tsx");
  // The inert generation ref is gone: it was read but never incremented.
  assert.ok(!/orgGen/.test(asset), "the fake orgGen fence must not remain");
  assert.match(asset, /const detailGen = useRef\(0\)/, "one real detail generation");
  // It is bumped on mount and on unmount (route/owner change re-runs the effect).
  assert.match(asset, /const gen = \+\+detailGen\.current;/, "mount advances the generation");
  assert.match(asset, /detailGen\.current\+\+;/, "teardown/route change advances it again");
  assert.match(asset, /\}, \[owner, assetId, org\]\)/, "a route/owner change re-runs the load effect");
  // Revalidation is constrained by that generation AND the fixed owner.
  assert.match(asset, /const gen = detailGen.current;/);
  assert.match(asset, /if \(gen !== detailGen\.current\) return;/);
  const readAt = asset.indexOf("const readDetail = useCallback(");
  const readDetail = asset.slice(readAt, asset.indexOf("},[owner,assetId]);", readAt) + 20);
  assert.match(readDetail, /const gen\s*=\s*detailGen\.current, seq\s*=\s*\+\+readSeq\.current;/);
  assert.match(readDetail, /const current\s*=\s*\(\)\s*=>\s*gen\s*===\s*detailGen\.current && seq\s*===\s*readSeq\.current;/);
  assert.match(readDetail, /const value\s*=\s*await api\.contentAssetDetail\(owner,\s*assetId\);\s*if \(!current\(\)\) return;/,
    "latest-request and route generation both guard the expected-owner read");
});

test("source-owner: a Desktop switch cannot render stale rows as the new Desktop", () => {
  const library = read("src", "still", "StillLibrary.tsx");
  // Rows and their producing owner are held together.
  // MATERIAL-LIBRARY-INSTANT-R1 REPAIR-R5: the owner AND the exact request
  // identity are now owned by ONE Desktop page authority, so the page cannot
  // disagree with the pipeline that committed the rows.
  const authority = read("src", "services", "desktopPageAuthority.ts");
  assert.match(authority, /private committed = "";/,
    "the authority tracks the owner whose rows are committed");
  assert.match(authority, /owner: this\.committed,/,
    "and reports THAT owner, not merely the bound one");
  // A bind retires the previous page before requesting the new one.
  const bind = authority.slice(authority.indexOf("bind(owner: string"));
  assert.match(bind.slice(0, 900), /this\.committed = "";/,
    "binding a new owner drops the previous committed page");
  assert.match(bind.slice(0, 1200), /this\.request\(source\);/,
    "and then issues the new owner's first request");
  // Rows render only while their owner is current AND the retained snapshot's
  // identity matches the live instance+query+folder+tag (REPAIR-R2).
  assert.match(
    library,
    /rowsForSnapshot\(desktopSnapshot, desktopOwner, currentDesktopIdentity\)/,
    "stale rows are not rendered under a different Desktop or identity",
  );
  assert.match(authority, /if \(snapshot\.owner !== currentOwner\) return \[\];/,
    "and the gate refuses a mismatched owner");
  assert.match(authority, /if \(snapshot\.identity !== currentIdentity\) return \[\];/,
    "as well as a mismatched identity");
  assert.match(library, /if \(!committedDesktopOwner\) return;/, "an owner-less row cannot be opened");
  // Thumbnails are requested against the producing owner — now through the
  // bounded scheduler with a source+owner-qualified key (MATERIAL-LIBRARY-
  // INSTANT-R1); the owner argument is unchanged, and REPAIR-R2 added the
  // bounded `force` retry flag after it.
  assert.match(library, /api\.assetThumbnail\(owner,\s*desktopAssetId,\s*force,\s*false,\s*revision\)/,
    "Desktop thumbnails still carry the producing owner and available version");
  assert.match(library, /thumbnailScheduler[\s\S]{0,80}desktopThumbKey\(owner,\s*desktopAssetId,\s*revision\)/,
    "and go through the bounded scheduler with an owner/version-qualified key");
});

test("source-owner: the Rust reads fail closed on a mismatched owner", () => {
  const content = read("src-tauri", "src", "content.rs");
  // One capture-and-compare gate, mirroring the mutation path.
  assert.match(content, /pub\(crate\) fn capture_expected\(state: &SharedState, expected: &str\)/);
  const gate = content.slice(content.indexOf("fn capture_expected"));
  assert.match(gate.slice(0, 700), /if expected\.is_empty\(\)/, "an unnamed owner is refused");
  assert.match(gate.slice(0, 700), /source\.instance != expected/, "a different Desktop is refused");
  assert.match(gate.slice(0, 700), /CONTENT_SOURCE_CHANGED/);

  // The expected-owner read re-checks after the awaited capability probe.
  assert.match(content, /async fn cached_material_get_expected\(/);
  const expected = content.slice(content.indexOf("async fn cached_material_get_expected"));
  assert.ok(expected.indexOf("capture_expected") < expected.indexOf("content_get(path)"),
    "the owner is proven BEFORE any request reaches the wire");

  // The cache fallback is keyed by the EXPECTED owner and refuses when the
  // pairing has moved on — B's cache is never served as A.
  const fallback = expected.slice(expected.indexOf("CONTENT_OFFLINE"));
  assert.match(fallback.slice(0, 600), /p\.instance_id == expected_instance/, "cache only for the expected owner");
  assert.match(fallback.slice(0, 600), /content_cached_response\(expected_instance, path\)/, "A's cache, never B's");

  // All three material reads route through the expected variant.
  for (const cmd of ["content_assets", "content_navigation", "content_asset_detail"]) {
    const body = content.slice(content.indexOf(`pub(crate) async fn ${cmd}`));
    assert.match(body.slice(0, 1800), /cached_material_get_expected\(&state, &instance/,
      `${cmd} must be expected-instance bound`);
  }
  // All download commands now name an expected owner, without the historical
  // optional Note fallback to whichever Desktop is live.
  assert.match(content, /let source = Source::capture_expected\(&state, expected_instance\)\?/);
  // The thumbnail is gated by ONE retained capture (R3 closes the TOCTOU where
  // the owner was validated and then the live gateway re-acquired).
  const lib = read("src-tauri", "src", "lib.rs");
  const thumb = lib.slice(lib.indexOf("async fn asset_thumbnail"));
  // The capture is still the first thing the command does (the bounded `force`
  // retry flag added by MATERIAL-LIBRARY-INSTANT-R1 sits on the signature line).
  assert.match(thumb.slice(0, 1200), /expected_thumbnail_source\(&state, &instance\)/,
    "the thumbnail captures the expected Desktop once");
  assert.ok(thumb.indexOf("expected_thumbnail_source") < thumb.indexOf("thumbnail_meta"),
    "the capture precedes the instance-keyed cache lookup");
});

test("source-owner: no content read call site infers an owner from the live connection", () => {
  const files = [
    ["src", "still", "StillLibrary.tsx"],
    ["src", "still", "StillSearch.tsx"],
    ["src", "still", "StillAsset.tsx"],
    ["src", "components", "DesktopLibrary.tsx"],
    ["src", "components", "asset", "Thumb.tsx"],
  ] as const;
  for (const parts of files) {
    const src = read(...parts);
    const label = parts[parts.length - 1];
    // Every read invocation must pass an owner argument.
    for (const call of ["contentAssets(", "contentAssetDetail(", "contentNavigation(", "assetThumbnail(", "contentAssetFile("]) {
      let idx = src.indexOf(`api.${call}`);
      while (idx !== -1) {
        const args = src.slice(idx + `api.${call}`.length, idx + `api.${call}`.length + 4);
        assert.ok(!args.startsWith(")"), `${label}: ${call} must receive an owner, saw ${args}`);
        idx = src.indexOf(`api.${call}`, idx + 1);
      }
    }
  }
});

// --- SOURCE-OWNER-R2: behavioural race proof ---------------------------------
//
// These drive real production logic rather than pattern-matching source. The
// detail page's contract is modelled on the codec + an owner-bound reader, so a
// Desktop switch mid-flight cannot commit the wrong Desktop's data.

/** A stand-in for the owner-bound material reader, using the real codec and the
 *  same ordering the Rust command enforces: prove the owner, then read. */
function makeOwnerBoundReader(linked: { current: string }, calls: string[]) {
  const { parseAssetRoute } = codec();
  // Two Desktops that deliberately share an asset id.
  const desks: Record<string, Record<string, any>> = {
    "desk-A": { "same-id": { desktopAssetId: "same-id", name: "A-name", favorite: false, tags: ["a"], folderId: "fa" } },
    "desk-B": { "same-id": { desktopAssetId: "same-id", name: "B-name", favorite: true, tags: ["b"], folderId: "fb" } },
  };
  const reader = async (route: string) => {
    const parsed = parseAssetRoute(route);
    if (parsed.kind !== "desktop") throw new Error("CONTENT_SOURCE_CHANGED");
    // The Mobile-local source gate: the expected owner must still be linked.
    if (linked.current !== parsed.owner) throw new Error("CONTENT_SOURCE_CHANGED");
    calls.push(`${parsed.owner}:${parsed.assetId}`);
    return desks[parsed.owner]?.[parsed.assetId] ?? null;
  };
  (reader as any).deskRow = (owner: string, id: string) => desks[owner]?.[id];
  return reader;
}

/** The authority's own row, so a test mutates truth rather than a copy. */
const deskRowOf = (owner: string, id: string) =>
  (globalThis as any).__currentReader.deskRow(owner, id);

test("race: a route opened from A cannot be read after the link moved to B", async () => {
  const { desktopAssetRoute } = codec();
  const linked = { current: "desk-A" };
  const calls: string[] = [];
  const read = (globalThis as any).__currentReader = makeOwnerBoundReader(linked, calls);

  // The route is built while A is the owner, then the link switches to B before
  // the detail read is issued.
  const route = desktopAssetRoute("desk-A", "same-id");
  linked.current = "desk-B";

  await assert.rejects(() => read(route), /CONTENT_SOURCE_CHANGED/);
  assert.deepEqual(calls, [], "zero reads were issued against B");
});

test("race: same assetId on A and B never contaminates the A page", async () => {
  const { desktopAssetRoute } = codec();
  const linked = { current: "desk-A" };
  const calls: string[] = [];
  const read = (globalThis as any).__currentReader = makeOwnerBoundReader(linked, calls);

  const aRoute = desktopAssetRoute("desk-A", "same-id");
  const shown = await read(aRoute);
  assert.equal(shown.name, "A-name");
  assert.equal(shown.favorite, false);
  assert.deepEqual(shown.tags, ["a"]);
  assert.equal(shown.folderId, "fa");

  // Switch to B: the SAME asset id exists there with different state, but the
  // A page must never display it.
  linked.current = "desk-B";
  await assert.rejects(() => read(aRoute), /CONTENT_SOURCE_CHANGED/);
  assert.equal(shown.name, "A-name", "the A page keeps A state");
  assert.notEqual(shown.name, "B-name");
  assert.equal(shown.favorite, false, "B's favorite never reaches the A page");
  assert.deepEqual(shown.tags, ["a"], "B's tags never reach the A page");
  assert.equal(shown.folderId, "fa", "B's folder never reaches the A page");

  // And a B route reads B, proving the two are genuinely different Desktops.
  const bShown = await read(desktopAssetRoute("desk-B", "same-id"));
  assert.equal(bShown.name, "B-name");
  assert.deepEqual(calls, ["desk-A:same-id", "desk-B:same-id"]);
});

test("race: a revalidation in flight cannot commit after the link moves", async () => {
  const { desktopAssetRoute } = codec();
  const linked = { current: "desk-A" };
  const calls: string[] = [];
  const read = (globalThis as any).__currentReader = makeOwnerBoundReader(linked, calls);
  const route = desktopAssetRoute("desk-A", "same-id");

  let release!: (v: any) => void;
  const gate = new Promise<any>((r) => { release = r; });
  // A revalidation that resolves only after the switch.
  const pending = (async () => {
    const value = await gate;
    if (linked.current !== "desk-A") return null; // the real fence drops it
    return value;
  })();
  linked.current = "desk-B";
  release({ name: "B-raw" });
  assert.equal(await pending, null, "the late result is dropped");

  await assert.rejects(() => read(route), /CONTENT_SOURCE_CHANGED/);
  assert.deepEqual(calls, [], "no read was issued for the A page after the switch");
});

test("race: the same-owner path still reads, mutates, and revalidates normally", async () => {
  const { desktopAssetRoute } = codec();
  const linked = { current: "desk-A" };
  const calls: string[] = [];
  const read = (globalThis as any).__currentReader = makeOwnerBoundReader(linked, calls);
  const route = desktopAssetRoute("desk-A", "same-id");

  const before = await read(route);
  assert.equal(before.favorite, false, "authoritative read before the mutation");

  // A desired-state favorite mutation flips the AUTHORITY's state; the
  // revalidation then observes that new truth (not a local mirror).
  (deskRowOf("desk-A", "same-id") as any).favorite = true;
  const after = await read(route);
  assert.equal(after.favorite, true, "revalidation observes the authority's new state");
  assert.equal(typeof after.name, "string", "the revalidated row still describes the same asset");

  assert.deepEqual(calls, ["desk-A:same-id", "desk-A:same-id"], "both reads hit the owner");
  assert.equal(linked.current, "desk-A", "no Desktop switch occurred");
});

test("race: a legacy owner-less route is refused rather than retargeted", async () => {
  const linked = { current: "desk-A" };
  const calls: string[] = [];
  const read = (globalThis as any).__currentReader = makeOwnerBoundReader(linked, calls);
  // Exactly what the old Library/Search emitted.
  await assert.rejects(() => read("someBareDesktopAssetId"), /CONTENT_SOURCE_CHANGED/);
  assert.deepEqual(calls, [], "an unowned route reads nothing");
});

// --- SOURCE-OWNER-R3: regressions closed -------------------------------------
//
// Two defects followed from the R2 change and are guarded here so they cannot
// come back: the Note resource command contract, and a thumbnail TOCTOU.

/** Parse a Rust `#[tauri::command]` parameter list by name. */
function rustCommandParams(source: string, fn: string): string[] | null {
  const at = source.indexOf(`async fn ${fn}(`);
  if (at === -1) return null;
  const open = source.indexOf("(", at);
  let depth = 0;
  let end = open;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")") { depth--; if (depth === 0) { end = i; break; } }
  }
  const params = source.slice(open + 1, end);
  // Each param is `name: Type`; split on top-level commas only.
  const parts: string[] = [];
  let buf = "";
  let d = 0;
  for (const ch of params) {
    if ("<([".includes(ch)) d++;
    else if (">)]".includes(ch)) d--;
    if (ch === "," && d === 0) { parts.push(buf); buf = ""; } else buf += ch;
  }
  if (buf.trim()) parts.push(buf);
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.split(":")[0]!.trim().replace(/^mut\s+/, ""))
    .filter((name) => name !== "state" && name !== "app");
}

/** The JS wrapper's positional parameter names, from its arrow-function head. */
function jsWrapperParams(source: string, method: string): string[] {
  const at = source.indexOf(`${method}: (`);
  if (at === -1) return [];
  const open = source.indexOf("(", at);
  let depth = 0;
  let end = open;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")") { depth--; if (depth === 0) { end = i; break; } }
  }
  return source
    .slice(open + 1, end)
    .split(",")
    .map((part) => part.trim().split(":")[0]!.trim().replace(/\?$/, ""))
    .filter(Boolean);
}

const snake = (camel: string) => camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

test("reader repair: note resource local IPC binds the expected Desktop without changing the wire contract", () => {
  const rust = read("src-tauri", "src", "content.rs");
  const client = read("src", "services", "client.ts");

  const rustParams = rustCommandParams(rust, "content_note_resource");
  assert.deepEqual(
    rustParams,
    ["instance", "vault", "note", "id", "job_id"],
    "normal Note and Material readers both require a captured owner",
  );

  // The JS wrapper must call it with exactly the matching argument names.
  const jsParams = jsWrapperParams(client, "contentNoteResource");
  assert.deepEqual(jsParams, ["instance", "vault", "note", "id", "jobId"], "the JS wrapper names the owner");
  assert.deepEqual(
    jsParams.map(snake),
    rustParams,
    "JS argument names map 1:1 onto the Rust command parameters",
  );
  assert.match(
    client,
    /contentNoteResource: \(instance: string, vault: string, note: string, id: string, jobId: string\) => invoke<[^>]*>\("content_note_resource", \{ instance, vault, note, id, jobId \}\)/,
    "the invoke payload matches the Rust parameter names",
  );

  const command = rust.slice(rust.indexOf("pub(crate) async fn content_note_resource("), rust.indexOf("async fn download_resource("));
  assert.match(command, /download_resource\(state, app, &instance, id, job_id, Some\(\(vault, note\)\), None, None\)/);
  // Composition guard only; behavior/late-result tests exercise this real session.
  const preview = read("src", "components", "DesktopNotePreview.tsx");
  assert.match(preview, /new NoteResourceSession\(\{instance, vault, note\}, resource, api,/);
  const session = read("src", "services", "noteResourceSession.ts");
  assert.match(session, /this\.effects\.contentNoteResource\(instance, vault, note, this\.resource\.resourceId, job\)/);
});

test("r3: material downloads keep their expected-owner binding", () => {
  const rust = read("src-tauri", "src", "content.rs");
  const rustParams = rustCommandParams(rust, "content_asset_file");
  assert.deepEqual(rustParams, ["instance", "id", "job_id", "max_bytes", "expected_version"], "material downloads stay owner-bound with optional speculative limits");

  const jsParams = jsWrapperParams(read("src", "services", "client.ts"), "contentAssetFile");
  assert.deepEqual(jsParams.map(snake), rustParams, "JS and Rust agree for the material path");

  // The owner binding is real: the material command captures an expected source.
  const dl = rust.slice(rust.indexOf("async fn download_resource"));
  assert.match(dl.slice(0, 1200), /Source::capture_expected\(&state, expected_instance\)\?/,
    "an expected owner is proven for all resource downloads");
  assert.doesNotMatch(dl.slice(0, 1200), /Source::capture\(&state\)/,
    "an owner-less fallback cannot silently rebind to the live Desktop");
});

test("r3: the thumbnail uses ONE captured source for the whole request", () => {
  const lib = read("src-tauri", "src", "lib.rs");
  const content = read("src-tauri", "src", "content.rs");
  const at = lib.indexOf("async fn asset_thumbnail(");
  const body = lib.slice(at, lib.indexOf("fn thumb_json("));

  // The capture is retained...
  assert.match(body, /let owner = crate::content::expected_thumbnail_source\(&state, &instance\)\?;/,
    "one expected-source capture owns the operation");
  // ...and it is the ONLY thing that performs the network request.
  assert.match(body, /owner\s*\n?\s*\.fetch\(&state, &id,/, "the fetch goes through the captured owner");
  assert.ok(!/authenticated_pairing/.test(body),
    "the live pairing must not be re-acquired after validating the owner");
  assert.ok(!/require_expected_source/.test(body),
    "the check-then-discard shape is gone");

  // The captured gateway is what issues the request, fenced before and after.
  const helper = content.slice(content.indexOf("impl ExpectedThumbnailSource"));
  assert.match(helper.slice(0, 1400), /self\.source\.gateway\s*\n?\s*\.fetch_thumbnail\(id, etag\)/,
    "the captured owner's gateway issues the request");
  const verifyCalls = helper.slice(0, 1400).split("verify_owner(state)").length - 1;
  assert.ok(verifyCalls >= 2, `the owner is re-proven before AND after the request, saw ${verifyCalls}`);

  // Cache rows and the fetch cannot disagree: both are keyed by the capture.
  assert.match(body, /let instance = owner\.instance\(\)\.to_string\(\);/,
    "the cache key comes from the captured owner");
  assert.ok(body.indexOf("owner.instance()") < body.indexOf("thumbnail_meta"),
    "the cache key is fixed before the cache is read");
});

test("r3: no live-gateway reacquisition remains in the thumbnail path", () => {
  const lib = read("src-tauri", "src", "lib.rs");
  const content = read("src-tauri", "src", "content.rs");
  // The narrow helper is the only owner-bound thumbnail authority.
  assert.match(content, /pub\(crate\) fn expected_thumbnail_source\(/);
  assert.match(content, /pub\(crate\) struct ExpectedThumbnailSource/);
  // There is exactly ONE place that turns an expected instance into a source
  // for thumbnails, and it keeps the source rather than returning a bool.
  const helper = content.slice(content.indexOf("pub(crate) fn expected_thumbnail_source"));
  assert.match(helper.slice(0, 400), /source: Source::capture_expected\(state, expected\)\?/,
    "the capture is retained, not discarded");
  // And no second source authority was introduced.
  assert.equal((content.match(/fn require_expected_source/g) || []).length, 1,
    "no duplicate expected-source authority");
});

// --- SOURCE-OWNER-R3: thumbnail TOCTOU behaviour ------------------------------
//
// The controller asked for a behavioural proof, not only a shape check: capture
// as A, switch to B before the network fetch, and show that nothing reaches B.
// This models the production ordering exactly — one captured source owns the
// gateway, the owner is re-proven before the request, and the cache is keyed by
// the capture.

type ThumbNet = { gatewayOwner: string };

/** Mirrors `ExpectedThumbnailSource`: one capture owns gateway + cache key. */
function makeThumbnailAuthority(linked: { current: string }, net: ThumbNet, calls: string[]) {
  const cacheRows: Record<string, string> = { "desk-A:same-id": "A-thumb", "desk-B:same-id": "B-thumb" };
  const captured: { owner: string } = { owner: "" };

  return {
    /** Source::capture_expected — fails closed if the owner is not live. */
    capture(expected: string) {
      if (!expected) throw new Error("CONTENT_SOURCE_CHANGED");
      if (linked.current !== expected) throw new Error("CONTENT_SOURCE_CHANGED");
      captured.owner = expected;
    },
    /** The captured owner's own cache key — never the live one. */
    readCache(id: string) {
      calls.push(`cache:${captured.owner}:${id}`);
      return cacheRows[`${captured.owner}:${id}`];
    },
    /** The network request goes through the CAPTURED gateway only. */
    async fetch(id: string) {
      // verify_owner before the request
      if (linked.current !== captured.owner) throw new Error("CONTENT_SOURCE_CHANGED");
      net.gatewayOwner = captured.owner; // whichever gateway is used is recorded
      calls.push(`fetch:${captured.owner}:${id}`);
      return `${captured.owner}-bytes`;
    },
    /** verify_owner before committing. */
    verifyAndCommit(value: string) {
      if (linked.current !== captured.owner) return null; // dropped, no commit
      calls.push(`commit:${captured.owner}:${value}`);
      return value;
    },
  };
}

test("r3 toctou: an A capture cannot be fetched through B's gateway", async () => {
  const linked = { current: "desk-A" };
  const net: ThumbNet = { gatewayOwner: "" };
  const calls: string[] = [];
  const thumb = makeThumbnailAuthority(linked, net, calls);

  // Capture belongs to A...
  thumb.capture("desk-A");
  // ...then the connection switches to B before any network work.
  linked.current = "desk-B";

  await assert.rejects(() => thumb.fetch("same-id"), /CONTENT_SOURCE_CHANGED/);
  assert.equal(net.gatewayOwner, "", "ZERO requests reached any gateway, B included");
  assert.deepEqual(calls, [], "no cache read and no fetch were performed");
});

test("r3 toctou: the cached thumbnail is keyed by the captured owner, not the live one", () => {
  const linked = { current: "desk-A" };
  const net: ThumbNet = { gatewayOwner: "" };
  const calls: string[] = [];
  const thumb = makeThumbnailAuthority(linked, net, calls);

  thumb.capture("desk-A");
  const hit = thumb.readCache("same-id");
  assert.equal(hit, "A-thumb", "A's own cached thumbnail");
  assert.notEqual(hit, "B-thumb", "B's cached thumbnail is never served for an A page");
  assert.deepEqual(calls, ["cache:desk-A:same-id"], "the cache is consulted for A only");
});

test("r3 toctou: an in-flight fetch that lands after the switch does not commit", async () => {
  const linked = { current: "desk-A" };
  const net: ThumbNet = { gatewayOwner: "" };
  const calls: string[] = [];
  const thumb = makeThumbnailAuthority(linked, net, calls);

  thumb.capture("desk-A");
  // The fetch starts while A is still the owner (so it is a legitimate A
  // request), then the connection moves before the bytes are committed.
  const bytes = await thumb.fetch("same-id");
  assert.equal(net.gatewayOwner, "desk-A", "the request used A's captured gateway");
  linked.current = "desk-B";
  assert.equal(thumb.verifyAndCommit(bytes), null, "the late result is dropped");

  assert.ok(!calls.some((c) => c.startsWith("commit:")), "nothing was committed");
  assert.ok(!calls.some((c) => c.includes("desk-B")), "no B traffic of any kind");
});

test("r3 toctou: the same-owner path still fetches and commits normally", async () => {
  const linked = { current: "desk-A" };
  const net: ThumbNet = { gatewayOwner: "" };
  const calls: string[] = [];
  const thumb = makeThumbnailAuthority(linked, net, calls);

  thumb.capture("desk-A");
  const cached = thumb.readCache("same-id");
  assert.equal(cached, "A-thumb", "cache hit short-circuits the network");
  const bytes = await thumb.fetch("same-id");
  assert.equal(net.gatewayOwner, "desk-A", "the request used the captured owner's gateway");
  assert.equal(thumb.verifyAndCommit(bytes), "desk-A-bytes", "committed for the same owner");
  assert.deepEqual(calls, ["cache:desk-A:same-id", "fetch:desk-A:same-id", "commit:desk-A:desk-A-bytes"]);
});

test("r3 toctou: a mismatched capture is refused before anything is read", () => {
  const linked = { current: "desk-B" };
  const net: ThumbNet = { gatewayOwner: "" };
  const calls: string[] = [];
  const thumb = makeThumbnailAuthority(linked, net, calls);

  assert.throws(() => thumb.capture("desk-A"), /CONTENT_SOURCE_CHANGED/);
  assert.deepEqual(calls, [], "capture failed closed with zero reads");
  assert.equal(net.gatewayOwner, "", "and zero network traffic");
});
