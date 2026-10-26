//! Explicit managed-vault commands. No migration runs on startup or list access.
use crate::{
    managed_vault::{self, Store},
    with_db, SharedState,
};
use serde_json::{json, Value};
use tauri::{Manager, State};
fn store(app: &tauri::AppHandle) -> Result<Store, String> {
    Store::new(&app.path().app_data_dir().map_err(|e| e.to_string())?)
}
fn source(db: &crate::db::Db) -> Result<Value, String> {
    let mut notes = Vec::new();
    let mut history = serde_json::Map::new();
    for entry in db.note_link_catalog()? {
        let note = db
            .note_get(&entry.note_id)?
            .ok_or("VAULT_MIGRATION_SOURCE_CHANGED")?;
        history.insert(entry.note_id, json!(entry.historical_names));
        notes.push(note);
    }
    Ok(json!({"version":1,"notes":notes,"folders":db.note_folders()?,"history":history,"replicas":db.managed_migration_snapshot()?}))
}
#[tauri::command]
pub(crate) fn managed_vault_create(app: tauri::AppHandle, state: State<'_, SharedState>, name: Option<String>, request_id: String) -> Result<Value, String> {
    with_db(&state, |db| {
        db.managed_recover()?;
        let _g = managed_vault::lock()?;
        store(&app)?.create_vault(name.as_deref().unwrap_or("笔记"), &request_id)
    })
}

/// User-confirmed enrollment. Reuse the existing current-pair, scope-protocol,
/// read-permission and offline preparation admission; a binding grants no ACL.
#[tauri::command]
pub(crate) async fn managed_vault_sync_to_phone(app: tauri::AppHandle, state: State<'_, SharedState>, instance: String, vault: String) -> Result<Value, String> {
    // An already registered local copy needs no second network admission.
    // This also makes retry-after-response-loss work offline, without resetting
    // preparation generations, resuming pauses, or granting fresh write access.
    let existing = with_db(&state, |db| {
        if db.paired()?.is_none_or(|p| p.instance_id != instance) { return Err("CONTENT_SOURCE_CHANGED".into()); }
        db.managed_recover()?;
        // Historical cache migration could register a binding without the
        // user's download confirmation. Such a scope still needs admission.
        if !db.offline_selected(&instance, &vault)? { return Ok(None); }
        let _g = managed_vault::lock()?;
        let list = store(&app)?.list()?;
        let matches: Vec<Value> = list["items"].as_array().ok_or("VAULT_REGISTRY_INVALID")?.iter()
            .filter(|row| row["binding"]["instanceId"] == instance && row["binding"]["remoteVaultId"] == vault)
            .cloned().collect();
        if matches.len() > 1 { return Err("MANAGED_SYNC_BINDING_AMBIGUOUS".into()); }
        Ok(matches.into_iter().next())
    })?;
    if let Some(existing) = existing { return Ok(existing); }
    crate::content::notes::offline::content_offline_control(state.clone(), instance.clone(), vault.clone(), "start".into()).await?;
    with_db(&state, |db| {
        if db.paired()?.is_none_or(|p| p.instance_id != instance) { return Err("CONTENT_SOURCE_CHANGED".into()); }
        if !db.offline_selected(&instance, &vault)? { return Err("CONTENT_OFFLINE_NOT_SELECTED".into()); }
        db.managed_recover()?;
        let _g = managed_vault::lock()?;
        db.managed_enroll_scope(&store(&app)?, &instance, &vault)
    })
}

