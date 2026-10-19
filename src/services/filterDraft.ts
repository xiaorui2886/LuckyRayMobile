// Filter draft controller (INTERACTION-CLOSURE-R1).
//
// Pure, framework-free state machine behind EVERY user-visible filter/sort
// sheet: open snapshots the APPLIED state into a draft; option edits touch
// only the draft; commit() returns the new applied state (the screen then
// triggers its real request/reload); cancel/backdrop/Back simply discard.
// This is what makes "看起来能点" sheets actually functional, and what the
// behavior tests exercise.

export type LibraryFilterState = {
  kind: string;
  favoriteOnly: boolean;
  archivedOnly: boolean;
  sort: string;
  view: "grid" | "list";
  /** Local tag filter (USABILITY-R1 A3). Local-only: never sent to Desktop. */
  tag: string;
};

export type KnowledgeFilterState = {
  mode: "local" | "pinned" | "favorite" | "archived";
  sort: string;
  tag: string;
};

export function defaultLibraryFilter(): LibraryFilterState {
  return { kind: "全部", favoriteOnly: false, archivedOnly: false, sort: "recent", view: "grid", tag: "" };
}

export function defaultKnowledgeFilter(): KnowledgeFilterState {
  return { mode: "local", sort: "recent", tag: "" };
}

export class FilterDraft<S> {
  private applied: S;
  private draft: S;
  private open = false;
  private defaults: () => S;

  constructor(defaults: () => S) {
    this.defaults = defaults;
    this.applied = defaults();
    this.draft = defaults();
  }

  /**
   * R4.3 (P1-R42-3): restore the APPLIED state from a retained session
   * identity (Knowledge remount). The DEFAULTS factory is untouched, so
   * 重置 still returns the REAL defaults — only what is currently applied
   * changes, keeping the sheet in sync with what the list is filtered by.
   */
  restoreApplied(state: S): void {
    this.applied = { ...state };
    if (!this.open) this.draft = { ...state };
  }

  /** Open the sheet: the draft starts from the CURRENT applied state. */
  begin(): S {
    this.open = true;
    this.draft = { ...this.applied };
    return this.draft;
  }

  /** Draft-only edit; applied state is untouched until commit(). */
  edit(patch: Partial<S>): S {
    this.draft = { ...this.draft, ...patch };
    return this.draft;
  }

  /** Reset the DRAFT to defaults; applied is untouched until commit(). */
  reset(): S {
    this.draft = this.defaults();
    return this.draft;
  }

  /** Apply: promote the draft to applied and close. */
  commit(): S {
    this.applied = { ...this.draft };
    this.open = false;
    return this.applied;
  }

  /** Cancel / backdrop / Back: discard the draft; applied unchanged. */
  cancel(): S {
    this.open = false;
    return this.applied;
  }

  getApplied(): S {
    return this.applied;
  }

  getDraft(): S {
    return this.draft;
  }

  isOpen(): boolean {
    return this.open;
  }
}
