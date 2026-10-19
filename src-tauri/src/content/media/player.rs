//! One opaque Android surface, bound to one native-owned media lease. JNI
//! snapshots actual rendered-first-frame metrics, never a poster or delayed JS.
use super::*;
use std::sync::Mutex as SyncMutex;
use tokio::sync::oneshot;

struct Session {
    token: String,
    url: String,
    lease: Arc<Lease>,
    cancelled: Arc<AtomicBool>,
    started: Instant,
    claimed: AtomicBool,
    frame: SyncMutex<Option<(u64, u64)>>,
    closed: SyncMutex<Option<oneshot::Sender<serde_json::Value>>>,
}
static CURRENT: SyncMutex<Option<Arc<Session>>> = SyncMutex::new(None);
#[cfg(target_os = "android")]
fn session(token: &str) -> Option<Arc<Session>> {
    CURRENT
        .lock()
        .ok()?
        .as_ref()
        .filter(|s| s.token == token)
        .cloned()
}
impl Session {
    fn check(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err("CONTENT_CANCELLED".into());
        }
        self.lease.check()
    }
    #[cfg(target_os = "android")]
    fn rendered(&self) {
        if self.check().is_err() {
            return;
        }
        let Ok(mut frame) = self.frame.lock() else {
            return;
        };
        if frame.is_none() {
            *frame = Some((
                self.started.elapsed().as_millis() as u64,
                self.lease.metrics()["remoteBytes"].as_u64().unwrap_or(0),
            ));
        }
    }
    fn finish(&self, position: i64, duration: i64, reason: i32, format: serde_json::Value) {
        let failure = self
            .check()
            .err()
            .filter(|code| code != "CONTENT_CANCELLED");
        self.lease.stop(); // retire bytes BEFORE completion crosses JNI/JS
        let mut result = self.lease.metrics();
        result["positionMs"] = position.max(0).into();
        result["durationMs"] = duration.max(0).into();
        let (name, code) = match reason {
            0 => ("back", None),
            1 => ("background", None),
            2 => ("ended", None),
            3 => ("unsupported", Some("MEDIA_CODEC_UNSUPPORTED")),
            4 => ("network", Some("MEDIA_NETWORK_FAILED")),
            6 => ("cancelled", None),
            7 => ("launchFailed", Some("MEDIA_NATIVE_UNAVAILABLE")),
            _ => ("playbackError", Some("MEDIA_PLAYBACK_FAILED")),
        };
        result["reason"] = name.into();
        if let Some(code) = code {
            result["errorCode"] = code.into();
        }
        if let Some(failure) = failure {
            result["errorCode"] = failure.into();
        }
        if let Ok(frame) = self.frame.lock() {
            if let Some((ms, bytes)) = *frame {
                result["firstFrameMs"] = ms.into();
                result["remoteBytesBeforeFirstFrame"] = bytes.into();
            }
        }
        result["format"] = format;
        if let Ok(mut sender) = self.closed.lock() {
            if let Some(sender) = sender.take() {
                let _ = sender.send(result);
            }
        }
    }
}
struct Guard(Arc<Session>);
impl Drop for Guard {
    fn drop(&mut self) {
        self.0.lease.stop();
        if let Ok(mut current) = CURRENT.lock() {
            if current.as_ref().is_some_and(|s| s.token == self.0.token) {
                *current = None;
            }
        }
    }
}
pub(in crate::content) fn supported() -> Result<(), String> {
    shell::supported()
}

