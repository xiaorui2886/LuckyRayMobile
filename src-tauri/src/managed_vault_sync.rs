//! Durable, scope-exact recovery payload for the managed-file/Content adapter.
//!
//! This module does not send requests, select a Desktop, or infer a binding.
//! The file journal owns ordering: capture while the SQLite transaction is
//! open, durably commit the intent, publish files, commit the projection, then
//! mark the intent applied. Recovery must finish before another scoped write.
use rusqlite::{params, params_from_iter, types::Value as SqlValue, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Scope {
    pub instance_id: String,
    pub vault_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct TableImage {
    name: String,
    columns: Vec<String>,
    rows: Vec<Vec<Value>>,
}

/// Internal journal data, never a wire DTO. Includes exact immutable operation
/// bytes, CAS baselines, routes, draft/editor generations, receipts, tombstones,
/// conflict observations, and the cursor from the SAME transaction.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ScopeCheckpoint {
    version: u32,
    pub scope: Scope,
    tables: Vec<TableImage>,
    metadata: Vec<(String, String)>,
    #[serde(default)]
    copy_receipts: Vec<(String, String)>,
}

const TABLES: &[(&str, bool)] = &[
    ("note_cache", false),
    ("content_note_operation", false),
    ("content_note_attachment", false),
    ("content_vault_cache", false),
    ("content_offline_note", false),
    ("content_note_operation_pause", true),
    ("content_note_operation_recovery", true),
];
const META_PREFIXES: &[&str] = &[
    "knowledge.editor.body-ack.v1:",
    "knowledge.cache.reader.v1:",
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
fn fail(e: rusqlite::Error) -> String {
    format!("MANAGED_SYNC_DATABASE: {e}")
}
fn invalid() -> String {
    "MANAGED_SYNC_CHECKPOINT_INVALID".into()
}
fn columns(db: &Connection, table: &str) -> Result<Vec<String>, String> {
    let mut q = db
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(fail)?;
    let values = q.query_map([], |r| r.get::<_, String>(1)).map_err(fail)?;
    let names = values.collect::<Result<Vec<_>, _>>().map_err(fail)?;
    if names.is_empty()
        || names
            .iter()
            .any(|v| !v.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_'))
    {
        return Err(invalid());
    }
    Ok(names)
}
fn read_table(db: &Connection, scope: &Scope, table: &str) -> Result<TableImage, String> {
    let names = columns(db, table)?;
    let mut q = db
        .prepare(&format!(
            "SELECT {} FROM {table} WHERE desktop_instance_id=?1 AND vault_id=?2 ORDER BY rowid",
            names.join(",")
        ))
        .map_err(fail)?;
    let rows = q
        .query_map(params![scope.instance_id, scope.vault_id], |r| {
            (0..names.len())
                .map(|i| match r.get::<_, SqlValue>(i)? {
                    SqlValue::Null => Ok(Value::Null),
                    SqlValue::Integer(v) => Ok(Value::from(v)),
                    SqlValue::Text(v) => Ok(Value::String(v)),
                    // These domain tables have no REAL/BLOB columns. Reject instead
                    // of silently coercing a future schema into lossy journal data.
                    _ => Err(rusqlite::Error::InvalidQuery),
                })
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(fail)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(fail)?;
    Ok(TableImage {
        name: table.into(),
        columns: names,
        rows,
    })
}
fn owns_metadata(scope: &Scope, key: &str) -> bool {
    META_PREFIXES.iter().any(|prefix| {
        key.strip_prefix(prefix).is_some_and(|suffix| {
            serde_json::from_str::<Vec<String>>(suffix)
                .ok()
                .is_some_and(|parts| {
                    parts.len() == 3 && parts[0] == scope.instance_id && parts[1] == scope.vault_id
                })
        })
    })
}
fn metadata(db: &Connection, scope: &Scope) -> Result<Vec<(String, String)>, String> {
    let mut q = db
        .prepare("SELECT key,value FROM app_meta ORDER BY key")
        .map_err(fail)?;
    let rows = q
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(fail)?;
    let mut result = Vec::new();
    for row in rows {
        let row = row.map_err(fail)?;
        if owns_metadata(scope, &row.0) {
            result.push(row);
        }
    }
    Ok(result)
}
impl ScopeCheckpoint {
    pub(crate) fn capture(db: &Connection, scope: Scope) -> Result<Self, String> {
        if scope.instance_id.is_empty() || scope.vault_id.is_empty() {
            return Err(invalid());
        }
        if db.is_autocommit() {
            return Err("MANAGED_SYNC_TRANSACTION_REQUIRED".into());
        }
        let tables = TABLES
            .iter()
            .map(|(name, _)| read_table(db, &scope, name))
            .collect::<Result<_, _>>()?;
        let metadata = metadata(db, &scope)?;
        let copy_receipts = {
            let mut q=db.prepare("SELECT m.key,m.value FROM app_meta m JOIN note_cache n ON n.note_id=m.value WHERE m.key LIKE 'local-note-upload:%' AND n.desktop_instance_id=?1 AND n.vault_id=?2 ORDER BY m.key").map_err(fail)?;
            let rows = q
                .query_map(params![scope.instance_id, scope.vault_id], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .map_err(fail)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(fail)?
        };
        Ok(Self {
            version: 1,
            scope,
            tables,
            metadata,
            copy_receipts,
        })
    }

    /// Restore only inside the caller's recovery transaction. Fail closed on
    /// schema drift or foreign scope, and never erase immutable pause audits.
    pub(crate) fn restore(&self, db: &Connection) -> Result<(), String> {
        if db.is_autocommit() {
            return Err("MANAGED_SYNC_TRANSACTION_REQUIRED".into());
        }
        if self.version != 1
            || self.scope.instance_id.is_empty()
            || self.scope.vault_id.is_empty()
            || self.tables.len() != TABLES.len()
        {
            return Err(invalid());
        }
        // Validate ALL images before the first SQL write.
        for (image, (name, _)) in self.tables.iter().zip(TABLES) {
            if image.name != *name || image.columns != columns(db, name)? {
                return Err(invalid());
            }
            let instance = image
                .columns
                .iter()
                .position(|c| c == "desktop_instance_id")
                .ok_or_else(invalid)?;
            let vault = image
                .columns
                .iter()
                .position(|c| c == "vault_id")
                .ok_or_else(invalid)?;
            for row in &image.rows {
                if row.len() != image.columns.len()
                    || row[instance].as_str() != Some(self.scope.instance_id.as_str())
                    || row[vault].as_str() != Some(self.scope.vault_id.as_str())
                    || row
                        .iter()
                        .any(|v| !(v.is_null() || v.is_string() || v.as_i64().is_some()))
                {
                    return Err(invalid());
                }
            }
        }
        if self
            .metadata
            .iter()
            .any(|(key, _)| !owns_metadata(&self.scope, key))
        {
            return Err(invalid());
        }
        for (image, (_, immutable)) in self.tables.iter().zip(TABLES) {
            if *immutable {
                // Existing audit rows must be an exact subset. IGNORE alone
                // would conceal a collision with a different original intent.
                let existing = read_table(db, &self.scope, &image.name)?;
                if existing.rows.iter().any(|row| !image.rows.contains(row)) {
                    return Err("MANAGED_SYNC_IMMUTABLE_AUDIT_CHANGED".into());
                }
            } else {
                db.execute(
                    &format!(
                        "DELETE FROM {} WHERE desktop_instance_id=?1 AND vault_id=?2",
                        image.name
                    ),
                    params![self.scope.instance_id, self.scope.vault_id],
                )
                .map_err(fail)?;
            }
            let placeholders = vec!["?"; image.columns.len()].join(",");
            let sql = format!(
                "INSERT {} INTO {} ({}) VALUES ({})",
                if *immutable { "OR IGNORE" } else { "" },
                image.name,
                image.columns.join(","),
                placeholders
            );
            for row in &image.rows {
                let values = row.iter().map(|v| match v {
                    Value::Null => SqlValue::Null,
                    Value::String(v) => SqlValue::Text(v.clone()),
                    _ => SqlValue::Integer(v.as_i64().expect("validated above")),
                });
                db.execute(&sql, params_from_iter(values)).map_err(fail)?;
            }
            if *immutable {
                let actual = read_table(db, &self.scope, &image.name)?;
                if actual.rows.len() != image.rows.len()
                    || image.rows.iter().any(|r| !actual.rows.contains(r))
                {
                    return Err("MANAGED_SYNC_IMMUTABLE_AUDIT_CHANGED".into());
                }
            }
        }
        for (key, _) in metadata(db, &self.scope)? {
            db.execute("DELETE FROM app_meta WHERE key=?1", [key])
                .map_err(fail)?;
        }
        for (key, value) in &self.metadata {
            db.execute(
                "INSERT INTO app_meta(key,value) VALUES(?1,?2)",
                params![key, value],
            )
            .map_err(fail)?;
        }
        let note_ids = self
            .note_rows()?
            .into_iter()
            .filter_map(|r| r.get("note_id").and_then(Value::as_str).map(str::to_owned))
            .collect::<Vec<_>>();
        for (key, value) in &self.copy_receipts {
            if !key.starts_with("local-note-upload:") || !note_ids.contains(value) {
                return Err(invalid());
            }
            let old: Option<String> = db
                .query_row("SELECT value FROM app_meta WHERE key=?1", [key], |r| {
                    r.get(0)
                })
                .optional()
                .map_err(fail)?;
            if old.as_ref().is_some_and(|v| v != value) {
                return Err("MANAGED_SYNC_COPY_RECEIPT_CHANGED".into());
            }
            db.execute(
                "INSERT OR IGNORE INTO app_meta(key,value) VALUES(?1,?2)",
                params![key, value],
            )
            .map_err(fail)?;
        }
        Ok(())
    }
}

use crate::managed_vault::{self, Binding, Manifest, Note, Store};
use rusqlite::{OptionalExtension, Transaction};
use serde_json::json;
use std::{collections::BTreeMap, fs, path::Path};

#[derive(Serialize, Deserialize)]
struct Stage {
    token: String,
    manifest: Manifest,
    writes: BTreeMap<String, String>,
    #[serde(default)]
    retire: Vec<String>,
}
const STAGE: &str = ".luckyray/sync-stage.json";
fn token_key(id: &str) -> String {
    format!("managed.sync.commit.v1:{id}")
}
fn store(db: &Connection) -> Result<Option<Store>, String> {
    // In-memory tests and old installations without managed files remain pure
    // SQLite. Merely opening/syncing never migrates or creates a new vault.
    let Some(path) = db.path().filter(|p| !p.is_empty()) else {
        return Ok(None);
    };
    let parent = Path::new(path)
        .parent()
        .ok_or("MANAGED_SYNC_PATH_INVALID")?;
    if !parent.join("managed-vaults/registry.json").exists() {
        return Ok(None);
    }
    Store::new(parent).map(Some)
}
fn ids(store: &Store) -> Result<Vec<String>, String> {
    Ok(store.list()?["items"]
        .as_array()
        .ok_or("MANAGED_SYNC_REGISTRY_INVALID")?
        .iter()
        .filter_map(|row| row["localVaultId"].as_str().map(str::to_owned))
        .collect())
}
fn bound(store: &Store, scope: &Scope) -> Result<Option<Manifest>, String> {
    let mut result = None;
    for id in ids(store)? {
        let m = store.manifest(&id)?;
        if m.binding.as_ref().is_some_and(|b| {
            b.instance_id == scope.instance_id && b.remote_vault_id == scope.vault_id
        }) {
            if result.is_some() {
                return Err("MANAGED_SYNC_BINDING_AMBIGUOUS".into());
            }
            result = Some(m);
        }
    }
    Ok(result)
}
fn recover_unlocked(db: &Connection, store: &Store) -> Result<(), String> {
    for id in ids(store)? {
        let root = store.vault_root(&id)?;
        let path = managed_vault::guarded(&root, STAGE)?;
        if !path.exists() {
            continue;
        }
        let stage: Stage = serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        if stage.manifest.local_vault_id != id {
            return Err("MANAGED_SYNC_STAGE_INVALID".into());
        }
        let token: Option<String> = db
            .query_row(
                "SELECT value FROM app_meta WHERE key=?1",
                [token_key(&id)],
                |r| r.get(0),
            )
            .optional()
            .map_err(fail)?;
        if token.as_deref() == Some(stage.token.as_str()) {
            let mut published = stage.manifest.clone();
            published.generation = published
                .generation
                .checked_add(1)
                .ok_or("VAULT_GENERATION_OVERFLOW")?;
            let current = store.manifest(&id)?;
            // Crash after publication but before stage retirement: exact
            // manifest equality proves publication, so never increment again.
            if serde_json::to_value(&current).map_err(|e| e.to_string())?
                != serde_json::to_value(&published).map_err(|e| e.to_string())?
            {
                store.commit_retire(stage.manifest, stage.writes, stage.retire)?;
            }
        }
        // No matching committed SQL token means the transaction never won.
        // Never publish its speculative files or replay a network request.
        fs::remove_file(path).map_err(|e| e.to_string())?;
        managed_vault::sync_dir(&root.join(".luckyray"))?;
    }
    Ok(())
}
pub(crate) fn recover(db: &Connection) -> Result<(), String> {
    let Some(store) = store(db)? else {
        return Ok(());
    };
    {let _gate = managed_vault::lock()?;recover_unlocked(db, &store)?;}
    crate::managed_vault_linked_import::reconcile(db,&store)
}

impl ScopeCheckpoint {
    fn note_rows(&self) -> Result<Vec<BTreeMap<String, Value>>, String> {
        let image = self.tables.first().ok_or_else(invalid)?;
        Ok(image
            .rows
            .iter()
            .map(|row| {
                image
                    .columns
                    .iter()
                    .cloned()
                    .zip(row.iter().cloned())
                    .collect()
            })
            .collect())
    }
    fn materialize(
        &self,
        store: &Store,
        mut m: Manifest,
    ) -> Result<(Manifest, BTreeMap<String, String>, Vec<String>), String> {
        let mut writes = BTreeMap::new();
        let mut retire = Vec::new();
        for row in self.note_rows()? {
            let strv = |key: &str| {
                row.get(key)
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned()
            };
            let id = strv("note_id");
            let body = strv("content");
            let dirty = row.get("dirty").and_then(Value::as_i64) == Some(1);
            let deleted = row.get("deleted").and_then(Value::as_i64) == Some(1);
            let cached =
                serde_json::from_str::<Value>(&strv("cached_document")).unwrap_or(Value::Null);
            let known = dirty || cached["content"].is_string() || !body.is_empty();
            let old = m.notes.get(&id).cloned();
            // Preserve readable folders while suffixing a stable scoped identity.
            let logical = strv("relative_path").replace('\\', "/");
            let move_key = format!("managed.move.v1:{}", json!([self.scope.instance_id,self.scope.vault_id,id]));
            let move_intent = self.metadata.iter().find(|(key,_)|key==&move_key)
                .map(|(_,bytes)|serde_json::from_str::<Value>(bytes).map_err(|_|invalid())).transpose()?;
            let logical = if let Some(intent)=&move_intent {
                let parent=intent["parentRelativePath"].as_str().ok_or_else(invalid)?;
                crate::managed_vault_folder_sync::safe_path(parent,true)?;
                let name=logical.rsplit('/').next().ok_or_else(invalid)?;
                if parent.is_empty(){name.to_owned()}else{format!("{parent}/{name}")}
            } else {logical};
            let folder = logical
                .rsplit_once('/')
                .map(|v| v.0)
                .unwrap_or("")
                .to_owned();
            let path = Store::path(&folder, &strv("title"), &managed_vault::hash(id.as_bytes()))?;
            if !folder.is_empty() {
                let mut parent = String::new();
                for part in folder.split('/') {
                    if !parent.is_empty() {
                        parent.push('/');
                    }
                    parent.push_str(part);
                    if !m.folders.contains(&parent) {
                        m.folders.push(parent.clone());
                    }
                }
            }
            let body_hash = if known {
                managed_vault::hash(body.as_bytes())
            } else {
                String::new()
            };
            let changed = old.as_ref().is_none_or(|n| {
                n.body_hash != body_hash
                    || n.title != strv("title")
                    || n.trashed != deleted
                    || n.relative_path != path
            });
            if known
                && old.as_ref().is_none_or(|n| {
                    n.body_hash != body_hash || n.relative_path != path || n.trashed != deleted
                })
            {
                if let Some(previous) = &old {
                    if previous.body_state == "ready" && !previous.trashed {
                        let previous = store.get(&m.local_vault_id, &id)?;
                        if let Some(content) = previous.content {
                            writes.insert(
                                format!(
                                    ".luckyray/history/{}/{}.md",
                                    managed_vault::hash(id.as_bytes()),
                                    managed_vault::hash(previous.revision.as_bytes())
                                ),
                                content,
                            );
                        }
                        if deleted || previous.relative_path != path {
                            retire.push(previous.relative_path);
                        }
                    }
                }
                if !deleted {
                    writes.insert(path.clone(), body);
                }
            }
            let mut remote = json!({"instanceId":self.scope.instance_id,"vaultId":self.scope.vault_id,
                "relativePath":strv("relative_path"),"revision":strv("revision"),"baseRevision":row.get("base_revision"),
                "draftGeneration":row.get("draft_generation"),"pendingKind":strv("pending_kind"),"serverDocument":serde_json::from_str::<Value>(&strv("server_document")).unwrap_or(Value::Null),
                "conflictDocument":serde_json::from_str::<Value>(&strv("conflict_document")).unwrap_or(Value::Null),
                "resourcesComplete":false,"resourceCompleteness":"unverified"});
            if let Some(previous)=&old {if let Some(value)=previous.remote.get("transferSource"){remote["transferSource"]=value.clone();}}
            if let Some(previous) = &old {
                if previous.body_hash == body_hash
                    && previous.remote["revision"] == remote["revision"]
                    && previous.remote["serverDocument"]["revision"] == remote["serverDocument"]["revision"]
                {
                    for key in [
                        "replica",
                        "resourcesComplete",
                        "resourceCompleteness",
                        "bodyReady",
                    ] {
                        if let Some(value) = previous.remote.get(key) {
                            remote[key] = value.clone();
                        }
                    }
                }
            }
            let mut initial_import=Value::Null;
            for (key,bytes) in &self.metadata {
                if let Some(suffix)=key.strip_prefix("managed.import.v1:") {
                    let parts:Vec<String>=serde_json::from_str(suffix).map_err(|_|invalid())?;
                    let receipt:Value=serde_json::from_str(bytes).map_err(|_|invalid())?;
                    if receipt["noteId"]==id {remote["legacyImportNoteId"]=json!(parts[2]);remote["sourceFingerprint"]=receipt["sourceFingerprint"].clone();initial_import=receipt;}
                    if initial_import["initialMetadata"]["transferSource"].is_object(){remote["transferSource"]=initial_import["initialMetadata"]["transferSource"].clone();}
                }
            }
            let resource_blocked=self.metadata.iter().any(|(key,_)|key==&format!("managed.import.resources.v1:{}",json!([self.scope.instance_id,self.scope.vault_id,id])));
            if resource_blocked {remote["importResourcesIncomplete"]=json!(true);remote["syncBlockedReason"]=json!("unresolved-import-resources");}
            let move_blocked=self.metadata.iter().find(|(key,_)|key==&format!("managed.move.blocked.v1:{}",json!([self.scope.instance_id,self.scope.vault_id,id])));
            if let Some((_,code))=move_blocked {remote["moveBlockedReason"]=json!(code);}
            let linked_blocked=self.metadata.iter().any(|(key,_)|key==&format!("managed.linked.blocked.v1:{}",json!([self.scope.instance_id,self.scope.vault_id,id])));
            if linked_blocked{remote["syncBlockedReason"]=json!("linked-import-review-required");}
            let conflict = !row.get("conflict_document").is_none_or(Value::is_null) || move_blocked.is_some() || linked_blocked;
            let mut historical_names = old
                .as_ref()
                .map(|n| n.historical_names.clone())
                .unwrap_or_else(||serde_json::from_value(initial_import["initialMetadata"]["historicalNames"].clone()).unwrap_or_default());
            if let Some(previous) = &old {
                if previous.title != strv("title")
                    && !previous.title.is_empty()
                    && !historical_names.contains(&previous.title)
                {
                    historical_names.push(previous.title.clone());
                }
            }
            let n = Note {
                local_vault_id: m.local_vault_id.clone(),
                note_id: id.clone(),
                title: strv("title"),
                relative_path: path,
                folder,
                revision: if changed {
                    uuid::Uuid::new_v4().simple().to_string()
                } else {
                    old.as_ref().unwrap().revision.clone()
                },
                body_state: if known { "ready" } else { "missing" }.into(),
                content: None,
                tags: old.as_ref().map(|n| n.tags.clone()).unwrap_or_else(||serde_json::from_value(initial_import["tags"].clone()).unwrap_or_default()),
                pinned: old.as_ref().map(|n|n.pinned).unwrap_or(initial_import["initialMetadata"]["pinned"]==true),
                favorite: old.as_ref().map(|n|n.favorite).unwrap_or(initial_import["initialMetadata"]["favorite"]==true),
                archived: old.as_ref().map(|n|n.archived).unwrap_or(initial_import["initialMetadata"]["archived"]==true),
                created_at: old
                    .as_ref()
                    .map(|n| n.created_at.clone())
                    .unwrap_or_else(||initial_import["initialMetadata"]["createdAt"].as_str().map(str::to_owned).unwrap_or_else(||strv("updated_at"))),
                updated_at: strv("updated_at"),
                historical_names,
                sync_state: if conflict {
                    "conflict"
                } else if resource_blocked {
                    "incomplete"
                } else if dirty || move_intent.is_some() {
                    "pending"
                } else {
                    "synced"
                }
                .into(),
                legacy_route: Some(format!(
                    "desktop:{}:{}:{}",
                    uri_component(&self.scope.instance_id),
                    uri_component(&self.scope.vault_id),
                    uri_component(&id)
                )),
                body_hash,
                remote,
                trashed: deleted,
            };
            m.notes.insert(id, n);
        }
        for (key,_) in &self.metadata {
            if let Some(suffix)=key.strip_prefix("managed.folder.v1:").or_else(||key.strip_prefix("managed.folder.receipt.v1:")) {
                let parts:Vec<String>=serde_json::from_str(suffix).map_err(|_|invalid())?;
                let folder=parts.get(2).ok_or_else(invalid)?;
                Store::path(folder,"validation","check")?;
                if !m.folders.contains(folder){m.folders.push(folder.clone());}
            }
        }
        m.checkpoint = serde_json::to_value(self).map_err(|e| e.to_string())?;
        Ok((m, writes, retire))
    }
}

/// Replace a validated domain transaction's final commit. Legacy scopes are
/// unchanged. On publication failure the committed token and durable stage
/// survive; readers recover before exposing the advanced index/cursor.
pub(crate) fn commit(tx: Transaction<'_>, instance: &str, vault: &str) -> Result<(), String> {
    let Some(store) = store(&tx)? else {
        return tx.commit().map_err(fail);
    };
    let _gate = managed_vault::lock()?;
    recover_unlocked(&tx, &store)?;
    let scope = Scope {
        instance_id: instance.into(),
        vault_id: vault.into(),
    };
    let Some(manifest) = bound(&store, &scope)? else {
        return tx.commit().map_err(fail);
    };
    let checkpoint = ScopeCheckpoint::capture(&tx, scope)?;
    let (manifest, writes, retire) = checkpoint.materialize(&store, manifest)?;
    let token = uuid::Uuid::new_v4().to_string();
    let id = manifest.local_vault_id.clone();
    let root = store.vault_root(&id)?;
    let stage = Stage {
        token: token.clone(),
        manifest,
        writes,
        retire,
    };
    managed_vault::write_atomic(
        &root,
        STAGE,
        &serde_json::to_vec(&stage).map_err(|e| e.to_string())?,
    )?;
    failpoint(1)?;
    tx.execute(
        "INSERT OR REPLACE INTO app_meta(key,value) VALUES(?1,?2)",
        params![token_key(&id), token],
    )
    .map_err(fail)?;
    tx.commit().map_err(fail)?;
    failpoint(2)?;
    // The caller still holds the application DB mutex, preventing observers
    // from seeing the cursor without the corresponding file publication.
    store.commit_retire(stage.manifest, stage.writes, stage.retire)?;
    failpoint(3)?;
    fs::remove_file(managed_vault::guarded(&root, STAGE)?).map_err(|e| e.to_string())?;
    managed_vault::sync_dir(&root.join(".luckyray"))
}

/// Exact, read-only migration inventory. Preview and commit hash the same scope,
/// queue, draft, attachment and cursor images; a new/changed scope invalidates it.
pub(crate) fn migration_snapshot(db: &Connection) -> Result<Value, String> {
    let tx = Transaction::new_unchecked(db, rusqlite::TransactionBehavior::Deferred).map_err(fail)?;
    let scopes = {
        let mut q = tx.prepare("SELECT desktop_instance_id,vault_id FROM content_vault_cache UNION SELECT desktop_instance_id,vault_id FROM note_cache ORDER BY 1,2").map_err(fail)?;
        let rows = q.query_map([], |r| Ok(Scope { instance_id:r.get(0)?, vault_id:r.get(1)? })).map_err(fail)?;
        rows.collect::<Result<Vec<_>,_>>().map_err(fail)?
    };
    let mut snapshots = Vec::new();
    let mut note_count = 0usize;
    for scope in scopes {
        let image = ScopeCheckpoint::capture(&tx, scope)?;
        note_count += image.tables.iter().find(|t| t.name == "note_cache").map_or(0, |t| t.rows.len());
        snapshots.push(image);
    }
    tx.commit().map_err(fail)?;
    Ok(json!({"version":1,"noteCount":note_count,"scopes":snapshots}))
}

/// Caller owns the DB mutex then file gate. Registration is an explicit,
/// single-scope operation: never imports unrelated caches or legacy notes.
pub(crate) fn enroll_scope(db: &Connection, store: &Store, instance: &str, vault: &str, name: &str) -> Result<String, String> {
    if instance.is_empty() || vault.is_empty() { return Err("CONTENT_INPUT_INVALID".into()); }
    recover_unlocked(db, store)?;
    let scope = Scope { instance_id: instance.into(), vault_id: vault.into() };
    if let Some(manifest) = bound(store, &scope)? { return Ok(manifest.local_vault_id); }
    let id = format!(
        "replica-{}",
        managed_vault::hash(
            serde_json::to_string(&scope)
                .map_err(|e| e.to_string())?
                .as_bytes()
        )
    );
    let tx = Transaction::new_unchecked(db, rusqlite::TransactionBehavior::Immediate)
        .map_err(fail)?;
    let checkpoint = ScopeCheckpoint::capture(&tx, scope.clone())?;
    let binding = Binding {
        instance_id: scope.instance_id,
        remote_vault_id: scope.vault_id,
    };
    // A crash can publish a verified replica before registry publication.
    // Resume its exact generation/identities instead of synthesizing a
    // fresh generation-zero manifest and losing the registration retry.
    let manifest = if store.vault_root(&id)?.join("manifest.json").exists() {
        let existing = store.manifest(&id)?;
        if existing.binding.as_ref() != Some(&binding) {
            return Err("MANAGED_SYNC_MIGRATION_BINDING_CHANGED".into());
        }
        for note in existing
            .notes
            .values()
            .filter(|n| !n.trashed && n.body_state == "ready")
        {
            if store.get(&id, &note.note_id)?.body_state != "ready" {
                return Err("VAULT_FILE_CHANGED".into());
            }
        }
        existing
    } else {
        Manifest {
            version: 1,
            local_vault_id: id.clone(),
            name: name.to_owned(),
            binding: Some(binding),
            checkpoint: Value::Null,
            generation: 0,
            notes: BTreeMap::new(),
            folders: Vec::new(),
        }
    };
    let (manifest, writes, retire) = checkpoint.materialize(&store, manifest)?;
    // Read-only export: original SQLite rows/operations remain untouched.
    store.commit_retire(manifest, writes, retire)?;
    store.register(&id)?;
    tx.commit().map_err(fail)?;
    Ok(id)
}

pub(crate) fn migrate_replicas(db: &Connection) -> Result<Value, String> {
    let Some(store) = store(db)? else {
        return Ok(json!({"items":[]}));
    };
    // Caller owns DB then file gate and has explicitly approved migration.
    recover_unlocked(db, &store)?;
    let scopes = {
        let mut q=db.prepare("SELECT desktop_instance_id,vault_id,name FROM content_vault_cache UNION SELECT desktop_instance_id,vault_id,vault_id FROM note_cache WHERE NOT EXISTS(SELECT 1 FROM content_vault_cache v WHERE v.desktop_instance_id=note_cache.desktop_instance_id AND v.vault_id=note_cache.vault_id)").map_err(fail)?;
        let rows = q
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(fail)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(fail)?
    };
    let mut items = Vec::new();
    for (instance, vault, name) in scopes {
        let scope = Scope {
            instance_id: instance,
            vault_id: vault,
        };
        if bound(&store, &scope)?.is_some() {
            continue;
        }
        let id = enroll_scope(db, &store, &scope.instance_id, &scope.vault_id, &name)?;
        items.push(id);
        failpoint(4)?;
    }
    Ok(json!({"items":items}))
}

pub(crate) fn read_body(
    db: &Connection,
    instance: &str,
    vault: &str,
    id: &str,
    value: &mut Value,
) -> Result<(), String> {
    let Some(store) = store(db)? else {
        return Ok(());
    };
    let _gate = managed_vault::lock()?;
    recover_unlocked(db, &store)?;
    let scope = Scope {
        instance_id: instance.into(),
        vault_id: vault.into(),
    };
    if let Some(m) = bound(&store, &scope)? {
        if value["deleted"] != true {
            let n = store.get(&m.local_vault_id, id)?;
            value["bodyState"] = json!(n.body_state);
            value["editable"] = json!(n.body_state == "ready");
            if let Some(body) = n.content {
                value["content"] = json!(body);
            }
        }
    }
    Ok(())
}
pub(crate) fn is_managed(db: &Connection, instance: &str, vault: &str) -> Result<bool, String> {
    let Some(store) = store(db)? else {
        return Ok(false);
    };
    let _gate = managed_vault::lock()?;
    recover_unlocked(db, &store)?;
    Ok(bound(
        &store,
        &Scope {
            instance_id: instance.into(),
            vault_id: vault.into(),
        },
    )?
    .is_some())
}
pub(crate) fn uri_component(value: &str) -> String {
    let mut out = String::new();
    for b in value.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
thread_local! { static FAILPOINT: std::cell::Cell<u8> = const { std::cell::Cell::new(0) }; }
fn failpoint(point: u8) -> Result<(), String> {
    #[cfg(test)]
    if FAILPOINT.with(|f| {
        if f.get() == point {
            f.set(0);
            true
        } else {
            false
        }
    }) {
        return Err(format!("MANAGED_SYNC_TEST_CRASH_{point}"));
    }
    let _ = point;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        root: std::path::PathBuf,
        db: crate::db::Db,
        store: Store,
        id: String,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    fn fixture() -> Fixture {
        let root = std::env::temp_dir().join(format!("managed-sync-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let mut db = crate::db::Db::open(&root.join("luckyray-mobile.db")).unwrap();
        db.content_vault_remember("desktop-a", "vault-a", "A")
            .unwrap();
        db.content_apply_batch("desktop-a", "vault-a", &[doc("r1", "original")], 1, None)
            .unwrap();
        let store = Store::new(&root).unwrap();
        store
            .commit(
                Manifest {
                    version: 1,
                    local_vault_id: "local".into(),
                    name: "local".into(),
                    binding: None,
                    checkpoint: Value::Null,
                    generation: 0,
                    notes: BTreeMap::new(),
                    folders: Vec::new(),
                },
                BTreeMap::new(),
            )
            .unwrap();
        store.register("local").unwrap();
        {
            let _g = managed_vault::lock().unwrap();
            db.managed_migrate_replicas().unwrap();
        }
        let id = store.list().unwrap()["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["binding"].is_object())
            .unwrap()["localVaultId"]
            .as_str()
            .unwrap()
            .to_owned();
        Fixture {
            root,
            db,
            store,
            id,
        }
    }
    fn doc(rev: &str, body: &str) -> Value {
        json!({"noteId":"n","vaultId":"vault-a","title":"N","content":body,"relativePath":"N.md","revision":rev,"resources":[],"updatedAt":"2026-10-25","deleted":false})
    }
    #[test]
    fn explicit_scope_enrollment_is_exact_idempotent_and_keeps_missing_bodies() {
        let root = std::env::temp_dir().join(format!("managed-enrollment-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let mut db = crate::db::Db::open(&root.join("luckyray-mobile.db")).unwrap();
        for instance in ["desktop-a", "desktop-b"] {
            db.content_vault_remember(instance, "vault-a", "Same name").unwrap();
            db.content_apply_batch(instance, "vault-a", &[json!({"noteId":"missing","vaultId":"vault-a","title":"Missing","revision":"r1"})], 1, None).unwrap();
        }
        let store = Store::new(&root).unwrap();
        let id = {
            let _g = managed_vault::lock().unwrap();
            let row = db.managed_enroll_scope(&store, "desktop-a", "vault-a").unwrap();
            let repeated = db.managed_enroll_scope(&store, "desktop-a", "vault-a").unwrap();
            assert_eq!(row, repeated);
            assert_eq!(store.list().unwrap()["items"].as_array().unwrap().len(), 1);
            row["localVaultId"].as_str().unwrap().to_owned()
        };
        let note = store.get(&id, "missing").unwrap();
        assert_eq!(note.body_state, "missing");
        assert!(note.content.is_none());
        assert_eq!(note.remote["resourcesComplete"], false);
        assert_eq!(store.migration_status().unwrap()["state"], "not-migrated");
        // Explicit registration of another same-named scope remains distinct.
        let second = { let _g = managed_vault::lock().unwrap(); db.managed_enroll_scope(&store, "desktop-b", "vault-a").unwrap() };
        assert_ne!(second["localVaultId"], id);
        assert_eq!(store.list().unwrap()["items"].as_array().unwrap().len(), 2);
        drop(db);
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn stage_without_sql_commit_never_publishes_speculative_body() {
        let f = fixture();
        let editor =
            f.db.content_begin_edit("desktop-a", "vault-a", "n")
                .unwrap();
        FAILPOINT.with(|v| v.set(1));
        assert!(f
            .db
            .content_edit(
                "desktop-a",
                "vault-a",
                "n",
                "N",
                "rejected",
                editor["editorEpoch"].as_i64().unwrap(),
                1
            )
            .is_err());
        f.db.managed_recover().unwrap();
        assert_eq!(
            f.store.get(&f.id, "n").unwrap().content.as_deref(),
            Some("original")
        );
        assert_eq!(
            f.db.content_note("desktop-a", "vault-a", "n").unwrap()["dirty"],
            false
        );
    }
    #[test]
    fn committed_stage_recovers_after_sql_and_after_file_publication() {
        for point in [2, 3] {
            let mut f = fixture();
            let editor =
                f.db.content_begin_edit("desktop-a", "vault-a", "n")
                    .unwrap();
            FAILPOINT.with(|v| v.set(point));
            assert!(f
                .db
                .content_edit(
                    "desktop-a",
                    "vault-a",
                    "n",
                    "N",
                    "durable",
                    editor["editorEpoch"].as_i64().unwrap(),
                    1
                )
                .is_err());
            f.db.managed_recover().unwrap();
            f.db.managed_recover().unwrap();
            assert_eq!(
                f.store.get(&f.id, "n").unwrap().content.as_deref(),
                Some("durable")
            );
            let first =
                f.db.content_prepare_operations("desktop-a", "vault-a")
                    .unwrap();
            let second =
                f.db.content_prepare_operations("desktop-a", "vault-a")
                    .unwrap();
            assert_eq!(first, second);
            assert_eq!(first[0]["expectedRevision"], "r1");
            assert_eq!(first[0]["content"], "durable");
        }
    }
    #[test]
    fn pull_dirty_conflict_and_tombstone_preserve_local_file() {
        let mut f = fixture();
        let editor =
            f.db.content_begin_edit("desktop-a", "vault-a", "n")
                .unwrap();
        f.db.content_edit(
            "desktop-a",
            "vault-a",
            "n",
            "N",
            "mine",
            editor["editorEpoch"].as_i64().unwrap(),
            1,
        )
        .unwrap();
        f.db.content_apply_batch("desktop-a", "vault-a", &[doc("r2", "theirs")], 2, None)
            .unwrap();
        assert_eq!(
            f.store.get(&f.id, "n").unwrap().content.as_deref(),
            Some("mine")
        );
        assert_eq!(f.store.get(&f.id, "n").unwrap().sync_state, "conflict");
        f.db.content_apply_batch(
            "desktop-a",
            "vault-a",
            &[json!({"noteId":"n","vaultId":"vault-a","revision":"r3","deleted":true})],
            3,
            None,
        )
        .unwrap();
        assert_eq!(
            f.store.get(&f.id, "n").unwrap().content.as_deref(),
            Some("mine")
        );
        assert_eq!(
            f.db.content_sync_position("desktop-a", "vault-a").unwrap()["cursor"],
            3
        );
    }
    #[test]
    fn checkpoint_restores_stable_operations_and_cursor_without_other_scope() {
        let mut f = fixture();
        let editor =
            f.db.content_begin_edit("desktop-a", "vault-a", "n")
                .unwrap();
        f.db.content_edit(
            "desktop-a",
            "vault-a",
            "n",
            "N",
            "mine",
            editor["editorEpoch"].as_i64().unwrap(),
            1,
        )
        .unwrap();
        let op =
            f.db.content_prepare_operations("desktop-a", "vault-a")
                .unwrap();
        let checkpoint: ScopeCheckpoint =
            serde_json::from_value(f.store.manifest(&f.id).unwrap().checkpoint).unwrap();
        let mut conn = Connection::open(f.root.join("luckyray-mobile.db")).unwrap();
        let tx = conn.transaction().unwrap();
        tx.execute("DELETE FROM content_note_operation WHERE desktop_instance_id='desktop-a' AND vault_id='vault-a'",[]).unwrap();
        tx.execute("UPDATE note_cache SET content='lost' WHERE desktop_instance_id='desktop-a' AND vault_id='vault-a'",[]).unwrap();
        checkpoint.restore(&tx).unwrap();
        checkpoint.restore(&tx).unwrap();
        tx.commit().unwrap();
        assert_eq!(
            f.db.content_prepare_operations("desktop-a", "vault-a")
                .unwrap(),
            op
        );
        assert_eq!(
            f.db.content_sync_position("desktop-a", "vault-a").unwrap()["cursor"],
            1
        );
    }
    #[test]
    fn known_empty_body_and_missing_body_never_conflate() {
        let mut f = fixture();
        f.db.content_apply_batch("desktop-a", "vault-a", &[doc("r2", "")], 2, None)
            .unwrap();
        assert_eq!(
            f.store.get(&f.id, "n").unwrap().content.as_deref(),
            Some("")
        );
        f.db.content_apply_batch(
            "desktop-a",
            "vault-a",
            &[json!({"noteId":"missing","vaultId":"vault-a","title":"Missing","revision":"r1"})],
            3,
            None,
        )
        .unwrap();
        let missing = f.store.get(&f.id, "missing").unwrap();
        assert_eq!(missing.body_state, "missing");
        assert!(missing.content.is_none());
        assert_eq!(missing.remote["resourcesComplete"], false);
    }
    #[test]
    fn queued_folders_and_moves_are_local_first_and_parent_ordered() {
        let mut f=fixture();
        f.db.managed_folder_create(&f.store,&f.id,"Work","").unwrap();
        f.db.managed_folder_create(&f.store,&f.id,"Nested","Work").unwrap();
        let note=f.db.managed_create_bound(&f.store,&f.id,"New","text",vec![],"Work/Nested").unwrap();
        assert!(f.db.content_prepare_operations("desktop-a","vault-a").unwrap().is_empty());
        let folders=f.db.managed_pending_folders("desktop-a","vault-a").unwrap();
        assert_eq!(folders.len(),2);assert!(!f.db.managed_folder_parent_ready("desktop-a","vault-a","Work/Nested").unwrap());
        for op in folders {f.db.managed_folder_ack(&op,&json!({"opId":op.op_id,"vaultId":"vault-a","relativePath":op.relative_path,"created":true})).unwrap();}
        assert_eq!(f.db.content_prepare_operations("desktop-a","vault-a").unwrap()[0]["noteId"],note.note_id);
        let old=f.store.get(&f.id,"n").unwrap();
        let (_,request)=f.db.managed_move_prepare(&f.store,&f.id,"n",&old.revision,"Work").unwrap();
        let moved=f.store.get(&f.id,"n").unwrap();assert_eq!(moved.folder,"Work");assert_eq!(moved.sync_state,"pending");assert_eq!(moved.content.as_deref(),Some("original"));
        assert_eq!(f.db.managed_pending_moves("desktop-a","vault-a").unwrap()[0].1,request);
        assert!(f.db.managed_pending_moves("other","vault-a").unwrap().is_empty());
        f.db.managed_save_bound(&f.store,&f.id,"n",&moved.revision,"N","edited during move",vec![]).unwrap();
        assert!(!f.db.content_prepare_operations("desktop-a","vault-a").unwrap().iter().any(|op|op["noteId"]=="n"));
        f.db.managed_move_ack("desktop-a","vault-a","n",&request,&json!({"opId":request["opId"],"vaultId":"vault-a","noteId":"n","revision":"r2","parentRelativePath":"Work"})).unwrap();
        assert_eq!(f.store.get(&f.id,"n").unwrap().content.as_deref(),Some("edited during move"));
        assert!(f.db.managed_pending_moves("desktop-a","vault-a").unwrap().is_empty());
    }
    #[test]
    fn bound_import_is_idempotent_and_sync_targets_ignore_ui_selection() {
        let f=fixture();
        let first=f.db.managed_import_bound(&f.store,&f.id,"legacy-1","source-hash","Imported","body",vec![],"").unwrap();
        let again=f.db.managed_import_bound(&f.store,&f.id,"legacy-1","source-hash","Imported","body",vec![],"").unwrap();
        assert_eq!(first.note_id,again.note_id);
        assert!(f.db.managed_import_bound(&f.store,&f.id,"legacy-1","changed","Imported","body",vec![],"").is_err());
        f.store.select("local").unwrap();
        let targets=f.db.managed_sync_targets(&f.store,"desktop-a").unwrap();assert_eq!(targets["items"][0]["vaultId"],"vault-a");assert_eq!(targets["items"][0]["pendingCount"],1);
        assert_eq!(f.db.managed_sync_targets(&f.store,"other").unwrap()["items"],json!([]));
    }
    #[test]
    fn linked_import_retains_body_and_blocks_only_its_upload_until_resolved() {
        let mut f=fixture();let body="before [[Other]] ![image](local.png) after";
        let imported=f.db.managed_import_bound(&f.store,&f.id,"linked","hash","Linked",body,vec![],"").unwrap();
        assert_eq!(imported.content.as_deref(),Some(body));assert_eq!(imported.sync_state,"incomplete");
        assert!(f.db.content_prepare_operations("desktop-a","vault-a").unwrap().is_empty());
        assert!(f.db.content_sync_attention("desktop-a","vault-a").unwrap());
        let saved=f.db.managed_save_bound(&f.store,&f.id,&imported.note_id,&imported.revision,"Linked","portable text",vec![]).unwrap();
        assert_eq!(saved.sync_state,"pending");
        assert_eq!(f.db.content_prepare_operations("desktop-a","vault-a").unwrap().len(),1);
    }
    #[test]
    fn folder_pages_are_additive_and_never_ack_pending_creates() {
        let f=fixture();f.db.managed_folder_create(&f.store,&f.id,"Pending","").unwrap();
        let page=json!({"vaultId":"vault-a","items":[{"parentRelativePath":"Empty"},{"parentRelativePath":"Pending"}],"hasMore":true,"nextAfterPath":"Pending"});
        assert_eq!(f.db.managed_folder_observe_page("desktop-a","vault-a",&page).unwrap(),(2,true));
        assert_eq!(f.db.managed_pending_folders("desktop-a","vault-a").unwrap().len(),1);
        assert!(f.store.manifest(&f.id).unwrap().folders.contains(&"Empty".into()));
        assert!(f.db.managed_folder_observe_page("desktop-a","vault-a",&page).is_err());
        assert!(f.db.managed_folder_observe_page("desktop-a","other",&page).is_err());
        f.db.managed_folder_observe_page("desktop-a","vault-a",&json!({"vaultId":"vault-a","items":[],"hasMore":false,"nextAfterPath":null})).unwrap();
        assert!(f.store.manifest(&f.id).unwrap().folders.contains(&"Empty".into()));
    }
    #[test]
    fn all_managed_replicas_are_hydrated_without_singleton_ui_selection() {
        let mut f=fixture();f.db.offline_current("desktop-a","vault-a",true).unwrap();
        assert!(f.db.offline_selected("desktop-a","vault-a").unwrap());
        f.db.content_apply_batch("desktop-a","vault-a",&[json!({"vaultId":"vault-a","noteId":"later","title":"Later","relativePath":"Later.md","revision":"r1"})],2,None).unwrap();
        assert_eq!(f.db.offline_job("desktop-a","vault-a").unwrap().unwrap().id,"later");
        f.store.select("local").unwrap();
        assert!(f.db.offline_job("desktop-a","vault-a").unwrap().is_some());
    }
    #[test]
    fn bound_move_is_stable_and_late_ack_never_regresses_newer_observation() {
        let mut f = fixture();
        f.db.managed_folder_create(&f.store,&f.id,"Work","").unwrap();
        let expected = f.store.get(&f.id, "n").unwrap().revision;
        let (_, request) =
            f.db.managed_move_prepare(&f.store, &f.id, "n", &expected, "Work")
                .unwrap();
        let (_, retry) =
            f.db.managed_move_prepare(&f.store, &f.id, "n", &expected, "Work")
                .unwrap();
        assert_eq!(request, retry);
        let mut newer = doc("r3", "newer");
        newer["relativePath"] = json!("Later/N.md");
        f.db.content_apply_batch("desktop-a", "vault-a", &[newer], 3, None)
            .unwrap();
        f.db.managed_move_ack("desktop-a","vault-a","n",&request,&json!({"opId":request["opId"],"vaultId":"vault-a","noteId":"n","revision":"r2","parentRelativePath":"Work"})).unwrap();
        let n = f.db.content_note("desktop-a", "vault-a", "n").unwrap();
        assert_eq!(n["serverDocument"]["revision"], "r3");
        assert_eq!(n["relativePath"], "Later/N.md");
        assert_eq!(f.store.get(&f.id, "n").unwrap().folder, "Later");
    }
    #[test]
    fn bound_delete_is_pending_until_ack_and_retains_history() {
        let mut f = fixture();
        let before = f.store.get(&f.id, "n").unwrap();
        f.db.content_delete("desktop-a", "vault-a", "n").unwrap();
        let queued = f.store.get(&f.id, "n").unwrap();
        assert_eq!(queued.sync_state, "pending");
        assert_eq!(queued.remote["pendingKind"], "delete");
        assert_eq!(queued.content.as_deref(), Some("original"));
        let op =
            f.db.content_prepare_operations("desktop-a", "vault-a")
                .unwrap();
        assert_eq!(op[0]["kind"], "delete");
        f.db.content_ack(
            "desktop-a",
            "vault-a",
            "n",
            op[0]["opId"].as_str().unwrap(),
            &json!({"noteId":"n","vaultId":"vault-a","revision":"r2","deleted":true}),
        )
        .unwrap();
        assert!(f.store.manifest(&f.id).unwrap().notes["n"].trashed);
        assert!(!f
            .store
            .vault_root(&f.id)
            .unwrap()
            .join(before.relative_path)
            .exists());
        let history = f
            .store
            .vault_root(&f.id)
            .unwrap()
            .join(format!(".luckyray/history/{}", managed_vault::hash(b"n")));
        assert!(fs::read_dir(history).unwrap().next().is_some());
    }
    #[test]
    fn managed_cache_clear_is_refused_and_missing_reader_is_not_editable() {
        let mut f = fixture();
        assert_eq!(
            f.db.content_cache_clear("desktop-a", "vault-a")
                .unwrap_err(),
            "VAULT_MANAGED_BODY_NOT_CACHE"
        );
        f.db.content_apply_batch(
            "desktop-a",
            "vault-a",
            &[json!({"noteId":"missing","vaultId":"vault-a","title":"Missing","revision":"r1"})],
            2,
            None,
        )
        .unwrap();
        let n =
            f.db.content_note("desktop-a", "vault-a", "missing")
                .unwrap();
        assert_eq!(n["bodyState"], "missing");
        assert_eq!(n["editable"], false);
    }

    #[test]
    fn replica_registration_retry_preserves_identity_and_file() {
        let f = fixture();
        let before = f.store.get(&f.id, "n").unwrap();
        let registry = f.store.root.join("registry.json");
        let mut r: Value = serde_json::from_slice(&fs::read(&registry).unwrap()).unwrap();
        r["vaultIds"] = json!(["local"]);
        fs::write(&registry, serde_json::to_vec(&r).unwrap()).unwrap();
        {
            let _gate = managed_vault::lock().unwrap();
            f.db.managed_migrate_replicas().unwrap();
        }
        let after = f.store.get(&f.id, "n").unwrap();
        assert_eq!(before.revision, after.revision);
        assert_eq!(before.content, after.content);
        assert_eq!(
            f.store.list().unwrap()["items"].as_array().unwrap().len(),
            2
        );
    }

    #[test]
    fn late_ack_keeps_newer_draft_file_and_exact_remaining_operation() {
        let mut f = fixture();
        let editor =
            f.db.content_begin_edit("desktop-a", "vault-a", "n")
                .unwrap();
        let epoch = editor["editorEpoch"].as_i64().unwrap();
        f.db.content_edit("desktop-a", "vault-a", "n", "N", "sent", epoch, 1)
            .unwrap();
        let op =
            f.db.content_prepare_operations("desktop-a", "vault-a")
                .unwrap();
        f.db.content_edit("desktop-a", "vault-a", "n", "N", "newer draft", epoch, 2)
            .unwrap();
        f.db.content_ack(
            "desktop-a",
            "vault-a",
            "n",
            op[0]["opId"].as_str().unwrap(),
            &doc("r2", "sent"),
        )
        .unwrap();
        assert_eq!(
            f.store.get(&f.id, "n").unwrap().content.as_deref(),
            Some("newer draft")
        );
        let next =
            f.db.content_prepare_operations("desktop-a", "vault-a")
                .unwrap();
        assert_eq!(next[0]["content"], "newer draft");
        assert_eq!(next[0]["expectedRevision"], "r2");
        assert_ne!(next[0]["opId"], op[0]["opId"]);
    }
    #[test]
    fn replay_after_revocation_does_not_restore_old_write_permission() {
        let mut f = fixture();
        f.db.offline_select("desktop-a", "vault-a", true).unwrap();
        let editor =
            f.db.content_begin_edit("desktop-a", "vault-a", "n")
                .unwrap();
        FAILPOINT.with(|v| v.set(2));
        assert!(f
            .db
            .content_edit(
                "desktop-a",
                "vault-a",
                "n",
                "N",
                "durable",
                editor["editorEpoch"].as_i64().unwrap(),
                1
            )
            .is_err());
        f.db.offline_revoke("desktop-a").unwrap();
        f.db.managed_recover().unwrap();
        let conn = Connection::open(f.root.join("luckyray-mobile.db")).unwrap();
        let state:String=conn.query_row("SELECT write_state FROM content_offline_vault WHERE desktop_instance_id='desktop-a' AND vault_id='vault-a'",[],|r|r.get(0)).unwrap();
        assert_eq!(state, "revoked");
        assert_eq!(
            f.store.get(&f.id, "n").unwrap().content.as_deref(),
            Some("durable")
        );
    }
    #[test]
    fn background_hydration_publishes_missing_body_before_ready() {
        let mut f = fixture();
        f.db.offline_select("desktop-a", "vault-a", true).unwrap();
        let summary = json!({"noteId":"missing","vaultId":"vault-a","title":"M","revision":"r1","relativePath":"Nested/M.md"});
        f.db.content_apply_batch("desktop-a", "vault-a", &[summary], 2, None)
            .unwrap();
        let job =
            f.db.offline_job_at("desktop-a", "vault-a", 100)
                .unwrap()
                .unwrap();
        assert_eq!(job.id, "missing");
        let body = json!({"noteId":"missing","vaultId":"vault-a","title":"M","revision":"r1","relativePath":"Nested/M.md","content":"hydrated","resources":[],"updatedAt":"2026-10-25"});
        assert!(f
            .db
            .offline_finish_at("desktop-a", "vault-a", &job, Ok(body), 100)
            .unwrap());
        let n = f.store.get(&f.id, "missing").unwrap();
        assert_eq!(n.content.as_deref(), Some("hydrated"));
        assert_eq!(n.folder, "Nested");
        assert!(f
            .store
            .vault_root(&f.id)
            .unwrap()
            .join(n.relative_path)
            .exists());
    }
}

/// An explicit repair never treats a partial scope as an empty cache. Active
/// credentials, pairing grants, revocation and offline selection are not in the
/// checkpoint and are never restored by this operation.
fn repair_source(db:&Connection,store:&Store,id:&str)->Result<(ScopeCheckpoint,String,usize),String>{
    let manifest=store.manifest(id)?;
    let binding=manifest.binding.as_ref().ok_or("VAULT_BINDING_REQUIRED")?;
    let checkpoint:ScopeCheckpoint=serde_json::from_value(manifest.checkpoint.clone()).map_err(|_|"MANAGED_SYNC_CHECKPOINT_INVALID")?;
    if checkpoint.scope.instance_id!=binding.instance_id||checkpoint.scope.vault_id!=binding.remote_vault_id{return Err("MANAGED_SYNC_BINDING_CHANGED".into());}
    let bytes=serde_json::to_vec(&manifest.checkpoint).map_err(|e|e.to_string())?;let hash=managed_vault::hash(&bytes);
    for row in checkpoint.note_rows()? {
        let note_id=row.get("note_id").and_then(Value::as_str).ok_or_else(invalid)?;
        let note=manifest.notes.get(note_id).ok_or("MANAGED_SYNC_FILE_INDEX_MISMATCH")?;
        if !note.trashed && note.body_state=="ready" {
            let actual=store.get(id,note_id)?;
            let body=row.get("content").and_then(Value::as_str).ok_or_else(invalid)?;
            if actual.body_state!="ready"||actual.body_hash!=managed_vault::hash(body.as_bytes())||actual.content.as_deref()!=Some(body){return Err("MANAGED_SYNC_FILE_INDEX_MISMATCH".into());}
        }
    }
    let mut existing=0;
    for (table,_) in TABLES {existing+=read_table(db,&checkpoint.scope,table)?.rows.len();}
    Ok((checkpoint,hash,existing))
}
pub(crate) fn rebuild_preview(db:&Connection,store:&Store,id:&str)->Result<Value,String>{
    recover(db)?;let _gate=managed_vault::lock()?;let (checkpoint,hash,existing)=repair_source(db,store,id)?;
    Ok(json!({"localVaultId":id,"checkpointHash":hash,"canRebuild":existing==0,"existingRows":existing,"noteCount":checkpoint.note_rows()?.len(),"reason":if existing==0{Value::Null}else{json!("MANAGED_SYNC_SCOPE_NOT_EMPTY")}}))
}
pub(crate) fn rebuild(db:&Connection,store:&Store,id:&str,expected_hash:&str)->Result<Value,String>{
    recover(db)?;let _gate=managed_vault::lock()?;let (checkpoint,hash,existing)=repair_source(db,store,id)?;
    if hash!=expected_hash{return Err("MANAGED_SYNC_CHECKPOINT_CHANGED".into());}
    if existing!=0{return Err("MANAGED_SYNC_SCOPE_NOT_EMPTY".into());}
    let tx=Transaction::new_unchecked(db,rusqlite::TransactionBehavior::Immediate).map_err(fail)?;
    checkpoint.restore(&tx)?;
    let paired:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM paired_desktop WHERE desktop_instance_id=?1)",[&checkpoint.scope.instance_id],|r|r.get(0)).map_err(fail)?;
    if !paired {
        for row in checkpoint.note_rows()? {if row.get("dirty").and_then(Value::as_i64)==Some(1){
            let id=row.get("note_id").and_then(Value::as_str).ok_or_else(invalid)?;
            tx.execute("INSERT OR REPLACE INTO app_meta(key,value) VALUES(?1,'required')",[format!("content.pairing-review.v1:{}",json!([checkpoint.scope.instance_id,checkpoint.scope.vault_id,id]))]).map_err(fail)?;
        }}
    }
    tx.commit().map_err(fail)?;
    Ok(json!({"localVaultId":id,"restoredNotes":checkpoint.note_rows()?.len(),"pairingReviewRequired":!paired}))
}

#[cfg(test)]
mod migration_orchestration_tests {
    use super::*;
    #[test]
    fn preview_fences_scope_changes_and_partial_publication_remains_retryable() {
        let root = std::env::temp_dir().join(format!("migration-plan-test-{}",uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let mut db = crate::db::Db::open(&root.join("luckyray-mobile.db")).unwrap();
        db.content_vault_remember("i", "a", "A").unwrap();
        db.content_apply_batch("i","a",&[json!({"noteId":"n","vaultId":"a","title":"N","content":"body","revision":"r","relativePath":"N.md"})],1,None).unwrap();
        db.content_vault_remember("i", "c", "C").unwrap();
        let store = Store::new(&root).unwrap();
        let source = json!({"version":1,"notes":[],"folders":[],"history":{},"replicas":db.managed_migration_snapshot().unwrap()});
        let plan = store.prepare_migration(source.clone()).unwrap();
        assert_eq!(plan["noteCount"],1);
        assert_eq!(plan["replicaVaultCount"],2);
        let id = plan["planId"].as_str().unwrap();
        store.commit_migration(id,&source).unwrap();
        // Simulated interruption after standalone registration, before replicas.
        assert_eq!(store.migration_status().unwrap()["state"],"prepared");
        assert_eq!(store.complete_migration(id,&source).unwrap_err(),"VAULT_MIGRATION_INCOMPLETE");
        let before = fs::read(store.vault_root("local").unwrap().join("manifest.json")).unwrap();
        store.commit_migration(id,&source).unwrap();
        {
            let _gate=managed_vault::lock().unwrap();
            FAILPOINT.with(|p| p.set(4));
            assert!(db.managed_migrate_replicas().is_err());
            assert_eq!(store.migration_status().unwrap()["state"],"prepared");
            assert_eq!(store.complete_migration(id,&source).unwrap_err(),"VAULT_MIGRATION_INCOMPLETE");
            db.managed_migrate_replicas().unwrap();
        }
        assert_eq!(fs::read(store.vault_root("local").unwrap().join("manifest.json")).unwrap(),before);
        let unchanged = json!({"version":1,"notes":[],"folders":[],"history":{},"replicas":db.managed_migration_snapshot().unwrap()});
        assert_eq!(source,unchanged);
        // Crash after replica registration but before complete receipt is retryable too.
        assert_eq!(store.migration_status().unwrap()["state"],"prepared");
        assert_eq!(store.complete_migration(id,&unchanged).unwrap()["state"],"ready");
        // A newly discovered scope is never silently adopted by the approved plan.
        db.content_vault_remember("i","b","B").unwrap();
        let changed = json!({"version":1,"notes":[],"folders":[],"history":{},"replicas":db.managed_migration_snapshot().unwrap()});
        assert_eq!(store.commit_migration(id,&changed).unwrap_err(),"VAULT_MIGRATION_SOURCE_CHANGED");
        drop(db); fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn repreview_allows_unpublished_scope_change_but_rejects_stale_published_replica() {
        let root=std::env::temp_dir().join(format!("migration-repreview-replica-{}",uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path=root.join("luckyray-mobile.db");
        let mut db=crate::db::Db::open(&path).unwrap();
        db.content_vault_remember("i","a","A").unwrap();
        db.content_vault_remember("i","c","C").unwrap();
        db.content_apply_batch("i","a",&[json!({"noteId":"n","vaultId":"a","title":"N","content":"original","revision":"r","relativePath":"N.md"})],1,None).unwrap();
        let store=Store::new(&root).unwrap();
        let source=|| json!({"notes":[],"folders":[],"history":{},"replicas":db.managed_migration_snapshot().unwrap()});
        let first=source(); let plan=store.prepare_migration(first.clone()).unwrap();
        store.commit_migration(plan["planId"].as_str().unwrap(),&first).unwrap();
        {let _g=managed_vault::lock().unwrap(); FAILPOINT.with(|p| p.set(4)); assert!(db.managed_migrate_replicas().is_err());}
        let raw=Connection::open(&path).unwrap();
        raw.execute("UPDATE content_vault_cache SET name='C updated' WHERE desktop_instance_id='i' AND vault_id='c'",[]).unwrap();
        let second=source(); let next=store.prepare_migration(second.clone()).unwrap();
        assert_ne!(next["planId"],plan["planId"]);
        store.commit_migration(next["planId"].as_str().unwrap(),&second).unwrap();
        let root_path=root.join("managed-vaults");
        let saved_plan=fs::read(root_path.join("migration-plan.json")).unwrap();
        // Simulate a changed legacy projection without the managed publication bridge.
        raw.execute("UPDATE note_cache SET content='new legacy body' WHERE desktop_instance_id='i' AND vault_id='a'",[]).unwrap();
        let changed=source();
        assert_eq!(store.prepare_migration(changed).unwrap_err(),"VAULT_MIGRATION_RECOVERY_CONFLICT");
        assert_eq!(fs::read(root_path.join("migration-plan.json")).unwrap(),saved_plan);
        assert_eq!(store.migration_status().unwrap()["state"],"prepared");
        drop(raw);drop(db);fs::remove_dir_all(root).unwrap();
    }

}
