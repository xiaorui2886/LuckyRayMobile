// EventStreamClient: WSS event stream with automatic reconnect (exponential
// backoff). Real-time hints only — durable sync is the source of truth.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicI64, AtomicI8, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use sha2::{Digest, Sha256};
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest,
    http::{header::AUTHORIZATION, HeaderValue, Request},
    Error as TungsteniteError, Message,
};
use futures_util::StreamExt;
use tauri::Emitter;

// 0 stopped, 1 connecting, 2 connected, 3 reconnecting
const ST_STOPPED: i8 = 0;
const ST_CONNECTING: i8 = 1;
const ST_CONNECTED: i8 = 2;
const ST_RECONNECTING: i8 = 3;
const ST_RE_PAIR_REQUIRED: i8 = 4;

/// Typed retryable failure classes surfaced to the UI as a user-safe
/// `last_failure` code in the ws snapshot. Certificate pinning is never
/// relaxed to convert a Tls failure into a Network one.
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum RetryKind {
    Network,
    Tls,
    Protocol,
    Deadline,
}

impl RetryKind {
    fn as_str(self) -> &'static str {
        match self {
            RetryKind::Network => "network",
            RetryKind::Tls => "tls",
            RetryKind::Protocol => "protocol",
            RetryKind::Deadline => "deadline",
        }
    }
}

#[derive(Debug)]
enum StreamFailure {
    AuthRevoked,
    Retryable { kind: RetryKind, note: String },
}

#[derive(Debug, Eq, PartialEq)]
enum StartOutcome {
    Started,
    AlreadyRunning,
    RePairRequired,
}

type AttemptFuture = Pin<Box<dyn Future<Output = Result<(), StreamFailure>> + Send>>;
type AttemptFn = Box<dyn FnMut(u64) -> AttemptFuture + Send>;
type StatusFn = Arc<dyn Fn(i8) + Send + Sync>;

struct Inner {
    handle: Mutex<Option<tokio::task::JoinHandle<()>>>,
    stop: Mutex<Option<tokio::sync::mpsc::UnboundedSender<()>>>,
    state: AtomicI8,
    last_seq: AtomicI64,
    current: Mutex<String>,
    revoked_credential_hash: Mutex<Option<[u8; 32]>>,
    /// Worker generation: bumped on every start AND every stop. A worker
    /// holds the generation it was spawned with; once stop() or a newer
    /// start bumps past it, the stale worker's state writes, emitted
    /// events, seq/event bookkeeping, handle release and revoked-hash
    /// writes are all refused — old tasks can never affect a new one.
    generation: AtomicU64,
    /// User-safe typed class of the LATEST retryable dial failure of the
    /// CURRENT worker (None while healthy). Surfaces as `last_failure` in
    /// the ws snapshot so the UI can name network vs TLS vs deadline.
    last_failure: Mutex<Option<&'static str>>,
    /// Test seam ONLY: every worker generation in spawn order, so tests can
    /// drive a stale worker's cleanup against a live newer worker with
    /// exact, controllable timing (never read by production code paths).
    #[cfg(test)]
    test_spawned_gens: Mutex<Vec<u64>>,
}

#[derive(Clone)]
pub struct EventStreamClient {
    inner: Arc<Inner>,
    base_delay_ms: u64,
    max_delay_ms: u64,
}

