// M2.7 Mobile-local domain — file ownership + Android share ingestion for the
// Local Inbox. This module is deliberately separate from capture_media.rs:
//
//   capture_media  -> Desktop delivery layer (capture-outbox/, ref-* files)
//   local_inbox    -> user-owned durable data (local-inbox/, att-* files)
//
// Ownership rules (invariants):
//   - attachment originals live under app-private `local-inbox/` only;
//   - every owned file is named `att-*`, so no Desktop/cache cleanup path
//     (which only ever touches `ref-*` under capture-outbox) can reach it;
//   - orphan cleanup deletes only unreferenced `att-*` files; files claimed by
//     a pending share meta (not yet ingested) are never treated as orphans;
//   - deleting a Local Inbox item removes exactly the files its own rows own.
//
// Android ACTION_SEND arrives as a share-*.meta.json in `local-inbox/`; the
// native ShareBridge writes it with the content already copied to app-private
// storage, then Rust reconciles the meta into SQLite idempotently.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use tauri::Emitter;
use uuid::Uuid;

use crate::capture_media::CaptureMedia;
use crate::db::Db;

/// Deduplicate concurrent reconcile attempts (startup + event-driven ingest).
static INGEST_LOCK: Mutex<()> = Mutex::new(());

/// Set once from setup; used by the ShareBridge JNI notify to emit
/// `lr:local-share` so a warm app can ingest a share without polling.
static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

pub fn set_app_handle(handle: tauri::AppHandle) {
    let _ = APP_HANDLE.set(handle);
}

/// Emit `lr:local-share` when the native ShareBridge persisted a share. Cold
/// start is covered by the frontend's mount-time ingest; this covers warm
/// resume (onNewIntent) without any polling.
fn notify_share_received() {
    if let Some(handle) = APP_HANDLE.get() {
        let _ = handle.emit("lr:local-share", serde_json::json!({ "at": "now" }));
    }
}

/// Share meta file name prefix (written by ShareBridge.kt).
fn is_share_meta_name(name: &str) -> bool {
    name.starts_with("share-")
        && (name.ends_with(".meta.json")
            || name.ends_with(".meta.json.bak")
            || name.ends_with(".meta.json.new"))
}

/// The app-private inbox root. Android: resolved through ShareBridge so the
/// Kotlin and Rust sides always agree on the directory.
#[cfg(target_os = "android")]
fn inbox_root() -> Result<PathBuf, String> {
    let mut env = attach_vm()?;
    let dir = local_inbox_dir(&mut env)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create local inbox: {e}"))?;
    PathBuf::from(dir).canonicalize().map_err(|e| format!("canonical local inbox: {e}"))
}

#[cfg(target_os = "android")]
static VM: OnceLock<jni::JavaVM> = OnceLock::new();

#[cfg(target_os = "android")]
static BRIDGE_CLASS: OnceLock<jni::objects::GlobalRef> = OnceLock::new();

#[cfg(target_os = "android")]
fn attach_vm<'local>() -> Result<jni::AttachGuard<'local>, String> {
    let vm = VM.get().ok_or("JVM not attached")?;
    vm.attach_current_thread()
        .map_err(|e| format!("attach: {e}"))
}

#[cfg(target_os = "android")]
fn bridge_class<'local>(
    env: &mut jni::JNIEnv<'local>,
) -> Result<jni::objects::JClass<'local>, String> {
    match BRIDGE_CLASS.get() {
        Some(g) => {
            let obj: jni::objects::JObject = unsafe { jni::objects::JObject::from_raw(g.as_raw()) };
            Ok(jni::objects::JClass::from(obj))
        }
        None => {
            let found = env.find_class("com/luckyray/mobile/ShareBridge");
            if found.is_err() {
                // find_class leaves a pending exception on Android when the app
                // class loader is not visible from this native-attached thread.
                // Clear it: a failed lookup must degrade gracefully, never abort
                // the process with a pending exception.
                let _ = env.exception_clear();
            }
            found.map_err(|e| format!("find ShareBridge: {e}"))
        }
    }
}

