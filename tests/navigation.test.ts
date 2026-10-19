// NavigationController unit tests (UI-REFRESH-R1 — pure logic, no Tauri).
// Run: node --experimental-strip-types --test tests/navigation.test.ts
//
// Model under test (STITCH-R6 / DESIGN.md §6): Bottom Nav is
// 首页 / 素材 / AI / 知识 / 我的; AI is a permanent destination; Capture is the
// global compose action and therefore a PUSHED surface, not a root. Details and
// search are layers. Back: layer -> root -> 首页 -> system fallback.

import test from "node:test";
import assert from "node:assert/strict";
import { BOTTOM_NAV_TABS, NavigationController } from "../src/navigation.ts";

test("ui-refresh-r1 — initial route is Home", () => {
  const nav = new NavigationController();
  assert.deepEqual(nav.current(), { tab: "home" });
});

test("stitch-r6 — bottom nav is 首页 / 素材 / AI / 知识 / 我的", () => {
  // STITCH-R6 (DESIGN.md §6) froze this order and made AI a PERMANENT
  // destination in every connection state. Capture deliberately left the nav:
  // it is the global compose action, not a root tab.
  assert.deepEqual([...BOTTOM_NAV_TABS], ["home", "library", "ai", "knowledge", "settings"]);
  assert.ok(BOTTOM_NAV_TABS.includes("ai" as never), "AI is a permanent nav destination");
  assert.ok(!BOTTOM_NAV_TABS.includes("capture" as never), "Capture is a global action, not a tab");
  assert.ok(!BOTTOM_NAV_TABS.includes("search" as never), "search stays an overlay");
});

test("ui-refresh-r1 — Home → Library root; Back = Home; Back at Home falls through", () => {
  const nav = new NavigationController();
  nav.switchRoot("library");
  assert.deepEqual(nav.current(), { tab: "library" });
  assert.equal(nav.goBack(), true, "root back consumed");
  assert.deepEqual(nav.current(), { tab: "home" });
  assert.equal(nav.goBack(), false, "Home back falls through to the system");
  assert.deepEqual(nav.current(), { tab: "home" });
});

test("ui-refresh-r1 — root switches stay bounded across many destinations", () => {
  const nav = new NavigationController();
  nav.switchRoot("library");
  nav.switchRoot("knowledge");
  nav.switchRoot("ai");
  nav.switchRoot("settings");
  assert.deepEqual(nav.current(), { tab: "settings" });
  assert.equal(nav.goBack(), true);
  assert.deepEqual(nav.current(), { tab: "home" });
  assert.equal(nav.goBack(), false);
});

test("ui-refresh-r1 — 100 top-level switches keep the stack bounded", () => {
  const nav = new NavigationController();
  const tabs = ["library", "knowledge", "ai", "settings", "home"] as const;
  for (let i = 0; i < 100; i++) {
    nav.switchRoot(tabs[i % tabs.length]);
  }
  assert.deepEqual(nav.current(), { tab: "home" });
  assert.equal(nav.goBack(), false, "already at the Home root");
});

test("ui-refresh-r1 — reselect active root adds no duplicate history", () => {
  const nav = new NavigationController();
  nav.switchRoot("library");
  nav.switchRoot("library"); // reselect
  nav.switchRoot("library"); // reselect again
  assert.deepEqual(nav.current(), { tab: "library" });
  assert.equal(nav.goBack(), true, "single entry only");
  assert.deepEqual(nav.current(), { tab: "home" });
});

test("ui-refresh-r1 — reselecting 首页 while on it is a no-op", () => {
  const nav = new NavigationController();
  nav.switchRoot("home");
  assert.deepEqual(nav.current(), { tab: "home" });
  assert.equal(nav.goBack(), false, "no history was built");
});

test("ui-refresh-r1 — Library detail → Back = Library → Back = Home", () => {
  const nav = new NavigationController();
  nav.switchRoot("library");
  nav.pushDetail({ tab: "library", detail: "local:asset-1" });
  assert.deepEqual(nav.current(), { tab: "library", detail: "local:asset-1" });
  assert.equal(nav.goBack(), true);
  assert.deepEqual(nav.current(), { tab: "library" });
  assert.equal(nav.goBack(), true);
  assert.deepEqual(nav.current(), { tab: "home" });
});

test("ui-refresh-r1 — Knowledge Note detail → Back = Knowledge → Back = Home", () => {
  const nav = new NavigationController();
  nav.switchRoot("knowledge");
  nav.pushDetail({ tab: "knowledge", detail: "note-1" });
  assert.equal(nav.goBack(), true);
  assert.deepEqual(nav.current(), { tab: "knowledge" });
  assert.equal(nav.goBack(), true);
  assert.deepEqual(nav.current(), { tab: "home" });
});

test("stitch-r6 — Capture Inbox detail → Back = Capture → Back = Home", () => {
  // The Inbox detail is reached from the Capture surface; Back returns to that
  // surface and then to the owning root.
  const nav = new NavigationController();
  nav.pushScreen("capture");
  nav.pushDetail({ tab: "capture", detail: "item-9" });
  assert.deepEqual(nav.current(), { tab: "capture", detail: "item-9" });
  assert.equal(nav.goBack(), true);
  assert.deepEqual(nav.current(), { tab: "capture" });
  assert.equal(nav.goBack(), true);
  assert.deepEqual(nav.current(), { tab: "home" });
});

test("ui-refresh-r1 — Local Search opened from Home → Back = Home", () => {
  const nav = new NavigationController();
  nav.openSearch();
  assert.deepEqual(nav.current(), { tab: "search" });
  assert.equal(nav.goBack(), true);
  assert.deepEqual(nav.current(), { tab: "home" });
});