#[tauri::command]
pub(crate) fn managed_vault_list(
    app: tauri::AppHandle,
    state: State<'_, SharedState>,
) -> Result<Value, String> {
    with_db(&state, |db| {
        db.managed_recover()?;
        let _g = managed_vault::lock()?;
        store(&app)?.list()
    })
}
#[tauri::command]
pub(crate) fn managed_vault_select(
    app: tauri::AppHandle,
    state: State<'_, SharedState>,
    local_vault_id: String,
) -> Result<(), String> {
    with_db(&state, |db| {
        db.managed_recover()?;
        let _g = managed_vault::lock()?;
        store(&app)?.select(&local_vault_id)
    })
}
#[tauri::command]
pub(crate) fn managed_vault_migration_status(
    app: tauri::AppHandle,
    state: State<'_, SharedState>,
) -> Result<Value, String> {
    with_db(&state, |db| {
        db.managed_recover()?;
        let _g = managed_vault::lock()?;
        store(&app)?.migration_status()
    })
}
#[tauri::command]
pub(crate) fn managed_vault_migration_prepare(
    app: tauri::AppHandle,
    state: State<'_, SharedState>,
) -> Result<Value, String> {
    with_db(&state, |db| {
        db.managed_recover()?;
        let _g = managed_vault::lock()?;
        store(&app)?.prepare_migration(source(db)?)
    })
}
#[tauri::command]
pub(crate) fn managed_vault_migration_commit(
    app: tauri::AppHandle,
    state: State<'_, SharedState>,
    plan_id: String,
) -> Result<Value, String> {
    with_db(&state, |db| {
        db.managed_recover()?;
        let _g = managed_vault::lock()?;
        let store = store(&app)?;
        store.commit_migration(&plan_id, &source(db)?)?;
        db.managed_migrate_replicas()?;
        store.complete_migration(&plan_id, &source(db)?)
    })
}
#[tauri::command]
pub(crate) fn managed_vault_note_list(
    app: tauri::AppHandle,
    state: State<'_, SharedState>,
    query: Value,
) -> Result<Value, String> {
    with_db(&state, |db| {
        db.managed_recover()?;
        let _g = managed_vault::lock()?;
        store(&app)?.notes(&query)
    })
}
#[tauri::command]
pub(crate) fn managed_vault_note_get(
    app: tauri::AppHandle,
    state: State<'_, SharedState>,
    local_vault_id: String,
    note_id: String,
) -> Result<managed_vault::Note, String> {
    with_db(&state, |db| {
        db.managed_recover()?;
        let _g = managed_vault::lock()?;
        store(&app)?.get(&local_vault_id, &note_id)
    })
}
#[tauri::command]
pub(crate) fn managed_vault_note_create(
    app: tauri::AppHandle,
    state: State<'_, SharedState>,
    local_vault_id: String,
    title: String,
    content: String,
    tags: Vec<String>,
    folder: String,
) -> Result<managed_vault::Note, String> {
    with_db(&state, |db| {
        db.managed_recover()?;
        let store = store(&app)?;
        let bound = {
            let _g = managed_vault::lock()?;
            store.manifest(&local_vault_id)?.binding.is_some()
        };
        if bound {
            db.managed_create_bound(&store, &local_vault_id, &title, &content, tags, &folder)
        } else {
            let _g = managed_vault::lock()?;
            store.create(&local_vault_id, &title, &content, tags, &folder)
        }
    })
}
#[tauri::command]
pub(crate) fn managed_vault_note_save(
    app: tauri::AppHandle,
    state: State<'_, SharedState>,
    local_vault_id: String,
    note_id: String,
    expected_revision: String,
    title: String,
    content: String,
    tags: Vec<String>,
) -> Result<managed_vault::Note, String> {
    with_db(&state, |db| {
        db.managed_recover()?;
        let store = store(&app)?;
        let bound = {
            let _g = managed_vault::lock()?;
            store.manifest(&local_vault_id)?.binding.is_some()
        };
        if bound {
            db.managed_save_bound(
                &store,
                &local_vault_id,
                &note_id,
                &expected_revision,
                &title,
                &content,
                tags,
            )
        } else {
            let _g = managed_vault::lock()?;
            store.save(
                &local_vault_id,
                &note_id,
                &expected_revision,
                &title,
                &content,
                tags,
            )
        }
    })
}
#[tauri::command]
pub(crate) async fn managed_vault_note_move(
    app: tauri::AppHandle,
    state: State<'_, SharedState>,
    local_vault_id: String,
    note_id: String,
    expected_revision: String,
    folder: String,
) -> Result<managed_vault::Note, String> {
    let prepared = with_db(&state, |db| {
        db.managed_recover()?;
        let store = store(&app)?;
        let bound = {
            let _g = managed_vault::lock()?;
            store.manifest(&local_vault_id)?.binding.is_some()
        };
        if bound {
            db.managed_move_prepare(
                &store,
                &local_vault_id,
                &note_id,
                &expected_revision,
                &folder,
            )
            .map(Some)
        } else {
            let _g = managed_vault::lock()?;
            store.move_note(&local_vault_id, &note_id, &expected_revision, &folder)?;
            Ok(None)
        }
    })?;
    // The immutable move is durably staged and rendered locally. The single
    // background sync owner sends it, even after navigation or disconnection.
    let _ = prepared;
    with_db(&state, |db| {
        db.managed_recover()?;
        let _g = managed_vault::lock()?;
        store(&app)?.get(&local_vault_id, &note_id)
    })
}
#[tauri::command]
pub(crate) async fn managed_vault_note_trash(
    app: tauri::AppHandle,
    state: State<'_, SharedState>,
    local_vault_id: String,
    note_id: String,
    expected_revision: String,
) -> Result<(), String> {
    let _sync = crate::content::notes::SYNC_GATE
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    with_db(&state, |db| {
        db.managed_recover()?;
        let binding = {
            let _g = managed_vault::lock()?;
            let store = store(&app)?;
            let note = store.get(&local_vault_id, &note_id)?;
            if note.revision != expected_revision {
                return Err("VAULT_REVISION_CONFLICT".into());
            }
            let binding = store.writable_manifest(&local_vault_id)?.binding;
            if binding.is_none() {
                store.trash(&local_vault_id, &note_id, &expected_revision)?;
            }
            binding
        };
        if let Some(binding) = binding {
            db.content_delete(&binding.instance_id, &binding.remote_vault_id, &note_id)?;
        }
        Ok(())
    })
}
#[tauri::command]
pub(crate) fn managed_vault_note_flags(
    app: tauri::AppHandle,
    state: State<'_, SharedState>,
    local_vault_id: String,
    note_id: String,
    expected_revision: String,
    flags: Value,
) -> Result<managed_vault::Note, String> {
    with_db(&state, |db| {
        db.managed_recover()?;
        let _g = managed_vault::lock()?;
        store(&app)?.flags(&local_vault_id, &note_id, &expected_revision, &flags)
    })
}
#[tauri::command]
pub(crate) fn managed_vault_folders(
    app: tauri::AppHandle,
    state: State<'_, SharedState>,
    local_vault_id: String,
) -> Result<Value, String> {
    with_db(&state, |db| {
        db.managed_recover()?;
        let _g = managed_vault::lock()?;
        store(&app)?.folders(&local_vault_id)
    })
}
#[tauri::command]
pub(crate) fn managed_vault_folder_create(
    app: tauri::AppHandle,
    state: State<'_, SharedState>,
    local_vault_id: String,
    name: String,
    parent: String,
) -> Result<Value, String> {
    with_db(&state, |db| {
        db.managed_recover()?;
        let store = store(&app)?;
        let bound = { let _g = managed_vault::lock()?; store.manifest(&local_vault_id)?.binding.is_some() };
        if bound { db.managed_folder_create(&store, &local_vault_id, &name, &parent) }
        else { let _g = managed_vault::lock()?; store.folder_create(&local_vault_id, &name, &parent) }
    })
}
#[tauri::command]
pub(crate) fn managed_vault_link_catalog(
    app: tauri::AppHandle,
    state: State<'_, SharedState>,
    local_vault_id: String,
) -> Result<Value, String> {
    with_db(&state, |db| {
        db.managed_recover()?;
        let _g = managed_vault::lock()?;
        store(&app)?.catalog(&local_vault_id)
    })
}
#[tauri::command]
pub(crate) fn managed_vault_resolve_legacy(
    app: tauri::AppHandle,
    state: State<'_, SharedState>,
    legacy_route: String,
) -> Result<Value, String> {
    with_db(&state, |db| {
        db.managed_recover()?;
        let _g = managed_vault::lock()?;
        store(&app)?.resolve(&legacy_route)
    })
}

