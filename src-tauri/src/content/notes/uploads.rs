use super::*;
use base64::Engine;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

#[tauri::command]
pub(crate) async fn content_note_attach(
    state: State<'_, SharedState>,
    app: tauri::AppHandle,
    instance: String,
    vault: String,
    id: String,
    kind: String,
) -> Result<Value, String> {
    public_id(&id)?;
    with_db(&state, |db| db.content_note(&instance, &vault, &id))?;
    let kind = match kind.as_str() {
        "image" => 0,
        "photo" => 1,
        "file" => 2,
        _ => return Err("CONTENT_ATTACHMENT_KIND_INVALID".into()),
    };
    let media = match tokio::task::spawn_blocking(move || crate::capture_media::pick(kind, 300_000))
        .await
        .map_err(|_| "CONTENT_PICKER_UNAVAILABLE")?
    {
        Ok(media) => media,
        Err(error) if error.to_lowercase().contains("cancel") => {
            return Ok(json!({"cancelled": true}))
        }
        Err(_) => return Err("CONTENT_PICKER_UNAVAILABLE".into()),
    };
    if media.size_bytes == 0 || media.size_bytes > 64 * 1024 * 1024 {
        return Err("CONTENT_ATTACHMENT_TOO_LARGE".into());
    }
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| "CONTENT_STORAGE_UNAVAILABLE")?
        .join("content-drafts");
    let op = uuid::Uuid::new_v4().to_string();
    let path = root.join(format!("attachment-{op}.bin"));
    std::fs::create_dir_all(&root).map_err(|_| "CONTENT_STORAGE_UNAVAILABLE")?;
    std::fs::copy(&media.local_uri, &path).map_err(|_| "CONTENT_STORAGE_UNAVAILABLE")?;
    std::fs::File::open(&path)
        .and_then(|f| f.sync_all())
        .map_err(|_| "CONTENT_STORAGE_UNAVAILABLE")?;
    let local_path = path.to_string_lossy().into_owned();
    crate::capture_media::validate_attachment_file(
        &local_path,
        media.size_bytes as i64,
        &media.sha256,
    )
    .map_err(|_| "CONTENT_ATTACHMENT_CHANGED")?;
    let note = with_db(&state, |db| {
        db.content_stage_attachment(
            &instance,
            &vault,
            &id,
            &op,
            &media.file_name,
            &media.mime,
            &local_path,
            media.size_bytes,
            &media.sha256,
        )
    })?;
    // Only the picker-owned temporary copy is removed, after the durable draft.
    let _ = std::fs::remove_file(&media.local_uri);
    Ok(json!({"cancelled": false, "note": note}))
}

async fn request(
    source: &Source,
    state: &SharedState,
    vault: &str,
    note: &str,
    path: &str,
    method: reqwest::Method,
    body: &Value,
) -> Result<Value, String> {
    let (status, result) = source.mutate(state, path, method, body).await?;
    source.check(state)?;
    if status == 200 {
        return Ok(result);
    }
    if status == 409 && result["code"] == "REVISION_CONFLICT" {
        let document = remote_note(source, vault, note).await?;
        source.with_db(state, |db| {
            db.content_conflict(&source.instance, vault, note, &document)
        })?;
    }
    Err(format!("CONTENT_ATTACHMENT_HTTP_{status}"))
}

