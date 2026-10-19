// GatewayClient: pinned HTTPS client speaking Protocol V1.
// All requests use the rustls fingerprint-pinned config from pairing.
// Replaces the M1 ad-hoc net.rs with the formal service client.

use crate::{build_pair_request_body, companion_error_note};
use crate::pinning::build_pinned_client_config;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue};
use serde_json::Value;

pub const ERROR_REVISION_CONFLICT: &str = "REVISION_CONFLICT";
pub const ERROR_CURSOR_TOO_OLD: &str = "CURSOR_TOO_OLD";

const LEGACY_ERROR_NOTE_REVISION_CONFLICT: &str = "NOTE_REVISION_CONFLICT";
const LEGACY_ERROR_RESYNC_REQUIRED: &str = "RESYNC_REQUIRED";

/// Normalize the two M2 receive-only aliases without giving either a second
/// Protocol V1 wire meaning. New gateways must emit the returned code.
pub(crate) fn canonical_protocol_error_code(code: &str) -> Option<&'static str> {
    match code {
        ERROR_REVISION_CONFLICT | LEGACY_ERROR_NOTE_REVISION_CONFLICT => Some(ERROR_REVISION_CONFLICT),
        ERROR_CURSOR_TOO_OLD | LEGACY_ERROR_RESYNC_REQUIRED => Some(ERROR_CURSOR_TOO_OLD),
        _ => None,
    }
}

/// The JSON response body is authoritative. The header fallback keeps the
/// already-validated M2 Mock Gateway compatible while it still emits its old
/// `RESYNC_REQUIRED` recovery hint.
fn response_protocol_error_code(headers: &HeaderMap, body: &Value) -> Option<&'static str> {
    body.get("code")
        .and_then(Value::as_str)
        .and_then(canonical_protocol_error_code)
        .or_else(|| {
            headers
                .get("x-luckyray-code")
                .and_then(|value| value.to_str().ok())
                .and_then(canonical_protocol_error_code)
        })
}

pub struct GatewayClient {
    fp: String,
    base: String,
    token: String,
}

impl GatewayClient {
    pub fn new(fp: &str, base: &str, token: &str) -> Self {
        Self { fp: fp.to_string(), base: base.trim_end_matches('/').to_string(), token: token.to_string() }
    }

    pub fn ws_url(&self) -> String {
        format!("wss://{}{}/v1/events", self.host(), self.path_base())
    }

    pub fn ws_authorization(&self) -> String {
        format!("Bearer {}", self.token)
    }

    pub fn base_url(&self) -> &str {
        &self.base
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    /// The paired certificate fingerprint this client pins (LSH carrier).
    pub fn fingerprint(&self) -> &str {
        &self.fp
    }

    pub fn client_req(&self) -> Result<reqwest::Client, String> {
        self.client()
    }

    /// Media ranges stay on the one paired/pinned origin. In particular, a
    /// redirect must not carry this authority to a second endpoint.
    pub(crate) fn media_client_req(&self) -> Result<reqwest::Client, String> {
        let config = build_pinned_client_config(&self.fp)?;
        reqwest::Client::builder().use_preconfigured_tls(config)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(30))
            .build().map_err(|_| "MEDIA_UNAVAILABLE".into())
    }

    fn host(&self) -> String {
        self.base
            .trim_start_matches("https://")
            .split('/')
            .next()
            .unwrap_or("")
            .to_string()
    }
    fn path_base(&self) -> String {
        let rest = self.base.trim_start_matches("https://");
        match rest.find('/') {
            Some(i) => rest[i..].to_string(),
            None => String::new(),
        }
    }

