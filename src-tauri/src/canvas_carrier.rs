//! Read-only canvas browser carrier. Native shell owns this handle and launch
//! URL; neither desktop credentials nor this API are exposed as Tauri commands.
//! No LSH state, arbitrary forwarding, writes, or WebSocket. Media is limited
//! to authenticated opaque canvas IDs and validated single byte ranges.
use crate::canvas_connection::CanvasConnection;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;
use zeroize::Zeroizing;

const COOKIE_PREFIX: &str = "luckyray_canvas_";
const LAUNCH_PATH: &str = "/canvas/__launch?capability=";
const MAX_HEAD_BYTES: usize = 16 * 1024;
const MAX_CONNECTIONS: usize = 8;
const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; media-src 'self' blob:; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'none'; worker-src 'none'";

// A watch retains cancellation even if no request is listening yet. This uses
// existing tokio features and does not add runtime/dependency permissions.
struct Stop(tokio::sync::watch::Sender<bool>);
impl Stop {
    fn new() -> Self { Self(tokio::sync::watch::channel(false).0) }
    fn cancel(&self) { self.0.send_replace(true); }
    fn is_cancelled(&self) -> bool { *self.0.borrow() }
    async fn cancelled(&self) {
        let mut receiver = self.0.subscribe();
        loop {
            if *receiver.borrow_and_update() { return; }
            if receiver.changed().await.is_err() { return; }
        }
    }
}

struct Runtime {
    connection: CanvasConnection,
    host: String,
    origin: String,
    launch: Mutex<Option<Zeroizing<String>>>,
    launch_expires: Instant,
    session: Zeroizing<String>,
    cookie_name: String,
    stop: Stop,
}

/// One handle owns one lease; no stale shell can cancel a replacement lease.
/// Do not serialize this handle or send its launch URL through JavaScript.
pub(crate) struct CanvasCarrier {
    runtime: Arc<Runtime>,
    lease: String,
    launch_url: Zeroizing<String>,
}

impl CanvasCarrier {
    pub(crate) async fn start(connection: CanvasConnection) -> Result<Self, String> {
        connection.current()?;
        let capability = random_secret()?;
        let session = random_secret()?;
        let lease = random_secret()?.to_string();
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await
            .map_err(|_| "CANVAS_CARRIER_UNAVAILABLE")?;
        let host = listener.local_addr().map_err(|_| "CANVAS_CARRIER_UNAVAILABLE")?.to_string();
        let origin = format!("http://{host}");
        let launch_url = Zeroizing::new(format!("{origin}{LAUNCH_PATH}{}", capability.as_str()));
        connection.current()?;
        let runtime = Arc::new(Runtime {
            connection, host, origin, launch: Mutex::new(Some(capability)),
            launch_expires: Instant::now() + Duration::from_secs(60),
            session, cookie_name: format!("{COOKIE_PREFIX}{lease}"), stop: Stop::new(),
        });
        tokio::spawn(serve(listener, runtime.clone()));
        Ok(Self { runtime, lease, launch_url })
    }

    pub(crate) fn lease_id(&self) -> &str { &self.lease }
    pub(crate) fn launch_url(&self) -> &str { &self.launch_url }
    pub(crate) fn current(&self, lease: &str) -> bool {
        if !equal_secret(lease, &self.lease) || self.runtime.stop.is_cancelled() { return false; }
        if self.runtime.connection.current().is_err() {
            self.runtime.stop.cancel();
            return false;
        }
        true
    }
    pub(crate) fn close(&self, lease: &str) -> bool {
        if !equal_secret(lease, &self.lease) { return false; }
        self.runtime.stop.cancel();
        true
    }
}

impl Drop for CanvasCarrier {
    fn drop(&mut self) { self.runtime.stop.cancel(); }
}

fn random_secret() -> Result<Zeroizing<String>, String> {
    let mut bytes = Zeroizing::new([0u8; 32]);
    getrandom::getrandom(&mut bytes[..]).map_err(|_| "CANVAS_CARRIER_ENTROPY_UNAVAILABLE")?;
    let mut secret = Zeroizing::new(String::with_capacity(64));
    use std::fmt::Write;
    for byte in bytes.iter() { write!(&mut *secret, "{byte:02x}").map_err(|_| "CANVAS_CARRIER_ENTROPY_UNAVAILABLE")?; }
    Ok(secret)
}

