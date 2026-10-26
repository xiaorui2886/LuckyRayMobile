//! Actual pinned HTTPS and canonical validators. The loopback fixture is a
//! test-only transport target; the product hint parser rejects loopback.
use super::{contract::Owner, transport};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

#[derive(Clone, Copy)]
enum Plan {
    Good,
    OtherInstance,
    HelloRedirect,
    LargeHello,
    SessionDenied,
    WrongDevice,
    SlowHello,
}
struct Fixture {
    url: String,
    fp: String,
    auth: Arc<AtomicUsize>,
    requests: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}
fn instance() -> String {
    format!("desktop-{}", "a".repeat(32))
}
fn credential() -> String {
    format!("device-{}.{}", "b".repeat(32), "c".repeat(64))
}
fn owner(fp: &str) -> Owner {
    Owner {
        instance: instance(),
        fingerprint: fp.into(),
        base_url: "https://192.168.1.20:7303".into(),
        paired_at: "synthetic-time".into(),
        display_name: "Synthetic PC".into(),
    }
}

async fn fixture(plan: Plan, expired: bool) -> Fixture {
    let mut parameters = rcgen::CertificateParams::new(vec!["localhost".into()]).unwrap();
    if expired {
        parameters.not_before = rcgen::date_time_ymd(1999, 1, 1);
        parameters.not_after = rcgen::date_time_ymd(2000, 1, 1);
    }
    let key = rcgen::KeyPair::generate().unwrap();
    let cert = parameters.self_signed(&key).unwrap();
    let fp = crate::pinning::PinVerifier::fingerprint_bytes(cert.der())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(
        vec![cert.der().clone()],
        rustls::pki_types::PrivateKeyDer::Pkcs8(key.serialize_der().into()),
    )
    .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("https://{}", listener.local_addr().unwrap());
    let accept = tokio_rustls::TlsAcceptor::from(Arc::new(config));
    let auth = Arc::new(AtomicUsize::new(0));
    let requests = Arc::new(AtomicUsize::new(0));
    let a = auth.clone();
    let r = requests.clone();
    let f = fp.clone();
    let task = tokio::spawn(async move {
        loop {
            let Ok((socket, _)) = listener.accept().await else {
                break;
            };
            let Ok(mut socket) = accept.accept(socket).await else {
                continue;
            };
            let mut bytes = Vec::new();
            loop {
                let mut chunk = [0u8; 1024];
                match socket.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => bytes.extend_from_slice(&chunk[..n]),
                };
                if bytes.windows(4).any(|w| w == b"\r\n\r\n") || bytes.len() > 8192 {
                    break;
                }
            }
            if bytes.is_empty() {
                continue;
            }
            r.fetch_add(1, Ordering::SeqCst);
            let text = String::from_utf8_lossy(&bytes);
            let authenticated = text.to_ascii_lowercase().contains("authorization: bearer ");
            if authenticated {
                a.fetch_add(1, Ordering::SeqCst);
            }
            let hello = text.starts_with("GET /v1/hello ");
            let session = text.starts_with("GET /v1/session ");
            let (status, body) = if hello {
                if matches!(plan, Plan::SlowHello) {
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    continue;
                }
                if matches!(plan, Plan::HelloRedirect) {
                    (302, "{}".into())
                } else if matches!(plan, Plan::LargeHello) {
                    (200, "x".repeat(64 * 1024 + 1))
                } else {
                    (200,serde_json::json!({"protocolVersion":1,"instanceId":if matches!(plan,Plan::OtherInstance){format!("desktop-{}","d".repeat(32))}else{instance()},"certificateFingerprint":f,"displayName":"Synthetic PC","platform":"windows","appVersion":"synthetic","capabilities":{"pairing":true,"authenticatedEvents":true,"deviceRevocation":true,"runs":false}}).to_string())
                }
            } else if session && authenticated {
                if matches!(plan, Plan::SessionDenied) {
                    (401, "{\"code\":\"AUTH_REVOKED\"}".into())
                } else {
                    (200,serde_json::json!({"ok":true,"protocolVersion":1,"deviceId":if matches!(plan,Plan::WrongDevice){format!("device-{}","d".repeat(32))}else{format!("device-{}","b".repeat(32))},"deviceLabel":"Synthetic Phone"}).to_string())
                }
            } else {
                (404, "{}".into())
            };
            let location = if status == 302 {
                "Location: https://127.0.0.1:1/never-follow\r\n"
            } else {
                ""
            };
            let response=format!("HTTP/1.1 {status} Result\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{location}Connection: close\r\n\r\n{body}",body.len());
            let _ = socket.write_all(response.as_bytes()).await;
            let _ = socket.shutdown().await;
        }
    });
    Fixture {
        url,
        fp,
        auth,
        requests,
        task,
    }
}

