// Mobile Companion Storage & Export (M2.11 + FIX-V1) — Rust side of the
// dedicated native boundary.
//
// One small JNI wrapper around `ExportBridge` (Kotlin), mirroring the
// existing KeystoreBridge pattern (VM + cached class GlobalRef via Kotlin
// `init { nativeInit() }`):
//
//  - `companion_export`   — validate the source file + collection, compute a
//    bounded streaming SHA-256, sanitize the display name authoritatively,
//    then ask the bridge to create a system MediaStore copy (or return
//    `already_exists` for an unchanged source).
//  - `companion_share_file` — validate the source file, then share via a
//    narrow FileProvider content:// URI (READ grant only).
//  - `companion_share_text` — ACTION_SEND text/plain.
//  - `companion_storage_stats` / `companion_clear_cache` — storage
//    transparency + bounded disposable-cache cleanup.
//
// FIX-V1 P1-1 — SOURCE AUTHORITY (final):
//  - the owner roots come from the SAME platform authority that creates them:
//    `ExportBridge.ownerRoots()` returns the canonical `activity.filesDir`
//    based roots (`local-assets/originals/`, `local-inbox/`) — no ambiguous
//    Tauri app_data_dir alias assumption;
//  - a valid source is a REGULAR FILE that is a DIRECT CHILD of exactly one
//    owner root, with the managed basename prefix (`asset-*` for the asset
//    originals root, `att-*` for the inbox root);
//  - `share-*.meta.json` reconciliation metadata, staging files, `ref-*`
//    outbox files, DB/diagnostics, arbitrary files inside an allowed
//    directory, and nested subpaths are all refused;
//  - canonicalization prevents `..` traversal escaping the roots.
//
// FIX-V1 P1-4 — the authoritative display-name sanitization runs HERE (before
// the bridge): the sanitized name is used for dedupe, unique-name generation,
// MediaStore DISPLAY_NAME and the share title. Useful Unicode/CJK is
// preserved; separators/control characters become `_`; leading dots and
// whitespace are stripped; empty results fall back to `export`; the result is
// byte-bounded (≤ 200 bytes, extension preserved) for Android/MediaStore
// safety. The LuckyRay asset's own display name in SQLite is never modified.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::capture_media::sha256_file;

#[cfg(target_os = "android")]
mod platform {
    use jni::objects::JValue;
    use jni::{JNIEnv, JavaVM};
    use std::path::PathBuf;
    use std::sync::OnceLock;

    use super::OwnerRoots;

    static VM: OnceLock<JavaVM> = OnceLock::new();
    static EXPORT_CLASS: OnceLock<jni::objects::GlobalRef> = OnceLock::new();

    #[no_mangle]
    pub extern "system" fn Java_com_luckyray_mobile_ExportBridge_nativeInit(
        env: JNIEnv,
        this: jni::objects::JObject,
    ) {
        if let Ok(vm) = env.get_java_vm() {
            let _ = VM.set(vm);
        }
        if let Ok(class) = env.get_object_class(&this) {
            if let Ok(g) = env.new_global_ref(class) {
                let _ = EXPORT_CLASS.set(g);
            }
        }
    }

    /// Call a `@JvmStatic` ExportBridge method returning a JSON string.
    fn call(method: &str, args: &[String]) -> Result<String, String> {
        let vm = VM.get().ok_or("JVM not attached (ExportBridge not initialized)")?;
        let mut env = vm
            .attach_current_thread()
            .map_err(|e| format!("attach jvm: {e}"))?;
        let class: jni::objects::JClass = match EXPORT_CLASS.get() {
            Some(g) => {
                let obj: jni::objects::JObject = unsafe { jni::objects::JObject::from_raw(g.as_raw()) };
                obj.into()
            }
            None => env
                .find_class("com/luckyray/mobile/ExportBridge")
                .map_err(|e| format!("find class: {e}"))?,
        };
        let jstrings: Vec<_> = args
            .iter()
            .map(|a| env.new_string(a).map_err(|e| format!("new string: {e}")))
            .collect::<Result<_, _>>()?;
        let sig = format!(
            "({})Ljava/lang/String;",
            "Ljava/lang/String;".repeat(args.len())
        );
        let jvalues: Vec<JValue> = jstrings.iter().map(|s| JValue::Object(s)).collect();
        let result = env
            .call_static_method(class, method, &sig, &jvalues)
            .map_err(|e| format!("call {method}: {e}"))?;
        let jobj = result.l().map_err(|e| format!("result: {e}"))?;
        let jstring: jni::objects::JString = jobj.into();
        let out: String = env
            .get_string(&jstring)
            .map_err(|e| format!("get string: {e}"))?
            .into();
        Ok(out)
    }

