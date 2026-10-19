// Behavior coverage for read-only registered-vault folders and typed links.
// Run with node --experimental-strip-types --test tests/knowledgeNavigation.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  KnowledgeFolderCatalog, folderAncestors, folderChildren, folderScopeKey,
  folderStatus, safeFolderPath, type FolderScope, type FolderSnapshot,
} from "../src/still/kit/knowledgeFolderCatalog.ts";
import {
  KnowledgeRelations, resolveWikiReference, relationsStatus,
  type RelationScope, type RelationSnapshot, type WikiReference,
} from "../src/still/kit/knowledgeRelations.ts";
import { safeWikiTarget, wikiSyntax } from "../src/still/kit/wikiSyntax.ts";
import { createKnowledgeNavigationReader } from "../src/services/knowledgeNavigationReader.ts";
import { KnowledgeLiveSync } from "../src/services/knowledgeLiveSync.ts";
import type { ChangeFeedClient } from "../src/services/companionServices/changeFeedClient.ts";
import { KnowledgeClient } from "../src/services/companionServices/knowledgeClient.ts";
import { ServicesError, type ServicesRequest } from "../src/services/companionServices/transport.ts";
import { ServiceRegistry } from "../src/services/companionServices/serviceRegistry.ts";
import type { KnowledgeDirectoryPage, KnowledgeRelation, KnowledgeRelationPage } from "../shared/companion-services-v1/types.ts";

const scope: FolderScope = { instance: "desktop-A", vault: "vault-A" };
const noteScope: RelationScope = { ...scope, note: "note-A" };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function memoryStorage() {
  const entries = new Map<string, string>(), writes: [string, string][] = [], removed: string[] = [];
  return {
    entries, writes, removed,
    getItem(key: string) { return entries.get(key) ?? null; },
    setItem(key: string, value: string) { entries.set(key, value); writes.push([key, value]); },
    removeItem(key: string) { entries.delete(key); removed.push(key); },
  };
}

for (const code of ["SERVICE_UNAVAILABLE", "AUTH_REVOKED"]) {
  test(`a retired capability refresh ${code} cannot overwrite a new A → B → A folder activation`, async () => {
    const capability = deferred<void>(), storage = memoryStorage();
    const catalog = new KnowledgeFolderCatalog({
      directories: async (instance, vault) => folders([instance === scope.instance ? "Current A" : "Current B"], null, vault),
      refresh: () => capability.promise,
    }, async () => [], storage);
    await catalog.activate(scope, true);
    const stale = catalog.refresh(scope, true);
    await catalog.activate({ instance: "desktop-B", vault: scope.vault }, true);
    await catalog.activate(scope, true);
    const current = catalog.snapshot(scope), saved = [...storage.entries];
    capability.reject(Object.assign(new Error(code), { code }));
    await stale;
    assert.equal(catalog.snapshot(scope), current);
    assert.equal(current.phase, "ready");
    assert.deepEqual(current.paths, ["Current A"]);
    assert.deepEqual([...storage.entries], saved);
  });
}
function folders(paths: string[], nextAfterPath: string | null = null, vault = scope.vault): KnowledgeDirectoryPage {
  return { vaultId: vault, items: paths.map(parentRelativePath => ({ parentRelativePath })), hasMore: nextAfterPath !== null, nextAfterPath };
}
function wiki(target = "Target", noteIds = ["resolved-note"], line = 1, status: "resolved" | "ambiguous" | "unresolved" = "resolved"): KnowledgeRelation {
  return { kind: "wikiLink", target, line, status, noteIds };
}
function relationPage(items: KnowledgeRelation[], revision = "r1", nextAfter: string | null = null, identity = noteScope): KnowledgeRelationPage {
  return { vaultId: identity.vault, noteId: identity.note, items, revision, hasMore: nextAfter !== null, nextAfter };
}
function relationSnapshot(items: KnowledgeRelation[] = [wiki()], extra: Partial<RelationSnapshot> = {}): RelationSnapshot {
  return { ...noteScope, phase: "ready", revision: "r1", items, ...extra };
}
const reference: WikiReference = { target: "Target", label: "An alias", line: 1, from: 0, to: 20 };

test("folders accept the root empty-string cursor and certify only after every page", async () => {
  const last = deferred<KnowledgeDirectoryPage>(), storage = memoryStorage();
  const calls: any[][] = [], emitted: FolderSnapshot[] = [];
  let legacyCalls = 0;
  const catalog = new KnowledgeFolderCatalog({ directories: async (...args) => {
    calls.push(args);
    if (calls.length === 1) return folders([""], "");
    if (calls.length === 2) return folders(["Empty", "Projects", "Projects/Nested"], "Projects/Nested");
    return last.promise;
  } }, async () => { legacyCalls++; return ["from-note-page"]; }, storage);
  catalog.subscribe(() => emitted.push(catalog.snapshot(scope)));
  const pending = catalog.activate(scope, true);
  await tick();
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(args => args[2]), [
    { limit: 100, afterPath: undefined }, { limit: 100, afterPath: "" },
    { limit: 100, afterPath: "Projects/Nested" },
  ]);
  assert.ok(calls.every(([instance, vault]) => instance === scope.instance && vault === scope.vault));
  assert.equal(catalog.snapshot(scope).complete, false);
  assert.deepEqual(catalog.snapshot(scope).paths, [], "a prefix of a catalog is not a complete inventory");
  assert.equal(storage.writes.length, 0);
  last.resolve(folders(["Projects/Nested", "Unused empty directory"]));
  await pending;
  const ready = catalog.snapshot(scope);
  assert.equal(ready.phase, "ready");
  assert.equal(ready.complete, true);
  assert.equal(ready.origin, "services");
  assert.deepEqual(ready.paths, ["", "Empty", "Projects", "Projects/Nested", "Unused empty directory"]);
  assert.equal(legacyCalls, 0, "empty directory discovery cannot depend on a note page");
  assert.equal(storage.writes.length, 1);
  assert.ok(emitted.every(snap => snap.phase !== "loading" || snap.paths.length === 0));
  const restored = new KnowledgeFolderCatalog({ directories: async () => { throw Error("offline"); } }, async () => [], storage);
  assert.deepEqual(restored.snapshot(scope), { ...ready, phase: "offline" });
});

test("an empty complete folder inventory is distinct from unavailable or note-derived folders", async () => {
  const storage = memoryStorage();
  const catalog = new KnowledgeFolderCatalog({ directories: async () => folders([]) }, async () => ["stale-note-folder"], storage);
  await catalog.activate(scope, true);
  assert.deepEqual(catalog.snapshot(scope).paths, []);
  assert.equal(catalog.snapshot(scope).complete, true);
  assert.equal(catalog.snapshot(scope).origin, "services");
  await catalog.activate(scope, false);
  assert.deepEqual(catalog.snapshot(scope).paths, []);
  assert.match(folderStatus(catalog.snapshot(scope), false), /完整目录/);
});

test("failed folder pagination cannot overwrite a previously complete cache or publish partial pages", async () => {
  const storage = memoryStorage(), tail = deferred<KnowledgeDirectoryPage>();
  let run = 0, calls = 0;
  const catalog = new KnowledgeFolderCatalog({ directories: async () => {
    if (run === 0) return folders(["", "Certified empty"]);
    calls++;
    return calls === 1 ? folders(["partial-untrusted"], "partial-untrusted") : tail.promise;
  } }, async () => { throw Error("fallback must not replace certified inventory"); }, storage);
  await catalog.activate(scope, true);
  const certified = catalog.snapshot(scope), bytes = [...storage.entries];
  run++;
  const refresh = catalog.activate(scope, true, true);
  await tick();
  assert.deepEqual(catalog.snapshot(scope).paths, certified.paths);
  assert.match(folderStatus(catalog.snapshot(scope), true), /上次目录/);
  tail.reject(new ServicesError("SERVICE_UNAVAILABLE", 503));
  await refresh;
  assert.equal(catalog.snapshot(scope).phase, "error");
  assert.equal(catalog.snapshot(scope).complete, true);
  assert.deepEqual(catalog.snapshot(scope).paths, certified.paths);
  assert.deepEqual([...storage.entries], bytes);
  assert.equal(storage.writes.length, 1);
});

