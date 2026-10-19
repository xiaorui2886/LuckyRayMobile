import type { Route } from "../navigation";
import { NOTE_EDIT_PREFIX } from "../noteRoute.ts";
export { NOTE_EDIT_PREFIX } from "../noteRoute.ts";
const ROOT_SCENE_DETAILS: Record<string, string> = {
  inbox: "inbox", preferences: "preferences", appearance: "appearance",
  storage: "storage", diagnostics: "diagnostics", recovery: "recovery",
  "connect-computer": "connect",
};
export type Scene = { name: string; id?: string; key: number; startInEdit?: boolean };

/** Presentation only: derive a page without changing the navigation authority. */
export function stillScene(route: Route, key: number): Scene | null {
  const r = route;
  if (r.tab === "search") return { name: "search", key };
  if (r.tab === "capture" && !r.detail) return { name: "capture", key };
  if (r.tab === "capture" && r.detail) return { name: "inbox-detail", id: r.detail, key };
  if (r.detail?.startsWith("entry:")) return { name: "inbox-detail", id: r.detail.slice("entry:".length), key };
  // Support pages attach to the initiating root, so resolve them before
  // generic asset/note/run details (Knowledge -> connect is not a note).
  if (r.detail && Object.prototype.hasOwnProperty.call(ROOT_SCENE_DETAILS, r.detail)) return { name: ROOT_SCENE_DETAILS[r.detail], key };
  if (r.tab === "library" && r.detail) return { name: "asset", id: r.detail, key };
  if (r.tab === "knowledge" && r.detail === "new") return { name: "new-note", key };
  if (r.tab === "knowledge" && r.detail?.startsWith(NOTE_EDIT_PREFIX))
    return { name: "note", id: r.detail.slice(NOTE_EDIT_PREFIX.length), key, startInEdit: true };
  if (r.tab === "knowledge" && r.detail) return { name: "note", id: r.detail, key };
  if (r.tab === "ai" && r.detail) return { name: "run", id: r.detail, key };
  if (r.tab === "settings" && r.detail) return { name: r.detail, key };
  return null;
}
