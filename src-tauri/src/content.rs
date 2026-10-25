//! Authorized content commands, isolated from legacy capture/AI synchronization.
use crate::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{atomic::AtomicBool, OnceLock};
use tauri::Manager;
use tokio::io::AsyncWriteExt;
pub(crate) mod materials;
pub(crate) mod notes;
mod media;
mod scope_probe;

pub(crate) fn retire_protocol_proof(key: &str) { scope_probe::retire(key); }

// Independent from pairing: selecting a saved library invalidates all old
// content work without disconnecting the Desktop or changing its active UI.
static CONTENT_SCOPE_EPOCHS: OnceLock<Mutex<HashMap<String, (u64, u64)>>> = OnceLock::new();
fn scope_epochs(instance: &str) -> Result<(u64, u64), String> {
    Ok(*CONTENT_SCOPE_EPOCHS.get_or_init(Default::default).lock().map_err(|_| "CONTENT_UNAVAILABLE")?.get(instance).unwrap_or(&(0, 0)))
}

pub(crate) fn material_cache_owner(instance: &str, library: Option<&str>) -> String {
    match library {
        None => instance.to_owned(), // Existing default-library rows stay intact.
        Some(library) => format!("material-scope-{:x}", Sha256::digest(serde_json::to_vec(&json!([instance, library])).unwrap())),
    }
}

#[tauri::command]
pub(crate) async fn content_scope_changed(instance: String, kind: String) -> Result<(), String> {
    public_id(&instance)?;
    if !matches!(kind.as_str(), "material" | "materials" | "knowledge") { return Err("CONTENT_SCOPE_INVALID".into()); }
    {
        let mut epochs = CONTENT_SCOPE_EPOCHS.get_or_init(Default::default).lock().map_err(|_| "CONTENT_UNAVAILABLE")?;
        let pair = epochs.entry(instance).or_default();
        if kind == "knowledge" { pair.1 = pair.1.wrapping_add(1); } else { pair.0 = pair.0.wrapping_add(1); }
    }
    crate::services_hints::retire_managed();
    // Downloads check their captured domain epoch; local-owned media is untouched.
    media::prune_retired().await;
    Ok(())
}

#[tauri::command]
pub(crate) async fn content_library_catalog(state: State<'_, SharedState>, instance: String) -> Result<Value, String> {
    let source = Source::capture_expected(&state, &instance)?;
    let (status, value) = scope_probe::read_with_retry(|| source.check(&state),
        || source.gateway.unscoped_get("/v1/services/libraries")).await?;
    source.check(&state)?;
    scope_probe::observe(source.scope_protocol_key()?, &source.lifecycle.epoch, source.epoch, status, &value);
    library_catalog_response(status, value)
}

fn legacy_vault_matches(requested: Option<&str>, catalog: &Value) -> bool {
    requested.is_some_and(|requested| catalog["items"].as_array()
        .and_then(|items| items.first()).and_then(|row| row["vaultId"].as_str()) == Some(requested))
}

fn legacy_scope_catalog(status: u16, value: &Value) -> bool {
    status == 404 || (status == 200 && value["scopeSelectionVersion"] == 0
        && value["mode"] == "legacyDefaultOnly" && value["authorizationMode"] == "legacy")
}

fn library_catalog_response(status: u16, value: Value) -> Result<Value, String> {
    // Only a proven missing endpoint permits the old default-only contract.
    // Transport/auth/server failures never silently choose another library.
    if legacy_scope_catalog(status, &value) {
        return Ok(json!({"scopeSelectionVersion":0,"materials":[],"knowledge":[]}));
    }
    if status != 200 { return Err(format!("CONTENT_HTTP_{status}")); }
    if value["scopeSelectionVersion"] != 1 { return Err("CONTENT_UPGRADE_REQUIRED".into()); }
    Ok(value)
}

#[tauri::command]
pub(crate) async fn content_media_source(state: State<'_, SharedState>, app: tauri::AppHandle, instance: String, library: Option<String>, id: String, vault: Option<String>, note: Option<String>) -> Result<Value,String> {
    let source = Source::capture_expected(&state,&instance)?.scoped(library.as_deref(),vault.as_deref())?;
    if vault.is_none() && note.is_none() {material_access_check(&state,&source.cache_owner(),&id)?;}
    let cached=cached_resource(&state,app.clone(),instance,library,id,vault,note).await?;
    let path=std::path::PathBuf::from(cached["path"].as_str().ok_or("CONTENT_NOT_CACHED")?);
    let root=app.path().app_cache_dir().map_err(|_| "CONTENT_NOT_CACHED")?.join("content-resources").canonicalize().map_err(|_| "CONTENT_NOT_CACHED")?;
    let path=path.canonicalize().map_err(|_| "CONTENT_NOT_CACHED")?;
    if path.parent()!=Some(root.as_path()) { return Err("CONTENT_NOT_CACHED".into()); }
    source.check(&state)?;
    media::issue_scoped(path,cached["mime"].as_str().ok_or("CONTENT_NOT_CACHED")?.to_string(), source, state.inner().clone()).await
}

#[tauri::command]
pub(crate) async fn content_media_release(token: String) { media::release(&token).await; }

/// A live paired asset, not a generic URL proxy and not a complete offline save.
#[tauri::command]
pub(crate) async fn content_media_stream(state: State<'_, SharedState>, instance: String, library: Option<String>, id: String, job_id: String) -> Result<Value, String> {
    public_id(&id)?; public_id(&job_id)?;
    let source = Source::capture_expected(&state, &instance)?.scoped(library.as_deref(), None)?;
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut jobs = DOWNLOADS.get_or_init(Default::default).lock().map_err(|_| "MEDIA_BUSY")?;
        if jobs.contains_key(&job_id) || jobs.len() >= 128 { return Err("MEDIA_BUSY".into()); }
        jobs.insert(job_id.clone(), cancelled.clone());
    }
    let _job = DownloadJob {id: job_id, cancelled: cancelled.clone()};
    cancellable(source.capabilities(&state, "materialPreview"), &|| {
        if cancelled.load(Ordering::Acquire) {return Err("CONTENT_CANCELLED".into());} source.check(&state)
    }).await??;
    media::issue_stream(source, state.inner().clone(), id, cancelled).await
}

#[tauri::command]
pub(crate) async fn content_media_status(token: String) -> Result<Value, String> { media::snapshot(&token).await }

/// Choose this owner's COMPLETE cache, otherwise the exact paired Range
/// source. No generic URL/path or full-file/hash prerequisite for watching.
#[tauri::command]
pub(crate) async fn content_video_play(state: State<'_, SharedState>, app: tauri::AppHandle,
    instance: String, library: Option<String>, id: String, job_id: String, title: String, start_position_ms: u64, dark_mode: Option<bool>) -> Result<Value, String> {
    media::supported()?;
    public_id(&instance)?; public_id(&id)?; public_id(&job_id)?;
    Source::capture_expected(&state,&instance)?;
    material_access_check(&state,&material_cache_owner(&instance,library.as_deref()),&id)?;
    if title.len() > 4096 || start_position_ms > i64::MAX as u64 {return Err("CONTENT_ID_INVALID".into());}
    let started = std::time::Instant::now();
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut jobs = DOWNLOADS.get_or_init(Default::default).lock().map_err(|_| "MEDIA_BUSY")?;
        if jobs.contains_key(&job_id) || jobs.len() >= 128 {return Err("MEDIA_BUSY".into());}
        jobs.insert(job_id.clone(), cancelled.clone());
    }
    let _job = DownloadJob {id:job_id, cancelled:cancelled.clone()};
    let grant = match content_media_source(state.clone(), app, instance.clone(), library.clone(), id.clone(), None, None).await {
        Ok(grant) => grant,
        Err(code) if code == "CONTENT_NOT_CACHED" => {
            let source = Source::capture_expected(&state, &instance)?.scoped(library.as_deref(), None)?;
            cancellable(source.capabilities(&state, "materialPreview"), &|| {
                if cancelled.load(Ordering::Acquire) {return Err("CONTENT_CANCELLED".into());} source.check(&state)
            }).await??;
            media::issue_stream(source, state.inner().clone(), id, cancelled.clone()).await?
        },
        Err(code) => return Err(code),
    };
    media::play(grant, title, start_position_ms, dark_mode.unwrap_or(false), cancelled, started).await
}

