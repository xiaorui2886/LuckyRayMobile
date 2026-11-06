//! Explicit, scope-exact SQLite erasure for an already removed managed library.
//!
//! The caller owns the application DB mutex and sync gate, has durably recorded
//! the purging tombstone, and has rejected any other local owner of this binding.
//! This module has no network or filesystem deletion and never changes authority.
//! Resource-key inventory reads only the existing managed manifest and scoped DB rows.
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::Value;

const SCOPE_TABLES: &[&str] = &[
    "note_cache",
    "content_note_operation",
    "content_note_attachment",
    "content_vault_cache",
    "content_offline_note",
    "content_offline_vault",
    "content_note_operation_pause",
    "content_note_operation_recovery",
];

// Exact original v10 schema. These guards are restored before the same
// transaction commits. Any error or crash rolls back both rows and DDL.
const IMMUTABLE_TRIGGERS: &[(&str, &str, &str)] = &[
    ("content_pause_immutable_update", "content_note_operation_pause", "CREATE TRIGGER content_pause_immutable_update BEFORE UPDATE ON content_note_operation_pause BEGIN SELECT RAISE(ABORT,'immutable pause audit'); END"),
    ("content_pause_immutable_delete", "content_note_operation_pause", "CREATE TRIGGER content_pause_immutable_delete BEFORE DELETE ON content_note_operation_pause BEGIN SELECT RAISE(ABORT,'immutable pause audit'); END"),
    ("content_recovery_immutable_update", "content_note_operation_recovery", "CREATE TRIGGER content_recovery_immutable_update BEFORE UPDATE ON content_note_operation_recovery BEGIN SELECT RAISE(ABORT,'immutable recovery audit'); END"),
    ("content_recovery_immutable_delete", "content_note_operation_recovery", "CREATE TRIGGER content_recovery_immutable_delete BEFORE DELETE ON content_note_operation_recovery BEGIN SELECT RAISE(ABORT,'immutable recovery audit'); END"),
];

// Only known knowledge-domain keys carry exact [desktop, vault, note/path]
// ownership. Never infer ownership from a substring or from a value's body.
const SCOPED_META_PREFIXES: &[&str] = &[
    "knowledge.editor.body-ack.v1:",
    "knowledge.cache.reader.v1:",
    "content.pairing-review.v1:",
    "managed.linked.plan.v1:",
    "managed.linked.receipt.v1:",
    "managed.linked.blocked.v1:",
    "managed.move.v1:",
    "managed.move.blocked.v1:",
    "managed.folder.blocked.v1:",
    "managed.move.receipt.v1:",
    "managed.import.v1:",
    "managed.import.resources.v1:",
    "managed.folder.v1:",
    "managed.folder.scan.v1:",
    "managed.folder.receipt.v1:",
    "managed.move.retry.v1:",
];

fn failure(error: rusqlite::Error) -> String {
    format!("VAULT_PURGE_DATABASE: {error}")
}
fn normalize_sql(sql: &str) -> String {
    sql.trim().trim_end_matches(';').split_whitespace().collect::<Vec<_>>().join(" ")
}
fn scoped_parts(suffix: &str, instance: &str, vault: &str, length: usize) -> bool {
    serde_json::from_str::<Vec<String>>(suffix).ok().is_some_and(|parts| {
        parts.len() == length && parts[0] == instance && parts[1] == vault
    })
}
fn owns_metadata(key: &str, value: &str, instance: &str, vault: &str, local_vault_id: &str) -> bool {
    SCOPED_META_PREFIXES.iter().any(|prefix| key.strip_prefix(prefix)
        .is_some_and(|suffix| scoped_parts(suffix, instance, vault, 3)))
        || key.strip_prefix("knowledge.cache.paused.v1:")
            .is_some_and(|suffix| scoped_parts(suffix, instance, vault, 2))
        || (key == format!("knowledge.replica.s1:{instance}") && value == vault)
        || key == format!("managed.sync.commit.v1:{local_vault_id}")
}

fn public_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 160
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
fn cache_key(instance: &str, vault: &str, note: &str, resource: &str) -> String {
    // Exact production download_resource / cached_resource namespace.
    crate::managed_vault::hash(format!("{instance}:note:{vault}:{note}:{resource}").as_bytes())
}

