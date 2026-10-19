// LSH remote surface — the Mobile-side seam for the Desktop's authenticated
// LightSeek web surface (Issue #72, FINAL-INTEGRATION phase).
//
// Architecture (frozen): Mobile NEVER runs a second LightSeek and never holds
// DSH authority. The Desktop is the only Agent/session/runtime authority;
// Mobile renders its surface through the paired-device boundary.
//
// The accepted Desktop #166 contract (ef5c1b4):
//   1. source gate: the surface belongs to ONE named paired Desktop — one
//      retained capture proves the owner before and after every network call;
//   2. strict hello capability: `lshRemoteSurface === true` (absence/false =
//      unavailable, never guessed);
//   3. `GET /v1/lsh/remote/state` (Bearer) → exactly {granted, runtimeAvailable};
//      a device without the per-device LSH grant fails truthfully — the grant
//      lives in the Desktop UI and is NEVER self-granted from Mobile;
//   4. `POST /v1/lsh/remote/session` (Bearer) → the bounded session mint
//      {ref, expiresAtMs, bootstrapPath, carrierGeneration, origin,
//      gatewayGeneration}. The `ref` is a sensitive short-lived credential:
//      it is consumed HERE (the carrier performs the bootstrap GET), so it is
//      never logged, never persisted, and never sent to Mobile JS;
//   5. the loopback carrier (lsh_carrier) serves the unmodified official
//      surface at http://127.0.0.1:<ephemeral> over the pinned upstream;
//   6. the dedicated Android WebView shell opens that loopback origin.

use crate::lsh_carrier::{self, SessionMint};
use serde_json::{json, Value};

/// Bearer state probe: exactly {granted, runtimeAvailable} from the named
/// Desktop. Used for the AI page's permission-truth states (Phase 4).
#[tauri::command]
pub(crate) async fn lsh_surface_state(
    state: tauri::State<'_, crate::SharedState>,
    expected_instance: String,
) -> Result<Value, String> {
    let gateway = crate::content::expected_gateway(&state, &expected_instance)?;
    let hello = gateway.hello(&state).await?;
    if hello["capabilities"]["lshRemoteSurface"] != true {
        return Err("LSH_UNAVAILABLE".into());
    }
    let value = gateway.content_get(&state, "/v1/lsh/remote/state").await?;
    Ok(json!({
        "granted": value["granted"].as_bool().unwrap_or(false),
        "runtimeAvailable": value["runtimeAvailable"].as_bool().unwrap_or(false),
    }))
}

#[tauri::command]
pub(crate) async fn lsh_surface_bootstrap(
    state: tauri::State<'_, crate::SharedState>,
    expected_instance: String,
) -> Result<Value, String> {
    // ONE retained capture: the pinned gateway and the owner are the same
    // object. A mismatch (or an unpaired/empty owner) refuses before any
    // request leaves the device.
    let gateway = crate::content::expected_gateway(&state, &expected_instance)?;
    let hello = gateway.hello(&state).await?;
    // Strict capability gate: absence is never read as `true`.
    if hello["capabilities"]["lshRemoteSurface"] != true {
        return Err("LSH_UNAVAILABLE".into());
    }
    // Bearer state: the Desktop per-device LSH grant is authoritative. Mobile
    // never grants; an off grant fails truthfully and points at the Desktop
    // permission UI.
    let state_value = gateway.content_get(&state, "/v1/lsh/remote/state").await?;
    if state_value["granted"] != true {
        return Err("LSH_NOT_GRANTED".into());
    }
    if state_value["runtimeAvailable"] != true {
        // Retryable by design: the Desktop reports a busy/transitioning runtime
        // as 503-class errors; no infinite retry — one truthful refusal per tap.
        return Err("LSH_RUNTIME_UNAVAILABLE".into());
    }
    // Mint one short-lived session. The mint body contains the sensitive `ref`
    // plus the bootstrap path/origin/generations.
    let (status, mint_body) = gateway.lsh_session_mint(&state).await?;
    if !(200..300).contains(&status) {
        // The Desktop reports not-granted as 403 and busy/unavailable as
        // 503-class; map to the bounded truthful codes (no raw body leakage).
        if status == 403 {
            return Err("LSH_NOT_GRANTED".into());
        }
        return Err("LSH_RUNTIME_UNAVAILABLE".into());
    }
    let mint_value = mint_body;
    let mint = SessionMint::validate(&mint_value, crate::lsh_carrier::now_ms_pub())?;

    // Start (or replace) the loopback carrier. The bootstrap GET — which
    // consumes the `ref` — happens inside the carrier over the SAME pinned
    // authority; the ref and the upstream cookies never cross this boundary.
    let paired_base = gateway.paired_base().to_string();
    let pinned_fp = gateway.pinned_fingerprint().to_string();
    let handle = crate::lsh_carrier::start(paired_base, pinned_fp, mint).await?;

    Ok(json!({
        // The ONLY URL Mobile JS ever sees: the loopback carrier origin.
        "sessionUrl": handle.session_url,
        "expiresAtMs": handle.expires_at_ms,
        "carrierGeneration": handle.carrier_generation,
        "gatewayGeneration": handle.gateway_generation,
    }))
}

