// M2.12 product-shell policy tests (pure, dependency-free).
// Issue #20 host-testable items 12-15:
//  12. every known interactive header/settings control maps to a REAL action
//      or is explicitly static — no fake/placeholder behavior;
//  13. Capture normal-product model exposes no primary Desktop push while
//      M3 HOLD (the backend capture-outbox is preserved);
//  14. Settings separates product rows from developer/connection diagnostics;
//  15. Library companion-positioning copy has no "sync Desktop" empty-state
//      promise while M3 HOLD.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_CAPABILITY_LABEL,
  CAPTURE_PRIMARY_KINDS,
  DESKTOP_CACHED_LABEL,
  DEVELOPER_SECTION_TITLE,
  HEADER_LEFT_ACTION,
  HOME_AVATAR_ACTION,
  M3_HOLD,
  SETTINGS_SECTIONS,
  SHELL_CONTROL_INVENTORY,
  agentRefreshAvailable,
  captureHasPrimaryDesktopPush,
  connectionSummary,
  hasPlaceholderBehavior,
  libraryEmptyState,
  shellControlAction,
} from "../src/services/productShell.ts";

test("m2.12 — M3 is HOLD; shell decisions are encoded", () => {
  assert.equal(M3_HOLD, true);
  assert.equal(HOME_AVATAR_ACTION, "settings", "avatar opens the real Settings root");
  assert.equal(HEADER_LEFT_ACTION, "home", "root header-left is the Dashboard/Home action");
  assert.equal(captureHasPrimaryDesktopPush(), false, "no primary Desktop push while M3 HOLD");
  assert.deepEqual([...CAPTURE_PRIMARY_KINDS], ["text", "link", "image", "photo", "file"]);
});

test("m2.12 — action policy: every known control is REAL or explicitly STATIC, never placeholder", () => {
  // Every inventory entry resolves; none is unknown, and no entry may resolve
  // to a fake 'coming soon' behavior.
  for (const c of SHELL_CONTROL_INVENTORY) {
    assert.equal(shellControlAction(c.id), c.action, `${c.id} resolves consistently`);
    assert.equal(hasPlaceholderBehavior(c.id), false, `${c.id} has no placeholder behavior`);
  }
  // The full inventory is covered by the policy (no stray control id).
  assert.ok(SHELL_CONTROL_INVENTORY.length >= 15, "inventory is complete enough for the shell audit");
  // Static controls are the Settings status rows + About.
  const statics = SHELL_CONTROL_INVENTORY.filter((c) => c.action === "static").map((c) => c.id);
  assert.ok(statics.includes("settings-connection-state"));
  assert.ok(statics.includes("settings-storage-rows"));
  assert.ok(statics.includes("settings-about"));
  // The real actions that replaced the formerly dead controls:
  for (const id of ["home-avatar", "library-header-left", "knowledge-header-left", "capture-header-search", "agent-header-refresh"]) {
    assert.equal(shellControlAction(id), "real", `${id} is a real action`);
  }
});

test("ui-refresh-r1 — Settings header is a real Home action; theme is real; erases need acknowledgement", () => {
  assert.equal(shellControlAction("settings-header-left"), "real", "header-left returns to the Home root");
  assert.equal(hasPlaceholderBehavior("settings-header-left"), false);
  const left = SHELL_CONTROL_INVENTORY.find((c) => c.id === "settings-header-left");
  assert.ok(left?.actionRef?.includes("home"), "header-left goes Home (never self-nav)");
  assert.equal(shellControlAction("settings-theme"), "real", "theme is a real toggle, not a static row");
  // Destructive erases require an explicit acknowledgement in a confirm sheet.
  for (const id of ["settings-erase-inbox", "settings-erase-notes", "settings-erase-assets"]) {
    const row = SHELL_CONTROL_INVENTORY.find((c) => c.id === id);
    assert.ok(row?.actionRef?.includes("acknowledgement"), `${id} requires an acknowledgement`);
  }
});

test("m2.12 FIX-V1B — no visible no-op handlers across the shell screens (header re-scan)", () => {
  const screens = ["Home", "Library", "Knowledge", "Capture", "AgentRemote", "Settings", "LocalSearchScreen"];
  for (const s of screens) {
    const src = readFileSync(join(import.meta.dirname, "..", "src", "screens", `${s}.tsx`), "utf8");
    assert.doesNotMatch(src, /onClick=\{\(\) => \{\}\}/, `${s} has no no-op onClick handler`);
  }
  // Settings never self-navigates and the dead Gear affordance is gone.
  const settings = readFileSync(join(import.meta.dirname, "..", "src", "screens", "Settings.tsx"), "utf8");
  assert.doesNotMatch(settings, /go\("settings"\)/, "Settings header never self-navigates");
  assert.doesNotMatch(settings, /IconGear/, "the dead Gear button is removed");
});

