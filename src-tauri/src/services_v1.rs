// Companion Services V1 — production transport (Issue #77 §2 / REPAIR-R1 P1-T1).
//
// This is the ONLY way Services V1 requests reach a Desktop. It reuses the
// existing pinned Companion authority rather than creating a parallel one:
//
//   TS -> Tauri command (here) -> expected-owner capture -> pinned
//   GatewayClient (rustls + pinned fingerprint + existing Bearer) -> HTTPS
//
// Security properties, all enforced in this module:
//  - the expected Desktop instance is MANDATORY and is captured BEFORE any
//    wire send; a different instance never reaches the network;
//  - the capture is RE-PROVEN after the awaited response, so a Desktop switch
//    during the request cannot be acknowledged as current state;
//  - there is NO generic proxy: operationId + method + path must match a closed
//    allowlist built from the canonical operation set, otherwise the call is
//    refused before the wire;
//  - paths are templates with validated identifiers, never caller-supplied
//    URLs, and no credential may appear in the query;
//  - raw ingest chunks are bounded to the canonical upload chunk limit;
//  - the canonical HTTP status and error code are passed back to TS verbatim.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::content::expected_scoped_gateway;

/// Canonical Services V1 namespace. Every allowed path starts with this.
const SERVICES_PREFIX: &str = "/v1/services";

/// Canonical ingest chunk bound (operations.json limits.uploadChunkBytes).
const MAX_CHUNK_BYTES: usize = 262_144;

/// Bounded response ceiling, matching the existing Content V1 readers.
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

/// Query keys that would smuggle a credential onto the wire.
const FORBIDDEN_QUERY_KEYS: &[&str] = &[
    "token", "access_token", "api_key", "apikey", "authorization", "auth", "bearer",
    "cookie", "secret", "sig", "signature", "password",
];

/// EXACT wire shape shared with `productionTransport.ts`.
///
/// Tauri's camelCase handling for command ARGUMENTS does not rename fields
/// inside a nested serde struct, so the nested names are made EXPLICIT here and
/// locked by a deserialization test using the literal JSON the TS side emits.
/// Nothing relies on implicit casing.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServicesRequest {
    pub instance: String,
    #[serde(default)]
    pub library: Option<String>,
    #[serde(default)]
    pub vault: Option<String>,
    #[serde(rename = "operationId")]
    pub operation_id: String,
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub query: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub body: Option<Value>,
    /// Raw chunk transport: base64 bytes + offset. Never a Desktop path.
    #[serde(default)]
    pub chunk: Option<ChunkPayload>,
}

/// EXACT chunk wire shape (see `ServicesRequest`).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChunkPayload {
    pub offset: u64,
    /// base64 of ONE bounded slice.
    #[serde(rename = "bytes_base64")]
    pub bytes_base64: String,
    pub sha256: String,
}

#[derive(Debug, Serialize)]
pub struct ServicesResponse {
    pub status: u16,
    pub body: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
}

/// Canonical error surface for a refusal that never reached the wire.
#[derive(Debug, Serialize)]
pub struct ServicesRefusal {
    pub code: String,
}

fn refusal(code: &str) -> ServicesRefusal {
    ServicesRefusal { code: code.to_string() }
}

/// Adapter that lets both `&'static str` and `String` error sources become a
/// canonical refusal without changing the refusal shape.
fn refusal_from<T: AsRef<str>>(code: T) -> ServicesRefusal {
    refusal(code.as_ref())
}

/// One allowlist entry: a canonical operation with its exact method and a path
/// template. `{}` segments are validated identifiers, never free-form paths.
struct Allowed {
    operation_id: &'static str,
    method: &'static str,
    /// Template using `*` for exactly one validated identifier segment.
    template: &'static str,
    /// Allowed query keys; anything else is refused.
    query_keys: &'static [&'static str],
}

