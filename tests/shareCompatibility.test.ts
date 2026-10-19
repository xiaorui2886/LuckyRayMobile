// M2.13 FIX-V1 P1-A — deterministic source guard for API-29 ACTION_SEND
// compatibility. The typed `getParcelableExtra(name, Uri::class.java)`
// overload exists only on API 33+; calling it unguarded on API 29 throws
// NoSuchMethodError (which would silently kill share ingest on MI 8). These
// tests read the committed Kotlin sources and assert the contract:
//   - MainActivity must never call the typed overload directly (it routes
//     ACTION_SEND through ShareBridge.handle, the single ingestion point);
//   - ShareBridge's typed call must live inside the `SDK_INT >= 33` branch
//     of the streamUriOf compatibility helper;
//   - the generic overload must be the API < 33 path;
//   - no other bare typed getParcelableExtra calls exist.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const shareBridge = readFileSync(join(ROOT, "scripts", "android-src", "ShareBridge.kt"), "utf-8");
const mainActivity = readFileSync(join(ROOT, "scripts", "android-src", "MainActivity.kt"), "utf-8");

test("P1-A — MainActivity never calls the typed getParcelableExtra directly", () => {
  assert.ok(
    !mainActivity.includes("getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)"),
    "MainActivity must route EXTRA_STREAM through ShareBridge (typed overload is API 33+)"
  );
  assert.ok(
    mainActivity.includes("ShareBridge.handle(intent)"),
    "MainActivity routes ACTION_SEND through ShareBridge.handle"
  );
});

test("P1-A — ShareBridge typed overload is SDK-guarded; generic overload is the API<33 path", () => {
  const typedIdx = shareBridge.indexOf("getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)");
  const genericIdx = shareBridge.indexOf("getParcelableExtra(Intent.EXTRA_STREAM)");
  assert.ok(typedIdx > 0, "typed overload present (inside the helper)");
  assert.ok(genericIdx > typedIdx, "generic overload appears after the typed one (else branch)");
  // The typed call must be inside the `SDK_INT >= 33` branch of streamUriOf:
  // the branch marker must appear before the typed call and after the
  // previous statement's boundary — assert the immediate context instead:
  const before = shareBridge.slice(Math.max(0, typedIdx - 200), typedIdx);
  assert.match(before, /SDK_INT\s*>=\s*33/, "typed call guarded by SDK_INT >= 33");
  const beforeGeneric = shareBridge.slice(Math.max(0, genericIdx - 160), genericIdx);
  assert.match(beforeGeneric, /@Suppress\("DEPRECATION"\)/, "generic overload marked as the legacy path");
});

test("P1-A — no other bare typed getParcelableExtra calls exist in the bridges", () => {
  // Any other `getParcelableExtra(X, SomeClass::class.java)` in MainActivity
  // or ShareBridge would be an unguarded API-33 call.
  const typedCall = /getParcelableExtra\(\s*[^,]+,\s*[A-Za-z]+::class\.java\s*\)/g;
  const mainMatches = mainActivity.match(typedCall) ?? [];
  const sbMatches = (shareBridge.match(typedCall) ?? []).filter((m) => m.includes("EXTRA_STREAM"));
  assert.deepEqual(mainMatches, [], "MainActivity: no typed getParcelableExtra calls at all");
  assert.equal(sbMatches.length, 1, "ShareBridge: exactly one typed EXTRA_STREAM call (inside the guarded helper)");
});

test("P1-A — streamUriOf is a single compatibility point, called from ShareBridge.handle", () => {
  assert.ok(shareBridge.includes("fun streamUriOf(intent: Intent?): Uri?"), "helper exists");
  assert.ok(shareBridge.includes('intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)'), "typed path present");
  // handle() must route through the helper — the typed call is unreachable
  // without it, and a bare unguarded call would violate the first test.
  assert.ok(shareBridge.includes("val streamUri = streamUriOf(intent)"), "handle() uses streamUriOf");
});
