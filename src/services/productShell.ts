// M2.12 product-shell policy (pure, dependency-free).
//
// Encodes the truthful product decisions of Issue #20 as ONE source of truth
// that the screens consume and the deterministic tests assert:
//
//  - every known interactive header/settings control maps to a REAL action or
//    is explicitly STATIC (non-interactive information) — no fake menus, no
//    "coming soon" placeholders;
//  - while M3 is HOLD, the normal Capture workflow exposes NO primary Desktop
//    push control (the backend capture-outbox is preserved but demoted to
//    non-destructive developer diagnostics);
//  - Settings separates product rows from a clearly secondary
//    developer/connection diagnostics section;
//  - Local Assets are positioned as 本机暂存/离线素材 — Library empty-state
//    copy never promises Desktop sync while M3 is HOLD, and Desktop cached
//    assets are labeled experimental/cached, never live.

export const M3_HOLD = true;

// ---------------------------------------------------------------------------
// Scope A — navigation policy consumed by the shell
// ---------------------------------------------------------------------------
/** Header-left affordance on top-level root screens: the Dashboard/Home
 *  action — one coherent pattern across Library/Knowledge (never a fake
 *  menu). */
export const HEADER_LEFT_ACTION = "home" as const;

/** Home avatar action: the real 我的 / Settings root. */
export const HOME_AVATAR_ACTION = "settings" as const;

/** Capture header search action: the real three-domain Local Search overlay. */
export const CAPTURE_SEARCH_ACTION = "search" as const;

// ---------------------------------------------------------------------------
// Scope C — M3 HOLD product truth
// ---------------------------------------------------------------------------
/** While M3 is HOLD the normal Capture product flow exposes no primary
 *  Desktop push control (text/link/image/photo/file → Local Inbox only).
 *  The capture-outbox backend and its pending rows are preserved. */
export function captureHasPrimaryDesktopPush(): boolean {
  return false;
}

export const CAPTURE_PRIMARY_KINDS = ["text", "link", "image", "photo", "file"] as const;

/** Truthful label for the AI surface (capability NOT expanded beyond the
 *  existing runs/events/stop). */
export const AGENT_CAPABILITY_LABEL = "Desktop Agent 远程（实验）· V1";

/** FIX-V1 P1-1: the Agent runs refresh affordance exists ONLY in the paired
 *  state (it is a real runs refresh); the unpaired state must render no
 *  refresh control — a dead button is forbidden. */
export function agentRefreshAvailable(paired: boolean): boolean {
  return paired;
}

/**
 * Truthful connection summary (FIX-V1 P1-4). Only actual `connected` may
 * claim realtime connection:
 *  - connected            → 已配对 · 实时连接
 *  - connecting/reconnecting → 已配对 · 正在连接
 *  - paired + stopped/offline/error → 已配对（未实时连接）
 *  - unpaired             → 未连接
 */
export function connectionSummary(paired: boolean, wsState: string): string {
  if (!paired) return "未连接";
  if (wsState === "connected") return "已配对 · 实时连接";
  if (wsState === "connecting" || wsState === "reconnecting") return "已配对 · 正在连接";
  return "已配对（未实时连接）";
}

// ---------------------------------------------------------------------------
// Scope E — Settings product vs developer sections
// ---------------------------------------------------------------------------
export type SettingsSection = {
  product: readonly string[];
  developer: readonly string[];
};

export const SETTINGS_SECTIONS: SettingsSection = {
  product: ["connection", "inbox", "notes", "assets", "storage", "about"],
  developer: ["pairing", "qr", "logs", "security", "syncDiagnostics", "outboxPending"],
};

export const DEVELOPER_SECTION_TITLE = "开发者与连接诊断";

// ---------------------------------------------------------------------------
// Scope D — Local Assets companion positioning
// ---------------------------------------------------------------------------
export type LibraryDomain = "all" | "local" | "desktop";

/** Truthful Library empty-state copy — never promises Desktop sync while M3
 *  is HOLD. */
export function libraryEmptyState(paired: boolean, domain: LibraryDomain): string {
  if (domain === "desktop") {
    return paired ? "Desktop 暂无缓存素材（实验缓存）" : "未连接 Desktop（实验缓存区为空）";
  }
  if (domain === "local") {
    return "还没有本机暂存素材 — 点击「导入到本机暂存」添加";
  }
  return paired
    ? "还没有素材 — 导入到本机暂存，或查看 Desktop 实验缓存"
    : "还没有素材 — 点击「导入到本机暂存」添加";
}