/// Both inline and native playback accept only a DB-owned, healthy local asset.
fn local_video_source(state: &SharedState, asset_id: &str) -> Result<(std::path::PathBuf, String), String> {
    public_id(asset_id)?;
    let asset=with_db(state,|db|db.asset_get(&asset_id))?.ok_or("CONTENT_NOT_CACHED")?;
    if asset.kind!="video" || !asset.mime.starts_with("video/") {return Err("MEDIA_TYPE_UNSUPPORTED".into());}
    if local_asset::check_integrity(&asset.local_path,asset.size_bytes,&asset.content_hash,false)?.status!="healthy" {return Err("CONTENT_NOT_CACHED".into());}
    let source=std::path::PathBuf::from(&asset.local_path).canonicalize().map_err(|_|"CONTENT_NOT_CACHED")?;
    let root=local_asset::asset_root()?.join("originals").canonicalize().map_err(|_|"CONTENT_NOT_CACHED")?;
    if source.parent()!=Some(root.as_path()) || !source.file_name().and_then(|s|s.to_str()).is_some_and(|s|s.starts_with("asset-")) {return Err("CONTENT_NOT_CACHED".into());}
    Ok((source, asset.mime))
}

/// Range-capable inline playback without opening another native screen.
#[tauri::command]
pub(crate) async fn local_asset_media_source(state: State<'_, SharedState>, asset_id: String) -> Result<Value, String> {
    let (source, mime) = local_video_source(&state, &asset_id)?;
    media::issue(source, mime).await
}

/// Local-owned video uses the SAME private player and lease. JavaScript names
/// the DB asset, never a URL or private path; Desktop pairing is not consulted.
#[tauri::command]
pub(crate) async fn local_asset_video_play(state: State<'_, SharedState>, asset_id: String,
    job_id: String, title: String, start_position_ms: u64, dark_mode: Option<bool>) -> Result<Value,String> {
    media::supported()?;
    public_id(&asset_id)?; public_id(&job_id)?;
    if title.len()>4096 || start_position_ms>i64::MAX as u64 {return Err("CONTENT_ID_INVALID".into());}
    let (source, mime) = local_video_source(&state, &asset_id)?;
    let started=std::time::Instant::now();
    let cancelled=Arc::new(AtomicBool::new(false));
    {
        let mut jobs=DOWNLOADS.get_or_init(Default::default).lock().map_err(|_|"MEDIA_BUSY")?;
        if jobs.contains_key(&job_id) || jobs.len()>=128 {return Err("MEDIA_BUSY".into());}
        jobs.insert(job_id.clone(),cancelled.clone());
    }
    let _job=DownloadJob{id:job_id,cancelled:cancelled.clone()};
    let grant=media::issue(source,mime).await?;
    media::play(grant,title,start_position_ms,dark_mode.unwrap_or(false),cancelled,started).await
}

struct Source {
    instance: String,
    lifecycle: ConnectionLifecycle,
    epoch: u64,
    gateway: GatewayClient,
    scope_epochs: (u64, u64),
    scope_kind: &'static str,
    library: Option<String>,
    vault: Option<String>,
    scope_protocol_checked: tokio::sync::OnceCell<()>,
}

impl Source {
    fn scoped(mut self, library: Option<&str>, vault: Option<&str>) -> Result<Self, String> {
        self.gateway = self.gateway.scoped(library, vault)?;
        self.library = library.map(str::to_owned);
        self.vault = vault.map(str::to_owned);
        self.scope_kind = if library.is_some() && vault.is_some() { "all" } else if vault.is_some() { "knowledge" } else { "material" };
        Ok(self)
    }
    fn knowledge(mut self) -> Self { self.scope_kind = "knowledge"; self }
    fn scope_changed(&self) -> bool {
        let Ok(current) = scope_epochs(&self.instance) else { return true; };
        match self.scope_kind {
            "none" => false,
            "material" => current.0 != self.scope_epochs.0,
            "knowledge" => current.1 != self.scope_epochs.1,
            _ => current != self.scope_epochs,
        }
    }
    fn cache_owner(&self) -> String { material_cache_owner(&self.instance, self.library.as_deref()) }

    fn with_db<T>(
        &self,
        state: &SharedState,
        action: impl FnOnce(&mut Db) -> Result<T, String>,
    ) -> Result<T, String> {
        let g = state.lock().map_err(|_| "CONTENT_UNAVAILABLE")?;
        if self.scope_changed()
            || g.connection_lifecycle.observe() != self.epoch
            || g.conn_intent.get() != ConnectionIntent::Auto
        {
            return Err("CONTENT_SOURCE_CHANGED".into());
        }
        let mut db = g.db.lock().map_err(|_| "CONTENT_UNAVAILABLE")?;
        if db.paired()?.is_none_or(|p| p.instance_id != self.instance) {
            return Err("CONTENT_SOURCE_CHANGED".into());
        }
        action(&mut db)
    }
    pub(crate) fn capture(state: &SharedState) -> Result<Self, String> {
        let (lifecycle, _) = connection_controls(state);
        let epoch = lifecycle.observe();
        if current_conn_intent(state) != ConnectionIntent::Auto {
            return Err("CONTENT_DISCONNECTED".into());
        }
        let (paired, gateway) = require_paired(state)?;
        if lifecycle.observe() != epoch {
            return Err("CONTENT_SOURCE_CHANGED".into());
        }
        let epochs = scope_epochs(&paired.instance_id)?;
        Ok(Self {
            instance: paired.instance_id,
            lifecycle,
            epoch,
            gateway,
            scope_epochs: epochs,
            scope_kind: "all",
            library: None,
            vault: None,
            scope_protocol_checked: tokio::sync::OnceCell::new(),
        })
    }

    pub(crate) fn check(&self, state: &SharedState) -> Result<(), String> {
        if self.scope_changed()
            || self.lifecycle.observe() != self.epoch
            || current_conn_intent(state) != ConnectionIntent::Auto
        {
            return Err("CONTENT_SOURCE_CHANGED".into());
        }
        Ok(())
    }

    /// Capture the live source and prove it is the Desktop the caller named.
    /// `capture` already snapshots the paired instance, so this is the single
    /// place a READ is bound to an EXPECTED owner instead of whatever happens
    /// to be paired right now. A mismatch never reaches the wire.
    pub(crate) fn capture_expected(state: &SharedState, expected: &str) -> Result<Self, String> {
        if expected.is_empty() {
            return Err("CONTENT_SOURCE_CHANGED".into());
        }
        let source = Self::capture(state)?;
        if source.instance != expected {
            return Err("CONTENT_SOURCE_CHANGED".into());
        }
        Ok(source)
    }

    /// Re-prove this captured source is still the live owner, comparing the
    /// instance recorded at capture time rather than the caller's expectation.
    /// Used to fence a request that is already bound to a captured gateway.
    pub(crate) fn verify_owner(&self, state: &SharedState) -> Result<(), String> {
        self.check(state)?;
        let live = Self::capture(state)?;
        if live.instance != self.instance {
            return Err("CONTENT_SOURCE_CHANGED".into());
        }
        Ok(())
    }

    fn scope_protocol_key(&self) -> Result<String, String> {
        Ok(scope_probe::proof_key(Arc::as_ptr(&self.lifecycle.epoch) as usize,
            self.epoch, &self.instance, self.gateway.base_url(),
            self.gateway.fingerprint(), self.gateway.token()))
    }

    async fn ensure_scope_protocol(&self, state: &SharedState) -> Result<(), String> {
        self.check(state)?;
        // Local OnceCell marks retry policy only; it must not bypass a shared
        // proof invalidated by a newer catalog, transport, or protocol response.
        self.negotiate_scope_protocol(state, false).await?;
        let _ = self.scope_protocol_checked.set(());
        self.check(state)
    }