/// The closed allowlist for Services V1. Derived from the canonical
/// `operations.json`; only the operations this client actually implements are
/// listed, so an unknown operation can never reach the network.
const ALLOWED: &[Allowed] = &[
    Allowed { operation_id: "services.discover", method: "GET", template: "/v1/services", query_keys: &[] },
    Allowed {
        operation_id: "materials.detailV1",
        method: "GET",
        template: "/v1/services/materials/assets/*",
        query_keys: &[],
    },
    Allowed {
        operation_id: "materials.metadataPatch",
        method: "PATCH",
        template: "/v1/services/materials/assets/*",
        query_keys: &[],
    },
    Allowed {
        operation_id: "materials.removeRecord",
        method: "DELETE",
        template: "/v1/services/materials/assets/*",
        query_keys: &[],
    },
    Allowed {
        operation_id: "materials.changes",
        method: "GET",
        template: "/v1/services/materials/changes",
        query_keys: &["after", "limit"],
    },
    Allowed {
        operation_id: "knowledge.vaults",
        method: "GET",
        template: "/v1/services/knowledge/vaults",
        query_keys: &[],
    },
    Allowed {
        operation_id: "knowledge.registeredList",
        method: "GET",
        template: "/v1/services/knowledge/vaults/*/notes",
        query_keys: &["limit", "afterId", "q"],
    },
    Allowed {
        operation_id: "knowledge.registeredChanges",
        method: "GET",
        template: "/v1/services/knowledge/vaults/*/changes",
        query_keys: &["after", "limit"],
    },
    Allowed {
        operation_id: "knowledge.move",
        method: "PATCH",
        template: "/v1/services/knowledge/notes/*/move",
        query_keys: &[],
    },
    Allowed { operation_id: "knowledge.createUnique", method: "POST", template: "/v1/services/knowledge/notes", query_keys: &[] },
    Allowed { operation_id: "knowledge.editing", method: "GET", template: "/v1/services/knowledge/notes/*/editing", query_keys: &["vault"] },
    Allowed { operation_id: "knowledge.editingOpen", method: "POST", template: "/v1/services/knowledge/notes/*/editing", query_keys: &[] },
    Allowed { operation_id: "knowledge.editingSet", method: "PUT", template: "/v1/services/knowledge/notes/*/editing", query_keys: &[] },
    Allowed { operation_id: "knowledge.directories", method: "GET", template: "/v1/services/knowledge/vaults/*/directories", query_keys: &["limit", "afterPath"] },
    Allowed { operation_id: "knowledge.relations", method: "GET", template: "/v1/services/knowledge/notes/*/relations", query_keys: &["vault", "limit", "after"] },
    Allowed { operation_id: "knowledge.materialReferences", method: "GET", template: "/v1/services/knowledge/materials/*/references", query_keys: &["vault", "limit", "after"] },
    Allowed { operation_id: "ingest.begin", method: "POST", template: "/v1/services/ingest/jobs", query_keys: &[] },
    Allowed {
        operation_id: "ingest.status",
        method: "GET",
        template: "/v1/services/ingest/jobs/*",
        query_keys: &[],
    },
    Allowed {
        operation_id: "ingest.chunk",
        method: "PUT",
        template: "/v1/services/ingest/jobs/*/chunks",
        query_keys: &[],
    },
    Allowed {
        operation_id: "ingest.complete",
        method: "POST",
        template: "/v1/services/ingest/jobs/*/complete",
        query_keys: &[],
    },
    Allowed {
        operation_id: "ingest.cancel",
        method: "POST",
        template: "/v1/services/ingest/jobs/*/cancel",
        query_keys: &[],
    },
    Allowed {
        operation_id: "search.unified",
        method: "GET",
        template: "/v1/services/search",
        query_keys: &["q", "domains", "limit", "cursor"],
    },
    Allowed {
        operation_id: "changes.hints",
        method: "GET",
        template: "/v1/services/events/stream",
        query_keys: &[],
    },
    Allowed {
        operation_id: "presentation.open",
        method: "POST",
        template: "/v1/services/presentation/open",
        query_keys: &[],
    },
];