/// Explicit user-requested retry for a metadata-only replica. Ordinary get,
/// list, graph and search remain local and never initiate network requests.
#[tauri::command]
pub(crate) async fn managed_vault_note_hydrate(
    app: tauri::AppHandle,
    state: State<'_, SharedState>,
    local_vault_id: String,
    note_id: String,
) -> Result<managed_vault::Note, String> {
    let binding = with_db(&state, |db| {
        db.managed_recover()?;
        let _gate = managed_vault::lock()?;
        let store = store(&app)?;
        store.get(&local_vault_id, &note_id)?;
        store
            .manifest(&local_vault_id)?
            .binding
            .ok_or("VAULT_BINDING_REQUIRED".into())
    })?;
    crate::content::notes::content_note_refresh(
        state.clone(),
        binding.instance_id,
        binding.remote_vault_id,
        note_id.clone(),
    )
    .await?;
    with_db(&state, |db| {
        db.managed_recover()?;
        let _gate = managed_vault::lock()?;
        store(&app)?.get(&local_vault_id, &note_id)
    })
}

#[tauri::command]
pub(crate) fn managed_vault_sync_targets(
    app: tauri::AppHandle,
    state: State<'_, SharedState>,
    instance: String,
) -> Result<Value, String> {
    with_db(&state, |db| {
        db.managed_sync_targets(&store(&app)?, &instance)
    })
}

#[tauri::command]
pub(crate) fn managed_vault_rebuild_preview(app:tauri::AppHandle,state:State<'_,SharedState>,local_vault_id:String)->Result<Value,String>{
    with_db(&state,|db|db.managed_rebuild_preview(&store(&app)?,&local_vault_id))
}
#[tauri::command]
pub(crate) fn managed_vault_rebuild_projection(app:tauri::AppHandle,state:State<'_,SharedState>,local_vault_id:String,checkpoint_hash:String)->Result<Value,String>{
    with_db(&state,|db|db.managed_rebuild(&store(&app)?,&local_vault_id,&checkpoint_hash))
}
#[tauri::command]
pub(crate) fn managed_vault_transfer_preview(app:tauri::AppHandle,state:State<'_,SharedState>,source_vault_id:String,target_vault_id:String)->Result<Value,String>{
    with_db(&state,|db|crate::managed_vault_transfer::preview(db,&store(&app)?,&source_vault_id,&target_vault_id))
}
#[tauri::command]
pub(crate) async fn managed_vault_transfer_commit(app:tauri::AppHandle,state:State<'_,SharedState>,source_vault_id:String,target_vault_id:String,snapshot_hash:String,wiki_proofs:Option<Value>)->Result<Value,String>{
    crate::content::notes::linked_import::commit(&state,&store(&app)?,&source_vault_id,&target_vault_id,&snapshot_hash,wiki_proofs).await
}
