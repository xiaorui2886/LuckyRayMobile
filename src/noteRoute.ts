/** Entry mode is not document identity. Keep the full Desktop owner scope. */
export const NOTE_EDIT_PREFIX = "edit:";

export function noteRouteIdentity(detail: string): string | undefined {
  const id = detail.startsWith(NOTE_EDIT_PREFIX) ? detail.slice(NOTE_EDIT_PREFIX.length) : detail;
  if (id.startsWith("note-")) return JSON.stringify(["local", id]);
  const parts = id.split(":");
  if (parts.length !== 4 || parts[0] !== "desktop" || parts.slice(1).some(part => !part)) return;
  try { return JSON.stringify(["desktop", ...parts.slice(1).map(part => decodeURIComponent(part))]); }
  catch { return; } // malformed routes must not alias a valid note
}