/// Capture provable transport-cache ownership BEFORE deleting the manifest or
/// scoped SQL rows. The caller owns DB -> file locks and the download gate.
/// No target/path/URL is interpreted as a filename or resource identity.
pub(crate) fn resource_cache_keys(connection: &Connection, store: &crate::managed_vault::Store, local_vault_id: &str) -> Result<Vec<String>, String> {
    let manifest = store.manifest(local_vault_id)?;
    let Some(binding) = manifest.binding else { return Ok(Vec::new()); };
    let instance = binding.instance_id.as_str();
    let vault = binding.remote_vault_id.as_str();
    if !public_id(instance) || !public_id(vault) { return Err("VAULT_PURGE_RESOURCE_SCOPE_INVALID".into()); }
    let mut keys = std::collections::BTreeSet::new();
    {
        let mut query = connection.prepare("SELECT note_id,cached_document,server_document,conflict_document FROM note_cache WHERE desktop_instance_id=?1 AND vault_id=?2 ORDER BY note_id").map_err(failure)?;
        let rows = query.query_map(params![instance,vault], |row| Ok((row.get::<_,String>(0)?, [row.get::<_,Option<String>>(1)?,row.get::<_,Option<String>>(2)?,row.get::<_,Option<String>>(3)?]))).map_err(failure)?;
        for row in rows {
            let (note, documents) = row.map_err(failure)?;
            if !public_id(&note) { continue; }
            for raw in documents.into_iter().flatten() {
                let Ok(document) = serde_json::from_str::<Value>(&raw) else { continue; };
                if document["noteId"] != note || document["vaultId"] != vault { continue; }
                for resource in document["resources"].as_array().into_iter().flatten() {
                    if let Some(id) = resource["resourceId"].as_str().filter(|id| public_id(id)) {
                        keys.insert(cache_key(instance,vault,&note,id));
                    }
                }
            }
        }
    }
    {
        let mut query = connection.prepare("SELECT note_id,op_id FROM content_note_attachment WHERE desktop_instance_id=?1 AND vault_id=?2 ORDER BY note_id,op_id").map_err(failure)?;
        let rows = query.query_map(params![instance,vault], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?))).map_err(failure)?;
        for row in rows {
            let (note, op) = row.map_err(failure)?;
            let id = format!("local-attachment-{op}");
            if public_id(&note) && public_id(&op) && public_id(&id) { keys.insert(cache_key(instance,vault,&note,&id)); }
        }
    }
    // Replica preparation downloads by downloadResourceId. resourceId is an
    // alias for vault-private resources and is not a transport-cache key.
    for note in manifest.notes.values() {
        if !public_id(&note.note_id) || note.local_vault_id != local_vault_id
            || note.remote["instanceId"] != instance || note.remote["vaultId"] != vault
            || note.remote["replica"]["schemaVersion"] != 1 { continue; }
        for resource in note.remote["replica"]["resources"].as_array().into_iter().flatten() {
            if let Some(id) = resource["downloadResourceId"].as_str().filter(|id| public_id(id)) {
                keys.insert(cache_key(instance,vault,&note.note_id,id));
            }
        }
    }
    Ok(keys.into_iter().collect())
}