fn is_identifier(segment: &str) -> bool {
    !segment.is_empty()
        && segment.len() <= 160
        && segment.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

/// Match a canonical path template against the requested path. Template `*`
/// consumes exactly one identifier segment, so `/v1/services` can never be
/// reached through a wildcard.
fn template_matches(template: &str, path: &str) -> bool {
    if !template.contains('*') {
        return template == path;
    }
    let t: Vec<&str> = template.split('/').collect();
    let p: Vec<&str> = path.split('/').collect();
    if t.len() != p.len() {
        return false;
    }
    t.iter().zip(p.iter()).all(|(ts, ps)| {
        if *ts == "*" {
            is_identifier(ps)
        } else {
            ts == ps
        }
    })
}

/// Resolve an allowed operation, or refuse before the wire.
fn resolve<'a>(
    operation_id: &str,
    method: &str,
    path: &str,
    query: &std::collections::BTreeMap<String, String>,
) -> Result<&'a Allowed, &'static str> {
    // Malformed path shapes are rejected FIRST so the reported reason is the
    // precise one: a caller-supplied URL/scheme, traversal or query string is
    // never a path at all.
    if !path.bytes().all(|b| b.is_ascii_alphanumeric() || b"/-_.~".contains(&b) || b == b'*') {
        return Err("SERVICES_PATH_INVALID");
    }
    if path.split('/').any(|seg| seg == "..") {
        return Err("SERVICES_PATH_INVALID");
    }
    if path.len() > 512 || path.is_empty() {
        return Err("SERVICES_PATH_INVALID");
    }
    // A well-formed path outside the Services namespace is never proxied.
    if !path.starts_with(SERVICES_PREFIX) {
        return Err("SERVICES_PATH_NOT_ALLOWED");
    }
    let entry = ALLOWED
        .iter()
        .find(|a| a.operation_id == operation_id && a.method == method)
        .ok_or("SERVICES_OPERATION_NOT_ALLOWED")?;
    if !template_matches(entry.template, path) {
        return Err("SERVICES_PATH_NOT_ALLOWED");
    }
    for key in query.keys() {
        if FORBIDDEN_QUERY_KEYS.contains(&key.to_ascii_lowercase().as_str()) {
            return Err("SERVICES_QUERY_CREDENTIAL_FORBIDDEN");
        }
        if !entry.query_keys.contains(&key.as_str()) {
            return Err("SERVICES_QUERY_NOT_ALLOWED");
        }
    }
    Ok(entry)
}

fn build_path(req: &ServicesRequest) -> String {
    if req.query.is_empty() {
        return req.path.clone();
    }
    let mut parts: Vec<String> = Vec::new();
    for (k, v) in &req.query {
        if v.is_empty() && k != "afterPath" {
            continue;
        }
        parts.push(format!("{}={}", encode_component(k), encode_component(v)));
    }
    if parts.is_empty() {
        req.path.clone()
    } else {
        format!("{}?{}", req.path, parts.join("&"))
    }
}

fn encode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn decode_base64(input: &str) -> Result<Vec<u8>, &'static str> {
    // Minimal, dependency-free decoder for the one bounded chunk payload.
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut lut = [255u8; 256];
    for (i, c) in TABLE.iter().enumerate() {
        lut[*c as usize] = i as u8;
    }
    let bytes: Vec<u8> = input.bytes().filter(|b| *b != b'\n' && *b != b'\r').collect();
    if bytes.len() % 4 != 0 {
        return Err("SERVICES_CHUNK_INVALID");
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks(4) {
        let mut vals = [0u8; 4];
        let mut pad = 0;
        for (i, b) in chunk.iter().enumerate() {
            if *b == b'=' {
                pad += 1;
                vals[i] = 0;
            } else {
                let v = lut[*b as usize];
                if v == 255 {
                    return Err("SERVICES_CHUNK_INVALID");
                }
                vals[i] = v;
            }
        }
        let n = ((vals[0] as u32) << 18) | ((vals[1] as u32) << 12) | ((vals[2] as u32) << 6) | vals[3] as u32;
        out.push((n >> 16) as u8);
        if pad < 2 {
            out.push((n >> 8) as u8);
        }
        if pad < 1 {
            out.push(n as u8);
        }
    }
    Ok(out)
}

fn looks_like_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|c| c.is_ascii_hexdigit())
}