for (const [code, phase] of [["VERSION_UNSUPPORTED", "unsupported"], ["METHOD_NOT_ALLOWED", "unsupported"], ["SERVICE_UNAVAILABLE", "error"]] as const) {
  test(`folder ${code} fallback stays incomplete and is never persisted`, async () => {
    const storage = memoryStorage();
    const catalog = new KnowledgeFolderCatalog({ directories: async () => { throw new ServicesError(code, 503); } },
      async (instance, vault) => { assert.deepEqual([instance, vault], [scope.instance, scope.vault]); return ["Cached/Notes", "../escape", "/absolute"]; }, storage);
    await catalog.activate(scope, true);
    assert.equal(catalog.snapshot(scope).phase, phase);
    assert.equal(catalog.snapshot(scope).complete, false);
    assert.equal(catalog.snapshot(scope).origin, "notes");
    assert.deepEqual(catalog.snapshot(scope).paths, ["Cached/Notes"]);
    assert.equal(storage.writes.length, 0);
    assert.match(folderStatus(catalog.snapshot(scope), true), /可能缺少空目录/);
  });
}

test("offline folders never request Services; failed local reads are unavailable rather than empty-success", async () => {
  const catalog = new KnowledgeFolderCatalog({ directories: async () => { assert.fail("offline Services call"); } }, async () => { throw Error("storage unavailable"); });
  await catalog.activate(scope, false);
  assert.deepEqual(catalog.snapshot(scope), { ...scope, phase: "offline", complete: false, origin: "none", paths: [], savedAt: 0 });
});

for (const code of ["GRANT_REQUIRED", "SCOPE_DENIED", "AUTH_REVOKED", "PAIRING_REQUIRED"] as const) {
  test(`folder ${code} clears certified cache and cannot resurrect through an offline note fallback`, async () => {
    const storage = memoryStorage();
    let deny = false, fallbackCalls = 0;
    const catalog = new KnowledgeFolderCatalog({ directories: async () => {
      if (deny) throw new ServicesError(code, 403);
      return folders(["Private/Empty"]);
    } }, async () => { fallbackCalls++; return ["Private/from-cached-note"]; }, storage);
    await catalog.activate(scope, true);
    deny = true;
    await catalog.activate(scope, true, true);
    assert.equal(catalog.snapshot(scope).phase, "denied");
    assert.deepEqual(catalog.snapshot(scope).paths, []);
    assert.equal(catalog.snapshot(scope).complete, false);
    assert.ok([...storage.entries.values()].every(value => !value.includes("Private")), "a denial may persist a tombstone, never the old directory names");
    const reopened = new KnowledgeFolderCatalog({ directories: async () => { throw new ServicesError(code, 403); } }, async () => ["Private/cached"], storage);
    await reopened.activate(scope, false);
    assert.equal(reopened.snapshot(scope).phase, "denied", "restart preserves the denial instead of resurrecting cached note folders");
    assert.deepEqual(reopened.snapshot(scope).paths, []);
    await catalog.activate(scope, false);
    assert.equal(catalog.snapshot(scope).phase, "denied", "connectivity loss must not erase an explicit denial");
    assert.deepEqual(catalog.snapshot(scope).paths, []);
    assert.equal(fallbackCalls, 0, "revoked note folders are not a fallback source");
    deny = false;
    await catalog.activate(scope, true, true);
    assert.equal(catalog.snapshot(scope).phase, "ready", "an explicit successful authorized refresh can recover");
  });
}

test("denied folder data stays hidden in the session even when persistent cache writes fail", async () => {
  const storage = memoryStorage();
  let deny = false;
  const catalog = new KnowledgeFolderCatalog({ directories: async () => {
    if (deny) throw new ServicesError("AUTH_REVOKED", 403);
    return folders(["Sensitive"]);
  } }, async () => ["Sensitive/cached"], { ...storage,
    setItem(key, value) { if (deny) throw Error("storage locked"); storage.setItem(key, value); },
    removeItem() { throw Error("storage locked"); },
  });
  await catalog.activate(scope, true);
  deny = true;
  await catalog.activate(scope, true, true);
  await catalog.activate(scope, false);
  assert.equal(catalog.snapshot(scope).phase, "denied");
  assert.deepEqual(catalog.snapshot(scope).paths, []);
});

test("folder snapshots and persistent keys isolate both desktop and vault, including delimiter-like identities", async () => {
  const storage = memoryStorage();
  const catalog = new KnowledgeFolderCatalog({ directories: async (instance, vault) => folders([`${instance}/${vault}`], null, vault) }, async () => [], storage);
  const scopes = [scope, { ...scope, instance: "desktop-B" }, { ...scope, vault: "vault-B" }];
  for (const value of scopes) await catalog.activate(value, true);
  assert.equal(storage.entries.size, 3);
  for (const value of scopes) assert.deepEqual(catalog.snapshot(value).paths, [`${value.instance}/${value.vault}`]);
  assert.notEqual(folderScopeKey({ instance: "a|b", vault: "c" }), folderScopeKey({ instance: "a", vault: "b|c" }));
  const other = new KnowledgeFolderCatalog({ directories: async () => folders([]) }, async () => [], storage);
  assert.equal(other.snapshot({ instance: "unrelated", vault: scope.vault }).complete, false);
});

test("folder hydration rejects corrupt, mis-scoped, and unsafe stored inventories", async () => {
  const storage = memoryStorage();
  const seed = new KnowledgeFolderCatalog({ directories: async () => folders(["Valid"]) }, async () => [], storage);
  await seed.activate(scope, true);
  const [key, encoded] = [...storage.entries][0], valid = JSON.parse(encoded);
  for (const invalid of [
    "not JSON", { ...valid, version: 9 }, { ...valid, instance: "other" },
    { ...valid, vault: "other" }, { ...valid, savedAt: 0 },
    { ...valid, complete: false }, { ...valid, origin: "notes" },
    { ...valid, paths: ["../escape"] }, { ...valid, paths: ["a//b"] },
    { ...valid, paths: [42] },
  ]) {
    storage.entries.set(key, typeof invalid === "string" ? invalid : JSON.stringify(invalid));
    const fresh = new KnowledgeFolderCatalog({ directories: async () => folders([]) }, async () => [], storage);
    assert.equal(fresh.snapshot(scope).complete, false, JSON.stringify(invalid));
    assert.deepEqual(fresh.snapshot(scope).paths, []);
  }
});

test("superseded folder pages cannot publish or persist after a desktop switch", async () => {
  const a = deferred<KnowledgeDirectoryPage>(), storage = memoryStorage();
  const other = { ...scope, instance: "desktop-B" };
  const catalog = new KnowledgeFolderCatalog({ directories: async instance => instance === scope.instance ? a.promise : folders(["B/empty"]) }, async () => [], storage);
  const old = catalog.activate(scope, true);
  await catalog.activate(other, true);
  a.resolve(folders(["A/late"]));
  await old;
  assert.deepEqual(catalog.snapshot(other).paths, ["B/empty"]);
  assert.deepEqual(catalog.snapshot(scope).paths, []);
  assert.equal(storage.writes.length, 1);
});

test("forced folder reload wins over older success and older denial", async () => {
  for (const lateDenial of [false, true]) {
    const slow = deferred<KnowledgeDirectoryPage>(), storage = memoryStorage();
    let calls = 0;
    const catalog = new KnowledgeFolderCatalog({ directories: async () => ++calls === 1 ? slow.promise : folders(["fresh"]) }, async () => [], storage);
    const old = catalog.activate(scope, true);
    const same = catalog.activate(scope, true);
    assert.equal(same, old, "identical in-flight activation shares its request");
    await catalog.activate(scope, true, true);
    if (lateDenial) slow.reject(new ServicesError("AUTH_REVOKED", 403));
    else slow.resolve(folders(["stale"]));
    await old;
    assert.equal(catalog.snapshot(scope).phase, "ready");
    assert.deepEqual(catalog.snapshot(scope).paths, ["fresh"]);
    assert.equal(storage.writes.length, 1);
    assert.equal(storage.removed.length, 0);
  }
});

