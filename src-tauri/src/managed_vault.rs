//! Managed app-private Markdown authority. SQLite is not used to read note bodies.
//! A durable roll-forward journal publishes files before their metadata checkpoint.
//! Original migration exports, old versions and trash are retained, never pruned here.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use unicode_normalization::UnicodeNormalization;

pub(crate) static GATE: OnceLock<Mutex<()>> = OnceLock::new();
pub(crate) fn lock() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    GATE.get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "VAULT_BUSY".into())
}
fn err(e: impl std::fmt::Display) -> String {
    format!("VAULT_IO: {e}")
}
pub(crate) fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn fresh() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}
fn now() -> String {
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = elapsed.as_secs();
    let z = (secs / 86400) as i64 + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if month <= 2 { 1 } else { 0 };
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        secs / 3600 % 24,
        secs / 60 % 60,
        secs % 60,
        elapsed.subsec_millis()
    )
}
fn clean(path: &str) -> bool {
    !path.is_empty()
        && !path.contains('\\')
        && !path.contains('\0')
        && !path.contains(':')
        && Path::new(path)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
        && path
            .split('/')
            .all(|s| !s.is_empty() && s != "." && s != "..")
}
fn path_key(path: &str) -> Result<String, String> {
    if !clean(path) {
        return Err("VAULT_PATH_INVALID".into());
    }
    let mut keys = Vec::new();
    for part in path.split('/') {
        if part.ends_with([' ', '.'])
            || part
                .chars()
                .any(|c| c.is_control() || "<>:\"|?*".contains(c))
        {
            return Err("VAULT_PATH_INVALID".into());
        }
        let key = part.nfc().flat_map(char::to_uppercase).collect::<String>();
        let stem = key.split('.').next().unwrap_or("");
        if [
            "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
            "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
        ]
        .contains(&stem)
        {
            return Err("VAULT_PATH_INVALID".into());
        }
        keys.push(key);
    }
    Ok(keys.join("/"))
}
fn file_hash(root: &Path, path: &str) -> Result<Option<String>, String> {
    let path = guarded(root, path)?;
    match fs::read(path) {
        Ok(bytes) => Ok(Some(hash(&bytes))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(err(e)),
    }
}
fn component(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 160
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
pub(crate) fn guarded(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if !clean(rel) {
        return Err("VAULT_PATH_INVALID".into());
    }
    let mut p = root.to_path_buf();
    if fs::symlink_metadata(root)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err("VAULT_SYMLINK".into());
    }
    for c in Path::new(rel).components() {
        p.push(c);
        if fs::symlink_metadata(&p)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err("VAULT_SYMLINK".into());
        }
    }
    Ok(p)
}
pub(crate) fn sync_dir(path: &Path) -> Result<(), String> {
    File::open(path).and_then(|f| f.sync_all()).map_err(err)
}
pub(crate) fn write_atomic(root: &Path, rel: &str, bytes: &[u8]) -> Result<(), String> {
    let path = guarded(root, rel)?;
    let parent = path.parent().ok_or("VAULT_PATH_INVALID")?;
    fs::create_dir_all(parent).map_err(err)?;
    // Unique create_new temporary avoids following an existing path or clobbering another writer.
    let temp = parent.join(format!(".stage-{}", fresh()));
    let mut f = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(err)?;
    f.write_all(bytes).and_then(|_| f.sync_all()).map_err(err)?;
    fs::rename(&temp, &path).map_err(err)?;
    sync_dir(parent)
}
fn read_json<T: for<'de> Deserialize<'de>>(root: &Path, rel: &str) -> Result<T, String> {
    serde_json::from_slice(&fs::read(guarded(root, rel)?).map_err(err)?).map_err(err)
}
fn json_bytes<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    serde_json::to_vec_pretty(value).map_err(err)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Binding {
    pub instance_id: String,
    pub remote_vault_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Note {
    pub local_vault_id: String,
    pub note_id: String,
    pub title: String,
    pub relative_path: String,
    pub folder: String,
    pub revision: String,
    pub body_state: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub content: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub pinned: bool,
    pub favorite: bool,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub historical_names: Vec<String>,
    pub sync_state: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub legacy_route: Option<String>,
    #[serde(default)]
    pub body_hash: String,
    #[serde(default)]
    pub remote: Value,
    #[serde(default)]
    pub trashed: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Manifest {
    pub version: u32,
    pub local_vault_id: String,
    pub name: String,
    pub binding: Option<Binding>,
    #[serde(default)]
    pub checkpoint: Value,
    pub generation: u64,
    pub notes: BTreeMap<String, Note>,
    pub folders: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Registry {
    version: u32,
    selected_vault_id: Option<String>,
    vault_ids: Vec<String>,
}
#[derive(Serialize, Deserialize)]
struct Journal {
    manifest: Manifest,
    writes: BTreeMap<String, String>,
    #[serde(default)]
    retire: Vec<String>,
    expected: BTreeMap<String, Option<String>>,
    manifest_preimage: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Plan {
    plan_id: String,
    source_hash: String,
    source: Value,
}

pub(crate) struct Store {
    pub(crate) root: PathBuf,
}
impl Store {
    pub fn new(app_data: &Path) -> Result<Self, String> {
        let root = app_data.join("managed-vaults");
        if fs::symlink_metadata(&root)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err("VAULT_SYMLINK".into());
        }
        fs::create_dir_all(&root).map_err(err)?;
        Ok(Self { root })
    }
    pub(crate) fn vault_root(&self, id: &str) -> Result<PathBuf, String> {
        if !component(id) {
            return Err("VAULT_ID_INVALID".into());
        }
        guarded(&self.root, id)
    }
    fn registry(&self) -> Result<Registry, String> {
        if !self.root.join("registry.json").exists() {
            return Ok(Registry {
                version: 1,
                ..Default::default()
            });
        }
        read_json(&self.root, "registry.json")
    }
    /// Explicit new library, deliberately separate from the legacy "local"
    /// migration identity. Creating one never adopts or hides old data.
    pub(crate) fn create_vault(&self, name: &str, request_id: &str) -> Result<Value, String> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 120 || name.chars().any(char::is_control) {
            return Err("VAULT_NAME_INVALID".into());
        }
        if request_id.is_empty() || request_id.len() > 160 || !request_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
            return Err("VAULT_REQUEST_INVALID".into());
        }
        let id = format!("vault-{}", hash(request_id.as_bytes()));
        // Recover an interrupted publication before inspecting the intent.
        self.recover(&id)?;
        if self.vault_root(&id)?.join("manifest.json").exists() {
            let existing = self.manifest(&id)?;
            if existing.name != name || existing.binding.is_some() { return Err("VAULT_REQUEST_CHANGED".into()); }
            self.register(&id)?;
            return self.vault_summary(&id);
        }
        self.commit(Manifest { version: 1, local_vault_id: id.clone(), name: name.into(),
            binding: None, checkpoint: Value::Null, generation: 0,
            notes: BTreeMap::new(), folders: Vec::new() }, BTreeMap::new())?;
        self.register(&id)?;
        self.vault_summary(&id)
    }
    pub(crate) fn vault_summary(&self, id: &str) -> Result<Value, String> {
        self.list()?["items"].as_array().and_then(|rows| rows.iter().find(|row| row["localVaultId"] == id))
            .cloned().ok_or_else(|| "VAULT_NOT_FOUND".into())
    }
    pub(crate) fn register(&self, id: &str) -> Result<(), String> {
        let mut r = self.registry()?;
        if !r.vault_ids.iter().any(|v| v == id) {
            r.vault_ids.push(id.into());
        }
        if r.selected_vault_id.is_none() {
            r.selected_vault_id = Some(id.into());
        }
        write_atomic(&self.root, "registry.json", &json_bytes(&r)?)
    }
    pub fn recover(&self, id: &str) -> Result<(), String> {
        let root = self.vault_root(id)?;
        if !root.join("journal.json").exists() {
            return Ok(());
        }
        let j: Journal = read_json(&root, "journal.json")?;
        if j.manifest.local_vault_id != id {
            return Err("VAULT_JOURNAL_INVALID".into());
        }
        let manifest_bytes = json_bytes(&j.manifest)?;
        let current_manifest = file_hash(&root, "manifest.json")?;
        if current_manifest != j.manifest_preimage
            && current_manifest != Some(hash(&manifest_bytes))
        {
            return Err("VAULT_RECOVERY_CONFLICT".into());
        }
        // Check every pre/post image BEFORE touching any file. Unknown bytes are retained.
        for (path, content) in &j.writes {
            let current = file_hash(&root, path)?;
            let expected = j.expected.get(path).ok_or("VAULT_JOURNAL_INVALID")?;
            if &current != expected && current != Some(hash(content.as_bytes())) {
                return Err("VAULT_RECOVERY_CONFLICT".into());
            }
        }
        for path in &j.retire {
            let current = file_hash(&root, path)?;
            let expected = j.expected.get(path).ok_or("VAULT_JOURNAL_INVALID")?;
            if current.is_some() && &current != expected {
                return Err("VAULT_RECOVERY_CONFLICT".into());
            }
        }
        for folder in &j.manifest.folders {
            let path = guarded(&root, folder)?;
            if path.exists() && !path.is_dir() {
                return Err("VAULT_RECOVERY_CONFLICT".into());
            }
        }
        for folder in &j.manifest.folders {
            let path = guarded(&root, folder)?;
            fs::create_dir_all(&path).map_err(err)?;
            sync_dir(&path)?;
            sync_dir(path.parent().ok_or("VAULT_PATH_INVALID")?)?;
        }
        for (path, content) in &j.writes {
            if file_hash(&root, path)? != Some(hash(content.as_bytes())) {
                write_atomic(&root, path, content.as_bytes())?;
            }
        }
        write_atomic(&root, "manifest.json", &json_bytes(&j.manifest)?)?;
        for path in &j.retire {
            let path = guarded(&root, path)?;
            if path.exists() {
                fs::remove_file(&path).map_err(err)?;
                sync_dir(path.parent().ok_or("VAULT_PATH_INVALID")?)?;
            }
        }
        fs::remove_file(root.join("journal.json")).map_err(err)?;
        sync_dir(&root)
    }
    pub fn manifest(&self, id: &str) -> Result<Manifest, String> {
        self.recover(id)?;
        let m: Manifest = read_json(&self.vault_root(id)?, "manifest.json")?;
        if m.version != 1 || m.local_vault_id != id {
            return Err("VAULT_MANIFEST_INVALID".into());
        }
        Ok(m)
    }
    pub(crate) fn commit(
        &self,
        m: Manifest,
        writes: BTreeMap<String, String>,
    ) -> Result<(), String> {
        self.commit_retire(m, writes, Vec::new())
    }
    pub(crate) fn commit_retire(
        &self,
        mut m: Manifest,
        writes: BTreeMap<String, String>,
        retire: Vec<String>,
    ) -> Result<(), String> {
        let root = self.vault_root(&m.local_vault_id)?;
        self.recover(&m.local_vault_id)?;
        fs::create_dir_all(&root).map_err(err)?;
        m.generation = m
            .generation
            .checked_add(1)
            .ok_or("VAULT_GENERATION_OVERFLOW")?;
        // Central validation also applies to imports and replicas, not just migration.
        let mut ids = std::collections::BTreeSet::new();
        let mut paths = std::collections::BTreeSet::new();
        for note in m.notes.values() {
            if !ids.insert(
                note.note_id
                    .nfc()
                    .flat_map(char::to_uppercase)
                    .collect::<String>(),
            ) {
                return Err("VAULT_PATH_COLLISION".into());
            }
            if !note.trashed && !paths.insert(path_key(&note.relative_path)?) {
                return Err("VAULT_PATH_COLLISION".into());
            }
        }
        let mut folders = std::collections::BTreeSet::new();
        for folder in &m.folders {
            if folder
                .split('/')
                .any(|p| p.eq_ignore_ascii_case(".luckyray"))
                || !folders.insert(path_key(folder)?)
                || paths.contains(&path_key(folder)?)
            {
                return Err("VAULT_PATH_COLLISION".into());
            }
        }
        for path in paths.iter().chain(folders.iter()) {
            let parts = path.split('/').collect::<Vec<_>>();
            for i in 1..parts.len() {
                if paths.contains(&parts[..i].join("/")) {
                    return Err("VAULT_PATH_COLLISION".into());
                }
            }
            if ["MANIFEST.JSON", "JOURNAL.JSON", ".LUCKYRAY"].contains(&parts[0]) {
                return Err("VAULT_PATH_INVALID".into());
            }
        }
        let manifest_preimage = file_hash(&root, "manifest.json")?;
        let old: Option<Manifest> = if manifest_preimage.is_some() {
            Some(read_json(&root, "manifest.json")?)
        } else {
            None
        };
        for note in m.notes.values_mut() {
            note.content = None;
        }
        if let Some(prior) = &old {
            if prior.generation == m.generation && json_bytes(prior)? == json_bytes(&m)? {
                for (path, body) in &writes {
                    if file_hash(&root, path)? != Some(hash(body.as_bytes())) {
                        return Err("VAULT_RECOVERY_CONFLICT".into());
                    }
                }
                for path in &retire {
                    if file_hash(&root, path)?.is_some() {
                        return Err("VAULT_RECOVERY_CONFLICT".into());
                    }
                }
                return Ok(());
            }
        }
        if old
            .as_ref()
            .is_some_and(|old| m.generation != old.generation.saturating_add(1))
        {
            return Err("VAULT_MANIFEST_CHANGED".into());
        }
        let mut expected = BTreeMap::new();
        for path in writes.keys().chain(retire.iter()) {
            guarded(&root, path)?;
            let before = file_hash(&root, path)?;
            if let Some(prior) = old.as_ref().and_then(|m| {
                m.notes
                    .values()
                    .find(|n| !n.trashed && n.body_state != "missing" && n.relative_path == *path)
            }) {
                if before != Some(prior.body_hash.clone()) {
                    return Err("VAULT_FILE_CHANGED".into());
                }
                if retire.contains(path)
                    && !writes.iter().any(|(backup, body)| {
                        backup.starts_with(".luckyray/") && hash(body.as_bytes()) == prior.body_hash
                    })
                {
                    return Err("VAULT_RETIRE_WITHOUT_BACKUP".into());
                }
            } else {
                if retire.contains(path) {
                    return Err("VAULT_RETIRE_UNOWNED".into());
                }
                if before.is_some() && before != writes.get(path).map(|body| hash(body.as_bytes()))
                {
                    return Err("VAULT_DESTINATION_EXISTS".into());
                }
            }
            expected.insert(path.clone(), before);
        }
        for note in m.notes.values_mut() {
            note.content = None;
        }
        write_atomic(
            &root,
            "journal.json",
            &json_bytes(&Journal {
                manifest: m.clone(),
                writes,
                retire,
                expected,
                manifest_preimage,
            })?,
        )?;
        self.recover(&m.local_vault_id)
    }
    pub fn list(&self) -> Result<Value, String> {
        let r = self.registry()?;
        let mut items = Vec::new();
        for id in &r.vault_ids {
            let m = self.manifest(id)?;
            items.push(json!({"localVaultId":id,"name":m.name,"binding":m.binding,"migrationState":"ready","transferState":m.checkpoint["transfer"]["state"],"transferTargetVaultId":m.checkpoint["transfer"]["targetVaultId"],"noteCount":m.notes.values().filter(|n|!n.trashed && !n.remote["transferredTo"].is_object()).count()}));
        }
        // A completed transfer may crash before registry selection is persisted.
        // Honor only its verified explicit destination, never choose another vault.
        let mut selected=r.selected_vault_id.clone();
        if let Some(id)=selected.as_deref() {
            let source=self.manifest(id)?;
            if source.checkpoint["transfer"]["state"]=="completed" {
                let target=source.checkpoint["transfer"]["targetVaultId"].as_str().ok_or("VAULT_TRANSFER_TARGET_MISSING")?;
                if target==id || !r.vault_ids.iter().any(|v|v==target) {return Err("VAULT_TRANSFER_TARGET_MISSING".into());}
                let target_manifest=self.manifest(target)?;
                if target_manifest.binding.is_none() || target_manifest.checkpoint["transfer"]["state"]=="completed" {return Err("VAULT_TRANSFER_TARGET_MISSING".into());}
                let plan: Value = if source.checkpoint["transfer"]["linkedPlan"]==true {
                    let linked:Value=read_json(&self.vault_root(id)?,".luckyray/linked-import-plan.json")?;
                    linked["snapshot"].clone()
                } else {read_json(&self.vault_root(id)?, ".luckyray/transfer-plan.json")?};
                let fingerprint = hash(&serde_json::to_vec(&json!([
                    plan["version"], plan["sourceVaultId"], plan["targetVaultId"],
                    plan["targetBinding"], plan["notes"], plan["folders"]
                ])).map_err(err)?);
                if source.binding.is_some() || plan["version"] != 1
                    || plan["sourceVaultId"] != id || plan["targetVaultId"] != target
                    || plan["snapshotHash"] != fingerprint
                    || serde_json::to_value(&target_manifest.binding).map_err(err)? != plan["targetBinding"]
                { return Err("VAULT_TRANSFER_TARGET_CHANGED".into()); }
                selected=Some(target.to_owned());
            }
        }
        Ok(json!({"items":items,"selectedVaultId":selected}))
    }
    pub fn select(&self, id: &str) -> Result<(), String> {
        let m = self.manifest(id)?;
        if m.checkpoint["transfer"]["state"] == "completed" { return Err("VAULT_TRANSFERRED".into()); }
        let mut r = self.registry()?;
        if !r.vault_ids.iter().any(|v| v == id) {
            return Err("VAULT_NOT_REGISTERED".into());
        }
        r.selected_vault_id = Some(id.into());
        write_atomic(&self.root, "registry.json", &json_bytes(&r)?)
    }
    pub fn get(&self, id: &str, note_id: &str) -> Result<Note, String> {
        let m = self.manifest(id)?;
        let n = m
            .notes
            .get(note_id)
            .cloned()
            .filter(|n| !n.trashed)
            .ok_or("VAULT_NOTE_NOT_FOUND")?;
        self.read_body(id, n)
    }
    fn read_body(&self, id: &str, mut n: Note) -> Result<Note, String> {
        if n.body_state != "missing" {
            let body = fs::read(guarded(&self.vault_root(id)?, &n.relative_path)?).map_err(err)?;
            let actual_hash = hash(&body);
            if actual_hash != n.body_hash {
                n.body_state = "conflict".into();
                n.sync_state = "conflict".into();
                if !n.remote.is_object() {
                    n.remote = json!({});
                }
                n.remote["localFileConflict"] =
                    json!({"expectedHash":n.body_hash,"actualHash":actual_hash});
                n.body_hash = actual_hash;
            }
            n.content = Some(String::from_utf8(body).map_err(err)?);
        }
        Ok(n)
    }
    fn checked(&self, id: &str, note_id: &str, rev: &str) -> Result<(Manifest, Note), String> {
        self.check_writable(&self.manifest(id)?)?;
        let n = self.get(id, note_id)?;
        if n.remote["transferredTo"].is_object() { return Err("VAULT_NOTE_TRANSFERRED".into()); }
        if n.remote["transferPending"].is_object() { return Err("VAULT_NOTE_TRANSFER_PENDING".into()); }
        if n.revision != rev {
            return Err("VAULT_REVISION_CONFLICT".into());
        }
        if n.body_state != "ready" {
            return Err("VAULT_BODY_NOT_EDITABLE".into());
        }
        Ok((self.manifest(id)?, n))
    }
    pub(crate) fn writable_manifest(&self, id: &str) -> Result<Manifest, String> {
        let manifest = self.manifest(id)?;
        self.check_writable(&manifest)?;
        Ok(manifest)
    }
    fn check_writable(&self, m: &Manifest) -> Result<(), String> {
        if m.checkpoint["transfer"]["state"] == "completed" { return Err("VAULT_TRANSFERRED".into()); }
        if m.checkpoint["transfer"]["state"] == "pending" { return Err("VAULT_TRANSFER_PENDING".into()); }
        if let Some(binding) = &m.binding {
            if binding.instance_id.trim().is_empty() || binding.remote_vault_id.trim().is_empty()
                || binding.instance_id.chars().any(char::is_control) || binding.remote_vault_id.chars().any(char::is_control) {
                return Err("VAULT_BINDING_INVALID".into());
            }
            let mut matching = 0;
            for id in self.registry()?.vault_ids {
                let other = self.manifest(&id)?;
                if other.binding.as_ref() == Some(binding) { matching += 1; }
            }
            if matching != 1 { return Err("MANAGED_SYNC_BINDING_AMBIGUOUS".into()); }
        }
        Ok(())
    }
    pub(crate) fn path(folder: &str, title: &str, note_id: &str) -> Result<String, String> {
        if !component(note_id)
            || (!folder.is_empty()
                && (!clean(folder)
                    || folder
                        .split('/')
                        .any(|p| p.eq_ignore_ascii_case(".luckyray"))))
        {
            return Err("VAULT_PATH_INVALID".into());
        }
        let mut name = String::new();
        for ch in title.trim().chars() {
            let ch = if ch.is_control() || "<>:\"/\\|?*".contains(ch) {
                '_'
            } else {
                ch
            };
            if name.len() + ch.len_utf8() > 64 {
                break;
            }
            name.push(ch);
        }
        let name = name.trim_matches([' ', '.']);
        let name = if name.is_empty() { "未命名" } else { name };
        // Permanent identity suffix avoids title/case/Unicode-normalization collisions.
        Ok(format!(
            "{}{}--{}.md",
            if folder.is_empty() {
                String::new()
            } else {
                format!("{folder}/")
            },
            name,
            note_id
        ))
    }
    pub fn create(
        &self,
        id: &str,
        title: &str,
        content: &str,
        tags: Vec<String>,
        folder: &str,
    ) -> Result<Note, String> {
        let mut m = self.manifest(id)?;
        self.check_writable(&m)?;
        if m.binding.is_some() {
            return Err("VAULT_REMOTE_SAVE_REQUIRES_BRIDGE".into());
        }
        if !folder.is_empty() && !m.folders.iter().any(|v| v == folder) {
            return Err("VAULT_FOLDER_NOT_FOUND".into());
        }
        let note_id = format!("note-{}", fresh());
        let time = now();
        let n = Note {
            local_vault_id: id.into(),
            note_id: note_id.clone(),
            title: title.into(),
            relative_path: Self::path(folder, title, &note_id)?,
            folder: folder.into(),
            revision: fresh(),
            body_state: "ready".into(),
            content: None,
            tags,
            pinned: false,
            favorite: false,
            archived: false,
            created_at: time.clone(),
            updated_at: time,
            historical_names: Vec::new(),
            sync_state: if m.binding.is_some() {
                "pending"
            } else {
                "local"
            }
            .into(),
            legacy_route: None,
            body_hash: hash(content.as_bytes()),
            remote: Value::Null,
            trashed: false,
        };
        let mut writes = BTreeMap::new();
        writes.insert(n.relative_path.clone(), content.into());
        m.notes.insert(note_id.clone(), n);
        self.commit(m, writes)?;
        self.get(id, &note_id)
    }
    pub fn save(
        &self,
        id: &str,
        note_id: &str,
        rev: &str,
        title: &str,
        content: &str,
        tags: Vec<String>,
    ) -> Result<Note, String> {
        let (mut m, mut n) = self.checked(id, note_id, rev)?;
        if m.binding.is_some() {
            return Err("VAULT_REMOTE_SAVE_REQUIRES_BRIDGE".into());
        }
        let previous = n.content.take().ok_or("VAULT_BODY_MISSING")?;
        let mut writes = BTreeMap::new();
        writes.insert(
            format!(".luckyray/history/{note_id}/{}.md", n.revision),
            previous,
        );
        let old_path = n.relative_path.clone();
        n.relative_path = Self::path(&n.folder, title, note_id)?;
        writes.insert(n.relative_path.clone(), content.into());
        if n.title != title && !n.title.is_empty() && !n.historical_names.contains(&n.title) {
            n.historical_names.push(n.title.clone());
        }
        n.title = title.into();
        n.tags = tags;
        n.body_hash = hash(content.as_bytes());
        n.revision = fresh();
        n.updated_at = now();
        n.sync_state = if m.binding.is_some() {
            "pending"
        } else {
            "local"
        }
        .into();
        let retire = if old_path == n.relative_path {
            Vec::new()
        } else {
            vec![old_path]
        };
        m.notes.insert(note_id.into(), n);
        self.commit_retire(m, writes, retire)?;
        self.get(id, note_id)
    }
    pub fn move_note(
        &self,
        id: &str,
        note_id: &str,
        rev: &str,
        folder: &str,
    ) -> Result<Note, String> {
        let (mut m, mut n) = self.checked(id, note_id, rev)?;
        if !folder.is_empty() && !m.folders.iter().any(|v| v == folder) {
            return Err("VAULT_FOLDER_NOT_FOUND".into());
        }
        if m.binding.is_some() {
            return Err("VAULT_REMOTE_MOVE_NOT_READY".into());
        }
        let body = n.content.take().ok_or("VAULT_BODY_MISSING")?;
        let old_path = n.relative_path.clone();
        let mut writes = BTreeMap::new();
        writes.insert(
            format!(".luckyray/history/{note_id}/{}.md", n.revision),
            body.clone(),
        );
        n.folder = folder.into();
        n.relative_path = Self::path(folder, &n.title, note_id)?;
        writes.insert(n.relative_path.clone(), body);
        n.revision = fresh();
        n.updated_at = now();
        let retire = if old_path == n.relative_path {
            Vec::new()
        } else {
            vec![old_path]
        };
        m.notes.insert(note_id.into(), n);
        self.commit_retire(m, writes, retire)?;
        self.get(id, note_id)
    }
    pub fn trash(&self, id: &str, note_id: &str, rev: &str) -> Result<(), String> {
        let (mut m, mut n) = self.checked(id, note_id, rev)?;
        if m.binding.is_some() {
            return Err("VAULT_REMOTE_DELETE_NOT_READY".into());
        }
        let mut writes = BTreeMap::new();
        writes.insert(
            format!(".luckyray/trash/{note_id}/{}.md", n.revision),
            n.content.take().ok_or("VAULT_BODY_MISSING")?,
        );
        let old_path = n.relative_path.clone();
        n.trashed = true;
        n.revision = fresh();
        m.notes.insert(note_id.into(), n);
        self.commit_retire(m, writes, vec![old_path])
    }
    pub fn flags(&self, id: &str, note_id: &str, rev: &str, flags: &Value) -> Result<Note, String> {
        let (mut m, mut n) = self.checked(id, note_id, rev)?;
        if let Some(v) = flags["pinned"].as_bool() {
            n.pinned = v;
        }
        if let Some(v) = flags["favorite"].as_bool() {
            n.favorite = v;
        }
        if let Some(v) = flags["archived"].as_bool() {
            n.archived = v;
        }
        n.revision = fresh();
        m.notes.insert(note_id.into(), n);
        self.commit(m, BTreeMap::new())?;
        self.get(id, note_id)
    }
    pub fn folder_create(&self, id: &str, name: &str, parent: &str) -> Result<Value, String> {
        if name.eq_ignore_ascii_case(".luckyray")
            || name.trim() != name
            || name.is_empty()
            || name.contains('/')
            || !clean(name)
        {
            return Err("VAULT_PATH_INVALID".into());
        }
        let mut m = self.manifest(id)?;
        self.check_writable(&m)?;
        if !parent.is_empty() && !m.folders.iter().any(|v| v == parent) {
            return Err("VAULT_FOLDER_NOT_FOUND".into());
        }
        let path = if parent.is_empty() {
            name.into()
        } else {
            format!("{parent}/{name}")
        };
        if m.folders
            .iter()
            .any(|s| s.to_lowercase() == path.to_lowercase())
        {
            return Err("VAULT_FOLDER_EXISTS".into());
        }
        m.folders.push(path.clone());
        m.folders.sort();
        self.commit(m, BTreeMap::new())?;
        Ok(json!({"path":path}))
    }
    pub fn folders(&self, id: &str) -> Result<Value, String> {
        Ok(json!({"paths":self.manifest(id)?.folders}))
    }
    pub fn notes(&self, q: &Value) -> Result<Value, String> {
        let id = q["localVaultId"].as_str().ok_or("VAULT_ID_INVALID")?;
        let m = self.manifest(id)?;
        let needle = q["q"].as_str().unwrap_or("").trim().to_lowercase();
        let mut notes = Vec::new();
        for n in m.notes.values().filter(|n| !n.trashed && !n.remote["transferredTo"].is_object()) {
            if let Some(folder) = q["folder"].as_str() {
                if n.folder != folder {
                    continue;
                }
            }
            if let Some(tag) = q["tag"].as_str().filter(|s| !s.is_empty()) {
                if !n.tags.iter().any(|s| s == tag) {
                    continue;
                }
            }
            if ["pinned", "favorite", "archived"].iter().any(|key| {
                q[*key].as_bool().is_some_and(|v| {
                    v != match *key {
                        "pinned" => n.pinned,
                        "favorite" => n.favorite,
                        _ => n.archived,
                    }
                })
            }) {
                continue;
            }
            if !needle.is_empty() && !n.title.to_lowercase().contains(&needle) {
                let note = self.read_body(id, n.clone())?;
                if !note
                    .content
                    .as_deref()
                    .unwrap_or("")
                    .to_lowercase()
                    .contains(&needle)
                {
                    continue;
                }
            }
            // Retain metadata only while sorting; materialize at most one page of bodies.
            notes.push(n.clone());
        }
        if q["sort"] == "name" {
            notes.sort_by(|a, b| {
                a.title
                    .to_lowercase()
                    .cmp(&b.title.to_lowercase())
                    .then(a.note_id.cmp(&b.note_id))
            });
        } else {
            notes.sort_by(|a, b| {
                b.pinned
                    .cmp(&a.pinned)
                    .then(b.updated_at.cmp(&a.updated_at))
                    .then(a.note_id.cmp(&b.note_id))
            });
        }
        let total = notes.len();
        let page = q["page"].as_u64().unwrap_or(1).max(1) as usize;
        let limit = q["limit"].as_u64().unwrap_or(50).clamp(1, 200) as usize;
        let start = (page - 1).saturating_mul(limit);
        let items = notes
            .into_iter()
            .skip(start)
            .take(limit)
            .map(|n| self.read_body(id, n))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(json!({"items":items,"total":total,"hasMore":start.saturating_add(limit)<total}))
    }
    pub fn catalog(&self, id: &str) -> Result<Value, String> {
        let m = self.manifest(id)?;
        Ok(json!({"items":m.notes.values().filter(|n|!n.trashed && !n.remote["transferredTo"].is_object()).collect::<Vec<_>>()}))
    }
    pub(crate) fn guard_legacy_write(&self, note_id: Option<&str>) -> Result<(), String> {
        let protected = if let Some(id) = note_id {
            let mut found = false;
            for vault in self.registry()?.vault_ids {
                let manifest = self.manifest(&vault)?;
                // Tombstones still protect the retained legacy migration source.
                if manifest.notes.values().any(|n| {
                    n.legacy_route.as_deref() == Some(id)
                        || n.remote["legacyImportNoteId"].as_str() == Some(id)
                }) {
                    found = true;
                    break;
                }
            }
            found
        } else {
            self.registry()?.vault_ids.iter().any(|id| id == "local")
        };
        if protected {
            return Err("VAULT_LEGACY_NOTE_MIGRATED".into());
        }
        Ok(())
    }
    pub fn resolve(&self, route: &str) -> Result<Value, String> {
        let mut original = Value::Null;
        for id in self.registry()?.vault_ids {
            let m = self.manifest(&id)?;
            for n in m.notes.values().filter(|n| !n.trashed) {
                if n.legacy_route.as_deref() == Some(route)
                    || n.remote["legacyImportNoteId"].as_str() == Some(route)
                    || (n.note_id == route && n.remote["transferredTo"].is_object())
                {
                    if n.remote["transferredTo"].is_object() {
                        let target = &n.remote["transferredTo"];
                        let vault = target["localVaultId"].as_str().ok_or("VAULT_TRANSFER_INVALID")?;
                        let note = target["noteId"].as_str().ok_or("VAULT_TRANSFER_INVALID")?;
                        self.get(vault, note)?; // Never redirect to an absent/unverified identity.
                        return Ok(json!({"localVaultId":vault,"noteId":note}));
                    }
                    if original.is_null() { original = json!({"localVaultId":id,"noteId":n.note_id}); }
                }
            }
        }
        Ok(original)
    }
    pub fn migration_status(&self) -> Result<Value, String> {
        let local_ready = self.registry()?.vault_ids.iter().any(|v| v == "local");
        if self.root.join("migration-plan.json").exists() {
            let p: Plan = read_json(&self.root, "migration-plan.json")?;
            let complete = if p.source.get("replicas").is_some() {
                if self.root.join("migration-complete.json").exists() {
                    let receipt: Value = read_json(&self.root, "migration-complete.json")?;
                    receipt["planId"] == p.plan_id && receipt["sourceHash"] == p.source_hash
                } else { false }
            } else { local_ready };
            let local_count = p.source["notes"].as_array().map_or(0, Vec::len);
            let replica_count = p.source["replicas"]["noteCount"].as_u64().unwrap_or(0);
            return Ok(json!({"state":if local_ready && complete {"ready"} else {"prepared"},
                "localVaultId":"local","noteCount":local_count as u64 + replica_count,
                "localNoteCount":local_count,"replicaNoteCount":replica_count,
                "replicaVaultCount":p.source["replicas"]["scopes"].as_array().map_or(0, Vec::len),
                "planId":p.plan_id,"warnings":[]}));
        }
        if local_ready {
            let m = self.manifest("local")?;
            return Ok(json!({"state":"ready","localVaultId":"local","noteCount":m.notes.len(),"warnings":[]}));
        }
        Ok(json!({"state":"not-migrated","localVaultId":"local","noteCount":0,"warnings":[]}))
    }
    /// Re-preview may extend unpublished scopes, never certify a changed source
    /// against stale already-published files. Both copies remain on conflict.
    fn verify_published_migration(&self, source: &Value, require_all: bool) -> Result<(), String> {
        let registry = self.registry()?;
        if registry.vault_ids.iter().any(|id| id == "local") {
            let m = self.manifest("local")?;
            let items = source["notes"].as_array().ok_or("VAULT_MIGRATION_INVALID")?;
            let folders: Vec<String> = serde_json::from_value(source["folders"].clone()).map_err(err)?;
            if m.notes.len() != items.len() || m.folders != folders { return Err("VAULT_MIGRATION_RECOVERY_CONFLICT".into()); }
            for item in items {
                let id=item["noteId"].as_str().ok_or("VAULT_MIGRATION_INVALID")?;
                let n=self.get("local",id)?;
                if n.body_state != "ready" || n.content.as_deref() != item["content"].as_str()
                    || n.title != item["title"].as_str().unwrap_or("")
                    || n.folder != item["folder"].as_str().unwrap_or("")
                    || json!(n.tags) != item["tags"] || n.pinned != (item["pinned"] == true)
                    || n.favorite != (item["favorite"] == true) || n.archived != (item["archived"] == true)
                    || n.created_at != item["createdAt"].as_str().unwrap_or("")
                    || n.updated_at != item["updatedAt"].as_str().unwrap_or("")
                    || json!(n.historical_names) != source["history"][id].as_array().map(|v| json!(v)).unwrap_or(json!([]))
                { return Err("VAULT_MIGRATION_RECOVERY_CONFLICT".into()); }
            }
        } else if require_all { return Err("VAULT_MIGRATION_INCOMPLETE".into()); }
        if let Some(scopes)=source["replicas"]["scopes"].as_array() {
            for id in &registry.vault_ids {
                let m=self.manifest(id)?;
                if let Some(binding)=m.binding {
                    if !scopes.iter().any(|s| s["scope"]["instanceId"]==binding.instance_id && s["scope"]["vaultId"]==binding.remote_vault_id) {
                        return Err("VAULT_MIGRATION_RECOVERY_CONFLICT".into());
                    }
                }
            }
            for snapshot in scopes {
                let instance=snapshot["scope"]["instanceId"].as_str().ok_or("VAULT_MIGRATION_INVALID")?;
                let vault=snapshot["scope"]["vaultId"].as_str().ok_or("VAULT_MIGRATION_INVALID")?;
                let mut found=false;
                for id in &registry.vault_ids {
                    let m=self.manifest(id)?;
                    if m.binding.as_ref().is_some_and(|b| b.instance_id==instance && b.remote_vault_id==vault) {
                        found=true;
                        if m.checkpoint != *snapshot { return Err("VAULT_MIGRATION_RECOVERY_CONFLICT".into()); }
                        for n in m.notes.values().filter(|n| !n.trashed && n.body_state=="ready") {
                            if self.get(id,&n.note_id)?.body_state != "ready" { return Err("VAULT_MIGRATION_RECOVERY_CONFLICT".into()); }
                        }
                    }
                }
                if require_all && !found { return Err("VAULT_MIGRATION_INCOMPLETE".into()); }
            }
        }
        Ok(())
    }
    pub fn prepare_migration(&self, source: Value) -> Result<Value, String> {
        let status = self.migration_status()?;
        if status["state"] == "ready" { return Ok(status); }
        let source_hash = hash(&json_bytes(&source)?);
        if self.root.join("migration-plan.json").exists() {
            let p: Plan = read_json(&self.root, "migration-plan.json")?;
            if p.source_hash == source_hash { return Ok(status); }
        }
        self.verify_published_migration(&source, false)?;
        let p = Plan { plan_id: fresh(), source_hash, source };
        write_atomic(&self.root, "migration-plan.json", &json_bytes(&p)?)?;
        self.migration_status()
    }
    /// Publish readiness only after every previewed replica has been registered.
    /// Retrying after interruption keeps the same plan and never rewrites local notes.
    pub(crate) fn complete_migration(&self, plan_id: &str, current_source: &Value) -> Result<Value, String> {
        let p: Plan = read_json(&self.root, "migration-plan.json")?;
        if p.plan_id != plan_id { return Err("VAULT_MIGRATION_PLAN_CHANGED".into()); }
        if hash(&json_bytes(current_source)?) != p.source_hash { return Err("VAULT_MIGRATION_SOURCE_CHANGED".into()); }
        if !self.registry()?.vault_ids.iter().any(|v| v == "local") { return Err("VAULT_MIGRATION_INCOMPLETE".into()); }
        if let Some(scopes) = p.source["replicas"]["scopes"].as_array() {
            let registered = self.registry()?;
            for scope in scopes {
                let instance = scope["scope"]["instanceId"].as_str().ok_or("VAULT_MIGRATION_INVALID")?;
                let vault = scope["scope"]["vaultId"].as_str().ok_or("VAULT_MIGRATION_INVALID")?;
                let mut found = false;
                for id in &registered.vault_ids {
                    let m = self.manifest(id)?;
                    if m.binding.as_ref().is_some_and(|b| b.instance_id == instance && b.remote_vault_id == vault) { found = true; break; }
                }
                if !found { return Err("VAULT_MIGRATION_INCOMPLETE".into()); }
            }
        }
        self.verify_published_migration(current_source, true)?;
        write_atomic(&self.root, "migration-complete.json", &json_bytes(&json!({"planId":p.plan_id,"sourceHash":p.source_hash}))?)?;
        self.migration_status()
    }
    pub fn commit_migration(&self, plan_id: &str, current_source: &Value) -> Result<Value, String> {
        let p: Plan = read_json(&self.root, "migration-plan.json")?;
        if p.plan_id != plan_id {
            return Err("VAULT_MIGRATION_PLAN_CHANGED".into());
        }
        if hash(&json_bytes(current_source)?) != p.source_hash {
            return Err("VAULT_MIGRATION_SOURCE_CHANGED".into());
        }
        if self.registry()?.vault_ids.iter().any(|v| v == "local") {
            self.verify_published_migration(current_source, false)?;
            return self.migration_status();
        }
        let mut m = Manifest {
            version: 1,
            local_vault_id: "local".into(),
            name: "笔记".into(),
            binding: None,
            checkpoint: Value::Null,
            generation: 0,
            notes: BTreeMap::new(),
            folders: Vec::new(),
        };
        let mut writes = BTreeMap::new();
        for folder in p.source["folders"]
            .as_array()
            .ok_or("VAULT_MIGRATION_INVALID")?
        {
            let folder = folder.as_str().ok_or("VAULT_MIGRATION_INVALID")?;
            if !clean(folder) {
                return Err("VAULT_PATH_INVALID".into());
            }
            m.folders.push(folder.into());
        }
        for item in p.source["notes"]
            .as_array()
            .ok_or("VAULT_MIGRATION_INVALID")?
        {
            let id = item["noteId"].as_str().ok_or("VAULT_MIGRATION_INVALID")?;
            if !component(id) || m.notes.contains_key(id) {
                return Err("VAULT_MIGRATION_ID_COLLISION".into());
            }
            let folder = item["folder"].as_str().unwrap_or("");
            let content = item["content"]
                .as_str()
                .ok_or("VAULT_MIGRATION_BODY_MISSING")?;
            let path = Self::path(folder, item["title"].as_str().unwrap_or(""), id)?;
            let strv = |key: &str| item[key].as_str().unwrap_or("").to_owned();
            let n = Note {
                local_vault_id: "local".into(),
                note_id: id.into(),
                title: strv("title"),
                relative_path: path.clone(),
                folder: folder.into(),
                revision: fresh(),
                body_state: "ready".into(),
                content: None,
                tags: serde_json::from_value(item["tags"].clone()).map_err(err)?,
                pinned: item["pinned"] == true,
                favorite: item["favorite"] == true,
                archived: item["archived"] == true,
                created_at: strv("createdAt"),
                updated_at: strv("updatedAt"),
                historical_names: p.source["history"][id]
                    .as_array()
                    .map(|v| {
                        v.iter()
                            .filter_map(|s| s.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default(),
                sync_state: "local".into(),
                legacy_route: Some(id.into()),
                body_hash: hash(content.as_bytes()),
                remote: Value::Null,
                trashed: false,
            };
            writes.insert(path, content.into());
            m.notes.insert(id.into(), n);
        }
        let root = self.vault_root("local")?;
        fs::create_dir_all(&root).map_err(err)?;
        // Retain a full logical source backup, including original IDs and metadata.
        let source_bytes = json_bytes(&p.source)?;
        if file_hash(&root, ".luckyray/migration-source.json")?
            .is_some_and(|h| h != hash(&source_bytes))
        {
            return Err("VAULT_MIGRATION_BACKUP_EXISTS".into());
        }
        write_atomic(&root, ".luckyray/migration-source.json", &source_bytes)?;
        self.recover("local")?;
        if root.join("manifest.json").exists() {
            let existing = self.manifest("local")?;
            if existing.notes.len() != m.notes.len() || existing.binding.is_some() {
                return Err("VAULT_MIGRATION_CHECKPOINT_CHANGED".into());
            }
            for (id, note) in &m.notes {
                let old = self.get("local", id)?;
                if old.body_hash != note.body_hash
                    || old.title != note.title
                    || old.folder != note.folder
                    || old.tags != note.tags
                    || old.pinned != note.pinned
                    || old.favorite != note.favorite
                    || old.archived != note.archived
                    || old.historical_names != note.historical_names
                {
                    return Err("VAULT_MIGRATION_CHECKPOINT_CHANGED".into());
                }
            }
            self.register("local")?;
            return self.migration_status();
        }
        self.commit(m.clone(), writes)?;
        for note in m.notes.values() {
            let actual = self.get("local", &note.note_id)?;
            if actual.body_hash != note.body_hash {
                return Err("VAULT_MIGRATION_VERIFY_FAILED".into());
            }
        }
        self.register("local")?;
        self.migration_status()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (PathBuf, Store, Value) {
        let root = std::env::temp_dir().join(format!("managed-vault-test-{}", fresh()));
        let s = Store::new(&root).unwrap();
        let source = json!({"notes":[{"noteId":"note-one","title":"同名","content":"---\ntags: [x]\n---\n正文 ![附件](luckyray-local-asset:asset-a)\n","folder":"目录","tags":["x"],"pinned":true,"favorite":true,"archived":false,"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-02T00:00:00Z","sourceInboxId":"inbox-one"},{"noteId":"note-two","title":"同名","content":"","folder":"","tags":[],"pinned":false,"favorite":false,"archived":true,"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-02T00:00:00Z"}],"folders":["目录","空目录"],"history":{"note-one":["旧名字"]}});
        (root, s, source)
    }
    fn migrate(s: &Store, source: &Value) {
        let p = s.prepare_migration(source.clone()).unwrap();
        s.commit_migration(p["planId"].as_str().unwrap(), source)
            .unwrap();
    }
    #[test]
    fn invalid_or_ambiguous_binding_is_readable_but_never_writable() {
        let (root, store, source) = fixture();
        migrate(&store, &source);
        let independent = store.create_vault("独立库", "independent-request").unwrap();
        let independent_id = independent["localVaultId"].as_str().unwrap();
        let mut m = store.manifest("local").unwrap();
        m.binding = Some(Binding { instance_id: "".into(), remote_vault_id: "v".into() });
        store.commit(m, BTreeMap::new()).unwrap();
        assert_eq!(store.writable_manifest("local").err().unwrap(), "VAULT_BINDING_INVALID");
        let note = store.get("local", "note-one").unwrap();
        assert!(note.content.is_some());
        assert!(store.flags("local", "note-one", &note.revision, &json!({"pinned":false})).is_err());
        assert!(store.create(independent_id, "safe", "body", vec![], "").is_ok());
        let binding = Binding { instance_id: "A".into(), remote_vault_id: "v".into() };
        let mut m = store.manifest("local").unwrap(); m.binding = Some(binding.clone());
        store.commit(m, BTreeMap::new()).unwrap();
        let other = store.create_vault("副本", "duplicate-request").unwrap();
        let mut duplicate = store.manifest(other["localVaultId"].as_str().unwrap()).unwrap(); duplicate.binding = Some(binding);
        store.commit(duplicate, BTreeMap::new()).unwrap();
        assert_eq!(store.writable_manifest("local").err().unwrap(), "MANAGED_SYNC_BINDING_AMBIGUOUS");
        assert!(store.get("local", "note-one").unwrap().content.is_some());
        assert!(store.writable_manifest(independent_id).is_ok());
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn create_normal_library_never_adopts_legacy_migration_identity() {
        let (root, store, source) = fixture();
        let row = store.create_vault(" 我的笔记 ", "request-a").unwrap();
        assert_eq!(row["name"], "我的笔记");
        assert_eq!(row["noteCount"], 0);
        assert_eq!(store.create_vault("我的笔记", "request-a").unwrap(), row);
        assert!(store.create_vault("另一个名字", "request-a").is_err());
        assert!(store.create_vault("我的笔记", "../bad").is_err());
        let other = store.create_vault("我的笔记", "request-b").unwrap();
        assert_ne!(other["localVaultId"], row["localVaultId"]);
        // Simulated crash after manifest publication, before registration.
        let mut registry = store.registry().unwrap();
        registry.vault_ids.retain(|id| id != row["localVaultId"].as_str().unwrap());
        write_atomic(&store.root, "registry.json", &json_bytes(&registry).unwrap()).unwrap();
        assert_eq!(store.create_vault("我的笔记", "request-a").unwrap(), row);
        assert!(row["binding"].is_null());
        assert_ne!(row["localVaultId"], "local");
        assert_eq!(store.migration_status().unwrap()["state"], "not-migrated");
        assert!(store.create_vault(" ", "request-b").is_err());
        assert!(store.create_vault("bad\nname", "request-b").is_err());
        migrate(&store, &source);
        assert_eq!(store.list().unwrap()["items"].as_array().unwrap().len(), 3);
        assert!(store.get("local", "note-one").unwrap().content.is_some());
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn migration_preserves_ids_duplicates_empty_body_metadata_and_source() {
        let (root, s, source) = fixture();
        migrate(&s, &source);
        let a = s.get("local", "note-one").unwrap();
        let b = s.get("local", "note-two").unwrap();
        assert_eq!(a.content.as_deref(), source["notes"][0]["content"].as_str());
        assert_eq!(b.content.as_deref(), Some(""));
        assert_eq!(a.title, b.title);
        assert!(a.pinned && a.favorite);
        assert_eq!(a.historical_names, vec!["旧名字"]);
        assert!(b.archived);
        assert_eq!(s.manifest("local").unwrap().notes.len(), 2);
        let backup: Value = read_json(
            &s.vault_root("local").unwrap(),
            ".luckyray/migration-source.json",
        )
        .unwrap();
        assert_eq!(backup, source);
        assert!(s.folders("local").unwrap()["paths"]
            .as_array()
            .unwrap()
            .contains(&json!("空目录")));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn migration_rejects_changed_source_then_retries_idempotently() {
        let (root, s, source) = fixture();
        let p = s.prepare_migration(source.clone()).unwrap();
        let id = p["planId"].as_str().unwrap();
        let mut changed = source.clone();
        changed["notes"][0]["content"] = json!("new");
        assert!(s
            .commit_migration(id, &changed)
            .unwrap_err()
            .contains("SOURCE_CHANGED"));
        assert_eq!(s.list().unwrap()["items"], json!([]));
        s.commit_migration(id, &source).unwrap();
        let before = s.get("local", "note-one").unwrap().revision;
        s.commit_migration(id, &source).unwrap();
        assert_eq!(before, s.get("local", "note-one").unwrap().revision);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn files_are_authority_and_cas_preserves_previous_version() {
        let (root, s, source) = fixture();
        migrate(&s, &source);
        let a = s.get("local", "note-one").unwrap();
        let updated = s
            .save("local", "note-one", &a.revision, "new", "updated", vec![])
            .unwrap();
        assert_eq!(updated.content.as_deref(), Some("updated"));
        assert!(s
            .save("local", "note-one", &a.revision, "late", "lost", vec![])
            .unwrap_err()
            .contains("REVISION_CONFLICT"));
        let history = fs::read_to_string(
            s.vault_root("local")
                .unwrap()
                .join(format!(".luckyray/history/note-one/{}.md", a.revision)),
        )
        .unwrap();
        assert_eq!(Some(history), a.content);
        fs::write(
            s.vault_root("local").unwrap().join(updated.relative_path),
            "external",
        )
        .unwrap();
        let external = s.get("local", "note-one").unwrap();
        assert_eq!(external.body_state, "conflict");
        assert_eq!(external.content.as_deref(), Some("external"));
        assert!(s
            .save(
                "local",
                "note-one",
                &external.revision,
                "overwrite",
                "bad",
                vec![]
            )
            .unwrap_err()
            .contains("NOT_EDITABLE"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn journal_replays_after_body_write_before_manifest_and_replays_twice() {
        let (root, s, source) = fixture();
        migrate(&s, &source);
        let mut m = s.manifest("local").unwrap();
        let n = m.notes.get_mut("note-one").unwrap();
        n.revision = "new-revision".into();
        n.body_hash = hash(b"crash-safe");
        let path = n.relative_path.clone();
        let mut writes = BTreeMap::new();
        writes.insert(path.clone(), "crash-safe".into());
        let vr = s.vault_root("local").unwrap();
        write_atomic(
            &vr,
            "journal.json",
            &json_bytes(&Journal {
                manifest: m,
                writes,
                retire: vec![],
                expected: BTreeMap::from([(path.clone(), file_hash(&vr, &path).unwrap())]),
                manifest_preimage: file_hash(&vr, "manifest.json").unwrap(),
            })
            .unwrap(),
        )
        .unwrap();
        write_atomic(&vr, &path, b"crash-safe").unwrap();
        s.recover("local").unwrap();
        s.recover("local").unwrap();
        assert_eq!(
            s.get("local", "note-one").unwrap().content.as_deref(),
            Some("crash-safe")
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn move_and_trash_keep_recoverable_bytes_and_no_duplicate_live_path() {
        let (root, s, source) = fixture();
        migrate(&s, &source);
        let a = s.get("local", "note-one").unwrap();
        let old_path = a.relative_path.clone();
        let b = s.move_note("local", "note-one", &a.revision, "").unwrap();
        assert!(!s.vault_root("local").unwrap().join(old_path).exists());
        assert_eq!(a.content, b.content);
        s.trash("local", "note-one", &b.revision).unwrap();
        assert!(s.get("local", "note-one").is_err());
        assert!(s
            .vault_root("local")
            .unwrap()
            .join(format!(".luckyray/trash/note-one/{}.md", b.revision))
            .exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn missing_body_never_becomes_empty_and_bound_save_cannot_bypass_bridge() {
        let (root, s, source) = fixture();
        migrate(&s, &source);
        let mut m = s.manifest("local").unwrap();
        m.notes.get_mut("note-two").unwrap().body_state = "missing".into();
        m.binding = Some(Binding {
            instance_id: "owner".into(),
            remote_vault_id: "remote".into(),
        });
        s.commit(m, BTreeMap::new()).unwrap();
        assert!(s.get("local", "note-two").unwrap().content.is_none());
        let a = s.get("local", "note-one").unwrap();
        assert!(s
            .save("local", "note-one", &a.revision, "x", "x", vec![])
            .unwrap_err()
            .contains("REQUIRES_BRIDGE"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn migration_does_not_guess_duplicate_ids_or_traversal() {
        let (root, s, mut source) = fixture();
        source["notes"][1]["noteId"] = json!("note-one");
        let p = s.prepare_migration(source.clone()).unwrap();
        assert!(s
            .commit_migration(p["planId"].as_str().unwrap(), &source)
            .unwrap_err()
            .contains("COLLISION"));
        assert_eq!(s.list().unwrap()["items"], json!([]));
        assert!(s.vault_root("../escape").is_err());
        assert!(guarded(&root, "../escape").is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn symlink_resource_ancestors_are_rejected() {
        use std::os::unix::fs::symlink;
        let (root, s, source) = fixture();
        migrate(&s, &source);
        let outside = root.join("outside");
        fs::create_dir(&outside).unwrap();
        symlink(&outside, s.vault_root("local").unwrap().join("linked")).unwrap();
        assert!(s.folder_create("local", "child", "linked").is_err());
        assert!(guarded(&s.vault_root("local").unwrap(), "linked/target.md").is_err());
        fs::remove_dir_all(root).unwrap();
    }
}

impl Store {
    /// Adopt an already persisted Android import receipt without deleting its legacy source.
    /// The receipt's native note ID is the idempotency key, never the title or body hash.
    pub(crate) fn import_legacy_receipt(&self, id: &str, item: &Value) -> Result<Note, String> {
        let registry = self.registry()?;
        if registry.selected_vault_id.as_deref() != Some(id) {
            return Err("VAULT_IMPORT_TARGET_CHANGED".into());
        }
        let mut m = self.manifest(id)?;
        self.check_writable(&m)?;
        if m.binding.is_some() {
            return Err("VAULT_IMPORT_BOUND_TARGET_NOT_READY".into());
        }
        let note_id = item["noteId"].as_str().ok_or("VAULT_IMPORT_INVALID")?;
        if !component(note_id) {
            return Err("VAULT_IMPORT_INVALID".into());
        }
        let fingerprint = hash(&json_bytes(item)?);
        let alias = self.resolve(note_id)?;
        if !alias.is_null() && alias["localVaultId"] != id {
            return Err("VAULT_IMPORT_ALREADY_ADOPTED_ELSEWHERE".into());
        }
        if let Some(existing) = m.notes.get(note_id) {
            if existing.remote["legacyImportSourceHash"] == fingerprint {
                return self.get(id, note_id);
            }
            let original: Value =
                read_json(&self.vault_root(id)?, ".luckyray/migration-source.json")?;
            if original["notes"].as_array().is_some_and(|items| {
                items.iter().any(|v| {
                    v["noteId"] == note_id
                        && hash(&json_bytes(v).unwrap_or_default()) == fingerprint
                })
            }) {
                return self.get(id, note_id);
            }
            return Err("VAULT_IMPORT_SOURCE_CHANGED".into());
        }
        let content = item["content"]
            .as_str()
            .ok_or("VAULT_IMPORT_BODY_MISSING")?;
        let title = item["title"].as_str().unwrap_or("");
        let folder = item["folder"].as_str().unwrap_or("");
        let path = Self::path(folder, title, note_id)?;
        // Legacy imports copy text only; unresolved linked files remain an explicit gap.
        let linked = content.contains("](")
            || content.contains("[[")
            || content.contains("luckyray-attachment:");
        let n = Note {
            local_vault_id: id.into(),
            note_id: note_id.into(),
            title: title.into(),
            relative_path: path.clone(),
            folder: folder.into(),
            revision: fresh(),
            body_state: "ready".into(),
            content: None,
            tags: serde_json::from_value(item["tags"].clone()).map_err(err)?,
            pinned: item["pinned"] == true,
            favorite: item["favorite"] == true,
            archived: item["archived"] == true,
            created_at: item["createdAt"].as_str().unwrap_or("").into(),
            updated_at: item["updatedAt"].as_str().unwrap_or("").into(),
            historical_names: Vec::new(),
            sync_state: if linked { "incomplete" } else { "local" }.into(),
            legacy_route: Some(note_id.into()),
            body_hash: hash(content.as_bytes()),
            remote: json!({"legacyImportSourceHash":fingerprint,"resourcesComplete":!linked}),
            trashed: false,
        };
        if !folder.is_empty() && !m.folders.iter().any(|f| f == folder) {
            m.folders.push(folder.into());
        }
        let mut writes = BTreeMap::new();
        writes.insert(path, content.into());
        writes.insert(
            format!(".luckyray/imports/{note_id}.json"),
            serde_json::to_string_pretty(item).map_err(err)?,
        );
        m.notes.insert(note_id.into(), n);
        self.commit(m, writes)?;
        self.get(id, note_id)
    }
}
#[cfg(test)]
mod import_tests {
    use super::*;
    fn setup() -> (PathBuf, Store, Value) {
        let root = std::env::temp_dir().join(format!("vault-import-{}", fresh()));
        let s = Store::new(&root).unwrap();
        let empty = json!({"notes":[],"folders":[],"history":{}});
        let p = s.prepare_migration(empty.clone()).unwrap();
        s.commit_migration(p["planId"].as_str().unwrap(), &empty)
            .unwrap();
        let note = json!({"noteId":"note-import-native-receipt","title":"文件","folder":"","content":"body","tags":[],"pinned":false,"favorite":false,"archived":false,"createdAt":"2026-01-01","updatedAt":"2026-01-01","sourceInboxId":null});
        (root, s, note)
    }
    #[test]
    fn imported_receipt_is_idempotent_and_changed_source_rejected() {
        let (root, s, mut item) = setup();
        let a = s.import_legacy_receipt("local", &item).unwrap();
        let b = s.import_legacy_receipt("local", &item).unwrap();
        assert_eq!(a.revision, b.revision);
        assert_eq!(s.manifest("local").unwrap().notes.len(), 1);
        item["content"] = json!("changed");
        assert!(s
            .import_legacy_receipt("local", &item)
            .unwrap_err()
            .contains("SOURCE_CHANGED"));
        assert_eq!(
            s.get("local", &a.note_id).unwrap().content.as_deref(),
            Some("body")
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cancelled_or_changed_target_does_not_import_and_missing_attachment_is_incomplete() {
        let (root, s, mut item) = setup();
        assert!(s
            .import_legacy_receipt("different", &item)
            .unwrap_err()
            .contains("TARGET_CHANGED"));
        assert!(s.manifest("local").unwrap().notes.is_empty());
        item["content"] = json!("![missing](attachment.png)");
        let n = s.import_legacy_receipt("local", &item).unwrap();
        assert_eq!(n.sync_state, "incomplete");
        assert_eq!(n.remote["resourcesComplete"], false);
        assert_eq!(s.resolve(&n.note_id).unwrap()["noteId"], n.note_id);
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    #[test]
    fn independent_files_survive_restart_without_sqlite_and_support_search_flags_and_folders() {
        let root = std::env::temp_dir().join(format!("vault-lifecycle-{}", fresh()));
        let s = Store::new(&root).unwrap();
        let source = json!({"notes":[],"folders":[],"history":{}});
        let p = s.prepare_migration(source.clone()).unwrap();
        let plan = p["planId"].as_str().unwrap().to_owned();
        s.commit_migration(&plan, &source).unwrap();
        s.folder_create("local", "资料", "").unwrap();
        let a = s
            .create(
                "local",
                "重复标题",
                "\u{feff}---\nhello: 世界\n---\nneedle",
                vec!["标签".into()],
                "资料",
            )
            .unwrap();
        let b = s
            .create("local", "重复标题", "other", vec![], "资料")
            .unwrap();
        assert_ne!(a.relative_path, b.relative_path);
        assert!(a.relative_path.starts_with("资料/重复标题--"));
        assert_eq!(
            s.notes(&json!({"localVaultId":"local","q":"needle"}))
                .unwrap()["total"],
            1
        );
        assert_eq!(
            s.notes(&json!({"localVaultId":"local","folder":"资料","page":2,"limit":1}))
                .unwrap()["items"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let a = s
            .flags("local", &a.note_id, &a.revision, &json!({"favorite":true}))
            .unwrap();
        assert!(a.favorite);
        assert_eq!(
            s.notes(&json!({"localVaultId":"local","favorite":true}))
                .unwrap()["total"],
            1
        );
        drop(s);
        let reopened = Store::new(&root).unwrap();
        assert_eq!(
            reopened.get("local", &a.note_id).unwrap().content,
            a.content
        );
        assert!(!root.join("luckyray-mobile.db").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn migration_recovers_after_publication_before_registration_without_rewriting() {
        let root = std::env::temp_dir().join(format!("vault-registration-{}", fresh()));
        let s = Store::new(&root).unwrap();
        let source = json!({"notes":[],"folders":["空目录"],"history":{}});
        let p = s.prepare_migration(source.clone()).unwrap();
        let plan = p["planId"].as_str().unwrap();
        s.commit_migration(plan, &source).unwrap();
        let original = fs::read(s.vault_root("local").unwrap().join("manifest.json")).unwrap();
        fs::remove_file(s.root.join("registry.json")).unwrap();
        s.commit_migration(plan, &source).unwrap();
        assert_eq!(
            original,
            fs::read(s.vault_root("local").unwrap().join("manifest.json")).unwrap()
        );
        assert_eq!(s.list().unwrap()["items"].as_array().unwrap().len(), 1);
        assert!(s.vault_root("local").unwrap().join("空目录").is_dir());
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod legacy_fence_tests {
    use super::*;
    #[test]
    fn late_legacy_writes_and_erase_are_rejected_after_identity_migration() {
        let root = std::env::temp_dir().join(format!("vault-legacy-fence-{}", fresh()));
        let store = Store::new(&root).unwrap();
        assert!(store.guard_legacy_write(Some("note-old")).is_ok());
        let source = json!({"notes":[{"noteId":"note-old","title":"Old","content":"preserved","tags":[]}],"folders":[],"history":{}});
        let plan = store.prepare_migration(source.clone()).unwrap();
        store
            .commit_migration(plan["planId"].as_str().unwrap(), &source)
            .unwrap();
        let before = store.get("local", "note-old").unwrap();
        assert_eq!(
            store.guard_legacy_write(Some("note-old")).unwrap_err(),
            "VAULT_LEGACY_NOTE_MIGRATED"
        );
        assert_eq!(
            store.guard_legacy_write(None).unwrap_err(),
            "VAULT_LEGACY_NOTE_MIGRATED"
        );
        assert!(store
            .guard_legacy_write(Some("note-new-import-receipt"))
            .is_ok());
        assert_eq!(
            store.get("local", "note-old").unwrap().content,
            before.content
        );
        let backup: Value = read_json(
            &store.vault_root("local").unwrap(),
            ".luckyray/migration-source.json",
        )
        .unwrap();
        assert_eq!(backup, source);
        store.trash("local", "note-old", &before.revision).unwrap();
        assert!(store.resolve("note-old").unwrap().is_null());
        assert_eq!(
            store.guard_legacy_write(Some("note-old")).unwrap_err(),
            "VAULT_LEGACY_NOTE_MIGRATED"
        );
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod transfer_redirect_tests {
    use super::*;
    #[test]
    fn transferred_original_remains_readable_but_not_mutable_or_listed() {
        let root=std::env::temp_dir().join(format!("vault-transfer-{}",fresh()));
        let store=Store::new(&root).unwrap();
        let source=json!({"notes":[{"noteId":"old","title":"Old","content":"kept","tags":[]}],"folders":[],"history":{}});
        let p=store.prepare_migration(source.clone()).unwrap();
        store.commit_migration(p["planId"].as_str().unwrap(),&source).unwrap();
        let target=store.create("local","Target","kept",vec![],"").unwrap();
        let mut m=store.manifest("local").unwrap();
        m.notes.get_mut("old").unwrap().remote=json!({"transferPending":{"localVaultId":"local"}});
        store.commit(m,BTreeMap::new()).unwrap();
        let old=store.get("local","old").unwrap();
        assert_eq!(store.save("local","old",&old.revision,"Old","changed",vec![]).unwrap_err(),"VAULT_NOTE_TRANSFER_PENDING");
        let mut m=store.manifest("local").unwrap();
        m.notes.get_mut("old").unwrap().remote=json!({"transferredTo":{"localVaultId":"local","noteId":target.note_id}});
        store.commit(m,BTreeMap::new()).unwrap();
        assert_eq!(store.get("local","old").unwrap().content.as_deref(),Some("kept"));
        assert_eq!(store.save("local","old",&old.revision,"Old","changed",vec![]).unwrap_err(),"VAULT_NOTE_TRANSFERRED");
        assert_eq!(store.trash("local","old",&old.revision).unwrap_err(),"VAULT_NOTE_TRANSFERRED");
        assert_eq!(store.flags("local","old",&old.revision,&json!({"favorite":true})).unwrap_err(),"VAULT_NOTE_TRANSFERRED");
        assert_eq!(store.notes(&json!({"localVaultId":"local"})).unwrap()["total"],1);
        assert_eq!(store.catalog("local").unwrap()["items"].as_array().unwrap().len(),1);
        assert_eq!(store.resolve("old").unwrap()["noteId"],target.note_id);
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod migration_repreview_safety_tests {
    use super::*;
    #[test]
    fn changed_published_local_source_cannot_replace_plan_or_certify_stale_file() {
        let root=std::env::temp_dir().join(format!("migration-repreview-{}",fresh()));
        let store=Store::new(&root).unwrap();
        let source=json!({"notes":[{"noteId":"n","title":"N","content":"original","tags":[]}],"folders":[],"history":{},"replicas":{"noteCount":0,"scopes":[]}});
        let p=store.prepare_migration(source.clone()).unwrap();
        store.commit_migration(p["planId"].as_str().unwrap(),&source).unwrap();
        let plan_bytes=fs::read(store.root.join("migration-plan.json")).unwrap();
        let mut changed=source.clone(); changed["notes"][0]["content"]=json!("new original");
        assert_eq!(store.prepare_migration(changed.clone()).unwrap_err(),"VAULT_MIGRATION_RECOVERY_CONFLICT");
        assert_eq!(fs::read(store.root.join("migration-plan.json")).unwrap(),plan_bytes);
        assert_eq!(store.commit_migration(p["planId"].as_str().unwrap(),&changed).unwrap_err(),"VAULT_MIGRATION_SOURCE_CHANGED");
        assert_eq!(store.get("local","n").unwrap().content.as_deref(),Some("original"));
        assert_eq!(store.migration_status().unwrap()["state"],"prepared");
        // An externally edited published file must also block completion.
        let n=store.get("local","n").unwrap();
        fs::write(store.vault_root("local").unwrap().join(n.relative_path),b"external edit").unwrap();
        assert_eq!(store.complete_migration(p["planId"].as_str().unwrap(),&source).unwrap_err(),"VAULT_MIGRATION_RECOVERY_CONFLICT");
        fs::remove_dir_all(root).unwrap();
    }
}
