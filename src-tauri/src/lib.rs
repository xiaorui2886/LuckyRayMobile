// LuckyRay Mobile — official app entry. Service assembly + Tauri commands.
// Protocol V1 (frozen in shared/protocol-v1) implemented against Mock Gateway.

mod capture_media;
mod companion_export;
mod db;
mod device;
mod eventstream;
mod gateway;
mod content;
mod lsh_carrier;
mod lsh_surface;
mod services_v1;
mod services_hints;
mod keystore;
mod local_asset;
mod local_inbox;
mod pinning;
mod qr;
mod secure;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{Manager, State};
use uuid::Uuid;

use db::Db;
use eventstream::EventStreamClient;
use gateway::GatewayClient;
use secure::SecureCredentialStore;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

struct AppState {
    db: Mutex<Db>,
    eventstream: EventStreamClient,
    connection_lifecycle: ConnectionLifecycle,
    conn_intent: ConnIntentMirror,
}

type SharedState = Arc<Mutex<AppState>>;

/// In-memory mirror of the durable connection intent.
///
/// It exists because a FAILED disk write must still veto automatic recovery
/// for the rest of this process. Without it, a user's explicit 断开连接 whose
/// preference save failed would be silently undone the moment the app
/// returned to the foreground. The mirror is the authority while the process
/// lives; the DB value is the durable projection across restarts.
#[derive(Clone)]
struct ConnIntentMirror {
    current: Arc<std::sync::atomic::AtomicU8>,
}

impl ConnIntentMirror {
    const AUTO: u8 = 0;
    const MANUAL_STOP: u8 = 1;
    const UNAVAILABLE: u8 = 2;

    /// Seeded from the durable intent at startup. A failed startup read
    /// becomes UNAVAILABLE (fail closed) — never AUTO.
    fn seeded(intent: ConnectionIntent) -> Self {
        let value = match intent {
            ConnectionIntent::Auto => Self::AUTO,
            ConnectionIntent::ManualStop => Self::MANUAL_STOP,
            ConnectionIntent::Unavailable => Self::UNAVAILABLE,
        };
        Self {
            current: Arc::new(std::sync::atomic::AtomicU8::new(value)),
        }
    }

    fn get(&self) -> ConnectionIntent {
        match self.current.load(Ordering::SeqCst) {
            Self::MANUAL_STOP => ConnectionIntent::ManualStop,
            Self::UNAVAILABLE => ConnectionIntent::Unavailable,
            _ => ConnectionIntent::Auto,
        }
    }

    fn set(&self, intent: ConnectionIntent) {
        let value = match intent {
            ConnectionIntent::Auto => Self::AUTO,
            ConnectionIntent::ManualStop => Self::MANUAL_STOP,
            ConnectionIntent::Unavailable => Self::UNAVAILABLE,
        };
        self.current.store(value, Ordering::SeqCst);
    }
}

/// Serializes every credential/session ownership transition. The epoch makes
/// a start request stale if forget or re-pair wins while that request is
/// paused before acquiring the async gate.
#[derive(Clone)]
struct ConnectionLifecycle {
    gate: Arc<tokio::sync::Mutex<()>>,
    epoch: Arc<AtomicU64>,
}

impl ConnectionLifecycle {
    fn new() -> Self {
        Self {
            gate: Arc::new(tokio::sync::Mutex::new(())),
            epoch: Arc::new(AtomicU64::new(0)),
        }
    }

    fn observe(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }

    fn invalidate(&self) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
    }

    async fn lock(&self) -> tokio::sync::OwnedMutexGuard<()> {
        Arc::clone(&self.gate).lock_owned().await
    }

    async fn run_if_current<T, F, Fut>(&self, observed: u64, action: F) -> Result<T, String>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<T, String>>,
    {
        let _guard = self.lock().await;
        if self.observe() != observed {
            return Err("connection lifecycle changed; stale start rejected".into());
        }
        action().await
    }
}

fn connection_controls(s: &SharedState) -> (ConnectionLifecycle, EventStreamClient) {
    let g = s.lock().unwrap();
    (g.connection_lifecycle.clone(), g.eventstream.clone())
}

fn with_db<F, T>(s: &SharedState, f: F) -> Result<T, String>
where
    F: FnOnce(&mut Db) -> Result<T, String>,
{
    let g = s.lock().unwrap();
    let mut db = g.db.lock().unwrap();
    f(&mut db)
}

fn save_and_verify_secure_credential<S: SecureCredentialStore + ?Sized>(
    store: &S,
    instance_id: &str,
    credential: &str,
) -> Result<String, String> {
    if credential.is_empty() {
        return Err("secure credential cannot be empty".into());
    }
    store.save_desktop_credential(instance_id, credential)?;
    let verified = store
        .load_desktop_credential(instance_id)?
        .filter(|value| !value.is_empty())
        .ok_or("secure credential verification failed")?;
    if verified != credential {
        return Err("secure credential verification failed".into());
    }
    Ok(verified)
}

/// Returns a gateway client only after obtaining its credential from secure
/// storage. `legacy_credential` exists solely to evacuate pre-P1 M2.x rows:
/// it is written/read-back-verified in the keystore before SQLite is scrubbed,
/// and it is never passed to GatewayClient directly.
fn authenticated_pairing<S: SecureCredentialStore + ?Sized>(
    db: &mut Db,
    store: &S,
) -> Result<(db::PairedDesktop, GatewayClient), String> {
    let mut paired = db.paired()?.ok_or("not paired")?;
    let credential = if paired.legacy_credential.is_empty() {
        // A prior scrub can have committed the empty value but failed while
        // truncating its WAL residue. Do not let the now-empty logical column
        // make that cleanup look complete on a later restart.
        db.finish_pending_legacy_credential_wal_cleanup()?;
        let secure_credential = store
            .load_desktop_credential(&paired.instance_id)?
            .filter(|value| !value.is_empty())
            .ok_or("secure credential missing; re-pair this Desktop")?;
        // Re-save every resolved secure credential through the current scoped
        // store. On Android this upgrades the prior one-slot Keystore file to
        // the instance-scoped file and removes the compatibility artifact.
        save_and_verify_secure_credential(store, &paired.instance_id, &secure_credential)?
    } else {
        let legacy_credential = paired.legacy_credential.clone();
        let verified = save_and_verify_secure_credential(
            store,
            &paired.instance_id,
            &legacy_credential,
        )?;
        db.scrub_legacy_credential(&paired.instance_id)?;
        paired.legacy_credential.clear();
        verified
    };
    let client = GatewayClient::new(&paired.fingerprint, &paired.base_url, &credential);
    Ok((paired, client))
}

fn scrub_active_legacy_credential(db: &mut Db) -> Result<(), String> {
    if let Some(paired) = db.paired()? {
        if paired.legacy_credential.is_empty() {
            db.finish_pending_legacy_credential_wal_cleanup()?;
        } else {
            db.scrub_legacy_credential(&paired.instance_id)?;
        }
    }
    Ok(())
}

/// The destructive pairing paths share this ordering: first render any
/// compatibility value unusable, then erase all scoped secure credentials,
/// then remove pairing metadata. That leaves no DB fallback if an operation
/// is interrupted between steps.
fn clear_pairing_and_secure_credentials<S: SecureCredentialStore + ?Sized>(
    db: &mut Db,
    store: &S,
) -> Result<(), String> {
    // Revoke/reset is a destructive boundary. Best-effort removal only touches
    // bridge-owned paths; it must not block credential revocation if the
    // outbox metadata itself is unhealthy. A later startup reconciliation can
    // reclaim any remaining private orphan once the database is reset.
    if let Ok(attachment_paths) = db.list_attachment_paths() {
        for local_path in attachment_paths {
            let _ = capture_media::remove_private_attachment_if_managed(&local_path);
        }
    }
    scrub_active_legacy_credential(db)?;
    store.delete_all_desktop_credentials()?;
    db.revoke_paired()
}

fn require_paired(s: &SharedState) -> Result<(db::PairedDesktop, GatewayClient), String> {
    let secure_store = secure::SecureCredentialStoreImpl;
    let g = s.lock().unwrap();
    let mut db = g.db.lock().unwrap();
    authenticated_pairing(&mut db, &secure_store)
}

/// M3-M1 R2 — durable connection intent. A restart must restore an existing
/// pairing automatically, but a user's explicit "断开连接" must NOT be
/// overridden by that automatic recovery. The intent is the only thing that
/// distinguishes the two: it is written on every explicit connect/disconnect
/// and read once at cold start.
pub(crate) const CONN_INTENT_KEY: &str = "conn_intent_v1";
pub(crate) const CONN_INTENT_AUTO: &str = "auto";
pub(crate) const CONN_INTENT_MANUAL_STOP: &str = "manual_stop";

/// The three outcomes a connection-intent read can produce. They are kept
/// distinct because treating a read FAILURE as "no key" would silently grant
/// automatic recovery the user may have deliberately disabled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ConnectionIntent {
    /// Explicit auto, an unrecognised value, or the legacy no-key state. The
    /// standing pairing is the opt-in.
    Auto,
    /// The user explicitly disconnected; automatic recovery is vetoed.
    ManualStop,
    /// The intent could not be read. Fail closed — never treat a broken read
    /// as authorisation to reconnect.
    Unavailable,
}

pub(crate) fn read_conn_intent(db: &Db) -> ConnectionIntent {
    match db.meta_get(CONN_INTENT_KEY) {
        Ok(None) => ConnectionIntent::Auto,
        Ok(Some(value)) if value == CONN_INTENT_MANUAL_STOP => ConnectionIntent::ManualStop,
        Ok(Some(_)) => ConnectionIntent::Auto,
        Err(_) => ConnectionIntent::Unavailable,
    }
}

/// Persist the intent, surfacing failure instead of swallowing it. A caller
/// must never report "saved" when this returns Err.
fn persist_conn_intent(s: &SharedState, value: &str) -> Result<(), String> {
    let g = s.lock().map_err(|_| "connection state unavailable".to_string())?;
    let db = g.db.lock().map_err(|_| "connection state unavailable".to_string())?;
    db.meta_set(CONN_INTENT_KEY, value)
}

/// True when an existing pairing should reconnect on its own.
pub(crate) fn conn_intent_allows_resume(db: &Db) -> bool {
    matches!(read_conn_intent(db), ConnectionIntent::Auto)
}

/// The intent authority during this process: the in-memory mirror wins,
/// because an explicit stop must hold even when its disk write failed.
fn current_conn_intent(s: &SharedState) -> ConnectionIntent {
    match s.lock() {
        Ok(g) => g.conn_intent.get(),
        Err(_) => ConnectionIntent::Unavailable,
    }
}

fn mirror_conn_intent(s: &SharedState, intent: ConnectionIntent) {
    match s.lock() {
        Ok(g) => g.conn_intent.set(intent),
        // A poisoned lock leaves the mirror unreachable; the durable value
        // then decides on the next read, which fails closed on error.
        Err(_) => {}
    }
}

// ---- Connection transition results -------------------------------------
// The UI must be able to tell "the operation failed" apart from "the operation
// succeeded but its preference could not be saved". A bare Err cannot carry
// that distinction, so every transition returns this small bounded JSON shape
// instead. It never carries the credential or the raw provider body.

pub(crate) const CONN_STATUS_STARTED: &str = "started";
pub(crate) const CONN_STATUS_STOPPED: &str = "stopped";
pub(crate) const CONN_STATUS_RESUMED: &str = "resumed";
pub(crate) const CONN_STATUS_SKIPPED_MANUAL_STOP: &str = "skipped_manual_stop";
pub(crate) const CONN_STATUS_SKIPPED_INTENT_UNAVAILABLE: &str = "skipped_intent_unavailable";
pub(crate) const CONN_STATUS_SKIPPED_NOT_PAIRED: &str = "skipped_not_paired";
pub(crate) const CONN_STATUS_DEFERRED_TRANSPORT: &str = "deferred_transport";

/// `preference_saved = false` means the operation itself succeeded but the
/// durable preference write failed. Callers must surface that, and must never
/// present it as the operation having failed.
fn conn_result_json(status: &str, preference_saved: bool, error: Option<&str>) -> String {
    serde_json::json!({
        "status": status,
        "preferenceSaved": preference_saved,
        "warning": error.map(|e| bounded_warning(e)),
    })
    .to_string()
}

/// The DB error text is diagnostic and short; bound it so a pathological
/// message can never grow the payload.
fn bounded_warning(error: &str) -> String {
    error.chars().take(160).collect()
}

#[derive(Serialize)]
struct ConnState {
    paired: bool,
    identity: Option<serde_json::Value>,
    stats: Option<serde_json::Value>,
    ws: serde_json::Value,
}

// ---------------------------------------------------------------------------
// Connection / Pairing
// ---------------------------------------------------------------------------

#[tauri::command]
fn conn_state(state: State<'_, SharedState>) -> Result<ConnState, String> {
    match conn_state_impl(&state) {
        Ok(v) => Ok(v),
        Err(error) => {
            // [LR] triage diagnostic: the ACTUAL failure code behind a
            // state_unavailable surface (truncated to a user-safe length,
            // matching the gateway error sanitize convention).
            println!(
                "[LR] conn_state failed: {}",
                error.chars().take(160).collect::<String>()
            );
            Err(error)
        }
    }
}

fn conn_state_impl(state: &State<'_, SharedState>) -> Result<ConnState, String> {
    let secure_store = secure::SecureCredentialStoreImpl;
    let (paired_opt, stats) = {
        let g = state.lock().unwrap();
        let mut db = g.db.lock().unwrap();
        // The first state read after an M2.x upgrade evacuates any legacy DB
        // credential into the Keystore before the UI exposes a usable pair.
        if db.paired()?.is_some() {
            let _ = authenticated_pairing(&mut db, &secure_store)?;
        }
        let paired = db.paired()?;
        let stats = match &paired {
            Some(p) => Some(db.stats(&p.instance_id)?),
            None => None,
        };
        (paired, stats)
    };
    let ws = {
        let g = state.lock().unwrap();
        g.eventstream.snapshot()
    };
    let identity = paired_opt.as_ref().map(|p| {
        serde_json::json!({
            "instanceId": p.instance_id,
            "displayName": p.display_name,
            "platform": p.platform,
            "appVersion": p.app_version,
            "protocolVersion": p.protocol_version,
            "certificateFingerprint": p.fingerprint,
            "baseUrl": p.base_url,
        })
    });
    Ok(ConnState { paired: paired_opt.is_some(), identity, stats, ws })
}

/// Parse a Protocol V1 pairing payload (from QR scan or manual paste) into its
/// typed fields. Pure function — unit-tested; used by do_pair.
fn is_private_lan_ipv4(ip: &str) -> bool {
    // companion-v1 qr-envelope schema: private-LAN IPv4 only
    // (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16).
    //
    // Parsed with Ipv4Addr::from_str so WHATWG/octal tricks ("010.0.0.1" →
    // 8.0.0.1, "172.016.0.1" → 172.14.0.1) and "+10.0.0.1" cannot smuggle a
    // public host past the private-LAN gate.
    use std::net::Ipv4Addr;
    let Ok(addr) = ip.parse::<Ipv4Addr>() else {
        return false;
    };
    let o = addr.octets();
    o[0] == 10
        || (o[0] == 172 && (16..=31).contains(&o[1]))
        || (o[0] == 192 && o[1] == 168)
}