    async fn negotiate_scope_protocol(&self, state: &SharedState, fresh: bool) -> Result<(), String> {
        if self.library.is_none() && self.vault.is_none() { return Ok(()); }
        self.check(state)?;
        // This caches protocol VERSION only, not a catalog or grant. Current
        // scope headers and the server's authorization still apply on every read.
        let key = self.scope_protocol_key()?;
        let read = || async {
            self.check(state)?;
            scope_probe::read_with_retry(|| self.check(state),
                || self.gateway.unscoped_get("/v1/services/libraries")).await
        };
        // A mutation independently negotiates immediately before its send.
        // It never joins a cached/pending read proof, and is fenced after await.
        let result = if fresh { read().await }
            else { scope_probe::discover(key.clone(), &self.lifecycle.epoch, self.epoch, read).await };
        let (status, catalog) = match result { Ok(value) => value, Err(error) => {scope_probe::retire(&key);return Err(error);} };
        self.check(state)?;
        if fresh { scope_probe::observe(key.clone(), &self.lifecycle.epoch, self.epoch, status, &catalog); }
        if status == 200 && catalog["scopeSelectionVersion"] == 1 {
            self.gateway.set_legacy_knowledge(false);
            self.gateway.set_scope_proof(key, catalog["reusableProofVersion"] == 1);
            return Ok(());
        }
        if legacy_scope_catalog(status, &catalog) && self.library.is_none() {
            let (current_status, current) = self.gateway.unscoped_get("/v1/vaults").await?;
            self.check(state)?;
            if current_status == 200 && legacy_vault_matches(self.vault.as_deref(), &current) {
                self.gateway.set_legacy_knowledge(true);
                self.gateway.set_scope_proof(key, false);
                return Ok(());
            }
        }
        if matches!(catalog["code"].as_str(), Some("SCOPE_UNAVAILABLE" | "SCOPE_MISMATCH")) {
            return Err(catalog["code"].as_str().unwrap().into());
        }
        if status != 200 && status != 404 { return Err(format!("CONTENT_HTTP_{status}")); }
        Err("CONTENT_UPGRADE_REQUIRED".into())
    }

    async fn prepare_mutation(&self, state: &SharedState) -> Result<(), String> {
        self.check(state)?;
        self.negotiate_scope_protocol(state, true).await?;
        self.check(state)
    }

    async fn mutate(&self, state: &SharedState, path: &str, method: reqwest::Method, body: &Value) -> Result<(u16, Value), String> {
        self.prepare_mutation(state).await?;
        let result = self.gateway.content_mutate(path, method, body).await;
        self.check(state)?;
        result
    }

    fn scoped_v1_proven(&self) -> bool {
        (self.library.is_some() || self.vault.is_some())
            && self.scope_protocol_checked.get().is_some()
            && !self.gateway.legacy_knowledge()
    }

    async fn metadata_request(&self, state: &SharedState, path: &str) -> Result<(u16, Value), String> {
        self.check(state)?;
        let read = || self.gateway.content_request(reqwest::Method::GET, path, None);
        let result = if self.scoped_v1_proven() {
            scope_probe::read_metadata_with_retry(|| self.check(state), read).await
        } else { read().await };
        self.check(state)?;
        result
    }

    async fn metadata_get(&self, state: &SharedState, path: &str) -> Result<Value, String> {
        let (status, body) = self.metadata_request(state, path).await?;
        if !(200..300).contains(&status) { return Err(format!("content {}", companion_error_note(status, &body))); }
        Ok(body)
    }

    pub(crate) async fn capabilities(&self, state: &SharedState, capability: &str) -> Result<Value, String> {
        self.ensure_scope_protocol(state).await?;
        let value = self.metadata_get(state, "/v1/capabilities").await?;
        self.check(state)?;
        if self.library.is_some() && value["scopeSelectionVersion"] != 1 {
            scope_probe::observe(self.scope_protocol_key()?, &self.lifecycle.epoch, self.epoch, 200, &value);
            return Err("CONTENT_UPGRADE_REQUIRED".into());
        }
        if value["contentVersion"] != 1 || value["capabilities"][capability] != true {
            return Err("CONTENT_UPGRADE_REQUIRED".into());
        }
        Ok(value)
    }
}

/// Prove the live Desktop is the one the caller named, from outside this
/// module (the thumbnail cache lives in `lib.rs`). Fails closed with
/// `CONTENT_SOURCE_CHANGED` when the connection has moved on.
pub(crate) fn require_expected_source(state: &SharedState, expected: &str) -> Result<(), String> {
    Source::capture_expected(state, expected).map(|_| ())
}

/// The owner-bound thumbnail state: the Desktop a thumbnail belongs to, plus
/// the ONE gateway captured for it.
///
/// Retaining the captured source is the whole point. Validating the owner and
/// then handing the work to whichever gateway happens to be live would let an
/// A->B switch send A's asset id to B — the wrong-source request would already
/// be on the wire. Here the gateway and the owner are the same capture.
pub(crate) struct ExpectedThumbnailSource {
    source: Source,
}

impl ExpectedThumbnailSource {
    /// The Desktop this thumbnail belongs to (also the cache key).
    pub(crate) fn instance(&self) -> &str {
        &self.source.instance
    }

    pub(crate) fn cache_owner(&self) -> String { self.source.cache_owner() }

    /// Fetch through the gateway captured for THIS owner. If the connection
    /// moved on between the capture and this call, the request is refused
    /// before it is sent, so it can never reach the new Desktop.
    pub(crate) async fn fetch(
        &self,
        state: &SharedState,
        id: &str,
        etag: Option<&str>,
    ) -> Result<(Vec<u8>, String, String), String> {
        // Refuse BEFORE the request if the owner already moved.
        self.source.verify_owner(state)?;
        self.source.capabilities(state, "materialPreview").await?;
        let value = self.source.gateway.fetch_thumbnail(id, etag).await?;
        // And again before the caller may act on the bytes.
        self.source.verify_owner(state)?;
        Ok(value)
    }

    /// Re-prove the owner still holds before the result is committed.
    pub(crate) fn verify(&self, state: &SharedState) -> Result<(), String> {
        self.source.check(state)?;
        self.source.verify_owner(state)
    }
}

/// Capture the expected owner once and keep its gateway for the whole
/// thumbnail operation.
pub(crate) fn expected_thumbnail_source(
    state: &SharedState,
    expected: &str,
    library: Option<&str>,
) -> Result<ExpectedThumbnailSource, String> {
    Ok(ExpectedThumbnailSource {
        source: Source::capture_expected(state, expected)?.scoped(library, None)?,
    })
}
/// One retained capture for an expected-owner gateway operation (Issue #72,
/// LSH remote surface). Same principle as the thumbnail source: the pinned
/// gateway and the owner are ONE capture, so an A->B switch can never make a
/// request to B in the name of A.
pub(crate) struct ExpectedGateway {
    source: Source,
}

impl ExpectedGateway {
    /// Apply a response under the exact captured source fence and DB lock.
    pub(crate) fn with_db<T>(&self,state:&SharedState,f:impl FnOnce(&mut Db)->Result<T,String>)->Result<T,String>{self.source.with_db(state,f)}

    pub(crate) fn instance(&self) -> &str {
        &self.source.instance
    }

    /// The paired Desktop LAN authority this gateway speaks to (the
    /// carrier's upstream resolve target).
    pub(crate) fn paired_base(&self) -> &str {
        self.source.gateway.base_url()
    }

    /// The pinned certificate fingerprint of this authority.
    pub(crate) fn pinned_fingerprint(&self) -> &str {
        self.source.gateway.fingerprint()
    }

    /// Authenticated hello through the pinned gateway captured for THIS owner,
    /// re-proving the owner before and after the request.
    pub(crate) async fn hello(&self, state: &SharedState) -> Result<Value, String> {
        self.source.verify_owner(state)?;
        let value = self.source.gateway.hello().await?;
        self.source.verify_owner(state)?;
        Ok(value)
    }