#[cfg(target_os = "android")]
fn local_inbox_dir<'local>(env: &mut jni::JNIEnv<'local>) -> Result<String, String> {
    let class = bridge_class(env)?;
    let result = env
        .call_static_method(class, "localInboxDir", "()Ljava/lang/String;", &[])
        .map_err(|e| format!("localInboxDir: {e}"))?;
    let object = result.l().map_err(|e| format!("localInboxDir result: {e}"))?;
    env.get_string(&object.into())
        .map(|value| value.into())
        .map_err(|e| format!("localInboxDir string: {e}"))
}

/// Generic static string-returning call on the cached ShareBridge class
/// (M2.9: `localAssetsDir`). Uses the same cached JVM/class machinery as
/// `local_inbox_dir`, so native threads never depend on find_class.
#[cfg(target_os = "android")]
pub(crate) fn share_bridge_static_string(method: &str, signature: &str) -> Result<String, String> {
    let vm = VM.get().ok_or("JVM not attached")?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("attach: {e}"))?;
    let class = bridge_class(&mut env)?;
    let result = env
        .call_static_method(class, method, signature, &[])
        .map_err(|e| format!("{method}: {e}"))?;
    let object = result.l().map_err(|e| format!("{method} result: {e}"))?;
    env.get_string(&object.into())
        .map(|value| value.into())
        .map_err(|e| format!("{method} string: {e}"))
}

/// App-private Local Inbox root (canonical). Shared with the Local Asset
/// promotion path so an att-* attachment can be verified as app-owned.
#[cfg(target_os = "android")]
pub(crate) fn inbox_root_path() -> Result<PathBuf, String> {
    inbox_root()
}

/// Kotlin `init { nativeInit() }` — caches the JVM and the ShareBridge class
/// GlobalRef so `localInboxDir()` never depends on find_class from a native
/// thread (the codebase-wide pattern from capture_media).
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_luckyray_mobile_ShareBridge_nativeInit<'local>(
    env: jni::JNIEnv<'local>,
    this: jni::objects::JObject<'local>,
) {
    if let Ok(vm) = env.get_java_vm() {
        let _ = VM.set(vm);
    }
    if let Ok(class) = env.get_object_class(&this) {
        if let Ok(g) = env.new_global_ref(class) {
            let _ = BRIDGE_CLASS.set(g);
        }
    }
}

/// App-scoped external files dir (adb-pullable, no runtime permission).
#[cfg(target_os = "android")]
pub fn diagnostics_dir() -> Result<String, String> {
    let mut env = attach_vm()?;
    let class = bridge_class(&mut env)?;
    let result = env
        .call_static_method(class, "diagnosticsDir", "()Ljava/lang/String;", &[])
        .map_err(|e| format!("diagnosticsDir: {e}"))?;
    let object = result.l().map_err(|e| format!("diagnosticsDir result: {e}"))?;
    env.get_string(&object.into())
        .map(|value| value.into())
        .map_err(|e| format!("diagnosticsDir string: {e}"))
}

/// Host diagnostics fallback (dev only).
#[cfg(not(target_os = "android"))]
pub fn diagnostics_dir() -> Result<String, String> {
    Ok(std::env::temp_dir().to_string_lossy().into_owned())
}

/// Kotlin calls this after persisting a share (warm resume path).
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_luckyray_mobile_ShareBridge_nativeNotify<'local>(
    env: jni::JNIEnv<'local>,
    _class: jni::objects::JObject<'local>,
) {
    if let Ok(vm) = env.get_java_vm() {
        let _ = VM.set(vm);
    }
    notify_share_received();
}

/// Host (non-Android) inbox root for tests and the desktop dev fixture.
#[cfg(not(target_os = "android"))]
fn inbox_root() -> Result<PathBuf, String> {
    Err("local inbox storage requires Android".into())
}

// ---------------------------------------------------------------------------
// File staging / ownership
// ---------------------------------------------------------------------------

/// A picked file that has been moved into the Local Inbox's private storage.
pub struct InboxStaged {
    pub ref_id: String,
    pub kind: String,
    pub file_name: String,
    pub mime: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub local_path: String,
}