test("folder suspend and online-to-offline transitions retire late Services and local fallback work", async () => {
  const slow = deferred<KnowledgeDirectoryPage>(), local = deferred<string[]>();
  const catalog = new KnowledgeFolderCatalog({ directories: async () => slow.promise }, async () => local.promise);
  const online = catalog.activate(scope, true);
  const offline = catalog.activate(scope, false);
  slow.resolve(folders(["late-online"]));
  await online;
  assert.deepEqual(catalog.snapshot(scope).paths, []);
  catalog.suspend();
  local.resolve(["late-local"]);
  await offline;
  assert.deepEqual(catalog.snapshot(scope).paths, []);
});

for (const [label, firstCursor, secondCursor] of [["repeated", "a", "a"], ["unsafe", "a", "../escape"]]) {
  test(`folder ${label} cursor fails closed without completing a partial inventory`, async () => {
    const storage = memoryStorage();
    let calls = 0;
    const catalog = new KnowledgeFolderCatalog({ directories: async () => folders([`page-${++calls}`], calls === 1 ? firstCursor : secondCursor) }, async () => ["cached-only"], storage);
    await catalog.activate(scope, true);
    assert.equal(calls, 2, "cursor problems terminate pagination");
    assert.equal(catalog.snapshot(scope).phase, "error");
    assert.equal(catalog.snapshot(scope).complete, false);
    assert.deepEqual(catalog.snapshot(scope).paths, ["cached-only"]);
    assert.equal(storage.writes.length, 0);
  });
}

test("folder pagination accepts Desktop UTF-8 ordering even where JS UTF-16 order disagrees", async () => {
  const cursors: Array<string | undefined> = [], pages = [folders(["\uE000"], "\uE000"), folders(["😀"], "😀"), folders(["😁"])];
  assert.ok("😀" < "\uE000", "the regression needs the UTF-16 versus UTF-8 ordering boundary");
  const catalog = new KnowledgeFolderCatalog({ directories: async (_instance, _vault, options) => {
    cursors.push(options?.afterPath); return pages.shift()!;
  } }, async () => []);
  await catalog.activate(scope, true);
  assert.deepEqual(cursors, [undefined, "\uE000", "😀"]);
  assert.equal(catalog.snapshot(scope).phase, "ready");
  assert.equal(catalog.snapshot(scope).complete, true);
  assert.deepEqual(catalog.snapshot(scope).paths, ["\uE000", "😀", "😁"]);
});

test("folder path and breadcrumb helpers preserve empty parents without accepting traversal or prefix collisions", () => {
  for (const good of ["", "Projects", "Projects/Empty", "中文/笔记", "a.b", "a".repeat(1024)]) assert.equal(safeFolderPath(good), true, good);
  for (const bad of ["/etc", "\\root", "C:/notes", "a\\b", "a//b", ".", "..", "a/../b", "a/./b", "a/", "a\0b", "a\nb", "a".repeat(1025), "中".repeat(342), 42, null]) assert.equal(safeFolderPath(bad), false, String(bad));
  assert.deepEqual(folderChildren(["", "a", "a/empty", "a/empty/deep", "ab/leak", "a/other", "a/../bad"], "a"), ["a/empty", "a/other"]);
  assert.deepEqual(folderChildren(["a/deep", "b", "a/other", "", "../no"], ""), ["a", "b"]);
  assert.deepEqual(folderChildren(["a"], "../bad"), []);
  assert.deepEqual(folderAncestors("a/b/c"), ["", "a", "a/b", "a/b/c"]);
  assert.deepEqual(folderAncestors(""), [""]);
  assert.deepEqual(folderAncestors("a/../bad"), [""]);
});

test("live directory revocation clears active and inactive vaults and fences pending pages", async () => {
  const storage = memoryStorage(), pending = deferred<KnowledgeDirectoryPage>(), listeners = new Set<() => void>();
  const other = { ...scope, vault: "vault-B" };
  let denied = false, slow = false;
  const catalog = new KnowledgeFolderCatalog({
    directories: async (_instance, vault) => slow ? pending.promise : folders([`${vault}/private`], null, vault),
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    authorityKey: () => denied ? "A|1|2|notGranted" : "A|1|1|implemented",
    denied: () => denied,
  }, async () => ["must-not-return"], storage);
  await catalog.activate(scope, true);
  await catalog.activate(other, true);
  slow = true;
  const old = catalog.activate(other, true, true);
  denied = true;
  for (const listener of listeners) listener();
  assert.equal(catalog.snapshot(scope).phase, "denied");
  assert.equal(catalog.snapshot(other).phase, "denied");
  assert.deepEqual(catalog.snapshot(scope).paths, []);
  assert.deepEqual(catalog.snapshot(other).paths, []);
  pending.resolve(folders(["late-private"], null, other.vault));
  await old;
  await catalog.activate(scope, false);
  assert.equal(catalog.snapshot(scope).phase, "denied");
  assert.ok([...storage.entries.values()].every(value => !value.includes("private")));
});

test("live directory authority changes retire old pagination and refresh the active exact scope", async () => {
  const oldTail = deferred<KnowledgeDirectoryPage>(), newTail = deferred<KnowledgeDirectoryPage>();
  const listeners = new Set<() => void>(), calls: any[][] = [];
  let authority = "A|1|1|implemented";
  const catalog = new KnowledgeFolderCatalog({
    directories: async (...args) => {
      calls.push(args);
      if (calls.length === 1) return folders(["old-page"], "old-cursor");
      return calls.length === 2 ? oldTail.promise : newTail.promise;
    },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    authorityKey: () => authority, denied: () => false,
  }, async () => []);
  const old = catalog.activate(scope, true);
  await tick();
  authority = "A|2|2|implemented";
  for (const listener of listeners) listener();
  await tick();
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2], [scope.instance, scope.vault, { limit: 100, afterPath: undefined }]);
  oldTail.resolve(folders(["retired-tail"]));
  await old;
  assert.deepEqual(catalog.snapshot(scope).paths, []);
  newTail.resolve(folders(["new-authority"]));
  await tick();
  assert.deepEqual(catalog.snapshot(scope).paths, ["new-authority"]);
  assert.equal(catalog.snapshot(scope).phase, "ready");
});

test("known directory denial synchronously blocks hydration before activation or any UI notification", async () => {
  const storage = memoryStorage();
  const seed = new KnowledgeFolderCatalog({ directories: async () => folders(["Private/cache"]) }, async () => [], storage);
  await seed.activate(scope, true);
  let notifications = 0, fallbackCalls = 0;
  const denied = new KnowledgeFolderCatalog({
    directories: async () => { assert.fail("known denial must not issue a directory request"); },
    denied: () => true,
  }, async () => { fallbackCalls++; return ["Private/local"]; }, storage);
  denied.subscribe(() => { notifications++; });
  const initial = denied.snapshot(scope);
  assert.equal(initial.phase, "denied");
  assert.equal(initial.complete, false);
  assert.deepEqual(initial.paths, []);
  assert.equal(notifications, 0, "snapshot is safe to read while rendering");
  await denied.activate(scope, true);
  await denied.activate(scope, false);
  assert.equal(fallbackCalls, 0);
  assert.deepEqual(denied.snapshot(scope).paths, []);
  assert.ok([...storage.entries.values()].every(value => !value.includes("Private")));
});

