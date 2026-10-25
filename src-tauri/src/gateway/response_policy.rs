//! Bounded, non-sensitive transport metadata. No paths, contents, or credentials.
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
static REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static FAILURE_TRACES: AtomicU64 = AtomicU64::new(0);
pub(crate) fn qa_failure(operation: &str, status: u16, body: &Value) {
    if option_env!("VITE_LR_KNOWLEDGE_DIAGNOSTICS") != Some("1") || FAILURE_TRACES.fetch_add(1,Ordering::Relaxed)>=128 {return;}
    println!("[LR-SCOPE-DIAG] {}",failure_metadata(operation,status,body));
}
fn failure_metadata(operation: &str, status: u16, body: &Value) -> Value {
    let operation=match operation {"/v1/services/libraries"=>"library-catalog","/v1/services"=>"services-discover","/v1/capabilities"=>"capabilities",_=>"scoped-operation"};
    let safe=|key: &str|body[key].as_str().filter(|v|!v.is_empty()&&v.len()<=64&&v.bytes().all(|b|b.is_ascii_alphanumeric()||matches!(b,b'-'|b'_')));
    let code=match safe("code") {Some(code @ ("RATE_LIMITED"|"GRANT_REQUIRED"|"AUTH_REVOKED"|"PAIRING_REQUIRED"|"SCOPE_UNAVAILABLE"|"SCOPE_MISMATCH"|"SERVICE_UNAVAILABLE"|"gateway-request-invalid"))=>code,_=>"OTHER"};
    serde_json::json!({"operation":operation,"phase":"response","httpStatus":status,"code":code,
        "requestId":safe("requestId"),
        "diagnosticStage":safe("diagnosticStage").filter(|v|matches!(*v,"request-read"|"authenticate"|"scope-resolve"|"execute"|"response-commit")),
        "diagnosticReason":safe("diagnosticReason").filter(|v|matches!(*v,"rate-window"|"control-pending"|"transition-busy"|"transition-unavailable"|"database-unavailable"|"generation-retired"|"permission-changed")),
        "retryAfterMs":body["retryAfterMs"].as_u64()})
}
pub(super) fn request_id() -> String {
    let ticks=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
    format!("m-{ticks:x}-{:x}",REQUEST_SEQUENCE.fetch_add(1,Ordering::Relaxed))
}
pub(super) fn retry_after_ms(value: Option<&str>) -> Option<u64> {
    // Our companion sends delta-seconds. HTTP-date/invalid values deliberately
    // use the caller's bounded fallback, never a guessed clock adjustment.
    let value=value?.trim();
    if value.is_empty() || value.len()>16 || !value.bytes().all(|b|b.is_ascii_digit()) {return None;}
    value.parse::<u64>().ok()?.checked_mul(1000)
}
pub(crate) fn scope_marker(required: bool, status: u16, marker: Option<&str>, count: usize) -> Result<(), String> {
    if required && (200..400).contains(&status) && (count!=1 || marker!=Some("1")) {
        return Err("CONTENT_UPGRADE_REQUIRED".into());
    }
    Ok(())
}
pub(super) fn enrich_error(value: &mut Value, status: u16, request: &str, retry: Option<&str>, stage: Option<&str>, reason: Option<&str>) {
    if status<400 {return;}
    let Some(body)=value.as_object_mut() else {return;};
    body.insert("requestId".into(),request.into());
    if status==429 {if let Some(ms)=retry_after_ms(retry) {body.insert("retryAfterMs".into(),ms.into());}}
    if let Some(stage)=stage.filter(|s|matches!(*s,"request-read"|"authenticate"|"scope-resolve"|"execute"|"response-commit")) {body.insert("diagnosticStage".into(),stage.into());}
    if let Some(reason)=reason.filter(|s|matches!(*s,"rate-window"|"control-pending"|"transition-busy"|"transition-unavailable"|"database-unavailable"|"generation-retired"|"permission-changed")) {body.insert("diagnosticReason".into(),reason.into());}
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn qa_failure_metadata_excludes_paths_names_and_credentials() {
        let body=serde_json::json!({"code":"RATE_LIMITED","requestId":"m-synthetic-1","diagnosticStage":"execute","diagnosticReason":"rate-window","retryAfterMs":60000,"token":"fixture-secret","message":"private-note","library":"private-library"});
        let line=failure_metadata("/private/path",429,&body).to_string();
        for value in ["private","fixture-secret","message","token","library"] {assert!(!line.contains(value));}
        assert!(line.contains("m-synthetic-1"));assert!(line.contains("rate-window"));
    }
    #[test] fn scope_downgrade_rejects_success_and_304_before_body_use() {
        for status in [200,206,304] {for marker in [None,Some("0"),Some("2")] {assert!(scope_marker(true,status,marker,usize::from(marker.is_some())).is_err());}}
        assert!(scope_marker(true,200,Some("1"),2).is_err());
        assert!(scope_marker(true,200,Some("1"),1).is_ok());
        assert!(scope_marker(false,200,None,0).is_ok());
        assert!(scope_marker(true,403,None,0).is_ok());
    }
    #[test] fn retry_after_never_shortens_large_server_window() {
        assert_eq!(retry_after_ms(Some("31")),Some(31_000));
        assert_eq!(retry_after_ms(Some("60")),Some(60_000));
        assert_eq!(retry_after_ms(Some("0")),Some(0));
        for value in ["-1","1.2","Wed, 21 Oct 2026 07:28:00 GMT","99999999999999999",""] {assert_eq!(retry_after_ms(Some(value)),None);}
    }
    #[test] fn diagnostic_values_are_allowlisted_and_body_code_unchanged() {
        let mut body=serde_json::json!({"code":"RATE_LIMITED"});
        enrich_error(&mut body,429,"m-fixture",Some("60"),Some("execute"),Some("/private/secret"));
        assert_eq!(body["code"],"RATE_LIMITED");assert_eq!(body["retryAfterMs"],60_000);
        assert_eq!(body["diagnosticStage"],"execute");assert!(body.get("diagnosticReason").is_none());
    }
    #[test] fn ids_are_short_ascii_and_unique() {
        let a=request_id();let b=request_id();assert_ne!(a,b);assert!(a.len()<=64);
        assert!(a.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'||b==b'_'));
    }
}
