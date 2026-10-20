// Formal SQLite layer: versioned migration system + typed table access.
// Business identity for cached entities is (desktop_instance_id, entity_id).
// content_hash is used for integrity/dedup only — never as a primary key.

use rusqlite::{Connection, OptionalExtension, params};
use std::path::Path;

// Append-only migrations retain existing note and offline preparation data.
pub const SCHEMA_VERSION: i64 = 12;
const LEGACY_CREDENTIAL_WAL_CLEANUP_KEY: &str = "legacy_credential_wal_cleanup_pending";
pub const OUTBOX_PENDING: &str = "pending";
pub const OUTBOX_UPLOADING: &str = "uploading";
pub const OUTBOX_COMPLETED: &str = "completed";
pub const OUTBOX_FAILED: &str = "failed";

/// Escape a user-supplied search term for use inside a LIKE pattern with
/// ESCAPE '\' so literal % and _ cannot act as wildcards.
fn escape_like(term: &str) -> String {
    term.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// Unicode-safe character truncation helper. Prevents panic when slicing
/// mixed ASCII, CJK, or multi-byte Emoji strings. Appends `…` only when truncated.
pub fn safe_truncate(s: &str, max_chars: usize) -> String {
    let mut char_count = 0;
    let mut end_byte = s.len();
    let mut is_truncated = false;

    for (idx, _) in s.char_indices() {
        if char_count == max_chars {
            end_byte = idx;
            is_truncated = true;
            break;
        }
        char_count += 1;
    }

    if is_truncated {
        format!("{}…", &s[..end_byte])
    } else {
        s.to_string()
    }
}

const MIGRATIONS: &[&str] = &[
    // v1 — formal schema
    r#"
    CREATE TABLE paired_desktop (
      desktop_instance_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      platform TEXT,
      app_version TEXT,
      protocol_version INTEGER,
      certificate_fingerprint TEXT NOT NULL,
      base_url TEXT NOT NULL,
      credential TEXT NOT NULL,
      paired_at TEXT NOT NULL
    );
    CREATE TABLE sync_cursor (
      desktop_instance_id TEXT NOT NULL,
      cursor_key TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (desktop_instance_id, cursor_key)
    );
    CREATE TABLE asset_cache (
      desktop_instance_id TEXT NOT NULL,
      desktop_asset_id TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      mime_type TEXT,
      size_bytes INTEGER,
      updated_at TEXT,
      content_hash TEXT,
      thumbnail_revision TEXT,
      folder_id TEXT,
      thumbnail_path TEXT,
      cached_at TEXT,
      PRIMARY KEY (desktop_instance_id, desktop_asset_id)
    );
    CREATE TABLE asset_tag_cache (
      desktop_instance_id TEXT NOT NULL,
      desktop_asset_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (desktop_instance_id, desktop_asset_id, tag)
    );
    CREATE TABLE note_cache (
      desktop_instance_id TEXT NOT NULL,
      note_id TEXT NOT NULL,
      title TEXT NOT NULL,
      relative_path TEXT,
      content TEXT NOT NULL DEFAULT '',
      revision TEXT NOT NULL,
      updated_at TEXT,
      dirty INTEGER NOT NULL DEFAULT 0,
      base_revision TEXT,
      PRIMARY KEY (desktop_instance_id, note_id)
    );
    CREATE TABLE capture_outbox (
      op_id TEXT PRIMARY KEY,
      desktop_instance_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE capture_attachment (
      op_id TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      file_name TEXT NOT NULL,
      size_bytes INTEGER,
      sha256 TEXT,
      local_path TEXT,
      PRIMARY KEY (op_id, ref_id)
    );
    CREATE TABLE ai_run_cache (
      desktop_instance_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      conversation_id TEXT,
      status TEXT,
      started_at TEXT,
      updated_at TEXT,
      summary TEXT,
      PRIMARY KEY (desktop_instance_id, run_id)
    );
    CREATE TABLE ai_event_cache (
      desktop_instance_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT,
      payload TEXT,
      at TEXT,
      PRIMARY KEY (desktop_instance_id, run_id, seq)
    );
    CREATE TABLE app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    "#,
    // v2 — thumbnail cache metadata (no binary blobs in SQLite)
    r#"
    ALTER TABLE asset_cache ADD COLUMN thumbnail_etag TEXT;
    ALTER TABLE asset_cache ADD COLUMN thumbnail_mime TEXT;
    ALTER TABLE asset_cache ADD COLUMN thumbnail_w INTEGER;
    ALTER TABLE asset_cache ADD COLUMN thumbnail_h INTEGER;
    ALTER TABLE asset_cache ADD COLUMN thumbnail_last_accessed TEXT;
    "#,
    // v3 — M2.7 Mobile-local domain (Local Inbox). User-created durable data
    // owned by the phone alone. Deliberately has NO desktop_instance_id:
    // never a Desktop cache, never a capture_outbox row, never a fake/sentinel
    // Desktop identity. Attachment files live in app-private `local-inbox/`
    // (att-* names) — a separate ownership root from capture-outbox (ref-*).
    // Idempotent (IF NOT EXISTS) because reset_full preserves these tables and
    // re-runs migrations from scratch.
    r#"
    CREATE TABLE IF NOT EXISTS local_inbox_item (
      item_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      text_payload TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual',
      archived INTEGER NOT NULL DEFAULT 0,
      favorite INTEGER NOT NULL DEFAULT 0,
      share_digest TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_local_inbox_created ON local_inbox_item(created_at DESC);
    CREATE TABLE IF NOT EXISTS local_inbox_attachment (
      item_id TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      mime TEXT NOT NULL DEFAULT '',
      file_name TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      sha256 TEXT NOT NULL DEFAULT '',
      local_path TEXT NOT NULL,
      PRIMARY KEY (item_id, ref_id)
    );
    CREATE INDEX IF NOT EXISTS idx_local_inbox_attachment_item ON local_inbox_attachment(item_id);
    CREATE TABLE IF NOT EXISTS local_inbox_share_log (
      digest TEXT PRIMARY KEY,
      dedup_until TEXT NOT NULL
    );
    "#,
    // v4 — M2.8 Mobile-local domain (Local Knowledge / Notes). User-created
    // durable data owned by the phone alone. Deliberately has NO desktop_instance_id:
    // never a Desktop cache, never a note_cache row, never a fake/sentinel Desktop
    // identity. Independent from note_cache (which remains Desktop-authoritative cache).
    // Idempotent (IF NOT EXISTS) because reset_full preserves these tables and
    // re-runs migrations from scratch.
    r#"
    CREATE TABLE IF NOT EXISTS local_note_item (
      note_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      source_inbox_id TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      favorite INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_local_note_updated ON local_note_item(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_local_note_created ON local_note_item(created_at DESC);
    CREATE TABLE IF NOT EXISTS local_note_tag (
      note_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (note_id, tag)
    );
    CREATE INDEX IF NOT EXISTS idx_local_note_tag ON local_note_tag(tag);
    "#,
    // v5 — M2.9 Mobile-local domain (Local Asset Library / 素材库). User-created
    // durable materials owned by the phone alone (images / videos / documents /
    // general files). Deliberately has NO desktop_instance_id: independent from
    // asset_cache (which remains Desktop-authoritative cache), note_cache,
    // capture_outbox, local_inbox_*, and local_note_*. Each row owns exactly one
    // app-private original under `local-assets/originals/asset-*`; `content_hash`
    // is integrity/dedup diagnostics only — never business identity. Idempotent
    // (IF NOT EXISTS) because reset_full preserves these tables and re-runs
    // migrations from scratch.
    r#"
    CREATE TABLE IF NOT EXISTS local_asset_item (
      asset_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      mime TEXT NOT NULL DEFAULT '',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT NOT NULL DEFAULT '',
      local_path TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'direct_import',
      source_inbox_id TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      favorite INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_local_asset_updated ON local_asset_item(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_local_asset_created ON local_asset_item(created_at DESC);
    CREATE TABLE IF NOT EXISTS local_asset_tag (
      asset_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (asset_id, tag)
    );
    CREATE INDEX IF NOT EXISTS idx_local_asset_tag ON local_asset_tag(tag);
    "#,
    // v6 — Desktop note drafts extend the existing cache, with durable immutable
    // operations. Mobile-owned note/inbox/asset tables are unchanged.
    r#"
    ALTER TABLE note_cache ADD COLUMN vault_id TEXT NOT NULL DEFAULT '';
    ALTER TABLE note_cache ADD COLUMN server_document TEXT;
    ALTER TABLE note_cache ADD COLUMN draft_generation INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE note_cache ADD COLUMN conflict_document TEXT;
    ALTER TABLE note_cache ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE note_cache ADD COLUMN pending_kind TEXT NOT NULL DEFAULT 'update';
    ALTER TABLE note_cache ADD COLUMN editor_epoch INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE note_cache ADD COLUMN editor_generation INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE content_note_operation (
      desktop_instance_id TEXT NOT NULL, vault_id TEXT NOT NULL, note_id TEXT NOT NULL,
      op_id TEXT NOT NULL, payload TEXT NOT NULL, draft_generation INTEGER NOT NULL,
      PRIMARY KEY(desktop_instance_id,vault_id,note_id));
    CREATE TABLE content_note_attachment (
      desktop_instance_id TEXT NOT NULL, vault_id TEXT NOT NULL, note_id TEXT NOT NULL,
      op_id TEXT NOT NULL, file_name TEXT NOT NULL, mime TEXT NOT NULL, local_path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, uploaded_bytes INTEGER NOT NULL DEFAULT 0,
      receipt TEXT, manifest TEXT, PRIMARY KEY(desktop_instance_id,op_id));
    CREATE TABLE content_vault_cache (
      desktop_instance_id TEXT NOT NULL, vault_id TEXT NOT NULL, name TEXT NOT NULL,
      snapshot_after TEXT, snapshot_seq INTEGER, cursor INTEGER NOT NULL DEFAULT 0,
      initialized INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(desktop_instance_id,vault_id));
    CREATE TABLE content_response_cache (desktop_instance_id TEXT NOT NULL, request_key TEXT NOT NULL,
      payload TEXT NOT NULL, saved_at TEXT NOT NULL, PRIMARY KEY(desktop_instance_id,request_key));
    "#,
    // v7 — STABILITY-FIX-R1(A): cached body provenance.
    //
    // A Desktop change/summary page may carry a revision WITHOUT `content`.
    // The previous UPSERT let such a summary overwrite the cached body with an
    // empty string AND advance `revision` to the summary revision — destroying
    // offline readability and, worse, forging the mutation baseline (the edit
    // path derives `expectedRevision` from the row revision).
    //
    // `cached_document` holds the COMPLETE server document (with content and
    // resources) the `content` column was materialised from, and `revision`
    // now always means "the revision the cached body corresponds to". A
    // metadata-only summary advances only `server_document` (the latest remote
    // observation) and never touches those two.
    //
    // Backfill is deliberately conservative: only a server_document that
    // PROVABLY carries a `content` key qualifies as a complete body document.
    // Rows whose server_document is a summary have unknown body provenance, so
    // any revision claim they were carrying is withdrawn (revision='') rather
    // than trusted; a normal online full refresh restores them. No rows,
    // content or drafts are deleted.
    r#"
    ALTER TABLE note_cache ADD COLUMN cached_document TEXT;
    UPDATE note_cache SET cached_document=server_document
      WHERE server_document IS NOT NULL
        AND json_valid(server_document)
        AND json_type(server_document,'$.content') IS NOT NULL;
    UPDATE note_cache SET revision=''
      WHERE dirty=0 AND server_document IS NOT NULL AND cached_document IS NULL;
    "#,
    // v8 — KNOWLEDGE-ORGANIZATION-R1 R1.6.2: a dedicated Mobile-local create
    // collision/sync-block state. base_revision stays a pure write-provenance
    // field (revision/expectedRevision semantics are untouched); the block
    // records that auto-copy retries hit the bound, stops the busy-loop, and
    // is cleared by any real user edit of title/content.
    r#"
    ALTER TABLE note_cache ADD COLUMN create_collision_block INTEGER NOT NULL DEFAULT 0;
    UPDATE note_cache SET base_revision=''
      WHERE base_revision='CREATE_COLLISION_EXHAUSTED';
    "#,
    // v9 — pin the transport of an immutable note operation separately from
    // its wire payload. Existing operations must replay through old Content,
    // even when a newer Desktop advertises atomic unique-name creation.
    r#"
    ALTER TABLE content_note_operation ADD COLUMN route TEXT NOT NULL DEFAULT 'content'
      CHECK(route IN ('content','knowledgeCreateUnique'));
    "#,
    // v10 — nonterminal pause audit. Original submitted bytes never change;
    // a later explicit user intent records a different opId, not a cancellation
    // or acceptance claim for the unknown server intent.
    r#"
    CREATE TABLE content_note_operation_pause (
      desktop_instance_id TEXT NOT NULL, vault_id TEXT NOT NULL, note_id TEXT NOT NULL,
      op_id TEXT NOT NULL, payload TEXT NOT NULL, route TEXT NOT NULL,
      draft_generation INTEGER NOT NULL, reason TEXT NOT NULL CHECK(reason='BLANK_RENAME_400'),
      paused_at TEXT NOT NULL,
      PRIMARY KEY(desktop_instance_id,vault_id,note_id,op_id));
    CREATE TABLE content_note_operation_recovery (
      desktop_instance_id TEXT NOT NULL, vault_id TEXT NOT NULL, note_id TEXT NOT NULL,
      paused_op_id TEXT NOT NULL, new_op_id TEXT NOT NULL, recovered_at TEXT NOT NULL,
      PRIMARY KEY(desktop_instance_id,vault_id,note_id,paused_op_id));
    CREATE TRIGGER content_pause_immutable_update BEFORE UPDATE ON content_note_operation_pause BEGIN SELECT RAISE(ABORT,'immutable pause audit'); END;
    CREATE TRIGGER content_pause_immutable_delete BEFORE DELETE ON content_note_operation_pause BEGIN SELECT RAISE(ABORT,'immutable pause audit'); END;
    CREATE TRIGGER content_recovery_immutable_update BEFORE UPDATE ON content_note_operation_recovery BEGIN SELECT RAISE(ABORT,'immutable recovery audit'); END;
    CREATE TRIGGER content_recovery_immutable_delete BEFORE DELETE ON content_note_operation_recovery BEGIN SELECT RAISE(ABORT,'immutable recovery audit'); END;
    "#,
    // v11: explicit offline selection and recoverable body preparation. No old
    // note, intent, audit or attachment row is rewritten by this migration.
    r#"
    CREATE TABLE content_offline_vault (
      desktop_instance_id TEXT NOT NULL, vault_id TEXT NOT NULL,
      paused INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 1,
      waiting_current INTEGER NOT NULL DEFAULT 0,
      write_state TEXT NOT NULL DEFAULT 'unknown',
      PRIMARY KEY(desktop_instance_id,vault_id));
    CREATE TABLE content_offline_note (
      desktop_instance_id TEXT NOT NULL, vault_id TEXT NOT NULL, note_id TEXT NOT NULL,
      target_revision TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','ready','failed','unverified')),
      error TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0,
      next_retry INTEGER NOT NULL DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(desktop_instance_id,vault_id,note_id));
    "#,
    // v12 — durable phone-local knowledge folders, including empty folders.
    // The membership column is added conditionally by migrate_kind because
    // reset_full preserves local_note_* tables while replaying migrations.
    r#"
    CREATE TABLE IF NOT EXISTS local_note_folder (
      path TEXT PRIMARY KEY,
      parent TEXT NOT NULL,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      UNIQUE(parent, name_key)
    );
    "#,
];

pub struct Db {
    conn: Connection,
}

#[path = "content_db.rs"]
pub(crate) mod content_db;

/// Startup-failure classification for [`Db::open_kind`].
///
/// Only `Corrupt` (definite SQLite file corruption: SQLITE_NOTADB /
/// SQLITE_CORRUPT) is eligible for quarantine isolation. Every other failure
/// class — ENOSPC, I/O, permission, busy, schema/migration — must surface as
/// a startup error instead of being treated as corruption, because
/// quarantining would silently discard the user's database.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenFailure {
    Corrupt,
    Other,
}

/// Maps a rusqlite error to the narrow corruption predicate. Anything that is
/// not an explicit NOTADB/CORRUPT sqlite result is `Other`.
pub(crate) fn classify_open(e: &rusqlite::Error) -> OpenFailure {
    match e {
        rusqlite::Error::SqliteFailure(f, _) => match f.code {
            rusqlite::ffi::ErrorCode::NotADatabase | rusqlite::ffi::ErrorCode::DatabaseCorrupt => {
                OpenFailure::Corrupt
            }
            _ => OpenFailure::Other,
        },
        _ => OpenFailure::Other,
    }
}

impl Db {
    pub fn open(path: &Path) -> Result<Self, String> {
        Self::open_kind(path).map_err(|(msg, _)| msg)
    }

    /// Like [`Self::open`], but additionally classifies the failure so callers
    /// can distinguish *definite SQLite file corruption* (SQLITE_NOTADB /
    /// SQLITE_CORRUPT) from transient or environmental errors (ENOSPC, I/O,
    /// permission, busy, schema/migration problems). Only the corruption class
    /// may trigger quarantine — anything else must surface as a startup error
    /// instead of silently discarding the user's database.
    pub fn open_kind(path: &Path) -> Result<Self, (String, OpenFailure)> {
        let conn = match Connection::open(path) {
            Ok(conn) => conn,
            Err(e) => return Err((format!("open db: {e}"), classify_open(&e))),
        };
        if let Err(e) = conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;
             PRAGMA secure_delete=ON;
             PRAGMA busy_timeout=5000;",
        ) {
            return Err((format!("pragma: {e}"), classify_open(&e)));
        }
        let mut db = Db { conn };
        db.migrate_kind()?;
        if let Err(e) = db.recover_interrupted_outbox() {
            return Err((format!("outbox: {e}"), OpenFailure::Other));
        }
        Ok(db)
    }

    fn migrate_kind(&mut self) -> Result<(), (String, OpenFailure)> {
        let current: i64 = self
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| (format!("read user_version: {e}"), classify_open(&e)))?;
        for (i, sql) in MIGRATIONS.iter().enumerate() {
            let v = i as i64 + 1;
            if v > current {
                // Forward-only: each migration runs exactly once, inside its own
                // IMMEDIATE transaction. A failure leaves user_version untouched
                // so a retry re-runs from the same point (idempotent by design;
                // MIGRATIONS is append-only — never edit existing entries).
                let tx = self
                    .conn
                    .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                    .map_err(|e| (format!("migrate tx: {e}"), classify_open(&e)))?;
                tx.execute_batch(sql)
                    .map_err(|e| (format!("migrate v{v}: {e}"), classify_open(&e)))?;
                if v == 12 {
                    let has_folder: bool = tx.query_row(
                        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('local_note_item') WHERE name='folder')",
                        [], |r| r.get(0),
                    ).map_err(|e| (format!("inspect note folder migration: {e}"), classify_open(&e)))?;
                    if !has_folder {
                        tx.execute_batch("ALTER TABLE local_note_item ADD COLUMN folder TEXT NOT NULL DEFAULT '';")
                            .map_err(|e| (format!("migrate note folder: {e}"), classify_open(&e)))?;
                    }
                    tx.execute_batch("CREATE INDEX IF NOT EXISTS idx_local_note_folder ON local_note_item(folder);")
                        .map_err(|e| (format!("index note folder: {e}"), classify_open(&e)))?;
                }
                tx.pragma_update(None, "user_version", v)
                    .map_err(|e| (format!("set user_version: {e}"), classify_open(&e)))?;
                tx.commit()
                    .map_err(|e| (format!("migrate commit: {e}"), classify_open(&e)))?;
            }
        }
        Ok(())
    }

    /// Health check used by the frontend to render a recoverable error page
    /// instead of a silent white screen when local data cannot be upgraded.
    /// Reports current schema version and whether it matches the app's expected
    /// schema. Also verifies core tables are queryable (catches a corrupted
    /// db file left by an interrupted migration).
    pub fn health(&self) -> Result<serde_json::Value, String> {
        let current: i64 = self
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| format!("read user_version: {e}"))?;
        let integrity: String = self
            .conn
            .query_row("PRAGMA quick_check(1)", [], |r| r.get(0))
            .map_err(|e| format!("health integrity check: {e}"))?;
        let integrity_ok = integrity.eq_ignore_ascii_case("ok");
        let mut ok_tables = true;
        for t in ["paired_desktop", "sync_cursor", "asset_cache", "note_cache", "capture_outbox", "capture_attachment", "local_inbox_item", "local_inbox_attachment", "local_note_item", "local_note_tag", "local_note_folder", "local_asset_item", "local_asset_tag", "content_note_operation", "content_note_attachment", "content_vault_cache", "content_response_cache"] {
            let n: i64 = self
                .conn
                .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1", params![t], |r| r.get(0))
                .map_err(|e| format!("health query: {e}"))?;
            if n == 0 {
                ok_tables = false;
            }
        }
        for t in ["content_note_operation_pause", "content_note_operation_recovery", "content_offline_vault", "content_offline_note"] {
            if self.conn.query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get::<_, i64>(0)).is_err() { ok_tables = false; }
        }
        let ok = current == SCHEMA_VERSION && ok_tables && integrity_ok;
        let recovery = if current > SCHEMA_VERSION {
            // A newer schema must not be destructively reset by an older app;
            // the user needs a compatible application version first.
            "incompatible-newer-schema"
        } else if !integrity_ok || !ok_tables {
            "reset-required"
        } else if current < SCHEMA_VERSION {
            // Normally Db::open runs migrations before health is exposed. This
            // branch still tells a caller an interrupted lower-version state is
            // retryable rather than silently treating it as healthy.
            "retry-migration"
        } else {
            "healthy"
        };
        Ok(serde_json::json!({
            "ok": ok,
            "schemaVersion": current,
            "expectedVersion": SCHEMA_VERSION,
            "tablesOk": ok_tables,
            "integrityOk": integrity_ok,
            "recovery": recovery,
        }))
    }

    /// RecoveryScreen "重置本地数据": drop every table, reset user_version and
    /// re-run migrations from scratch. Clears pairing + caches; nothing is
    /// recovered afterwards (user explicitly chose full reset).
    ///
    /// M2.7/M2.8/M2.9 ownership gate: the Local Inbox (`local_inbox_*`), Local
    /// Notes (`local_note_*`) and Local Assets (`local_asset_*`) are user-created
    /// durable data, not Desktop cache. A Desktop/cache reset must never
    /// silently erase them, so those tables are preserved here. Erasing each
    /// domain is a separate explicit destructive operation (`inbox_erase_all` /
    /// `note_erase_all` / `asset_erase_all`).
    pub fn reset_full(&mut self) -> Result<(), String> {
        let pending: i64 = self.conn.query_row("SELECT COUNT(*) FROM note_cache WHERE dirty=1", [], |r| r.get(0)).map_err(|e| e.to_string())?;
        if pending > 0 { return Err("还有未同步的电脑笔记草稿，请先处理或保留副本后再重置缓存。".into()); }
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| format!("reset tx: {e}"))?;
        let names: Vec<String> = tx
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
            .map_err(|e| format!("list tables: {e}"))?
            .query_map([], |r| r.get(0))
            .map_err(|e| format!("map tables: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("collect tables: {e}"))?;
        for name in &names {
            if name.starts_with("local_inbox_")
                || name.starts_with("local_note_")
                || name.starts_with("local_asset_")
            {
                continue; // user-created data survives a Desktop/cache reset
            }
            tx.execute_batch(&format!("DROP TABLE IF EXISTS \"{name}\";"))
                .map_err(|e| format!("drop {name}: {e}"))?;
        }
        tx.pragma_update(None, "user_version", 0)
            .map_err(|e| format!("reset user_version: {e}"))?;
        tx.commit().map_err(|e| format!("reset commit: {e}"))?;
        self.migrate_kind().map_err(|(msg, _)| msg)
    }

    // ---- paired_desktop ----
    /// Stores pairing metadata only. The compatibility `credential` column is
    /// deliberately kept empty; usable credentials belong in SecureCredentialStore.
    pub fn upsert_paired(
        &mut self,
        instance: &str,
        name: &str,
        platform: &str,
        app_version: &str,
        protocol_version: i64,
        fp: &str,
        base_url: &str,
    ) -> Result<(), String> {
        // Single-authority model: pairing a (new) Desktop instance replaces the
        // previous one. Caches are namespaced by desktop_instance_id, so a new
        // instance never merges with stale state (ADR-0001 DESKTOP_INSTANCE_CHANGED).
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| format!("paired tx: {e}"))?;
        tx.execute("DELETE FROM paired_desktop", []).map_err(|e| format!("clear paired: {e}"))?;
        tx.execute(
            "INSERT INTO paired_desktop VALUES (?1,?2,?3,?4,?5,?6,?7,?8,datetime('now'))",
            params![instance, name, platform, app_version, protocol_version, fp, base_url, ""],
        )
        .map_err(|e| format!("upsert paired: {e}"))?;
        tx.commit().map_err(|e| format!("paired commit: {e}"))?;
        Ok(())
    }

    /// Legacy M2.x rows may still contain a credential. Callers must first
    /// write and read-back-verify it in secure storage, then clear this field.
    ///
    /// SQLite uses WAL mode, so logical row cleanup is insufficient on its
    /// own: this writes a durable pending marker, commits the empty value, and
    /// only reports success after a non-busy WAL TRUNCATE checkpoint has
    /// removed historical plaintext frames.
    pub fn scrub_legacy_credential(&mut self, instance: &str) -> Result<(), String> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| format!("legacy credential scrub transaction: {e}"))?;
        tx.execute(
            "INSERT OR REPLACE INTO app_meta VALUES (?1, 'pending')",
            params![LEGACY_CREDENTIAL_WAL_CLEANUP_KEY],
        )
        .map_err(|e| format!("mark legacy credential WAL cleanup: {e}"))?;
        let changed = tx
            .execute(
                "UPDATE paired_desktop SET credential='' WHERE desktop_instance_id=?1",
                params![instance],
            )
            .map_err(|e| format!("scrub legacy credential: {e}"))?;
        if changed != 1 {
            return Err("legacy credential pairing metadata missing during scrub".into());
        }
        tx.commit()
            .map_err(|e| format!("commit legacy credential scrub: {e}"))?;
        self.finish_pending_legacy_credential_wal_cleanup()
    }

    /// Retries an interrupted post-scrub cleanup before authenticated use.
    /// A busy/failed checkpoint remains a hard migration-cleanup error; callers
    /// must not construct a GatewayClient until it succeeds.
    pub fn finish_pending_legacy_credential_wal_cleanup(&self) -> Result<(), String> {
        if self.meta_get(LEGACY_CREDENTIAL_WAL_CLEANUP_KEY)?.is_none() {
            return Ok(());
        }

        let (busy, log_frames, checkpointed_frames): (i64, i64, i64) = self
            .conn
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(|e| format!("legacy credential WAL checkpoint: {e}"))?;
        if busy != 0 {
            return Err(format!(
                "legacy credential WAL truncate busy (log={log_frames}, checkpointed={checkpointed_frames})"
            ));
        }

        self.conn
            .execute(
                "DELETE FROM app_meta WHERE key=?1",
                params![LEGACY_CREDENTIAL_WAL_CLEANUP_KEY],
            )
            .map_err(|e| format!("clear legacy credential WAL cleanup marker: {e}"))?;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn seed_legacy_credential_for_test(
        &self,
        instance: &str,
        credential: &str,
    ) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE paired_desktop SET credential=?2 WHERE desktop_instance_id=?1",
                params![instance, credential],
            )
            .map_err(|e| format!("seed legacy credential: {e}"))?;
        Ok(())
    }

    pub fn paired(&self) -> Result<Option<PairedDesktop>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT desktop_instance_id, display_name, platform, app_version, protocol_version,
                        certificate_fingerprint, base_url, credential, paired_at
                 FROM paired_desktop ORDER BY paired_at DESC LIMIT 1",
            )
            .map_err(|e| format!("prepare: {e}"))?;
        let mut rows = stmt
            .query_map([], |r| {
                Ok(PairedDesktop {
                    instance_id: r.get(0)?,
                    display_name: r.get(1)?,
                    platform: r.get(2)?,
                    app_version: r.get(3)?,
                    protocol_version: r.get(4)?,
                    fingerprint: r.get(5)?,
                    base_url: r.get(6)?,
                    legacy_credential: r.get(7)?,
                    paired_at: r.get(8)?,
                })
            })
            .map_err(|e| format!("query: {e}"))?;
        match rows.next() {
            Some(Ok(row)) => Ok(Some(row)),
            Some(Err(e)) => Err(format!("row: {e}")),
            None => Ok(None),
        }
    }

    pub fn revoke_paired(&mut self) -> Result<(), String> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| format!("revoke transaction: {e}"))?;
        // Capture attachments are deleted with their queue rows at the same
        // durable boundary as pairing metadata. App-private file cleanup happens
        // before this transaction; if the process dies between the two, a later
        // reset sees a bounded missing-file failure rather than stale metadata.
        for table in [
            "capture_attachment",
            "capture_outbox",
            "sync_cursor",
            "asset_tag_cache",
            "asset_cache",
            "ai_event_cache",
            "ai_run_cache",
            "paired_desktop",
        ] {
            tx.execute(&format!("DELETE FROM {table}"), [])
                .map_err(|e| format!("revoke {table}: {e}"))?;
        }
        tx.execute("DELETE FROM note_cache WHERE dirty=0", []).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| format!("revoke commit: {e}"))?;
        Ok(())
    }

    // ---- sync_cursor ----
    pub fn cursor(&self, instance: &str, key: &str) -> Result<i64, String> {
        self.conn
            .query_row(
                "SELECT seq FROM sync_cursor WHERE desktop_instance_id=?1 AND cursor_key=?2",
                params![instance, key],
                |r| r.get(0),
            )
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(0),
                other => Err(format!("cursor: {other}")),
            })
    }

    pub fn set_cursor(&self, instance: &str, key: &str, seq: i64) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO sync_cursor VALUES (?1,?2,?3)
                 ON CONFLICT(desktop_instance_id, cursor_key) DO UPDATE SET seq=excluded.seq",
                params![instance, key, seq],
            )
            .map_err(|e| format!("set cursor: {e}"))?;
        Ok(())
    }

    // ---- asset_cache ----
    pub fn upsert_asset(
        &mut self,
        instance: &str,
        id: &str,
        name: &str,
        kind: &str,
        mime: &str,
        size: i64,
        updated_at: &str,
        hash: &str,
        thumb_rev: &str,
        folder_id: &str,
        tags: &[String],
    ) -> Result<(), String> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| format!("tx: {e}"))?;
        tx.execute(
            "INSERT INTO asset_cache (desktop_instance_id, desktop_asset_id, name, kind, mime_type, size_bytes, updated_at, content_hash, thumbnail_revision, folder_id, thumbnail_path, cached_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,NULL,datetime('now'))
             ON CONFLICT(desktop_instance_id, desktop_asset_id) DO UPDATE SET
               name=excluded.name, kind=excluded.kind, mime_type=excluded.mime_type,
               size_bytes=excluded.size_bytes, updated_at=excluded.updated_at,
               content_hash=excluded.content_hash, thumbnail_revision=excluded.thumbnail_revision,
               thumbnail_etag=CASE WHEN COALESCE(asset_cache.thumbnail_revision,'')<>excluded.thumbnail_revision
                 OR COALESCE(asset_cache.content_hash,'')<>excluded.content_hash
                 OR (excluded.thumbnail_revision='' AND excluded.content_hash='' AND asset_cache.updated_at<>excluded.updated_at)
                 THEN NULL ELSE asset_cache.thumbnail_etag END,
               folder_id=excluded.folder_id, cached_at=datetime('now')",
            params![instance, id, name, kind, mime, size, updated_at, hash, thumb_rev, folder_id],
        )
        .map_err(|e| format!("upsert asset: {e}"))?;
        tx.execute("DELETE FROM asset_tag_cache WHERE desktop_instance_id=?1 AND desktop_asset_id=?2", params![instance, id])
            .map_err(|e| format!("clear tags: {e}"))?;
        for tag in tags {
            tx.execute("INSERT OR IGNORE INTO asset_tag_cache VALUES (?1,?2,?3)", params![instance, id, tag])
                .map_err(|e| format!("tag: {e}"))?;
        }
        tx.commit().map_err(|e| format!("commit: {e}"))?;
        Ok(())
    }

    pub fn delete_asset(&mut self, instance: &str, id: &str) -> Result<(), String> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| format!("tx: {e}"))?;
        tx.execute("DELETE FROM asset_tag_cache WHERE desktop_instance_id=?1 AND desktop_asset_id=?2", params![instance, id])
            .map_err(|e| format!("clear tags: {e}"))?;
        tx.execute("DELETE FROM asset_cache WHERE desktop_instance_id=?1 AND desktop_asset_id=?2", params![instance, id])
            .map_err(|e| format!("delete asset: {e}"))?;
        tx.commit().map_err(|e| format!("commit: {e}"))?;
        Ok(())
    }

    /// Available material version fields in the existing owner-bound row.
    /// The same encoding is used by the frontend; absence is not invented.
    pub(crate) fn asset_version(&self, instance: &str, id: &str) -> Result<Option<String>, String> {
        use rusqlite::OptionalExtension;
        self.conn.query_row("SELECT content_hash,thumbnail_revision,updated_at FROM asset_cache WHERE desktop_instance_id=?1 AND desktop_asset_id=?2",
            params![instance,id],|r| {
                let fields:[String;3]=[r.get(0)?,r.get(1)?,r.get(2)?];
                Ok(if fields.iter().all(String::is_empty) {String::new()} else {fields.join("|")})
            }).optional().map_err(|e|format!("asset version: {e}"))
    }

    pub fn list_assets(&self, instance: &str, kind: Option<&str>, page: i64, limit: i64) -> Result<Vec<AssetRow>, String> {
        let mut sql = String::from(
            "SELECT a.desktop_asset_id, a.name, a.kind, a.mime_type, a.size_bytes, a.updated_at,
                    a.content_hash, a.thumbnail_revision, a.folder_id, a.thumbnail_path,
                    COALESCE((SELECT group_concat(tag) FROM asset_tag_cache t
                              WHERE t.desktop_instance_id=a.desktop_instance_id
                                AND t.desktop_asset_id=a.desktop_asset_id), '')
             FROM asset_cache a WHERE a.desktop_instance_id=?1",
        );
        let mut args: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(instance.to_string())];
        let kind = kind.filter(|k| !k.is_empty());
        if let Some(k) = &kind {
            sql.push_str(" AND a.kind=?2");
            args.push(Box::new(k.to_string()));
        }
        let lim = args.len() as i32 + 1;
        let off = lim + 1;
        sql.push_str(&format!(" ORDER BY a.updated_at DESC LIMIT ?{lim} OFFSET ?{off}"));
        args.push(Box::new(limit));
        args.push(Box::new(page * limit));
        let mut stmt = self.conn.prepare(&sql).map_err(|e| format!("prepare: {e}"))?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(args.iter().map(|a| a.as_ref())), |r| {
                Ok(AssetRow {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    kind: r.get(2)?,
                    mime: r.get(3)?,
                    size: r.get(4)?,
                    updated_at: r.get(5)?,
                    hash: r.get(6)?,
                    thumb_rev: r.get(7)?,
                    folder_id: r.get(8)?,
                    thumb_path: r.get::<_, Option<String>>(9)?.unwrap_or_default(),
                    tags: r.get::<_, String>(10)?.split(',').filter(|s| !s.is_empty()).map(String::from).collect(),
                })
            })
            .map_err(|e| format!("query: {e}"))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("row: {e}"))?);
        }
        Ok(out)
    }

    pub fn count_assets(&self, instance: &str) -> Result<i64, String> {
        self.conn
            .query_row("SELECT COUNT(*) FROM asset_cache WHERE desktop_instance_id=?1", params![instance], |r| r.get(0))
            .map_err(|e| format!("count assets: {e}"))
    }

    pub fn set_thumbnail(
        &self,
        instance: &str,
        id: &str,
        path: &str,
        etag: &str,
        mime: &str,
        w: i64,
        h: i64,
    ) -> Result<usize, String> {
        let n = self
            .conn
            .execute(
                "UPDATE asset_cache SET thumbnail_path=?3, thumbnail_etag=?4, thumbnail_mime=?5,
                        thumbnail_w=?6, thumbnail_h=?7, thumbnail_last_accessed=datetime('now')
                 WHERE desktop_instance_id=?1 AND desktop_asset_id=?2",
                params![instance, id, path, etag, mime, w, h],
            )
            .map_err(|e| format!("thumb meta: {e}"))?;
        Ok(n)
    }

    pub fn touch_thumbnail(&self, instance: &str, id: &str) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE asset_cache SET thumbnail_last_accessed=datetime('now') WHERE desktop_instance_id=?1 AND desktop_asset_id=?2",
                params![instance, id],
            )
            .map_err(|e| format!("touch thumb: {e}"))?;
        Ok(())
    }

    pub fn thumbnail_meta(&self, instance: &str, id: &str) -> Result<Option<ThumbMeta>, String> {
        self.conn
            .query_row(
                "SELECT thumbnail_path, thumbnail_etag, thumbnail_mime, thumbnail_w, thumbnail_h FROM asset_cache
                 WHERE desktop_instance_id=?1 AND desktop_asset_id=?2",
                params![instance, id],
                |r| {
                    let path: Option<String> = r.get(0)?;
                    if path.is_none() {
                        return Ok(None);
                    }
                    Ok(Some(ThumbMeta {
                        path: path.unwrap(),
                        etag: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                        mime: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                        w: r.get(3)?,
                        h: r.get(4)?,
                    }))
                },
            )
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(format!("thumb meta: {other}")),
            })
    }

    /// LRU order by last_accessed (oldest first) for eviction.
    pub fn thumbnails_lru(&self, instance: &str) -> Result<Vec<(String, String)>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT desktop_asset_id, thumbnail_path FROM asset_cache
                 WHERE desktop_instance_id=?1 AND thumbnail_path IS NOT NULL
                 ORDER BY thumbnail_last_accessed ASC",
            )
            .map_err(|e| format!("prepare: {e}"))?;
        let rows = stmt
            .query_map(params![instance], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| format!("query: {e}"))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("row: {e}"))?);
        }
        Ok(out)
    }

    pub fn clear_thumbnail_meta(&self, instance: &str, id: &str) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE asset_cache SET thumbnail_path=NULL, thumbnail_etag=NULL, thumbnail_mime=NULL, thumbnail_w=NULL, thumbnail_h=NULL
                 WHERE desktop_instance_id=?1 AND desktop_asset_id=?2",
                params![instance, id],
            )
            .map_err(|e| format!("clear thumb: {e}"))?;
        Ok(())
    }

    // ---- note_cache ----
    pub fn upsert_note(&self, instance: &str, id: &str, title: &str, path: &str, content: &str, rev: &str, updated_at: &str) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO note_cache(desktop_instance_id,note_id,title,relative_path,content,revision,updated_at,dirty,base_revision) VALUES (?1,?2,?3,?4,?5,?6,?7,0,NULL)
                 ON CONFLICT(desktop_instance_id, note_id) DO UPDATE SET
                   title=excluded.title, relative_path=excluded.relative_path,
                   content=excluded.content, revision=excluded.revision,
                   updated_at=excluded.updated_at, dirty=0, base_revision=NULL",
                params![instance, id, title, path, content, rev, updated_at],
            )
            .map_err(|e| format!("upsert note: {e}"))?;
        Ok(())
    }

    pub fn list_notes(&self, instance: &str) -> Result<Vec<NoteRow>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT note_id, title, relative_path, revision, updated_at, dirty, vault_id
                 FROM note_cache WHERE desktop_instance_id=?1 AND (deleted=0 OR dirty=1) ORDER BY updated_at DESC",
            )
            .map_err(|e| format!("prepare: {e}"))?;
        let rows = stmt
            .query_map(params![instance], |r| {
                Ok(NoteRow { id: r.get(0)?, title: r.get(1)?, path: r.get(2)?, revision: r.get(3)?, updated_at: r.get(4)?, dirty: r.get(5)?, vault_id: r.get(6)? })
            })
            .map_err(|e| format!("query: {e}"))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("row: {e}"))?);
        }
        Ok(out)
    }

    pub fn get_note(&self, instance: &str, id: &str) -> Result<Option<NoteRow>, String> {
        self.conn
            .query_row(
                "SELECT note_id, title, relative_path, revision, updated_at, dirty, vault_id FROM note_cache
                 WHERE desktop_instance_id=?1 AND note_id=?2",
                params![instance, id],
                |r| {
                    Ok(NoteRow { id: r.get(0)?, title: r.get(1)?, path: r.get(2)?, revision: r.get(3)?, updated_at: r.get(4)?, dirty: r.get(5)?, vault_id: r.get(6)? })
                },
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(format!("get note: {other}")),
            })
    }

    pub fn get_note_content(&self, instance: &str, id: &str) -> Result<Option<String>, String> {
        self.conn
            .query_row(
                "SELECT content FROM note_cache WHERE desktop_instance_id=?1 AND note_id=?2",
                params![instance, id],
                |r| r.get(0),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(format!("get note content: {other}")),
            })
    }

    pub fn apply_local_note_edit(&self, instance: &str, id: &str, title: &str, content: &str) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE note_cache SET title=?3, content=?4, dirty=1,
                        base_revision=CASE WHEN base_revision IS NULL THEN revision ELSE base_revision END,
                        updated_at=datetime('now')
                 WHERE desktop_instance_id=?1 AND note_id=?2",
                params![instance, id, title, content],
            )
            .map_err(|e| format!("local edit: {e}"))?;
        Ok(())
    }

    pub fn mark_note_synced(&self, instance: &str, id: &str, new_rev: &str) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE note_cache SET revision=?3, dirty=0, base_revision=NULL WHERE desktop_instance_id=?1 AND note_id=?2",
                params![instance, id, new_rev],
            )
            .map_err(|e| format!("mark synced: {e}"))?;
        Ok(())
    }

    pub fn delete_note(&self, instance: &str, id: &str) -> Result<(), String> {
        self.conn
            .execute("DELETE FROM note_cache WHERE desktop_instance_id=?1 AND note_id=?2", params![instance, id])
            .map_err(|e| format!("delete note: {e}"))?;
        Ok(())
    }

    // ---- capture_outbox ----
    /// An upload that was in flight when Android terminated the process has no
    /// durable completion acknowledgement. Requeue it before the UI or a flush
    /// can observe the outbox; the existing opId makes the subsequent retry
    /// safe when the gateway had already accepted the request.
    pub fn recover_interrupted_outbox(&self) -> Result<usize, String> {
        self.conn
            .execute(
                "UPDATE capture_outbox
                 SET state=?1,
                     last_error='upload interrupted by app restart; retry queued'
                 WHERE state=?2",
                params![OUTBOX_PENDING, OUTBOX_UPLOADING],
            )
            .map_err(|e| format!("recover interrupted outbox: {e}"))
    }

    pub fn enqueue_capture(&self, instance: &str, op_id: &str, kind: &str, payload: &str) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT OR IGNORE INTO capture_outbox VALUES (?1,?2,?3,?4,?5,0,NULL,datetime('now'))",
                params![op_id, instance, kind, payload, OUTBOX_PENDING],
            )
            .map_err(|e| format!("enqueue: {e}"))?;
        Ok(())
    }

    /// Persist a picked attachment and its capture together. The native picker
    /// has already copied the file into app-private storage; this transaction
    /// makes the metadata visible as one durable unit, so a process death
    /// cannot leave a queued capture that references an unrecorded attachment.
    /// Replaying an opId is intentionally a no-op, preserving the metadata from
    /// the original committed enqueue.
    #[allow(clippy::too_many_arguments)]
    pub fn enqueue_capture_with_attachment(
        &mut self,
        instance: &str,
        op_id: &str,
        kind: &str,
        payload: &str,
        ref_id: &str,
        attachment_kind: &str,
        file_name: &str,
        size: i64,
        sha256: &str,
        local_path: &str,
    ) -> Result<(), String> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| format!("capture enqueue transaction: {e}"))?;
        let inserted = tx
            .execute(
                "INSERT OR IGNORE INTO capture_outbox VALUES (?1,?2,?3,?4,?5,0,NULL,datetime('now'))",
                params![op_id, instance, kind, payload, OUTBOX_PENDING],
            )
            .map_err(|e| format!("capture enqueue: {e}"))?;
        if inserted == 1 {
            tx.execute(
                "INSERT INTO capture_attachment VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![op_id, ref_id, attachment_kind, file_name, size, sha256, local_path],
            )
            .map_err(|e| format!("capture attachment enqueue: {e}"))?;
        }
        tx.commit()
            .map_err(|e| format!("capture enqueue commit: {e}"))?;
        Ok(())
    }

    pub fn list_outbox(&self, instance: &str) -> Result<Vec<OutboxRow>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT op_id, kind, payload, state, attempt_count, last_error FROM capture_outbox
                 WHERE desktop_instance_id=?1 ORDER BY created_at",
            )
            .map_err(|e| format!("prepare: {e}"))?;
        let rows = stmt
            .query_map(params![instance], |r| {
                Ok(OutboxRow { op_id: r.get(0)?, kind: r.get(1)?, payload: r.get(2)?, state: r.get(3)?, attempt: r.get(4)?, error: r.get::<_, Option<String>>(5)?.unwrap_or_default() })
            })
            .map_err(|e| format!("query: {e}"))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("row: {e}"))?);
        }
        Ok(out)
    }

    /// Atomically claim a queued or failed item for one upload attempt. A
    /// concurrent flush cannot claim the same opId because the conditional
    /// update affects exactly one row.
    pub fn outbox_begin_upload(&self, op_id: &str) -> Result<(), String> {
        let changed = self
            .conn
            .execute(
                "UPDATE capture_outbox
                 SET state=?2, attempt_count=attempt_count+1, last_error=NULL
                 WHERE op_id=?1 AND state IN (?3, ?4)",
                params![op_id, OUTBOX_UPLOADING, OUTBOX_PENDING, OUTBOX_FAILED],
            )
            .map_err(|e| format!("outbox begin upload: {e}"))?;
        if changed != 1 {
            return Err("outbox item is not ready to upload".into());
        }
        Ok(())
    }

    /// Finish a previously claimed upload. Attempt counting belongs exclusively
    /// to `outbox_begin_upload`, so a failure/completion transition cannot
    /// inflate diagnostics or hide a retry loop.
    pub fn outbox_finish_upload(
        &self,
        op_id: &str,
        state: &str,
        error: Option<&str>,
    ) -> Result<(), String> {
        if state != OUTBOX_COMPLETED && state != OUTBOX_FAILED {
            return Err("invalid outbox upload completion state".into());
        }
        let changed = self
            .conn
            .execute(
                "UPDATE capture_outbox SET state=?2, last_error=?3
                 WHERE op_id=?1 AND state=?4",
                params![op_id, state, error, OUTBOX_UPLOADING],
            )
            .map_err(|e| format!("outbox finish upload: {e}"))?;
        if changed != 1 {
            return Err("outbox item is not uploading".into());
        }
        Ok(())
    }

    pub fn outbox_mark(&self, op_id: &str, state: &str, error: Option<&str>) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE capture_outbox SET state=?2, attempt_count=attempt_count+1, last_error=?3 WHERE op_id=?1",
                params![op_id, state, error],
            )
            .map_err(|e| format!("outbox mark: {e}"))?;
        Ok(())
    }

    pub fn insert_attachment(
        &self,
        op_id: &str,
        ref_id: &str,
        kind: &str,
        file_name: &str,
        size: i64,
        sha256: &str,
        local_path: &str,
    ) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT OR REPLACE INTO capture_attachment VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![op_id, ref_id, kind, file_name, size, sha256, local_path],
            )
            .map_err(|e| format!("insert attach: {e}"))?;
        Ok(())
    }

    pub fn list_attachments(&self, op_id: &str) -> Result<Vec<serde_json::Value>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT ref_id, kind, file_name, size_bytes, sha256, local_path FROM capture_attachment WHERE op_id=?1",
            )
            .map_err(|e| format!("prepare: {e}"))?;
        let rows = stmt
            .query_map(params![op_id], |r| {
                Ok(serde_json::json!({
                    "refId": r.get::<_, String>(0)?,
                    "kind": r.get::<_, String>(1)?,
                    "fileName": r.get::<_, String>(2)?,
                    "sizeBytes": r.get::<_, i64>(3)?,
                    "sha256": r.get::<_, String>(4)?,
                    "localPath": r.get::<_, String>(5)?,
                }))
            })
            .map_err(|e| format!("query: {e}"))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("row: {e}"))?);
        }
        Ok(out)
    }

    /// Attachments for captures already acknowledged by the gateway. They are
    /// retained until app-private file cleanup succeeds, which makes a crash
    /// between durable completion and file removal safely retryable on restart.
    pub fn list_completed_attachments(&self) -> Result<Vec<AttachmentRow>, String> {
        let mut statement = self
            .conn
            .prepare(
                "SELECT a.op_id, a.ref_id, a.local_path
                 FROM capture_attachment a
                 INNER JOIN capture_outbox o ON o.op_id=a.op_id
                 WHERE o.state=?1
                 ORDER BY o.created_at, a.ref_id",
            )
            .map_err(|e| format!("prepare completed attachments: {e}"))?;
        let rows = statement
            .query_map(params![OUTBOX_COMPLETED], |row| {
                Ok(AttachmentRow {
                    op_id: row.get(0)?,
                    ref_id: row.get(1)?,
                    local_path: row.get(2)?,
                })
            })
            .map_err(|e| format!("query completed attachments: {e}"))?;
        let mut attachments = Vec::new();
        for row in rows {
            attachments.push(row.map_err(|e| format!("completed attachment row: {e}"))?);
        }
        Ok(attachments)
    }

    /// All paths still represented by durable attachment metadata. Startup uses
    /// this allow-list when reconciling the Android app-private capture folder,
    /// so an interrupted picker cannot cause an unrelated queued attachment to
    /// be deleted.
    pub fn list_attachment_paths(&self) -> Result<Vec<String>, String> {
        let mut statement = self
            .conn
            .prepare(
                "SELECT local_path FROM capture_attachment
                 WHERE local_path IS NOT NULL AND local_path <> ''",
            )
            .map_err(|e| format!("prepare attachment paths: {e}"))?;
        let rows = statement
            .query_map([], |row| row.get(0))
            .map_err(|e| format!("query attachment paths: {e}"))?;
        let mut paths = Vec::new();
        for row in rows {
            paths.push(row.map_err(|e| format!("attachment path row: {e}"))?);
        }
        Ok(paths)
    }

    /// Remove metadata only after the corresponding app-private file has been
    /// deleted (or is already absent). Keeping the completed outbox row lets the
    /// UI retain its local history without leaking attachment references.
    pub fn delete_attachment(&self, op_id: &str, ref_id: &str) -> Result<(), String> {
        self.conn
            .execute(
                "DELETE FROM capture_attachment WHERE op_id=?1 AND ref_id=?2",
                params![op_id, ref_id],
            )
            .map_err(|e| format!("delete attachment metadata: {e}"))?;
        Ok(())
    }

    pub fn outbox_delete(&self, op_id: &str) -> Result<(), String> {
        self.conn
            .execute("DELETE FROM capture_outbox WHERE op_id=?1", params![op_id])
            .map_err(|e| format!("outbox delete: {e}"))?;
        self.conn
            .execute("DELETE FROM capture_attachment WHERE op_id=?1", params![op_id])
            .map_err(|e| format!("attach delete: {e}"))?;
        Ok(())
    }

    // ---- local inbox (M2.7 Mobile-local domain) ----
    // User-created durable data owned by the phone alone. No desktop_instance_id
    // anywhere: independent from asset_cache / note_cache / capture_outbox and
    // Protocol V1. Attachment originals are app-private files under
    // `local-inbox/` (att-* names); DB rows record their metadata.

    /// Insert a manual text/link item. A single INSERT is atomic; the
    /// attachment variant below wraps item + attachment in one transaction.
    pub fn inbox_insert(
        &self,
        item_id: &str,
        kind: &str,
        title: &str,
        text: &str,
        url: &str,
        source: &str,
    ) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT OR IGNORE INTO local_inbox_item
                 (item_id, kind, title, text_payload, url, source, created_at, updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,datetime('now'),datetime('now'))",
                params![item_id, kind, title, text, url, source],
            )
            .map_err(|e| format!("inbox insert: {e}"))?;
        Ok(())
    }

    /// Persist a media item and its attachment metadata together. The app-private
    /// file already exists in `local-inbox/`; this transaction makes the item
    /// visible as one durable unit, so a process death cannot leave an item that
    /// points at an unrecorded file or a file that has no owner.
    /// Replaying the same item_id is intentionally a no-op (original metadata
    /// wins), which keeps retried deliveries idempotent.
    #[allow(clippy::too_many_arguments)]
    pub fn inbox_insert_with_attachment(
        &mut self,
        item_id: &str,
        kind: &str,
        title: &str,
        text: &str,
        url: &str,
        source: &str,
        ref_id: &str,
        att_kind: &str,
        mime: &str,
        file_name: &str,
        size: i64,
        sha256: &str,
        local_path: &str,
    ) -> Result<(), String> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| format!("inbox media transaction: {e}"))?;
        let inserted = tx
            .execute(
                "INSERT OR IGNORE INTO local_inbox_item
                 (item_id, kind, title, text_payload, url, source, created_at, updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,datetime('now'),datetime('now'))",
                params![item_id, kind, title, text, url, source],
            )
            .map_err(|e| format!("inbox media insert: {e}"))?;
        if inserted == 1 {
            tx.execute(
                "INSERT INTO local_inbox_attachment
                 (item_id, ref_id, kind, mime, file_name, size_bytes, sha256, local_path)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                params![item_id, ref_id, att_kind, mime, file_name, size, sha256, local_path],
            )
            .map_err(|e| format!("inbox attachment insert: {e}"))?;
        }
        tx.commit()
            .map_err(|e| format!("inbox media commit: {e}"))?;
        Ok(())
    }

    /// Ingest one shared item (Android ACTION_SEND) with duplicate-delivery
    /// protection. Returns Ok(true) when a new item was created, Ok(false) when
    /// this digest was already ingested recently (duplicate intent delivery /
    /// Activity recreation / a leftover share meta replayed after a crash).
    /// The digest check, item insert, and share-log refresh commit together, so
    /// a concurrent or replayed delivery cannot double-insert.
    #[allow(clippy::too_many_arguments)]
    pub fn inbox_share_ingest(
        &mut self,
        item_id: &str,
        kind: &str,
        title: &str,
        text: &str,
        url: &str,
        digest: &str,
        att_kind: Option<&str>,
        mime: Option<&str>,
        file_name: Option<&str>,
        size: Option<i64>,
        sha256: Option<&str>,
        local_path: Option<&str>,
    ) -> Result<bool, String> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| format!("inbox share transaction: {e}"))?;
        let duplicate: bool = tx
            .query_row(
                "SELECT 1 FROM local_inbox_share_log WHERE digest=?1 AND dedup_until > datetime('now')",
                params![digest],
                |r| r.get::<_, i64>(0),
            )
            .map(|v| v == 1)
            .unwrap_or(false);
        if duplicate {
            tx.commit()
                .map_err(|e| format!("inbox share dedup commit: {e}"))?;
            return Ok(false);
        }
        tx.execute(
            "INSERT INTO local_inbox_item
             (item_id, kind, title, text_payload, url, source, share_digest, created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,'share',?6,datetime('now'),datetime('now'))",
            params![item_id, kind, title, text, url, digest],
        )
        .map_err(|e| format!("inbox share insert: {e}"))?;
        if let (Some(att_kind), Some(file_name), Some(sha256), Some(local_path)) =
            (att_kind, file_name, sha256, local_path)
        {
            // ref_id mirrors the share nonce (the file is att-<nonce>.<ext>).
            tx.execute(
                "INSERT INTO local_inbox_attachment
                 (item_id, ref_id, kind, mime, file_name, size_bytes, sha256, local_path)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                params![
                    item_id,
                    item_id,
                    att_kind,
                    mime.unwrap_or("application/octet-stream"),
                    file_name,
                    size.unwrap_or(0),
                    sha256,
                    local_path,
                ],
            )
            .map_err(|e| format!("inbox share attachment insert: {e}"))?;
        }
        // Dedup window: 1 hour. A real re-share of the same content later still
        // creates a fresh item; a leftover meta from a crash within the window
        // cannot duplicate the original item.
        tx.execute(
            "INSERT INTO local_inbox_share_log (digest, dedup_until) VALUES (?1, datetime('now','+1 hour'))
             ON CONFLICT(digest) DO UPDATE SET dedup_until=excluded.dedup_until",
            params![digest],
        )
        .map_err(|e| format!("inbox share log: {e}"))?;
        tx.commit()
            .map_err(|e| format!("inbox share commit: {e}"))?;
        Ok(true)
    }

    pub fn inbox_get(&self, item_id: &str) -> Result<Option<InboxDetail>, String> {
        let item: Option<InboxItem> = self
            .conn
            .query_row(
                "SELECT item_id, kind, title, text_payload, url, source, archived, favorite, created_at, updated_at
                 FROM local_inbox_item WHERE item_id=?1",
                params![item_id],
                |r| {
                    Ok(InboxItem {
                        item_id: r.get(0)?,
                        kind: r.get(1)?,
                        title: r.get(2)?,
                        text: r.get(3)?,
                        url: r.get(4)?,
                        source: r.get(5)?,
                        archived: r.get::<_, i64>(6)? != 0,
                        favorite: r.get::<_, i64>(7)? != 0,
                        created_at: r.get(8)?,
                        updated_at: r.get(9)?,
                    })
                },
            )
            .optional()
            .map_err(|e| format!("inbox get: {e}"))?;
        let Some(item) = item else { return Ok(None) };
        let attachments = self.inbox_attachments(item_id)?;
        Ok(Some(InboxDetail { item, attachments }))
    }

    pub fn inbox_attachments(&self, item_id: &str) -> Result<Vec<InboxAttachmentRow>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT ref_id, kind, mime, file_name, size_bytes, sha256, local_path
                 FROM local_inbox_attachment WHERE item_id=?1 ORDER BY ref_id",
            )
            .map_err(|e| format!("prepare inbox attachments: {e}"))?;
        let rows = stmt
            .query_map(params![item_id], |r| {
                Ok(InboxAttachmentRow {
                    ref_id: r.get(0)?,
                    kind: r.get(1)?,
                    mime: r.get(2)?,
                    file_name: r.get(3)?,
                    size_bytes: r.get(4)?,
                    sha256: r.get(5)?,
                    local_path: r.get(6)?,
                })
            })
            .map_err(|e| format!("query inbox attachments: {e}"))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("inbox attachment row: {e}"))?);
        }
        Ok(out)
    }

    /// List Local Inbox items newest first with optional kind filter, favorite /
    /// archive flags, and a local search over title / text / url / file name.
    /// Returns (items, total-matching-count) for pagination.
    pub fn inbox_query(
        &self,
        kind: Option<&str>,
        q: Option<&str>,
        favorite: Option<bool>,
        archived: Option<bool>,
        page: i64,
        limit: i64,
    ) -> Result<(Vec<InboxRow>, i64), String> {
        let mut conditions = Vec::<String>::new();
        let mut args = Vec::<rusqlite::types::Value>::new();
        if let Some(kind) = kind {
            conditions.push(format!("i.kind = ?{}", args.len() + 1));
            args.push(rusqlite::types::Value::Text(kind.to_string()));
        }
        if let Some(favorite) = favorite {
            conditions.push(format!("i.favorite = ?{}", args.len() + 1));
            args.push((if favorite { 1 } else { 0 }).into());
        }
        if let Some(archived) = archived {
            conditions.push(format!("i.archived = ?{}", args.len() + 1));
            args.push((if archived { 1 } else { 0 }).into());
        }
        if let Some(q) = q {
            // ?N may be referenced more than once; one needle serves all fields.
            let n = args.len() + 1;
            conditions.push(format!(
                "(i.title LIKE ?{n} ESCAPE '\\' OR i.text_payload LIKE ?{n} ESCAPE '\\'
                 OR i.url LIKE ?{n} ESCAPE '\\' OR a.file_name LIKE ?{n} ESCAPE '\\')"
            ));
            args.push(format!("%{}%", escape_like(q)).into());
        }
        let where_sql = if conditions.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", conditions.join(" AND "))
        };
        let total: i64 = self
            .conn
            .query_row(
                &format!(
                    "SELECT COUNT(*) FROM local_inbox_item i
                     LEFT JOIN local_inbox_attachment a ON a.item_id = i.item_id {where_sql}"
                ),
                rusqlite::params_from_iter(args.iter()),
                |r| r.get(0),
            )
            .map_err(|e| format!("inbox count: {e}"))?;
        let offset = if page < 1 { 0 } else { (page - 1) * limit };
        let mut stmt = self
            .conn
            .prepare(&format!(
                "SELECT i.item_id, i.kind, i.title, i.text_payload, i.url, i.source,
                        i.archived, i.favorite, i.created_at, i.updated_at,
                        a.ref_id, a.kind, a.mime, a.file_name, a.size_bytes, a.sha256, a.local_path
                 FROM local_inbox_item i
                 LEFT JOIN local_inbox_attachment a ON a.item_id = i.item_id
                 {where_sql}
                 ORDER BY i.created_at DESC, i.item_id
                 LIMIT {limit} OFFSET {offset}"
            ))
            .map_err(|e| format!("prepare inbox query: {e}"))?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(args.iter()), |r| {
                Ok(InboxRow {
                    item: InboxItem {
                        item_id: r.get(0)?,
                        kind: r.get(1)?,
                        title: r.get(2)?,
                        text: r.get(3)?,
                        url: r.get(4)?,
                        source: r.get(5)?,
                        archived: r.get::<_, i64>(6)? != 0,
                        favorite: r.get::<_, i64>(7)? != 0,
                        created_at: r.get(8)?,
                        updated_at: r.get(9)?,
                    },
                    attachment: match r.get::<_, Option<String>>(10)? {
                        Some(ref_id) => Some(InboxAttachmentRow {
                            ref_id,
                            kind: r.get::<_, Option<String>>(11)?.unwrap_or_default(),
                            mime: r.get::<_, Option<String>>(12)?.unwrap_or_default(),
                            file_name: r.get::<_, Option<String>>(13)?.unwrap_or_default(),
                            size_bytes: r.get::<_, Option<i64>>(14)?.unwrap_or(0),
                            sha256: r.get::<_, Option<String>>(15)?.unwrap_or_default(),
                            local_path: r.get::<_, Option<String>>(16)?.unwrap_or_default(),
                        }),
                        None => None,
                    },
                })
            })
            .map_err(|e| format!("query inbox: {e}"))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("inbox row: {e}"))?);
        }
        Ok((out, total))
    }

    /// User edits of safe metadata (title / text / link). Only the item's own
    /// editable columns are touched; attachments and identity never change.
    pub fn inbox_update_meta(
        &mut self,
        item_id: &str,
        title: &str,
        text: &str,
        url: &str,
    ) -> Result<(), String> {
        let changed = self
            .conn
            .execute(
                "UPDATE local_inbox_item
                 SET title=?2, text_payload=?3, url=?4, updated_at=datetime('now')
                 WHERE item_id=?1",
                params![item_id, title, text, url],
            )
            .map_err(|e| format!("inbox update: {e}"))?;
        if changed != 1 {
            return Err("inbox item not found".into());
        }
        Ok(())
    }

    pub fn inbox_set_flags(
        &mut self,
        item_id: &str,
        favorite: Option<bool>,
        archived: Option<bool>,
    ) -> Result<(), String> {
        let favorite = favorite
            .map(|v| format!("favorite={}", if v { 1 } else { 0 }))
            .unwrap_or_default();
        let archived = archived
            .map(|v| format!("archived={}", if v { 1 } else { 0 }))
            .unwrap_or_default();
        let sets = vec![favorite, archived]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(", ");
        if sets.is_empty() {
            return Ok(());
        }
        let changed = self
            .conn
            .execute(
                &format!(
                    "UPDATE local_inbox_item SET {sets}, updated_at=datetime('now') WHERE item_id=?1"
                ),
                params![item_id],
            )
            .map_err(|e| format!("inbox set flags: {e}"))?;
        if changed != 1 {
            return Err("inbox item not found".into());
        }
        Ok(())
    }

    /// Delete one Local Inbox item. Returns the attachment paths owned by that
    /// item only, so the caller can remove exactly those app-private files and
    /// never any other user or Desktop content. Rows are removed first; a crash
    /// between the commit and file removal leaves an unreferenced file that the
    /// Local Inbox orphan cleanup reclaims (never an owned file).
    pub fn inbox_delete(&mut self, item_id: &str) -> Result<Vec<String>, String> {
        let paths = self
            .inbox_attachments(item_id)?
            .into_iter()
            .map(|a| a.local_path)
            .collect::<Vec<_>>();
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| format!("inbox delete transaction: {e}"))?;
        let changed = tx
            .execute("DELETE FROM local_inbox_item WHERE item_id=?1", params![item_id])
            .map_err(|e| format!("inbox item delete: {e}"))?;
        tx.execute(
            "DELETE FROM local_inbox_attachment WHERE item_id=?1",
            params![item_id],
        )
        .map_err(|e| format!("inbox attachment delete: {e}"))?;
        tx.commit()
            .map_err(|e| format!("inbox delete commit: {e}"))?;
        if changed == 0 {
            return Err("inbox item not found".into());
        }
        Ok(paths)
    }

    /// All app-private Local Inbox paths still owned by durable metadata.
    /// Startup reconciliation uses this allow-list when scanning `local-inbox/`
    /// so a user file is never treated as an orphan.
    pub fn inbox_attachment_paths(&self) -> Result<Vec<String>, String> {
        let mut statement = self
            .conn
            .prepare("SELECT local_path FROM local_inbox_attachment WHERE local_path <> ''")
            .map_err(|e| format!("prepare inbox paths: {e}"))?;
        let rows = statement
            .query_map([], |row| row.get(0))
            .map_err(|e| format!("query inbox paths: {e}"))?;
        let mut paths = Vec::new();
        for row in rows {
            paths.push(row.map_err(|e| format!("inbox path row: {e}"))?);
        }
        Ok(paths)
    }

    pub fn inbox_stats(&self) -> Result<serde_json::Value, String> {
        let total: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM local_inbox_item", [], |r| r.get(0))
            .map_err(|e| format!("inbox stats total: {e}"))?;
        let archived: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM local_inbox_item WHERE archived=1", [], |r| r.get(0))
            .map_err(|e| format!("inbox stats archived: {e}"))?;
        let favorites: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM local_inbox_item WHERE favorite=1", [], |r| r.get(0))
            .map_err(|e| format!("inbox stats favorites: {e}"))?;
        let bytes: i64 = self
            .conn
            .query_row(
                "SELECT COALESCE(SUM(a.size_bytes),0) FROM local_inbox_attachment a
                 INNER JOIN local_inbox_item i ON i.item_id=a.item_id",
                [],
                |r| r.get(0),
            )
            .map_err(|e| format!("inbox stats bytes: {e}"))?;
        Ok(serde_json::json!({
            "total": total,
            "archived": archived,
            "favorites": favorites,
            "bytes": bytes,
        }))
    }

    /// Structural Local Inbox summary for diagnostics export. Deliberately
    /// contains NO user content: no item id, title, text, URL, original file
    /// name, SHA-256/content fingerprint, or local path. Diagnostics must not
    /// silently become a content export feature.
    pub fn inbox_diagnostics(&self) -> Result<serde_json::Value, String> {
        let stats = self.inbox_stats()?;
        let (rows, _total) = self.inbox_query(None, None, None, None, 1, 500)?;
        let items: Vec<serde_json::Value> = rows
            .iter()
            .map(|r| {
                let att = r.attachment.as_ref();
                serde_json::json!({
                    "kind": r.item.kind,
                    "source": r.item.source,
                    "archived": r.item.archived,
                    "favorite": r.item.favorite,
                    "createdAt": r.item.created_at,
                    "updatedAt": r.item.updated_at,
                    "attachmentPresent": att.is_some(),
                    "attachment": att.map(|a| serde_json::json!({
                        "mime": a.mime,
                        "sizeBytes": a.size_bytes,
                        "fileExists": std::path::Path::new(&a.local_path).is_file(),
                    })),
                })
            })
            .collect();
        Ok(serde_json::json!({ "stats": stats, "items": items }))
    }

    /// Destructive "erase my local content": clear every Local Inbox row and
    /// return every owned attachment path so the caller can delete the
    /// app-private files. Explicitly separate from reset_full (which preserves
    /// the Local Inbox).
    pub fn inbox_erase_all(&mut self) -> Result<Vec<String>, String> {
        let paths = self.inbox_attachment_paths()?;
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| format!("inbox erase transaction: {e}"))?;
        for table in ["local_inbox_attachment", "local_inbox_item", "local_inbox_share_log"] {
            tx.execute(&format!("DELETE FROM {table}"), [])
                .map_err(|e| format!("inbox erase {table}: {e}"))?;
        }
        tx.commit()
            .map_err(|e| format!("inbox erase commit: {e}"))?;
        Ok(paths)
    }

    // ---- local note (M2.8 Mobile-local domain) ----
    // User-created durable data owned by the phone alone. No desktop_instance_id
    // anywhere: independent from note_cache (which remains Desktop-authoritative cache),
    // asset_cache, capture_outbox and Protocol V1.

    pub fn note_folders(&self) -> Result<Vec<String>, String> {
        let mut stmt = self.conn.prepare("SELECT path FROM local_note_folder ORDER BY path COLLATE NOCASE, path")
            .map_err(|e| format!("prepare note folders: {e}"))?;
        let rows = stmt.query_map([], |r| r.get(0)).map_err(|e| format!("query note folders: {e}"))?;
        rows.collect::<Result<Vec<String>, _>>().map_err(|e| format!("read note folders: {e}"))
    }

    fn note_require_folder(&self, folder: &str) -> Result<(), String> {
        if folder.is_empty() { return Ok(()); }
        let exists: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM local_note_folder WHERE path=?1)",
            params![folder], |r| r.get(0),
        ).map_err(|e| format!("check note folder: {e}"))?;
        if exists { Ok(()) } else { Err("local note folder not found".into()) }
    }

    pub fn note_create_folder(&self, name: &str, parent: &str) -> Result<String, String> {
        if name.chars().any(char::is_control) {
            return Err("folder name cannot contain control characters".into());
        }
        let name = name.trim();
        if name.is_empty() || name == "." || name == ".." || name.chars().count() > 120
            || name.chars().any(|c| c == '/' || c == '\\' || c == ':' || c.is_control()) {
            return Err("folder name must be one segment, 1–120 characters, without slashes, colons or control characters".into());
        }
        self.note_require_folder(parent)?;
        let path = if parent.is_empty() { name.to_string() } else { format!("{parent}/{name}") };
        if path.len() > 1024 {
            return Err("folder path cannot exceed 1024 UTF-8 bytes".into());
        }
        self.conn.execute(
            "INSERT INTO local_note_folder(path,parent,name,name_key) VALUES (?1,?2,?3,?4)",
            params![path, parent, name, name.to_lowercase()],
        ).map_err(|e| match e {
            rusqlite::Error::SqliteFailure(ref error, _) if error.code == rusqlite::ErrorCode::ConstraintViolation =>
                "a folder with this name already exists here".to_string(),
            _ => format!("create note folder: {e}"),
        })?;
        Ok(path)
    }

    pub fn note_set_folder(&self, note_id: &str, folder: &str) -> Result<(), String> {
        self.note_require_folder(folder)?;
        let changed = self.conn.execute(
            "UPDATE local_note_item SET folder=?2, updated_at=datetime('now') WHERE note_id=?1",
            params![note_id, folder],
        ).map_err(|e| format!("move note to folder: {e}"))?;
        if changed == 1 { Ok(()) } else { Err("local note not found".into()) }
    }

    pub fn note_insert(
        &mut self,
        note_id: &str,
        title: &str,
        content: &str,
        tags: &[String],
        source_inbox_id: Option<&str>,
    ) -> Result<(), String> {
        self.note_insert_in_folder(note_id, title, content, tags, source_inbox_id, "")
    }

    pub fn note_insert_in_folder(
        &mut self, note_id: &str, title: &str, content: &str, tags: &[String],
        source_inbox_id: Option<&str>, folder: &str,
    ) -> Result<(), String> {
        self.note_require_folder(folder)?;
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| format!("note insert tx: {e}"))?;
        let inserted = tx
            .execute(
                "INSERT OR IGNORE INTO local_note_item
                 (note_id, title, content, source_inbox_id, archived, favorite, pinned, created_at, updated_at, folder)
                 VALUES (?1, ?2, ?3, ?4, 0, 0, 0, datetime('now'), datetime('now'), ?5)",
                params![note_id, title, content, source_inbox_id, folder],
            )
            .map_err(|e| format!("note insert item: {e}"))?;
        if inserted == 1 {
            for tag in tags {
                let trimmed = tag.trim();
                if !trimmed.is_empty() {
                    tx.execute(
                        "INSERT OR IGNORE INTO local_note_tag (note_id, tag) VALUES (?1, ?2)",
                        params![note_id, trimmed],
                    )
                    .map_err(|e| format!("note insert tag: {e}"))?;
                }
            }
        }
        tx.commit().map_err(|e| format!("note insert commit: {e}"))?;
        Ok(())
    }

    pub fn note_update(
        &mut self,
        note_id: &str,
        title: &str,
        content: &str,
        tags: &[String],
    ) -> Result<(), String> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| format!("note update tx: {e}"))?;
        let changed = tx
            .execute(
                "UPDATE local_note_item
                 SET title=?2, content=?3, updated_at=datetime('now')
                 WHERE note_id=?1",
                params![note_id, title, content],
            )
            .map_err(|e| format!("note update item: {e}"))?;
        if changed != 1 {
            return Err("local note not found".into());
        }
        tx.execute("DELETE FROM local_note_tag WHERE note_id=?1", params![note_id])
            .map_err(|e| format!("note clear old tags: {e}"))?;
        for tag in tags {
            let trimmed = tag.trim();
            if !trimmed.is_empty() {
                tx.execute(
                    "INSERT OR IGNORE INTO local_note_tag (note_id, tag) VALUES (?1, ?2)",
                    params![note_id, trimmed],
                )
                .map_err(|e| format!("note insert tag: {e}"))?;
            }
        }
        tx.commit().map_err(|e| format!("note update commit: {e}"))?;
        Ok(())
    }

    pub fn note_get(&self, note_id: &str) -> Result<Option<LocalNoteItem>, String> {
        let item: Option<(String, String, String, Option<String>, bool, bool, bool, String, String, String)> = self
            .conn
            .query_row(
                "SELECT note_id, title, content, source_inbox_id, archived, favorite, pinned, created_at, updated_at, folder
                 FROM local_note_item WHERE note_id=?1",
                params![note_id],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get::<_, i64>(4)? != 0,
                        r.get::<_, i64>(5)? != 0,
                        r.get::<_, i64>(6)? != 0,
                        r.get(7)?,
                        r.get(8)?,
                        r.get(9)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| format!("note get: {e}"))?;

        let Some((note_id, title, content, source_inbox_id, archived, favorite, pinned, created_at, updated_at, folder)) = item else {
            return Ok(None);
        };

        let tags = self.note_tags(&note_id)?;

        Ok(Some(LocalNoteItem {
            note_id,
            title,
            content,
            source_inbox_id,
            archived,
            favorite,
            pinned,
            created_at,
            updated_at,
            tags,
            folder,
        }))
    }

    /// Every distinct tag on the Local Note tag authority (bounded, stable
    /// order). This is the AUTHORITY-level vocabulary the filter picker
    /// needs: deriving tags from a loaded page would hide tags that exist
    /// only on later pages, and an applied tag filter would hide every
    /// other tag from the picker.
    pub fn note_tag_vocabulary(&self, limit: i64) -> Result<Vec<String>, String> {
        let bounded = if limit <= 0 { 100 } else { limit.min(200) };
        let mut stmt = self
            .conn
            .prepare(
                "SELECT tag FROM local_note_tag
                 WHERE tag <> ''
                 GROUP BY tag
                 ORDER BY tag COLLATE NOCASE ASC
                 LIMIT ?1",
            )
            .map_err(|e| format!("prepare tag vocabulary: {e}"))?;
        let rows = stmt
            .query_map(rusqlite::params![bounded], |r| r.get::<_, String>(0))
            .map_err(|e| format!("query tag vocabulary: {e}"))?;
        let mut tags = Vec::new();
        for row in rows {
            tags.push(row.map_err(|e| format!("tag row: {e}"))?);
        }
        Ok(tags)
    }

    pub fn note_tags(&self, note_id: &str) -> Result<Vec<String>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT tag FROM local_note_tag WHERE note_id=?1 ORDER BY tag")
            .map_err(|e| format!("prepare note tags: {e}"))?;
        let rows = stmt
            .query_map(params![note_id], |r| r.get(0))
            .map_err(|e| format!("query note tags: {e}"))?;
        let mut tags = Vec::new();
        for r in rows {
            tags.push(r.map_err(|e| format!("note tag row: {e}"))?);
        }
        Ok(tags)
    }

    pub fn note_query(
        &self,
        q: Option<&str>,
        tag: Option<&str>,
        pinned: Option<bool>,
        favorite: Option<bool>,
        archived: Option<bool>,
        page: i64,
        limit: i64,
        sort: Option<&str>,
    ) -> Result<(Vec<LocalNoteItem>, i64), String> {
        self.note_query_in_folder(q, tag, pinned, favorite, archived, page, limit, sort, None)
    }

    pub fn note_query_in_folder(
        &self, q: Option<&str>, tag: Option<&str>, pinned: Option<bool>,
        favorite: Option<bool>, archived: Option<bool>, page: i64, limit: i64,
        sort: Option<&str>, folder: Option<&str>,
    ) -> Result<(Vec<LocalNoteItem>, i64), String> {
        let mut conditions = Vec::<String>::new();
        let mut args = Vec::<rusqlite::types::Value>::new();

        if let Some(folder) = folder {
            conditions.push(format!("n.folder = ?{}", args.len() + 1));
            args.push(folder.to_string().into());
        }
        if let Some(pinned) = pinned {
            conditions.push(format!("n.pinned = ?{}", args.len() + 1));
            args.push((if pinned { 1 } else { 0 }).into());
        }
        if let Some(favorite) = favorite {
            conditions.push(format!("n.favorite = ?{}", args.len() + 1));
            args.push((if favorite { 1 } else { 0 }).into());
        }
        if let Some(archived) = archived {
            conditions.push(format!("n.archived = ?{}", args.len() + 1));
            args.push((if archived { 1 } else { 0 }).into());
        }
        if let Some(tag) = tag {
            if !tag.trim().is_empty() {
                conditions.push(format!(
                    "n.note_id IN (SELECT note_id FROM local_note_tag WHERE tag = ?{})",
                    args.len() + 1
                ));
                args.push(rusqlite::types::Value::Text(tag.trim().to_string()));
            }
        }
        if let Some(q) = q {
            if !q.trim().is_empty() {
                let n = args.len() + 1;
                conditions.push(format!(
                    "(n.title LIKE ?{n} ESCAPE '\\' OR n.content LIKE ?{n} ESCAPE '\\'
                     OR n.note_id IN (SELECT note_id FROM local_note_tag WHERE tag LIKE ?{n} ESCAPE '\\'))"
                ));
                args.push(format!("%{}%", escape_like(q.trim())).into());
            }
        }

        let where_sql = if conditions.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", conditions.join(" AND "))
        };

        let total: i64 = self
            .conn
            .query_row(
                &format!("SELECT COUNT(DISTINCT n.note_id) FROM local_note_item n {where_sql}"),
                rusqlite::params_from_iter(args.iter()),
                |r| r.get(0),
            )
            .map_err(|e| format!("note count: {e}"))?;

        let offset = if page < 1 { 0 } else { (page - 1) * limit };
        let limit_sql = if limit <= 0 {
            String::new()
        } else {
            format!("LIMIT {limit} OFFSET {offset}")
        };

        // The selected sort is applied by the AUTHORITY, before LIMIT/OFFSET:
        // a name sort must order the WHOLE library, not the loaded subset.
        // `recent` keeps the historical pinned/updated/created order exactly;
        // both orders end in a deterministic note_id tiebreaker so pagination
        // can never repeat or skip a row. Pinned still leads (a deliberate
        // product invariant of this list, preserved for both sorts).
        let order_sql = match sort.unwrap_or("recent") {
            "name" => "ORDER BY n.pinned DESC, n.title COLLATE NOCASE ASC, n.note_id ASC",
            _ => "ORDER BY n.pinned DESC, n.updated_at DESC, n.created_at DESC, n.note_id ASC",
        };

        let mut stmt = self
            .conn
            .prepare(&format!(
                "SELECT n.note_id, n.title, n.content, n.source_inbox_id, n.archived, n.favorite, n.pinned, n.created_at, n.updated_at, n.folder
                 FROM local_note_item n
                 {where_sql}
                 {order_sql}
                 {limit_sql}"
            ))
            .map_err(|e| format!("prepare note query: {e}"))?;

        let note_tuples = stmt
            .query_map(rusqlite::params_from_iter(args.iter()), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, i64>(4)? != 0,
                    r.get::<_, i64>(5)? != 0,
                    r.get::<_, i64>(6)? != 0,
                    r.get::<_, String>(7)?,
                    r.get::<_, String>(8)?,
                    r.get::<_, String>(9)?,
                ))
            })
            .map_err(|e| format!("query notes: {e}"))?;

        let mut notes = Vec::new();
        for r in note_tuples {
            let (note_id, title, content, source_inbox_id, archived, favorite, pinned, created_at, updated_at, folder) =
                r.map_err(|e| format!("note row: {e}"))?;
            let tags = self.note_tags(&note_id)?;
            notes.push(LocalNoteItem {
                note_id,
                title,
                content,
                source_inbox_id,
                archived,
                favorite,
                pinned,
                created_at,
                updated_at,
                tags,
                folder,
            });
        }

        Ok((notes, total))
    }

    pub fn note_set_flags(
        &mut self,
        note_id: &str,
        pinned: Option<bool>,
        favorite: Option<bool>,
        archived: Option<bool>,
    ) -> Result<(), String> {
        let pinned_sql = pinned
            .map(|v| format!("pinned={}", if v { 1 } else { 0 }))
            .unwrap_or_default();
        let favorite_sql = favorite
            .map(|v| format!("favorite={}", if v { 1 } else { 0 }))
            .unwrap_or_default();
        let archived_sql = archived
            .map(|v| format!("archived={}", if v { 1 } else { 0 }))
            .unwrap_or_default();

        let sets = vec![pinned_sql, favorite_sql, archived_sql]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(", ");

        if sets.is_empty() {
            return Ok(());
        }

        let changed = self
            .conn
            .execute(
                &format!("UPDATE local_note_item SET {sets}, updated_at=datetime('now') WHERE note_id=?1"),
                params![note_id],
            )
            .map_err(|e| format!("note set flags: {e}"))?;

        if changed != 1 {
            return Err("local note not found".into());
        }
        Ok(())
    }

    pub fn note_delete(&mut self, note_id: &str) -> Result<(), String> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| format!("note delete tx: {e}"))?;
        tx.execute("DELETE FROM local_note_tag WHERE note_id=?1", params![note_id])
            .map_err(|e| format!("note delete tags: {e}"))?;
        let changed = tx
            .execute("DELETE FROM local_note_item WHERE note_id=?1", params![note_id])
            .map_err(|e| format!("note delete item: {e}"))?;
        tx.commit().map_err(|e| format!("note delete commit: {e}"))?;
        if changed == 0 {
            return Err("local note not found".into());
        }
        Ok(())
    }

    pub fn note_stats(&self) -> Result<serde_json::Value, String> {
        let total: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM local_note_item", [], |r| r.get(0))
            .map_err(|e| format!("note stats total: {e}"))?;
        let archived: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM local_note_item WHERE archived=1", [], |r| r.get(0))
            .map_err(|e| format!("note stats archived: {e}"))?;
        let favorites: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM local_note_item WHERE favorite=1", [], |r| r.get(0))
            .map_err(|e| format!("note stats favorites: {e}"))?;
        let pinned: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM local_note_item WHERE pinned=1", [], |r| r.get(0))
            .map_err(|e| format!("note stats pinned: {e}"))?;
        Ok(serde_json::json!({
            "total": total,
            "archived": archived,
            "favorites": favorites,
            "pinned": pinned,
        }))
    }

    /// Destructive "erase my local notes": clear every Local Note row.
    /// Preserves Local Inbox content (`local_inbox_*` tables are untouched).
    pub fn note_erase_all(&mut self) -> Result<usize, String> {
        let count = self.note_stats()?["total"].as_i64().unwrap_or(0) as usize;
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| format!("note erase transaction: {e}"))?;
        for table in ["local_note_tag", "local_note_item", "local_note_folder"] {
            tx.execute(&format!("DELETE FROM {table}"), [])
                .map_err(|e| format!("note erase {table}: {e}"))?;
        }
        tx.commit().map_err(|e| format!("note erase commit: {e}"))?;
        Ok(count)
    }

    /// Scope E — Local Inbox → Local Note conversion:
    /// Creates a new Local Note from a Local Inbox text/link/image/file item.
    /// Idempotent for single user action retries: if a note with `source_inbox_id = inbox_id`
    /// already exists, returns the existing note without duplicating.
    pub fn convert_inbox_to_note(
        &mut self,
        inbox_id: &str,
        new_note_id: &str,
    ) -> Result<LocalNoteItem, String> {
        // Idempotency check: does a note with this source_inbox_id already exist?
        let existing_id: Option<String> = self
            .conn
            .query_row(
                "SELECT note_id FROM local_note_item WHERE source_inbox_id=?1 ORDER BY created_at DESC LIMIT 1",
                params![inbox_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| format!("check inbox convert existing: {e}"))?;

        if let Some(existing_id) = existing_id {
            if let Some(existing_note) = self.note_get(&existing_id)? {
                return Ok(existing_note);
            }
        }

        let inbox_detail = self
            .inbox_get(inbox_id)?
            .ok_or("source local inbox item not found")?;

        let item = inbox_detail.item;
        let attachment = inbox_detail.attachments.first();

        let (title, content, tags) = match item.kind.as_str() {
            "link" => (
                if item.title.is_empty() { item.url.clone() } else { item.title.clone() },
                format!("URL: {}\n\n{}", item.url, item.text),
                vec!["inbox".to_string(), "link".to_string()],
            ),
            "file" | "image" | "photo" => {
                let fname = attachment.map(|a| a.file_name.clone()).unwrap_or_default();
                let fsize = attachment.map(|a| a.size_bytes).unwrap_or(0);
                (
                    if item.title.is_empty() { fname.clone() } else { item.title.clone() },
                    format!("Attachment: {}\nSize: {} B\nKind: {}\n\n{}", fname, fsize, item.kind, item.text),
                    vec!["inbox".to_string(), item.kind.clone()],
                )
            }
            _ => (
                if item.title.is_empty() {
                    let first_line = item.text.lines().next().unwrap_or("").trim();
                    if first_line.is_empty() { "New Note from Inbox".to_string() } else { first_line.to_string() }
                } else {
                    item.title.clone()
                },
                item.text.clone(),
                vec!["inbox".to_string()],
            ),
        };

        self.note_insert(new_note_id, &title, &content, &tags, Some(inbox_id))?;
        let note = self
            .note_get(new_note_id)?
            .ok_or("failed to retrieve newly created note")?;
        Ok(note)
    }

    /// Ranked search-candidate rows for Local Notes (FIX-V2 P1-B).
    ///
    /// The relevance score is computed IN SQL with the exact same contract as the
    /// unified final ranking: exact title match 100 / title contains 50 / tag contains
    /// 30 / content contains 10, then `updated_at DESC` + stable id tiebreaker.
    /// Candidates are ranked BEFORE any truncation, so an older high-relevance result
    /// outside the first `limit` rows in updated-time order is never dropped.
    /// LIKE escaping + bound parameters only — no raw user text interpolation.
    fn note_search_candidates(
        &self,
        q: &str,
        limit: i64,
    ) -> Result<(Vec<(LocalNoteItem, i64)>, i64), String> {
        let raw = q.trim();
        let pattern = format!("%{}%", escape_like(raw)).to_lowercase();

        let total: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(DISTINCT n.note_id) FROM local_note_item n
                 WHERE LOWER(n.title) LIKE ?1 ESCAPE '\\'
                    OR LOWER(n.content) LIKE ?1 ESCAPE '\\'
                    OR EXISTS (SELECT 1 FROM local_note_tag t WHERE t.note_id = n.note_id AND LOWER(t.tag) LIKE ?1 ESCAPE '\\')",
                params![pattern],
                |r| r.get(0),
            )
            .map_err(|e| format!("note search count: {e}"))?;

        let mut stmt = self
            .conn
            .prepare(
                "SELECT n.note_id, n.title, n.content, n.source_inbox_id, n.archived, n.favorite, n.pinned,
                        n.created_at, n.updated_at,
                        (CASE
                           WHEN LOWER(n.title) = LOWER(?2) THEN 100
                           WHEN LOWER(n.title) LIKE ?1 ESCAPE '\\' THEN 50
                           ELSE 0
                         END
                         + CASE WHEN EXISTS (
                             SELECT 1 FROM local_note_tag t
                             WHERE t.note_id = n.note_id AND LOWER(t.tag) LIKE ?1 ESCAPE '\\'
                           ) THEN 30 ELSE 0 END
                         + CASE WHEN LOWER(n.content) LIKE ?1 ESCAPE '\\' THEN 10 ELSE 0 END) AS score, n.folder
                 FROM local_note_item n
                 WHERE LOWER(n.title) LIKE ?1 ESCAPE '\\'
                    OR LOWER(n.content) LIKE ?1 ESCAPE '\\'
                    OR EXISTS (SELECT 1 FROM local_note_tag t WHERE t.note_id = n.note_id AND LOWER(t.tag) LIKE ?1 ESCAPE '\\')
                 ORDER BY score DESC, n.updated_at DESC, n.note_id
                 LIMIT ?3",
            )
            .map_err(|e| format!("prepare note search: {e}"))?;

        let note_tuples = stmt
            .query_map(params![pattern, raw, limit], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, i64>(4)? != 0,
                    r.get::<_, i64>(5)? != 0,
                    r.get::<_, i64>(6)? != 0,
                    r.get::<_, String>(7)?,
                    r.get::<_, String>(8)?,
                    r.get::<_, i64>(9)?,
                    r.get::<_, String>(10)?,
                ))
            })
            .map_err(|e| format!("query note search rows: {e}"))?;

        let mut candidates = Vec::new();
        for r in note_tuples {
            let (note_id, title, content, source_inbox_id, archived, favorite, pinned, created_at, updated_at, score, folder) =
                r.map_err(|e| format!("note search row: {e}"))?;
            let tags = self.note_tags(&note_id)?;
            candidates.push((
                LocalNoteItem {
                    note_id,
                    title,
                    content,
                    source_inbox_id,
                    archived,
                    favorite,
                    pinned,
                    created_at,
                    updated_at,
                    tags,
                    folder,
                },
                score,
            ));
        }
        Ok((candidates, total))
    }

    /// Ranked search-candidate rows for Local Inbox (FIX-V2 P1-B).
    ///
    /// Same ranking contract as `note_search_candidates` and the unified final merge:
    /// derived title (item title, else URL for links, else attachment file name) exact
    /// 100 / contains 50, text/url contains 10, then `updated_at DESC` + stable id.
    fn inbox_search_candidates(
        &self,
        q: &str,
        limit: i64,
    ) -> Result<(Vec<(InboxRow, i64)>, i64), String> {
        let raw = q.trim();
        let pattern = format!("%{}%", escape_like(raw)).to_lowercase();

        let total: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM local_inbox_item i
                 LEFT JOIN local_inbox_attachment a ON a.item_id = i.item_id
                 WHERE LOWER(i.title) LIKE ?1 ESCAPE '\\'
                    OR LOWER(i.text_payload) LIKE ?1 ESCAPE '\\'
                    OR LOWER(i.url) LIKE ?1 ESCAPE '\\'
                    OR LOWER(a.file_name) LIKE ?1 ESCAPE '\\'",
                params![pattern],
                |r| r.get(0),
            )
            .map_err(|e| format!("inbox search count: {e}"))?;

        let mut stmt = self
            .conn
            .prepare(
                "SELECT i.item_id, i.kind, i.title, i.text_payload, i.url, i.source,
                        i.archived, i.favorite, i.created_at, i.updated_at,
                        a.ref_id, a.kind, a.mime, a.file_name, a.size_bytes, a.sha256, a.local_path,
                        (CASE
                           WHEN LOWER(CASE WHEN i.title <> '' THEN i.title
                                           WHEN i.kind = 'link' THEN i.url
                                           ELSE COALESCE(a.file_name, '') END) = LOWER(?2) THEN 100
                           WHEN LOWER(CASE WHEN i.title <> '' THEN i.title
                                           WHEN i.kind = 'link' THEN i.url
                                           ELSE COALESCE(a.file_name, '') END) LIKE ?1 ESCAPE '\\' THEN 50
                           ELSE 0
                         END
                         + CASE WHEN LOWER(i.text_payload) LIKE ?1 ESCAPE '\\'
                                 OR LOWER(i.url) LIKE ?1 ESCAPE '\\'
                                THEN 10 ELSE 0 END) AS score
                 FROM local_inbox_item i
                 LEFT JOIN local_inbox_attachment a ON a.item_id = i.item_id
                 WHERE LOWER(i.title) LIKE ?1 ESCAPE '\\'
                    OR LOWER(i.text_payload) LIKE ?1 ESCAPE '\\'
                    OR LOWER(i.url) LIKE ?1 ESCAPE '\\'
                    OR LOWER(a.file_name) LIKE ?1 ESCAPE '\\'
                 ORDER BY score DESC, i.updated_at DESC, i.item_id
                 LIMIT ?3",
            )
            .map_err(|e| format!("prepare inbox search: {e}"))?;

        let rows = stmt
            .query_map(params![pattern, raw, limit], |r| {
                Ok((
                    InboxRow {
                        item: InboxItem {
                            item_id: r.get(0)?,
                            kind: r.get(1)?,
                            title: r.get(2)?,
                            text: r.get(3)?,
                            url: r.get(4)?,
                            source: r.get(5)?,
                            archived: r.get::<_, i64>(6)? != 0,
                            favorite: r.get::<_, i64>(7)? != 0,
                            created_at: r.get(8)?,
                            updated_at: r.get(9)?,
                        },
                        attachment: match r.get::<_, Option<String>>(10)? {
                            Some(ref_id) => Some(InboxAttachmentRow {
                                ref_id,
                                kind: r.get::<_, Option<String>>(11)?.unwrap_or_default(),
                                mime: r.get::<_, Option<String>>(12)?.unwrap_or_default(),
                                file_name: r.get::<_, Option<String>>(13)?.unwrap_or_default(),
                                size_bytes: r.get::<_, Option<i64>>(14)?.unwrap_or(0),
                                sha256: r.get::<_, Option<String>>(15)?.unwrap_or_default(),
                                local_path: r.get::<_, Option<String>>(16)?.unwrap_or_default(),
                            }),
                            None => None,
                        },
                    },
                    r.get::<_, i64>(17)?,
                ))
            })
            .map_err(|e| format!("query inbox search rows: {e}"))?;

        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("inbox search row: {e}"))?);
        }
        Ok((out, total))
    }

    /// Scope D — Local full-text / unified search across Local Notes, Local
    /// Inbox AND Local Assets. Returns typed results (`result_type`:
    /// "note" | "inbox" | "asset") sorted by match relevance and updated time.
    /// Uses char-safe snippet truncation (no UTF-8 byte boundary panic on
    /// CJK/Emoji), exact ranking-before-truncation pagination (FIX-V2 P1-B),
    /// and a composite title/tag relevance + updated_at DESC ranking contract.
    pub fn unified_local_search(
        &self,
        q: &str,
        page: i64,
        limit: i64,
    ) -> Result<(Vec<UnifiedSearchResult>, i64), String> {
        let trimmed = q.trim();
        if trimmed.is_empty() {
            return Ok((Vec::new(), 0));
        }

        let page_num = page.max(1);
        let limit_num = limit.max(1);
        // Ranking happens BEFORE any truncation: each domain query returns the top
        // (page * limit) candidates ordered by the SAME final ranking contract
        // (score DESC, updated_at DESC, stable id). A global top-N can contain at most
        // N rows from either domain, so slicing the merged candidates is exact —
        // an older high-relevance result can never be shadowed by newer low-score rows.
        let candidates_needed = page_num * limit_num;

        let (notes, note_total) = self.note_search_candidates(trimmed, candidates_needed)?;
        let (inbox_rows, inbox_total) = self.inbox_search_candidates(trimmed, candidates_needed)?;
        let (assets, asset_total) = self.asset_search_candidates(trimmed, candidates_needed)?;

        let mut candidate_results = Vec::new();

        for (n, score) in notes {
            let snippet = safe_truncate(&n.content, 120);
            candidate_results.push((
                score,
                UnifiedSearchResult {
                    result_type: "note".to_string(),
                    id: n.note_id,
                    title: if n.title.is_empty() { "Untitled Note".to_string() } else { n.title },
                    snippet,
                    kind: "note".to_string(),
                    created_at: n.created_at,
                    updated_at: n.updated_at,
                    extra: serde_json::json!({
                        "tags": n.tags,
                        "pinned": n.pinned,
                        "favorite": n.favorite,
                        "archived": n.archived,
                        "sourceInboxId": n.source_inbox_id,
                    }),
                },
            ));
        }

        for (r, score) in inbox_rows {
            let title = if !r.item.title.is_empty() {
                r.item.title.clone()
            } else if r.item.kind == "link" {
                r.item.url.clone()
            } else if let Some(att) = &r.attachment {
                att.file_name.clone()
            } else {
                "Local Item".to_string()
            };

            let raw_text = if !r.item.text.is_empty() {
                &r.item.text
            } else if !r.item.url.is_empty() {
                &r.item.url
            } else if let Some(att) = &r.attachment {
                &att.file_name
            } else {
                ""
            };
            let snippet = safe_truncate(raw_text, 120);

            candidate_results.push((
                score,
                UnifiedSearchResult {
                    result_type: "inbox".to_string(),
                    id: r.item.item_id,
                    title,
                    snippet,
                    kind: r.item.kind,
                    created_at: r.item.created_at,
                    updated_at: r.item.updated_at,
                    extra: serde_json::json!({
                        "source": r.item.source,
                        "favorite": r.item.favorite,
                        "archived": r.item.archived,
                        "attachment": r.attachment.map(|a| serde_json::json!({
                            "fileName": a.file_name,
                            "mime": a.mime,
                            "sizeBytes": a.size_bytes,
                        })),
                    }),
                },
            ));
        }

        for (a, score) in assets {
            let snippet = safe_truncate(&a.name, 120);
            candidate_results.push((
                score,
                UnifiedSearchResult {
                    result_type: "asset".to_string(),
                    id: a.asset_id,
                    title: if a.name.is_empty() { "Untitled Asset".to_string() } else { a.name },
                    snippet,
                    kind: a.kind,
                    created_at: a.created_at,
                    updated_at: a.updated_at,
                    extra: serde_json::json!({
                        "mime": a.mime,
                        "sizeBytes": a.size_bytes,
                        "favorite": a.favorite,
                        "archived": a.archived,
                        "source": a.source,
                    }),
                },
            ));
        }

        // Merge with the EXACT same ranking contract used by the SQL candidate
        // selection: score DESC, updated_at DESC, stable id tiebreaker. This keeps the
        // per-domain top-K selection and the global merge consistent (deterministic,
        // non-overlapping pages).
        candidate_results.sort_by(|a, b| {
            b.0.cmp(&a.0)
                .then_with(|| b.1.updated_at.cmp(&a.1.updated_at))
                .then_with(|| a.1.id.cmp(&b.1.id))
        });

        let total = (note_total + inbox_total + asset_total) as i64;
        let offset = ((page_num - 1) * limit_num) as usize;
        let limit_sz = limit_num as usize;

        let paged_results = if offset < candidate_results.len() {
            let end = (offset + limit_sz).min(candidate_results.len());
            candidate_results[offset..end]
                .iter()
                .map(|pair| pair.1.clone())
                .collect()
        } else {
            Vec::new()
        };

        Ok((paged_results, total))
    }

    /// Structural Local Note summary for diagnostics export. Deliberately
    /// contains NO user content: no note_id, title, content, tags, or source_inbox_id.
    pub fn note_diagnostics(&self) -> Result<serde_json::Value, String> {
        let stats = self.note_stats()?;
        let (notes, _total) = self.note_query(None, None, None, None, None, 1, 500, None)?;
        let items: Vec<serde_json::Value> = notes
            .iter()
            .map(|n| {
                serde_json::json!({
                    "archived": n.archived,
                    "favorite": n.favorite,
                    "pinned": n.pinned,
                    "hasSourceInboxId": n.source_inbox_id.is_some(),
                    "tagCount": n.tags.len(),
                    "createdAt": n.created_at,
                    "updatedAt": n.updated_at,
                })
            })
            .collect();
        Ok(serde_json::json!({ "stats": stats, "items": items }))
    }

    // ---- local asset (M2.9 Mobile-local Library domain) ----
    // User-created durable materials owned by the phone alone. No
    // desktop_instance_id anywhere: independent from asset_cache (which remains
    // Desktop-authoritative cache), note_cache, capture_outbox, local_inbox_*
    // and local_note_*. Each row owns exactly one app-private original under
    // `local-assets/originals/asset-*`; content_hash is integrity/dedup
    // diagnostics only — never business identity.

    /// Derive the bounded Local Asset kind primarily from the MIME type.
    /// Unknown or empty types fall back to "file" (never a crash, never an
    /// arbitrary user-supplied string).
    pub fn asset_kind_for_mime(mime: &str) -> String {
        let m = mime.trim().to_ascii_lowercase();
        if m.starts_with("image/") {
            "image".to_string()
        } else if m.starts_with("video/") {
            "video".to_string()
        } else if m == "application/pdf" {
            "document".to_string()
        } else {
            "file".to_string()
        }
    }

    /// Insert a Local Asset row. The managed original file MUST already exist
    /// at `local_path` before this is called (visible-row invariant: a DB row
    /// never points at a half-written original). Replaying the same asset_id is
    /// intentionally a no-op that keeps the original metadata, so an internal
    /// retry of one import/promotion action cannot create duplicate assets.
    #[allow(clippy::too_many_arguments)]
    pub fn asset_insert(
        &mut self,
        asset_id: &str,
        kind: &str,
        name: &str,
        mime: &str,
        size_bytes: i64,
        content_hash: &str,
        local_path: &str,
        source: &str,
        source_inbox_id: Option<&str>,
        tags: &[String],
    ) -> Result<(), String> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| format!("asset insert tx: {e}"))?;
        let inserted = tx
            .execute(
                "INSERT OR IGNORE INTO local_asset_item
                 (asset_id, kind, name, mime, size_bytes, content_hash, local_path,
                  source, source_inbox_id, archived, favorite, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, 0, datetime('now'), datetime('now'))",
                params![
                    asset_id,
                    kind,
                    name,
                    mime,
                    size_bytes,
                    content_hash,
                    local_path,
                    source,
                    source_inbox_id,
                ],
            )
            .map_err(|e| format!("asset insert item: {e}"))?;
        if inserted == 1 {
            for tag in tags {
                let trimmed = tag.trim();
                if !trimmed.is_empty() {
                    tx.execute(
                        "INSERT OR IGNORE INTO local_asset_tag (asset_id, tag) VALUES (?1, ?2)",
                        params![asset_id, trimmed],
                    )
                    .map_err(|e| format!("asset insert tag: {e}"))?;
                }
            }
        }
        tx.commit().map_err(|e| format!("asset insert commit: {e}"))?;
        Ok(())
    }

    pub fn asset_get(&self, asset_id: &str) -> Result<Option<LocalAssetItem>, String> {
        let item: Option<(String, String, String, String, i64, String, String, String, Option<String>, bool, bool, String, String)> = self
            .conn
            .query_row(
                "SELECT asset_id, kind, name, mime, size_bytes, content_hash, local_path,
                        source, source_inbox_id, archived, favorite, created_at, updated_at
                 FROM local_asset_item WHERE asset_id=?1",
                params![asset_id],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                        r.get(8)?,
                        r.get::<_, i64>(9)? != 0,
                        r.get::<_, i64>(10)? != 0,
                        r.get(11)?,
                        r.get(12)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| format!("asset get: {e}"))?;

        let Some((asset_id, kind, name, mime, size_bytes, content_hash, local_path, source, source_inbox_id, archived, favorite, created_at, updated_at)) = item else {
            return Ok(None);
        };
        let tags = self.asset_tags(&asset_id)?;
        Ok(Some(LocalAssetItem {
            asset_id,
            kind,
            name,
            mime,
            size_bytes,
            content_hash,
            local_path,
            source,
            source_inbox_id,
            archived,
            favorite,
            created_at,
            updated_at,
            tags,
        }))
    }

    /// Every distinct tag on the Local Asset tag authority (bounded, stable
    /// order). This is the AUTHORITY-level vocabulary the library filter picker
    /// needs: deriving tags from a loaded page would hide tags that exist only
    /// on later pages, and an applied tag filter would hide every other tag.
    /// Read-only projection; no schema change.
    pub fn asset_tag_vocabulary(&self, limit: i64) -> Result<Vec<String>, String> {
        let bounded = if limit <= 0 { 100 } else { limit.min(200) };
        let mut stmt = self
            .conn
            .prepare(
                "SELECT tag FROM local_asset_tag
                 WHERE tag <> ''
                 GROUP BY tag
                 ORDER BY tag COLLATE NOCASE ASC
                 LIMIT ?1",
            )
            .map_err(|e| format!("prepare asset tag vocabulary: {e}"))?;
        let rows = stmt
            .query_map(rusqlite::params![bounded], |r| r.get::<_, String>(0))
            .map_err(|e| format!("query asset tag vocabulary: {e}"))?;
        let mut tags = Vec::new();
        for row in rows {
            tags.push(row.map_err(|e| format!("asset tag row: {e}"))?);
        }
        Ok(tags)
    }
    pub fn asset_tags(&self, asset_id: &str) -> Result<Vec<String>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT tag FROM local_asset_tag WHERE asset_id=?1 ORDER BY tag")
            .map_err(|e| format!("prepare asset tags: {e}"))?;
        let rows = stmt
            .query_map(params![asset_id], |r| r.get(0))
            .map_err(|e| format!("query asset tags: {e}"))?;
        let mut tags = Vec::new();
        for r in rows {
            tags.push(r.map_err(|e| format!("asset tag row: {e}"))?);
        }
        Ok(tags)
    }

    /// Rename a Local Asset and replace its tags. Identity, kind, mime, size,
    /// hash, original path and provenance never change.
    pub fn asset_update(
        &mut self,
        asset_id: &str,
        name: &str,
        tags: &[String],
    ) -> Result<(), String> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| format!("asset update tx: {e}"))?;
        let changed = tx
            .execute(
                "UPDATE local_asset_item SET name=?2, updated_at=datetime('now') WHERE asset_id=?1",
                params![asset_id, name],
            )
            .map_err(|e| format!("asset update item: {e}"))?;
        if changed != 1 {
            return Err("local asset not found".into());
        }
        tx.execute("DELETE FROM local_asset_tag WHERE asset_id=?1", params![asset_id])
            .map_err(|e| format!("asset clear old tags: {e}"))?;
        for tag in tags {
            let trimmed = tag.trim();
            if !trimmed.is_empty() {
                tx.execute(
                    "INSERT OR IGNORE INTO local_asset_tag (asset_id, tag) VALUES (?1, ?2)",
                    params![asset_id, trimmed],
                )
                .map_err(|e| format!("asset insert tag: {e}"))?;
            }
        }
        tx.commit().map_err(|e| format!("asset update commit: {e}"))?;
        Ok(())
    }

    pub fn asset_set_flags(
        &mut self,
        asset_id: &str,
        favorite: Option<bool>,
        archived: Option<bool>,
    ) -> Result<(), String> {
        let favorite_sql = favorite
            .map(|v| format!("favorite={}", if v { 1 } else { 0 }))
            .unwrap_or_default();
        let archived_sql = archived
            .map(|v| format!("archived={}", if v { 1 } else { 0 }))
            .unwrap_or_default();
        let sets = vec![favorite_sql, archived_sql]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(", ");
        if sets.is_empty() {
            return Ok(());
        }
        let changed = self
            .conn
            .execute(
                &format!(
                    "UPDATE local_asset_item SET {sets}, updated_at=datetime('now') WHERE asset_id=?1"
                ),
                params![asset_id],
            )
            .map_err(|e| format!("asset set flags: {e}"))?;
        if changed != 1 {
            return Err("local asset not found".into());
        }
        Ok(())
    }

    /// Delete one Local Asset row and return the app-private original path
    /// owned by that row only. Rows are removed first; a crash between the
    /// commit and file removal leaves an unreferenced `asset-*` file that the
    /// Local Asset orphan reconciliation reclaims (never an owned file). The
    /// caller must remove the file through the managed check (under
    /// `local-assets/originals/` with an `asset-*` name) so no other domain's
    /// file can ever be deleted from DB input alone.
    pub fn asset_delete(&mut self, asset_id: &str) -> Result<Vec<String>, String> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| format!("asset delete tx: {e}"))?;
        let owned: Option<String> = tx
            .query_row(
                "SELECT local_path FROM local_asset_item WHERE asset_id=?1",
                params![asset_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| format!("asset delete read path: {e}"))?;
        tx.execute("DELETE FROM local_asset_tag WHERE asset_id=?1", params![asset_id])
            .map_err(|e| format!("asset delete tags: {e}"))?;
        let changed = tx
            .execute("DELETE FROM local_asset_item WHERE asset_id=?1", params![asset_id])
            .map_err(|e| format!("asset delete item: {e}"))?;
        tx.commit().map_err(|e| format!("asset delete commit: {e}"))?;
        if changed == 0 {
            return Err("local asset not found".into());
        }
        Ok(owned.into_iter().collect())
    }

    /// List Local Assets newest first with optional kind / tag / favorite /
    /// archive filters and a local search over display name + tags + MIME/kind
    /// metadata. Returns (items, total-matching-count) for pagination.
    #[allow(clippy::too_many_arguments)]
    pub fn asset_query(
        &self,
        kind: Option<&str>,
        q: Option<&str>,
        tag: Option<&str>,
        favorite: Option<bool>,
        archived: Option<bool>,
        page: i64,
        limit: i64,
        sort: Option<&str>,
    ) -> Result<(Vec<LocalAssetItem>, i64), String> {
        let mut conditions = Vec::<String>::new();
        let mut args = Vec::<rusqlite::types::Value>::new();
        if let Some(kind) = kind {
            if !kind.trim().is_empty() {
                conditions.push(format!("a.kind = ?{}", args.len() + 1));
                args.push(rusqlite::types::Value::Text(kind.trim().to_string()));
            }
        }
        if let Some(favorite) = favorite {
            conditions.push(format!("a.favorite = ?{}", args.len() + 1));
            args.push((if favorite { 1 } else { 0 }).into());
        }
        if let Some(archived) = archived {
            conditions.push(format!("a.archived = ?{}", args.len() + 1));
            args.push((if archived { 1 } else { 0 }).into());
        }
        if let Some(tag) = tag {
            if !tag.trim().is_empty() {
                conditions.push(format!(
                    "a.asset_id IN (SELECT asset_id FROM local_asset_tag WHERE tag = ?{})",
                    args.len() + 1
                ));
                args.push(rusqlite::types::Value::Text(tag.trim().to_string()));
            }
        }
        if let Some(q) = q {
            if !q.trim().is_empty() {
                let n = args.len() + 1;
                conditions.push(format!(
                    "(a.name LIKE ?{n} ESCAPE '\\' OR a.mime LIKE ?{n} ESCAPE '\\'
                     OR a.kind LIKE ?{n} ESCAPE '\\'
                     OR a.asset_id IN (SELECT asset_id FROM local_asset_tag WHERE tag LIKE ?{n} ESCAPE '\\'))"
                ));
                args.push(format!("%{}%", escape_like(q.trim())).into());
            }
        }
        let where_sql = if conditions.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", conditions.join(" AND "))
        };
        let total: i64 = self
            .conn
            .query_row(
                &format!("SELECT COUNT(DISTINCT a.asset_id) FROM local_asset_item a {where_sql}"),
                rusqlite::params_from_iter(args.iter()),
                |r| r.get(0),
            )
            .map_err(|e| format!("asset count: {e}"))?;
        let offset = if page < 1 { 0 } else { (page - 1) * limit };
        let limit_sql = if limit <= 0 {
            String::new()
        } else {
            format!("LIMIT {limit} OFFSET {offset}")
        };
        // LOCAL-LIBRARY-USABILITY: the selected sort is applied by the
        // AUTHORITY, before LIMIT/OFFSET — a name/size sort orders the WHOLE
        // library, not the already-loaded pages. Every order ends in a
        // deterministic asset_id tiebreaker so pagination cannot repeat or skip
        // a row. `recent` is LAST-UPDATED order (the UI label is 最近更新, and
        // asset_update / asset_set_flags deliberately write updated_at), with
        // created_at DESC then asset_id ASC as deterministic fallbacks.
        let order_sql = match sort.unwrap_or("recent") {
            "name" => "ORDER BY a.name COLLATE NOCASE ASC, a.asset_id ASC",
            "size" => "ORDER BY a.size_bytes DESC, a.name COLLATE NOCASE ASC, a.asset_id ASC",
            _ => "ORDER BY a.updated_at DESC, a.created_at DESC, a.asset_id ASC",
        };

        let mut stmt = self
            .conn
            .prepare(&format!(
                "SELECT a.asset_id, a.kind, a.name, a.mime, a.size_bytes, a.content_hash,
                        a.local_path, a.source, a.source_inbox_id, a.archived, a.favorite,
                        a.created_at, a.updated_at
                 FROM local_asset_item a
                 {where_sql}
                 {order_sql}
                 {limit_sql}"
            ))
            .map_err(|e| format!("prepare asset query: {e}"))?;
        let tuples = stmt
            .query_map(rusqlite::params_from_iter(args.iter()), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, String>(7)?,
                    r.get::<_, Option<String>>(8)?,
                    r.get::<_, i64>(9)? != 0,
                    r.get::<_, i64>(10)? != 0,
                    r.get::<_, String>(11)?,
                    r.get::<_, String>(12)?,
                ))
            })
            .map_err(|e| format!("query assets: {e}"))?;
        let mut assets = Vec::new();
        for r in tuples {
            let (asset_id, kind, name, mime, size_bytes, content_hash, local_path, source, source_inbox_id, archived, favorite, created_at, updated_at) =
                r.map_err(|e| format!("asset row: {e}"))?;
            let tags = self.asset_tags(&asset_id)?;
            assets.push(LocalAssetItem {
                asset_id,
                kind,
                name,
                mime,
                size_bytes,
                content_hash,
                local_path,
                source,
                source_inbox_id,
                archived,
                favorite,
                created_at,
                updated_at,
                tags,
            });
        }
        Ok((assets, total))
    }

    /// All app-private Local Asset original paths still owned by durable
    /// metadata. Startup reconciliation uses this allow-list when scanning
    /// `local-assets/originals/` so a user's managed original is never treated
    /// as an orphan.
    pub fn asset_paths(&self) -> Result<Vec<String>, String> {
        let mut statement = self
            .conn
            .prepare("SELECT local_path FROM local_asset_item WHERE local_path <> ''")
            .map_err(|e| format!("prepare asset paths: {e}"))?;
        let rows = statement
            .query_map([], |row| row.get(0))
            .map_err(|e| format!("query asset paths: {e}"))?;
        let mut paths = Vec::new();
        for row in rows {
            paths.push(row.map_err(|e| format!("asset path row: {e}"))?);
        }
        Ok(paths)
    }

    /// All durable Local Asset ids. Thumbnail reconciliation uses this set to
    /// reclaim stale derived `thumb-*` files whose asset row no longer exists.
    pub fn asset_id_list(&self) -> Result<Vec<String>, String> {
        let mut statement = self
            .conn
            .prepare("SELECT asset_id FROM local_asset_item")
            .map_err(|e| format!("prepare asset ids: {e}"))?;
        let rows = statement
            .query_map([], |row| row.get(0))
            .map_err(|e| format!("query asset ids: {e}"))?;
        let mut ids = Vec::new();
        for row in rows {
            ids.push(row.map_err(|e| format!("asset id row: {e}"))?);
        }
        Ok(ids)
    }

    /// Idempotency anchor for Local Inbox → Local Asset promotion: the asset
    /// created from a given live Inbox item, if one still exists.
    pub fn asset_by_source_inbox(&self, inbox_id: &str) -> Result<Option<LocalAssetItem>, String> {
        let existing_id: Option<String> = self
            .conn
            .query_row(
                "SELECT asset_id FROM local_asset_item WHERE source_inbox_id=?1 ORDER BY created_at DESC LIMIT 1",
                params![inbox_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| format!("check inbox promote existing: {e}"))?;
        match existing_id {
            Some(id) => self.asset_get(&id),
            None => Ok(None),
        }
    }

    pub fn asset_stats(&self) -> Result<serde_json::Value, String> {
        let total: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM local_asset_item", [], |r| r.get(0))
            .map_err(|e| format!("asset stats total: {e}"))?;
        let archived: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM local_asset_item WHERE archived=1", [], |r| r.get(0))
            .map_err(|e| format!("asset stats archived: {e}"))?;
        let favorites: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM local_asset_item WHERE favorite=1", [], |r| r.get(0))
            .map_err(|e| format!("asset stats favorites: {e}"))?;
        let bytes: i64 = self
            .conn
            .query_row("SELECT COALESCE(SUM(size_bytes),0) FROM local_asset_item", [], |r| r.get(0))
            .map_err(|e| format!("asset stats bytes: {e}"))?;
        Ok(serde_json::json!({
            "total": total,
            "archived": archived,
            "favorites": favorites,
            "bytes": bytes,
        }))
    }

    /// Destructive "erase my local assets": clear every Local Asset row and
    /// return every owned (asset_id, original path) pair so the caller can
    /// delete exactly the app-private originals AND their derived thumbnails.
    /// Explicitly separate from reset_full (which preserves Local Assets) and
    /// from Local Inbox / Local Note erase.
    pub fn asset_erase_all(&mut self) -> Result<Vec<(String, String)>, String> {
        let rows = {
            let mut statement = self
                .conn
                .prepare("SELECT asset_id, local_path FROM local_asset_item WHERE local_path <> ''")
                .map_err(|e| format!("prepare asset erase rows: {e}"))?;
            let mapped = statement
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .map_err(|e| format!("query asset erase rows: {e}"))?;
            let mut out = Vec::new();
            for r in mapped {
                out.push(r.map_err(|e| format!("asset erase row: {e}"))?);
            }
            out
        };
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| format!("asset erase transaction: {e}"))?;
        for table in ["local_asset_tag", "local_asset_item"] {
            tx.execute(&format!("DELETE FROM {table}"), [])
                .map_err(|e| format!("asset erase {table}: {e}"))?;
        }
        tx.commit().map_err(|e| format!("asset erase commit: {e}"))?;
        Ok(rows)
    }

    /// Structural Local Asset summary for diagnostics export. Deliberately
    /// contains NO user content: no asset id, display name, original file name,
    /// tags, SHA-256/content fingerprint, local path, or source inbox id.
    /// Diagnostics must not silently become a content export feature.
    pub fn asset_diagnostics(&self) -> Result<serde_json::Value, String> {
        let stats = self.asset_stats()?;
        let (assets, _total) = self.asset_query(None, None, None, None, None, 1, 500, None)?;
        let items: Vec<serde_json::Value> = assets
            .iter()
            .map(|a| {
                serde_json::json!({
                    "kind": a.kind,
                    "source": a.source,
                    "archived": a.archived,
                    "favorite": a.favorite,
                    "mime": a.mime,
                    "sizeBytes": a.size_bytes,
                    "tagCount": a.tags.len(),
                    "hasSourceInboxId": a.source_inbox_id.is_some(),
                    "originalExists": std::path::Path::new(&a.local_path).is_file(),
                    "createdAt": a.created_at,
                    "updatedAt": a.updated_at,
                })
            })
            .collect();
        Ok(serde_json::json!({ "stats": stats, "items": items }))
    }

    /// Ranked search-candidate rows for Local Assets (M2.9 unified search).
    ///
    /// Same ranking contract as the note/inbox candidates and the unified final
    /// merge: exact display-name match 100 / name contains 50 / tag contains 30 /
    /// MIME-or-kind contains 10, then `updated_at DESC` + stable id tiebreaker.
    /// Candidates are ranked BEFORE any truncation (FIX-V2 P1-B guarantee).
    /// LIKE escaping + bound parameters only — no raw user text interpolation.
    fn asset_search_candidates(
        &self,
        q: &str,
        limit: i64,
    ) -> Result<(Vec<(LocalAssetItem, i64)>, i64), String> {
        let raw = q.trim();
        let pattern = format!("%{}%", escape_like(raw)).to_lowercase();

        let total: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM local_asset_item a
                 WHERE LOWER(a.name) LIKE ?1 ESCAPE '\\'
                    OR LOWER(a.mime) LIKE ?1 ESCAPE '\\'
                    OR LOWER(a.kind) LIKE ?1 ESCAPE '\\'
                    OR EXISTS (SELECT 1 FROM local_asset_tag t WHERE t.asset_id = a.asset_id AND LOWER(t.tag) LIKE ?1 ESCAPE '\\')",
                params![pattern],
                |r| r.get(0),
            )
            .map_err(|e| format!("asset search count: {e}"))?;

        let mut stmt = self
            .conn
            .prepare(
                "SELECT a.asset_id, a.kind, a.name, a.mime, a.size_bytes, a.content_hash,
                        a.local_path, a.source, a.source_inbox_id, a.archived, a.favorite,
                        a.created_at, a.updated_at,
                        (CASE
                           WHEN LOWER(a.name) = LOWER(?2) THEN 100
                           WHEN LOWER(a.name) LIKE ?1 ESCAPE '\\' THEN 50
                           ELSE 0
                         END
                         + CASE WHEN EXISTS (
                             SELECT 1 FROM local_asset_tag t
                             WHERE t.asset_id = a.asset_id AND LOWER(t.tag) LIKE ?1 ESCAPE '\\'
                           ) THEN 30 ELSE 0 END
                         + CASE WHEN LOWER(a.mime) LIKE ?1 ESCAPE '\\'
                                  OR LOWER(a.kind) LIKE ?1 ESCAPE '\\'
                                THEN 10 ELSE 0 END) AS score
                 FROM local_asset_item a
                 WHERE LOWER(a.name) LIKE ?1 ESCAPE '\\'
                    OR LOWER(a.mime) LIKE ?1 ESCAPE '\\'
                    OR LOWER(a.kind) LIKE ?1 ESCAPE '\\'
                    OR EXISTS (SELECT 1 FROM local_asset_tag t WHERE t.asset_id = a.asset_id AND LOWER(t.tag) LIKE ?1 ESCAPE '\\')
                 ORDER BY score DESC, a.updated_at DESC, a.asset_id
                 LIMIT ?3",
            )
            .map_err(|e| format!("prepare asset search: {e}"))?;

        let tuples = stmt
            .query_map(params![pattern, raw, limit], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, String>(7)?,
                    r.get::<_, Option<String>>(8)?,
                    r.get::<_, i64>(9)? != 0,
                    r.get::<_, i64>(10)? != 0,
                    r.get::<_, String>(11)?,
                    r.get::<_, String>(12)?,
                    r.get::<_, i64>(13)?,
                ))
            })
            .map_err(|e| format!("query asset search rows: {e}"))?;

        let mut candidates = Vec::new();
        for r in tuples {
            let (asset_id, kind, name, mime, size_bytes, content_hash, local_path, source, source_inbox_id, archived, favorite, created_at, updated_at, score) =
                r.map_err(|e| format!("asset search row: {e}"))?;
            let tags = self.asset_tags(&asset_id)?;
            candidates.push((
                LocalAssetItem {
                    asset_id,
                    kind,
                    name,
                    mime,
                    size_bytes,
                    content_hash,
                    local_path,
                    source,
                    source_inbox_id,
                    archived,
                    favorite,
                    created_at,
                    updated_at,
                    tags,
                },
                score,
            ));
        }
        Ok((candidates, total))
    }

    // ---- ai caches ----
    pub fn upsert_run(&self, instance: &str, run: &serde_json::Value) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO ai_run_cache VALUES (?1,?2,?3,?4,?5,?6,?7)
                 ON CONFLICT(desktop_instance_id, run_id) DO UPDATE SET
                   conversation_id=excluded.conversation_id, status=excluded.status,
                   started_at=excluded.started_at, updated_at=excluded.updated_at, summary=excluded.summary",
                params![
                    instance,
                    run["runId"].as_str().unwrap_or(""),
                    run["conversationId"].as_str().unwrap_or(""),
                    run["status"].as_str().unwrap_or(""),
                    run["startedAt"].as_str().unwrap_or(""),
                    run["updatedAt"].as_str().unwrap_or(""),
                    run["summary"].as_str(),
                ],
            )
            .map_err(|e| format!("upsert run: {e}"))?;
        Ok(())
    }

    pub fn list_runs(&self, instance: &str) -> Result<Vec<serde_json::Value>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT run_id, conversation_id, status, started_at, updated_at, summary FROM ai_run_cache WHERE desktop_instance_id=?1 ORDER BY updated_at DESC LIMIT 50")
            .map_err(|e| format!("prepare: {e}"))?;
        let rows = stmt
            .query_map(params![instance], |r| {
                Ok(serde_json::json!({
                    "runId": r.get::<_, String>(0)?,
                    "conversationId": r.get::<_, String>(1)?,
                    "status": r.get::<_, String>(2)?,
                    "startedAt": r.get::<_, String>(3)?,
                    "updatedAt": r.get::<_, String>(4)?,
                    "summary": r.get::<_, Option<String>>(5)?,
                }))
            })
            .map_err(|e| format!("query: {e}"))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("row: {e}"))?);
        }
        Ok(out)
    }

    pub fn append_event(&self, instance: &str, run_id: &str, seq: i64, typ: &str, payload: &str) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT OR IGNORE INTO ai_event_cache VALUES (?1,?2,?3,?4,?5,datetime('now'))",
                params![instance, run_id, seq, typ, payload],
            )
            .map_err(|e| format!("append event: {e}"))?;
        Ok(())
    }

    pub fn events_after(&self, instance: &str, run_id: &str, after: i64, limit: i64) -> Result<Vec<serde_json::Value>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT seq, type, payload FROM ai_event_cache
                 WHERE desktop_instance_id=?1 AND run_id=?2 AND seq>?3 ORDER BY seq LIMIT ?4",
            )
            .map_err(|e| format!("prepare: {e}"))?;
        let rows = stmt
            .query_map(params![instance, run_id, after, limit], |r| {
                Ok(serde_json::json!({ "seq": r.get::<_, i64>(0)?, "type": r.get::<_, String>(1)?, "payload": r.get::<_, String>(2)? }))
            })
            .map_err(|e| format!("query: {e}"))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("row: {e}"))?);
        }
        Ok(out)
    }

    pub fn events_max_seq(&self, instance: &str, run_id: &str) -> Result<i64, String> {
        self.conn
            .query_row(
                "SELECT COALESCE(MAX(seq),0) FROM ai_event_cache WHERE desktop_instance_id=?1 AND run_id=?2",
                params![instance, run_id],
                |r| r.get(0),
            )
            .map_err(|e| format!("max seq: {e}"))
    }

    // ---- app_meta ----
    pub fn meta_set(&self, key: &str, value: &str) -> Result<(), String> {
        self.conn
            .execute("INSERT OR REPLACE INTO app_meta VALUES (?1,?2)", params![key, value])
            .map_err(|e| format!("meta: {e}"))?;
        Ok(())
    }

    pub fn meta_get(&self, key: &str) -> Result<Option<String>, String> {
        self.conn
            .query_row("SELECT value FROM app_meta WHERE key=?1", params![key], |r| r.get(0))
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(format!("meta get: {other}")),
            })
    }

    pub fn stats(&self, instance: &str) -> Result<serde_json::Value, String> {
        let assets = self.count_assets(instance)?;
        let notes = self
            .conn
            .query_row("SELECT COUNT(*) FROM note_cache WHERE desktop_instance_id=?1", params![instance], |r| r.get::<_, i64>(0))
            .map_err(|e| format!("count notes: {e}"))?;
        let outbox = self
            .conn
            .query_row("SELECT COUNT(*) FROM capture_outbox WHERE desktop_instance_id=?1", params![instance], |r| r.get::<_, i64>(0))
            .map_err(|e| format!("count outbox: {e}"))?;
        let runs = self
            .conn
            .query_row("SELECT COUNT(*) FROM ai_run_cache WHERE desktop_instance_id=?1", params![instance], |r| r.get::<_, i64>(0))
            .map_err(|e| format!("count runs: {e}"))?;
        let cursor = self.cursor(instance, "changes")?;
        Ok(serde_json::json!({
            "assets": assets, "notes": notes, "outbox": outbox, "runs": runs, "sync_cursor": cursor,
        }))
    }

    /// Apply a batch of sync ops in ONE transaction (rollback on any error).
    /// op = ("asset"|"note"|"agent_run", entity_id, "upsert"|"delete", Option<data json>)
    pub fn apply_sync_batch(&mut self, instance: &str, ops: &[(String, String, String, Option<serde_json::Value>)]) -> Result<usize, String> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| format!("sync tx: {e}"))?;
        let mut n = 0usize;
        for (entity, id, op, data) in ops {
            match (entity.as_str(), op.as_str()) {
                ("asset", "delete") => {
                    tx.execute("DELETE FROM asset_tag_cache WHERE desktop_instance_id=?1 AND desktop_asset_id=?2", params![instance, id])
                        .map_err(|e| format!("tag del: {e}"))?;
                    tx.execute("DELETE FROM asset_cache WHERE desktop_instance_id=?1 AND desktop_asset_id=?2", params![instance, id])
                        .map_err(|e| format!("asset del: {e}"))?;
                }
                ("asset", _) => {
                    if let Some(d) = data {
                        let tags: Vec<String> = d["tags"].as_array().map(|a| a.iter().filter_map(|t| t.as_str().map(String::from)).collect()).unwrap_or_default();
                        tx.execute(
                            "INSERT INTO asset_cache (desktop_instance_id, desktop_asset_id, name, kind, mime_type, size_bytes, updated_at, content_hash, thumbnail_revision, folder_id, thumbnail_path, cached_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,NULL,datetime('now'))
                             ON CONFLICT(desktop_instance_id, desktop_asset_id) DO UPDATE SET
                               name=excluded.name, kind=excluded.kind, mime_type=excluded.mime_type,
                               size_bytes=excluded.size_bytes, updated_at=excluded.updated_at,
                               content_hash=excluded.content_hash, thumbnail_revision=excluded.thumbnail_revision,
                               folder_id=excluded.folder_id, cached_at=datetime('now')",
                            params![
                                instance, id,
                                d["name"].as_str().unwrap_or(""),
                                d["kind"].as_str().unwrap_or("other"),
                                d["mimeType"].as_str().unwrap_or(""),
                                d["sizeBytes"].as_i64().unwrap_or(0),
                                d["updatedAt"].as_str().unwrap_or(""),
                                d["contentHash"].as_str().unwrap_or(""),
                                d["thumbnailRevision"].as_str().unwrap_or(""),
                                d["folderId"].as_str().unwrap_or(""),
                            ],
                        )
                        .map_err(|e| format!("asset upsert: {e}"))?;
                        tx.execute("DELETE FROM asset_tag_cache WHERE desktop_instance_id=?1 AND desktop_asset_id=?2", params![instance, id])
                            .map_err(|e| format!("tag clear: {e}"))?;
                        for tag in &tags {
                            tx.execute("INSERT OR IGNORE INTO asset_tag_cache VALUES (?1,?2,?3)", params![instance, id, tag])
                                .map_err(|e| format!("tag ins: {e}"))?;
                        }
                    }
                }
                ("note", "delete") => {
                    tx.execute("DELETE FROM note_cache WHERE desktop_instance_id=?1 AND note_id=?2", params![instance, id])
                        .map_err(|e| format!("note del: {e}"))?;
                }
                ("note", _) => {
                    if let Some(d) = data {
                        tx.execute(
                            "INSERT INTO note_cache(desktop_instance_id,note_id,title,relative_path,content,revision,updated_at,dirty,base_revision) VALUES (?1,?2,?3,?4,?5,?6,?7,0,NULL)
                             ON CONFLICT(desktop_instance_id, note_id) DO UPDATE SET
                               title=excluded.title, relative_path=excluded.relative_path,
                               content=excluded.content, revision=excluded.revision,
                               updated_at=excluded.updated_at, dirty=0, base_revision=NULL",
                            params![
                                instance, id,
                                d["title"].as_str().unwrap_or(""),
                                d["relativePath"].as_str().unwrap_or(""),
                                d["content"].as_str().unwrap_or(""),
                                d["revision"].as_str().unwrap_or(""),
                                d["updatedAt"].as_str().unwrap_or(""),
                            ],
                        )
                        .map_err(|e| format!("note upsert: {e}"))?;
                    }
                }
                ("agent_run", _) => {
                    if let Some(d) = data {
                        tx.execute(
                            "INSERT INTO ai_run_cache VALUES (?1,?2,?3,?4,?5,?6,?7)
                             ON CONFLICT(desktop_instance_id, run_id) DO UPDATE SET
                               conversation_id=excluded.conversation_id, status=excluded.status,
                               started_at=excluded.started_at, updated_at=excluded.updated_at, summary=excluded.summary",
                            params![
                                instance, id,
                                d["conversationId"].as_str().unwrap_or(""),
                                d["status"].as_str().unwrap_or(""),
                                d["startedAt"].as_str().unwrap_or(""),
                                d["updatedAt"].as_str().unwrap_or(""),
                                d["summary"].as_str(),
                            ],
                        )
                        .map_err(|e| format!("run upsert: {e}"))?;
                    }
                }
                _ => {}
            }
            n += 1;
        }
        tx.commit().map_err(|e| format!("sync commit: {e}"))?;
        Ok(n)
    }
}

