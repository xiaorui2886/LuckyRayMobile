// STILL-01.1 host adapters (parity rebuild R1).
//
// The ONLY bridge between production authorities and the Still 01.1 kit.
// Authority copies in this folder stay presentation-only; every host-specific
// mapping lives here.

export type Connection = "unknown" | "unpaired" | "connecting" | "connected" | "offline" | "re-pair";
export type StillNoteState = "local" | "synced" | "metadata" | "outdated" | "pending" | "conflict" | "error";

import { useCallback } from "react";
import { overlayStack } from "../../services/overlayStack";
import type { ConnState } from "../../services/client";
import { noteStatus, hasReadableBody, type CachedNote } from "../../services/noteProvenance";

/** Project the real connection state from connState (never a timer/copy). */
export function connectionOf(conn: ConnState | null): Connection {
  if (!conn) return "unknown";
  if (!conn.paired) return "unpaired";
  const s = conn.ws?.state ?? "";
  if (s === "connected") return "connected";
  if (s === "connecting" || s === "reconnecting") return "connecting";
  if (s === "re_pair_required") return "re-pair";
  return "offline";
}

/** Register a Still Sheet into the production overlayStack (Android Back). */
export function useOverlayRegister() {
  return useCallback((dismiss: () => void) => overlayStack.push(dismiss), []);
}

/** Map the REAL noteProvenance status onto the Still NoteState projection.
 *  Provenance is NEVER inferred from UI labels. */
export function stillNoteState(note: CachedNote | null, isLocal: boolean): StillNoteState {
  if (isLocal) return "local";
  const s = noteStatus(note);
  switch (s.key) {
    case "conflict": return "conflict";
    case "pending-delete":
    case "title-required":
    case "operation-paused":
    case "pending": return "pending";
    case "metadata-only": return "metadata";
    case "cached-outdated": return "outdated";
    case "synced": return "synced";
  }
}

export { noteStatus, hasReadableBody };