impl EventStreamClient {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                handle: Mutex::new(None),
                stop: Mutex::new(None),
                state: AtomicI8::new(ST_STOPPED),
                last_seq: AtomicI64::new(0),
                current: Mutex::new(String::new()),
                revoked_credential_hash: Mutex::new(None),
                generation: AtomicU64::new(0),
                last_failure: Mutex::new(None),
                #[cfg(test)]
                test_spawned_gens: Mutex::new(Vec::new()),
            }),
            base_delay_ms: 1000,
            max_delay_ms: 30000,
        }
    }

    fn state_str(v: i8) -> &'static str {
        match v {
            ST_CONNECTING => "connecting",
            ST_CONNECTED => "connected",
            ST_RECONNECTING => "reconnecting",
            ST_RE_PAIR_REQUIRED => "re_pair_required",
            _ => "stopped",
        }
    }

    pub async fn start(
        &self,
        url: &str,
        authorization: &str,
        fp: &str,
        app: tauri::AppHandle,
    ) -> Result<(), String> {
        let credential_hash = credential_hash(authorization);
        let url = url.to_string();
        let authorization = authorization.to_string();
        let fp = fp.to_string();
        let attempt_client = self.clone();
        let attempt_app = app.clone();
        let attempt: AttemptFn = Box::new(move |worker_gen: u64| {
            let url = url.clone();
            let authorization = authorization.clone();
            let fp = fp.clone();
            let app = attempt_app.clone();
            let client = attempt_client.clone();
            Box::pin(async move {
                connect_once(&url, &authorization, &fp, &app, &client, worker_gen).await
            })
        });
        let status_client = self.clone();
        let status_app = app.clone();
        let status: StatusFn = Arc::new(move |state| status_client.emit_status(&status_app, state));
        match self
            .start_with_attempt(attempt, status, Some(credential_hash))
            .await
        {
            StartOutcome::Started | StartOutcome::AlreadyRunning => Ok(()),
            StartOutcome::RePairRequired => {
                Err("paired credential was rejected; re-pair required".into())
            }
        }
    }

    async fn start_with_attempt(
        &self,
        mut attempt: AttemptFn,
        on_status: StatusFn,
        credential_hash: Option<[u8; 32]>,
    ) -> StartOutcome {
        let inner = self.inner.as_ref();
        if credential_hash.is_some()
            && *inner.revoked_credential_hash.lock().unwrap() == credential_hash
        {
            on_status(ST_RE_PAIR_REQUIRED);
            return StartOutcome::RePairRequired;
        }
        let mut handle_slot = inner.handle.lock().unwrap();
        // Re-check after acquiring ownership: a terminal worker may have
        // recorded its 401 between the first check and this lock.
        if credential_hash.is_some()
            && *inner.revoked_credential_hash.lock().unwrap() == credential_hash
        {
            on_status(ST_RE_PAIR_REQUIRED);
            return StartOutcome::RePairRequired;
        }
        if handle_slot.is_some() {
            return StartOutcome::AlreadyRunning;
        }
        // Taking the handle slot under the lock serializes start/stop pairs,
        // so this generation is strictly newer than any retired worker's.
        let worker_gen = inner.generation.fetch_add(1, Ordering::SeqCst) + 1;
        #[cfg(test)]
        inner.test_spawned_gens.lock().unwrap().push(worker_gen);
        let (stop_tx, mut stop_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
        *inner.stop.lock().unwrap() = Some(stop_tx);
        inner.state.store(ST_CONNECTING, Ordering::SeqCst);
        *inner.last_failure.lock().unwrap() = None;
        let (registered_tx, registered_rx) = tokio::sync::oneshot::channel::<()>();

        let this = self.clone();
        let base_delay = self.base_delay_ms;
        let max_delay = self.max_delay_ms;
        let handle = tokio::spawn(async move {
            let _ = registered_rx.await;
            if !this.is_current(worker_gen) {
                // Retired before the task even ran: touch nothing.
                return;
            }
            on_status(ST_CONNECTING);
            let mut attempt_count: u32 = 0;
            loop {
                let res = tokio::select! {
                    biased;
                    _ = stop_rx.recv() => break,
                    r = attempt(worker_gen) => r,
                };
                match res {
                    Ok(()) => break,
                    Err(StreamFailure::AuthRevoked) => {
                        // Only the CURRENT worker's 401 is credential truth.
                        // A stale worker's 401 must not poison the revoked
                        // list, emit re_pair_required, or release the slot a
                        // newer worker now owns.
                        if this.is_current(worker_gen) {
                            if let Some(hash) = credential_hash {
                                *this.inner.revoked_credential_hash.lock().unwrap() = Some(hash);
                            }
                            on_status(ST_RE_PAIR_REQUIRED);
                            this.release_handle_if_current(worker_gen);
                        }
                        return;
                    }
                    Err(StreamFailure::Retryable { kind, .. }) => {
                        if !this.is_current(worker_gen) {
                            return; // stale worker records nothing
                        }
                        *this.inner.last_failure.lock().unwrap() = Some(kind.as_str());
                    }
                }
                attempt_count += 1;
                if !this.is_current(worker_gen) {
                    return; // superseded: stop cycling
                }
                on_status(ST_RECONNECTING);
                let d = (base_delay << attempt_count.min(6)).min(max_delay);
                tokio::select! {
                    biased;
                    _ = stop_rx.recv() => break,
                    _ = tokio::time::sleep(Duration::from_millis(d)) => {}
                }
            }
            if this.is_current(worker_gen) {
                on_status(ST_STOPPED);
                this.release_handle_if_current(worker_gen);
            }
        });

        *handle_slot = Some(handle);
        drop(handle_slot);
        let _ = registered_tx.send(());
        StartOutcome::Started
    }

    /// Invalidate every worker and RETIRE the current one to a full stop.
    /// The generation bump happens first, so the old worker's in-flight
    /// status writes and events become no-ops; the handle is then awaited
    /// (bounded grace) so the task has actually finished before a fresh
    /// start takes the slot — stop COMPLETES, it does not just signal.
    pub async fn stop(&self) {
        let inner = self.inner.as_ref();
        inner.generation.fetch_add(1, Ordering::SeqCst);
        if let Some(tx) = inner.stop.lock().unwrap().take() {
            let _ = tx.send(());
        }
        let handle = inner.handle.lock().unwrap().take();
        if let Some(mut h) = handle {
            // Grace window for the loop's break path; abort is the backstop —
            // a detached-but-alive task would keep dialing in the background.
            if tokio::time::timeout(Duration::from_millis(500), &mut h).await.is_err() {
                h.abort();
                let _ = (&mut h).await;
            }
        }
        inner.state.store(ST_STOPPED, Ordering::SeqCst);
        *inner.last_failure.lock().unwrap() = None;
    }

    fn is_current(&self, gen: u64) -> bool {
        self.inner.generation.load(Ordering::SeqCst) == gen
    }

    /// P1-4, generation-scoped AND lock-atomic: release the task-handle
    /// ownership WITHOUT aborting the task — used by the loop itself when
    /// the failure is terminal (AUTH_REVOKED): the task is about to finish
    /// naturally, and a later explicit pair must be able to start a fresh
    /// WSS. The generation check and BOTH slot clears share ONE critical
    /// section under the handle lock: start_with_attempt assigns a new
    /// worker's handle/stop under this same lock only AFTER bumping the
    /// generation, so a stale release arriving mid-takeover either observes
    /// the new generation (and writes nothing) or completed before the
    /// takeover began (and cleared its own slots) — it can never clear a
    /// newer worker's slots. Lock order handle→stop matches
    /// start_with_attempt; stop() never holds both locks simultaneously.
    fn release_handle_if_current(&self, gen: u64) {
        let inner = self.inner.as_ref();
        let mut handle_slot = inner.handle.lock().unwrap();
        if !self.is_current(gen) {
            return; // a newer worker owns the world; touch nothing
        }
        *handle_slot = None;
        *inner.stop.lock().unwrap() = None;
    }

    pub fn snapshot(&self) -> serde_json::Value {
        let inner = self.inner.as_ref();
        let cur = inner.current.lock().unwrap().clone();
        let state = inner.state.load(Ordering::SeqCst);
        let last_failure = *inner.last_failure.lock().unwrap();
        serde_json::json!({
            "state": Self::state_str(state),
            "reason": if state == ST_RE_PAIR_REQUIRED { Some("auth_revoked") } else { None },
            "last_failure": last_failure,
            "last_seq": inner.last_seq.load(Ordering::SeqCst),
            "current": cur,
        })
    }

    #[cfg(test)]
    fn set_state_for_runtime(&self, state: i8) {
        self.inner.state.store(state, Ordering::SeqCst);
    }

    #[cfg(test)]
    pub(crate) fn ownership_snapshot(&self) -> (bool, bool) {
        let inner = self.inner.as_ref();
        (inner.handle.lock().unwrap().is_some(), inner.stop.lock().unwrap().is_some())
    }

    #[cfg(test)]
    pub(crate) fn spawned_generations_for_test(&self) -> Vec<u64> {
        self.inner.test_spawned_gens.lock().unwrap().clone()
    }

    /// Test seam: invoke the REAL lock-atomic release with an exact
    /// generation, reproducing a stale worker's terminal cleanup firing at
    /// any chosen moment relative to a newer worker's takeover.
    #[cfg(test)]
    pub(crate) fn release_handle_if_current_for_test(&self, gen: u64) {
        self.release_handle_if_current(gen)
    }

    fn emit_status(&self, app: &tauri::AppHandle, state: i8) {
        let inner = self.inner.as_ref();
        inner.state.store(state, Ordering::SeqCst);
        let last_seq = inner.last_seq.load(Ordering::SeqCst);
        let reason = if state == ST_RE_PAIR_REQUIRED { Some("auth_revoked") } else { None };
        let _ = app.emit("lr:ws-status", serde_json::json!({ "state": Self::state_str(state), "reason": reason, "last_seq": last_seq }));
    }

    /// Generation-gated status projection: a retired worker's state write
    /// and emitted event are dropped — the frontend can never see a stale
    /// "connected"/"stopped"/"re_pair_required" from an old task over a new
    /// one.
    fn emit_status_gated(&self, app: &tauri::AppHandle, state: i8, gen: u64) {
        if !self.is_current(gen) {
            return;
        }
        self.emit_status(app, state);
    }

    /// Generation-gated event/seq bookkeeping: a stale socket's trailing
    /// frames must not regress the current worker's last_seq/current.
    fn on_event_gated(&self, app: &tauri::AppHandle, text: String, gen: u64) {
        if !self.is_current(gen) {
            return;
        }
        self.on_event(app, text);
    }

    fn on_event(&self, app: &tauri::AppHandle, text: String) {
        let inner = self.inner.as_ref();
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(seq) = v["seq"].as_i64() {
                inner.last_seq.store(seq, Ordering::SeqCst);
            }
        }
        *inner.current.lock().unwrap() = text.clone();
        let _ = app.emit("lr:ws-event", text);
    }
}