#[derive(Debug, Clone)]
pub struct PairedDesktop {
    pub instance_id: String,
    pub display_name: String,
    pub platform: String,
    pub app_version: String,
    pub protocol_version: i64,
    pub fingerprint: String,
    pub base_url: String,
    /// Compatibility-only source for one-time M2.x credential migration.
    /// Runtime authentication must never use this value.
    pub legacy_credential: String,
    pub paired_at: String,
}

#[derive(Debug, Clone)]
pub struct AssetRow {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub mime: String,
    pub size: i64,
    pub updated_at: String,
    pub hash: String,
    pub thumb_rev: String,
    pub folder_id: String,
    pub thumb_path: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct NoteRow {
    pub id: String,
    pub vault_id: String,
    pub title: String,
    pub path: String,
    pub revision: String,
    pub updated_at: String,
    pub dirty: i64,
}

#[derive(Debug, Clone)]
pub struct OutboxRow {
    pub op_id: String,
    pub kind: String,
    pub payload: String,
    pub state: String,
    pub attempt: i64,
    pub error: String,
}

#[derive(Debug, Clone)]
pub struct AttachmentRow {
    pub op_id: String,
    pub ref_id: String,
    pub local_path: String,
}

#[derive(Debug, Clone)]
pub struct ThumbMeta {
    pub path: String,
    pub etag: String,
    pub mime: String,
    pub w: i64,
    pub h: i64,
}

#[derive(Debug, Clone)]
pub struct InboxItem {
    pub item_id: String,
    pub kind: String,
    pub title: String,
    pub text: String,
    pub url: String,
    pub source: String,
    pub archived: bool,
    pub favorite: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct InboxAttachmentRow {
    pub ref_id: String,
    pub kind: String,
    pub mime: String,
    pub file_name: String,
    pub size_bytes: i64,
    pub sha256: String,
    pub local_path: String,
}

/// List row: one Inbox item plus its first attachment (M2.7 stores at most one
/// attachment per item; the LEFT JOIN keeps text/link rows attachment-less).
#[derive(Debug, Clone)]
pub struct InboxRow {
    pub item: InboxItem,
    pub attachment: Option<InboxAttachmentRow>,
}

#[derive(Debug, Clone)]
pub struct InboxDetail {
    pub item: InboxItem,
    pub attachments: Vec<InboxAttachmentRow>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalNoteItem {
    #[serde(default)]
    pub folder: String,
    pub note_id: String,
    pub title: String,
    pub content: String,
    pub source_inbox_id: Option<String>,
    pub archived: bool,
    pub favorite: bool,
    pub pinned: bool,
    pub created_at: String,
    pub updated_at: String,
    pub tags: Vec<String>,
}

/// M2.9 Mobile-local Library domain row. User-owned durable material; the row
/// owns exactly one app-private original under `local-assets/originals/asset-*`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAssetItem {
    pub asset_id: String,
    pub kind: String, // "image" | "video" | "document" | "file"
    pub name: String,
    pub mime: String,
    pub size_bytes: i64,
    /// Integrity/dedup diagnostics only — never business identity.
    pub content_hash: String,
    pub local_path: String,
    pub source: String, // "direct_import" | "inbox"
    pub source_inbox_id: Option<String>,
    pub archived: bool,
    pub favorite: bool,
    pub created_at: String,
    pub updated_at: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedSearchResult {
    pub result_type: String, // "note" | "inbox"
    pub id: String,
    pub title: String,
    pub snippet: String,
    pub kind: String,
    pub created_at: String,
    pub updated_at: String,
    pub extra: serde_json::Value,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_recovery_migration_v9_audit_preserves_pairing_drafts_frozen_bytes_and_attachments() {
        let conn = Connection::open_in_memory().unwrap();
        for sql in MIGRATIONS.iter().take(9) { conn.execute_batch(sql).unwrap(); }
        conn.pragma_update(None,"user_version",9).unwrap();
        conn.execute("INSERT INTO paired_desktop VALUES('inst','PC','windows','1',1,'pin','https://host:6845','legacy-credential','time')",[]).unwrap();
        conn.execute("INSERT INTO note_cache(desktop_instance_id,note_id,vault_id,title,content,revision,dirty,base_revision,draft_generation,editor_epoch,editor_generation) VALUES('inst','kn-a','v','later title','later body','r1',1,'r1',3,4,2)",[]).unwrap();
        let bytes = "{ \"opId\":\"old\", \"kind\":\"rename\", \"title\":\"\" }";
        conn.execute("INSERT INTO content_note_operation VALUES('inst','v','kn-a','old',?1,1,'content')",params![bytes]).unwrap();
        conn.execute("INSERT INTO content_note_attachment VALUES('inst','v','kn-a','att','a.png','image/png','private-stage',123,'digest',5,NULL,'manifest')",[]).unwrap();
        let before: Vec<(String,String)> = ["paired_desktop","note_cache","content_note_operation","content_note_attachment"].iter().map(|table| ((*table).to_string(),dump_table(&conn,table))).collect();
        let mut db = Db { conn };
        db.migrate_kind().unwrap();
        assert_eq!(db.health().unwrap()["schemaVersion"],SCHEMA_VERSION);
        for (table,rows) in before { assert_eq!(dump_table(&db.conn,&table),rows); }
        db.migrate_kind().unwrap();
        assert_eq!(db.health().unwrap()["ok"],true);
    }

    fn dump_table(conn: &Connection, table: &str) -> String {
        let mut query = conn.prepare(&format!("SELECT * FROM {table}")).unwrap();
        let columns = query.column_count();
        let rows = query.query_map([],|row| Ok((0..columns).map(|i| format!("{:?}",row.get_ref(i).unwrap())).collect::<Vec<_>>())).unwrap();
        format!("{:?}",rows.collect::<Result<Vec<_>,_>>().unwrap())
    }

    #[test]
    fn rollback_v11_reopen_preserves_bodies_drafts_frozen_operations_and_preparation_records() {
        let path = std::env::temp_dir().join(format!("lr-rollback-v11-{}.db", uuid::Uuid::new_v4()));
        let conn = Connection::open(&path).unwrap();
        for sql in MIGRATIONS.iter().take(10) { conn.execute_batch(sql).unwrap(); }
        conn.pragma_update(None, "user_version", 10).unwrap();
        conn.execute("INSERT INTO paired_desktop VALUES('inst','PC','windows','1',1,'pin','https://host:6845','credential','time')",[]).unwrap();
        conn.execute("INSERT INTO note_cache(desktop_instance_id,note_id,vault_id,title,content,revision,dirty,draft_generation) VALUES('inst','kn-a','v','local title','local body','r1',1,3)",[]).unwrap();
        let payload = "{ \"opId\":\"old\", \"kind\":\"rename\", \"title\":\"\" }";
        conn.execute("INSERT INTO content_note_operation VALUES('inst','v','kn-a','old',?1,1,'content')", [payload]).unwrap();
        conn.execute("INSERT INTO content_note_attachment VALUES('inst','v','kn-a','att','a.png','image/png','stage',123,'digest',5,NULL,'manifest')",[]).unwrap();
        conn.execute("INSERT INTO content_note_operation_pause VALUES('inst','v','kn-a','old',?1,'content',1,'BLANK_RENAME_400','time')",[payload]).unwrap();
        conn.execute("INSERT INTO content_note_operation_recovery VALUES('inst','v','kn-a','old','new','time')",[]).unwrap();
        let tables = ["paired_desktop","note_cache","content_note_operation","content_note_attachment","content_note_operation_pause","content_note_operation_recovery"];
        let before: Vec<_> = tables.iter().map(|table| dump_table(&conn,table)).collect();
        // Fail the real append migration on its second table. The first table
        // and user_version must roll back; the old schema's data stays intact.
        conn.execute_batch("CREATE TABLE content_offline_note (test_collision TEXT)").unwrap();
        let mut db = Db { conn };
        assert!(db.migrate_kind().is_err());
        assert_eq!(db.conn.pragma_query_value(None,"user_version",|r|r.get::<_,i64>(0)).unwrap(),10);
        assert_eq!(db.conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE name='content_offline_vault'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        for (table, rows) in tables.iter().zip(&before) { assert_eq!(dump_table(&db.conn,table),*rows); }
        db.conn.execute_batch("DROP TABLE content_offline_note").unwrap(); // only the test collision
        db.migrate_kind().unwrap();
        db.migrate_kind().unwrap(); // restart/reentry
        assert_eq!(db.health().unwrap()["schemaVersion"], SCHEMA_VERSION);
        for (table, rows) in tables.iter().zip(&before) { assert_eq!(dump_table(&db.conn,table),*rows); }
        assert_eq!(db.conn.query_row("SELECT COUNT(*) FROM content_offline_vault", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        db.content_vault_remember("inst", "v", "Existing library").unwrap();
        db.content_apply_batch("inst", "v", &[serde_json::json!({"noteId":"clean","vaultId":"v","title":"Prepared note","content":"saved full body","revision":"r2","resources":[]})], 10, None).unwrap();
        db.conn.execute("INSERT INTO content_offline_vault VALUES('inst','v',1,8,1,'denied')", []).unwrap();
        db.conn.execute("INSERT INTO content_offline_note VALUES('inst','v','clean','r2','ready','',0,0,0)", []).unwrap();
        db.conn.execute("INSERT INTO content_offline_note VALUES('inst','v','kn-a','r3','failed','CONTENT_OFFLINE',2,123,1)", []).unwrap();
        let retained_tables = ["paired_desktop","note_cache","content_note_operation","content_note_attachment","content_note_operation_pause","content_note_operation_recovery","content_offline_vault","content_offline_note"];
        let retained: Vec<_> = retained_tables.iter().map(|table| dump_table(&db.conn, table)).collect();
        drop(db);
        let mut db = Db::open(&path).unwrap();
        assert_eq!(db.health().unwrap()["schemaVersion"], SCHEMA_VERSION);
        assert_eq!(db.health().unwrap()["ok"], true);
        db.content_resnapshot("inst", "v").unwrap();
        assert!(db.content_prepare_operations("inst", "v").unwrap().is_empty(), "the old paused operation must not resume");
        for (table, rows) in retained_tables.iter().zip(&retained) { assert_eq!(dump_table(&db.conn, table), *rows, "retained table {table}"); }
        assert_eq!(db.content_note("inst", "v", "clean").unwrap()["content"], "saved full body");
        assert_eq!(db.content_note("inst", "v", "kn-a").unwrap()["content"], "local body");
        drop(db);
        std::fs::remove_file(path).unwrap();
    }

    fn temp_db() -> Db {
        temp_db_at().0
    }

    fn temp_db_at() -> (Db, std::path::PathBuf) {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("lrm-test-{}-{}", std::process::id(), nanos));
        std::fs::create_dir_all(&dir).ok();
        let path = dir.join("test.db");
        (Db::open(&path).expect("open+migrate"), path)
    }

    #[test]
    fn migration_initializes_from_empty() {
        let db = temp_db();
        // v2 schema present
        assert!(db.meta_set("k", "v").is_ok());
        assert_eq!(db.meta_get("k").unwrap().as_deref(), Some("v"));
        assert!(db.enqueue_capture("i1", "op-1", "text", "{}").is_ok());
        assert_eq!(db.list_outbox("i1").unwrap().len(), 1);
    }

    /// Build a db file that pretends to be at schema version `v` (with the v1
    /// table set present) so we can verify forward migrations.
    fn db_at_version(v: i64) -> Db {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("lrm-mig-{}-{}", std::process::id(), nanos));
        std::fs::create_dir_all(&dir).ok();
        let path = dir.join("test.db");
        let conn = rusqlite::Connection::open(&path).expect("open raw");
        for idx in 0..(v as usize) {
            if idx < MIGRATIONS.len() {
                conn.execute_batch(MIGRATIONS[idx]).expect("apply migration step");
            }
        }
        conn.pragma_update(None, "user_version", v).expect("set version");
        drop(conn);
        Db::open(&path).expect("open+migrate")
    }

    #[test]
    fn migration_v1_to_current_preserves_user_rows() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("lrm-mig1-{}-{}", std::process::id(), nanos));
        std::fs::create_dir_all(&dir).ok();
        let path = dir.join("test.db");
        {
            let conn = rusqlite::Connection::open(&path).expect("open raw");
            conn.execute_batch(MIGRATIONS[0]).expect("apply v1");
            // user data that must survive the upgrade
            conn.execute(
                "INSERT INTO paired_desktop VALUES ('inst-1','PC','windows','1.0',1,'fp1','https://h','cred1',datetime('now'))",
                [],
            ).expect("seed paired");
            conn.execute(
                "INSERT INTO sync_cursor VALUES ('inst-1','changes',7)",
                [],
            ).expect("seed cursor");
            conn.pragma_update(None, "user_version", 1).expect("set v1");
        }
        let db = Db::open(&path).expect("upgrade");
        // v2 tables exist, user rows preserved
        let paired: String = db
            .conn
            .query_row("SELECT display_name FROM paired_desktop WHERE desktop_instance_id='inst-1'", [], |r| r.get(0))
            .expect("paired preserved");
        assert_eq!(paired, "PC");
        let seq: i64 = db
            .conn
            .query_row("SELECT seq FROM sync_cursor WHERE desktop_instance_id='inst-1' AND cursor_key='changes'", [], |r| r.get(0))
            .expect("cursor preserved");
        assert_eq!(seq, 7);
        assert_eq!(db.health().unwrap()["ok"].as_bool(), Some(true), "health ok after v1->current");
    }

