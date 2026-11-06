//! Android WebView cannot reliably seek through Wry's intercepted asset URLs.
//! Serve an owned complete cache file or a bounded paired Range stream, behind
//! a short-lived loopback capability. No path, Desktop credential or LAN API
//! is exposed to the WebView or the native player.
use std::{collections::HashMap, path::PathBuf, sync::{Arc, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant}};
use tokio::{io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt}, net::{TcpListener, TcpStream}, sync::{Mutex, OnceCell, Semaphore}};

enum MediaSource { Cached(PathBuf), Remote(Arc<stream::Remote>) }
struct Lease { source: MediaSource, mime: String, expires: Instant, live: AtomicBool, scope: Option<Box<dyn Fn() -> Result<(), String> + Send + Sync>> }
impl Lease {
    fn check(&self) -> Result<(), String> {
        if !self.live.load(Ordering::Acquire) || self.expires <= Instant::now() { return Err("MEDIA_EXPIRED".into()); }
        if let Some(check) = &self.scope { check()?; }
        if let MediaSource::Remote(remote) = &self.source { remote.check()?; }
        Ok(())
    }
    fn stop(&self) { self.live.store(false, Ordering::Release); if let MediaSource::Remote(remote) = &self.source { remote.stop(); } }
    fn metrics(&self) -> serde_json::Value {
        match &self.source {
            MediaSource::Remote(remote) => serde_json::json!({"transport":"lan", "completeOffline":false,
                "sizeBytes":remote.metadata.len, "remoteBytes":remote.metrics.bytes.load(Ordering::Acquire),
                "rangeRequests":remote.metrics.requests.load(Ordering::Acquire), "cacheBytes":remote.metrics.cache_bytes.load(Ordering::Acquire)}),
            MediaSource::Cached(path) => serde_json::json!({"transport":"cache", "completeOffline":true,
                "sizeBytes":std::fs::metadata(path).map(|m|m.len()).unwrap_or(0), "remoteBytes":0, "rangeRequests":0}),
        }
    }
}
#[derive(Clone, Copy)]
struct TransferBudget { header: Duration, idle: Duration }
impl Default for TransferBudget {
    // Five minutes with no accepted body bytes is an idle reader, not a
    // five-minute movie limit. The original two-hour capability lifetime,
    // eight sockets, four remote sessions and upstream deadlines remain.
    fn default() -> Self { Self {header: Duration::from_secs(5), idle: Duration::from_secs(300)} }
}
struct Server { port: u16, leases: Mutex<HashMap<String, Arc<Lease>>>, budget: TransferBudget }
static SERVER: OnceCell<Arc<Server>> = OnceCell::const_new();
mod stream;
mod player;
pub(super) use player::{play, supported};

pub(super) async fn issue_stream(source: super::Source, state: crate::SharedState, id: String, cancelled: Arc<AtomicBool>) -> Result<serde_json::Value, String> {
    source.check(&state)?;
    let client = source.gateway.media_client_req()?;
    let url = format!("{}/v1/assets/{id}/file", source.gateway.base_url());
    let authorization = source.gateway.ws_authorization().parse().map_err(|_| "MEDIA_UNAVAILABLE")?;
    let source = Arc::new(source);
    let response_source = source.clone();
    issue_remote(stream::Authority {client, url, authorization,
        response_check: Arc::new(move |response| match response {
            Some(response) => response_source.gateway.check_scope_response(response),
            None => { response_source.gateway.retire_scope_proof(); Err("MEDIA_OFFLINE".into()) }
        }),
        check: Arc::new(move || {
        if cancelled.load(Ordering::Acquire) { return Err("CONTENT_CANCELLED".into()); }
        source.check(&state)
    })}).await
}

async fn issue_remote(authority: stream::Authority) -> Result<serde_json::Value, String> {
    // Prune before acquiring a remote slot, including expired/disconnected
    // leases, so they cannot retain slots or a previous owner's cache.
    let server = server().await?;
    server.leases.lock().await.retain(|_, lease| {let keep = lease.check().is_ok(); if !keep {lease.stop();} keep});
    let remote = stream::Remote::open(authority).await?;
    let mut grant = register(MediaSource::Remote(remote.clone()), remote.metadata.mime.clone()).await?;
    grant["sizeBytes"] = remote.metadata.len.into(); grant["mime"] = remote.metadata.mime.clone().into(); grant["etag"] = remote.metadata.etag.clone().into();
    Ok(grant)
}

async fn server() -> Result<&'static Arc<Server>, String> {
    SERVER.get_or_try_init(|| async {
        let (server, task) = bind_server(TransferBudget::default()).await?;
        drop(task); // the listener has the same lifetime as the app runtime
        Ok::<_, String>(server)
    }).await
}