/// Move a picker result out of the Desktop capture-outbox staging area into
/// the Local Inbox's own storage (rename within app-private filesDir, so no
/// extra copy is made). The `att-` prefix and the inbox root make the file
/// unreachable by every Desktop/cache cleanup path. Move happens BEFORE the
/// SQLite commit: a crash in between leaves only an unreferenced `att-` file,
/// which the Local Inbox orphan cleanup can reclaim — never a half item.
pub fn stage_picked_into_inbox(media: &CaptureMedia) -> Result<InboxStaged, String> {
    let root = inbox_root()?;
    stage_into_root(&root, media)
}

fn stage_into_root(root: &Path, media: &CaptureMedia) -> Result<InboxStaged, String> {
    if media.local_uri.is_empty() {
        return Err("picked file missing local path".into());
    }
    let source = PathBuf::from(&media.local_uri);
    let source_name = source
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("capture")
        .to_string();
    let ext = Path::new(&source_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin")
        .to_string();
    let ref_id = new_inbox_ref_id();
    let file_name = format!("att-{ref_id}.{ext}");
    let dest = root.join(&file_name);
    std::fs::rename(&source, &dest).map_err(|e| format!("stage into local inbox: {e}"))?;
    let size = std::fs::metadata(&dest)
        .map_err(|e| format!("staged inbox metadata: {e}"))?
        .len();
    Ok(InboxStaged {
        ref_id,
        kind: media.kind.clone(),
        file_name: media.file_name.clone(),
        mime: media.mime.clone(),
        size_bytes: size,
        sha256: media.sha256.clone(),
        local_path: dest.to_string_lossy().into_owned(),
    })
}

fn new_inbox_ref_id() -> String {
    format!("in-{}", Uuid::new_v4().simple())
}

/// Delete an attachment file only if it resolves under the Local Inbox root
/// and has the inbox-owned `att-` filename. Missing files are already cleaned
/// up (Ok(true)); untrusted paths are never deleted from DB input alone.
pub fn remove_inbox_attachment_if_managed(local_path: &str) -> Result<bool, String> {
    let root = inbox_root()?;
    remove_managed_at(&root, local_path)
}

fn remove_managed_at(root: &Path, local_path: &str) -> Result<bool, String> {
    let root = root
        .canonicalize()
        .map_err(|e| format!("canonical inbox root: {e}"))?;
    let canonical = match PathBuf::from(local_path).canonicalize() {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(format!("canonical inbox attachment: {error}")),
    };
    let name_owned = canonical
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("att-"));
    if !canonical.starts_with(&root) || !name_owned {
        return Ok(false);
    }
    std::fs::remove_file(&canonical).map_err(|e| format!("remove inbox attachment: {e}"))?;
    Ok(true)
}

// ---------------------------------------------------------------------------
// Orphan cleanup
// ---------------------------------------------------------------------------

/// Scan `local-inbox/` and remove `att-*` files not referenced by (a) durable
/// Local Inbox metadata (the SQLite allow-list) or (b) a still-pending share
/// meta that has not been ingested yet. Share meta files themselves are never
/// deleted here — `reconcile_pending_shares` owns them.
#[cfg(target_os = "android")]
pub fn cleanup_unreferenced_inbox_files(referenced_paths: &[String]) -> Result<usize, String> {
    let root = inbox_root()?;
    cleanup_unreferenced_at(&root, referenced_paths)
}

/// Desktop dev fixture: nothing to reconcile off-device.
#[cfg(not(target_os = "android"))]
pub fn cleanup_unreferenced_inbox_files(_referenced_paths: &[String]) -> Result<usize, String> {
    Ok(0)
}