pub(in crate::content) async fn play(
    grant: serde_json::Value,
    title: String,
    start_ms: u64,
    dark_mode: bool,
    cancelled: Arc<AtomicBool>,
    started: Instant,
) -> Result<serde_json::Value, String> {
    let token = grant["token"].as_str().ok_or("MEDIA_EXPIRED")?.to_string();
    let url = grant["url"].as_str().ok_or("MEDIA_EXPIRED")?.to_string();
    let lease = server()
        .await?
        .leases
        .lock()
        .await
        .get(&token)
        .cloned()
        .ok_or("MEDIA_EXPIRED")?;
    if !lease.mime.starts_with("video/") {
        release(&token).await;
        return Err("MEDIA_TYPE_UNSUPPORTED".into());
    }
    let (tx, mut rx) = oneshot::channel();
    let active = Arc::new(Session {
        token: token.clone(),
        url,
        lease,
        cancelled,
        started,
        claimed: AtomicBool::new(false),
        frame: SyncMutex::new(None),
        closed: SyncMutex::new(Some(tx)),
    });
    let accepted = {
        let mut current = CURRENT.lock().map_err(|_| "MEDIA_BUSY")?;
        if current.is_some() {
            false
        } else {
            *current = Some(active.clone());
            true
        }
    };
    if !accepted {
        release(&token).await;
        return Err("MEDIA_BUSY".into());
    }
    let _guard = Guard(active.clone());
    if let Err(error) = active.check() {
        release(&token).await;
        return Err(error);
    }
    let launch = active.clone();
    let opened = tokio::task::spawn_blocking(move || {
        shell::open(&launch.url, &title, &launch.token, start_ms, dark_mode)
    })
    .await;
    let launch_time = Instant::now();
    let mut forced_error = None;
    if !matches!(opened, Ok(Ok(true))) {
        active.finish(0, 0, 7, serde_json::json!({}));
    }
    let mut result = loop {
        tokio::select! {
            biased;
            result = &mut rx => break result.map_err(|_| "MEDIA_NATIVE_UNAVAILABLE"),
            _ = tokio::time::sleep(Duration::from_millis(100)) => {
                let invalid = active.check().err().or_else(|| {
                    if !active.claimed.load(Ordering::Acquire) && launch_time.elapsed() > Duration::from_secs(5) {Some("MEDIA_NATIVE_UNAVAILABLE".into())} else {None}
                });
                if let Some(error) = invalid {
                    forced_error = Some(error); active.lease.stop();
                    let stop = active.token.clone();
                    let _ = tokio::task::spawn_blocking(move || shell::close(&stop)).await;
                    break match tokio::time::timeout(Duration::from_secs(1), &mut rx).await {
                        Ok(Ok(value)) => Ok(value), _ => {active.finish(0, 0, 6, serde_json::json!({})); rx.await.map_err(|_| "MEDIA_NATIVE_UNAVAILABLE")}
                    };
                }
            }
        }
    }?;
    release(&token).await;
    if let Some(error) = forced_error {
        result["reason"] = "cancelled".into();
        if error != "CONTENT_CANCELLED" {
            result["errorCode"] = error.into();
        }
    }
    Ok(result)
}

