// A0 R1.1: combined presentation derivation (pure, unit-tested).
// Search truth has two legitimate owners — the local unified-search session
// and the Desktop search authority. Neither may decide emptiness alone.
// SERVICES-SEARCH-R1: the Desktop authority is now the canonical
// `search.unified` RemoteSearchSnapshot (searchServicesController.ts); the
// legacy two-domain snapshot derivation is retained for its existing tests.
import type { SearchSnapshot } from "./searchController";
import type { RemoteSearchSnapshot } from "./searchServicesController";

export type SearchPresentation = {
  /** Show the loading state (no results yet, something still running). */
  loading: boolean;
  /** Emptiness is truthful only here. */
  empty: boolean;
};

export function deriveSearchPresentation(input: {
  localLoading: boolean;
  localCount: number;
  snapshot: SearchSnapshot;
}): SearchPresentation {
  const { localLoading, localCount, snapshot } = input;
  const desktopCount = snapshot.notes.items.length + snapshot.assets.items.length;
  const desktopSettled = snapshot.phase === "idle" || snapshot.phase === "settled" || snapshot.phase === "partial-failure";
  const settled = !localLoading && desktopSettled;
  return {
    loading: !settled && localCount + desktopCount === 0,
    empty: settled && localCount + desktopCount === 0,
  };
}

/**
 * SERVICES-SEARCH-R1: combined presentation for the canonical remote phase.
 *
 * Remote phases that truthfully END the remote side: ready / not-granted /
 * temporarily-unavailable / unsupported / error / idle. `loading` and
 * `loading-more` keep the page unsettled (loading-more still shows its rows).
 */
export function deriveSearchPagePresentation(input: {
  localLoading: boolean;
  localCount: number;
  remote: RemoteSearchSnapshot;
}): SearchPresentation {
  const { localLoading, localCount, remote } = input;
  const remoteSettled =
    remote.phase === "idle" || remote.phase === "ready" ||
    remote.phase === "unpaired" || remote.phase === "offline" ||
    remote.phase === "not-granted" || remote.phase === "temporarily-unavailable" ||
    remote.phase === "unsupported" || remote.phase === "error";
  const remoteCount = remote.hits.length;
  const settled = !localLoading && remoteSettled;
  return {
    loading: !settled && localCount + remoteCount === 0,
    empty: settled && localCount + remoteCount === 0,
  };
}
