// Standalone harness only: its CanvasConnection is an in-memory adapter, never
// a production/pairing service. Tests exercise the actual carrier over loopback.
use crate::canvas_carrier::CanvasCarrier;
use crate::canvas_connection::CanvasConnection;
use std::sync::{Arc, atomic::{AtomicBool, AtomicUsize, Ordering}};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use std::time::Duration;

fn connection() -> (CanvasConnection, Arc<AtomicBool>, Arc<AtomicUsize>, Arc<AtomicBool>) {
    let current = Arc::new(AtomicBool::new(true));
    let calls = Arc::new(AtomicUsize::new(0));
    let hanging = Arc::new(AtomicBool::new(false));
    (CanvasConnection { current: current.clone(), calls: calls.clone(), hanging: hanging.clone() }, current, calls, hanging)
}

async fn send(url: &str, cookie: Option<&str>, origin: Option<&str>) -> String {
    send_range(url, cookie, origin, None).await
}

async fn send_range(url: &str, cookie: Option<&str>, origin: Option<&str>, range: Option<&str>) -> String {
    let rest = url.strip_prefix("http://").unwrap();
    let (host, path) = rest.split_once('/').unwrap();
    let mut stream = TcpStream::connect(host).await.unwrap();
    let mut head = format!("GET /{path} HTTP/1.1\r\nHost: {host}\r\n");
    if let Some(cookie) = cookie { head.push_str(&format!("Cookie: {cookie}\r\n")); }
    if let Some(origin) = origin { head.push_str(&format!("Origin: {origin}\r\n")); }
    if let Some(range) = range { head.push_str(&format!("Range: {range}\r\n")); }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).await.unwrap();
    let mut bytes = Vec::new();
    // Retiring a lease can close/reset a connection; both are acceptable.
    let _ = tokio::time::timeout(Duration::from_secs(3), stream.read_to_end(&mut bytes)).await.unwrap();
    String::from_utf8(bytes).unwrap()
}

async fn launch(carrier: &CanvasCarrier) -> (String, String) {
    let response = send(carrier.launch_url(), None, None).await;
    assert!(response.starts_with("HTTP/1.1 303"));
    assert!(response.contains("HttpOnly; SameSite=Strict; Path=/canvas"));
    assert!(response.contains("Referrer-Policy: no-referrer"));
    let cookie = response.split("Set-Cookie: ").nth(1).unwrap().split(';').next().unwrap().to_owned();
    let root = carrier.launch_url().split("/canvas/").next().unwrap().to_owned();
    (root, cookie)
}