fn equal_secret(left: &str, right: &str) -> bool {
    if left.len() != right.len() { return false; }
    left.bytes().zip(right.bytes()).fold(0u8, |difference, (a, b)| difference | (a ^ b)) == 0
}

async fn serve(listener: TcpListener, runtime: Arc<Runtime>) {
    let slots = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    let mut check = tokio::time::interval(Duration::from_millis(250));
    loop {
        tokio::select! {
            biased;
            _ = runtime.stop.cancelled() => break,
            _ = check.tick() => {
                if runtime.connection.current().is_err() { runtime.stop.cancel(); break; }
            },
            accepted = listener.accept() => {
                let Ok((stream, peer)) = accepted else { runtime.stop.cancel(); break; };
                if !peer.ip().is_loopback() { continue; }
                let Ok(permit) = slots.clone().try_acquire_owned() else { continue; };
                let runtime = runtime.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    // Cancelling drops the stream AND an outstanding pinned
                    // upstream future, not just the listener accepting work.
                    tokio::select! {
                        biased;
                        _ = runtime.stop.cancelled() => {},
                        _ = tokio::time::timeout(Duration::from_secs(300), handle(stream, &runtime)) => {},
                    }
                });
            },
        }
    }
    runtime.stop.cancel();
}

struct Request<'a> {
    path: &'a str,
    headers: Vec<(&'a str, &'a str)>,
}
impl Request<'_> {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| *value)
    }
}

// One bounded request per socket. No bodies, HTTP pipelining or upgrades.
fn parse_request(head: &[u8]) -> Result<Request<'_>, u16> {
    if head.len() > MAX_HEAD_BYTES || !head.ends_with(b"\r\n\r\n") { return Err(400); }
    let text = std::str::from_utf8(head).map_err(|_| 400u16)?;
    let mut lines = text[..text.len() - 4].split("\r\n");
    let mut first = lines.next().ok_or(400u16)?.split(' ');
    let method = first.next().ok_or(400u16)?;
    let path = first.next().ok_or(400u16)?;
    if first.next() != Some("HTTP/1.1") || first.next().is_some() { return Err(400); }
    if method != "GET" { return Err(405); }
    if !path.starts_with('/') || path.starts_with("//") || !path.bytes().all(|b| b.is_ascii_graphic()) { return Err(400); }
    let mut headers: Vec<(&str, &str)> = Vec::new();
    for line in lines {
        let (key, value) = line.split_once(':').ok_or(400u16)?;
        if key.is_empty() || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            || !value.bytes().all(|b| b == b'\t' || (0x20..=0x7e).contains(&b))
            || headers.len() >= 64 || headers.iter().any(|(existing, _)| existing.eq_ignore_ascii_case(key)) {
            return Err(400);
        }
        headers.push((key, value.trim()));
    }
    let request = Request { path, headers };
    if request.header("transfer-encoding").is_some() || request.header("upgrade").is_some()
        || request.header("expect").is_some()
        || request.header("content-length").is_some_and(|length| length != "0") { return Err(400); }
    Ok(request)
}

fn valid_origin(request: &Request<'_>, host: &str, origin: &str) -> bool {
    request.header("host") == Some(host)
        && request.header("origin").map_or(true, |value| value == origin)
        && request.header("referer").map_or(true, |value| value.strip_prefix(origin).is_some_and(|suffix| suffix.starts_with('/')))
        && request.header("sec-fetch-site").map_or(true, |value| matches!(value, "same-origin" | "none"))
}

fn has_cookie(request: &Request<'_>, cookie_name: &str, session: &str) -> bool {
    let Some(cookie) = request.header("cookie") else { return false; };
    let mut found = None;
    for part in cookie.split(';') {
        if let Some((key, value)) = part.trim().split_once('=') {
            if key == cookie_name {
                if found.is_some() { return false; }
                found = Some(value);
            }
        }
    }
    found.is_some_and(|value| equal_secret(value, session))
}

fn single_asset_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 200 && name != "." && name != ".."
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

