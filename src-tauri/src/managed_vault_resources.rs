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
        let available = r.status == "verified" && read_verified(&root, &current.note_id, r).is_ok();
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