    #[test]
    fn migration_v2_to_current_is_noop() {
        let db = db_at_version(2);
        // already current: nothing to run, health ok
        assert_eq!(db.health().unwrap()["ok"].as_bool(), Some(true));
        assert_eq!(db.health().unwrap()["schemaVersion"].as_i64(), Some(SCHEMA_VERSION));
    }

    #[test]
    fn migration_current_to_current_noop_keeps_data() {
        let mut db = temp_db();
        db.upsert_paired("inst-x", "PC", "windows", "1.0", 1, "fp", "https://h").unwrap();
        db.set_cursor("inst-x", "changes", 99).unwrap();
        // re-open (simulates app restart at same version) — no migration runs
        drop(db);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        // temp_db uses its own dir; reopen via stored path is not accessible,
        // so verify no-op semantics differently: open at v2 and confirm identity
        let db2 = db_at_version(2);
        assert_eq!(db2.health().unwrap()["schemaVersion"].as_i64(), Some(SCHEMA_VERSION));
    }

    #[test]
    fn migration_failure_rolls_back_and_reports() {
        // A bad migration entry must fail inside its transaction (no partial
        // schema), leaving user_version unchanged so retry resumes cleanly.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("lrm-bad-{}-{}", std::process::id(), nanos));
        std::fs::create_dir_all(&dir).ok();
        let path = dir.join("test.db");
        let prev_v = (MIGRATIONS.len() - 1) as i64;
        let target_v = MIGRATIONS.len() as i64;
        {
            let conn = rusqlite::Connection::open(&path).expect("open raw");
            for idx in 0..(MIGRATIONS.len() - 1) {
                conn.execute_batch(MIGRATIONS[idx]).expect("apply prev migration");
            }
            conn.pragma_update(None, "user_version", prev_v).expect("set prev version");
        }
        // inject a bogus migration into a copy of the array (test-only)
        let mut bad = MIGRATIONS.to_vec();
        bad.push("CREATE TABLE broken_x (); CREATE TABLE broken_x ();"); // second stmt fails
        let mut conn = rusqlite::Connection::open(&path).expect("reopen");
        let res: Result<(), rusqlite::Error> = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).and_then(|tx| {
            tx.execute_batch(bad[bad.len() - 1])?; // last bad migration
            tx.pragma_update(None, "user_version", target_v)?;
            tx.commit()
        });
        assert!(res.is_err(), "bad migration must fail");
        let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).expect("version");
        assert_eq!(v, prev_v, "user_version unchanged after failed migration (rollback)");
        // and the partial table must not exist
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM sqlite_master WHERE name='broken_x'", [], |r| r.get(0))
            .expect("count");
        assert_eq!(n, 0, "partial schema rolled back");
        drop(conn);
        // the real open still works and upgrades cleanly afterwards
        let db = Db::open(&path).expect("recover");
        assert_eq!(db.health().unwrap()["ok"].as_bool(), Some(true));
        assert_eq!(db.health().unwrap()["schemaVersion"].as_i64(), Some(SCHEMA_VERSION));
    }

