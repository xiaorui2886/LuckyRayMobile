//! Android's existing picker persists receipt-backed legacy note IDs first.
//! Adoption is explicit and fenced to the selected managed vault; bound text
//! imports reuse the immutable scoped create queue and a durable receipt mapping.
use crate::{
    managed_vault::{self, Store},
    with_db, SharedState,
};
use tauri::{Manager, State};
#[tauri::command]
pub(crate) fn managed_vault_import_legacy_receipt(
    app: tauri::AppHandle,
    state: State<'_, SharedState>,
    local_vault_id: String,
    note_id: String,
    folder: Option<String>,
) -> Result<managed_vault::Note, String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    with_db(&state, |db| {
        db.managed_recover()?;
        let note = db
            .note_get(&note_id)?
            .ok_or("VAULT_IMPORT_SOURCE_MISSING")?;
        let folder=folder.as_deref().unwrap_or("");
        crate::managed_vault_folder_sync::safe_path(folder,true)?;
        let mut source = serde_json::to_value(&note).map_err(|e| e.to_string())?;
        source["folder"]=serde_json::json!(folder);
        let store = Store::new(&root)?;
        let bound = {
            let _guard = managed_vault::lock()?;
            if store.list()?["selectedVaultId"] != local_vault_id {
                return Err("VAULT_IMPORT_TARGET_CHANGED".into());
            }
            let alias = store.resolve(&note_id)?;
            if !alias.is_null() && alias["localVaultId"] != local_vault_id {
                return Err("VAULT_IMPORT_ALREADY_ADOPTED_ELSEWHERE".into());
            }
            store.manifest(&local_vault_id)?.binding.is_some()
        };
        if bound {
            let fingerprint =
                managed_vault::hash(&serde_json::to_vec(&source).map_err(|e| e.to_string())?);
            db.managed_import_bound(
                &store,
                &local_vault_id,
                &note_id,
                &fingerprint,
                &note.title,
                &note.content,
                note.tags,
                folder,
            )
        } else {
            let _guard = managed_vault::lock()?;
            store.import_legacy_receipt(&local_vault_id, &source)
        }
    })
}
