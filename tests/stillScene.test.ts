import test from "node:test";
import assert from "node:assert/strict";
import { NavigationController } from "../src/navigation.ts";
import { stillScene } from "../src/still/stillScene.ts";

test("Knowledge opens connection support as connection, then Back returns to its root", () => {
  const nav = new NavigationController({ tab: "knowledge" });
  nav.pushDetail({ tab: "knowledge", detail: "connect-computer" });
  assert.deepEqual(stillScene(nav.current(), 7), { name: "connect", key: 7 });
  nav.goBack();
  assert.deepEqual(nav.current(), { tab: "knowledge" });
});

test("support pages on every root preserve their real view and root Back", () => {
  const details = { "connect-computer": "connect", diagnostics: "diagnostics", recovery: "recovery",
    inbox: "inbox", preferences: "preferences", appearance: "appearance", storage: "storage" };
  for (const tab of ["home", "knowledge", "library", "ai", "settings"] as const) {
    for (const [detail, name] of Object.entries(details)) {
      const nav = new NavigationController({ tab });
      nav.pushDetail({ tab, detail });
      const before = nav.snapshot();
      assert.deepEqual(stillScene(nav.current(), 11), { name, key: 11 });
      assert.deepEqual(nav.snapshot(), before, "derivation never edits history");
      nav.goBack();
      assert.deepEqual(nav.current(), { tab });
    }
  }
});

test("ordinary content, editable note, entry and search mappings remain intact", () => {
  for (const [route, scene] of [
    [{ tab: "library", detail: "local:asset-1" }, { name: "asset", id: "local:asset-1" }],
    [{ tab: "knowledge", detail: "desktop:instance:vault:id" }, { name: "note", id: "desktop:instance:vault:id" }],
    [{ tab: "knowledge", detail: "edit:desktop:instance:vault:id" }, { name: "note", id: "desktop:instance:vault:id", startInEdit: true }],
    [{ tab: "knowledge", detail: "new" }, { name: "new-note" }],
    [{ tab: "ai", detail: "run-1" }, { name: "run", id: "run-1" }],
    [{ tab: "knowledge", detail: "entry:inbox-1" }, { name: "inbox-detail", id: "inbox-1" }],
    [{ tab: "capture", detail: "inbox-2" }, { name: "inbox-detail", id: "inbox-2" }],
    [{ tab: "capture" }, { name: "capture" }],
    [{ tab: "search" }, { name: "search" }],
    [{ tab: "knowledge", detail: "constructor" }, { name: "note", id: "constructor" }],
  ] as const) assert.deepEqual(stillScene(route, 3), { ...scene, key: 3 });
  assert.equal(stillScene({ tab: "knowledge" }, 1), null);
  const nav = new NavigationController({ tab: "knowledge" });
  nav.openSearch();
  nav.pushDetail({ tab: "knowledge", detail: "edit:desktop:i:v:n" });
  assert.equal(stillScene(nav.current(), 9)?.startInEdit, true);
  nav.goBack();
  assert.equal(stillScene(nav.current(), 8)?.name, "search");
  nav.goBack();
  assert.deepEqual(nav.current(), { tab: "knowledge" });
});
