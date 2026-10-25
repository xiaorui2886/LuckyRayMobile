// Wave-A Mobile gateway commands — Desktop material organization.
//
// Thin, capability-gated callers over the existing Companion Content V1
// transport (`content_mutate`). No local favorite/tag/folder authority: the
// Desktop owns the truth, Mobile reads the authoritative response back.
//
// Every command:
//   * requires a currently connected/authorized Desktop (no offline queue);
//   * gates on the advertised capability so an older Desktop fails truthfully;
//   * validates its input locally before touching the wire.
use serde_json::Value;
use tauri::State;

use super::*;

const MAX_BATCH: usize = 100;

fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn control_chars(value: &str) -> bool {
    value.chars().any(char::is_control)
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 160 && id.trim() == id && !control_chars(id)
}

/// Map the gateway's status/body into a truthful bounded error code.
fn mutation_error(status: u16, body: &Value) -> String {
    let code = body
        .get("code")
        .and_then(|v| v.as_str())
        .unwrap_or("CONTENT_MUTATION_FAILED");
    format!("{code} ({status})")
}

async fn send(
    state: &SharedState,
    expected_instance: &str,
    library: Option<&str>,
    capability: &str,
    path: String,
    method: reqwest::Method,
    payload: Value,
) -> Result<Value, String> {
    if expected_instance.is_empty() {
        return Err("CONTENT_SOURCE_CHANGED".into());
    }
    let source = Source::capture(state)?.scoped(library, None)?;
    // CROSS-DEVICE WRITE INTEGRITY: the UI decided this mutation belongs to a
    // specific Desktop. If the live connection has moved on, the request must
    // not be retargeted at the new one — bail out BEFORE the capability probe
    // and before anything reaches the wire.
    if source.instance != expected_instance {
        return Err("CONTENT_SOURCE_CHANGED".into());
    }
    // Capability gate: an older Desktop that does not advertise the domain
    // fails here instead of silently pretending the write happened.
    source.capabilities(state, capability).await?;
    // The identity must still hold across the awaited probe.
    if source.instance != expected_instance {
        return Err("CONTENT_SOURCE_CHANGED".into());
    }
    source.check(state)?;
    let (status, body) = source.mutate(state, &path, method, &payload).await?;
    if !(200..300).contains(&status) {
        return Err(mutation_error(status, &body));
    }
    // Source lifecycle check on the result, so a switch mid-flight is surfaced.
    source.check(state)?;
    Ok(body)
}

#[tauri::command]
pub(crate) async fn content_material_set_favorite(
    state: State<'_, SharedState>,
    instance: String,
    library: Option<String>,
    asset_id: String,
    favorited: bool,
) -> Result<Value, String> {
    if !valid_id(&asset_id) {
        return Err("CONTENT_INPUT_INVALID".into());
    }
    let payload = serde_json::json!({ "desktopAssetId": asset_id, "favorited": favorited });
    send(
        &state,
        &instance,
        library.as_deref(),
        "materialFavorite",
        format!("/v1/assets/{}/favorite", encode(&asset_id)),
        reqwest::Method::POST,
        payload,
    )
    .await
}

#[tauri::command]
pub(crate) async fn content_material_set_tags(
    state: State<'_, SharedState>,
    instance: String,
    library: Option<String>,
    asset_id: String,
    set: Option<Vec<String>>,
    add: Option<Vec<String>>,
    remove: Option<Vec<String>>,
) -> Result<Value, String> {
    if !valid_id(&asset_id) {
        return Err("CONTENT_INPUT_INVALID".into());
    }
    for tag in set.iter().chain(add.iter()).chain(remove.iter()).flatten() {
        if !valid_id(tag) {
            return Err("CONTENT_INPUT_INVALID".into());
        }
    }
    let mut payload = serde_json::Map::new();
    payload.insert("desktopAssetId".into(), serde_json::json!(asset_id));
    if let Some(set) = set {
        payload.insert("set".into(), serde_json::json!(set));
    }
    if let Some(add) = add {
        payload.insert("add".into(), serde_json::json!(add));
    }
    if let Some(remove) = remove {
        payload.insert("remove".into(), serde_json::json!(remove));
    }
    send(
        &state,
        &instance,
        library.as_deref(),
        "materialTags",
        format!("/v1/assets/{}/tags", encode(&asset_id)),
        reqwest::Method::PATCH,
        Value::Object(payload),
    )
    .await
}

