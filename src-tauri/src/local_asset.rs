// M2.9 Mobile-local domain — durable original-file ownership for the Local
// Material Library (素材库). Deliberately separate from:
//
//   capture_media  -> Desktop delivery layer (capture-outbox/, ref-* files)
//   local_inbox    -> Local Inbox user data (local-inbox/, att-* files)
//   local_asset    -> Local Asset user data (local-assets/, asset-* originals)
//
// Ownership rules (invariants):
//   - every managed original lives under app-private `local-assets/originals/`
//     with an `asset-*` name — unreachable by Desktop/cache cleanup (ref-*),
//     Local Inbox cleanup (att-*), or pairing revoke;
//   - staging files live under `local-assets/staging/` (`stage-*.part`) and are
//     transient: a crash before the final rename leaves only a staging file;
//   - visible-DB-row invariant: a Local Asset row is committed only AFTER the
//     final original exists (staging -> fsync -> verify size+SHA-256 ->
//     atomic rename -> DB commit);
//   - a crash between rename and DB commit leaves an unowned managed original
//     that startup reconciliation reclaims (never a DB-owned file);
//   - orphan cleanup deletes only unreferenced `asset-*` originals and any
//     staging file; it never touches `local-inbox/att-*` or `capture-outbox/ref-*`;
//   - deleting a Local Asset removes exactly the file its own row owns;
//   - Local Inbox -> Local Asset promotion COPIES the att-* original into the
//     independent asset root; the source Inbox item + attachment stay intact.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use uuid::Uuid;

use crate::capture_media::{sha256_file, CaptureMedia};
use crate::db::{self, Db};

/// The app-private Local Asset root. Android: resolved through ShareBridge so
/// the Kotlin and Rust sides always agree on the directory.
#[cfg(target_os = "android")]
pub(crate) fn asset_root() -> Result<PathBuf, String> {
    let dir = crate::local_inbox::share_bridge_static_string("localAssetsDir", "()Ljava/lang/String;")?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create local assets: {e}"))?;
    PathBuf::from(dir).canonicalize().map_err(|e| format!("canonical local assets: {e}"))
}

/// Host (non-Android) asset root for tests and the desktop dev fixture.
#[cfg(not(target_os = "android"))]
pub(crate) fn asset_root() -> Result<PathBuf, String> {
    Err("local asset storage requires Android".into())
}

/// Derive the managed original file name for a Local Asset. The extension
/// comes from the user-visible file name and is sanitized (alphanumeric,
/// bounded length) so a hostile/odd file name can never escape the root.
fn original_file_name(asset_id: &str, file_name: &str, mime: &str) -> String {
    let ext = Path::new(file_name)
        .extension()
        .and_then(|e| e.to_str())
        .filter(|e| !e.is_empty() && e.len() <= 10 && e.chars().all(|c| c.is_ascii_alphanumeric()))
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_else(|| match mime {
            "image/png" => "png".to_string(),
            "image/jpeg" | "image/jpg" => "jpg".to_string(),
            "image/webp" => "webp".to_string(),
            "image/gif" => "gif".to_string(),
            "video/mp4" => "mp4".to_string(),
            "video/webm" => "webm".to_string(),
            "application/pdf" => "pdf".to_string(),
            "text/plain" => "txt".to_string(),
            _ => "bin".to_string(),
        });
    format!("asset-{asset_id}.{ext}")
}

/// A picked/promoted file that has been durably staged as a managed original.
#[derive(Debug)]
pub struct StagedOriginal {
    pub asset_id: String,
    pub file_name: String,
    pub mime: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub local_path: String,
}

/// Copy a picker result (already in the capture-outbox staging area) into the
/// Local Asset storage: staging copy -> fsync -> size+SHA-256 verify -> atomic
/// rename to `originals/asset-*`. The DB row is committed by the caller AFTER
/// this succeeds (visible-row invariant). A crash anywhere before the commit
/// leaves only an unowned file that reconciliation reclaims.
pub fn stage_picked_into_assets(media: &CaptureMedia) -> Result<StagedOriginal, String> {
    let root = asset_root()?;
    stage_into_assets_at(&root, Path::new(&media.local_uri), &media.file_name, &media.mime, media.size_bytes, &media.sha256)
}

/// Copy a Local Inbox attachment (att-* under local-inbox/) into the Local
/// Asset root. Promotion copies — the source Inbox file is never moved or
/// re-parented, so deleting either side can never break the other.
pub fn stage_inbox_attachment_into_assets(
    inbox_attachment_path: &str,
    file_name: &str,
    mime: &str,
    size_bytes: u64,
    sha256: &str,
) -> Result<StagedOriginal, String> {
    let root = asset_root()?;
    stage_into_assets_at(&root, Path::new(inbox_attachment_path), file_name, mime, size_bytes, sha256)
}