fn websocket_request(url: &str, authorization: &str) -> Result<Request<()>, String> {
    let mut request = url
        .into_client_request()
        .map_err(|e| format!("ws request: {e}"))?;
    let authorization = HeaderValue::from_str(authorization)
        .map_err(|e| format!("ws authorization: {e}"))?;
    request.headers_mut().insert(AUTHORIZATION, authorization);
    Ok(request)
}

/// Opens the exact TLS-pinned tokio-tungstenite transport used by the runtime.
/// Keeping request construction and connection here makes the non-URL bearer
/// invariant testable without changing EventStreamClient's state semantics.
async fn connect_pinned_websocket(
    url: &str,
    authorization: &str,
    fp: &str,
) -> Result<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, StreamFailure> {
    let config = crate::pinning::build_pinned_client_config(fp).map_err(|e| {
        StreamFailure::Retryable { kind: RetryKind::Tls, note: format!("pinned config: {e}") }
    })?;
    let request = websocket_request(url, authorization).map_err(|e| {
        StreamFailure::Retryable { kind: RetryKind::Protocol, note: format!("ws request: {e}") }
    })?;
    tokio_tungstenite::connect_async_tls_with_config(
        request,
        None,
        false,
        Some(tokio_tungstenite::Connector::Rustls(std::sync::Arc::new(config))),
    )
    .await
    .map(|(websocket, _response)| websocket)
    .map_err(classify_tungstenite_connect_error)
}

fn credential_hash(authorization: &str) -> [u8; 32] {
    Sha256::digest(authorization.as_bytes()).into()
}

/// Typed production classification: only an actual HTTP 401 WebSocket
/// upgrade response is terminal for the bearer. Transport/protocol failures
/// stay retryable and never become auth truth through string matching. The
/// retryable class is typed so the UI can distinguish network (unreachable)
/// from TLS identity (pinned-certificate) failures — without ever relaxing
/// the pinning itself.
fn classify_tungstenite_connect_error(error: TungsteniteError) -> StreamFailure {
    match &error {
        TungsteniteError::Http(response)
            if response.status() == tokio_tungstenite::tungstenite::http::StatusCode::UNAUTHORIZED =>
        {
            StreamFailure::AuthRevoked
        }
        TungsteniteError::Tls(_) => StreamFailure::Retryable {
            kind: RetryKind::Tls,
            note: format!("ws tls: {error}"),
        },
        // tokio-tungstenite 0.24 wraps rustls handshake verdicts as
        // Io(InvalidData, <rustls error>) — verified against the real
        // transport in real_handshake_with_wrong_pin_reports_tls_not_network.
        // A pinned-certificate mismatch lands HERE, not in Tls(_), so a
        // naive Io→Network mapping would misreport identity failures as
        // reachability problems. Only non-InvalidData I/O (refused, reset,
        // timeout, unreachable) is Network.
        TungsteniteError::Io(ref e) if e.kind() == std::io::ErrorKind::InvalidData => {
            StreamFailure::Retryable {
                kind: RetryKind::Tls,
                note: format!("ws tls handshake: {error}"),
            }
        }
        TungsteniteError::Io(_) => StreamFailure::Retryable {
            kind: RetryKind::Network,
            note: format!("ws io: {error}"),
        },
        _ => StreamFailure::Retryable {
            kind: RetryKind::Protocol,
            note: format!("ws connect: {error}"),
        },
    }
}

/// A dial that outlives its deadline becomes a typed RETRYABLE failure, so the
/// backoff loop keeps cycling and the projected state stays truthful. Without
/// this, a silently dropped SYN (Wi-Fi roam, desktop IP re-lease, phone doze)
/// pins the worker in `connecting` forever with no feedback and no retry.
const WS_DIAL_TIMEOUT: Duration = Duration::from_secs(10);

async fn dial_deadline<T>(
    dial: impl Future<Output = Result<T, StreamFailure>>,
    timeout: Duration,
) -> Result<T, StreamFailure> {
    match tokio::time::timeout(timeout, dial).await {
        Ok(result) => result,
        Err(_elapsed) => Err(StreamFailure::Retryable {
            kind: RetryKind::Deadline,
            note: "ws dial deadline exceeded".into(),
        }),
    }
}

async fn connect_once(
    url: &str,
    authorization: &str,
    fp: &str,
    app: &tauri::AppHandle,
    client: &EventStreamClient,
    worker_gen: u64,
) -> Result<(), StreamFailure> {
    let ws = dial_deadline(connect_pinned_websocket(url, authorization, fp), WS_DIAL_TIMEOUT).await?;

    // Only a CURRENT worker may declare itself connected or clear the
    // failure class — a stale worker's late success must not project.
    client.emit_status_gated(app, ST_CONNECTED, worker_gen);
    if client.is_current(worker_gen) {
        *client.inner.last_failure.lock().unwrap() = None;
    }

    let (mut sink, mut stream) = ws.split();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
    pump_messages(&mut sink, &mut stream, &mut heartbeat, |t| {
        client.on_event_gated(app, t, worker_gen);
    })
    .await
    .map_err(|note| StreamFailure::Retryable { kind: RetryKind::Protocol, note })
}

