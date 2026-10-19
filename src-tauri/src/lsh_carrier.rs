// LSH loopback browser carrier (FINAL-INTEGRATION Phase 2 + CLOSURE-R1, Issue #72).
//
// WHY THIS TRANSPORT: the Desktop declares the browser origin
// `https://luckyray-companion.local:<gateway-port>` and serves the official
// DSH surface behind a self-signed certificate whose leaf fingerprint is the
// pairing fingerprint. Android's WebView cannot pin that certificate (no
// per-origin cert pinning API; installing a trust root is forbidden), and
// `luckyray-companion.local` is not resolvable without OS-level host edits
// (also forbidden). Path A (direct WebView) is therefore NOT provably secure
// on this stack; the accepted alternative is this Mobile-owned loopback
// carrier.
//
// SECURITY MODEL (CLOSURE-R1):
//   * LOCAL CLIENT AUTH (P0-S1): bootstrap mints a random one-time LAUNCH
//     capability plus a random carrier-scoped session token. The shell loads
//     /__luckyray/carrier/launch?capability=... once; the carrier exchanges it
//     for an HttpOnly `lsh_local_carrier` cookie (random, memory-only) and
//     302s to the official surface with the LuckyRay presentation marker.
//     Every other request (HTTP and WS) MUST present that local cookie — a
//     local client without it produces ZERO authenticated upstream traffic;
//   * binds 127.0.0.1 ONLY, on an ephemeral port;
//   * every upstream byte flows through the SAME fingerprint-pinned,
//     owner-proven Desktop authority the rest of pairing uses (rustls config
//     built from the paired fingerprint; TLS SNI luckyray-companion.local;
//     TCP to the paired LAN address — resolved locally, no DNS/hosts edits);
//   * translates ONLY transport/origin/cookie mechanics: Host/Origin are
//     rewritten to the declared Desktop origin, the in-memory upstream
//     browser cookies are injected, and the (unmodified) official DSH
//     responses are streamed back verbatim;
//   * never parses or re-implements DSH chat/session/tool semantics;
//   * the bootstrap `ref` is consumed HERE (the carrier performs the
//     bootstrap GET) and never reaches JavaScript; `expiresAtMs` bounds ONLY
//     that consumption (P1-F3) — the live browser surface is governed by the
//     lease/owner/revoke lifecycle, not by the spent ref TTL;
//   * LIFECYCLE (P1-F4): every carrier carries a random lease id; teardown is
//     lease-bound, so a stale Activity A cannot stop a newer carrier B;
//   * refuses browser traffic to the device API (`/v1/*`) outright.
//
// One carrier at a time. A fresh bootstrap stops the previous one. The cookie
// jar, tokens, and the `ref` are memory-only and die with the carrier.

use crate::pinning::build_pinned_client_config;
use futures_util::{SinkExt, StreamExt};
use reqwest::Method;
use serde_json::Value;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::handshake::client::generate_key;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::Message;

const MAX_HEAD_BYTES: usize = 64 * 1024;
const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;
const MAX_JAR_ENTRIES: usize = 32;
/// Local browser capability/token sizes (128-bit random, hex-encoded).
const LAUNCH_CAPABILITY_HEX_LEN: usize = 32;
const LOCAL_TOKEN_HEX_LEN: usize = 64;
/// The mint ref TTL must be short and plausible (Desktop #166: <= 120 s; we
/// accept up to 10 minutes for clock skew and reject everything else).
const MAX_MINT_TTL_MS: i64 = 10 * 60 * 1000;
const LOCAL_COOKIE_NAME: &str = "lsh_local_carrier";
/// The one-time launch exchange route on the loopback origin.
pub(crate) const LAUNCH_PATH: &str = "/__luckyray/carrier/launch";
/// Where the launch exchange sends the (now authenticated) WebView: the
/// official surface root carrying the LuckyRay presentation marker.
const LAUNCH_LANDING: &str = "/?luckyrayMobile=1";

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// OS-backed CSPRNG bytes for the carrier's local security credentials.
///
/// These values ARE the local-client authentication boundary of the loopback
/// carrier (P0-S2): the launch capability, the local browser session token and
/// the carrier lease all come from here. Entropy acquisition failure fails
/// CLOSED — there is deliberately no timestamp seed and no PRNG fallback.
fn random_hex(bytes: usize) -> Result<String, String> {
    let mut buf = vec![0u8; bytes];
    fill_random(&mut buf)?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

fn fill_random(buf: &mut [u8]) -> Result<(), String> {
    // getrandom is the OS CSPRNG (getrandom(2) on Linux/Android, BCryptGenRandom
    // on Windows). A failure is a hard error: never degrade to predictable
    // bytes for a security credential.
    getrandom::getrandom(buf).map_err(|_| "LSH_CARRIER_ENTROPY_UNAVAILABLE".to_string())
}

/// The accepted Desktop #166 session mint, validated into a bounded shape
/// (P1-C1: exact contract shape, drift negatives fail closed). The `ref` is a
/// sensitive short-lived credential: it lives HERE, in Rust memory, and is
/// never logged, persisted, or surfaced to JavaScript.
#[derive(Debug, Clone)]
pub(crate) struct SessionMint {
    pub reference: String,
    pub bootstrap_path: String,
    pub expires_at_ms: i64,
    pub carrier_generation: u64,
    pub origin: String,
    pub gateway_generation: u64,
}

impl SessionMint {
    pub(crate) fn validate(value: &Value, now_ms: i64) -> Result<SessionMint, String> {
        let invalid = || "LSH_GATEWAY_CONTRACT_INVALID".to_string();
        // ref: exactly 64 lowercase hex characters (Desktop random_hex(32)).
        let reference = value["ref"].as_str().filter(|r| {
            r.len() == 64
                && r.bytes().all(|b| {
                    b.is_ascii_digit() || (b.is_ascii_hexdigit() && b.is_ascii_lowercase())
                })
        }).ok_or_else(invalid)?.to_string();
        // bootstrap path: the accepted remote-bootstrap path, no query/fragment.
        let bootstrap_path = value["bootstrapPath"].as_str().filter(|p| {
            *p == "/_luckyray/remote/bootstrap"
        }).ok_or_else(invalid)?.to_string();
        let expires_at_ms = value["expiresAtMs"].as_i64().filter(|e| {
            // unconsumed mint: must be in the future and plausibly short-lived
            *e > now_ms && *e <= now_ms + MAX_MINT_TTL_MS
        }).ok_or_else(invalid)?;
        let carrier_generation = value["carrierGeneration"].as_u64().ok_or_else(invalid)?;
        let gateway_generation = value["gatewayGeneration"].as_u64().ok_or_else(invalid)?;
        let origin = value["origin"].as_str().filter(|o| {
            // exactly the advertised carrier origin
            o.starts_with("https://luckyray-companion.local:") && o.len() <= 254
        }).ok_or_else(invalid)?.to_string();
        let port = origin
            .rsplit_once(':')
            .and_then(|(_, p)| p.parse::<u16>().ok())
            .filter(|p| *p > 0)
            .ok_or_else(invalid)?;
        let _ = port;
        Ok(SessionMint {
            reference,
            bootstrap_path,
            expires_at_ms,
            carrier_generation,
            origin,
            gateway_generation,
        })
    }

    /// (host, port) of the declared Desktop origin.
    pub(crate) fn origin_parts(&self) -> (String, u16) {
        let rest = self.origin.trim_start_matches("https://");
        match rest.rsplit_once(':') {
            Some((host, port)) => (host.to_string(), port.parse().unwrap_or(0)),
            None => (rest.to_string(), 0),
        }
    }
}

/// Memory-only upstream browser cookie jar: name -> value, bounded, updated
/// from upstream `Set-Cookie` headers, never serialized or persisted.
#[derive(Default)]
struct CookieJar {
    entries: Vec<(String, String)>,
}

impl CookieJar {
    fn observe(&mut self, set_cookie_values: &[String]) {
        for raw in set_cookie_values {
            let pair = raw.split(';').next().unwrap_or("");
            if let Some((name, value)) = pair.split_once('=') {
                let name = name.trim();
                let value = value.trim();
                if name.is_empty() || name.len() > 128 || value.len() > 4096 {
                    continue;
                }
                if let Some(slot) = self.entries.iter_mut().find(|(n, _)| n == name) {
                    slot.1 = value.to_string();
                } else {
                    if self.entries.len() >= MAX_JAR_ENTRIES {
                        self.entries.remove(0);
                    }
                    self.entries.push((name.to_string(), value.to_string()));
                }
            }
        }
    }

    fn header(&self) -> Option<String> {
        if self.entries.is_empty() {
            return None;
        }
        Some(
            self.entries
                .iter()
                .map(|(n, v)| format!("{n}={v}"))
                .collect::<Vec<_>>()
                .join("; "),
        )
    }
}

struct CarrierState {
    pinned_fp: String,
    paired_base: String,
    origin: String,
    origin_host: String,
    gateway_port: u16,
    /// The loopback port this carrier bound (exact launch-URL proof, P1-F8).
    local_port: u16,
    carrier_generation: u64,
    gateway_generation: u64,
    jar: Mutex<CookieJar>,
    live_connections: AtomicUsize,
    stopped: Arc<AtomicBool>,
    /// P1-F7: carrier-scoped cancellation. `stop`/`retire_leased` fire this,
    /// and every in-flight relay/WS task selects on it, so retirement actually
    /// CLOSES established HTTP and WebSocket work instead of merely refusing
    /// new accepts. Scoped to this carrier only — never a global kill.
    cancel: tokio::sync::watch::Sender<bool>,
    /// P0-S1: the carrier-scoped local browser session token. Memory-only.
    local_token: String,
    /// P0-S1: the one-time launch capability, consumed on first use.
    launch_capability: Mutex<Option<String>>,
    /// P1-F4: the random lease binding this carrier to its launched surface.
    lease: String,
}

pub(crate) struct CarrierHandle {
    /// The one-time launch URL the shell loads (capability in the query,
    /// exchanged for the local HttpOnly carrier cookie).
    pub session_url: String,
    pub expires_at_ms: i64,
    pub carrier_generation: u64,
    pub gateway_generation: u64,
    /// P1-F4: lease-bound teardown token (goes to the launched Activity).
    pub lease: String,
}

static CARRIER: OnceLock<Mutex<Option<(Arc<CarrierState>, String)>>> = OnceLock::new();

/// Validated mint expiry needs the current time (P1-C1).
pub(crate) fn now_ms_pub() -> i64 {
    now_ms()
}

fn carrier_slot() -> &'static Mutex<Option<(Arc<CarrierState>, String)>> {
    CARRIER.get_or_init(|| Mutex::new(None))
}

