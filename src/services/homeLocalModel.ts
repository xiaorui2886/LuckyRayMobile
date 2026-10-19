// Home local-first view model (M2.10 Scope A).
//
// Pure functions so the exact semantics are unit-testable:
//  - Home renders REAL Mobile-owned recent content + counts from the Local
//    Inbox / Local Note / Local Asset stats — never from Desktop stats;
//  - the model is identical for paired=false and paired=true (Desktop is only
//    a secondary connection hint rendered by the screen);
//  - recent route mapping: Local Asset -> `local:<assetId>` detail,
//    Local Note -> local NoteEditor, Local Inbox -> Inbox detail.

export type HomeLocalStats = {
  inbox: number;
  notes: number;
  assets: number;
};

export type HomeRecent = {
  assets: any[];
  notes: any[];
  inbox: any[];
};

export function homeLocalStats(
  inboxStats: { total: number } | null,
  noteStats: { total: number } | null,
  assetStats: { total: number } | null
): HomeLocalStats {
  return {
    inbox: inboxStats?.total ?? 0,
    notes: noteStats?.total ?? 0,
    assets: assetStats?.total ?? 0,
  };
}

/** Route for a recent Local Asset card (Local Asset detail). */
export function homeAssetRoute(assetId: string): string {
  return `local:${assetId}`;
}

/** Route for a recent Local Note card (local NoteEditor). */
export function homeNoteRoute(noteId: string): string {
  return noteId;
}

/** Route for a recent Local Inbox card (Inbox detail). */
export function homeInboxRoute(itemId: string): string {
  return itemId;
}

/**
 * Title for a recent Local Inbox card: title first, then the item URL
 * (FIX-V1 P2 — Link rows must prefer `item.url` over the generic fallback),
 * then a short text / attachment-file fallback, then the generic label.
 */
export function homeInboxTitle(item: {
  title?: string;
  url?: string;
  text?: string;
  attachment?: { fileName?: string };
}): string {
  return item.title || item.url || item.text?.slice(0, 40) || item.attachment?.fileName || "本地收集";
}

/**
 * Truthful Desktop hint state (FIX-V1 P2): pairing metadata does NOT prove
 * the Desktop is online. The dot is online only when actual WS connection
 * state says connected/connecting; anything else is offline/neutral.
 */
export function homeDesktopOnline(wsState: string): boolean {
  return wsState === "connected" || wsState === "connecting";
}

/** Recent slices are bounded — Home never loads hundreds of rows. */
export const HOME_RECENT_LIMIT = 3;

export function recentSlice<T>(items: T[]): T[] {
  return items.slice(0, HOME_RECENT_LIMIT);
}

export function homeRecentLimitCheck(): number {
  return HOME_RECENT_LIMIT;
}

// ---------------------------------------------------------------------------
// UI-REFRESH-R1 — the unified "最近" timeline.
//
// Home used to render three separate lists (最近素材 / 最近笔记 / 最近收集),
// each with its own "查看全部". They competed for attention and pushed the
// real content below fold. This merges them into ONE time-ordered list where
// every row keeps an explicit source label, so the Mobile-local vs 收集箱
// distinction stays unambiguous.
// ---------------------------------------------------------------------------

export type RecentDomain = "note" | "asset" | "inbox";

export type RecentEntry = {
  domain: RecentDomain;
  id: string;
  title: string;
  subtitle: string;
  /** Leading-art kind (image/video/document/file/text/link). */
  kind: string;
  /** Source badge text — never lets a local item read as Desktop content. */
  sourceLabel: string;
  source: "local" | "inbox";
  /** ISO timestamp used only for ordering. */
  at: string;
};

/** Entries shown in the unified timeline (bounded, newest first). */
export const HOME_TIMELINE_LIMIT = 6;

function stamp(value: unknown): string {
  return typeof value === "string" && value ? value : "";
}

/**
 * Merge the three local domains into one newest-first timeline.
 *
 * Ordering is by the item's own updated/created timestamp, so a just-edited
 * note can surface above a just-imported asset. Rows missing a timestamp sort
 * last (stable within their domain) rather than jumping to the top.
 */
export function mergeRecent(
  input: { assets?: any[]; notes?: any[]; inbox?: any[] },
  limit = HOME_TIMELINE_LIMIT
): RecentEntry[] {
  const entries: RecentEntry[] = [];

  for (const a of input.assets ?? []) {
    entries.push({
      domain: "asset",
      id: a.assetId,
      title: a.name || "未命名素材",
      subtitle: `${kindLabel(a.kind)} · 本机素材`,
      kind: a.kind || "file",
      sourceLabel: a.source === "inbox" ? "收集箱" : "本机",
      source: "local",
      at: stamp(a.updatedAt) || stamp(a.createdAt),
    });
  }

  for (const n of input.notes ?? []) {
    entries.push({
      domain: "note",
      id: n.noteId,
      title: n.title || "无标题笔记",
      subtitle: [n.pinned ? "置顶" : "", fmtWhen(n.updatedAt)].filter(Boolean).join(" · ") || "本地笔记",
      kind: "text",
      sourceLabel: "本机",
      source: "local",
      at: stamp(n.updatedAt) || stamp(n.createdAt),
    });
  }

  for (const i of input.inbox ?? []) {
    entries.push({
      domain: "inbox",
      id: i.itemId,
      title: homeInboxTitle(i),
      subtitle: `${inboxKindLabel(i.kind)} · 收集箱`,
      kind: i.kind || "text",
      sourceLabel: "收集箱",
      source: "inbox",
      at: stamp(i.updatedAt) || stamp(i.createdAt),
    });
  }

  // Newest first; entries without a timestamp keep their input order at the end.
  const withTime = entries.filter((e) => e.at);
  const withoutTime = entries.filter((e) => !e.at);
  withTime.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return [...withTime, ...withoutTime].slice(0, limit);
}

function fmtWhen(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  return value.replace("T", " ").slice(0, 16);
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "image":
      return "图片";
    case "video":
      return "视频";
    case "document":
      return "文档";
    default:
      return "文件";
  }
}

function inboxKindLabel(kind: string): string {
  switch (kind) {
    case "link":
      return "链接";
    case "image":
    case "photo":
      return "图片";
    case "file":
      return "文件";
    default:
      return "文本";
  }
}