test("m2.12 — Settings separates product rows from developer/connection diagnostics", () => {
  assert.deepEqual([...SETTINGS_SECTIONS.product], ["connection", "inbox", "notes", "assets", "storage", "about"]);
  assert.deepEqual(
    [...SETTINGS_SECTIONS.developer],
    ["pairing", "qr", "logs", "security", "syncDiagnostics", "outboxPending"]
  );
  assert.equal(DEVELOPER_SECTION_TITLE, "开发者与连接诊断");
  // Product and developer sections are disjoint.
  for (const p of SETTINGS_SECTIONS.product) {
    assert.ok(!SETTINGS_SECTIONS.developer.includes(p as never), `${p} only in one section`);
  }
});

test("m3-m1 foundation — Settings does not present legacy cache or AI copy as current Desktop capability", () => {
  const settings = readFileSync(join(import.meta.dirname, "..", "src", "screens", "Settings.tsx"), "utf8");
  assert.doesNotMatch(settings, /conn\.stats\.sync_cursor/, "historical cursor is not a live Desktop sync status");
  assert.doesNotMatch(settings, /经 Desktop（实验）/, "foundation does not claim a Desktop model API");
  assert.match(settings, /Desktop 内容同步[\s\S]*连接基础阶段未开放/, "content sync is explicitly gated");
  assert.match(settings, /Desktop AI[\s\S]*连接基础阶段未开放/, "Desktop AI is explicitly gated");
});

test("m2.12 — Library companion copy never promises Desktop sync while M3 HOLD", () => {
  for (const paired of [false, true]) {
    for (const domain of ["all", "local", "desktop"] as const) {
      const copy = libraryEmptyState(paired, domain);
      assert.ok(!copy.includes("同步 Desktop"), `${copy} has no sync-Desktop promise`);
      assert.ok(!copy.includes("同步后可见"), `${copy} has no vague sync promise`);
    }
  }
  assert.ok(libraryEmptyState(false, "local").includes("导入到本机暂存"));
  assert.ok(libraryEmptyState(true, "desktop").includes("实验缓存"));
  assert.equal(DESKTOP_CACHED_LABEL, "Desktop 缓存（实验）", "cached assets are labeled experimental");
});

test("m2.12 FIX-V1 — connection summary: only actual connected claims realtime", () => {
  assert.equal(connectionSummary(false, "stopped"), "未连接");
  assert.equal(connectionSummary(false, "connecting"), "未连接", "unpaired is 未连接 regardless of ws");
  assert.equal(connectionSummary(true, "connected"), "已配对 · 实时连接", "only connected claims realtime");
  assert.equal(connectionSummary(true, "connecting"), "已配对 · 正在连接", "connecting never claims realtime");
  assert.equal(connectionSummary(true, "reconnecting"), "已配对 · 正在连接", "reconnecting never claims realtime");
  assert.equal(connectionSummary(true, "stopped"), "已配对（未实时连接）");
  assert.equal(connectionSummary(true, "offline"), "已配对（未实时连接）");
  assert.equal(connectionSummary(true, "error"), "已配对（未实时连接）");
  // The realtime CLAIM ("· 实时连接") appears ONLY for connected — note that
  // "未实时连接" legitimately contains the substring "实时连接", so we assert
  // on the claim pattern.
  for (const s of ["stopped", "connecting", "reconnecting", "offline", "error", ""]) {
    assert.ok(!connectionSummary(true, s).includes("· 实时连接"), `${s} never claims 实时连接`);
  }
  assert.ok(connectionSummary(true, "connected").includes("· 实时连接"), "connected does claim realtime");
});

test("m2.12 FIX-V1 — Agent refresh affordance exists only when paired", () => {
  assert.equal(agentRefreshAvailable(false), false, "unpaired state has NO refresh affordance (no dead button)");
  assert.equal(agentRefreshAvailable(true), true, "paired state keeps the real runs refresh");
});

test("m2.12 FIX-V1 — Settings local-domain rows are REAL root navigation", () => {
  assert.equal(shellControlAction("settings-inbox"), "real");
  assert.equal(shellControlAction("settings-notes"), "real");
  assert.equal(shellControlAction("settings-assets"), "real");
  assert.equal(hasPlaceholderBehavior("settings-inbox"), false);
  assert.equal(hasPlaceholderBehavior("settings-notes"), false);
  assert.equal(hasPlaceholderBehavior("settings-assets"), false);
  const inbox = SHELL_CONTROL_INVENTORY.find((c) => c.id === "settings-inbox");
  assert.ok(inbox?.actionRef?.includes("switchRoot:capture"), "inbox row navigates to Capture");
  const notes = SHELL_CONTROL_INVENTORY.find((c) => c.id === "settings-notes");
  assert.ok(notes?.actionRef?.includes("switchRoot:knowledge"), "notes row navigates to Knowledge");
  const assets = SHELL_CONTROL_INVENTORY.find((c) => c.id === "settings-assets");
  assert.ok(assets?.actionRef?.includes("switchRoot:library"), "assets row navigates to Library");
});

test("m2.12 — AI capability label is truthful and non-expansive", () => {
  assert.ok(AGENT_CAPABILITY_LABEL.includes("实验"));
  assert.ok(!AGENT_CAPABILITY_LABEL.includes("敬请期待"));
});