async fn bind_server(budget: TransferBudget) -> Result<(Arc<Server>, tokio::task::JoinHandle<()>), String> {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await.map_err(|_| "MEDIA_UNAVAILABLE")?;
        let server = Arc::new(Server { port: listener.local_addr().map_err(|_| "MEDIA_UNAVAILABLE")?.port(), leases: Mutex::new(HashMap::new()), budget });
        let state = server.clone();
        let task = tokio::spawn(async move {
            let slots = Arc::new(Semaphore::new(8));
            while let Ok((socket, peer)) = listener.accept().await {
                if !peer.ip().is_loopback() { continue; }
                let Ok(permit) = slots.clone().try_acquire_owned() else { continue };
                let state = state.clone();
                // A progressive body may legitimately live longer than five
                // minutes. Header, per-write idle and capability/source fences
                // bound its resources; healthy progress is not a timeout.
                tokio::spawn(async move { let _permit = permit; let _ = serve(socket, state).await; });
            }
        });
        Ok((server, task))
}

pub(super) async fn issue(path: PathBuf, mime: String) -> Result<serde_json::Value, String> {
    if !mime.starts_with("video/") && !mime.starts_with("audio/") { return Err("MEDIA_TYPE_UNSUPPORTED".into()); }
    if mime.contains(['\r','\n']) { return Err("MEDIA_TYPE_UNSUPPORTED".into()); }
    register(MediaSource::Cached(path), mime).await
}

pub(super) async fn issue_scoped(path: PathBuf, mime: String, source: super::Source, state: crate::SharedState) -> Result<serde_json::Value, String> {
    if !mime.starts_with("video/") && !mime.starts_with("audio/") { return Err("MEDIA_TYPE_UNSUPPORTED".into()); }
    if mime.contains(['\r','\n']) { return Err("MEDIA_TYPE_UNSUPPORTED".into()); }
    let server = server().await?;
    source.check(&state)?;
    let mut leases = server.leases.lock().await;
    leases.retain(|_, lease| { let keep = lease.check().is_ok(); if !keep { lease.stop(); } keep });
    if leases.len() >= 64 { return Err("MEDIA_BUSY".into()); }
    let token = uuid::Uuid::new_v4().simple().to_string();
    leases.insert(token.clone(), Arc::new(Lease { source: MediaSource::Cached(path), mime,
        expires: Instant::now() + Duration::from_secs(7200), live: AtomicBool::new(true),
        scope: Some(Box::new(move || source.check(&state))) }));
    Ok(serde_json::json!({"token":token,"url":format!("http://127.0.0.1:{}/media/{token}",server.port)}))
}

async fn register(source: MediaSource, mime: String) -> Result<serde_json::Value, String> {
    let server = server().await?;
    register_on(server, source, mime).await
}

async fn register_on(server: &Arc<Server>, source: MediaSource, mime: String) -> Result<serde_json::Value, String> {
    let mut leases = server.leases.lock().await;
    leases.retain(|_, lease| { let keep = lease.check().is_ok(); if !keep { lease.stop(); } keep });
    if leases.len() >= 64 { return Err("MEDIA_BUSY".into()); }
    let token = uuid::Uuid::new_v4().simple().to_string();
    leases.insert(token.clone(), Arc::new(Lease { source, mime, expires: Instant::now() + Duration::from_secs(7200), live: AtomicBool::new(true), scope: None }));
    Ok(serde_json::json!({"token":token,"url":format!("http://127.0.0.1:{}/media/{token}",server.port)}))
}

pub(super) async fn release(token: &str) {
    if let Some(server) = SERVER.get() {
        if let Some(lease) = server.leases.lock().await.remove(token) { lease.stop(); }
    }
}

pub(super) async fn prune_retired() {
    if let Some(server) = SERVER.get() {
        let mut leases = server.leases.lock().await;
        leases.retain(|_, lease| { let keep = lease.check().is_ok(); if !keep { lease.stop(); } keep });
    }
}

fn range(value: Option<&str>, len: u64) -> Result<(u64,u64,bool), ()> {
    let Some(value) = value else { return Ok((0,len,false)); };
    if len == 0 { return Err(()); }
    let (start,end) = value.strip_prefix("bytes=").ok_or(())?.split_once('-').ok_or(())?;
    if end.contains('-') || value.contains(',') { return Err(()); }
    let number = |s: &str| if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) { s.parse::<u64>().map_err(|_| ()) } else { Err(()) };
    let (start,end) = if start.is_empty() { let count = number(end)?; if count == 0 { return Err(()); } (len.saturating_sub(count),len-1) }
        else { let start=number(start)?; (start,if end.is_empty() {len-1} else {number(end)?.min(len-1)}) };
    if start >= len || start > end { return Err(()); }
    Ok((start,end-start+1,true))
}

async fn reject(socket: &mut TcpStream, status: &str, extra: &str) -> std::io::Result<()> {
    tokio::time::timeout(TransferBudget::default().header, socket.write_all(format!("HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: 0\r\n{extra}\r\n").as_bytes())).await?
}