    pub fn export_file(
        source: &str,
        display_name: &str,
        mime: &str,
        collection: &str,
        sha256: &str,
    ) -> Result<String, String> {
        call(
            "exportFile",
            &[source.to_string(), display_name.to_string(), mime.to_string(), collection.to_string(), sha256.to_string()],
        )
    }

    pub fn share_file(source: &str, display_name: &str, mime: &str) -> Result<String, String> {
        call("shareFile", &[source.to_string(), display_name.to_string(), mime.to_string()])
    }

    /// M2.13 FIX-V1 P1-D: external open of an app-private file through the
    /// dedicated narrow provider (ACTION_VIEW + content:// + read grant).
    /// The tauri-plugin-opener mobile path (`run_mobile_plugin("open", String)`)
    /// is incompatible with the tauri-android plugin bridge (Jackson cannot
    /// deserialize a plain String into the Kotlin args object), so opening
    /// goes through ExportBridge.openFile instead — same FileProvider,
    /// same narrow export_file_paths.xml exposure.
    pub fn open_file(source: &str, mime: &str) -> Result<String, String> {
        call("openFile", &[source.to_string(), mime.to_string()])
    }

    pub fn share_text(text: &str) -> Result<String, String> {
        call("shareText", &[text.to_string()])
    }

    pub fn storage_stats() -> Result<String, String> {
        call("storageStats", &[])
    }

    pub fn clear_cache() -> Result<String, String> {
        call("clearCache", &[])
    }

    /// The exact canonical Mobile-owned roots, from the platform authority
    /// that creates them (`ExportBridge` -> `activity.filesDir`).
    pub fn owner_roots() -> Result<super::OwnerRoots, String> {
        let raw = call("ownerRoots", &[])?;
        let arr: Vec<String> = serde_json::from_str(&raw).map_err(|e| format!("owner roots parse: {e}"))?;
        if arr.len() != 2 {
            return Err(String::from("owner roots malformed"));
        }
        let canonical = |p: &str| {
            match PathBuf::from(p).canonicalize() {
                Ok(c) => Ok(c),
                Err(e) => {
                    // Device-local diagnostic only (never forwarded to the
                    // renderer — the caller keeps the generic message).
                    println!("[LR-EXPORT] owner root canonicalize failed: {p}: {e}");
                    Err(String::from("owner root not accessible"))
                }
            }
        };
        Ok(super::OwnerRoots {
            asset_originals: canonical(&arr[0])?,
            inbox: canonical(&arr[1])?,
        })
    }
}

#[cfg(not(target_os = "android"))]
mod platform {
    // Host-safe fallback: these commands exist on non-Android builds (e.g.
    // cargo test / desktop dev) but have no native bridge. They return a
    // bounded, explicit error — the UI only exposes them on Android.
    pub fn export_file(_s: &str, _n: &str, _m: &str, _c: &str, _h: &str) -> Result<String, String> {
        Err(String::from("system export is Android-only"))
    }
    pub fn share_file(_s: &str, _n: &str, _m: &str) -> Result<String, String> {
        Err(String::from("system share is Android-only"))
    }
    pub fn open_file(_s: &str, _m: &str) -> Result<String, String> {
        Err(String::from("external open is Android-only"))
    }
    pub fn share_text(_t: &str) -> Result<String, String> {
        Err(String::from("system share is Android-only"))
    }
    pub fn storage_stats() -> Result<String, String> {
        Err(String::from("storage stats are Android-only"))
    }
    pub fn clear_cache() -> Result<String, String> {
        Err(String::from("cache cleanup is Android-only"))
    }
    pub fn owner_roots() -> Result<super::OwnerRoots, String> {
        Err(String::from("owner roots are Android-only"))
    }
}

// ---------------------------------------------------------------------------
// Shared (host + Android) validation helpers — pure and unit-testable.
// ---------------------------------------------------------------------------