fn is_lower_hex(value: &str, len: usize) -> bool {
    value.len() == len && value.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// Parse a Protocol V1 pairing payload (from QR scan or manual paste) into its
/// typed fields. Pure function — unit-tested; used by do_pair.
///
/// M3-M1 Phase-B: tightened to the frozen companion-v1 bundle contract
/// (schemas/qr-envelope.schema.json + manifest.compatibility):
/// exactly the seven canonical fields (additionalProperties=false,
/// unknownQrFields=reject), instance `^desktop-[a-f0-9]{32}$`, secret/fp
/// `^[a-f0-9]{64}$`, private-LAN ip, port 1..=65535, name 1..=80 chars.
fn parse_pair_payload(payload: &serde_json::Value) -> Result<(i64, String, String, String, u16, String, String), String> {
    // unknownQrFields = "reject": no additional properties, no aliases.
    if let Some(obj) = payload.as_object() {
        const CANONICAL: [&str; 7] = ["v", "name", "instance", "ip", "port", "secret", "fp"];
        for key in obj.keys() {
            if !CANONICAL.contains(&key.as_str()) {
                // Key name only, capped — values never enter error text.
                let mut key = key.clone();
                if key.chars().count() > 64 {
                    key = key.chars().take(64).collect();
                }
                return Err(format!("unknown field in pairing payload: {key}"));
            }
        }
    }
    let v = payload["v"].as_i64().unwrap_or(0);
    if v != 1 {
        return Err(format!("unsupported pairing protocol version: {v}"));
    }
    let name = payload["name"].as_str().ok_or("payload missing name")?.to_string();
    if name.is_empty() || name.chars().count() > 80 {
        return Err("invalid pairing payload name length".into());
    }
    let instance = payload["instance"].as_str().ok_or("payload missing instance")?.to_string();
    if !(instance.starts_with("desktop-") && is_lower_hex(&instance["desktop-".len()..], 32)) {
        return Err("invalid instance id in payload".into());
    }
    let ip = payload["ip"].as_str().ok_or("payload missing ip")?.to_string();
    if !is_private_lan_ipv4(&ip) {
        return Err("pairing payload ip is not a private LAN address".into());
    }
    let port_i = payload["port"].as_i64().ok_or("payload missing port")?;
    if !(1..=65535).contains(&port_i) {
        return Err("invalid pairing payload port".into());
    }
    let port = port_i as u16;
    let secret = payload["secret"].as_str().ok_or("payload missing secret")?.to_string();
    if !is_lower_hex(&secret, 64) {
        return Err("invalid secret format in payload".into());
    }
    let fp = payload["fp"].as_str().ok_or("payload missing fingerprint")?.to_string();
    if !is_lower_hex(&fp, 64) {
        return Err("invalid fingerprint format in payload".into());
    }
    Ok((v, name, instance, ip, port, secret, fp))
}

/// M3-M1 Phase-B — bundle trust sequence #3: the pinned hello response must
/// carry protocol version 1, the SAME desktop instance and the SAME
/// certificate fingerprint the QR envelope was pinned with.
pub(crate) fn validate_hello_identity(hello: &serde_json::Value, expected_instance: &str, expected_fp: &str) -> Result<(), String> {
    let version = hello["protocolVersion"].as_i64().unwrap_or(0);
    if version != 1 {
        return Err(format!("desktop hello protocol version mismatch: {version}"));
    }
    let instance = hello["instanceId"].as_str().unwrap_or("");
    if instance != expected_instance {
        return Err("desktop hello instance does not match the pinned QR identity".into());
    }
    let fp = hello["certificateFingerprint"].as_str().unwrap_or("");
    if fp != expected_fp {
        return Err("desktop hello certificate fingerprint does not match the pinned QR identity".into());
    }
    let display_name = hello["displayName"]
        .as_str()
        .ok_or("desktop hello is missing displayName")?;
    if display_name.is_empty() || display_name.chars().count() > 80 {
        return Err("desktop hello displayName length is invalid".into());
    }
    if hello["platform"].as_str() != Some("windows") {
        return Err("desktop hello platform must be windows".into());
    }
    let app_version = hello["appVersion"]
        .as_str()
        .ok_or("desktop hello is missing appVersion")?;
    if app_version.is_empty() || app_version.chars().count() > 64 {
        return Err("desktop hello appVersion length is invalid".into());
    }
    // Phase-B R1 (P2-a): the complete required hello shape includes the
    // capabilities object (hello-response.schema.json, consts) — pairing,
    // authenticatedEvents and deviceRevocation true, runs false for the
    // four-route foundation. Unknown fields (inside capabilities and at the
    // top level) are IGNORED per manifest.compatibility.
    let caps = &hello["capabilities"];
    if !caps.is_object() {
        return Err("desktop hello is missing capabilities".into());
    }
    if caps["pairing"].as_bool() != Some(true)
        || caps["authenticatedEvents"].as_bool() != Some(true)
        || caps["deviceRevocation"].as_bool() != Some(true)
        || caps["runs"].as_bool() != Some(false)
    {
        return Err("desktop hello capabilities do not match the companion-v1 foundation".into());
    }
    Ok(())
}

/// M3-M1 Phase-B — bundle trust sequence #4: the pair response must be a
/// valid pair-response object (protocolVersion 1, deviceId matching the
/// credential prefix, credential `device-[a-f0-9]{32}.[a-f0-9]{64}`).
pub(crate) fn validate_pair_response(pair: &serde_json::Value) -> Result<String, String> {
    let version = pair["protocolVersion"].as_i64().unwrap_or(0);
    if version != 1 {
        return Err(format!("pair response protocol version mismatch: {version}"));
    }
    let device_id = pair["deviceId"].as_str().unwrap_or("");
    let credential = pair["credential"].as_str().unwrap_or("");
    let Some((prefix, secret_part)) = credential.split_once('.') else {
        return Err("pair response credential is malformed".into());
    };
    if device_id != prefix {
        return Err("pair response deviceId does not match the credential".into());
    }
    let ok_device = prefix
        .strip_prefix("device-")
        .map(|h| is_lower_hex(h, 32))
        .unwrap_or(false);
    if !ok_device {
        return Err("pair response deviceId is malformed".into());
    }
    if !is_lower_hex(secret_part, 64) {
        return Err("pair response credential is malformed".into());
    }
    Ok(credential.to_string())
}

/// M3-M1 Phase-B — pair-request body per the frozen pair-request.schema.json
/// (required exactly: secret, fingerprint, deviceLabel; additionalProperties
/// false). Kept as a pure function next to the parser so the schema contract
/// is unit-testable.
pub(crate) fn build_pair_request_body(secret: &str, fingerprint: &str, device_label: &str) -> serde_json::Value {
    serde_json::json!({
        "secret": secret,
        "fingerprint": fingerprint,
        "deviceLabel": device_label,
    })
}

/// M3-M1 Phase-B (R1) — session-response validation per the frozen
/// session-response.schema.json: ok=true, protocolVersion 1, deviceId bound
/// to the paired device, deviceLabel 1..=80 chars. Unknown response fields
/// are ignored (manifest.compatibility).
pub(crate) fn validate_session_response(session: &serde_json::Value, expected_device_id: &str) -> Result<(), String> {
    if session["ok"].as_bool() != Some(true) {
        return Err("session response is not ok".into());
    }
    let version = session["protocolVersion"].as_i64().unwrap_or(0);
    if version != 1 {
        return Err(format!("session response protocol version mismatch: {version}"));
    }
    let device_id = session["deviceId"].as_str().unwrap_or("");
    if device_id != expected_device_id {
        return Err("session response deviceId does not match the paired device".into());
    }
    let label = session["deviceLabel"].as_str().unwrap_or("");
    if label.is_empty() || label.chars().count() > 80 {
        return Err("session response deviceLabel length is invalid".into());
    }
    Ok(())
}

/// M3-M1 Phase-B — bounded companion error note: carries the typed code only
/// (frozen error fixtures); the raw body/message never enters Mobile state.
pub(crate) fn companion_error_note(status: u16, body: &serde_json::Value) -> String {
    // The typed code is carried (frozen fixtures use short codes); a
    // nonconformant oversized code is truncated so the note stays bounded.
    let code = body["code"].as_str().unwrap_or("UNKNOWN");
    let mut code = code.to_string();
    if code.chars().count() > 64 {
        code = code.chars().take(64).collect();
    }
    format!("http {status} [{code}]")
}


async fn do_pair(s: &SharedState, payload: serde_json::Value) -> Result<serde_json::Value, String> {
    let (lifecycle, eventstream) = connection_controls(s);
    let _lifecycle_guard = lifecycle.lock().await;
    lifecycle.invalidate();
    let (_v, name, instance, ip, port, secret, fp) = parse_pair_payload(&payload)?;
    let base = format!("https://{ip}:{port}");

    // 1) pin-verified hello -> DesktopIdentity
    let probe = GatewayClient::new(&fp, &base, "");
    let identity = probe.hello().await?;
    // Phase-B bundle trust sequence #3: hello must match the pinned QR identity.
    validate_hello_identity(&identity, &instance, &fp)?;
    let platform = identity["platform"].as_str().ok_or("validated hello missing platform")?.to_string();
    let app_version = identity["appVersion"].as_str().ok_or("validated hello missing appVersion")?.to_string();
    let protocol_version = identity["protocolVersion"].as_i64().unwrap_or(1);

    // 2) exchange one-time secret for device credential (trust sequence #4:
    //    the request carries the pinned fingerprint and a device label; the
    //    response is validated against the frozen pair-response schema).
    let pair = probe.pair(&secret, "LuckyRay Mobile").await?;
    let credential = validate_pair_response(&pair)?;

    // 3) Phase-B R1 (P1-2): canonical session gate — GET /v1/session with the
    // FRESH credential as the Bearer token must succeed and bind to the SAME
    // device BEFORE any credential/paired metadata becomes durable. The probe
    // client (blank token) is replaced by an authenticated client built from
    // the validated pair response, and the session body is schema-validated
    // (ok/protocolVersion/deviceId binding) — never discarded.
    let authed = GatewayClient::new(&fp, &base, &credential);
    let session = authed.session().await?;
    validate_session_response(
        &session,
        pair["deviceId"].as_str().unwrap_or(""),
    )?;

    // Only a fully validated replacement credential may retire the current
    // worker. Invalid/failed re-pair attempts leave the existing authority
    // untouched, while a successful replacement cannot overlap old bearer
    // ownership during persistence.
    eventstream.stop().await;
    // P0-S3: the LSH carrier copies the OLD Desktop target, fingerprint and an
    // authenticated browser cookie. A successful A->B replacement must retire
    // it here — before B becomes the durable pairing — so A can never remain a
    // live authenticated control channel. (Failed attempts already returned
    // above, so a rejected re-pair never touches A's carrier.)
    crate::lsh_carrier::stop();
    // P1-H3: the Services hint worker holds an authenticated old-bearer WSS to the
    services_hints::retire_managed();
    // PREVIOUS Desktop; retire it in the SAME gate, before B becomes durable.

    // 3) persist secure credential before metadata. A DB failure can never
    // leave an active pairing that later authenticates from SQLite.
    let secure_store = secure::SecureCredentialStoreImpl;
    {
        let g = s.lock().unwrap();
        let mut db = g.db.lock().unwrap();
        let previous = db.paired()?;
        db.finish_pending_legacy_credential_wal_cleanup()?;
        if let Some(previous) = &previous {
            if !previous.legacy_credential.is_empty() {
                // Re-pairing may replace an M2.x row before its normal first
                // authenticated read. Purge that legacy plaintext before the
                // replacement transaction can hide it logically.
                db.scrub_legacy_credential(&previous.instance_id)?;
            }
        }
        let previous_secure_credential = match &previous {
            Some(paired) => secure_store.load_desktop_credential(&paired.instance_id)?,
            None => None,
        };

        save_and_verify_secure_credential(&secure_store, &instance, &credential)?;
        if let Some(previous) = &previous {
            if previous.instance_id != instance {
                if let Err(error) = secure_store.delete_desktop_credential(&previous.instance_id) {
                    let _ = secure_store.delete_desktop_credential(&instance);
                    return Err(format!("clear previous secure credential: {error}"));
                }
            }
        }

        if let Err(error) = db.upsert_paired(
            &instance,
            &name,
            &platform,
            &app_version,
            protocol_version,
            &fp,
            &base,
        ) {
            if let (Some(previous), Some(previous_credential)) = (&previous, previous_secure_credential) {
                let _ = save_and_verify_secure_credential(
                    &secure_store,
                    &previous.instance_id,
                    &previous_credential,
                );
                if previous.instance_id != instance {
                    let _ = secure_store.delete_desktop_credential(&instance);
                }
            } else {
                let _ = secure_store.delete_desktop_credential(&instance);
            }
            return Err(format!("persist pairing metadata: {error}"));
        }
    }

    Ok(serde_json::json!({
        "instanceId": instance,
        "displayName": name,
        "baseUrl": base,
        "deviceId": pair["deviceId"],
    }))
}

#[tauri::command]
async fn conn_pair(state: State<'_, SharedState>, payload: String) -> Result<serde_json::Value, String> {
    let json: serde_json::Value =
        serde_json::from_str(&payload).map_err(|e| format!("invalid pairing payload JSON: {e}"))?;
    do_pair(&state, json).await
}

// Pair by picking pairing.json through the system file picker (GetContent).
// No storage permission needed; works on devices where adb text injection fails.
#[tauri::command]
async fn pair_pick_file(state: State<'_, SharedState>) -> Result<serde_json::Value, String> {
    let media = capture_media::pick(2, 300_000)?; // kind=file; SAF picker can be slow on real devices
    if media.local_uri.is_empty() {
        return Err("file picker returned no file".into());
    }
    let content = std::fs::read_to_string(&media.local_uri).map_err(|e| format!("read picked file: {e}"))?;
    let json: serde_json::Value = serde_json::from_str(&content).map_err(|e| format!("invalid JSON: {e}"))?;
    do_pair(&state, json).await
}

#[tauri::command]
async fn conn_pair_file(state: State<'_, SharedState>, app: tauri::AppHandle, file_name: String) -> Result<serde_json::Value, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| format!("data dir: {e}"))?;
    let content = std::fs::read_to_string(data_dir.join(file_name)).map_err(|e| format!("read pairing file: {e}"))?;
    let json: serde_json::Value = serde_json::from_str(&content).map_err(|e| format!("invalid JSON: {e}"))?;
    do_pair(&state, json).await
}

#[tauri::command]
async fn conn_revoke(state: State<'_, SharedState>) -> Result<String, String> {
    // M3-M1 Phase-B R1 (P1-3): local forget retires the authenticated WSS
    // session FIRST so no authenticated channel survives the credential
    // clearing. This is a LOCAL stop only — it does not claim any Desktop
    // remote revocation (the bundle declares none).
    let (lifecycle, eventstream) = connection_controls(&state);
    let _lifecycle_guard = lifecycle.lock().await;
    lifecycle.invalidate();
    eventstream.stop().await;
    // P0-S3: the LSH carrier holds an authenticated Desktop browser session.
    // Local forget must retire it BEFORE the credential/metadata clearing, so
    // no authenticated remote surface survives the revoke.
    crate::lsh_carrier::stop();
    // P1-H3: local forget retires the Services hint scope too, BEFORE credentials are cleared.
    services_hints::retire_managed();
    let secure_store = secure::SecureCredentialStoreImpl;
    {
        let g = state.lock().unwrap();
        let mut db = g.db.lock().unwrap();
        clear_pairing_and_secure_credentials(&mut db, &secure_store)?;
        // Forgetting the device clears the stored intent too: a future pairing
        // starts from a clean slate rather than inheriting an old opt-out.
        let _ = db.meta_set(CONN_INTENT_KEY, CONN_INTENT_AUTO);
    }
    // The mirror follows the clear so a re-pair in this process is not vetoed
    // by the opt-out the cleared pairing used to carry.
    mirror_conn_intent(&state, ConnectionIntent::Auto);
    Ok("revoked".into())
}

#[tauri::command]
async fn conn_hello(state: State<'_, SharedState>) -> Result<serde_json::Value, String> {
    let (paired, gw) = require_paired(&state)?;
    let identity = gw.hello().await?;
    let _ = paired;
    Ok(identity)
}

// ---------------------------------------------------------------------------
// Durable sync
// ---------------------------------------------------------------------------

#[tauri::command]
async fn sync_run(state: State<'_, SharedState>, app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let (paired, gw) = require_paired(&state)?;
    let instance = paired.instance_id;
    let mut cursor = with_db(&state, |db| db.cursor(&instance, "changes"))?;
    let mut resynced = false;
    let mut applied: i64 = 0;
    loop {
        let page = match gw.sync_changes(cursor, 200).await {
            Ok(p) => p,
            Err(e) if e.contains(gateway::ERROR_CURSOR_TOO_OLD) && !resynced => {
                // journal compacted -> full resync from 0; outbox is untouched
                with_db(&state, |db| db.set_cursor(&instance, "changes", 0))?;
                cursor = 0;
                resynced = true;
                continue;
            }
            Err(e) => return Err(e),
        };
        let changes = page["changes"].as_array().cloned().unwrap_or_default();
        if changes.is_empty() {
            break;
        }
        let mut ops: Vec<(String, String, String, Option<serde_json::Value>)> = Vec::new();
        for ch in &changes {
            let etype = ch["entityType"].as_str().unwrap_or("").to_string();
            let eid = ch["entityId"].as_str().unwrap_or("").to_string();
            let op = ch["operation"].as_str().unwrap_or("upsert").to_string();
            let mut data: Option<serde_json::Value> = None;
            if op == "upsert" {
                data = match etype.as_str() {
                    "asset" => Some(gw.asset_detail(&eid).await?),
                    "note" => Some(gw.note(&eid).await?),
                    _ => None,
                };
            }
            ops.push((etype, eid, op, data));
        }
        with_db(&state, |db| db.apply_sync_batch(&instance, &ops))?;
        // tombstone cleanup: remove cached thumbnail files for deleted entities
        let cache = app.path().app_cache_dir().map_err(|e| format!("cache dir: {e}"))?;
        for (etype, eid, op, _) in &ops {
            if etype == "asset" && op == "delete" {
                let _ = cleanup_thumb_files(&cache, &instance, eid);
            }
        }
        let after = page["after"].as_i64().unwrap_or(cursor + changes.len() as i64);
        with_db(&state, |db| db.set_cursor(&instance, "changes", after))?;
        applied += changes.len() as i64;
        cursor = after;
        if !page["hasMore"].as_bool().unwrap_or(false) {
            break;
        }
        if applied > 5000 {
            break; // safety
        }
    }
    // refresh agent runs
    if let Ok(runs) = gw.ai_runs().await {
        if let Some(arr) = runs.as_array() {
            for r in arr {
                with_db(&state, |db| db.upsert_run(&instance, r))?;
            }
        }
    }
    let stats = with_db(&state, |db| db.stats(&instance))?;
    Ok(serde_json::json!({ "applied": applied, "cursor": cursor, "resynced": resynced, "stats": stats }))
}

// ---------------------------------------------------------------------------
// Library (assets)
// ---------------------------------------------------------------------------

#[tauri::command]
async fn assets_refresh(state: State<'_, SharedState>, page: i64, limit: i64, kind: Option<String>) -> Result<serde_json::Value, String> {
    let (paired, gw) = require_paired(&state)?;
    let instance = paired.instance_id;
    let res = gw.assets(page, limit, kind.as_deref(), None).await?;
    if let Some(items) = res["items"].as_array() {
        for a in items {
            let id = a["desktopAssetId"].as_str().unwrap_or("").to_string();
            let tags: Vec<String> = a["tags"].as_array().map(|t| t.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
            with_db(&state, |db| {
                db.upsert_asset(
                    &instance, &id,
                    a["name"].as_str().unwrap_or(""),
                    a["kind"].as_str().unwrap_or("other"),
                    a["mimeType"].as_str().unwrap_or(""),
                    a["sizeBytes"].as_i64().unwrap_or(0),
                    a["updatedAt"].as_str().unwrap_or(""),
                    a["contentHash"].as_str().unwrap_or(""),
                    a["thumbnailRevision"].as_str().unwrap_or(""),
                    a["folderId"].as_str().unwrap_or(""),
                    &tags,
                )
            })?;
        }
    }
    Ok(res)
}

#[tauri::command]
async fn assets_local(state: State<'_, SharedState>, page: i64, limit: i64, kind: Option<String>) -> Result<serde_json::Value, String> {
    let instance = {
        let g = state.lock().unwrap();
        let db = g.db.lock().unwrap();
        db.paired()?.map(|p| p.instance_id)
    };
    let Some(instance) = instance else {
        return Ok(serde_json::json!({ "items": [], "page": page, "limit": limit, "total": 0, "hasMore": false }));
    };
    let rows = with_db(&state, |db| db.list_assets(&instance, kind.as_deref(), page, limit))?;
    let items: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| {
            serde_json::json!({
                "desktopAssetId": r.id, "name": r.name, "kind": r.kind, "mimeType": r.mime,
                "sizeBytes": r.size, "updatedAt": r.updated_at, "contentHash": r.hash,
                "thumbnailRevision": r.thumb_rev, "folderId": r.folder_id,
                "thumbnailPath": r.thumb_path, "tags": r.tags,
            })
        })
        .collect();
    let total = with_db(&state, |db| db.count_assets(&instance))?;
    Ok(serde_json::json!({
        "items": items, "page": page, "limit": limit, "total": total,
        "hasMore": (page + 1) * limit < total,
    }))
}

#[tauri::command]
async fn asset_detail(state: State<'_, SharedState>, id: String) -> Result<serde_json::Value, String> {
    let (paired, gw) = require_paired(&state)?;
    let instance = paired.instance_id;
    let detail = gw.asset_detail(&id).await?;
    let tags: Vec<String> = detail["tags"].as_array().map(|t| t.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
    with_db(&state, |db| {
        db.upsert_asset(
            &instance, &id,
            detail["name"].as_str().unwrap_or(""),
            detail["kind"].as_str().unwrap_or("other"),
            detail["mimeType"].as_str().unwrap_or(""),
            detail["sizeBytes"].as_i64().unwrap_or(0),
            detail["updatedAt"].as_str().unwrap_or(""),
            detail["contentHash"].as_str().unwrap_or(""),
            detail["thumbnailRevision"].as_str().unwrap_or(""),
            detail["folderId"].as_str().unwrap_or(""),
            &tags,
        )
    })?;
    Ok(detail)
}

// ThumbnailCache: (instance, asset_id, etag) keyed. Files live in the app
// cache dir; SQLite keeps only path/etag/mime/w/h/last_accessed (never blobs).
// Alpha hardening: returns a cache URI for the WebView (convertFileSrc) instead
// of large data URLs; protects against oversized downloads; 304 never rewrites
// the cache; 404 clears stale cache entries.
pub(crate) const THUMBNAIL_MAX_BYTES: usize = 512 * 1024;

#[tauri::command]
async fn asset_thumbnail(
    state: State<'_, SharedState>,
    app: tauri::AppHandle,
    instance: String,
    id: String,
    // MATERIAL-LIBRARY-INSTANT-R1 REPAIR-R2 (3B): a bounded RETRY of a
    // thumbnail whose cached bytes failed to decode ON THIS DEVICE. It skips
    // the local cache hit and drops the exact (owner, asset) cache row first,
    // so the following request is a genuinely new attempt. Every ownership /
    // currentness fence below is unchanged, the scope is exactly one
    // owner+asset, and no second cache is introduced.
    force: Option<bool>,
    preview: Option<bool>,
    version: Option<String>,
) -> Result<serde_json::Value, String> {
    // The thumbnail belongs to the Desktop the page was opened from, and ONE
    // capture owns the whole operation: its gateway is the only one used for
    // the network request, so an A->B switch can never send A's asset id to B.
    // The thumbnail cache is keyed by instance, so the same capture also
    // decides which cache rows are legitimately visible here.
    let owner = crate::content::expected_thumbnail_source(&state, &instance)?;
    if id.is_empty() || id.len()>160 || !id.bytes().all(|c|c.is_ascii_alphanumeric()||c==b'-'||c==b'_') {return Err("CONTENT_ID_INVALID".into());}
    // Everything below is keyed by the CAPTURED owner, never by the raw
    // parameter, so the cache rows and the fetch cannot disagree.
    let instance = owner.instance().to_string();
    crate::content::material_access_check(&state,&instance,&id)?;
    let captured_version=with_db(&state,|db|db.asset_version(&instance,&id))?;
    if version.as_ref().is_some_and(|v|!v.is_empty()&&captured_version.as_deref()!=Some(v.as_str())) {return Err("CONTENT_VERSION_CHANGED".into());}
    if preview.unwrap_or(false) {
        let value = crate::content::asset_screen_preview(&state, &app, &instance, &id, version.as_deref().unwrap_or(""),force.unwrap_or(false)).await?;
        owner.verify(&state)?;
        return Ok(value);
    }
    let cache = app.path().app_cache_dir().map_err(|e| format!("cache dir: {e}"))?;
    std::fs::create_dir_all(&cache).map_err(|e| format!("mkdir: {e}"))?;

    // 1) local cache hit (offline-safe) — SKIPPED for a forced retry, and the
    //    exact owner+asset cache row is dropped so the refetch cannot simply
    //    hand back the same bytes that just failed to decode. Only the captured
    //    owner's own row is touched: switching Desktop never lets A's retry
    //    invalidate B's cache.
    let mut meta = with_db(&state, |db| db.thumbnail_meta(&instance, &id))?;
    if force.unwrap_or(false) {
        if let Some(m) = &meta {
            if !m.path.is_empty() {
                if let Some(path)=managed_thumbnail_path(&cache,&instance,&id,&m.path) {let _=std::fs::remove_file(path);}
            }
        }
        with_db(&state, |db| db.clear_thumbnail_meta(&instance, &id))?;
        meta = None;
    } else if let Some(m) = &meta {
        if !m.etag.is_empty() && managed_thumbnail_path(&cache,&instance,&id,&m.path).is_some() {
            // R6: a legacy `.img` cache file migrates IN PLACE to its sniffed
            // real suffix before serving. Owner + asset + etag are preserved
            // and no network is involved. If the DB update fails after the
            // rename, the file is rolled back so the valid cache survives.
            let mut served = m.clone();
            if let Some(new_path) = migrate_legacy_thumb(m) {
                let ok = with_db(&state, |db| {
                    db.set_thumbnail(&instance, &id, &new_path, &m.etag, &m.mime, m.w, m.h)
                })
                .is_ok();
                if ok {
                    served.path = new_path;
                } else {
                    let _ = std::fs::rename(&new_path, &m.path);
                }
            }
            owner.verify(&state)?;
            with_db(&state, |db| {if db.asset_version(&instance,&id)?!=captured_version {return Err("CONTENT_VERSION_CHANGED".into());}db.touch_thumbnail(&instance, &id)?;evict_thumbnail_rows(db,&cache,&instance,64*1024*1024,Some(&id))?;Ok(())})?;
            return Ok(thumb_json(&served.path, &served.etag, &served.mime, served.w, served.h));
        }
    }

    // 2) fetch with revalidation; 404 clears stale local cache
    // A forced retry must not revalidate with the etag of the bytes that just
    // failed to decode (a 304 would return the same bad file).
    let etag = if force.unwrap_or(false) {
        String::new()
    } else {
        meta.as_ref().map(|m| m.etag.clone()).unwrap_or_default()
    };
    let (bytes, resp_etag, mime) = match owner
        .fetch(&state, &id, if etag.is_empty() { None } else { Some(&etag) })
        .await
    {
        Ok(v) => v,
        Err(e) if e.contains("404") => {
            if let Some(m) = &meta {
                if !m.path.is_empty() {
                    if let Some(path)=managed_thumbnail_path(&cache,&instance,&id,&m.path) {let _=std::fs::remove_file(path);}
                }
            }
            let _ = with_db(&state, |db| db.clear_thumbnail_meta(&instance, &id));
            return Err(e);
        }
        Err(e) => return Err(e),
    };
    let mime = if mime.is_empty() { "image/png".to_string() } else { mime };

    // The captured owner must still be the live Desktop before these bytes are
    // committed to A's page: an A-to-B switch mid-flight must not land a
    // different Desktop's thumbnail on A's page.
    owner.verify(&state)?;

    if with_db(&state,|db|db.asset_version(&instance,&id))?!=captured_version {return Err("CONTENT_VERSION_CHANGED".into());}

    if bytes.is_empty() {
        // 304 Not Modified: keep existing cache (never rewrite)
        if let Some(m) = &meta {
            if managed_thumbnail_path(&cache,&instance,&id,&m.path).is_some() {
                with_db(&state, |db| db.touch_thumbnail(&instance, &id))?;
                return Ok(thumb_json(&m.path, &m.etag, &m.mime, m.w, m.h));
            }
        }
        return Err("thumbnail: 304 but no local cache".into());
    }

    // 404 was surfaced by fetch_thumbnail as Err -> clear stale cache below.
    if bytes.len() > THUMBNAIL_MAX_BYTES {
        return Err(format!("thumbnail too large ({} bytes, max {THUMBNAIL_MAX_BYTES})", bytes.len()));
    }

    // R6: the cache file carries the sniffed REAL suffix, so an old WebView
    // can identify the image. The HTTP MIME is recorded in the DB row as
    // metadata; the suffix decision is the bytes' alone.
    let dest = cache.join(thumb_cache_name(&instance, &id, &resp_etag, &bytes));
    atomic_write(&dest, &bytes)?;
    let dims = image_dimensions(&bytes);
    with_db(&state, |db| {
        if db.asset_version(&instance,&id)?!=captured_version {return Err("CONTENT_VERSION_CHANGED".into());}
        db.set_thumbnail(&instance, &id, dest.to_str().unwrap_or(""), &resp_etag, &mime, dims.0, dims.1)
    })?;
    // Superseded derived pixels cannot accumulate outside the DB LRU. The
    // exact previous owned file is disposable; originals/other owners are not.
    if let Some(previous)=meta.as_ref().and_then(|m|managed_thumbnail_path(&cache,&instance,&id,&m.path)) {
        if previous!=dest {let _=std::fs::remove_file(previous);}
    }
    with_db(&state,|db|evict_thumbnail_rows(db,&cache,&instance,64*1024*1024,Some(&id)))?;
    Ok(thumb_json(dest.to_str().unwrap_or(""), &resp_etag, &mime, dims.0, dims.1))
}

fn thumb_json(path: &str, etag: &str, mime: &str, w: i64, h: i64) -> serde_json::Value {
    serde_json::json!({
        "uri": path, "etag": etag, "mime": mime, "w": w, "h": h,
    })
}

// LRU eviction: remove oldest thumbnail files until under a size budget.
#[tauri::command]
async fn thumbnail_evict(state: State<'_, SharedState>, app: tauri::AppHandle, budget_bytes: u64) -> Result<serde_json::Value, String> {
    let instance = {
        let g = state.lock().unwrap();
        let db = g.db.lock().unwrap();
        db.paired()?.map(|p| p.instance_id)
    };
    let Some(instance) = instance else { return Ok(serde_json::json!({"evicted": 0})); };
    let cache = app.path().app_cache_dir().map_err(|e| format!("cache dir: {e}"))?;
    with_db(&state,|db|evict_thumbnail_rows(db,&cache,&instance,budget_bytes.min(64*1024*1024),None))
}

fn managed_thumbnail_path(cache:&std::path::Path,instance:&str,id:&str,path:&str)->Option<std::path::PathBuf> {
    let root=cache.canonicalize().ok()?;
    let path=std::path::PathBuf::from(path).canonicalize().ok()?;
    let name=path.file_name()?.to_str()?;
    if path.parent()!=Some(root.as_path()) || !name.starts_with(&format!("thumb-{instance}-{id}-")) || ![".jpg",".jpeg",".png",".webp",".avif",".img"].iter().any(|suffix|name.ends_with(suffix)) {return None;}
    Some(path)
}

fn evict_thumbnail_rows(db:&Db,cache:&std::path::Path,instance:&str,budget_bytes:u64,keep:Option<&str>)->Result<serde_json::Value,String> {
    let rows=db.thumbnails_lru(instance)?;
    let mut total: u64 = 0;
    let mut count=0usize;
    let mut evicted = 0usize;
    for (id, path) in &rows {
        if let Some(path)=managed_thumbnail_path(cache,instance,id,path) {
        if let Ok(md) = std::fs::metadata(path) {
            total += md.len();
            count+=1;
        }
        }
    }
    for (id, path) in &rows {
        if total <= budget_bytes && count<=512 {
            break;
        }
        if keep==Some(id.as_str()) {continue;}
        if let Some(path)=managed_thumbnail_path(cache,instance,id,path) {
        if let Ok(md) = std::fs::metadata(&path) {
            if std::fs::remove_file(path).is_ok() {
                total=total.saturating_sub(md.len());count-=1;db.clear_thumbnail_meta(instance,id)?;evicted+=1;
            }
        }
        }
    }
    Ok(serde_json::json!({ "evicted": evicted, "remaining_bytes": total }))
}


fn atomic_write(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("write tmp: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("rename: {e}"))
}

// MATERIAL-LIBRARY-INSTANT-R1 PHYSICAL-REPAIR-R6 (3) — the thumbnail FORMAT
// AUTHORITY.
//
// The Desktop returns thumbnail bytes plus a Content-Type, but every cache
// file used to be written as `thumb-*.img`. On the MI 8's old WebView a file
// served through the asset/convertFileSrc bridge with a blind `.img` name can
// fail the image sniff and render grey/blank. This narrow authority decides
// the cache-file suffix from the REAL bytes:
//
//   - the magic bytes identify PNG / JPEG / WebP / AVIF-family;
//   - when the magic and the HTTP MIME disagree, the BYTES win — a mislabelled
//     response must not rename a JPEG into `.webp`;
//   - the raw MIME string is NEVER used as a filename, and an unknown payload
//     keeps the `.img` suffix rather than guessing one;
//   - other HEIF brands (heic/heix/…) are real formats but are not in the
//     sanctioned extension vocabulary, so they also stay `.img` (no guess).
//
// No second cache, no image decoding, no new dependency: sniffing is a handful
// of byte comparisons, and everything downstream (owner fence, LRU, ETag,
// one bad-cache retry) is unchanged.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ThumbFormat {
    Png,
    Jpeg,
    Webp,
    Avif,
    Unknown,
}

/// Identify the real image format from the payload's magic bytes.
pub(crate) fn sniff_thumb_format(bytes: &[u8]) -> ThumbFormat {
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if bytes.len() >= 8
        && bytes[0] == 0x89
        && bytes[1] == 0x50
        && bytes[2] == 0x4E
        && bytes[3] == 0x47
        && bytes[4] == 0x0D
        && bytes[5] == 0x0A
        && bytes[6] == 0x1A
        && bytes[7] == 0x0A
    {
        return ThumbFormat::Png;
    }
    // JPEG: FF D8 FF
    if bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
        return ThumbFormat::Jpeg;
    }
    // WebP: "RIFF" <size:4> "WEBP"
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return ThumbFormat::Webp;
    }
    // ISO base media container: <size:4> "ftyp" <major brand:4>. AVIF/AVIS
    // brands are the AVIF family; other HEIF brands stay Unknown on purpose.
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        let brand = &bytes[8..12];
        if brand == b"avif" || brand == b"avis" {
            return ThumbFormat::Avif;
        }
    }
    ThumbFormat::Unknown
}

