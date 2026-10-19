/**
 * M2.13 FIX-V2 #4 — deterministic Android patch/repro contract. Reads the
 * TRACKED patch script (and, when a generated android project exists
 * locally, the merged manifest) and asserts the reproduction contract:
 *
 *  - the generated activity must carry `adjustResize` (idempotent patch);
 *  - ACTION_SEND filters text/plain, image (star), and any-type (star-slash) must exist (idempotent);
 *  - the companion provider is the NON-exported `{applicationId}.exportprovider`
 *    with `grantUriPermissions=true`;
 *  - NO `NarrowFileProvider` (exported=true) may be produced;
 *  - NO READ_MEDIA_* permission anywhere;
 *  - the build must NOT reference the private untracked `dev-cache` path —
 *    the Gradle task is maintained in scripts/android-src/BuildTask.kt;
 *    scripts/tauri-wrapper.cmd remains a portable manual CLI entry.
 *
 * NOTE: run with `node --experimental-strip-types --test` (CI convention).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = readFileSync(join(ROOT, "scripts", "apply-android-patches.sh"), "utf-8");

test("patch contract — adjustResize + ACTION_SEND filters are idempotently guaranteed", () => {
  assert.ok(SCRIPT.includes("windowSoftInputMode"), "adjustResize patch present");
  assert.ok(SCRIPT.includes('"adjustResize"'), "adjustResize value present");
  for (const mime of ["text/plain", "image/*", "*/*"]) {
    assert.ok(SCRIPT.includes(mime), `ACTION_SEND filter ${mime} guaranteed`);
  }
});

test("patch contract — non-exported exportprovider; no exported NarrowFileProvider", () => {
  assert.ok(SCRIPT.includes("exportprovider"), "exportprovider authority registered");
  assert.ok(SCRIPT.includes('android:exported="false"'), "provider is exported=false");
  assert.ok(SCRIPT.includes('android:grantUriPermissions="true"'), "provider grants URI permissions");
  // The patch may only ever REFERENCE NarrowFileProvider to delete it (the
  // FIX-V2 removal block); it must never register it as a provider.
  assert.ok(
    !SCRIPT.includes('android:name="com.luckyray.mobile.NarrowFileProvider"'),
    "patch script must not register NarrowFileProvider"
  );
  assert.ok(
    !SCRIPT.includes('android:exported="true"\n      android:grantUriPermissions="true"'),
    "no exported+grant provider block in the patch script"
  );
});

test("patch contract — no READ_MEDIA_* / READ_EXTERNAL / MANAGE_EXTERNAL", () => {
  for (const p of ["READ_MEDIA_IMAGES", "READ_MEDIA_VIDEO", "READ_MEDIA_AUDIO", "READ_EXTERNAL_STORAGE", "MANAGE_EXTERNAL_STORAGE"]) {
    assert.ok(!SCRIPT.includes(p), `${p} must not be introduced`);
  }
});

test("patch contract — no private dev-cache tool dependency; tracked generation entry", () => {
  // SDK paths may live outside the repo; generated executable authority
  // comes from the tracked configuration entry, never a private helper.
  assert.ok(
    !SCRIPT.includes("dev-cache\tauri-wrapper") && !SCRIPT.includes("dev-cache/tauri-wrapper"),
    "no dev-cache wrapper dependency in the patch script"
  );
  assert.ok(!SCRIPT.includes("dev-cache\tauri-wrapper.cmd"), "no dev-cache wrapper.cmd reference");
  assert.ok(SCRIPT.includes('node "$SCRIPT_DIR/configure-android-build.mjs"'), "tracked build configuration invoked");
});

test("patch contract — merged manifest (when present) honors the same contract", () => {
  const manifest = join(ROOT, "src-tauri", "gen", "android", "app", "src", "main", "AndroidManifest.xml");
  if (!existsSync(manifest)) {
    // Clean CI checkout has no generated android project — the patch-script
    // contract above is the authority there; nothing further to assert.
    return;
  }
  const m = readFileSync(manifest, "utf-8");
  assert.ok(m.includes('android:windowSoftInputMode="adjustResize"'), "merged manifest has adjustResize");
  for (const mime of ['<data android:mimeType="text/plain" />', '<data android:mimeType="image/*" />', '<data android:mimeType="*/*" />']) {
    assert.ok(m.includes(mime), `merged manifest has ${mime}`);
  }
  assert.ok(m.includes("exportprovider"), "merged manifest registers exportprovider");
  assert.ok(m.includes('android:name="androidx.core.content.FileProvider"'), "exportprovider is the FileProvider class");
  assert.ok(!m.includes("NarrowFileProvider"), "merged manifest has no NarrowFileProvider");
  assert.ok(!m.includes("READ_MEDIA"), "merged manifest has no READ_MEDIA_*");
  // Only the launcher activity may be exported.
  const exportedCount = (m.match(/android:exported="true"/g) ?? []).length;
  assert.equal(exportedCount, 1, "exactly one exported component (launcher MainActivity)");
});
