//! Copy a saved local note into the existing Content V1 mutation queue.
use super::*;
async fn upload_target(source: &Source, state: &SharedState) -> Result<Value, String> {
    source.capabilities(state, "noteWrite").await?;
    let vaults = source.gateway.content_get("/v1/vaults").await?;
    let vault = vaults["items"].as_array().and_then(|items| items.first()).ok_or("CONTENT_VAULT_UNAVAILABLE")?;
    let id = vault["vaultId"].as_str().filter(|id| !id.is_empty()).ok_or("CONTENT_VAULT_UNAVAILABLE")?;
    source.with_db(state, |db| {
        db.content_vault_remember(&source.instance, id, vault["name"].as_str().unwrap_or(id))?;
        let mut dirs = db.content_note_directories(&source.instance, id)?["directories"].as_array().cloned().unwrap_or_default();
        dirs.insert(0, json!(""));
        Ok(json!({"instanceId":source.instance,"vaultId":id,"name":vault["name"].as_str().unwrap_or(id),"writeGranted":true,"directories":dirs}))
    })
}
#[tauri::command]
pub(crate) async fn content_local_note_upload_target(state: State<'_, SharedState>, instance: String, vault: Option<String>) -> Result<Value, String> {
    let source = Source::capture_expected(&state, &instance)?.scoped(None, vault.as_deref())?.knowledge();
    upload_target(&source, &state).await
}
#[tauri::command]
pub(crate) async fn content_local_note_upload(state: State<'_, SharedState>, instance: String, vault: String, note_id: String, parent_relative_path: Option<String>) -> Result<Value, String> {
    let _gate = SYNC_GATE.get_or_init(|| tokio::sync::Mutex::new(())).lock().await;
    let source = Source::capture_expected(&state, &instance)?.scoped(None, Some(&vault))?;
    let target = upload_target(&source, &state).await?;
    if target["vaultId"] != vault { return Err("CONTENT_VAULT_UNAVAILABLE".into()); }
    source.with_db(&state, |db| db.local_note_upload_stage(&instance, &vault, &note_id, parent_relative_path.as_deref().unwrap_or("")))
}
