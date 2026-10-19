// Unified three-domain local search (M2.10 Scope B + FIX-V1 P1-1).
//
// One shared search session used by both the dedicated Local Search surface
// (LocalSearchScreen) and the Knowledge screen — so no search path can keep a
// silent page-1/limit-50 dead end while another is pageable.
//
// Correctness contract (implemented by the dependency-free
// `UnifiedSearchSession`, FIX-V1 P1-1):
//  - queries run through the existing `unifiedLocalSearch` backend contract
//    (typed note/inbox/asset results, ranking-before-truncation, exact pages);
//  - bounded Load More using the backend pagination;
//  - ONE request epoch: changing draft A → B invalidates A immediately at
//    input-change time (before the debounce fires); a late response from A
//    (page-1, load-more, or error) never overwrites B's draft or appends into
//    B's state;
//  - an error settles recoverably without desynchronizing the epoch — typing a
//    new query afterwards works;
//  - responses never write the user's draft text; clearing invalidates all;
//  - local-data invalidation refresh never restores an older active query over
//    a newer draft;
//  - results are NEVER client-side re-ranked (backend page order is authority);
//  - CJK-safe via the backend; no OCR/transcription/semantic/cloud search.

import { useCallback, useEffect, useState } from "react";
import { api } from "./client";
import { localDataStore } from "./localDataStore";
import { SEARCH_DEBOUNCE_MS } from "./searchContract";
import { UnifiedSearchSession, type UnifiedSearchState } from "./unifiedSearchSession";

export type { UnifiedSearchState };

/**
 * React hook for one generation-safe unified search session.
 * `setQuery` debounces the page-1 fetch (and invalidates the previous query
 * synchronously); `loadMore` appends the next exact page; local-data
 * mutations refresh the active query in place.
 */
export function useUnifiedSearch() {
  const [session] = useState(
    () => new UnifiedSearchSession((q, page, limit) => api.unifiedLocalSearch(q, page, limit), SEARCH_DEBOUNCE_MS)
  );
  const [state, setState] = useState<UnifiedSearchState>(() => session.getState());

  useEffect(() => session.subscribe((s) => setState(s)), [session]);

  // Live refresh: a successful Mobile-local mutation re-runs the ACTIVE query
  // (a newer draft typed by the user is never resurrected — see session).
  const localVersion = useLocalDataVersion();
  useEffect(() => {
    session.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localVersion, session]);

  // Cleanup pending debounce + listeners (StrictMode/HMR-safe).
  useEffect(() => () => session.dispose(), [session]);

  const setQuery = useCallback((q: string) => session.setQuery(q), [session]);
  const loadMore = useCallback(() => {
    void session.loadMore();
  }, [session]);

  return { state, setQuery, loadMore };
}

function useLocalDataVersion(): number {
  const [version, setVersion] = useState(() => localDataStore.getVersion());
  useEffect(() => {
    return localDataStore.subscribe(() => setVersion(localDataStore.getVersion()));
  }, []);
  return version;
}
