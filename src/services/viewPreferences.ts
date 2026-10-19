// View preferences (UI-REFRESH-R1) — Mobile-frontend-only display choices.
//
// The library grid/list choice and the sort order are pure presentation
// preferences. They are held in memory (and mirrored to localStorage only as
// a convenience) so that navigating away and back keeps the user's choice.
// Nothing here touches data authority, ordering semantics of the backend, or
// cross-device contracts: sorting is applied to the already-returned rows.

export type LibraryView = "grid" | "list";
export type SortKey = "recent" | "name" | "size";

const VIEW_KEY = "luckyray.view.library";
const SORT_KEY = "luckyray.sort.library";
const NOTES_SORT_KEY = "luckyray.sort.notes";

function read(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* a session-only preference is still a valid preference */
  }
}

let libraryView: LibraryView = (read(VIEW_KEY, "grid") as LibraryView) === "list" ? "list" : "grid";
let librarySort: SortKey = normalizeSort(read(SORT_KEY, "recent"));
let notesSort: SortKey = normalizeSort(read(NOTES_SORT_KEY, "recent"));

function normalizeSort(value: string): SortKey {
  return value === "name" || value === "size" ? value : "recent";
}

export function getLibraryView(): LibraryView {
  return libraryView;
}

export function setLibraryView(view: LibraryView): LibraryView {
  libraryView = view;
  write(VIEW_KEY, view);
  return libraryView;
}

export function getLibrarySort(): SortKey {
  return librarySort;
}

export function setLibrarySort(sort: SortKey): SortKey {
  librarySort = sort;
  write(SORT_KEY, sort);
  return librarySort;
}

export function getNotesSort(): SortKey {
  return notesSort;
}

export function setNotesSort(sort: SortKey): SortKey {
  notesSort = sort;
  write(NOTES_SORT_KEY, sort);
  return notesSort;
}

export const SORT_LABELS: Record<SortKey, string> = {
  recent: "最近更新",
  name: "名称",
  size: "大小",
};

export type Sortable = {
  name?: string;
  title?: string;
  sizeBytes?: number;
  updatedAt?: string;
  createdAt?: string;
};

function sortStamp(row: Sortable): string {
  return row.updatedAt || row.createdAt || "";
}

function sortLabel(row: Sortable): string {
  return (row.name || row.title || "").toLowerCase();
}

/**
 * Order already-fetched rows for display. `recent` is the default and keeps
 * the backend's own ordering (newest first) untouched; `name`/`size` are
 * explicit user choices applied client-side to the loaded page.
 */
export function sortRows<T extends Sortable>(rows: T[], sort: SortKey): T[] {
  if (sort === "recent") {
    return [...rows].sort((a, b) => (sortStamp(a) < sortStamp(b) ? 1 : sortStamp(a) > sortStamp(b) ? -1 : 0));
  }
  if (sort === "name") {
    return [...rows].sort((a, b) => sortLabel(a).localeCompare(sortLabel(b), "zh-Hans-CN"));
  }
  return [...rows].sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
}
