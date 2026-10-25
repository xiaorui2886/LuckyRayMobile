import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomFillSync } from "node:crypto";
import { createRequire } from "node:module";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { ManagedImportIntents } from "../src/services/managedImportIntents.ts";
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const target = { localVaultId: "vault-A", folder: "资料", sessionGeneration: "session:1" };
function fixture() { let value: string | null = null; let now = 1000; const storage = { getItem: () => value, setItem: (_: string, next: string) => { value = next; } }; return { store: new ManagedImportIntents(storage, () => now), storage, advance: () => { now += 86400001; } }; }

// Evaluate the actual module, including its startup statements, in a fresh
// browser realm. Testing the UUID helper alone misses a pre-React boot crash.
const { buildSync } = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
const startupCode = buildSync({ entryPoints: [fileURLToPath(new URL("../src/services/managedImportIntents.ts", import.meta.url))], bundle: true, platform: "browser", format: "iife", globalName: "importIntents", write: false }).outputFiles[0].text;
function startup(crypto: unknown) {
  const math = Object.assign(Object.create(Math), { random: () => { throw Error("weak-randomness-forbidden"); } });
  const realm = createContext({ crypto, Math: math });
  runInContext(startupCode, realm);
  return (realm as { importIntents?: typeof import("../src/services/managedImportIntents.ts") }).importIntents!;
}

test("startup MI8: crypto exists without randomUUID; secure getRandomValues keeps the import owner alive", () => {
  let calls = 0;
  const crypto = { getRandomValues(bytes: Uint8Array) { assert.equal(this, crypto); calls++; return randomFillSync(bytes); } };
  const app = startup(crypto);
  app.setManagedImportTarget("vault-A", "资料");
  const first = app.snapshotManagedImportTarget()!;
  assert.match(first.sessionGeneration, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:\d+$/);
  assert.equal(app.currentManagedImportTarget(first), true);
  app.setManagedImportTarget("vault-A", "资料");
  assert.equal(app.snapshotManagedImportTarget()!.sessionGeneration, first.sessionGeneration);
  app.invalidateManagedImportTarget();
  app.setManagedImportTarget("vault-A", "资料");
  assert.equal(app.currentManagedImportTarget(first), false, "same folder after navigation cannot revive an old capture");
  assert.notEqual(app.snapshotManagedImportTarget()!.sessionGeneration, first.sessionGeneration);
  assert.equal(calls, 1, "one secure incarnation per app realm, not per render");
});

test("startup modern engine keeps native randomUUID and durable receipts cannot cross cold owners", () => {
  let calls = 0;
  const crypto = { randomUUID() { assert.equal(this, crypto); calls++; const bytes = randomFillSync(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128; const h = Buffer.from(bytes).toString("hex"); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`; }, getRandomValues() { throw Error("native path must not use fallback"); } };
  const before = startup(crypto), after = startup(crypto);
  before.setManagedImportTarget("vault-A", "资料"); after.setManagedImportTarget("vault-A", "资料");
  const old = before.snapshotManagedImportTarget()!, current = after.snapshotManagedImportTarget()!;
  assert.notEqual(old.sessionGeneration, current.sessionGeneration);
  const {storage} = fixture();
  const pending = new before.ManagedImportIntents(storage, () => 1000);
  pending.remember(id(51), old);
  const replay = new after.ManagedImportIntents(storage, () => 1000);
  assert.equal(replay.matching(id(51), current), null, "cold reload must require explicit recovery of old receipt");
  assert.notEqual(replay.matching(id(51), old), null, "receipt is retained, not acknowledged or deleted");
  assert.equal(calls, 2);
});

test("startup safe failure: absent, unusable or throwing secure randomness disables automatic capture without crashing", () => {
  for (const crypto of [undefined, {}, {randomUUID: true}, {randomUUID: () => "invalid"}, {randomUUID: () => {throw Error("denied");}}, {getRandomValues: () => {throw Error("denied");}}]) {
    const app = startup(crypto);
    assert.doesNotThrow(() => app.setManagedImportTarget("vault-A", "资料"));
    assert.equal(app.snapshotManagedImportTarget(), null);
    assert.equal(app.currentManagedImportTarget(target), false);
    const {storage} = fixture();
    const receipts = new app.ManagedImportIntents(storage, () => 1000);
    receipts.remember(id(52), target);
    assert.equal(receipts.matching(id(52), app.snapshotManagedImportTarget()), null);
    assert.notEqual(receipts.matching(id(52), target), null, "failure must not drop durable recovery receipt");
  }
});

test("startup safe failure can recover after secure randomness returns without reusing an old owner", () => {
  let blocked = true;
  const crypto = { getRandomValues(bytes: Uint8Array) { if (blocked) throw Error("unavailable"); return randomFillSync(bytes); } };
  const app = startup(crypto);
  app.setManagedImportTarget("vault-A"); assert.equal(app.snapshotManagedImportTarget(), null);
  blocked = false;
  app.setManagedImportTarget("vault-A");
  assert.ok(app.snapshotManagedImportTarget());
  app.invalidateManagedImportTarget();
  assert.equal(app.snapshotManagedImportTarget(), null);
});
test("actual picker UUID survives durable storage but stale vault/session/cold owner cannot reuse it", () => {
  const {store, storage} = fixture(); store.remember(id(1), target);
  assert.deepEqual(store.matching(id(1), target), target);
  assert.deepEqual(new ManagedImportIntents(storage, () => 1000).matching(id(1), target), target);
  for (const owner of [null, {...target, folder:"其他"}, {...target, localVaultId:"vault-B"}, {...target, sessionGeneration:"session:2"}]) assert.equal(store.matching(id(1), owner), null);
  assert.equal(store.matching(id(2), target), null);
  store.forget(id(1)); assert.equal(store.matching(id(1), target), null);
});
test("pending intents are bounded, expired and malformed entries fail closed", () => {
  const {store, storage, advance} = fixture();
  for(let n=1;n<=32;n++) store.remember(id(n),target);
  assert.throws(() => store.remember(id(33),target), /FULL/);
  store.remember(id(1),target); advance(); assert.equal(store.matching(id(1),target),null);
  store.remember(id(33),target);
  storage.setItem("",'{'); assert.equal(store.matching(id(33),target),null);
  assert.throws(() => store.remember("wrong",target), /INVALID/);
});
test("picker correlation is preserved across Kotlin/Rust/client and unmanaged receipts require explicit target", () => {
  const read = (path: string) => readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
  const kotlin = read('scripts/android-src/NoteImportBridge.kt');
  assert.match(kotlin,/put\("status", "launched"\)\.put\("requestId", id\)/);
  assert.match(kotlin,/val deliveryId = if \(source == "picker"\) id else UUID.randomUUID\(\).toString\(\)/);
  assert.match(read('src-tauri/src/note_import.rs'),/serde_json::from_str\(&status\)/);
  assert.match(read('src/services/client.ts'),/requestId\?: string/);
  const bridge = read('src/still/kit/LocalNoteImportBridge.tsx');
  assert.match(bridge,/await launchSettled/);
  assert.match(bridge,/item.source === "picker" \? intents\(\).matching/);
  assert.match(bridge,/请选择笔记库/);
  assert(bridge.indexOf('await managedVault.importLegacyReceipt') < bridge.indexOf('await api.localNoteImportAck'));
  assert.doesNotMatch(bridge,/openRef.current\("note", item.noteId/);
});