#[tauri::command]
pub(crate) async fn lsh_surface_open(
    state: tauri::State<'_, crate::SharedState>,
    session_url: String,
    owner_instance_id: String,
    title: String,
) -> Result<Value, String> {
    if session_url.is_empty() || owner_instance_id.is_empty() {
        return Err("LSH_SURFACE_DECLINED".into());
    }
    // The shell is launched only for a URL the bootstrap itself produced: the
    // Mobile-owned loopback carrier origin. Anything else (file/content/data/
    // javascript, LAN hosts, foreign origins) is refused at this boundary.
    if !is_loopback_session_url(&session_url) {
        return Err("LSH_SURFACE_DECLINED".into());
    }
    // The owner is RE-PROVEN at the native boundary: a stale A launch while B
    // is paired refuses before anything reaches the shell.
    crate::content::require_expected_source(&state, &owner_instance_id)?;
    // P1-F8: the URL and the lease must come from the SAME current carrier,
    // proven atomically under the carrier slot lock. A stale A URL after a B
    // bootstrap is refused here — it can neither launch nor carry B's lease.
    let lease = crate::lsh_carrier::claim_current_launch(&session_url)
        .ok_or("LSH_SURFACE_DECLINED")?;
    let title = sanitize_surface_title(&title);
    // P1-F4: the launched Activity carries its own carrier's lease; its destroy
    // retires the carrier only when the lease still matches (stale A cannot
    // stop a newer B). The lease never crosses this boundary.
    let lease_for_retire = lease.clone();
    let launched = tauri::async_runtime::spawn_blocking(move || {
        shell::open(&session_url, &owner_instance_id, &title, &lease)
    })
    .await;
    let opened = match launched {
        Ok(Ok(opened)) => opened,
        Ok(Err(e)) => {
            // P1-F5: a failed launch must not leave an authenticated carrier
            // running with no surface attached — retire exactly this lease.
            crate::lsh_carrier::retire_leased(&lease_for_retire);
            return Err(e);
        }
        Err(e) => {
            crate::lsh_carrier::retire_leased(&lease_for_retire);
            return Err(format!("lsh shell task: {e}"));
        }
    };
    if !opened {
        // P1-F9: the JNI launch reported no foreground Activity. Leaving the
        // authenticated carrier alive with no surface would be an invisible
        // control channel — retire exactly this lease and refuse.
        crate::lsh_carrier::retire_leased(&lease_for_retire);
        return Err("LSH_SURFACE_DECLINED".into());
    }
    Ok(json!({ "opened": opened }))
}

/// Strict loopback-origin check: only `http://127.0.0.1:<port>/…` (the
/// Mobile-owned carrier) qualifies as a launchable session URL.
pub(crate) fn is_loopback_session_url(raw: &str) -> bool {
    if raw.len() > 2048 {
        return false;
    }
    let rest = match raw.strip_prefix("http://") {
        Some(rest) => rest,
        None => return false,
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (h, p),
        None => (authority, ""),
    };
    host == "127.0.0.1"
        && !port.is_empty()
        && port.parse::<u16>().map(|p| p > 0).unwrap_or(false)
}

