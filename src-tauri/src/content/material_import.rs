//! Phone picker -> explicitly selected Desktop library, via canonical ingest.
//! No local asset is created, no legacy capture fallback, no new authorization.
use super::*;
use std::io::Read;

const MAX_UPLOAD_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CHUNK_BYTES: usize = 262_144;

trait ImportWire: Sync {
    fn json(&self, method: &str, path: &str, body: &Value) -> impl std::future::Future<Output = Result<Value, String>> + Send;
    fn chunk(&self, path: &str, offset: u64, bytes: &[u8]) -> impl std::future::Future<Output = Result<Value, String>> + Send;
    fn check(&self) -> Result<(), String>;
}

struct PinnedImport<'a> { gateway: ExpectedGateway, state: &'a SharedState }

// Fixed phases and bounded identifiers only: never log file names, paths,
// request bodies, job IDs, server messages or authorization material.
fn diagnostic_code(value: &str) -> &str {
    let code = value.split(|c: char| c.is_whitespace() || c == ':').next().unwrap_or("");
    if (2..=80).contains(&code.len()) && code.bytes().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_') { code } else { "MATERIAL_IMPORT_FAILED" }
}

fn observed(phase: &str, result: Result<(u16, Value), String>) -> Result<Value, String> {
    match result {
        Ok((status, value)) => {
            let code = if (200..300).contains(&status) { "OK" } else { diagnostic_code(value["code"].as_str().unwrap_or("MATERIAL_IMPORT_FAILED")) };
            println!("[LRMaterialImport] phase={phase} http={status} code={code}");
            accepted(status, value)
        }
        Err(error) => {
            println!("[LRMaterialImport] phase={phase} http=none code={}", diagnostic_code(&error));
            Err(error)
        }
    }
}

fn accepted(status: u16, value: Value) -> Result<Value, String> {
    if (200..300).contains(&status) { return Ok(value); }
    let code = value["code"].as_str().filter(|s| s.len() <= 80 && s.bytes().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')).unwrap_or("MATERIAL_IMPORT_FAILED");
    Err(format!("{code} ({status})"))
}

impl ImportWire for PinnedImport<'_> {
    async fn json(&self, method: &str, path: &str, body: &Value) -> Result<Value, String> {
        let phase = if method == "GET" { "catalog" } else if path.ends_with("/complete") { "complete" } else { "begin" };
        let result = if method == "GET" {
            self.gateway.services_request(self.state, method, path, false, &Value::Null).await
        } else {
            self.gateway.services_request_json(self.state, method, path, body).await
        };
        observed(phase, result)
    }
    async fn chunk(&self, path: &str, offset: u64, bytes: &[u8]) -> Result<Value, String> {
        let headers = vec![("x-chunk-offset".to_owned(), offset.to_string()), ("x-chunk-sha256".to_owned(), format!("{:x}", Sha256::digest(bytes)))];
        let result = self.gateway.services_request_with_chunk(self.state, "PUT", path, bytes, &headers).await;
        observed("chunk", result)
    }
    fn check(&self) -> Result<(), String> { self.gateway.source.verify_owner(self.state) }
}

fn import_limits(catalog: &Value, instance: &str) -> Result<(u64, usize), String> {
    if catalog["catalogVersion"] != 1 || catalog["desktopInstanceId"] != instance { return Err("CONTENT_UPGRADE_REQUIRED".into()); }
    for operation in ["ingest.begin", "ingest.status", "ingest.chunk", "ingest.complete"] {
        match catalog["operations"][operation]["state"].as_str() {
            Some("implemented") => (),
            Some("notGranted") => return Err("MATERIAL_IMPORT_NOT_GRANTED".into()),
            Some("temporarilyUnavailable") => return Err("MATERIAL_IMPORT_UNAVAILABLE".into()),
            _ => return Err("CONTENT_UPGRADE_REQUIRED".into()),
        }
    }
    let max = catalog["limits"]["uploadBytes"].as_u64().filter(|n| *n > 0).ok_or("CONTENT_UPGRADE_REQUIRED")?.min(MAX_UPLOAD_BYTES);
    let chunk = catalog["limits"]["uploadChunkBytes"].as_u64().filter(|n| *n > 0).ok_or("CONTENT_UPGRADE_REQUIRED")?.min(MAX_CHUNK_BYTES as u64) as usize;
    Ok((max, chunk))
}

fn job_id(value: &Value, op_id: &str, total: u64) -> Result<String, String> {
    let id = value["jobId"].as_str().ok_or("MATERIAL_IMPORT_INVALID_RECEIPT")?;
    public_id(id)?;
    if value["opId"] != op_id || !matches!(value["state"].as_str(), Some("staging" | "completed")) || value["committedBytes"].as_u64().filter(|n| *n <= total).is_none() {
        return Err("MATERIAL_IMPORT_INVALID_RECEIPT".into());
    }
    Ok(id.to_owned())
}