enum Route<'a> { Asset(&'a str), List, Detail(&'a str), Media(&'a str), Alias(String), Missing }
fn route(path: &str) -> Route<'_> {
    if matches!(path, "/canvas/" | "/canvas/index.html" | "/canvas/luckyray-logo.png") { return Route::Asset(path); }
    if path.strip_prefix("/canvas/assets/").is_some_and(single_asset_name) { return Route::Asset(path); }
    if let Some(name) = path.strip_prefix("/assets/").filter(|name| single_asset_name(name)) {
        // Path=/canvas cannot accompany /assets. Redirect only, with zero
        // upstream traffic; the second request must authenticate its cookie.
        return Route::Alias(format!("/canvas/assets/{name}"));
    }
    if path == "/luckyray-logo.png" { return Route::Alias("/canvas/luckyray-logo.png".into()); }
    if path == "/canvas/api/v1/canvases" { return Route::List; }
    if let Some(id) = path.strip_prefix("/canvas/api/v1/canvases/").filter(|id| !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))) {
        return Route::Detail(id);
    }
    if let Some(id) = path.strip_prefix("/canvas/media/").filter(|id| id.len() == 64 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))) {
        return Route::Media(id);
    }
    Route::Missing
}

async fn read_head(stream: &mut TcpStream) -> Result<Zeroizing<Vec<u8>>, ()> {
    let mut head = Zeroizing::new(Vec::with_capacity(MAX_HEAD_BYTES));
    loop {
        let byte = stream.read_u8().await.map_err(|_| ())?;
        head.push(byte);
        if head.ends_with(b"\r\n\r\n") { return Ok(head); }
        if head.len() >= MAX_HEAD_BYTES { return Err(()); }
    }
}

async fn handle(mut stream: TcpStream, runtime: &Runtime) {
    if runtime.connection.current().is_err() { runtime.stop.cancel(); return; }
    let head = match tokio::time::timeout(Duration::from_secs(5), read_head(&mut stream)).await {
        Ok(Ok(head)) => head,
        _ => return,
    };
    if runtime.connection.current().is_err() { runtime.stop.cancel(); return; }
    let request = match parse_request(&head) {
        Ok(request) => request,
        Err(status) => { let _ = respond(&mut stream, status, "text/plain", b"CANVAS_REQUEST_REJECTED", None, None).await; return; }
    };
    // Five seconds for headers plus twenty for ordinary reads. Only the fixed
    // media route receives the long streaming budget; outer cap is 300 total.
    let budget = if matches!(route(request.path), Route::Media(_)) { 300 } else { 20 };
    let _ = tokio::time::timeout(Duration::from_secs(budget), dispatch(stream, runtime, &request)).await;
}

async fn dispatch(mut stream: TcpStream, runtime: &Runtime, request: &Request<'_>) {
    if !valid_origin(&request, &runtime.host, &runtime.origin) {
        let _ = respond(&mut stream, 403, "text/plain", b"CANVAS_ORIGIN_REJECTED", None, None).await;
        return;
    }
    if request.header("range").is_some() && !matches!(route(request.path), Route::Media(_)) {
        let _ = respond(&mut stream, 400, "text/plain", b"CANVAS_RANGE_INVALID", None, None).await;
        return;
    }
    if let Some(capability) = request.path.strip_prefix(LAUNCH_PATH) {
        let accepted = runtime.launch.lock().ok().is_some_and(|mut launch| {
            if Instant::now() >= runtime.launch_expires { launch.take(); return false; }
            if launch.as_ref().is_some_and(|expected| equal_secret(capability, expected)) { launch.take(); true } else { false }
        });
        if !accepted { let _ = respond(&mut stream, 403, "text/plain", b"CANVAS_LAUNCH_REJECTED", None, None).await; return; }
        if runtime.connection.current().is_err() { runtime.stop.cancel(); return; }
        let cookie = Zeroizing::new(format!("{}={}; HttpOnly; SameSite=Strict; Path=/canvas", runtime.cookie_name, runtime.session.as_str()));
        let _ = respond(&mut stream, 303, "text/plain", b"", Some("/canvas/"), Some(&cookie)).await;
        return;
    }
    let selected = route(request.path);
    if let Route::Alias(location) = &selected {
        let _ = respond(&mut stream, 302, "text/plain", b"", Some(location), None).await;
        return;
    }
    if !has_cookie(&request, &runtime.cookie_name, &runtime.session) {
        let _ = respond(&mut stream, 401, "text/plain", b"CANVAS_LOCAL_AUTH_REQUIRED", None, None).await;
        return;
    }
    let result = match selected {
        Route::Asset(path) => runtime.connection.asset(path).await.map(|asset| (asset.bytes, asset.content_type)),
        Route::List => runtime.connection.list().await.map(|body| (body, "application/json")),
        Route::Detail(id) => runtime.connection.load(id).await.map(|body| (body, "application/json")),
        Route::Media(id) => {
            stream_media(&mut stream, runtime, id, request.header("range")).await;
            return;
        },
        _ => { let _ = respond(&mut stream, 404, "text/plain", b"CANVAS_ROUTE_UNAVAILABLE", None, None).await; return; },
    };
    if runtime.connection.current().is_err() { runtime.stop.cancel(); return; }
    match result {
        Ok((body, mime)) => { let _ = respond(&mut stream, 200, mime, &body, None, None).await; },
        Err(error) => {
            let (status, code) = match error.as_str() {
                "CANVAS_RANGE_INVALID" => (400, "CANVAS_RANGE_INVALID"),
                "CANVAS_NOT_FOUND" => (404, "CANVAS_NOT_FOUND"),
                "CANVAS_RESPONSE_TOO_LARGE" => (413, "CANVAS_RESPONSE_TOO_LARGE"),
                "CANVAS_SESSION_EXPIRED" => { runtime.stop.cancel(); return; },
                _ => (503, "CANVAS_SERVICE_UNAVAILABLE"),
            };
            let _ = respond(&mut stream, status, "text/plain", code.as_bytes(), None, None).await;
        },
    }
}

