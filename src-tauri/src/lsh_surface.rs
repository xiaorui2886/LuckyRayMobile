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
    // Cancel the actual asynchronous bootstrap work before the presentation
    // controller's longer deadline; do not leave an orphan future to replace
    // a later retry's carrier. This does not alter identity or TLS gates.
    let stage = std::sync::atomic::AtomicU8::new(0);
    tokio::time::timeout(std::time::Duration::from_secs(35), bootstrap_surface(state, expected_instance, &stage))
        .await.map_err(|_| format!("LSH_BOOTSTRAP_TIMEOUT:{}", bootstrap_stage_label(stage.load(std::sync::atomic::Ordering::Relaxed))))?
}

fn bootstrap_stage_label(stage: u8) -> &'static str {
    match stage { 1 => "hello", 2 => "state", 3 => "session_mint", 4 => "carrier_bootstrap", _ => "source_gate" }
}

async fn bootstrap_surface(
    state: tauri::State<'_, crate::SharedState>,
    expected_instance: String,
    stage: &std::sync::atomic::AtomicU8,
) -> Result<Value, String> {
    // ONE retained capture: the pinned gateway and the owner are the same
    // object. A mismatch (or an unpaired/empty owner) refuses before any
    // request leaves the device.
    let gateway = crate::content::expected_gateway(&state, &expected_instance)?;
    stage.store(1, std::sync::atomic::Ordering::Relaxed);
    let hello = gateway.hello(&state).await?;
    // Strict capability gate: absence is never read as `true`.
    if hello["capabilities"]["lshRemoteSurface"] != true {
        return Err("LSH_UNAVAILABLE".into());
    }
    // Bearer state: the Desktop per-device LSH grant is authoritative. Mobile
    // never grants; an off grant fails truthfully and points at the Desktop
    // permission UI.
    stage.store(2, std::sync::atomic::Ordering::Relaxed);
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
    stage.store(3, std::sync::atomic::Ordering::Relaxed);
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
    stage.store(4, std::sync::atomic::Ordering::Relaxed);
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

/// Mobile tab presentation only. It does not create another LSH authority.
#[tauri::command]
pub(crate) async fn lsh_surface_embed(
    state: tauri::State<'_, crate::SharedState>,
    expected_instance: String,
    action: String,
    presentation_id: Option<String>,
    presentation_activation: Option<u64>,
    lifecycle_generation: Option<u64>,
    session_url: Option<String>,
    bounds: Option<Value>,
    dark: Option<bool>,
) -> Result<Value, String> {
    if expected_instance.is_empty() { return Err("CONTENT_SOURCE_CHANGED".into()); }
    if !matches!(action.as_str(), "open" | "layout" | "hide" | "close" | "back" | "status" | "suspend") {
        return Err("LSH_SURFACE_DECLINED".into());
    }
    // Closing/hiding old A is allowed after pairing moved to B, but Kotlin
    // matches its retained owner so it cannot close or hide B's surface.
    if action != "close" && action != "hide" {
        crate::content::require_expected_source(&state, &expected_instance)?;
    }
    // Cancel a completed bootstrap that never reached a WebView. Exact
    // unconsumed launch proof retires only that carrier, not a newer one.
    if action == "close" {
        if let Some(ref url) = session_url {
            if let Some(lease) = crate::lsh_carrier::claim_current_launch(url) {
                crate::lsh_carrier::retire_leased(&lease);
            }
            // This is an unused-bootstrap retirement, NOT a view close. A late
            // stale bootstrap must never close a newer view of the same owner.
            return Ok(json!({"opened": false, "visible": false, "ready": false, "canGoBack": false}));
        }
    }
    // Presentation fence is not authority: pairing, grant, origin and lease
    // checks still apply. Bind before blocking/JNI dispatch can be delayed.
    let presentation_id = presentation_id.filter(|id| !id.is_empty() && id.len() <= 64 && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'))
        .ok_or("LSH_PRESENTATION_INVALID")?;
    let presentation_activation = presentation_activation.filter(|value| *value > 0 && *value <= 9_007_199_254_740_991).ok_or("LSH_PRESENTATION_INVALID")?;
    let mut request = json!({"lifecycleGeneration": lifecycle_generation.unwrap_or(0), "presentationActivation": presentation_activation, "expectedInstance": expected_instance, "action": action, "presentationId": presentation_id, "dark": dark.unwrap_or(false)});
    let mut claimed_lease = None;
    if action == "open" || action == "layout" || action == "suspend" {
        let b = bounds.ok_or("LSH_SURFACE_BOUNDS_INVALID")?;
        for key in ["x", "y", "width", "height", "viewportWidth"] {
            let value = b.get(key).and_then(Value::as_f64).ok_or("LSH_SURFACE_BOUNDS_INVALID")?;
            if !value.is_finite() || value.abs() > 100_000.0 ||
                ((key == "width" || key == "height") && value < 0.0) ||
                (key == "viewportWidth" && value <= 0.0) {
                return Err("LSH_SURFACE_BOUNDS_INVALID".into());
            }
        }
        request["bounds"] = b;
    }
    if action == "open" {
        let url = session_url.ok_or("LSH_SURFACE_DECLINED")?;
        if !is_loopback_session_url(&url) { return Err("LSH_SURFACE_DECLINED".into()); }
        let lease = crate::lsh_carrier::claim_current_launch(&url).ok_or("LSH_SURFACE_DECLINED")?;
        request["sessionUrl"] = json!(url);
        request["lease"] = json!(lease);
        claimed_lease = Some(lease);
    }
    let result = tauri::async_runtime::spawn_blocking(move || shell::embedded(&request.to_string()))
        .await.map_err(|_| "LSH_EMBED_OUTCOME_UNKNOWN".to_string()).and_then(|v| v);
    if result.is_err() {
        if let Some(ref lease) = claimed_lease { crate::lsh_carrier::retire_leased(lease); }
    }
    result
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

    #[no_mangle]
    pub extern "system" fn Java_com_luckyray_mobile_LshSurfaceBridge_nativeIsLeaseCurrent(
        mut env: JNIEnv,
        _class: JObject,
        lease: jni::objects::JString,
    ) -> jni::sys::jboolean {
        match env_string(&mut env, lease) {
            Some(lease) if !lease.is_empty() && crate::lsh_carrier::current_lease().as_deref() == Some(lease.as_str()) => 1,
            _ => 0,
        }
    }

    fn env_string(env: &mut JNIEnv, s: jni::objects::JString) -> Option<String> {
        env.get_string(&s).ok().map(|v| v.to_string_lossy().to_string())
    }

    pub fn embedded(request: &str) -> Result<serde_json::Value, String> {
        let vm = VM.get().ok_or("JVM not attached (LshSurfaceBridge not initialized)")?;
        let mut env = vm.attach_current_thread().map_err(|_| "LSH_EMBED_JVM")?;
        let g = BRIDGE_CLASS.get().ok_or("LSH_EMBED_JVM")?;
        let obj: JObject = unsafe { JObject::from_raw(g.as_raw()) };
        let class: jni::objects::JClass = obj.into();
        let input = env.new_string(request).map_err(|_| "LSH_EMBED_JVM")?;
        let result = env.call_static_method(class, "embedded", "(Ljava/lang/String;)Ljava/lang/String;", &[JValue::Object(&input)])
            .map_err(|_| "LSH_EMBED_JVM")?.l().map_err(|_| "LSH_EMBED_JVM")?;
        let result = env_string(&mut env, jni::objects::JString::from(result)).ok_or("LSH_EMBED_JVM")?;
        let result: serde_json::Value = serde_json::from_str(&result).map_err(|_| "LSH_EMBED_INVALID_RESULT")?;
        if result.get("opened").is_none() {
            if let Some(error) = result.get("error").and_then(serde_json::Value::as_str) { return Err(error.to_owned()); }
        }
        Ok(result)
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
    pub fn embedded(_request: &str) -> Result<serde_json::Value, String> {
        Err("LSH_SURFACE_UNSUPPORTED".into())
    }
    // Desktop/dev builds have no Android shell; the caller surfaces this
    // truthfully instead of pretending the surface opened.
    pub fn open(_session_url: &str, _owner: &str, _title: &str, _lease: &str) -> Result<bool, String> {
        Err("LSH_SURFACE_UNSUPPORTED".into())
    }
}
