// Cached-body provenance helpers (STABILITY-FIX-R1 Finding A).
//
// A Desktop change/summary page may carry a revision WITHOUT `content`. The
// Rust cache keeps two facts apart and exposes them here:
//
//   serverDocument — the latest remote observation (may be a metadata summary)
//   cachedDocument — the last COMPLETE server document (with content +
//                    resources) the phone actually owns
//   revision       — the revision the cached BODY corresponds to
//   bodyOutdated   — true when a readable body exists but the latest remote
//                    observation is a different revision
//
// The editor must decide "can I read/continue this note?" from the CACHED BODY,
// never from the summary — otherwise a bodyless summary makes a perfectly
// readable offline note look uncached.
//
// Pure and dependency-free so the semantics are unit-testable.

/** Shape of a cached Desktop note as returned by the Mobile local API. */
export type CachedNote = {
  content?: string;
  revision?: string;
  dirty?: boolean;
  deleted?: boolean;
  pendingKind?: string;
  titleNeedsCorrection?: boolean;
  operationPaused?: boolean;
  serverDocument?: { content?: string; revision?: string; resources?: any[] } | null;
  cachedDocument?: { content?: string; revision?: string; resources?: any[] } | null;
  bodyOutdated?: boolean;
  conflictDocument?: { content?: string; deleted?: boolean } | null;
};

/**
 * True when the phone holds a readable body for this note.
 *
 * A dirty draft is always readable (the user typed it). Otherwise the cached
 * body document must exist — `content: ""` counts, because an explicitly empty
 * body is a real, complete body.
 */
export function hasReadableBody(note: CachedNote | null): boolean {
  if (!note) return false;
  if (note.dirty) return true;
  return note.cachedDocument !== null && note.cachedDocument !== undefined && note.cachedDocument.content !== undefined;
}

// ---------------------------------------------------------------------------
// Unified status (FINAL-CLOSURE-R1 P2-1).
//
// ONE priority table for every surface that shows how a Desktop note stands.
// The list badge and the detail header both read from here, so an
// only-metadata note can never read "已同步" in the list while the detail says
// "仅同步元数据".
//
// Priority (frozen by #33):
//   1. conflict            -> 需处理冲突
//   2. dirty delete        -> 待同步删除
//   3. dirty               -> 待同步
//   4. no readable body    -> 仅同步元数据
//   5. body outdated       -> 缓存版本            (never "已同步")
//   6. complete + current  -> 已同步
//
// Readability is decided by `hasReadableBody` ONLY — never re-derived here.
// ---------------------------------------------------------------------------

export type NoteStatusKey =
  | "conflict"
  | "pending-delete"
  | "pending"
  | "title-required"
  | "operation-paused"
  | "metadata-only"
  | "cached-outdated"
  | "synced";

export type NoteStatus = {
  key: NoteStatusKey;
  /** Compact label for a list badge. */
  label: string;
  /** Slightly richer label for a detail header. */
  headerLabel: string;
  /** Badge tone, mapping onto the existing meta-tag classes. */
  tone: "neutral" | "warn" | "danger";
  /** True ONLY for a complete, current, clean body. */
  isSynced: boolean;
};

export function noteStatus(note: CachedNote | null): NoteStatus {
  if (!note) {
    return { key: "metadata-only", label: "仅同步元数据", headerLabel: "仅同步元数据", tone: "neutral", isSynced: false };
  }
  // 1. A conflict outranks every other state.
  if (note.conflictDocument) {
    return { key: "conflict", label: "需处理冲突", headerLabel: "需处理冲突", tone: "danger", isSynced: false };
  }
  // 2/3. Local changes not yet pushed.
  if (note.dirty) {
    if (note.operationPaused) {
      return { key: "operation-paused", label: "同步已暂停 · 需处理", headerLabel: "已保存在手机 · 同步已暂停，需处理", tone: "warn", isSynced: false };
    }
    if (note.pendingKind !== "delete" && note.titleNeedsCorrection) {
      return { key: "title-required", label: "需填写有效标题", headerLabel: "已保存在手机 · 请填写有效标题", tone: "warn", isSynced: false };
    }
    return note.pendingKind === "delete"
      ? { key: "pending-delete", label: "待同步删除", headerLabel: "待同步删除", tone: "warn", isSynced: false }
      : { key: "pending", label: "待同步", headerLabel: "已保存在手机 · 待同步", tone: "warn", isSynced: false };
  }
  // 4. Nothing readable offline: say so instead of claiming a sync state.
  if (!hasReadableBody(note)) {
    return { key: "metadata-only", label: "仅同步元数据", headerLabel: "仅同步元数据", tone: "neutral", isSynced: false };
  }
  // 5. Readable body, but the Desktop has moved on.
  if (note.bodyOutdated) {
    return { key: "cached-outdated", label: "缓存版本", headerLabel: "缓存版本 · 电脑已更新", tone: "neutral", isSynced: false };
  }
  // 6. Complete, current, clean.
  return { key: "synced", label: "已同步", headerLabel: "已同步", tone: "neutral", isSynced: true };
}

/** CSS class for a note status badge (empty string = default meta-tag look). */
export function noteStatusClass(status: NoteStatus): string {
  return status.tone === "neutral" ? "" : status.tone;
}

/**
 * Resources to render in the reading view: those belonging to the CACHED BODY
 * revision, never a summary's (which has none). Using the summary here would
 * blank out attachments that are still legitimately cached.
 */
export function cachedResources(note: CachedNote | null): any[] {
  return note?.cachedDocument?.resources ?? [];
}

/** The revision the cached body corresponds to (the edit baseline). */
export function bodyRevision(note: CachedNote | null): string {
  return note?.revision ?? "";
}

/**
 * A concise, non-blocking status line: the body is readable but the Desktop has
 * moved on. Returns null when there is nothing worth saying.
 */
export function cachedBodyNotice(note: CachedNote | null): string | null {
  if (!note || note.dirty || !note.bodyOutdated) return null;
  const latest = note.serverDocument?.revision;
  return latest ? `已缓存版本 · 电脑上已更新（${latest.slice(0, 6)}）` : "已缓存版本 · 电脑上已更新";
}

/** The offline "no body yet" message, only when there is genuinely no body. */
export function missingBodyMessage(note: CachedNote | null): string | null {
  if (note?.dirty || hasReadableBody(note)) return null;
  return "正文尚未缓存，请连接电脑后再打开。";
}