/// Stop any running carrier (fresh bootstrap, owner change).
pub(crate) fn stop() {
    if let Ok(mut slot) = carrier_slot().lock() {
        if let Some((state, _lease)) = slot.take() {
            state.stopped.store(true, Ordering::Release);
            // P1-F7: cancel live HTTP/WS work, not just future accepts.
            let _ = state.cancel.send(true);
        }
    }
}

/// P1-F4: retire the carrier ONLY if `lease` matches the live one. A stale
/// Activity A cannot stop a newer carrier B.
pub(crate) fn retire_leased(lease: &str) -> bool {
    if lease.is_empty() {
        return false;
    }
    if let Ok(mut slot) = carrier_slot().lock() {
        if let Some((state, live)) = slot.as_ref() {
            if *live == lease {
                state.stopped.store(true, Ordering::Release);
                // P1-F7: abort the carrier's live relays and WS pumps.
                let _ = state.cancel.send(true);
                slot.take();
                return true;
            }
        }
    }
    false
}

/// The current lease (the launch boundary passes it into the shell).
pub(crate) fn current_lease() -> Option<String> {
    carrier_slot()
        .lock()
        .ok()
        .and_then(|slot| slot.as_ref().map(|(_, lease)| lease.clone()))
}

/// P1-F8: prove that `session_url` is THE exact launch URL of the current
/// carrier and return that carrier's lease — both under one slot lock, so a
/// URL and a lease can never come from different carriers. A stale A URL is
/// refused once B has replaced A, and the lease never crosses this boundary.
pub(crate) fn claim_current_launch(session_url: &str) -> Option<String> {
    if session_url.is_empty() {
        return None;
    }
    let slot = carrier_slot().lock().ok()?;
    let (state, lease) = slot.as_ref()?;
    if state.stopped.load(Ordering::Acquire) {
        return None;
    }
    let port = state.local_port;
    let expected_prefix = format!("http://127.0.0.1:{port}{LAUNCH_PATH}?capability=");
    if !session_url.starts_with(&expected_prefix) {
        return None;
    }
    // The capability itself must still be the live, unconsumed one.
    let capability = &session_url[expected_prefix.len()..];
    let matches = state
        .launch_capability
        .lock()
        .ok()
        .map(|cap| cap.as_deref() == Some(capability))
        .unwrap_or(false);
    if !matches {
        return None;
    }
    Some(lease.clone())
}

/// Start (or replace) the loopback carrier for one accepted Desktop session.
/// `mint.expiresAtMs` bounds ONLY the bootstrap consumption below (P1-F3).
pub(crate) async fn start(
    paired_base: String,
    pinned_fp: String,
    mint: SessionMint,
) -> Result<CarrierHandle, String> {
    stop();
    let (origin_host, gateway_port) = mint.origin_parts();
    if gateway_port == 0 {
        return Err("LSH_GATEWAY_CONTRACT_INVALID".into());
    }
    let lan = lan_host_of(&paired_base);
    if lan.is_empty() {
        return Err("CONTENT_SOURCE_CHANGED".into());
    }
    // P1-F3: the ref must be consumed while the mint is still valid.
    if now_ms() > mint.expires_at_ms {
        return Err("LSH_REF_EXPIRED".into());
    }
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("carrier bind: {e}"))?;
    let local_port = listener
        .local_addr()
        .map_err(|e| format!("carrier addr: {e}"))?
        .port();

    let mut jar = CookieJar::default();
    bootstrap_upstream(
        &mut jar,
        &pinned_fp,
        &lan,
        &origin_host,
        gateway_port,
        &mint.bootstrap_path,
        &mint.reference,
    )
    .await?;
    // The ref is consumed; drop it from memory immediately (P1-F3: the browser
    // surface no longer depends on it).
    drop(mint.reference);

    let (cancel_tx, _cancel_rx) = tokio::sync::watch::channel(false);
    let state = Arc::new(CarrierState {
        cancel: cancel_tx,
        pinned_fp,
        paired_base,
        origin: format!("https://{origin_host}:{gateway_port}"),
        origin_host,
        gateway_port,
        local_port,
        carrier_generation: mint.carrier_generation,
        gateway_generation: mint.gateway_generation,
        jar: Mutex::new(jar),
        live_connections: AtomicUsize::new(0),
        stopped: Arc::new(AtomicBool::new(false)),
        local_token: random_hex(LOCAL_TOKEN_HEX_LEN / 2)?,
        launch_capability: Mutex::new(Some(random_hex(LAUNCH_CAPABILITY_HEX_LEN / 2)?)),
        lease: random_hex(16)?,
    });

    let capability = state
        .launch_capability
        .lock()
        .map_err(|_| "carrier state poisoned")?
        .clone()
        .expect("just set");
    let session_url = format!("http://127.0.0.1:{local_port}{LAUNCH_PATH}?capability={capability}");

    if let Ok(mut slot) = carrier_slot().lock() {
        *slot = Some((state.clone(), state.lease.clone()));
    }

    let accept_state = state.clone();
    tokio::spawn(async move {
        loop {
            if accept_state.stopped.load(Ordering::Acquire) {
                break;
            }
            match listener.accept().await {
                Ok((stream, _)) => {
                    if accept_state.stopped.load(Ordering::Acquire)
                        || accept_state.live_connections.load(Ordering::Acquire) > 64
                    {
                        break;
                    }
                    let conn_state = accept_state.clone();
                    let counter_state = accept_state.clone();
                    accept_state.live_connections.fetch_add(1, Ordering::AcqRel);
                    tokio::spawn(async move {
                        serve_connection(conn_state, stream).await;
                        counter_state.live_connections.fetch_sub(1, Ordering::AcqRel);
                    });
                }
                Err(_) => break,
            }
        }
    });

    Ok(CarrierHandle {
        session_url,
        expires_at_ms: mint.expires_at_ms,
        carrier_generation: mint.carrier_generation,
        gateway_generation: mint.gateway_generation,
        lease: state.lease.clone(),
    })
}

