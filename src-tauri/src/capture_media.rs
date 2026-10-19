// Mobile capture (Android): pick image / take photo / pick file.
// JNI bridge to CaptureBridge (Kotlin). Results arrive as meta JSON files in
// the app-private outbox dir; we poll until the file appears, then compute
// SHA-256 and return a structured result. Shared TS only sees the adapter.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;

#[derive(Serialize, Clone)]
pub struct CaptureMedia {
    pub ref_id: String,
    pub kind: String, // "image" | "file"
    pub file_name: String,
    pub mime: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub local_uri: String,
}

/// Hash an attachment in bounded chunks so capture metadata can be verified
/// without loading a user-selected file into memory.
pub fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|e| format!("open attachment: {e}"))?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65_536];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|e| format!("read attachment: {e}"))?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(hash.finalize().iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Check that durable attachment metadata still describes the app-private file
/// immediately before upload. A missing or changed file is a recoverable outbox
/// failure; it must never be silently skipped or crash the command.
pub fn validate_attachment_file(
    local_path: &str,
    expected_size: i64,
    expected_sha256: &str,
) -> Result<(), String> {
    if local_path.is_empty() {
        return Err("attachment missing local path".into());
    }
    let path = Path::new(local_path);
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err("attachment missing from private outbox".into())
        }
        Err(error) => return Err(format!("attachment metadata: {error}")),
    };
    if !metadata.is_file() {
        return Err("attachment is not a regular file".into());
    }
    if expected_size < 0 {
        return Err("attachment size metadata invalid".into());
    }
    if metadata.len() != expected_size as u64 {
        return Err(format!(
            "attachment size mismatch (expected {expected_size}, found {})",
            metadata.len()
        ));
    }
    if expected_sha256.is_empty() {
        return Err("attachment sha256 metadata missing".into());
    }
    let actual_sha256 = sha256_file(path)?;
    if actual_sha256 != expected_sha256 {
        return Err("attachment sha256 mismatch".into());
    }
    Ok(())
}

/// Cancellation is a terminal, user-initiated picker outcome, not a failed
/// capture. Keep this narrowly scoped so timeouts and launch failures remain
/// visible to the caller.
pub fn is_user_cancelled_error(error: &str) -> bool {
    matches!(
        error.trim().to_ascii_lowercase().as_str(),
        "capture cancelled" | "capture canceled"
    )
}

/// Android's `AtomicFile` can leave a `.bak` or `.new` sidecar if the process
/// dies while a terminal picker result is being written. Those files have no
/// durable ownership until SQLite commits the attachment, so startup may safely
/// reclaim them alongside the primary terminal metadata file.
#[cfg(any(target_os = "android", test))]
fn is_terminal_capture_meta_name(name: &str) -> bool {
    name.starts_with("pending-")
        && (name.ends_with(".meta.json")
            || name.ends_with(".meta.json.bak")
            || name.ends_with(".meta.json.new"))
}

#[cfg(target_os = "android")]
mod platform {
    use super::*;
    use jni::objects::{GlobalRef, JObject, JValue};
    use jni::{JNIEnv, JavaVM};
    use std::collections::HashSet;
    use std::path::PathBuf;
    use std::sync::OnceLock;
    use std::time::{Duration, Instant};

    static VM: OnceLock<JavaVM> = OnceLock::new();
    static BRIDGE_CLASS: OnceLock<GlobalRef> = OnceLock::new();

    #[no_mangle]
    pub extern "system" fn Java_com_luckyray_mobile_CaptureBridge_nativeInit<'local>(
        env: JNIEnv<'local>,
        this: JObject<'local>,
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

