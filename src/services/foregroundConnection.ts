/** Deduplicates Android focus/visibility signals. Authority stays in conn_resume:
 * this helper never calls ws_start or changes the user's connection intent. */
export function foregroundConnection(resume: () => Promise<unknown>, refresh: () => Promise<unknown>) {
  let pending: Promise<void> | null = null;
  return () => {
    if (pending) return pending;
    pending = (async () => {
      try { await resume(); } catch { /* retry remains governed by native intent */ }
      await refresh();
    })().finally(() => { pending = null; });
    return pending;
  };
}