pub(super) async fn upload_pending(
    source: &Source,
    state: &SharedState,
    vault: &str,
) -> Result<u64, String> {
    let rows = source.with_db(state, |db| {
        db.content_pending_attachments(&source.instance, vault)
    })?;
    let mut completed = 0;
    for row in rows {
        source.check(state)?;
        let get = |key: &str| row[key].as_str().ok_or("CONTENT_ATTACHMENT_INVALID");
        let id = get("noteId")?;
        let op = get("opId")?;
        let local_path = get("localPath")?;
        let size = row["sizeBytes"]
            .as_u64()
            .ok_or("CONTENT_ATTACHMENT_INVALID")?;
        crate::capture_media::validate_attachment_file(local_path, size as i64, get("sha256")?)
            .map_err(|_| "CONTENT_ATTACHMENT_CHANGED")?;
        let manifest = if row["manifest"].is_null() {
            let value = json!({"vaultId": vault, "expectedRevision": row["serverDocument"]["revision"],
                "name": row["name"], "mime": row["mime"], "sizeBytes": size, "sha256": row["sha256"]});
            source.with_db(state, |db| {
                db.content_upload_manifest(&source.instance, op, &value)
            })?;
            value
        } else {
            row["manifest"].clone()
        };
        let path = format!("/v1/notes/{id}/attachments/{op}");
        let mut status = request(
            source,
            state,
            vault,
            id,
            &path,
            reqwest::Method::POST,
            &manifest,
        )
        .await?;
        let mut offset = status["offset"]
            .as_u64()
            .filter(|n| *n <= size)
            .ok_or("CONTENT_UPLOAD_OFFSET_INVALID")?;
        if status["complete"] != true {
            let mut file = tokio::fs::File::open(local_path)
                .await
                .map_err(|_| "CONTENT_ATTACHMENT_MISSING")?;
            file.seek(std::io::SeekFrom::Start(offset))
                .await
                .map_err(|_| "CONTENT_ATTACHMENT_MISSING")?;
            let mut buffer = vec![0u8; 256 * 1024];
            while offset < size {
                source.check(state)?;
                let n = file
                    .read(&mut buffer[..(size - offset).min(256 * 1024) as usize])
                    .await
                    .map_err(|_| "CONTENT_ATTACHMENT_MISSING")?;
                if n == 0 {
                    return Err("CONTENT_ATTACHMENT_CHANGED".into());
                }
                let body = json!({"vaultId": vault, "offset": offset,
                    "data": base64::engine::general_purpose::STANDARD.encode(&buffer[..n]),
                    "sha256": format!("{:x}", Sha256::digest(&buffer[..n]))});
                status =
                    request(source, state, vault, id, &path, reqwest::Method::PUT, &body).await?;
                offset += n as u64;
                if status["opId"] != op || status["offset"].as_u64() != Some(offset) {
                    return Err("CONTENT_UPLOAD_OFFSET_INVALID".into());
                }
            }
            status = request(
                source,
                state,
                vault,
                id,
                &format!("{path}/complete"),
                reqwest::Method::POST,
                &json!({"vaultId": vault}),
            )
            .await?;
        }
        if status["opId"] != op || status["complete"] != true {
            return Err("CONTENT_ATTACHMENT_RECEIPT_INVALID".into());
        }
        source.with_db(state, |db| {
            db.content_attachment_receipt(&source.instance, vault, id, op, &status)
        })?;
        completed += 1;
    }
    Ok(completed)
}