/// The safe cache-file suffix for these bytes. Unknown payloads keep `.img`
/// (the honest answer when the bytes cannot be identified).
pub(crate) fn thumb_extension(bytes: &[u8]) -> &'static str {
    match sniff_thumb_format(bytes) {
        ThumbFormat::Png => ".png",
        ThumbFormat::Jpeg => ".jpg",
        ThumbFormat::Webp => ".webp",
        ThumbFormat::Avif => ".avif",
        ThumbFormat::Unknown => ".img",
    }
}

/// The cache-file name for a thumbnail: owner + asset + etag, plus the
/// sniffed REAL suffix. A forced retry passes an empty etag (it must not
/// revalidate against the bytes that just failed to decode), so the name is
/// etag-suffixed but always byte-typed.
pub(crate) fn thumb_cache_name(instance: &str, id: &str, etag: &str, bytes: &[u8]) -> String {
    format!(
        "thumb-{instance}-{id}-{}{}",
        etag.replace('"', "").chars().map(|c|if c.is_ascii_alphanumeric()||matches!(c,'-'|'_'|'.') {c} else {'_'}).collect::<String>(),
        thumb_extension(bytes)
    )
}

/// Migrate a legacy `.img` cache file to its sniffed REAL suffix, in place.
///
/// Returns `Some(new_path)` when the file was renamed (the caller then updates
/// the DB row, keeping owner + asset + etag + mime + dims). Returns `None`
/// when nothing was migrated — unknown bytes, a non-legacy name, or any I/O
/// failure — and in every `None` case the ORIGINAL FILE IS INTACT, so the
/// previously valid cache keeps serving. No network is involved at any point.
pub(crate) fn migrate_legacy_thumb(meta: &crate::db::ThumbMeta) -> Option<String> {
    let path = std::path::Path::new(&meta.path);
    // Only the legacy cache generation uses the blind `.img` suffix.
    if path.extension().and_then(|e| e.to_str()) != Some("img") {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    let ext = thumb_extension(&bytes);
    if ext == ".img" {
        // Unknown payload: never rename into a guess.
        return None;
    }
    let dest = path.with_extension(&ext[1..]);
    if dest == path {
        return None;
    }
    // Same-directory rename is atomic. A stale leftover from an earlier
    // interrupted migration is cleared first (Windows rename refuses to
    // overwrite; on Linux this is a no-op when absent).
    if dest.exists() {
        let _ = std::fs::remove_file(&dest);
    }
    std::fs::rename(path, &dest).ok()?;
    Some(dest.to_str()?.to_string())
}

fn image_dimensions(bytes: &[u8]) -> (i64, i64) {
    if bytes.len() < 24 {
        return (0, 0);
    }
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    if bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4E && bytes[3] == 0x47
        && bytes[4] == 0x0D && bytes[5] == 0x0A && bytes[6] == 0x1A && bytes[7] == 0x0A
    {
        let w = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
        let h = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
        return (w as i64, h as i64);
    }
    // JPEG: FF D8
    if bytes[0] == 0xFF && bytes[1] == 0xD8 {
        let mut i = 2usize;
        while i + 9 < bytes.len() {
            if bytes[i] != 0xFF {
                i += 1;
                continue;
            }
            let marker = bytes[i + 1];
            if marker == 0xC0 || marker == 0xC2 {
                let h = u16::from_be_bytes([bytes[i + 5], bytes[i + 6]]);
                let w = u16::from_be_bytes([bytes[i + 7], bytes[i + 8]]);
                return (w as i64, h as i64);
            }
            let seg = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
            i += 2 + seg;
        }
    }
    (0, 0)
}
#[tauri::command]
async fn asset_file(state: State<'_, SharedState>, app: tauri::AppHandle, id: String) -> Result<String, String> {
    let (paired, gw) = require_paired(&state)?;
    let instance = paired.instance_id;
    let cache = app.path().app_cache_dir().map_err(|e| format!("cache dir: {e}"))?;
    std::fs::create_dir_all(&cache).map_err(|e| format!("mkdir: {e}"))?;
    let dest = cache.join(format!("file-{instance}-{id}.bin"));
    let client = gw;
    let resp = client
        .client_req()?
        .get(format!("{}/v1/assets/{id}/file", client.base_url()))
        .header("Authorization", format!("Bearer {}", client.token()))
        .send()
        .await
        .map_err(|e| format!("file download: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("file http {status}"));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("body: {e}"))?;
    std::fs::write(&dest, &bytes).map_err(|e| format!("write: {e}"))?;
    Ok(format!("{} bytes -> {}", bytes.len(), dest.display()))
}

// ---------------------------------------------------------------------------
// Knowledge (notes)
// ---------------------------------------------------------------------------

#[tauri::command]
async fn notes_list(state: State<'_, SharedState>) -> Result<serde_json::Value, String> {
    let instance = {
        let g = state.lock().unwrap();
        let db = g.db.lock().unwrap();
        db.paired()?.map(|p| p.instance_id)
    };
    let Some(instance) = instance else {
        return Ok(serde_json::json!([]));
    };
    let rows = with_db(&state, |db| db.list_notes(&instance))?;
    let items: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| {
            serde_json::json!({
                "noteId": r.id, "title": r.title, "relativePath": r.path,
                "instanceId": instance, "vaultId": r.vault_id,
                "revision": r.revision, "updatedAt": r.updated_at, "dirty": r.dirty,
            })
        })
        .collect();
    Ok(serde_json::json!(items))
}

#[tauri::command]
async fn note_get(state: State<'_, SharedState>, id: String) -> Result<serde_json::Value, String> {
    let instance = {
        let g = state.lock().unwrap();
        let db = g.db.lock().unwrap();
        db.paired()?.map(|p| p.instance_id)
    };
    let Some(instance) = instance else {
        return Err("not paired".into());
    };
    let row = with_db(&state, |db| db.get_note(&instance, &id))?.ok_or("note not found")?;
    let content = with_db(&state, |db| db.get_note_content(&instance, &id))?.unwrap_or_default();
    Ok(serde_json::json!({
        "noteId": row.id, "title": row.title, "relativePath": row.path,
        "content": content, "revision": row.revision, "updatedAt": row.updated_at, "dirty": row.dirty,
    }))
}

#[tauri::command]
async fn note_refresh(state: State<'_, SharedState>, id: String) -> Result<serde_json::Value, String> {
    let (paired, gw) = require_paired(&state)?;
    let instance = paired.instance_id;
    let doc = gw.note(&id).await?;
    with_db(&state, |db| {
        db.upsert_note(
            &instance, &id,
            doc["title"].as_str().unwrap_or(""),
            doc["relativePath"].as_str().unwrap_or(""),
            doc["content"].as_str().unwrap_or(""),
            doc["revision"].as_str().unwrap_or(""),
            doc["updatedAt"].as_str().unwrap_or(""),
        )
    })?;
    Ok(doc)
}

/// Save note via expectedRevision; conflict surfaces as ERROR_REVISION_CONFLICT.
#[tauri::command]
async fn note_update(
    state: State<'_, SharedState>,
    id: String,
    expectedRevision: String,
    content: String,
    title: String,
) -> Result<serde_json::Value, String> {
    let (paired, gw) = require_paired(&state)?;
    let instance = paired.instance_id;
    let res = gw.note_update(&id, &expectedRevision, &content, &title).await?;
    let new_rev = res["revision"].as_str().unwrap_or(&expectedRevision);
    with_db(&state, |db| db.mark_note_synced(&instance, &id, new_rev))?;
    Ok(res)
}

/// Offline edit: mark dirty locally, keep base_revision for later 409 reconciliation.
#[tauri::command]
async fn note_local_edit(state: State<'_, SharedState>, id: String, title: String, content: String) -> Result<String, String> {
    let instance = {
        let g = state.lock().unwrap();
        let db = g.db.lock().unwrap();
        db.paired()?.map(|p| p.instance_id)
    };
    let Some(instance) = instance else {
        return Err("not paired".into());
    };
    with_db(&state, |db| db.apply_local_note_edit(&instance, &id, &title, &content))?;
    Ok("saved locally (dirty)".into())
}

// ---------------------------------------------------------------------------
// Capture outbox (offline-first)
// ---------------------------------------------------------------------------

fn now_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let base: u64 = 1783440000; // ~2026-08-07T00:00:00Z
    let offset = secs.saturating_sub(base);
    format!("2026-08-07T00:00:{:02}Z", (offset % 60))
}

/// A gateway acknowledgement is durable before an app-private attachment is
/// removed. If Android terminates the process between those operations, the
/// completed row remains discoverable and this cleanup simply retries on the
/// next startup/flush. Non-managed paths are deliberately retained rather than
/// trusting SQLite metadata to delete an arbitrary file.
fn cleanup_completed_capture_attachments(db: &Db) -> Result<usize, String> {
    let attachments = db.list_completed_attachments()?;
    let mut removed = 0usize;
    for attachment in attachments {
        if capture_media::remove_private_attachment_if_managed(&attachment.local_path)? {
            db.delete_attachment(&attachment.op_id, &attachment.ref_id)?;
            removed += 1;
        }
    }
    Ok(removed)
}

#[tauri::command]
async fn capture_add(state: State<'_, SharedState>, kind: String, text: String, link: String) -> Result<serde_json::Value, String> {
    let instance = {
        let g = state.lock().unwrap();
        let db = g.db.lock().unwrap();
        db.paired()?.map(|p| p.instance_id)
    };
    let Some(instance) = instance else {
        return Err("not paired".into());
    };
    let op_id = Uuid::new_v4().to_string();
    let payload = serde_json::json!({
        "opId": op_id,
        "type": kind,
        "createdAt": now_iso(),
        "payload": { "text": text, "link": link },
        "attachmentRefs": [],
        "state": "pending",
        "attemptCount": 0,
    });
    with_db(&state, |db| db.enqueue_capture(&instance, &op_id, &kind, &payload.to_string()))?;
    Ok(payload)
}

// Pick an image / take a photo / pick a file via the platform adapter,
// copy into the private outbox area, enqueue a capture with attachment metadata.
#[tauri::command]
async fn capture_pick(state: State<'_, SharedState>, kind: String) -> Result<serde_json::Value, String> {
    let instance = {
        let g = state.lock().unwrap();
        let db = g.db.lock().unwrap();
        db.paired()?.map(|p| p.instance_id)
    };
    let Some(instance) = instance else {
        return Err("not paired".into());
    };
    let kind_idx = match kind.as_str() {
        "photo" => 1i32,
        "file" => 2i32,
        _ => 0i32, // image
    };
    let media = match capture_media::pick(kind_idx, 300_000) {
        Ok(media) => media,
        Err(error) if capture_media::is_user_cancelled_error(&error) => {
            return Ok(serde_json::json!({ "cancelled": true }))
        }
        Err(error) => return Err(error),
    };
    let op_id = Uuid::new_v4().to_string();
    let payload = serde_json::json!({
        "opId": op_id,
        "type": media.kind.clone(),
        "createdAt": now_iso(),
        "payload": { "text": "", "link": "" },
        "attachmentRefs": [{
            "refId": media.ref_id,
            "kind": media.kind,
            "fileName": media.file_name,
            "sizeBytes": media.size_bytes,
            "sha256": media.sha256,
        }],
        "state": "pending",
        "attemptCount": 0,
    });
    with_db(&state, |db| {
        db.enqueue_capture_with_attachment(
            &instance,
            &op_id,
            &media.kind,
            &payload.to_string(),
            &media.ref_id,
            &media.kind,
            &media.file_name,
            media.size_bytes as i64,
            &media.sha256,
            &media.local_uri,
        )
    })?;
    Ok(payload)
}

#[tauri::command]
async fn capture_list(state: State<'_, SharedState>) -> Result<serde_json::Value, String> {
    let instance = {
        let g = state.lock().unwrap();
        let db = g.db.lock().unwrap();
        db.paired()?.map(|p| p.instance_id)
    };
    let Some(instance) = instance else {
        return Ok(serde_json::json!([]));
    };
    let rows = with_db(&state, |db| db.list_outbox(&instance))?;
    let items: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| {
            serde_json::json!({
                "opId": r.op_id, "kind": r.kind,
                "payload": serde_json::from_str::<serde_json::Value>(&r.payload).unwrap_or_default(),
                "state": r.state, "attemptCount": r.attempt, "lastError": r.error,
            })
        })
        .collect();
    Ok(serde_json::json!(items))
}

/// Push one locally claimed outbox item. A durable `uploading` state is written
/// before any network I/O, so a process death can requeue the same opId on the
/// next database open without silently losing or duplicating the capture.
async fn flush_outbox_row(
    state: &SharedState,
    gateway: &GatewayClient,
    row: &db::OutboxRow,
) -> Result<serde_json::Value, String> {
    with_db(state, |db| db.outbox_begin_upload(&row.op_id))?;

    let result = async {
        let op: serde_json::Value = serde_json::from_str(&row.payload)
            .map_err(|e| format!("capture payload corrupt: {e}"))?;
        let attachments = with_db(state, |db| db.list_attachments(&row.op_id))?;
        for attachment in &attachments {
            let local_path = attachment["localPath"]
                .as_str()
                .ok_or("attachment missing local path")?;
            let size_bytes = attachment["sizeBytes"]
                .as_i64()
                .ok_or("attachment size metadata invalid")?;
            let expected_sha256 = attachment["sha256"]
                .as_str()
                .ok_or("attachment sha256 metadata missing")?;
            capture_media::validate_attachment_file(local_path, size_bytes, expected_sha256)?;

            let server_sha = gateway
                .upload_attachment(
                    &row.op_id,
                    attachment["refId"].as_str().unwrap_or(""),
                    attachment["fileName"].as_str().unwrap_or("file"),
                    attachment["mime"].as_str().unwrap_or("application/octet-stream"),
                    local_path,
                )
                .await?;
            if !server_sha.is_empty() && expected_sha256 != server_sha {
                return Err(format!("attachment sha256 mismatch: {server_sha}"));
            }
        }
        gateway.capture(&op).await
    }
    .await;

    match result {
        Ok(response) => {
            with_db(state, |db| {
                db.outbox_finish_upload(&row.op_id, db::OUTBOX_COMPLETED, None)
            })?;
            if let Err(error) = with_db(state, |db| cleanup_completed_capture_attachments(db)) {
                println!("[LR] completed attachment cleanup deferred: {error}");
            }
            Ok(response)
        }
        Err(error) => {
            with_db(state, |db| {
                db.outbox_finish_upload(&row.op_id, db::OUTBOX_FAILED, Some(&error))
            })?;
            Err(error)
        }
    }
}

/// Push pending outbox items (opId idempotent on the gateway).
#[tauri::command]
async fn capture_flush(state: State<'_, SharedState>) -> Result<serde_json::Value, String> {
    let (paired, gw) = require_paired(&state)?;
    let instance = paired.instance_id;
    let rows = with_db(&state, |db| db.list_outbox(&instance))?;
    let mut pushed = 0i64;
    let mut failed = 0i64;
    for r in rows {
        if r.state == db::OUTBOX_COMPLETED || r.state == db::OUTBOX_UPLOADING {
            continue;
        }
        match flush_outbox_row(&state, &gw, &r).await {
            Ok(_) => {
                pushed += 1;
            }
            Err(_) => {
                failed += 1;
            }
        }
    }
    Ok(serde_json::json!({ "pushed": pushed, "failed": failed }))
}

#[tauri::command]
async fn capture_retry(state: State<'_, SharedState>, opId: String) -> Result<serde_json::Value, String> {
    let (paired, gw) = require_paired(&state)?;
    let row = {
        let g = state.lock().unwrap();
        let db = g.db.lock().unwrap();
        db.list_outbox(&paired.instance_id)?.into_iter().find(|r| r.op_id == opId)
    };
    let Some(row) = row else {
        return Err("outbox item not found".into());
    };
    flush_outbox_row(&state, &gw, &row).await
}

// ---------------------------------------------------------------------------
// Local Inbox (M2.7 Mobile-local domain — usable with zero Desktop connection)
// ---------------------------------------------------------------------------

fn inbox_item_json(item: &db::InboxItem) -> serde_json::Value {
    serde_json::json!({
        "itemId": item.item_id,
        "kind": item.kind,
        "title": item.title,
        "text": item.text,
        "url": item.url,
        "source": item.source,
        "archived": item.archived,
        "favorite": item.favorite,
        "createdAt": item.created_at,
        "updatedAt": item.updated_at,
    })
}

fn inbox_attachment_json(a: &db::InboxAttachmentRow) -> serde_json::Value {
    serde_json::json!({
        "refId": a.ref_id,
        "kind": a.kind,
        "mime": a.mime,
        "fileName": a.file_name,
        "sizeBytes": a.size_bytes,
        "sha256": a.sha256,
        "localPath": a.local_path,
    })
}

/// List Local Inbox items newest first (kind filter / favorite / archived /
/// local search / pagination). No pairing required — the phone's own data.
#[tauri::command]
async fn local_inbox_list(
    state: State<'_, SharedState>,
    kind: Option<String>,
    q: Option<String>,
    favorite: Option<bool>,
    archived: Option<bool>,
    page: i64,
    limit: i64,
) -> Result<serde_json::Value, String> {
    let limit = if limit <= 0 { 50 } else { limit.min(200) };
    let (rows, total) = with_db(&state, |db| {
        db.inbox_query(kind.as_deref(), q.as_deref(), favorite, archived, page, limit)
    })?;
    let items: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| {
            let mut item = inbox_item_json(&r.item);
            if let Some(att) = &r.attachment {
                item["attachment"] = inbox_attachment_json(att);
            }
            item
        })
        .collect();
    Ok(serde_json::json!({ "items": items, "total": total, "hasMore": page * limit < total }))
}

#[tauri::command]
async fn local_inbox_get(state: State<'_, SharedState>, itemId: String) -> Result<serde_json::Value, String> {
    let detail = with_db(&state, |db| db.inbox_get(&itemId))?
        .ok_or("inbox item not found")?;
    Ok(serde_json::json!({
        "item": inbox_item_json(&detail.item),
        "attachments": detail.attachments.iter().map(inbox_attachment_json).collect::<Vec<_>>(),
    }))
}

/// Save a manual text/link item straight into the Local Inbox. Always local:
/// no pairing, no Desktop identity, no capture_outbox row.
#[tauri::command]
async fn local_inbox_add(
    state: State<'_, SharedState>,
    kind: String,
    text: String,
    link: String,
) -> Result<serde_json::Value, String> {
    let item_id = Uuid::new_v4().to_string();
    let (kind, text_v, url_v) = match kind.as_str() {
        "link" => ("link", String::new(), if link.is_empty() { text } else { link }),
        _ => ("text", text, String::new()),
    };
    with_db(&state, |db| db.inbox_insert(&item_id, kind, "", &text_v, &url_v, "manual"))?;
    Ok(serde_json::json!({ "itemId": item_id, "kind": kind }))
}

/// Pick an image / take a photo / pick a file and save it into the Local
/// Inbox (kind: image | photo | file). Works without pairing; the picked file
/// is moved into app-private `local-inbox/` before the durable commit.
#[tauri::command]
async fn local_inbox_add_media(
    state: State<'_, SharedState>,
    kind: String,
) -> Result<serde_json::Value, String> {
    let kind_idx = match kind.as_str() {
        "photo" => 1i32,
        "file" => 2i32,
        _ => 0i32, // image
    };
    let media = match capture_media::pick(kind_idx, 300_000) {
        Ok(media) => media,
        Err(error) if capture_media::is_user_cancelled_error(&error) => {
            return Ok(serde_json::json!({ "cancelled": true }))
        }
        Err(error) => return Err(error),
    };
    let staged = local_inbox::stage_picked_into_inbox(&media)?;
    let kind = if kind.as_str() == "photo" {
        "photo".to_string()
    } else {
        staged.kind.clone()
    };
    let item_id = Uuid::new_v4().to_string();
    with_db(&state, |db| {
        db.inbox_insert_with_attachment(
            &item_id,
            &kind,
            "",
            "",
            "",
            "picker",
            &staged.ref_id,
            &staged.kind,
            &staged.mime,
            &staged.file_name,
            staged.size_bytes as i64,
            &staged.sha256,
            &staged.local_path,
        )
    })?;
    Ok(serde_json::json!({ "itemId": item_id, "kind": kind, "fileName": staged.file_name }))
}

/// Edit safe metadata (title / text / link) of a Local Inbox item.
#[tauri::command]
async fn local_inbox_update(
    state: State<'_, SharedState>,
    itemId: String,
    title: String,
    text: String,
    url: String,
) -> Result<String, String> {
    with_db(&state, |db| db.inbox_update_meta(&itemId, &title, &text, &url))?;
    Ok("updated".into())
}

