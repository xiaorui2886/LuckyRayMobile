// KNOWLEDGE-ORGANIZATION-R1 R1.5-A — the READ-ONLY directory metadata
// hydration driver.
//
// The user's physical finding: Desktop notes were visible through canonical
// browse, but Mobile's directory choices derive ONLY from the local
// note_cache relative_path projection — which the canonical pipeline never
// hydrates — so the directory sheet looked empty and moves could not be
// exercised.
//
// This driver opens the sheet against the ALREADY-CACHED directories
// immediately, then runs the Mobile-local `content_hydrate_directories`
// command in the background (Content V1 note SUMMARY pages; never
// content_sync — hydration must never push pending writes/attachments).
// Every await is owner/vault fenced: a page that lands after the sheet's
// scope changed is dropped whole.
//
// Truth states:
//   "cached"     — cached dirs are on screen, live hydration in flight;
//   "hydrated"   — the background hydration finished (dirs refreshed);
//   "failed"     — live hydration failed; cached dirs stay with truthful copy;
//   "unsynced"   — offline and nothing was ever synced: 「尚未同步目录」,
//                  never a fake successful empty directory list.

export type HydrationStatus = "cached" | "hydrated" | "failed" | "unsynced" | "offline-cached";

// ---------------------------------------------------------------------------
// REPAIR-R1.5.2 — the SESSION-LEVEL hydration continuation, keyed by the
// exact `instance|vault`. This is UI/session continuation ONLY (never
// localStorage, never the business DB): it lets the NEXT sheet run resume
// at the retained cursor instead of silently restarting page 1 on a large
// vault. A completed scope records completion; a fresh full pass on a later
// open is a NEW completion cycle.
// ---------------------------------------------------------------------------

type HydrationContinuation = {
  nextAfterId: string;
  /** True while the scope finished a full pass (a later open starts fresh). */
  completed: boolean;
};

const hydrationContinuations = new Map<string, HydrationContinuation>();

const continuationKey = (instanceId: string, vaultId: string) => `${instanceId}|${vaultId}`;

/** The retained continuation for the exact scope (null = start from page 1). */
export function hydrationCursorFor(instanceId: string, vaultId: string): HydrationContinuation | null {
  const c = hydrationContinuations.get(continuationKey(instanceId, vaultId));
  if (!c || c.completed) return null;
  return c;
}

/** Retain the continuation after one page (R1.5.2: survives sheet closes). */
export function retainHydrationCursor(instanceId: string, vaultId: string, nextAfterId: string, completed: boolean): void {
  hydrationContinuations.set(continuationKey(instanceId, vaultId), { nextAfterId, completed });
}

export type HydrationDeps = {
  /**
   * R1.5.1: the Mobile-local read-only hydration command — ONE bounded page
   * per call, RESUMED from the previous call's real cursor (nextAfterId).
   * The driver threads the cursor; no invocation may restart page 1 while
   * hasMore remains true.
   */
  hydrate: (instanceId: string, vaultId: string, afterId: string | null) => Promise<{ nextAfterId: string; hasMore: boolean; applied: number }>;
  /** The cached directory projection read. */
  readDirectories: (instanceId: string, vaultId: string) => Promise<string[]>;
  /** The scope key this run was started for (owner/vault fencing). */
  scopeKey: () => string;
  /** Coalesce bound: continuation chunks per run (bounded, defensive). */
  maxChunks?: number;
};

export type HydrationEvents = {
  onDirectories: (dirs: string[]) => void;
  onStatus: (status: HydrationStatus) => void;
};

/**
 * ONE hydration run for the exact (instanceId, vaultId). The caller captures
 * the scope key at start; every continuation chunk re-proves it, so an owner
 * or vault change mid-run drops the remaining chunks whole (the Rust command
 * itself is exact-instance fenced as the second layer).
 */
export async function runDirectoryHydration(
  deps: HydrationDeps,
  instanceId: string,
  vaultId: string,
  connected: boolean,
  events: HydrationEvents,
): Promise<void> {
  const scopeAtStart = deps.scopeKey();
  const stillCurrent = () => deps.scopeKey() === scopeAtStart;
  // R1.5.1: the bound covers a 6000-note vault in one sheet run (60 pages);
  // a larger vault stays truthfully 正在同步目录… and resumes on the next
  // open through the retained cursor semantics of the projection.
  const maxChunks = deps.maxChunks ?? 60;

  // 1. The CACHED projection paints immediately.
  const cached = await deps.readDirectories(instanceId, vaultId).catch(() => null);
  if (!stillCurrent()) return;
  if (cached) events.onDirectories(cached);

  // 2. Offline: truthful state. With no cached directories this is
  // 「尚未同步目录」 — never a fake empty successful list.
  if (!connected) {
    events.onStatus(cached && cached.length > 0 ? "offline-cached" : "unsynced");
    return;
  }

  // 3. Live background hydration over the summary pages, threaded through
  // the REAL cursor — seeded from the SESSION-LEVEL continuation so the next
  // sheet run resumes at the retained cursor instead of restarting page 1.
  events.onStatus("cached");
  let afterId: string | null = hydrationCursorFor(instanceId, vaultId)?.nextAfterId || null;
  for (let chunk = 0; chunk < maxChunks; chunk += 1) {
    const result: { nextAfterId: string; hasMore: boolean; applied: number } | null =
      await deps.hydrate(instanceId, vaultId, afterId).catch(() => null);
    if (!stillCurrent()) {
      // R1.5.2: even a dropped run RETAINS its cursor for the next open.
      if (result?.nextAfterId) {
        retainHydrationCursor(instanceId, vaultId, result.nextAfterId, false);
      }
      return;
    }
    if (!result) {
      // Live hydration failed: the cached dirs stay with truthful copy.
      events.onStatus("failed");
      return;
    }
    afterId = result.nextAfterId || null;
    // R1.5.2: the continuation is retained after EVERY page.
    retainHydrationCursor(instanceId, vaultId, result.nextAfterId, !result.hasMore);
    // Refresh the projection incrementally after each chunk.
    const dirs = await deps.readDirectories(instanceId, vaultId).catch(() => null);
    if (!stillCurrent()) return;
    if (dirs) events.onDirectories(dirs);
    if (!result.hasMore) {
      events.onStatus("hydrated");
      return;
    }
  }
  // The bound was hit while hasMore is still true: NEVER say hydrated — the
  // truthful still-syncing state stays, and the next sheet open resumes from
  // the RETAINED session cursor (not page 1).
  events.onStatus("cached");
}