    /// Authenticated Bearer GET through the pinned gateway captured for THIS
    /// owner, re-proving the owner before and after the request.
    pub(crate) async fn content_get(&self, state: &SharedState, path: &str) -> Result<Value, String> {
        self.source.verify_owner(state)?;
        let value = self.source.gateway.content_get(path).await?;
        self.source.verify_owner(state)?;
        Ok(value)
    }

    /// The pinned wss:// URL for the Services hint stream. Built from the
    /// CAPTURED gateway (never the caller), so a wrong Desktop cannot influence
    /// the target.
    pub(crate) fn services_hint_url(&self) -> String {
        let ws = self.source.gateway.ws_url(); // wss://<host><base>/v1/events
        match ws.strip_suffix("/v1/events") {
            Some(prefix) => format!("{prefix}/v1/services/events/stream"),
            None => ws,
        }
    }

    /// The NON-URL bearer for the captured gateway. Only ever placed in the
    /// Authorization header by the Rust worker.
    pub(crate) fn ws_authorization(&self) -> String {
        self.source.gateway.ws_authorization()
    }

    /// G1E test seam: run `body` BETWEEN the two production fences.
    ///
    /// The production `services_request*` methods are literally this shape
    /// (`services_connection_current` -> await -> `services_connection_current`),
    /// so driving them through this helper exercises the real fence rather than
    /// a copy of it. Test-only; nothing in production calls this.
    #[cfg(test)]
    pub(crate) async fn run_between_fences<F, Fut, T>(
        &self,
        state: &SharedState,
        body: F,
    ) -> Result<T, String>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<T, String>>,
    {
        self.services_connection_current(state)?;
        let value = body().await?;
        self.services_connection_current(state)?;
        Ok(value)
    }

    /// G1-N: prove the CAPTURED Services connection is still current.
    ///
    /// `verify_owner` only compares the Desktop instance, so a disconnect and
    /// reconnect to the SAME Desktop yields a new connection epoch that it
    /// cannot see. `Source::check` compares the epoch captured with this
    /// gateway plus the connection intent, which is exactly the fence the
    /// Services request paths need before the send and after the await.
    ///
    /// Scope discipline: this is a Services-specific proof. `verify_owner` and
    /// the Content V1 / thumbnail / LSH semantics are untouched.
    fn services_connection_current(&self, state: &SharedState) -> Result<(), String> {
        // Captured owner must still be the requested Desktop…
        self.source.verify_owner(state)?;
        // …AND the captured connection epoch must still be live with Auto intent.
        self.source.check(state)
    }

    pub(crate) fn wire_vault(&self, vault: Option<String>) -> Option<String> {
        if self.source.gateway.legacy_knowledge() { None } else { vault }
    }

    pub(crate) async fn require_scope_protocol(&self, state: &SharedState) -> Result<(), String> {
        self.source.ensure_scope_protocol(state).await
    }

    /// One canonical Services V1 JSON request through the pinned gateway
    /// captured for THIS owner, re-proving the owner BEFORE the send and AFTER
    /// the awaited response (Issue #77 §2).
    ///
    /// The canonical HTTP status is returned alongside the body so a non-2xx
    /// (409/410/426/503 ...) reaches TS as a value, not as a transport error.
    pub(crate) async fn services_request(
        &self,
        state: &SharedState,
        method: &str,
        path: &str,
        has_body: bool,
        body: &Value,
    ) -> Result<(u16, Value), String> {
        self.services_connection_current(state)?;
        self.require_scope_protocol(state).await?;
        let http_method = match method {
            "GET" => reqwest::Method::GET,
            "POST" => reqwest::Method::POST,
            "PATCH" => reqwest::Method::PATCH,
            "PUT" => reqwest::Method::PUT,
            "DELETE" => reqwest::Method::DELETE,
            _ => return Err("SERVICES_METHOD_INVALID".into()),
        };
        // Only GET metadata is retryable, and only after this exact source
        // proved version-1 scope selection. Mutations keep one send.
        let result = if http_method == reqwest::Method::GET {
            self.source.metadata_request(state, path).await?
        } else {
            self.source.prepare_mutation(state).await?;
            self.source.gateway.content_request(http_method, path, None).await?
        };
        let _ = has_body;
        let _ = body;
        self.services_connection_current(state)?;
        Ok(result)
    }

    /// One canonical Services V1 request WITH a JSON body (mutations).
    pub(crate) async fn services_request_json(
        &self,
        state: &SharedState,
        method: &str,
        path: &str,
        body: &Value,
    ) -> Result<(u16, Value), String> {
        self.services_connection_current(state)?;
        self.require_scope_protocol(state).await?;
        let http_method = match method {
            "POST" => reqwest::Method::POST,
            "PATCH" => reqwest::Method::PATCH,
            "PUT" => reqwest::Method::PUT,
            "DELETE" => reqwest::Method::DELETE,
            _ => return Err("SERVICES_METHOD_INVALID".into()),
        };
        let result = self.source.mutate(state, path, http_method, body).await?;
        self.services_connection_current(state)?;
        Ok(result)
    }

    /// One canonical Services V1 RAW CHUNK request (bounded bytes + headers).
    /// Same before/after owner proof as the JSON paths.
    pub(crate) async fn services_request_with_chunk(
        &self,
        state: &SharedState,
        method: &str,
        path: &str,
        bytes: &[u8],
        headers: &[(String, String)],
    ) -> Result<(u16, Value), String> {
        self.services_connection_current(state)?;
        self.require_scope_protocol(state).await?;
        let http_method = match method {
            "PUT" => reqwest::Method::PUT,
            "POST" => reqwest::Method::POST,
            _ => return Err("SERVICES_METHOD_INVALID".into()),
        };
        self.source.prepare_mutation(state).await?;
        let result = self
            .source
            .gateway
            .content_request(http_method, path, Some((bytes, headers)))
            .await?;
        self.services_connection_current(state)?;
        Ok(result)
    }

    /// Authenticated Bearer POST through the pinned gateway captured for THIS
    /// owner, re-proving the owner before and after the request.
    pub(crate) async fn lsh_session_mint(&self, state: &SharedState) -> Result<(u16, Value), String> {
        self.source.verify_owner(state)?;
        let result = self
            .source
            .gateway
            .content_mutate("/v1/lsh/remote/session", reqwest::Method::POST, &serde_json::json!({}))
            .await?;
        self.source.verify_owner(state)?;
        Ok(result)
    }
}

/// Capture the expected owner once and keep its pinned gateway.
pub(crate) fn expected_gateway(
    state: &SharedState,
    expected: &str,
) -> Result<ExpectedGateway, String> {
    let mut source = Source::capture_expected(state, expected)?;
    source.scope_kind = "none";
    Ok(ExpectedGateway { source })
}

pub(crate) fn expected_scoped_gateway(state: &SharedState, expected: &str, library: Option<&str>, vault: Option<&str>) -> Result<ExpectedGateway, String> {
    Ok(ExpectedGateway { source: Source::capture_expected(state, expected)?.scoped(library, vault)? })
}

fn public_id(id: &str) -> Result<(), String> {    if id.is_empty()
        || id.len() > 160
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        Err("CONTENT_ID_INVALID".into())
    } else {
        Ok(())
    }
}

fn encode(s: &str) -> String {
    s.bytes()
        .map(|c| {
            if c.is_ascii_alphanumeric() || b"-._~".contains(&c) {
                (c as char).to_string()
            } else {
                format!("%{c:02X}")
            }
        })
        .collect()
}