async fn transfer(wire: &impl ImportWire, media: &crate::capture_media::CaptureMedia, folder: Option<&str>, kind: &str, op_id: &str, limits: (u64, usize)) -> Result<Value, String> {
    if media.size_bytes == 0 || media.size_bytes > limits.0 { return Err("PAYLOAD_TOO_LARGE".into()); }
    if media.file_name.is_empty() || media.file_name.chars().any(|c| c.is_control() || c == '/' || c == '\\') || matches!(media.file_name.as_str(), "." | "..") { return Err("CONTENT_INPUT_INVALID".into()); }
    crate::capture_media::validate_attachment_file(&media.local_uri, media.size_bytes as i64, &media.sha256).map_err(|_| "MATERIAL_IMPORT_FILE_CHANGED")?;
    wire.check()?;
    let manifest = json!({ "opId": op_id, "kind": kind, "target": { "domain": "materials", "folderId": folder }, "name": media.file_name, "mimeType": media.mime, "sizeBytes": media.size_bytes, "sha256": media.sha256, "source": { "captureKind": "import" } });
    let mut job = wire.json("POST", "/v1/services/ingest/jobs", &manifest).await?;
    let id = job_id(&job, op_id, media.size_bytes)?;
    let mut offset = job["committedBytes"].as_u64().ok_or("MATERIAL_IMPORT_INVALID_RECEIPT")?;
    if job["state"] == "staging" {
        use std::io::{Seek, SeekFrom};
        let mut file = std::fs::File::open(&media.local_uri).map_err(|_| "MATERIAL_IMPORT_FILE_CHANGED")?;
        file.seek(SeekFrom::Start(offset)).map_err(|_| "MATERIAL_IMPORT_FILE_CHANGED")?;
        while offset < media.size_bytes {
            wire.check()?;
            let want = (media.size_bytes - offset).min(limits.1 as u64) as usize;
            let mut bytes = vec![0; want];
            file.read_exact(&mut bytes).map_err(|_| "MATERIAL_IMPORT_FILE_CHANGED")?;
            job = wire.chunk(&format!("/v1/services/ingest/jobs/{id}/chunks"), offset, &bytes).await?;
            if job_id(&job, op_id, media.size_bytes)? != id || job["committedBytes"].as_u64() != Some(offset + want as u64) { return Err("MATERIAL_IMPORT_INVALID_RECEIPT".into()); }
            offset += want as u64;
        }
        // The picker file must still be the exact manifest before publication.
        crate::capture_media::validate_attachment_file(&media.local_uri, media.size_bytes as i64, &media.sha256).map_err(|_| "MATERIAL_IMPORT_FILE_CHANGED")?;
        job = wire.json("POST", &format!("/v1/services/ingest/jobs/{id}/complete"), &json!({})).await?;
    }
    wire.check()?;
    if job_id(&job, op_id, media.size_bytes)? != id || job["state"] != "completed" || job["committedBytes"].as_u64() != Some(media.size_bytes) || job["receipt"]["domain"] != "materials" { return Err("MATERIAL_IMPORT_INVALID_RECEIPT".into()); }
    let asset_id = job["receipt"]["assetId"].as_str().ok_or("MATERIAL_IMPORT_INVALID_RECEIPT")?;
    public_id(asset_id)?;
    if job["receipt"]["revision"].as_str().filter(|s| !s.is_empty()).is_none() { return Err("MATERIAL_IMPORT_INVALID_RECEIPT".into()); }
    Ok(json!({ "assetId": asset_id, "revision": job["receipt"]["revision"], "name": media.file_name, "sizeBytes": media.size_bytes, "sha256": media.sha256, "completed": true }))
}

#[tauri::command]
pub(crate) async fn content_material_import(state: State<'_, SharedState>, instance: String, library: String, folder: Option<String>, kind: String) -> Result<Value, String> {
    public_id(&instance)?; public_id(&library)?;
    if let Some(folder) = folder.as_deref() { public_id(folder)?; }
    let picker = match kind.as_str() { "image" => 0, "video" => 3, "file" => 2, _ => return Err("CONTENT_INPUT_INVALID".into()) };
    let wire = PinnedImport { gateway: expected_scoped_gateway(&state, &instance, Some(&library), None)?, state: &state };
    let catalog = wire.json("GET", "/v1/services", &Value::Null).await?;
    let limits = import_limits(&catalog, &instance)?;
    // Capture BEFORE the picker: returning from Android may not change the owner
    // or library to which this upload belongs.
    let media = match crate::capture_media::pick(picker, 300_000) {
        Ok(media) => media,
        Err(error) if crate::capture_media::is_user_cancelled_error(&error) => return Ok(json!({"cancelled":true})),
        Err(_) => { println!("[LRMaterialImport] phase=picker http=none code=MATERIAL_IMPORT_PICK_FAILED"); return Err("MATERIAL_IMPORT_PICK_FAILED".into()); },
    };
    let op_id = Uuid::new_v4().to_string();
    let result = transfer(&wire, &media, folder.as_deref(), &kind, &op_id, limits).await;
    if let Err(error) = &result { println!("[LRMaterialImport] phase=final http=none code={}", diagnostic_code(error)); }
    // Only our app-private picker copy. Never the user's original media.
    let _ = crate::capture_media::remove_private_attachment_if_managed(&media.local_uri);
    let mut receipt = result?;
    receipt["instance"] = json!(instance); receipt["libraryId"] = json!(library); receipt["folderId"] = json!(folder);
    Ok(receipt)
}

#[cfg(test)]
mod tests;