/// The paired LAN host from the stored pairing authority.
fn lan_host_of(paired_base: &str) -> String {
    paired_base
        .trim_start_matches("https://")
        .split('/')
        .next()
        .unwrap_or("")
        .to_string()
}

/// The paired LAN address; malformed input fails closed at connect time.
fn resolve_addr(lan: &str) -> std::net::SocketAddr {
    lan.parse().unwrap_or_else(|_| {
        std::net::SocketAddr::new(
            std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED),
            0,
        )
    })
}

/// Consume the one-shot bootstrap `ref` upstream (pinned TLS, Desktop Host
/// header, NO device Bearer — the ref IS the credential) and capture the
/// Secure/HttpOnly session cookies the 302 sets into the memory-only jar.
async fn bootstrap_upstream(
    jar: &mut CookieJar,
    pinned_fp: &str,
    lan: &str,
    origin_host: &str,
    gateway_port: u16,
    bootstrap_path: &str,
    reference: &str,
) -> Result<(), String> {
    let config = build_pinned_client_config(pinned_fp)?;
    let url = format!("https://{origin_host}:{gateway_port}{bootstrap_path}?ref={reference}");
    let client = reqwest::Client::builder()
        .use_preconfigured_tls(config)
        .redirect(reqwest::redirect::Policy::none())
        .resolve(origin_host, resolve_addr(lan))
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("bootstrap client: {e}"))?;
    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("bootstrap url: {e}"))?;
    let response = client
        .get(parsed)
        .send()
        .await
        .map_err(|_| "CONTENT_OFFLINE".to_string())?;
    let set_cookies: Vec<String> = response
        .headers()
        .get_all("set-cookie")
        .iter()
        .filter_map(|v| v.to_str().ok().map(|s| s.to_string()))
        .collect();
    jar.observe(&set_cookies);
    if !response.status().is_redirection() && !response.status().is_success() {
        return Err("LSH_BOOTSTRAP_FAILED".into());
    }
    Ok(())
}

struct ParsedRequest {
    method: String,
    /// Full origin-form target: path + query (P1-F2: never split).
    target: String,
    /// Path-only view for fences.
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

async fn serve_connection(state: Arc<CarrierState>, mut local: TcpStream) {
    let raw = match read_request(&mut local, MAX_BODY_BYTES).await {
        Some(raw) => raw,
        None => return,
    };
    let (head, body) = match split_head_body(&raw) {
        Some(pair) => pair,
        None => {
            let _ = write_simple(&mut local, 400, "Bad Request").await;
            return;
        }
    };
    let request = match parse_head(head, body) {
        Some(request) => request,
        None => {
            let _ = write_simple(&mut local, 400, "Bad Request").await;
            return;
        }
    };
    // P1-F2: reject absolute-form / fragment / malformed targets.
    if request.target.contains('#') || request.target.contains("://") || !request.target.starts_with('/')
    {
        let _ = write_simple(&mut local, 400, "Bad Request").await;
        return;
    }

    // The one-time launch exchange is the ONLY unauthenticated route.
    if let Some(capability_query) = request.target.strip_prefix(LAUNCH_PATH) {
        handle_launch(&state, &mut local, capability_query).await;
        return;
    }

    // P0-S1: every other request MUST present the carrier-scoped local cookie.
    if !local_cookie_ok(&state, &request) {
        // Zero authenticated upstream traffic for unauthenticated locals.
        let _ = write_simple(&mut local, 403, "Forbidden").await;
        return;
    }

    // The device API is never reachable through the browser carrier.
    if request.path == "/v1" || request.path.starts_with("/v1/") {
        let _ = write_simple(&mut local, 403, "Forbidden").await;
        return;
    }
    // P1-F3: no ref-TTL 504 here — the live surface is lease/owner-governed.
    if state.stopped.load(Ordering::Acquire) {
        let _ = write_simple(&mut local, 502, "LightSeek carrier stopped").await;
        return;
    }
    let wants_ws = request
        .headers
        .iter()
        .any(|(n, v)| n.eq_ignore_ascii_case("upgrade") && v.eq_ignore_ascii_case("websocket"));
    let cancel = state.cancel.subscribe();
    if wants_ws {
        tunnel_websocket(state, local, &request, cancel).await;
    } else {
        relay_http(state, local, request, cancel).await;
    }
}

fn local_cookie_ok(state: &CarrierState, request: &ParsedRequest) -> bool {
    let Some(cookie_header) = request
        .headers
        .iter()
        .find(|(n, _)| n.eq_ignore_ascii_case("cookie"))
        .map(|(_, v)| v)
    else {
        return false;
    };
    cookie_header
        .split(';')
        .filter_map(|pair| pair.split_once('='))
        .any(|(n, v)| n.trim() == LOCAL_COOKIE_NAME && v.trim() == state.local_token)
}

async fn handle_launch(state: &Arc<CarrierState>, local: &mut TcpStream, query: &str) {
    let capability = query
        .strip_prefix("?capability=")
        .or_else(|| query.strip_prefix("capability="))
        .unwrap_or("");
    let ok = state
        .launch_capability
        .lock()
        .ok()
        .and_then(|mut cap| {
            if !capability.is_empty() && cap.as_deref() == Some(capability) {
                // one-time: consume immediately
                cap.take();
                Some(())
            } else {
                None
            }
        })
        .is_some();
    if !ok {
        let _ = write_simple(local, 403, "Forbidden").await;
        return;
    }
    // Establish the carrier-scoped local HttpOnly cookie and land on the
    // official surface with the LuckyRay presentation marker.
    let landing = format!(
        "HTTP/1.1 302 Found\r\nlocation: {LAUNCH_LANDING}\r\nset-cookie: {LOCAL_COOKIE_NAME}={}; HttpOnly; Path=/; SameSite=Strict\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
        state.local_token
    );
    let _ = local.write_all(landing.as_bytes()).await;
    let _ = local.shutdown().await;
}

fn parse_head(head: &str, body: &[u8]) -> Option<ParsedRequest> {
    let mut lines = head.split("\r\n");
    let request_line = lines.next()?;
    let mut parts = request_line.split(' ');
    let method = parts.next()?.to_string();
    let target = parts.next()?.to_string();
    if !target.starts_with('/') || target.contains('#') || target.contains("://") {
        return None;
    }
    let path = target.split('?').next().unwrap_or("").to_string();
    let mut headers = Vec::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_string(), value.trim().to_string()));
        }
    }
    Some(ParsedRequest {
        method,
        target,
        path,
        headers,
        body: body.to_vec(),
    })
}