async fn cached_material_get(state: &SharedState, path: &str) -> Result<Value, String> {
    let paired = with_db(state, |db| db.paired())?.ok_or("CONTENT_DISCONNECTED")?;
    let result = async {
        let source = Source::capture(state)?;
        source.capabilities(state, "materialPreview").await?;
        let value = source.metadata_get(state, path).await?;
        if let Some(items) = value["items"].as_array() {
            cache_assets(state, &source, items)?;
        } else if value.get("desktopAssetId").is_some() {
            cache_assets(state, &source, std::slice::from_ref(&value))?;
        }
        source.with_db(state, |db| {
            db.content_cache_response(&source.cache_owner(), path, &value)
        })?;
        // Provenance is decided where the answer came from, never inferred
        // later from Promise status.
        let mut value = value;
        value["source"] = json!("live");
        Ok::<Value, String>(value)
    }
    .await;
    match result {
        Err(e) if e == "CONTENT_OFFLINE" || e == "CONTENT_DISCONNECTED" => with_db(state, |db| {
            if db
                .paired()?
                .is_none_or(|p| p.instance_id != paired.instance_id)
            {
                return Err("CONTENT_SOURCE_CHANGED".into());
            }
            let mut cached = db.content_cached_response(&paired.instance_id, path)?;
            cached["source"] = json!("cache");
            Ok(cached)
        }),
        other => other,
    }
}

/// A material read that must belong to ONE named Desktop.
///
/// The whole point is the ordering: the expected owner is proven to still be
/// the live source BEFORE a request is issued or a cache entry is consulted.
/// If the connection has already moved to another Desktop, this fails closed —
/// it never reaches the new Desktop and never serves that Desktop's cache as
/// if it were the requested one. Only when the expected owner is still paired
/// (but currently offline/disconnected) may this Desktop's own cached response
/// be used.
async fn cached_material_get_expected(
    state: &SharedState,
    expected_instance: &str,
    library: Option<&str>,
    path: &str,
) -> Result<Value, String> {
    let guard=Source::capture_expected(state, expected_instance)?.scoped(library, None)?;
    let result = async {
        let source = Source::capture_expected(state, expected_instance)?.scoped(library, None)?;
        source.capabilities(state, "materialPreview").await?;
        // The identity must still hold across the awaited capability probe.
        source.check(state)?;
        let value = source.metadata_get(state, path).await?;
        if let Some(items) = value["items"].as_array() {
            cache_assets(state, &source, items)?;
        } else if value.get("desktopAssetId").is_some() {
            cache_assets(state, &source, std::slice::from_ref(&value))?;
        }
        source.with_db(state, |db| {
            db.content_cache_response(&source.cache_owner(), path, &value)
        })?;
        let mut value = value;
        value["source"] = json!("live");
        Ok::<Value, String>(value)
    }
    .await;
    match result {
        Err(e) if e == "CONTENT_OFFLINE" || e == "CONTENT_DISCONNECTED" => guard.with_db(state, |db| {
            // The cache fallback is keyed by the EXPECTED owner, and only
            // reaches here while that owner is still the paired Desktop.
            match db.paired()? {
                Some(p) if p.instance_id == expected_instance => {}
                _ => return Err("CONTENT_SOURCE_CHANGED".into()),
            }
            let mut cached = db.content_cached_response(&guard.cache_owner(), path)?;
            if let Some(error)=cached["_mobileAccessError"].as_str() {return Err(error.into());}
            cached["source"] = json!("cache");
            Ok(cached)
        }),
        Err(error) if material_denial_code(&error).is_some() => {
            let code=material_denial_code(&error).unwrap();
            // Same existing response-cache row: a confirmed denial replaces
            // positive offline metadata, never deletes the user's originals.
            guard.with_db(state,|db|db.content_cache_response(&guard.cache_owner(),path,&json!({"_mobileAccessError":code})))?;
            Err(code.into())
        },
        other => other,
    }
}

fn material_denial_code(error:&str)->Option<&'static str> {
    if error.contains("SCOPE_UNAVAILABLE") { return Some("SCOPE_UNAVAILABLE"); }
    if error.contains("SCOPE_MISMATCH") { return Some("SCOPE_MISMATCH"); }
    if matches!(error, "CONTENT_HTTP_401" | "CONTENT_HTTP_403" | "CONTENT_HTTP_404" | "CONTENT_HTTP_410") {
        return match error { "CONTENT_HTTP_401" => Some("CONTENT_HTTP_401"), "CONTENT_HTTP_403" => Some("CONTENT_HTTP_403"), "CONTENT_HTTP_404" => Some("CONTENT_HTTP_404"), _ => Some("CONTENT_HTTP_410") };
    }
    [("http 401 ","CONTENT_HTTP_401"),("http 403 ","CONTENT_HTTP_403"),("http 404 ","CONTENT_HTTP_404"),("http 410 ","CONTENT_HTTP_410")]
        .into_iter().find(|(wire,_)|error.contains(wire)).map(|(_,code)|code)
}

pub(crate) fn material_access_check(state:&SharedState,instance:&str,id:&str)->Result<(),String> {
    let value=with_db(state,|db|db.content_cached_response(instance,&format!("/v1/assets/{id}")));
    if let Ok(value)=value {if let Some(error)=value["_mobileAccessError"].as_str(){return Err(error.into());}}
    Ok(())
}

#[tauri::command]
pub(crate) async fn content_capabilities(state: State<'_, SharedState>) -> Result<Value, String> {
    let source = Source::capture(&state)?;
    let value = source.gateway.content_get("/v1/capabilities").await?;
    source.check(&state)?;
    Ok(value)
}

#[tauri::command]
pub(crate) async fn content_assets(
    state: State<'_, SharedState>,
    instance: String, library: Option<String>,
    page: u32,
    limit: u32,
    q: Option<String>,
    kind: Option<String>,
    folder: Option<String>,
    tag: Option<String>,
) -> Result<Value, String> {
    if page == 0 || page > 1_000_000 || limit == 0 || limit > 100 {
        return Err("CONTENT_PAGE_INVALID".into());
    }
    let mut path = format!("/v1/assets?page={page}&limit={limit}");
    for (key, value) in [("q", q), ("kind", kind), ("folder", folder), ("tag", tag)] {
        if let Some(value) = value.filter(|s| !s.is_empty()) {
            if value.len() > 4096 {
                return Err("CONTENT_QUERY_INVALID".into());
            }
            path.push_str(&format!("&{key}={}", encode(&value)));
        }
    }
    // Bound to the Desktop that produced the rows the caller is rendering —
    // never to whatever is paired when this happens to run.
    let value = cached_material_get_expected(&state, &instance, library.as_deref(), &path).await?;
    Ok(value)
}