/** Desktop cached assets are labeled experimental/cached — never live
 *  Desktop browsing. */
export const DESKTOP_CACHED_LABEL = "Desktop 缓存（实验）";

export const LOCAL_IMPORT_LABEL = "导入到本机暂存";

// ---------------------------------------------------------------------------
// Scope B — zero-dead-controls inventory (testable policy)
// ---------------------------------------------------------------------------
export type ShellControl = {
  id: string;
  action: "real" | "static";
  actionRef?: string;
  staticNote?: string;
};

/** Every known interactive-looking header/settings control: either a REAL
 *  action reference or explicitly STATIC (rendered as non-interactive
 *  information, no button semantics/chevron/pressed feedback). No fake
 *  "coming soon" behavior anywhere. */
export const SHELL_CONTROL_INVENTORY: readonly ShellControl[] = [
  { id: "home-search-pill", action: "real", actionRef: "openSearch" },
  { id: "home-quick-capture", action: "real", actionRef: "switchRoot:capture" },
  { id: "home-avatar", action: "real", actionRef: "switchRoot:settings" },
  { id: "home-agent-entry", action: "real", actionRef: "pushScreen:ai" },
  { id: "library-header-left", action: "real", actionRef: "switchRoot:home" },
  { id: "library-import-local", action: "real", actionRef: "localImport(image|video|file)" },
  { id: "library-filter-sheet", action: "real", actionRef: "filterSheet(kind|favorite|archived|sort|view)" },
  { id: "knowledge-header-left", action: "real", actionRef: "switchRoot:home" },
  { id: "knowledge-create-note", action: "real", actionRef: "localNoteAdd" },
  { id: "knowledge-filter-sheet", action: "real", actionRef: "filterSheet(scope|tag|sort)" },
  { id: "capture-header-search", action: "real", actionRef: "openSearch" },
  { id: "capture-compose-kind", action: "real", actionRef: "localInbox(text|link)" },
  { id: "capture-save-local", action: "real", actionRef: "localInboxAdd" },
  { id: "capture-media-actions", action: "real", actionRef: "localInboxAddMedia(image|photo|file)" },
  { id: "agent-header-back", action: "real", actionRef: "goBack" },
  { id: "agent-header-refresh", action: "real", actionRef: "refreshRuns" },
  { id: "settings-header-left", action: "real", actionRef: "switchRoot:home" },
  { id: "settings-connection", action: "real", actionRef: "connectionSummary + connect-computer" },
  { id: "settings-inbox", action: "real", actionRef: "switchRoot:capture (Local Inbox rows open Capture)" },
  { id: "settings-notes", action: "real", actionRef: "switchRoot:knowledge (Local Notes rows open Knowledge)" },
  { id: "settings-assets", action: "real", actionRef: "switchRoot:library (Local Assets rows open Library)" },
  { id: "settings-theme", action: "real", actionRef: "applyTheme(dark|light)" },
  { id: "settings-connection-state", action: "static", staticNote: "information row — truthful connection state, no chevron/button" },
  { id: "settings-storage-rows", action: "static", staticNote: "information rows — no chevron/button" },
  { id: "settings-about", action: "static", staticNote: "information row — no chevron/button" },
  { id: "settings-developer-section", action: "real", actionRef: "developerDiagnostics (collapsed secondary)" },
  { id: "settings-storage-cleanup", action: "real", actionRef: "companionClearCache" },
  { id: "settings-erase-inbox", action: "real", actionRef: "localInboxEraseAll (confirm sheet + acknowledgement)" },
  { id: "settings-erase-notes", action: "real", actionRef: "localNoteEraseAll (confirm sheet + acknowledgement)" },
  { id: "settings-erase-assets", action: "real", actionRef: "localAssetEraseAll (confirm sheet + acknowledgement)" },
];

export function shellControlAction(id: string): "real" | "static" | "unknown" {
  const c = SHELL_CONTROL_INVENTORY.find((x) => x.id === id);
  return c ? c.action : "unknown";
}

/** No control may resolve to a fake/placeholder behavior. */
export function hasPlaceholderBehavior(id: string): boolean {
  const c = SHELL_CONTROL_INVENTORY.find((x) => x.id === id);
  if (!c) return true;
  if (c.action === "static") return false;
  return c.actionRef === undefined || /coming soon|敬请期待/i.test(c.actionRef);
}
