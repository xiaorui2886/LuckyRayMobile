//! Verified replica resources. Source targets are lookup keys, never paths or URLs.
//! Immutable owned blobs precede the manifest commit; a crash can leave an orphan,
//! never a completeness claim for unpublished bytes. Callers hold DB then vault lock.
use crate::managed_vault::{self, Note, Store};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::Read,
    path::Path,
};

pub(crate) const MAX_RESOURCE: u64 = 64 * 1024 * 1024;
const MAX_TOTAL: u64 = 128 * 1024 * 1024;
/// A phone-owned immutable attachment. Metadata is published with the note body.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalAttachment {
    pub op_id: String,
    pub name: String,
    pub mime_type: String,
    pub sha256: String,
    pub size_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publication_markdown: Option<String>,
}
pub(crate) fn insert_attachment(body: &str, attachment: &LocalAttachment, from_utf16: usize, to_utf16: usize) -> Result<String, String> {
    if from_utf16 > to_utf16 { return Err("VAULT_SELECTION_CHANGED".into()); }
    let byte_offset = |offset: usize| -> Result<usize, String> {
        let mut units = 0;
        for (byte, ch) in body.char_indices() {
            if units == offset { return Ok(byte); }
            units += ch.len_utf16();
            if units > offset { return Err("VAULT_SELECTION_CHANGED".into()); }
        }
        if units == offset { Ok(body.len()) } else { Err("VAULT_SELECTION_CHANGED".into()) }
    };
    let from = byte_offset(from_utf16)?;
    let to = byte_offset(to_utf16)?;
    let name = attachment.name.replace('\\', "\\\\").replace('[', "\\[").replace(']', "\\]");
    let image = if attachment.mime_type.starts_with("image/") { "!" } else { "" };
    Ok(format!("{}{image}[{name}](luckyray-attachment:{}){}", &body[..from], attachment.op_id, &body[to..]))
}
pub(crate) fn local_attachment_path(note: &str, attachment: &LocalAttachment) -> Result<String, String> {
    if !digest(&attachment.sha256) { return Err("VAULT_RESOURCE_HASH_MISMATCH".into()); }
    Ok(format!("resources/{}/local/{}.bin", managed_vault::hash(note.as_bytes()), attachment.sha256))
}
/// Caller holds the vault lock, then commits this descriptor and the body together.
pub(crate) fn stage_owned(store: &Store, vault: &str, note: &str, expected_revision: &str, name: &str, mime: &str, bytes: &[u8]) -> Result<LocalAttachment, String> {
    store.writable_manifest(vault)?;
    let n = store.get(vault, note)?;
    if n.trashed || n.body_state != "ready" { return Err("VAULT_BODY_NOT_EDITABLE".into()); }
    if n.remote["transferredTo"].is_object() { return Err("VAULT_NOTE_TRANSFERRED".into()); }
    if n.remote["transferPending"].is_object() { return Err("VAULT_NOTE_TRANSFER_PENDING".into()); }
    if n.revision != expected_revision { return Err("VAULT_REVISION_CONFLICT".into()); }
    if bytes.is_empty() || bytes.len() as u64 > MAX_RESOURCE { return Err("VAULT_RESOURCE_TOO_LARGE".into()); }
    let attachment = LocalAttachment { op_id: uuid::Uuid::new_v4().to_string(), name: name.into(), mime_type: mime.into(), sha256: managed_vault::hash(bytes), size_bytes: bytes.len() as u64, publication_markdown: None };
    managed_vault::write_atomic(&store.vault_root(vault)?, &local_attachment_path(note, &attachment)?, bytes)?;
    Ok(attachment)
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Body {
    pub sha256: String,
    pub size_bytes: u64,
    pub encoding: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Resource {
    pub resource_id: String,
    #[serde(default)]
    pub download_resource_id: String,
    pub target: String,
    #[serde(default)]
    pub mime_type: String,
    pub required: bool,
    pub status: String,
    pub sha256: Option<String>,
    pub size_bytes: Option<u64>,
    pub version: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Replica {
    pub schema_version: u32,
    pub vault_id: String,
    pub note_id: String,
    pub revision: String,
    pub body: Body,
    pub resource_identity: String,
    pub resources: Vec<Resource>,
    pub complete: bool,
}
fn invalid() -> String {
    "VAULT_REPLICA_INVALID".into()
}
fn digest(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn opaque(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 256
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
}
pub(crate) fn supported(caps: &Value) -> bool {
    caps["replicaManifest"]["version"] == 1
        && caps["replicaManifest"]["resourceIdentity"] == "scoped-target-alias"
        && caps["replicaManifest"]["bodyEncoding"] == "utf-8"
}
impl Replica {
    pub(crate) fn validate(
        &self,
        vault: &str,
        note: &str,
        revision: &str,
        body: &[u8],
    ) -> Result<(), String> {
        if self.schema_version != 1
            || self.resource_identity != "scoped-target-alias"
            || self.vault_id != vault
            || self.note_id != note
            || self.revision != revision
            || revision.is_empty()
            || self.body.encoding != "utf-8"
            || self.resources.len() > 1000
        {
            return Err(invalid());
        }
        verify(body, &self.body.sha256, self.body.size_bytes)?;
        let mut ids = HashSet::new();
        let mut targets = HashSet::new();
        let mut total = 0u64;
        for r in &self.resources {
            if !opaque(&r.resource_id)
                || !ids.insert(&r.resource_id)
                || !targets.insert(&r.target)
                || r.target.len() > 16384
            {
                return Err(invalid());
            }
            if r.status == "verified" {
                let size = r.size_bytes.ok_or_else(invalid)?;
                if !opaque(&r.download_resource_id)
                    || r.sha256.as_deref().is_none_or(|s| !digest(s))
                    || r.version.as_deref().is_none_or(str::is_empty)
                    || size > MAX_RESOURCE
                {
                    return Err(invalid());
                }
                total = total.checked_add(size).ok_or_else(invalid)?;
            }
        }
        if total > MAX_TOTAL {
            return Err("VAULT_REPLICA_TOO_LARGE".into());
        }
        Ok(())
    }
}
pub(crate) fn verify(bytes: &[u8], sha: &str, size: u64) -> Result<(), String> {
    if !digest(sha) || bytes.len() as u64 != size || managed_vault::hash(bytes) != sha {
        return Err("VAULT_RESOURCE_HASH_MISMATCH".into());
    }
    Ok(())
}
/// Path contains no source-controlled path segments or extensions.
pub(crate) fn resource_path(note: &str, r: &Resource) -> Result<String, String> {
    let sha = r
        .sha256
        .as_deref()
        .filter(|s| digest(s))
        .ok_or_else(invalid)?;
    Ok(format!(
        "resources/{}/{}/{}.bin",
        managed_vault::hash(note.as_bytes()),
        managed_vault::hash(r.resource_id.as_bytes()),
        sha
    ))
}
pub(crate) fn read_verified(root: &Path, note: &str, r: &Resource) -> Result<Vec<u8>, String> {
    let path = managed_vault::guarded(root, &resource_path(note, r)?)?;
    let size = r
        .size_bytes
        .filter(|s| *s <= MAX_RESOURCE)
        .ok_or_else(invalid)?;
    let meta = fs::metadata(&path).map_err(|_| "VAULT_RESOURCE_MISSING")?;
    if !meta.is_file() || meta.len() != size {
        return Err("VAULT_RESOURCE_HASH_MISMATCH".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| "VAULT_RESOURCE_MISSING")?
        .take(size + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "VAULT_RESOURCE_MISSING")?;
    verify(&bytes, r.sha256.as_deref().ok_or_else(invalid)?, size)?;
    Ok(bytes)
}
/// A matching published receipt plus the CURRENT authoritative replica hash
/// can reuse this note's immutable phone-owned bytes. A matching name alone
/// cannot. Called only after the replica body/revision/scope validation below.
fn reuse_owned_replica(root: &Path, current: &Note, resource: &Resource) -> bool {
    if resource.status != "verified" { return false; }
    let Some(hash) = resource.sha256.as_deref().filter(|value| digest(value)) else { return false; };
    let Some(size) = resource.size_bytes.filter(|size| *size <= MAX_RESOURCE) else { return false; };
    let Some(rows) = current.remote["localAttachments"].as_array() else { return false; };
    let matches: Vec<&Value> = rows.iter().filter(|row| {
        row["publicationMarkdown"].as_str()
            .and_then(crate::db::content_db::attachment_publication_target)
            .as_deref() == Some(resource.target.as_str())
    }).collect();
    // Conflicting local receipts remain unresolved even if one happens to match.
    if matches.is_empty() || matches.iter().any(|row| row["sha256"].as_str() != Some(hash)
        || row["sizeBytes"].as_u64() != Some(size)) { return false; }
    let Ok(attachment) = serde_json::from_value::<LocalAttachment>(matches[0].clone()) else { return false; };
    let attempt = || -> Result<(), String> {
        let source = managed_vault::guarded(root, &local_attachment_path(&current.note_id, &attachment)?)?;
        let mut bytes = Vec::new();
        fs::File::open(source).map_err(|_| "VAULT_RESOURCE_MISSING")?
            .take(size + 1).read_to_end(&mut bytes).map_err(|_| "VAULT_RESOURCE_MISSING")?;
        verify(&bytes, hash, size)?;
        let relative = resource_path(&current.note_id, resource)?;
        let destination = managed_vault::guarded(root, &relative)?;
        // Do not overwrite a foreign/corrupted immutable slot on this fast path.
        // Existing download repair retains such evidence through its own path.
        if destination.exists() { return read_verified(root, &current.note_id, resource).map(|_| ()); }
        managed_vault::write_atomic(root, &relative, &bytes)?;
        Ok(())
    };
    attempt().is_ok()
}

pub(crate) fn publish(
    store: &Store,
    local: &str,
    expected: &Note,
    replica: &Replica,
    bytes: Option<(&Resource, &[u8])>,
    now: u64,
) -> Result<bool, String> {
    let mut manifest = store.manifest(local)?;
    let binding = manifest
        .binding
        .as_ref()
        .ok_or("VAULT_REPLICA_SCOPE_CHANGED")?;
    if binding.remote_vault_id != replica.vault_id
        || expected.remote["instanceId"] != binding.instance_id
    {
        return Err("VAULT_REPLICA_SCOPE_CHANGED".into());
    }
    let current = store.get(local, &expected.note_id)?;
    if current.revision != expected.revision
        || current.body_hash != expected.body_hash
        || current.remote["revision"] != replica.revision
        || current.body_state != "ready"
        || current.sync_state != "synced"
        || current.trashed
    {
        return Err("VAULT_REPLICA_REVISION_CHANGED".into());
    }
    replica.validate(
        &binding.remote_vault_id,
        &current.note_id,
        &replica.revision,
        current
            .content
            .as_deref()
            .ok_or("VAULT_BODY_MISSING")?
            .as_bytes(),
    )?;
    let root = store.vault_root(local)?;
    if let Some((resource, bytes)) = bytes {
        if !replica
            .resources
            .iter()
            .any(|r| r.resource_id == resource.resource_id && r.sha256 == resource.sha256)
            || resource.status != "verified"
        {
            return Err(invalid());
        }
        verify(
            bytes,
            resource.sha256.as_deref().ok_or_else(invalid)?,
            resource.size_bytes.ok_or_else(invalid)?,
        )?;
        let relative = resource_path(&current.note_id, resource)?;
        let destination = managed_vault::guarded(&root, &relative)?;
        if destination.exists() && read_verified(&root, &current.note_id, resource).is_err() {
            // Never erase unknown/corrupted bytes in an immutable hash slot. Retain
            // them beside it before repairing; a crash leaves recoverable evidence.
            if !fs::metadata(&destination).map_err(|_| invalid())?.is_file() {
                return Err("VAULT_RESOURCE_DESTINATION_INVALID".into());
            }
            let retained = managed_vault::guarded(
                &root,
                &format!("{relative}.rejected-{}", uuid::Uuid::new_v4().simple()),
            )?;
            fs::rename(&destination, retained).map_err(|_| "VAULT_RESOURCE_RETAIN_FAILED")?;
            managed_vault::sync_dir(destination.parent().ok_or_else(invalid)?)?;
        }
        managed_vault::write_atomic(&root, &relative, bytes)?;
    }
    let mut rows = Vec::new();
    // A local set of valid rows cannot upgrade an explicitly incomplete source
    // manifest (for example, a newer server reporting an unlisted dependency).
    let mut complete = replica.complete;
    let mut pending = false;
    for r in &replica.resources {
        let available = r.status == "verified"
            && (read_verified(&root, &current.note_id, r).is_ok() || reuse_owned_replica(&root, &current, r));
        if r.required && !available {
            complete = false;
            pending |= r.status == "verified";
        }
        let mut row = serde_json::to_value(r).map_err(|_| invalid())?;
        row["localStatus"] = json!(if available {
            "verified"
        } else if r.status == "verified" {
            "deferred"
        } else {
            r.status.as_str()
        });
        if available {
            row["localRelativePath"] = json!(resource_path(&current.note_id, r)?);
        }
        rows.push(row);
    }
    let n = manifest
        .notes
        .get_mut(&current.note_id)
        .ok_or_else(invalid)?;
    n.remote["replica"] = json!({"schemaVersion":1,"revision":replica.revision,"bodySha256":replica.body.sha256,"bodyReady":true,
        "resourcesComplete":complete,"resources":rows,"checkedAtMs":now,"retryAfterMs":if pending {0} else {now.saturating_add(60000)}});
    n.remote["bodyReady"] = json!(true);
    n.remote["resourcesComplete"] = json!(complete);
    n.remote["resourceCompleteness"] = json!(if complete { "verified" } else { "incomplete" });
    store.commit(manifest, BTreeMap::new())?;
    Ok(pending)
}
/// Offline only: exact recognized Markdown target lookup; never fetches a URL.
pub(crate) fn resolve(
    store: &Store,
    local: &str,
    note: &str,
    target: &str,
) -> Result<Value, String> {
    let n = store.get(local, note)?;
    let replica_claims_target = n.remote["replica"]["resources"].as_array().is_some_and(|rows| rows.iter().any(|row| row["target"] == target));
    // A published path may later refer to newer Desktop bytes. Explicit replica
    // descriptors win, even unavailable ones; only opaque pending op IDs are owned.
    if !n.trashed && n.body_state == "ready" && (target.starts_with("luckyray-attachment:") || !replica_claims_target) {
        let rows: Vec<&Value> = n.remote["localAttachments"].as_array().into_iter().flatten().filter(|row| {
            target.strip_prefix("luckyray-attachment:").is_some_and(|op| row["opId"] == op)
                || row["publicationMarkdown"].as_str().and_then(crate::db::content_db::attachment_publication_target).as_deref() == Some(target)
        }).collect();
        if let Some(row) = rows.first() {
            if rows.iter().any(|other| other["sha256"] != row["sha256"]) { return Err("VAULT_RESOURCE_AMBIGUOUS".into()); }
            let body = n.content.as_deref().unwrap_or_default();
            if target.strip_prefix("luckyray-attachment:").is_some_and(|op| !crate::db::content_db::has_attachment_reference(body, op)) { return Err("VAULT_RESOURCE_MISSING".into()); }
            if !body.contains(&format!("]({target})")) && !body.contains(&format!("](<{target}>)")) && !body.contains(&format!("[[{target}]]")) { return Err("VAULT_RESOURCE_MISSING".into()); }
            let attachment: LocalAttachment = serde_json::from_value((*row).clone()).map_err(|_| "VAULT_RESOURCE_UNVERIFIED")?;
            if attachment.size_bytes > MAX_RESOURCE { return Err("VAULT_RESOURCE_TOO_LARGE".into()); }
            let path = managed_vault::guarded(&store.vault_root(local)?, &local_attachment_path(note, &attachment)?)?;
            let mut bytes = Vec::new();
            fs::File::open(&path).map_err(|_| "VAULT_RESOURCE_MISSING")?.take(attachment.size_bytes + 1).read_to_end(&mut bytes).map_err(|_| "VAULT_RESOURCE_MISSING")?;
            verify(&bytes, &attachment.sha256, attachment.size_bytes)?;
            return Ok(json!({"path":path,"mime":attachment.mime_type,"sha256":attachment.sha256,"sizeBytes":attachment.size_bytes}));
        }
    }
    let proof = &n.remote["replica"];
    if n.trashed
        || n.body_state != "ready"
        || proof["bodySha256"] != n.body_hash
        || proof["revision"] != n.remote["revision"]
    {
        return Err("VAULT_RESOURCE_UNVERIFIED".into());
    }
    let row = proof["resources"]
        .as_array()
        .and_then(|rows| {
            rows.iter()
                .find(|r| r["target"] == target && r["localStatus"] == "verified")
        })
        .ok_or("VAULT_RESOURCE_MISSING")?;
    let r: Resource = serde_json::from_value(row.clone()).map_err(|_| invalid())?;
    let root = store.vault_root(local)?;
    read_verified(&root, note, &r)?;
    Ok(
        json!({"path":managed_vault::guarded(&root,&resource_path(note,&r)?)?,"mime":r.mime_type,"sha256":r.sha256,"sizeBytes":r.size_bytes}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    fn replica() -> Replica {
        serde_json::from_value(json!({"schemaVersion":1,"vaultId":"v","noteId":"n","revision":"r","body":{"sha256":managed_vault::hash(b"body"),"sizeBytes":4,"encoding":"utf-8"},"resourceIdentity":"scoped-target-alias","resources":[],"complete":true})).unwrap()
    }
    #[test]
    fn exact_body_scope_and_revision() {
        let r = replica();
        assert!(r.validate("v", "n", "r", b"body").is_ok());
        for (v, n, rev, body) in [
            ("x", "n", "r", b"body".as_slice()),
            ("v", "x", "r", b"body"),
            ("v", "n", "r2", b"body"),
            ("v", "n", "r", b"BODY"),
        ] {
            assert!(r.validate(v, n, rev, body).is_err());
        }
    }
    #[test]
    fn absent_capability_never_verified() {
        assert!(!supported(&json!({"capabilities":{"noteRead":true}})));
    }
    #[test]
    fn corruption_and_length_rejected() {
        let sha = managed_vault::hash(b"ok");
        assert!(verify(b"bad", &sha, 2).is_err());
        assert!(verify(b"no", &sha, 2).is_err());
    }
    #[test]
    fn source_target_is_not_path_authority() {
        let r:Resource=serde_json::from_value(json!({"resourceId":"alias","downloadResourceId":"legacy","target":"../../secret","mimeType":"text/html","required":true,"status":"verified","sha256":managed_vault::hash(b"ok"),"sizeBytes":2,"version":"v"})).unwrap();
        let path = resource_path("../note", &r).unwrap();
        assert!(!path.contains(".."));
        assert!(!path.contains("secret"));
    }
    #[test]
    fn unverified_required_resource_is_explicit() {
        let mut r = replica();
        r.resources.push(serde_json::from_value(json!({"resourceId":"a","target":"https://private.invalid/x","required":true,"status":"external"})).unwrap());
        assert!(r.validate("v", "n", "r", b"body").is_ok());
        assert_ne!(r.resources[0].status, "verified");
    }
}

#[cfg(test)]
mod persistence_tests {
    use super::*;
    struct Fixture {
        dir: std::path::PathBuf,
        store: Store,
        note: Note,
        replica: Replica,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }
    fn fixture() -> Fixture {
        let dir = std::env::temp_dir().join(format!("replica-tests-{}", uuid::Uuid::new_v4()));
        let store = Store::new(&dir).unwrap();
        let source = json!({"version":1,"notes":[{"noteId":"n","title":"N","content":"![img](original.png)","tags":[],"folder":""}],"folders":[],"history":{}});
        let plan = store.prepare_migration(source.clone()).unwrap();
        store
            .commit_migration(plan["planId"].as_str().unwrap(), &source)
            .unwrap();
        let mut m = store.manifest("local").unwrap();
        m.binding = Some(managed_vault::Binding {
            instance_id: "i".into(),
            remote_vault_id: "v".into(),
        });
        let n = m.notes.get_mut("n").unwrap();
        n.sync_state = "synced".into();
        n.remote = json!({"instanceId":"i","revision":"r"});
        store.commit(m, BTreeMap::new()).unwrap();
        let note = store.get("local", "n").unwrap();
        let replica:Replica=serde_json::from_value(json!({"schemaVersion":1,"vaultId":"v","noteId":"n","revision":"r","body":{"sha256":note.body_hash,"sizeBytes":note.content.as_ref().unwrap().len(),"encoding":"utf-8"},"resourceIdentity":"scoped-target-alias","resources":[{"resourceId":"a","downloadResourceId":"legacy","target":"original.png","mimeType":"image/png","required":true,"status":"verified","sha256":managed_vault::hash(b"image"),"sizeBytes":5,"version":"etag"}],"complete":true})).unwrap();
        Fixture {
            dir,
            store,
            note,
            replica,
        }
    }
    fn owned_receipt(f: &Fixture, bytes: &[u8], published: &str) -> Note {
        let a = LocalAttachment { op_id: "own-synthetic".into(), name: "image.png".into(),
            mime_type: "image/png".into(), sha256: managed_vault::hash(bytes), size_bytes: bytes.len() as u64,
            publication_markdown: Some(format!("![image](<{published}>)")) };
        managed_vault::write_atomic(&f.store.vault_root("local").unwrap(), &local_attachment_path("n", &a).unwrap(), bytes).unwrap();
        let mut manifest = f.store.manifest("local").unwrap();
        manifest.notes.get_mut("n").unwrap().remote["localAttachments"] = json!([a]);
        f.store.commit(manifest, BTreeMap::new()).unwrap();
        f.store.get("local", "n").unwrap()
    }
    #[test]
    fn matching_owned_receipt_is_ready_on_first_replica_publish_without_download() {
        let f = fixture();
        let note = owned_receipt(&f, b"image", "original.png");
        assert!(!publish(&f.store, "local", &note, &f.replica, None, 1).unwrap());
        let file = resolve(&f.store, "local", "n", "original.png").unwrap();
        assert_eq!(fs::read(file["path"].as_str().unwrap()).unwrap(), b"image");
        assert_eq!(f.store.get("local", "n").unwrap().remote["replica"]["resources"][0]["localStatus"], "verified");
    }
    #[test]
    fn changed_bytes_or_unrelated_receipt_never_reuse_local_image() {
        for (bytes, target) in [(b"other".as_slice(), "original.png"), (b"image".as_slice(), "other.png")] {
            let f = fixture(); let note = owned_receipt(&f, bytes, target);
            assert!(publish(&f.store, "local", &note, &f.replica, None, 1).unwrap());
            assert!(resolve(&f.store, "local", "n", "original.png").is_err());
        }
    }
    #[test]
    fn missing_or_ambiguous_replica_never_promotes_owned_bytes() {
        for status in ["missing", "ambiguous"] {
            let mut f = fixture(); let note = owned_receipt(&f, b"image", "original.png");
            f.replica.resources[0].status = status.into();
            publish(&f.store, "local", &note, &f.replica, None, 1).unwrap();
            assert!(resolve(&f.store, "local", "n", "original.png").is_err());
        }
    }
    #[test]
    fn corrupt_owned_bytes_or_conflicting_receipts_still_require_verification() {
        for corrupt in [true, false] {
            let f = fixture(); let note = owned_receipt(&f, b"image", "original.png");
            let a: LocalAttachment = serde_json::from_value(note.remote["localAttachments"][0].clone()).unwrap();
            if corrupt {
                let path = managed_vault::guarded(&f.store.vault_root("local").unwrap(), &local_attachment_path("n", &a).unwrap()).unwrap();
                fs::write(path, b"other").unwrap();
            } else {
                let mut other = a.clone(); other.op_id = "other-op".into(); other.sha256 = managed_vault::hash(b"other");
                let mut manifest = f.store.manifest("local").unwrap();
                manifest.notes.get_mut("n").unwrap().remote["localAttachments"] = json!([a, other]);
                f.store.commit(manifest, BTreeMap::new()).unwrap();
            }
            let current = f.store.get("local", "n").unwrap();
            assert!(publish(&f.store, "local", &current, &f.replica, None, 1).unwrap());
            assert!(resolve(&f.store, "local", "n", "original.png").is_err());
        }
    }
    #[test]
    fn server_complete_not_local_complete_and_offline_resolve_uses_owned_bytes() {
        let f = fixture();
        assert!(publish(&f.store, "local", &f.note, &f.replica, None, 1).unwrap());
        assert_eq!(
            f.store.get("local", "n").unwrap().remote["resourcesComplete"],
            false
        );
        assert!(!publish(
            &f.store,
            "local",
            &f.note,
            &f.replica,
            Some((&f.replica.resources[0], b"image")),
            2
        )
        .unwrap());
        let resolved = resolve(&f.store, "local", "n", "original.png").unwrap();
        assert_eq!(
            fs::read(resolved["path"].as_str().unwrap()).unwrap(),
            b"image"
        );
        assert_eq!(f.store.get("local", "n").unwrap().content, f.note.content);
        assert!(resolve(&f.store, "local", "n", "https://external.invalid").is_err());
    }
    #[test]
    fn corrupt_blob_and_symlink_never_resolve() {
        let f = fixture();
        publish(
            &f.store,
            "local",
            &f.note,
            &f.replica,
            Some((&f.replica.resources[0], b"image")),
            2,
        )
        .unwrap();
        let resolved = resolve(&f.store, "local", "n", "original.png").unwrap();
        let path = resolved["path"].as_str().unwrap();
        fs::write(path, b"wrong").unwrap();
        assert!(resolve(&f.store, "local", "n", "original.png").is_err());
        #[cfg(unix)]
        {
            fs::remove_file(path).unwrap();
            std::os::unix::fs::symlink("/etc/passwd", path).unwrap();
            assert!(resolve(&f.store, "local", "n", "original.png").is_err());
        }
    }
    #[test]
    fn changed_revision_or_binding_blocks_publication() {
        let f = fixture();
        let mut m = f.store.manifest("local").unwrap();
        m.notes.get_mut("n").unwrap().revision = "changed".into();
        f.store.commit(m, BTreeMap::new()).unwrap();
        assert!(publish(
            &f.store,
            "local",
            &f.note,
            &f.replica,
            Some((&f.replica.resources[0], b"image")),
            1
        )
        .is_err());
        let mut m = f.store.manifest("local").unwrap();
        m.binding.as_mut().unwrap().instance_id = "different".into();
        f.store.commit(m, BTreeMap::new()).unwrap();
        assert!(publish(&f.store, "local", &f.note, &f.replica, None, 1).is_err());
    }
    #[test]
    fn bad_bytes_do_not_publish_completeness() {
        let f = fixture();
        assert!(publish(
            &f.store,
            "local",
            &f.note,
            &f.replica,
            Some((&f.replica.resources[0], b"wrong")),
            1
        )
        .is_err());
        assert!(f.store.get("local", "n").unwrap().remote["resourcesComplete"] != true);
    }
    #[test]
    fn source_incomplete_is_never_upgraded_to_complete() {
        let mut f = fixture();
        f.replica.complete = false;
        publish(&f.store, "local", &f.note, &f.replica,
            Some((&f.replica.resources[0], b"image")), 1).unwrap();
        assert_eq!(f.store.get("local", "n").unwrap().remote["resourcesComplete"], false);
        assert!(resolve(&f.store, "local", "n", "original.png").is_ok());
    }
    #[test]
    fn repairing_corrupt_immutable_resource_retains_unknown_bytes() {
        let f = fixture();
        let root = f.store.vault_root("local").unwrap();
        let relative = resource_path("n", &f.replica.resources[0]).unwrap();
        managed_vault::write_atomic(&root, &relative, b"unknown original bytes").unwrap();
        publish(&f.store, "local", &f.note, &f.replica,
            Some((&f.replica.resources[0], b"image")), 1).unwrap();
        let slot = managed_vault::guarded(&root, &relative).unwrap();
        let retained = fs::read_dir(slot.parent().unwrap()).unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| path.file_name().unwrap().to_string_lossy().contains(".rejected-"))
            .expect("corrupt original must be retained");
        assert_eq!(fs::read(retained).unwrap(), b"unknown original bytes");
        assert_eq!(fs::read(slot).unwrap(), b"image");
        assert!(resolve(&f.store, "local", "n", "original.png").is_ok());
    }

}

#[cfg(test)]
mod owned_attachment_tests {
    use super::*;
    struct Fixture { root: std::path::PathBuf, store: Store, note: Note }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.root); } }
    fn fixture() -> Fixture {
        let root = std::env::temp_dir().join(format!("owned-attachment-test-{}", uuid::Uuid::new_v4()));
        let store = Store::new(&root).unwrap();
        store.commit(managed_vault::Manifest { version:1, local_vault_id:"local".into(),name:"Synthetic".into(),binding:None,checkpoint:Value::Null,generation:0,notes:BTreeMap::new(),folders:vec![] },BTreeMap::new()).unwrap();
        store.register("local").unwrap();
        let note=store.create("local","N","before after",vec![],"").unwrap();
        Fixture {root,store,note}
    }
    fn publish(f: &Fixture, a: &LocalAttachment) -> String {
        let target=format!("luckyray-attachment:{}",a.op_id);
        let n=f.store.save("local",&f.note.note_id,&f.note.revision,"N",&format!("before [file]({target}) after"),vec![]).unwrap();
        let mut m=f.store.manifest("local").unwrap();
        m.notes.get_mut(&n.note_id).unwrap().remote=json!({"localAttachments":[a]});
        f.store.commit(m,BTreeMap::new()).unwrap();
        target
    }
    #[test]
    fn owned_bytes_are_unpublished_until_metadata_and_read_offline_after_reopen() {
        let f=fixture();
        let a=stage_owned(&f.store,"local",&f.note.note_id,&f.note.revision,"../synthetic.txt","text/plain",b"owned bytes").unwrap();
        let target=format!("luckyray-attachment:{}",a.op_id);
        assert!(resolve(&f.store,"local",&f.note.note_id,&target).is_err());
        assert_eq!(f.store.get("local",&f.note.note_id).unwrap().revision,f.note.revision);
        publish(&f,&a);
        let reopened=Store::new(&f.root).unwrap();
        let found=resolve(&reopened,"local",&f.note.note_id,&target).unwrap();
        assert_eq!(fs::read(found["path"].as_str().unwrap()).unwrap(),b"owned bytes");
        assert!(!local_attachment_path(&f.note.note_id,&a).unwrap().contains(".."));
        assert!(resolve(&reopened,"other",&f.note.note_id,&target).is_err());
        assert!(resolve(&reopened,"local","other-note",&target).is_err());
    }
    #[test]
    fn owned_revision_binding_and_deleted_note_are_checked_before_write() {
        let f=fixture();
        assert_eq!(stage_owned(&f.store,"local",&f.note.note_id,"stale","x","text/plain",b"x").unwrap_err(),"VAULT_REVISION_CONFLICT");
        let mut m=f.store.manifest("local").unwrap();
        m.binding=Some(managed_vault::Binding {instance_id:"".into(),remote_vault_id:"v".into()});
        f.store.commit(m,BTreeMap::new()).unwrap();
        assert_eq!(stage_owned(&f.store,"local",&f.note.note_id,&f.note.revision,"x","text/plain",b"x").unwrap_err(),"VAULT_BINDING_INVALID");
        let mut m=f.store.manifest("local").unwrap();m.binding=None;m.notes.get_mut(&f.note.note_id).unwrap().trashed=true;
        f.store.commit(m,BTreeMap::new()).unwrap();
        assert!(stage_owned(&f.store,"local",&f.note.note_id,&f.note.revision,"x","text/plain",b"x").is_err());
    }
    #[test]
    fn owned_corruption_and_removed_body_reference_do_not_resolve() {
        let f=fixture();let a=stage_owned(&f.store,"local",&f.note.note_id,&f.note.revision,"x","text/plain",b"one").unwrap();let target=publish(&f,&a);
        let path=f.store.vault_root("local").unwrap().join(local_attachment_path(&f.note.note_id,&a).unwrap());
        fs::write(path,b"two").unwrap();
        assert_eq!(resolve(&f.store,"local",&f.note.note_id,&target).unwrap_err(),"VAULT_RESOURCE_HASH_MISMATCH");
        let n=f.store.get("local",&f.note.note_id).unwrap();
        f.store.save("local",&n.note_id,&n.revision,"N","reference removed",vec![]).unwrap();
        assert_eq!(resolve(&f.store,"local",&n.note_id,&target).unwrap_err(),"VAULT_RESOURCE_MISSING");
    }
    #[test]
    fn insertion_uses_utf16_selection_and_keeps_text_and_safe_labels() {
        let f=fixture();let mut a=stage_owned(&f.store,"local",&f.note.note_id,&f.note.revision,"a[b]\\c","text/plain",b"x").unwrap();
        assert_eq!(insert_attachment("A😀中Z",&a,1,3).unwrap(),format!("A[a\\[b\\]\\\\c](luckyray-attachment:{})中Z",a.op_id));
        assert!(insert_attachment("A😀中Z",&a,2,3).is_err());
        assert!(insert_attachment("A😀中Z",&a,1,2).is_err());
        assert!(insert_attachment("A😀中Z",&a,6,6).is_err());
        assert!(insert_attachment("abc",&a,2,1).is_err());
        a.mime_type="image/png".into();a.name="image.png".into();
        assert_eq!(insert_attachment("ab",&a,1,1).unwrap(),format!("a![image.png](luckyray-attachment:{})b",a.op_id));
    }

    #[test]
    fn explicit_replica_target_never_falls_back_to_stale_owned_alias() {
        let f=fixture();let mut a=stage_owned(&f.store,"local",&f.note.note_id,&f.note.revision,"x","text/plain",b"old").unwrap();
        a.publication_markdown=Some("[x](attachments/x.txt)".into());publish(&f,&a);
        let n=f.store.get("local",&f.note.note_id).unwrap();let n=f.store.save("local",&n.note_id,&n.revision,"N","[x](attachments/x.txt)",vec![]).unwrap();
        assert!(resolve(&f.store,"local",&n.note_id,"attachments/x.txt").is_ok());
        let mut m=f.store.manifest("local").unwrap();let current=m.notes.get_mut(&n.note_id).unwrap();
        current.remote["revision"]=json!("remote2");
        current.remote["replica"]=json!({"bodySha256":n.body_hash,"revision":"remote2","resources":[{"resourceId":"new","target":"attachments/x.txt","status":"verified","localStatus":"deferred","sha256":managed_vault::hash(b"new"),"sizeBytes":3,"mimeType":"text/plain","required":true}]});
        f.store.commit(m,BTreeMap::new()).unwrap();
        assert_eq!(resolve(&f.store,"local",&n.note_id,"attachments/x.txt").unwrap_err(),"VAULT_RESOURCE_MISSING");
    }

    #[test]
    fn publication_alias_requires_live_reference_and_rejects_ambiguous_hashes() {
        let f=fixture();let mut a=stage_owned(&f.store,"local",&f.note.note_id,&f.note.revision,"x","text/plain",b"one").unwrap();
        a.publication_markdown=Some("[x](attachments/x.txt)".into());publish(&f,&a);
        let n=f.store.get("local",&f.note.note_id).unwrap();f.store.save("local",&n.note_id,&n.revision,"N","[renamed](attachments/x.txt)",vec![]).unwrap();
        assert!(resolve(&f.store,"local",&n.note_id,"attachments/x.txt").is_ok());
        let n=f.store.get("local",&n.note_id).unwrap();f.store.save("local",&n.note_id,&n.revision,"N","[[attachments/x.txt]]",vec![]).unwrap();
        assert!(resolve(&f.store,"local",&n.note_id,"attachments/x.txt").is_ok());
        let mut other=a.clone();other.op_id="other".into();other.sha256=managed_vault::hash(b"other");
        let mut m=f.store.manifest("local").unwrap();m.notes.get_mut(&n.note_id).unwrap().remote["localAttachments"]=json!([a,other]);f.store.commit(m,BTreeMap::new()).unwrap();
        assert_eq!(resolve(&f.store,"local",&n.note_id,"attachments/x.txt").unwrap_err(),"VAULT_RESOURCE_AMBIGUOUS");
    }

}

#[cfg(test)]
#[path = "managed_attachment_lifecycle_tests.rs"]
mod lifecycle_tests;