#[tauri::command]
pub(crate) async fn content_material_set_folder(
    state: State<'_, SharedState>,
    instance: String,
    library: Option<String>,
    asset_id: String,
    folder_id: Option<String>,
) -> Result<Value, String> {
    if !valid_id(&asset_id) {
        return Err("CONTENT_INPUT_INVALID".into());
    }
    if let Some(folder) = folder_id.as_deref() {
        if !valid_id(folder) {
            return Err("CONTENT_INPUT_INVALID".into());
        }
    }
    // Explicit null is meaningful: it returns the asset to ROOT.
    let payload = serde_json::json!({ "desktopAssetId": asset_id, "folderId": folder_id });
    send(
        &state,
        &instance,
        library.as_deref(),
        "materialFolders",
        format!("/v1/assets/{}/folder", encode(&asset_id)),
        reqwest::Method::PATCH,
        payload,
    )
    .await
}

#[tauri::command]
pub(crate) async fn content_material_create_tag(
    state: State<'_, SharedState>,
    instance: String,
    library: Option<String>,
    name: String,
    color: Option<String>,
) -> Result<Value, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 || control_chars(name) {
        return Err("CONTENT_INPUT_INVALID".into());
    }
    if let Some(color) = color.as_deref() {
        if color.len() > 32 || control_chars(color) {
            return Err("CONTENT_INPUT_INVALID".into());
        }
    }
    let payload = serde_json::json!({ "name": name, "color": color });
    send(&state, &instance, library.as_deref(), "materialTags", "/v1/assets/tags".into(), reqwest::Method::POST, payload)
        .await
}

#[tauri::command]
pub(crate) async fn content_material_create_folder(
    state: State<'_, SharedState>,
    instance: String,
    library: Option<String>,
    name: String,
    parent_id: Option<String>,
) -> Result<Value, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 120 || control_chars(name) {
        return Err("CONTENT_INPUT_INVALID".into());
    }
    if let Some(parent) = parent_id.as_deref() {
        if !valid_id(parent) {
            return Err("CONTENT_INPUT_INVALID".into());
        }
    }
    let payload = serde_json::json!({ "name": name, "parentId": parent_id });
    send(&state, &instance, library.as_deref(), "materialFolders", "/v1/assets/folders".into(), reqwest::Method::POST, payload)
        .await
}

#[tauri::command]
pub(crate) async fn content_material_batch(
    state: State<'_, SharedState>,
    instance: String,
    library: Option<String>,
    asset_ids: Vec<String>,
    favorited: Option<bool>,
    add: Option<Vec<String>>,
    remove: Option<Vec<String>>,
    // Explicit presence signal: only a folder action sets this, so an
    // unrelated batch never carries a folderId.
    folder_change: bool,
    folder_id: Option<String>,
) -> Result<Value, String> {
    if folder_change && folder_id.is_some() && !valid_id(folder_id.as_deref().unwrap_or("")) {
        return Err("CONTENT_INPUT_INVALID".into());
    }
    if asset_ids.is_empty() || asset_ids.len() > MAX_BATCH {
        return Err("CONTENT_BATCH_TOO_LARGE".into());
    }
    if asset_ids.iter().any(|id| !valid_id(id)) {
        return Err("CONTENT_INPUT_INVALID".into());
    }
    for tag in add.iter().chain(remove.iter()).flatten() {
        if !valid_id(tag) {
            return Err("CONTENT_INPUT_INVALID".into());
        }
    }
    let mut payload = serde_json::Map::new();
    payload.insert("desktopAssetIds".into(), serde_json::json!(asset_ids));
    if let Some(favorited) = favorited {
        payload.insert("favorited".into(), serde_json::json!(favorited));
    }
    if let Some(add) = add {
        payload.insert("add".into(), serde_json::json!(add));
    }
    if let Some(remove) = remove {
        payload.insert("remove".into(), serde_json::json!(remove));
    }
    // Tri-state: omitted = leave the folder unchanged; null = move to root;
    // string = move into that folder.
    if folder_change {
        payload.insert("folderId".into(), serde_json::json!(folder_id));
    }
    send(
        &state,
        &instance,
        library.as_deref(),
        "materialBatch",
        "/v1/assets/favorite-batch".into(),
        reqwest::Method::POST,
        Value::Object(payload),
    )
    .await
}
