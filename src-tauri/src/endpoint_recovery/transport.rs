//! A single supplied target, pinned to the stored certificate. No discovery,
//! redirects, authority replacement, raw error output, or pairing requests.
use super::contract::Owner;
use crate::pinning::build_pinned_client_config;
use serde_json::Value;
use std::time::Duration;

const MAX_RESPONSE: usize = 64 * 1024;

fn failure(error: &reqwest::Error) -> &'static str {
    use std::error::Error;
    if error.is_timeout() {
        return "ENDPOINT_TIMEOUT";
    }
    let mut source: Option<&(dyn Error + 'static)> = Some(error);
    while let Some(value) = source {
        if value.downcast_ref::<rustls::Error>().is_some() {
            return "ENDPOINT_TLS_FAILED";
        }
        // std::io::Error::source() can skip the contained TLS error itself.
        // Inspect its typed payload rather than matching sensitive error text.
        source = value
            .downcast_ref::<std::io::Error>()
            .and_then(|io| io.get_ref().map(|inner| inner as &(dyn Error + 'static)))
            .or_else(|| value.source());
    }
    "ENDPOINT_UNREACHABLE"
}

async fn read_response(mut response: reqwest::Response) -> Result<Value, &'static str> {
    let status = response.status();
    if status.is_redirection() {
        return Err("ENDPOINT_REDIRECT_DENIED");
    }
    if matches!(status.as_u16(), 401 | 403) {
        return Err("ENDPOINT_AUTH_REJECTED");
    }
    if status.as_u16() == 404 || status.as_u16() == 426 {
        return Err("ENDPOINT_VERSION_UNSUPPORTED");
    }
    if status.as_u16() != 200 {
        return Err("ENDPOINT_SERVICE_UNAVAILABLE");
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_RESPONSE as u64)
    {
        return Err("ENDPOINT_RESPONSE_TOO_LARGE");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| failure(&e))? {
        if bytes.len() + chunk.len() > MAX_RESPONSE {
            return Err("ENDPOINT_RESPONSE_TOO_LARGE");
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "ENDPOINT_PROTOCOL_INVALID")
}

pub(super) async fn verify<F>(
    owner: &Owner,
    candidate: &str,
    credential: &str,
    active: F,
) -> Result<(), &'static str>
where
    F: Fn() -> Result<(), &'static str>,
{
    let config =
        build_pinned_client_config(&owner.fingerprint).map_err(|_| "ENDPOINT_PIN_MISMATCH")?;
    let client = reqwest::Client::builder()
        .use_preconfigured_tls(config)
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "ENDPOINT_STATE_UNAVAILABLE")?;
    let verify = async {
        active()?;
        // Existing credential is not sent until TLS and the complete hello
        // identity/protocol contract have both passed.
        let hello = read_response(
            client
                .get(format!("{candidate}/v1/hello"))
                .send()
                .await
                .map_err(|e| failure(&e))?,
        )
        .await?;
        active()?;
        // V1 hello uses instanceId; the recovery-envelope's field is named
        // desktopInstanceId. Do not confuse the two existing wire formats.
        if hello["instanceId"].as_str() != Some(owner.instance.as_str()) {
            return Err("ENDPOINT_INSTANCE_MISMATCH");
        }
        crate::validate_hello_identity(&hello, &owner.instance, &owner.fingerprint)
            .map_err(|_| "ENDPOINT_PROTOCOL_INVALID")?;
        let device = credential
            .split_once('.')
            .map(|p| p.0)
            .ok_or("ENDPOINT_CREDENTIAL_UNAVAILABLE")?;
        crate::validate_pair_response(
            &serde_json::json!({"protocolVersion":1,"deviceId":device,"credential":credential}),
        )
        .map_err(|_| "ENDPOINT_CREDENTIAL_UNAVAILABLE")?;
        active()?;
        let session = read_response(
            client
                .get(format!("{candidate}/v1/session"))
                .bearer_auth(credential)
                .send()
                .await
                .map_err(|e| failure(&e))?,
        )
        .await?;
        active()?;
        crate::validate_session_response(&session, device)
            .map_err(|_| "ENDPOINT_SESSION_MISMATCH")?;
        Ok(())
    };
    tokio::time::timeout(Duration::from_secs(15), verify)
        .await
        .map_err(|_| "ENDPOINT_TIMEOUT")?
}
