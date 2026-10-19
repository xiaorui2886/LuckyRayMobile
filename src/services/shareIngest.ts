// Android Share ingest → Mobile-local invalidation decision (FIX-V1 P1-3A).
//
// Dependency-free: App.tsx publishes an Inbox commit ONLY when the ingest
// actually consumed new shares. A focus/visibility reconciliation sweep that
// consumed zero items is not a mutation, and a failed ingest must publish
// nothing — both would otherwise trigger false refreshes (and false Home /
// Settings / search re-reads).

export type ShareIngestResult = { consumed?: number } | null | undefined;

/** True only when the ingest result reports at least one consumed share. */
export function shouldPublishInboxCommit(result: ShareIngestResult): boolean {
  return Boolean(result && typeof result.consumed === "number" && result.consumed > 0);
}