fn cache_assets(state: &SharedState, source: &Source, items: &[Value]) -> Result<(), String> {
    source.check(state)?;
    // The state lock excludes pairing changes while validating and committing.
    let g = state.lock().map_err(|_| "CONTENT_UNAVAILABLE")?;
    if g.connection_lifecycle.observe() != source.epoch
        || g.conn_intent.get() != ConnectionIntent::Auto
    {
        return Err("CONTENT_SOURCE_CHANGED".into());
    }
    let mut db = g.db.lock().map_err(|_| "CONTENT_UNAVAILABLE")?;
    if db
        .paired()?
        .is_none_or(|p| p.instance_id != source.instance)
    {
        return Err("CONTENT_SOURCE_CHANGED".into());
    }
    for a in items {
        let text = |key: &str| a[key].as_str().unwrap_or("");
        public_id(text("desktopAssetId"))?;
        let tags = a["tags"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        db.upsert_asset(
            &source.cache_owner(),
            text("desktopAssetId"),
            text("name"),
            text("kind"),
            text("mimeType"),
            a["sizeBytes"].as_i64().unwrap_or(0),
            text("updatedAt"),
            text("contentHash"),
            text("thumbnailRevision"),
            text("folderId"),
            &tags,
        )?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn content_navigation(
    state: State<'_, SharedState>,
    instance: String, library: Option<String>,
) -> Result<Value, String> {
    cached_material_get_expected(&state, &instance, library.as_deref(), "/v1/assets/navigation").await
}

#[tauri::command]
pub(crate) async fn content_asset_detail(
    state: State<'_, SharedState>,
    instance: String, library: Option<String>,
    id: String,
) -> Result<Value, String> {
    public_id(&id)?;
    cached_material_get_expected(&state, &instance, library.as_deref(), &format!("/v1/assets/{id}")).await
}

static DOWNLOADS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
// Prevent competing resumptions of the same staging file. Other content reads remain independent.
static DOWNLOAD_GATE: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

#[tauri::command]
pub(crate) fn content_cancel(job_id: String) {
    if let Some(flag) = DOWNLOADS
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .get(&job_id)
    {
        flag.store(true, Ordering::Release);
    }
}

struct DownloadJob {
    id: String,
    cancelled: Arc<AtomicBool>,
}
impl Drop for DownloadJob {
    fn drop(&mut self) {
        DOWNLOADS
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .remove(&self.id);
    }
}

#[tauri::command]
pub(crate) async fn content_asset_file(
    state: State<'_, SharedState>,
    app: tauri::AppHandle,
    instance: String, library: Option<String>,
    id: String,
    job_id: String,
    max_bytes: Option<u64>,
    expected_version: Option<String>,
) -> Result<Value, String> {
    // Material downloads are owner-bound: the page names the Desktop it belongs
    // to and a moved connection fails closed.
    download_resource(state, app, &instance, library.as_deref(), id, job_id, None, max_bytes, expected_version).await
}

#[tauri::command]
pub(crate) async fn content_note_resource(
    state: State<'_, SharedState>,
    app: tauri::AppHandle,
    instance: String,
    vault: String,
    note: String,
    id: String,
    job_id: String,
) -> Result<Value, String> {
    public_id(&vault)?;
    public_id(&note)?;
    // The reader names its captured Desktop, just like the material reader.
    // A moved pairing must fail before any wire request or cache mutation.
    download_resource(state, app, &instance, None, id, job_id, Some((vault, note)), None, None).await
}

/// Both callers bind the Desktop their page belongs to, with no fallback to
/// whichever source happens to be paired now.
async fn download_resource(
    state: State<'_, SharedState>,
    app: tauri::AppHandle,
    expected_instance: &str,
    library: Option<&str>,
    id: String,
    job_id: String,
    note: Option<(String, String)>,
    max_bytes: Option<u64>,
    expected_version: Option<String>,
) -> Result<Value, String> {
    public_id(&id)?;
    public_id(&job_id)?;
    // The original file belongs to the Desktop the page was opened from. This
    // is proven before the download gate, so a connection that moved on can
    // never pull the new Desktop's file for an old Desktop's page.
    let source = Source::capture_expected(&state, expected_instance)?.scoped(library, note.as_ref().map(|n| n.0.as_str()))?;
    let resource_authority = source.with_db(&state, |db| db.content_resource_authority())?;
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut jobs = DOWNLOADS.get_or_init(Default::default).lock().unwrap();
        if jobs.contains_key(&job_id) || jobs.len() >= 128 {
            return Err("CONTENT_DOWNLOAD_BUSY".into());
        }
        jobs.insert(job_id.clone(), cancelled.clone());
    }
    let job = DownloadJob {
        id: job_id,
        cancelled,
    };
    let check = || -> Result<(), String> {
        source.check(&state)?;
        if job.cancelled.load(Ordering::Acquire) {
            Err("CONTENT_CANCELLED".into())
        } else {
            Ok(())
        }
    };
    let _gate = cancellable(
        DOWNLOAD_GATE
            .get_or_init(|| tokio::sync::Mutex::new(()))
            .lock(),
        &check,
    )
    .await?;
    check()?;
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|_| "CONTENT_CACHE_UNAVAILABLE")?
        .join("content-resources");
    tokio::fs::create_dir_all(&root)
        .await
        .map_err(|_| "CONTENT_CACHE_UNAVAILABLE")?;
    let domain = note
        .as_ref()
        .map(|(vault, note)| format!("note:{vault}:{note}"))
        .unwrap_or_else(|| "asset".into());
    let key = format!(
        "{:x}",
        Sha256::digest(format!("{}:{domain}:{id}", if note.is_none() { source.cache_owner() } else { source.instance.clone() }))
    );
    let part = root.join(format!("{key}.part"));
    let metadata_path = root.join(format!("{key}.part.json"));
    let metadata: Value = tokio::fs::read(&metadata_path)
        .await
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null);
    if metadata["resourceAuthority"].as_i64().unwrap_or(0) != resource_authority {
        // Only resumable staging bytes are discarded. Completed originals and
        // all note drafts remain on disk, but cannot be reused as new authority.
        let _ = tokio::fs::remove_file(&part).await;
        let _ = tokio::fs::remove_file(&metadata_path).await;
    }
    let etag = if metadata["resourceAuthority"].as_i64().unwrap_or(0) == resource_authority { metadata["etag"].as_str().unwrap_or("") } else { "" };
    let offset = tokio::fs::metadata(&part)
        .await
        .ok()
        .map(|m| m.len())
        .unwrap_or(0);
    cancellable(source.capabilities(&state, if note.is_some() { "noteRead" } else { "materialPreview" }), &check).await??;
    let route = note
        .as_ref()
        .map(|(vault, note)| format!("/v1/notes/{note}/resources/{id}?vault={}", encode(vault)))
        .unwrap_or_else(|| format!("/v1/assets/{id}/file"));
    let mut request = source
        .gateway
        .client_req()?
        .get(format!("{}{route}", source.gateway.base_url()))
        .bearer_auth(source.gateway.token());
    let cached = cached_resource(
        &state,
        app.clone(),
        source.instance.clone(),
        source.library.clone(),
        id.clone(),
        note.as_ref().map(|n| n.0.clone()),
        note.as_ref().map(|n| n.1.clone()),
    )
    .await
    .ok();
    // Only material originals get this additive stamp. Notes/knowledge are
    // untouched. The row was read before the conditional GET validates bytes.
    let asset_version = if note.is_none() {
        source.with_db(&state, |db| db.asset_version(&source.cache_owner(), &id))?
            .unwrap_or_default()
    } else {String::new()};
    if expected_version.as_ref().is_some_and(|v| v!=&asset_version) {return Err("CONTENT_VERSION_CHANGED".into());}
    if offset > 0 && !etag.is_empty() {
        request = request
            .header("Range", format!("bytes={offset}-"))
            .header("If-Range", etag);
    } else if let Some(etag) = cached.as_ref().and_then(|v| v["etag"].as_str()) {
        request = request.header("If-None-Match", etag);
    }
    let mut response = cancellable(request.send(), &check)
        .await?
        .map_err(|_| {source.gateway.retire_scope_proof(); "CONTENT_OFFLINE"})?;
    check()?;
    source.gateway.check_scope_response(&response)?;
    let status = response.status().as_u16();
    if status == 304 {
        if cached.is_some() && !asset_version.is_empty() {
            let path=root.join(format!("{key}.json"));
            let mut meta:Value=serde_json::from_slice(&tokio::fs::read(&path).await.map_err(|_|"CONTENT_NOT_CACHED")?).map_err(|_|"CONTENT_NOT_CACHED")?;
            meta["assetVersion"]=json!(asset_version);
            atomic_write(&path,&serde_json::to_vec(&meta).map_err(|_|"CONTENT_CACHE_UNAVAILABLE")?)?;
        }
        let mut cached=cached.ok_or_else(|| "CONTENT_NOT_CACHED".to_string())?;
        if note.is_none() {cached["assetVersion"]=json!(asset_version);}
        return Ok(cached);
    }
    if !matches!(status, 200 | 206) {
        return Err(format!("CONTENT_RESOURCE_HTTP_{status}"));
    }
    let version = response
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .filter(|s| s.len() <= 256)
        .ok_or("CONTENT_VERSION_MISSING")?
        .to_owned();
    let mime = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_owned();
    let length = response.content_length().ok_or("CONTENT_LENGTH_MISSING")?;
    let start = if status == 206 {
        if version != etag
            || !response
                .headers()
                .get("content-range")
                .and_then(|s| s.to_str().ok())
                .is_some_and(|s| s.starts_with(&format!("bytes {offset}-")))
        {
            return Err("CONTENT_RANGE_INVALID".into());
        }
        offset
    } else {
        0
    };
    let byte_limit=max_bytes.unwrap_or(4*1024*1024*1024).min(4*1024*1024*1024);
    if start.saturating_add(length) > byte_limit {
        return Err("CONTENT_RESOURCE_TOO_LARGE".into());
    }
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(start > 0)
        .truncate(start == 0)
        .open(&part)
        .await
        .map_err(|_| "CONTENT_CACHE_UNAVAILABLE")?;
    tokio::fs::write(
        &metadata_path,
        serde_json::to_vec(&json!({"resourceAuthority":resource_authority,"etag": version, "mime": mime})).unwrap(),
    )
    .await
    .map_err(|_| "CONTENT_CACHE_UNAVAILABLE")?;
    let mut received = 0u64;
    while let Some(chunk) = cancellable(response.chunk(), &check)
        .await?
        .map_err(|_| {source.gateway.retire_scope_proof(); "CONTENT_OFFLINE"})?
    {
        check()?;
        received += chunk.len() as u64;
        if received > length || start.saturating_add(received) > byte_limit {
            return Err("CONTENT_LENGTH_INVALID".into());
        }
        file.write_all(&chunk)
            .await
            .map_err(|_| "CONTENT_CACHE_UNAVAILABLE")?;
    }
    if received != length {
        return Err("CONTENT_LENGTH_INVALID".into());
    }
    file.sync_all()
        .await
        .map_err(|_| "CONTENT_CACHE_UNAVAILABLE")?;
    drop(file);
    check()?;
    let extension = match mime.split(';').next().unwrap_or("") {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/svg+xml" => "svg",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "video/quicktime" => "mov",
        "application/pdf" => "pdf",
        "text/plain" => "txt",
        _ => "bin",
    };
    if let Some(expected)=expected_version.as_ref() {
        if source.with_db(&state,|db|db.asset_version(&source.cache_owner(),&id))?.as_ref()!=Some(expected) {return Err("CONTENT_VERSION_CHANGED".into());}
    }
    let version_key = format!("{:x}", Sha256::digest(version.as_bytes()));
    let dest = root.join(format!("{key}-{version_key}.{extension}"));
    tokio::fs::rename(&part, &dest)
        .await
        .map_err(|_| "CONTENT_CACHE_UNAVAILABLE")?;
    let mut complete_metadata = json!({"resourceAuthority":resource_authority,"etag":version,"mime":mime,"fileName":dest.file_name().unwrap().to_string_lossy(),"sizeBytes":start+received});
    if note.is_none() { complete_metadata["assetVersion"] = json!(asset_version); }
    tokio::fs::write(root.join(format!("{key}.json")),serde_json::to_vec(&complete_metadata).unwrap())
        .await.map_err(|_|"CONTENT_CACHE_UNAVAILABLE")?;
    let _ = tokio::fs::remove_file(&metadata_path).await;
    let mut receipt=json!({"path": dest.to_string_lossy(), "mime": mime, "etag": version, "sizeBytes": start + received});
    if note.is_none() {receipt["assetVersion"]=complete_metadata["assetVersion"].clone();}
    check()?;
    Ok(receipt)
}

