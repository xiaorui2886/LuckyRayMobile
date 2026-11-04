// Included by canvas_upstream's test module. Synthetic loopback HTTP fixtures
// exercise response handling, not certificate pinning or Android/WebView glue.
fn fixture(response: String) -> (Url, std::thread::JoinHandle<String>) {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let task = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let mut request = Vec::new();
        let mut byte = [0u8; 1];
        while !request.ends_with(b"\r\n\r\n") {
            assert_eq!(stream.read(&mut byte).unwrap(), 1);
            request.push(byte[0]);
            assert!(request.len() < 8192);
        }
        stream.write_all(response.as_bytes()).unwrap();
        String::from_utf8(request).unwrap()
    });
    (Url::parse(&format!("http://{address}/")).unwrap(), task)
}

fn reply(status: &str, content_type: &str, body: &str) -> String {
    format!("HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
}

fn fixture_upstream(origin: Url) -> CanvasUpstream {
    CanvasUpstream {
        client: Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(3)).build().unwrap(),
        origin,
        session: Zeroizing::new("a".repeat(64)),
    }
}

#[test]
fn ids_and_json_contract_reject_route_escapes_and_identity_changes() {
    for bad in ["", ".", "..", "a/b", "a\\b", "a?b", "a#b", "%2f", "a\n", "画布", "https://evil.test"] {
        assert!(canvas_load_path(bad).is_err(), "{bad}");
    }
    assert!(canvas_load_path(&"a".repeat(129)).is_err());
    assert!(canvas_load_path(&"a".repeat(128)).is_ok());
    assert_eq!(canvas_load_path("canvas_A-1").unwrap(), "/canvas/api/v1/canvases/canvas_A-1");
    assert!(validate_document(br#"{"canvasId":"a","remoteProjectionVersion":1}"#, "a").is_ok());
    for body in [r#"{"canvasId":"b","remoteProjectionVersion":1}"#, r#"{"canvasId":"../a","remoteProjectionVersion":1}"#, r#"{"canvas_id":"a","remoteProjectionVersion":1}"#, r#"{"canvasId":"a","canvasId":"b","remoteProjectionVersion":1}"#, r#"{"canvasId":"a","remoteProjectionVersion":1} trailing"#, "null", "[]"] {
        assert!(validate_document(body.as_bytes(), "a").is_err(), "{body}");
    }
    assert!(validate_list(br#"{"canvases":[{"id":"a"},{"id":"b"}]}"#).is_ok());
    for body in [r#"{"canvases":[{"id":"a"},{"id":"a"}]}"#, r#"{"canvases":[{"id":"../x"}]}"#, r#"{"canvases":[{}]}"#, r#"{"canvases":null}"#, "{}", "<html>"] {
        assert!(validate_list(body.as_bytes()).is_err(), "{body}");
    }
}

#[test]
fn json_mime_allowlist_is_exact() {
    for good in ["application/json", "Application/JSON", "application/json; charset=utf-8", "application/json;charset=\"UTF-8\""] {
        assert!(json_content_type(good), "{good}");
    }
    for bad in ["", "text/html", "application/jsonp", "application/problem+json", "application/json, text/html", "application/json; charset=latin1", "application/json;", "application/json;charset=utf-8;charset=utf-8"] {
        assert!(!json_content_type(bad), "{bad}");
    }
}

#[tokio::test]
async fn load_is_get_to_fixed_path_with_private_header_and_matching_id() {
    let body = r#"{"canvasId":"canvas_A-1","remoteProjectionVersion":1,"nodes":[]}"#;
    let (origin, task) = fixture(reply("200 OK", "application/json", body));
    let received = fixture_upstream(origin).load("canvas_A-1").await.unwrap();
    assert_eq!(&received[..], body.as_bytes());
    let request = task.join().unwrap();
    assert!(request.starts_with("GET /canvas/api/v1/canvases/canvas_A-1 HTTP/1.1\r\n"));
    assert!(request.contains(&format!("x-luckyray-canvas-session: {}\r\n", "a".repeat(64))));
    assert!(!request.to_ascii_lowercase().contains("cookie:"));
    assert!(!request.to_ascii_lowercase().contains("authorization:"));
}

#[tokio::test]
async fn only_200_is_success_and_remote_error_bodies_never_escape() {
    for (status, expected) in [("201 Created", "CANVAS_SERVICE_UNAVAILABLE"), ("204 No Content", "CANVAS_SERVICE_UNAVAILABLE"), ("302 Found", "CANVAS_SERVICE_UNAVAILABLE"), ("401 Unauthorized", "CANVAS_SESSION_EXPIRED"), ("403 Forbidden", "CANVAS_SESSION_EXPIRED"), ("404 Not Found", "CANVAS_NOT_FOUND"), ("413 Content Too Large", "CANVAS_RESPONSE_TOO_LARGE"), ("500 Internal Server Error", "CANVAS_SERVICE_UNAVAILABLE")] {
        let (origin, task) = fixture(reply(status, "text/html", "private upstream diagnostics"));
        assert_eq!(fixture_upstream(origin).load("a").await.unwrap_err(), expected);
        task.join().unwrap();
    }
    let (origin, task) = fixture(reply("200 OK", "application/json", r#"{"canvasId":"other","remoteProjectionVersion":1}"#));
    assert_eq!(fixture_upstream(origin).load("a").await.unwrap_err(), "CANVAS_RESPONSE_INVALID");
    task.join().unwrap();
}

#[tokio::test]
async fn response_mime_encoding_and_declared_or_streamed_size_are_bounded() {
    let cases = [
        (reply("200 OK", "text/html", "{}"), "CANVAS_RESPONSE_INVALID"),
        ("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".into(), "CANVAS_RESPONSE_INVALID"),
        ("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".into(), "CANVAS_RESPONSE_INVALID"),
        ("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Encoding: gzip\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".into(), "CANVAS_RESPONSE_INVALID"),
        (reply("200 OK", "application/json", "12345"), "CANVAS_RESPONSE_TOO_LARGE"),
        ("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n3\r\n123\r\n2\r\n45\r\n0\r\n\r\n".into(), "CANVAS_RESPONSE_TOO_LARGE"),
    ];
    for (raw, expected) in cases {
        let (origin, task) = fixture(raw);
        let response = Client::builder().no_proxy().build().unwrap().get(origin).send().await.unwrap();
        assert_eq!(bounded_json_body(response, 4, false).await.unwrap_err(), expected);
        task.join().unwrap();
    }
    let (origin, task) = fixture(reply("200 OK", "application/json", "1234"));
    let response = Client::builder().no_proxy().build().unwrap().get(origin).send().await.unwrap();
    assert_eq!(&bounded_json_body(response, 4, true).await.unwrap()[..], b"1234");
    task.join().unwrap();
}

#[tokio::test]
async fn invalid_inputs_fail_before_network_and_redirects_are_not_followed() {
    let upstream = fixture_upstream(Url::parse("http://127.0.0.1:9/").unwrap());
    assert_eq!(upstream.load("../escape").await.unwrap_err(), "CANVAS_INVALID_ID");
    assert!(matches!(CanvasUpstream::bootstrap("invalid", &"a".repeat(64), Zeroizing::new("bad".into())).await,
        Err(error) if error == "CANVAS_BOOTSTRAP_INVALID"));
    assert!(matches!(CanvasUpstream::bootstrap("invalid", "not-a-fingerprint", Zeroizing::new("a".repeat(64))).await,
        Err(error) if error == "CANVAS_GATEWAY_INVALID"));
    let raw = "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:9/secret-leak\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into();
    let (origin, task) = fixture(raw);
    assert_eq!(fixture_upstream(origin).load("a").await.unwrap_err(), "CANVAS_SERVICE_UNAVAILABLE");
    task.join().unwrap();
}

#[tokio::test]
async fn list_returns_only_valid_json_with_unambiguous_ids() {
    let (origin, task) = fixture(reply("200 OK", "application/json", r#"{"canvases":[{"id":"a"}]}"#));
    assert!(fixture_upstream(origin).list().await.is_ok());
    assert!(task.join().unwrap().starts_with("GET /canvas/api/v1/canvases HTTP/1.1\r\n"));
    for body in ["<html>", r#"{"canvases":[{"id":"a"},{"id":"a"}]}"#] {
        let (origin, task) = fixture(reply("200 OK", "application/json", body));
        assert_eq!(fixture_upstream(origin).list().await.unwrap_err(), "CANVAS_RESPONSE_INVALID");
        task.join().unwrap();
    }
}

#[tokio::test]
async fn truncated_body_is_not_returned_as_partial_success() {
    let raw = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 20\r\nConnection: close\r\n\r\n{}".into();
    let (origin, task) = fixture(raw);
    let response = Client::builder().no_proxy().build().unwrap().get(origin).send().await.unwrap();
    assert_eq!(bounded_json_body(response, 32, false).await.unwrap_err(), "CANVAS_TRANSPORT_UNAVAILABLE");
    task.join().unwrap();
}

#[test]
fn assets_have_fixed_paths_and_path_specific_mime() {
    for path in ["/canvas/", "/canvas/index.html", "/canvas/luckyray-logo.png", "/canvas/assets/index-A_1.js", "/canvas/assets/font.woff2"] {
        assert!(valid_asset_path(path), "{path}");
    }
    for path in ["", "/canvas", "https://evil.test/canvas/", "//evil.test/canvas/", "/canvas//index.html", "/canvas/assets/", "/canvas/assets/.", "/canvas/assets/..", "/canvas/assets/../index.html", "/canvas/assets/a/b.js", "/canvas/assets/a\\b.js", "/canvas/assets/%2e%2e", "/canvas/assets/a%2f.js", "/canvas/assets/a.js?q=1", "/canvas/assets/a.js#x", "/canvas/assets/a.js\r\n", "/canvas/api/v1/canvases", "/assets/index.js"] {
        assert!(!valid_asset_path(path), "{path}");
    }
    assert!(!valid_asset_path(&format!("/canvas/assets/{}", "a".repeat(201))));
    for (path, mime, canonical) in [
        ("/canvas/", "text/html; charset=UTF-8", "text/html"),
        ("/canvas/index.html", "TEXT/HTML", "text/html"),
        ("/canvas/assets/a.js", "application/javascript", "application/javascript"),
        ("/canvas/assets/a.mjs", "text/javascript;charset=\"UTF-8\"", "text/javascript"),
        ("/canvas/assets/a.css", "text/css", "text/css"),
        ("/canvas/luckyray-logo.png", "image/png", "image/png"),
        ("/canvas/assets/a.svg", "image/svg+xml", "image/svg+xml"),
        ("/canvas/assets/a.woff2", "font/woff2", "font/woff2"),
    ] { assert_eq!(asset_content_type(path, mime), Some(canonical)); }
    for (path, mime) in [
        ("/canvas/assets/a.js", "text/html"),
        ("/canvas/", "application/json"),
        ("/canvas/assets/a.png", "text/javascript"),
        ("/canvas/assets/a.html", "text/html"),
        ("/canvas/assets/a.js", "application/octet-stream"),
        ("/canvas/assets/a.js", "text/javascript; charset=latin1"),
        ("/canvas/assets/a.js", "text/javascript; charset=utf-8; charset=utf-8"),
        ("/canvas/assets/a.js", "text/javascript, text/html"),
        ("/canvas/assets/a.js", "text/javascript;"),
    ] { assert_eq!(asset_content_type(path, mime), None, "{path} {mime}"); }
}

#[tokio::test]
async fn asset_get_returns_only_bytes_and_canonical_mime() {
    let (origin, task) = fixture(reply("200 OK", "text/javascript; charset=utf-8", "export default 1;"));
    let response = fixture_upstream(origin).asset("/canvas/assets/app-1.js").await.ok().unwrap();
    assert_eq!(&response.bytes[..], b"export default 1;");
    assert_eq!(response.content_type, "text/javascript");
    let request = task.join().unwrap();
    assert!(request.starts_with("GET /canvas/assets/app-1.js HTTP/1.1\r\n"));
    assert!(request.contains(&format!("x-luckyray-canvas-session: {}\r\n", "a".repeat(64))));
    assert!(!request.to_ascii_lowercase().contains("cookie:"));
    assert!(!request.to_ascii_lowercase().contains("authorization:"));
    let upstream = fixture_upstream(Url::parse("http://127.0.0.1:9/").unwrap());
    assert_eq!(upstream.asset("/canvas/assets/%2fsecret.js").await.err().unwrap(), "CANVAS_INVALID_ASSET");
}

#[tokio::test]
async fn asset_errors_redirects_and_html_fallback_are_rejected() {
    for (raw, expected) in [
        (reply("200 OK", "text/html", "<html>fallback</html>"), "CANVAS_RESPONSE_INVALID"),
        (reply("401 Unauthorized", "text/plain", "private error"), "CANVAS_SESSION_EXPIRED"),
        (reply("403 Forbidden", "text/plain", "private error"), "CANVAS_SESSION_EXPIRED"),
        (reply("404 Not Found", "text/plain", "private error"), "CANVAS_NOT_FOUND"),
        (reply("206 Partial Content", "text/javascript", "partial"), "CANVAS_SERVICE_UNAVAILABLE"),
        (reply("413 Payload Too Large", "text/plain", "private error"), "CANVAS_RESPONSE_TOO_LARGE"),
        ("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:9/leak\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(), "CANVAS_SERVICE_UNAVAILABLE"),
        (format!("HTTP/1.1 200 OK\r\nContent-Type: text/javascript\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", MAX_ASSET_BYTES + 1), "CANVAS_RESPONSE_TOO_LARGE"),
        ("HTTP/1.1 200 OK\r\nContent-Type: text/javascript\r\nContent-Encoding: gzip\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(), "CANVAS_RESPONSE_INVALID"),
        ("HTTP/1.1 200 OK\r\nContent-Type: text/javascript\r\nContent-Type: text/html\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(), "CANVAS_RESPONSE_INVALID"),
    ] {
        let (origin, task) = fixture(raw);
        assert_eq!(fixture_upstream(origin).asset("/canvas/assets/app.js").await.err().unwrap(), expected);
        task.join().unwrap();
    }
}


#[test]
fn load_requires_the_supported_safe_projection_not_legacy_canonical() {
    for body in [
        r#"{"canvasId":"a"}"#,
        r#"{"canvasId":"a","nodes":[{"src":"/Users/example/private.png"}]}"#,
        r#"{"canvasId":"a","remoteProjectionVersion":0}"#,
        r#"{"canvasId":"a","remoteProjectionVersion":2}"#,
        r#"{"canvasId":"a","remoteProjectionVersion":-1}"#,
        r#"{"canvasId":"a","remoteProjectionVersion":"1"}"#,
        r#"{"canvasId":"a","remoteProjectionVersion":true}"#,
        r#"{"canvasId":"a","remoteProjectionVersion":null}"#,
        r#"{"canvasId":"a","remoteProjectionVersion":1.0}"#,
        r#"{"canvasId":"a","remote_projection_version":1}"#,
        r#"{"canvasId":"a","remoteProjectionVersion":1,"remoteProjectionVersion":2}"#,
    ] {
        assert_eq!(validate_document(body.as_bytes(), "a").unwrap_err(), "CANVAS_RESPONSE_INVALID", "{body}");
    }
    assert!(validate_document(br#"{"canvasId":"a","remoteProjectionVersion":1,"nodes":[]}"#, "a").is_ok());
}

#[tokio::test]
async fn load_rejects_legacy_canonical_even_when_http_and_identity_match() {
    let (origin, task) = fixture(reply("200 OK", "application/json", r#"{"canvasId":"a","nodes":[]}"#));
    assert_eq!(fixture_upstream(origin).load("a").await.unwrap_err(), "CANVAS_RESPONSE_INVALID");
    task.join().unwrap();
}

#[test]
fn media_identity_and_single_range_are_strict() {
    assert!(valid_media_id(&"a".repeat(64)));
    for id in ["a".repeat(63), "A".repeat(64), format!("{}?x=1", "a".repeat(64)), "../file".into()] { assert!(!valid_media_id(&id)); }
    for (text, total, bounds) in [("bytes=1-3", 5, Some((1,3))), ("bytes=2-", 5, Some((2,4))), ("bytes=-2", 5, Some((3,4))), ("bytes=-10", 5, Some((0,4))), ("bytes=0-99", 5, Some((0,4))), ("bytes=5-", 5, None), ("bytes=0-", 0, None)] {
        assert_eq!(MediaRange::parse(text).unwrap().bounds(total), bounds);
    }
    for bad in ["", "bytes=", "bytes=-0", "bytes=3-2", "bytes=0-1,4-5", "bytes=+1-2", "bytes=0-1\r\nX: y", "bytes= 0-1", "BYTES=0-1", "bytes=18446744073709551616-", "bytes=1--2"] { assert!(MediaRange::parse(bad).is_none(), "{bad}"); }
    assert_eq!(MediaRange::parse("bytes=0001-0002").unwrap().header(), "bytes=1-2");
}

#[tokio::test]
async fn media_streams_and_forwards_only_canonical_range() {
    let id = "a".repeat(64);
    let raw = "HTTP/1.1 206 Partial Content\r\nContent-Type: video/mp4\r\nContent-Length: 3\r\nContent-Range: bytes 2-4/8\r\nConnection: close\r\n\r\nabc".into();
    let (origin, task) = fixture(raw);
    let mut media = fixture_upstream(origin).media(&id, Some("bytes=02-04")).await.ok().unwrap();
    assert_eq!(media.status, 206);
    assert_eq!(media.content_length, 3);
    assert_eq!(media.content_range.as_deref(), Some("bytes 2-4/8"));
    let mut body = Vec::new();
    while let Some(chunk) = media.chunk().await.unwrap() { body.extend_from_slice(&chunk); }
    assert_eq!(body, b"abc");
    let request = task.join().unwrap();
    assert!(request.starts_with(&format!("GET /canvas/media/{id} HTTP/1.1\r\n")));
    assert!(request.contains("range: bytes=2-4\r\n"));
    assert!(!request.contains("Cookie:"));
    assert!(!request.contains("Authorization:"));
}

#[tokio::test]
async fn media_rejects_bad_ranges_before_network_and_preserves_valid_416() {
    let upstream = fixture_upstream(Url::parse("http://127.0.0.1:9/").unwrap());
    assert_eq!(upstream.media("../secret", None).await.err().unwrap(), "CANVAS_INVALID_MEDIA");
    assert_eq!(upstream.media(&"a".repeat(64), Some("bytes=0-1,4-5")).await.err().unwrap(), "CANVAS_RANGE_INVALID");
    let raw = "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Length: 0\r\nContent-Range: bytes */8\r\nConnection: close\r\n\r\n".into();
    let (origin, task) = fixture(raw);
    let mut media = fixture_upstream(origin).media(&"a".repeat(64), Some("bytes=8-")).await.ok().unwrap();
    assert_eq!(media.status, 416);
    assert_eq!(media.content_range.as_deref(), Some("bytes */8"));
    assert!(media.chunk().await.unwrap().is_none());
    task.join().unwrap();
}

#[tokio::test]
async fn media_rejects_html_redirects_inconsistent_or_unbounded_responses() {
    let cases = [
        (reply("200 OK", "text/html", "abc"), None),
        (reply("200 OK", "video/mp4", "abc"), Some("bytes=0-2")),
        (reply("302 Found", "video/mp4", "abc"), None),
        ("HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nConnection: close\r\n\r\nabc".into(), None),
        (format!("HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", MAX_MEDIA_BYTES + 1), None),
        ("HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: 0\r\nContent-Encoding: gzip\r\nConnection: close\r\n\r\n".into(), None),
        ("HTTP/1.1 206 Partial Content\r\nContent-Type: video/mp4\r\nContent-Length: 3\r\nContent-Range: bytes 2-4/8\r\nConnection: close\r\n\r\nabc".into(), Some("bytes=1-3")),
        ("HTTP/1.1 206 Partial Content\r\nContent-Type: video/mp4\r\nContent-Length: 2\r\nContent-Range: bytes 2-4/8\r\nConnection: close\r\n\r\nab".into(), Some("bytes=2-4")),
        ("HTTP/1.1 206 Partial Content\r\nContent-Type: video/mp4\r\nContent-Length: 3\r\nContent-Range: bytes 2-4/*\r\nConnection: close\r\n\r\nabc".into(), Some("bytes=2-4")),
        ("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Length: 0\r\nContent-Range: bytes */8\r\nConnection: close\r\n\r\n".into(), Some("bytes=0-2")),
    ];
    for (raw, range) in cases {
        let (origin, task) = fixture(raw);
        assert!(fixture_upstream(origin).media(&"a".repeat(64), range).await.is_err());
        task.join().unwrap();
    }
}

#[tokio::test]
async fn truncated_media_never_finishes_as_success() {
    let raw = "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 5\r\nConnection: close\r\n\r\nabc".into();
    let (origin, task) = fixture(raw);
    let mut media = fixture_upstream(origin).media(&"a".repeat(64), None).await.ok().unwrap();
    loop {
        match media.chunk().await { Ok(Some(_)) => {}, Err(_) => break, Ok(None) => panic!("truncated media accepted") }
    }
    task.join().unwrap();
}