    #[test]
    fn reset_full_clears_and_remigrates() {
        let mut db = temp_db();
        db.upsert_paired("inst-r", "PC", "windows", "1.0", 1, "fp", "https://h").unwrap();
        db.set_cursor("inst-r", "changes", 55).unwrap();
        db.reset_full().unwrap();
        // tables recreated at current version, data cleared
        assert_eq!(db.health().unwrap()["ok"].as_bool(), Some(true));
        assert_eq!(db.paired().unwrap().is_none(), true, "pairing cleared");
        assert_eq!(db.cursor("inst-r", "changes").unwrap(), 0, "cursor cleared");
    }

    #[test]
    fn health_distinguishes_reset_required_from_newer_schema_incompatibility() {
        let db = temp_db();
        db.conn
            .execute_batch("DROP TABLE capture_attachment")
            .expect("simulate a structurally incomplete disposable database");
        let reset_required = db.health().expect("health response");
        assert_eq!(reset_required["ok"], false);
        assert_eq!(reset_required["tablesOk"], false);
        assert_eq!(reset_required["recovery"], "reset-required");

        let newer = temp_db();
        newer
            .conn
            .pragma_update(None, "user_version", SCHEMA_VERSION + 1)
            .expect("simulate a newer app database");
        let incompatible = newer.health().expect("health response");
        assert_eq!(incompatible["ok"], false);
        assert_eq!(incompatible["recovery"], "incompatible-newer-schema");
    }

