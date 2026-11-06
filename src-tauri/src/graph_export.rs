//! User-initiated bounded graph PNG export; no frontend path/filename input.
use base64::Engine;
use std::{fs, sync::Mutex};
use tauri::Manager;
#[path = "graph_export_png.rs"]
mod png_cache;
pub(crate) use png_cache::validate_cache_file;
use png_cache::{canonical_png, error, private_root, write_cache, MAX_PNG_BYTES};
static EXPORT_LOCK: Mutex<()> = Mutex::new(());

#[tauri::command]
pub(crate) async fn graph_export_png(
    app: tauri::AppHandle,
    png_base64: String,
    action: String,
) -> Result<serde_json::Value, String> {
    if action != "share" && action != "save" {
        return Err("GRAPH_EXPORT_ACTION_INVALID".into());
    }
    if png_base64.len() > ((MAX_PNG_BYTES + 2) / 3) * 4 {
        return Err(error());
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        let _ = png_base64;
        return Err("GRAPH_EXPORT_ANDROID_ONLY".into());
    }
    #[cfg(target_os = "android")]
    {
        let cache = app
            .path()
            .app_cache_dir()
            .map_err(|_| "GRAPH_CACHE_UNAVAILABLE")?;
        tauri::async_runtime::spawn_blocking(move || {
            let _guard = EXPORT_LOCK.lock().map_err(|_| "GRAPH_EXPORT_BUSY")?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(png_base64)
                .map_err(|_| error())?;
            let png = canonical_png(&bytes)?;
            let root = private_root(&cache)?;
            let path = write_cache(&root, &png)?;
            let result = crate::companion_export::export_graph_cache(&root, &path, &action);
            // A shared URI needs the cache after the chooser returns. Save/error does not.
            if action == "save" || result.is_err() {
                let _ = fs::remove_file(&path);
            }
            result
        })
        .await
        .map_err(|_| "GRAPH_EXPORT_FAILED".to_string())?
    }
}
