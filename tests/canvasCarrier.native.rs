fn parsed(path: &str, extra: &str) -> Zeroizing<Vec<u8>> {
    Zeroizing::new(format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:12345\r\n{extra}\r\n").into_bytes())
}

#[test]
fn headers_reject_smuggling_duplicate_auth_and_non_get() {
    for raw in [
        "POST /canvas/ HTTP/1.1\r\nHost: 127.0.0.1:12345\r\n\r\n",
        "GET /canvas/ HTTP/1.0\r\nHost: 127.0.0.1:12345\r\n\r\n",
        "GET http://evil.test/ HTTP/1.1\r\nHost: evil.test\r\n\r\n",
        "GET //evil.test/ HTTP/1.1\r\nHost: evil.test\r\n\r\n",
        "GET /canvas/ HTTP/1.1\r\nHost: a\r\nhost: b\r\n\r\n",
        "GET /canvas/ HTTP/1.1\r\nCookie: a\r\nCookie: b\r\n\r\n",
        "GET /canvas/ HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n",
        "GET /canvas/ HTTP/1.1\r\nContent-Length: 1\r\n\r\n",
        "GET /canvas/ HTTP/1.1\r\nUpgrade: websocket\r\n\r\n",
        "GET /canvas/ HTTP/1.1\r\n Folded: bad\r\n\r\n",
        "GET /canvas/ HTTP/1.1\r\nX: bad\nnew\r\n\r\n",
    ] { assert!(parse_request(raw.as_bytes()).is_err(), "{raw}"); }
    assert!(parse_request(&parsed("/canvas/", "Content-Length: 0\r\n")).is_ok());
    assert!(parse_request(&parsed("/canvas/", &format!("X: {}\r\n", "a".repeat(MAX_HEAD_BYTES)))).is_err());
}

#[test]
fn host_origin_and_fetch_metadata_are_exact() {
    for extra in ["", "Origin: http://127.0.0.1:12345\r\n", "Referer: http://127.0.0.1:12345/canvas/\r\nSec-Fetch-Site: same-origin\r\n"] {
        let head = parsed("/canvas/", extra);
        assert!(valid_origin(&parse_request(&head).unwrap(), "127.0.0.1:12345", "http://127.0.0.1:12345"));
    }
    for extra in ["Origin: null\r\n", "Origin: http://127.0.0.1:12346\r\n", "Origin: https://evil.test\r\n", "Referer: http://127.0.0.1:12345.evil.test/\r\n", "Sec-Fetch-Site: same-site\r\n", "Sec-Fetch-Site: cross-site\r\n"] {
        let head = parsed("/canvas/", extra);
        assert!(!valid_origin(&parse_request(&head).unwrap(), "127.0.0.1:12345", "http://127.0.0.1:12345"));
    }
    let head = parsed("/canvas/", "");
    assert!(!valid_origin(&parse_request(&head).unwrap(), "localhost:12345", "http://localhost:12345"));
}

#[test]
fn cookie_is_independent_and_duplicate_current_cookie_fails_closed() {
    let name = "luckyray_canvas_current";
    for cookie in ["luckyray_canvas_current=secret", "lsh_local_carrier=other; luckyray_canvas_old=old; luckyray_canvas_current=secret"] {
        let head = parsed("/canvas/", &format!("Cookie: {cookie}\r\n"));
        assert!(has_cookie(&parse_request(&head).unwrap(), name, "secret"));
    }
    for cookie in ["lsh_local_carrier=secret", "luckyray_canvas_old=secret", "luckyray_canvas_current=wrong", "luckyray_canvas_current=secret; luckyray_canvas_current=secret", "luckyray_canvas_current=secret; luckyray_canvas_current=wrong"] {
        let head = parsed("/canvas/", &format!("Cookie: {cookie}\r\n"));
        assert!(!has_cookie(&parse_request(&head).unwrap(), name, "secret"));
    }
}

#[test]
fn routes_are_read_only_with_fixed_detail_and_media_ids() {
    assert!(matches!(route("/canvas/"), Route::Asset("/canvas/")));
    assert!(matches!(route("/canvas/api/v1/canvases"), Route::List));
    assert!(matches!(route("/canvas/api/v1/canvases/canvas_A-1"), Route::Detail("canvas_A-1")));
    assert!(matches!(route("/assets/index-A.js"), Route::Alias(path) if path == "/canvas/assets/index-A.js"));
    assert!(matches!(route("/canvas/assets/index-A.js"), Route::Asset(_)));
    for path in ["/canvas/assets/../secret", "/assets/%2e%2e.js", "/assets/a/b.js", "/assets/a.js?x=1", "/assets/a.js#x", "/canvas/api/v1/canvases/a/submit", "/canvas/api/v1/canvases/%2f", "/v1/pair", "/api/conversations", "/__luckyray/carrier/launch", "https://evil.test"] {
        assert!(matches!(route(path), Route::Missing), "{path}");
    }
}

#[tokio::test]
async fn cancellation_is_retained_for_old_and_new_waiters() {
    let stop = Arc::new(Stop::new());
    let waiting = stop.clone();
    let task = tokio::spawn(async move { waiting.cancelled().await; });
    stop.cancel();
    assert!(stop.is_cancelled());
    tokio::time::timeout(Duration::from_secs(1), task).await.unwrap().unwrap();
    tokio::time::timeout(Duration::from_secs(1), stop.cancelled()).await.unwrap();
}


#[test]
fn media_route_never_accepts_paths_or_query_parameters() {
    let valid = format!("/canvas/media/{}", "a".repeat(64));
    assert!(matches!(route(&valid), Route::Media(id) if id == "a".repeat(64)));
    for path in [format!("{valid}?x=1"), format!("{valid}/other"), format!("/canvas/media/{}", "A".repeat(64)), "/canvas/media/%2fsecret".into()] {
        assert!(matches!(route(&path), Route::Missing));
    }
    let raw = parsed(&valid, "Range: bytes=1-2\r\n");
    assert_eq!(parse_request(&raw).unwrap().header("range"), Some("bytes=1-2"));
    let duplicate = parsed(&valid, "Range: bytes=1-2\r\nrange: bytes=4-5\r\n");
    assert!(parse_request(&duplicate).is_err());
}