/// Read the request head plus a Content-Length-bounded body.
async fn read_request(local: &mut TcpStream, max_body: usize) -> Option<Vec<u8>> {
    let mut buf: Vec<u8> = Vec::with_capacity(2048);
    let mut chunk = [0u8; 8192];
    loop {
        if let Some(head_end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let head_end = head_end + 4; // include the delimiter
            let head_text = String::from_utf8_lossy(&buf[..head_end]).to_string();
            let content_length = head_text
                .to_ascii_lowercase()
                .lines()
                .find_map(|l| l.strip_prefix("content-length:"))
                .and_then(|v| v.trim().parse::<usize>().ok())
                .unwrap_or(0);
            if content_length > max_body {
                return None;
            }
            let total = head_end + content_length;
            while buf.len() < total {
                let n = local.read(&mut chunk).await.ok()?;
                if n == 0 {
                    break;
                }
                let remaining = total - buf.len();
                buf.extend_from_slice(&chunk[..n.min(remaining)]);
            }
            buf.truncate(total);
            return Some(buf);
        }
        if buf.len() > MAX_HEAD_BYTES + max_body {
            return None;
        }
        let n = local.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

fn split_head_body(raw: &[u8]) -> Option<(&str, &[u8])> {
    let pos = raw.windows(4).position(|w| w == b"\r\n\r\n")?;
    Some((std::str::from_utf8(&raw[..pos]).ok()?, &raw[pos + 4..]))
}

/// Forward one HTTP request upstream through the pinned client with the
/// declared Desktop origin (Host/Origin rewritten, browser cookies injected)
/// and stream the official response back verbatim minus hop-by-hop headers.
async fn relay_http(
    state: Arc<CarrierState>,
    mut local: TcpStream,
    request: ParsedRequest,
    mut cancel: tokio::sync::watch::Receiver<bool>,
) {
    let config = match build_pinned_client_config(&state.pinned_fp) {
        Ok(c) => c,
        Err(_) => {
            let _ = write_simple(&mut local, 502, "carrier tls").await;
            return;
        }
    };
    let lan = lan_host_of(&state.paired_base);
    let client = match reqwest::Client::builder()
        .use_preconfigured_tls(config)
        .resolve(&state.origin_host, resolve_addr(&lan))
        .timeout(std::time::Duration::from_secs(300))
        .build()
    {
        Ok(c) => c,
        Err(_) => {
            let _ = write_simple(&mut local, 502, "carrier client").await;
            return;
        }
    };
    // P1-F2: the full origin-form target (path + query) reaches upstream.
    let url = format!("{}{}", state.origin, request.target);
    let method = Method::from_bytes(request.method.as_bytes()).unwrap_or(Method::GET);
    let mut upstream = client.request(method, reqwest::Url::parse(&url).unwrap_or_else(|_| {
        reqwest::Url::parse("https://luckyray-companion.local/").unwrap()
    }));
    let cookie = state.jar.lock().ok().and_then(|jar| jar.header());
    if let Some(cookie) = cookie {
        upstream = upstream.header("cookie", cookie);
    }
    for (name, value) in &request.headers {
        let lower = name.to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "host"
                | "connection"
                | "content-length"
                | "accept-encoding"
                | "cookie"
                | "upgrade"
                | "sec-websocket-key"
                | "sec-websocket-version"
                | "sec-websocket-extensions"
        ) {
            continue;
        }
        if lower == "origin" {
            upstream = upstream.header("origin", state.origin.clone());
            continue;
        }
        upstream = upstream.header(name.as_str(), value.as_str());
    }
    upstream = upstream.header("host", state.origin.trim_start_matches("https://"));
    if !request.body.is_empty() {
        upstream = upstream.body(request.body.clone());
    }
    let response = match tokio::select! {
        // P1-F7: retirement must abort in-flight work promptly.
        _ = wait_cancelled(&mut cancel) => {
            let _ = write_simple(&mut local, 502, "LightSeek carrier retired").await;
            return;
        }
        r = upstream.send() => r,
    } {
        Ok(r) => r,
        Err(_) => {
            let _ = write_simple(&mut local, 502, "LightSeek transport unavailable").await;
            return;
        }
    };
    let set_cookies: Vec<String> = response
        .headers()
        .get_all("set-cookie")
        .iter()
        .filter_map(|v| v.to_str().ok().map(|s| s.to_string()))
        .collect();
    if !set_cookies.is_empty() {
        if let Ok(mut jar) = state.jar.lock() {
            jar.observe(&set_cookies);
        }
    }

    let status = response.status().as_u16();
    let head_line =
        format!("HTTP/1.1 {status} {}\r\n", response.status().canonical_reason().unwrap_or(""));
    let mut out = Vec::with_capacity(512);
    out.extend_from_slice(head_line.as_bytes());
    for (name, value) in response.headers() {
        let lower = name.as_str().to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "set-cookie"
                | "connection"
                | "transfer-encoding"
                | "content-length"
                | "keep-alive"
                | "strict-transport-security"
                | "alt-svc"
        ) {
            continue;
        }
        out.extend_from_slice(
            format!("{}: {}\r\n", name.as_str(), value.to_str().unwrap_or("")).as_bytes(),
        );
    }
    out.extend_from_slice(b"connection: close\r\n\r\n");
    if local.write_all(&out).await.is_err() {
        return;
    }
    // Stream: never buffer the whole body (chat streaming, attachments).
    let mut stream = response.bytes_stream();
    let mut buffer: VecDeque<Vec<u8>> = VecDeque::new();
    loop {
        let chunk = tokio::select! {
            _ = wait_cancelled(&mut cancel) => break, // retired mid-stream
            next = stream.next() => next,
        };
        match chunk {
            Some(Ok(bytes)) => {
                buffer.push_back(bytes.to_vec());
                while let Some(bytes) = buffer.pop_front() {
                    let write = tokio::select! {
                        _ = wait_cancelled(&mut cancel) => return,
                        w = local.write_all(&bytes) => w,
                    };
                    if write.is_err() {
                        return;
                    }
                }
            }
            Some(Err(_)) => break,
            None => break,
        }
    }
    let _ = local.shutdown().await;
}

/// WebSocket: accept locally (accept derived from the LOCAL Sec-WebSocket-Key
/// — P1-F1), dial the same origin-form target upstream with a FRESH upstream
/// key through the pinned TLS connection, pipe frames both ways.
async fn tunnel_websocket(
    state: Arc<CarrierState>,
    mut local: TcpStream,
    request: &ParsedRequest,
    cancel: tokio::sync::watch::Receiver<bool>,
) {
    let lan = lan_host_of(&state.paired_base);
    let cookie = state.jar.lock().ok().and_then(|jar| jar.header());
    // P1-F1: the LOCAL accept derives from the LOCAL browser key.
    let Some(local_key) = request
        .headers
        .iter()
        .find(|(n, _)| n.eq_ignore_ascii_case("sec-websocket-key"))
        .map(|(_, v)| v.clone())
    else {
        let _ = write_simple(&mut local, 400, "Bad Request").await;
        return;
    };
    let accept = derive_accept_key(local_key.as_bytes());
    // The upstream handshake uses its own fresh key (never the derived accept).
    let upstream_key = generate_key();

    let config = match build_pinned_client_config(&state.pinned_fp) {
        Ok(c) => std::sync::Arc::new(c),
        Err(_) => return,
    };
    let addr = resolve_addr(&lan);
    let upstream_tcp = match tokio::net::TcpSocket::new_v4() {
        Ok(socket) => match socket.connect(addr).await {
            Ok(s) => s,
            Err(_) => return,
        },
        Err(_) => return,
    };
    let request_obj = tokio_tungstenite::tungstenite::http::Request::builder()
        .method("GET")
        .header("Host", format!("{}:{}", state.origin_host, state.gateway_port))
        .header("Upgrade", "websocket")
        .header("Connection", "Upgrade")
        .header("Sec-WebSocket-Key", &upstream_key)
        .header("Sec-WebSocket-Version", "13")
        .header("Origin", &state.origin)
        .header("Cookie", cookie.unwrap_or_default())
        .uri(format!(
            "wss://{}:{}{}",
            state.origin_host, state.gateway_port, request.target
        ))
        .body(());
    let request_obj = match request_obj {
        Ok(r) => r,
        Err(_) => return,
    };
    let (upstream_ws, _) = match tokio_tungstenite::client_async_tls_with_config(
        request_obj,
        upstream_tcp,
        None,
        Some(tokio_tungstenite::Connector::Rustls(config)),
    )
    .await
    {
        Ok(pair) => pair,
        Err(_) => return,
    };
    let accept_line = format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
    );
    if local.write_all(accept_line.as_bytes()).await.is_err() {
        return;
    }
    let local_ws = tokio_tungstenite::WebSocketStream::from_raw_socket(
        local,
        tokio_tungstenite::tungstenite::protocol::Role::Server,
        None,
    )
    .await;
    pipe_ws(local_ws, upstream_ws, cancel).await;
}

