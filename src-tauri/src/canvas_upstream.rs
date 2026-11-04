//! A canvas-only pinned upstream. It does not share LSH's client, pool, or
//! cookie jar. Nothing in this module is exposed to the browser or JavaScript.
use crate::pinning::build_pinned_client_config;
use reqwest::{header::{HeaderValue, CONTENT_TYPE, CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_RANGE, TRANSFER_ENCODING}, Client, StatusCode, Url};
use serde::Deserialize;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;
use zeroize::{Zeroize, Zeroizing};

const HOST: &str = "luckyray-companion.local";
const MAX_JSON_BYTES: usize = 9 * 1024 * 1024;
const MAX_ASSET_BYTES: usize = 16 * 1024 * 1024;

// Internal carrier response only. Never includes upstream headers or secrets.
pub(crate) struct CanvasAsset {
    pub(crate) bytes: Zeroizing<Vec<u8>>,
    pub(crate) content_type: &'static str,
}

const MAX_MEDIA_BYTES: u64 = 1024 * 1024 * 1024;

/// Validated metadata only. The original response and its headers stay private.
pub(crate) struct CanvasMedia {
    pub(crate) status: u16,
    pub(crate) content_type: &'static str,
    pub(crate) content_length: u64,
    pub(crate) content_range: Option<String>,
    response: Option<reqwest::Response>,
    remaining: u64,
}
impl CanvasMedia {
    pub(crate) async fn chunk(&mut self) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
        let Some(response) = self.response.as_mut() else { return Ok(None); };
        let chunk = tokio::time::timeout(Duration::from_secs(15), response.chunk()).await
            .map_err(|_| "CANVAS_MEDIA_TIMEOUT")?.map_err(|_| "CANVAS_TRANSPORT_UNAVAILABLE")?;
        match chunk {
            Some(chunk) => {
                if chunk.len() as u64 > self.remaining { return Err("CANVAS_RESPONSE_INVALID".into()); }
                self.remaining -= chunk.len() as u64;
                Ok(Some(Zeroizing::new(chunk.to_vec())))
            },
            None if self.remaining == 0 => { self.response.take(); Ok(None) },
            None => Err("CANVAS_RESPONSE_INVALID".into()),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MediaRange { From(u64, Option<u64>), Suffix(u64) }
impl MediaRange {
    fn parse(value: &str) -> Option<Self> {
        let (start, end) = value.strip_prefix("bytes=")?.split_once('-')?;
        if start.is_empty() {
            let length = decimal(end)?;
            return (length > 0).then_some(Self::Suffix(length));
        }
        let start = decimal(start)?;
        if end.is_empty() { return Some(Self::From(start, None)); }
        let end = decimal(end)?;
        (start <= end).then_some(Self::From(start, Some(end)))
    }
    fn header(self) -> String {
        match self { Self::From(start, Some(end)) => format!("bytes={start}-{end}"),
            Self::From(start, None) => format!("bytes={start}-"), Self::Suffix(length) => format!("bytes=-{length}") }
    }
    fn bounds(self, total: u64) -> Option<(u64, u64)> {
        if total == 0 { return None; }
        match self {
            Self::From(start, end) if start < total => Some((start, end.unwrap_or(total - 1).min(total - 1))),
            Self::From(_, _) => None,
            Self::Suffix(length) => Some((total.saturating_sub(length), total - 1)),
        }
    }
}
fn decimal(value: &str) -> Option<u64> {
    if value.is_empty() || value.len() > 20 || !value.bytes().all(|b| b.is_ascii_digit()) { return None; }
    value.parse().ok()
}
fn valid_media_id(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn media_mime(value: &str) -> Option<&'static str> {
    ["image/png", "image/jpeg", "image/gif", "image/webp", "video/mp4", "video/webm", "audio/wav", "audio/ogg", "audio/mpeg"]
        .into_iter().find(|mime| value.eq_ignore_ascii_case(mime))
}

fn validate_media_response(response: reqwest::Response, requested: Option<MediaRange>) -> Result<CanvasMedia, String> {
    let invalid = || "CANVAS_RESPONSE_INVALID".to_owned();
    let headers = response.headers();
    if headers.get_all(CONTENT_LENGTH).iter().count() != 1 || headers.contains_key(TRANSFER_ENCODING)
        || headers.get_all(CONTENT_ENCODING).iter().count() > 1
        || headers.get_all(CONTENT_ENCODING).iter().any(|v| !v.as_bytes().eq_ignore_ascii_case(b"identity")) {
        return Err(invalid());
    }
    let length = headers.get(CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(decimal).ok_or_else(invalid)?;
    if length > MAX_MEDIA_BYTES { return Err("CANVAS_RESPONSE_TOO_LARGE".into()); }
    let status = response.status().as_u16();
    if headers.get_all(CONTENT_RANGE).iter().count() > 1 { return Err(invalid()); }
    let range = headers.get(CONTENT_RANGE).map(|v| v.to_str().map_err(|_| invalid())).transpose()?;
    if status == 416 {
        let total = range.and_then(|value| value.strip_prefix("bytes */")).and_then(decimal).ok_or_else(invalid)?;
        if total > MAX_MEDIA_BYTES || length != 0 || requested.is_none() || requested.and_then(|r| r.bounds(total)).is_some() {
            return Err(invalid());
        }
        return Ok(CanvasMedia { status, content_type: "text/plain", content_length: 0,
            content_range: Some(format!("bytes */{total}")), response: None, remaining: 0 });
    }
    if headers.get_all(CONTENT_TYPE).iter().count() != 1 { return Err(invalid()); }
    let content_type = headers.get(CONTENT_TYPE).and_then(|v| v.to_str().ok()).and_then(media_mime).ok_or_else(invalid)?;
    let content_range = match status {
        200 if requested.is_none() && range.is_none() => None,
        206 => {
            let (span, total) = range.and_then(|value| value.strip_prefix("bytes ")).and_then(|value| value.split_once('/')).ok_or_else(invalid)?;
            let (start, end) = span.split_once('-').ok_or_else(invalid)?;
            let (start, end, total) = (decimal(start).ok_or_else(invalid)?, decimal(end).ok_or_else(invalid)?, decimal(total).ok_or_else(invalid)?);
            if total > MAX_MEDIA_BYTES || start > end || end >= total || end - start + 1 != length
                || requested.and_then(|r| r.bounds(total)) != Some((start, end)) { return Err(invalid()); }
            Some(format!("bytes {start}-{end}/{total}"))
        },
        _ => return Err(invalid()),
    };
    Ok(CanvasMedia { status, content_type, content_length: length, content_range, response: Some(response), remaining: length })
}

fn valid_secret(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn paired_address(base: &str) -> Result<(SocketAddr, Url), String> {
    let url = Url::parse(base).map_err(|_| "CANVAS_GATEWAY_INVALID")?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some()
        || !matches!(url.path(), "" | "/") || url.query().is_some() || url.fragment().is_some() {
        return Err("CANVAS_GATEWAY_INVALID".into());
    }
    let host = url.host_str().ok_or("CANVAS_GATEWAY_INVALID")?;
    let ip: IpAddr = host.trim_start_matches('[').trim_end_matches(']').parse().map_err(|_| "CANVAS_GATEWAY_INVALID")?;
    let port = url.port_or_known_default().filter(|p| *p != 0).ok_or("CANVAS_GATEWAY_INVALID")?;
    let origin = Url::parse(&format!("https://{HOST}:{port}/")).map_err(|_| "CANVAS_GATEWAY_INVALID")?;
    Ok((SocketAddr::new(ip, port), origin))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BootstrapResponse<'a> { #[serde(borrow)] session: &'a str }

/// Separate Client means a canvas request cannot follow an LSH HTTP request on
/// its upstream connection; redirects are rejected before any session header
/// can be sent elsewhere. No browser Cookie is passed to this client.
pub(crate) struct CanvasUpstream {
    client: Client,
    origin: Url,
    session: Zeroizing<String>,
}

impl CanvasUpstream {
    // Caller captures the expected paired owner before minting and must
    // revalidate that same owner and connection epoch after this await before
    // publishing the carrier; a late bootstrap cannot revive an old pairing.
    pub(crate) async fn bootstrap(base: &str, fingerprint: &str, reference: Zeroizing<String>) -> Result<Self, String> {
        if !valid_secret(&reference) { return Err("CANVAS_BOOTSTRAP_INVALID".into()); }
        // The shared pin parser expects ASCII before slicing the hex string.
        if fingerprint.len() != 64 || !fingerprint.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("CANVAS_GATEWAY_INVALID".into());
        }
        let (address, origin) = paired_address(base)?;
        let client = Client::builder()
            .use_preconfigured_tls(build_pinned_client_config(fingerprint)?)
            .resolve(HOST, address)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(20))
            .build().map_err(|_| "CANVAS_TRANSPORT_UNAVAILABLE")?;
        let url = origin.join("/canvas/bootstrap").map_err(|_| "CANVAS_GATEWAY_INVALID")?;
        let mut header = HeaderValue::from_bytes(reference.as_bytes()).map_err(|_| "CANVAS_BOOTSTRAP_INVALID")?;
        header.set_sensitive(true);
        let response = client.post(url).header("x-luckyray-canvas-bootstrap", header)
            .header("accept", "application/json")
            .send().await.map_err(|_| "CANVAS_TRANSPORT_UNAVAILABLE")?;
        if response.status() != StatusCode::OK { return Err("CANVAS_BOOTSTRAP_UNAVAILABLE".into()); }
        let body = bounded_json_body(response, 1024, true).await?;
        let parsed: BootstrapResponse<'_> = serde_json::from_slice(&body).map_err(|_| "CANVAS_BOOTSTRAP_INVALID")?;
        if !valid_secret(parsed.session) { return Err("CANVAS_BOOTSTRAP_INVALID".into()); }
        let session = Zeroizing::new(parsed.session.to_owned());
        Ok(Self { client, origin, session })
    }

    /// Only these two read routes can attach the private session header.
    pub(crate) async fn list(&self) -> Result<Zeroizing<Vec<u8>>, String> {
        let body = self.read("/canvas/api/v1/canvases").await?;
        validate_list(&body)?;
        Ok(body)
    }

    pub(crate) async fn load(&self, id: &str) -> Result<Zeroizing<Vec<u8>>, String> {
        let path = canvas_load_path(id)?;
        let body = self.read(&path).await?;
        validate_document(&body, id)?;
        Ok(body)
    }

    pub(crate) async fn asset(&self, path: &str) -> Result<CanvasAsset, String> {
        if !valid_asset_path(path) { return Err("CANVAS_INVALID_ASSET".into()); }
        let url = self.origin.join(path).map_err(|_| "CANVAS_GATEWAY_INVALID")?;
        let mut header = HeaderValue::from_bytes(self.session.as_bytes()).map_err(|_| "CANVAS_SESSION_EXPIRED")?;
        header.set_sensitive(true);
        let response = self.client.get(url).header("x-luckyray-canvas-session", header)
            .send().await.map_err(|_| "CANVAS_TRANSPORT_UNAVAILABLE")?;
        match response.status() {
            StatusCode::OK => {},
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => return Err("CANVAS_SESSION_EXPIRED".into()),
            StatusCode::NOT_FOUND => return Err("CANVAS_NOT_FOUND".into()),
            StatusCode::PAYLOAD_TOO_LARGE => return Err("CANVAS_RESPONSE_TOO_LARGE".into()),
            _ => return Err("CANVAS_SERVICE_UNAVAILABLE".into()),
        }
        let headers = response.headers();
        if headers.get_all(CONTENT_TYPE).iter().count() != 1
            || headers.get_all(CONTENT_ENCODING).iter().any(|v| !v.as_bytes().eq_ignore_ascii_case(b"identity")) {
            return Err("CANVAS_RESPONSE_INVALID".into());
        }
        let content_type = headers.get(CONTENT_TYPE).and_then(|v| v.to_str().ok())
            .and_then(|value| asset_content_type(path, value)).ok_or("CANVAS_RESPONSE_INVALID")?;
        let bytes = bounded_body(response, MAX_ASSET_BYTES, false).await?;
        Ok(CanvasAsset { bytes, content_type })
    }

    pub(crate) async fn media(&self, id: &str, range: Option<&str>) -> Result<CanvasMedia, String> {
        if !valid_media_id(id) { return Err("CANVAS_INVALID_MEDIA".into()); }
        let range = range.map(|value| MediaRange::parse(value).ok_or("CANVAS_RANGE_INVALID")).transpose()?;
        let url = self.origin.join(&format!("/canvas/media/{id}")).map_err(|_| "CANVAS_GATEWAY_INVALID")?;
        let mut header = HeaderValue::from_bytes(self.session.as_bytes()).map_err(|_| "CANVAS_SESSION_EXPIRED")?;
        header.set_sensitive(true);
        let mut request = self.client.get(url).header("x-luckyray-canvas-session", header)
            .timeout(Duration::from_secs(300));
        if let Some(range) = range { request = request.header("range", range.header()); }
        let response = tokio::time::timeout(Duration::from_secs(20), request.send()).await
            .map_err(|_| "CANVAS_MEDIA_TIMEOUT")?.map_err(|_| "CANVAS_TRANSPORT_UNAVAILABLE")?;
        match response.status() {
            StatusCode::OK | StatusCode::PARTIAL_CONTENT | StatusCode::RANGE_NOT_SATISFIABLE => validate_media_response(response, range),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Err("CANVAS_SESSION_EXPIRED".into()),
            StatusCode::NOT_FOUND => Err("CANVAS_NOT_FOUND".into()),
            StatusCode::PAYLOAD_TOO_LARGE => Err("CANVAS_RESPONSE_TOO_LARGE".into()),
            _ => Err("CANVAS_SERVICE_UNAVAILABLE".into()),
        }
    }

    // Private to this module; callers cannot supply arbitrary browser URLs.
    async fn read(&self, path: &str) -> Result<Zeroizing<Vec<u8>>, String> {
        let url = self.origin.join(path).map_err(|_| "CANVAS_GATEWAY_INVALID")?;
        let mut header = HeaderValue::from_bytes(self.session.as_bytes()).map_err(|_| "CANVAS_SESSION_EXPIRED")?;
        header.set_sensitive(true);
        let response = self.client.get(url).header("x-luckyray-canvas-session", header)
            .header("accept", "application/json")
            .send().await.map_err(|_| "CANVAS_TRANSPORT_UNAVAILABLE")?;
        match response.status() {
            StatusCode::OK => bounded_json_body(response, MAX_JSON_BYTES, false).await,
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Err("CANVAS_SESSION_EXPIRED".into()),
            StatusCode::NOT_FOUND => Err("CANVAS_NOT_FOUND".into()),
            StatusCode::PAYLOAD_TOO_LARGE => Err("CANVAS_RESPONSE_TOO_LARGE".into()),
            _ => Err("CANVAS_SERVICE_UNAVAILABLE".into()),
        }
    }
}

fn valid_asset_path(path: &str) -> bool {
    if matches!(path, "/canvas/" | "/canvas/index.html" | "/canvas/luckyray-logo.png") { return true; }
    let Some(name) = path.strip_prefix("/canvas/assets/") else { return false; };
    !name.is_empty() && name.len() <= 200 && name != "." && name != ".."
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

// Check MIME against the requested file type too: an HTML fallback for a
// missing script must not become executable carrier content. No sniffing.
fn asset_content_type(path: &str, value: &str) -> Option<&'static str> {
    let mut parts = value.split(';');
    let mime = parts.next()?.trim();
    if let Some(parameter) = parts.next() {
        let (key, value) = parameter.trim().split_once('=')?;
        if !key.trim().eq_ignore_ascii_case("charset")
            || !(value.trim().eq_ignore_ascii_case("utf-8") || value.trim().eq_ignore_ascii_case("\"utf-8\""))
            || parts.next().is_some() { return None; }
    }
    let allowed: &[&'static str] = if matches!(path, "/canvas/" | "/canvas/index.html") {
        &["text/html"]
    } else {
        match path.rsplit('.').next()? {
            "js" | "mjs" => &["text/javascript", "application/javascript"],
            "css" => &["text/css"],
            "png" => &["image/png"],
            "jpg" | "jpeg" => &["image/jpeg"],
            "gif" => &["image/gif"],
            "webp" => &["image/webp"],
            "avif" => &["image/avif"],
            "svg" => &["image/svg+xml"],
            "ico" => &["image/x-icon", "image/vnd.microsoft.icon"],
            "woff" => &["font/woff"],
            "woff2" => &["font/woff2"],
            "ttf" => &["font/ttf"],
            "otf" => &["font/otf"],
            "eot" => &["application/vnd.ms-fontobject"],
            _ => return None,
        }
    };
    allowed.iter().copied().find(|candidate| mime.eq_ignore_ascii_case(candidate))
}

fn valid_canvas_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

fn canvas_load_path(id: &str) -> Result<String, String> {
    if !valid_canvas_id(id) { return Err("CANVAS_INVALID_ID".into()); }
    Ok(format!("/canvas/api/v1/canvases/{id}"))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CanvasList<'a> { #[serde(borrow)] canvases: Vec<CanvasListId<'a>> }
#[derive(Deserialize)]
struct CanvasListId<'a> { #[serde(borrow)] id: &'a str }

fn validate_list(body: &[u8]) -> Result<(), String> {
    let list: CanvasList<'_> = serde_json::from_slice(body).map_err(|_| "CANVAS_RESPONSE_INVALID")?;
    let mut ids = std::collections::HashSet::new();
    if list.canvases.iter().any(|row| !valid_canvas_id(row.id) || !ids.insert(row.id)) {
        return Err("CANVAS_RESPONSE_INVALID".into());
    }
    Ok(())
}

// The existing remote surface consumes a top-level camelCase document. Parse
// identity and the required safe-projection version without copying arbitrary
// user content into an extra JSON tree. Unmarked legacy canonical documents
// can contain desktop-local paths and must never pass this boundary.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CanvasDocumentIdentity<'a> {
    #[serde(borrow)] canvas_id: &'a str,
    remote_projection_version: u32,
}