/// Bounded display title: control characters stripped, trimmed, length capped.
pub(crate) fn sanitize_surface_title(raw: &str) -> String {
    let cleaned: String = raw.chars().filter(|c| !c.is_control()).collect();
    let trimmed = cleaned.trim();
    if trimmed.chars().count() > MAX_SURFACE_TITLE_CHARS {
        trimmed.chars().take(MAX_SURFACE_TITLE_CHARS).collect()
    } else {
        trimmed.to_string()
    }
}

const MAX_SURFACE_TITLE_CHARS: usize = 64;

#[tauri::command]
pub(crate) async fn lsh_surface_stop() -> Result<Value, String> {
    crate::lsh_carrier::stop();
    Ok(json!({ "stopped": true }))
}

#[cfg(target_os = "android")]
mod shell {
    use jni::objects::{GlobalRef, JObject, JValue};
    use jni::{JNIEnv, JavaVM};
    use std::sync::OnceLock;

    static VM: OnceLock<JavaVM> = OnceLock::new();
    static BRIDGE_CLASS: OnceLock<GlobalRef> = OnceLock::new();

    #[no_mangle]
    pub extern "system" fn Java_com_luckyray_mobile_LshSurfaceBridge_nativeInit(
        env: JNIEnv,
        this: JObject,
    ) {
        if let Ok(vm) = env.get_java_vm() {
            let _ = VM.set(vm);
        }
        if let Ok(class) = env.get_object_class(&this) {
            if let Ok(g) = env.new_global_ref(class) {
                let _ = BRIDGE_CLASS.set(g);
            }
        }
    }

    /// P1-F4: retire the carrier bound to `lease` (Activity destroy path).
    #[no_mangle]
    pub extern "system" fn Java_com_luckyray_mobile_LshSurfaceBridge_nativeRetire(
        mut _env: JNIEnv,
        _class: JObject,
        lease: jni::objects::JString,
    ) {
        let lease: String = match env_string(&mut _env, lease) {
            Some(v) => v,
            None => return,
        };
        crate::lsh_carrier::retire_leased(&lease);
    }

    fn env_string(env: &mut JNIEnv, s: jni::objects::JString) -> Option<String> {
        env.get_string(&s).ok().map(|v| v.to_string_lossy().to_string())
    }

    /// Launch the shell; `false` maps to a truthful refusal upstream.
    pub fn open(session_url: &str, owner: &str, title: &str, lease: &str) -> Result<bool, String> {
        let vm = VM.get().ok_or("JVM not attached (LshSurfaceBridge not initialized)")?;
        let mut env = vm.attach_current_thread().map_err(|e| format!("attach jvm: {e}"))?;
        let class: jni::objects::JClass = match BRIDGE_CLASS.get() {
            Some(g) => {
                let obj: JObject = unsafe { JObject::from_raw(g.as_raw()) };
                obj.into()
            }
            None => env
                .find_class("com/luckyray/mobile/LshSurfaceBridge")
                .map_err(|e| format!("find class: {e}"))?,
        };
        let jurl = env.new_string(session_url).map_err(|e| format!("url: {e}"))?;
        let jowner = env.new_string(owner).map_err(|e| format!("owner: {e}"))?;
        let jtitle = env.new_string(title).map_err(|e| format!("title: {e}"))?;
        let jlease = env.new_string(lease).map_err(|e| format!("lease: {e}"))?;
        let result = env
            .call_static_method(
                class,
                "open",
                "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Z",
                &[
                    JValue::Object(&jurl),
                    JValue::Object(&jowner),
                    JValue::Object(&jtitle),
                    JValue::Object(&jlease),
                ],
            )
            .map_err(|e| format!("call open: {e}"))?;
        Ok(result.z().unwrap_or(false))
    }
}

#[cfg(not(target_os = "android"))]
mod shell {
    // Desktop/dev builds have no Android shell; the caller surfaces this
    // truthfully instead of pretending the surface opened.
    pub fn open(_session_url: &str, _owner: &str, _title: &str, _lease: &str) -> Result<bool, String> {
        Err("LSH_SURFACE_UNSUPPORTED".into())
    }
}
