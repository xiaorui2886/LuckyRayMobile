// SERVICES-INTEGRATION-R2 — compile-time acceptance gate.
//
// The ONLY way the acceptance driver exists in a bundle is the BUILD-TIME
// environment flag `VITE_LUCKYRAY_SERVICES_ACCEPTANCE=1` (vite statically
// replaces `import.meta.env.*`, so a normal build evaluates this to a constant
// false and the gated dynamic import in main.tsx is dead-code eliminated —
// the driver module is not shipped at all, let alone reachable).
//
// `import.meta.env.DEV` is deliberately NOT used: the acceptance APK is a
// release-mode bundle where DEV is false.

/**
 * Is the acceptance surface compiled in? The optional parameter exists ONLY so
 * tests can inject an environment; production calls it with no argument.
 *
 * Semantics are EXACTLY the main.tsx build gate: only the string `"1"`
 * enables — vite statically replaces `import.meta.env.*` with strings, so the
 * helper matches what the bundle actually folds.
 */
export function servicesAcceptanceEnabled(env: unknown = import.meta.env): boolean {
  let flag: unknown;
  try {
    flag = (env as Record<string, unknown> | null | undefined)?.VITE_LUCKYRAY_SERVICES_ACCEPTANCE;
  } catch {
    return false;
  }
  return flag === "1";
}