#[tokio::test]
async fn synthetic_launch_cookie_origin_alias_and_detail_boundary() {
    let (connection, _, calls, _) = connection();
    let carrier = CanvasCarrier::start(connection).await.unwrap();
    let root = carrier.launch_url().split("/canvas/").next().unwrap();
    assert!(send(&format!("{root}/canvas/"), None, None).await.starts_with("HTTP/1.1 401"));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let (root, cookie) = launch(&carrier).await;
    assert!(send(carrier.launch_url(), None, None).await.starts_with("HTTP/1.1 403"));
    let alias = send(&format!("{root}/assets/app.js"), None, None).await;
    assert!(alias.starts_with("HTTP/1.1 302"));
    assert!(alias.contains("Location: /canvas/assets/app.js\r\n"));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(send(&format!("{root}/canvas/"), Some(&cookie), Some("http://127.0.0.1:1")).await.starts_with("HTTP/1.1 403"));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let list = send(&format!("{root}/canvas/api/v1/canvases"), Some(&cookie), Some(&root)).await;
    assert!(list.starts_with("HTTP/1.1 200"));
    assert!(list.ends_with(r#"{"canvases":[]}"#));
    for header in ["Cache-Control: no-store", "X-Content-Type-Options: nosniff", "Content-Security-Policy:", "Cross-Origin-Resource-Policy: same-origin"] { assert!(list.contains(header)); }
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let detail = send(&format!("{root}/canvas/api/v1/canvases/a"), Some(&cookie), None).await;
    assert!(detail.starts_with("HTTP/1.1 200"));
    assert!(detail.contains("remoteProjectionVersion"));
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert!(!carrier.close("stale-lease"));
    assert!(carrier.current(carrier.lease_id()));
    assert!(carrier.close(carrier.lease_id()));
    assert!(!carrier.current(carrier.lease_id()));
}

#[tokio::test]
async fn synthetic_old_lease_cannot_retire_new_and_cookies_are_distinct() {
    let (a, _, _, _) = connection();
    let (b, _, _, _) = connection();
    let a = CanvasCarrier::start(a).await.unwrap();
    let b = CanvasCarrier::start(b).await.unwrap();
    let (_, cookie_a) = launch(&a).await;
    let (root_b, cookie_b) = launch(&b).await;
    assert_ne!(cookie_a.split('=').next(), cookie_b.split('=').next());
    assert!(!b.close(a.lease_id()));
    a.close(a.lease_id());
    assert!(b.current(b.lease_id()));
    assert!(send(&format!("{root_b}/canvas/"), Some(&cookie_a), None).await.starts_with("HTTP/1.1 401"));
    assert!(send(&format!("{root_b}/canvas/"), Some(&cookie_b), None).await.starts_with("HTTP/1.1 200"));
}

#[tokio::test]
async fn synthetic_epoch_retirement_aborts_pending_request() {
    let (connection, current, calls, hanging) = connection();
    let carrier = CanvasCarrier::start(connection).await.unwrap();
    let (root, cookie) = launch(&carrier).await;
    hanging.store(true, Ordering::SeqCst);
    let request = tokio::spawn(async move { send(&format!("{root}/canvas/api/v1/canvases"), Some(&cookie), None).await });
    tokio::time::timeout(Duration::from_secs(2), async {
        while calls.load(Ordering::SeqCst) == 0 { tokio::time::sleep(Duration::from_millis(5)).await; }
    }).await.unwrap();
    current.store(false, Ordering::SeqCst);
    let response = tokio::time::timeout(Duration::from_secs(2), request).await.unwrap().unwrap();
    assert!(!response.contains("200 OK"));
    assert!(!carrier.current(carrier.lease_id()));
}


#[tokio::test]
async fn synthetic_media_stream_range_and_416_have_rebuilt_headers() {
    let (connection, _, calls, _) = connection();
    let carrier = CanvasCarrier::start(connection).await.unwrap();
    let (root, cookie) = launch(&carrier).await;
    let url = format!("{root}/canvas/media/{}", "a".repeat(64));
    let denied = send(&url, None, None).await;
    assert!(denied.starts_with("HTTP/1.1 401"));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let full = send(&url, Some(&cookie), None).await;
    assert!(full.starts_with("HTTP/1.1 200"));
    assert!(full.contains("Content-Length: 3\r\n"));
    assert!(full.ends_with("\r\n\r\nabc"));
    let partial = send_range(&url, Some(&cookie), None, Some("bytes=0-1")).await;
    assert!(partial.starts_with("HTTP/1.1 206"));
    assert!(partial.contains("Content-Range: bytes 0-1/3\r\n"));
    assert!(partial.ends_with("\r\n\r\nab"));
    let unsatisfied = send_range(&url, Some(&cookie), None, Some("bytes=99-")).await;
    assert!(unsatisfied.starts_with("HTTP/1.1 416"));
    assert!(unsatisfied.contains("Content-Range: bytes */3\r\n"));
    assert!(unsatisfied.contains("Content-Length: 0\r\n"));
    let bad_range = send_range(&url, Some(&cookie), None, Some("bytes=0-1,2-3")).await;
    assert!(bad_range.starts_with("HTTP/1.1 400"));
    let list_range = send_range(&format!("{root}/canvas/api/v1/canvases"), Some(&cookie), None, Some("bytes=0-1")).await;
    assert!(list_range.starts_with("HTTP/1.1 400"));
}

#[tokio::test]
async fn synthetic_epoch_retirement_aborts_pending_media_chunk() {
    let (connection, current, calls, hanging) = connection();
    let carrier = CanvasCarrier::start(connection).await.unwrap();
    let (root, cookie) = launch(&carrier).await;
    hanging.store(true, Ordering::SeqCst);
    let request = tokio::spawn(async move { send(&format!("{root}/canvas/media/{}", "a".repeat(64)), Some(&cookie), None).await });
    tokio::time::timeout(Duration::from_secs(2), async {
        while calls.load(Ordering::SeqCst) == 0 { tokio::time::sleep(Duration::from_millis(5)).await; }
    }).await.unwrap();
    current.store(false, Ordering::SeqCst);
    let response = tokio::time::timeout(Duration::from_secs(2), request).await.unwrap().unwrap();
    assert!(!response.ends_with("abc"));
    assert!(!carrier.current(carrier.lease_id()));
}