pub(crate) fn purge_scope(connection: &Connection, instance: &str, vault: &str, local_vault_id: &str) -> Result<(), String> {
    if instance.is_empty() || vault.is_empty() || local_vault_id.is_empty()
        || local_vault_id.len() > 160
        || !local_vault_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err("VAULT_PURGE_ID_INVALID".into());
    }
    if !connection.is_autocommit() { return Err("VAULT_PURGE_TRANSACTION_ACTIVE".into()); }
    let tx = Transaction::new_unchecked(connection, TransactionBehavior::Immediate).map_err(failure)?;

    // Validate all four BEFORE changing any guard or row. An unexpected future
    // schema needs an explicit compatible purge, not an unprotected fallback.
    for (name, table, sql) in IMMUTABLE_TRIGGERS {
        let actual: Option<(String, String)> = tx.query_row(
            "SELECT tbl_name,sql FROM sqlite_master WHERE type='trigger' AND name=?1",
            [name], |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional().map_err(failure)?;
        if actual.as_ref().is_none_or(|(actual_table, actual_sql)| actual_table != table || normalize_sql(actual_sql) != normalize_sql(sql)) {
            return Err("VAULT_PURGE_AUDIT_SCHEMA_CHANGED".into());
        }
    }
    let metadata = {
        let mut statement = tx.prepare("SELECT key,value FROM app_meta ORDER BY key").map_err(failure)?;
        let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).map_err(failure)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(failure)?
    };
    for (name, _, _) in IMMUTABLE_TRIGGERS {
        tx.execute_batch(&format!("DROP TRIGGER {name};")).map_err(failure)?;
    }
    for table in SCOPE_TABLES {
        tx.execute(&format!("DELETE FROM {table} WHERE desktop_instance_id=?1 AND vault_id=?2"), params![instance, vault]).map_err(failure)?;
    }
    for (key, value) in metadata {
        if owns_metadata(&key, &value, instance, vault, local_vault_id) {
            tx.execute("DELETE FROM app_meta WHERE key=?1", [key]).map_err(failure)?;
        }
    }
    // local-note-upload:* receipts deliberately survive: they are body-free
    // duplicate-submission ledgers for independently retained local originals.
    // content_response_cache is the material response cache, not a note body
    // store; its owner has no knowledge-vault dimension and is not touched.
    failpoint(1)?;
    for (_, _, sql) in IMMUTABLE_TRIGGERS { tx.execute_batch(sql).map_err(failure)?; }
    failpoint(2)?;
    tx.commit().map_err(failure)
}