test("a denied folder refresh cannot recover through transport failure or unsupported fallback", async () => {
  let failure: "AUTH_REVOKED" | "SERVICE_UNAVAILABLE" | "VERSION_UNSUPPORTED" = "AUTH_REVOKED";
  let fallbackCalls = 0;
  const catalog = new KnowledgeFolderCatalog({ directories: async () => { throw new ServicesError(failure, 403); } }, async () => { fallbackCalls++; return ["cached-private"]; });
  await catalog.activate(scope, true);
  for (const next of ["SERVICE_UNAVAILABLE", "VERSION_UNSUPPORTED"] as const) {
    failure = next;
    await catalog.activate(scope, true, true);
    assert.equal(catalog.snapshot(scope).phase, "denied");
    assert.deepEqual(catalog.snapshot(scope).paths, []);
  }
  assert.equal(fallbackCalls, 0);
});

test("relations publish all typed pages atomically under one exact revision and scope", async () => {
  const last = deferred<KnowledgeRelationPage>(), calls: any[][] = [], published: RelationSnapshot[] = [];
  const first: KnowledgeRelation[] = [wiki(), { kind: "material", assetId: "asset-A", target: "photo.png" }];
  const backlink: KnowledgeRelation = { kind: "backlink", sourceNoteId: "source-note", target: "Note A", line: 3, status: "resolved", noteIds: [noteScope.note] };
  const reader = new KnowledgeRelations(noteScope, { relations: async (...args) => {
    calls.push(args); return calls.length === 1 ? relationPage(first, "r1", "page2") : last.promise;
  } }, snap => published.push(snap));
  const pending = reader.load(true);
  await tick();
  assert.deepEqual(calls, [
    [scope.instance, scope.vault, noteScope.note, { limit: 100, after: undefined }],
    [scope.instance, scope.vault, noteScope.note, { limit: 100, after: "page2" }],
  ]);
  assert.equal(reader.snapshot().phase, "loading");
  assert.deepEqual(reader.snapshot().items, []);
  last.resolve(relationPage([backlink]));
  await pending;
  assert.deepEqual(reader.snapshot(), relationSnapshot([...first, backlink]));
  assert.deepEqual(published.map(snap => snap.phase), ["loading", "ready"]);
});

test("relations restart once on a revision change, discarding every old page", async () => {
  const calls: Array<string | undefined> = [];
  const pages = [relationPage([wiki("old-one")], "r1", "p2"), relationPage([wiki("mixed")], "r2"), relationPage([wiki("new-one")], "r3", "new2"), relationPage([wiki("new-two")], "r3")];
  const reader = new KnowledgeRelations(noteScope, { relations: async (_instance, _vault, _note, options) => { calls.push(options?.after); return pages.shift()!; } }, () => {});
  await reader.load(true);
  assert.deepEqual(calls, [undefined, "p2", undefined, "new2"]);
  assert.equal(reader.snapshot().phase, "ready");
  assert.equal(reader.snapshot().revision, "r3");
  assert.deepEqual(reader.snapshot().items.map(item => item.target), ["new-one", "new-two"]);
});

test("relations recover a CURSOR_TOO_OLD once from page one rather than retrying the bad cursor", async () => {
  const calls: Array<string | undefined> = [];
  const reader = new KnowledgeRelations(noteScope, { relations: async (_instance, _vault, _note, options) => {
    calls.push(options?.after);
    if (calls.length === 1) return relationPage([wiki("old")], "r1", "expired");
    if (calls.length === 2) throw new ServicesError("CURSOR_TOO_OLD", 410);
    return relationPage([wiki("fresh")], "r2");
  } }, () => {});
  await reader.load(true);
  assert.deepEqual(calls, [undefined, "expired", undefined]);
  assert.deepEqual(reader.snapshot().items.map(item => item.target), ["fresh"]);
});

test("continuously changing relation revisions terminate after one restart without publishing mixed data", async () => {
  let calls = 0;
  const reader = new KnowledgeRelations(noteScope, { relations: async () => {
    calls++; return relationPage([wiki(`partial-${calls}`)], `r${calls}`, calls % 2 ? "p2" : null);
  } }, () => {});
  await reader.load(true);
  assert.equal(calls, 4);
  assert.equal(reader.snapshot().phase, "error");
  assert.deepEqual(reader.snapshot().items, []);
  assert.equal(reader.snapshot().revision, "");
});

test("repeated relation cursors fail without an infinite loop or partial relation publish", async () => {
  let calls = 0;
  const reader = new KnowledgeRelations(noteScope, { relations: async () => { calls++; return relationPage([wiki()], "r1", "repeat"); } }, () => {});
  await reader.load(true);
  assert.equal(calls, 2);
  assert.equal(reader.snapshot().phase, "error");
  assert.deepEqual(reader.snapshot().items, []);
});

for (const [code, phase] of [
  ["GRANT_REQUIRED", "denied"], ["SCOPE_DENIED", "denied"], ["AUTH_REVOKED", "denied"], ["PAIRING_REQUIRED", "denied"],
  ["VERSION_UNSUPPORTED", "unsupported"], ["METHOD_NOT_ALLOWED", "unsupported"], ["SERVICE_UNAVAILABLE", "error"],
] as const) {
  test(`relation ${code} clears old identities and exposes ${phase}`, async () => {
    let fail = false;
    const reader = new KnowledgeRelations(noteScope, { relations: async () => { if (fail) throw new ServicesError(code, 403); return relationPage([wiki()]); } }, () => {});
    await reader.load(true);
    fail = true;
    await reader.load(true);
    assert.equal(reader.snapshot().phase, phase);
    assert.deepEqual(reader.snapshot().items, []);
    assert.equal(reader.snapshot().revision, "");
    assert.notEqual(relationsStatus(phase), "");
  });
}

test("relation offline transitions retire in-flight pages and never expose cached navigable identities", async () => {
  const slow = deferred<KnowledgeRelationPage>();
  let calls = 0;
  const reader = new KnowledgeRelations(noteScope, { relations: async () => { calls++; return calls === 1 ? relationPage([wiki()]) : slow.promise; } }, () => {});
  await reader.load(true);
  const pending = reader.load(true);
  await reader.load(false);
  slow.resolve(relationPage([wiki("late")]));
  await pending;
  assert.equal(calls, 2);
  assert.equal(reader.snapshot().phase, "offline");
  assert.deepEqual(reader.snapshot().items, []);
  assert.equal(resolveWikiReference(reader.snapshot(), reference, "r1", true).kind, "unavailable");
});

test("new relation loads supersede both late successes and late denials; retire suppresses publication", async () => {
  for (const denial of [false, true]) {
    const slow = deferred<KnowledgeRelationPage>(), published: RelationSnapshot[] = [];
    let calls = 0;
    const reader = new KnowledgeRelations(noteScope, { relations: async () => ++calls === 1 ? slow.promise : relationPage([wiki("new")], "r2") }, snap => published.push(snap));
    const old = reader.load(true);
    await reader.load(true);
    if (denial) slow.reject(new ServicesError("AUTH_REVOKED", 403)); else slow.resolve(relationPage([wiki("old")]));
    await old;
    assert.equal(reader.snapshot().phase, "ready");
    assert.equal(reader.snapshot().revision, "r2");
    assert.deepEqual(reader.snapshot().items.map(item => item.target), ["new"]);
    assert.equal(published.length, 3);
  }
  const slow = deferred<KnowledgeRelationPage>(), published: RelationSnapshot[] = [];
  const retired = new KnowledgeRelations(noteScope, { relations: async () => slow.promise }, snap => published.push(snap));
  const pending = retired.load(true);
  retired.retire();
  slow.resolve(relationPage([wiki()]));
  await pending;
  assert.deepEqual(published.map(snap => snap.phase), ["loading"]);
});