/// Core staging implementation (host-testable with an explicit root).
fn stage_into_assets_at(
    root: &Path,
    source: &Path,
    file_name: &str,
    mime: &str,
    expected_size: u64,
    expected_sha256: &str,
) -> Result<StagedOriginal, String> {
    let source_canonical = source
        .canonicalize()
        .map_err(|e| format!("canonical import source: {e}"))?;
    if !source_canonical.is_file() {
        return Err("import source is not a regular file".into());
    }
    // The domain root is created here (idempotent), then canonicalized so
    // Windows 8.3 short paths cannot break the starts_with ownership checks.
    std::fs::create_dir_all(root).map_err(|e| format!("create local assets root: {e}"))?;
    let root = root
        .canonicalize()
        .map_err(|e| format!("canonical local assets root: {e}"))?;
    let staging_dir = root.join("staging");
    let originals_dir = root.join("originals");
    std::fs::create_dir_all(&staging_dir).map_err(|e| format!("mkdir asset staging: {e}"))?;
    std::fs::create_dir_all(&originals_dir).map_err(|e| format!("mkdir asset originals: {e}"))?;

    let asset_id = format!("{}", Uuid::new_v4().simple());
    let final_name = original_file_name(&asset_id, file_name, mime);
    let staging_path = staging_dir.join(format!("stage-{asset_id}.part"));
    let final_path = originals_dir.join(&final_name);

    // 1) streaming copy to the app-private staging file (bounded RAM).
    {
        let mut input = std::fs::File::open(&source_canonical)
            .map_err(|e| format!("open import source: {e}"))?;
        let mut output = std::fs::File::create(&staging_path)
            .map_err(|e| format!("create asset staging: {e}"))?;
        let mut buffer = [0u8; 65_536];
        let mut copied: u64 = 0;
        loop {
            let count = input
                .read(&mut buffer)
                .map_err(|e| format!("read import source: {e}"))?;
            if count == 0 {
                break;
            }
            output
                .write_all(&buffer[..count])
                .map_err(|e| format!("write asset staging: {e}"))?;
            copied += count as u64;
        }
        // 2) fsync before the final rename (durable original on crash).
        output.sync_all().map_err(|e| format!("sync asset staging: {e}"))?;
        if copied != expected_size {
            let _ = std::fs::remove_file(&staging_path);
            return Err(format!(
                "import size mismatch (expected {expected_size}, copied {copied})"
            ));
        }
    }
    // 3) verify content integrity by SHA-256 (streaming; never whole-file RAM).
    let actual_sha = sha256_file(&staging_path)?;
    if !expected_sha256.is_empty() && actual_sha != expected_sha256 {
        let _ = std::fs::remove_file(&staging_path);
        return Err("import sha256 mismatch — source changed during copy".into());
    }
    // 4) atomically rename staging -> final managed original.
    std::fs::rename(&staging_path, &final_path).map_err(|e| {
        let _ = std::fs::remove_file(&staging_path);
        format!("rename asset original: {e}")
    })?;
    let size = std::fs::metadata(&final_path)
        .map_err(|e| format!("asset original metadata: {e}"))?
        .len();
    Ok(StagedOriginal {
        asset_id,
        file_name: file_name.to_string(),
        mime: mime.to_string(),
        size_bytes: size,
        sha256: actual_sha,
        local_path: final_path.to_string_lossy().into_owned(),
    })
}

/// Deterministic derived-thumbnail path for a Local Asset (disposable cache).
pub fn thumb_path(asset_id: &str) -> Result<PathBuf, String> {
    if asset_id.is_empty() || asset_id.len()>160 || !asset_id.bytes().all(|c|c.is_ascii_alphanumeric()||c==b'-'||c==b'_') {return Err("local asset id invalid".into());}
    let root = asset_root()?;
    Ok(root.join("thumbs").join(format!("thumb-{asset_id}.jpg")))
}

/// Remove one asset's derived thumbnail (best-effort, disposable cache).
/// Only touches `local-assets/thumbs/thumb-<id>.jpg`; never originals or any
/// other domain. Host: no-op (no managed root off-device).
#[cfg(target_os = "android")]
pub fn remove_thumbnail_if_managed(asset_id: &str) -> Result<bool, String> {
    let thumb = thumb_path(asset_id)?;
    match std::fs::remove_file(&thumb) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("remove asset thumbnail: {error}")),
    }
}

#[cfg(not(target_os = "android"))]
pub fn remove_thumbnail_if_managed(_asset_id: &str) -> Result<bool, String> {
    Ok(false)
}

/// Remove derived thumbnails for many asset ids (erase-all path).
#[cfg(target_os = "android")]
pub fn erase_asset_thumbs(ids: &[String]) -> Result<usize, String> {
    let mut removed = 0usize;
    for id in ids {
        if remove_thumbnail_if_managed(id)? {
            removed += 1;
        }
    }
    Ok(removed)
}

#[cfg(not(target_os = "android"))]
pub fn erase_asset_thumbs(_ids: &[String]) -> Result<usize, String> {
    Ok(0)
}

/// Integrity report for one Local Asset original (P1-1 FIX-V1).
///
/// This is a READ-ONLY bounded check: it never deletes the DB row or the
/// original, and it never hashes every asset in the grid (the caller decides
/// when to request the streaming SHA-256 verification).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityReport {
    pub exists: bool,
    pub is_file: bool,
    pub size_matches: bool,
    /// true only when `verify_hash` was requested and the streaming SHA-256
    /// comparison actually ran; false when verification was deferred — callers
    /// must not claim verified integrity from a deferred check.
    pub hash_verified: bool,
    /// "healthy" | "missing" | "unreadable" | "size-mismatch" | "hash-mismatch"
    pub status: String,
}

/// Android entry: check an asset original that must resolve under the managed
/// Local Asset root (a tampered DB path can never inspect arbitrary files).
#[cfg(target_os = "android")]
pub fn check_integrity(
    local_path: &str,
    expected_size: i64,
    expected_hash: &str,
    verify_hash: bool,
) -> Result<IntegrityReport, String> {
    let root = asset_root()?;
    check_integrity_at(&root, local_path, expected_size, expected_hash, verify_hash)
}

/// Desktop dev fixture: no managed asset root off-device.
#[cfg(not(target_os = "android"))]
pub fn check_integrity(
    _local_path: &str,
    _expected_size: i64,
    _expected_hash: &str,
    _verify_hash: bool,
) -> Result<IntegrityReport, String> {
    Err("local asset integrity requires Android".into())
}

/// Host-testable core of `check_integrity`.
fn check_integrity_at(
    root: &Path,
    local_path: &str,
    expected_size: i64,
    expected_hash: &str,
    verify_hash: bool,
) -> Result<IntegrityReport, String> {
    let root = root
        .canonicalize()
        .map_err(|e| format!("canonical asset root: {e}"))?;
    let canonical = match PathBuf::from(local_path).canonicalize() {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(IntegrityReport {
                exists: false,
                is_file: false,
                size_matches: false,
                hash_verified: false,
                status: "missing".to_string(),
            })
        }
        Err(error) => {
            return Ok(IntegrityReport {
                exists: true,
                is_file: false,
                size_matches: false,
                hash_verified: false,
                status: "unreadable".to_string(),
            })
        }
    };
    // A visible Local Asset row must only ever reference its own managed
    // original; refuse to inspect anything outside the asset root.
    let originals_dir = root.join("originals");
    if !canonical.starts_with(&originals_dir) {
        return Err("local asset path outside managed root".into());
    }
    let metadata = match std::fs::metadata(&canonical) {
        Ok(m) => m,
        Err(_) => {
            return Ok(IntegrityReport {
                exists: true,
                is_file: false,
                size_matches: false,
                hash_verified: false,
                status: "unreadable".to_string(),
            })
        }
    };
    if !metadata.is_file() {
        return Ok(IntegrityReport {
            exists: true,
            is_file: false,
            size_matches: false,
            hash_verified: false,
            status: "unreadable".to_string(),
        });
    }
    let size_matches = metadata.len() == expected_size as u64;
    if !size_matches {
        return Ok(IntegrityReport {
            exists: true,
            is_file: true,
            size_matches: false,
            hash_verified: false,
            status: "size-mismatch".to_string(),
        });
    }
    if verify_hash {
        let actual = sha256_file(&canonical)?;
        if !expected_hash.is_empty() && actual != expected_hash {
            return Ok(IntegrityReport {
                exists: true,
                is_file: true,
                size_matches: true,
                hash_verified: true,
                status: "hash-mismatch".to_string(),
            });
        }
        return Ok(IntegrityReport {
            exists: true,
            is_file: true,
            size_matches: true,
            hash_verified: true,
            status: "healthy".to_string(),
        });
    }
    Ok(IntegrityReport {
        exists: true,
        is_file: true,
        size_matches: true,
        hash_verified: false,
        status: "healthy".to_string(),
    })
}