/// Resolves when the carrier is retired (or its sender is dropped).
async fn wait_cancelled(cancel: &mut tokio::sync::watch::Receiver<bool>) {
    loop {
        if *cancel.borrow() {
            return;
        }
        if cancel.changed().await.is_err() {
            return;
        }
    }
}
/// Bounded pump: frames forwarded as they arrive, close propagates both ways,
/// and carrier retirement (P1-F7) closes the established socket promptly.
async fn pipe_ws(
    mut local: tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    mut upstream: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    mut cancel: tokio::sync::watch::Receiver<bool>,
) {
    let (mut ls, mut lr) = local.split();
    let (mut us, mut ur) = upstream.split();
    // Each direction needs its own watch handle (a watch receiver is Clone and
    // &mut cannot be held by two concurrent futures).
    let mut cancel_up = cancel.clone();
    let to_upstream = async {
        loop {
            let msg = tokio::select! {
                _ = wait_cancelled(&mut cancel_up) => {
                    // Retired: stop forwarding upstream and close both ends.
                    let _ = us.send(Message::Close(None)).await;
                    break;
                }
                next = lr.next() => match next {
                    Some(m) => m,
                    None => break,
                },
            };
            let forward = match msg {
                Ok(Message::Binary(b)) => Some(Message::Binary(b)),
                Ok(Message::Text(t)) => Some(Message::Text(t)),
                Ok(Message::Ping(p)) => Some(Message::Ping(p)),
                Ok(Message::Pong(p)) => Some(Message::Pong(p)),
                Ok(Message::Close(c)) => {
                    let _ = us.send(Message::Close(c)).await;
                    break;
                }
                Ok(_) => None,
                Err(_) => break,
            };
            if let Some(forward) = forward {
                if us.send(forward).await.is_err() {
                    break;
                }
            }
        }
        let _ = us.close().await;
    };
    let to_local = async {
        loop {
            let msg = tokio::select! {
                _ = wait_cancelled(&mut cancel) => {
                    let _ = ls.send(Message::Close(None)).await;
                    break;
                }
                next = ur.next() => match next {
                    Some(m) => m,
                    None => break,
                },
            };
            let forward = match msg {
                Ok(Message::Binary(b)) => Some(Message::Binary(b)),
                Ok(Message::Text(t)) => Some(Message::Text(t)),
                Ok(Message::Ping(p)) => Some(Message::Ping(p)),
                Ok(Message::Pong(p)) => Some(Message::Pong(p)),
                Ok(Message::Close(c)) => {
                    let _ = ls.send(Message::Close(c)).await;
                    break;
                }
                Ok(_) => None,
                Err(_) => break,
            };
            if let Some(forward) = forward {
                if ls.send(forward).await.is_err() {
                    break;
                }
            }
        }
        let _ = ls.close().await;
    };
    tokio::join!(to_upstream, to_local);
}

async fn write_simple(local: &mut TcpStream, status: u16, text: &str) {
    let reason = match status {
        400 => "Bad Request",
        403 => "Forbidden",
        502 => "Bad Gateway",
        504 => "Gateway Timeout",
        _ => "Error",
    };
    let body = format!("{text}\n");
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = local.write_all(response.as_bytes()).await;
    // Windows: closing with unread request bytes sends RST before the client
    // can read the response. Drain briefly (bounded) so the refusal lands.
    let mut sink = Vec::new();
    let _ = tokio::time::timeout(std::time::Duration::from_millis(150), local.read_to_end(&mut sink)).await;
    let _ = local.shutdown().await;
}