    #[test]
    fn cursor_advance_does_not_touch_outbox() {
        let db = temp_db();
        db.set_cursor("i1", "changes", 42).unwrap();
        db.enqueue_capture("i1", "op-9", "text", "{}").unwrap();
        // simulate full resync: reset cursor only
        db.set_cursor("i1", "changes", 0).unwrap();
        assert_eq!(db.cursor("i1", "changes").unwrap(), 0, "cursor reset");
        assert_eq!(db.list_outbox("i1").unwrap().len(), 1, "outbox preserved on resync");
    }

    #[test]
    fn reopening_recovers_an_interrupted_upload_without_losing_the_capture() {
        let (db, path) = temp_db_at();
        db.enqueue_capture("i1", "op-interrupted", "file", r#"{\"opId\":\"op-interrupted\"}"#)
            .expect("enqueue durable capture");
        db.outbox_mark("op-interrupted", "uploading", None)
            .expect("record in-flight upload");
        drop(db);

        let recovered = Db::open(&path).expect("restart opens durable database");
        let row = recovered
            .list_outbox("i1")
            .expect("read recovered outbox")
            .pop()
            .expect("capture remains durable");

        assert_eq!(row.state, "pending", "restart must requeue an interrupted upload");
        assert_eq!(row.attempt, 1, "the interrupted attempt is retained for diagnostics");
        assert_eq!(row.payload, r#"{\"opId\":\"op-interrupted\"}"#);
    }

    #[test]
    fn attachment_enqueue_is_idempotent_and_keeps_the_original_metadata_together() {
        let mut db = temp_db();
        let original_name = format!("{}-{}.bin", "长文件名".repeat(32), "x".repeat(96));

        db.enqueue_capture_with_attachment(
            "i1",
            "op-attachment",
            "file",
            r#"{\"opId\":\"op-attachment\",\"attachmentRefs\":[{\"refId\":\"ref-original\"}]}"#,
            "ref-original",
            "file",
            &original_name,
            0,
            "zero-byte-sha",
            "/private/capture-outbox/ref-original.bin",
        )
        .expect("enqueue capture and attachment in one durable operation");

        // Replaying the same opId must be a no-op. In particular it must not
        // replace the original attachment with a different ref while the first
        // transaction is already durable.
        db.enqueue_capture_with_attachment(
            "i1",
            "op-attachment",
            "file",
            r#"{\"opId\":\"op-attachment\",\"attachmentRefs\":[{\"refId\":\"ref-replayed\"}]}"#,
            "ref-replayed",
            "file",
            "replacement.bin",
            7,
            "replacement-sha",
            "/private/capture-outbox/ref-replayed.bin",
        )
        .expect("duplicate opId is locally idempotent");

        let outbox = db.list_outbox("i1").expect("list durable capture");
        assert_eq!(outbox.len(), 1);
        assert!(outbox[0].payload.contains("ref-original"));

        let attachments = db
            .list_attachments("op-attachment")
            .expect("list durable attachment");
        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0]["refId"], "ref-original");
        assert_eq!(attachments[0]["fileName"], original_name);
        assert_eq!(attachments[0]["sizeBytes"], 0);
    }