fn validate_document(body: &[u8], expected_id: &str) -> Result<(), String> {
    let document: CanvasDocumentIdentity<'_> = serde_json::from_slice(body).map_err(|_| "CANVAS_RESPONSE_INVALID")?;
    if document.remote_projection_version != 1
        || !valid_canvas_id(document.canvas_id) || document.canvas_id != expected_id {
        return Err("CANVAS_RESPONSE_INVALID".into());
    }
    Ok(())
}

fn json_content_type(value: &str) -> bool {
    let mut parts = value.split(';');
    if !parts.next().unwrap_or("").trim().eq_ignore_ascii_case("application/json") { return false; }
    match (parts.next(), parts.next()) {
        (None, None) => true,
        (Some(parameter), None) => parameter.trim().split_once('=').is_some_and(|(key, value)| {
            key.trim().eq_ignore_ascii_case("charset")
                && (value.trim().eq_ignore_ascii_case("utf-8") || value.trim().eq_ignore_ascii_case("\"utf-8\""))
        }),
        _ => false,
    }
}

async fn bounded_json_body(response: reqwest::Response, limit: usize, preallocate: bool) -> Result<Zeroizing<Vec<u8>>, String> {
    let headers = response.headers();
    if headers.get_all(CONTENT_TYPE).iter().count() != 1
        || !headers.get(CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(json_content_type)
        || headers.get_all(CONTENT_ENCODING).iter().any(|v| !v.as_bytes().eq_ignore_ascii_case(b"identity")) {
        return Err("CANVAS_RESPONSE_INVALID".into());
    }
    bounded_body(response, limit, preallocate).await
}

async fn bounded_body(mut response: reqwest::Response, limit: usize, preallocate: bool) -> Result<Zeroizing<Vec<u8>>, String> {
    if response.content_length().is_some_and(|length| length > limit as u64) {
        return Err("CANVAS_RESPONSE_TOO_LARGE".into());
    }
    // Bootstrap is small; reserving its full bound avoids reallocating an
    // earlier secret-containing buffer while receiving it in chunks.
    let mut body = Zeroizing::new(if preallocate { Vec::with_capacity(limit) } else { Vec::new() });
    while let Some(chunk) = response.chunk().await.map_err(|_| "CANVAS_TRANSPORT_UNAVAILABLE")? {
        if body.len().saturating_add(chunk.len()) > limit { body.zeroize(); return Err("CANVAS_RESPONSE_TOO_LARGE".into()); }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    include!("../../tests/canvasUpstream.native.rs");
    #[test]
    fn paired_origin_is_fixed_and_never_accepts_user_supplied_urls() {
        let (socket, origin) = paired_address("https://192.168.1.20:37419").unwrap();
        assert_eq!(socket.to_string(), "192.168.1.20:37419");
        assert_eq!(origin.as_str(), "https://luckyray-companion.local:37419/");
        for bad in ["http://192.168.1.20:37419", "https://user:pass@192.168.1.20:37419", "https://192.168.1.20:37419/path", "https://evil.example:37419", "https://192.168.1.20:37419/?x=1"] {
            assert!(paired_address(bad).is_err(), "{bad}");
        }
        assert_eq!(paired_address("https://192.168.1.20:443").unwrap().0.port(), 443);
        assert!(valid_secret(&"a".repeat(64)));
        assert!(!valid_secret(&"G".repeat(64)));
    }
}
