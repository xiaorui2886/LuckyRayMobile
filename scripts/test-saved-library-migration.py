#!/usr/bin/env python3
"""Execute the application's actual append-only v14 SQL with SQLite.
No app runtime, live device, credentials or network required.
"""
import json
import re
import sqlite3
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / 'src-tauri/src/db.rs').read_text()
MIGRATIONS = re.findall(r'r#"(.*?)"#', SOURCE[SOURCE.index('const MIGRATIONS'):SOURCE.index('pub struct Db')], re.S)


def statements(sql):
    pending = ''
    for line in sql.splitlines(True):
        pending += line
        if sqlite3.complete_statement(pending):
            yield pending
            pending = ''
    if pending.strip():
        yield pending


def migrate(db, fail_after_copy=False):
    current = db.execute('PRAGMA user_version').fetchone()[0]
    for version, sql in enumerate(MIGRATIONS, 1):
        if version <= current:
            continue
        db.execute('BEGIN IMMEDIATE')
        try:
            for statement in statements(sql):
                db.execute(statement)
                if fail_after_copy and version == 14 and 'INSERT INTO note_cache_scope_v14' in statement:
                    raise RuntimeError('simulated power/write failure after copy')
            db.execute(f'PRAGMA user_version={version}')
            db.commit()
        except Exception:
            db.rollback()
            raise


