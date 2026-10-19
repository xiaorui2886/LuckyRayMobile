// Bridge durable local-data commits to the connection snapshot used by
// Settings/Home. This keeps conn_state event-driven instead of polling it.

import { dataStore } from "./dataStore.ts";

export type ConnectionStateRefresh = () => void | Promise<unknown>;

export function refreshConnectionStateOnDataCommit(refresh: ConnectionStateRefresh): () => void {
  return dataStore.subscribe(() => {
    try {
      void Promise.resolve(refresh()).catch(() => {
        // conn_state is best-effort while pairing/revoking; the screen keeps
        // its last coherent snapshot until the next committed event.
      });
    } catch {
      // Match the non-fatal refresh behavior used by the app shell.
    }
  });
}