/// M3-M1 Phase-B R1 (P1-5): THE EventStream message path, extracted verbatim
/// from connect_once so the frozen ping→pong contract is testable hermetically
/// (an in-process WebSocket pair exercises the real path without any desktop).
async fn pump_messages(
    sink: &mut (impl futures_util::SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin),
    stream: &mut (impl futures_util::StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin),
    heartbeat: &mut tokio::time::Interval,
    mut on_event: impl FnMut(String),
) -> Result<(), String> {
    loop {
        tokio::select! {
            msg = stream.next() => {
                match msg {
                    Some(Ok(Message::Text(t))) => on_event(t.to_string()),
                    // Companion v1: echo each server ping payload in a pong —
                    // a missing or mismatched pong retires the socket.
                    // (tungstenite also auto-queues a pong internally; this
                    // explicit send guarantees prompt payload echo without
                    // waiting for the next write flush — a duplicate pong is
                    // RFC-legal and tolerated by the peer.)
                    Some(Ok(Message::Ping(payload))) => {
                        if sink.send(Message::Pong(payload)).await.is_err() {
                            return Err("pong failed".into());
                        }
                    }
                    Some(Ok(Message::Close(_))) => return Err("closed".into()),
                    Some(Err(e)) => return Err(format!("read: {e}")),
                    Some(Ok(_)) => {}
                    None => return Err("closed by server".into()),
                }
            }
            _ = heartbeat.tick() => {
                if sink.send(Message::Ping(vec![].into())).await.is_err() {
                    return Err("ping failed".into());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;
    use tokio_tungstenite::tungstenite::Message;

    use super::*;
    use super::{connect_pinned_websocket, websocket_request};

    #[test]
    fn websocket_handshake_keeps_credential_out_of_url_and_in_authorization_header() {
        let request = websocket_request(
            "wss://192.168.1.8:48180/v1/events",
            "Bearer credential-that-must-not-enter-a-url",
        )
        .expect("websocket request");

        assert_eq!(request.uri().to_string(), "wss://192.168.1.8:48180/v1/events");
        assert!(!request.uri().to_string().contains("credential-that-must-not-enter-a-url"));
        assert_eq!(
            request.headers().get(AUTHORIZATION).and_then(|value| value.to_str().ok()),
            Some("Bearer credential-that-must-not-enter-a-url")
        );
    }

    // ---- M3-M1 Phase-B R1 (P1-5): hermetic ping→pong gate over the REAL
    // pump_messages path (the exact EventStream message loop), using an
    // in-process duplex pair — no network, no desktop, no mock gateway.
    // The server half sends the canonical eight-byte big-endian generation
    // Ping; the client half must emit a Pong carrying the IDENTICAL payload.

    #[tokio::test]
    async fn pump_echoes_eight_byte_server_ping_payload_in_pong() {
        use tokio_tungstenite::tungstenite::protocol::Role;

        // In-process WebSocket pair: both halves are real tungstenite
        // WebSocket sessions over a tokio duplex, wrapped exactly like the
        // runtime's WebSocketStream — this exercises the actual pump_messages
        // loop that connect_once runs in production.
        let (a, b) = tokio::io::duplex(4096);
        let server = tokio_tungstenite::WebSocketStream::from_raw_socket(a, Role::Server, None).await;
        let client = tokio_tungstenite::WebSocketStream::from_raw_socket(b, Role::Client, None).await;

        let canonical_generation_ping: [u8; 8] = [0, 0, 0, 0, 0, 0, 0, 42];
        let (mut server_sink, mut server_stream) = server.split();
        let (mut client_sink, mut client_stream) = client.split();

        let mut heartbeat = tokio::time::interval(Duration::from_millis(u64::MAX)); // idle heartbeats
        let seen_events = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let seen = std::sync::Arc::clone(&seen_events);

        let pump_handle = tokio::spawn(async move {
            let _ = pump_messages(&mut client_sink, &mut client_stream, &mut heartbeat, move |t| {
                seen.lock().unwrap().push(t);
            })
            .await;
        });

        // Server: canonical 8-byte generation ping.
        server_sink
            .send(Message::Ping(canonical_generation_ping.to_vec().into()))
            .await
            .expect("server sends ping");

        // Client pump must answer with a Pong carrying the IDENTICAL payload.
        let deadline = std::time::Duration::from_secs(2);
        let pong = tokio::time::timeout(deadline, server_stream.next())
            .await
            .expect("pong within deadline")
            .expect("server stream open");
        match pong.expect("server stream open") {
            Message::Pong(payload) => {
                assert_eq!(payload.as_slice(), &canonical_generation_ping, "pong payload identical");
            }
            other => panic!("expected pong, got {other:?}"),
        }

        // The pump keeps running (socket healthy).
        server_sink
            .send(Message::Text("hello".into()))
            .await
            .expect("server sends text after pong");
        pump_handle.abort(); // stop the pump; server half drops
    }

    #[tokio::test]
    async fn real_401_upgrade_is_terminal_releases_owner_and_fresh_credential_can_start() {
        use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind 401 fixture");
        let address = listener.local_addr().expect("fixture address");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept upgrade");
            let mut request = vec![0u8; 4096];
            let _ = socket.read(&mut request).await.expect("read upgrade");
            socket
                .write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await
                .expect("write 401");
        });

        let client = EventStreamClient::new();
        let attempts = Arc::new(AtomicUsize::new(0));
        let attempts_401 = Arc::clone(&attempts);
        let url = format!("ws://{address}/v1/events");
        let status_client = client.clone();
        let started = client
            .start_with_attempt(
                Box::new(move |_worker_gen: u64| {
                    let url = url.clone();
                    let attempts = Arc::clone(&attempts_401);
                    Box::pin(async move {
                        attempts.fetch_add(1, AtomicOrdering::SeqCst);
                        let error = tokio_tungstenite::connect_async(&url).await.expect_err("fixture rejects upgrade");
                        Err(classify_tungstenite_connect_error(error))
                    })
                }),
                Arc::new(move |state| status_client.set_state_for_runtime(state)),
                Some([1; 32]),
            )
            .await;
        assert_eq!(started, StartOutcome::Started, "old credential worker registered");
        server.await.expect("401 fixture completed");
        tokio::time::timeout(Duration::from_secs(2), async {
            while client.snapshot()["state"] != "re_pair_required"
                || client.ownership_snapshot() != (false, false)
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("typed terminal state");
        assert_eq!(client.snapshot()["reason"], "auth_revoked");
        assert_eq!(attempts.load(AtomicOrdering::SeqCst), 1, "no same-bearer retry/backoff");
        assert_eq!(client.ownership_snapshot(), (false, false), "terminal worker releases handle and stop slot");

        let rejected_attempts = Arc::new(AtomicUsize::new(0));
        let rejected_seen = Arc::clone(&rejected_attempts);
        let rejected = client
            .start_with_attempt(
                Box::new(move |_worker_gen: u64| {
                    rejected_seen.fetch_add(1, AtomicOrdering::SeqCst);
                    Box::pin(std::future::pending())
                }),
                Arc::new(|_| {}),
                Some([1; 32]),
            )
            .await;
        assert_eq!(rejected, StartOutcome::RePairRequired, "same rejected credential is gated");
        assert_eq!(rejected_attempts.load(AtomicOrdering::SeqCst), 0, "old bearer never reaches transport");

        let fresh_attempts = Arc::new(AtomicUsize::new(0));
        let fresh_seen = Arc::clone(&fresh_attempts);
        let fresh_status_client = client.clone();
        let fresh_started = client
            .start_with_attempt(
                Box::new(move |_worker_gen: u64| {
                    fresh_seen.fetch_add(1, AtomicOrdering::SeqCst);
                    Box::pin(std::future::pending())
                }),
                Arc::new(move |state| fresh_status_client.set_state_for_runtime(state)),
                Some([2; 32]),
            )
            .await;
        assert_eq!(fresh_started, StartOutcome::Started, "new credential can register a fresh worker");
        tokio::task::yield_now().await;
        assert_eq!(fresh_attempts.load(AtomicOrdering::SeqCst), 1);
        assert_eq!(client.ownership_snapshot(), (true, true));
        client.stop().await;
        assert_eq!(client.ownership_snapshot(), (false, false));
    }

    #[tokio::test]
    async fn retryable_transport_failure_keeps_owner_and_retries() {
        use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

        let mut client = EventStreamClient::new();
        client.base_delay_ms = 1;
        client.max_delay_ms = 2;
        let attempts = Arc::new(AtomicUsize::new(0));
        let attempts_seen = Arc::clone(&attempts);
        let status_client = client.clone();
        let started = client
            .start_with_attempt(
                Box::new(move |_worker_gen: u64| {
                    let attempt = attempts_seen.fetch_add(1, AtomicOrdering::SeqCst);
                    if attempt == 0 {
                        Box::pin(async { Err(StreamFailure::Retryable { kind: RetryKind::Network, note: "fixture transport loss".into() }) })
                    } else {
                        Box::pin(std::future::pending())
                    }
                }),
                Arc::new(move |state| status_client.set_state_for_runtime(state)),
                Some([3; 32]),
            )
            .await;
        assert_eq!(started, StartOutcome::Started);
        tokio::time::timeout(Duration::from_secs(2), async {
            while attempts.load(AtomicOrdering::SeqCst) < 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("retryable failure reaches a second attempt");
        assert_eq!(client.ownership_snapshot(), (true, true));
        // Typed failure class is projected for the CURRENT worker.
        assert_eq!(client.snapshot()["last_failure"], serde_json::json!("network"));
        assert_eq!(client.snapshot()["state"], serde_json::json!("reconnecting"));
        client.stop().await;
        assert_eq!(client.ownership_snapshot(), (false, false));
        // stop() also retires the failure class along with the worker.
        assert_eq!(client.snapshot()["last_failure"], serde_json::Value::Null);
    }

    // ---- Reconnect-stuck R2: generation isolation with CONTROLLABLE
    // TIMING. stop() must COMPLETE the old worker (not just signal it), and
    // a retired worker's late attempt resolution — success, retryable
    // failure or 401 — must not touch the new worker's state, failure
    // class, handle/stop ownership, or the revoked-credential list. ----

    /// A held dial + stop + fresh start, then the OLD dial resolves late:
    /// nothing it reports may reach the shared world the new worker owns.
    #[tokio::test]
    async fn held_dial_stop_then_new_start_late_old_resolution_is_inert() {
        let client = EventStreamClient::new();
        let status_client = client.clone();
        let (old_ok, old_res) = tokio::sync::oneshot::channel::<Result<(), StreamFailure>>();
        let mut old_res = Some(old_res);
        let started_old = client
            .start_with_attempt(
                Box::new(move |_g| {
                    let rx = old_res.take();
                    Box::pin(async move {
                        match rx {
                            Some(rx) => rx.await.unwrap_or(Ok(())),
                            None => std::future::pending().await,
                        }
                    })
                }),
                Arc::new(move |state| status_client.set_state_for_runtime(state)),
                Some([11; 32]),
            )
            .await;
        assert_eq!(started_old, StartOutcome::Started);
        tokio::task::yield_now().await;

        // stop() completes: slot released, truthful stopped, no failure class.
        client.stop().await;
        assert_eq!(client.ownership_snapshot(), (false, false), "stop completes the worker");
        assert_eq!(client.snapshot()["state"], serde_json::json!("stopped"));

        // A fresh worker with a DIFFERENT credential takes the slot.
        let new_status_client = client.clone();
        let started_new = client
            .start_with_attempt(
                Box::new(|_g| Box::pin(std::future::pending())),
                Arc::new(move |state| new_status_client.set_state_for_runtime(state)),
                Some([12; 32]),
            )
            .await;
        assert_eq!(started_new, StartOutcome::Started);
        assert_eq!(client.snapshot()["state"], serde_json::json!("connecting"));
        assert_eq!(client.ownership_snapshot(), (true, true));

        // The old dial resolves late with a retryable failure. The retired
        // loop must write nothing: state, failure class and ownership stay
        // exactly the new worker's.
        let _ = old_ok.send(Err(StreamFailure::Retryable {
            kind: RetryKind::Network,
            note: "stale dial resolved after retirement".into(),
        }));
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(
            client.snapshot()["state"],
            serde_json::json!("connecting"),
            "a retired worker cannot project state"
        );
        assert_eq!(
            client.snapshot()["last_failure"],
            serde_json::Value::Null,
            "a retired worker records no failure class"
        );
        assert_eq!(client.ownership_snapshot(), (true, true), "the new worker keeps its slot");

        // The same-credential gate must NOT have been poisoned by the stale
        // dial: credential [11] was never terminally rejected.
        let gate_probe = client
            .start_with_attempt(
                Box::new(|_g| Box::pin(std::future::pending())),
                Arc::new(|_| {}),
                Some([11; 32]),
            )
            .await;
        assert_eq!(gate_probe, StartOutcome::AlreadyRunning, "no stale 401 gated the old credential");
        client.stop().await;
    }

    /// A held dial resolves 401 AFTER retirement: the revoked-credential
    /// list, the re_pair_required state and the new worker's slot must all
    /// stay untouched — only a CURRENT worker's 401 is credential truth.
    #[tokio::test]
    async fn retired_workers_401_cannot_poison_revoked_list_or_new_worker() {
        let client = EventStreamClient::new();
        let status_client = client.clone();
        let (old_ok, old_res) = tokio::sync::oneshot::channel::<Result<(), StreamFailure>>();
        let mut old_res = Some(old_res);
        let started_old = client
            .start_with_attempt(
                Box::new(move |_g| {
                    let rx = old_res.take();
                    Box::pin(async move {
                        match rx {
                            Some(rx) => rx.await.unwrap_or(Ok(())),
                            None => std::future::pending().await,
                        }
                    })
                }),
                Arc::new(move |state| status_client.set_state_for_runtime(state)),
                Some([21; 32]),
            )
            .await;
        assert_eq!(started_old, StartOutcome::Started);
        tokio::task::yield_now().await;
        client.stop().await;

        let new_status_client = client.clone();
        let started_new = client
            .start_with_attempt(
                Box::new(|_g| Box::pin(std::future::pending())),
                Arc::new(move |state| new_status_client.set_state_for_runtime(state)),
                Some([22; 32]),
            )
            .await;
        assert_eq!(started_new, StartOutcome::Started);

        // The retired worker's late 401.
        let _ = old_ok.send(Err(StreamFailure::AuthRevoked));
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(
            client.snapshot()["state"],
            serde_json::json!("connecting"),
            "a retired 401 cannot project re_pair_required"
        );
        assert_eq!(client.ownership_snapshot(), (true, true), "a retired 401 cannot release the new slot");

        // Credential [21] was never terminally rejected by a CURRENT worker,
        // so a fresh start with it must register, not be gated.
        client.stop().await;
        let gate_status = client.clone();
        let gate = client
            .start_with_attempt(
                Box::new(|_g| Box::pin(std::future::pending())),
                Arc::new(move |state| gate_status.set_state_for_runtime(state)),
                Some([21; 32]),
            )
            .await;
        assert_eq!(gate, StartOutcome::Started, "the stale 401 never entered the revoked list");
        client.stop().await;
    }

    /// A stale worker's terminal cleanup (release) firing mid-takeover must
    /// not clear the NEW worker's slots. Controlled timing: worker A is held,
    /// retired, superseded by worker B; A's release is then invoked with A's
    /// exact generation — the lock-atomic check must refuse it. The current
    /// generation's release must still clear both slots (the legitimate
    /// terminal path is not broken).
    #[tokio::test]
    async fn stale_release_mid_takeover_cannot_clear_the_new_workers_slots() {
        let client = EventStreamClient::new();
        let status_client = client.clone();
        let (a_ok, a_res) = tokio::sync::oneshot::channel::<Result<(), StreamFailure>>();
        let mut a_res = Some(a_res);
        let started_a = client
            .start_with_attempt(
                Box::new(move |_g| {
                    let rx = a_res.take();
                    Box::pin(async move {
                        match rx {
                            Some(rx) => rx.await.unwrap_or(Ok(())),
                            None => std::future::pending().await,
                        }
                    })
                }),
                Arc::new(move |state| status_client.set_state_for_runtime(state)),
                Some([41; 32]),
            )
            .await;
        assert_eq!(started_a, StartOutcome::Started);
        tokio::task::yield_now().await;
        let a_gen = client.spawned_generations_for_test()[0];

        client.stop().await;
        let new_status_client = client.clone();
        let started_b = client
            .start_with_attempt(
                Box::new(|_g| Box::pin(std::future::pending())),
                Arc::new(move |state| new_status_client.set_state_for_runtime(state)),
                Some([42; 32]),
            )
            .await;
        assert_eq!(started_b, StartOutcome::Started);
        assert_eq!(client.ownership_snapshot(), (true, true), "worker B owns both slots");

        // A's terminal cleanup fires NOW — after B's takeover completed.
        client.release_handle_if_current_for_test(a_gen);
        assert_eq!(
            client.ownership_snapshot(),
            (true, true),
            "the stale release cannot clear the newer worker's handle/stop"
        );

        // The legitimate path is intact: B's own generation release clears both.
        let b_gen = client.spawned_generations_for_test()[1];
        client.release_handle_if_current_for_test(b_gen);
        assert_eq!(client.ownership_snapshot(), (false, false), "a current release clears both slots");
        drop(a_ok);
        client.stop().await;
    }

    /// stop() while the worker sits in its backoff sleep: the sleep must
    /// lose to the stop signal deterministically (biased), and the worker
    /// must not write a post-stop status.
    #[tokio::test]
    async fn stop_wins_against_the_backoff_sleep_and_completes_promptly() {
        let mut client = EventStreamClient::new();
        client.base_delay_ms = 10_000; // one long backoff nap
        client.max_delay_ms = 10_000;
        let status_client = client.clone();
        let started = client
            .start_with_attempt(
                Box::new(|_g| {
                    Box::pin(async { Err(StreamFailure::Retryable { kind: RetryKind::Network, note: "once".into() }) })
                }),
                Arc::new(move |state| status_client.set_state_for_runtime(state)),
                Some([31; 32]),
            )
            .await;
        assert_eq!(started, StartOutcome::Started);
        // Wait until the worker is IN the backoff sleep.
        tokio::time::timeout(Duration::from_secs(2), async {
            while client.snapshot()["state"] != serde_json::json!("reconnecting") {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("worker reaches its backoff sleep");
        // stop() must complete well inside the 10s nap.
        tokio::time::timeout(Duration::from_millis(800), client.stop())
            .await
            .expect("stop completes promptly despite the long backoff");
        assert_eq!(client.snapshot()["state"], serde_json::json!("stopped"));
        assert_eq!(client.ownership_snapshot(), (false, false));
    }

    /// A silently hanging dial (dropped SYN) must become a RETRYABLE failure
    /// at its deadline — never a terminal classification, never a silent
    /// `connecting` pin — so the backoff loop keeps cycling truthfully.
    #[tokio::test]
    async fn dial_deadline_turns_a_hanging_dial_into_retryable_failure() {
        let failure = dial_deadline(
            std::future::pending::<Result<(), StreamFailure>>(),
            Duration::from_millis(5),
        )
        .await
        .expect_err("the deadline must fire");
        match failure {
            StreamFailure::Retryable { kind, note } => {
                assert_eq!(kind, RetryKind::Deadline, "a hung dial is a deadline failure");
                assert!(note.contains("deadline"), "the note names the deadline: {note}");
            }
            other => panic!("a hung dial must never classify as {other:?}"),
        }
    }

    #[tokio::test]
    async fn dial_deadline_never_reclassifies_success_or_terminal_outcomes() {
        let ok: Result<(), StreamFailure> = Ok(());
        assert!(matches!(
            dial_deadline(async move { ok }, Duration::from_secs(1)).await,
            Ok(())
        ));
        let tls: Result<(), StreamFailure> = Err(StreamFailure::Retryable { kind: RetryKind::Tls, note: "fixture".into() });
        assert!(matches!(
            dial_deadline(async move { tls }, Duration::from_secs(1)).await,
            Err(StreamFailure::Retryable { kind: RetryKind::Tls, .. })
        ));
        let revoked: Result<(), StreamFailure> = Err(StreamFailure::AuthRevoked);
        assert!(matches!(
            dial_deadline(async move { revoked }, Duration::from_secs(1)).await,
            Err(StreamFailure::AuthRevoked)
        ));
    }

    #[test]
    fn connect_once_dials_through_the_deadline_guard() {
        // House source-contract style: pin the wiring so the production dial
        // can never silently drop back to an unbounded connect.
        let src = include_str!("eventstream.rs");
        let at = src.find("async fn connect_once(").expect("connect_once exists");
        let body = &src[at..src.find("async fn pump_messages(").expect("pump_messages follows")];
        assert!(
            body.contains("dial_deadline(connect_pinned_websocket("),
            "the production dial must ride dial_deadline with WS_DIAL_TIMEOUT"
        );
    }

    /// Classifier ground truth pinned to the verified tokio-tungstenite 0.24
    /// paths: rustls handshake verdicts arrive as Io(InvalidData) — a
    /// certificate pin mismatch must classify as TLS, never as Network.
    #[test]
    fn io_invalid_data_is_tls_verdict_and_plain_io_is_network() {
        use std::io::ErrorKind;
        let pin_mismatch = TungsteniteError::Io(std::io::Error::new(
            ErrorKind::InvalidData,
            "certificate pin mismatch: expected 382b.. got 7aea..",
        ));
        match classify_tungstenite_connect_error(pin_mismatch) {
            StreamFailure::Retryable { kind: RetryKind::Tls, note } => {
                assert!(note.contains("pin mismatch"), "the note keeps the verifier's verdict: {note}");
            }
            other => panic!("a pin mismatch must be TLS, got {other:?}"),
        }
        let refused = TungsteniteError::Io(std::io::Error::new(
            ErrorKind::ConnectionRefused,
            "connection refused (ConnectRefused)",
        ));
        match classify_tungstenite_connect_error(refused) {
            StreamFailure::Retryable { kind: RetryKind::Network, .. } => {}
            other => panic!("a refused TCP connect must be Network, got {other:?}"),
        }
    }

    /// REAL-transport lab gate (repository-local M1 Mock Gateway): dial the
    /// gateway twice — once with the correct pinned fingerprint (control:
    /// the TLS layer must complete; a post-TLS 401 still proves TLS passed),
    /// once with a flipped fingerprint byte. The wrong-pin dial MUST
    /// classify as TLS and its note must carry the PinVerifier's own
    /// "certificate pin mismatch" verdict — proving the classification rides
    /// the actual rustls error path, not a guessed mapping. Verification is
    /// never relaxed in either direction.
    #[tokio::test]
    #[ignore = "requires the repository-local M1 Mock Gateway and its certificate fingerprint"]
    async fn real_handshake_with_wrong_pin_reports_tls_not_network() {
        let url = std::env::var("LUCKYRAY_WSS_TEST_URL")
            .expect("set LUCKYRAY_WSS_TEST_URL to the Mock WSS endpoint");
        let good_fp = std::env::var("LUCKYRAY_WSS_TEST_FINGERPRINT")
            .expect("set LUCKYRAY_WSS_TEST_FINGERPRINT to the Mock certificate fingerprint");
        let authorization = std::env::var("LUCKYRAY_WSS_TEST_AUTHORIZATION")
            .unwrap_or_else(|_| "Bearer lab-fixture-bearer".into());
        // The app installs the ring provider during startup; a bare test
        // process must do the same before rustls can build a client config.
        let _ = rustls::crypto::ring::default_provider().install_default();

        // Control: the correct pin completes the handshake (or is rejected
        // AFTER TLS by a 401 upgrade — either proves the TLS layer passed).
        match connect_pinned_websocket(&url, &authorization, &good_fp).await {
            Ok(_stream) => {}
            Err(StreamFailure::AuthRevoked) => {}
            Err(other) => panic!("control dial with the correct pin must pass TLS, got {other:?}"),
        }

        // Wrong pin: flip the first fingerprint byte and dial for real.
        let mut bad = crate::pinning::PinVerifier::hex_to_bytes(&good_fp).expect("hex fingerprint");
        bad[0] ^= 0xff;
        let bad_hex: String = bad.iter().map(|b| format!("{b:02x}")).collect();
        let failure = connect_pinned_websocket(&url, &authorization, &bad_hex)
            .await
            .expect_err("a wrong pinned fingerprint must fail the handshake");
        match failure {
            StreamFailure::Retryable { kind: RetryKind::Tls, note } => {
                assert!(
                    note.contains("certificate pin mismatch"),
                    "the note must carry the PinVerifier's real verdict, got: {note}"
                );
            }
            other => panic!("wrong pin must classify as TLS, got {other:?}"),
        }
    }

    /// Manual lab gate for the exact tokio-tungstenite transport used by the
    /// runtime. It intentionally needs the repository-local TLS Mock Gateway,
    /// so hosted CI remains hermetic while the MI 8 / lab validation runs it.
    #[tokio::test]
    #[ignore = "requires the repository-local M1 Mock Gateway and ephemeral test bearer"]
    async fn actual_tokio_client_receives_mock_event_with_authorization_header() {
        let url = std::env::var("LUCKYRAY_WSS_TEST_URL")
            .expect("set LUCKYRAY_WSS_TEST_URL to the endpoint-only Mock WSS URL");
        let authorization = std::env::var("LUCKYRAY_WSS_TEST_AUTHORIZATION")
            .expect("set LUCKYRAY_WSS_TEST_AUTHORIZATION to an ephemeral bearer header");
        let fingerprint = std::env::var("LUCKYRAY_WSS_TEST_FINGERPRINT")
            .expect("set LUCKYRAY_WSS_TEST_FINGERPRINT to the Mock certificate fingerprint");

        assert!(!url.contains('?'), "WSS endpoint must not include a query token");
        let mut websocket = connect_pinned_websocket(&url, &authorization, &fingerprint)
            .await
            .expect("tokio-tungstenite must connect with the authorization header");
        let message = tokio::time::timeout(std::time::Duration::from_secs(4), websocket.next())
            .await
            .expect("Mock must emit its first event within the timeout")
            .expect("Mock must keep the socket open")
            .expect("Mock event must be a valid websocket frame");
        let Message::Text(text) = message else {
            panic!("expected a text Mock event");
        };
        let event: serde_json::Value = serde_json::from_str(&text).expect("Mock event JSON");
        assert_eq!(event["type"], "mock.connected");
        assert_eq!(event["seq"], 0);
    }
}

// ---------------------------------------------------------------------------
// Services V1 hint worker (Issue #77 REPAIR-R2 P1-W2).
//
// A SEPARATE worker from the foundation `/v1/events` stream: different URL,
// different task, different state. It reuses the SAME pinned connect helper and
// the SAME non-URL bearer invariant, so no second TLS/credential path exists.
// ---------------------------------------------------------------------------

/// Connect a pinned WebSocket to `url` with the bearer in the Authorization
/// header only. Exposed for the Services hint worker; identical TLS pinning and
/// request construction to the foundation stream.
pub(crate) async fn hint_websocket_connect(
    url: &str,
    authorization: &str,
    fp: &str,
) -> Result<
    tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    String,
> {
    connect_pinned_websocket(url, authorization, fp)
        .await
        .map_err(|failure| match failure {
            StreamFailure::AuthRevoked => "PAIRING_REQUIRED".to_string(),
            StreamFailure::Retryable { .. } => "SERVICE_UNAVAILABLE".to_string(),
        })
}

/// Run the Services hint worker until the scope is retired or the socket ends.
///
/// The loop selects on THREE things (P1-H4): the generation-scoped cancellation
/// channel, the socket read, and an idle keepalive tick. A `retire()` on this
/// generation fires the cancellation branch immediately, so the authenticated
/// socket closes promptly instead of waiting out the read timeout.
///
/// Every worker-originated cleanup is generation-conditional (P1-H5): a stale
/// worker finishing its own generation can never retire or cancel a newer one.
/// Native lifecycle code (`retire_managed`) intentionally retires the CURRENT
/// authority, which is a different call path.
pub(crate) async fn run_hint_worker(
    url: String,
    authorization: String,
    fingerprint: String,
    state: crate::services_hints::ManagedHintState,
    generation: u64,
    shared: crate::SharedState,
    owner: String,
) {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    // P1-H7: the cancellation receiver may only be installed while THIS
    // generation is still current and not stopped. A worker whose generation was
    // retired while its task sat queued is refused HERE — before any dial — so it
    // can never open an authenticated WSS after the authority was retired.
    let mut cancel = match state.install_cancellation_if_current(generation) {
        Some(receiver) => receiver,
        None => {
            state.finish(generation, false);
            return;
        }
    };

    // Dial under cancellation too: a retire while dialling must not leave a
    // socket opening in the background.
    let dial = hint_websocket_connect(&url, &authorization, &fingerprint);
    tokio::pin!(dial);
    let mut socket = tokio::select! {
        biased;
        _ = cancel.changed() => {
            state.finish(generation, false);
            return;
        }
        result = &mut dial => match result {
            Ok(socket) => socket,
            Err(_) => {
                state.finish(generation, true);
                return;
            }
        },
    };
    // Only a CURRENT generation may declare itself connected.
    if !state.mark_running(generation) {
        let _ = socket.close(None).await;
        return;
    }

    let mut keepalive = tokio::time::interval(std::time::Duration::from_secs(30));
    keepalive.tick().await; // the first tick is immediate

    loop {
        tokio::select! {
            biased;
            // 1) Cancellation: close the socket NOW, no timeout wait.
            _ = cancel.changed() => {
                let _ = socket.close(None).await;
                state.finish(generation, false);
                return;
            }
            // 2) Idle keepalive: ping so a dead peer is detected.
            _ = keepalive.tick() => {
                if socket.send(Message::Ping(Vec::new().into())).await.is_err() {
                    state.finish(generation, true);
                    return;
                }
            }
            // 3) Socket traffic.
            next = socket.next() => match next {
                None => {
                    state.finish(generation, true); // EOF
                    return;
                }
                Some(Err(_)) => {
                    state.finish(generation, true); // protocol error
                    return;
                }
                Some(Ok(message)) => match message {
                    Message::Text(text) => {
                        match crate::services_hints::parse_hint(&text) {
                            Ok(Some(hint)) => {
                                if !state.publish(generation, Some(hint)) {
                                    // Retired while in flight: stop this worker.
                                    state.finish(generation, false);
                                    return;
                                }
                            }
                            Ok(None) => {}
                            // Malformed/unknown hint: fail closed, but ONLY for
                            // this generation — a stale worker must not retire a
                            // newer one.
                            Err(()) => {
                                let _ = socket.close(None).await;
                                state.retire_if_current(generation);
                                state.finish(generation, false);
                                return;
                            }
                        }
                    }
                    Message::Ping(payload) => {
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            state.finish(generation, true); // ping failure
                            return;
                        }
                    }
                    Message::Close(_) => {
                        state.finish(generation, false);
                        return;
                    }
                    _ => {}
                },
            },
        }

        // A Desktop switch retires this worker even mid-stream. Generation-safe:
        // a stale worker leaves a newer generation alone.
        if crate::content::expected_gateway(&shared, &owner).is_err() {
            let _ = socket.close(None).await;
            state.retire_if_current(generation);
            state.finish(generation, false);
            return;
        }
    }
}