async fn write_body(socket: &mut TcpStream, mut bytes: &[u8], lease: &Lease, idle: Duration) -> std::io::Result<()> {
    let check = || lease.check();
    while !bytes.is_empty() {
        // Use write, not write_all: every positive socket write resets the
        // idle budget, including partial progress within a 64KiB chunk.
        let n = super::cancellable(tokio::time::timeout(idle, socket.write(bytes)), &check).await
            .map_err(|_| std::io::ErrorKind::ConnectionAborted)???;
        if n == 0 { return Err(std::io::ErrorKind::WriteZero.into()); }
        bytes = &bytes[n..];
    }
    Ok(())
}

async fn write_head(socket: &mut TcpStream, bytes: &[u8], lease: &Lease, deadline: Duration) -> std::io::Result<()> {
    let check = || lease.check();
    super::cancellable(tokio::time::timeout(deadline, socket.write_all(bytes)), &check).await
        .map_err(|_| std::io::ErrorKind::ConnectionAborted)???;
    Ok(())
}

async fn serve(mut socket: TcpStream, server: Arc<Server>) -> std::io::Result<()> {
    let request = tokio::time::timeout(server.budget.header, async {
        let mut bytes = Vec::new(); let mut chunk=[0;1024];
        loop {
            let n=socket.read(&mut chunk).await?;
            if n==0 || bytes.len()+n > 8192 { return Err(std::io::ErrorKind::InvalidData.into()); }
            bytes.extend_from_slice(&chunk[..n]);
            if bytes.windows(4).any(|w| w==b"\r\n\r\n") { return Ok::<_,std::io::Error>(bytes); }
        }
    }).await;
    let Ok(Ok(bytes))=request else { return reject(&mut socket,"400 Bad Request","").await; };
    let Ok(text)=std::str::from_utf8(&bytes) else { return reject(&mut socket,"400 Bad Request","").await; };
    let mut lines=text.split("\r\n"); let first=lines.next().unwrap_or("").split_whitespace().collect::<Vec<_>>();
    if first.len()!=3 || !matches!(first[0],"GET"|"HEAD") || first[2]!="HTTP/1.1" { return reject(&mut socket,"405 Method Not Allowed","").await; }
    let token=first[1].strip_prefix("/media/").unwrap_or("");
    if token.len()!=32 || !token.bytes().all(|b| b.is_ascii_hexdigit()) { return reject(&mut socket,"404 Not Found","").await; }
    let mut headers=HashMap::new();
    for line in lines.take_while(|line| !line.is_empty()) {
        let Some((key,value))=line.split_once(':') else { return reject(&mut socket,"400 Bad Request","").await; };
        if headers.insert(key.to_ascii_lowercase(),value.trim()).is_some() { return reject(&mut socket,"400 Bad Request","").await; }
    }
    if headers.get("host")!=Some(&format!("127.0.0.1:{}",server.port).as_str()) || headers.contains_key("transfer-encoding") || headers.get("content-length").is_some_and(|v| *v!="0") {
        return reject(&mut socket,"400 Bad Request","").await;
    }
    if headers.get("origin").is_some_and(|v| !matches!(*v,"http://tauri.localhost"|"https://tauri.localhost"|"http://localhost:1420")) { return reject(&mut socket,"403 Forbidden","").await; }
    let lease=server.leases.lock().await.get(token).cloned();
    let Some(lease)=lease.filter(|l| l.check().is_ok()) else { return reject(&mut socket,"404 Not Found","").await; };
    if let MediaSource::Remote(remote) = &lease.source { return serve_remote(socket, lease.clone(), remote.clone(), first[0], &headers, server.budget).await; }
    let MediaSource::Cached(path) = &lease.source else { unreachable!() };
    let Ok(mut file)=tokio::fs::File::open(path).await else { return reject(&mut socket,"404 Not Found","").await; };
    let metadata=file.metadata().await?; let len=metadata.len();
    if !metadata.is_file() { return reject(&mut socket,"404 Not Found","").await; }
    let Ok((start,count,partial))=range(headers.get("range").copied(),len) else { return reject(&mut socket,"416 Range Not Satisfiable",&format!("Content-Range: bytes */{len}\r\n")).await; };
    let status=if partial {"206 Partial Content"} else {"200 OK"};
    let extra=if partial {format!("Content-Range: bytes {start}-{}/{len}\r\n",start+count-1)} else {String::new()};
    write_head(&mut socket, format!("HTTP/1.1 {status}\r\nContent-Type: {}\r\nContent-Length: {count}\r\nAccept-Ranges: bytes\r\nCache-Control: no-store\r\nConnection: close\r\n{extra}\r\n",lease.mime).as_bytes(), &lease, server.budget.header).await?;
    if first[0]=="HEAD" { return Ok(()); }
    file.seek(std::io::SeekFrom::Start(start)).await?;
    let mut left=count; let mut buffer=[0;65536];
    while left>0 && lease.check().is_ok() {
        let n=file.read(&mut buffer[..left.min(65536) as usize]).await?; if n==0 { break; }
        write_body(&mut socket, &buffer[..n], &lease, server.budget.idle).await?; left-=n as u64;
    }
    Ok(())
}

