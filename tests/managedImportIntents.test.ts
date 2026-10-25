import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ManagedImportIntents } from "../src/services/managedImportIntents.ts";
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const target = { localVaultId: "vault-A", folder: "资料", sessionGeneration: "session:1" };
function fixture() { let value: string | null = null; let now = 1000; const storage = { getItem: () => value, setItem: (_: string, next: string) => { value = next; } }; return { store: new ManagedImportIntents(storage, () => now), storage, advance: () => { now += 86400001; } }; }
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