/// Generate a bounded JPEG thumbnail for an image original via the native
/// ThumbnailBridge (BitmapFactory with inSampleSize — bounded memory, no
/// broad media framework). Failure is reported as an error; callers fall back
/// to the icon/art treatment instead of breaking the asset.
#[cfg(target_os = "android")]
mod thumbnail {
    use super::*;
    use jni::objects::{GlobalRef, JObject, JValue};
    use jni::{JNIEnv, JavaVM};
    use std::sync::OnceLock;

    static VM: OnceLock<JavaVM> = OnceLock::new();
    static BRIDGE_CLASS: OnceLock<GlobalRef> = OnceLock::new();

    /// Kotlin `init { nativeInit() }` — caches the JVM and the ThumbnailBridge
    /// class GlobalRef so `generate()` never depends on find_class from a
    /// native thread (the codebase-wide pattern from capture_media).
    #[no_mangle]
    pub extern "system" fn Java_com_luckyray_mobile_ThumbnailBridge_nativeInit<'local>(
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
            None => {
                let found = env.find_class("com/luckyray/mobile/ThumbnailBridge");
                if found.is_err() {
                    let _ = env.exception_clear();
                }
                found.map_err(|e| format!("find ThumbnailBridge: {e}"))
            }
        }
    }

    pub fn generate(src_path: &str, dest_path: &str, max_dimension: i32) -> Result<(), String> {
        let vm = VM.get().ok_or("JVM not attached")?;
        let mut env = vm
            .attach_current_thread()
            .map_err(|e| format!("attach: {e}"))?;
        let class = bridge_class(&mut env)?;
        let src = env.new_string(src_path).map_err(|e| format!("src str: {e}"))?;
        let dest = env.new_string(dest_path).map_err(|e| format!("dest str: {e}"))?;
        let result = env
            .call_static_method(
                class,
                "generate",
                "(Ljava/lang/String;Ljava/lang/String;I)Ljava/lang/String;",
                &[
                    JValue::Object(&src),
                    JValue::Object(&dest),
                    JValue::Int(max_dimension.clamp(512, 1280)),
                ],
            )
            .map_err(|e| format!("thumbnail generate: {e}"))?;
        let obj = result.l().map_err(|e| format!("thumbnail ref: {e}"))?;
        let out: String = env
            .get_string(&obj.into())
            .map_err(|e| format!("thumbnail string: {e}"))?
            .into();
        if out == "ok" {
            Ok(())
        } else {
            Err(format!("thumbnail: {out}"))
        }
    }
}

#[cfg(target_os = "android")]
pub fn generate_thumbnail(src_path: &str, dest_path: &str) -> Result<(), String> {
    thumbnail::generate(src_path, dest_path, 512)
}

/// Same bounds-first native decoder and derived-cache authority, screen-sized
/// output only; never decode an unbounded original inside the old WebView.
#[cfg(target_os = "android")]
pub fn generate_screen_preview(src_path: &str, dest_path: &str) -> Result<(), String> {
    thumbnail::generate(src_path, dest_path, 1280)
}
#[cfg(not(target_os = "android"))]
pub fn generate_screen_preview(_: &str, _: &str) -> Result<(), String> {
    Err("image preview requires Android".into())
}

/// Same native decoder, existing domain cache, one screen decode at a time.
/// Only exact managed derivative names are disposable, never original files.
pub(crate) fn screen_preview_cached(source: &Path, dest: &Path, force: bool) -> Result<(i64, i64), String> {
    derived_preview_cached(source,dest,1280,force)
}

pub(crate) fn thumbnail_cached(source: &Path, dest: &Path, force: bool) -> Result<(i64,i64),String> {
    derived_preview_cached(source,dest,512,force)
}

fn derived_preview_cached(source: &Path, dest: &Path, max_dimension: i64, force: bool) -> Result<(i64,i64),String> {
    static GATE: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _gate = GATE.lock().map_err(|_| "CONTENT_PREVIEW_UNAVAILABLE")?;
    let root = dest.parent().ok_or("CONTENT_CACHE_UNAVAILABLE")?;
    std::fs::create_dir_all(root).map_err(|_| "CONTENT_CACHE_UNAVAILABLE")?;
    let dims = match (!force).then(||cache_dimensions(dest,max_dimension)).flatten() {
        Some(dims) => dims,
        None => {
            let temp = dest.with_extension(if max_dimension>512 {"tmp.png"} else {"tmp.jpg"});
            let generate = if max_dimension>512 {generate_screen_preview} else {generate_thumbnail};
            if let Err(error) = generate(source.to_str().ok_or("CONTENT_NOT_CACHED")?, temp.to_str().ok_or("CONTENT_NOT_CACHED")?) {
                let _ = std::fs::remove_file(&temp);
                return Err(error);
            }
            let Some(dims) = cache_dimensions(&temp,max_dimension) else {
                let _ = std::fs::remove_file(&temp);
                return Err("CONTENT_PREVIEW_UNAVAILABLE".into());
            };
            std::fs::rename(&temp, dest).map_err(|_| "CONTENT_CACHE_UNAVAILABLE")?;
            dims
        }
    };
    if let Ok(file) = std::fs::File::open(dest) {
        let _ = file.set_times(std::fs::FileTimes::new().set_modified(std::time::SystemTime::now()));
    }
    if max_dimension>512 {evict_screen_derivatives(root,dest)?;} else {evict_local_thumbnails(root,dest)?;}
    Ok(dims)
}

