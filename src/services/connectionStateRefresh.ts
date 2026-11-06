// Bridge durable local-data commits to the connection snapshot used by
// Settings/Home. This keeps conn_state event-driven instead of polling it.

import { dataStore } from "./dataStore.ts";

export type ConnectionStateRefresh = () => void | Promise<unknown>;

type ConnectionSnapshot = { paired: boolean; identity: { instanceId: string } | null; ws: { state: string } };

/** Native reconnect hints can arrive while React still holds "connected".
 * Keep the hint across superseding reads, then validate the current native
 * peer before releasing a retired sync schedule. Ordinary refreshes do not
 * clear authorization failures, and stale reads cannot publish or release it.
 */
export function createConnectionSnapshotRefresh<T extends ConnectionSnapshot>(
  read: () => Promise<T>, publish: (value: T) => void, reconnected: (instance: string) => void,
): (reconnectedInstance?: string) => Promise<void> {
  let generation = 0, pendingInstance = "";
  return async (reconnectedInstance?: string) => {
    if (typeof reconnectedInstance === "string" && reconnectedInstance) pendingInstance = reconnectedInstance;
    const request = ++generation;
    try {
      const value = await read();
      if (request !== generation) return;
      publish(value);
      if (!value.paired || value.identity?.instanceId !== pendingInstance) pendingInstance = "";
      if (pendingInstance && value.ws.state === "connected") {
        const instance = pendingInstance; pendingInstance = "";
        reconnected(instance);
      }
    } catch { /* Retain the same-peer hint for the next coherent native read. */ }
  };
}

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
