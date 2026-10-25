/** A cache snapshot must be taken after pending saves, and still belong to the
 * same effect/editor generation when it returns. Never adopt a pre-save read. */
export async function settledNoteRead<T>(options: {
  pending: readonly Promise<unknown>[];
  isCurrent: () => boolean;
  read: () => Promise<T>;
  apply: (value: T) => void;
}): Promise<boolean> {
  try {
    await Promise.all(options.pending);
    if (!options.isCurrent()) return false;
    const value = await options.read();
    if (!options.isCurrent()) return false;
    options.apply(value);
    return true;
  } catch { return false; }
}
