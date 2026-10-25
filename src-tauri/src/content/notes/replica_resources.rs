//! One bounded manifest/resource preparation step owned by the existing sync gate.
//! Never invoked by editor reads, and never opens an external media URL.
use super::*;
use crate::{
    managed_vault::{self, Note, Store},
    managed_vault_resources::{self as resources, Replica},
};
use std::{fs, io::Read, path::Path};
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
fn selected(store: &Store, instance: &str, vault: &str) -> Result<Option<(String, Note)>, String> {
    let mut candidates = Vec::new();
    for row in store.list()?["items"]
        .as_array()
        .ok_or("VAULT_REGISTRY_INVALID")?
    {
        let local = row["localVaultId"]
            .as_str()
            .ok_or("VAULT_REGISTRY_INVALID")?;
        let m = store.manifest(local)?;
        if !m
            .binding
            .as_ref()
            .is_some_and(|b| b.instance_id == instance && b.remote_vault_id == vault)
        {
            continue;
        }
        for n in m.notes.values() {
            if !n.trashed
                && n.body_state == "ready"
                && n.sync_state == "synced"
                && n.remote["revision"].as_str().is_some_and(|s| !s.is_empty())
                && n.remote["replica"]["retryAfterMs"].as_u64().unwrap_or(0) <= now()
            {
                candidates.push((local.to_owned(), n.clone()));
            }
        }
    }
    candidates.sort_by_key(|(_, n)| n.remote["replica"]["checkedAtMs"].as_u64().unwrap_or(0));
    Ok(candidates.into_iter().next())
}
fn owned_cached_bytes(
    app: &tauri::AppHandle,
    receipt: &Value,
    r: &resources::Resource,
) -> Result<Vec<u8>, String> {
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|_| "CONTENT_CACHE_UNAVAILABLE")?
        .join("content-resources");
    let path = Path::new(receipt["path"].as_str().ok_or("CONTENT_NOT_CACHED")?);
    let rel = path
        .strip_prefix(&root)
        .map_err(|_| "CONTENT_NOT_CACHED")?
        .to_str()
        .ok_or("CONTENT_NOT_CACHED")?;
    let path = managed_vault::guarded(&root, rel)?;
    let size = r
        .size_bytes
        .filter(|n| *n <= resources::MAX_RESOURCE)
        .ok_or("VAULT_REPLICA_INVALID")?;
    let meta = fs::metadata(&path).map_err(|_| "CONTENT_NOT_CACHED")?;
    if !meta.is_file() || meta.len() != size {
        return Err("VAULT_RESOURCE_HASH_MISMATCH".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| "CONTENT_NOT_CACHED")?
        .take(size + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "CONTENT_NOT_CACHED")?;
    resources::verify(
        &bytes,
        r.sha256.as_deref().ok_or("VAULT_REPLICA_INVALID")?,
        size,
    )?;
    Ok(bytes)
}
pub(super) async fn prepare_one(
    source: &Source,
    state: State<'_, SharedState>,
    app: &tauri::AppHandle,
    vault: &str,
    caps: &Value,
) -> Result<bool, String> {
    if !resources::supported(caps) {
        return Ok(false);
    }
    let data = app.path().app_data_dir().map_err(|_| "VAULT_UNAVAILABLE")?;
    // Do not create a vault or adopt legacy data merely because sync ran.
    if !data.join("managed-vaults/registry.json").exists() {
        return Ok(false);
    }
    let store = Store::new(&data)?;
    let job = source.with_db(&state, |db| {
        db.managed_recover()?;
        let _g = managed_vault::lock()?;
        selected(&store, &source.instance, vault)
    })?;
    let Some((local, note)) = job else {
        return Ok(false);
    };
    let result = tokio::time::timeout(std::time::Duration::from_secs(15), async {
        source.check(&state)?;
        let (status, value) = source
            .gateway
            .content_request(
                reqwest::Method::GET,
                &format!(
                    "/v1/notes/{}/replica-manifest?vault={}",
                    encode(&note.note_id),
                    encode(vault)
                ),
                None,
            )
            .await?;
        source.check(&state)?;
        if status != 200 {
            return Err(format!("CONTENT_REPLICA_HTTP_{status}"));
        }
        let replica: Replica =
            serde_json::from_value(value).map_err(|_| "VAULT_REPLICA_INVALID")?;
        let missing = source.with_db(&state, |db| {
            db.managed_recover()?;
            let _g = managed_vault::lock()?;
            let current = store.get(&local, &note.note_id)?;
            if current.body_state != "ready"
                || current.sync_state != "synced"
                || current.revision != note.revision
            {
                return Err("VAULT_REPLICA_REVISION_CHANGED".into());
            }
            replica.validate(
                vault,
                &note.note_id,
                note.remote["revision"]
                    .as_str()
                    .ok_or("VAULT_REPLICA_INVALID")?,
                current
                    .content
                    .as_deref()
                    .ok_or("VAULT_BODY_MISSING")?
                    .as_bytes(),
            )?;
            let root = store.vault_root(&local)?;
            Ok(replica
                .resources
                .iter()
                .find(|r| {
                    r.required
                        && r.status == "verified"
                        && resources::read_verified(&root, &note.note_id, r).is_err()
                })
                .cloned())
        })?;
        let mut downloaded = None;
        if let Some(r) = &missing {
            // Cache receipts/ETags are never treated as content-hash proof.
            let cached = cached_resource(
                &state,
                app.clone(),
                source.instance.clone(),
                None,
                r.download_resource_id.clone(),
                Some(vault.into()),
                Some(note.note_id.clone()),
            )
            .await
            .ok();
            let bytes = if let Some(bytes) = cached
                .as_ref()
                .and_then(|v| owned_cached_bytes(app, v, r).ok())
            {
                bytes
            } else {
                source.check(&state)?;
                if cached.is_some() {
                    // A corrupt completed cache must not be revalidated forever by
                    // ETag/304. Quarantine only its transport pointer under the SAME
                    // download gate, retaining bytes and metadata for recovery.
                    let _gate = DOWNLOAD_GATE
                        .get_or_init(|| tokio::sync::Mutex::new(()))
                        .lock()
                        .await;
                    source.with_db(&state, |_| {
                        let root = app
                            .path()
                            .app_cache_dir()
                            .map_err(|_| "CONTENT_CACHE_UNAVAILABLE")?
                            .join("content-resources");
                        let key = managed_vault::hash(
                            format!(
                                "{}:note:{}:{}:{}",
                                source.instance, vault, note.note_id, r.download_resource_id
                            )
                            .as_bytes(),
                        );
                        let metadata = managed_vault::guarded(&root, &format!("{key}.json"))?;
                        if let Ok(raw) = fs::read(&metadata) {
                            let current: Value =
                                serde_json::from_slice(&raw).map_err(|_| "CONTENT_NOT_CACHED")?;
                            let old_name = cached
                                .as_ref()
                                .and_then(|v| v["path"].as_str())
                                .and_then(|p| Path::new(p).file_name())
                                .and_then(|n| n.to_str());
                            if current["fileName"].as_str() == old_name {
                                let retained = managed_vault::guarded(
                                    &root,
                                    &format!(
                                        "{key}.rejected-{}.json",
                                        uuid::Uuid::new_v4().simple()
                                    ),
                                )?;
                                fs::rename(metadata, retained)
                                    .map_err(|_| "CONTENT_CACHE_UNAVAILABLE")?;
                                managed_vault::sync_dir(&root)?;
                            }
                        }
                        Ok(())
                    })?;
                }
                let receipt = download_resource(
                    state.clone(),
                    app.clone(),
                    &source.instance,
                    None,
                    r.download_resource_id.clone(),
                    format!("replica-{}", uuid::Uuid::new_v4().simple()),
                    Some((vault.into(), note.note_id.clone())),
                    Some(resources::MAX_RESOURCE),
                    None,
                )
                .await?;
                source.check(&state)?;
                owned_cached_bytes(app, &receipt, r)?
            };
            downloaded = Some(bytes);
        }
        source.with_db(&state, |db| {
            db.managed_recover()?;
            let _g = managed_vault::lock()?;
            let more = resources::publish(
                &store,
                &local,
                &note,
                &replica,
                missing.as_ref().zip(downloaded.as_deref()),
                now(),
            )?;
            Ok(more || selected(&store, &source.instance, vault)?.is_some())
        })
    })
    .await
    .unwrap_or_else(|_| Err("CONTENT_REPLICA_TIMEOUT".into()));
    match result {
        Ok(more) => Ok(more),
        Err(e) if e == "CONTENT_SOURCE_CHANGED" => Err(e),
        Err(_) => {
            // Durable bounded retry; no extra timer, busy-loop, or failed body sync.
            source.with_db(&state, |db| {
                db.managed_recover()?;
                let _g = managed_vault::lock()?;
                let mut m = store.manifest(&local)?;
                if let Some(n) = m
                    .notes
                    .get_mut(&note.note_id)
                    .filter(|n| n.revision == note.revision && n.body_hash == note.body_hash)
                {
                    if !n.remote["replica"].is_object() {
                        n.remote["replica"] = json!({});
                    }
                    n.remote["replica"]["checkedAtMs"] = json!(now());
                    n.remote["replica"]["retryAfterMs"] = json!(now().saturating_add(30000));
                    n.remote["resourcesComplete"] = json!(false);
                    n.remote["resourceCompleteness"] = json!("deferred");
                    store.commit(m, std::collections::BTreeMap::new())?;
                }
                Ok(())
            })?;
            Ok(false)
        }
    }
}