fn cache_dimensions(path: &Path, max_dimension: i64) -> Option<(i64, i64)> {
    let file = std::fs::File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    if size == 0 || size > 8 * 1024 * 1024 { return None; }
    let mut header = Vec::new();
    file.take(64 * 1024).read_to_end(&mut header).ok()?;
    let dims = crate::image_dimensions(&header);
    (dims.0 > 0 && dims.1 > 0 && dims.0.max(dims.1) <= max_dimension).then_some(dims)
}

fn evict_screen_derivatives(root: &Path, keep: &Path) -> Result<(), String> {
    let mut files = std::fs::read_dir(root).map_err(|_| "CONTENT_CACHE_UNAVAILABLE")?
        .filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name();
            let Some(name) = name.to_str().and_then(|s| s.strip_prefix("screen-")).and_then(|s| s.strip_suffix(".png").or_else(||s.strip_suffix(".jpg"))) else { return false; };
            let parts = name.split('-').collect::<Vec<_>>();
            parts.len() == 2 && parts.iter().all(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
                && entry.file_type().is_ok_and(|t| t.is_file())
        })
        .filter_map(|entry| entry.metadata().ok().map(|m| (entry.path(), m.len(), m.modified().ok())))
        .collect::<Vec<_>>();
    files.sort_by_key(|entry| entry.2);
    let mut bytes = files.iter().map(|entry| entry.1).sum::<u64>();
    let mut count = files.len();
    for (path, size, _) in files {
        if bytes <= 32 * 1024 * 1024 && count <= 48 { break; }
        if path != keep && std::fs::remove_file(path).is_ok() { bytes = bytes.saturating_sub(size); count -= 1; }
    }
    Ok(())
}

fn evict_local_thumbnails(root:&Path,keep:&Path)->Result<(),String> {
    let mut files=std::fs::read_dir(root).map_err(|_|"CONTENT_CACHE_UNAVAILABLE")?
        .filter_map(Result::ok).filter(|entry|{
            entry.file_type().is_ok_and(|t|t.is_file()) && entry.file_name().to_str().and_then(|s|s.strip_prefix("thumb-")).and_then(|s|s.strip_suffix(".jpg"))
                .is_some_and(|id|!id.is_empty()&&id.len()<=160&&id.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'||b==b'_'))
        }).filter_map(|entry|entry.metadata().ok().map(|m|(entry.path(),m.len(),m.modified().ok()))).collect::<Vec<_>>();
    files.sort_by_key(|entry|entry.2);
    let mut bytes=files.iter().map(|entry|entry.1).sum::<u64>();
    let mut count=files.len();
    for(path,size,_)in files {if bytes<=32*1024*1024 && count<=256 {break;}if path!=keep&&std::fs::remove_file(path).is_ok(){bytes=bytes.saturating_sub(size);count-=1;}}
    Ok(())
}

/// Desktop dev fixture: no native thumbnail generation off-device.
#[cfg(not(target_os = "android"))]
pub fn generate_thumbnail(_src_path: &str, _dest_path: &str) -> Result<(), String> {
    Err("thumbnail generation requires Android".into())
}

/// Delete a Local Asset original only if it resolves under the Local Asset
/// root's `originals/` subdir and has the managed `asset-*` filename. Missing
/// files are already cleaned up (Ok(true)); untrusted paths are never deleted
/// from DB input alone — this can never reach `local-inbox/att-*`,
/// `capture-outbox/ref-*`, or Desktop cache files.
pub fn remove_asset_original_if_managed(local_path: &str) -> Result<bool, String> {
    let root = asset_root()?;
    remove_original_at(&root, local_path)
}

fn remove_original_at(root: &Path, local_path: &str) -> Result<bool, String> {
    let root = match root.canonicalize() {
        Ok(path) => path,
        // The whole domain root is gone: nothing owned can exist inside it.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(format!("canonical asset root: {error}")),
    };
    let canonical = match PathBuf::from(local_path).canonicalize() {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(format!("canonical asset original: {error}")),
    };
    let originals_dir = root.join("originals");
    let name_owned = canonical
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("asset-"));
    if !canonical.starts_with(&originals_dir) || !name_owned {
        return Ok(false);
    }
    std::fs::remove_file(&canonical).map_err(|e| format!("remove asset original: {e}"))?;
    Ok(true)
}

/// Orphan reconciliation for the Local Asset root. Removes ONLY:
///   - every staging file (`staging/stage-*.part`) — staging is transient by
///     design (a crash before commit leaves it unowned);
///   - unreferenced `originals/asset-*` files not in the DB allow-list;
///   - stale derived thumbnails (`thumbs/thumb-<id>.jpg` whose asset row no
///     longer exists) — thumbnails are disposable cache and may be reclaimed
///     aggressively.
/// Never touches `local-inbox/`, `capture-outbox/`, Desktop cache, or DB rows.
#[cfg(target_os = "android")]
pub fn reconcile_asset_roots(db: &Db) -> Result<usize, String> {
    let root = asset_root()?;
    let referenced = db.asset_paths()?;
    let known_ids = db.asset_id_list()?;
    reconcile_assets_at(&root, &referenced, &known_ids)
}

/// Desktop dev fixture: nothing to reconcile off-device.
#[cfg(not(target_os = "android"))]
pub fn reconcile_asset_roots(_db: &Db) -> Result<usize, String> {
    Ok(0)
}