test("typed wiki resolution uses exact target and line, never aliases, backlinks, material IDs, or title guesses", () => {
  const snapshot = relationSnapshot([
    { kind: "backlink", sourceNoteId: "backlink-source", target: reference.target, line: reference.line, status: "resolved", noteIds: ["backlink-source"] },
    { kind: "material", assetId: "asset-id", target: reference.target },
    wiki(reference.label, ["alias-is-not-id"]), wiki(reference.target, ["wrong-line"], 2), wiki(reference.target, ["exact-id"]),
  ]);
  assert.deepEqual(resolveWikiReference(snapshot, reference, "r1", true), { kind: "resolved", noteIds: ["exact-id"] });
  assert.deepEqual(resolveWikiReference(snapshot, { ...reference, target: "target" }, "r1", true), { kind: "missing", noteIds: [] });
  assert.equal(resolveWikiReference(relationSnapshot([wiki("Folder/Note#Heading", ["heading-note"])]), { ...reference, target: "Folder/Note#Heading", heading: "Heading" }, "r1", true).kind, "resolved");
});

test("typed wiki resolution requires an exact current revision and a clean note", () => {
  const snapshot = relationSnapshot();
  for (const [revision, clean] of [["r0", true], ["", true], ["r1", false]] as const) {
    assert.deepEqual(resolveWikiReference(snapshot, reference, revision, clean), { kind: "stale", noteIds: [] });
  }
  for (const phase of ["idle", "loading", "offline", "denied", "unsupported", "error"] as const) {
    assert.deepEqual(resolveWikiReference({ ...snapshot, phase }, reference, "r1", true), { kind: "unavailable", noteIds: [] });
  }
});

test("typed wiki ambiguity is explicit; repeated occurrences agree and conflicting server matches fail closed", () => {
  assert.deepEqual(resolveWikiReference(relationSnapshot([wiki("Target", ["a", "a"])]), reference, "r1", true), { kind: "resolved", noteIds: ["a"] });
  assert.deepEqual(resolveWikiReference(relationSnapshot([wiki("Target", ["a", "b", "a"], 1, "ambiguous")]), reference, "r1", true), { kind: "ambiguous", noteIds: ["a", "b"] });
  assert.deepEqual(resolveWikiReference(relationSnapshot([wiki(), wiki()]), reference, "r1", true), { kind: "resolved", noteIds: ["resolved-note"] });
  for (const items of [[wiki(), wiki("Target", ["different-id"])], [wiki("Target", [])], [wiki("Target", ["a", "b"])], [wiki("Target", ["a"], 1, "ambiguous")], [wiki("Target", ["a"], 1, "unresolved")]]) {
    assert.deepEqual(resolveWikiReference(relationSnapshot(items), reference, "r1", true), { kind: "missing", noteIds: [] });
  }
});

function registryHarness() {
  const state = {
    snapshot: { desktopInstanceId: scope.instance, services: { knowledge: { version: 1, granted: false } } } as any,
    operations: { "knowledge.directories": "implemented", "knowledge.relations": "implemented" } as Record<string, string>,
    refreshes: [] as string[], queried: [] as string[], namespace: "desktop-A|1|1", listeners: new Set<() => void>(),
  };
  const registry = {
    snapshot: () => state.snapshot,
    currentNamespace: () => state.namespace,
    subscribe: (listener: () => void) => { state.listeners.add(listener); return () => { state.listeners.delete(listener); }; },
    operation: (operation: string) => { state.queried.push(operation); return { state: state.operations[operation] ?? "unsupported" }; },
    refreshAdopting: async (instance: string) => { state.refreshes.push(instance); state.snapshot = { ...state.snapshot, desktopInstanceId: instance }; return state.snapshot; },
  } as unknown as ServiceRegistry;
  return { state, registry };
}

test("navigation reader gates each exact operation independently and forwards immutable scopes/options", async () => {
  const { state, registry } = registryHarness(), calls: any[][] = [];
  const knowledge = {
    directories: async (...args: any[]) => { calls.push(["directories", ...args]); return folders([]); },
    relations: async (...args: any[]) => { calls.push(["relations", ...args]); return relationPage([]); },
  } as unknown as KnowledgeClient;
  const reader = createKnowledgeNavigationReader(knowledge, registry);
  await reader.directories(scope.instance, scope.vault, { limit: 100, afterPath: "" });
  await reader.relations(scope.instance, scope.vault, noteScope.note, { limit: 100, after: "cursor" });
  assert.deepEqual(calls, [
    ["directories", scope.instance, scope.vault, { limit: 100, afterPath: "" }],
    ["relations", scope.instance, scope.vault, noteScope.note, { limit: 100, after: "cursor" }],
  ]);
  assert.ok(state.queried.includes("knowledge.directories") && state.queried.includes("knowledge.relations"));
  assert.ok(state.queried.every(operation => ["knowledge.directories", "knowledge.relations"].includes(operation)));
  assert.deepEqual(state.refreshes, []);
  state.operations["knowledge.relations"] = "notGranted";
  state.snapshot.services.knowledge.granted = true;
  await assert.rejects(reader.relations(scope.instance, scope.vault, noteScope.note), { code: "GRANT_REQUIRED" });
  assert.equal(calls.length, 2, "a service-wide grant does not permit this operation");
});

for (const [operationState, code] of [["unsupported", "VERSION_UNSUPPORTED"], ["notGranted", "GRANT_REQUIRED"], ["temporarilyUnavailable", "SERVICE_UNAVAILABLE"], ["unknown", "VERSION_UNSUPPORTED"]]) {
  test(`navigation reader refuses ${operationState} before transport`, async () => {
    const { state, registry } = registryHarness();
    state.operations["knowledge.directories"] = operationState;
    const reader = createKnowledgeNavigationReader({ directories: async () => assert.fail("must not reach transport") } as unknown as KnowledgeClient, registry);
    await assert.rejects(reader.directories(scope.instance, scope.vault), { code });
  });
}

test("navigation reader cold discovery is instance-pinned and unsupported knowledge versions fail closed", async () => {
  const { state, registry } = registryHarness();
  state.snapshot.desktopInstanceId = "desktop-old";
  let calls = 0;
  const reader = createKnowledgeNavigationReader({ directories: async () => { calls++; return folders([]); } } as unknown as KnowledgeClient, registry);
  await reader.directories(scope.instance, scope.vault);
  assert.deepEqual(state.refreshes, [scope.instance]);
  assert.equal(calls, 1);
  state.snapshot.services.knowledge.version = 2;
  await assert.rejects(reader.directories(scope.instance, scope.vault), { code: "VERSION_UNSUPPORTED" });
  assert.equal(calls, 1);
  state.snapshot.desktopInstanceId = "desktop-wrong";
  registry.refreshAdopting = async () => state.snapshot;
  await assert.rejects(reader.directories(scope.instance, scope.vault), { code: "SOURCE_CHANGED" });
  assert.equal(calls, 1);
});

for (const operation of ["directories", "relations"] as const) {
  for (const change of ["instance", "namespace", "grant"] as const) {
    test(`navigation ${operation} rejects an in-flight page after ${change} authority changes`, async () => {
      const { state, registry } = registryHarness(), pending = deferred<any>();
      const knowledge = { directories: async () => pending.promise, relations: async () => pending.promise } as unknown as KnowledgeClient;
      const reader = createKnowledgeNavigationReader(knowledge, registry);
      const request = operation === "directories"
        ? reader.directories(scope.instance, scope.vault)
        : reader.relations(scope.instance, scope.vault, noteScope.note);
      await tick();
      if (change === "instance") state.snapshot.desktopInstanceId = "desktop-B";
      else if (change === "namespace") state.namespace = "desktop-A|2|2";
      else state.operations[`knowledge.${operation}`] = "notGranted";
      pending.resolve(operation === "directories" ? folders(["retired"]) : relationPage([wiki("retired")]));
      await assert.rejects(request, { code: change === "grant" ? "GRANT_REQUIRED" : "SOURCE_CHANGED" });
    });
  }
}