pub const ALLOWED_COLLECTIONS: [&str; 3] = ["Pictures", "Movies", "Downloads"];
const MAX_MIME: usize = 128;
/// Hard byte bound for a sanitized export display name (Android/ext4-safe;
/// 255-byte component limit minus headroom). Extension is preserved.
pub const MAX_SANITIZED_NAME_BYTES: usize = 200;

/// Exact canonical Mobile-owned roots. On Android these come from
/// `ExportBridge.ownerRoots()` (`activity.filesDir` authority — the same
/// platform code that creates the roots); host tests construct explicit
/// fixture roots.
pub struct OwnerRoots {
    pub asset_originals: PathBuf,
    pub inbox: PathBuf,
}

fn is_managed_basename(prefix: &str, name: &str) -> bool {
    name.starts_with(prefix) && name.len() > prefix.len()
}

/// FIX-V1 P1-1: validate that `path` is a MANAGED file — a regular file that
/// is a DIRECT CHILD of exactly one canonical owner root, with the managed
/// basename prefix (`asset-*` under the asset-originals root, `att-*` under
/// the inbox root). `share-*.meta.json`, staging files, `ref-*` outbox files,
/// arbitrary files inside an allowed directory, nested subpaths, and
/// `..` traversal are all refused.
pub fn validate_source_path(roots: &OwnerRoots, path: &str) -> Result<PathBuf, String> {
    let raw = PathBuf::from(path);
    if !raw.is_absolute() {
        return Err(String::from("source path must be absolute"));
    }
    let canonical = raw
        .canonicalize()
        .map_err(|_| String::from("source file not accessible"))?;
    if !canonical.is_file() {
        return Err(String::from("source file not found"));
    }
    let parent = canonical
        .parent()
        .ok_or_else(|| String::from("source has no parent"))?;
    let name = canonical
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| String::from("source name invalid"))?;

    let originals = roots
        .asset_originals
        .canonicalize()
        .map_err(|_| String::from("owner root not accessible"))?;
    let inbox = roots
        .inbox
        .canonicalize()
        .map_err(|_| String::from("owner root not accessible"))?;

    if parent == originals && is_managed_basename("asset-", name) {
        return Ok(canonical);
    }
    if parent == inbox && is_managed_basename("att-", name) {
        return Ok(canonical);
    }
    Err(String::from("source is not a managed Mobile-owned file"))
}

/// FIX-V1 P1-4: authoritative display-name sanitization (the ONLY place a
/// display name becomes a system filename). Preserves Unicode/CJK; path
/// separators and C0/C1 control characters become `_`; whitespace trimmed;
/// leading dots stripped; empty/only-dot results fall back to `export`; the
/// result is byte-bounded (≤ 200 bytes, extension preserved).
pub fn sanitize_export_name(name: &str) -> String {
    let mut cleaned = String::with_capacity(name.len());
    for ch in name.chars() {
        let o = ch as u32;
        if ch == '/' || ch == '\\' || o <= 0x1f || o == 0x7f {
            cleaned.push('_');
        } else {
            cleaned.push(ch);
        }
    }
    let trimmed = cleaned.trim();
    let base: String = trimmed.trim_start_matches('.').to_string();
    let base = if base.is_empty() { "export".to_string() } else { base };

    if base.len() <= MAX_SANITIZED_NAME_BYTES {
        return base;
    }
    // Byte-bounded with the extension preserved (char-safe truncation —
    // chars are taken only while their UTF-8 bytes fit the budget).
    fn truncate_to_bytes(s: &str, budget: usize) -> String {
        let mut out = String::new();
        for ch in s.chars() {
            if out.len() + ch.len_utf8() > budget {
                break;
            }
            out.push(ch);
        }
        out
    }
    match base.rfind('.') {
        Some(dot) => {
            let ext = &base[dot..];
            let keep = MAX_SANITIZED_NAME_BYTES.saturating_sub(ext.len());
            if keep == 0 {
                return truncate_to_bytes(&base, MAX_SANITIZED_NAME_BYTES);
            }
            let mut out = truncate_to_bytes(&base[..dot], keep);
            out.push_str(ext);
            out
        }
        None => truncate_to_bytes(&base, MAX_SANITIZED_NAME_BYTES),
    }
}