#[cfg(target_os = "android")]
mod shell {
    use super::*;
    use jni::sys::{jboolean, jint, jlong};
    use jni::{
        objects::{GlobalRef, JClass, JObject, JString, JValue},
        JNIEnv, JavaVM,
    };
    use std::sync::OnceLock;
    static VM: OnceLock<JavaVM> = OnceLock::new();
    static CLASS: OnceLock<GlobalRef> = OnceLock::new();
    fn string(env: &mut JNIEnv, value: JString) -> Option<String> {
        env.get_string(&value)
            .ok()
            .map(|s| s.to_string_lossy().into_owned())
    }
    #[no_mangle]
    pub extern "system" fn Java_com_luckyray_mobile_MediaPlayerBridge_nativeInit(
        env: JNIEnv,
        this: JObject,
    ) {
        if let Ok(vm) = env.get_java_vm() {
            let _ = VM.set(vm);
        }
        if let Ok(class) = env.get_object_class(&this) {
            if let Ok(class) = env.new_global_ref(class) {
                let _ = CLASS.set(class);
            }
        }
    }
    #[no_mangle]
    pub extern "system" fn Java_com_luckyray_mobile_MediaPlayerBridge_nativeClaim(
        mut env: JNIEnv,
        _: JObject,
        token: JString,
        url: JString,
    ) -> jboolean {
        let (Some(token), Some(url)) = (string(&mut env, token), string(&mut env, url)) else {
            return 0;
        };
        session(&token).is_some_and(|s| {
            s.url == url && s.check().is_ok() && !s.claimed.swap(true, Ordering::AcqRel)
        }) as jboolean
    }
    #[no_mangle]
    pub extern "system" fn Java_com_luckyray_mobile_MediaPlayerBridge_nativeIsCurrent(
        mut env: JNIEnv,
        _: JObject,
        token: JString,
    ) -> jboolean {
        string(&mut env, token)
            .and_then(|t| session(&t))
            .is_some_and(|s| s.check().is_ok()) as jboolean
    }
    #[no_mangle]
    pub extern "system" fn Java_com_luckyray_mobile_MediaPlayerBridge_nativeFirstFrame(
        mut env: JNIEnv,
        _: JObject,
        token: JString,
    ) {
        if let Some(s) = string(&mut env, token).and_then(|t| session(&t)) {
            s.rendered();
        }
    }
    #[no_mangle]
    pub extern "system" fn Java_com_luckyray_mobile_MediaPlayerBridge_nativeClosed(
        mut env: JNIEnv,
        _: JObject,
        token: JString,
        position: jlong,
        duration: jlong,
        reason: jint,
        format: JString,
    ) {
        let Some(s) = string(&mut env, token).and_then(|t| session(&t)) else {
            return;
        };
        let format = string(&mut env, format)
            .filter(|f| f.len() <= 4096)
            .and_then(|f| serde_json::from_str(&f).ok())
            .filter(|f: &serde_json::Value| f.is_object())
            .unwrap_or(serde_json::json!({}));
        s.finish(position, duration, reason, format);
    }
    pub fn supported() -> Result<(), String> {
        if VM.get().is_some() && CLASS.get().is_some() {
            Ok(())
        } else {
            Err("MEDIA_NATIVE_UNAVAILABLE".into())
        }
    }
    pub fn open(url: &str, title: &str, token: &str, start: u64, dark_mode: bool) -> Result<bool, String> {
        let mut env = VM
            .get()
            .ok_or("MEDIA_NATIVE_UNAVAILABLE")?
            .attach_current_thread()
            .map_err(|_| "MEDIA_NATIVE_UNAVAILABLE")?;
        let class: JClass =
            unsafe { JObject::from_raw(CLASS.get().ok_or("MEDIA_NATIVE_UNAVAILABLE")?.as_raw()) }
                .into();
        let url = env
            .new_string(url)
            .map_err(|_| "MEDIA_NATIVE_UNAVAILABLE")?;
        let title = env
            .new_string(title)
            .map_err(|_| "MEDIA_NATIVE_UNAVAILABLE")?;
        let token = env
            .new_string(token)
            .map_err(|_| "MEDIA_NATIVE_UNAVAILABLE")?;
        let call = env.call_static_method(
            class,
            "open",
            "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;JZ)Z",
            &[
                JValue::Object(&url),
                JValue::Object(&title),
                JValue::Object(&token),
                JValue::Long(start as i64),
                JValue::Bool(dark_mode.into()),
            ],
        );
        if call.is_err() {
            let _ = env.exception_clear();
        }
        call.map_err(|_| "MEDIA_NATIVE_UNAVAILABLE".into())
            .map(|v| v.z().unwrap_or(false))
    }
    pub fn close(token: &str) -> Result<(), String> {
        let mut env = VM
            .get()
            .ok_or("MEDIA_NATIVE_UNAVAILABLE")?
            .attach_current_thread()
            .map_err(|_| "MEDIA_NATIVE_UNAVAILABLE")?;
        let class: JClass =
            unsafe { JObject::from_raw(CLASS.get().ok_or("MEDIA_NATIVE_UNAVAILABLE")?.as_raw()) }
                .into();
        let token = env
            .new_string(token)
            .map_err(|_| "MEDIA_NATIVE_UNAVAILABLE")?;
        let call = env.call_static_method(
            class,
            "close",
            "(Ljava/lang/String;)V",
            &[JValue::Object(&token)],
        );
        if call.is_err() {
            let _ = env.exception_clear();
        }
        call.map_err(|_| "MEDIA_NATIVE_UNAVAILABLE".into())
            .map(|_| ())
    }
}
#[cfg(not(target_os = "android"))]
mod shell {
    pub fn supported() -> Result<(), String> {
        Err("MEDIA_NATIVE_UNSUPPORTED".into())
    }
    pub fn open(_: &str, _: &str, _: &str, _: u64, _: bool) -> Result<bool, String> {
        Err("MEDIA_NATIVE_UNSUPPORTED".into())
    }
    pub fn close(_: &str) -> Result<(), String> {
        Ok(())
    }
}