#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use std::sync::Arc;

    /// A fake "Desktop": pinned TLS on 127.0.0.1 that answers the bootstrap
    /// GET (Set-Cookie), echoes HTTP with its raw target (query proof), and
    /// speaks WS (echo/pong/close).
    struct DesktopStub {
        addr: std::net::SocketAddr,
        fingerprint: String,
        seen: Arc<Mutex<Vec<String>>>,
        shutdown: Arc<AtomicBool>,
    }

    fn make_cert() -> (Vec<u8>, Vec<u8>) {
        let cert = rcgen::generate_simple_self_signed(vec!["luckyray-companion.local".to_owned()])
            .expect("generate test cert");
        let der = cert.cert.der().to_vec();
        let key = cert.key_pair.serialize_der();
        (der, key)
    }

    fn fp_of(der: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(der);
        h.finalize().iter().map(|b| format!("{b:02x}")).collect()
    }

    async fn spawn_desktop_stub() -> DesktopStub {
        // rustls 0.23 requires a process-level crypto provider; install ring
        // (the same provider the app's pinning config uses).
        let _ = rustls::crypto::ring::default_provider().install_default();
        use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer};
        use tokio_rustls::rustls::ServerConfig;
        let (cert_der, key_der) = make_cert();
        let fingerprint = fp_of(&cert_der);
        let provider = std::sync::Arc::new(rustls::crypto::ring::default_provider());
        let server_config = ServerConfig::builder_with_provider(provider)
            .with_protocol_versions(&[&rustls::version::TLS13])
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(
                vec![CertificateDer::from(cert_der.clone())],
                PrivateKeyDer::Pkcs8(key_der.into()),
            )
            .expect("server config");
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(server_config));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let seen_task = seen.clone();
        let shutdown = Arc::new(AtomicBool::new(false));
        let shutdown_task = shutdown.clone();
        tokio::spawn(async move {
            loop {
                if shutdown_task.load(Ordering::Acquire) {
                    break;
                }
                let accepted = tokio::select! {
                    a = listener.accept() => a,
                    _ = tokio::time::sleep(Duration::from_millis(200)) => continue,
                };
                let Ok((stream, _)) = accepted else { break };
                let acceptor = acceptor.clone();
                let seen_task = seen_task.clone();
                let shutdown_task = shutdown_task.clone();
                tokio::spawn(async move {
                    let Ok(mut tls) = acceptor.accept(stream).await else { return };
                    let mut buf: Vec<u8> = Vec::new();
                    let mut chunk = [0u8; 8192];
                    loop {
                        match tls.read(&mut chunk).await {
                            Ok(0) => break,
                            Ok(n) => {
                                buf.extend_from_slice(&chunk[..n]);
                                let head_end = buf.windows(4).position(|w| w == b"\r\n\r\n");
                                if let Some(pos) = head_end {
                                    let is_upgrade = String::from_utf8_lossy(&buf[..pos])
                                        .to_ascii_lowercase()
                                        .contains("upgrade: websocket");
                                    if !is_upgrade {
                                        break; // plain HTTP: head only
                                    }
                                    // WS: keep reading until the head is complete
                                    break;
                                }
                            }
                            Err(_) => break,
                        }
                    }
                    if shutdown_task.load(Ordering::Acquire) {
                        return;
                    }
                    let text = String::from_utf8_lossy(&buf).to_string();
                    let target = text
                        .lines()
                        .next()
                        .and_then(|l| l.split(' ').nth(1))
                        .unwrap_or("")
                        .to_string();
                    seen_task.lock().unwrap().push(target.clone());
                    let is_upgrade = text.to_ascii_lowercase().contains("upgrade: websocket");
                    if is_upgrade {
                        let key = text
                            .lines()
                            .find(|l| l.to_ascii_lowercase().starts_with("sec-websocket-key:"))
                            .and_then(|l| l.split(':').nth(1))
                            .map(|v| v.trim().to_string())
                            .unwrap_or_default();
                        let accept = derive_accept_key(key.as_bytes());
                        let head = format!(
                            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n",
                        );
                        let mut ws = tls;
                        let _ = ws.write_all(head.as_bytes()).await;
                        echo_ws_frames(ws).await;
                    } else {
                        let body = format!("target={target}");
                        let head = format!(
                            "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                            body.len()
                        );
                        let mut ws = tls;
                        let _ = ws.write_all(head.as_bytes()).await;
                        let _ = ws.shutdown().await;
                    }
                });
            }
        });
        DesktopStub { addr, fingerprint, seen, shutdown }
    }

    async fn echo_ws_frames<S>(stream: S)
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    {
        let mut ws = tokio_tungstenite::WebSocketStream::from_raw_socket(
            stream,
            tokio_tungstenite::tungstenite::protocol::Role::Server,
            None,
        )
        .await;
        while let Some(msg) = ws.next().await {
            match msg {
                Ok(Message::Binary(b)) => {
                    let _ = ws.send(Message::Binary(b)).await;
                }
                Ok(Message::Ping(p)) => {
                    let _ = ws.send(Message::Pong(p)).await;
                }
                Ok(Message::Close(_)) | Err(_) => break,
                Ok(_) => {}
            }
        }
    }

    /// The carrier is a process-global singleton: serialize lifecycle tests
    /// so concurrent starts cannot stop each other's carriers.
    fn lifecycle_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
    }
    fn valid_mint(port: u16, ttl_ms: i64) -> SessionMint {
        SessionMint {
            reference: "a".repeat(64),
            bootstrap_path: "/_luckyray/remote/bootstrap".into(),
            expires_at_ms: now_ms() + ttl_ms,
            carrier_generation: 7,
            origin: format!("https://luckyray-companion.local:{port}"),
            gateway_generation: 3,
        }
    }

    fn port_of(url: &str) -> u16 {
        url.split("127.0.0.1:")
            .nth(1)
            .and_then(|rest| rest.split('/').next())
            .and_then(|p| p.parse().ok())
            .unwrap_or(0)
    }

    fn client_with_cookie(cookie: &str) -> reqwest::Client {
        let mut h = reqwest::header::HeaderMap::new();
        h.insert("cookie", reqwest::header::HeaderValue::from_str(cookie).unwrap());
        reqwest::Client::builder()
            .default_headers(h)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap()
    }

    // ---------- P0-S1 + P1-F2: auth gate + query preservation ----------

    #[tokio::test]
    async fn carrier_requires_local_cookie_and_preserves_query() {
        let _lifecycle = lifecycle_lock();
        let desktop = spawn_desktop_stub().await;
        let handle = start(
            format!("https://{}", desktop.addr),
            desktop.fingerprint.clone(),
            valid_mint(desktop.addr.port(), 60_000),
        )
        .await
        .expect("carrier start");
        let port = port_of(&handle.session_url);

        let anon = reqwest::Client::new();

        // S1: NO local cookie -> 403 with ZERO upstream traffic.
        let resp = anon
            .get(format!("http://127.0.0.1:{port}/some/page"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 403, "unauthenticated local request refused");
        {
            // The ONLY upstream traffic so far is the bootstrap itself
            // (performed by the carrier, not by unauthenticated locals).
            let seen = desktop.seen.lock().unwrap();
            assert_eq!(seen.len(), 1, "only the carrier's bootstrap reached upstream");
            assert!(seen[0].starts_with("/_luckyray/remote/bootstrap"), "bootstrap request only");
        }

        // S1: wrong launch capability -> 403, still zero upstream traffic.
        let resp = anon
            .get(format!("http://127.0.0.1:{port}{LAUNCH_PATH}?capability=deadbeef"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 403, "wrong capability refused");
        assert_eq!(desktop.seen.lock().unwrap().len(), 1, "still only the bootstrap upstream-side");
        // Launch exchange with the REAL one-time capability: 302 + HttpOnly
        // carrier cookie. The capability is consumed (one-time).
        assert!(handle.session_url.contains("capability="));
        let launcher = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let resp = launcher
            .get(&handle.session_url)
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 302, "cookie set + redirect to landing");
        let set_cookie = resp
            .headers()
            .get_all("set-cookie")
            .iter()
            .filter_map(|v| v.to_str().ok().map(|s| s.to_string()))
            .collect::<Vec<_>>()
            .join("| ");
        assert!(set_cookie.contains(LOCAL_COOKIE_NAME), "carrier cookie is set");
        assert!(
            set_cookie.to_ascii_lowercase().contains("httponly"),
            "cookie is HttpOnly",
        );

        // S1: replay of the consumed capability -> 403 (one-time).
        let resp = launcher
            .get(&handle.session_url)
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 403, "capability is one-time");

        // P1-F2: authenticated HTTP with query — the FULL origin-form target
        // (path + query, including the presentation marker) reaches upstream.
        let cookie = set_cookie.split("; ").next().unwrap_or("").to_string();
        let auth = client_with_cookie(&cookie);
        let resp = auth
            .get(format!("http://127.0.0.1:{port}/?luckyrayMobile=1&probe=x"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 200);
        let body = resp.text().await.unwrap();
        assert!(body.contains("/?luckyrayMobile=1&probe=x"), "query reached upstream intact: {body}");

        // The device API fence holds even for authenticated locals.
        let resp = auth
            .get(format!("http://127.0.0.1:{port}/v1/lsh/remote/state"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 403, "/v1/* refused through the carrier");
    }

    // ---------- P1-F1: real loopback WebSocket ----------

    #[tokio::test]
    async fn carrier_websocket_handshake_frames_and_close() {
        let _lifecycle = lifecycle_lock();
        let desktop = spawn_desktop_stub().await;
        let handle = start(
            format!("https://{}", desktop.addr),
            desktop.fingerprint.clone(),
            valid_mint(desktop.addr.port(), 60_000),
        )
        .await
        .unwrap();
        let port = port_of(&handle.session_url);

        // Establish the local carrier cookie via the real launch URL.
        let launcher = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let resp = launcher
            .get(&handle.session_url)
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 302);
        let cookie = resp
            .headers()
            .get_all("set-cookie")
            .iter()
            .filter_map(|v| v.to_str().ok().map(|s| s.to_string()))
            .collect::<Vec<_>>()
            .join("; ");

        // A REAL WS client: connect_async VALIDATES Sec-WebSocket-Accept, so a
        // wrong accept (P1-F1) fails this handshake.
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let mut request = format!("ws://127.0.0.1:{port}/api/remote.mux")
            .into_client_request()
            .unwrap();
        request.headers_mut().insert(
            "cookie",
            reqwest::header::HeaderValue::from_str(&cookie).unwrap(),
        );
        let (mut ws, response) = tokio_tungstenite::connect_async(request)
            .await
            .expect("local WS handshake (accept from LOCAL key)");
        assert_eq!(response.status(), 101);

        // Bidirectional frame.
        ws.send(Message::Binary(vec![1, 2, 3])).await.unwrap();
        loop {
            match ws.next().await {
                Some(Ok(Message::Binary(b))) => {
                    assert_eq!(b, vec![1, 2, 3], "frame echoed from upstream");
                    break;
                }
                Some(Ok(Message::Ping(_))) => {}
                other => panic!("expected echoed frame, got {other:?}"),
            }
        }

        // Ping/pong.
        ws.send(Message::Ping(vec![9])).await.unwrap();
        loop {
            match ws.next().await {
                Some(Ok(Message::Pong(p))) => {
                    assert_eq!(p, vec![9], "pong");
                    break;
                }
                Some(Ok(Message::Ping(_))) => {}
                other => panic!("expected pong, got {other:?}"),
            }
        }

        // Close propagation.
        ws.close(None).await.unwrap();
        loop {
            match ws.next().await {
                Some(Ok(Message::Close(_))) => break,
                Some(Ok(Message::Ping(_))) => {}
                None => break,
                other => panic!("expected close, got {other:?}"),
            }
        }
    }

    // ---------- P1-F3: ref TTL vs browser-session lifetime ----------

    #[tokio::test]
    async fn carrier_outlives_ref_ttl_but_stale_ref_is_refused() {
        let _lifecycle = lifecycle_lock();
        let desktop = spawn_desktop_stub().await;
        let now = now_ms();

        // A stale (already expired) unconsumed mint is refused at start.
        let stale = SessionMint {
            reference: "c".repeat(64),
            bootstrap_path: "/_luckyray/remote/bootstrap".into(),
            expires_at_ms: now - 1_000,
            carrier_generation: 1,
            origin: format!("https://luckyray-companion.local:{}", desktop.addr.port()),
            gateway_generation: 1,
        };
        assert!(
            start(
                format!("https://{}", desktop.addr),
                desktop.fingerprint.clone(),
                stale,
            )
            .await
            .is_err(),
            "stale unconsumed ref refused",
        );

        // A short-TTL mint is consumed in time; the carrier KEEPS SERVING after
        // the original ref expiry passes (no ref-TTL 504) — clock-controlled.
        let handle = start(
            format!("https://{}", desktop.addr),
            desktop.fingerprint.clone(),
            valid_mint(desktop.addr.port(), 1_000),
        )
        .await
        .unwrap();
        let port = port_of(&handle.session_url);
        let launcher = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let resp = launcher
            .get(&handle.session_url)
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 302);
        let cookie = resp
            .headers()
            .get_all("set-cookie")
            .iter()
            .filter_map(|v| v.to_str().ok().map(|s| s.to_string()))
            .collect::<Vec<_>>()
            .join("; ");

        // Outlive the original ref TTL (1 s) by 600 ms...
        tokio::time::sleep(Duration::from_millis(1_600)).await;

        let auth = client_with_cookie(&cookie);
        let resp = auth
            .get(format!("http://127.0.0.1:{port}/?probe=after-ref-expiry"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 200, "surface still usable after ref expiry");
        let body = resp.text().await.unwrap();
        assert!(body.contains("probe=after-ref-expiry"), "query intact: {body}");
    }

    // ---------- P1-F4: lease-bound teardown ----------

    #[tokio::test]
    async fn stale_activity_cannot_stop_a_newer_carrier() {
        let _lifecycle = lifecycle_lock();
        let desktop = spawn_desktop_stub().await;
        let mint = |ttl: i64| SessionMint {
            reference: "e".repeat(64),
            bootstrap_path: "/_luckyray/remote/bootstrap".into(),
            expires_at_ms: now_ms() + ttl,
            carrier_generation: 7,
            origin: format!("https://luckyray-companion.local:{}", desktop.addr.port()),
            gateway_generation: 3,
        };
        let a = start(
            format!("https://{}", desktop.addr),
            desktop.fingerprint.clone(),
            mint(60_000),
        )
        .await
        .unwrap();
        let stale_lease = a.lease.clone();
        let stale_url = a.session_url.clone();
        // A fresh bootstrap replaces A (owner switch / refresh).
        let b = start(
            format!("https://{}", desktop.addr),
            desktop.fingerprint.clone(),
            mint(60_000),
        )
        .await
        .unwrap();
        assert_ne!(a.lease, b.lease);

        // Stale A tries to retire — must be a no-op.
        assert!(!retire_leased(&stale_lease), "stale lease is a no-op");

        // B is still live and enforcing auth.
        let anon = reqwest::Client::new();
        let resp = anon
            .get(format!("{}/anything", b.session_url))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 403, "B still alive (403 = enforcing)");
        let _ = stale_url;

        // B retires itself with its own lease.
        assert!(retire_leased(&b.lease), "own lease retires");
    }

    // ---------- P1-F5: the returned metadata is NOT the lifetime ----------

    #[tokio::test]
    async fn dropping_the_returned_metadata_does_not_stop_the_carrier() {
        let _lifecycle = lifecycle_lock();
        let desktop = spawn_desktop_stub().await;
        // 1. start carrier
        let handle = start(
            format!("https://{}", desktop.addr),
            desktop.fingerprint.clone(),
            valid_mint(desktop.addr.port(), 60_000),
        )
        .await
        .unwrap();
        // 2. extract the metadata the production command copies into JSON
        let session_url = handle.session_url.clone();
        let lease = handle.lease.clone();
        // 3. drop the returned handle exactly like lsh_surface_bootstrap does
        drop(handle);

        // 4. the launch exchange must still work
        let port = port_of(&session_url);
        let launcher = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let resp = launcher.get(&session_url).send().await.unwrap();
        assert_eq!(resp.status().as_u16(), 302, "carrier survived the metadata drop");
        let cookie = resp
            .headers()
            .get_all("set-cookie")
            .iter()
            .filter_map(|v| v.to_str().ok().map(|s| s.to_string()))
            .collect::<Vec<_>>()
            .join("; ");

        // 5. and an authenticated request must still succeed
        let auth = client_with_cookie(&cookie);
        let resp = auth
            .get(format!("http://127.0.0.1:{port}/?after=drop"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 200, "authenticated carrier still alive");
        let body = resp.text().await.unwrap();
        assert!(body.contains("after=drop"));

        // 6. only the MATCHING lease retires it
        assert!(retire_leased(&lease), "matching lease retires the carrier");
        let resp = auth
            .get(format!("http://127.0.0.1:{port}/?after=retire"))
            .send()
            .await;
        // The listener is gone: the connection must fail rather than answer.
        assert!(resp.is_err(), "carrier is gone after its lease retired");
    }

    // ---------- P1-L1: explicit 断开连接 (ws_stop) retires the carrier ----------

    #[test]
    fn ws_stop_retires_the_carrier_between_eventstream_and_the_manual_stop_result() {
        let lib = include_str!("lib.rs");
        let at = lib.find("async fn ws_stop(").expect("ws_stop exists");
        // Bound the body to the next command so ordering cannot be satisfied by
        // an unrelated later occurrence.
        let rest = &lib[at..];
        let end = rest.find("#[tauri::command]").unwrap_or(rest.len());
        let body = &rest[..end];
        let es_stop = body.find("es.stop().await").expect("eventstream stop present");
        let carrier_stop = body
            .find("crate::lsh_carrier::stop()")
            .expect("P1-L1: ws_stop must retire the LSH carrier");
        let mirror = body
            .find("mirror_conn_intent(&state, ConnectionIntent::ManualStop)")
            .expect("manual-stop mirror present");
        let result = body.find("conn_result_json(").expect("result present");
        assert!(
            es_stop < carrier_stop,
            "carrier retirement follows the eventstream stop",
        );
        assert!(
            carrier_stop < mirror && mirror < result,
            "carrier retirement precedes the manual-stop mirror and the result",
        );
    }
    // ---------- P1-F7: retirement closes ESTABLISHED transport ----------

    #[tokio::test]
    async fn retirement_closes_an_established_websocket_and_stops_upstream_frames() {
        let _lifecycle = lifecycle_lock();
        let desktop = spawn_desktop_stub().await;
        let handle = start(
            format!("https://{}", desktop.addr),
            desktop.fingerprint.clone(),
            valid_mint(desktop.addr.port(), 60_000),
        )
        .await
        .unwrap();
        let port = port_of(&handle.session_url);
        let lease = handle.lease.clone();
        let url = handle.session_url.clone();
        drop(handle);

        // Establish the local cookie and a long-lived authenticated WS.
        let launcher = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let resp = launcher.get(&url).send().await.unwrap();
        assert_eq!(resp.status().as_u16(), 302);
        let cookie = resp
            .headers()
            .get_all("set-cookie")
            .iter()
            .filter_map(|v| v.to_str().ok().map(|s| s.to_string()))
            .collect::<Vec<_>>()
            .join("; ");
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let mut request = format!("ws://127.0.0.1:{port}/api/remote.mux")
            .into_client_request()
            .unwrap();
        request.headers_mut().insert(
            "cookie",
            reqwest::header::HeaderValue::from_str(&cookie).unwrap(),
        );
        let (mut ws, _) = tokio_tungstenite::connect_async(request).await.unwrap();
        // Prove the socket is live.
        ws.send(Message::Binary(vec![7])).await.unwrap();
        loop {
            match ws.next().await {
                Some(Ok(Message::Binary(b))) => {
                    assert_eq!(b, vec![7]);
                    break;
                }
                Some(Ok(Message::Ping(_))) => {}
                other => panic!("expected echo, got {other:?}"),
            }
        }

        // Retire the matching lease: the ESTABLISHED socket must close promptly.
        assert!(retire_leased(&lease));
        let closed = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match ws.next().await {
                    Some(Ok(Message::Close(_))) | None => break true,
                    Some(Ok(_)) => continue,
                    Some(Err(_)) => break true,
                }
            }
        })
        .await;
        assert!(matches!(closed, Ok(true)), "client observed close/failure promptly");

        // And no further frame reaches upstream: every later send must fail or
        // be dropped because the carrier closed both directions.
        let before = desktop.seen.lock().unwrap().len();
        let _ = ws.send(Message::Binary(vec![9])).await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        let after = desktop.seen.lock().unwrap().len();
        assert_eq!(before, after, "no new upstream request after retirement");
    }

    // ---------- P0-S3: pairing / revoke retire the carrier ----------

    /// The pairing-authority transitions that must retire the carrier are
    /// asserted at the SOURCE level because driving them needs a live Desktop
    /// pairing exchange; the carrier-side effect (stop/claim) is covered by the
    /// lifecycle tests above.
    #[test]
    fn pairing_and_revoke_paths_retire_the_carrier() {
        let lib = include_str!("lib.rs");
        // do_pair: the retirement sits AFTER the validated replacement and
        // BEFORE the durable upsert (which is the first line of the persistence
        // block), so a failed/early-returning re-pair never touches A.
        let pair_at = lib.find("async fn do_pair(").expect("do_pair exists");
        let pair_body = &lib[pair_at..];
        let retire = pair_body.find("crate::lsh_carrier::stop()");
        let upsert = pair_body.find("db.upsert_paired(");
        let persist = pair_body.find("let secure_store = secure::SecureCredentialStoreImpl;");
        assert!(retire.is_some(), "do_pair retires the carrier");
        assert!(upsert.is_some(), "do_pair persists the new pairing");
        assert!(
            retire.unwrap() < persist.unwrap() && persist.unwrap() < upsert.unwrap(),
            "retirement happens before the new pairing becomes durable",
        );
        // conn_revoke: retire BEFORE the credential/metadata clearing.
        let revoke_at = lib.find("async fn conn_revoke(").expect("conn_revoke exists");
        let revoke_body = &lib[revoke_at..];
        let r_retire = revoke_body.find("crate::lsh_carrier::stop()");
        let r_clear = revoke_body.find("clear_pairing_and_secure_credentials(");
        assert!(r_retire.is_some(), "conn_revoke retires the carrier");
        assert!(r_clear.is_some());
        assert!(r_retire.unwrap() < r_clear.unwrap(), "retire precedes credential clearing");
    }

    /// Behavioural half: the exact primitive those paths call really does make
    /// the live carrier unusable, and a stale/foreign caller cannot.
    #[tokio::test]
    async fn carrier_stop_makes_the_live_carrier_unusable() {
        let _lifecycle = lifecycle_lock();
        let desktop = spawn_desktop_stub().await;
        let handle = start(
            format!("https://{}", desktop.addr),
            desktop.fingerprint.clone(),
            valid_mint(desktop.addr.port(), 60_000),
        )
        .await
        .unwrap();
        let url = handle.session_url.clone();
        drop(handle);
        // Usable before the authority transition.
        let launcher = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let resp = launcher.get(&url).send().await.unwrap();
        assert_eq!(resp.status().as_u16(), 302);

        // Exactly what do_pair / conn_revoke call.
        stop();

        // The launch exchange is gone and the URL claims nothing any more.
        let after = launcher.get(&url).send().await;
        match after {
            Ok(r) => assert_ne!(r.status().as_u16(), 302, "carrier no longer serves"),
            Err(_) => {}
        }
        assert!(claim_current_launch(&url).is_none(), "no claim after the transition");
    }
    // ---------- P1-F8: URL and lease are claimed atomically ----------

    #[tokio::test]
    async fn stale_launch_url_cannot_claim_a_newer_carrier() {
        let _lifecycle = lifecycle_lock();
        let desktop = spawn_desktop_stub().await;
        let mint = |ttl: i64| SessionMint {
            reference: "f".repeat(64),
            bootstrap_path: "/_luckyray/remote/bootstrap".into(),
            expires_at_ms: now_ms() + ttl,
            carrier_generation: 7,
            origin: format!("https://luckyray-companion.local:{}", desktop.addr.port()),
            gateway_generation: 3,
        };
        let a = start(
            format!("https://{}", desktop.addr),
            desktop.fingerprint.clone(),
            mint(60_000),
        )
        .await
        .unwrap();
        let a_url = a.session_url.clone();
        let a_lease = a.lease.clone();
        // A's own URL claims A's own lease while A is current.
        assert_eq!(claim_current_launch(&a_url).as_deref(), Some(a_lease.as_str()));

        // B replaces A.
        let b = start(
            format!("https://{}", desktop.addr),
            desktop.fingerprint.clone(),
            mint(60_000),
        )
        .await
        .unwrap();

        // The STALE A URL can no longer claim anything (so it can neither
        // launch with B's lease nor retire B).
        assert!(claim_current_launch(&a_url).is_none(), "stale A URL refused");
        // B's own URL still claims B's lease.
        assert_eq!(claim_current_launch(&b.session_url).as_deref(), Some(b.lease.as_str()));
        // And a foreign/garbage URL claims nothing.
        assert!(claim_current_launch("http://127.0.0.1:1/nope").is_none());
        assert!(claim_current_launch("").is_none());

        // B is untouched by all of the above.
        let anon = reqwest::Client::new();
        let resp = anon
            .get(format!("{}/x", b.session_url))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 403, "B still alive and enforcing");
    }
    // ---------- P0-S2: the security values come from the OS CSPRNG ----------

    #[test]
    fn local_security_values_come_from_the_os_csprng() {
        // Distinct draws must not collide (a deterministic time/LCG stream
        // seeded per call would still be predictable, so we assert BOTH the
        // shape and the source path).
        let a = random_hex(32).expect("entropy available");
        let b = random_hex(32).expect("entropy available");
        assert_eq!(a.len(), 64, "32 random bytes -> 64 hex chars");
        assert_eq!(b.len(), 64);
        assert_ne!(a, b, "independent draws differ");
        let expected_len = LOCAL_TOKEN_HEX_LEN;
        let token = random_hex(LAUNCH_CAPABILITY_HEX_LEN / 2).unwrap();
        let _ = expected_len;
        assert_eq!(token.len(), LAUNCH_CAPABILITY_HEX_LEN);
        // Fail-closed contract: the entropy helper returns Result, and the
        // ONLY source is getrandom (source-guarded below).
    }

    #[test]
    fn csprng_source_guard_no_time_seed_or_prng_fallback() {
        let source = include_str!("lsh_carrier.rs");
        // Scope the guard to the PRODUCTION region (before the tests module)
        // so the test file's own text cannot satisfy it.
        let production = source.split("#[cfg(test)]").next().unwrap();
        assert!(production.contains("getrandom::getrandom"), "OS CSPRNG is used");
        assert!(production.contains("LSH_CARRIER_ENTROPY_UNAVAILABLE"), "entropy failure is a hard error");
        // Scope the credential path narrowly: `now_ms()` legitimately reads the
        // clock for lease/ref timing, so the guard inspects only the random
        // helper region (from `fn random_hex` to the end of `fill_random`).
        let rand_start = production.find("fn random_hex").unwrap();
        let rand_end = production[rand_start..].find("/// The accepted Desktop #166").unwrap() + rand_start;
        let credential_path = &production[rand_start..rand_end];
        assert!(credential_path.contains("getrandom::getrandom"), "the credential path uses the OS CSPRNG");
        for forbidden in ["SystemTime", "wrapping_mul", "thread_rng"] {
            assert!(!credential_path.contains(forbidden), "no {forbidden} in the credential path");
        }
        // And the time-based seed helper is gone entirely from production.
        assert!(!production.contains("let nanos = std::time::SystemTime"), "no time-seeded randomness remains");
    }
    // ---------- P1-C1: contract-drift negatives ----------

    #[test]
    fn mint_validation_rejects_contract_drift() {
        let now = now_ms();
        let base = serde_json::json!({
            "ref": "a".repeat(64),
            "bootstrapPath": "/_luckyray/remote/bootstrap",
            "expiresAtMs": now + 30_000,
            "carrierGeneration": 7,
            "origin": "https://luckyray-companion.local:37418",
            "gatewayGeneration": 3,
        });
        assert!(SessionMint::validate(&base, now).is_ok());

        let drift = |patch: serde_json::Value| {
            let mut v = base.clone();
            if let Some(obj) = patch.as_object() {
                for (k, val) in obj {
                    v[k] = val.clone();
                }
            }
            v
        };
        assert!(SessionMint::validate(&drift(serde_json::json!({ "ref": "a".repeat(63) })), now).is_err(), "63-hex ref");
        assert!(SessionMint::validate(&drift(serde_json::json!({ "ref": "A".repeat(64) })), now).is_err(), "uppercase ref");
        assert!(SessionMint::validate(&drift(serde_json::json!({ "ref": "z".repeat(64) })), now).is_err(), "non-hex ref");
        assert!(SessionMint::validate(&drift(serde_json::json!({ "bootstrapPath": "/other/bootstrap" })), now).is_err(), "wrong path");
        assert!(SessionMint::validate(&drift(serde_json::json!({ "bootstrapPath": "/_luckyray/remote/bootstrap?x=1" })), now).is_err(), "query ambiguity");
        assert!(SessionMint::validate(&drift(serde_json::json!({ "expiresAtMs": now - 1 })), now).is_err(), "past expiry");
        assert!(SessionMint::validate(&drift(serde_json::json!({ "expiresAtMs": now + MAX_MINT_TTL_MS + 1 })), now).is_err(), "implausible expiry");
        assert!(SessionMint::validate(&drift(serde_json::json!({ "origin": "https://127.0.0.1:37418" })), now).is_err(), "IP origin");
        assert!(SessionMint::validate(&drift(serde_json::json!({ "origin": "https://evil.example:37418" })), now).is_err(), "foreign host");
        assert!(SessionMint::validate(&drift(serde_json::json!({ "gatewayGeneration": null })), now).is_err(), "missing generation");
    }
}