test("stitch-r6 — Local Search opened from the Capture surface → Back = its owning root", () => {
  // Capture is pushed over a root (it is not a nav destination), so Search
  // opened from it returns to the surface, then to the root beneath.
  const nav = new NavigationController();
  nav.pushScreen("capture");
  assert.deepEqual(nav.current(), { tab: "capture" });
  nav.openSearch();
  assert.deepEqual(nav.current(), { tab: "search" });
  assert.equal(nav.goBack(), true);
  assert.deepEqual(nav.current(), { tab: "capture" }, "returns to the Capture surface");
  assert.equal(nav.goBack(), true);
  assert.deepEqual(nav.current(), { tab: "home" });
});

test("ui-refresh-r1 — switching Bottom Nav while a detail/search is open discards it", () => {
  const nav = new NavigationController();
  nav.switchRoot("library");
  nav.pushDetail({ tab: "library", detail: "local:asset-1" });
  nav.switchRoot("knowledge"); // root switch discards the open detail
  assert.deepEqual(nav.current(), { tab: "knowledge" });

  nav.openSearch(); // open search from knowledge
  assert.deepEqual(nav.current(), { tab: "search" });
  nav.switchRoot("ai"); // root switch discards search
  assert.deepEqual(nav.current(), { tab: "ai" });
  assert.equal(nav.goBack(), true);
  assert.deepEqual(nav.current(), { tab: "home" });
});

test("ui-refresh-r1 — cross-root detail push switches the owning root first", () => {
  const nav = new NavigationController();
  nav.switchRoot("library");
  // A search result opens a Knowledge note from the Library root.
  nav.pushDetail({ tab: "knowledge", detail: "note-1" });
  assert.deepEqual(nav.current(), { tab: "knowledge", detail: "note-1" });
  assert.equal(nav.goBack(), true);
  assert.deepEqual(nav.current(), { tab: "knowledge" }, "owns the knowledge root");
  assert.equal(nav.goBack(), true);
  assert.deepEqual(nav.current(), { tab: "home" });
});

test("ui-refresh-r1 — goHome returns to 首页 from any root/detail", () => {
  const nav = new NavigationController();
  nav.switchRoot("knowledge");
  nav.pushDetail({ tab: "knowledge", detail: "note-1" });
  nav.goHome();
  assert.deepEqual(nav.current(), { tab: "home" });
  assert.equal(nav.goBack(), false, "at Home back falls through");
});

test("stitch-r6 — switchRoot ignores non-bottom-nav tabs (search/capture)", () => {
  const nav = new NavigationController();
  nav.switchRoot("library");
  nav.switchRoot("search"); // search is an overlay, not a root
  assert.deepEqual(nav.current(), { tab: "library" }, "search switch is a no-op");
  nav.switchRoot("capture"); // Capture is a pushed surface, not a root
  assert.deepEqual(nav.current(), { tab: "library" }, "capture switch is a no-op");
});

test("stitch-r6 — the Capture surface pushes over 首页 and Back returns to 首页", () => {
  const nav = new NavigationController();
  nav.pushScreen("capture");
  assert.deepEqual(nav.current(), { tab: "capture" });
  assert.equal(nav.goBack(), true);
  assert.deepEqual(nav.current(), { tab: "home" });
  assert.equal(nav.goBack(), false);
});

test("interaction-closure — the Capture surface returns to its INITIATING root", () => {
  // INTERACTION-CLOSURE-R1: 素材 → 收集 → Back = 素材 (never forced home).
  const nav = new NavigationController();
  nav.switchRoot("library");
  nav.pushScreen("capture");
  assert.deepEqual(nav.current(), { tab: "capture" });
  assert.equal(nav.goBack(), true);
  assert.deepEqual(nav.current(), { tab: "library" });

  // Knowledge → Capture → Back = Knowledge
  nav.switchRoot("knowledge");
  nav.pushScreen("capture");
  assert.equal(nav.goBack(), true);
  assert.deepEqual(nav.current(), { tab: "knowledge" });

  // Settings → Capture → Back = Settings
  nav.switchRoot("settings");
  nav.pushScreen("capture");
  assert.equal(nav.goBack(), true);
  assert.deepEqual(nav.current(), { tab: "settings" });

  // Pushing from an already-pushed screen replaces it (bounded history).
  nav.pushScreen("capture");
  nav.pushScreen("capture");
  assert.equal(nav.hasLayer(), true);
});

test("ui-refresh-r1 — hasLayer reports whether a dismissible layer is open", () => {
  const nav = new NavigationController();
  assert.equal(nav.hasLayer(), false, "a single root is not a layer");
  nav.switchRoot("library");
  assert.equal(nav.hasLayer(), false, "root switch replaces, never stacks");
  nav.pushDetail({ tab: "library", detail: "local:1" });
  assert.equal(nav.hasLayer(), true, "detail is a layer");
  nav.goBack();
  assert.equal(nav.hasLayer(), false);
  nav.openSearch();
  assert.equal(nav.hasLayer(), true, "search is a layer");
});

test("subscribe notifies on change", () => {
  const nav = new NavigationController({ tab: "home" });
  let calls = 0;
  const un = nav.subscribe(() => calls++);
  nav.switchRoot("library");
  assert.equal(calls, 1);
  nav.goBack();
  assert.equal(calls, 2);
  un();
  nav.switchRoot("library");
  assert.equal(calls, 2, "unsubscribed no notify");
});