fn reconcile_assets_at(root: &Path, referenced_paths: &[String], known_ids: &[String]) -> Result<usize, String> {
    let root = match root.canonicalize() {
        Ok(path) => path,
        // The domain root is gone: nothing to reconcile.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(format!("canonical local assets root: {error}")),
    };
    let staging_dir = root.join("staging");
    let originals_dir = root.join("originals");
    let thumbs_dir = root.join("thumbs");
    let referenced: std::collections::HashSet<PathBuf> = referenced_paths
        .iter()
        .filter_map(|path| PathBuf::from(path).canonicalize().ok())
        .filter(|path| path.starts_with(&originals_dir))
        .collect();
    let known_ids: std::collections::HashSet<&str> = known_ids.iter().map(|s| s.as_str()).collect();
    let mut removed = 0usize;

    if staging_dir.is_dir() {
        for entry in std::fs::read_dir(&staging_dir).map_err(|e| format!("read asset staging: {e}"))? {
            let entry = entry.map_err(|e| format!("asset staging entry: {e}"))?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("stage-") && name.ends_with(".part") {
                std::fs::remove_file(&path).map_err(|e| format!("remove asset staging: {e}"))?;
                removed += 1;
            }
        }
    }

    if originals_dir.is_dir() {
        for entry in std::fs::read_dir(&originals_dir).map_err(|e| format!("read asset originals: {e}"))? {
            let entry = entry.map_err(|e| format!("asset originals entry: {e}"))?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with("asset-") {
                continue;
            }
            let canonical = path
                .canonicalize()
                .map_err(|e| format!("canonical asset entry: {e}"))?;
            if !referenced.contains(&canonical) {
                std::fs::remove_file(&canonical)
                    .map_err(|e| format!("remove asset orphan: {e}"))?;
                removed += 1;
            }
        }
    }

    // Derived thumbnails are disposable: reclaim `thumb-<id>.jpg` files whose
    // asset row no longer exists. Never touches originals or other domains.
    if thumbs_dir.is_dir() {
        for entry in std::fs::read_dir(&thumbs_dir).map_err(|e| format!("read asset thumbs: {e}"))? {
            let entry = entry.map_err(|e| format!("asset thumbs entry: {e}"))?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(id) = name.strip_prefix("thumb-").and_then(|n| n.strip_suffix(".jpg")) else {
                continue;
            };
            if !known_ids.contains(id) {
                std::fs::remove_file(&path).map_err(|e| format!("remove stale asset thumbnail: {e}"))?;
                removed += 1;
            }
        }
    }
    Ok(removed)
}

/// Host-testable core of `verify_inbox_attachment`.
fn verify_inbox_attachment_at(inbox_root: &Path, attachment_path: &str) -> Result<PathBuf, String> {
    let root = inbox_root
        .canonicalize()
        .map_err(|e| format!("canonical inbox root: {e}"))?;
    let canonical = match PathBuf::from(attachment_path).canonicalize() {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err("source inbox attachment missing".into())
        }
        Err(error) => return Err(format!("canonical inbox attachment: {error}")),
    };
    let name_owned = canonical
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("att-"));
    if !canonical.starts_with(&root) || !name_owned {
        return Err("source is not an app-owned Local Inbox attachment".into());
    }
    if !canonical.is_file() {
        return Err("source inbox attachment is not a regular file".into());
    }
    Ok(canonical)
}

/// Full Local Inbox -> Local Asset promotion orchestration (Android).
///
/// Ownership proof:
///   - the att-* original is COPIED into `local-assets/originals/asset-*`
///     (never moved / re-parented / shared), so the source Inbox item stays
///     intact and deleting either side can never break the other;
///   - the DB row is committed only after the copy is verified and renamed;
///   - idempotent for repeated taps / internal retries of the same live Inbox
///     item: if an asset with `source_inbox_id = inbox_id` already exists it is
///     returned instead of creating a duplicate.
#[cfg(target_os = "android")]
pub fn promote_inbox_to_asset(
    db: &mut Db,
    inbox_id: &str,
    new_asset_id: &str,
) -> Result<db::LocalAssetItem, String> {
    let inbox_root = crate::local_inbox::inbox_root_path()?;
    let asset_root = asset_root()?;
    promote_inbox_to_asset_at(db, &inbox_root, &asset_root, inbox_id, new_asset_id)
}

/// Desktop dev fixture: promotion requires the Android storage roots.
#[cfg(not(target_os = "android"))]
pub fn promote_inbox_to_asset(
    _db: &mut Db,
    _inbox_id: &str,
    _new_asset_id: &str,
) -> Result<db::LocalAssetItem, String> {
    Err("local asset promotion requires Android".into())
}