/// Materialize only a durable attachment owned by this exact note into the
/// existing asset-protocol cache. This works offline; it grants no remote read.
#[tauri::command]
pub(crate) async fn content_note_local_attachment(
    state: State<'_, SharedState>, app: tauri::AppHandle,
    instance: String, vault: String, note: String, op: String,
) -> Result<Value, String> {
    for id in [&instance, &vault, &note, &op] { public_id(id)?; }
    let resource_authority = with_db(&state, |db| db.content_resource_authority())?;
    let epochs = scope_epochs(&instance)?;
    let (lifecycle, _) = connection_controls(&state);
    let connection_epoch = lifecycle.observe();
    let check = || -> Result<(), String> {
        if lifecycle.observe() != connection_epoch || scope_epochs(&instance)?.1 != epochs.1 { return Err("CONTENT_SOURCE_CHANGED".into()); }
        with_db(&state, |db| {
            if db.paired()?.is_none_or(|p| p.instance_id != instance) || db.content_resource_authority()? != resource_authority { return Err("CONTENT_SOURCE_CHANGED".into()); }
            Ok(())
        })
    };
    check()?;
    let saved = with_db(&state, |db| db.content_local_attachment_file(&instance, &vault, &note, &op))?;
    let resource_id = format!("local-attachment-{op}");
    if let Ok(cached) = crate::content::content_cached_resource(state.clone(), app.clone(), instance.clone(), None, resource_id.clone(), Some(vault.clone()), Some(note.clone())).await {
        if cached["etag"] == saved["sha256"] {
            with_db(&state, |db| db.content_local_attachment_file(&instance, &vault, &note, &op))?;
            check()?;
            return Ok(cached);
        }
    }
    let root = app.path().app_data_dir().map_err(|_| "CONTENT_NOT_CACHED")?.join("content-drafts")
        .canonicalize().map_err(|_| "CONTENT_NOT_CACHED")?;
    let source = std::path::PathBuf::from(saved["path"].as_str().ok_or("CONTENT_NOT_CACHED")?)
        .canonicalize().map_err(|_| "CONTENT_NOT_CACHED")?;
    if source.parent() != Some(root.as_path()) { return Err("CONTENT_NOT_CACHED".into()); }
    let size = saved["sizeBytes"].as_u64().filter(|n| *n > 0 && *n <= 64 * 1024 * 1024).ok_or("CONTENT_NOT_CACHED")?;
    let hash = saved["sha256"].as_str().filter(|s| s.len() == 64 && s.bytes().all(|c| c.is_ascii_hexdigit())).ok_or("CONTENT_NOT_CACHED")?;
    let metadata = tokio::fs::metadata(&source).await.map_err(|_| "CONTENT_NOT_CACHED")?;
    if !metadata.is_file() || metadata.len() != size { return Err("CONTENT_ATTACHMENT_CHANGED".into()); }
    let file = tokio::fs::File::open(&source).await.map_err(|_| "CONTENT_NOT_CACHED")?;
    let mut bytes = Vec::with_capacity(size as usize);
    file.take(size + 1).read_to_end(&mut bytes).await.map_err(|_| "CONTENT_NOT_CACHED")?;
    if bytes.len() as u64 != size || format!("{:x}", Sha256::digest(&bytes)) != hash { return Err("CONTENT_ATTACHMENT_CHANGED".into()); }
    check()?;
    // Recheck deletion/scope after I/O before making pixels readable.
    with_db(&state, |db| db.content_local_attachment_file(&instance, &vault, &note, &op))?;
    let key = format!("{:x}", Sha256::digest(format!("{instance}:note:{vault}:{note}:{resource_id}")));
    let cache = app.path().app_cache_dir().map_err(|_| "CONTENT_CACHE_UNAVAILABLE")?.join("content-resources");
    tokio::fs::create_dir_all(&cache).await.map_err(|_| "CONTENT_CACHE_UNAVAILABLE")?;
    let extension = match saved["mime"].as_str().unwrap_or("").split(';').next().unwrap_or("") {
        "image/jpeg" => "jpg", "image/png" => "png", "image/webp" => "webp", "image/gif" => "gif",
        "image/svg+xml" => "svg", "video/mp4" => "mp4", "audio/mpeg" => "mp3", "application/pdf" => "pdf", _ => "bin",
    };
    let filename = format!("{key}-{hash}.{extension}");
    let path = cache.join(&filename);
    let temp = cache.join(format!("{key}-{}.tmp", uuid::Uuid::new_v4()));
    tokio::fs::write(&temp, &bytes).await.map_err(|_| "CONTENT_CACHE_UNAVAILABLE")?;
    tokio::fs::rename(&temp, &path).await.map_err(|_| "CONTENT_CACHE_UNAVAILABLE")?;
    let metadata = json!({"resourceAuthority":resource_authority,"fileName":filename,"mime":saved["mime"],"etag":hash,"sizeBytes":size});
    let meta_temp = cache.join(format!("{key}-{}.json.tmp", uuid::Uuid::new_v4()));
    tokio::fs::write(&meta_temp, metadata.to_string()).await.map_err(|_| "CONTENT_CACHE_UNAVAILABLE")?;
    tokio::fs::rename(meta_temp, cache.join(format!("{key}.json"))).await.map_err(|_| "CONTENT_CACHE_UNAVAILABLE")?;
    check()?;
    Ok(json!({"path":path.to_string_lossy(),"mime":saved["mime"],"etag":hash,"sizeBytes":size,"cached":true}))
}
