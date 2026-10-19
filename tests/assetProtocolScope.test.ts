// Node.js regression assertion for the asset protocol scope (FIX-V1 P1-4).
// The WebView asset protocol must stay narrowed to the smallest proven paths:
//   - $APPDATA/files/local-assets/** — Local Asset originals + derived
//     thumbnails. NOTE: on Android, Tauri's $APPDATA resolves to
//     activity.dataDir (e.g. /data/user/0/com.luckyray.mobile), NOT
//     getFilesDir(); Local Asset files live under files/local-assets/, so the
//     narrowest working syntax verified on MI 8 is $APPDATA/files/local-assets/**.
//   - $CACHE/** — existing Mobile cached Desktop-thumbnail files (cache root,
//     thumb-{instance}-{asset}-{rev}.img — no narrower subdirectory exists).
// $RESOURCE/** and a bare $APPDATA/** (which would expose unrelated
// app-private files to the WebView) are forbidden without explicit review.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const confPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "tauri.conf.json");
const conf = JSON.parse(readFileSync(confPath, "utf-8"));
const scope: string[] = conf?.app?.security?.assetProtocol?.scope ?? [];

test("assetProtocol scope is enabled and present", () => {
  assert.equal(conf.app.security.assetProtocol.enable, true);
  assert.ok(Array.isArray(scope) && scope.length > 0, "scope must not be empty");
});

test("assetProtocol scope covers the Local Asset root and cached Desktop thumbnails", () => {
  // On Android $APPDATA is activity.dataDir, so the Local Asset root resolves
  // to $APPDATA/files/local-assets/** (verified on MI 8).
  assert.ok(
    scope.some((p) => p === "$APPDATA/files/local-assets/**"),
    "Local Asset original + thumbnail root must be covered"
  );
  assert.ok(scope.some((p) => p === "$CACHE/**"), "cached Desktop thumbnail root must be covered");
});

test("assetProtocol scope must not expose unrelated app-private files", () => {
  for (const p of scope) {
    assert.notEqual(p, "$APPDATA/**", "bare $APPDATA/** is forbidden (FIX-V1 P1-4)");
    assert.notEqual(p, "$RESOURCE/**", "$RESOURCE/** is unnecessary for the Mobile flow");
    assert.ok(
      !p.startsWith("$APPDATA/") || p.startsWith("$APPDATA/files/local-assets/"),
      `unexpected $APPDATA scope entry: ${p}`
    );
  }
});
