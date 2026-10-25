import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const bridge = read('scripts/android-src/NoteImportBridge.kt');
const native = read('src-tauri/src/note_import.rs');

test('document bridge bounds URI, bytes, encoding, worker admission and request filename', () => {
  assert.match(bridge, /uri\.scheme != "content"/);
  assert.match(bridge, /checkUriPermission/);
  assert.match(bridge, /out\.size\(\) \+ n <= LIMIT/);
  assert.match(bridge, /CodingErrorAction\.REPORT/);
  assert.match(bridge, /ArrayBlockingQueue<Runnable>\(8\)/);
  assert.match(bridge, /emptyReads <= 8/);
  assert.match(bridge, /UUID\.fromString\(id\)\.toString\(\) == id/);
  assert.doesNotMatch(bridge, /takePersistableUriPermission|MANAGE_EXTERNAL_STORAGE|READ_EXTERNAL_STORAGE/);
  assert.match(native, /note-import-\{import_id\}/);
  assert.match(native, /db\.note_insert/);
  assert.match(native, /NOTE_IMPORT_QUEUE_INVALID/);
});

test('document manifest patch is executable, idempotent and never claims web URLs', () => {
  const script = read('scripts/apply-android-patches.sh');
  const python = script.split("<<'PYNOTE'\n")[1]?.split('\nPYNOTE')[0];
  assert.ok(python);
  const dir = mkdtempSync(join(tmpdir(), 'note-manifest-'));
  try {
    const manifest = join(dir, 'AndroidManifest.xml');
    writeFileSync(manifest, '<manifest><application><activity android:name=".MainActivity"></activity></application></manifest>');
    for (let i = 0; i < 2; i++) {
      const run = spawnSync('python', ['-', manifest], {input: python, encoding: 'utf8'});
      assert.equal(run.status, 0, run.stderr);
    }
    const xml = readFileSync(manifest, 'utf8');
    assert.equal((xml.match(/android.intent.action.VIEW/g) || []).length, 4);
    assert.equal((xml.match(/android:scheme="content"/g) || []).length, 4);
    assert.doesNotMatch(xml, /BROWSABLE|scheme="https?"|mimeType="\*\/\*"/);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('upload is single atomic scoped snapshot, portable preflight and permanent replay ledger', () => {
  const db = read('src-tauri/src/local_note_upload_db.rs');
  const cmd = read('src-tauri/src/content/notes/local_upload.rs');
  const preflight = db.indexOf('if let Some((line, reference)) = blocked_resource(&note.content)');
  assert.ok(preflight >= 0 && preflight < db.indexOf('let tx = rusqlite::Transaction'), 'resource diagnostics must reject before opening the atomic upload transaction');
  assert.match(db.slice(preflight, db.indexOf('let tx = rusqlite::Transaction')), /return Err\(format!\("LOCAL_NOTE_UPLOAD_RESOURCES_UNSUPPORTED:/);
  assert.match(db, /TransactionBehavior::Immediate/);
  assert.match(db, /local-note-upload:/);
  assert.match(db, /json!\(\[instance, vault, note_id, note.title, note.content, parent\]\)/);
  assert.match(cmd, /capture_expected/);
  assert.match(cmd, /capabilities\(state, "noteWrite"\)/);
  assert.match(cmd, /target\["vaultId"\] != vault/);
  assert.doesNotMatch(db, /DELETE FROM local_note|note_delete/);
});


test('repeated VIEW requeues a receipt for the same note, distinct URI uses distinct dedup key', () => {
  assert.match(bridge, /uri\.toString\(\) \+ "\\u0000" \+ digest/);
  assert.match(bridge, /put\("requestId", deliveryId\)\.put\("importId", importId\)/);
  assert.match(bridge, /if \(source == "view"\) repeatedViewId\(viewKey, id, now\) else id/);
  assert.doesNotMatch(bridge, /getBoolean\("done:/);
  assert.match(native, /meta\["importId"\]\.as_str\(\)\.unwrap_or\(id\)/);
  assert.match(native, /let note_id = format!\("note-import-\{import_id\}"\)/);
});
