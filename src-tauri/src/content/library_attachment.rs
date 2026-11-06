//! Copy a selected, scoped material into the note's existing attachment store.
//! The renderer supplies identities, never paths, bytes or publication links.
use super::*;
use serde::Deserialize;
use std::io::{Read, Write};

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub(crate) enum AssetSource {
    Local { asset_id: String, version: String },
    Desktop { instance: String, library: Option<String>, asset_id: String, version: String },
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub(crate) enum NoteTarget {
    Managed { local_vault_id: String, note_id: String, expected_revision: String, from: usize, to: usize },
    Desktop { instance: String, vault: String, note_id: String, expected_content: String },
}
enum TargetProof {
    Managed(Option<crate::managed_vault::Binding>),
    Desktop(u64),
}
enum SourceProof {
    Local(crate::db::LocalAssetItem),
    Desktop { source: Source, asset_id: String, version: String, authority: i64 },
}
struct VerifiedAsset { name: String, mime: String, bytes: Vec<u8>, proof: SourceProof }

fn check_desktop_note(note: &Value, expected: &str) -> Result<(), String> {
    if note["deleted"] == true || note["pendingKind"] == "delete" || !note["conflictDocument"].is_null() || note["operationPaused"] == true {
        return Err("CONTENT_NOTE_UNAVAILABLE".into());
    }
    if note["content"].as_str() != Some(expected) { return Err("VAULT_REVISION_CONFLICT".into()); }
    Ok(())
}
fn target_proof(state: &SharedState, root: &std::path::Path, target: &NoteTarget) -> Result<TargetProof, String> {
    with_db(state, |db| match target {
        NoteTarget::Managed { local_vault_id, note_id, expected_revision, .. } => {
            db.managed_recover()?;
            let _gate = crate::managed_vault::lock()?;
            let store = crate::managed_vault::Store::new(root)?;
            let manifest = store.writable_manifest(local_vault_id)?;
            if store.get(local_vault_id, note_id)?.revision != *expected_revision { return Err("VAULT_REVISION_CONFLICT".into()); }
            Ok(TargetProof::Managed(manifest.binding))
        }
        NoteTarget::Desktop { instance, vault, note_id, expected_content } => {
            for id in [instance, vault, note_id] { public_id(id)?; }
            db.managed_scope_active(instance, vault)?;
            if db.paired()?.is_none_or(|p| p.instance_id != *instance) { return Err("CONTENT_SOURCE_CHANGED".into()); }
            check_desktop_note(&db.content_note(instance, vault, note_id)?, expected_content)?;
            Ok(TargetProof::Desktop(scope_epochs(instance)?.1))
        }
    })
}
fn read_limited(path: &std::path::Path, size: u64) -> Result<Vec<u8>, String> {
    let max = crate::managed_vault_resources::MAX_RESOURCE;
    if size == 0 || size > max { return Err("CONTENT_ATTACHMENT_TOO_LARGE".into()); }
    let mut bytes = Vec::with_capacity(size as usize);
    std::fs::File::open(path).map_err(|_| "CONTENT_ATTACHMENT_CHANGED")?.take(max + 1)
        .read_to_end(&mut bytes).map_err(|_| "CONTENT_ATTACHMENT_CHANGED")?;
    if bytes.len() as u64 != size { return Err("CONTENT_ATTACHMENT_CHANGED".into()); }
    Ok(bytes)
}
// Desktop Content V1 exposes the catalog's import-time SHA-256 in
// contentHash. Its ETag instead hashes ID, timestamp and file metadata; it is
// not a content digest. Never publish bytes without the selected digest.
fn selected_content_hash(version: &str, detail: &Value) -> Result<String, String> {
    let expected = version.split_once('|').map(|(hash, _)| hash).ok_or("CONTENT_VERSION_UNCONFIRMED")?;
    if expected.len() != 64 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) { return Err("CONTENT_VERSION_UNCONFIRMED".into()); }
    let reported = detail["contentHash"].as_str().ok_or("CONTENT_VERSION_UNCONFIRMED")?;
    if !reported.eq_ignore_ascii_case(expected) { return Err("CONTENT_VERSION_CHANGED".into()); }
    Ok(expected.to_ascii_lowercase())
}
fn read_verified_desktop_asset(path: &std::path::Path, size: u64, selected_hash: &str) -> Result<Vec<u8>, String> {
    let bytes = read_limited(path, size)?;
    if format!("{:x}", Sha256::digest(&bytes)) != selected_hash { return Err("CONTENT_VERSION_CHANGED".into()); }
    Ok(bytes)
}
pub(super) fn verify_selected_file(path: &std::path::Path, selected_hash: &str) -> Result<(), String> {
    let actual = crate::capture_media::sha256_file(path).map_err(|_| "CONTENT_ATTACHMENT_CHANGED")?;
    if actual != selected_hash { return Err("CONTENT_VERSION_CHANGED".into()); }
    Ok(())
}
fn name_and_mime(name: &str, mime: &str) -> Result<(String, String), String> {
    // A display name is never a path authority and cannot inject Markdown lines.
    let name: String = name.chars().filter(|c| !c.is_control() && *c != '/' && *c != '\\').take(255).collect();
    if name.trim().is_empty() || name == "." || name == ".." { return Err("CONTENT_ATTACHMENT_INVALID".into()); }
    let essence = mime.split(';').next().unwrap_or("").trim();
    let token = |value: &str| !value.is_empty() && value.bytes().all(|c| c.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&c));
    let mime = if essence.len() <= 255 && essence.split_once('/').is_some_and(|(kind, sub)| token(kind) && token(sub)) { essence } else { "application/octet-stream" };
    Ok((name, mime.to_ascii_lowercase()))
}
/// Restore display type from already identity/hash-verified bytes, never from
/// the filename. Some desktop assets retain a generic MIME even though their
/// thumbnail and actual payload are images. This does not change file bytes,
/// authorization, size limits or the catalog's stored source metadata.
fn attachment_mime(declared: &str, bytes: &[u8]) -> String {
    let detected = if bytes.len() >= 33 && bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        && bytes[8..12] == [0, 0, 0, 13] && &bytes[12..16] == b"IHDR"
        && bytes[16..20] != [0, 0, 0, 0] && bytes[20..24] != [0, 0, 0, 0] {
        Some("image/png")
    } else if bytes.len() >= 4 && bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.len() >= 13 && (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"))
        && bytes[6..8] != [0, 0] && bytes[8..10] != [0, 0] {
        Some("image/gif")
    } else if bytes.len() >= 20 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP"
        && matches!(&bytes[12..16], b"VP8 " | b"VP8L" | b"VP8X") {
        Some("image/webp")
    } else { None };
    // No filename-based HTML/SVG promotion. Specific existing declarations
    // retain their original semantics when no supported raster signature exists.
    detected.unwrap_or(declared).to_owned()
}

async fn read_asset(state: State<'_, SharedState>, app: tauri::AppHandle, input: AssetSource) -> Result<VerifiedAsset, String> {
    match input {
        AssetSource::Local { asset_id, version } => {
            public_id(&asset_id)?;
            let row = with_db(&state, |db| db.asset_get(&asset_id))?.ok_or("CONTENT_NOT_CACHED")?;
            if row.content_hash != version || version.len() != 64 || row.size_bytes <= 0 { return Err("CONTENT_VERSION_CHANGED".into()); }
            if row.size_bytes as u64 > crate::managed_vault_resources::MAX_RESOURCE { return Err("CONTENT_ATTACHMENT_TOO_LARGE".into()); }
            let report = crate::local_asset::check_integrity(&row.local_path, row.size_bytes, &row.content_hash, true)?;
            if report.status != "healthy" || !report.hash_verified { return Err("CONTENT_ATTACHMENT_CHANGED".into()); }
            let bytes = read_limited(std::path::Path::new(&row.local_path), row.size_bytes as u64)?;
            if format!("{:x}", Sha256::digest(&bytes)) != row.content_hash { return Err("CONTENT_ATTACHMENT_CHANGED".into()); }
            let (name, mime) = name_and_mime(&row.name, &row.mime)?;
            let mime = attachment_mime(&mime, &bytes);
            Ok(VerifiedAsset { name, mime, bytes, proof: SourceProof::Local(row) })
        }
        AssetSource::Desktop { instance, library, asset_id, version } => {
            public_id(&asset_id)?;
            if version.is_empty() { return Err("CONTENT_VERSION_UNCONFIRMED".into()); }
            let source = Source::capture_expected(&state, &instance)?.scoped(library.as_deref(), None)?;
            source.capabilities(&state, "materialPreview").await?;
            let detail = source.metadata_get(&state, &format!("/v1/assets/{asset_id}")).await?;
            source.check(&state)?;
            if detail["desktopAssetId"].as_str() != Some(asset_id.as_str()) { return Err("CONTENT_SOURCE_CHANGED".into()); }
            let selected_hash = selected_content_hash(&version, &detail)?;
            cache_assets(&state, &source, std::slice::from_ref(&detail))?;
            let authority = source.with_db(&state, |db| {
                if db.asset_version(&source.cache_owner(), &asset_id)?.as_deref() != Some(version.as_str()) { return Err("CONTENT_VERSION_CHANGED".into()); }
                db.content_resource_authority()
            })?;
            let (name, mime) = name_and_mime(detail["name"].as_str().unwrap_or(""), detail["mimeType"].as_str().unwrap_or(""))?;
            let job = format!("note-asset-{}", uuid::Uuid::new_v4());
            let result = download_resource_verified(state.clone(), app, &instance, library.as_deref(), asset_id.clone(), job, None,
                Some(crate::managed_vault_resources::MAX_RESOURCE), Some(version.clone()), Some(&selected_hash)).await?;
            source.check(&state)?;
            let path = result["path"].as_str().ok_or("CONTENT_NOT_CACHED")?;
            let size = result["sizeBytes"].as_u64().ok_or("CONTENT_NOT_CACHED")?;
            let bytes = read_verified_desktop_asset(std::path::Path::new(path), size, &selected_hash)?;
            let mime = attachment_mime(&mime, &bytes);
            Ok(VerifiedAsset { name, mime, bytes, proof: SourceProof::Desktop { source, asset_id, version, authority } })
        }
    }
}
fn same_local_asset(db: &crate::db::Db, row: &crate::db::LocalAssetItem) -> Result<(), String> {
    let live = db.asset_get(&row.asset_id)?.ok_or("CONTENT_SOURCE_CHANGED")?;
    if live.content_hash != row.content_hash || live.local_path != row.local_path || live.size_bytes != row.size_bytes || live.mime != row.mime || live.name != row.name {
        return Err("CONTENT_SOURCE_CHANGED".into());
    }
    Ok(())
}
fn commit(db: &mut crate::db::Db, root: &std::path::Path, target: &NoteTarget, proof: &TargetProof, asset: &VerifiedAsset) -> Result<Value, String> {
    match (target, proof) {
        (NoteTarget::Managed { local_vault_id, note_id, expected_revision, from, to }, TargetProof::Managed(binding)) => {
            let store = crate::managed_vault::Store::new(root)?;
            {
                let _gate = crate::managed_vault::lock()?;
                if store.writable_manifest(local_vault_id)?.binding != *binding { return Err("CONTENT_SOURCE_CHANGED".into()); }
            }
            let note = db.managed_stage_attachment(&store, local_vault_id, note_id, expected_revision, &asset.name, &asset.mime, &asset.bytes, *from, *to)?;
            Ok(json!({"note":note}))
        }
        (NoteTarget::Desktop { instance, vault, note_id, expected_content }, TargetProof::Desktop(epoch)) => {
            if scope_epochs(instance)?.1 != *epoch || db.paired()?.is_none_or(|p| p.instance_id != *instance) { return Err("CONTENT_SOURCE_CHANGED".into()); }
            db.managed_scope_active(instance, vault)?;
            check_desktop_note(&db.content_note(instance, vault, note_id)?, expected_content)?;
            let dir = root.join("content-drafts");
            std::fs::create_dir_all(&dir).map_err(|_| "CONTENT_STORAGE_UNAVAILABLE")?;
            let op = uuid::Uuid::new_v4().to_string();
            let path = dir.join(format!("attachment-{op}.bin"));
            let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(|_| "CONTENT_STORAGE_UNAVAILABLE")?;
            file.write_all(&asset.bytes).and_then(|_| file.sync_all()).map_err(|_| "CONTENT_STORAGE_UNAVAILABLE")?;
            let hash = format!("{:x}", Sha256::digest(&asset.bytes));
            let note = db.content_stage_attachment(instance, vault, note_id, &op, &asset.name, &asset.mime, &path.to_string_lossy(), asset.bytes.len() as u64, &hash)?;
            Ok(json!({"note":note}))
        }
        _ => Err("CONTENT_SOURCE_CHANGED".into()),
    }
}

#[tauri::command]
pub(crate) async fn note_attach_library_asset(state: State<'_, SharedState>, app: tauri::AppHandle, target: NoteTarget, source: AssetSource) -> Result<Value, String> {
    let root = app.path().app_data_dir().map_err(|_| "VAULT_UNAVAILABLE")?;
    let target_snapshot = target_proof(&state, &root, &target)?;
    let asset = read_asset(state.clone(), app, source).await?;
    // The same DB critical section rechecks the source and commits the target.
    // Downloads never pass a remote path or URL into the note body.
    match &asset.proof {
        SourceProof::Local(row) => with_db(&state, |db| { same_local_asset(db, row)?; commit(db, &root, &target, &target_snapshot, &asset) }),
        SourceProof::Desktop { source, asset_id, version, authority } => source.with_db(&state, |db| {
            if db.content_resource_authority()? != *authority || db.asset_version(&source.cache_owner(), asset_id)?.as_deref() != Some(version.as_str()) { return Err("CONTENT_SOURCE_CHANGED".into()); }
            commit(db, &root, &target, &target_snapshot, &asset)
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn names_and_size_are_checked_before_publication() {
        assert_eq!(name_and_mime("dir/图\n片.png", "image/png").unwrap(), ("dir图片.png".into(), "image/png".into()));
        assert!(name_and_mime("../", "text/plain").is_err());
        assert_eq!(name_and_mime("note.txt", "bad\nmime").unwrap().1, "application/octet-stream");
        assert_eq!(name_and_mime("note.txt", "text/plain; charset=utf-8").unwrap().1, "text/plain");
        assert_eq!(name_and_mime("image.png", "IMAGE/PNG").unwrap().1, "image/png");
        let path = std::env::temp_dir().join(format!("lr-material-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"abc").unwrap();
        assert_eq!(read_limited(&path, 3).unwrap(), b"abc");
        assert!(read_limited(&path, 2).is_err());
        assert!(read_limited(&path, 0).is_err());
        assert!(read_limited(&path, crate::managed_vault_resources::MAX_RESOURCE + 1).is_err());
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn stale_deleted_conflicted_or_paused_desktop_note_is_never_a_target() {
        let note = json!({"content":"body", "deleted":false, "pendingKind":"update", "conflictDocument":null, "operationPaused":false});
        assert!(check_desktop_note(&note, "body").is_ok());
        assert!(check_desktop_note(&note, "old body").is_err());
        for (field, value) in [("deleted", json!(true)), ("pendingKind", json!("delete")), ("conflictDocument", json!({})), ("operationPaused", json!(true))] {
            let mut changed = note.clone(); changed[field] = value;
            assert!(check_desktop_note(&changed, "body").is_err());
        }
    }
    #[test]
    fn request_requires_scoped_identities_and_versions() {
        assert!(serde_json::from_value::<AssetSource>(json!({"kind":"local","assetId":"a","version":"hash"})).is_ok());
        assert!(serde_json::from_value::<AssetSource>(json!({"kind":"local","assetId":"a","path":"/tmp/file"})).is_err());
        assert!(serde_json::from_value::<AssetSource>(json!({"kind":"local","assetId":"a","version":"hash","path":"/tmp/file"})).is_err());
        assert!(serde_json::from_value::<AssetSource>(json!({"kind":"desktop","instance":"i","library":"l","assetId":"a","version":"v"})).is_ok());
        assert!(serde_json::from_value::<AssetSource>(json!({"kind":"desktop","library":"l","assetId":"a","version":"v"})).is_err());
        assert!(serde_json::from_value::<NoteTarget>(json!({"kind":"managed","localVaultId":"v","noteId":"n","expectedRevision":"r","from":0,"to":0})).is_ok());
        assert!(serde_json::from_value::<NoteTarget>(json!({"kind":"desktop","instance":"i","vault":"v","noteId":"n"})).is_err());
    }
    #[test]
    fn selected_hash_binds_downloaded_bytes_when_file_changes_after_detail() {
        let selected = b"old bytes";
        let replacement = b"new bytes"; // same length; cached metadata remains unchanged
        let hash = format!("{:x}", Sha256::digest(selected));
        let version = format!("{hash}|thumb|updated");
        let detail = json!({"contentHash":hash});
        let proof = selected_content_hash(&version, &detail).unwrap();
        let path = std::env::temp_dir().join(format!("lr-material-swap-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, replacement).unwrap();
        assert_eq!(verify_selected_file(&path, &proof).unwrap_err(), "CONTENT_VERSION_CHANGED");
        assert_eq!(read_verified_desktop_asset(&path, replacement.len() as u64, &proof).unwrap_err(), "CONTENT_VERSION_CHANGED");
        std::fs::write(&path, selected).unwrap();
        assert!(verify_selected_file(&path, &proof).is_ok());
        assert_eq!(read_verified_desktop_asset(&path, selected.len() as u64, &proof).unwrap(), selected);
        assert!(selected_content_hash("|thumb|updated", &json!({"contentHash":null})).is_err());
        assert!(selected_content_hash(&version, &json!({"contentHash":"not-a-hash"})).is_err());
        std::fs::remove_file(path).unwrap();
    }
}

#[cfg(test)]
mod image_mime_regression {
    use super::attachment_mime;
    #[test]
    fn generic_png_is_an_image_without_filename_guessing() {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend_from_slice(&[0,0,0,1,0,0,0,1,8,6,0,0,0,0,0,0,0]);
        assert_eq!(attachment_mime("application/octet-stream", &png), "image/png");
        assert_eq!(attachment_mime("application/x-unknown", &png), "image/png");
        assert_eq!(attachment_mime("image/jpeg", &png), "image/png");
        let attachment = crate::managed_vault_resources::LocalAttachment {
            op_id: "synthetic-image".into(), name: "reference-B.png".into(),
            mime_type: attachment_mime("application/octet-stream", &png),
            sha256: "0".repeat(64), size_bytes: png.len() as u64, publication_markdown: None,
        };
        assert_eq!(crate::managed_vault_resources::insert_attachment("正文", &attachment, 2, 2).unwrap(),
            "正文![reference-B.png](luckyray-attachment:synthetic-image)");
    }
    #[test]
    fn other_raster_signatures_are_preserved() {
        assert_eq!(attachment_mime("application/octet-stream", &[255,216,255,224]), "image/jpeg");
        assert_eq!(attachment_mime("application/octet-stream", b"GIF89a\x01\0\x01\0\0\0\0"), "image/gif");
        assert_eq!(attachment_mime("application/octet-stream", b"RIFF\x0c\0\0\0WEBPVP8L\0\0\0\0"), "image/webp");
    }
    #[test]
    fn ordinary_files_and_truncated_headers_are_not_promoted() {
        for bytes in [b"".as_slice(), b"fake.png", b"<svg></svg>", b"<html></html>", b"\x89PNG\r\n\x1a\n"] {
            assert_eq!(attachment_mime("application/octet-stream", bytes), "application/octet-stream");
        }
        assert_eq!(attachment_mime("text/plain", b"notes"), "text/plain");
    }
}
