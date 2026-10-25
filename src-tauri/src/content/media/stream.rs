//! Native-only paired asset Range authority. URLs/credentials never come from JS.
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex as SyncMutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};

// One request is big enough not to turn extraction/seeking into tiny LAN
// requests. Three owner+asset+version-scoped blocks, no persistent partial file.
pub(super) const BLOCK_BYTES: u64 = 4 * 1024 * 1024;
const CACHE_BLOCKS: usize = 3;
static SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
pub(super) struct Authority {
    pub(super) client: reqwest::Client,
    pub(super) url: String,
    pub(super) authorization: reqwest::header::HeaderValue,
    pub(super) check: Arc<dyn Fn() -> Result<(), String> + Send + Sync>,
    pub(super) response_check: Arc<dyn Fn(Option<&reqwest::Response>) -> Result<(), String> + Send + Sync>,
}

#[derive(Clone)]
pub(super) struct Metadata {
    pub(super) len: u64,
    pub(super) mime: String,
    pub(super) etag: String,
}
#[derive(Default)]
pub(super) struct Metrics {
    pub(super) bytes: AtomicU64,
    pub(super) requests: AtomicU64,
    pub(super) cache_bytes: AtomicU64,
}
type Blocks = VecDeque<(u64, Arc<Vec<u8>>)>;
pub(super) struct Remote {
    authority: Authority,
    pub(super) metadata: Metadata,
    pub(super) metrics: Arc<Metrics>,
    blocks: Mutex<Blocks>,
    alive: AtomicBool,
    failure: SyncMutex<Option<String>>,
    expires: Instant,
    _slot: OwnedSemaphorePermit,
}

impl Remote {
    pub(super) async fn open(authority: Authority) -> Result<Arc<Self>, String> {
        let slot = SLOTS
            .get_or_init(|| Arc::new(Semaphore::new(4)))
            .clone()
            .try_acquire_owned()
            .map_err(|_| "MEDIA_BUSY")?;
        let metrics = Arc::new(Metrics::default());
        let (metadata, first) =
            fetch(&authority, 0, None, &metrics, &|| (authority.check)()).await?;
        metrics
            .cache_bytes
            .store(first.len() as u64, Ordering::Release);
        Ok(Arc::new(Self {
            authority,
            metadata,
            metrics,
            blocks: Mutex::new(VecDeque::from([(0, Arc::new(first))])),
            alive: AtomicBool::new(true),
            failure: SyncMutex::new(None),
            expires: Instant::now() + Duration::from_secs(7200),
            _slot: slot,
        }))
    }
    pub(super) fn check(&self) -> Result<(), String> {
        if !self.alive.load(Ordering::Acquire) || self.expires <= Instant::now() {
            return Err(self
                .failure
                .lock()
                .ok()
                .and_then(|f| f.clone())
                .unwrap_or_else(|| "MEDIA_EXPIRED".into()));
        }
        (self.authority.check)()
    }
    pub(super) fn stop(&self) {
        self.alive.store(false, Ordering::Release);
    }
    pub(super) async fn block(&self, offset: u64) -> Result<Arc<Vec<u8>>, String> {
        let result = self.read_block(offset).await;
        if let Err(error) = &result {
            if let Ok(mut failure) = self.failure.lock() {
                if failure.is_none() {
                    *failure = Some(error.clone());
                }
            }
            self.stop();
        }
        result
    }
    async fn read_block(&self, offset: u64) -> Result<Arc<Vec<u8>>, String> {
        self.check()?;
        if offset >= self.metadata.len {
            return Err("MEDIA_RANGE_INVALID".into());
        }
        let base = offset / BLOCK_BYTES * BLOCK_BYTES;
        let check = || self.check();
        // This single-flight cache also coalesces simultaneous small extractor
        // reads into one LAN block. Revocation cancels while waiting for it.
        let mut blocks = super::super::cancellable(self.blocks.lock(), &check).await?;
        if let Some(index) = blocks.iter().position(|(at, _)| *at == base) {
            let value = blocks.remove(index).unwrap();
            let bytes = value.1.clone();
            blocks.push_back(value);
            return Ok(bytes);
        }
        if blocks.len() >= CACHE_BLOCKS {
            blocks.pop_front();
        }
        let (_, bytes) = fetch(
            &self.authority,
            base,
            Some(&self.metadata),
            &self.metrics,
            &check,
        )
        .await?;
        let bytes = Arc::new(bytes);
        blocks.push_back((base, bytes.clone()));
        self.metrics.cache_bytes.store(
            blocks.iter().map(|(_, b)| b.len() as u64).sum(),
            Ordering::Release,
        );
        Ok(bytes)
    }
}

