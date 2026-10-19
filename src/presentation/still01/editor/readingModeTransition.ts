/** Switch presentation only after the existing save owner has settled.
 * Never terminate IME composition or let an old async request dismiss newer input. */
export async function settleReadingMode(options: {
  isCurrent: () => boolean;
  isComposing: () => boolean;
  activity: () => number;
  flush: () => Promise<boolean>;
  hasUnsaved: () => boolean;
  commit: () => void;
}): Promise<boolean> {
  if (!options.isCurrent() || options.isComposing()) return false;
  const activity = options.activity();
  try { if (!(await options.flush())) return false; } catch { return false; }
  if (!options.isCurrent() || options.isComposing() || options.activity() !== activity || options.hasUnsaved()) return false;
  options.commit(); return true;
}