test("navigation authority helpers stay operation-specific and notify subscribers only while subscribed", () => {
  const { state, registry } = registryHarness();
  const reader = createKnowledgeNavigationReader({} as KnowledgeClient, registry);
  assert.equal(reader.authorityKey("desktop-elsewhere", "directories"), "unknown");
  const directories = reader.authorityKey(scope.instance, "directories");
  state.operations["knowledge.relations"] = "notGranted";
  assert.equal(reader.denied(scope.instance, "relations"), true);
  assert.equal(reader.denied(scope.instance, "directories"), false);
  assert.equal(reader.denied("desktop-elsewhere", "relations"), false);
  assert.equal(reader.authorityKey(scope.instance, "directories"), directories);
  assert.notEqual(reader.authorityKey(scope.instance, "relations"), directories);
  let notifications = 0;
  const unsubscribe = reader.subscribe(() => { notifications++; });
  for (const listener of state.listeners) listener();
  unsubscribe();
  for (const listener of state.listeners) listener();
  assert.equal(notifications, 1);
});

function discoveryCatalog(instance = scope.instance, permissionRevision = 1, state = "implemented") {
  return {
    desktopInstanceId: instance, gatewayGeneration: 1, permissionRevision,
    services: { knowledge: { version: 1, granted: true } },
    operations: {
      "knowledge.directories": { state, capability: "knowledge", grant: "read", scope: "registeredVault" },
      "knowledge.relations": { state, capability: "knowledge", grant: "read", scope: "registeredVault" },
    },
  };
}

test("real registry invalidation notifies navigation subscribers and prevents an in-flight page becoming current", async () => {
  const tail = deferred<KnowledgeRelationPage>();
  const registry = new ServiceRegistry({ request: async () => ({ status: 200, body: discoveryCatalog() }) });
  await registry.refreshAdopting(scope.instance);
  const reader = createKnowledgeNavigationReader({ relations: async () => tail.promise } as unknown as KnowledgeClient, registry);
  let notifications = 0;
  const stop = reader.subscribe(() => { notifications++; });
  const old = reader.relations(scope.instance, scope.vault, noteScope.note);
  await tick();
  registry.invalidate();
  assert.equal(notifications, 1);
  assert.equal(reader.authorityKey(scope.instance, "relations"), "unknown");
  tail.resolve(relationPage([wiki()]));
  await assert.rejects(old, { code: "SOURCE_CHANGED" });
  stop();
  await registry.refreshAdopting(scope.instance);
  assert.equal(notifications, 1);
});

test("real registry permission invalidation retires a late discovery without resurrecting its catalog", async () => {
  const discovery = deferred<any>();
  const registry = new ServiceRegistry({ request: async () => discovery.promise });
  const pending = registry.refreshAdopting(scope.instance);
  assert.equal(registry.invalidateForPermissionRevision(2), true);
  discovery.resolve({ status: 200, body: discoveryCatalog(scope.instance, 1) });
  await assert.rejects(pending, /superseded/);
  assert.equal(registry.snapshot(), null);
  assert.equal(registry.currentNamespace(), "");
});

test("initial directory discovery uses the existing in-flight request without duplicate pagination", async () => {
  let discoveryCalls = 0, directoryCalls = 0;
  const registry = new ServiceRegistry({ request: async () => { discoveryCalls++; return { status: 200, body: discoveryCatalog() }; } });
  const navigation = createKnowledgeNavigationReader({ directories: async () => { directoryCalls++; return folders(["Empty"]); } } as unknown as KnowledgeClient, registry);
  const catalog = new KnowledgeFolderCatalog(navigation, async () => []);
  await catalog.activate(scope, true);
  await tick();
  assert.equal(discoveryCalls, 1);
  assert.equal(directoryCalls, 1);
  assert.equal(catalog.snapshot(scope).phase, "ready");
  assert.deepEqual(catalog.snapshot(scope).paths, ["Empty"]);
});

test("explicit navigation refresh rediscovers grants even when the desktop identity is unchanged", async () => {
  let revision = 1, state = "notGranted", discoveries = 0, reads = 0;
  const registry = new ServiceRegistry({ request: async () => { discoveries++; return { status: 200, body: discoveryCatalog(scope.instance, revision, state) }; } });
  await registry.refreshAdopting(scope.instance);
  const reader = createKnowledgeNavigationReader({ directories: async () => { reads++; return folders([]); } } as unknown as KnowledgeClient, registry);
  assert.equal(reader.denied(scope.instance, "directories"), true);
  await assert.rejects(reader.directories(scope.instance, scope.vault), { code: "GRANT_REQUIRED" });
  revision = 2; state = "implemented";
  await reader.refresh(scope.instance);
  assert.equal(discoveries, 2);
  assert.equal(reader.denied(scope.instance, "directories"), false);
  await reader.directories(scope.instance, scope.vault);
  assert.equal(reads, 1);
});

test("explicit folder refresh recovers a restored grant with one complete directory request", async () => {
  let revision = 1, state = "notGranted", discoveries = 0, reads = 0;
  const registry = new ServiceRegistry({ request: async () => { discoveries++; return { status: 200, body: discoveryCatalog(scope.instance, revision, state) }; } });
  await registry.refreshAdopting(scope.instance);
  const reader = createKnowledgeNavigationReader({ directories: async () => { reads++; return folders(["Now authorized"]); } } as unknown as KnowledgeClient, registry);
  const catalog = new KnowledgeFolderCatalog(reader, async () => { assert.fail("denial cannot use note fallback"); });
  await catalog.activate(scope, true);
  assert.equal(catalog.snapshot(scope).phase, "denied");
  revision = 2; state = "implemented";
  await catalog.refresh(scope, true);
  await tick();
  assert.equal(discoveries, 2);
  assert.equal(reads, 1, "capability subscription and explicit retry must share the same directory refresh");
  assert.equal(catalog.snapshot(scope).phase, "ready");
  assert.deepEqual(catalog.snapshot(scope).paths, ["Now authorized"]);
});

test("a late capability refresh cannot reactivate folders after the user switches desktops", async () => {
  const refresh = deferred<void>(), calls: string[] = [];
  const other = { ...scope, instance: "desktop-B" };
  const catalog = new KnowledgeFolderCatalog({
    directories: async instance => { calls.push(instance); return folders([instance]); },
    refresh: async () => refresh.promise,
  }, async () => []);
  await catalog.activate(scope, true);
  const pending = catalog.refresh(scope, true);
  await catalog.activate(other, true);
  refresh.resolve();
  await pending;
  assert.deepEqual(calls, [scope.instance, other.instance]);
  assert.deepEqual(catalog.snapshot(other).paths, [other.instance]);
});

test("failed explicit capability refresh retains a certified inventory with a truthful error state", async () => {
  const catalog = new KnowledgeFolderCatalog({
    directories: async () => folders(["Certified empty"]),
    refresh: async () => { throw new ServicesError("SERVICE_UNAVAILABLE", 503); },
  }, async () => []);
  await catalog.activate(scope, true);
  const old = catalog.snapshot(scope);
  await catalog.refresh(scope, true);
  assert.deepEqual(catalog.snapshot(scope), { ...old, phase: "error" });
});