/// Post-sanitization bounds: non-empty and byte-bounded. Separators/controls
/// are already gone (sanitize is authoritative); this only guards the
/// boundary.
pub fn validate_display_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > MAX_SANITIZED_NAME_BYTES {
        return Err(String::from("invalid display name"));
    }
    Ok(())
}

pub fn validate_collection(collection: &str) -> Result<(), String> {
    if ALLOWED_COLLECTIONS.contains(&collection) {
        Ok(())
    } else {
        Err(String::from("unknown export collection"))
    }
}

pub fn validate_mime(mime: &str) -> Result<(), String> {
    if mime.len() > MAX_MIME {
        return Err(String::from("invalid mime"));
    }
    Ok(())
}

pub fn validate_text(text: &str) -> Result<(), String> {
    if text.is_empty() || text.len() > 64 * 1024 {
        return Err(String::from("invalid share text"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Command entry points (called from lib.rs)
// ---------------------------------------------------------------------------

/// Export a Mobile-owned file to a system MediaStore collection.
/// `collection` ∈ {Pictures, Movies, Downloads} (classified by the pure TS
/// exportPolicy — the bridge only accepts the three known collections).
/// Returns {status: created|already_exists|error, destination, displayName,
/// uri?, bytes?} — never a private filesystem path.
pub fn export_to_system(
    source_path: &str,
    display_name: &str,
    mime: &str,
    collection: &str,
) -> Result<serde_json::Value, String> {
    let roots = platform::owner_roots()?;
    let source = validate_source_path(&roots, source_path)?;
    // FIX-V1 P1-4: sanitize BEFORE the bridge — the sanitized name is the
    // single authority for dedupe / unique-name / MediaStore display / share.
    let sanitized = sanitize_export_name(display_name);
    validate_display_name(&sanitized)?;
    validate_collection(collection)?;
    validate_mime(mime)?;
    let sha = sha256_file(&source)?;
    let raw = platform::export_file(
        &source.to_string_lossy(),
        &sanitized,
        mime,
        collection,
        &sha,
    )?;
    serde_json::from_str(&raw).map_err(|e| format!("export result parse: {e}"))
}

pub fn share_file_to_system(
    source_path: &str,
    display_name: &str,
    mime: &str,
) -> Result<serde_json::Value, String> {
    let roots = platform::owner_roots()?;
    let source = validate_source_path(&roots, source_path)?;
    let sanitized = sanitize_export_name(display_name);
    validate_display_name(&sanitized)?;
    validate_mime(mime)?;
    let raw = platform::share_file(&source.to_string_lossy(), &sanitized, mime)?;
    serde_json::from_str(&raw).map_err(|e| format!("share result parse: {e}"))
}

pub fn share_text_to_system(text: &str) -> Result<serde_json::Value, String> {
    validate_text(text)?;
    let raw = platform::share_text(text)?;
    serde_json::from_str(&raw).map_err(|e| format!("share result parse: {e}"))
}

/// M2.13 FIX-V1 P1-D: external open of an app-private file.
///
/// Android: validates the source against the exact owner roots (Local Inbox
/// attachments / Local Asset originals only — never a free-form path), then
/// opens via `ExportBridge.openFile` (narrow content:// provider + read
/// grant + explicit viewer check).
///
/// Desktop/host: opens the path with the system default application through
/// the opener crate directly (the mobile plugin ACL path is Android-only).
pub fn open_attachment_path(source_path: &str, mime: &str) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        let roots = platform::owner_roots()?;
        let source = validate_source_path(&roots, source_path)?;
        validate_mime(mime)?;
        let raw = platform::open_file(&source.to_string_lossy(), mime)?;
        serde_json::from_str(&raw).map_err(|e| format!("open result parse: {e}"))
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = mime;
        tauri_plugin_opener::open_path(source_path, None::<&str>)
            .map_err(|e| format!("open failed: {e}"))?;
        Ok(serde_json::json!({ "status": "ok" }))
    }
}

pub fn storage_stats() -> Result<serde_json::Value, String> {
    let raw = platform::storage_stats()?;
    serde_json::from_str(&raw).map_err(|e| format!("stats parse: {e}"))
}

/// Caller resolves an exact private content-cache object from its identity and
/// validated receipt; this is deliberately not a path-taking frontend command.
pub(crate) fn open_content_cache(source: &str, mime: &str) -> Result<serde_json::Value,String> {
    validate_mime(mime)?;
    #[cfg(target_os="android")] {
        let result:serde_json::Value=serde_json::from_str(&platform::open_file(source,mime)?).map_err(|_|"CONTENT_OPEN_FAILED")?;
        if result["status"] != "ok" {return Err("CONTENT_VIEWER_UNAVAILABLE".into());}
        Ok(result)
    }
    #[cfg(not(target_os="android"))] {open_attachment_path(source,mime)}
}

pub fn clear_cache() -> Result<serde_json::Value, String> {
    let raw = platform::clear_cache()?;
    serde_json::from_str(&raw).map_err(|e| format!("clear cache parse: {e}"))
}

// ---------------------------------------------------------------------------
// Host unit tests (deterministic, no device needed)
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    /// Fixture roots mirroring the real Android layout (filesDir authority):
    /// the fixture root directory stands in for `activity.filesDir`.
    fn fixture_roots() -> (std::path::PathBuf, OwnerRoots) {
        let dir = std::env::temp_dir().join(format!("lr-companion-fixv1-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let originals = dir.join("local-assets/originals");
        let inbox = dir.join("local-inbox");
        std::fs::create_dir_all(&originals).unwrap();
        std::fs::create_dir_all(&inbox).unwrap();
        std::fs::create_dir_all(dir.join("local-assets/staging")).unwrap();
        std::fs::create_dir_all(dir.join("capture-outbox")).unwrap();
        let roots = OwnerRoots {
            asset_originals: originals.clone(),
            inbox: inbox.clone(),
        };
        (dir, roots)
    }

    fn write(dir: &std::path::Path, rel: &str) -> std::path::PathBuf {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, b"x").unwrap();
        p
    }

    #[test]
    fn validates_managed_files_only_direct_children_with_prefixes() {
        let (dir, roots) = fixture_roots();

        // Direct managed files accepted.
        let asset = write(&dir, "local-assets/originals/asset-1.jpg");
        assert!(validate_source_path(&roots, &asset.to_string_lossy()).is_ok(), "asset-* direct child accepted");
        let att = write(&dir, "local-inbox/att-1.png");
        assert!(validate_source_path(&roots, &att.to_string_lossy()).is_ok(), "att-* direct child accepted");

        // Inbox reconciliation metadata must NEVER be a source.
        let meta = write(&dir, "local-inbox/share-abc.meta.json");
        assert!(validate_source_path(&roots, &meta.to_string_lossy()).is_err(), "share-*.meta.json refused");

        // Arbitrary files inside an allowed directory refused.
        let foo_originals = write(&dir, "local-assets/originals/foo.bin");
        assert!(validate_source_path(&roots, &foo_originals.to_string_lossy()).is_err(), "foo.bin in originals refused");
        let foo_inbox = write(&dir, "local-inbox/foo.bin");
        assert!(validate_source_path(&roots, &foo_inbox.to_string_lossy()).is_err(), "foo.bin in inbox refused");

        // Prefix-like but not managed: `att-` alone, `asset-` alone.
        let att_bare = write(&dir, "local-inbox/att-");
        assert!(validate_source_path(&roots, &att_bare.to_string_lossy()).is_err(), "bare 'att-' refused");
        let asset_bare = write(&dir, "local-assets/originals/asset-");
        assert!(validate_source_path(&roots, &asset_bare.to_string_lossy()).is_err(), "bare 'asset-' refused");

        // Nested subpaths refused (no arbitrary descendants).
        let nested_att = write(&dir, "local-inbox/sub/att-1.png");
        assert!(validate_source_path(&roots, &nested_att.to_string_lossy()).is_err(), "nested inbox refused");
        let nested_asset = write(&dir, "local-assets/originals/sub/asset-1.jpg");
        assert!(validate_source_path(&roots, &nested_asset.to_string_lossy()).is_err(), "nested originals refused");

        // Staging / outbox / DB / foreign files refused.
        let staging = write(&dir, "local-assets/staging/stage-1.part");
        assert!(validate_source_path(&roots, &staging.to_string_lossy()).is_err(), "staging refused");
        let outbox = write(&dir, "capture-outbox/ref-1.bin");
        assert!(validate_source_path(&roots, &outbox.to_string_lossy()).is_err(), "outbox ref-* refused");
        let db = write(&dir, "luckyray-mobile.db");
        assert!(validate_source_path(&roots, &db.to_string_lossy()).is_err(), "DB refused");
        let foreign = write(&dir, "other.txt");
        assert!(validate_source_path(&roots, &foreign.to_string_lossy()).is_err(), "foreign file refused");

        // Traversal cannot escape the roots.
        let data_file = write(&dir, "secret.txt");
        let traversal = dir.join("local-inbox").join("..").join("secret.txt");
        if let Ok(c) = traversal.canonicalize() {
            assert!(validate_source_path(&roots, &c.to_string_lossy()).is_err(), ".. traversal refused");
        }
        let _ = data_file;

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sanitize_export_name_is_authoritative_and_safe() {
        // FIX-V1 P1-4 deterministic case: a legitimate editable display name
        // with `/`, `\` and a control char exports as a safe system filename.
        assert_eq!(sanitize_export_name("旅行/照片\\\u{1}A.jpg"), "旅行_照片__A.jpg");
        // CJK preserved.
        assert_eq!(sanitize_export_name("照片 01.jpg"), "照片 01.jpg");
        // Separators / controls replaced.
        assert_eq!(sanitize_export_name("a/b\\c\u{0}d.txt"), "a_b_c_d.txt");
        // Leading dots + whitespace stripped; dot-dot cannot survive.
        assert_eq!(sanitize_export_name("..hidden.txt"), "hidden.txt");
        assert_eq!(sanitize_export_name(".."), "export");
        assert_eq!(sanitize_export_name("   "), "export");
        assert_eq!(sanitize_export_name(""), "export");
        // Byte-bounded with the extension preserved.
        let long = format!("{}{}", "长".repeat(90), ".png"); // 270 bytes + ext
        let out = sanitize_export_name(&long);
        assert!(out.len() <= MAX_SANITIZED_NAME_BYTES, "bounded: {} bytes", out.len());
        assert!(out.ends_with(".png"), "extension preserved");
        // Sanitized names always pass the boundary validation.
        for case in ["旅行/照片\u{1}A.jpg", "..", "   ", "a/b\\c.txt", &long] {
            let s = sanitize_export_name(case);
            assert!(validate_display_name(&s).is_ok(), "sanitized {case:?} validates");
        }
    }

    #[test]
    fn validates_collection_name_and_mime_bounds() {
        assert!(validate_collection("Pictures").is_ok());
        assert!(validate_collection("Movies").is_ok());
        assert!(validate_collection("Downloads").is_ok());
        assert!(validate_collection("External").is_err());
        assert!(validate_collection("").is_err());

        // After sanitization the boundary only checks bounds.
        assert!(validate_display_name("照片-01.jpg").is_ok());
        assert!(validate_display_name("").is_err());
        assert!(validate_display_name(&"n".repeat(201)).is_err());

        assert!(validate_mime("image/jpeg").is_ok());
        assert!(validate_mime(&"m".repeat(200)).is_err());

        assert!(validate_text("hello").is_ok());
        assert!(validate_text("").is_err());
        assert!(validate_text(&"x".repeat(70_000)).is_err());
    }
}

/// Graph-only trusted caller. Not a frontend path-taking command; no change to
/// validate_source_path or provider exposure. Source is fresh canonical PNG.
pub(crate) fn export_graph_cache(root: &Path, path: &Path, action: &str) -> Result<serde_json::Value, String> {
    let source=crate::graph_export::validate_cache_file(root,path)?;
    let raw=match action {
        "share"=>platform::share_file(&source.to_string_lossy(),"LuckyRay-Graph.png","image/png")?,
        "save"=>platform::export_file(&source.to_string_lossy(),"LuckyRay-Graph.png","image/png","Pictures",&sha256_file(&source)?)?,
        _=>return Err("GRAPH_EXPORT_ACTION_INVALID".into()),
    };
    let result:serde_json::Value=serde_json::from_str(&raw).map_err(|_|"GRAPH_EXPORT_FAILED")?;
    if result["status"]!="ok"&&result["status"]!="created"&&result["status"]!="already_exists" {return Err("GRAPH_EXPORT_FAILED".into());}
    Ok(result)
}