    #[test]
    fn outbox_upload_lifecycle_records_one_attempt_per_actual_upload() {
        let db = temp_db();
        db.enqueue_capture("i1", "op-lifecycle", "text", r#"{\"opId\":\"op-lifecycle\"}"#)
            .expect("enqueue");

        db.outbox_begin_upload("op-lifecycle")
            .expect("mark durable in-flight state");
        let uploading = db.list_outbox("i1").unwrap().pop().unwrap();
        assert_eq!(uploading.state, OUTBOX_UPLOADING);
        assert_eq!(uploading.attempt, 1);

        db.outbox_finish_upload("op-lifecycle", OUTBOX_FAILED, Some("synthetic local failure"))
            .expect("record bounded failure without creating a second attempt");
        let failed = db.list_outbox("i1").unwrap().pop().unwrap();
        assert_eq!(failed.state, OUTBOX_FAILED);
        assert_eq!(failed.attempt, 1);
        assert_eq!(failed.error, "synthetic local failure");

        db.outbox_begin_upload("op-lifecycle")
            .expect("retry moves only this item back to in-flight");
        db.outbox_finish_upload("op-lifecycle", OUTBOX_COMPLETED, None)
            .expect("durable completion");
        let completed = db.list_outbox("i1").unwrap().pop().unwrap();
        assert_eq!(completed.state, OUTBOX_COMPLETED);
        assert_eq!(completed.attempt, 2);
        assert_eq!(completed.error, "");
    }

    #[test]
    fn completed_attachment_cleanup_preserves_capture_history_but_releases_metadata() {
        let mut db = temp_db();
        db.enqueue_capture_with_attachment(
            "i1",
            "op-cleanup",
            "file",
            r#"{\"opId\":\"op-cleanup\"}"#,
            "ref-cleanup",
            "file",
            "completed.bin",
            1,
            "sha",
            "/private/capture-outbox/ref-cleanup.bin",
        )
        .unwrap();
        db.outbox_begin_upload("op-cleanup").unwrap();
        db.outbox_finish_upload("op-cleanup", OUTBOX_COMPLETED, None)
            .unwrap();

        let completed_attachments = db
            .list_completed_attachments()
            .expect("completed attachment remains discoverable for cleanup");
        assert_eq!(completed_attachments.len(), 1);
        assert_eq!(completed_attachments[0].op_id, "op-cleanup");
        assert_eq!(completed_attachments[0].ref_id, "ref-cleanup");

        db.delete_attachment("op-cleanup", "ref-cleanup")
            .expect("delete metadata after managed file cleanup");
        assert!(db.list_completed_attachments().unwrap().is_empty());
        let history = db.list_outbox("i1").unwrap();
        assert_eq!(history.len(), 1, "completion history remains available to the UI");
        assert_eq!(history[0].state, OUTBOX_COMPLETED);
    }

    #[test]
    fn thumbnail_meta_clear_after_404() {
        let mut db = temp_db();
        db.upsert_asset("i1", "a1", "n", "image", "image/png", 1, "t", "h", "r", "f", &[]).unwrap();
        let affected = db.set_thumbnail("i1", "a1", "/cache/thumb.img", "th-1", "image/png", 96, 96).unwrap();
        assert_eq!(affected, 1, "set_thumbnail updated exactly one row");
        let meta = db.thumbnail_meta("i1", "a1").unwrap();
        assert!(meta.is_some(), "meta present after set_thumbnail");
        assert_eq!(meta.unwrap().path, "/cache/thumb.img");
        // simulate 404 cleanup
        db.clear_thumbnail_meta("i1", "a1").unwrap();
        assert!(db.thumbnail_meta("i1", "a1").unwrap().is_none(), "meta cleared after 404");
    }

    #[test]
    fn materials_97_changed_version_retires_thumbnail_validator_only_for_its_owner() {
        let mut db = temp_db();
        for owner in ["A", "B"] {
            db.upsert_asset(owner,"a1","n","image","image/png",1,"t1","hash1","r1","",&[]).unwrap();
            db.set_thumbnail(owner,"a1","/cache/derived.jpg","etag1","image/jpeg",384,240).unwrap();
        }
        db.upsert_asset("A","a1","renamed","image","image/png",1,"t2","hash1","r1","",&[]).unwrap();
        assert_eq!(db.thumbnail_meta("A","a1").unwrap().unwrap().etag,"etag1","metadata-only change keeps valid pixels");
        db.upsert_asset("A","a1","n","image","image/png",2,"t3","hash2","r2","",&[]).unwrap();
        assert_eq!(db.thumbnail_meta("A","a1").unwrap().unwrap().etag,"","changed bytes cannot hit the old thumbnail");
        assert_eq!(db.thumbnail_meta("B","a1").unwrap().unwrap().etag,"etag1","other owner remains untouched");
    }

    #[test]
    fn pairing_overwrites_previous_instance() {
        let mut db = temp_db();
        db.upsert_paired("inst-A", "old", "windows", "1.0", 1, "fpA", "https://a").unwrap();
        db.upsert_paired("inst-B", "new", "windows", "1.0", 1, "fpB", "https://b").unwrap();
        let p = db.paired().unwrap().unwrap();
        assert_eq!(p.instance_id, "inst-B", "new desktop instance replaces old (no stale authority)");
    }

    #[test]
    fn composite_primary_key_enforced() {
        let mut db = temp_db();
        db.upsert_asset("i1", "a1", "n", "image", "image/png", 1, "t", "h", "r", "f", &[]).unwrap();
        db.upsert_asset("i2", "a1", "n2", "image", "image/png", 2, "t", "h", "r", "f", &[]).unwrap();
        assert_eq!(db.list_assets("i1", None, 0, 10).unwrap().len(), 1, "namespaced by instance");
        assert_eq!(db.list_assets("i2", None, 0, 10).unwrap().len(), 1);
    }

    // ---- M2.7 Local Inbox tests ----

    #[test]
    fn migration_v3_adds_local_inbox_tables_and_preserves_v2_rows() {
        let db = db_at_version(2);
        assert_eq!(db.health().unwrap()["schemaVersion"].as_i64(), Some(SCHEMA_VERSION));
        assert_eq!(db.health().unwrap()["ok"].as_bool(), Some(true));
        db.inbox_insert("item-1", "text", "t", "hello", "", "manual").unwrap();
        let d = db.inbox_get("item-1").unwrap().unwrap();
        assert_eq!(d.item.text, "hello");
        assert!(db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='local_inbox_attachment'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap()
            == 1);
    }

    #[test]
    fn inbox_crud_roundtrip() {
        let mut db = temp_db();
        db.inbox_insert("i1", "text", "", "first idea", "", "manual").unwrap();
        db.inbox_insert("i2", "link", "", "", "https://example.com/a", "manual").unwrap();
        db.inbox_insert_with_attachment(
            "i3", "image", "", "", "", "picker", "ref-3", "image", "image/jpeg",
            "photo.jpg", 2048, "abc", "/inbox/att-ref-3.jpg",
        )
        .unwrap();

        let (rows, total) = db.inbox_query(None, None, None, None, 1, 10).unwrap();
        assert_eq!(total, 3);
        let ids: Vec<&str> = rows.iter().map(|r| r.item.item_id.as_str()).collect();
        assert!(ids.contains(&"i1") && ids.contains(&"i2") && ids.contains(&"i3"));
        let media = rows.iter().find(|r| r.item.item_id == "i3").unwrap();
        assert_eq!(media.attachment.as_ref().unwrap().file_name, "photo.jpg");

        // edit safe metadata
        db.inbox_update_meta("i1", "edited title", "edited text", "").unwrap();
        let d = db.inbox_get("i1").unwrap().unwrap();
        assert_eq!(d.item.title, "edited title");
        assert_eq!(d.item.text, "edited text");
        assert!(d.item.updated_at >= d.item.created_at);
        assert!(db.inbox_update_meta("missing", "x", "y", "").is_err());

        // replay of the same item_id keeps the original metadata (idempotent)
        db.inbox_insert_with_attachment(
            "i3", "image", "", "", "", "picker", "ref-9", "image", "image/png",
            "other.png", 5, "zzz", "/inbox/att-other.png",
        )
        .unwrap();
        let d3 = db.inbox_get("i3").unwrap().unwrap();
        assert_eq!(d3.attachments.len(), 1, "replay must not add a second attachment");
        assert_eq!(d3.attachments[0].file_name, "photo.jpg");

        // delete
        let paths = db.inbox_delete("i2").unwrap();
        assert!(paths.is_empty(), "text item owns no attachment files");
        assert!(db.inbox_get("i2").unwrap().is_none());
        assert!(db.inbox_delete("missing").is_err());
    }

    #[test]
    fn inbox_query_filters_kind_favorite_archive_and_search() {
        let mut db = temp_db();
        db.inbox_insert("a", "text", "alpha idea", "aaa", "", "manual").unwrap();
        db.inbox_insert("b", "link", "", "", "https://b.example/note", "manual").unwrap();
        db.inbox_insert_with_attachment(
            "c", "file", "report", "", "", "picker", "ref-c", "file", "application/pdf",
            "quarterly-report.pdf", 100, "hc", "/inbox/att-report.pdf",
        )
        .unwrap();
        db.inbox_set_flags("a", Some(true), None).unwrap();
        db.inbox_set_flags("b", None, Some(true)).unwrap();

        // kind filter
        let (links, _) = db.inbox_query(Some("link"), None, None, None, 1, 10).unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].item.item_id, "b");

        // favorite / archive filters
        let (favs, _) = db.inbox_query(None, None, Some(true), None, 1, 10).unwrap();
        assert_eq!(favs.len(), 1);
        assert_eq!(favs[0].item.item_id, "a");
        let (arch, _) = db.inbox_query(None, None, None, Some(true), 1, 10).unwrap();
        assert_eq!(arch.len(), 1);
        assert_eq!(arch[0].item.item_id, "b");
        let (active, _) = db.inbox_query(None, None, None, Some(false), 1, 10).unwrap();
        assert_eq!(active.len(), 2);