    fn bridge_class<'local>(env: &mut JNIEnv<'local>) -> Result<jni::objects::JClass<'local>, String> {
        match BRIDGE_CLASS.get() {
            Some(g) => {
                let obj: JObject = unsafe { JObject::from_raw(g.as_raw()) };
                Ok(jni::objects::JClass::from(obj))
            }
            None => env
                .find_class("com/luckyray/mobile/CaptureBridge")
                .map_err(|e| format!("find: {e}")),
        }
    }

    fn launch<'local>(env: &mut JNIEnv<'local>, kind: i32) -> Result<String, String> {
        let class = bridge_class(env)?;
        let res = env
            .call_static_method(
                class,
                "launch",
                "(I)Ljava/lang/String;",
                &[JValue::Int(kind)],
            )
            .map_err(|e| format!("launch: {e}"))?;
        let obj = res.l().map_err(|e| format!("ref: {e}"))?;
        let s: String = env.get_string(&obj.into()).map_err(|e| format!("str: {e}"))?.into();
        Ok(s)
    }

    fn meta_path<'local>(env: &mut JNIEnv<'local>, ref_id: &str) -> Result<String, String> {
        let class = bridge_class(env)?;
        let arg = env.new_string(ref_id).map_err(|e| format!("new str: {e}"))?;
        let res = env
            .call_static_method(
                class,
                "metaPath",
                "(Ljava/lang/String;)Ljava/lang/String;",
                &[JValue::Object(&arg)],
            )
            .map_err(|e| format!("metaPath: {e}"))?;
        let obj = res.l().map_err(|e| format!("ref: {e}"))?;
        let s: String = env.get_string(&obj.into()).map_err(|e| format!("str: {e}"))?.into();
        Ok(s)
    }

    fn cancel<'local>(env: &mut JNIEnv<'local>, ref_id: &str) -> Result<(), String> {
        let class = bridge_class(env)?;
        let arg = env.new_string(ref_id).map_err(|e| format!("new str: {e}"))?;
        env.call_static_method(
            class,
            "cancel",
            "(Ljava/lang/String;)Ljava/lang/String;",
            &[JValue::Object(&arg)],
        )
        .map_err(|e| format!("capture cancel: {e}"))?;
        Ok(())
    }

    fn outbox_dir<'local>(env: &mut JNIEnv<'local>) -> Result<String, String> {
        let class = bridge_class(env)?;
        let result = env
            .call_static_method(class, "outboxDir", "()Ljava/lang/String;", &[])
            .map_err(|e| format!("capture outbox dir: {e}"))?;
        let object = result.l().map_err(|e| format!("capture outbox dir result: {e}"))?;
        env.get_string(&object.into())
            .map(|value| value.into())
            .map_err(|e| format!("capture outbox dir string: {e}"))
    }

    fn cancel_pending(ref_id: &str) {
        let Some(vm) = VM.get() else {
            return;
        };
        if let Ok(mut env) = vm.attach_current_thread() {
            let _ = cancel(&mut env, ref_id);
        }
    }

    fn private_outbox_dir() -> Result<PathBuf, String> {
        let vm = VM.get().ok_or("JVM not attached")?;
        let mut env = vm
            .attach_current_thread()
            .map_err(|e| format!("attach: {e}"))?;
        let dir = PathBuf::from(outbox_dir(&mut env)?);
        std::fs::create_dir_all(&dir).map_err(|e| format!("create private outbox: {e}"))?;
        dir.canonicalize()
            .map_err(|e| format!("canonical private outbox: {e}"))
    }

    /// Launch a picker (0=image, 1=photo, 2=file) and wait for the meta file.
    pub fn pick(kind: i32, timeout_ms: u64) -> Result<CaptureMedia, String> {
        let vm = VM.get().ok_or("JVM not attached")?;
        let mut env = vm.attach_current_thread().map_err(|e| format!("attach: {e}"))?;
        let ref_id = launch(&mut env, kind)?;
        if ref_id == "BUSY" {
            return Err("capture busy: another picker is active".into());
        }
        if ref_id.is_empty() {
            return Err("capture launch unavailable".into());
        }
        let meta_path = meta_path(&mut env, &ref_id)?;
        drop(env);

        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        let path = PathBuf::from(&meta_path);
        loop {
            if path.exists() {
                let content = std::fs::read_to_string(&path).map_err(|e| format!("read meta: {e}"))?;
                let json: serde_json::Value = match serde_json::from_str(&content) {
                    Ok(json) => json,
                    Err(error) => {
                        cancel_pending(&ref_id);
                        let _ = std::fs::remove_file(&path);
                        return Err(format!("capture metadata invalid: {error}"));
                    }
                };
                let status = json["status"].as_str().unwrap_or("error");
                match status {
                    "done" => {
                        let local_uri = json["localUri"].as_str().unwrap_or("").to_string();
                        if local_uri.is_empty() {
                            let _ = std::fs::remove_file(&path);
                            return Err("capture result missing local file".into());
                        }
                        let size = std::fs::metadata(&local_uri)
                            .map_err(|e| format!("capture result metadata: {e}"))?
                            .len();
                        if let Some(reported_size) = json["sizeBytes"].as_u64() {
                            if reported_size != size {
                                let _ = std::fs::remove_file(&path);
                                return Err("capture result size changed before enqueue".into());
                            }
                        }
                        let sha = sha256_file(Path::new(&local_uri))?;
                        let media = CaptureMedia {
                            ref_id,
                            kind: json["kind"].as_str().unwrap_or("file").to_string(),
                            file_name: json["fileName"].as_str().unwrap_or("capture").to_string(),
                            mime: json["mime"].as_str().unwrap_or("application/octet-stream").to_string(),
                            size_bytes: size,
                            sha256: sha,
                            local_uri,
                        };
                        let _ = std::fs::remove_file(&path);
                        return Ok(media);
                    }
                    "cancelled" => {
                        let _ = std::fs::remove_file(&path);
                        return Err("capture cancelled".into());
                    }
                    "error" => {
                        let _ = std::fs::remove_file(&path);
                        return Err(format!("capture error: {}", json["message"]));
                    }
                    _ => {}
                }
            }
            if Instant::now() > deadline {
                cancel_pending(&ref_id);
                let _ = std::fs::remove_file(&path);
                return Err("capture timeout".into());
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    /// On restart, remove only unreferenced files in the app-private capture
    /// directory. Database-owned paths are preserved; terminal picker metadata
    /// and files created before the database transaction are safe to reclaim.
    pub fn cleanup_unreferenced_private_outbox(referenced_paths: &[String]) -> Result<usize, String> {
        let root = private_outbox_dir()?;
        let referenced: HashSet<PathBuf> = referenced_paths
            .iter()
            .filter_map(|path| PathBuf::from(path).canonicalize().ok())
            .filter(|path| path.starts_with(&root))
            .collect();
        let mut removed = 0usize;
        for entry in std::fs::read_dir(&root).map_err(|e| format!("read private outbox: {e}"))? {
            let entry = entry.map_err(|e| format!("private outbox entry: {e}"))?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let is_terminal_meta = is_terminal_capture_meta_name(&name);
            let is_attachment = name.starts_with("ref-");
            let managed_path = path.canonicalize().map_err(|e| format!("canonical private entry: {e}"))?;
            if is_terminal_meta || (is_attachment && !referenced.contains(&managed_path)) {
                std::fs::remove_file(&managed_path)
                    .map_err(|e| format!("remove private outbox orphan: {e}"))?;
                removed += 1;
            }
        }
        Ok(removed)
    }

    /// Delete a completed attachment only if it resolves under the app-private
    /// capture outbox and has the bridge-owned `ref-` filename. Missing files
    /// are already cleaned up and may release their metadata; untrusted paths
    /// are never deleted from SQLite input alone.
    pub fn remove_private_attachment_if_managed(local_path: &str) -> Result<bool, String> {
        let root = private_outbox_dir()?;
        let path = PathBuf::from(local_path);
        let canonical = match path.canonicalize() {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
            Err(error) => return Err(format!("canonical completed attachment: {error}")),
        };
        let name_is_managed = canonical
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("ref-"));
        if !canonical.starts_with(&root) || !name_is_managed {
            return Ok(false);
        }
        std::fs::remove_file(&canonical).map_err(|e| format!("remove completed attachment: {e}"))?;
        Ok(true)
    }
}

#[cfg(not(target_os = "android"))]
mod platform {
    use super::*;
    // Desktop fallback (dev only): generate a tiny fixture so the flow can be
    // exercised without a device. NOT for production.
    pub fn pick(kind: i32, _timeout_ms: u64) -> Result<CaptureMedia, String> {
        let ref_id = format!("ref-desktop-{kind}");
        Ok(CaptureMedia {
            ref_id,
            kind: if kind == 1 { "image".into() } else { "file".into() },
            file_name: "desktop-fixture.bin".into(),
            mime: "application/octet-stream".into(),
            size_bytes: 42,
            sha256: "desktop-fixture".into(),
            local_uri: String::new(),
        })
    }

    pub fn cleanup_unreferenced_private_outbox(_referenced_paths: &[String]) -> Result<usize, String> {
        Ok(0)
    }

    pub fn remove_private_attachment_if_managed(_local_path: &str) -> Result<bool, String> {
        Ok(false)
    }
}

pub use platform::{
    cleanup_unreferenced_private_outbox, pick, remove_private_attachment_if_managed,
};

/// Single-request model guard: the bridge returns "BUSY" while a picker is active.
pub fn validate_ref_id(ref_id: &str) -> Result<(), String> {
    if ref_id == "BUSY" {
        Err("capture busy: another picker is active".into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn busy_refid_rejected() {
        assert!(validate_ref_id("BUSY").is_err());
        assert!(validate_ref_id("ref-123").is_ok());
    }

    #[test]
    fn cancellation_error_is_not_a_capture_failure() {
        assert!(is_user_cancelled_error("capture cancelled"));
        assert!(is_user_cancelled_error("CAPTURE CANCELED"));
        assert!(!is_user_cancelled_error("capture timeout"));
        assert!(!is_user_cancelled_error("capture error: picker unavailable"));
    }

    #[test]
    fn reconciliation_recognizes_atomic_terminal_meta_sidecars() {
        assert!(is_terminal_capture_meta_name("pending-ref-1.meta.json"));
        assert!(is_terminal_capture_meta_name("pending-ref-1.meta.json.bak"));
        assert!(is_terminal_capture_meta_name("pending-ref-1.meta.json.new"));
        assert!(!is_terminal_capture_meta_name("pending-ref-1.json"));
        assert!(!is_terminal_capture_meta_name("ref-1.jpg"));
    }

    #[test]
    fn thumbnail_max_bytes_sane() {
        // oversized downloads must be rejected before caching
        assert!(crate::THUMBNAIL_MAX_BYTES > 0);
    }

    #[test]
    fn attachment_validation_handles_unicode_zero_small_and_large_files() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("luckyray-attachment-{nonce}"));
        std::fs::create_dir_all(&dir).expect("create disposable attachment directory");

        let zero = dir.join("空文件-零字节.bin");
        let small = dir.join("短文件.txt");
        let large = dir.join(format!("{}-large.bin", "长文件名".repeat(24)));
        std::fs::write(&zero, []).expect("write zero-byte fixture");
        std::fs::write(&small, b"small fixture").expect("write small fixture");
        std::fs::write(&large, vec![0x5a; 1024 * 1024]).expect("write large fixture");

        for path in [&zero, &small, &large] {
            let size = std::fs::metadata(path).unwrap().len() as i64;
            let sha = sha256_file(path).expect("hash fixture");
            validate_attachment_file(path.to_str().unwrap(), size, &sha)
                .expect("valid app-private attachment is uploadable");
        }

        std::fs::remove_dir_all(&dir).expect("remove disposable fixtures");
    }

    #[test]
    fn attachment_validation_returns_bounded_errors_for_missing_or_changed_files() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("luckyray-attachment-error-{nonce}"));
        std::fs::create_dir_all(&dir).expect("create disposable attachment directory");
        let path = dir.join("changed.bin");
        std::fs::write(&path, b"before").expect("write fixture");
        let sha = sha256_file(&path).expect("hash fixture");

        std::fs::write(&path, b"after-content").expect("mutate fixture");
        let changed = validate_attachment_file(path.to_str().unwrap(), 6, &sha)
            .expect_err("changed bytes must not be uploaded under stale metadata");
        assert!(changed.contains("size mismatch") || changed.contains("sha256 mismatch"));

        let missing = validate_attachment_file(
            dir.join("missing.bin").to_str().unwrap(),
            0,
            "no-hash",
        )
        .expect_err("missing attachment is a recoverable failure, not a crash");
        assert!(missing.contains("attachment missing"));
        std::fs::remove_dir_all(&dir).expect("remove disposable fixtures");
    }
}
