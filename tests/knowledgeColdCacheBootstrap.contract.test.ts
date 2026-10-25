// Light production-wiring guards only. These do not execute Rust, SQLite,
// device transport or real LAN; the native bootstrap tests own behavior.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beginDesktopNote, DesktopNoteOpener } from "../src/services/desktopNoteBegin.ts";

const native = readFileSync(new URL("../src-tauri/src/content/notes.rs", import.meta.url), "utf8");
const database = readFileSync(new URL("../src-tauri/src/content_db.rs", import.meta.url), "utf8");
const begin = native.split("pub(crate) fn content_note_begin(")[1]?.split("#[tauri::command]")[0] ?? "";
const cold = native.split("async fn refresh_cold_note(")[1]?.split("#[tauri::command]")[0] ?? "";
const cached = database.split("pub(crate) fn content_note_cached(")[1]?.split("pub(crate) fn content_cache_bootstrap(")[0] ?? "";
const adopt = database.split("pub(crate) fn content_cache_bootstrap(")[1]?.split("pub(crate) fn content_edit(")[0] ?? "";

test("actual synchronous begin is separate from readonly cold refresh and fenced atomic adoption", () => {
  assert.match(begin, /db\.content_begin_edit/);
  assert.doesNotMatch(begin, /await|gateway|content_get|bootstrap/);
  assert.match(cold, /bootstrap::fetch_if_missing/);
  assert.match(native.split("pub(crate) async fn content_note_refresh(")[1] ?? "", /Source::capture_expected\(&state, &instance\)/);
  assert.equal((cold.match(/source\.verify_owner\(state\)/g) ?? []).length, 2);
  assert.equal((cold.match(/source\.check\(state\)/g) ?? []).length, 2);
  assert.match(cold, /\/v1\/notes\/\{id\}\?vault=/);
  assert.match(cold, /source\.with_db[\s\S]*content_cache_bootstrap/);
  assert.doesNotMatch(cold, /remote_note\(|content_mutate|content_apply_batch|content_begin_edit|editingOpen/);
});

test("exact zero-row cache miss is distinct from other database errors", () => {
  const allocating = database.split("pub(crate) fn content_begin_edit(")[1]?.split("pub(crate) fn content_note_cached(")[0] ?? "";
  assert.match(allocating, /if count == 0[\s\S]*CONTENT_NOTE_NOT_CACHED/);
  assert.match(cached, /\.optional\(\)\.map_err\(fail\)/);
  assert.doesNotMatch(cached, /\.ok\(\)|unwrap_or|contains\(/);
});

test("adoption rejects wrong/incomplete/deleted bodies and never rewrites an intervening row or cursor", () => {
  assert.match(adopt, /text\(document, "noteId"\) != id/);
  assert.match(adopt, /text\(document, "vaultId"\) != vault/);
  assert.match(adopt, /document\["deleted"\] == true/);
  for (const key of ["content", "title", "relativePath", "updatedAt"]) assert.match(adopt, new RegExp(`document\\["${key}"\\]\\.is_string\\(\\)`));
  assert.match(adopt, /document\["resources"\]\.is_array\(\)/);
  assert.match(adopt, /text\(document, "revision"\)\.is_empty\(\)/);
  assert.match(adopt, /TransactionBehavior::Immediate/);
  assert.match(adopt, /if existing\.is_none\(\) \{\s*offline::cache_allow_reader\(&tx, instance, vault, id\)\?;\s*apply_document\(&tx, instance, vault, document\)\?;\s*\}/);
  assert.doesNotMatch(adopt, /content_apply_batch|content_vault_cache|SET cursor|content_prepare|content_note_operation/);
  assert.doesNotMatch(adopt, /SET editor_epoch|editor_generation=0/);
});

test("fresh uncached canonical row reads exact body before allocating its current editor epoch", async () => {
  const calls: string[] = [];
  let body: string | null = null;
  let epoch = 0;
  const loaded = await beginDesktopNote({
    begin: async () => { calls.push("begin"); if (body === null) throw "CONTENT_NOTE_NOT_CACHED"; return { body, epoch: ++epoch }; },
    refresh: async () => { calls.push("readonly refresh A/v/fresh"); body = "desktop body"; },
  }, () => true);
  assert.deepEqual(calls, ["begin", "readonly refresh A/v/fresh", "begin"]);
  assert.deepEqual(loaded, { cached: { body: "desktop body", epoch: 1 }, refreshed: true });
});

test("existing cached/offline draft does not bootstrap and allocates only once", async () => {
  let begins = 0;
  const loaded = await beginDesktopNote({
    begin: async () => ({ body: "phone draft", epoch: ++begins }),
    refresh: async () => { assert.fail("warm begin must not bootstrap"); },
  }, () => true);
  assert.equal(begins, 1);
  assert.deepEqual(loaded, { cached: { body: "phone draft", epoch: 1 }, refreshed: false });
});

test("other database failures never become a network bootstrap", async () => {
  await assert.rejects(beginDesktopNote({
    begin: async () => { throw new Error("CONTENT_DATABASE: bad schema"); },
    refresh: async () => { assert.fail("non-missing failure must not fetch"); },
  }, () => true), /bad schema/);
});

test("retired A cold response cannot allocate an epoch after B has begun and durably edited", async () => {
  let currentA = true;
  let finishRead!: () => void;
  let beginsA = 0;
  let epochB = 0;
  let body = "";
  const response = new Promise<void>(resolve => { finishRead = resolve; });
  const oldA = beginDesktopNote({
    begin: async () => {
      if (++beginsA === 1) throw "CONTENT_NOTE_NOT_CACHED";
      epochB++; // actual native begin would steal B's epoch here
      return { body, epoch: epochB };
    },
    refresh: () => response,
  }, () => currentA);
  await new Promise(resolve => setImmediate(resolve));
  currentA = false;
  epochB = 1; body = "B durable draft";
  finishRead();
  assert.equal(await oldA, null);
  assert.equal(beginsA, 1, "retired A must not issue the final native begin");
  assert.equal(epochB, 1, "B keeps the epoch used by its next save");
  assert.equal(body, "B durable draft");
});

test("late canceled/hidden/source-retired read errors stay inert and allocate no editor", async () => {
  let live = true;
  let rejectRead!: (error: unknown) => void;
  let begins = 0;
  const response = new Promise<void>((_, reject) => { rejectRead = reject; });
  const opening = beginDesktopNote({
    begin: async () => { begins++; throw "CONTENT_NOTE_NOT_CACHED"; },
    refresh: () => response,
  }, () => live);
  await new Promise(resolve => setImmediate(resolve));
  live = false;
  rejectRead("CONTENT_SOURCE_CHANGED");
  assert.equal(await opening, null);
  assert.equal(begins, 1);
});

test("current failed readonly body request propagates its error without a second begin", async () => {
  let begins = 0;
  await assert.rejects(beginDesktopNote({
    begin: async () => { begins++; throw "CONTENT_NOTE_NOT_CACHED"; },
    refresh: async () => { throw new Error("CONTENT_HTTP_403"); },
  }, () => true), /CONTENT_HTTP_403/);
  assert.equal(begins, 1);
});

test("retained unfinished A hides, returns, and reopens without waiting for its retired response", async () => {
  let initialized = false;
  let body: string | null = null;
  let epoch = 0;
  let attempts = 0;
  const completions: Array<() => void> = [];
  const ticks = () => new Promise(resolve => setImmediate(resolve));
  const opener = new DesktopNoteOpener(async isCurrent => {
    attempts++;
    const loaded = await beginDesktopNote({
      begin: async () => { if (body === null) throw "CONTENT_NOTE_NOT_CACHED"; return { body, epoch: ++epoch }; },
      refresh: () => new Promise<void>(resolve => completions.push(() => { body = "readonly body"; resolve(); })),
    }, isCurrent);
    if (loaded) initialized = true;
  }, () => initialized);
  opener.setCurrent(true);
  await ticks();
  opener.setCurrent(false);
  opener.setCurrent(true);
  await ticks();
  assert.equal(attempts, 2, "back starts its own attempt, not the retired request");
  completions[0](); // old A arrives while A is visible again: still retired
  await ticks();
  assert.equal(initialized, false);
  assert.equal(epoch, 0, "old A does not become current merely on back");
  completions[1]();
  await ticks();
  assert.equal(initialized, true);
  assert.equal(epoch, 1);
  opener.dispose();
});

test("loaded editor hides and returns with no begin, hydrate, epoch or draft reset", async () => {
  let initialized = false;
  let opens = 0;
  let epoch = 0;
  let draft = "cached body";
  const opener = new DesktopNoteOpener(async () => {
    opens++; epoch++; initialized = true;
  }, () => initialized);
  opener.setCurrent(true);
  await new Promise(resolve => setImmediate(resolve));
  draft = "new durable phone draft";
  opener.setCurrent(false);
  opener.setCurrent(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(opens, 1);
  assert.equal(epoch, 1);
  assert.equal(draft, "new durable phone draft");
  opener.dispose();
});

test("actual retained Still caller wires unfinished resume without re-running identity cleanup", () => {
  const caller = readFileSync(new URL("../src/still/StillNote.tsx", import.meta.url), "utf8");
  const init = caller.split("const opener = new DesktopNoteOpener(")[1]?.split("}, [instance, vault, id]);")[0] ?? "";
  assert.match(init, /isAttemptCurrent\(\).*session === owner\.current.*currentPage\.current/);
  assert.match(init, /epoch\.current !== 0/);
  assert.match(init, /opener\.dispose\(\)/);
  const visibility = caller.split("noteOpener.current?.setCurrent(current);")[1]?.slice(0, 80) ?? "";
  assert.match(visibility, /\}, \[current\]\)/);
});


test("explicit cold reader opt-in is fenced by the durable cache generation before adoption", () => {
  assert.match(cold, /let cache_generation = source\.with_db\(state, \|db\| db\.content_cache_generation\(instance, vault\)\)\?;[\s\S]*bootstrap::fetch_if_missing/);
  assert.match(cold, /if db\.content_cache_generation\(instance, vault\)\? != cache_generation \{\s*return Err\("CONTENT_CACHE_CHANGED"\.into\(\)\);\s*\}\s*db\.content_cache_bootstrap/);
  const offline = readFileSync(new URL("../src-tauri/src/content_offline_db.rs", import.meta.url), "utf8");
  assert.match(offline, /fn cache_clear_scoped_transaction_preserves_drafts_and_rejects_late_jobs/);
  assert.match(offline, /fn cache_clear_retires_saved_editor_and_blocks_prefetch_until_explicit_read/);
  assert.match(offline, /fn cache_clear_persists_for_historical_vault_and_can_be_repeated/);
  assert.match(database, /offline::cache_suppress_body\(db, instance, vault, id\)\?/);
  assert.match(database, /let adopt = !offline::cache_paused\(&tx, instance, vault\)\? && &current == expected/);
});