#[tauri::command]
async fn local_inbox_set_favorite(
    state: State<'_, SharedState>,
    itemId: String,
    favorite: bool,
) -> Result<String, String> {
    with_db(&state, |db| db.inbox_set_flags(&itemId, Some(favorite), None))?;
    Ok("ok".into())
}

#[tauri::command]
async fn local_inbox_set_archived(
    state: State<'_, SharedState>,
    itemId: String,
    archived: bool,
) -> Result<String, String> {
    with_db(&state, |db| db.inbox_set_flags(&itemId, None, Some(archived)))?;
    Ok("ok".into())
}

/// Delete one Local Inbox item and exactly the files its own rows own.
#[tauri::command]
async fn local_inbox_delete(state: State<'_, SharedState>, itemId: String) -> Result<String, String> {
    let paths = with_db(&state, |db| db.inbox_delete(&itemId))?;
    // Best-effort file removal after the durable commit; a crash in between
    // leaves only unreferenced files that startup reconciliation reclaims.
    let _ = local_inbox::erase_inbox_files(&paths);
    Ok("deleted".into())
}

#[tauri::command]
async fn local_inbox_stats(state: State<'_, SharedState>) -> Result<serde_json::Value, String> {
    with_db(&state, |db| db.inbox_stats())
}

/// Explicit destructive "erase my local content" — separate from reset_full,
/// which preserves the Local Inbox. Confirmed twice by the UI before calling.
#[tauri::command]
async fn local_inbox_erase_all(state: State<'_, SharedState>) -> Result<String, String> {
    let paths = with_db(&state, |db| db.inbox_erase_all())?;
    let removed = local_inbox::erase_inbox_files(&paths)?;
    Ok(format!("local inbox erased ({removed} files)"))
}

/// Ingest pending Android share metas (ACTION_SEND) into the Local Inbox.
/// Called on cold start (setup), on `lr:local-share` events, and defensively
/// from the UI after mount. Idempotent by share digest. After ingestion the
/// Local Inbox file domain is reconciled immediately, so a warm-runtime dedup
/// (same digest within the 1 h SQLite window but after the 60 s Kotlin window)
/// cannot leave the just-staged `att-*` file unowned until the next restart.
#[tauri::command]
async fn local_inbox_ingest_shares(state: State<'_, SharedState>) -> Result<serde_json::Value, String> {
    let consumed = with_db(&state, |db| local_inbox::reconcile_pending_shares(db))?;
    let paths = with_db(&state, |db| db.inbox_attachment_paths())?;
    let reconciled = local_inbox::cleanup_unreferenced_inbox_files(&paths)?;
    Ok(serde_json::json!({ "consumed": consumed, "reconciled": reconciled }))
}

// ---------------------------------------------------------------------------
// Local Note & Unified Search (M2.8 Mobile-local Knowledge domain)
// ---------------------------------------------------------------------------

#[tauri::command]
async fn local_note_list(
    state: State<'_, SharedState>,
    q: Option<String>,
    tag: Option<String>,
    pinned: Option<bool>,
    favorite: Option<bool>,
    archived: Option<bool>,
    page: i64,
    limit: i64,
    sort: Option<String>,
    folder: Option<String>,
) -> Result<serde_json::Value, String> {
    let limit = if limit <= 0 { 50 } else { limit.min(200) };
    // The sort vocabulary is bounded to what this list actually offers; the
    // authority applies it BEFORE LIMIT/OFFSET so a name sort covers the
    // whole library rather than the already-loaded pages.
    let sort = match sort.as_deref() {
        Some("name") => Some("name"),
        _ => Some("recent"),
    };
    let (items, total) = with_db(&state, |db| {
        db.note_query_in_folder(q.as_deref(), tag.as_deref(), pinned, favorite, archived, page, limit, sort, folder.as_deref())
    })?;
    Ok(serde_json::json!({ "items": items, "total": total, "hasMore": page * limit < total }))
}

#[tauri::command]
async fn local_note_folders(state: State<'_, SharedState>) -> Result<serde_json::Value, String> {
    let paths = with_db(&state, |db| db.note_folders())?;
    Ok(serde_json::json!({ "paths": paths }))
}

#[tauri::command]
async fn local_note_create_folder(
    state: State<'_, SharedState>, name: String, parent: Option<String>,
) -> Result<serde_json::Value, String> {
    let path = with_db(&state, |db| db.note_create_folder(&name, parent.as_deref().unwrap_or("")))?;
    Ok(serde_json::json!({ "path": path }))
}

#[tauri::command]
async fn local_note_set_folder(
    state: State<'_, SharedState>, noteId: String, folder: String,
) -> Result<serde_json::Value, String> {
    let note = with_db(&state, |db| {
        db.note_set_folder(&noteId, &folder)?;
        db.note_get(&noteId)?.ok_or_else(|| "local note not found".to_string())
    })?;
    serde_json::to_value(note).map_err(|e| format!("serialize note: {e}"))
}

/// Every distinct tag on the Local Note tag authority (bounded, stable
/// order). The knowledge filter picker needs the AUTHORITY vocabulary, not
/// the tags visible on the currently loaded page.
#[tauri::command]
async fn local_note_tags(state: State<'_, SharedState>) -> Result<serde_json::Value, String> {
    let tags = with_db(&state, |db| db.note_tag_vocabulary(100))?;
    Ok(serde_json::json!({ "tags": tags }))
}
#[tauri::command]
async fn local_note_get(
    state: State<'_, SharedState>,
    noteId: String,
) -> Result<serde_json::Value, String> {
    let note = with_db(&state, |db| db.note_get(&noteId))?.ok_or("local note not found")?;
    Ok(serde_json::to_value(&note).map_err(|e| format!("serialize note: {e}"))?)
}

#[tauri::command]
async fn local_note_add(
    state: State<'_, SharedState>,
    title: String,
    content: String,
    tags: Vec<String>,
    folder: Option<String>,
) -> Result<serde_json::Value, String> {
    let note_id = format!("note-{}", Uuid::new_v4().simple());
    with_db(&state, |db| {
        db.note_insert_in_folder(&note_id, &title, &content, &tags, None, folder.as_deref().unwrap_or(""))
    })?;
    let note = with_db(&state, |db| db.note_get(&note_id))?.ok_or("created note not found")?;
    Ok(serde_json::to_value(&note).map_err(|e| format!("serialize note: {e}"))?)
}

#[tauri::command]
async fn local_note_update(
    state: State<'_, SharedState>,
    noteId: String,
    title: String,
    content: String,
    tags: Vec<String>,
) -> Result<serde_json::Value, String> {
    with_db(&state, |db| {
        db.note_update(&noteId, &title, &content, &tags)
    })?;
    let note = with_db(&state, |db| db.note_get(&noteId))?.ok_or("updated note not found")?;
    Ok(serde_json::to_value(&note).map_err(|e| format!("serialize note: {e}"))?)
}

#[tauri::command]
async fn local_note_set_flags(
    state: State<'_, SharedState>,
    noteId: String,
    pinned: Option<bool>,
    favorite: Option<bool>,
    archived: Option<bool>,
) -> Result<String, String> {
    with_db(&state, |db| {
        db.note_set_flags(&noteId, pinned, favorite, archived)
    })?;
    Ok("ok".into())
}

#[tauri::command]
async fn local_note_delete(
    state: State<'_, SharedState>,
    noteId: String,
) -> Result<String, String> {
    with_db(&state, |db| db.note_delete(&noteId))?;
    Ok("deleted".into())
}

#[tauri::command]
async fn local_note_stats(
    state: State<'_, SharedState>,
) -> Result<serde_json::Value, String> {
    with_db(&state, |db| db.note_stats())
}

#[tauri::command]
async fn local_note_erase_all(
    state: State<'_, SharedState>,
) -> Result<String, String> {
    let count = with_db(&state, |db| db.note_erase_all())?;
    Ok(format!("local notes erased ({count} notes)"))
}

#[tauri::command]
async fn local_note_convert_inbox(
    state: State<'_, SharedState>,
    inboxId: String,
) -> Result<serde_json::Value, String> {
    let new_note_id = format!("note-{}", Uuid::new_v4().simple());
    let note = with_db(&state, |db| {
        db.convert_inbox_to_note(&inboxId, &new_note_id)
    })?;
    Ok(serde_json::to_value(&note).map_err(|e| format!("serialize note: {e}"))?)
}

#[tauri::command]
async fn unified_local_search(
    state: State<'_, SharedState>,
    q: String,
    page: i64,
    limit: i64,
) -> Result<serde_json::Value, String> {
    let limit = if limit <= 0 { 50 } else { limit.min(200) };
    let (results, total) = with_db(&state, |db| {
        db.unified_local_search(&q, page, limit)
    })?;
    Ok(serde_json::json!({
        "results": results,
        "total": total,
        "hasMore": page * limit < total,
    }))
}

// ---------------------------------------------------------------------------
// Local Asset Library (M2.9 Mobile-local Library domain — usable with zero
// Desktop connection)
// ---------------------------------------------------------------------------

/// List Local Assets newest first (kind / tag / favorite / archive filters,
/// local search over display name + tags + MIME/kind, pagination). No pairing
/// required — the phone's own durable materials.
#[tauri::command]
async fn local_asset_list(
    state: State<'_, SharedState>,
    kind: Option<String>,
    q: Option<String>,
    tag: Option<String>,
    favorite: Option<bool>,
    archived: Option<bool>,
    page: i64,
    limit: i64,
    sort: Option<String>,
) -> Result<serde_json::Value, String> {
    let limit = if limit <= 0 { 50 } else { limit.min(200) };
    // The sort vocabulary is bounded to what the library offers; the authority
    // applies it BEFORE LIMIT/OFFSET so name/size order covers the whole
    // library rather than the already-loaded pages.
    let sort = match sort.as_deref() {
        Some("name") => Some("name"),
        Some("size") => Some("size"),
        _ => Some("recent"),
    };
    let (items, total) = with_db(&state, |db| {
        db.asset_query(kind.as_deref(), q.as_deref(), tag.as_deref(), favorite, archived, page, limit, sort)
    })?;
    Ok(serde_json::json!({ "items": items, "total": total, "hasMore": page * limit < total }))
}

#[tauri::command]
async fn local_asset_get(
    state: State<'_, SharedState>,
    assetId: String,
) -> Result<serde_json::Value, String> {
    let asset = with_db(&state, |db| db.asset_get(&assetId))?.ok_or("local asset not found")?;
    Ok(serde_json::to_value(&asset).map_err(|e| format!("serialize asset: {e}"))?)
}

/// Direct import into the Local Library (image / video / file). No Desktop
/// involved: the picker result is copied into app-private `local-assets/`
/// (staging -> fsync -> size/SHA-256 verify -> atomic rename -> DB commit).
/// Cancellation leaves no visible asset or orphan; an interrupted import
/// leaves only unowned staging/original files that reconciliation reclaims.
#[tauri::command]
async fn local_asset_import(
    state: State<'_, SharedState>,
    kind: String,
) -> Result<serde_json::Value, String> {
    let kind_idx = match kind.as_str() {
        "video" => 3i32,
        "file" => 2i32,
        _ => 0i32, // image
    };
    let media = match capture_media::pick(kind_idx, 300_000) {
        Ok(media) => media,
        Err(error) if capture_media::is_user_cancelled_error(&error) => {
            return Ok(serde_json::json!({ "cancelled": true }))
        }
        Err(error) => return Err(error),
    };
    let staged = local_asset::stage_picked_into_assets(&media)?;
    let asset_id = staged.asset_id.clone();
    let asset_kind = db::Db::asset_kind_for_mime(&staged.mime);
    with_db(&state, |db| {
        db.asset_insert(
            &asset_id,
            &asset_kind,
            &staged.file_name,
            &staged.mime,
            staged.size_bytes as i64,
            &staged.sha256,
            &staged.local_path,
            "direct_import",
            None,
            &[],
        )
    })?;
    // The picker staging copy in capture-outbox is transient; drop it now that
    // the managed original is committed. A crash before this point leaves it
    // unowned and the startup capture-outbox reconciliation reclaims it.
    let _ = capture_media::remove_private_attachment_if_managed(&media.local_uri);
    let asset = with_db(&state, |db| db.asset_get(&asset_id))?.ok_or("imported asset not found")?;
    Ok(serde_json::to_value(&asset).map_err(|e| format!("serialize asset: {e}"))?)
}

/// Rename a Local Asset and replace its tags. Identity, kind, mime, size,
/// hash, original path and provenance never change.
#[tauri::command]
async fn local_asset_update(
    state: State<'_, SharedState>,
    assetId: String,
    name: String,
    tags: Vec<String>,
) -> Result<serde_json::Value, String> {
    with_db(&state, |db| db.asset_update(&assetId, &name, &tags))?;
    let asset = with_db(&state, |db| db.asset_get(&assetId))?.ok_or("updated asset not found")?;
    Ok(serde_json::to_value(&asset).map_err(|e| format!("serialize asset: {e}"))?)
}

/// Every distinct tag on the Local Asset tag authority (bounded, stable
/// order). The library filter picker needs the AUTHORITY vocabulary, not the
/// tags that happen to sit on the currently loaded page.
#[tauri::command]
async fn local_asset_tags(state: State<'_, SharedState>) -> Result<serde_json::Value, String> {
    let tags = with_db(&state, |db| db.asset_tag_vocabulary(100))?;
    Ok(serde_json::json!({ "tags": tags }))
}
#[tauri::command]
async fn local_asset_set_flags(
    state: State<'_, SharedState>,
    assetId: String,
    favorite: Option<bool>,
    archived: Option<bool>,
) -> Result<String, String> {
    with_db(&state, |db| db.asset_set_flags(&assetId, favorite, archived))?;
    Ok("ok".into())
}

/// Delete one Local Asset and exactly the managed original its own row owns.
/// Rows are removed first; a crash between commit and file removal leaves an
/// unreferenced `asset-*` file that reconciliation reclaims (never an owned
/// file, never a Local Inbox / capture-outbox file). The asset's derived
/// thumbnail (disposable cache) is removed together with the original.
#[tauri::command]
async fn local_asset_delete(state: State<'_, SharedState>, assetId: String) -> Result<String, String> {
    let paths = with_db(&state, |db| db.asset_delete(&assetId))?;
    for p in &paths {
        let _ = local_asset::remove_asset_original_if_managed(p);
    }
    let _ = local_asset::remove_thumbnail_if_managed(&assetId);
    Ok("deleted".into())
}

#[tauri::command]
async fn local_asset_stats(state: State<'_, SharedState>) -> Result<serde_json::Value, String> {
    with_db(&state, |db| db.asset_stats())
}

/// Explicit destructive "erase my local assets" — separate from reset_full
/// (which preserves Local Assets) and from Local Inbox / Local Note erase.
/// Confirmed twice by the UI before calling. Removes the owned originals AND
/// their derived thumbnails; never touches Inbox / Notes / Desktop caches.
#[tauri::command]
async fn local_asset_erase_all(state: State<'_, SharedState>) -> Result<String, String> {
    let rows = with_db(&state, |db| db.asset_erase_all())?;
    let mut removed = 0usize;
    let mut ids = Vec::new();
    for (asset_id, path) in &rows {
        ids.push(asset_id.clone());
        if local_asset::remove_asset_original_if_managed(path)? {
            removed += 1;
        }
    }
    let thumbs = local_asset::erase_asset_thumbs(&ids)?;
    Ok(format!("local assets erased ({removed} originals, {thumbs} thumbnails)"))
}

/// Bounded read-only integrity status for one Local Asset original
/// (FIX-V1 P1-1). `verifyHash` runs the streaming SHA-256 comparison; when
/// false the report honestly leaves `hashVerified=false`. Never deletes the
/// DB row or the original; never inspects files outside the managed root.
#[tauri::command]
async fn local_asset_integrity(
    state: State<'_, SharedState>,
    assetId: String,
    verifyHash: bool,
) -> Result<serde_json::Value, String> {
    let asset = with_db(&state, |db| db.asset_get(&assetId))?.ok_or("local asset not found")?;
    let report = local_asset::check_integrity(
        &asset.local_path,
        asset.size_bytes,
        &asset.content_hash,
        verifyHash,
    )?;
    Ok(serde_json::json!({
        "assetId": asset.asset_id,
        "name": asset.name,
        "kind": asset.kind,
        "sizeBytes": asset.size_bytes,
        "exists": report.exists,
        "isFile": report.is_file,
        "sizeMatches": report.size_matches,
        "hashVerified": report.hash_verified,
        "status": report.status,
    }))
}

/// Bounded thumbnail for a Local Asset image. Derived cache under
/// `local-assets/thumbs/` (regenerated on demand, never user-owned); a
/// generation failure is an error the grid falls back to art/icon for — the
/// asset itself is never broken.
#[tauri::command]
async fn local_asset_thumbnail(
    state: State<'_, SharedState>,
    assetId: String,
    preview: Option<bool>,
    force: Option<bool>,
) -> Result<serde_json::Value, String> {
    use sha2::Digest;
    let asset = with_db(&state, |db| db.asset_get(&assetId))?.ok_or("local asset not found")?;
    if asset.kind != "image" {
        return Err("thumbnail unavailable for this kind".into());
    }
    if local_asset::check_integrity(&asset.local_path, asset.size_bytes, &asset.content_hash, false)?.status != "healthy" {
        return Err("local asset original unavailable".into());
    }
    if preview.unwrap_or(false) {
        if let Some((w,h))=local_asset::display_original_dimensions(std::path::Path::new(&asset.local_path)) {
            let original=std::path::PathBuf::from(&asset.local_path).canonicalize().map_err(|_|"local asset original unavailable")?;
            let root=local_asset::asset_root()?.join("originals").canonicalize().map_err(|_|"local asset original unavailable")?;
            if original.parent()!=Some(root.as_path()) {return Err("local asset original unavailable".into());}
            let latest=with_db(&state,|db|db.asset_get(&assetId))?.ok_or("local asset not found")?;
            if latest.content_hash!=asset.content_hash || latest.local_path!=asset.local_path {return Err("local asset changed".into());}
            return Ok(serde_json::json!({"uri":original.to_string_lossy(),"mime":asset.mime,"w":w,"h":h,"original":true}));
        }
    }
    let dest = if preview.unwrap_or(false) {
        let base=local_asset::thumb_path(&assetId)?;
        let owner=format!("{:x}",sha2::Sha256::digest(format!("local:{assetId}")));
        let key=format!("{:x}",sha2::Sha256::digest(asset.content_hash.as_bytes()));
        base.with_file_name(format!("screen-{owner}-{key}.png"))
    } else {local_asset::thumb_path(&assetId)?};
    let source=std::path::PathBuf::from(&asset.local_path);
    let output=dest.clone();
    let dims=tokio::task::spawn_blocking(move|| {
        if preview.unwrap_or(false) {return local_asset::screen_preview_cached(&source,&dest,force.unwrap_or(false));}
        local_asset::thumbnail_cached(&source,&dest,force.unwrap_or(false))
    }).await.map_err(|_|"thumbnail unavailable")??;
    let latest=with_db(&state,|db|db.asset_get(&assetId))?.ok_or("local asset not found")?;
    if latest.content_hash!=asset.content_hash || latest.local_path!=asset.local_path { return Err("local asset changed".into()); }
    Ok(serde_json::json!({
        "uri": output.to_string_lossy(),
        "mime": if preview.unwrap_or(false) {"image/png"} else {"image/jpeg"},
        "w": dims.0,
        "h": dims.1,
    }))
}

/// Local Inbox -> Local Asset promotion: copies the att-* original into the
/// independent Local Asset root (source Inbox item + attachment stay intact),
/// derives the kind from MIME, and is idempotent for repeated taps of the same
/// live Inbox item (existing promoted asset is returned).
#[tauri::command]
async fn local_asset_promote_inbox(
    state: State<'_, SharedState>,
    inboxId: String,
) -> Result<serde_json::Value, String> {
    let asset_id = format!("asset-{}", Uuid::new_v4().simple());
    let asset = with_db(&state, |db| local_asset::promote_inbox_to_asset(db, &inboxId, &asset_id))?;
    Ok(serde_json::to_value(&asset).map_err(|e| format!("serialize asset: {e}"))?)
}

/// Startup/warm orphan reconciliation for the Local Asset file root: removes
/// only transient staging files and unowned `originals/asset-*` files; never
/// touches DB-owned originals, `local-inbox/att-*`, or `capture-outbox/ref-*`.
#[tauri::command]
async fn local_asset_reconcile(state: State<'_, SharedState>) -> Result<serde_json::Value, String> {
    let reconciled = {
        let g = state.lock().unwrap();
        let db = g.db.lock().unwrap();
        local_asset::reconcile_asset_roots(&db)?
    };
    Ok(serde_json::json!({ "reconciled": reconciled }))
}

// ---------------------------------------------------------------------------
// M2.11 — Mobile Companion Storage & Export
// ---------------------------------------------------------------------------

/// Export a Mobile-owned file (Local Asset original / Local Inbox attachment)
/// into the system ecosystem: Pictures/LuckyRay, Movies/LuckyRay, or
/// Download/LuckyRay. `collection` is classified by the pure TS exportPolicy.
/// The source authority + roots come from ExportBridge (FIX-V1 P1-1):
/// managed `asset-*` / `att-*` direct children only.
/// Returns {status: created|already_exists|error, destination, displayName,
/// uri?, bytes?} — never a private filesystem path.
#[tauri::command]
async fn companion_export(
    sourcePath: String,
    displayName: String,
    mime: String,
    collection: String,
) -> Result<serde_json::Value, String> {
    companion_export::export_to_system(&sourcePath, &displayName, &mime, &collection)
}

/// Share a Mobile-owned file via ACTION_SEND with a narrow content:// grant.
#[tauri::command]
async fn companion_share_file(
    sourcePath: String,
    displayName: String,
    mime: String,
) -> Result<serde_json::Value, String> {
    companion_export::share_file_to_system(&sourcePath, &displayName, &mime)
}

/// Share plain text (Inbox text/link) via ACTION_SEND text/plain.
#[tauri::command]
async fn companion_share_text(text: String) -> Result<serde_json::Value, String> {
    companion_export::share_text_to_system(&text)
}

/// M2.13 FIX-V1 P1-D: external open of a Mobile-owned attachment/asset via a
/// narrow content:// grant (ExportBridge.openFile on Android; opener crate on
/// desktop). Replaces the plugin ACL path (`plugin:opener|open_path`), which
/// the mobile plugin bridge cannot deserialize on Android.
#[tauri::command]
async fn open_attachment(sourcePath: String, mime: String) -> Result<serde_json::Value, String> {
    companion_export::open_attachment_path(&sourcePath, &mime)
}

/// Bounded storage stats: inbox attachments / asset originals / disposable
/// thumbnails / capture outbox (bytes + counts).
#[tauri::command]
async fn companion_storage_stats() -> Result<serde_json::Value, String> {
    companion_export::storage_stats()
}

/// Clear ONLY the disposable derived thumbnail cache roots; returns
/// {freedBytes, filesRemoved}. Never touches user-owned data.
#[tauri::command]
async fn companion_clear_cache() -> Result<serde_json::Value, String> {
    companion_export::clear_cache()
}

// ---------------------------------------------------------------------------
// Agent remote (V1: list / events / stop)
// ---------------------------------------------------------------------------

#[tauri::command]
async fn agent_runs(state: State<'_, SharedState>) -> Result<serde_json::Value, String> {
    let (paired, gw) = require_paired(&state)?;
    let instance = paired.instance_id;
    let res = gw.ai_runs().await?;
    if let Some(arr) = res.as_array() {
        for r in arr {
            with_db(&state, |db| db.upsert_run(&instance, r))?;
        }
    }
    Ok(res)
}

