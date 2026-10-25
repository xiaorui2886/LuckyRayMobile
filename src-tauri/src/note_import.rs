//! App-private document copies; durable queue IDs are also local note IDs.
use crate::{db::Db, with_db, SharedState};
use serde_json::{json, Value};
use std::path::Path;
use tauri::State;
const MAX_BYTES: usize = 4 * 1024 * 1024;

fn validate_document(name: &str, content: &str) -> Result<String, String> {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    if !matches!(ext.as_str(), "md" | "markdown" | "txt") { return Err("NOTE_IMPORT_EXTENSION_UNSUPPORTED".into()); }
    if content.len() > MAX_BYTES { return Err("NOTE_IMPORT_TOO_LARGE".into()); }
    if content.chars().any(|c| c.is_ascii_control() && !matches!(c, '\t' | '\n' | '\r')) { return Err("NOTE_IMPORT_ENCODING_UNSUPPORTED".into()); }
    let leaf = name.rsplit(['/', '\\']).next().unwrap_or("note.md");
    let stem = leaf.rsplit_once('.').map(|(s, _)| s).unwrap_or(leaf);
    let mut title = String::new();
    for c in stem.chars().filter(|c| !c.is_control() && !"<>:\"/\\|?*".contains(*c)) {
        if title.len() + c.len_utf8() > 180 { break; }
        title.push(c);
    }
    let title = title.trim().trim_matches('.').trim();
    Ok(if title.is_empty() { "导入笔记".into() } else { title.into() })
}
fn valid_request(id: &str) -> bool { uuid::Uuid::parse_str(id).is_ok() && id.len() == 36 }
#[cfg(target_os = "android")]
fn root() -> Result<std::path::PathBuf, String> {
    crate::local_inbox::share_bridge_static_string("noteImportDir", "()Ljava/lang/String;").map(Into::into)
}
#[tauri::command]
pub(crate) fn local_note_import_pick() -> Result<Value, String> {
    #[cfg(target_os = "android")]
    {
        let status = crate::local_inbox::share_bridge_static_string("launchNoteImport", "()Ljava/lang/String;")?;
        if status == "busy" { return Err("NOTE_IMPORT_PICKER_BUSY".into()); }
        // New bridge returns the native picker identity; old status-only bridges
        // remain readable, but cannot authorize an automatic managed adoption.
        if status.starts_with('{') {
            let result: Value = serde_json::from_str(&status).map_err(|_| "NOTE_IMPORT_REQUEST_INVALID")?;
            if result["status"] != "launched" || !result["requestId"].as_str().map(valid_request).unwrap_or(false) {
                return Err("NOTE_IMPORT_REQUEST_INVALID".into());
            }
            return Ok(result);
        }
        return Ok(json!({"status":status}));
    }
    #[cfg(not(target_os = "android"))]
    Err("NOTE_IMPORT_ANDROID_REQUIRED".into())
}
fn pending_at(db: &mut Db, root: &Path) -> Result<Value, String> {
    let mut items = Vec::new();
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(json!({"items":[]})),
        Err(_) => return Err("NOTE_IMPORT_QUEUE_UNAVAILABLE".into()),
    };
    let mut paths = entries.filter_map(Result::ok).take(128).map(|entry| entry.path()).collect::<Vec<_>>();
    let mut total_bytes = 0u64;
    let mut has_more = false;
    paths.sort();
    for path in paths {
        if items.len() >= 32 { has_more = true; break; }
        if path.extension().and_then(|s| s.to_str()) != Some("json") { continue; }
        let id = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        if !valid_request(id) || path.is_symlink() { continue; }
        // JSON escaping can expand UTF-8 control characters six-fold.
        let error = |reason: &str| json!({"requestId":id,"source":"picker","status":"error","error":reason});
        let size = match path.metadata() { Ok(meta) => meta.len(), Err(_) => { items.push(error("NOTE_IMPORT_QUEUE_UNAVAILABLE")); continue; } };
        if size > (MAX_BYTES * 6 + 4096) as u64 { items.push(error("NOTE_IMPORT_TOO_LARGE")); continue; }
        total_bytes += size;
        if total_bytes > (MAX_BYTES * 12 + 8192) as u64 { has_more = true; break; }
        let bytes = match std::fs::read(&path) { Ok(bytes) => bytes, Err(_) => { items.push(error("NOTE_IMPORT_QUEUE_UNAVAILABLE")); continue; } };
        let meta: Value = match serde_json::from_slice(&bytes) { Ok(meta) => meta, Err(_) => { items.push(error("NOTE_IMPORT_QUEUE_INVALID")); continue; } };
        if meta["requestId"] != id { items.push(error("NOTE_IMPORT_QUEUE_INVALID")); continue; }
        let source = if meta["source"] == "view" { "view" } else { "picker" };
        if meta["status"] != "ready" {
            items.push(json!({"requestId":id,"source":source,"status":if meta["status"]=="cancelled" {"cancelled"} else {"error"},"error":meta["error"]}));
            continue;
        }
        let Some(content) = meta["content"].as_str() else { items.push(error("NOTE_IMPORT_QUEUE_INVALID")); continue };
        let title = match validate_document(meta["fileName"].as_str().unwrap_or(""), content) {
            Ok(title) => title,
            Err(error) => { items.push(json!({"requestId":id,"source":source,"status":"error","error":error})); continue; }
        };
        let import_id = meta["importId"].as_str().unwrap_or(id);
        if !valid_request(import_id) { items.push(error("NOTE_IMPORT_REQUEST_INVALID")); continue; }
        let note_id = format!("note-import-{import_id}");
        // INSERT OR IGNORE and tags commit in one transaction. Replay never
        // overwrites an edited imported note after crash or warm delivery.
        db.note_insert(&note_id, &title, content.strip_prefix('\u{feff}').unwrap_or(content), &[], None)?;
        let saved_title = db.note_get(&note_id)?.map(|note| note.title).unwrap_or(title);
        items.push(json!({"requestId":id,"source":source,"status":"imported","noteId":note_id,"title":saved_title}));
    }
    Ok(json!({"items":items,"hasMore":has_more}))
}
#[tauri::command]
pub(crate) fn local_note_import_pending(state: State<'_, SharedState>) -> Result<Value, String> {
    #[cfg(target_os = "android")]
    { let dir = root()?; return with_db(&state, |db| pending_at(db, &dir)); }
    #[cfg(not(target_os = "android"))]
    { let _ = state; Ok(json!({"items":[]})) }
}
#[tauri::command]
pub(crate) fn local_note_import_ack(request_ids: Vec<String>) -> Result<(), String> {
    if request_ids.len() > 100 || request_ids.iter().any(|id| !valid_request(id)) { return Err("NOTE_IMPORT_REQUEST_INVALID".into()); }
    #[cfg(target_os = "android")]
    for id in request_ids {
        let root = root()?;
        for suffix in [".json.bak", ".json.new", ".json"] {
            let path = root.join(format!("{id}{suffix}"));
            match std::fs::remove_file(path) { Ok(()) => (), Err(e) if e.kind()==std::io::ErrorKind::NotFound => (), Err(_) => return Err("NOTE_IMPORT_ACK_FAILED".into()) }
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn title_and_document_are_bounded() {
        assert_eq!(validate_document("../../恶意:标题.md", "正文").unwrap(), "恶意标题");
        assert!(validate_document("evil.pdf", "body").is_err());
        assert!(validate_document("a.md", "utf16\0body").is_err());
        assert!(validate_document("a.txt", &"a".repeat(MAX_BYTES + 1)).is_err());
        assert!(validate_document(&format!("{}.md", "中".repeat(500)), "").unwrap().len() <= 180);
    }
    #[test] fn malformed_receipt_does_not_starve_valid_import() {
        let dir = std::env::temp_dir().join(format!("note-import-malformed-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut db = Db::open(&dir.join("test.db")).unwrap();
        std::fs::write(dir.join("00000000-0000-0000-0000-000000000001.json"), "{").unwrap();
        let id = "00000000-0000-0000-0000-000000000002";
        std::fs::write(dir.join(format!("{id}.json")), json!({"requestId":id,"status":"ready","fileName":"empty.txt","content":""}).to_string()).unwrap();
        let results = pending_at(&mut db, &dir).unwrap();
        assert_eq!(results["items"][0]["status"], "error");
        assert_eq!(results["items"][1]["status"], "imported");
        drop(db); std::fs::remove_dir_all(dir).unwrap();
    }
    #[test] fn replay_preserves_edits_and_idempotent_note() {
        let dir = std::env::temp_dir().join(format!("note-import-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut db = Db::open(&dir.join("test.db")).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        std::fs::write(dir.join(format!("{id}.json")), json!({"requestId":id,"source":"view","status":"ready","fileName":"readme.md","content":"original"}).to_string()).unwrap();
        let receipt = pending_at(&mut db, &dir).unwrap();
        let note = receipt["items"][0]["noteId"].as_str().unwrap();
        db.note_update(note, "edited", "changed", &[]).unwrap();
        assert_eq!(pending_at(&mut db, &dir).unwrap()["items"][0]["noteId"], note);
        assert_eq!(db.note_get(note).unwrap().unwrap().content, "changed");
        // After acknowledgement, another VIEW delivery must reopen the same
        // imported note without overwriting edits or producing a duplicate.
        std::fs::remove_file(dir.join(format!("{id}.json"))).unwrap();
        let delivery = uuid::Uuid::new_v4().to_string();
        std::fs::write(dir.join(format!("{delivery}.json")), json!({"requestId":delivery,"importId":id,"source":"view","status":"ready","fileName":"readme.md","content":"original"}).to_string()).unwrap();
        let reopened = pending_at(&mut db, &dir).unwrap();
        assert_eq!(reopened["items"][0]["requestId"], delivery);
        assert_eq!(reopened["items"][0]["noteId"], note);
        assert_eq!(db.note_get(note).unwrap().unwrap().content, "changed");
        drop(db); std::fs::remove_dir_all(dir).unwrap();
    }
}