pub(super) async fn snapshot(token: &str) -> Result<serde_json::Value, String> {
    let lease = server().await?.leases.lock().await.get(token).cloned().ok_or("MEDIA_EXPIRED")?;
    lease.check()?;
    Ok(lease.metrics())
}

async fn serve_remote(mut socket: TcpStream, lease: Arc<Lease>, remote: Arc<stream::Remote>, method: &str, headers: &HashMap<String, &str>, budget: TransferBudget) -> std::io::Result<()> {
    let meta = &remote.metadata;
    if headers.get("if-range").is_some_and(|v| *v != meta.etag) { return reject(&mut socket, "412 Precondition Failed", "").await; }
    let Ok((start, count, partial)) = range(headers.get("range").copied(), meta.len) else { return reject(&mut socket, "416 Range Not Satisfiable", &format!("Content-Range: bytes */{}\r\n", meta.len)).await; };
    let mut block = if method == "GET" {
        match remote.block(start).await { Ok(b) => Some(b), Err(_) => return reject(&mut socket, "502 Bad Gateway", "").await }
    } else { None };
    if lease.check().is_err() { return reject(&mut socket, "410 Gone", "").await; }
    let status = if partial {"206 Partial Content"} else {"200 OK"};
    let extra = if partial {format!("Content-Range: bytes {start}-{}/{}\r\n", start + count - 1, meta.len)} else {String::new()};
    write_head(&mut socket, format!("HTTP/1.1 {status}\r\nContent-Type: {}\r\nContent-Length: {count}\r\nAccept-Ranges: bytes\r\nETag: {}\r\nCache-Control: no-store\r\nConnection: close\r\n{extra}\r\n", meta.mime, meta.etag).as_bytes(), &lease, budget.header).await?;
    if method == "HEAD" { return Ok(()); }
    let mut at = start; let end = start + count;
    while at < end {
        if lease.check().is_err() { break; }
        let base = at / stream::BLOCK_BYTES * stream::BLOCK_BYTES;
        let bytes = match block.take() {Some(b) => b, None => remote.block(at).await.map_err(|_| std::io::ErrorKind::ConnectionAborted)?};
        let mut pos = (at - base) as usize;
        while pos < bytes.len() && at < end {
            let n = (bytes.len() - pos).min((end - at).min(65536) as usize);
            // Back-pressure: never fetch the next LAN block until this one was
            // consumed. Explicit release/source epoch cancels a blocked write.
            write_body(&mut socket, &bytes[pos..pos+n], &lease, budget.idle).await?;
            pos += n; at += n as u64;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU8, AtomicU64};
    // The process-wide loopback server has the same runtime lifetime as the
    // app. Separate #[tokio::test] runtimes would destroy the listener after
    // the first test while retaining its OnceCell address for the others.
    fn runtime() -> &'static tokio::runtime::Runtime {
        static RUNTIME: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();
        RUNTIME.get_or_init(|| tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap())
    }
    fn run(future: impl std::future::Future<Output = ()>) {
        // These tests deliberately share the real app-lifetime server and
        // its four-remote-session limit. Five simultaneous fixture cases are
        // not five independent apps: isolate cases without relaxing the cap.
        static CASES: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _case = CASES.lock().unwrap_or_else(|poison|poison.into_inner());
        runtime().block_on(future);
    }

    struct RemoteFixture {
        url: String,
        requests: Arc<Mutex<Vec<(u64, u64)>>>,
        fault: Arc<AtomicU8>,
        delay_ms: Arc<AtomicU64>,
        task: tokio::task::JoinHandle<()>,
    }
    impl Drop for RemoteFixture { fn drop(&mut self) { self.task.abort(); } }
    async fn remote_fixture(len: u64) -> RemoteFixture {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let url = format!("http://127.0.0.1:{}/v1/assets/synthetic/file", listener.local_addr().unwrap().port());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = requests.clone();
        let fault = Arc::new(AtomicU8::new(0)); let behavior = fault.clone();
        let delay_ms = Arc::new(AtomicU64::new(0)); let delay = delay_ms.clone();
        let task = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let seen = seen.clone();
                let behavior = behavior.clone();
                let delay = delay.clone();
                tokio::spawn(async move {
                    let mut bytes = Vec::new(); let mut buf = [0; 1024];
                    while !bytes.windows(4).any(|b| b == b"\r\n\r\n") {
                        let n = socket.read(&mut buf).await.unwrap(); if n == 0 { return; }
                        bytes.extend_from_slice(&buf[..n]); assert!(bytes.len() < 8192);
                    }
                    let text = String::from_utf8(bytes).unwrap();
                    assert!(text.starts_with("GET /v1/assets/synthetic/file HTTP/1.1\r\n"));
                    let headers = text.lines().skip(1).filter_map(|line| line.split_once(':')).map(|(k,v)| (k.to_ascii_lowercase(), v.trim().to_string())).collect::<HashMap<_,_>>();
                    assert_eq!(headers.get("authorization").map(String::as_str), Some("Bearer synthetic-only"));
                    let (start, count, _) = range(headers.get("range").map(String::as_str), len).unwrap();
                    let end = start + count - 1;
                    seen.lock().await.push((start, end));
                    let wait = delay.load(Ordering::Acquire);
                    if wait > 0 { tokio::time::sleep(Duration::from_millis(wait)).await; }
                    while behavior.load(Ordering::Acquire) == 11 {tokio::time::sleep(Duration::from_millis(25)).await;}
                    let fault = behavior.load(Ordering::Acquire);
                    let status = match fault {1|12 => "200 OK", 8 => "416 Range Not Satisfiable", 9 => "403 Forbidden", _ => "206 Partial Content"};
                    let total = if fault == 3 {"*".to_string()} else {len.to_string()};
                    let first = if fault == 4 {start+1} else {start};
                    let length = if matches!(fault, 1|12) {len} else if fault == 5 {count+1} else {count};
                    let etag = if fault == 2 {"\"synthetic-v2\""} else if fault == 7 {"W/\"synthetic-v1\""} else {"\"synthetic-v1\""};
                    let encoding = if fault == 6 {"Content-Encoding: gzip\r\n"} else {""};
                    let head = format!("HTTP/1.1 {status}\r\nContent-Type: video/mp4\r\nContent-Length: {length}\r\nContent-Range: bytes {first}-{end}/{total}\r\nETag: {etag}\r\n{encoding}Connection: close\r\n\r\n");
                    if socket.write_all(head.as_bytes()).await.is_err() { return; }
                    let mut at = start;
                    while at <= end {
                        if fault == 10 && at >= start + count/2 {return;}
                        let size = (end - at + 1).min(65536) as usize;
                        let body = (at..at + size as u64).map(|n| (n % 251) as u8).collect::<Vec<_>>();
                        if socket.write_all(&body).await.is_err() { return; } at += size as u64;
                    }
                });
            }
        });
        RemoteFixture {url, requests, fault, delay_ms, task}
    }
    fn remote_authority(fixture: &RemoteFixture, epoch: &Arc<AtomicU64>) -> stream::Authority {
        let live = epoch.clone();
        stream::Authority {
            client: reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap(),
            url: fixture.url.clone(), authorization: "Bearer synthetic-only".parse().unwrap(),
            response_check: Arc::new(|_| Ok(())),
            check: Arc::new(move || if live.load(Ordering::Acquire) == 7 {Ok(())} else {Err("CONTENT_SOURCE_CHANGED".into())}),
        }
    }

    struct TimedServer { state: Arc<Server>, task: tokio::task::JoinHandle<()> }
    impl Drop for TimedServer {
        fn drop(&mut self) {
            self.task.abort();
            if let Ok(mut leases) = self.state.leases.try_lock() { for (_, lease) in leases.drain() {lease.stop();} }
        }
    }
    async fn timed_server(budget: TransferBudget) -> TimedServer {
        let (state, task) = bind_server(budget).await.unwrap();
        TimedServer {state, task}
    }

    #[test]
    fn healthy_open_ended_remote_stream_survives_the_former_absolute_deadline() { run(async {
        let former_deadline = Duration::from_millis(100);
        let server = timed_server(TransferBudget {header: Duration::from_secs(1), idle: former_deadline}).await;
        let len = 20 * 1024 * 1024u64;
        let fixture = remote_fixture(len).await;
        let epoch = Arc::new(AtomicU64::new(7));
        let remote = stream::Remote::open(remote_authority(&fixture, &epoch)).await.unwrap();
        let grant = register_on(&server.state, MediaSource::Remote(remote), "video/mp4".into()).await.unwrap();
        fixture.delay_ms.store(45, Ordering::Release);
        let started = Instant::now();
        let response = reqwest::Client::new().get(grant["url"].as_str().unwrap()).header("Range", "bytes=0-").send().await.unwrap();
        assert_eq!(response.status(), 206);
        let body = response.bytes().await.expect("healthy open-ended body must not truncate at a wall-clock lifetime deadline");
        assert!(started.elapsed() > former_deadline * 2, "controlled real upstream makes the stream outlive the old deadline");
        assert_eq!(body.len() as u64, len);
        assert!(body.iter().enumerate().all(|(at, byte)| *byte == (at % 251) as u8));
        assert_eq!(fixture.requests.lock().await.len(), 5);
    }); }

    #[test]
    fn paused_remote_reader_resumes_past_the_former_blocked_write_timeout() { run(async {
        let old_write = Duration::from_millis(35);
        let pause = Duration::from_millis(150);
        let server = timed_server(TransferBudget {header: Duration::from_secs(1), idle: Duration::from_secs(1)}).await;
        let len = 32 * 1024 * 1024u64;
        let fixture = remote_fixture(len).await;
        let epoch = Arc::new(AtomicU64::new(7));
        let remote = stream::Remote::open(remote_authority(&fixture, &epoch)).await.unwrap();
        let grant = register_on(&server.state, MediaSource::Remote(remote), "video/mp4".into()).await.unwrap();
        let response = reqwest::Client::new().get(grant["url"].as_str().unwrap()).header("Range", "bytes=0-").send().await.unwrap();
        assert_eq!(response.status(), 206);
        let requests = fixture.requests.lock().await.len();
        tokio::time::sleep(pause).await; // external player stops polling its HTTP body
        let at_pause = fixture.requests.lock().await.len();
        assert!(at_pause < 8, "a paused reader backpressures upstream rather than downloading the whole video");
        assert!(at_pause >= requests);
        let body = response.bytes().await.expect("a legitimate pause beyond the old write deadline must resume the same response/version");
        assert_eq!(body.len() as u64, len);
        assert!(body.iter().enumerate().all(|(at, byte)| *byte == (at % 251) as u8));
        assert!(pause > old_write * 3);
    }); }

    #[test]
    fn paused_complete_cache_reader_resumes_without_truncating_or_remote_work() { run(async {
        let server = timed_server(TransferBudget {header: Duration::from_secs(1), idle: Duration::from_secs(1)}).await;
        let path = std::env::temp_dir().join(format!("lr-media-pause-{}.mp4", uuid::Uuid::new_v4()));
        struct OwnedFile(PathBuf);
        impl Drop for OwnedFile {fn drop(&mut self) {let _ = std::fs::remove_file(&self.0);}}
        let file = OwnedFile(path);
        let expected = (0..32 * 1024 * 1024usize).map(|n| (n % 251) as u8).collect::<Vec<_>>();
        tokio::fs::write(&file.0, &expected).await.unwrap();
        let grant = register_on(&server.state, MediaSource::Cached(file.0.clone()), "video/mp4".into()).await.unwrap();
        let response = reqwest::Client::new().get(grant["url"].as_str().unwrap()).header("Range", "bytes=0-").send().await.unwrap();
        assert_eq!(response.status(), 206);
        tokio::time::sleep(Duration::from_millis(150)).await;
        let body = response.bytes().await.expect("a complete cache has the same pause-safe local transport as a remote stream");
        assert_eq!(&body[..], &expected);
        let receipt = server.state.leases.lock().await.get(grant["token"].as_str().unwrap()).unwrap().metrics();
        assert_eq!(receipt["transport"], "cache"); assert_eq!(receipt["remoteBytes"], 0);
    }); }

    #[test]
    fn reader_with_no_progress_still_expires_and_stops_upstream_work() { run(async {
        let server = timed_server(TransferBudget {header: Duration::from_secs(1), idle: Duration::from_millis(100)}).await;
        let fixture = remote_fixture(32 * 1024 * 1024).await;
        let epoch = Arc::new(AtomicU64::new(7));
        let remote = stream::Remote::open(remote_authority(&fixture, &epoch)).await.unwrap();
        let grant = register_on(&server.state, MediaSource::Remote(remote), "video/mp4".into()).await.unwrap();
        let response = reqwest::Client::new().get(grant["url"].as_str().unwrap()).header("Range", "bytes=0-").send().await.unwrap();
        assert_eq!(response.status(), 206);
        tokio::time::sleep(Duration::from_millis(500)).await;
        let reads = fixture.requests.lock().await.len();
        assert!(reads < 8, "idle playback cannot consume the whole source");
        assert!(tokio::time::timeout(Duration::from_secs(1), response.bytes()).await.unwrap().is_err(), "true blocked-write idle budget still closes the response");
        tokio::time::sleep(Duration::from_millis(120)).await;
        assert_eq!(fixture.requests.lock().await.len(), reads, "closing an idle socket cannot trigger further remote blocks");
    }); }

    #[test]
    fn source_epoch_cancels_a_backpressured_local_body_without_waiting_for_idle() { run(async {
        let server = timed_server(TransferBudget {header: Duration::from_secs(1), idle: Duration::from_secs(30)}).await;
        let fixture = remote_fixture(32 * 1024 * 1024).await;
        let epoch = Arc::new(AtomicU64::new(7));
        let remote = stream::Remote::open(remote_authority(&fixture, &epoch)).await.unwrap();
        let grant = register_on(&server.state, MediaSource::Remote(remote), "video/mp4".into()).await.unwrap();
        let url = grant["url"].as_str().unwrap();
        let response = reqwest::Client::new().get(url).header("Range", "bytes=0-").send().await.unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        let reads = fixture.requests.lock().await.len(); assert!(reads < 8);
        let started = Instant::now(); epoch.store(8, Ordering::Release);
        assert!(tokio::time::timeout(Duration::from_millis(500), response.bytes()).await.unwrap().is_err());
        assert!(started.elapsed() < Duration::from_millis(500));
        assert_eq!(reqwest::Client::new().get(url).send().await.unwrap().status(), 404);
        tokio::time::sleep(Duration::from_millis(120)).await;
        assert_eq!(fixture.requests.lock().await.len(), reads, "source change wins over a blocked local write and all future reads");
    }); }

    #[test]
    fn incomplete_request_headers_keep_a_finite_deadline() { run(async {
        let deadline = Duration::from_millis(50);
        let server = timed_server(TransferBudget {header: deadline, idle: Duration::from_secs(300)}).await;
        let mut socket = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, server.state.port)).await.unwrap();
        let started = Instant::now();
        socket.write_all(b"GET /media/incomplete HTTP/1.1\r\n").await.unwrap();
        let mut bytes = Vec::new();
        tokio::time::timeout(Duration::from_millis(500), socket.read_to_end(&mut bytes)).await.unwrap().unwrap();
        assert!(started.elapsed() >= deadline);
        assert!(bytes.starts_with(b"HTTP/1.1 400 Bad Request\r\n"));
    }); }

    #[test]
    fn remote_authorization_failure_retains_a_truthful_recoverable_reason() { run(async {
        let fixture = remote_fixture(32 * 1024 * 1024).await;
        let epoch = Arc::new(AtomicU64::new(7));
        let grant = issue_remote(remote_authority(&fixture, &epoch)).await.unwrap();
        fixture.fault.store(9, Ordering::Release);
        let response = reqwest::Client::new().get(grant["url"].as_str().unwrap()).header("Range", "bytes=8388608-8388671").send().await.unwrap();
        assert_eq!(response.status(), 502);
        assert_eq!(snapshot(grant["token"].as_str().unwrap()).await.unwrap_err(), "MEDIA_RANGE_HTTP_403", "a withdrawn read grant is not a generic expired/network message");
        release(grant["token"].as_str().unwrap()).await;
    }); }

    #[test]
    fn remote_large_asset_first_range_tail_seek_and_head_do_not_download_full_file() { run(async {
        let len = 5 * 1024 * 1024 * 1024u64 + 117;
        let fixture = remote_fixture(len).await;
        let epoch = Arc::new(AtomicU64::new(7));
        let live = epoch.clone();
        let grant = issue_remote(stream::Authority {
            client: reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap(),
            url: fixture.url.clone(), authorization: "Bearer synthetic-only".parse().unwrap(),
            response_check: Arc::new(|_| Ok(())),
            check: Arc::new(move || if live.load(Ordering::Acquire) == 7 {Ok(())} else {Err("CONTENT_SOURCE_CHANGED".into())}),
        }).await.unwrap();
        let url = grant["url"].as_str().unwrap(); let client = reqwest::Client::new();
        let response = client.get(url).header("Range", "bytes=0-65535").send().await.unwrap();
        assert_eq!(response.status(), 206);
        assert_eq!(&response.bytes().await.unwrap()[..], &(0..65536).map(|n| (n % 251) as u8).collect::<Vec<_>>());
        let response = client.get(url).header("Range", "bytes=-96").send().await.unwrap();
        assert_eq!(response.status(), 206);
        assert_eq!(&response.bytes().await.unwrap()[..], &(len-96..len).map(|n| (n % 251) as u8).collect::<Vec<_>>());
        let response = client.head(url).send().await.unwrap();
        assert_eq!(response.headers()["content-length"], len.to_string());
        assert!(response.bytes().await.unwrap().is_empty());
        let reads = fixture.requests.lock().await.clone();
        assert_eq!(reads.len(), 2, "reuse the first bounded block; one new tail block only");
        assert!(reads.iter().map(|(a,b)| b-a+1).sum::<u64>() <= 8*1024*1024, "not a 5GB full download");
        assert!(reads.iter().all(|(a,b)| b-a+1 <= 4*1024*1024));
        release(grant["token"].as_str().unwrap()).await;
    }); }

    #[test]
    fn remote_never_publishes_ignored_ranges_unknown_length_weak_version_or_invalid_bytes() { run(async {
        for fault in [1, 3, 4, 5, 6, 7, 8, 9, 10] {
            let fixture = remote_fixture(5 * 1024 * 1024 * 1024u64).await;
            fixture.fault.store(fault, Ordering::Release);
            let epoch = Arc::new(AtomicU64::new(7));
            let result = issue_remote(remote_authority(&fixture, &epoch)).await;
            assert!(result.is_err(), "fault{fault}: no usable loopback capability may be published");
            assert_eq!(fixture.requests.lock().await.len(), 1, "no full-file fallback/retry storm");
        }
    }); }

    #[test]
    fn remote_version_change_source_epoch_and_release_refuse_cached_and_future_bytes() { run(async {
        let fixture = remote_fixture(40 * 1024 * 1024).await;
        let epoch = Arc::new(AtomicU64::new(7)); let client = reqwest::Client::new();
        for fault in [2, 12] {
            fixture.fault.store(0, Ordering::Release);
            let grant = issue_remote(remote_authority(&fixture, &epoch)).await.unwrap();
            let url = grant["url"].as_str().unwrap();
            fixture.fault.store(fault, Ordering::Release);
            let response = client.get(url).header("Range", "bytes=8388608-8388703").send().await.unwrap();
            assert_eq!(response.status(), 502);
            assert!(response.bytes().await.unwrap().is_empty(), "no bytes from a new/unknown version");
            assert_eq!(client.head(url).send().await.unwrap().status(), 404, "poisoned version cannot serve cached old blocks");
            release(grant["token"].as_str().unwrap()).await;
        }
        fixture.fault.store(0, Ordering::Release);
        let grant = issue_remote(remote_authority(&fixture, &epoch)).await.unwrap();
        let url = grant["url"].as_str().unwrap();
        let before = fixture.requests.lock().await.len();
        epoch.store(8, Ordering::Release);
        assert_eq!(client.get(url).header("Range", "bytes=0-96").send().await.unwrap().status(), 404, "even a cache hit must prove the captured epoch");
        assert_eq!(fixture.requests.lock().await.len(), before, "no moved-owner wire request");
        release(grant["token"].as_str().unwrap()).await;
        assert_eq!(client.head(url).send().await.unwrap().status(), 404);
    }); }

    #[test]
    fn remote_seek_cache_is_bounded_and_blocked_fetch_cancels_on_exit() { run(async {
        let fixture = remote_fixture(40 * 1024 * 1024).await;
        let epoch = Arc::new(AtomicU64::new(7)); let client = reqwest::Client::new();
        let grant = issue_remote(remote_authority(&fixture, &epoch)).await.unwrap();
        let url = grant["url"].as_str().unwrap(); let token = grant["token"].as_str().unwrap();
        for offset in [4,8,12,16,20].map(|n| n*1024*1024u64) {
            let response = client.get(url).header("Range", format!("bytes={offset}-{}", offset+95)).send().await.unwrap();
            assert_eq!(response.status(), 206); assert_eq!(response.bytes().await.unwrap().len(), 96);
            let stats = snapshot(token).await.unwrap();
            assert!(stats["cacheBytes"].as_u64().unwrap() <= 12*1024*1024);
            assert_eq!(stats["completeOffline"], false, "bounded streaming cache is not an offline complete original");
        }
        fixture.fault.store(11, Ordering::Release);
        let reads = fixture.requests.lock().await.len();
        let pending = tokio::spawn({let client = client.clone(); let url = url.to_string(); async move {client.get(url).header("Range", "bytes=29360128-29360223").send().await.unwrap()}});
        tokio::time::timeout(Duration::from_secs(2), async {while fixture.requests.lock().await.len() == reads {tokio::task::yield_now().await;}}).await.unwrap();
        release(token).await;
        let response = tokio::time::timeout(Duration::from_millis(500), pending).await.unwrap().unwrap();
        assert_eq!(response.status(), 502);
        assert!(response.bytes().await.unwrap().is_empty());
        fixture.fault.store(0, Ordering::Release);
        assert_eq!(client.head(url).send().await.unwrap().status(), 404);
        assert_eq!(fixture.requests.lock().await.len(), reads+1, "no subsequent background fetch after exit");
    }); }
    #[test]
    fn exact_cache_lease_ranges_head_revoke_and_path_denial() { run(async {
        let path=std::env::temp_dir().join(format!("lr-media-{}.mp4",uuid::Uuid::new_v4()));
        let body=(0..200_000).map(|n| (n%251) as u8).collect::<Vec<_>>(); tokio::fs::write(&path,&body).await.unwrap();
        let grant=issue(path.clone(),"video/mp4".into()).await.unwrap(); let url=grant["url"].as_str().unwrap();
        let client=reqwest::Client::new();
        let response=client.get(url).header("Range","bytes=65400-132000").send().await.unwrap();
        assert_eq!(response.status(),206); assert_eq!(response.headers()["content-range"],"bytes 65400-132000/200000"); assert_eq!(&response.bytes().await.unwrap()[..],&body[65400..132001]);
        let response=client.get(url).header("Range","bytes=-50").send().await.unwrap(); assert_eq!(&response.bytes().await.unwrap()[..],&body[199950..]);
        let response=client.head(url).send().await.unwrap(); assert_eq!(response.headers()["content-length"],"200000"); assert!(response.bytes().await.unwrap().is_empty());
        assert_eq!(client.get(url).header("Range","bytes=200000-").send().await.unwrap().status(),416);
        assert_eq!(client.get(url).header("Origin","https://untrusted.example").send().await.unwrap().status(),403);
        assert_eq!(client.get(format!("{url}/../file")).send().await.unwrap().status(),404);
        release(grant["token"].as_str().unwrap()).await; assert_eq!(client.get(url).send().await.unwrap().status(),404);
        tokio::fs::remove_file(path).await.unwrap();
    }); }
}