async fn stream_media(stream: &mut TcpStream, runtime: &Runtime, id: &str, range: Option<&str>) {
    let mut media = match runtime.connection.media(id, range).await {
        Ok(media) => media,
        Err(error) => {
            if runtime.connection.current().is_err() || error == "CANVAS_SESSION_EXPIRED" { runtime.stop.cancel(); return; }
            let status = match error.as_str() { "CANVAS_RANGE_INVALID" => 400, "CANVAS_NOT_FOUND" => 404, "CANVAS_RESPONSE_TOO_LARGE" => 413, _ => 503 };
            let _ = respond(stream, status, "text/plain", b"CANVAS_MEDIA_UNAVAILABLE", None, None).await;
            return;
        },
    };
    if runtime.connection.current().is_err() { runtime.stop.cancel(); return; }
    let mut head = response_head(media.status, media.content_type, media.content_length);
    head.push_str("Accept-Ranges: bytes\r\n");
    if let Some(range) = &media.content_range { head.push_str(&format!("Content-Range: {range}\r\n")); }
    head.push_str("\r\n");
    if !matches!(tokio::time::timeout(Duration::from_secs(15), stream.write_all(head.as_bytes())).await, Ok(Ok(()))) { return; }
    loop {
        // Both before and after every upstream chunk await, then around each
        // browser write. No complete-video buffering and no unvalidated headers.
        let chunk = match runtime.connection.media_chunk(&mut media).await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(_) => { if runtime.connection.current().is_err() { runtime.stop.cancel(); } return; },
        };
        if runtime.connection.current().is_err() { runtime.stop.cancel(); return; }
        if !matches!(tokio::time::timeout(Duration::from_secs(15), stream.write_all(&chunk)).await, Ok(Ok(()))) { return; }
        if runtime.connection.current().is_err() { runtime.stop.cancel(); return; }
    }
    let _ = stream.shutdown().await;
}

fn response_head(status: u16, mime: &str, length: u64) -> Zeroizing<String> {
    let reason = match status { 200 => "OK", 206 => "Partial Content", 302 => "Found", 303 => "See Other", 400 => "Bad Request", 401 => "Unauthorized", 403 => "Forbidden", 404 => "Not Found", 405 => "Method Not Allowed", 413 => "Payload Too Large", 416 => "Range Not Satisfiable", _ => "Service Unavailable" };
    Zeroizing::new(format!("HTTP/1.1 {status} {reason}\r\nContent-Type: {mime}\r\nContent-Length: {length}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: {CSP}\r\nCross-Origin-Resource-Policy: same-origin\r\nX-Frame-Options: DENY\r\n"))
}

async fn respond(stream: &mut TcpStream, status: u16, mime: &str, body: &[u8], location: Option<&str>, cookie: Option<&str>) -> std::io::Result<()> {
    let mut head = response_head(status, mime, body.len() as u64);
    if let Some(location) = location { head.push_str(&format!("Location: {location}\r\n")); }
    if let Some(cookie) = cookie { head.push_str("Set-Cookie: "); head.push_str(cookie); head.push_str("\r\n"); }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body).await?;
    stream.shutdown().await
}

#[cfg(test)]
mod tests {
    use super::*;
    include!("../../tests/canvasCarrier.native.rs");
}
