// The editor browser follows the knowledge list's in-session sort per vault.
// This is presentation only; it stores no notes, routes, or sync state.
type NotesSort = "name" | "recent";
const sorts = new Map<string, NotesSort>();
export function readNotesSort(vaultId: string): NotesSort { return sorts.get(vaultId) || "recent"; }
export function rememberNotesSort(vaultId: string, sort: NotesSort) { sorts.set(vaultId, sort); }