test("a servicesChanged live hint revokes folders and pending relations on the same connection", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let revision = 1, grant = "implemented", reads = 0, wakes = 0;
  const registry = new ServiceRegistry({ request: async () => ({ status: 200, body: discoveryCatalog(scope.instance, revision, grant) }) });
  await registry.refreshAdopting(scope.instance);
  const relationTail = deferred<KnowledgeRelationPage>(), storage = memoryStorage();
  const navigation = createKnowledgeNavigationReader({
    directories: async () => { reads++; return folders(["Private/empty"]); },
    relations: async () => relationTail.promise,
  } as unknown as KnowledgeClient, registry);
  const catalog = new KnowledgeFolderCatalog(navigation, async () => { assert.fail("revoked cached notes are not a fallback"); }, storage);
  await catalog.activate(scope, true);
  const relations = new KnowledgeRelations(noteScope, navigation, () => {});
  const relationLoad = relations.load(true);
  await tick();
  let hints: any[] = [];
  const starts: string[] = [], permissionHints: [string, number][] = [];
  const feed = {
    stop: async () => {}, start: async (instance: string) => { starts.push(instance); },
    boundGeneration: () => 1, refreshMode: async () => "hints",
    readHints: async () => { const batch = hints; hints = []; return batch; },
  } as unknown as ChangeFeedClient;
  const live = new KnowledgeLiveSync(feed, () => { wakes++; }, (instance, nextRevision) => {
    permissionHints.push([instance, nextRevision]);
    const current = registry.snapshot();
    if (!current || current.desktopInstanceId === instance) registry.invalidateForPermissionRevision(nextRevision);
  });
  const retire = live.bind(scope.instance);
  await tick();
  revision = 2; grant = "notGranted";
  hints = [{ kind: "servicesChanged", permissionRevision: 2 }];
  t.mock.timers.tick(400);
  await tick();
  assert.deepEqual(starts, [scope.instance], "permission changes must not require a reconnect");
  assert.deepEqual(permissionHints, [[scope.instance, 2]]);
  assert.equal(catalog.snapshot(scope).phase, "denied");
  assert.deepEqual(catalog.snapshot(scope).paths, []);
  assert.ok([...storage.entries.values()].every(value => !value.includes("Private")));
  assert.equal(reads, 1, "revoked rediscovery does not issue an unauthorized directory read");
  assert.equal(wakes, 0, "permission hints do not impersonate durable content changes");
  relationTail.resolve(relationPage([wiki()]));
  await relationLoad;
  assert.equal(relations.snapshot().phase, "denied");
  assert.deepEqual(relations.snapshot().items, []);
  await catalog.activate(scope, false);
  assert.equal(catalog.snapshot(scope).phase, "denied");
  retire();
});

for (const successor of ["desktop-B", scope.instance]) {
  test(`late live permission hints are fenced after rebinding to ${successor}`, async t => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const oldHints = deferred<any[]>(), permissions: [string, number][] = [], starts: string[] = [];
    let reads = 0, wakes = 0;
    const feed = {
      stop: async () => {}, start: async (instance: string) => { starts.push(instance); },
      boundGeneration: () => 1, refreshMode: async () => "hints",
      readHints: async () => ++reads === 1 ? oldHints.promise : [
        { kind: "servicesChanged", permissionRevision: 3 },
        { kind: "knowledgeChanged", vaultId: scope.vault, cursor: "current" },
      ],
    } as unknown as ChangeFeedClient;
    const live = new KnowledgeLiveSync(feed, () => { wakes++; }, (instance, revision) => { permissions.push([instance, revision]); });
    const retireOld = live.bind(scope.instance);
    await tick();
    t.mock.timers.tick(400);
    await tick();
    assert.equal(reads, 1);
    const retireCurrent = live.bind(successor);
    retireOld();
    await tick();
    oldHints.resolve([{ kind: "servicesChanged", permissionRevision: 99 }, { kind: "knowledgeChanged", vaultId: scope.vault, cursor: "retired" }]);
    await tick();
    assert.deepEqual(permissions, []);
    assert.equal(wakes, 0);
    t.mock.timers.tick(400);
    await tick();
    assert.deepEqual(starts, [scope.instance, successor]);
    assert.deepEqual(permissions, [[successor, 3]]);
    assert.equal(wakes, 1);
    retireCurrent();
    t.mock.timers.tick(400);
    await tick();
    assert.equal(reads, 2, "retirement stops further hint drains");
  });
}

test("real navigation client uses only GET routes and preserves the empty root cursor", async () => {
  const calls: ServicesRequest[] = [];
  const client = new KnowledgeClient({ request: async request => {
    calls.push(request);
    return { status: 200, body: request.operationId === "knowledge.directories" ? folders([""]) : relationPage([wiki()]) };
  } });
  await client.directories(scope.instance, scope.vault, { limit: 100, afterPath: "" });
  await client.relations(scope.instance, scope.vault, noteScope.note, { limit: 100, after: "opaque" });
  assert.deepEqual(calls, [
    { instance: scope.instance, operationId: "knowledge.directories", method: "GET", path: "/v1/services/knowledge/vaults/vault-A/directories", query: { limit: 100, afterPath: "" } },
    { instance: scope.instance, operationId: "knowledge.relations", method: "GET", path: "/v1/services/knowledge/notes/note-A/relations", query: { vault: scope.vault, limit: 100, after: "opaque" } },
  ]);
});

test("real relation client rejects cross-vault/note pages and malformed typed identities", async () => {
  for (const body of [
    { ...relationPage([]), vaultId: "other-vault" }, { ...relationPage([]), noteId: "other-note" },
    relationPage([{ ...wiki(), noteIds: ["../path-is-not-id"] } as KnowledgeRelation]),
    relationPage([{ kind: "backlink", target: "Target", line: 1, status: "resolved", noteIds: ["a"], sourceNoteId: "../bad" }]),
    relationPage([{ kind: "material", assetId: "file:///etc", target: "photo" }]),
    relationPage([{ ...wiki(), line: 0 } as KnowledgeRelation]),
    { ...relationPage([]), hasMore: true, nextAfter: "" },
  ]) {
    const client = new KnowledgeClient({ request: async () => ({ status: 200, body }) });
    await assert.rejects(client.relations(scope.instance, scope.vault, noteScope.note), { code: "MALFORMED_RESPONSE" });
  }
});

// Resolve the parser through its actual react-markdown dependency. This works
// with pnpm's isolated layout without adding packages or relying on hoisting.
const require = createRequire(import.meta.url);
const markdownRequire = createRequire(require.resolve("react-markdown"));
const { unified } = await import(pathToFileURL(markdownRequire.resolve("unified")).href);
const { default: remarkParse } = await import(pathToFileURL(markdownRequire.resolve("remark-parse")).href);
function parseWiki(source: string) {
  const references = new Map<string, WikiReference>();
  const processor = unified().use(remarkParse).use(wikiSyntax(source, references));
  const tree = processor.runSync(processor.parse(source));
  return { tree, references, refs: [...references.values()] };
}
function plainMarkdown(source: string) { return unified().use(remarkParse).parse(source); }
function descendants(tree: any, type: string): any[] {
  return [...(tree.type === type ? [tree] : []), ...(tree.children ?? []).flatMap((child: any) => descendants(child, type))];
}
function assertRanges(tree: any, source: string) {
  const check = (node: any) => {
    if (node.position) {
      const { start, end } = node.position;
      assert.ok(start.offset >= 0 && end.offset >= start.offset && end.offset <= source.length, `invalid range for ${node.type}`);
      const before = source.slice(0, start.offset).split(/\r\n|\r|\n/);
      assert.equal(start.line, before.length);
      assert.equal(start.column, before.at(-1)!.length + 1);
    }
    let priorEnd = node.position?.start.offset ?? 0;
    for (const child of node.children ?? []) {
      if (child.position) {
        assert.ok(child.position.start.offset >= priorEnd, `overlapping ${node.type} children`);
        if (node.position) assert.ok(child.position.end.offset <= node.position.end.offset);
        priorEnd = child.position.end.offset;
      }
      check(child);
    }
  };
  check(tree);
}

test("real Markdown AST handles wiki aliases, heading text, repeat labels, Unicode and CRLF source ranges", () => {
  const source = "前文 [[Folder/Note#Heading| Friendly alias ]] 和 [[Other|Friendly alias]]\r\n\r\n[[中文/笔记]] 后文";
  const { tree, refs } = parseWiki(source);
  assert.deepEqual(refs.map(({ target, label, line, heading }) => ({ target, label, line, heading })), [
    { target: "Folder/Note#Heading", label: "Friendly alias", line: 1, heading: "Heading" },
    { target: "Other", label: "Friendly alias", line: 1, heading: undefined },
    { target: "中文/笔记", label: "中文/笔记", line: 3, heading: undefined },
  ]);
  for (const ref of refs) {
    assert.equal(source.slice(ref.from, ref.to).startsWith("[["), true);
    const link = descendants(tree, "link").find(node => node.url === `#luckyray-wiki-${ref.from}`);
    assert.deepEqual([link.position.start.offset, link.position.end.offset], [ref.from, ref.to]);
    assert.equal(link.children[0].value, ref.label);
    assert.equal(link.data.hProperties["data-wiki-start"], ref.from);
  }
  assertRanges(tree, source);
});