def fixture():
    db = sqlite3.connect(':memory:')
    db.execute('PRAGMA foreign_keys=ON')
    for sql in MIGRATIONS[:13]:
        db.executescript(sql)
    db.execute('PRAGMA user_version=13')
    payload = json.dumps({'opId':'immutable-op', 'vaultId':'vault-a', 'noteId':'same', 'content':'submitted'})
    db.execute('''INSERT INTO note_cache VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
        ('desktop','same','dirty title','folder/n.md','dirty body','r1','date',1,'base-r1',
         'vault-a', '{"revision":"remote"}',8,'{"content":"conflict"}',0,'update',19,7,'{"content":"cached"}',1))
    db.execute("INSERT INTO content_note_operation VALUES ('desktop','vault-a','same','immutable-op',?,8,'content')", (payload,))
    db.execute("INSERT INTO content_note_attachment VALUES ('desktop','vault-a','same','attach','a.png','image/png','private',4,'hash',2,NULL,NULL)")
    db.execute("INSERT INTO content_note_operation_pause VALUES ('desktop','vault-a','same','immutable-op',?,'content',8,'BLANK_RENAME_400','date')", (payload,))
    db.execute("INSERT INTO content_offline_vault VALUES ('desktop','vault-a',0,9,0,'granted')")
    db.execute("INSERT INTO content_offline_note VALUES ('desktop','vault-a','same','r1','ready','',0,0,1)")
    db.commit()
    return db


def retained(db):
    tables = ['note_cache','content_note_operation','content_note_attachment','content_note_operation_pause',
              'content_note_operation_recovery','content_offline_vault','content_offline_note','capture_outbox','local_note_item']
    return {t: db.execute(f'SELECT * FROM {t} ORDER BY rowid').fetchall() for t in tables}


class MigrationTests(unittest.TestCase):
    def test_append_only(self):
        self.assertEqual(len(MIGRATIONS), 14)
        self.assertIn('pub const SCHEMA_VERSION: i64 = 14;', SOURCE)

    def test_preserves_every_column_operation_audit_fk_and_index(self):
        db = fixture()
        before = retained(db)
        schema = db.execute("SELECT name,sql FROM sqlite_master WHERE type IN ('index','trigger') AND tbl_name!='note_cache' ORDER BY name").fetchall()
        migrate(db)
        self.assertEqual(retained(db), before)
        self.assertEqual(db.execute("SELECT name,sql FROM sqlite_master WHERE type IN ('index','trigger') AND tbl_name!='note_cache' ORDER BY name").fetchall(), schema)
        self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(), [])
        self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
        self.assertEqual([r[1] for r in sorted(db.execute('PRAGMA table_info(note_cache)'), key=lambda r:r[5]) if r[5]], ['desktop_instance_id','vault_id','note_id'])
        db.execute("INSERT INTO note_cache(desktop_instance_id,vault_id,note_id,title,content,revision) VALUES ('desktop','vault-b','same','B','body B','rB')")
        self.assertEqual(db.execute("SELECT content FROM note_cache WHERE desktop_instance_id='desktop' AND vault_id='vault-a' AND note_id='same'").fetchone()[0], 'dirty body')
        self.assertEqual(db.execute("SELECT content FROM note_cache WHERE desktop_instance_id='desktop' AND vault_id='vault-b' AND note_id='same'").fetchone()[0], 'body B')
        # Legacy foundation tombstones cannot delete scoped rows.
        db.execute("DELETE FROM note_cache WHERE desktop_instance_id='desktop' AND vault_id='' AND note_id='same'")
        self.assertEqual(db.execute('SELECT COUNT(*) FROM note_cache').fetchone()[0], 2)

    def test_failure_rolls_back_copy_ddl_and_version_then_retry_succeeds(self):
        db = fixture()
        before = retained(db)
        with self.assertRaises(RuntimeError):
            migrate(db, fail_after_copy=True)
        self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 13)
        self.assertEqual(retained(db), before)
        self.assertEqual(db.execute("SELECT name FROM sqlite_master WHERE name='note_cache_scope_v14'").fetchall(), [])
        migrate(db)
        self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 14)
        self.assertEqual(retained(db), before)
        migrate(db)  # Startup rerun must be a no-op.
        self.assertEqual(retained(db), before)

    def test_pair_replacement_rotates_cache_authority_and_parks_without_rewriting(self):
        db = fixture()
        migrate(db)
        before = retained(db)
        # Execute exact production SQL, not a restatement of its behavior.
        literals = re.findall(r'"([^"\n]+)"', SOURCE)
        park = next(sql for sql in literals if sql.startswith("INSERT OR IGNORE INTO app_meta(key,value) SELECT 'content.pairing-review.v1:'") and 'desktop_instance_id=?1' in sql)
        rotate = next(sql for sql in literals if sql.startswith("INSERT INTO app_meta(key,value) VALUES('content.resource.authority.v1'"))
        db.execute(park, ('desktop',))
        db.execute(rotate)
        self.assertEqual(db.execute("SELECT value FROM app_meta WHERE key='content.resource.authority.v1'").fetchone()[0], '1')
        self.assertEqual(db.execute("SELECT COUNT(*) FROM app_meta WHERE key LIKE 'content.pairing-review.v1:%'").fetchone()[0], 1)
        self.assertEqual(retained(db), before)
        # Replacement again changes authority, never operation ID or body.
        db.execute(park, ('desktop',))
        db.execute(rotate)
        self.assertEqual(db.execute("SELECT value FROM app_meta WHERE key='content.resource.authority.v1'").fetchone()[0], '2')
        self.assertEqual(retained(db), before)
        content = (ROOT / 'src-tauri/src/content_db.rs').read_text()
        guard = re.search(r'query_row\("(SELECT EXISTS\(SELECT 1 FROM note_cache n JOIN app_meta m.*?n.dirty=1\))"', content).group(1)
        self.assertEqual(db.execute(guard, ('desktop','vault-a')).fetchone()[0], 1)
        self.assertEqual(db.execute(guard, ('desktop','vault-b')).fetchone()[0], 0)

    def test_parked_notes_do_not_block_unrelated_pushes_and_read_queries(self):
        db = fixture()
        migrate(db)
        db.execute("UPDATE note_cache SET conflict_document=NULL,create_collision_block=0")
        literals = re.findall(r'"([^"\n]+)"', SOURCE)
        park = next(sql for sql in literals if sql.startswith("INSERT OR IGNORE INTO app_meta(key,value) SELECT 'content.pairing-review.v1:'") and 'desktop_instance_id=?1' in sql)
        db.execute(park, ('desktop',))
        db.execute("INSERT INTO note_cache(desktop_instance_id,vault_id,note_id,title,content,revision,dirty,server_document,pending_kind) VALUES ('desktop','vault-a','fresh','Fresh','new','r1',1,'{}','create')")
        db.execute("INSERT INTO content_note_attachment VALUES ('desktop','vault-a','fresh','new-attach','a.png','image/png','private-new',4,'hash',0,NULL,NULL)")
        content = (ROOT / 'src-tauri/src/content_db.rs').read_text()
        prepare = re.search(r'tx.prepare\(&format!\("(SELECT \{NOTE_COLUMNS\} FROM note_cache.*?)"\)\)', content, re.S).group(1).replace('{NOTE_COLUMNS}', 'note_id')
        self.assertEqual(db.execute(prepare, ('desktop','vault-a',1,' \t\r\n')).fetchall(), [('fresh',)])
        attachments = re.search(r'self.conn.prepare\("(SELECT a.note_id,a.op_id,a.file_name.*?ORDER BY a.op_id LIMIT 16)"\)', content, re.S).group(1)
        self.assertEqual([row[0] for row in db.execute(attachments, ('desktop','vault-a'))], ['fresh'])
        self.assertEqual(db.execute("SELECT content FROM note_cache WHERE desktop_instance_id='desktop' AND vault_id='vault-a' AND note_id='same'").fetchone()[0], 'dirty body')


if __name__ == '__main__':
    unittest.main(verbosity=2)