#[tauri::command]
async fn agent_events(state: State<'_, SharedState>, runId: String) -> Result<serde_json::Value, String> {
    let (paired, gw) = require_paired(&state)?;
    let instance = paired.instance_id;
    let after = with_db(&state, |db| db.events_max_seq(&instance, &runId))?;
    let res = gw.ai_events(&runId, after, 200).await?;
    if let Some(events) = res["events"].as_array() {
        for ev in events {
            let seq = ev["seq"].as_i64().unwrap_or(after + 1);
            with_db(&state, |db| {
                db.append_event(&instance, &runId, seq, ev["type"].as_str().unwrap_or(""), &ev["payload"].to_string())
            })?;
        }
    }
    Ok(res)
}

#[tauri::command]
async fn agent_stop(state: State<'_, SharedState>, runId: String) -> Result<serde_json::Value, String> {
    let (_, gw) = require_paired(&state)?;
    gw.ai_stop(&runId).await
}

// ---------------------------------------------------------------------------
// Event stream (WS)
// ---------------------------------------------------------------------------

#[tauri::command]
async fn ws_start(state: State<'_, SharedState>, app: tauri::AppHandle) -> Result<String, String> {
    let (lifecycle, es) = connection_controls(&state);
    let observed = lifecycle.observe();
    lifecycle
        .run_if_current(observed, || async move {
            let (paired, gw) = require_paired(&state)?;
            // Manual reconnect semantics: retire any previous eventstream
            // worker FIRST. es.start alone returns AlreadyRunning when a
            // worker exists, so a wedged retry loop could otherwise never be
            // interrupted by the user's tap. This is an eventstream-only
            // stop — it is NOT the ws_stop opt-out and never touches the
            // connection intent or credentials.
            es.stop().await;
            es.start(&gw.ws_url(), &gw.ws_authorization(), &paired.fingerprint, app).await?;
            // An explicit start is the user's standing opt-in for this pairing:
            // record it so a later cold start restores it without a manual tap.
            // The in-memory mirror flips first — the connection is genuinely
            // live and this process will honour the opt-in either way.
            mirror_conn_intent(&state, ConnectionIntent::Auto);
            if let Err(error) = persist_conn_intent(&state, CONN_INTENT_AUTO) {
                // Connected, but the preference is not durable. Return the
                // truth instead of a bare error: the UI must not claim the
                // start failed while a live worker exists.
                return Ok(conn_result_json(CONN_STATUS_STARTED, false, Some(&error)));
            }
            Ok(conn_result_json(CONN_STATUS_STARTED, true, None))
        })
        .await
}

/// M3-M1 R2 — cold-start / foreground auto-recovery. Idempotent by
/// construction: an already-running worker returns AlreadyRunning, an
/// unpaired device never starts, and a user's explicit stop vetoes it. This
/// is the ONLY entry point the app shell calls automatically; it never
/// re-pairs and never invents a credential.
///
/// The intent is read INSIDE the lifecycle gate, after any concurrent explicit
/// stop/re-pair has been serialized ahead of it. Reading it before the gate
/// would let this order run: resume reads auto → stop completes and writes
/// manual_stop → this start proceeds and leaves a live worker behind.
#[tauri::command]
async fn conn_resume(state: State<'_, SharedState>, app: tauri::AppHandle) -> Result<String, String> {
    let (lifecycle, es) = connection_controls(&state);
    let observed = lifecycle.observe();
    lifecycle
        .run_if_current(observed, || async move {
            // The ONE authority check, made while holding the gate. The
            // in-memory mirror is consulted first: an explicit stop whose
            // durable save failed still vetoes resume in this process.
            match current_conn_intent(&state) {
                ConnectionIntent::ManualStop => {
                    return Ok(conn_result_json(CONN_STATUS_SKIPPED_MANUAL_STOP, true, None))
                }
                ConnectionIntent::Unavailable => {
                    return Ok(conn_result_json(CONN_STATUS_SKIPPED_INTENT_UNAVAILABLE, true, None))
                }
                ConnectionIntent::Auto => {}
            }
            let (paired, gw) = match require_paired(&state) {
                Ok(v) => v,
                // Not paired (or the credential is gone) — nothing to resume;
                // this is a normal state, not an error the UI should surface.
                Err(_) => return Ok(conn_result_json(CONN_STATUS_SKIPPED_NOT_PAIRED, true, None)),
            };
            match es
                .start(&gw.ws_url(), &gw.ws_authorization(), &paired.fingerprint, app)
                .await
            {
                Ok(()) => Ok(conn_result_json(CONN_STATUS_RESUMED, true, None)),
                // A rejected credential leaves the worker in re_pair_required;
                // that terminal state is authoritative and must stand.
                Err(_) => Ok(conn_result_json(CONN_STATUS_DEFERRED_TRANSPORT, true, None)),
            }
        })
        .await
}

#[tauri::command]
async fn ws_stop(state: State<'_, SharedState>) -> Result<String, String> {
    // An explicit stop is a standing opt-out. It runs under the SAME gate as
    // every start/resume and invalidates the epoch, so a resume that already
    // observed the pre-stop state is rejected when it tries to take the gate.
    let (lifecycle, es) = connection_controls(&state);
    let _guard = lifecycle.lock().await;
    lifecycle.invalidate();
    es.stop().await;
    // P1-L1: an explicit 断开连接 must not leave an already-authenticated LSH
    // remote surface active. Retire the carrier in the SAME lifecycle gate,
    // right after the eventstream stops and before the manual-stop result is
    // mirrored/persisted — its cancellation closes established LSH HTTP/WS
    // promptly. A later reconnect simply bootstraps a fresh carrier.
    crate::lsh_carrier::stop();
    // P1-H3: an explicit 断开连接 must retire the authenticated hint WSS promptly.
    services_hints::retire_managed();
    // The mirror flips BEFORE attempting the disk write, so a failed save can
    // never let this process auto-recover what the user just disconnected.
    mirror_conn_intent(&state, ConnectionIntent::ManualStop);
    if let Err(error) = persist_conn_intent(&state, CONN_INTENT_MANUAL_STOP) {
        // The worker IS stopped and this process honours the opt-out; only
        // cross-process durability is compromised. Report that exactly rather
        // than as a failed disconnect.
        return Ok(conn_result_json(CONN_STATUS_STOPPED, false, Some(&error)));
    }
    Ok(conn_result_json(CONN_STATUS_STOPPED, true, None))
}

#[tauri::command]
async fn ws_state(state: State<'_, SharedState>) -> Result<serde_json::Value, String> {
    let es = {
        let g = state.lock().unwrap();
        g.eventstream.clone()
    };
    Ok(es.snapshot())
}

// ---------------------------------------------------------------------------
// Secure storage / misc
// ---------------------------------------------------------------------------

#[tauri::command]
async fn secure_test(state: State<'_, SharedState>) -> Result<String, String> {
    let store = secure::SecureCredentialStoreImpl;
    let pairing_metadata_scrubbed = {
        let g = state.lock().unwrap();
        let mut db = g.db.lock().unwrap();
        if db.paired()?.is_some() {
            let _ = authenticated_pairing(&mut db, &store)?;
        }
        db.paired()?
            .map(|paired| paired.legacy_credential.is_empty())
            .unwrap_or(true)
    };
    if !pairing_metadata_scrubbed {
        return Err("SQLite pairing credential was not scrubbed".into());
    }
    let instance = "test-instance";
    store.save_desktop_credential(instance, "roundtrip-secret-001")?;
    let loaded = store.load_desktop_credential(instance)?.unwrap_or_default();
    if loaded == "roundtrip-secret-001" {
        store.delete_desktop_credential(instance)?;
        Ok("keystore round-trip OK; SQLite credential empty".into())
    } else {
        let _ = store.delete_desktop_credential(instance);
        Err("keystore round-trip MISMATCH".into())
    }
}

#[tauri::command]
fn mq_log(msg: String) -> Result<String, String> {
    println!("[LR] {msg}");
    Ok("ok".into())
}

#[tauri::command]
async fn db_stats(state: State<'_, SharedState>) -> Result<serde_json::Value, String> {
    let instance = {
        let g = state.lock().unwrap();
        let db = g.db.lock().unwrap();
        db.paired()?.map(|p| p.instance_id)
    };
    match instance {
        Some(id) => with_db(&state, |db| db.stats(&id)),
        None => Ok(serde_json::json!({ "assets": 0, "notes": 0, "outbox": 0, "runs": 0, "sync_cursor": 0 })),
    }
}

#[tauri::command]
async fn db_reset(state: State<'_, SharedState>) -> Result<String, String> {
    let secure_store = secure::SecureCredentialStoreImpl;
    // P1-H6: this command clears pairing/credentials, so the authenticated
    // Services hint WSS must be retired FIRST — the native authority enforces
    // it rather than relying on the UI to stop the stream.
    services_hints::retire_managed();
    {
        let g = state.lock().unwrap();
        let mut db = g.db.lock().unwrap();
        clear_pairing_and_secure_credentials(&mut db, &secure_store)?;
    }
    Ok("db reset".into())
}

/// Full local-data reset (RecoveryScreen "重置本地数据"): drops all tables and
/// re-runs migrations from scratch. Pairing/credential is cleared; the app
/// starts fresh. Used only when a migration cannot be recovered by retry.
#[tauri::command]
async fn db_reset_full(state: State<'_, SharedState>) -> Result<String, String> {
    let secure_store = secure::SecureCredentialStoreImpl;
    // P1-H6: RecoveryScreen's "重置本地数据（清除配对与缓存）" reaches here, so
    // the Services hint authority is retired before the pairing clear — the
    // same rule as every other destructive pairing path.
    services_hints::retire_managed();
    {
        let g = state.lock().unwrap();
        let mut db = g.db.lock().unwrap();
        clear_pairing_and_secure_credentials(&mut db, &secure_store)?;
        db.reset_full()?;
    }
    Ok("db fully reset".into())
}

/// Is Google Play Services available? The QR barcode plugin (ML Kit) requires
/// GMS; on devices without it scan() silently hangs — surface this to the UI.
#[tauri::command]
fn gms_available() -> bool {
    device::gms_available()
}

/// INTERACTION-CLOSURE-R1: Android root Back falls back to normal task/back
/// semantics (move the task to background = return to launcher). No process
/// kill; never touches insets/IME/pairing.
#[tauri::command]
fn move_task_to_back() -> bool {
    device::move_task_to_back()
}

/// INTERACTION-CLOSURE-R1 (用户问题1): system-bar appearance follows the app
/// color mode. Visual only; applySystemBarInsets() geometry is untouched.
#[tauri::command]
fn set_system_bar_appearance(dark: bool, dimmed: Option<bool>) -> bool {
    device::set_system_bar_appearance(dark, dimmed.unwrap_or(false))
}

// ---------------------------------------------------------------------------
// QR pairing (native CameraX + bundled ML Kit, works without GMS)
// ---------------------------------------------------------------------------

/// Scan a QR code with the native bridge (CameraX + bundled ML Kit).
/// Returns the scanned content string. Never hangs: cancelled on timeout.
#[tauri::command]
async fn qr_scan(timeout_ms: u64) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || qr::scan(timeout_ms))
        .await
        .map_err(|e| format!("qr task: {e}"))?
}

/// Cancel an active QR scan (tears the camera down).
#[tauri::command]
async fn qr_cancel() -> Result<String, String> {
    qr::scan_stop()?;
    Ok("qr cancelled".into())
}

/// M2.13 FIX-V1 P1-C + FIX-V2 #5: move the *complete* SQLite set (main db +
/// -wal + -shm) out of the way under one shared `corrupt-<suffix>` recovery
/// suffix so no part of a corrupt database is ever deleted or left half-moved.
///
/// All-or-nothing: every source/destination pair is preflighted BEFORE any
/// rename; if any move then fails, the members already moved are rolled back
/// (restored to their original paths) so the active SQLite set is left
/// intact. Only after this returns Ok may the caller create a fresh recovery
/// DB — and the recovery flag is only ever written on a fully successful
/// quarantine. Quarantined files are kept for diagnostics and are never
/// auto-deleted by RecoveryScreen reset.
///
/// Test-only failure injection: when `TEST_FAIL_MOVE_AT` is non-zero, the
/// Nth rename (1-based) fails, which exercises the rollback path
/// deterministically (see the injected-failure tests below).
#[cfg(test)]
static TEST_FAIL_MOVE_AT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
/// Serializes quarantine tests that touch the injected-failure counter so
/// parallel test threads cannot consume each other's injection.
#[cfg(test)]
static TEST_QUARANTINE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn quarantine_corrupt_db_set(data_dir: &std::path::Path, suffix: &str) -> Result<(), String> {
    // Preflight: collect the moves that WILL happen (every source that
    // exists). A destination that already exists is a hard error BEFORE any
    // rename — a half-moved set must never be reachable from a preflight
    // failure either.
    let mut moves: Vec<(std::path::PathBuf, std::path::PathBuf)> = Vec::new();
    for name in ["luckyray-mobile.db", "luckyray-mobile.db-wal", "luckyray-mobile.db-shm"] {
        let src = data_dir.join(name);
        let dst = data_dir.join(format!("{name}.{suffix}"));
        if src.exists() {
            if dst.exists() {
                return Err(format!("quarantine target already exists: {name}.{suffix}"));
            }
            moves.push((src, dst));
        }
    }
    // Execute; on ANY failure roll back the members already moved so the
    // original active SQLite set is restored intact.
    let mut done: Vec<(std::path::PathBuf, std::path::PathBuf)> = Vec::new();
    for (idx, (src, dst)) in moves.iter().enumerate() {
        #[cfg(test)]
        {
            let fail_at = TEST_FAIL_MOVE_AT.load(std::sync::atomic::Ordering::SeqCst);
            if fail_at > 0 {
                TEST_FAIL_MOVE_AT.store(fail_at - 1, std::sync::atomic::Ordering::SeqCst);
                if fail_at == 1 {
                    for (moved_src, moved_dst) in done.iter().rev() {
                        let _ = std::fs::rename(moved_dst, moved_src);
                    }
                    return Err(format!("injected quarantine move failure on move {}", idx + 1));
                }
            }
        }
        if let Err(e) = std::fs::rename(src, dst) {
            for (moved_src, moved_dst) in done.iter().rev() {
                let _ = std::fs::rename(moved_dst, moved_src);
            }
            return Err(format!("quarantine move {} failed: {e}", idx + 1));
        }
        done.push((src.clone(), dst.clone()));
    }
    Ok(())
}

/// Local data health: the frontend renders a recoverable error page (retry /
/// export diagnostics) instead of a white screen when this reports not-ok
/// (e.g. an interrupted schema migration or a corrupted db file).
#[tauri::command]
fn db_health(state: State<'_, SharedState>) -> Result<serde_json::Value, String> {
    let g = state.lock().unwrap();
    let db = g.db.lock().unwrap();
    let mut h: serde_json::Value = db.health()?;
    // M2.13-B4: a corrupt DB that was isolated at startup stays in recovery
    // until the user explicitly resets (reset_full drops app_meta).
    if db.meta_get("db_recovery")?.as_deref() == Some("corrupt_isolated") {
        h["ok"] = serde_json::Value::Bool(false);
        h["recovery"] = serde_json::Value::String("corrupt_isolated".into());
    }
    Ok(h)
}