#[cfg(test)]
thread_local! { static FAILPOINT: std::cell::Cell<u8> = const { std::cell::Cell::new(0) }; }
fn failpoint(point: u8) -> Result<(), String> {
    #[cfg(test)]
    if FAILPOINT.with(|value| { if value.get() == point { value.set(0); true } else { false } }) {
        return Err(format!("VAULT_PURGE_TEST_FAILURE_{point}"));
    }
    #[cfg(not(test))]
    let _ = point;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::types::Value as SqlValue;
    use serde_json::json;
    use std::collections::BTreeMap;

    struct Fixture { root: std::path::PathBuf, db: crate::db::Db }
    impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.root); } }
    fn fixture() -> Fixture {
        let root = std::env::temp_dir().join(format!("managed-purge-synthetic-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let db = crate::db::Db::open(&root.join("synthetic.db")).unwrap();
        for (instance, vault) in [("desktop-a", "vault-a"), ("desktop-a", "vault-b"), ("desktop-b", "vault-a")] {
            let marker = format!("secret {instance} {vault}");
            db.conn.execute("INSERT INTO note_cache(desktop_instance_id,vault_id,note_id,title,content,revision,dirty,base_revision,server_document,conflict_document,cached_document) VALUES(?1,?2,'n','Title',?3,'r1',1,'base',?3,?3,?3)", params![instance, vault, marker]).unwrap();
            db.conn.execute("INSERT INTO content_note_operation VALUES(?1,?2,'n','operation',?3,2,'content')", params![instance, vault, marker]).unwrap();
            db.conn.execute("INSERT INTO content_note_attachment VALUES(?1,?2,'n',?3,'asset.bin','application/octet-stream','shared-file-not-owned-by-purge',8,'digest',1,NULL,?4)", params![instance, vault, format!("attachment-{vault}"), marker]).unwrap();
            db.conn.execute("INSERT INTO content_vault_cache VALUES(?1,?2,'name','after',10,8,1)", params![instance, vault]).unwrap();
            db.conn.execute("INSERT INTO content_offline_vault VALUES(?1,?2,0,7,0,'granted')", params![instance, vault]).unwrap();
            db.conn.execute("INSERT INTO content_offline_note VALUES(?1,?2,'n','r1','ready','',0,0,0)", params![instance, vault]).unwrap();
            db.conn.execute("INSERT INTO content_note_operation_pause VALUES(?1,?2,'n','paused',?3,'content',1,'BLANK_RENAME_400','time')", params![instance, vault, marker]).unwrap();
            db.conn.execute("INSERT INTO content_note_operation_recovery VALUES(?1,?2,'n','paused','replacement','time')", params![instance, vault]).unwrap();
            for prefix in SCOPED_META_PREFIXES {
                db.conn.execute("INSERT INTO app_meta VALUES(?1,?2)", params![format!("{prefix}{}", json!([instance, vault, "n"])), marker]).unwrap();
            }
            db.conn.execute("INSERT INTO app_meta VALUES(?1,'paused')", [format!("knowledge.cache.paused.v1:{}", json!([instance,vault]))]).unwrap();
        }
        for (key, value) in [
            ("knowledge.replica.s1:desktop-a", "vault-a"),
            ("knowledge.replica.s1:desktop-b", "vault-a"),
            ("managed.sync.commit.v1:local-a", "commit-token"),
            ("managed.sync.commit.v1:other-local", "other-token"),
            ("local-note-upload:receipt", "n"),
            ("content.resource.authority.v1", "9"),
            ("grant:desktop-a", "unchanged grant"),
            ("managed.import.v1:not-json", "unproven ownership"),
        ] { db.conn.execute("INSERT INTO app_meta VALUES(?1,?2)", params![key, value]).unwrap(); }
        db.conn.execute("INSERT INTO paired_desktop VALUES('desktop-a','Desktop',NULL,NULL,NULL,'synthetic-fingerprint','http://test.invalid','synthetic-credential','time')", []).unwrap();
        db.conn.execute("INSERT INTO sync_cursor VALUES('desktop-a','legacy-global',15)", []).unwrap();
        db.conn.execute("INSERT INTO content_response_cache VALUES('desktop-a','/v1/assets/material','material metadata','time')", []).unwrap();
        Fixture { root, db }
    }
    fn rows(db: &Connection, table: &str, scope: Option<(&str, &str)>) -> Vec<Vec<Value>> {
        let sql = format!("SELECT * FROM {table}{} ORDER BY rowid", if scope.is_some() { " WHERE desktop_instance_id=?1 AND vault_id=?2" } else { "" });
        let mut statement = db.prepare(&sql).unwrap();
        let count = statement.column_count();
        let map = |row: &rusqlite::Row<'_>| (0..count).map(|column| row.get::<_, SqlValue>(column).map(|v| match v {
            SqlValue::Null => Value::Null, SqlValue::Integer(v) => json!(v), SqlValue::Real(v) => json!(v), SqlValue::Text(v) => json!(v), SqlValue::Blob(v) => json!(v),
        })).collect::<Result<Vec<_>, _>>();
        match scope {
            Some((instance, vault)) => statement.query_map(params![instance, vault], map).unwrap().collect::<Result<Vec<_>, _>>().unwrap(),
            None => statement.query_map([], map).unwrap().collect::<Result<Vec<_>, _>>().unwrap(),
        }
    }
    fn scope_snapshot(db: &Connection, instance: &str, vault: &str) -> BTreeMap<String, Vec<Vec<Value>>> {
        SCOPE_TABLES.iter().map(|table| ((*table).into(), rows(db, table, Some((instance, vault))))).collect()
    }
    fn triggers(db: &Connection) -> Vec<(String, String)> {
        let mut statement = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").unwrap();
        statement.query_map([], |row| Ok((row.get(0)?,row.get(1)?))).unwrap().collect::<Result<Vec<_>, _>>().unwrap()
    }
    fn assert_immutable(db: &Connection) {
        for table in ["content_note_operation_pause", "content_note_operation_recovery"] {
            assert!(db.execute(&format!("DELETE FROM {table} WHERE desktop_instance_id='desktop-b' AND vault_id='vault-a'"), []).is_err());
            let field = if table.ends_with("pause") { "payload" } else { "new_op_id" };
            assert!(db.execute(&format!("UPDATE {table} SET {field}='changed' WHERE desktop_instance_id='desktop-b' AND vault_id='vault-a'"), []).is_err());
        }
    }

    #[test]
    fn purge_erases_only_target_scope_and_restores_immutable_protection() {
        let f = fixture();
        let other_vault = scope_snapshot(&f.db.conn, "desktop-a", "vault-b");
        let other_desktop = scope_snapshot(&f.db.conn, "desktop-b", "vault-a");
        let before_triggers = triggers(&f.db.conn);
        let globals = ["paired_desktop", "sync_cursor", "content_response_cache"].map(|t| rows(&f.db.conn,t,None));
        let before_metadata = rows(&f.db.conn,"app_meta",None);
        purge_scope(&f.db.conn, "desktop-a", "vault-a", "local-a").unwrap();
        assert!(scope_snapshot(&f.db.conn, "desktop-a", "vault-a").values().all(Vec::is_empty));
        assert_eq!(scope_snapshot(&f.db.conn, "desktop-a", "vault-b"), other_vault);
        assert_eq!(scope_snapshot(&f.db.conn, "desktop-b", "vault-a"), other_desktop);
        assert_eq!(["paired_desktop", "sync_cursor", "content_response_cache"].map(|t| rows(&f.db.conn,t,None)), globals);
        assert_eq!(triggers(&f.db.conn), before_triggers);
        let expected_metadata: Vec<_> = before_metadata.into_iter().filter(|row| !owns_metadata(row[0].as_str().unwrap(),row[1].as_str().unwrap(),"desktop-a","vault-a","local-a")).collect();
        assert_eq!(rows(&f.db.conn,"app_meta",None), expected_metadata);
        assert_immutable(&f.db.conn);
        let after = rows(&f.db.conn,"app_meta",None);
        purge_scope(&f.db.conn, "desktop-a", "vault-a", "local-a").unwrap();
        assert_eq!(rows(&f.db.conn,"app_meta",None), after, "retry does not touch unrelated receipts");
        assert_eq!(triggers(&f.db.conn), before_triggers);
    }

    #[test]
    fn purge_failure_rolls_back_rows_metadata_and_guard_ddl() {
        for point in [1,2] {
            let f = fixture();
            let before = scope_snapshot(&f.db.conn, "desktop-a", "vault-a");
            let other = scope_snapshot(&f.db.conn, "desktop-b", "vault-a");
            let metadata = rows(&f.db.conn,"app_meta",None);
            let guard_schema = triggers(&f.db.conn);
            FAILPOINT.with(|value| value.set(point));
            assert_eq!(purge_scope(&f.db.conn,"desktop-a","vault-a","local-a").unwrap_err(),format!("VAULT_PURGE_TEST_FAILURE_{point}"));
            assert_eq!(scope_snapshot(&f.db.conn, "desktop-a", "vault-a"), before);
            assert_eq!(scope_snapshot(&f.db.conn, "desktop-b", "vault-a"), other);
            assert_eq!(rows(&f.db.conn,"app_meta",None), metadata);
            assert_eq!(triggers(&f.db.conn), guard_schema);
            assert!(f.db.conn.is_autocommit());
            assert_immutable(&f.db.conn);
        }
    }

    #[test]
    fn purge_rejects_missing_or_changed_audit_schema_before_any_row_change() {
        for changed in [false,true] {
            let f = fixture();
            let before = scope_snapshot(&f.db.conn, "desktop-a", "vault-a");
            f.db.conn.execute_batch("DROP TRIGGER content_pause_immutable_delete;").unwrap();
            if changed { f.db.conn.execute_batch("CREATE TRIGGER content_pause_immutable_delete BEFORE DELETE ON content_note_operation_pause BEGIN SELECT 1; END;").unwrap(); }
            let schema = triggers(&f.db.conn);
            assert_eq!(purge_scope(&f.db.conn,"desktop-a","vault-a","local-a").unwrap_err(),"VAULT_PURGE_AUDIT_SCHEMA_CHANGED");
            assert_eq!(scope_snapshot(&f.db.conn, "desktop-a", "vault-a"), before);
            assert_eq!(triggers(&f.db.conn), schema);
        }
    }

    #[test]
    fn resource_cache_inventory_uses_exact_note_scope_and_actual_transport_ids() {
        let f = fixture();
        let store = crate::managed_vault::Store::new(&f.root).unwrap();
        let mut local_ids = Vec::new();
        for (index, (instance, vault)) in [("desktop-a","vault-a"),("desktop-a","vault-b"),("desktop-b","vault-a")].into_iter().enumerate() {
            let created = store.create_vault("Cache fixture", &format!("cache-intent-{index}")).unwrap();
            let id = created["localVaultId"].as_str().unwrap().to_owned();
            let note = store.create(&id,"Replica","body",vec![],"").unwrap();
            let mut manifest = store.manifest(&id).unwrap();
            manifest.binding = Some(crate::managed_vault::Binding { instance_id:instance.into(), remote_vault_id:vault.into() });
            manifest.notes.get_mut(&note.note_id).unwrap().remote = json!({"instanceId":instance,"vaultId":vault,"replica":{"schemaVersion":1,"resources":[{"resourceId":"alias-only","downloadResourceId":"replica-download","target":"../../not-a-path-authority","status":"verified"},{"resourceId":"bad-alias","downloadResourceId":"../outside"}]}});
            store.commit(manifest,BTreeMap::new()).unwrap();
            let doc = json!({"noteId":"n","vaultId":vault,"resources":[{"resourceId":"shared-resource"},{"resourceId":"../invalid"},{"id":"guessed-id"}]}).to_string();
            let server = json!({"noteId":"n","vaultId":vault,"resources":[{"resourceId":"server-resource"}]}).to_string();
            let conflict = json!({"noteId":"n","vaultId":vault,"resources":[{"resourceId":"conflict-resource"}]}).to_string();
            f.db.conn.execute("UPDATE note_cache SET cached_document=?3,server_document=?4,conflict_document=?5 WHERE desktop_instance_id=?1 AND vault_id=?2",params![instance,vault,doc,server,conflict]).unwrap();
            local_ids.push((id,note.note_id,instance,vault));
        }
        let keys = resource_cache_keys(&f.db.conn,&store,&local_ids[0].0).unwrap();
        let expected = [
            cache_key("desktop-a","vault-a","n","shared-resource"),
            cache_key("desktop-a","vault-a","n","server-resource"),
            cache_key("desktop-a","vault-a","n","conflict-resource"),
            cache_key("desktop-a","vault-a","n","local-attachment-attachment-vault-a"),
            cache_key("desktop-a","vault-a",&local_ids[0].1,"replica-download"),
        ].into_iter().collect::<std::collections::BTreeSet<_>>();
        assert_eq!(keys.into_iter().collect::<std::collections::BTreeSet<_>>(),expected);
        for (id, _, instance, vault) in &local_ids[1..] {
            let other = resource_cache_keys(&f.db.conn,&store,id).unwrap();
            assert!(other.contains(&cache_key(instance,vault,"n","shared-resource")));
            assert!(other.iter().all(|key| !expected.contains(key)),"the same resource IDs in another binding never share a cache key");
        }
        let unproven = json!({"noteId":"foreign-note","vaultId":"vault-a","resources":[{"resourceId":"unproven-resource"}]}).to_string();
        f.db.conn.execute("UPDATE note_cache SET conflict_document=?1 WHERE desktop_instance_id='desktop-a' AND vault_id='vault-a'",[unproven]).unwrap();
        let keys = resource_cache_keys(&f.db.conn,&store,&local_ids[0].0).unwrap();
        assert!(!keys.contains(&cache_key("desktop-a","vault-a","n","unproven-resource")));
        assert!(!keys.contains(&cache_key("desktop-a","vault-a",&local_ids[0].1,"alias-only")),"replica aliases are not guessed as transport keys");
    }

    #[test]
    fn purge_metadata_ownership_is_exact_and_preserves_global_copy_receipts() {
        assert!(owns_metadata("managed.linked.plan.v1:[\"a\",\"v\",\"n\"]","body","a","v","local"));
        for key in ["managed.linked.plan.v1:[\"a\",\"v-other\",\"n\"]", "managed.linked.plan.v1:[\"other\",\"v\",\"n\"]", "managed.linked.plan.v1:[\"a\",\"v\"]", "local-note-upload:receipt", "content.resource.authority.v1"] {
            assert!(!owns_metadata(key,"v","a","v","local"), "{key}");
        }
        assert!(!owns_metadata("knowledge.replica.s1:a","v-other","a","v","local"));
    }
}