fn cleanup_unreferenced_at(root: &Path, referenced_paths: &[String]) -> Result<usize, String> {
    // Canonicalize the root so Windows 8.3 short paths cannot break the
    // starts_with ownership check against canonicalized file paths.
    let root = root
        .canonicalize()
        .map_err(|e| format!("canonical local inbox root: {e}"))?;
    let mut referenced: HashSet<PathBuf> = referenced_paths
        .iter()
        .filter_map(|path| PathBuf::from(path).canonicalize().ok())
        .filter(|path| path.starts_with(&root))
        .collect();
    // Files claimed by a pending share meta are protected even though their
    // SQLite row does not exist yet.
    for entry in std::fs::read_dir(&root).map_err(|e| format!("read local inbox: {e}"))? {
        let entry = entry.map_err(|e| format!("local inbox entry: {e}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !is_share_meta_name(&name) {
            continue;
        }
        if let Ok(content) = std::fs::read_to_string(entry.path()) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(local_uri) = json["localUri"].as_str() {
                    if let Ok(canonical) = PathBuf::from(local_uri).canonicalize() {
                        referenced.insert(canonical);
                    }
                }
            }
        }
    }
    let mut removed = 0usize;
    for entry in std::fs::read_dir(&root).map_err(|e| format!("read local inbox: {e}"))? {
        let entry = entry.map_err(|e| format!("local inbox entry: {e}"))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("att-") {
            continue;
        }
        let canonical = path
            .canonicalize()
            .map_err(|e| format!("canonical inbox entry: {e}"))?;
        if !referenced.contains(&canonical) {
            std::fs::remove_file(&canonical)
                .map_err(|e| format!("remove local inbox orphan: {e}"))?;
            removed += 1;
        }
    }
    Ok(removed)
}

// ---------------------------------------------------------------------------
// Share ingestion
// ---------------------------------------------------------------------------

/// Ingest every pending `share-*.meta.json` into the Local Inbox. Idempotent:
/// duplicate deliveries are deduped by digest inside the SQLite transaction
/// (`inbox_share_ingest`), and a crash between commit and meta removal just
/// replays the same digest on the next startup. Broken metas (unreadable /
/// missing file) are removed rather than retried forever.
#[cfg(target_os = "android")]
pub fn reconcile_pending_shares(db: &mut Db) -> Result<usize, String> {
    let root = inbox_root()?;
    let _guard = INGEST_LOCK.lock().unwrap();
    reconcile_pending_shares_at(db, &root)
}

/// Desktop dev fixture: no Local Inbox storage off-device.
#[cfg(not(target_os = "android"))]
pub fn reconcile_pending_shares(_db: &mut Db) -> Result<usize, String> {
    Ok(0)
}