/// Perform one Services V1 request through the pinned captured gateway.
///
/// Returns `Ok(ServicesResponse)` for BOTH success and canonical non-2xx
/// (the caller branches on the code), and `Err(ServicesRefusal)` for a refusal
/// that never reached the wire.
#[tauri::command]
pub async fn services_v1_request(
    state: State<'_, crate::SharedState>,
    request: ServicesRequest,
) -> Result<ServicesResponse, ServicesRefusal> {
    // 1. Closed allowlist BEFORE anything else — no wire, no owner capture.
    let entry = resolve(&request.operation_id, &request.method, &request.path, &request.query)
        .map_err(refusal_from)?;
    let _ = entry;

    // 2. Expected Desktop instance is mandatory.
    if request.instance.is_empty() {
        return Err(refusal("CONTENT_SOURCE_CHANGED"));
    }

    // 3. Capture the pinned gateway for THAT owner (fences before the send).
    let gateway = expected_scoped_gateway(&state, &request.instance, request.library.as_deref(), request.vault.as_deref()).map_err(refusal_from)?;

    let path = build_path(&request);

    // 4. Raw chunk transport: bounded, offset+hash carried as headers.
    if let Some(chunk) = &request.chunk {
        let bytes = decode_base64(&chunk.bytes_base64).map_err(refusal_from)?;
        if bytes.is_empty() || bytes.len() > MAX_CHUNK_BYTES {
            return Err(refusal("PAYLOAD_TOO_LARGE"));
        }
        if !looks_like_sha256(&chunk.sha256) {
            return Err(refusal("UPLOAD_HASH_MISMATCH"));
        }
        let headers = vec![
            ("x-chunk-offset".to_string(), chunk.offset.to_string()),
            ("x-chunk-sha256".to_string(), chunk.sha256.clone()),
        ];
        let (status, body) = gateway
            .services_request_with_chunk(&state, &request.method, &path, &bytes, &headers)
            .await
            .map_err(refusal_from)?;
        return Ok(ServicesResponse { status, retry_after_ms: if status==429 {body["retryAfterMs"].as_u64()} else {None}, body });
    }

    // 5. JSON request. A body is sent only when the caller supplied one; a
    //    bodiless DELETE/POST still carries its exact method.
    let result = match &request.body {
        Some(body) => gateway
            .services_request_json(&state, &request.method, &path, body)
            .await
            .map_err(refusal_from)?,
        None => gateway
            .services_request(&state, &request.method, &path, false, &Value::Null)
            .await
            .map_err(refusal_from)?,
    };
    Ok(ServicesResponse { status: result.0, retry_after_ms: if result.0==429 {result.1["retryAfterMs"].as_u64()} else {None}, body: result.1 })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn q(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn rate_limit_hint_preserves_the_server_window_on_the_wire() {
        let reply = ServicesResponse { status:429, body:serde_json::json!({"code":"RATE_LIMITED"}), retry_after_ms:Some(60_000) };
        let json=serde_json::to_value(reply).unwrap();
        assert_eq!(json["retry_after_ms"],60_000);
        assert_eq!(json["body"]["code"],"RATE_LIMITED");
        let reply=ServicesResponse {status:200,body:serde_json::json!({}),retry_after_ms:None};
        assert!(serde_json::to_value(reply).unwrap().get("retry_after_ms").is_none());
    }

    // ---------------------------------------------------------------------
    // EXACT wire shape (P1-W1). These literals are the JSON that
    // productionTransport.ts emits; they are deserialized here for real, so a
    // camelCase/snake_case mismatch fails the build, not just a JS fake.
    // ---------------------------------------------------------------------

    #[test]
    fn deserializes_the_exact_production_request_shape() {
        let json = r#"{
            "instance": "fixture-desktop-1",
            "operationId": "materials.metadataPatch",
            "method": "PATCH",
            "path": "/v1/services/materials/assets/asset-1",
            "query": {},
            "body": {"opId":"o","expectedRevision":"r","name":"N"},
            "chunk": null
        }"#;
        let req: ServicesRequest = serde_json::from_str(json).expect("production shape must deserialize");
        assert_eq!(req.instance, "fixture-desktop-1");
        assert_eq!(req.operation_id, "materials.metadataPatch");
        assert_eq!(req.method, "PATCH");
        assert_eq!(req.path, "/v1/services/materials/assets/asset-1");
        assert!(req.query.is_empty());
        assert_eq!(req.body.as_ref().unwrap()["opId"], "o");
        assert!(req.chunk.is_none());
    }

    #[test]
    fn deserializes_the_exact_production_chunk_shape() {
        let json = r#"{
            "instance": "fixture-desktop-1",
            "operationId": "ingest.chunk",
            "method": "PUT",
            "path": "/v1/services/ingest/jobs/job-1/chunks",
            "query": {},
            "body": null,
            "chunk": {"offset": 262144, "bytes_base64": "aGVsbG8=", "sha256": "abababababababababababababababababababababababababababababababab"}
        }"#;
        let req: ServicesRequest = serde_json::from_str(json).expect("chunk shape must deserialize");
        let chunk = req.chunk.expect("chunk present");
        assert_eq!(chunk.offset, 262_144);
        assert_eq!(chunk.bytes_base64, "aGVsbG8=");
        assert_eq!(chunk.sha256.len(), 64);
    }

    #[test]
    fn snake_case_operation_id_would_be_rejected() {
        // Guards the explicit contract: the wire uses `operationId`, so a
        // snake_case payload must NOT silently deserialize.
        let json = r#"{"instance":"d","operation_id":"services.discover","method":"GET","path":"/v1/services"}"#;
        assert!(serde_json::from_str::<ServicesRequest>(json).is_err());
    }

    #[test]
    fn unknown_wire_fields_are_rejected() {
        let json = r#"{"instance":"d","operationId":"services.discover","method":"GET","path":"/v1/services","surprise":1}"#;
        assert!(serde_json::from_str::<ServicesRequest>(json).is_err());
    }

    #[test]
    fn query_values_must_be_strings_on_the_wire() {
        let json = r#"{"instance":"d","operationId":"materials.changes","method":"GET","path":"/v1/services/materials/changes","query":{"after":"m:1","limit":"5"}}"#;
        let req: ServicesRequest = serde_json::from_str(json).expect("string query deserializes");
        assert_eq!(req.query.get("after").unwrap(), "m:1");
        assert_eq!(req.query.get("limit").unwrap(), "5");
    }

    // ---------------------------------------------------------------------
    // G1-N — the Services paths fence the CAPTURED connection epoch.
    //
    // `verify_owner` compares only the Desktop instance, so a disconnect and
    // reconnect to the SAME Desktop (X @ E -> X @ E+1) is invisible to it.
    // These exercise the same two primitives the production fence uses.
    // ---------------------------------------------------------------------

    #[test]
    fn source_check_detects_a_new_epoch_for_the_same_desktop() {
        use crate::ConnectionLifecycle;
        let lifecycle = ConnectionLifecycle::new();
        // The epoch captured WITH the gateway.
        let captured = lifecycle.observe();
        // Same Desktop, but the connection was torn down and re-established.
        lifecycle.invalidate();
        assert_ne!(lifecycle.observe(), captured, "a new epoch is observable");
        // The production fence compares the captured epoch, so it refuses.
        assert!(lifecycle.observe() != captured);
    }

    #[test]
    fn a_services_request_fences_twice_around_the_await() {
        // Source-level proof that each Services path proves the captured
        // connection around both scope negotiation and the transport response.
        let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/content.rs"))
            .expect("content.rs");
        for name in [
            "pub(crate) async fn services_request(",
            "pub(crate) async fn services_request_json(",
            "pub(crate) async fn services_request_with_chunk(",
        ] {
            let at = source.find(name).unwrap_or_else(|| panic!("{name} present"));
            let next = source[at + 10..]
                .find("pub(crate) async fn")
                .map(|offset| at + 10 + offset)
                .unwrap_or(source.len());
            let body = &source[at..next];
            let fences = body.matches("services_connection_current(state)?").count();
            assert_eq!(fences, 2, "{name} fences the captured epoch before and after");
            assert!(body.contains("self.require_scope_protocol(state).await?;"),
                "{name} negotiates the exact captured scope before transport");
            let awaits: Vec<_> = body.match_indices(".await?").map(|(at, _)| at).collect();
            let branching_read = name == "pub(crate) async fn services_request(";
            let chunk = name == "pub(crate) async fn services_request_with_chunk(";
            assert_eq!(awaits.len(), if branching_read {4} else if chunk {3} else {2},
                "{name} negotiates, freshly fences mutations, then sends one transport branch");
            assert!(body.contains(if branching_read || chunk {"self.source.prepare_mutation(state).await?"}
                else {"self.source.mutate(state, path, http_method, body).await?"}),
                "{name} never uses a retained read proof to authorize a mutation");
            if branching_read {
                assert!(body.contains("if http_method == reqwest::Method::GET"));
                assert!(body.contains("self.source.metadata_request(state, path).await?"));
            }
            let first = body.find("services_connection_current(state)?").expect("pre");
            let last = body.rfind("services_connection_current(state)?").expect("post");
            assert!(first < awaits[0] && awaits[0] < awaits[1] && *awaits.last().unwrap() < last,
                "{name} fences around scope negotiation and transport awaits");
        }
    }

    #[test]
    fn the_services_fence_reuses_the_captured_epoch_not_a_new_number() {
        let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/content.rs"))
            .expect("content.rs");
        let at = source.find("fn services_connection_current").expect("fence helper");
        let body = &source[at..at + 500];
        // It proves the captured owner AND the captured connection epoch.
        assert!(body.contains("verify_owner(state)?"), "owner is re-proved");
        assert!(body.contains("self.source.check(state)"), "the captured epoch is checked");
    }

    #[test]
    fn allowlist_accepts_canonical_operations() {
        assert!(resolve("services.discover", "GET", "/v1/services", &q(&[])).is_ok());
        assert!(resolve("materials.detailV1", "GET", "/v1/services/materials/assets/asset-1", &q(&[])).is_ok());
        assert!(resolve("materials.changes", "GET", "/v1/services/materials/changes", &q(&[("after", "m:1")])).is_ok());
        assert!(resolve("knowledge.registeredList", "GET", "/v1/services/knowledge/vaults/vault-1/notes",
            &q(&[("afterId", "note-1"), ("limit", "50")])).is_ok());
        assert!(resolve("presentation.open", "POST", "/v1/services/presentation/open", &q(&[])).is_ok());
    }

    #[test]
    fn knowledge_successor_has_exact_method_path_and_query_allowlist() {
        for (op, method, path, query) in [
            ("knowledge.createUnique", "POST", "/v1/services/knowledge/notes", q(&[])),
            ("knowledge.editing", "GET", "/v1/services/knowledge/notes/n/editing", q(&[("vault","v")])),
            ("knowledge.editingOpen", "POST", "/v1/services/knowledge/notes/n/editing", q(&[])),
            ("knowledge.editingSet", "PUT", "/v1/services/knowledge/notes/n/editing", q(&[])),
            ("knowledge.directories", "GET", "/v1/services/knowledge/vaults/v/directories", q(&[("afterPath","")])),
            ("knowledge.relations", "GET", "/v1/services/knowledge/notes/n/relations", q(&[("vault","v"),("after","cursor")])),
            ("knowledge.materialReferences", "GET", "/v1/services/knowledge/materials/a/references", q(&[("vault","v")])),
        ] {
            assert!(resolve(op,method,path,&query).is_ok(), "{op}");
            assert!(resolve(op,"DELETE",path,&query).is_err(), "{op} wrong method");
        }
        assert!(resolve("knowledge.editingOpen","PUT","/v1/services/knowledge/notes/n/editing",&q(&[])).is_err());
        assert!(resolve("knowledge.editingSet","PUT","/v1/services/knowledge/notes/n/editing",&q(&[("vault","v")])).is_err());
        assert!(resolve("knowledge.editingOpen","POST","/v1/services/knowledge/notes/n/editing",&q(&[("vault","v")])).is_err());
    }

    #[test]
    fn unknown_operation_is_refused_before_the_wire() {
        assert_eq!(
            resolve("materials.restore", "PATCH", "/v1/services/materials/assets/a", &q(&[])).err(),
            Some("SERVICES_OPERATION_NOT_ALLOWED"),
        );
        assert_eq!(
            resolve("no.such.op", "GET", "/v1/services", &q(&[])).err(),
            Some("SERVICES_OPERATION_NOT_ALLOWED"),
        );
    }

    #[test]
    fn wrong_method_for_a_known_operation_is_refused() {
        assert_eq!(
            resolve("services.discover", "POST", "/v1/services", &q(&[])).err(),
            Some("SERVICES_OPERATION_NOT_ALLOWED"),
        );
        assert_eq!(
            resolve("materials.metadataPatch", "GET", "/v1/services/materials/assets/a", &q(&[])).err(),
            Some("SERVICES_OPERATION_NOT_ALLOWED"),
        );
    }

    #[test]
    fn arbitrary_paths_outside_services_are_refused() {
        assert_eq!(
            resolve("services.discover", "GET", "/v1/hello", &q(&[])).err(),
            Some("SERVICES_PATH_NOT_ALLOWED"),
        );
        assert_eq!(
            resolve("services.discover", "GET", "/v1/assets", &q(&[])).err(),
            Some("SERVICES_PATH_NOT_ALLOWED"),
        );
        assert_eq!(
            resolve("services.discover", "GET", "https://evil.test/v1/services", &q(&[])).err(),
            Some("SERVICES_PATH_INVALID"),
        );
        assert_eq!(
            resolve("services.discover", "GET", "/v1/services/../../etc", &q(&[])).err(),
            Some("SERVICES_PATH_INVALID"),
        );
    }

    #[test]
    fn a_template_never_matches_a_different_depth() {
        // `/v1/services` must not be reachable with a wildcard appended.
        assert_eq!(
            resolve("services.discover", "GET", "/v1/services/extra", &q(&[])).err(),
            Some("SERVICES_PATH_NOT_ALLOWED"),
        );
        // An identifier segment must be a real identifier.
        assert_eq!(
            resolve("materials.detailV1", "GET", "/v1/services/materials/assets/", &q(&[])).err(),
            Some("SERVICES_PATH_NOT_ALLOWED"),
        );
        assert_eq!(
            resolve("materials.detailV1", "GET", "/v1/services/materials/assets/a/b", &q(&[])).err(),
            Some("SERVICES_PATH_NOT_ALLOWED"),
        );
    }

    #[test]
    fn credential_bearing_query_is_refused() {
        assert_eq!(
            resolve("search.unified", "GET", "/v1/services/search", &q(&[("token", "x")])).err(),
            Some("SERVICES_QUERY_CREDENTIAL_FORBIDDEN"),
        );
        assert_eq!(
            resolve("search.unified", "GET", "/v1/services/search", &q(&[("access_token", "x")])).err(),
            Some("SERVICES_QUERY_CREDENTIAL_FORBIDDEN"),
        );
        assert_eq!(
            resolve("search.unified", "GET", "/v1/services/search", &q(&[("cookie", "x")])).err(),
            Some("SERVICES_QUERY_CREDENTIAL_FORBIDDEN"),
        );
    }

    #[test]
    fn undeclared_query_keys_are_refused() {
        assert_eq!(
            resolve("services.discover", "GET", "/v1/services", &q(&[("q", "x")])).err(),
            Some("SERVICES_QUERY_NOT_ALLOWED"),
        );
        assert_eq!(
            resolve("materials.changes", "GET", "/v1/services/materials/changes", &q(&[("cursor", "c")])).err(),
            Some("SERVICES_QUERY_NOT_ALLOWED"),
        );
    }

    #[test]
    fn query_values_are_encoded() {
        let req = ServicesRequest {
            library: None, vault: None,
            instance: "d".into(), operation_id: "search.unified".into(), method: "GET".into(),
            path: "/v1/services/search".into(), query: q(&[("q", "a b&c")]), body: None, chunk: None,
        };
        assert_eq!(build_path(&req), "/v1/services/search?q=a%20b%26c");
    }

    #[test]
    fn empty_directory_after_path_is_present_and_skips_root() {
        let req = ServicesRequest {
            library: None, vault: None,
            instance: "A".into(), operation_id: "knowledge.directories".into(), method: "GET".into(),
            path: "/v1/services/knowledge/vaults/v/directories".into(), query: q(&[("afterPath","")]), body: None, chunk: None,
        };
        assert_eq!(build_path(&req), "/v1/services/knowledge/vaults/v/directories?afterPath=");
    }

    #[test]
    fn base64_decoder_round_trips_and_rejects_junk() {
        assert_eq!(decode_base64("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(decode_base64("YWJj").unwrap(), b"abc");
        assert!(decode_base64("!!!").is_err());
        assert!(decode_base64("a").is_err());
    }

    #[test]
    fn sha256_shape_is_checked() {
        assert!(looks_like_sha256(&"a".repeat(64)));
        assert!(!looks_like_sha256("short"));
        assert!(!looks_like_sha256(&"z".repeat(64)));
    }
}
