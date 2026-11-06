/** A library switch must never retire a save owner with a newer draft/IME input. */
export async function leaveNoteForVault(owner: {
  current: () => boolean;
  composing: () => boolean;
  activity: () => string;
  save: () => Promise<boolean>;
  pending: () => boolean;
  commit: () => void;
}): Promise<boolean> {
  if (!owner.current() || owner.composing()) return false;
  const activity = owner.activity();
  if (!await owner.save()) return false;
  if (!owner.current() || owner.composing() || activity !== owner.activity() || owner.pending()) return false;
  owner.commit();
  return true;
}
