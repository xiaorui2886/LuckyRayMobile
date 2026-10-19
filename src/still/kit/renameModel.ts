// A0-closure R2: rename async-completion helper (behavior-tested).

export type RenameUiState = { open: boolean; value: string; busy: boolean };

export type RenameDecision =
  | { kind: "noop" }
  | { kind: "invalid" }
  | { kind: "submit"; value: string };

/** Classify a rename attempt (UI + tests share one model). */
export function renameDecision(currentTitle: string, input: string): RenameDecision {
  const value = input.trim();
  if (!value) return { kind: "invalid" };
  if (value === currentTitle.trim()) return { kind: "noop" };
  return { kind: "submit", value };
}

/** Apply a rename persistence result to the rename UI state.
 *  success  → close the sheet (busy cleared);
 *  failure  → keep the sheet open, preserve the user text, clear busy. */
export async function applyRenameResult(
  persistence: Promise<boolean>,
  current: RenameUiState,
  set: (next: RenameUiState) => void
): Promise<void> {
  try {
    const ok = await persistence;
    if (ok) set({ open: false, value: current.value, busy: false });
    else set({ open: true, value: current.value, busy: false });
  } catch {
    set({ open: true, value: current.value, busy: false });
  }
}