fn reconcile_pending_shares_at(db: &mut Db, root: &Path) -> Result<usize, String> {
    let mut consumed = 0usize;
    let mut metas = Vec::new();
    for entry in std::fs::read_dir(root).map_err(|e| format!("read local inbox: {e}"))? {
        let entry = entry.map_err(|e| format!("local inbox entry: {e}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with("share-") && name.ends_with(".meta.json") {
            metas.push(entry.path());
        }
    }
    for path in metas {
        let content = match std::fs::read_to_string(&path) {
            Ok(content) => content,
            Err(_) => {
                let _ = std::fs::remove_file(&path);
                continue;
            }
        };
        let meta: serde_json::Value = match serde_json::from_str(&content) {
            Ok(meta) => meta,
            Err(_) => {
                let _ = std::fs::remove_file(&path);
                continue;
            }
        };
        if meta["status"].as_str() != Some("done") {
            let _ = std::fs::remove_file(&path);
            continue;
        }
        match ingest_share_meta(db, &meta) {
            Ok(Some(true)) => consumed += 1,
            Ok(Some(false)) => {} // deduped duplicate — still remove the meta below
            Ok(None) => {}        // broken meta (e.g. missing file) — drop it
            Err(error) => return Err(format!("ingest share {path:?}: {error}")),
        }
        let _ = std::fs::remove_file(&path);
        // AtomicFile sidecars are reclaimed together with the primary meta.
        for sidecar in [".bak", ".new"] {
            let mut name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            if name.ends_with(sidecar) {
                continue;
            }
            name.push_str(sidecar);
            let _ = std::fs::remove_file(path.with_file_name(name));
        }
    }
    Ok(consumed)
}

/// Apply one share meta into SQLite. Returns:
///   Ok(Some(true))  -> a new Local Inbox item was created
///   Ok(Some(false)) -> the digest was deduped (duplicate delivery)
///   Ok(None)        -> the meta is broken (missing file); drop it silently
fn ingest_share_meta(db: &mut Db, meta: &serde_json::Value) -> Result<Option<bool>, String> {
    let share_id = meta["shareId"].as_str().unwrap_or("").to_string();
    let digest = meta["digest"].as_str().ok_or("share meta missing digest")?;
    if share_id.is_empty() || digest.is_empty() {
        return Err("share meta missing shareId/digest".into());
    }
    match meta["shareType"].as_str().unwrap_or("") {
        "text" => {
            let text = meta["text"].as_str().unwrap_or("").to_string();
            let url = meta["url"].as_str().unwrap_or("").to_string();
            // A single URL share becomes a link item; anything else is text.
            let kind = if !url.is_empty() { "link" } else { "text" };
            db.inbox_share_ingest(
                &share_id, kind, "", &text, &url, digest,
                None, None, None, None, None, None,
            )
            .map(Some)
        }
        "file" => {
            let local_uri = meta["localUri"].as_str().ok_or("share meta missing localUri")?;
            if local_uri.is_empty() {
                return Ok(None); // broken share — nothing to keep
            }
            let path = PathBuf::from(local_uri);
            if !path.is_file() {
                return Ok(None); // broken share (file lost) — drop the meta
            }
            let mime = meta["mime"].as_str().unwrap_or("application/octet-stream").to_string();
            let kind = if mime.starts_with("image/") { "image" } else { "file" };
            let file_name = meta["fileName"].as_str().unwrap_or("share").to_string();
            let size = meta["sizeBytes"].as_i64().unwrap_or(0);
            let sha256 = meta["sha256"].as_str().unwrap_or(digest).to_string();
            db.inbox_share_ingest(
                &share_id, kind, "", "", "", digest,
                Some(kind), Some(&mime), Some(&file_name), Some(size), Some(&sha256), Some(local_uri),
            )
            .map(Some)
        }
        _ => Err("share meta has unknown shareType".into()),
    }
}

// ---------------------------------------------------------------------------
// Erase (explicit destructive "erase my local content")
// ---------------------------------------------------------------------------

/// Delete every owned Local Inbox file. Called only from the explicit erase
/// command after `inbox_erase_all` has committed row removal, so a crash in
/// between leaves only unreferenced files that the orphan cleanup reclaims.
pub fn erase_inbox_files(paths: &[String]) -> Result<usize, String> {
    let root = inbox_root()?;
    let mut removed = 0usize;
    for path in paths {
        if remove_managed_at(&root, path)? {
            removed += 1;
        }
    }
    Ok(removed)
}

// ---------------------------------------------------------------------------
// Host tests (pure file/dir logic, no JNI)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture_media::sha256_file;
    use std::io::Write;

    fn temp_root() -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("lrm-inbox-{}-{}", std::process::id(), nanos));
        std::fs::create_dir_all(&dir).expect("create disposable inbox root");
        dir
    }

    fn write_file(root: &Path, name: &str, content: &[u8]) -> PathBuf {
        let path = root.join(name);
        let mut f = std::fs::File::create(&path).expect("create fixture");
        f.write_all(content).expect("write fixture");
        f.sync_all().ok();
        path
    }

    #[test]
    fn share_meta_names_are_recognized() {
        assert!(is_share_meta_name("share-sh-1.meta.json"));
        assert!(is_share_meta_name("share-sh-1.meta.json.bak"));
        assert!(is_share_meta_name("share-sh-1.meta.json.new"));
        assert!(!is_share_meta_name("att-sh-1.jpg"));
        assert!(!is_share_meta_name("pending-ref-1.meta.json"));
    }

    #[test]
    fn orphan_cleanup_keeps_referenced_and_pending_share_files() {
        let root = temp_root();
        // DB-owned file (in the allow-list)
        let owned = write_file(&root, "att-owned.jpg", b"owned");
        // file claimed by a still-pending share meta
        write_file(&root, "att-pending.png", b"pending");
        // true orphan
        write_file(&root, "att-orphan.bin", b"orphan");
        // non-inbox files must never be touched
        let unrelated = write_file(&root, "ref-other.jpg", b"capture outbox file");
        // pending share meta claiming att-pending.png (JSON needs forward
        // slashes: backslashes are illegal JSON escapes on Windows hosts)
        write_file(
            &root,
            "share-sh-1.meta.json",
            format!(
                r#"{{"status":"done","shareId":"sh-1","shareType":"file","digest":"d","localUri":"{}"}}"#,
                root.join("att-pending.png").to_string_lossy().replace('\\', "/")
            )
            .as_bytes(),
        );

        let referenced = vec![owned.to_string_lossy().into_owned()];
        let removed = cleanup_unreferenced_at(&root, &referenced).expect("cleanup");
        assert_eq!(removed, 1, "only the unreferenced att-* file is removed");
        assert!(owned.exists());
        assert!(root.join("att-pending.png").exists(), "pending share file protected");
        assert!(!root.join("att-orphan.bin").exists());
        assert!(unrelated.exists(), "capture-outbox file never touched");
        std::fs::remove_dir_all(&root).expect("remove disposable root");
    }

    #[test]
    fn remove_managed_only_touches_inbox_att_files() {
        let root = temp_root();
        let inbox_file = write_file(&root, "att-x.jpg", b"x");
        let ref_file = write_file(&root, "ref-x.jpg", b"r");

        // owned name under the root -> deleted
        assert!(remove_managed_at(&root, inbox_file.to_str().unwrap()).unwrap());
        // ref-* file (Desktop outbox ownership) -> untouched
        assert!(!remove_managed_at(&root, ref_file.to_str().unwrap()).unwrap());
        assert!(ref_file.exists());
        // missing path -> Ok(true) (already cleaned)
        assert!(remove_managed_at(&root, root.join("att-missing.jpg").to_str().unwrap()).unwrap());
        // path outside the root -> Ok(false), never deleted
        let outside = temp_root();
        let outside_file = write_file(&outside, "att-outside.jpg", b"o");
        assert!(!remove_managed_at(&root, outside_file.to_str().unwrap()).unwrap());
        assert!(outside_file.exists());
        std::fs::remove_dir_all(&root).expect("remove disposable root");
        std::fs::remove_dir_all(&outside).expect("remove disposable root");
    }

    #[test]
    fn stage_rename_preserves_content_and_hash() {
        let root = temp_root();
        let source = write_file(&root, "ref-picked.jpg", b"photo-bytes");
        let media = CaptureMedia {
            ref_id: "ref-picked".into(),
            kind: "image".into(),
            file_name: "photo.jpg".into(),
            mime: "image/jpeg".into(),
            size_bytes: 11,
            sha256: sha256_file(&source).expect("hash"),
            local_uri: source.to_string_lossy().into_owned(),
        };
        let staged = stage_into_root(&root, &media).expect("stage");
        assert!(!source.exists(), "picked file moved out of the capture staging area");
        assert!(PathBuf::from(&staged.local_path).exists());
        let name = Path::new(&staged.local_path)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert!(name.starts_with("att-"), "inbox-owned att-* naming");
        assert_eq!(staged.sha256, media.sha256, "content preserved on move");
        assert_eq!(staged.size_bytes, 11);
        std::fs::remove_dir_all(&root).expect("remove disposable root");
    }

    #[test]
    fn reconcile_ingests_text_link_and_file_metas_then_removes_them() {
        let root = temp_root();
        let mut db = crate::db::Db::open(&root.join("test.db")).expect("open db");
        write_file(
            &root,
            "share-sh-text.meta.json",
            br#"{"status":"done","shareId":"sh-text","shareType":"text","digest":"d1","text":"hello share","url":""}"#,
        );
        write_file(
            &root,
            "share-sh-link.meta.json",
            br#"{"status":"done","shareId":"sh-link","shareType":"text","digest":"d2","text":"https://example.com/x","url":"https://example.com/x"}"#,
        );
        let file = write_file(&root, "att-sh-file.jpg", b"shared image");
        let sha = sha256_file(&file).expect("hash");
        write_file(
            &root,
            "share-sh-file.meta.json",
            format!(
                r#"{{"status":"done","shareId":"sh-file","shareType":"file","digest":"d3","fileName":"pic.jpg","mime":"image/jpeg","sizeBytes":12,"sha256":"{sha}","localUri":"{}"}}"#,
                file.to_string_lossy().replace('\\', "/")
            )
            .as_bytes(),
        );
        // broken meta (missing file) is removed, not retried forever
        write_file(
            &root,
            "share-sh-broken.meta.json",
            br#"{"status":"done","shareId":"sh-broken","shareType":"file","digest":"d4","fileName":"gone.bin","mime":"application/octet-stream","sizeBytes":1,"sha256":"x","localUri":"/nonexistent/gone.bin"}"#,
        );

        let consumed = reconcile_pending_shares_at(&mut db, &root).expect("reconcile");
        assert_eq!(consumed, 3);

        let text = db.inbox_get("sh-text").unwrap().unwrap();
        assert_eq!(text.item.kind, "text");
        assert_eq!(text.item.text, "hello share");
        assert_eq!(text.item.source, "share");
        let link = db.inbox_get("sh-link").unwrap().unwrap();
        assert_eq!(link.item.kind, "link");
        assert_eq!(link.item.url, "https://example.com/x");
        let file_item = db.inbox_get("sh-file").unwrap().unwrap();
        assert_eq!(file_item.item.kind, "image");
        assert_eq!(file_item.attachments.len(), 1);
        assert_eq!(file_item.attachments[0].file_name, "pic.jpg");
        assert_eq!(file_item.attachments[0].sha256, sha);

        // all metas consumed (including the broken one)
        let remaining: Vec<_> = std::fs::read_dir(&root)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("share-"))
            .collect();
        assert!(remaining.is_empty(), "metas removed after ingest: {remaining:?}");
        assert!(!root.join("sh-broken").exists());
        drop(db); // Windows: the SQLite file must be released before cleanup
        std::fs::remove_dir_all(&root).expect("remove disposable root");
    }

    #[test]
    fn reconcile_replay_after_crash_is_deduped() {
        let root = temp_root();
        let mut db = crate::db::Db::open(&root.join("test.db")).expect("open db");
        // Simulate a crash between commit and meta removal: meta still exists.
        write_file(
            &root,
            "share-sh-1.meta.json",
            br#"{"status":"done","shareId":"sh-1","shareType":"text","digest":"d1","text":"dup","url":""}"#,
        );
        assert_eq!(reconcile_pending_shares_at(&mut db, &root).unwrap(), 1);
        // replay the same meta (crash before deletion)
        write_file(
            &root,
            "share-sh-1.meta.json",
            br#"{"status":"done","shareId":"sh-1","shareType":"text","digest":"d1","text":"dup","url":""}"#,
        );
        let consumed = reconcile_pending_shares_at(&mut db, &root).expect("reconcile replay");
        assert_eq!(consumed, 0, "replayed share must not create a duplicate item");
        let (rows, total) = db.inbox_query(None, None, None, None, 1, 10).unwrap();
        assert_eq!(total, 1);
        assert_eq!(rows[0].item.item_id, "sh-1");
        drop(db); // Windows: the SQLite file must be released before cleanup
        std::fs::remove_dir_all(&root).expect("remove disposable root");
    }

    #[test]
    fn stream_plus_text_meta_ingests_as_file() {
        // FIX-V1 routing contract: when an ACTION_SEND carries both a stream
        // and text, the stream wins. At the meta boundary this means a file
        // meta that also carries a caption text field must ingest as the file
        // item (with attachment) and never as a text item.
        let root = temp_root();
        let mut db = crate::db::Db::open(&root.join("test.db")).expect("open db");
        let file = write_file(&root, "att-sh-cap.jpg", b"image-with-caption");
        let sha = sha256_file(&file).expect("hash");
        write_file(
            &root,
            "share-sh-cap.meta.json",
            format!(
                r#"{{"status":"done","shareId":"sh-cap","shareType":"file","digest":"dcap","text":"caption text that must NOT win","url":"","fileName":"pic.jpg","mime":"image/jpeg","sizeBytes":21,"sha256":"{sha}","localUri":"{}"}}"#,
                file.to_string_lossy().replace('\\', "/")
            )
            .as_bytes(),
        );
        assert_eq!(reconcile_pending_shares_at(&mut db, &root).unwrap(), 1);
        let item = db.inbox_get("sh-cap").unwrap().unwrap();
        assert_eq!(item.item.kind, "image", "stream wins over caption text");
        assert_eq!(item.attachments.len(), 1, "attachment kept");
        assert_eq!(item.attachments[0].file_name, "pic.jpg");
        // The caption must not have created a separate text item.
        let (_, total) = db.inbox_query(None, None, None, None, 1, 10).unwrap();
        assert_eq!(total, 1);
        drop(db);
        std::fs::remove_dir_all(&root).expect("remove disposable root");
    }

    #[test]
    fn warm_dedup_does_not_leave_orphan_attachment() {
        // FIX-V1 lifecycle gap: same file shared again >60 s later (inside the
        // 1 h Rust window) stages a second att-* file that dedup rejects. The
        // ingest-then-reconcile sequence must remove the unowned staged file
        // without an app restart and keep the first owned file.
        let root = temp_root();
        let mut db = crate::db::Db::open(&root.join("test.db")).expect("open db");

        // First share: digest D -> item + owned file.
        let first = write_file(&root, "att-sh-first.jpg", b"same-content");
        let sha = sha256_file(&first).expect("hash");
        write_file(
            &root,
            "share-sh-first.meta.json",
            format!(
                r#"{{"status":"done","shareId":"sh-first","shareType":"file","digest":"D","fileName":"a.jpg","mime":"image/jpeg","sizeBytes":13,"sha256":"{sha}","localUri":"{}"}}"#,
                first.to_string_lossy().replace('\\', "/")
            )
            .as_bytes(),
        );
        assert_eq!(reconcile_pending_shares_at(&mut db, &root).unwrap(), 1);
        let owned = db.inbox_attachment_paths().unwrap();
        assert_eq!(owned.len(), 1);
        assert!(PathBuf::from(&owned[0]).exists(), "first owned file present");

        // Second share >60 s later: Kotlin stages a NEW file + meta with the
        // same digest; Rust dedups -> no new item, meta removed.
        let second = write_file(&root, "att-sh-second.jpg", b"same-content");
        write_file(
            &root,
            "share-sh-second.meta.json",
            format!(
                r#"{{"status":"done","shareId":"sh-second","shareType":"file","digest":"D","fileName":"a.jpg","mime":"image/jpeg","sizeBytes":13,"sha256":"{sha}","localUri":"{}"}}"#,
                second.to_string_lossy().replace('\\', "/")
            )
            .as_bytes(),
        );
        let consumed = reconcile_pending_shares_at(&mut db, &root).expect("reconcile second");
        assert_eq!(consumed, 0, "duplicate digest creates no second item");
        let (_, total) = db.inbox_query(None, None, None, None, 1, 10).unwrap();
        assert_eq!(total, 1, "still exactly one item");

        // Ingest-then-reconcile (the warm path, no restart): the just-staged
        // unowned file is removed; the DB-owned first file survives.
        let referenced = db.inbox_attachment_paths().unwrap();
        let removed = cleanup_unreferenced_at(&root, &referenced).expect("warm reconcile");
        assert_eq!(removed, 1, "exactly the unowned staged file is reclaimed");
        assert!(!second.exists(), "deduped staged file cleaned without restart");
        assert!(first.exists(), "first owned file still exists");
        assert_eq!(db.inbox_attachment_paths().unwrap().len(), 1);
        drop(db);
        std::fs::remove_dir_all(&root).expect("remove disposable root");
    }
}