#[tokio::test]
async fn same_pin_identity_then_original_session_is_real_https() {
    let f = fixture(Plan::Good, false).await;
    transport::verify(&owner(&f.fp), &f.url, &credential(), || Ok(()))
        .await
        .unwrap();
    assert_eq!(f.requests.load(Ordering::SeqCst), 2);
    assert_eq!(
        f.auth.load(Ordering::SeqCst),
        1,
        "hello must not carry Bearer"
    );
}
#[tokio::test]
async fn same_certificate_other_instance_never_receives_bearer() {
    let f = fixture(Plan::OtherInstance, false).await;
    assert_eq!(
        transport::verify(&owner(&f.fp), &f.url, &credential(), || Ok(()))
            .await
            .unwrap_err(),
        "ENDPOINT_INSTANCE_MISMATCH"
    );
    assert_eq!(f.auth.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn wrong_pin_and_expired_certificate_are_tls_failures_not_network_or_success() {
    let f = fixture(Plan::Good, false).await;
    assert_eq!(
        transport::verify(&owner(&"e".repeat(64)), &f.url, &credential(), || Ok(()))
            .await
            .unwrap_err(),
        "ENDPOINT_TLS_FAILED"
    );
    assert_eq!(f.auth.load(Ordering::SeqCst), 0);
    let f = fixture(Plan::Good, true).await;
    assert_eq!(
        transport::verify(&owner(&f.fp), &f.url, &credential(), || Ok(()))
            .await
            .unwrap_err(),
        "ENDPOINT_TLS_FAILED"
    );
    assert_eq!(f.auth.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn refused_socket_is_not_misreported_as_a_certificate_failure() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("https://{}", listener.local_addr().unwrap());
    drop(listener);
    assert_eq!(
        transport::verify(&owner(&"e".repeat(64)), &url, &credential(), || Ok(()))
            .await
            .unwrap_err(),
        "ENDPOINT_UNREACHABLE"
    );
}
#[tokio::test]
async fn redirects_and_oversized_hello_never_reach_session_or_send_bearer() {
    for (plan, expected) in [
        (Plan::HelloRedirect, "ENDPOINT_REDIRECT_DENIED"),
        (Plan::LargeHello, "ENDPOINT_RESPONSE_TOO_LARGE"),
    ] {
        let f = fixture(plan, false).await;
        assert_eq!(
            transport::verify(&owner(&f.fp), &f.url, &credential(), || Ok(()))
                .await
                .unwrap_err(),
            expected
        );
        assert_eq!(f.requests.load(Ordering::SeqCst), 1);
        assert_eq!(f.auth.load(Ordering::SeqCst), 0);
    }
}
#[tokio::test]
async fn current_credential_denied_and_wrong_device_are_not_recovered() {
    for (plan, expected) in [
        (Plan::SessionDenied, "ENDPOINT_AUTH_REJECTED"),
        (Plan::WrongDevice, "ENDPOINT_SESSION_MISMATCH"),
    ] {
        let f = fixture(plan, false).await;
        assert_eq!(
            transport::verify(&owner(&f.fp), &f.url, &credential(), || Ok(()))
                .await
                .unwrap_err(),
            expected
        );
        assert_eq!(f.auth.load(Ordering::SeqCst), 1);
    }
}
#[tokio::test]
async fn cancelled_or_changed_owner_after_hello_never_sends_credential() {
    for code in ["ENDPOINT_CANCELLED_OR_STALE", "ENDPOINT_SOURCE_CHANGED"] {
        let f = fixture(Plan::Good, false).await;
        let calls = AtomicUsize::new(0);
        assert_eq!(
            transport::verify(&owner(&f.fp), &f.url, &credential(), || {
                if calls.fetch_add(1, Ordering::SeqCst) > 0 {
                    Err(code)
                } else {
                    Ok(())
                }
            })
            .await
            .unwrap_err(),
            code
        );
        assert_eq!(f.auth.load(Ordering::SeqCst), 0);
    }
}
#[tokio::test]
async fn supplied_target_has_a_real_bounded_deadline() {
    let f = fixture(Plan::SlowHello, false).await;
    let start = std::time::Instant::now();
    assert_eq!(
        transport::verify(&owner(&f.fp), &f.url, &credential(), || Ok(()))
            .await
            .unwrap_err(),
        "ENDPOINT_TIMEOUT"
    );
    assert!(start.elapsed() < std::time::Duration::from_secs(18));
    assert_eq!(f.auth.load(Ordering::SeqCst), 0);
}