/// Export local diagnostics (db health + structural Local Inbox / Local Note /
/// Local Asset summaries + version info) to the app's external files dir so it
/// can be pulled without root. The local-domain sections are structural only
/// (`inbox_diagnostics` / `note_diagnostics` / `asset_diagnostics`): counts,
/// flags, kinds, timestamps, attachment presence/MIME/size/existence. User
/// content (title, text, URL, note content, tags, file names, asset names,
/// SHA-256, paths, item/note/asset ids, source inbox ids) is never exported;
/// no secrets are included.
#[tauri::command]
fn db_export_diagnostics(state: State<'_, SharedState>) -> Result<String, String> {
    let (health, inbox, note, asset) = {
        let g = state.lock().unwrap();
        let db = g.db.lock().unwrap();
        (
            db.health()?,
            db.inbox_diagnostics()?,
            db.note_diagnostics()?,
            db.asset_diagnostics()?,
        )
    };
    let doc = serde_json::json!({
        "appVersion": env!("CARGO_PKG_VERSION"),
        "exportedAt": now_iso(),
        "health": health,
        "localInbox": inbox,
        "localNote": note,
        "localAsset": asset,
        "note": "LuckyRay mobile local-data diagnostics (no secrets included)",
    });
    let text = serde_json::to_string_pretty(&doc).map_err(|e| format!("serialize: {e}"))?;
    // Android 10 scoped storage blocks direct /sdcard/Download writes; the
    // app's external files dir (via Context.getExternalFilesDir) is
    // app-scoped, adb-pullable, and needs no runtime permission.
    let out_dir = std::path::PathBuf::from(local_inbox::diagnostics_dir()?);
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("mkdir diagnostics dir: {e}"))?;
    let out = out_dir.join(format!(
        "luckyray-diagnostics-{}.json",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    ));
    std::fs::write(&out, text).map_err(|e| format!("write diagnostics: {e}"))?;
    Ok(out.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init());
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());
    builder
        .invoke_handler(tauri::generate_handler![
            conn_state,
            conn_pair,
            conn_pair_file,
            pair_pick_file,
            conn_revoke,
            conn_hello,
            sync_run,
            assets_refresh,
            content::content_capabilities,
            services_v1::services_v1_request,
            services_hints::services_hints_start,
            services_hints::services_hints_state,
            services_hints::services_hints_status,
            services_hints::services_hints_stop,
            lsh_surface::lsh_surface_state,
            lsh_surface::lsh_surface_bootstrap,
            lsh_surface::lsh_surface_open,
            lsh_surface::lsh_surface_stop,
            content::content_assets,
            content::content_navigation,
            content::content_asset_detail,
            content::content_asset_file,
            content::content_cancel,
            content::content_note_resource,
            content::content_media_source,
            content::content_media_stream,
            content::content_media_status,
            content::content_video_play,
            content::local_asset_video_play,
            content::local_asset_media_source,
            content::content_media_release,
            content::content_cached_resource,
            content::content_open_resource,
            content::notes::content_sync,
            content::notes::content_vaults,
            content::notes::offline::content_offline_libraries,
            content::notes::offline::content_offline_notes,
            content::notes::offline::content_offline_control,
            content::notes::content_notes,
            content::notes::content_note_directories,
            content::materials::content_material_set_favorite,
            content::materials::content_material_set_tags,
            content::materials::content_material_set_folder,
            content::materials::content_material_create_tag,
            content::materials::content_material_create_folder,
            content::materials::content_material_batch,
            content::notes::content_note_begin,
            content::notes::content_note_get,
            content::notes::content_note_previews,
            content::notes::content_note_refresh,
            content::notes::content_note_prefetch,
            content::notes::content_note_edit,
            content::notes::content_note_resume_paused,
            content::notes::content_note_create,
            content::notes::content_note_delete,
            content::notes::content_note_move_receipt,
            content::notes::content_note_move_facts,
            content::notes::content_hydrate_directories,
            content::notes::content_note_create_authority,
            content::notes::content_note_resolve,
            content::notes::uploads::content_note_attach,
            assets_local,
            asset_detail,
            asset_thumbnail,
            thumbnail_evict,
            asset_file,
            notes_list,
            note_get,
            note_refresh,
            note_update,
            note_local_edit,
            capture_add,
            capture_pick,
            capture_list,
            capture_flush,
            capture_retry,
            local_inbox_list,
            local_inbox_get,
            local_inbox_add,
            local_inbox_add_media,
            local_inbox_update,
            local_inbox_set_favorite,
            local_inbox_set_archived,
            local_inbox_delete,
            local_inbox_stats,
            local_inbox_erase_all,
            local_inbox_ingest_shares,
            local_note_list,
            local_note_folders,
            local_note_create_folder,
            local_note_set_folder,
            local_note_tags,
            local_note_get,
            local_note_add,
            local_note_update,
            local_note_set_flags,
            local_note_delete,
            local_note_stats,
            local_note_erase_all,
            local_note_convert_inbox,
            unified_local_search,
            local_asset_list,
            local_asset_get,
            local_asset_import,
            local_asset_update,
            local_asset_tags,
            local_asset_set_flags,
            local_asset_delete,
            local_asset_stats,
            local_asset_erase_all,
            local_asset_thumbnail,
            local_asset_integrity,
            local_asset_promote_inbox,
            local_asset_reconcile,
            companion_export,
            companion_share_file,
            companion_share_text,
            open_attachment,
            companion_storage_stats,
            companion_clear_cache,
            agent_runs,
            agent_events,
            agent_stop,
            ws_start,
            ws_stop,
            ws_state,
            conn_resume,
            secure_test,
            mq_log,
            db_stats,
            db_reset,
            gms_available,
            move_task_to_back,
            set_system_bar_appearance,
            qr_scan,
            qr_cancel,
            db_health,
            db_export_diagnostics,
            db_reset_full,
        ])
        .setup(|app| {
            println!("[LR] APP STARTED (setup)");
            let data_dir = app.path().app_data_dir().map_err(|e| format!("data dir: {e}"))?;
            std::fs::create_dir_all(&data_dir).map_err(|e| format!("mkdir: {e}"))?;
            #[cfg(not(target_os = "android"))]
            keystore::set_data_dir(data_dir.clone());
            // M2.13-B4 + FIX-V1 P1-C: a DB that cannot even be opened must NOT
            // hard-fail startup (that would leave the user with a silent white
            // screen / app exit and no recovery path). BUT quarantine is only
            // legal for *definite SQLite corruption* (SQLITE_NOTADB /
            // SQLITE_CORRUPT): ENOSPC / I/O / permission / busy / schema /
            // migration failures are NOT corruption and must surface as a
            // startup error instead of silently discarding the database.
            // The whole SQLite set (main db + -wal + -shm) is moved to the
            // same recovery suffix — never deleted — and only after every move
            // verifies successfully is a fresh recovery DB created. The flag
            // is cleared by reset_full (it drops app_meta); quarantined files
            // are preserved for diagnostics and never auto-deleted.
            let db_path = data_dir.join("luckyray-mobile.db");
            let mut db = match db::Db::open_kind(&db_path) {
                Ok(db) => db,
                Err((open_err, kind)) => match kind {
                    db::OpenFailure::Corrupt => {
                        println!(
                            "[LR] DB open failed with SQLite corruption ({open_err}); quarantining corrupt set"
                        );
                        let nanos = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_nanos())
                            .unwrap_or(0);
                        let suffix = format!("corrupt-{nanos}");
                        quarantine_corrupt_db_set(&data_dir, &suffix)
                            .map_err(|e| format!("quarantine: {e}"))?;
                        // All moves verified above — only now open a fresh DB.
                        let fresh =
                            db::Db::open(&db_path).map_err(|e| format!("fresh db open: {e}"))?;
                        let _ = fresh.meta_set("db_recovery", "corrupt_isolated");
                        fresh
                    }
                    db::OpenFailure::Other => {
                        return Err(format!("db open failed (not corruption): {open_err}").into());
                    }
                },
            };
            if let Err(error) = cleanup_completed_capture_attachments(&db) {
                println!("[LR] completed attachment cleanup deferred: {error}");
            }
            // M2.7: ingest Android shares that arrived before/at cold start,
            // then reconcile the Local Inbox file domain. Order matters: the
            // orphan scan must run AFTER share ingestion so files claimed by a
            // pending share meta are never treated as orphans.
            if let Err(error) = local_inbox::reconcile_pending_shares(&mut db) {
                println!("[LR] local inbox share reconcile deferred: {error}");
            }
            let attachment_paths = db.list_attachment_paths()?;
            if let Err(error) = capture_media::cleanup_unreferenced_private_outbox(&attachment_paths) {
                println!("[LR] private capture outbox reconciliation deferred: {error}");
            }
            let inbox_paths = db.inbox_attachment_paths()?;
            if let Err(error) = local_inbox::cleanup_unreferenced_inbox_files(&inbox_paths) {
                println!("[LR] local inbox reconciliation deferred: {error}");
            }
            // M2.9: reconcile the Local Asset file domain — transient staging
            // files and unowned `originals/asset-*` (crash between rename and
            // DB commit) are reclaimed; DB-owned originals and every other
            // storage domain are never touched.
            if let Err(error) = local_asset::reconcile_asset_roots(&db) {
                println!("[LR] local asset reconciliation deferred: {error}");
            }
            local_inbox::set_app_handle(app.handle().clone());
            // Seed the in-memory intent mirror from the durable value. A read
            // failure seeds UNAVAILABLE (fail closed) rather than silently
            // authorising automatic recovery.
            let conn_intent = ConnIntentMirror::seeded(read_conn_intent(&db));
            let state = Arc::new(Mutex::new(AppState {
                db: Mutex::new(db),
                eventstream: EventStreamClient::new(),
                connection_lifecycle: ConnectionLifecycle::new(),
                conn_intent,
            }));
            app.manage(state);
            let hint_state = services_hints::ManagedHintState::default();
            services_hints::install_managed(hint_state.clone());
            app.manage(hint_state);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Remove thumbnail cache files matching (instance, asset id) prefix.
fn cleanup_thumb_files(cache: &std::path::Path, instance: &str, id: &str) -> Result<usize, String> {
    let prefix = format!("thumb-{instance}-{id}-");
    let mut removed = 0usize;
    if let Ok(entries) = std::fs::read_dir(cache) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with(&prefix) {
                let _ = std::fs::remove_file(e.path());
                removed += 1;
            }
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    #[tokio::test]
    async fn phase_b_r2_forget_wins_against_paused_old_bearer_start() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

        let lifecycle = ConnectionLifecycle::new();
        let eventstream = EventStreamClient::new();
        let paired = Arc::new(AtomicBool::new(true));
        let handshakes = Arc::new(AtomicUsize::new(0));
        let captured = Arc::new(tokio::sync::Barrier::new(2));
        let resume = Arc::new(tokio::sync::Barrier::new(2));
        let observed_epoch = lifecycle.observe();

        let start_lifecycle = lifecycle.clone();
        let start_paired = Arc::clone(&paired);
        let start_handshakes = Arc::clone(&handshakes);
        let start_captured = Arc::clone(&captured);
        let start_resume = Arc::clone(&resume);
        let paused_start = tokio::spawn(async move {
            start_captured.wait().await;
            start_resume.wait().await;
            start_lifecycle
                .run_if_current(observed_epoch, || async move {
                    if !start_paired.load(Ordering::SeqCst) {
                        return Err("not paired".to_string());
                    }
                    start_handshakes.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                })
                .await
        });

        captured.wait().await;
        {
            let _guard = lifecycle.lock().await;
            lifecycle.invalidate();
            eventstream.stop().await;
            paired.store(false, Ordering::SeqCst);
        }
        resume.wait().await;

        assert!(paused_start.await.expect("paused start joins").is_err(), "stale start is rejected");
        assert!(!paired.load(Ordering::SeqCst), "forget wins and pairing stays cleared");
        assert_eq!(handshakes.load(Ordering::SeqCst), 0, "old bearer never reaches handshake");
        assert_eq!(eventstream.ownership_snapshot(), (false, false), "no worker/handle/stop slot survives");
    }

    // ---- M2.13 FIX-V1 P1-C: corrupt-DB recovery narrowness + full-set
    // quarantine. Deterministic tests, no device required.

    fn corrupt_test_dir(tag: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("lrm-corrupt-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    /// A byte blob that is definitely NOT a SQLite database: opening it must
    /// surface SQLITE_NOTADB.
    fn write_not_a_database(path: &std::path::Path) {
        std::fs::write(path, b"this is not a sqlite database file at all - 0123456789")
            .expect("write junk file");
    }

    #[test]
    fn corrupt_open_kind_classifies_not_a_database_as_corrupt() {
        let dir = corrupt_test_dir("notadb");
        let path = dir.join("luckyray-mobile.db");
        write_not_a_database(&path);
        // junk file must fail to open with the Corrupt class (Db is not Debug,
        // so match instead of expect_err)
        let (_, kind) = match db::Db::open_kind(&path) {
            Err(k) => k,
            Ok(_) => panic!("junk file must fail to open"),
        };
        assert_eq!(kind, db::OpenFailure::Corrupt, "NOTADB is definite corruption");
        // and the error text is preserved for the startup log
        let err = match db::Db::open(&path) {
            Err(msg) => msg,
            Ok(_) => panic!("same failure via plain open"),
        };
        assert!(err.contains("open db:") || err.contains("pragma:"), "diagnostic text kept: {err}");
    }

    #[test]
    fn non_corrupt_open_errors_are_never_classified_corrupt() {
        use rusqlite::ffi::{Error as FfiError, ErrorCode};
        // Build SqliteFailure directly from an ErrorCode (Error::new takes a
        // raw c_int and re-maps it, so struct fields are the precise route).
        let mk = |code: ErrorCode| {
            rusqlite::Error::SqliteFailure(FfiError { code, extended_code: 0 }, None)
        };
        // ENOSPC / I/O / permission / busy / cannot-open / schema — every one
        // of these must be Other, never Corrupt, so the caller cannot be
        // tricked into quarantining a database that failed for another reason.
        for code in [
            ErrorCode::SystemIoFailure,    // 10 — I/O error
            ErrorCode::DiskFull,           // 13 — disk full (ENOSPC)
            ErrorCode::PermissionDenied,   // 3 — permission denied
            ErrorCode::DatabaseBusy,       // 5 — locked by another process
            ErrorCode::DatabaseLocked,     // 6 — table locked
            ErrorCode::CannotOpen,         // 14 — cannot open file
            ErrorCode::SchemaChanged,      // 17 — schema changed
            ErrorCode::ReadOnly,           // 8 — read-only database
            ErrorCode::OperationAborted,   // 4 — abort
        ] {
            assert_eq!(
                db::classify_open(&mk(code)),
                db::OpenFailure::Other,
                "sqlite error {code:?} must NOT be treated as corruption"
            );
        }
        // Non-sqlite failures (e.g. invalid path) are Other too.
        assert_eq!(
            db::classify_open(&rusqlite::Error::InvalidPath(std::path::PathBuf::from("x"))),
            db::OpenFailure::Other
        );
        // The two true corruption codes are the only ones classified Corrupt.
        assert_eq!(
            db::classify_open(&mk(ErrorCode::NotADatabase)),
            db::OpenFailure::Corrupt
        );
        assert_eq!(
            db::classify_open(&mk(ErrorCode::DatabaseCorrupt)),
            db::OpenFailure::Corrupt
        );
    }

    #[test]
    fn quarantine_moves_complete_sqlite_set_under_one_suffix() {
        let _g = TEST_QUARANTINE_LOCK.lock().unwrap();
        let dir = corrupt_test_dir("quar");
        let main = dir.join("luckyray-mobile.db");
        let wal = dir.join("luckyray-mobile.db-wal");
        let shm = dir.join("luckyray-mobile.db-shm");
        write_not_a_database(&main);
        std::fs::write(&wal, b"wal-frame-1\nwal-frame-2\n").expect("write wal");
        std::fs::write(&shm, b"shm-header").expect("write shm");
        quarantine_corrupt_db_set(&dir, "corrupt-12345").expect("quarantine succeeds");
        // Originals are gone...
        assert!(!main.exists(), "main db moved away");
        assert!(!wal.exists(), "wal moved away (never deleted)");
        assert!(!shm.exists(), "shm moved away (never deleted)");
        // ...and all three live under the SAME recovery suffix, contents intact.
        assert_eq!(
            std::fs::read(dir.join("luckyray-mobile.db.corrupt-12345")).expect("main quarantine"),
            b"this is not a sqlite database file at all - 0123456789"
        );
        assert_eq!(
            std::fs::read(dir.join("luckyray-mobile.db-wal.corrupt-12345")).expect("wal quarantine"),
            b"wal-frame-1\nwal-frame-2\n"
        );
        assert_eq!(
            std::fs::read(dir.join("luckyray-mobile.db-shm.corrupt-12345")).expect("shm quarantine"),
            b"shm-header"
        );
        // A fresh recovery DB can then be created at the original path.
        db::Db::open(&main).expect("fresh recovery db opens after quarantine");
    }

    #[test]
    fn quarantine_skips_missing_wal_and_shm_but_keeps_main() {
        let _g = TEST_QUARANTINE_LOCK.lock().unwrap();
        let dir = corrupt_test_dir("quarnolog");
        let main = dir.join("luckyray-mobile.db");
        write_not_a_database(&main);
        // No -wal / -shm present (e.g. journal already checkpointed).
        quarantine_corrupt_db_set(&dir, "corrupt-999").expect("quarantine with missing sidecars");
        assert!(!main.exists());
        assert!(dir.join("luckyray-mobile.db.corrupt-999").exists());
        assert!(!dir.join("luckyray-mobile.db-wal.corrupt-999").exists());
        assert!(!dir.join("luckyray-mobile.db-shm.corrupt-999").exists());
    }

    // ---- FIX-V2 #5: all-or-nothing quarantine — injected move failures.

    /// Full corrupt set with distinguishable contents (for rollback checks).
    fn seed_full_set(dir: &std::path::Path) -> std::path::PathBuf {
        let main = dir.join("luckyray-mobile.db");
        let wal = dir.join("luckyray-mobile.db-wal");
        let shm = dir.join("luckyray-mobile.db-shm");
        write_not_a_database(&main);
        std::fs::write(&wal, b"wal-original-content").expect("write wal");
        std::fs::write(&shm, b"shm-original-content").expect("write shm");
        main
    }

    fn assert_set_intact(dir: &std::path::Path, suffix: &str) {
        // Original paths restored with identical contents; no partial
        // quarantine set; nothing moved.
        assert_eq!(
            std::fs::read(dir.join("luckyray-mobile.db")).expect("main restored"),
            b"this is not a sqlite database file at all - 0123456789"
        );
        assert_eq!(
            std::fs::read(dir.join("luckyray-mobile.db-wal")).expect("wal restored"),
            b"wal-original-content"
        );
        assert_eq!(
            std::fs::read(dir.join("luckyray-mobile.db-shm")).expect("shm restored"),
            b"shm-original-content"
        );
        // No partial quarantine set may remain.
        let prefix = format!("luckyray-mobile.db{suffix}");
        let mut partial = 0usize;
        for entry in std::fs::read_dir(dir).expect("read dir") {
            let name = entry.expect("entry").file_name().to_string_lossy().into_owned();
            if name.contains(suffix) {
                partial += 1;
            }
        }
        assert_eq!(partial, 0, "no partial quarantine members for {prefix}");
    }

    #[test]
    fn quarantine_rolls_back_when_second_move_fails() {
        let _g = TEST_QUARANTINE_LOCK.lock().unwrap();
        // main moves first; injecting failure on move 2 (the -wal rename)
        // must restore the main too — the active set stays complete.
        TEST_FAIL_MOVE_AT.store(2, std::sync::atomic::Ordering::SeqCst);
        let dir = corrupt_test_dir("quar-rb2");
        seed_full_set(&dir);
        let err = quarantine_corrupt_db_set(&dir, "corrupt-rb2")
            .expect_err("injected second-move failure must propagate");
        assert!(err.contains("injected"), "error text: {err}");
        TEST_FAIL_MOVE_AT.store(0, std::sync::atomic::Ordering::SeqCst);
        assert_set_intact(&dir, ".corrupt-rb2");
    }

    #[test]
    fn quarantine_rolls_back_when_third_move_fails() {
        let _g = TEST_QUARANTINE_LOCK.lock().unwrap();
        // main + wal move first; injecting failure on move 3 (the -shm
        // rename) must restore both — the active set stays complete.
        TEST_FAIL_MOVE_AT.store(3, std::sync::atomic::Ordering::SeqCst);
        let dir = corrupt_test_dir("quar-rb3");
        seed_full_set(&dir);
        let err = quarantine_corrupt_db_set(&dir, "corrupt-rb3")
            .expect_err("injected third-move failure must propagate");
        assert!(err.contains("injected"), "error text: {err}");
        TEST_FAIL_MOVE_AT.store(0, std::sync::atomic::Ordering::SeqCst);
        assert_set_intact(&dir, ".corrupt-rb3");
    }

    #[test]
    fn quarantine_preflight_rejects_existing_target_without_moving_anything() {
        let dir = corrupt_test_dir("quar-pf");
        seed_full_set(&dir);
        // A destination already exists -> preflight error BEFORE any rename.
        std::fs::write(dir.join("luckyray-mobile.db.corrupt-pf"), b"stale").expect("write stale target");
        let err = quarantine_corrupt_db_set(&dir, "corrupt-pf")
            .expect_err("preflight must reject existing target");
        assert!(err.contains("already exists"), "error text: {err}");
        // Original set restored (the pre-existing target stays untouched).
        assert_eq!(
            std::fs::read(dir.join("luckyray-mobile.db")).expect("main intact"),
            b"this is not a sqlite database file at all - 0123456789"
        );
        assert_eq!(
            std::fs::read(dir.join("luckyray-mobile.db-wal")).expect("wal intact"),
            b"wal-original-content"
        );
        assert_eq!(
            std::fs::read(dir.join("luckyray-mobile.db-shm")).expect("shm intact"),
            b"shm-original-content"
        );
        // The stale target remains; NO member was moved onto it.
        assert_eq!(
            std::fs::read(dir.join("luckyray-mobile.db.corrupt-pf")).expect("stale target untouched"),
            b"stale"
        );
        // And no NEW quarantine member appeared.
        let mut members = 0usize;
        for entry in std::fs::read_dir(&dir).expect("read dir") {
            let name = entry.expect("entry").file_name().to_string_lossy().into_owned();
            if name.starts_with("luckyray-mobile.db.") && name != "luckyray-mobile.db.corrupt-pf" {
                members += 1;
            }
        }
        assert_eq!(members, 0, "no new quarantine members after preflight rejection");
    }

    #[test]
    fn reset_full_clears_recovery_flag_but_preserves_quarantined_files() {
        let dir = corrupt_test_dir("resetkeep");
        let path = dir.join("luckyray-mobile.db");
        let mut db = db::Db::open(&path).expect("open fresh db");
        db.meta_set("db_recovery", "corrupt_isolated").expect("flag set");
        // Simulate a quarantined set that survived from a previous startup.
        let quar_main = dir.join("luckyray-mobile.db.corrupt-12345");
        let quar_wal = dir.join("luckyray-mobile.db-wal.corrupt-12345");
        std::fs::write(&quar_main, b"old-corrupt-main").expect("write quarantined main");
        std::fs::write(&quar_wal, b"old-corrupt-wal").expect("write quarantined wal");
        // RecoveryScreen reset: clears the flag (reset_full drops app_meta)...
        db.reset_full().expect("reset_full succeeds");
        assert_ne!(
            db.meta_get("db_recovery").expect("meta readable").as_deref(),
            Some("corrupt_isolated"),
            "recovery flag cleared by reset"
        );
        // ...but the quarantined files are NEVER auto-deleted.
        assert_eq!(
            std::fs::read(&quar_main).expect("quarantined main preserved"),
            b"old-corrupt-main"
        );
        assert_eq!(
            std::fs::read(&quar_wal).expect("quarantined wal preserved"),
            b"old-corrupt-wal"
        );
    }

    #[derive(Default)]
    struct MemorySecureStore {
        credentials: Mutex<HashMap<String, String>>,
    }

    impl SecureCredentialStore for MemorySecureStore {
        fn save_desktop_credential(&self, instance_id: &str, credential: &str) -> Result<(), String> {
            self.credentials
                .lock()
                .unwrap()
                .insert(instance_id.to_string(), credential.to_string());
            Ok(())
        }

        fn load_desktop_credential(&self, instance_id: &str) -> Result<Option<String>, String> {
            Ok(self
                .credentials
                .lock()
                .unwrap()
                .get(instance_id)
                .filter(|credential| !credential.is_empty())
                .cloned())
        }

        fn delete_desktop_credential(&self, instance_id: &str) -> Result<(), String> {
            self.credentials.lock().unwrap().remove(instance_id);
            Ok(())
        }

        fn delete_all_desktop_credentials(&self) -> Result<(), String> {
            self.credentials.lock().unwrap().clear();
            Ok(())
        }
    }

    fn temp_db_at() -> (Db, std::path::PathBuf) {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("luckyray-secure-{nanos}"));
        std::fs::create_dir_all(&dir).expect("create temp db directory");
        let path = dir.join("luckyray-mobile.db");
        let db = Db::open(&path).expect("open temp db");
        (db, path)
    }

    // -----------------------------------------------------------------------
    // G1E — the production Services fence rejects an old response after a
    // SAME-DESKTOP reconnect (epoch E -> E+1) that happened while the request
    // was suspended. This drives the real `ExpectedGateway` fence, not a copy.
    // -----------------------------------------------------------------------

    /// The G1E tests share the process-global keystore data dir, so they
    /// must not run concurrently with each other.
    static G1E_SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn g1e_state(instance: &str, gateway: &str) -> SharedState {
        // `require_paired` reads the credential through the keystore, which needs
        // a data dir the way the real app provides one at startup.
        let (mut db, path) = temp_db_at();
        let _ = &path;
        keystore::set_data_dir(path.parent().expect("parent").to_path_buf());
        db.upsert_paired(instance, "PC", "windows", "1.0", 1, "fp", gateway)
            .expect("seed pairing");
        // `require_paired` resolves the credential through the keystore, which
        // is not available in a unit test, so seed the legacy column it reads
        // FIRST (empty legacy falls through to secure storage).
        db.seed_legacy_credential_for_test(instance, "credential")
            .expect("seed credential");
        Arc::new(Mutex::new(AppState {
            db: Mutex::new(db),
            eventstream: EventStreamClient::new(),
            connection_lifecycle: ConnectionLifecycle::new(),
            conn_intent: ConnIntentMirror::seeded(ConnectionIntent::Auto),
        }))
    }

    #[test]
    fn materials_97_confirmed_denial_blocks_offline_bytes_until_positive_metadata() {
        let _serial=G1E_SERIAL.lock().unwrap_or_else(|e|e.into_inner());
        let state=g1e_state("A","https://127.0.0.1:6845");
        with_db(&state,|db|db.content_cache_response("A","/v1/assets/x",&serde_json::json!({"_mobileAccessError":"CONTENT_HTTP_403"}))).unwrap();
        assert_eq!(crate::content::material_access_check(&state,"A","x"),Err("CONTENT_HTTP_403".into()));
        assert!(crate::content::material_access_check(&state,"B","x").is_ok(),"A never poisons B's same id");
        with_db(&state,|db|db.content_cache_response("A","/v1/assets/x",&serde_json::json!({"desktopAssetId":"x","contentHash":"h2"}))).unwrap();
        assert!(crate::content::material_access_check(&state,"A","x").is_ok(),"an actual positive reply recovers the existing authority");
    }

    #[test]
    fn materials_97_grid_lru_is_owner_bound_and_never_removes_originals() {
        let root=std::env::temp_dir().join(format!("lrm-m97-lru-{}",Uuid::new_v4().simple()));
        let cache=root.join("cache");std::fs::create_dir_all(&cache).unwrap();
        let mut db=Db::open(&root.join("fixture.db")).unwrap();
        let original=root.join("asset-original.png");std::fs::write(&original,b"user-original").unwrap();
        let old=cache.join("thumb-A-old-v1.jpg");let keep=cache.join("thumb-A-current-v1.jpg");let other=cache.join("thumb-B-old-v1.jpg");
        for path in [&old,&keep,&other] {std::fs::write(path,b"8derived").unwrap();}
        for(owner,id,path)in [("A","old",&old),("A","current",&keep),("B","old",&other),("A","outside",&original)] {
            db.upsert_asset(owner,id,"fixture","image","image/png",8,"t","h","r","",&[]).unwrap();
            db.set_thumbnail(owner,id,path.to_str().unwrap(),"v1","image/jpeg",384,240).unwrap();
        }
        let result=evict_thumbnail_rows(&db,&cache,"A",8,Some("current")).unwrap();
        assert_eq!(result["evicted"],1);assert_eq!(result["remaining_bytes"],8);
        assert!(!old.exists());assert!(keep.exists()&&other.exists()&&original.exists());
        assert!(db.thumbnail_meta("A","old").unwrap().is_none());
        assert!(db.thumbnail_meta("B","old").unwrap().is_some());
        assert!(managed_thumbnail_path(&cache,"A","outside",original.to_str().unwrap()).is_none());
        let hostile=thumb_cache_name("A","old","W/../../../x",b"unknown");
        assert!(!hostile.contains('/')&&!hostile.contains('\\'));
        drop(db);std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn g1e_same_desktop_new_epoch_rejects_a_suspended_services_response() {
        let _serial = G1E_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let state = g1e_state("desktop-X", "https://127.0.0.1:6845");
        // Capture the SAME Desktop X at epoch E through the production path.
        let gateway = crate::content::expected_gateway(&state, "desktop-X")
            .expect("capture expected gateway at epoch E");
        assert_eq!(gateway.instance(), "desktop-X");

        // A barrier the test uses to hold the request open between the fences.
        let reached = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let reached_worker = reached.clone();
        let release_worker = release.clone();

        let state_worker = state.clone();
        let request = tokio::spawn(async move {
            gateway
                .run_between_fences(&state_worker, || async move {
                    // Suspended here: the test invalidates the lifecycle now.
                    reached_worker.notify_one();
                    release_worker.notified().await;
                    // The "old response" arrives after the reconnect.
                    Ok::<_, String>("old-response-body".to_string())
                })
                .await
        });

        // Wait until the request is parked INSIDE the fence pair, then
        // invalidate and re-establish the SAME Desktop at epoch E+1 / Auto.
        reached.notified().await;
        let (lifecycle, _es) = connection_controls(&state);
        lifecycle.invalidate(); // E -> E+1 for the SAME instance
        mirror_conn_intent(&state, ConnectionIntent::Auto);

        release.notify_one();
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(5), request)
            .await
            .expect("the request returns promptly")
            .expect("no panic");

        // The POST-await production fence must reject the stale response.
        assert_eq!(
            outcome.err().as_deref(),
            Some("CONTENT_SOURCE_CHANGED"),
            "the same-Desktop new-epoch response is rejected after the await"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn g1e_the_fence_admits_a_response_when_the_epoch_never_moved() {
        let _serial = G1E_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let state = g1e_state("desktop-X", "https://127.0.0.1:6845");
        let gateway = crate::content::expected_gateway(&state, "desktop-X")
            .expect("capture expected gateway");
        let outcome = gateway
            .run_between_fences(&state, || async { Ok::<_, String>("fresh".to_string()) })
            .await;
        assert_eq!(outcome.as_deref().ok(), Some("fresh"), "an unchanged epoch still returns");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn g1e_a_manual_stop_while_suspended_also_rejects_the_response() {
        let _serial = G1E_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let state = g1e_state("desktop-X", "https://127.0.0.1:6845");
        let gateway = crate::content::expected_gateway(&state, "desktop-X")
            .expect("capture expected gateway");
        let reached = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let reached_worker = reached.clone();
        let release_worker = release.clone();
        let state_worker = state.clone();
        let request = tokio::spawn(async move {
            gateway
                .run_between_fences(&state_worker, || async move {
                    reached_worker.notify_one();
                    release_worker.notified().await;
                    Ok::<_, String>("old".to_string())
                })
                .await
        });
        reached.notified().await;
        // An explicit 断开连接 flips the intent away from Auto.
        mirror_conn_intent(&state, ConnectionIntent::ManualStop);
        release.notify_one();
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(5), request)
            .await
            .expect("prompt")
            .expect("no panic");
        assert!(outcome.is_err(), "a manual stop while suspended rejects the response");
    }

    #[test]
    fn g1e_the_three_services_paths_share_the_same_fence_helper() {
        let content = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/content.rs"))
            .expect("content.rs");
        // JSON mutation and the raw chunk path call the SAME production wrapper
        // the tests above drive.
        for name in [
            "pub(crate) async fn services_request(",
            "pub(crate) async fn services_request_json(",
            "pub(crate) async fn services_request_with_chunk(",
        ] {
            let at = content.find(name).unwrap_or_else(|| panic!("{name} present"));
            let next = content[at + 10..]
                .find("pub(crate) async fn")
                .map(|offset| at + 10 + offset)
                .unwrap_or(content.len());
            assert!(
                content[at..next].contains("services_connection_current(state)?"),
                "{name} uses the shared fence"
            );
        }
        // The seam the tests call is the same proof the production paths use.
        let seam = content.find("fn run_between_fences").expect("seam");
        assert!(content[seam..seam + 500].contains("services_connection_current(state)?"),
            "the test seam drives the production fence");
    }

    fn temp_db() -> Db {
        temp_db_at().0
    }

    fn contains_bytes(bytes: &[u8], needle: &[u8]) -> bool {
        !needle.is_empty() && bytes.windows(needle.len()).any(|window| window == needle)
    }

    #[test]
    fn paired_runtime_uses_keystore_when_database_credential_is_empty() {
        let mut db = temp_db();
        db.upsert_paired("inst-1", "PC", "windows", "1.0", 1, "fp", "https://gateway")
            .expect("seed metadata-only pairing");
        let store = MemorySecureStore::default();
        store
            .save_desktop_credential("inst-1", "keystore-credential")
            .expect("seed keystore credential");

        let (paired, gateway) = authenticated_pairing(&mut db, &store).expect("authenticated pairing");

        assert_eq!(paired.legacy_credential, "");
        assert_eq!(gateway.token(), "keystore-credential");
    }

    #[test]
    fn secure_credential_survives_restart_but_data_clear_requires_explicit_repair() {
        let (mut db, path) = temp_db_at();
        db.upsert_paired("inst-restart", "PC", "windows", "1.0", 1, "fp", "https://gateway")
            .expect("seed metadata-only pairing");
        let store = MemorySecureStore::default();
        store
            .save_desktop_credential("inst-restart", "keystore-credential")
            .expect("seed secure credential");
        drop(db);

        let mut restarted = Db::open(&path).expect("restart opens durable SQLite state");
        let (_, gateway) = authenticated_pairing(&mut restarted, &store)
            .expect("normal restart retains Android-Keystore authority");
        assert_eq!(gateway.token(), "keystore-credential");

        // Android app-data clear/reinstall is deliberately a credential-loss
        // boundary. Pairing metadata is not a usable fallback and must request
        // a new pairing rather than silently authenticate from SQLite.
        store
            .delete_all_desktop_credentials()
            .expect("simulate app-data clear credential loss");
        let error = match authenticated_pairing(&mut restarted, &store) {
            Ok(_) => panic!("cleared Keystore cannot authenticate from pairing metadata"),
            Err(error) => error,
        };
        assert!(error.contains("secure credential missing"));
        assert!(restarted.paired().unwrap().is_some(), "metadata remains non-secret only");

        clear_pairing_and_secure_credentials(&mut restarted, &store)
            .expect("explicit reset clears the metadata after credential loss");
        assert!(restarted.paired().unwrap().is_none());
    }

    #[test]
    fn pairing_metadata_without_a_secure_credential_cannot_create_gateway_client() {
        let mut db = temp_db();
        db.upsert_paired("inst-1", "PC", "windows", "1.0", 1, "fp", "https://gateway")
            .expect("seed metadata-only pairing");

        let error = match authenticated_pairing(&mut db, &MemorySecureStore::default()) {
            Ok(_) => panic!("missing keystore credential must block authentication"),
            Err(error) => error,
        };

        assert!(error.contains("secure credential missing"));
    }

    #[test]
    fn legacy_sqlite_credential_is_migrated_verified_and_scrubbed() {
        let mut db = temp_db();
        db.upsert_paired("inst-1", "PC", "windows", "1.0", 1, "fp", "https://gateway")
        .expect("seed legacy pairing");
        db.seed_legacy_credential_for_test("inst-1", "legacy-sqlite-credential")
            .expect("seed legacy credential");
        let store = MemorySecureStore::default();

        let (paired, gateway) = authenticated_pairing(&mut db, &store).expect("migrate legacy credential");

        assert_eq!(gateway.token(), "legacy-sqlite-credential");
        assert_eq!(
            store.load_desktop_credential("inst-1").expect("read keystore"),
            Some("legacy-sqlite-credential".to_string())
        );
        assert_eq!(paired.legacy_credential, "");
        assert_eq!(
            db.paired()
                .expect("read pairing")
                .expect("pairing remains")
                .legacy_credential,
            ""
        );
    }

    #[test]
    fn legacy_migration_truncates_wal_and_removes_plaintext_marker_from_disk() {
        const MARKER: &str = "P1_SEC_1B_WAL_RESIDUE_MARKER_not_a_real_credential";

        let (mut db, db_path) = temp_db_at();
        let wal_path = std::path::PathBuf::from(format!("{}-wal", db_path.display()));
        db.upsert_paired("inst-wal", "PC", "windows", "1.0", 1, "fp", "https://gateway")
            .expect("seed legacy pairing");
        db.seed_legacy_credential_for_test("inst-wal", MARKER)
            .expect("seed legacy plaintext marker");
        let before = std::fs::read(&wal_path).expect("legacy marker must first be present in WAL");
        assert!(contains_bytes(&before, MARKER.as_bytes()), "seeded marker is visible in the WAL before migration");

        let store = MemorySecureStore::default();
        let (paired, gateway) = authenticated_pairing(&mut db, &store).expect("migrate legacy credential");

        assert_eq!(paired.legacy_credential, "");
        assert_eq!(gateway.token(), MARKER);
        assert_eq!(
            db.paired().expect("read pairing").expect("pairing remains").legacy_credential,
            ""
        );
        for path in [&db_path, &wal_path] {
            let bytes = std::fs::read(path).unwrap_or_default();
            assert!(
                !contains_bytes(&bytes, MARKER.as_bytes()),
                "legacy plaintext marker remains on disk at {}",
                path.display()
            );
        }
    }

    #[test]
    fn busy_wal_truncate_blocks_gateway_until_pending_cleanup_retries() {
        const MARKER: &str = "P1_SEC_1B_BUSY_WAL_MARKER_not_a_real_credential";

        let (mut db, db_path) = temp_db_at();
        db.upsert_paired("inst-busy", "PC", "windows", "1.0", 1, "fp", "https://gateway")
            .expect("seed legacy pairing");
        db.seed_legacy_credential_for_test("inst-busy", MARKER)
            .expect("seed legacy plaintext marker");

        // An explicit reader transaction keeps a WAL snapshot open, so a
        // TRUNCATE checkpoint cannot claim success while it still needs the
        // historical frame containing the legacy marker.
        let reader = rusqlite::Connection::open(&db_path).expect("open competing reader");
        reader
            .execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=0; BEGIN;")
            .expect("begin reader transaction");
        let seen: String = reader
            .query_row(
                "SELECT credential FROM paired_desktop WHERE desktop_instance_id='inst-busy'",
                [],
                |row| row.get(0),
            )
            .expect("reader sees legacy marker");
        assert_eq!(seen, MARKER);

        let store = MemorySecureStore::default();
        let error = match authenticated_pairing(&mut db, &store) {
            Ok(_) => panic!("a busy WAL truncate must block authenticated gateway use"),
            Err(error) => error,
        };
        assert!(error.contains("WAL truncate busy"), "unexpected cleanup error: {error}");
        assert_eq!(
            store
                .load_desktop_credential("inst-busy")
                .expect("read verified secure credential"),
            Some(MARKER.to_string())
        );
        assert_eq!(
            db.paired().expect("read pairing").expect("pairing remains").legacy_credential,
            ""
        );

        reader.execute_batch("COMMIT").expect("release reader transaction");
        let (_, gateway) = authenticated_pairing(&mut db, &store)
            .expect("retry completes pending WAL cleanup before gateway creation");
        assert_eq!(gateway.token(), MARKER);
    }

    #[test]
    fn clear_pairing_removes_metadata_legacy_value_and_every_secure_credential() {
        let mut db = temp_db();
        db.upsert_paired("inst-current", "PC", "windows", "1.0", 1, "fp", "https://gateway")
            .expect("seed pairing");
        db.seed_legacy_credential_for_test("inst-current", "legacy-sqlite-credential")
            .expect("seed compatibility credential");
        let store = MemorySecureStore::default();
        store
            .save_desktop_credential("inst-current", "current-credential")
            .expect("seed current secure credential");
        store
            .save_desktop_credential("inst-stale", "stale-credential")
            .expect("seed stale secure credential");
        db.enqueue_capture_with_attachment(
            "inst-current",
            "op-revoke",
            "file",
            r#"{\"opId\":\"op-revoke\"}"#,
            "ref-revoke",
            "file",
            "revoke.bin",
            1,
            "sha",
            "/private/capture-outbox/ref-revoke.bin",
        )
        .expect("seed durable capture before destructive reset");

        clear_pairing_and_secure_credentials(&mut db, &store).expect("clear pairing and credentials");

        assert!(db.paired().expect("read pairing").is_none());
        assert!(db.list_outbox("inst-current").unwrap().is_empty());
        assert!(db.list_attachment_paths().unwrap().is_empty());
        assert_eq!(
            store
                .load_desktop_credential("inst-current")
                .expect("read current credential"),
            None
        );
        assert_eq!(
            store
                .load_desktop_credential("inst-stale")
                .expect("read stale credential"),
            None
        );
    }

    fn valid_payload() -> serde_json::Value {
        serde_json::json!({
            "v": 1,
            "name": "TEST-PC",
            "instance": "desktop-1234567890abcdef1234567890abcdef",
            "ip": "192.168.0.10",
            "port": 48180,
            "secret": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            "fp": "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        })
    }

    #[test]
    fn qr_payload_parses_valid_v1() {
        let (v, name, instance, ip, port, secret, fp) = parse_pair_payload(&valid_payload()).unwrap();
        assert_eq!(v, 1);
        assert_eq!(name, "TEST-PC");
        assert_eq!(instance, "desktop-1234567890abcdef1234567890abcdef");
        assert_eq!(ip, "192.168.0.10");
        assert_eq!(port, 48180);
        assert_eq!(secret, "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
        assert_eq!(fp, "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890");
    }

    #[test]
    fn qr_payload_rejects_unsupported_version() {
        let mut p = valid_payload();
        p["v"] = serde_json::json!(2);
        assert!(parse_pair_payload(&p).unwrap_err().contains("unsupported pairing protocol version"));
    }

    #[test]
    fn qr_payload_rejects_bad_fingerprint() {
        let mut p = valid_payload();
        p["fp"] = serde_json::json!("short");
        assert!(parse_pair_payload(&p).unwrap_err().contains("invalid fingerprint format"));
    }

    #[test]
    fn qr_payload_rejects_missing_fields() {
        let mut p = valid_payload();
        p.as_object_mut().unwrap().remove("secret");
        assert!(parse_pair_payload(&p).is_err());
        let mut p2 = valid_payload();
        p2.as_object_mut().unwrap().remove("port");
        assert!(parse_pair_payload(&p2).is_err());
    }

    // ---- M3-M1 Phase-B: frozen companion-v1 bundle contracts (source:
    // luckyray-app/protocol/companion-v1 @ af81b643…, schemas/qr-envelope.
    // schema.json + fixtures, manifest.compatibility.unknownQrFields=reject).

    /// Golden QR envelope straight from the frozen bundle fixture
    /// fixtures/success/qr-envelope.json (synthetic values only).
    fn bundle_qr_payload() -> serde_json::Value {
        serde_json::json!({
            "v": 1,
            "name": "LuckyRay Desktop",
            "instance": "desktop-0123456789abcdef0123456789abcdef",
            "ip": "192.168.10.20",
            "port": 48180,
            "secret": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            "fp": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        })
    }

    #[test]
    fn phase_b_bundle_golden_qr_envelope_parses() {
        let (v, name, instance, ip, port, secret, fp) = parse_pair_payload(&bundle_qr_payload()).unwrap();
        assert_eq!(v, 1);
        assert_eq!(name, "LuckyRay Desktop");
        assert_eq!(instance, "desktop-0123456789abcdef0123456789abcdef");
        assert_eq!(ip, "192.168.10.20");
        assert_eq!(port, 48180);
        assert_eq!(secret, "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
        assert_eq!(fp, "a".repeat(64));
    }

    #[test]
    fn phase_b_qr_rejects_unknown_fields_bundle_compatibility_reject() {
        // manifest.compatibility.unknownQrFields = "reject";
        // qr-envelope.schema.json additionalProperties = false.
        let mut p = bundle_qr_payload();
        p["extra"] = serde_json::json!("sneaky");
        let err = parse_pair_payload(&p).unwrap_err();
        assert!(err.contains("unknown"), "must reject additional properties: {err}");
    }

    #[test]
    fn phase_b_qr_rejects_non_hex_secret_and_bad_instance() {
        // schemas: secret/fp ^[a-f0-9]{64}$, instance ^desktop-[a-f0-9]{32}$.
        let mut p = bundle_qr_payload();
        p["secret"] = serde_json::json!("zzzz-not-hex-please-reject-me-aaaaaaaaaaaaaaaaaaaaaaaaa");
        assert!(parse_pair_payload(&p).is_err(), "non-hex secret must be rejected");
        let mut p2 = bundle_qr_payload();
        p2["instance"] = serde_json::json!("1234567890abcdef1234567890abcdef");
        assert!(parse_pair_payload(&p2).is_err(), "instance must match the desktop id pattern");
    }

    #[test]
    fn phase_b_qr_rejects_non_lan_ip_and_bad_port_and_name() {
        // schemas: ip is private-LAN only; port 1..=65535; name 1..=80 chars.
        for bad_ip in ["8.8.8.8", "192.169.0.1", "11.0.0.1"] {
            let mut p = bundle_qr_payload();
            p["ip"] = serde_json::json!(bad_ip);
            assert!(parse_pair_payload(&p).is_err(), "non-LAN ip {bad_ip} must be rejected");
        }
        // P1 review fix: octal/leading-zero/sign canonicalization must not
        // smuggle a public host past the private-LAN gate.
        for smuggled in ["010.0.0.1", "172.016.0.1", "+10.0.0.1", "192.168.00.1"] {
            let mut p = bundle_qr_payload();
            p["ip"] = serde_json::json!(smuggled);
            assert!(parse_pair_payload(&p).is_err(), "canonicalization trick {smuggled} must be rejected");
        }
        let mut p = bundle_qr_payload();
        p["port"] = serde_json::json!(0);
        assert!(parse_pair_payload(&p).is_err(), "port 0 must be rejected");
        let mut p2 = bundle_qr_payload();
        p2["name"] = serde_json::json!("x".repeat(81));
        assert!(parse_pair_payload(&p2).is_err(), "name > 80 chars must be rejected");
    }

    #[test]
    fn phase_b_hello_identity_must_match_pinned_qr() {
        // Bundle trust sequence #3: hello must carry protocolVersion 1, the
        // SAME instanceId and the SAME certificateFingerprint as the QR.
        let good = serde_json::json!({
            "instanceId": "desktop-0123456789abcdef0123456789abcdef",
            "displayName": "LuckyRay Desktop",
            "platform": "windows",
            "appVersion": "1.8.0",
            "protocolVersion": 1,
            "certificateFingerprint": "a".repeat(64),
            "capabilities": { "pairing": true, "authenticatedEvents": true, "deviceRevocation": true, "runs": false }
        });
        validate_hello_identity(&good, "desktop-0123456789abcdef0123456789abcdef", &"a".repeat(64))
            .expect("matching hello identity passes");

        let wrong_instance = serde_json::json!({
            "instanceId": "desktop-ffffffffffffffffffffffffffffffff",
            "displayName": "LuckyRay Desktop",
            "platform": "windows",
            "appVersion": "1.8.0",
            "protocolVersion": 1,
            "certificateFingerprint": "a".repeat(64),
            "capabilities": { "pairing": true, "authenticatedEvents": true, "deviceRevocation": true, "runs": false }
        });
        assert!(validate_hello_identity(&wrong_instance, "desktop-0123456789abcdef0123456789abcdef", &"a".repeat(64)).is_err());

        let wrong_fp = serde_json::json!({
            "instanceId": "desktop-0123456789abcdef0123456789abcdef",
            "protocolVersion": 1,
            "certificateFingerprint": "b".repeat(64),
            "capabilities": { "pairing": true, "authenticatedEvents": true, "deviceRevocation": true, "runs": false }
        });
        assert!(validate_hello_identity(&wrong_fp, "desktop-0123456789abcdef0123456789abcdef", &"a".repeat(64)).is_err());

        let wrong_version = serde_json::json!({
            "instanceId": "desktop-0123456789abcdef0123456789abcdef",
            "protocolVersion": 2,
            "certificateFingerprint": "a".repeat(64),
            "capabilities": { "pairing": true, "authenticatedEvents": true, "deviceRevocation": true, "runs": false }
        });
        assert!(validate_hello_identity(&wrong_version, "desktop-0123456789abcdef0123456789abcdef", &"a".repeat(64)).is_err());
    }

    #[test]
    fn phase_b_pair_response_must_match_bundle_schema() {
        // Golden pair-response fixture.
        let good = serde_json::json!({
            "deviceId": "device-11111111111111111111111111111111",
            "credential": "device-11111111111111111111111111111111.2222222222222222222222222222222222222222222222222222222222222222",
            "protocolVersion": 1
        });
        let credential = validate_pair_response(&good).expect("golden pair response passes");
        assert!(credential.starts_with("device-11111111111111111111111111111111."));

        // deviceId must equal the credential prefix.
        let mismatched = serde_json::json!({
            "deviceId": "device-ffffffffffffffffffffffffffffffff",
            "credential": "device-11111111111111111111111111111111.2222222222222222222222222222222222222222222222222222222222222222",
            "protocolVersion": 1
        });
        assert!(validate_pair_response(&mismatched).is_err());

        let wrong_version = serde_json::json!({
            "deviceId": "device-11111111111111111111111111111111",
            "credential": "device-11111111111111111111111111111111.2222222222222222222222222222222222222222222222222222222222222222",
            "protocolVersion": 2
        });
        assert!(validate_pair_response(&wrong_version).is_err());

        let bad_credential = serde_json::json!({
            "deviceId": "device-11111111111111111111111111111111",
            "credential": "not-a-credential",
            "protocolVersion": 1
        });
        assert!(validate_pair_response(&bad_credential).is_err());
    }

    #[test]
    fn phase_b_r1_session_response_must_match_bundle_schema() {
        // Golden session-response fixture (frozen bundle):
        // { ok:true, protocolVersion:1, deviceId, deviceLabel }.
        let good = serde_json::json!({
            "ok": true,
            "protocolVersion": 1,
            "deviceId": "device-11111111111111111111111111111111",
            "deviceLabel": "Fixture Phone"
        });
        validate_session_response(&good, "device-11111111111111111111111111111111")
            .expect("golden session response passes");

        // ok must be true.
        let not_ok = serde_json::json!({
            "ok": false,
            "protocolVersion": 1,
            "deviceId": "device-11111111111111111111111111111111",
            "deviceLabel": "Fixture Phone"
        });
        assert!(validate_session_response(&not_ok, "device-11111111111111111111111111111111").is_err());

        // deviceId binding: session must belong to the paired device.
        let wrong_device = serde_json::json!({
            "ok": true,
            "protocolVersion": 1,
            "deviceId": "device-ffffffffffffffffffffffffffffffff",
            "deviceLabel": "Fixture Phone"
        });
        assert!(validate_session_response(&wrong_device, "device-11111111111111111111111111111111").is_err());

        // protocolVersion must be 1.
        let wrong_version = serde_json::json!({
            "ok": true,
            "protocolVersion": 2,
            "deviceId": "device-11111111111111111111111111111111",
            "deviceLabel": "Fixture Phone"
        });
        assert!(validate_session_response(&wrong_version, "device-11111111111111111111111111111111").is_err());
    }

    #[test]
    fn phase_b_r1_hello_capabilities_are_validated_but_unknown_fields_ignored() {
        // Golden hello fixture (frozen bundle): capabilities required, runs:false.
        let good = serde_json::json!({
            "instanceId": "desktop-0123456789abcdef0123456789abcdef",
            "displayName": "LuckyRay Desktop",
            "platform": "windows",
            "appVersion": "1.8.0",
            "protocolVersion": 1,
            "certificateFingerprint": "a".repeat(64),
            "capabilities": {
                "pairing": true,
                "authenticatedEvents": true,
                "deviceRevocation": true,
                "runs": false
            }
        });
        validate_hello_identity(&good, "desktop-0123456789abcdef0123456789abcdef", &"a".repeat(64))
            .expect("golden hello with capabilities passes");

        // capabilities.runs must be false for the foundation (const false).
        let runs_true = serde_json::json!({
            "instanceId": "desktop-0123456789abcdef0123456789abcdef",
            "protocolVersion": 1,
            "certificateFingerprint": "a".repeat(64),
            "capabilities": {
                "pairing": true,
                "authenticatedEvents": true,
                "deviceRevocation": true,
                "runs": true
            }
        });
        assert!(validate_hello_identity(&runs_true, "desktop-0123456789abcdef0123456789abcdef", &"a".repeat(64)).is_err());

        // A missing capabilities object must fail the complete-shape gate…
        let no_caps = serde_json::json!({
            "instanceId": "desktop-0123456789abcdef0123456789abcdef",
            "protocolVersion": 1,
            "certificateFingerprint": "a".repeat(64),
        });
        assert!(validate_hello_identity(&no_caps, "desktop-0123456789abcdef0123456789abcdef", &"a".repeat(64)).is_err());

        // …while UNKNOWN response fields are ignored (compatibility:
        // unknownResponseFields = "ignore").
        let extra = serde_json::json!({
            "instanceId": "desktop-0123456789abcdef0123456789abcdef",
            "displayName": "LuckyRay Desktop",
            "platform": "windows",
            "appVersion": "1.8.0",
            "protocolVersion": 1,
            "certificateFingerprint": "a".repeat(64),
            "capabilities": {
                "pairing": true,
                "authenticatedEvents": true,
                "deviceRevocation": true,
                "runs": false,
                "futureThing": true
            },
            "someFutureTopLevel": 7
        });
        validate_hello_identity(&extra, "desktop-0123456789abcdef0123456789abcdef", &"a".repeat(64))
            .expect("unknown response fields are ignored");
    }

    #[test]
    fn phase_b_r2_hello_requires_complete_bounded_identity_shape() {
        let good = serde_json::json!({
            "instanceId": "desktop-0123456789abcdef0123456789abcdef",
            "displayName": "LuckyRay Desktop",
            "platform": "windows",
            "appVersion": "1.8.0",
            "protocolVersion": 1,
            "certificateFingerprint": "a".repeat(64),
            "capabilities": { "pairing": true, "authenticatedEvents": true, "deviceRevocation": true, "runs": false }
        });
        for missing in ["displayName", "platform", "appVersion"] {
            let mut value = good.clone();
            value.as_object_mut().unwrap().remove(missing);
            assert!(validate_hello_identity(&value, "desktop-0123456789abcdef0123456789abcdef", &"a".repeat(64)).is_err(), "missing {missing} must fail");
        }
        for (field, bad) in [
            ("displayName", serde_json::json!(7)),
            ("platform", serde_json::json!("linux")),
            ("appVersion", serde_json::json!(false)),
        ] {
            let mut value = good.clone();
            value[field] = bad;
            assert!(validate_hello_identity(&value, "desktop-0123456789abcdef0123456789abcdef", &"a".repeat(64)).is_err(), "invalid {field} must fail");
        }
        for (field, bad) in [
            ("displayName", "".to_string()),
            ("displayName", "x".repeat(81)),
            ("appVersion", "".to_string()),
            ("appVersion", "x".repeat(65)),
        ] {
            let mut value = good.clone();
            value[field] = serde_json::json!(bad);
            assert!(validate_hello_identity(&value, "desktop-0123456789abcdef0123456789abcdef", &"a".repeat(64)).is_err(), "out-of-bounds {field} must fail");
        }
    }

    #[test]
    fn phase_b_pair_request_body_carries_device_label() {
        // pair-request.schema.json: required [secret, fingerprint, deviceLabel].
        let body = build_pair_request_body(
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            &"a".repeat(64),
            "LuckyRay Mobile",
        );
        assert_eq!(body["secret"], "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
        assert_eq!(body["fingerprint"], "a".repeat(64));
        assert_eq!(body["deviceLabel"], "LuckyRay Mobile");
        assert_eq!(body.as_object().unwrap().len(), 3, "additionalProperties: false");
    }

    #[test]
    fn phase_b_companion_errors_map_to_bounded_notes() {
        // Frozen error fixtures — bounded notes carry the CODE, never the body.
        let cases = [
            (401u16, "AUTH_REVOKED"),
            (429u16, "AUTH_RATE_LIMITED"),
            (401u16, "pairing-secret-invalid"),
            (410u16, "pairing-expired"),
            (409u16, "pairing-replayed"),
            (409u16, "pairing-device-limit"),
            (401u16, "PAIRING_REQUIRED"),
        ];
        for (status, code) in cases {
            let body = serde_json::json!({ "ok": false, "code": code, "message": "some desktop message that must not leak" });
            let note = companion_error_note(status, &body);
            assert!(note.contains(code), "note carries the typed code: {note}");
            assert!(!note.contains("must not leak"), "note must not carry the body message");
        }
        // Unknown code → terminal-for-current-request (bounded), body dropped.
        let unknown = serde_json::json!({ "ok": false, "code": "FUTURE_CODE", "message": "internal detail" });
        let note = companion_error_note(500, &unknown);
        assert!(note.contains("FUTURE_CODE"));
        assert!(!note.contains("internal detail"));
        // Missing code → still bounded.
        let nocode = serde_json::json!({ "ok": false, "message": "internal detail" });
        let note = companion_error_note(500, &nocode);
        assert!(!note.contains("internal detail"));
        // P2 review: a nonconformant oversized code is truncated (bounded).
        let oversized = serde_json::json!({ "ok": false, "code": "X".repeat(200), "message": "internal detail" });
        let note = companion_error_note(500, &oversized);
        assert!(note.contains("X".repeat(64).as_str()));
        assert!(!note.contains("X".repeat(65).as_str()), "code must be truncated to 64 chars");
    }

    // ---- M3-M1 R2: durable connection intent gates automatic resume. ----

    #[test]
    fn r2_resume_intent_defaults_to_auto_and_manual_stop_vetoes_it() {
        let db = temp_db();

        // A device paired before this key existed has no stored intent; the
        // standing pairing is the opt-in, so resume is allowed.
        assert_eq!(db.meta_get(CONN_INTENT_KEY).expect("meta read"), None);
        assert!(conn_intent_allows_resume(&db), "missing intent defaults to auto");

        // An explicit 断开连接 is a standing opt-out and must survive a restart.
        db.meta_set(CONN_INTENT_KEY, CONN_INTENT_MANUAL_STOP).expect("meta write");
        assert!(!conn_intent_allows_resume(&db), "manual stop vetoes resume");

        // Reconnecting (ws_start) restores the opt-in.
        db.meta_set(CONN_INTENT_KEY, CONN_INTENT_AUTO).expect("meta write");
        assert!(conn_intent_allows_resume(&db), "explicit connect re-enables resume");

        // A corrupt/unknown value is treated as auto — it never silently
        // disables a user's standing pairing.
        db.meta_set(CONN_INTENT_KEY, "unexpected-value").expect("meta write");
        assert!(conn_intent_allows_resume(&db), "unknown intent falls back to auto");
    }

    #[test]
    fn r2_connection_intent_survives_a_reopen() {
        // The intent is durable across a process restart — the EXACT case the
        // task card requires (desktop truly exits, then starts again).
        let (db, path) = temp_db_at();
        db.meta_set(CONN_INTENT_KEY, CONN_INTENT_MANUAL_STOP).expect("meta write");
        drop(db);

        let reopened = Db::open(&path).expect("reopen db");
        assert!(
            !conn_intent_allows_resume(&reopened),
            "a manual stop must still veto resume after a real reopen"
        );
    }

    // ---- R2-REPAIR-R3 M1/M2: intent read classification, mirror veto, and
    // the stop/resume race with a controllable sync point. ----

    #[test]
    fn r3_intent_read_distinguishes_missing_failure_and_manual_stop() {
        let db = temp_db();

        // Legacy / never-written: the standing pairing is the opt-in.
        assert_eq!(read_conn_intent(&db), ConnectionIntent::Auto);
        assert!(conn_intent_allows_resume(&db));

        // Explicit opt-out.
        db.meta_set(CONN_INTENT_KEY, CONN_INTENT_MANUAL_STOP).expect("meta write");
        assert_eq!(read_conn_intent(&db), ConnectionIntent::ManualStop);
        assert!(!conn_intent_allows_resume(&db));

        // Explicit auto, and an unrecognised value, both resume.
        db.meta_set(CONN_INTENT_KEY, CONN_INTENT_AUTO).expect("meta write");
        assert_eq!(read_conn_intent(&db), ConnectionIntent::Auto);
        db.meta_set(CONN_INTENT_KEY, "future-value").expect("meta write");
        assert_eq!(read_conn_intent(&db), ConnectionIntent::Auto);

        // A BROKEN READ must not be indistinguishable from "no key": dropping
        // the meta table forces the read to fail, and that must fail closed.
        let (broken, path) = temp_db_at();
        drop(broken);
        let read_only = Db::open(&path).expect("reopen");
        {
            let conn = rusqlite::Connection::open(&path).expect("raw connection");
            conn.execute_batch("DROP TABLE app_meta;").expect("drop meta table");
        }
        assert_eq!(
            read_conn_intent(&read_only),
            ConnectionIntent::Unavailable,
            "a failed read must never look like an authorising missing key"
        );
        assert!(
            !conn_intent_allows_resume(&read_only),
            "a failed read must not authorise automatic recovery"
        );
    }

    #[test]
    fn r3_mirror_manual_stop_vetoes_resume_even_when_the_save_failed() {
        // The exact M2 hazard: the durable write fails, so the DB still says
        // auto. The in-memory mirror must keep vetoing for this process.
        let db = temp_db();
        assert_eq!(read_conn_intent(&db), ConnectionIntent::Auto);
        let mirror = ConnIntentMirror::seeded(read_conn_intent(&db));

        // User disconnects; the preference save fails (simulated by simply
        // not writing it) but the mirror flips.
        mirror.set(ConnectionIntent::ManualStop);

        assert_eq!(mirror.get(), ConnectionIntent::ManualStop);
        assert_eq!(
            read_conn_intent(&db),
            ConnectionIntent::Auto,
            "the durable value is unchanged in this simulation"
        );
        assert!(
            !matches!(mirror.get(), ConnectionIntent::Auto),
            "the in-process authority must not authorise resume after a stop whose save failed"
        );
    }

    #[test]
    fn r3_mirror_seeded_from_a_failed_startup_read_fails_closed() {
        let mirror = ConnIntentMirror::seeded(ConnectionIntent::Unavailable);
        assert_eq!(mirror.get(), ConnectionIntent::Unavailable);
        assert!(!matches!(mirror.get(), ConnectionIntent::Auto));

        // And a healthy seed still honours a stored manual stop.
        let stopped = ConnIntentMirror::seeded(ConnectionIntent::ManualStop);
        assert_eq!(stopped.get(), ConnectionIntent::ManualStop);
        let auto = ConnIntentMirror::seeded(ConnectionIntent::Auto);
        assert_eq!(auto.get(), ConnectionIntent::Auto);
    }

    // A controllable sync point proving the stop/resume ordering: stop takes
    // the SAME gate, so a resume that observed the pre-stop epoch is rejected
    // instead of leaving a live worker behind. This mirrors the REAL command
    // shape (gate -> epoch check -> intent read -> start), not just a key:value
    // assertion.
    #[tokio::test]
    async fn r3_stop_serialises_against_a_resume_that_read_auto_first() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let lifecycle = ConnectionLifecycle::new();
        let eventstream = EventStreamClient::new();
        let starts = Arc::new(AtomicUsize::new(0));
        let mirror = ConnIntentMirror::seeded(ConnectionIntent::Auto);
        // Resume read the intent BEFORE taking the gate — the exact stale read
        // the central ruling describes.
        let read_before_gate = mirror.get();
        assert_eq!(read_before_gate, ConnectionIntent::Auto);

        let resume_entered = Arc::new(tokio::sync::Barrier::new(2));
        let stop_done = Arc::new(tokio::sync::Barrier::new(2));
        let observed_epoch = lifecycle.observe();

        let resume_lifecycle = lifecycle.clone();
        let resume_starts = Arc::clone(&starts);
        let resume_entered_tx = Arc::clone(&resume_entered);
        let stop_done_rx = Arc::clone(&stop_done);
        let stale_resume = tokio::spawn(async move {
            resume_entered_tx.wait().await;
            // The stop completes (and invalidates) while this request is
            // parked here, still holding only the stale pre-gate read.
            stop_done_rx.wait().await;
            resume_lifecycle
                .run_if_current(observed_epoch, || async move {
                    resume_starts.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                })
                .await
        });

        resume_entered.wait().await;
        {
            // An explicit stop, exactly as ws_stop does it.
            let _guard = lifecycle.lock().await;
            lifecycle.invalidate();
            eventstream.stop().await;
            mirror.set(ConnectionIntent::ManualStop);
        }
        stop_done.wait().await;

        let result = stale_resume.await.expect("resume task joins");
        assert!(result.is_err(), "the stale resume is rejected, not silently applied");
        assert_eq!(
            starts.load(Ordering::SeqCst),
            0,
            "no worker start survives a completed explicit stop"
        );
        assert_eq!(
            eventstream.ownership_snapshot(),
            (false, false),
            "no worker/handle/stop slot survives the stop"
        );
        assert_eq!(mirror.get(), ConnectionIntent::ManualStop);
    }

    #[tokio::test]
    async fn r3_explicit_reconnect_after_stop_restores_the_opt_in() {
        // The user's follow-up 重新连接 must work even though the earlier stop
        // wrote an opt-out — the veto is not permanent.
        let lifecycle = ConnectionLifecycle::new();
        let eventstream = EventStreamClient::new();
        let mirror = ConnIntentMirror::seeded(ConnectionIntent::Auto);
        let db = temp_db();

        // Stop.
        {
            let _guard = lifecycle.lock().await;
            lifecycle.invalidate();
            eventstream.stop().await;
            mirror.set(ConnectionIntent::ManualStop);
            db.meta_set(CONN_INTENT_KEY, CONN_INTENT_MANUAL_STOP).expect("meta write");
        }
        assert!(!conn_intent_allows_resume(&db));

        // Explicit reconnect runs under the same gate and restores auto.
        let observed = lifecycle.observe();
        let started = lifecycle
            .run_if_current(observed, || async {
                mirror.set(ConnectionIntent::Auto);
                db.meta_set(CONN_INTENT_KEY, CONN_INTENT_AUTO).map_err(|e| e.to_string())?;
                Ok(())
            })
            .await;
        assert!(started.is_ok(), "explicit reconnect after a stop succeeds");
        assert_eq!(mirror.get(), ConnectionIntent::Auto);
        assert!(conn_intent_allows_resume(&db), "durable opt-in is restored");
    }

    #[tokio::test]
    async fn r3_forget_still_wins_and_clears_the_intent_mirror() {
        // The pre-existing forget guarantee must survive the new gate usage:
        // forget invalidates and clears both the durable value and the mirror.
        let lifecycle = ConnectionLifecycle::new();
        let eventstream = EventStreamClient::new();
        let mirror = ConnIntentMirror::seeded(ConnectionIntent::ManualStop);
        let db = temp_db();
        db.meta_set(CONN_INTENT_KEY, CONN_INTENT_MANUAL_STOP).expect("meta write");

        let observed = lifecycle.observe();
        let _guard = lifecycle.lock().await;
        lifecycle.invalidate();
        eventstream.stop().await;
        db.meta_set(CONN_INTENT_KEY, CONN_INTENT_AUTO).expect("meta write");
        mirror.set(ConnectionIntent::Auto);
        drop(_guard);

        assert_eq!(mirror.get(), ConnectionIntent::Auto, "forget clears the opt-out");
        assert!(conn_intent_allows_resume(&db));
        assert_eq!(eventstream.ownership_snapshot(), (false, false));

        // A start queued against the pre-forget epoch is still rejected.
        let stale = lifecycle
            .run_if_current(observed, || async { Ok::<(), String>(()) })
            .await;
        assert!(stale.is_err(), "pre-forget start remains stale");
    }

    // -----------------------------------------------------------------------
    // MATERIAL-LIBRARY-INSTANT-R1 PHYSICAL-REPAIR-R6 (3) — the thumbnail
    // format authority: real suffixes from real bytes, legacy `.img` migration,
    // and the owner fence the thumbnail path still rides on.
    // -----------------------------------------------------------------------

    mod r6_thumb {
        use super::*;

        // Minimal real payloads — magic bytes only, never full images.
        fn png() -> Vec<u8> {
            let mut v = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
            v.extend_from_slice(&[0u8; 16]);
            v
        }
        fn jpeg() -> Vec<u8> { vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10] }
        fn webp() -> Vec<u8> {
            let mut v = b"RIFF".to_vec();
            v.extend_from_slice(&[0x24, 0x00, 0x00, 0x00]);
            v.extend_from_slice(b"WEBPVP8 ");
            v
        }
        fn avif() -> Vec<u8> {
            let mut v = vec![0x00, 0x00, 0x00, 0x1C];
            v.extend_from_slice(b"ftypavif");
            v.extend_from_slice(&[0u8; 8]);
            v
        }
        fn heic() -> Vec<u8> {
            let mut v = vec![0x00, 0x00, 0x00, 0x18];
            v.extend_from_slice(b"ftypheic");
            v.extend_from_slice(&[0u8; 8]);
            v
        }
        fn riff_not_webp() -> Vec<u8> {
            let mut v = b"RIFF".to_vec();
            v.extend_from_slice(&[0x10, 0x00, 0x00, 0x00]);
            v.extend_from_slice(b"WAVEfmt ");
            v
        }

        #[test]
        fn r6_sniff_identifies_each_safe_format() {
            assert_eq!(sniff_thumb_format(&png()), ThumbFormat::Png);
            assert_eq!(sniff_thumb_format(&jpeg()), ThumbFormat::Jpeg);
            assert_eq!(sniff_thumb_format(&webp()), ThumbFormat::Webp);
            assert_eq!(sniff_thumb_format(&avif()), ThumbFormat::Avif);
        }

        #[test]
        fn r6_sniff_is_fail_closed() {
            assert_eq!(sniff_thumb_format(b""), ThumbFormat::Unknown);
            assert_eq!(sniff_thumb_format(&[0x89, 0x50]), ThumbFormat::Unknown, "truncated PNG magic");
            assert_eq!(sniff_thumb_format(&riff_not_webp()), ThumbFormat::Unknown, "RIFF but not WEBP");
            assert_eq!(sniff_thumb_format(&heic()), ThumbFormat::Unknown,
                "other HEIF brands are real formats but are NOT in the sanctioned suffix vocabulary");
            assert_eq!(sniff_thumb_format(b"GIF89a......"), ThumbFormat::Unknown, "GIF is not guessed either");
        }

        #[test]
        fn r6_extension_maps_only_safe_formats() {
            assert_eq!(thumb_extension(&png()), ".png");
            assert_eq!(thumb_extension(&jpeg()), ".jpg");
            assert_eq!(thumb_extension(&webp()), ".webp");
            assert_eq!(thumb_extension(&avif()), ".avif");
            assert_eq!(thumb_extension(b"not an image at all"), ".img", "unknown keeps the honest .img");
        }

        // MIME/magic conflict: the BYTES win. The extension decision never
        // consults the MIME, so a response labelled image/webp that actually
        // carries JPEG bytes is cached as .jpg.
        #[test]
        fn r6_mime_conflict_bytes_win() {
            let mislabelled_webp = jpeg();
            assert_eq!(thumb_extension(&mislabelled_webp), ".jpg");
            let mislabelled_png = webp();
            assert_eq!(thumb_extension(&mislabelled_png), ".webp");
            // And a known MIME over unknown bytes still never guesses a suffix.
            assert_eq!(thumb_extension(b"????"), ".img");
        }

        #[test]
        fn r6_cache_name_carries_real_suffix_and_sanitised_etag() {
            assert_eq!(
                thumb_cache_name("A", "x1", "\"v1\"", &png()),
                "thumb-A-x1-v1.png"
            );
            assert_eq!(
                thumb_cache_name("A", "x1", "\"v1\"", &jpeg()),
                "thumb-A-x1-v1.jpg"
            );
            // A forced retry passes an empty etag; the name is still byte-typed.
            assert_eq!(thumb_cache_name("A", "x1", "", &webp()), "thumb-A-x1-.webp");
            assert_eq!(thumb_cache_name("A", "x1", "\"v2\"", &heic()), "thumb-A-x1-v2.img");
        }

        // ---- legacy `.img` migration --------------------------------------

        fn legacy_dir(tag: &str) -> std::path::PathBuf {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let dir = std::env::temp_dir().join(format!("luckyray-r6-{tag}-{nanos}"));
            std::fs::create_dir_all(&dir).expect("mkdir");
            dir
        }

        fn meta_for(path: &std::path::Path, etag: &str, mime: &str) -> crate::db::ThumbMeta {
            crate::db::ThumbMeta {
                path: path.to_string_lossy().to_string(),
                etag: etag.to_string(),
                mime: mime.to_string(),
                w: 640,
                h: 480,
            }
        }

        #[test]
        fn r6_migration_renames_each_safe_format() {
            for (bytes, ext) in [(png(), "png"), (jpeg(), "jpg"), (webp(), "webp"), (avif(), "avif")] {
                let dir = legacy_dir(&format!("mig-{ext}"));
                let old = dir.join("thumb-A-x1-v1.img");
                std::fs::write(&old, &bytes).expect("write legacy");
                let meta = meta_for(&old, "v1", "image/whatever");
                let Some(new_path) = migrate_legacy_thumb(&meta) else {
                    panic!("{ext} was not migrated");
                };
                assert!(new_path.ends_with(&format!(".{ext}")), "renamed to the real suffix: {new_path}");
                assert!(!old.exists(), "the legacy name is gone");
                assert!(std::path::Path::new(&new_path).exists(), "the bytes live under the new name");
                let back = std::fs::read(&new_path).expect("read migrated");
                assert_eq!(back, bytes, "the bytes are byte-identical");
            }
        }

        #[test]
        fn r6_migration_unknown_keeps_the_old_file() {
            let dir = legacy_dir("unknown");
            let old = dir.join("thumb-A-x1-v1.img");
            std::fs::write(&old, b"mystery bytes").expect("write legacy");
            let meta = meta_for(&old, "v1", "image/png"); // a MIME claiming png must not force a guess
            assert!(migrate_legacy_thumb(&meta).is_none(), "unknown bytes are never renamed");
            assert!(old.exists(), "the original valid cache file is INTACT");
        }

        #[test]
        fn r6_migration_failure_keeps_the_old_file() {
            // Missing file: nothing to migrate, and the call is inert.
            let dir = legacy_dir("missing");
            let ghost = dir.join("thumb-A-x1-v1.img");
            let meta = meta_for(&ghost, "v1", "image/png");
            assert!(migrate_legacy_thumb(&meta).is_none());
            // Unreadable directory-as-file: fs::read fails -> None, original preserved.
            let dir2 = legacy_dir("unreadable");
            let blocked = dir2.join("thumb-A-x1-v1.img");
            std::fs::create_dir(&blocked).expect("a directory where the file should be");
            let meta2 = meta_for(&blocked, "v1", "image/png");
            assert!(migrate_legacy_thumb(&meta2).is_none(), "an unreadable payload does not migrate");
            assert!(blocked.exists(), "nothing was destroyed");
        }

        #[test]
        fn r6_migration_ignores_already_typed_files() {
            let dir = legacy_dir("already");
            let typed = dir.join("thumb-A-x1-v1.png");
            std::fs::write(&typed, png()).expect("write typed");
            let meta = meta_for(&typed, "v1", "image/png");
            assert!(migrate_legacy_thumb(&meta).is_none(), "non-.img files are never touched");
            assert!(typed.exists());
        }

        // The DB row survives a migration with owner + asset + etag intact.
        #[test]
        fn r6_migration_db_row_preserves_owner_asset_etag() {
            let (mut db, _path) = temp_db_at();
            db.upsert_paired("B", "PC", "windows", "1.0", 1, "fpB", "http://b")
                .expect("seed B");
            // The thumbnail row rides on an asset_cache row for (owner, id).
            db.upsert_asset("B", "x9", "sample.png", "image", "image/webp", 1_000, "2026-01-01T00:00:00Z", "h1", "r1", "", &[])
                .expect("seed asset row");
            let dir = legacy_dir("dbrow");
            let old = dir.join("thumb-B-x9-etag7.img");
            std::fs::write(&old, webp()).expect("write legacy");
            db.set_thumbnail("B", "x9", old.to_str().unwrap(), "etag7", "image/webp", 100, 80)
                .expect("seed row");

            let meta = db.thumbnail_meta("B", "x9").expect("read row").expect("row exists");
            let Some(new_path) = migrate_legacy_thumb(&meta) else { panic!("not migrated") };
            // The caller (asset_thumbnail) updates the row with the SAME
            // owner/asset/etag/mime/dims and only the new path:
            db.set_thumbnail("B", "x9", &new_path, &meta.etag, &meta.mime, meta.w, meta.h)
                .expect("update row");

            let after = db.thumbnail_meta("B", "x9").expect("read row").expect("row exists");
            assert_eq!(after.path, new_path);
            assert_eq!(after.etag, "etag7", "etag preserved: no re-download is implied");
            assert_eq!(after.mime, "image/webp");
            assert_eq!((after.w, after.h), (100, 80));
            // And the owner scoping of the row is still exact: A cannot see it.
            assert!(db.thumbnail_meta("A", "x9").expect("read").is_none(),
                "the row stays owner-scoped after migration");
        }

        // The thumbnail path's owner fence: the capture names the instance the
        // whole operation is keyed by, and a different/empty owner is refused
        // before anything is read or written.
        #[test]
        fn r6_owner_fence_rejects_wrong_and_empty_owner() {
            let state = g1e_state("A", "http://a");
            let ok = crate::content::expected_thumbnail_source(&state, "A")
                .expect("the paired owner captures");
            assert_eq!(ok.instance(), "A");
            let wrong = crate::content::expected_thumbnail_source(&state, "B")
                .err().expect("a different Desktop is refused").to_string();
            assert!(wrong.contains("CONTENT_SOURCE_CHANGED"), "err: {wrong}");
            let empty = crate::content::expected_thumbnail_source(&state, "")
                .err().expect("an unnamed owner is refused").to_string();
            assert!(empty.contains("CONTENT_SOURCE_CHANGED") || empty.to_lowercase().contains("empty"),
                "err: {empty}");
        }
    }
}