async fn cancellable<T>(
    future: impl std::future::Future<Output = T>,
    check: &impl Fn() -> Result<(), String>,
) -> Result<T, String> {
    tokio::pin!(future);
    loop {
        tokio::select! {
            result = &mut future => {check()?; return Ok(result);},
            _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => check()?,
        }
    }
}

#[tauri::command]
pub(crate) async fn content_open_resource(
    state: State<'_, SharedState>,
    app: tauri::AppHandle,
    instance: String, library: Option<String>,
    id: String,
    vault: Option<String>,
    note: Option<String>,
) -> Result<Value, String> {
    let source = Source::capture_expected(&state,&instance)?.scoped(library.as_deref(),vault.as_deref())?;
    if vault.is_none() && note.is_none() {material_access_check(&state,&source.cache_owner(),&id)?;}
    let cached = cached_resource(&state,app, instance, library, id, vault, note).await?;
    source.check(&state)?;
    crate::companion_export::open_content_cache(
        cached["path"].as_str().ok_or("CONTENT_NOT_CACHED")?,
        cached["mime"]
            .as_str()
            .unwrap_or("application/octet-stream"),
    )
}

#[tauri::command]
pub(crate) async fn content_cached_resource(
    state: State<'_, SharedState>,
    app: tauri::AppHandle,
    instance: String, library: Option<String>,
    id: String,
    vault: Option<String>,
    note: Option<String>,
) -> Result<Value, String> {
    cached_resource(&state, app, instance, library, id, vault, note).await
}

async fn cached_resource(state: &SharedState, app: tauri::AppHandle, instance: String,
    library: Option<String>, id: String, vault: Option<String>, note: Option<String>) -> Result<Value, String> {
    let resource_authority = with_db(state, |db| db.content_resource_authority())?;
    let epochs = scope_epochs(&instance)?;
    let (lifecycle, _) = connection_controls(state);
    let connection_epoch = lifecycle.observe();
    let knowledge = vault.is_some();
    let check = || -> Result<(), String> {
        let current = scope_epochs(&instance)?;
        if (if knowledge { current.1 != epochs.1 } else { current.0 != epochs.0 }) || lifecycle.observe() != connection_epoch {
            return Err("CONTENT_SOURCE_CHANGED".into());
        }
        with_db(state, |db| {
            if db.paired()?.is_none_or(|p| p.instance_id != instance) || db.content_resource_authority()? != resource_authority { return Err("CONTENT_SOURCE_CHANGED".into()); }
            Ok(())
        })
    };
    check()?;
    if let Some(library) = library.as_deref() { public_id(library)?; }
    public_id(&instance)?;
    public_id(&id)?;
    let domain = match (vault, note) {
        (Some(vault), Some(note)) => {
            public_id(&vault)?;
            public_id(&note)?;
            format!("note:{vault}:{note}")
        }
        (None, None) => "asset".into(),
        _ => return Err("CONTENT_ID_INVALID".into()),
    };
    let owner = if domain == "asset" { material_cache_owner(&instance, library.as_deref()) } else { instance.clone() };
    let key = format!("{:x}", Sha256::digest(format!("{owner}:{domain}:{id}")));
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|_| "CONTENT_CACHE_UNAVAILABLE")?
        .join("content-resources");
    let metadata: Value = serde_json::from_slice(
        &tokio::fs::read(root.join(format!("{key}.json")))
            .await
            .map_err(|_| "CONTENT_NOT_CACHED")?,
    )
    .map_err(|_| "CONTENT_NOT_CACHED")?;
    if metadata["resourceAuthority"].as_i64().unwrap_or(0) != resource_authority { return Err("CONTENT_NOT_CACHED".into()); }
    let name = metadata["fileName"]
        .as_str()
        .filter(|name| {
            name.starts_with(&format!("{key}-"))
                && name
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"-._".contains(&c))
        })
        .ok_or("CONTENT_NOT_CACHED")?;
    let path = root.join(name);
    let actual = tokio::fs::metadata(&path)
        .await
        .map_err(|_| "CONTENT_NOT_CACHED")?;
    if !actual.is_file() || Some(actual.len()) != metadata["sizeBytes"].as_u64() {
        return Err("CONTENT_NOT_CACHED".into());
    }
    let mut receipt=json!({"path":path.to_string_lossy(),"mime":metadata["mime"],"etag":metadata["etag"],"sizeBytes":actual.len(),"cached":true});
    if domain=="asset" {receipt["assetVersion"]=metadata["assetVersion"].clone();}
    check()?;
    Ok(receipt)
}