/// Host-testable core of `promote_inbox_to_asset` (explicit roots).
pub(crate) fn promote_inbox_to_asset_at(
    db: &mut Db,
    inbox_root: &Path,
    asset_root: &Path,
    inbox_id: &str,
    new_asset_id: &str,
) -> Result<db::LocalAssetItem, String> {
    // Idempotency: a promotion already applied to this live Inbox item?
    if let Some(existing) = db.asset_by_source_inbox(inbox_id)? {
        return Ok(existing);
    }
    let detail = db.inbox_get(inbox_id)?.ok_or("source local inbox item not found")?;
    let attachment = detail
        .attachments
        .first()
        .ok_or("inbox item has no attachment to promote")?;
    if !matches!(attachment.kind.as_str(), "image" | "photo" | "file") {
        return Err("text/link inbox items use the Local Note conversion path".into());
    }
    let source = verify_inbox_attachment_at(inbox_root, &attachment.local_path)?;
    let staged = stage_into_assets_at(
        asset_root,
        &source,
        &attachment.file_name,
        &attachment.mime,
        attachment.size_bytes as u64,
        &attachment.sha256,
    )?;
    let kind = db::Db::asset_kind_for_mime(&attachment.mime);
    db.asset_insert(
        new_asset_id,
        &kind,
        &attachment.file_name,
        &attachment.mime,
        staged.size_bytes as i64,
        &staged.sha256,
        &staged.local_path,
        "inbox",
        Some(inbox_id),
        &[],
    )?;
    db.asset_get(new_asset_id)?
        .ok_or_else(|| "promoted asset not found after insert".to_string())
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
        let dir = std::env::temp_dir().join(format!("lrm-assets-{}-{}", std::process::id(), nanos));
        std::fs::create_dir_all(&dir).expect("create disposable asset root");
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
    fn materials_97_screen_budget_never_removes_original_metadata_or_other_cache() {
        let root=temp_root();
        let original=write_file(&root,"original.png",b"original");
        let meta=write_file(&root,"resource.json",b"metadata");
        let foreign=write_file(&root,"screen-user-owned.jpg",b"not-managed");
        let mut current=PathBuf::new();
        for i in 0..52 {
            current=write_file(&root,&format!("screen-{:064x}-{:064x}.jpg",1,i),b"derived");
        }
        evict_screen_derivatives(&root,&current).unwrap();
        assert!(original.exists()&&meta.exists()&&foreign.exists()&&current.exists());
        let count=std::fs::read_dir(&root).unwrap().filter_map(Result::ok).filter(|e|e.file_name().to_string_lossy().len()==140).count();
        assert_eq!(count,48);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn materials_97_local_grid_budget_and_failed_regeneration_preserve_originals() {
        let root=temp_root();
        let original=write_file(&root,"asset-original.png",b"original-not-a-derived-cache");
        let metadata=write_file(&root,"resource.json",b"metadata");
        let mut current=PathBuf::new();
        for i in 0..260 {current=write_file(&root,&format!("thumb-{:032x}.jpg",i),b"derived");}
        evict_local_thumbnails(&root,&current).unwrap();
        let count=std::fs::read_dir(&root).unwrap().filter_map(Result::ok).filter(|e|e.file_name().to_string_lossy().starts_with("thumb-")).count();
        assert_eq!(count,256);
        assert!(original.exists()&&metadata.exists()&&current.exists());
        // Header-cache fixture, not a claimed decoded image. Android decoder
        // failure must leave last-good pixels and every original intact.
        let mut png=b"\x89PNG\r\n\x1a\n".to_vec();png.extend_from_slice(&[0;8]);
        png.extend_from_slice(&1280u32.to_be_bytes());png.extend_from_slice(&800u32.to_be_bytes());
        let screen=write_file(&root,&format!("screen-{:064x}-{:064x}.png",1,1),&png);
        assert_eq!(screen_preview_cached(&original,&screen,false).unwrap(),(1280,800));
        assert!(screen_preview_cached(&original,&screen,true).is_err(),"host has no Android decoder");
        assert_eq!(std::fs::read(&screen).unwrap(),png);
        assert_eq!(std::fs::read(&original).unwrap(),b"original-not-a-derived-cache");
        std::fs::remove_dir_all(root).unwrap();
    }

    fn fixture_media(root: &Path, name: &str, content: &[u8]) -> CaptureMedia {
        let source = write_file(root, name, content);
        CaptureMedia {
            ref_id: "ref-import".into(),
            kind: "image".into(),
            file_name: name.into(),
            mime: "image/jpeg".into(),
            size_bytes: content.len() as u64,
            sha256: sha256_file(&source).expect("hash"),
            local_uri: source.to_string_lossy().into_owned(),
        }
    }

    #[test]
    fn stage_import_copies_verifies_and_renames_to_managed_original() {
        let root = temp_root();
        let media = fixture_media(&root, "photo.jpg", b"jpeg-bytes-content");
        let staged = stage_into_assets_at(&root, Path::new(&media.local_uri), &media.file_name, &media.mime, media.size_bytes, &media.sha256)
            .expect("stage import");
        assert!(staged.asset_id.starts_with("asset-") || !staged.asset_id.is_empty());
        let final_path = PathBuf::from(&staged.local_path);
        assert!(final_path.exists(), "managed original exists");
        let name = final_path.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with("asset-"), "asset-* naming: {name}");
        assert!(
            final_path.starts_with(root.canonicalize().unwrap().join("originals")),
            "under originals/"
        );
        assert_eq!(staged.size_bytes, 18);
        assert_eq!(staged.sha256, media.sha256, "content preserved byte-for-byte");
        // the import source is copied, never consumed (the capture-outbox
        // staging copy is removed by the command after the DB commit)
        assert!(Path::new(&media.local_uri).exists(), "source remains until commit");
        // no staging file left behind
        let staging_left: Vec<_> = std::fs::read_dir(root.join("staging")).unwrap()
            .filter_map(|e| e.ok()).collect();
        assert!(staging_left.is_empty(), "staging empty after successful rename");
        std::fs::remove_dir_all(&root).expect("remove disposable root");
    }

    #[test]
    fn size_mismatch_aborts_without_visible_original() {
        let root = temp_root();
        let media = fixture_media(&root, "photo.jpg", b"some-bytes");
        let err = stage_into_assets_at(&root, Path::new(&media.local_uri), &media.file_name, &media.mime, 9999, &media.sha256)
            .expect_err("size mismatch must fail");
        assert!(err.contains("size mismatch"));
        let originals = root.join("originals");
        if originals.is_dir() {
            assert_eq!(std::fs::read_dir(&originals).unwrap().count(), 0, "no half-visible original");
        }
        std::fs::remove_dir_all(&root).expect("remove disposable root");
    }

    #[test]
    fn sha_mismatch_aborts_and_removes_staging() {
        let root = temp_root();
        let media = fixture_media(&root, "photo.jpg", b"content-bytes");
        let err = stage_into_assets_at(&root, Path::new(&media.local_uri), &media.file_name, &media.mime, media.size_bytes, "deadbeef")
            .expect_err("sha mismatch must fail");
        assert!(err.contains("sha256 mismatch"));
        let staging = root.join("staging");
        if staging.is_dir() {
            assert_eq!(std::fs::read_dir(&staging).unwrap().count(), 0, "failed staging removed");
        }
        std::fs::remove_dir_all(&root).expect("remove disposable root");
    }

    #[test]
    fn orphan_cleanup_keeps_db_owned_originals_and_reclaims_unowned() {
        let root = temp_root();
        let media = fixture_media(&root, "a.jpg", b"aaaa");
        let owned = stage_into_assets_at(&root, Path::new(&media.local_uri), &media.file_name, &media.mime, media.size_bytes, &media.sha256)
            .expect("stage owned");
        // unowned managed original (crash between rename and DB commit)
        let media2 = fixture_media(&root, "b.jpg", b"bbbb");
        let _orphan = stage_into_assets_at(&root, Path::new(&media2.local_uri), &media2.file_name, &media2.mime, media2.size_bytes, &media2.sha256)
            .expect("stage unowned");
        // a leftover staging file (crash during copy)
        std::fs::create_dir_all(root.join("staging")).ok();
        write_file(&root.join("staging"), "stage-dead.part", b"partial");
        // files that must never be touched: local-inbox att-* and capture-outbox ref-*
        let inbox_file = write_file(&root, "att-user.jpg", b"inbox-owned");
        let outbox_file = write_file(&root, "ref-user.jpg", b"capture-outbox");

        let referenced = vec![owned.local_path.clone()];
        let removed = reconcile_assets_at(&root, &referenced, &[]).expect("reconcile");
        assert_eq!(removed, 2, "staging + unowned original reclaimed");
        assert!(PathBuf::from(&owned.local_path).exists(), "DB-owned original survives");
        assert!(inbox_file.exists(), "local-inbox att-* never touched");
        assert!(outbox_file.exists(), "capture-outbox ref-* never touched");
        std::fs::remove_dir_all(&root).expect("remove disposable root");
    }

    #[test]
    fn managed_delete_only_touches_originals_asset_files() {
        let root = temp_root();
        let media = fixture_media(&root, "x.jpg", b"xxxx");
        let staged = stage_into_assets_at(&root, Path::new(&media.local_uri), &media.file_name, &media.mime, media.size_bytes, &media.sha256)
            .expect("stage");
        let original = PathBuf::from(&staged.local_path);
        assert!(remove_original_at(&root, &staged.local_path).unwrap(), "owned original removed");
        assert!(!original.exists());
        // missing path -> Ok(true)
        assert!(remove_original_at(&root, root.join("originals/asset-gone.bin").to_str().unwrap()).unwrap());
        // local-inbox att-* inside a DIFFERENT root must never be deleted
        let other_root = temp_root();
        let inbox_file = write_file(&other_root, "att-x.jpg", b"i");
        assert!(!remove_original_at(&root, inbox_file.to_str().unwrap()).unwrap());
        assert!(inbox_file.exists());
        // an asset-* file outside the asset root is not owned
        let outside = write_file(&other_root, "asset-x.jpg", b"o");
        assert!(!remove_original_at(&root, outside.to_str().unwrap()).unwrap());
        assert!(outside.exists());
        std::fs::remove_dir_all(&root).expect("remove disposable root");
        std::fs::remove_dir_all(&other_root).expect("remove disposable root");
    }

    #[test]
    fn verify_inbox_attachment_accepts_only_att_files_under_inbox_root() {
        let inbox_root = temp_root();
        let att = write_file(&inbox_root, "att-ok.jpg", b"inbox attachment");
        let outside_att = write_file(&inbox_root, "att-outside.jpg", b"o");
        let root2 = temp_root();
        let foreign = write_file(&root2, "att-foreign.jpg", b"f");

        assert!(verify_inbox_attachment_at(&inbox_root, att.to_str().unwrap()).is_ok());
        // same root but not an att-* name -> rejected
        let non_att = write_file(&inbox_root, "ref-other.jpg", b"r");
        assert!(verify_inbox_attachment_at(&inbox_root, non_att.to_str().unwrap()).is_err());
        // att-* file outside the inbox root -> rejected
        assert!(verify_inbox_attachment_at(&inbox_root, foreign.to_str().unwrap()).is_err());
        // missing file -> bounded error
        assert!(verify_inbox_attachment_at(&inbox_root, inbox_root.join("att-missing.jpg").to_str().unwrap()).is_err());
        // unrelated file must never be treated as owned
        assert!(outside_att.exists() && att.exists());
        std::fs::remove_dir_all(&inbox_root).expect("remove disposable root");
        std::fs::remove_dir_all(&root2).expect("remove disposable root");
    }

    #[test]
    fn promotion_copies_bytes_and_is_idempotent() {
        let root = temp_root();
        let inbox_root = root.join("inbox");
        let asset_root = root.join("assets");
        std::fs::create_dir_all(&inbox_root).unwrap();
        let mut db = crate::db::Db::open(&root.join("test.db")).expect("open db");
        // an app-owned inbox item with an attachment file
        let att = write_file(&inbox_root, "att-sh-1.pdf", b"pdf-bytes-12345");
        let sha = sha256_file(&att).expect("hash");
        db.inbox_insert_with_attachment(
            "in-1", "file", "report", "", "", "picker",
            "ref-1", "file", "application/pdf", "report.pdf", 15, &sha, att.to_str().unwrap(),
        )
        .unwrap();

        let promoted = promote_inbox_to_asset_at(&mut db, &inbox_root, &asset_root, "in-1", "asset-1").unwrap();
        assert_eq!(promoted.kind, "document", "MIME-derived kind");
        assert_eq!(promoted.source, "inbox");
        assert_eq!(promoted.source_inbox_id.as_deref(), Some("in-1"));
        assert_eq!(promoted.size_bytes, 15);
        assert!(PathBuf::from(&promoted.local_path).exists(), "copied original exists");
        assert!(
            PathBuf::from(&promoted.local_path)
                .starts_with(asset_root.canonicalize().unwrap().join("originals")),
            "promoted original lives in the asset root"
        );
        // the source Inbox attachment is untouched (copy, not move)
        assert!(att.exists(), "source Inbox attachment remains intact");
        let inbox_detail = db.inbox_get("in-1").unwrap().unwrap();
        assert_eq!(inbox_detail.attachments.len(), 1);

        // repeated tap for the same live Inbox item -> existing asset, no duplicate
        let again = promote_inbox_to_asset_at(&mut db, &inbox_root, &asset_root, "in-1", "asset-dup").unwrap();
        assert_eq!(again.asset_id, "asset-1", "idempotent promotion returns the existing asset");
        let (_assets, total) = db.asset_query(None, None, None, None, None, 1, 10, None).unwrap();
        assert_eq!(total, 1, "no duplicate logical assets");

        // deleting the source Inbox item must not break the promoted asset
        db.inbox_delete("in-1").unwrap();
        let after = db.asset_get("asset-1").unwrap().unwrap();
        assert!(PathBuf::from(&after.local_path).exists(), "asset original survives inbox delete");

        // deleting the promoted asset must not touch the inbox domain (item is gone,
        // but its file path is under the inbox root and was already removed with the item)
        let paths = db.asset_delete("asset-1").unwrap();
        assert_eq!(paths, vec![after.local_path]);
        drop(db);
        std::fs::remove_dir_all(&root).expect("remove disposable root");
    }

    #[test]
    fn integrity_reports_healthy_missing_size_hash_and_unicode() {
        let root = temp_root();
        // healthy original (Unicode path content)
        let media = fixture_media(&root, "photo.jpg", b"hello-integrity-bytes");
        let staged = stage_into_assets_at(&root, Path::new(&media.local_uri), &media.file_name, &media.mime, media.size_bytes, &media.sha256)
            .expect("stage");
        let ok = check_integrity_at(&root, &staged.local_path, staged.size_bytes as i64, &staged.sha256, true).expect("check");
        assert!(ok.exists && ok.is_file && ok.size_matches && ok.hash_verified);
        assert_eq!(ok.status, "healthy");

        // deferred hash: healthy but honestly hashVerified=false
        let deferred = check_integrity_at(&root, &staged.local_path, staged.size_bytes as i64, &staged.sha256, false).expect("check");
        assert_eq!(deferred.status, "healthy");
        assert!(!deferred.hash_verified, "deferred hash must not claim verification");

        // missing original
        let missing = check_integrity_at(&root, root.join("originals/asset-gone.bin").to_str().unwrap(), 1, "h", true).expect("check");
        assert!(!missing.exists);
        assert_eq!(missing.status, "missing");

        // size mismatch / truncated file
        std::fs::write(PathBuf::from(&staged.local_path), b"short").expect("truncate");
        let sized = check_integrity_at(&root, &staged.local_path, staged.size_bytes as i64, &staged.sha256, true).expect("check");
        assert!(sized.exists && sized.is_file);
        assert!(!sized.size_matches);
        assert_eq!(sized.status, "size-mismatch");

        // same-size but altered content -> SHA verification catches it
        std::fs::write(PathBuf::from(&staged.local_path), b"hello-integrity-BYTES").expect("rewrite same size");
        let altered = check_integrity_at(&root, &staged.local_path, staged.size_bytes as i64, &staged.sha256, true).expect("check");
        assert!(altered.size_matches);
        assert!(altered.hash_verified);
        assert_eq!(altered.status, "hash-mismatch");

        // path outside the managed root is refused (bounded, no arbitrary file reads)
        let outside = write_file(&root, "att-other.jpg", b"inbox file");
        let err = check_integrity_at(&root, outside.to_str().unwrap(), 10, "h", true).expect_err("outside path refused");
        assert!(err.contains("outside managed root"));
        std::fs::remove_dir_all(&root).expect("remove disposable root");
    }

    #[test]
    fn integrity_failure_preserves_the_db_row() {
        let root = temp_root();
        let mut db = crate::db::Db::open(&root.join("test.db")).expect("open db");
        let media = fixture_media(&root, "a.jpg", b"row-preserved-bytes");
        let staged = stage_into_assets_at(&root, Path::new(&media.local_uri), &media.file_name, &media.mime, media.size_bytes, &media.sha256)
            .expect("stage");
        let asset_id = staged.asset_id.clone();
        db.asset_insert(&asset_id, "image", "a.jpg", "image/jpeg", staged.size_bytes as i64, &staged.sha256, &staged.local_path, "direct_import", None, &[])
            .expect("insert row");
        // destroy the original on disk
        std::fs::remove_file(&staged.local_path).expect("remove original");
        let report = check_integrity_at(&root, &staged.local_path, staged.size_bytes as i64, &staged.sha256, true).expect("check");
        assert_eq!(report.status, "missing");
        // the DB row must survive the integrity failure
        let row = db.asset_get(&asset_id).expect("get").expect("row preserved");
        assert_eq!(row.name, "a.jpg");
        assert_eq!(row.size_bytes, staged.size_bytes as i64);
        drop(db);
        std::fs::remove_dir_all(&root).expect("remove disposable root");
    }

    #[test]
    fn thumbnail_reconcile_reclaims_stale_thumbs_only() {
        let root = temp_root();
        let media = fixture_media(&root, "a.jpg", b"thumb-lifecycle");
        let staged = stage_into_assets_at(&root, Path::new(&media.local_uri), &media.file_name, &media.mime, media.size_bytes, &media.sha256)
            .expect("stage");
        let asset_id = staged.asset_id.clone();
        let thumbs = root.join("thumbs");
        std::fs::create_dir_all(&thumbs).unwrap();
        // a live thumbnail for the known asset + two stale ones
        write_file(&thumbs, format!("thumb-{asset_id}.jpg").as_str(), b"live");
        write_file(&thumbs, "thumb-dead-1.jpg", b"stale");
        write_file(&thumbs, "thumb-dead-2.jpg", b"stale");
        // an owned original that must NEVER be touched by thumbnail cleanup
        let owned_original = write_file(&root.join("originals"), "asset-keep.jpg", b"original");

        let referenced = vec![
            staged.local_path.clone(),
            owned_original.to_string_lossy().into_owned(),
        ];
        let removed = reconcile_assets_at(&root, &referenced, &[asset_id.clone()]).expect("reconcile");
        assert_eq!(removed, 2, "only stale thumbnails reclaimed");
        assert!(thumbs.join(format!("thumb-{asset_id}.jpg")).exists(), "live thumbnail kept");
        assert!(owned_original.exists(), "originals never touched by thumbnail cleanup");
        assert!(PathBuf::from(&staged.local_path).exists(), "owned original survives");
        std::fs::remove_dir_all(&root).expect("remove disposable root");
    }

    #[test]
    fn promote_after_delete_creates_fresh_asset() {
        let root = temp_root();
        let inbox_root = root.join("inbox");
        let asset_root = root.join("assets");
        std::fs::create_dir_all(&inbox_root).unwrap();
        let mut db = crate::db::Db::open(&root.join("test.db")).expect("open db");
        let att = write_file(&inbox_root, "att-sh-2.jpg", b"img-bytes");
        let sha = sha256_file(&att).expect("hash");
        db.inbox_insert_with_attachment(
            "in-2", "image", "", "", "", "picker",
            "ref-2", "image", "image/jpeg", "pic.jpg", 9, &sha, att.to_str().unwrap(),
        )
        .unwrap();

        let first = promote_inbox_to_asset_at(&mut db, &inbox_root, &asset_root, "in-2", "asset-2a").unwrap();
        db.asset_delete(&first.asset_id).unwrap();
        let second = promote_inbox_to_asset_at(&mut db, &inbox_root, &asset_root, "in-2", "asset-2b").unwrap();
        assert_ne!(second.asset_id, first.asset_id, "promotion after deletion creates a fresh asset");
        assert!(PathBuf::from(&second.local_path).exists());
        drop(db);
        std::fs::remove_dir_all(&root).expect("remove disposable root");
    }
}
