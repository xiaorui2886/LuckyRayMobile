/**
 * M2.13 FIX-V2 #3 — the renderer must NOT hold a broad `opener:open-path`
 * authority over the whole app-data tree. FIX-V1 added
 * `opener:allow-open-path` with `$APPDATA/**` because the raw
 * `plugin:opener|open_path` path was being considered; FIX-V2 removes it:
 * external open goes exclusively through the app's controlled
 * `open_attachment` command (owner-root validated, non-exported
 * exportprovider + per-intent read grant). `opener:default` (open-url /
 * reveal-item-in-dir only) stays.
 *
 * NOTE: run with `node --experimental-strip-types --test` (CI convention).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CAP_FILE = join(import.meta.dirname, "..", "src-tauri", "capabilities", "default.json");

test("capability must NOT grant a broad opener:allow-open-path / APPDATA scope", () => {
  const cap = JSON.parse(readFileSync(CAP_FILE, "utf8"));
  const perms = cap.permissions as unknown[];
  const broad = perms.find(
    (p) =>
      typeof p === "object" &&
      p !== null &&
      (p as { identifier?: string }).identifier === "opener:allow-open-path"
  );
  assert.equal(broad, undefined, "opener:allow-open-path must NOT be granted to the renderer");
  // And no other permission object may smuggle an APPDATA path scope.
  for (const p of perms) {
    if (typeof p !== "object" || p === null) continue;
    const obj = p as { allow?: unknown };
    assert.ok(
      !JSON.stringify(obj.allow ?? []).includes("$APPDATA"),
      "no permission object may carry an $APPDATA path scope"
    );
  }
  // Sanity: the base sets are still present.
  for (const id of ["core:default", "opener:default"]) {
    assert.ok(perms.includes(id), `${id} must be present`);
  }
});