fn header<'a>(headers: &'a reqwest::header::HeaderMap, name: &str) -> Result<&'a str, String> {
    if headers.get_all(name).iter().count() != 1 {
        return Err("MEDIA_RESPONSE_INVALID".into());
    }
    headers
        .get(name)
        .and_then(|h| h.to_str().ok())
        .ok_or_else(|| "MEDIA_RESPONSE_INVALID".into())
}
fn metadata(headers: &reqwest::header::HeaderMap, start: u64) -> Result<(Metadata, usize), String> {
    let value = header(headers, "content-range")?
        .strip_prefix("bytes ")
        .ok_or("MEDIA_RESPONSE_INVALID")?;
    let (positions, total) = value.split_once('/').ok_or("MEDIA_RESPONSE_INVALID")?;
    let (first, last) = positions.split_once('-').ok_or("MEDIA_RESPONSE_INVALID")?;
    let number = |s: &str| -> Result<u64, String> {
        if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
            return Err("MEDIA_RESPONSE_INVALID".into());
        }
        s.parse().map_err(|_| "MEDIA_RESPONSE_INVALID".into())
    };
    let (first, last, len) = (number(first)?, number(last)?, number(total)?);
    if len == 0
        || first != start
        || first > last
        || last >= len
        || last != start.saturating_add(BLOCK_BYTES - 1).min(len - 1)
    {
        return Err("MEDIA_RESPONSE_INVALID".into());
    }
    let count = last - first + 1;
    if number(header(headers, "content-length")?)? != count || count > BLOCK_BYTES {
        return Err("MEDIA_RESPONSE_INVALID".into());
    }
    if headers
        .get("content-encoding")
        .is_some_and(|v| v != "identity")
    {
        return Err("MEDIA_RESPONSE_INVALID".into());
    }
    let etag = header(headers, "etag")?;
    if etag.len() < 2
        || etag.len() > 256
        || !etag.starts_with('"')
        || !etag.ends_with('"')
        || !etag[1..etag.len() - 1]
            .bytes()
            .all(|b| (0x21..=0x7e).contains(&b) && b != b'"')
    {
        return Err("MEDIA_VERSION_MISSING".into());
    }
    let mime = header(headers, "content-type")?;
    if mime.len() > 128
        || !(mime.starts_with("video/") || mime.starts_with("audio/"))
        || mime.contains(['\r', '\n'])
    {
        return Err("MEDIA_TYPE_UNSUPPORTED".into());
    }
    Ok((
        Metadata {
            len,
            mime: mime.to_string(),
            etag: etag.to_string(),
        },
        count as usize,
    ))
}

async fn fetch(
    authority: &Authority,
    start: u64,
    expected: Option<&Metadata>,
    metrics: &Metrics,
    check: &(impl Fn() -> Result<(), String> + Sync),
) -> Result<(Metadata, Vec<u8>), String> {
    check()?;
    let end = start.saturating_add(BLOCK_BYTES - 1);
    let mut request = authority
        .client
        .get(&authority.url)
        .header(
            reqwest::header::AUTHORIZATION,
            authority.authorization.clone(),
        )
        .header("Accept-Encoding", "identity")
        .header("Range", format!("bytes={start}-{end}"))
        .timeout(Duration::from_secs(30));
    if let Some(expected) = expected {
        request = request.header("If-Range", &expected.etag);
    }
    metrics.requests.fetch_add(1, Ordering::AcqRel);
    let mut response = super::super::cancellable(request.send(), check)
        .await?
        .map_err(|_| {let _=(authority.response_check)(None); "MEDIA_OFFLINE"})?;
    (authority.response_check)(Some(&response))?;
    // A 200 could be a stale If-Range or an ignored Range. Never drain it or
    // silently turn it into a full-file download. 416/unknown totals also fail.
    if response.status().as_u16() != 206 {
        return Err(format!("MEDIA_RANGE_HTTP_{}", response.status().as_u16()));
    }
    let (meta, count) = metadata(response.headers(), start)?;
    if expected.is_some_and(|e| e.len != meta.len || e.etag != meta.etag || e.mime != meta.mime) {
        return Err("MEDIA_VERSION_CHANGED".into());
    }
    let mut bytes = Vec::with_capacity(count);
    while let Some(chunk) = super::super::cancellable(response.chunk(), check)
        .await?
        .map_err(|_| {let _=(authority.response_check)(None); "MEDIA_OFFLINE"})?
    {
        metrics
            .bytes
            .fetch_add(chunk.len() as u64, Ordering::AcqRel);
        if bytes.len() + chunk.len() > count {
            return Err("MEDIA_RESPONSE_INVALID".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.len() != count {
        return Err("MEDIA_RESPONSE_INVALID".into());
    }
    check()?;
    Ok((meta, bytes))
}