/// Derived screen pixels live beside the EXISTING complete resource, keyed by
/// its owner/domain/id + HTTP etag + available material revision. No new DB or
/// original-file authority, no remote URL/path accepted from JavaScript.
pub(crate) async fn asset_screen_preview(state:&SharedState,app:&tauri::AppHandle,instance:&str,library:Option<&str>,id:&str,expected_version:&str,force:bool)->Result<Value,String> {
    let cached=cached_resource(state,app.clone(),instance.into(),library.map(str::to_owned),id.into(),None,None).await?;
    let cache_owner=material_cache_owner(instance,library);
    let instance=cache_owner.as_str();
    material_access_check(state,instance,id)?;
    if !cached["mime"].as_str().unwrap_or("").starts_with("image/") {return Err("CONTENT_PREVIEW_UNAVAILABLE".into());}
    let current=with_db(state,|db|db.asset_version(instance,id))?.ok_or("CONTENT_NOT_CACHED")?;
    if current.is_empty() || current!=expected_version {return Err("CONTENT_VERSION_CHANGED".into());}
    let root=app.path().app_cache_dir().map_err(|_|"CONTENT_CACHE_UNAVAILABLE")?.join("content-resources");
    let key=format!("{:x}",Sha256::digest(format!("{instance}:asset:{id}")));
    let metadata:Value=serde_json::from_slice(&tokio::fs::read(root.join(format!("{key}.json"))).await.map_err(|_|"CONTENT_NOT_CACHED")?).map_err(|_|"CONTENT_NOT_CACHED")?;
    if metadata["assetVersion"].as_str()!=Some(current.as_str()) {return Err("CONTENT_VERSION_UNCONFIRMED".into());}
    let source=std::path::PathBuf::from(cached["path"].as_str().ok_or("CONTENT_NOT_CACHED")?);
    let source=source.canonicalize().map_err(|_|"CONTENT_NOT_CACHED")?;
    let root=root.canonicalize().map_err(|_|"CONTENT_NOT_CACHED")?;
    if source.parent()!=Some(root.as_path()) {return Err("CONTENT_NOT_CACHED".into());}
    if let Some((w,h))=crate::local_asset::display_original_dimensions(&source) {
        material_access_check(state,instance,id)?;
        if with_db(state,|db|db.asset_version(instance,id))?!=Some(current.clone()) {return Err("CONTENT_VERSION_CHANGED".into());}
        return Ok(json!({"uri":source.to_string_lossy(),"mime":cached["mime"],"etag":cached["etag"],"w":w,"h":h,"original":true}));
    }
    let revision=format!("{:x}",Sha256::digest(format!("{}:{current}",cached["etag"])));
    let dest=root.join(format!("screen-{key}-{revision}.png"));
    let output=dest.clone();
    let dims=tokio::task::spawn_blocking(move|| crate::local_asset::screen_preview_cached(&source,&dest,force))
        .await.map_err(|_|"CONTENT_PREVIEW_UNAVAILABLE")??;
    material_access_check(state,instance,id)?;
    if with_db(state,|db|db.asset_version(instance,id))?!=Some(current) {return Err("CONTENT_VERSION_CHANGED".into());}
    Ok(json!({"uri":output.to_string_lossy(),"mime":"image/png","etag":cached["etag"],"w":dims.0,"h":dims.1}))
}

#[cfg(test)]
mod saved_library_scope_tests {
    use super::*;

    fn source(instance: &str, kind: &'static str) -> Source {
        Source {
            instance: instance.into(), lifecycle: ConnectionLifecycle::new(), epoch: 0,
            gateway: GatewayClient::new("fixture", "https://localhost", "fixture"),
            scope_epochs: scope_epochs(instance).unwrap(), scope_kind: kind, library: None, vault: None,
            scope_protocol_checked: tokio::sync::OnceCell::new(),
        }
    }

    #[test]
    fn material_cache_namespaces_do_not_alias_same_asset_or_legacy_rows() {
        let a = material_cache_owner("desktop", Some("library-a"));
        let b = material_cache_owner("desktop", Some("library-b"));
        assert_ne!(a, b);
        assert_ne!(a, material_cache_owner("other-desktop", Some("library-a")));
        assert_ne!(a, material_cache_owner("desktop", None));
        assert_eq!(material_cache_owner("desktop", None), "desktop");
        let mut db = Db::open(std::path::Path::new(":memory:")).unwrap();
        for (owner, name) in [(&a, "A"), (&b, "B")] {
            db.upsert_asset(owner, "same-asset", name, "image", "image/png", 1, "now", name, name, "", &[]).unwrap();
            db.content_cache_response(owner, "/v1/assets/same-asset", &json!({"name":name})).unwrap();
            db.set_thumbnail(owner, "same-asset", name, name, "image/png", 1, 1).unwrap();
        }
        assert_eq!(db.content_cached_response(&a, "/v1/assets/same-asset").unwrap()["name"], "A");
        assert_eq!(db.content_cached_response(&b, "/v1/assets/same-asset").unwrap()["name"], "B");
        assert_eq!(db.thumbnail_meta(&a, "same-asset").unwrap().unwrap().path, "A");
        assert_eq!(db.thumbnail_meta(&b, "same-asset").unwrap().unwrap().path, "B");
        db.content_cache_response(&a, "/v1/assets/same-asset", &json!({"_mobileAccessError":"CONTENT_HTTP_403"})).unwrap();
        assert_eq!(db.content_cached_response(&b, "/v1/assets/same-asset").unwrap()["name"], "B");
    }

    #[tokio::test]
    async fn library_switch_invalidates_only_captured_owner_and_domain() {
        let owner = format!("scope-test-{}", uuid::Uuid::new_v4());
        let material = source(&owner, "material");
        let knowledge = source(&owner, "knowledge");
        let other = source("scope-test-other", "all");
        let lsh = source(&owner, "none");
        content_scope_changed(owner.clone(), "materials".into()).await.unwrap();
        assert!(material.scope_changed());
        assert!(!knowledge.scope_changed());
        assert!(!other.scope_changed());
        assert!(!lsh.scope_changed());
        let new_material = source(&owner, "material");
        content_scope_changed(owner, "knowledge".into()).await.unwrap();
        assert!(knowledge.scope_changed());
        assert!(!new_material.scope_changed());
        assert!(!lsh.scope_changed());
    }

    #[test]
    fn catalog_fallback_is_missing_endpoint_only_not_denial_or_server_failure() {
        assert_eq!(library_catalog_response(404, json!({})).unwrap()["scopeSelectionVersion"], 0);
        for status in [401, 403, 409, 410, 429, 500, 503] {
            assert!(library_catalog_response(status, json!({})).is_err());
        }
        assert!(library_catalog_response(200, json!({"scopeSelectionVersion":0})).is_err());
        assert_eq!(library_catalog_response(200, json!({"scopeSelectionVersion":0,"mode":"legacyDefaultOnly","authorizationMode":"legacy"})).unwrap()["scopeSelectionVersion"], 0);
        assert!(!legacy_scope_catalog(200, &json!({"scopeSelectionVersion":1,"materials":[],"knowledge":[]})));
        assert!(legacy_vault_matches(Some("a"), &json!({"items":[{"vaultId":"a"}]})));
        assert!(!legacy_vault_matches(Some("b"), &json!({"items":[{"vaultId":"a"}]})));
        assert!(!legacy_vault_matches(Some("a"), &json!({"items":[]})));
        assert_eq!(library_catalog_response(200, json!({"scopeSelectionVersion":1,"materials":[],"knowledge":[]})).unwrap()["scopeSelectionVersion"], 1);
    }

    #[test]
    fn switching_vaults_never_migrates_existing_operation_ids_or_payloads() {
        let mut db = Db::open(std::path::Path::new(":memory:")).unwrap();
        for vault in ["a", "b"] {
            db.content_vault_remember("desktop", vault, vault).unwrap();
            db.content_create("desktop", vault, "same-note", vault, "saved").unwrap();
        }
        let a = db.content_prepare_available_operations("desktop", "a", Some(false)).unwrap().pop().unwrap();
        let b = db.content_prepare_available_operations("desktop", "b", Some(false)).unwrap().pop().unwrap();
        assert_ne!(a.payload["opId"], b.payload["opId"]);
        assert_eq!(a.payload["vaultId"], "a");
        assert_eq!(b.payload["vaultId"], "b");
        db.offline_select("desktop", "b", true).unwrap();
        db.offline_current("desktop", "b", true).unwrap();
        db.offline_current("desktop", "a", true).unwrap();
        let again = db.content_prepare_available_operations("desktop", "a", Some(true)).unwrap().pop().unwrap();
        assert_eq!(a.payload, again.payload);
        assert_eq!(a.route, again.route);
    }
}
