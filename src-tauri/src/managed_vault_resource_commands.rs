//! Verified offline projection into the existing narrowly allowed cache protocol.
use crate::{
    managed_vault::{self, Store},
    managed_vault_resources, SharedState,
};
use serde_json::{json, Value};
use std::io::Read;
use tauri::{Manager, State};
#[tauri::command]
pub(crate) fn managed_vault_resource_get(
    app: tauri::AppHandle,
    state: State<'_, SharedState>,
    local_vault_id: String,
    note_id: String,
    expected_revision: String,
    target: String,
) -> Result<Value, String> {
    crate::with_db(&state, |db| {
        db.managed_recover()?;
        let _g = managed_vault::lock()?;
        let store = Store::new(&app.path().app_data_dir().map_err(|_| "VAULT_UNAVAILABLE")?)?;
        if store.get(&local_vault_id, &note_id)?.revision != expected_revision {
            return Err("VAULT_REVISION_CONFLICT".into());
        }
        let mut resource =
            managed_vault_resources::resolve(&store, &local_vault_id, &note_id, &target)?;
        // Resolver already verified owned authoritative bytes. Verify again after read
        // so projection never relies solely on existence, size, or stale metadata.
        let mut bytes = Vec::new();
        std::fs::File::open(resource["path"].as_str().ok_or("VAULT_RESOURCE_MISSING")?)
            .map_err(|_| "VAULT_RESOURCE_MISSING")?
            .take(managed_vault_resources::MAX_RESOURCE + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "VAULT_RESOURCE_MISSING")?;
        let sha = resource["sha256"]
            .as_str()
            .ok_or("VAULT_RESOURCE_UNVERIFIED")?;
        managed_vault_resources::verify(
            &bytes,
            sha,
            resource["sizeBytes"]
                .as_u64()
                .ok_or("VAULT_RESOURCE_UNVERIFIED")?,
        )?;
        let root = app
            .path()
            .app_cache_dir()
            .map_err(|_| "CONTENT_CACHE_UNAVAILABLE")?
            .join("content-resources");
        let rel = format!(
            "managed/{}/{}/{}.bin",
            managed_vault::hash(local_vault_id.as_bytes()),
            managed_vault::hash(note_id.as_bytes()),
            sha
        );
        managed_vault::write_atomic(&root, &rel, &bytes)?;
        resource["path"] = json!(managed_vault::guarded(&root, &rel)?);
        Ok(resource)
    })
}

/// User-triggered offline open, preserving the existing narrow content:// grant.
#[tauri::command]
pub(crate) fn managed_vault_resource_open(
    app: tauri::AppHandle,
    state: State<'_, SharedState>,
    local_vault_id: String,
    note_id: String,
    expected_revision: String,
    target: String,
) -> Result<Value, String> {
    let resource = managed_vault_resource_get(
        app,
        state,
        local_vault_id,
        note_id,
        expected_revision,
        target,
    )?;
    crate::companion_export::open_content_cache(
        resource["path"].as_str().ok_or("VAULT_RESOURCE_MISSING")?,
        resource["mime"]
            .as_str()
            .unwrap_or("application/octet-stream"),
    )
}