test("wiki transformation leaves fenced/indented/inline code, raw HTML, existing links and images alone", () => {
  const source = [
    "`[[Inline]]` [[Live]]", "", "```md", "[[Fenced]]", "```", "", "    [[Indented]]", "",
    "<div>", "[[Raw HTML]]", "</div>", "", "[already [[Linked]]](https://example.com)", "",
    "![image [[Alt]]](photo.png)", "", "[reference [[Named]]][id]", "", "[id]: https://example.com",
  ].join("\n");
  const { tree, refs } = parseWiki(source);
  assert.deepEqual(refs.map(ref => ref.target), ["Live"]);
  assert.equal(descendants(tree, "inlineCode")[0].value, "[[Inline]]");
  assert.deepEqual(descendants(tree, "code").map(node => node.value), ["[[Fenced]]", "[[Indented]]"]);
  assert.equal(descendants(tree, "image")[0].url, "photo.png");
  assertRanges(tree, source);
});

test("wiki escapes stay literal while independently unescaped repetitions remain navigable", () => {
  const source = String.raw`\[[Escaped]] [[Escaped]] \\[[Even backslashes]] [[Final]]` + "\n\n[[Independent]]";
  const { tree, refs } = parseWiki(source);
  assert.deepEqual(refs.map(ref => ref.target), ["Escaped", "Even backslashes", "Final", "Independent"]);
  assert.equal(refs[0].from, source.indexOf("[[Escaped]]", 2));
  assertRanges(tree, source);
});

test("wiki embeds remain image nodes and never become note-navigation references", () => {
  const source = "before ![[images/cover.png|Cover]] and [[Note]] after";
  const { tree, refs } = parseWiki(source), images = descendants(tree, "image");
  assert.deepEqual(refs.map(ref => ref.target), ["Note"]);
  assert.equal(images.length, 1);
  assert.equal(images[0].url, "images/cover.png");
  assert.equal(images[0].alt, "Cover");
  assert.equal(source.slice(images[0].position.start.offset, images[0].position.end.offset), "![[images/cover.png|Cover]]");
  assertRanges(tree, source);
});

test("wiki targets accept canonical relative resolver text but reject absolute paths, protocols, controls and oversized UTF-8", () => {
  for (const good of ["Note", "Folder/Note#Heading", "中文", "Note.md", "../Sibling", "./Note", "a/../b", "a//b", "a\\b", "a".repeat(1024)]) assert.equal(safeWikiTarget(good), true, good);
  for (const bad of ["", "/etc/passwd", "\\server", "C:/secret", "https://example.com", "file:///etc", "a\nb", "a\0b", "a".repeat(1025), "中".repeat(342)]) assert.equal(safeWikiTarget(bad), false, bad);
  const source = "[[../secret]] [[/absolute]] [[https://example.com]] [[a//b]] [[Safe]]";
  const { tree, refs } = parseWiki(source);
  assert.deepEqual(refs.map(ref => ref.target), ["../secret", "a//b", "Safe"]);
  assertRanges(tree, source);
});

test("relative wiki references navigate only via a matching canonical typed note ID, never the relative target", async () => {
  const source = "[[../Sibling#Details|Sibling]] [[./A]]", { refs } = parseWiki(source);
  assert.deepEqual(refs.map(ref => ref.target), ["../Sibling#Details", "./A"]);
  const client = new KnowledgeClient({ request: async () => ({ status: 200, body: relationPage([
    wiki("../Sibling#Details", ["canonical-sibling"]), wiki("./A", ["canonical-a"]),
  ]) }) });
  const page = await client.relations(scope.instance, scope.vault, noteScope.note);
  assert.deepEqual(resolveWikiReference(relationSnapshot(page.items), refs[0], "r1", true), { kind: "resolved", noteIds: ["canonical-sibling"] });
  assert.deepEqual(resolveWikiReference(relationSnapshot(page.items), refs[1], "r1", true), { kind: "resolved", noteIds: ["canonical-a"] });
  assert.deepEqual(resolveWikiReference(relationSnapshot([]), refs[0], "r1", true), { kind: "missing", noteIds: [] });
});

test("wiki decoded entities cannot substitute a later identical token or corrupt surrounding text", () => {
  const source = "start [[A&#x26;B]] middle [[A&B]] end";
  const { tree, refs } = parseWiki(source);
  assert.equal(refs.length, 1, "only the exact literal token is navigable");
  assert.deepEqual(refs[0], { target: "A&B", label: "A&B", line: 1, from: source.indexOf("[[A&B]]"), to: source.indexOf("[[A&B]]") + "[[A&B]]".length, heading: undefined });
  const content = descendants(tree, "text").map(node => node.value).join("");
  assert.equal(content, "start [[A&B]] middle A&B end", "decoded literal must remain before the later link");
  assertRanges(tree, source);
});

test("wiki parsing preserves source ranges around decoded punctuation, emphasis, soft breaks and consecutive links", () => {
  const source = "&amp; before **[[One|1]]**\n[[Two]][[Three|]] after &copy;";
  const { tree, refs } = parseWiki(source);
  assert.deepEqual(refs.map(ref => ref.label), ["1", "Two", "Three"]);
  assert.deepEqual(refs.map(ref => ref.line), [1, 2, 2]);
  for (const ref of refs) assert.equal(source.slice(ref.from, ref.to).startsWith("[["), true);
  assertRanges(tree, source);
});

for (const [label, source, expected] of [
  ["named entities before links", "&copy; &amp; [[One]] &copy; [[Two]]", ["One", "Two"]],
  ["numeric and astral entities before links", "&#65; &#x1F642; [[One]] and [[Two]]", ["One", "Two"]],
  ["entity-synthesized wiki delimiters", "&#91;&#91;Ghost]] [[Real]]", ["Real"]],
  ["entity-containing aliases", "[[Alias|A&amp;B]] [[Real]]", ["Real"]],
  ["escaped delimiters inside tokens", String.raw`[[Escaped\]]] [[Real]]`, ["Real"]],
  ["escaped punctuation before links", String.raw`\* literal \[ bracket [[Real]]`, ["Real"]],
] as const) {
  test(`wiki source correspondence handles ${label} without guessed identities`, () => {
    const { tree, refs } = parseWiki(source);
    assert.deepEqual(refs.map(ref => ref.target), expected);
    for (const ref of refs) assert.equal(source.slice(ref.from, ref.to), `[[${ref.target}]]`);
    assertRanges(tree, source);
  });
}

test("wiki transformed token spellings stay literal rather than producing guessed link identities", () => {
  for (const source of ["[[Alias|A&amp;B]]", "&#91;&#91;Ghost]]", String.raw`\[[Escaped]]`, "[[A&#x26;B]]"]) {
    const { tree, refs } = parseWiki(source);
    assert.deepEqual(refs, []);
    assert.deepEqual(tree, plainMarkdown(source));
  }
});

test("plain repeated/consecutive wiki tokens retain distinct offsets across soft CRLF and CR breaks", () => {
  const source = "[[One]][[One]]\r\n[[Two]]\r[[Three|]]";
  const { tree, refs } = parseWiki(source);
  assert.deepEqual(refs.map(ref => [ref.target, ref.label, ref.line]), [["One", "One", 1], ["One", "One", 1], ["Two", "Two", 2], ["Three", "Three", 3]]);
  assert.equal(new Set(refs.map(ref => ref.from)).size, 4);
  assertRanges(tree, source);
});