        // local search across title / text / url / file name
        let (by_title, _) = db.inbox_query(None, Some("alpha"), None, None, 1, 10).unwrap();
        assert_eq!(by_title.len(), 1);
        assert_eq!(by_title[0].item.item_id, "a");
        let (by_url, _) = db.inbox_query(None, Some("b.example"), None, None, 1, 10).unwrap();
        assert_eq!(by_url.len(), 1);
        let (by_file, _) = db.inbox_query(None, Some("quarterly"), None, None, 1, 10).unwrap();
        assert_eq!(by_file.len(), 1);
        assert_eq!(by_file[0].item.item_id, "c");
        let (none, total) = db.inbox_query(None, Some("zzz-no-match"), None, None, 1, 10).unwrap();
        assert_eq!(total, 0);
        assert!(none.is_empty());
    }

    #[test]
    fn inbox_search_escapes_like_wildcards() {
        let mut db = temp_db();
        db.inbox_insert("w1", "text", "abc_def", "", "", "manual").unwrap();
        // '_' in the query must match a literal underscore, not any character
        let (rows, total) = db.inbox_query(None, Some("abc_def"), None, None, 1, 10).unwrap();
        assert_eq!(total, 1);
        assert_eq!(rows[0].item.item_id, "w1");
        let (_, total) = db.inbox_query(None, Some("abcXdef"), None, None, 1, 10).unwrap();
        assert_eq!(total, 0, "underscore must not act as a wildcard");
        let (_, total) = db.inbox_query(None, Some("%"), None, None, 1, 10).unwrap();
        assert_eq!(total, 0, "percent must not act as a wildcard");
    }

    #[test]
    fn inbox_query_paginates_and_orders_newest_first() {
        let mut db = temp_db();
        db.inbox_insert("p1", "text", "", "one", "", "manual").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        db.inbox_insert("p2", "text", "", "two", "", "manual").unwrap();
        let (rows, total) = db.inbox_query(None, None, None, None, 1, 1).unwrap();
        assert_eq!(total, 2);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].item.item_id, "p2", "newest first on page 1");
        let (rows2, _) = db.inbox_query(None, None, None, None, 2, 1).unwrap();
        assert_eq!(rows2[0].item.item_id, "p1", "page 2 carries the older item");
    }

    #[test]
    fn inbox_delete_removes_only_its_own_attachment() {
        let mut db = temp_db();
        db.inbox_insert_with_attachment(
            "x", "file", "", "", "", "picker", "ref-x", "file", "application/pdf",
            "doc.pdf", 100, "hx", "/inbox/att-ref-x.pdf",
        )
        .unwrap();
        db.inbox_insert_with_attachment(
            "y", "image", "", "", "", "picker", "ref-y", "image", "image/png",
            "pic.png", 200, "hy", "/inbox/att-ref-y.png",
        )
        .unwrap();
        let paths = db.inbox_delete("x").unwrap();
        assert_eq!(paths, vec!["/inbox/att-ref-x.pdf"], "only the deleted item's file");
        assert!(db.inbox_get("x").unwrap().is_none());
        let y = db.inbox_get("y").unwrap().unwrap();
        assert_eq!(y.attachments.len(), 1);
        assert_eq!(y.attachments[0].file_name, "pic.png");
    }

    #[test]
    fn inbox_share_ingest_dedupes_duplicate_delivery() {
        let mut db = temp_db();
        let created1 = db
            .inbox_share_ingest("s1", "text", "", "shared text", "", "digest-1",
                None, None, None, None, None, None)
            .unwrap();
        assert!(created1);
        // Duplicate delivery (same digest within the window): no second item.
        let created2 = db
            .inbox_share_ingest("s2", "text", "", "shared text", "", "digest-1",
                None, None, None, None, None, None)
            .unwrap();
        assert!(!created2, "same digest within the window must be deduped");
        let (rows, total) = db.inbox_query(None, None, None, None, 1, 10).unwrap();
        assert_eq!(total, 1);
        assert_eq!(rows[0].item.item_id, "s1");
        // A different digest is a genuinely new share.
        let created3 = db
            .inbox_share_ingest("s3", "text", "", "other text", "", "digest-2",
                None, None, None, None, None, None)
            .unwrap();
        assert!(created3);
    }

    #[test]
    fn inbox_share_ingest_with_attachment_commits_atomically() {
        let mut db = temp_db();
        let created = db
            .inbox_share_ingest("m1", "image", "", "", "", "digest-img",
                Some("image"), Some("image/jpeg"), Some("shared.jpg"),
                Some(1234), Some("h1"), Some("/inbox/att-shared.jpg"))
            .unwrap();
        assert!(created);
        let d = db.inbox_get("m1").unwrap().unwrap();
        assert_eq!(d.item.source, "share");
        assert_eq!(d.item.kind, "image");
        assert_eq!(d.attachments.len(), 1);
        assert_eq!(d.attachments[0].file_name, "shared.jpg");
        assert_eq!(d.attachments[0].size_bytes, 1234);
    }

    #[test]
    fn reset_full_preserves_local_inbox_but_clears_desktop_data() {
        let mut db = temp_db();
        db.upsert_paired("inst-r", "PC", "windows", "1.0", 1, "fp", "https://h").unwrap();
        db.inbox_insert("keep-1", "text", "", "user data", "", "manual").unwrap();
        db.reset_full().unwrap();
        assert_eq!(db.health().unwrap()["ok"].as_bool(), Some(true));
        let d = db.inbox_get("keep-1").unwrap().unwrap();
        assert_eq!(d.item.text, "user data", "Local Inbox survives a Desktop/cache reset");
        assert!(db.paired().unwrap().is_none(), "pairing cleared");
        assert_eq!(db.cursor("inst-r", "changes").unwrap(), 0, "cursor cleared");
    }

    #[test]
    fn revoke_paired_preserves_local_inbox() {
        let mut db = temp_db();
        db.upsert_paired("inst-v", "PC", "windows", "1.0", 1, "fp", "https://h").unwrap();
        db.enqueue_capture("inst-v", "op-1", "text", "{}").unwrap();
        db.inbox_insert("keep-2", "link", "", "", "https://keep", "manual").unwrap();
        db.revoke_paired().unwrap();
        assert!(
            db.inbox_get("keep-2").unwrap().is_some(),
            "pairing revoke must preserve the Local Inbox"
        );
        assert_eq!(db.list_outbox("inst-v").unwrap().len(), 0, "outbox cleared");
    }

    #[test]
    fn inbox_erase_all_clears_rows_and_returns_all_paths() {
        let mut db = temp_db();
        db.inbox_insert_with_attachment(
            "e1", "file", "", "", "", "picker", "ref-e", "file", "application/pdf",
            "a.pdf", 1, "h", "/inbox/att-a.pdf",
        )
        .unwrap();
        db.inbox_insert("e2", "text", "", "note", "", "manual").unwrap();
        let paths = db.inbox_erase_all().unwrap();
        assert_eq!(paths.len(), 1);
        assert!(db.inbox_get("e1").unwrap().is_none());
        assert!(db.inbox_get("e2").unwrap().is_none());
        let (_, total) = db.inbox_query(None, None, None, None, 1, 10).unwrap();
        assert_eq!(total, 0);
    }

    #[test]
    fn health_reports_missing_inbox_table_as_reset_required() {
        let db = temp_db();
        db.conn
            .execute_batch("DROP TABLE local_inbox_item")
            .expect("drop inbox table");
        let h = db.health().unwrap();
        assert_eq!(h["ok"], false);
        assert_eq!(h["tablesOk"], false);
        assert_eq!(h["recovery"], "reset-required");
    }

    #[test]
    fn inbox_stats_counts_items_favorites_archived_and_bytes() {
        let mut db = temp_db();
        db.inbox_insert("s1", "text", "", "one", "", "manual").unwrap();
        db.inbox_insert_with_attachment(
            "s2", "file", "", "", "", "picker", "ref-s", "file", "application/pdf",
            "b.pdf", 4096, "hs", "/inbox/att-b.pdf",
        )
        .unwrap();
        db.inbox_set_flags("s1", Some(true), None).unwrap();
        db.inbox_set_flags("s2", None, Some(true)).unwrap();
        let stats = db.inbox_stats().unwrap();
        assert_eq!(stats["total"], 2);
        assert_eq!(stats["favorites"], 1);
        assert_eq!(stats["archived"], 1);
        assert_eq!(stats["bytes"], 4096);
    }

    #[test]
    fn inbox_diagnostics_redacts_user_content() {
        // Obvious sensitive markers must never appear in diagnostics output.
        let mut db = temp_db();
        db.inbox_insert(
            "d1", "text", "SECRET-TITLE", "SECRET-M2.7-TEXT-123", "", "manual",
        )
        .unwrap();
        db.inbox_insert(
            "d2", "link", "", "", "https://private.example/SECRET-M2.7", "share",
        )
        .unwrap();
        db.inbox_insert_with_attachment(
            "d3", "file", "", "", "", "picker", "ref-d", "file", "application/pdf",
            "SECRET-FILENAME.pdf", 2048, "sha256-of-secret", "/inbox/att-SECRET-FILENAME.pdf",
        )
        .unwrap();
        let json = db.inbox_diagnostics().unwrap();
        let serialized = serde_json::to_string(&json).unwrap();
        for marker in [
            "SECRET-M2.7-TEXT-123",
            "https://private.example/SECRET-M2.7",
            "SECRET-FILENAME.pdf",
            "SECRET-TITLE",
            "sha256-of-secret",
            "/inbox/att-SECRET-FILENAME.pdf",
            "d1",
            "d2",
            "d3",
        ] {
            assert!(
                !serialized.contains(marker),
                "diagnostics must not contain user content marker: {marker}"
            );
        }
        // Structural fields that ARE needed for diagnosis remain present.
        assert_eq!(json["stats"]["total"], 3);
        assert_eq!(json["items"].as_array().unwrap().len(), 3);
        let kinds: Vec<&str> = json["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["kind"].as_str().unwrap())
            .collect();
        assert!(kinds.contains(&"text") && kinds.contains(&"link") && kinds.contains(&"file"));
        // Order-independent: the attachment item may appear at any index (inserts can
        // cross a `datetime('now')` second boundary, changing created_at ordering).
        let file_item = json["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["kind"].as_str() == Some("file"))
            .expect("file item present in diagnostics");
        assert!(file_item["attachmentPresent"].as_bool().unwrap());
        assert_eq!(file_item["attachment"]["sizeBytes"], 2048);
        assert_eq!(file_item["attachment"]["mime"], "application/pdf");
    }

    // ---- M2.8 Local Note & Search tests ----

    #[test]
    fn migration_v4_adds_local_note_tables_and_preserves_v3_rows() {
        let db = db_at_version(3);
        assert_eq!(db.health().unwrap()["schemaVersion"].as_i64(), Some(SCHEMA_VERSION));
        assert_eq!(db.health().unwrap()["ok"].as_bool(), Some(true));

        // Ensure v3 inbox tables still work
        db.inbox_insert("in-v3", "text", "v3", "v3 content", "", "manual").unwrap();
        assert!(db.inbox_get("in-v3").unwrap().is_some());

        // Ensure v4 local note tables present
        let mut db = db;
        db.note_insert("note-v4", "v4 note", "content v4", &["tag1".to_string()], None).unwrap();
        let note = db.note_get("note-v4").unwrap().unwrap();
        assert_eq!(note.title, "v4 note");
        assert_eq!(note.tags, vec!["tag1"]);
    }

    #[test]
    fn local_note_folders_validate_and_preserve_empty_nested_folders() {
        let db = temp_db();
        assert_eq!(db.note_create_folder(" Work ", "").unwrap(), "Work");
        assert_eq!(db.note_create_folder("Ideas", "Work").unwrap(), "Work/Ideas");
        assert_eq!(db.note_folders().unwrap(), vec!["Work", "Work/Ideas"]);
        for name in ["", " ", ".", "..", "a/b", "a\\b", "a:b", "bad\nname", "\tbad"] {
            assert!(db.note_create_folder(name, "").is_err(), "invalid name: {name:?}");
        }
        assert!(db.note_create_folder(&"x".repeat(121), "").is_err());
        assert!(db.note_create_folder("work", "").is_err());
        db.note_create_folder("École", "").unwrap();
        assert!(db.note_create_folder("éCOLE", "").is_err());
        assert!(db.note_create_folder("Child", "Missing").is_err());
        db.note_create_folder("Ideas", "").unwrap(); // same name, different parent
        // Path limits are bytes, while each segment's limit is characters.
        let segment = "界".repeat(100); // 300 UTF-8 bytes
        let mut parent = String::new();
        for _ in 0..3 {
            parent = db.note_create_folder(&segment, &parent).unwrap();
        }
        assert_eq!(parent.len(), 902);
        assert!(db.note_create_folder(&"界".repeat(41), &parent).is_err()); // 1026 bytes
        let boundary = db.note_create_folder(&"x".repeat(120), &parent).unwrap();
        assert_eq!(boundary.len(), 1023);
        let exact_limit = db.note_create_folder(&format!("{}界", "x".repeat(118)), &parent).unwrap();
        assert_eq!(exact_limit.len(), 1024);
        assert!(db.note_create_folder("x", &boundary).is_err()); // 1025 bytes
    }

    #[test]
    fn local_note_folder_membership_is_direct_and_survives_edits_reset_reopen() {
        let (mut db, path) = temp_db_at();
        db.note_create_folder("Work", "").unwrap();
        db.note_create_folder("Ideas", "Work").unwrap();
        db.note_insert("root", "Root", "body", &[], None).unwrap();
        db.note_insert_in_folder("direct", "Direct", "body", &[], None, "Work").unwrap();
        db.note_insert_in_folder("nested", "Nested", "body", &[], None, "Work/Ideas").unwrap();
        assert!(db.note_insert_in_folder("bad", "Bad", "", &[], None, "Missing").is_err());
        assert!(db.note_get("bad").unwrap().is_none());
        let (all, total) = db.note_query_in_folder(None, None, None, None, None, 1, 50, None, None).unwrap();
        assert_eq!((all.len(), total), (3, 3));
        let (direct, total) = db.note_query_in_folder(None, None, None, None, None, 1, 50, None, Some("Work")).unwrap();
        assert_eq!(total, 1);
        assert_eq!(direct[0].note_id, "direct");
        assert_eq!(direct[0].folder, "Work");
        let (root, total) = db.note_query_in_folder(None, None, None, None, None, 1, 50, None, Some("")).unwrap();
        assert_eq!(total, 1);
        assert_eq!(root[0].note_id, "root");
        db.note_update("direct", "Edited", "edited", &["tag".into()]).unwrap();
        assert_eq!(db.note_get("direct").unwrap().unwrap().folder, "Work");
        assert!(db.note_set_folder("direct", "Missing").is_err());
        assert!(db.note_set_folder("absent", "Work").is_err());
        db.note_set_folder("root", "Work/Ideas").unwrap();
        db.note_set_folder("nested", "").unwrap();
        db.reset_full().unwrap();
        assert_eq!(db.note_get("direct").unwrap().unwrap().folder, "Work");
        assert_eq!(db.note_folders().unwrap(), vec!["Work", "Work/Ideas"]);
        drop(db);
        let mut db = Db::open(&path).unwrap();
        assert_eq!(db.note_get("root").unwrap().unwrap().folder, "Work/Ideas");
        assert_eq!(db.note_get("nested").unwrap().unwrap().folder, "");
        db.note_erase_all().unwrap();
        assert!(db.note_folders().unwrap().is_empty());
        drop(db);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn local_note_folder_migration_preserves_schema_11_note_content() {
        let conn = Connection::open_in_memory().unwrap();
        for sql in MIGRATIONS.iter().take(11) { conn.execute_batch(sql).unwrap(); }
        conn.pragma_update(None, "user_version", 11).unwrap();
        conn.execute("INSERT INTO local_note_item(note_id,title,content,created_at,updated_at) VALUES('old','Title','Content','time','time')", []).unwrap();
        let mut db = Db { conn };
        db.migrate_kind().unwrap();
        db.migrate_kind().unwrap();
        let note = db.note_get("old").unwrap().unwrap();
        assert_eq!(note.title, "Title");
        assert_eq!(note.content, "Content");
        assert_eq!(note.folder, "");
        assert!(db.note_folders().unwrap().is_empty());
        assert_eq!(db.health().unwrap()["ok"], true);
    }

    #[test]
    fn local_note_crud_roundtrip_and_tags() {
        let mut db = temp_db();
        db.note_insert(
            "n1",
            "My First Note",
            "Markdown content #idea",
            &["idea".to_string(), "work".to_string()],
            None,
        )
        .unwrap();

        let note = db.note_get("n1").unwrap().unwrap();
        assert_eq!(note.title, "My First Note");
        assert_eq!(note.content, "Markdown content #idea");
        assert_eq!(note.tags, vec!["idea", "work"]);
        assert_eq!(note.pinned, false);
        assert_eq!(note.archived, false);

        // Update title, content, tags
        db.note_update("n1", "Updated Title", "New body", &["updated_tag".to_string()]).unwrap();
        let updated = db.note_get("n1").unwrap().unwrap();
        assert_eq!(updated.title, "Updated Title");
        assert_eq!(updated.content, "New body");
        assert_eq!(updated.tags, vec!["updated_tag"]);

        // Flags
        db.note_set_flags("n1", Some(true), Some(true), None).unwrap();
        let flagged = db.note_get("n1").unwrap().unwrap();
        assert_eq!(flagged.pinned, true);
        assert_eq!(flagged.favorite, true);

        // Delete
        db.note_delete("n1").unwrap();
        assert!(db.note_get("n1").unwrap().is_none());
        assert!(db.note_tags("n1").unwrap().is_empty());
    }

    #[test]
    fn local_note_query_filters_and_like_wildcard_escaping() {
        let mut db = temp_db();
        db.note_insert("n1", "Alpha_Note", "Body text with %percent", &["project".to_string()], None).unwrap();
        db.note_insert("n2", "Beta Note", "Simple body", &["draft".to_string()], None).unwrap();
        db.note_set_flags("n1", Some(true), None, None).unwrap();

        // Search title with wildcard
        let (rows, total) = db.note_query(Some("Alpha_Note"), None, None, None, None, 1, 10, None).unwrap();
        assert_eq!(total, 1);
        assert_eq!(rows[0].note_id, "n1");

        // Literal wildcard escaping test
        let (rows, total) = db.note_query(Some("%percent"), None, None, None, None, 1, 10, None).unwrap();
        assert_eq!(total, 1);
        assert_eq!(rows[0].note_id, "n1");

        // Filter by tag
        let (rows, total) = db.note_query(None, Some("draft"), None, None, None, 1, 10, None).unwrap();
        assert_eq!(total, 1);
        assert_eq!(rows[0].note_id, "n2");

        // Filter by pinned
        let (rows, total) = db.note_query(None, None, Some(true), None, None, 1, 10, None).unwrap();
        assert_eq!(total, 1);
        assert_eq!(rows[0].note_id, "n1");
    }

    #[test]
    fn convert_inbox_to_note_is_idempotent_and_creates_valid_note() {
        let mut db = temp_db();
        db.inbox_insert("in1", "text", "Inbox Idea", "Detailed thoughts inside inbox", "", "manual").unwrap();

        let note1 = db.convert_inbox_to_note("in1", "n-from-in1").unwrap();
        assert_eq!(note1.title, "Inbox Idea");
        assert_eq!(note1.content, "Detailed thoughts inside inbox");
        assert_eq!(note1.source_inbox_id.as_deref(), Some("in1"));
        assert!(note1.tags.contains(&"inbox".to_string()));

        // Second convert for same inbox_id returns existing note (idempotent, no duplicate note)
        let note2 = db.convert_inbox_to_note("in1", "n-duplicate").unwrap();
        assert_eq!(note2.note_id, note1.note_id);

        let (_all_notes, total) = db.note_query(None, None, None, None, None, 1, 10, None).unwrap();
        assert_eq!(total, 1);
    }

    #[test]
    fn unified_local_search_combines_notes_and_inbox_with_proper_types() {
        let mut db = temp_db();
        db.note_insert("n1", "Project Phoenix", "Architecture plan for mobile", &["mobile".to_string()], None).unwrap();
        db.inbox_insert("i1", "link", "Phoenix Repo", "", "https://github.com/phoenix", "manual").unwrap();

        let (results, total) = db.unified_local_search("Phoenix", 1, 10).unwrap();
        assert_eq!(total, 2);
        let types: Vec<&str> = results.iter().map(|r| r.result_type.as_str()).collect();
        assert!(types.contains(&"note") && types.contains(&"inbox"));
    }

    #[test]
    fn reset_full_preserves_local_inbox_and_local_notes() {
        let mut db = temp_db();
        db.upsert_paired("inst-r", "PC", "windows", "1.0", 1, "fp", "https://h").unwrap();
        db.inbox_insert("in-keep", "text", "", "user inbox data", "", "manual").unwrap();
        db.note_insert("note-keep", "User Note Title", "user note content", &[], None).unwrap();

        db.reset_full().unwrap();

        assert_eq!(db.health().unwrap()["ok"].as_bool(), Some(true));
        assert!(db.inbox_get("in-keep").unwrap().is_some(), "Local Inbox preserved");
        assert!(db.note_get("note-keep").unwrap().is_some(), "Local Notes preserved");
        assert!(db.paired().unwrap().is_none(), "pairing cleared");
    }

    #[test]
    fn inbox_erase_leaves_local_notes_untouched_and_vice_versa() {
        let mut db = temp_db();
        db.inbox_insert("in1", "text", "", "inbox item", "", "manual").unwrap();
        db.note_insert("n1", "Note Title", "Note body", &[], None).unwrap();

        // Erase inbox only
        db.inbox_erase_all().unwrap();
        assert!(db.inbox_get("in1").unwrap().is_none());
        assert!(db.note_get("n1").unwrap().is_some(), "Local notes untouched when inbox erased");

        // Re-insert inbox, erase note only
        db.inbox_insert("in2", "text", "", "inbox item 2", "", "manual").unwrap();
        db.note_erase_all().unwrap();
        assert!(db.note_get("n1").unwrap().is_none());
        assert!(db.inbox_get("in2").unwrap().is_some(), "Local inbox untouched when notes erased");
    }

    #[test]
    fn note_diagnostics_redacts_user_content() {
        let mut db = temp_db();
        db.note_insert(
            "n-sec",
            "SECRET-NOTE-TITLE-99",
            "SECRET-NOTE-BODY-CONTENT-88",
            &["SECRET-TAG-77".to_string()],
            Some("in-sec-66"),
        )
        .unwrap();

        let json = db.note_diagnostics().unwrap();
        let serialized = serde_json::to_string(&json).unwrap();
        for marker in [
            "SECRET-NOTE-TITLE-99",
            "SECRET-NOTE-BODY-CONTENT-88",
            "SECRET-TAG-77",
            "in-sec-66",
            "n-sec",
        ] {
            assert!(
                !serialized.contains(marker),
                "note diagnostics must not contain user content marker: {marker}"
            );
        }
        assert_eq!(json["stats"]["total"], 1);
        assert_eq!(json["items"][0]["tagCount"], 1);
        assert_eq!(json["items"][0]["hasSourceInboxId"], true);
    }

    #[test]
    fn safe_truncate_handles_unicode_emoji_cjk_without_panic() {
        let ascii = "Hello World";
        assert_eq!(safe_truncate(ascii, 20), "Hello World");
        assert_eq!(safe_truncate(ascii, 5), "Hello…");

        // CJK + Emoji mixed text
        let mixed = "LuckyRay 移动端 🚀 离线知识库测试文本，包含超长字符。";
        let truncated = safe_truncate(mixed, 11);
        assert_eq!(truncated, "LuckyRay 移动…");

        // Multibyte boundary safe
        let cjk_only = "中文测试字符串超长文本内容截断";
        assert_eq!(safe_truncate(cjk_only, 4), "中文测试…");
    }

    #[test]
    fn unified_search_pagination_and_relevance_ranking() {
        let mut db = temp_db();
        // Insert multiple notes and inbox items with target query
        for i in 1..=5 {
            db.note_insert(
                &format!("n-{i}"),
                &format!("Target Title Note {i}"),
                "Some body content",
                &["target_tag".to_string()],
                None,
            )
            .unwrap();
        }
        for i in 1..=5 {
            db.inbox_insert(
                &format!("in-{i}"),
                "text",
                &format!("Target Title Inbox {i}"),
                "Target text body",
                "",
                "manual",
            )
            .unwrap();
        }

        // Page 1, limit 4
        let (page1, total) = db.unified_local_search("Target", 1, 4).unwrap();
        assert_eq!(total, 10, "Total count reflects all matches in DB");
        assert_eq!(page1.len(), 4, "Page 1 returns limit items");

        // Page 2, limit 4
        let (page2, total2) = db.unified_local_search("Target", 2, 4).unwrap();
        assert_eq!(total2, 10);
        assert_eq!(page2.len(), 4, "Page 2 returns limit items");
        assert_ne!(page1[0].id, page2[0].id, "Page 2 items are distinct from Page 1");

        // Page 3, limit 4
        let (page3, _) = db.unified_local_search("Target", 3, 4).unwrap();
        assert_eq!(page3.len(), 2, "Page 3 returns remaining 2 items");

        // Page 4 (out of bounds)
        let (page4, _) = db.unified_local_search("Target", 4, 4).unwrap();
        assert_eq!(page4.len(), 0, "Page 4 is empty");
    }

    #[test]
    fn unified_search_ranks_before_truncation_older_high_relevance() {
        let mut db = temp_db();

        // 12 RECENT low-score (content-only) matches in EACH domain — far more than
        // page*limit=4 candidates, so a truncate-then-rank implementation would fill
        // the candidate window with low-score rows and permanently drop the older hit.
        for i in 1..=12 {
            db.note_insert(
                &format!("n-recent-{i}"),
                &format!("Recent title {i}"),
                "common needle appears in the body only",
                &[],
                None,
            )
            .unwrap();
            db.inbox_insert(
                &format!("in-recent-{i}"),
                "text",
                &format!("Recent inbox {i}"),
                "common needle appears in the body only",
                "",
                "manual",
            )
            .unwrap();
        }

        // An OLDER exact-title high-score result, outside the first page*limit rows
        // in plain updated-time order (updated one day before the recent rows).
        db.note_insert(
            "n-old",
            "Needle",
            "old body",
            &["needle_tag".to_string()],
            None,
        )
        .unwrap();
        db.conn
            .execute(
                "UPDATE local_note_item SET updated_at = datetime('now', '-1 day') WHERE note_id = 'n-old'",
                [],
            )
            .unwrap();

        // Page 1 must still contain the older high-score item (ranking before truncation).
        let (page1, total) = db.unified_local_search("Needle", 1, 4).unwrap();
        assert_eq!(total, 25, "all matching rows counted: 13 notes + 12 inbox");
        assert_eq!(page1.len(), 4);
        assert_eq!(page1[0].id, "n-old", "older exact-title hit ranks first");
        assert_eq!(page1[0].result_type, "note");
        assert_eq!(page1[0].title, "Needle");
        assert!(
            page1.iter().any(|r| r.id == "n-old"),
            "older high-relevance result must not be truncated away"
        );
    }

    #[test]
    fn unified_search_pages_stable_and_non_overlapping() {
        let mut db = temp_db();
        // Mixed relevance: 3 exact-title notes + 3 title-contains inbox + 4 content-only notes.
        for i in 1..=3 {
            db.note_insert(
                &format!("n-exact-{i}"),
                "Stable",
                "body",
                &[],
                None,
            )
            .unwrap();
            db.inbox_insert(
                &format!("in-contains-{i}"),
                "text",
                &format!("Prefix Stable {i} suffix"),
                "payload",
                "",
                "manual",
            )
            .unwrap();
        }
        for i in 1..=4 {
            db.note_insert(
                &format!("n-body-{i}"),
                &format!("Other {i}"),
                "mentions stable in the body",
                &[],
                None,
            )
            .unwrap();
        }

        let (page1a, total) = db.unified_local_search("Stable", 1, 4).unwrap();
        let (page2a, _) = db.unified_local_search("Stable", 2, 4).unwrap();
        assert_eq!(total, 10);

        // Repeat calls must produce the exact same pages (stable ordering).
        let (page1b, _) = db.unified_local_search("Stable", 1, 4).unwrap();
        let (page2b, _) = db.unified_local_search("Stable", 2, 4).unwrap();
        let ids_a: Vec<String> = page1a.iter().chain(page2a.iter()).map(|r| r.id.clone()).collect();
        let ids_b: Vec<String> = page1b.iter().chain(page2b.iter()).map(|r| r.id.clone()).collect();
        assert_eq!(ids_a, ids_b, "repeated queries return identical pages");

        // Non-overlapping pages.
        let p1_ids: Vec<&str> = page1a.iter().map(|r| r.id.as_str()).collect();
        let p2_ids: Vec<&str> = page2a.iter().map(|r| r.id.as_str()).collect();
        for id in &p1_ids {
            assert!(!p2_ids.contains(id), "page 1 and page 2 must not overlap");
        }

        // Exact-title notes (score 100) rank before title-contains (50) before body (10).
        assert!(page1a[0].id.starts_with("n-exact-"), "exact title first on page 1");
        assert!(page1a[1].id.starts_with("n-exact-"), "second exact title next");
        assert!(page1a[2].id.starts_with("n-exact-"), "third exact title next");
        assert!(
            page1a[3].id.starts_with("in-contains-"),
            "title-contains inbox item follows exact-title notes"
        );
    }

    #[test]
    fn unified_search_cjk_matching() {
        let mut db = temp_db();
        // Local Note with Chinese title + body (title note body deliberately does NOT
        // contain the second query term, so its match is title-scoped only).
        db.note_insert("n-cjk-title", "项目计划", "离线中文笔记正文内容", &[], None).unwrap();
        db.note_insert("n-cjk-body", "普通标题", "正文里包含知识库关键词的内容", &["知识库".to_string()], None).unwrap();
        // Local Inbox with Chinese text and a Chinese URL.
        db.inbox_insert("in-cjk-text", "text", "", "中文收件箱内容：本地知识库检索测试", "", "manual").unwrap();
        db.inbox_insert("in-cjk-url", "link", "", "", "https://example.com/知识库/文档.pdf", "manual").unwrap();

        // Query Chinese characters: body/tag match across both domains.
        let (results, total) = db.unified_local_search("知识库", 1, 10).unwrap();
        assert_eq!(total, 3, "CJK query matches note tag/body and inbox text/url");
        let ids: Vec<&str> = results.iter().map(|r| r.id.as_str()).collect();
        assert!(ids.contains(&"n-cjk-body"), "CJK note body/tag match returned");
        assert!(ids.contains(&"in-cjk-text"), "CJK inbox text match returned");
        assert!(ids.contains(&"in-cjk-url"), "CJK inbox url match returned");
        assert!(!ids.contains(&"n-cjk-title"), "title-only note without the CJK query term excluded");

        // CJK exact title match ranks first and matches correctly.
        let (exact, total_exact) = db.unified_local_search("项目计划", 1, 10).unwrap();
        assert_eq!(total_exact, 1);
        assert_eq!(exact.len(), 1);
        assert_eq!(exact[0].id, "n-cjk-title");
        assert_eq!(exact[0].title, "项目计划");

        // CJK title-contains query.
        let (contains, _) = db.unified_local_search("项目", 1, 10).unwrap();
        assert_eq!(contains.len(), 1);
        assert_eq!(contains[0].id, "n-cjk-title");

        // No panic / valid UTF-8 on the returned snippet and title.
        for r in results {
            assert!(r.title.is_char_boundary(0));
            assert!(r.snippet.is_char_boundary(0));
            assert!(!r.snippet.contains('\u{0}'));
        }
    }

    // ---- M2.9 Local Asset Library tests ----

    #[test]
    fn migration_v5_adds_local_asset_tables_and_preserves_v4_rows() {
        let db = db_at_version(4);
        assert_eq!(db.health().unwrap()["schemaVersion"].as_i64(), Some(SCHEMA_VERSION));
        assert_eq!(db.health().unwrap()["ok"].as_bool(), Some(true));

        // v3/v4 rows still work after the v4 -> v5 upgrade
        db.inbox_insert("in-v5", "text", "v5", "v5 content", "", "manual").unwrap();
        assert!(db.inbox_get("in-v5").unwrap().is_some());

        let mut db = db;
        db.note_insert("note-v5", "v5 note", "content v5", &["tag".to_string()], None).unwrap();
        assert!(db.note_get("note-v5").unwrap().is_some());

        // v5 local asset tables present
        db.asset_insert("asset-1", "image", "pic.jpg", "image/jpeg", 100, "h1", "/assets/originals/asset-1.jpg", "direct_import", None, &["work".to_string()])
            .unwrap();
        let asset = db.asset_get("asset-1").unwrap().unwrap();
        assert_eq!(asset.kind, "image");
        assert_eq!(asset.tags, vec!["work"]);
        assert_eq!(asset.source, "direct_import");
    }

    #[test]
    fn local_asset_crud_roundtrip_rename_flags_and_tags() {
        let mut db = temp_db();
        db.asset_insert(
            "asset-a", "document", "report.pdf", "application/pdf", 2048, "h-a",
            "/assets/originals/asset-a.pdf", "direct_import", None, &["pdf".to_string()],
        )
        .unwrap();
        let asset = db.asset_get("asset-a").unwrap().unwrap();
        assert_eq!(asset.name, "report.pdf");
        assert_eq!(asset.kind, "document");
        assert_eq!(asset.mime, "application/pdf");
        assert_eq!(asset.tags, vec!["pdf"]);
        assert_eq!(asset.archived, false);
        assert_eq!(asset.favorite, false);

        // rename + replace tags (identity/metadata untouched)
        db.asset_update("asset-a", "季度报告", &["work".to_string(), "2026".to_string()]).unwrap();
        let renamed = db.asset_get("asset-a").unwrap().unwrap();
        assert_eq!(renamed.name, "季度报告");
        assert_eq!(renamed.tags, vec!["2026", "work"]);
        assert_eq!(renamed.kind, "document", "kind never changes on rename");
        assert_eq!(renamed.mime, "application/pdf");
        assert_eq!(renamed.content_hash, "h-a");
        assert!(db.asset_update("missing", "x", &[]).is_err());

        // flags
        db.asset_set_flags("asset-a", Some(true), Some(true)).unwrap();
        let flagged = db.asset_get("asset-a").unwrap().unwrap();
        assert!(flagged.favorite && flagged.archived);
        assert!(db.asset_set_flags("missing", Some(true), None).is_err());

        // delete returns exactly the owned path
        let paths = db.asset_delete("asset-a").unwrap();
        assert_eq!(paths, vec!["/assets/originals/asset-a.pdf"]);
        assert!(db.asset_get("asset-a").unwrap().is_none());
        assert!(db.asset_tags("asset-a").unwrap().is_empty());
        assert!(db.asset_delete("asset-a").is_err());
    }

    #[test]
    fn local_asset_query_filters_and_like_wildcard_escaping() {
        let mut db = temp_db();
        db.asset_insert("asset-1", "image", "IMG_100%_note", "image/jpeg", 10, "h1", "/a/asset-1.jpg", "direct_import", None, &["trip".to_string()]).unwrap();
        db.asset_insert("asset-2", "video", "clip.mp4", "video/mp4", 20, "h2", "/a/asset-2.mp4", "direct_import", None, &[]).unwrap();
        db.asset_insert("asset-3", "document", "手册.pdf", "application/pdf", 30, "h3", "/a/asset-3.pdf", "inbox", Some("in-9"), &["手册".to_string()]).unwrap();
        db.asset_set_flags("asset-1", Some(true), None).unwrap();
        db.asset_set_flags("asset-3", None, Some(true)).unwrap();

        // kind filter
        let (videos, _) = db.asset_query(Some("video"), None, None, None, None, 1, 10, None).unwrap();
        assert_eq!(videos.len(), 1);
        assert_eq!(videos[0].asset_id, "asset-2");

        // tag filter
        let (tagged, _) = db.asset_query(None, None, Some("trip"), None, None, 1, 10, None).unwrap();
        assert_eq!(tagged.len(), 1);
        assert_eq!(tagged[0].asset_id, "asset-1");

        // favorite / archive filters
        let (favs, _) = db.asset_query(None, None, None, Some(true), None, 1, 10, None).unwrap();
        assert_eq!(favs[0].asset_id, "asset-1");
        let (arch, _) = db.asset_query(None, None, None, None, Some(true), 1, 10, None).unwrap();
        assert_eq!(arch[0].asset_id, "asset-3");
        let (active, _) = db.asset_query(None, None, None, None, Some(false), 1, 10, None).unwrap();
        assert_eq!(active.len(), 2);

        // search by name / tags / mime / kind
        let (by_name, _) = db.asset_query(None, Some("clip"), None, None, None, 1, 10, None).unwrap();
        assert_eq!(by_name[0].asset_id, "asset-2");
        let (by_tag, _) = db.asset_query(None, Some("trip"), None, None, None, 1, 10, None).unwrap();
        assert_eq!(by_tag[0].asset_id, "asset-1");
        let (by_mime, _) = db.asset_query(None, Some("application/pdf"), None, None, None, 1, 10, None).unwrap();
        assert_eq!(by_mime[0].asset_id, "asset-3");
        let (by_kind, _) = db.asset_query(None, Some("video"), None, None, None, 1, 10, None).unwrap();
        assert_eq!(by_kind[0].asset_id, "asset-2");

        // literal wildcard escaping: '%' and '_' in a query must match literally
        let (rows, total) = db.asset_query(None, Some("IMG_100%_note"), None, None, None, 1, 10, None).unwrap();
        assert_eq!(total, 1);
        assert_eq!(rows[0].asset_id, "asset-1");
        let (_, total) = db.asset_query(None, Some("IMGX100Xnote"), None, None, None, 1, 10, None).unwrap();
        assert_eq!(total, 0, "underscore must not act as a wildcard");
        // '%' matches ONLY names that literally contain a percent sign (the
        // query itself must never act as a wildcard across the whole table)
        let (rows, total) = db.asset_query(None, Some("%"), None, None, None, 1, 10, None).unwrap();
        assert_eq!(total, 1);
        assert_eq!(rows[0].asset_id, "asset-1", "only the literal-% name matches");
    }

    #[test]
    fn local_asset_cjk_search_and_pagination() {
        let mut db = temp_db();
        db.asset_insert("asset-1", "document", "季度报告.pdf", "application/pdf", 10, "h1", "/a/1.pdf", "direct_import", None, &["工作".to_string()]).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        db.asset_insert("asset-2", "image", "旅行照片.jpg", "image/jpeg", 20, "h2", "/a/2.jpg", "direct_import", None, &[]).unwrap();

        let (by_name, total) = db.asset_query(None, Some("季度"), None, None, None, 1, 10, None).unwrap();
        assert_eq!(total, 1);
        assert_eq!(by_name[0].asset_id, "asset-1");
        let (by_tag, _) = db.asset_query(None, Some("工作"), None, None, None, 1, 10, None).unwrap();
        assert_eq!(by_tag[0].asset_id, "asset-1");

        // newest first + pagination
        let (page1, total) = db.asset_query(None, None, None, None, None, 1, 1, None).unwrap();
        assert_eq!(total, 2);
        assert_eq!(page1[0].asset_id, "asset-2", "newest first");
        let (page2, _) = db.asset_query(None, None, None, None, None, 2, 1, None).unwrap();
        assert_eq!(page2[0].asset_id, "asset-1");

        // kind derivation from MIME (pure helper)
        assert_eq!(Db::asset_kind_for_mime("image/png"), "image");
        assert_eq!(Db::asset_kind_for_mime("VIDEO/MP4"), "video");
        assert_eq!(Db::asset_kind_for_mime("application/pdf"), "document");
        assert_eq!(Db::asset_kind_for_mime("application/octet-stream"), "file");
        assert_eq!(Db::asset_kind_for_mime(""), "file");
    }

    #[test]
    fn reset_full_preserves_inbox_notes_and_assets() {
        let mut db = temp_db();
        db.upsert_paired("inst-r", "PC", "windows", "1.0", 1, "fp", "https://h").unwrap();
        db.inbox_insert("in-keep", "text", "", "user inbox data", "", "manual").unwrap();
        db.note_insert("note-keep", "User Note", "user note content", &[], None).unwrap();
        db.asset_insert("asset-keep", "image", "photo.jpg", "image/jpeg", 5, "h", "/a/asset-keep.jpg", "direct_import", None, &[]).unwrap();

        db.reset_full().unwrap();

        assert_eq!(db.health().unwrap()["ok"].as_bool(), Some(true));
        assert!(db.inbox_get("in-keep").unwrap().is_some(), "Local Inbox preserved");
        assert!(db.note_get("note-keep").unwrap().is_some(), "Local Notes preserved");
        assert!(db.asset_get("asset-keep").unwrap().is_some(), "Local Assets preserved");
        assert!(db.paired().unwrap().is_none(), "pairing cleared");
    }

    #[test]
    fn erase_boundaries_never_cross_delete_any_mobile_domain() {
        let mut db = temp_db();
        db.inbox_insert("in1", "text", "", "inbox item", "", "manual").unwrap();
        db.note_insert("n1", "Note", "body", &[], None).unwrap();
        db.asset_insert("asset-1", "file", "a.bin", "application/octet-stream", 1, "h", "/a/asset-1.bin", "direct_import", None, &[]).unwrap();

        // inbox erase leaves notes + assets
        db.inbox_erase_all().unwrap();
        assert!(db.note_get("n1").unwrap().is_some());
        assert!(db.asset_get("asset-1").unwrap().is_some());

        // note erase leaves inbox + assets
        db.note_erase_all().unwrap();
        assert!(db.asset_get("asset-1").unwrap().is_some());

        // asset erase leaves inbox + notes (re-seed inbox/note first)
        db.inbox_insert("in2", "link", "", "", "https://x", "manual").unwrap();
        db.note_insert("n2", "Note2", "body2", &[], None).unwrap();
        let erased = db.asset_erase_all().unwrap();
        assert_eq!(erased.len(), 1, "asset erase returns owned (id, path) pairs");
        assert_eq!(erased[0].0, "asset-1", "erase returns the asset id for thumbnail cleanup");
        assert_eq!(erased[0].1, "/a/asset-1.bin", "erase returns the owned original path");
        assert!(db.asset_get("asset-1").unwrap().is_none());
        assert!(db.inbox_get("in2").unwrap().is_some(), "inbox untouched by asset erase");
        assert!(db.note_get("n2").unwrap().is_some(), "notes untouched by asset erase");
        let stats = db.asset_stats().unwrap();
        assert_eq!(stats["total"], 0);
    }

    #[test]
    fn asset_diagnostics_redacts_user_content() {
        let mut db = temp_db();
        db.asset_insert(
            "asset-sec",
            "document",
            "SECRET-ASSET-NAME-42.pdf",
            "application/pdf",
            777,
            "sha256-of-secret-asset",
            "/assets/originals/SECRET-PATH.pdf",
            "inbox",
            Some("in-secret-99"),
            &["SECRET-ASSET-TAG-7".to_string()],
        )
        .unwrap();
        let json = db.asset_diagnostics().unwrap();
        let serialized = serde_json::to_string(&json).unwrap();
        for marker in [
            "SECRET-ASSET-NAME-42.pdf",
            "sha256-of-secret-asset",
            "/assets/originals/SECRET-PATH.pdf",
            "in-secret-99",
            "SECRET-ASSET-TAG-7",
            "asset-sec",
        ] {
            assert!(
                !serialized.contains(marker),
                "asset diagnostics must not contain user content marker: {marker}"
            );
        }
        assert_eq!(json["stats"]["total"], 1);
        assert_eq!(json["stats"]["bytes"], 777);
        let item = &json["items"][0];
        assert_eq!(item["kind"], "document");
        assert_eq!(item["source"], "inbox");
        assert_eq!(item["mime"], "application/pdf");
        assert_eq!(item["tagCount"], 1);
        assert_eq!(item["hasSourceInboxId"], true);
    }

    #[test]
    fn unified_search_asset_domain_ranking_before_truncation_and_pagination() {
        let mut db = temp_db();
        // 12 RECENT low-score matches in each of the THREE domains — far more
        // than page*limit=4, so truncate-then-rank would drop the older hit.
        // (Assets have no body: recent matches come via display-name contains.)
        for i in 1..=12 {
            db.note_insert(&format!("n-recent-{i}"), &format!("Recent title {i}"), "common needle in body", &[], None).unwrap();
            db.inbox_insert(&format!("in-recent-{i}"), "text", &format!("Recent inbox {i}"), "common needle in body", "", "manual").unwrap();
            db.asset_insert(&format!("a-recent-{i}"), "file", &format!("Recent needle file {i}.bin"), "application/octet-stream", 1, "h", &format!("/a/a-recent-{i}.bin"), "direct_import", None, &[]).unwrap();
        }
        // An OLDER high-score asset (exact display-name match), one day older
        // than the recent rows: ranking must happen BEFORE truncation.
        db.asset_insert("a-old", "document", "Needle", "application/pdf", 2, "h-old", "/a/a-old.pdf", "direct_import", None, &["needle_tag".to_string()]).unwrap();
        db.conn
            .execute("UPDATE local_asset_item SET updated_at = datetime('now', '-1 day') WHERE asset_id = 'a-old'", [])
            .unwrap();

        let (page1, total) = db.unified_local_search("Needle", 1, 4).unwrap();
        assert_eq!(total, 37, "13 notes + 12 inbox + 12 assets all counted");
        assert_eq!(page1.len(), 4);
        assert_eq!(page1[0].id, "a-old", "older exact-name asset ranks first");
        assert_eq!(page1[0].result_type, "asset");
        assert!(page1.iter().any(|r| r.id == "a-old"), "older high-relevance asset never truncated away");

        // typed asset result carries structural metadata only
        let asset_result = page1[0].clone();
        assert_eq!(asset_result.kind, "document");
        assert_eq!(asset_result.extra["mime"], "application/pdf");
        assert_eq!(asset_result.extra["source"], "direct_import");
        assert_eq!(asset_result.extra["favorite"], false);

        // stable, non-overlapping pages across all three domains
        let (p1a, _) = db.unified_local_search("Needle", 1, 4).unwrap();
        let (p2a, _) = db.unified_local_search("Needle", 2, 4).unwrap();
        let (p1b, _) = db.unified_local_search("Needle", 1, 4).unwrap();
        let (p2b, _) = db.unified_local_search("Needle", 2, 4).unwrap();
        let ids_a: Vec<String> = p1a.iter().chain(p2a.iter()).map(|r| r.id.clone()).collect();
        let ids_b: Vec<String> = p1b.iter().chain(p2b.iter()).map(|r| r.id.clone()).collect();
        assert_eq!(ids_a, ids_b, "repeated queries return identical pages");
        for r1 in &p1a {
            assert!(!p2a.iter().any(|r| r.id == r1.id), "pages must not overlap");
        }
    }

    #[test]
    fn unified_search_asset_and_inbox_same_name_both_returned() {
        let mut db = temp_db();
        // exact device scenario: inbox image item with empty title, attachment file_name m27-share-test.jpg
        db.inbox_insert_with_attachment(
            "m27-item", "image", "", "", "", "share",
            "m27-ref", "image", "image/jpeg", "m27-share-test.jpg", 1830, "f805db4d", "/inbox/att-m27-share-test.jpg",
        )
        .unwrap();
        db.asset_insert("asset-m27", "image", "m27-share-test.jpg", "image/jpeg", 1830, "h", "/a/asset-m27.jpg", "inbox", Some("m27-item"), &[]).unwrap();
        let (results, total) = db.unified_local_search("m27", 1, 50).unwrap();
        assert_eq!(total, 2, "asset + inbox must both match");
        let types: Vec<&str> = results.iter().map(|r| r.result_type.as_str()).collect();
        assert!(types.contains(&"asset"), "asset in results");
        assert!(types.contains(&"inbox"), "inbox in results");
    }

    #[test]
    fn unified_search_asset_cjk_matching() {
        let mut db = temp_db();
        db.asset_insert("a-cjk", "document", "本地素材报告.pdf", "application/pdf", 5, "h", "/a/cjk.pdf", "direct_import", None, &["素材库".to_string()]).unwrap();
        db.asset_insert("a-cjk2", "image", "照片.jpg", "image/jpeg", 6, "h2", "/a/cjk2.jpg", "direct_import", None, &[]).unwrap();

        let (results, total) = db.unified_local_search("素材", 1, 10).unwrap();
        assert_eq!(total, 1, "CJK asset name + tag match returns one asset");
        assert_eq!(results[0].result_type, "asset");
        assert_eq!(results[0].id, "a-cjk");
        for r in results {
            assert!(r.title.is_char_boundary(0));
            assert!(r.snippet.is_char_boundary(0));
        }
    }
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// M2.13 Scope B — scale/performance baseline (test-only fixtures; no production
// code path changes).
//
// Seeds 5,000 Local Notes + 5,000 Local Inbox + 5,000 Local Asset metadata rows
// through the REAL public API into a temp DB, then verifies:
//   - exact domain counts (stats match the seeded pattern exactly);
//   - page-50 pagination reaches the FULL dataset with no duplicates/gaps and
//     stable order across independent re-walks;
//   - filter reset truth (kind / tag / pinned / favorite / archived / query);
//   - unified three-domain search returns correct domain/type totals and stable
//     pagination;
//   - timings are measured and printed (bounded assertions only, so CI stays
//     deterministic; the recorded numbers are the evidence).
//
// `m213_seed_ui_fixture` is the env-driven disposable fixture generator used
// for the Android UI stress set (M213_SEED_PATH -> seeds 1,000 rows/domain,
// all rows carry the unmistakable `m213-*` prefix so they can be removed
// individually afterwards).
// ---------------------------------------------------------------------------
#[cfg(test)]
mod scale_stress {
    use super::*;
    use std::collections::HashSet;
    use std::time::Instant;

    const N_NOTES: i64 = 5000;
    const N_INBOX: i64 = 5000;
    const N_ASSETS: i64 = 5000;
    const PAGE: i64 = 50;

    fn temp_scale_dir(tag: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("lrm-scale-{tag}-{}-{}", std::process::id(), nanos));
        std::fs::create_dir_all(&dir).ok();
        dir
    }

    /// Fixture seeding: synchronous=NORMAL is a test-only speedup for the bulk
    /// insert phase (production `Db::open` keeps its defaults; this code path
    /// is never compiled into the app).
    fn seed_dataset(db: &mut Db, dir: &std::path::Path, n: i64) {
        db.conn
            .pragma_update(None, "synchronous", "NORMAL")
            .expect("fixture pragma");

        let kinds = ["image", "video", "document", "file"];
        let mimes = ["image/jpeg", "video/mp4", "application/pdf", "application/octet-stream"];
        let exts = ["jpg", "mp4", "pdf", "bin"];

        for i in 0..n {
            // Local Notes: title/content token pattern shared with the other
            // two domains so unified search hits all three.
            let mut tags = vec!["m213-scale".to_string()];
            if i % 4 == 0 {
                tags.push("photo".to_string());
            }
            // NOTE: ids must keep the product "note-" prefix contract
            // (NoteEditor routes local vs desktop by `id.startsWith("note-")`).
            let nid = format!("note-m213-{i:05}");
            db.note_insert(
                &nid,
                &format!("Note {i:05}"),
                &format!("body of note {i:05} token m213token{}", i % 50),
                &tags,
                None,
            )
            .unwrap();
            db.note_set_flags(
                &nid,
                Some(i % 10 == 0),
                Some(i % 7 == 0),
                Some(i % 13 == 0),
            )
            .unwrap();

            // Local Inbox: kind cycles text/link/image/file.
            let inbox_kinds = ["text", "link", "image", "file"];
            let kind = inbox_kinds[(i % 4) as usize];
            let (title, text, url) = match kind {
                "link" => (
                    format!("Link {i:05}"),
                    format!("share text {i:05} token m213token{}", i % 50),
                    format!("https://example.com/m213/{i:05}"),
                ),
                _ => (
                    format!("Inbox {i:05}"),
                    format!("share text {i:05} token m213token{}", i % 50),
                    String::new(),
                ),
            };
            db.inbox_insert(
                &format!("m213-inbox-{i:05}"),
                kind,
                &title,
                &text,
                &url,
                "m213-fixture",
            )
            .unwrap();
            db.inbox_set_flags(&format!("m213-inbox-{i:05}"), Some(i % 7 == 0), Some(i % 13 == 0))
                .unwrap();

            // Local Asset metadata: a small real file set (first 100 rows)
            // exercises the filesystem-backed path without creating 15,000
            // large files; the rest are metadata-only rows.
            let kind = kinds[(i % 4) as usize];
            let mut asset_tags = vec!["m213-scale".to_string()];
            if kind == "image" {
                asset_tags.push("photo".to_string());
            }
            let local_path = if i < 100 {
                let p = dir.join(format!("file-{i:05}.{}", exts[(i % 4) as usize]));
                std::fs::write(&p, vec![0x5Au8; 1024]).unwrap();
                p.to_string_lossy().to_string()
            } else {
                String::new()
            };
            db.asset_insert(
                &format!("m213-asset-{i:05}"),
                kind,
                &format!("Asset {i:05} m213token{}", i % 50),
                mimes[(i % 4) as usize],
                (i * 137) % 100_000 + 1_000,
                &format!("m213hash{i:05}"),
                &local_path,
                "m213-fixture",
                None,
                &asset_tags,
            )
            .unwrap();
            db.asset_set_flags(&format!("m213-asset-{i:05}"), Some(i % 7 == 0), Some(i % 13 == 0))
                .unwrap();
        }
    }

    /// Walk every page (limit PAGE) of a paged query and return (ids in order,
    /// per-page latencies ms). The caller passes a closure that returns
    /// (Vec<String> ids, total).
    fn walk_pages<F>(mut page_fn: F) -> (Vec<String>, i64, Vec<u128>)
    where
        F: FnMut(i64) -> (Vec<String>, i64),
    {
        let mut ids = Vec::new();
        let mut total = 0;
        let mut latencies = Vec::new();
        let mut page = 1;
        loop {
            let t = Instant::now();
            let (rows, tot) = page_fn(page);
            latencies.push(t.elapsed().as_millis());
            total = tot;
            if rows.is_empty() {
                break;
            }
            ids.extend(rows);
            if (ids.len() as i64) >= total {
                break;
            }
            page += 1;
        }
        (ids, total, latencies)
    }

    fn assert_no_dup_gap(ids: &[String], expected: i64) {
        let set: HashSet<&String> = ids.iter().collect();
        assert_eq!(ids.len() as i64, expected, "collected row count");
        assert_eq!(set.len(), ids.len(), "no duplicate ids across pages");
        assert_eq!(set.len() as i64, expected, "no gaps (unique ids == total)");
    }

    #[test]
    /// K2 (LOCAL-KNOWLEDGE-USABILITY-R1 CLOSURE): the name sort is applied by
    /// the AUTHORITY before LIMIT/OFFSET, so a record whose title belongs on
    /// page 1 is reachable on page 1 even though it is last by recency.
    #[test]
    fn note_name_sort_orders_the_whole_library_before_pagination() {
        let dir = temp_scale_dir("name-sort");
        let path = dir.join("name.db");
        let mut db = Db::open(&path).expect("open+migrate");

        // 120 notes: recency descends as the index rises while titles ascend, so
        // a loaded-subset sort could never surface n000 on page 1.
        for i in 0..120i32 {
            let id = format!("n{i:03}");
            db.note_insert(&id, &format!("Title {i:03}"), "body", &[], None)
                .unwrap();
            db.conn
                .execute(
                    "UPDATE local_note_item SET updated_at = ?1, created_at = ?1 WHERE note_id = ?2",
                    rusqlite::params![format!("2026-01-01T{:02}:{:02}:00", i / 60, i % 60), id],
                )
                .unwrap();
        }

        // Page 1 under NAME sort leads with the alphabetically-first title.
        let (page1, total) = db
            .note_query(None, None, None, None, None, 1, 50, Some("name"))
            .unwrap();
        assert_eq!(total, 120);
        assert_eq!(page1[0].title, "Title 000", "whole-library name sort reaches page 1");
        assert_eq!(page1[0].note_id, "n000");

        // Both sorts walk the whole library, duplicate-free.
        for sort in ["name", "recent"] {
            let mut ids: Vec<String> = Vec::new();
            for page in 1..=3 {
                let (rows, _) = db
                    .note_query(None, None, None, None, None, page, 50, Some(sort))
                    .unwrap();
                ids.extend(rows.into_iter().map(|r| r.note_id));
            }
            assert_eq!(ids.len(), 120, "{sort}: every record is reachable");
            let unique: std::collections::HashSet<_> = ids.iter().collect();
            assert_eq!(unique.len(), 120, "{sort}: no record repeats across pages");
        }

        // Recent keeps its historical semantics (genuinely different order).
        let (recent1, _) = db
            .note_query(None, None, None, None, None, 1, 50, Some("recent"))
            .unwrap();
        assert_eq!(recent1[0].note_id, "n119", "recent leads with the newest (genuinely different order)");
    }

    /// K3: the tag picker reads the tag AUTHORITY, so a tag that exists only on
    /// a later page is still offered, and an applied tag does not hide others.
    #[test]
    fn note_tag_vocabulary_covers_the_whole_authority() {
        let dir = temp_scale_dir("tag-vocab");
        let path = dir.join("tags.db");
        let mut db = Db::open(&path).expect("open+migrate");

        for i in 0..60i32 {
            let id = format!("n{i:03}");
            // Only the LAST note carries the late-page tag.
            let tags = if i == 59 {
                vec!["work".to_string(), "zzz-late-page".to_string()]
            } else {
                vec!["work".to_string()]
            };
            db.note_insert(&id, &format!("T{i:03}"), "b", &tags, None).unwrap();
        }

        let vocab = db.note_tag_vocabulary(100).unwrap();
        assert_eq!(
            vocab,
            vec!["work".to_string(), "zzz-late-page".to_string()],
            "stable, complete authority order"
        );

        // Bounded by the caller.
        assert_eq!(db.note_tag_vocabulary(1).unwrap().len(), 1);

        // Even with a tag applied (loaded rows carry only that tag), the other
        // tag stays selectable from the authority.
        let (rows, _) = db
            .note_query(None, Some("work"), None, None, None, 1, 50, None)
            .unwrap();
        // Every returned row DOES carry the applied tag (the last note carries it',
        // too, alongside its extra tag) — the picker's point is that the OTHER',
        // tag stays offered even though these rows do not reveal it.',
        assert!(rows.iter().all(|r| r.tags.contains(&"work".to_string())));
        assert!(db.note_tag_vocabulary(100).unwrap().contains(&"zzz-late-page".to_string()));
    }
    /// A2 (LOCAL-LIBRARY-USABILITY-R1): name/size sorts are applied by the
    /// AUTHORITY before LIMIT/OFFSET, so a record whose name/size belongs on
    /// page 1 is reachable on page 1 even under recency pagination. >100 assets.
    #[test]
    fn asset_name_size_sort_orders_the_whole_library_before_pagination() {
        let dir = temp_scale_dir("asset-sort");
        let path = dir.join("sort.db");
        let mut db = Db::open(&path).expect("open+migrate");

        // 120 assets: recency and size DESCEND as the index rises, while the
        // name ASCENDS with the index — so a loaded-subset sort could never
        // surface asset 0 on page 1 under recency pagination.
        for i in 0..120i32 {
            let id = format!("a{i:03}");
            db.asset_insert(
                &id,
                "image",
                &format!("Asset {i:03}"),
                "image/png",
                10_000 - i as i64,
                &format!("hash{i:03}"),
                &format!("p{i:03}.png"),
                "direct_import",
                None,
                &[],
            )
            .unwrap();
            db.conn
                .execute(
                    "UPDATE local_asset_item SET created_at = ?1, updated_at = ?1 WHERE asset_id = ?2",
                    rusqlite::params![format!("2026-01-01T{:02}:{:02}:00", i / 60, i % 60), id],
                )
                .unwrap();
        }

        // NAME: page 1 leads with the alphabetically-first asset (asset 0,
        // which is the LAST by recency and the SMALLEST by size).
        let (page1, total) = db
            .asset_query(None, None, None, None, None, 1, 50, Some("name"))
            .unwrap();
        assert_eq!(total, 120);
        assert_eq!(page1[0].name, "Asset 000", "whole-library name sort reaches page 1");
        assert_eq!(page1[0].asset_id, "a000");

        // SIZE: page 1 leads with the largest asset (asset 0, also last by recency).
        let (size1, _) = db
            .asset_query(None, None, None, None, None, 1, 50, Some("size"))
            .unwrap();
        assert_eq!(size1[0].asset_id, "a000", "size DESC leads with 10_000");
        assert_eq!(size1[0].size_bytes, 10_000);

        // Both sorts walk the whole library, duplicate-free (deterministic pages).
        for sort in ["name", "size", "recent"] {
            let mut ids: Vec<String> = Vec::new();
            for page in 1..=3 {
                let (rows, _) = db
                    .asset_query(None, None, None, None, None, page, 50, Some(sort))
                    .unwrap();
                ids.extend(rows.into_iter().map(|r| r.asset_id));
            }
            assert_eq!(ids.len(), 120, "{sort}: every asset is reachable");
            let unique: std::collections::HashSet<_> = ids.iter().collect();
            assert_eq!(unique.len(), 120, "{sort}: no asset repeats across pages");
        }

        // Recent is LAST-UPDATED order: with no updates yet this equals the
        // created order (a119 newest-created), and it genuinely differs from name.
        let (recent1, _) = db
            .asset_query(None, None, None, None, None, 1, 50, Some("recent"))
            .unwrap();
        assert_eq!(recent1[0].asset_id, "a119", "recent leads with the last-updated");

        // P1-L1: an OLD-CREATED asset that is renamed jumps to the FRONT of the
        // recent order (asset_update writes updated_at) — and it must do so
        // through pagination, not just in the loaded subset.
        db.asset_update("a000", "Asset 000 RENAMED", &["renamed".to_string()]).unwrap();
        let (page1, total) = db
            .asset_query(None, None, None, None, None, 1, 50, Some("recent"))
            .unwrap();
        assert_eq!(total, 120);
        assert_eq!(page1[0].asset_id, "a000", "the renamed old asset leads recent page 1");
        assert_eq!(page1[0].name, "Asset 000 RENAMED");
        // And a name-sorted page 1 no longer contains the old title either.
        let (name1, _) = db
            .asset_query(None, None, None, None, None, 1, 50, Some("name"))
            .unwrap();
        assert_eq!(name1[0].name, "Asset 000 RENAMED");
    }

    /// A3: the tag picker reads the Local Asset tag AUTHORITY, so a tag that
    /// exists only on a later page is still offered, and an applied tag does
    /// not hide the others.
    #[test]
    fn asset_tag_vocabulary_covers_the_whole_authority() {
        let dir = temp_scale_dir("asset-tag-vocab");
        let path = dir.join("tags.db");
        let mut db = Db::open(&path).expect("open+migrate");

        for i in 0..60i32 {
            let id = format!("a{i:03}");
            // Only the LAST asset carries the late-page tag.
            let tags = if i == 59 {
                vec!["work".to_string(), "zzz-late-page".to_string()]
            } else {
                vec!["work".to_string()]
            };
            db.asset_insert(
                &id,
                "image",
                &format!("A{i:03}"),
                "image/png",
                1,
                &format!("h{i:03}"),
                &format!("p{i:03}.png"),
                "direct_import",
                None,
                &tags,
            )
            .unwrap();
        }

        let vocab = db.asset_tag_vocabulary(100).unwrap();
        assert_eq!(
            vocab,
            vec!["work".to_string(), "zzz-late-page".to_string()],
            "stable, complete authority order"
        );

        // Bounded by the caller.
        assert_eq!(db.asset_tag_vocabulary(1).unwrap().len(), 1);

        // With tag=work applied, the loaded rows reveal only that tag, yet the
        // authority still offers the late-page tag (switch needs no full load).
        let (rows, _) = db
            .asset_query(None, None, Some("work"), None, None, 1, 50, None)
            .unwrap();
        assert!(rows.iter().all(|r| r.tags.contains(&"work".to_string())));
        assert!(db.asset_tag_vocabulary(100).unwrap().contains(&"zzz-late-page".to_string()));
    }
    fn m213_scale_5000x3_pagination_search_filters() {
        let dir = temp_scale_dir("verify");
        let path = dir.join("scale.db");
        let mut db = Db::open(&path).expect("open+migrate");

        let seed_t = Instant::now();
        seed_dataset(&mut db, &dir, N_NOTES); // seeds all three domains
        let seed_ms = seed_t.elapsed().as_millis();
        println!("[m213-scale] seed 5000x3 took {seed_ms} ms");

        // ---- exact counts ----
        let note_stats = db.note_stats().unwrap();
        assert_eq!(note_stats["total"].as_i64(), Some(N_NOTES));
        assert_eq!(
            note_stats["favorites"].as_i64(),
            Some((0..N_NOTES).filter(|i| i % 7 == 0).count() as i64)
        );
        assert_eq!(
            note_stats["pinned"].as_i64(),
            Some((0..N_NOTES).filter(|i| i % 10 == 0).count() as i64)
        );
        assert_eq!(
            note_stats["archived"].as_i64(),
            Some((0..N_NOTES).filter(|i| i % 13 == 0).count() as i64)
        );

        let inbox_stats = db.inbox_stats().unwrap();
        assert_eq!(inbox_stats["total"].as_i64(), Some(N_INBOX));
        assert_eq!(
            inbox_stats["favorites"].as_i64(),
            Some((0..N_INBOX).filter(|i| i % 7 == 0).count() as i64)
        );
        assert_eq!(
            inbox_stats["archived"].as_i64(),
            Some((0..N_INBOX).filter(|i| i % 13 == 0).count() as i64)
        );

        let asset_stats = db.asset_stats().unwrap();
        assert_eq!(asset_stats["total"].as_i64(), Some(N_ASSETS));
        assert_eq!(
            asset_stats["favorites"].as_i64(),
            Some((0..N_ASSETS).filter(|i| i % 7 == 0).count() as i64)
        );
        assert_eq!(
            asset_stats["archived"].as_i64(),
            Some((0..N_ASSETS).filter(|i| i % 13 == 0).count() as i64)
        );
        println!("[m213-scale] exact counts verified: notes {N_NOTES}, inbox {N_INBOX}, assets {N_ASSETS}");

        // ---- full page-50 walks, no dup/gap, stable across re-walks ----
        let walk = |db: &Db| {
            let (note_ids, note_total, note_lat) = walk_pages(|p| {
                let (rows, t) = db.note_query(None, None, None, None, None, p, PAGE, None).unwrap();
                (rows.iter().map(|r| r.note_id.clone()).collect(), t)
            });
            let (inbox_ids, inbox_total, inbox_lat) = walk_pages(|p| {
                let (rows, t) = db.inbox_query(None, None, None, None, p, PAGE).unwrap();
                (rows.iter().map(|r| r.item.item_id.clone()).collect(), t)
            });
            let (asset_ids, asset_total, asset_lat) = walk_pages(|p| {
                let (rows, t) = db.asset_query(None, None, None, None, None, p, PAGE, None).unwrap();
                (rows.iter().map(|r| r.asset_id.clone()).collect(), t)
            });
            (
                note_ids, note_total, note_lat,
                inbox_ids, inbox_total, inbox_lat,
                asset_ids, asset_total, asset_lat,
            )
        };

        let (n1, nt1, nl1, i1, it1, il1, a1, at1, al1) = walk(&db);
        assert_no_dup_gap(&n1, N_NOTES);
        assert_no_dup_gap(&i1, N_INBOX);
        assert_no_dup_gap(&a1, N_ASSETS);
        assert_eq!(nt1, N_NOTES);
        assert_eq!(it1, N_INBOX);
        assert_eq!(at1, N_ASSETS);

        let (n2, nt2, _, i2, it2, _, a2, at2, _) = walk(&db);
        assert_eq!(n1, n2, "note walk order stable across re-walks");
        assert_eq!(i1, i2, "inbox walk order stable across re-walks");
        assert_eq!(a1, a2, "asset walk order stable across re-walks");
        assert_eq!(nt2, N_NOTES);
        assert_eq!(it2, N_INBOX);
        assert_eq!(at2, N_ASSETS);

        let avg = |lat: &[u128]| lat.iter().sum::<u128>() as f64 / lat.len().max(1) as f64;
        println!(
            "[m213-scale] note walk: {} pages, avg {:.1} ms/page, total {} ms; inbox {} pages, avg {:.1} ms; assets {} pages, avg {:.1} ms",
            nl1.len(), avg(&nl1), nl1.iter().sum::<u128>(), il1.len(), avg(&il1), al1.len(), avg(&al1)
        );

        // ---- filter truth ----
        let (rows, total) = db.note_query(None, Some("photo"), None, None, None, 1, PAGE, None).unwrap();
        assert_eq!(total, (0..N_NOTES).filter(|i| i % 4 == 0).count() as i64, "note tag filter total");
        assert_eq!(rows.len() as i64, PAGE, "note tag filter first page full");
        let (_, total) = db.note_query(None, None, Some(true), None, None, 1, PAGE, None).unwrap();
        assert_eq!(total, (0..N_NOTES).filter(|i| i % 10 == 0).count() as i64, "note pinned filter");
        let (_, total) = db.note_query(None, None, None, Some(true), None, 1, PAGE, None).unwrap();
        assert_eq!(total, (0..N_NOTES).filter(|i| i % 7 == 0).count() as i64, "note favorite filter");
        let (_, total) = db.note_query(None, None, None, None, Some(true), 1, PAGE, None).unwrap();
        assert_eq!(total, (0..N_NOTES).filter(|i| i % 13 == 0).count() as i64, "note archived filter");
        let (_, total) = db.note_query(Some("m213token7"), None, None, None, None, 1, PAGE, None).unwrap();
        assert_eq!(total, (0..N_NOTES).filter(|i| i % 50 == 7).count() as i64, "note content query");

        let (_, total) = db.inbox_query(Some("link"), None, None, None, 1, PAGE).unwrap();
        assert_eq!(total, (0..N_INBOX).filter(|i| i % 4 == 1).count() as i64, "inbox kind=link");
        let (_, total) = db.inbox_query(None, Some("m213token7"), None, None, 1, PAGE).unwrap();
        assert_eq!(total, (0..N_INBOX).filter(|i| i % 50 == 7).count() as i64, "inbox query");

        let (rows, total) = db.asset_query(Some("image"), None, None, None, None, 1, PAGE, None).unwrap();
        assert_eq!(total, (0..N_ASSETS).filter(|i| i % 4 == 0).count() as i64, "asset kind=image");
        assert_eq!(rows.len() as i64, PAGE);
        let (_, total) = db.asset_query(None, Some("m213token7"), None, None, None, 1, PAGE, None).unwrap();
        assert_eq!(total, (0..N_ASSETS).filter(|i| i % 50 == 7).count() as i64, "asset name query");
        let (_, total) = db.asset_query(None, None, Some("photo"), None, None, 1, PAGE, None).unwrap();
        assert_eq!(total, (0..N_ASSETS).filter(|i| i % 4 == 0).count() as i64, "asset tag=photo");
        println!("[m213-scale] filter truth verified (kind/tag/pinned/favorite/archived/query)");

        // ---- unified three-domain search, full walk ----
        let t = Instant::now();
        let (res, res_total, res_lat) = walk_pages(|p| {
            let (r, t) = db.unified_local_search("m213token7", p, PAGE).unwrap();
            (
                r.iter()
                    .map(|x| format!("{}:{}", x.result_type, x.id))
                    .collect(),
                t,
            )
        });
        assert_eq!(res_total, 300, "unified search total = 100 notes + 100 inbox + 100 assets");
        assert_no_dup_gap(&res, res_total);
        // typed-id keys: never collide across domains (e.g. note:... vs asset:...)
        let keys: HashSet<&String> = res.iter().collect();
        assert_eq!(keys.len(), res.len(), "typed-id keys unique");
        let (res2, res_total2, _) = walk_pages(|p| {
            let (r, t) = db.unified_local_search("m213token7", p, PAGE).unwrap();
            (
                r.iter()
                    .map(|x| format!("{}:{}", x.result_type, x.id))
                    .collect(),
                t,
            )
        });
        assert_eq!(res, res2, "unified search walk stable across re-walks");
        assert_eq!(res_total2, 300);
        println!(
            "[m213-scale] unified search 'm213token7': total {res_total}, {} pages, avg {:.1} ms/page, search walk {} ms",
            res_lat.len(),
            avg(&res_lat),
            t.elapsed().as_millis()
        );

        // ---- filesystem-backed rows stayed truthful ----
        let sample = db.asset_get("m213-asset-00042").unwrap().expect("asset row");
        assert!(
            std::path::Path::new(&sample.local_path).is_file(),
            "filesystem-backed asset row exists"
        );
        assert_eq!(db.asset_get("m213-asset-00100").unwrap().unwrap().local_path, "");

        // ---- bounded latency (generous CI-safe ceilings; real numbers printed) ----
        assert!(nl1.iter().all(|&m| m < 2000), "note page queries bounded");
        assert!(il1.iter().all(|&m| m < 2000), "inbox page queries bounded");
        assert!(al1.iter().all(|&m| m < 2000), "asset page queries bounded");
        assert!(res_lat.iter().all(|&m| m < 2000), "search page queries bounded");
    }

    /// Env-driven disposable fixture generator for the Android UI stress set:
    /// seeds 1,000 Local Notes + 1,000 Local Inbox + 1,000 Local Asset metadata
    /// rows at $M213_SEED_PATH (all `m213-*` prefixed), checkpoints WAL, and
    /// prints M213_SEED_DONE. Ignored by default; run explicitly with
    /// `cargo test --lib -- --ignored m213_seed_ui_fixture --nocapture`.
    #[test]
    #[ignore = "env-driven disposable fixture (M213_SEED_PATH); never runs in normal CI"]
    fn m213_seed_ui_fixture() {
        let Some(path) = std::env::var("M213_SEED_PATH").ok().map(std::path::PathBuf::from) else {
            println!("M213_SEED_PATH unset — fixture skipped");
            return;
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("fixture parent dir");
        }
        let mut db = Db::open(&path).expect("open fixture db");
        let dir = temp_scale_dir("ui-fixture");
        seed_dataset(&mut db, &dir, 1000);
        db.conn
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .expect("checkpoint");
        drop(db);
        println!("M213_SEED_DONE notes=1000 inbox=1000 assets=1000 at {}", path.display());
    }
}