    fn client(&self) -> Result<reqwest::Client, String> {
        let config = build_pinned_client_config(&self.fp)?;
        reqwest::Client::builder()
            .use_preconfigured_tls(config)
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(300))
            .build()
            .map_err(|e| format!("client build: {e}"))
    }

    fn bearer(&self) -> reqwest::header::HeaderMap {
        let mut h = reqwest::header::HeaderMap::new();
        if let Ok(v) = HeaderValue::from_str(&self.ws_authorization()) {
            h.insert(AUTHORIZATION, v);
        }
        h
    }

    pub(crate) async fn content_get(&self, path: &str) -> Result<Value, String> {
        let mut resp = self.client()?.get(format!("{}{}", self.base, path)).headers(self.bearer())
            .send().await.map_err(|_| "CONTENT_OFFLINE".to_string())?;
        let status = resp.status();
        let mut bytes = Vec::new();
        while let Some(chunk) = resp.chunk().await.map_err(|_| "CONTENT_OFFLINE".to_string())? {
            if bytes.len() + chunk.len() > 8 * 1024 * 1024 { return Err("CONTENT_RESPONSE_TOO_LARGE".into()); }
            bytes.extend_from_slice(&chunk);
        }
        let body: Value = serde_json::from_slice(&bytes).map_err(|_| "CONTENT_RESPONSE_INVALID".to_string())?;
        if !status.is_success() {
            return Err(format!("content {}", companion_error_note(status.as_u16(), &body)));
        }
        Ok(body)
    }

    pub(crate) async fn content_mutate(&self, path: &str, method: reqwest::Method, payload: &Value) -> Result<(u16, Value), String> {
        let mut response = self.client()?.request(method,format!("{}{}",self.base,path)).headers(self.bearer()).json(payload)
            .send().await.map_err(|_| "CONTENT_OFFLINE")?;
        let status = response.status().as_u16();
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "CONTENT_OFFLINE")? {
            if bytes.len()+chunk.len()>8*1024*1024 {return Err("CONTENT_RESPONSE_TOO_LARGE".into());}
            bytes.extend_from_slice(&chunk);
        }
        let value = serde_json::from_slice(&bytes).map_err(|_| "CONTENT_RESPONSE_INVALID")?;
        Ok((status,value))
    }

    /// One canonical request through the pinned client, carrying the existing
    /// Bearer. `payload` is either JSON (via `content_mutate`) or raw bytes with
    /// caller headers (the bounded ingest chunk path).
    ///
    /// Returns the canonical status alongside the parsed body, so a non-2xx is
    /// a VALUE the caller can branch on rather than a transport failure.
    pub(crate) async fn content_request(
        &self,
        method: reqwest::Method,
        path: &str,
        raw: Option<(&[u8], &[(String, String)])>,
    ) -> Result<(u16, Value), String> {
        let mut builder = self
            .client()?
            .request(method, format!("{}{}", self.base, path))
            .headers(self.bearer());
        if let Some((bytes, headers)) = raw {
            let mut map = reqwest::header::HeaderMap::new();
            for (name, value) in headers {
                let n = reqwest::header::HeaderName::from_bytes(name.as_bytes())
                    .map_err(|_| "SERVICES_HEADER_INVALID")?;
                let v = HeaderValue::from_str(value).map_err(|_| "SERVICES_HEADER_INVALID")?;
                map.insert(n, v);
            }
            builder = builder.headers(map).body(bytes.to_vec());
        }
        let mut response = builder.send().await.map_err(|_| "CONTENT_OFFLINE")?;
        let status = response.status().as_u16();
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "CONTENT_OFFLINE")? {
            if bytes.len() + chunk.len() > 8 * 1024 * 1024 {
                return Err("CONTENT_RESPONSE_TOO_LARGE".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| "CONTENT_RESPONSE_INVALID".to_string())?;
        Ok((status, value))
    }

    async fn get_json(&self, path: &str) -> Result<Value, String> {
        let client = self.client()?;
        let resp = client
            .get(format!("{}{}", self.base, path))
            .headers(self.bearer())
            .send()
            .await
            .map_err(|e| format!("GET {path}: {e}"))?;
        let status = resp.status();
        let headers = resp.headers().clone();
        let body: Value = resp.json().await.map_err(|e| format!("json: {e}"))?;
        if !status.is_success() {
            let marker = response_protocol_error_code(&headers, &body)
                .map(|code| format!(" {code}"))
                .unwrap_or_default();
            return Err(format!("GET {path} http {status}{marker}: {body}"));
        }
        Ok(body)
    }

    pub async fn hello(&self) -> Result<Value, String> {
        let client = self.client()?;
        let resp = client.get(format!("{}/v1/hello", self.base)).send().await.map_err(|e| format!("hello: {e}"))?;
        let status = resp.status();
        let body: Value = resp.json().await.map_err(|e| format!("json: {e}"))?;
        if !status.is_success() {
            // Phase-B: bounded companion error note — typed code only, the
            // raw body/message never enters Mobile state or logs.
            return Err(format!("hello {}", companion_error_note(status.as_u16(), &body)));
        }
        Ok(body)
    }

    pub async fn pair(&self, secret: &str, device_label: &str) -> Result<Value, String> {
        let client = self.client()?;
        let resp = client
            .post(format!("{}/v1/pair", self.base))
            .json(&build_pair_request_body(secret, &self.fp, device_label))
            .send()
            .await
            .map_err(|e| format!("pair: {e}"))?;
        let status = resp.status();
        let body: Value = resp.json().await.map_err(|e| format!("json: {e}"))?;
        if !status.is_success() {
            // Phase-B: bounded companion error note — typed code only, the
            // raw body/message never enters Mobile state or logs.
            return Err(format!("pair {}", companion_error_note(status.as_u16(), &body)));
        }
        Ok(body)
    }

    /// M3-M1 Phase-B R1 (P1-2): canonical session gate — GET /v1/session with
    /// the fresh Bearer device credential. Errors are bounded (typed code
    /// only); AUTH_REVOKED detection is left to the caller via the status.
    pub async fn session(&self) -> Result<Value, String> {
        let client = self.client()?;
        let resp = client
            .get(format!("{}/v1/session", self.base))
            .headers(self.bearer())
            .send()
            .await
            .map_err(|e| format!("session: {e}"))?;
        let status = resp.status();
        let body: Value = resp.json().await.map_err(|e| format!("json: {e}"))?;
        if !status.is_success() {
            return Err(format!("session {}", companion_error_note(status.as_u16(), &body)));
        }
        Ok(body)
    }

    pub async fn assets(&self, page: i64, limit: i64, kind: Option<&str>, q: Option<&str>) -> Result<Value, String> {
        let mut path = format!("/v1/assets?page={page}&limit={limit}");
        if let Some(k) = kind {
            path.push_str(&format!("&kind={k}"));
        }
        if let Some(query) = q {
            path.push_str(&format!("&q={}", urlencode(query)));
        }
        self.get_json(&path).await
    }

    pub async fn asset_detail(&self, id: &str) -> Result<Value, String> {
        self.get_json(&format!("/v1/assets/{id}")).await
    }

    /// Fetch thumbnail with If-None-Match revalidation.
    /// Returns (bytes, etag, mime). A 304 returns the cached etag with empty bytes
    /// (caller keeps local copy); 404 maps to an error the cache layer surfaces.
    pub async fn fetch_thumbnail(&self, id: &str, etag: Option<&str>) -> Result<(Vec<u8>, String, String), String> {
        let client = self.client()?;
        let mut req = client.get(format!("{}/v1/assets/{id}/thumbnail", self.base)).headers(self.bearer());
        if let Some(e) = etag {
            req = req.header("If-None-Match", e);
        }
        let mut resp = req.send().await.map_err(|_| "thumbnail: offline".to_string())?;
        let status = resp.status();
        let resp_etag = resp.headers().get("etag").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        let mime = resp.headers().get(CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("image/png").to_string();
        if status == reqwest::StatusCode::NOT_MODIFIED {
            return Ok((Vec::new(), resp_etag, mime));
        }
        if status == reqwest::StatusCode::NOT_FOUND {
            return Err("thumbnail: 404 asset not found".into());
        }
        if !status.is_success() {
            return Err(format!("thumbnail http {status}"));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = resp.chunk().await.map_err(|_| "thumbnail: interrupted".to_string())? {
            if bytes.len() + chunk.len() > crate::THUMBNAIL_MAX_BYTES { return Err("thumbnail: too large".into()); }
            bytes.extend_from_slice(&chunk);
        }
        Ok((bytes, resp_etag, mime))
    }

    pub async fn notes(&self) -> Result<Value, String> {
        self.get_json("/v1/notes").await
    }

    pub async fn note(&self, id: &str) -> Result<Value, String> {
        self.get_json(&format!("/v1/notes/{id}")).await
    }

    /// Returns Ok(updated) or Err with ERROR_REVISION_CONFLICT marker on 409.
    pub async fn note_update(&self, id: &str, expected_revision: &str, content: &str, title: &str) -> Result<Value, String> {
        let client = self.client()?;
        let resp = client
            .patch(format!("{}/v1/notes/{id}", self.base))
            .headers(self.bearer())
            .json(&serde_json::json!({
                "expectedRevision": expected_revision,
                "content": content,
                "title": title,
            }))
            .send()
            .await
            .map_err(|e| format!("note update: {e}"))?;
        let status = resp.status();
        if status == reqwest::StatusCode::CONFLICT {
            return Err(format!("{ERROR_REVISION_CONFLICT}: {status}"));
        }
        let body: Value = resp.json().await.map_err(|e| format!("json: {e}"))?;
        if !status.is_success() {
            return Err(format!("note update http {status}: {body}"));
        }
        Ok(body)
    }

    /// Capture with opId idempotency. Duplicate opId returns the same result.
    pub async fn capture(&self, op: &Value) -> Result<Value, String> {
        let client = self.client()?;
        let resp = client
            .post(format!("{}/v1/capture", self.base))
            .headers(self.bearer())
            .json(op)
            .send()
            .await
            .map_err(|e| format!("capture: {e}"))?;
        let status = resp.status();
        let body: Value = resp.json().await.map_err(|e| format!("json: {e}"))?;
        if !status.is_success() {
            return Err(format!("capture http {status}: {body}"));
        }
        Ok(body)
    }

    pub async fn sync_changes(&self, after: i64, limit: i64) -> Result<Value, String> {
        self.get_json(&format!("/v1/sync/changes?after={after}&limit={limit}")).await
    }

    /// Upload an attachment file body with idempotency by opId.
    /// Returns the gateway-observed sha256 (client compares to its local hash).
    pub async fn upload_attachment(
        &self,
        op_id: &str,
        ref_id: &str,
        file_name: &str,
        mime: &str,
        local_path: &str,
    ) -> Result<String, String> {
        let bytes = std::fs::read(local_path).map_err(|e| format!("read attachment: {e}"))?;
        let client = self.client()?;
        let resp = client
            .post(format!("{}/v1/capture/file", self.base))
            .headers(self.bearer())
            .header("x-client-operation-id", op_id)
            .header("x-ref-id", ref_id)
            .header("x-file-name", file_name)
            .header("x-mime", mime)
            .body(bytes)
            .send()
            .await
            .map_err(|e| format!("upload attachment: {e}"))?;
        let status = resp.status();
        let body: Value = resp.json().await.map_err(|e| format!("json: {e}"))?;
        if !status.is_success() {
            return Err(format!("upload attachment http {status}: {body}"));
        }
        Ok(body["sha256"].as_str().unwrap_or("").to_string())
    }

    pub async fn ai_runs(&self) -> Result<Value, String> {
        self.get_json("/v1/ai/runs").await
    }

    pub async fn ai_events(&self, run_id: &str, after: i64, limit: i64) -> Result<Value, String> {
        self.get_json(&format!("/v1/ai/runs/{run_id}/events?after={after}&limit={limit}")).await
    }

    pub async fn ai_stop(&self, run_id: &str) -> Result<Value, String> {
        let client = self.client()?;
        let resp = client
            .post(format!("{}/v1/ai/runs/{run_id}/stop", self.base))
            .headers(self.bearer())
            .send()
            .await
            .map_err(|e| format!("ai stop: {e}"))?;
        let status = resp.status();
        let body: Value = resp.json().await.map_err(|e| format!("json: {e}"))?;
        if !status.is_success() {
            return Err(format!("ai stop http {status}: {body}"));
        }
        Ok(body)
    }

    /// Negative pin test: attempt hello with a deliberately wrong fingerprint; must fail.
    pub async fn negative_pin_test(base: &str) -> Result<String, String> {
        let wrong_fp = "00".repeat(32);
        let config = build_pinned_client_config(&wrong_fp)?;
        let client = reqwest::Client::builder()
            .use_preconfigured_tls(config)
            .connect_timeout(std::time::Duration::from_secs(5))
            .build()
            .map_err(|e| format!("client: {e}"))?;
        let start = std::time::Instant::now();
        let err = client.get(format!("{}/v1/hello", base.trim_end_matches('/'))).send().await;
        let ms = start.elapsed().as_millis() as u64;
        match err {
            Ok(_) => Err("unexpected: connection succeeded with wrong pin".into()),
            Err(e) => Ok(format!("rejected wrong pin as expected ({ms}ms): {e}")),
        }
    }
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use reqwest::header::{HeaderMap, HeaderValue};
    use serde_json::json;

    use super::{
        canonical_protocol_error_code, response_protocol_error_code, ERROR_CURSOR_TOO_OLD,
        ERROR_REVISION_CONFLICT, GatewayClient,
    };

    #[test]
    fn websocket_url_never_contains_the_credential() {
        let client = GatewayClient::new(
            "fingerprint",
            "https://192.168.1.8:48180",
            "credential-that-must-not-enter-a-url",
        );

        let url = client.ws_url();

        assert_eq!(url, "wss://192.168.1.8:48180/v1/events");
        assert!(!url.contains("credential-that-must-not-enter-a-url"));
        assert!(!url.contains('?'));
    }

    #[test]
    fn normalizes_receive_only_legacy_protocol_error_aliases() {
        assert_eq!(canonical_protocol_error_code("NOTE_REVISION_CONFLICT"), Some(ERROR_REVISION_CONFLICT));
        assert_eq!(canonical_protocol_error_code("RESYNC_REQUIRED"), Some(ERROR_CURSOR_TOO_OLD));
        assert_eq!(canonical_protocol_error_code("UNKNOWN_ERROR"), None);
    }

    #[test]
    fn canonical_json_code_wins_over_a_legacy_recovery_header() {
        let mut headers = HeaderMap::new();
        headers.insert("x-luckyray-code", HeaderValue::from_static("RESYNC_REQUIRED"));

        assert_eq!(
            response_protocol_error_code(&headers, &json!({ "code": "CURSOR_TOO_OLD" })),
            Some(ERROR_CURSOR_TOO_OLD)
        );
        assert_eq!(response_protocol_error_code(&headers, &json!({})), Some(ERROR_CURSOR_TOO_OLD));
    }
}
