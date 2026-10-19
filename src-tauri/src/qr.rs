// QR scanner bridge (Android): CameraX + bundled ML Kit barcode scanning.
//
// Bundled ML Kit (com.google.mlkit:barcode-scanning) ships the model in the APK
// and does NOT need Google Play Services — this is the no-GMS QR pairing path
// (tauri-plugin-barcode-scanner uses the unbundled play-services-mlkit-* variant
// and is unusable on GMS-less devices).
//
// Flow: scan() -> JNI scanStart() adds a full-screen CameraX preview over the
// WebView; result/error is written to a meta file; we poll it until done/error
// or timeout; cancel() tears the camera down. Same pattern as CaptureBridge.

#[cfg(target_os = "android")]
mod platform {
    use jni::objects::JValue;
    use jni::{JNIEnv, JavaVM};
    use std::sync::OnceLock;
    use std::time::{Duration, Instant};

    static VM: OnceLock<JavaVM> = OnceLock::new();
    static QR_CLASS: OnceLock<jni::objects::GlobalRef> = OnceLock::new();

    #[no_mangle]
    pub extern "system" fn Java_com_luckyray_mobile_QrScannerBridge_nativeInit(
        env: JNIEnv,
        this: jni::objects::JObject,
    ) {
        if let Ok(vm) = env.get_java_vm() {
            let _ = VM.set(vm);
        }
        if let Ok(class) = env.get_object_class(&this) {
            if let Ok(g) = env.new_global_ref(class) {
                let _ = QR_CLASS.set(g);
            }
        }
    }

    /// Call a static method returning a String; maps JNI errors to typed errors.
    fn call_string(method: &str, sig: &str, args: &[JValue]) -> Result<String, String> {
        let vm = VM.get().ok_or("JVM not attached (QrScannerBridge not initialized)")?;
        let mut env = vm
            .attach_current_thread()
            .map_err(|e| format!("attach jvm: {e}"))?;
        let class: jni::objects::JClass = match QR_CLASS.get() {
            Some(g) => {
                let obj: jni::objects::JObject = unsafe { jni::objects::JObject::from_raw(g.as_raw()) };
                obj.into()
            }
            None => env
                .find_class("com/luckyray/mobile/QrScannerBridge")
                .map_err(|e| format!("find class: {e}"))?,
        };
        let result = env
            .call_static_method(class, method, sig, args)
            .map_err(|e| format!("call {method}: {e}"))?;
        let jobj = result.l().map_err(|e| format!("result: {e}"))?;
        let jstring: jni::objects::JString = jobj.into();
        let out: String = env
            .get_string(&jstring)
            .map_err(|e| format!("get string: {e}"))?
            .into();
        Ok(out)
    }

    fn call_void(method: &str, sig: &str, args: &[JValue]) -> Result<(), String> {
        let vm = VM.get().ok_or("JVM not attached (QrScannerBridge not initialized)")?;
        let mut env = vm
            .attach_current_thread()
            .map_err(|e| format!("attach jvm: {e}"))?;
        let class: jni::objects::JClass = match QR_CLASS.get() {
            Some(g) => {
                let obj: jni::objects::JObject = unsafe { jni::objects::JObject::from_raw(g.as_raw()) };
                obj.into()
            }
            None => env
                .find_class("com/luckyray/mobile/QrScannerBridge")
                .map_err(|e| format!("find class: {e}"))?,
        };
        env.call_static_method(class, method, sig, args)
            .map_err(|e| format!("call {method}: {e}"))?;
        Ok(())
    }

    /// Start scanning. Returns immediately; result lands in a meta file.
    pub fn scan_start() -> Result<String, String> {
        call_string("scanStart", "()Ljava/lang/String;", &[])
    }

    pub fn scan_stop() -> Result<(), String> {
        call_void("scanStop", "()V", &[])
    }

    pub fn meta_path() -> Result<String, String> {
        call_string("metaPath", "()Ljava/lang/String;", &[])
    }

    /// Poll the meta file until status done/error or timeout. Returns
    /// Ok(content) on success, Err(msg) on error/timeout (caller surfaces it;
    /// the promise never hangs — camera is stopped on timeout).
    pub fn scan(timeout_ms: u64) -> Result<String, String> {
        let ref_id = scan_start()?;
        if ref_id.is_empty() {
            return Err("qr scanner already active or unavailable".into());
        }
        let meta = meta_path()?;
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            if let Ok(text) = std::fs::read_to_string(&meta) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                    match v["status"].as_str() {
                        Some("done") => {
                            let _ = scan_stop();
                            return Ok(v["content"].as_str().unwrap_or("").to_string());
                        }
                        Some("error") => {
                            let _ = scan_stop();
                            return Err(v["error"].as_str().unwrap_or("qr error").to_string());
                        }
                        _ => {}
                    }
                }
            }
            if Instant::now() >= deadline {
                let _ = scan_stop();
                return Err("qr scan timeout".into());
            }
            std::thread::sleep(Duration::from_millis(150));
        }
    }
}

#[cfg(not(target_os = "android"))]
mod platform {
    use std::path::PathBuf;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    static FAKE_META: Mutex<Option<PathBuf>> = Mutex::new(None);

    pub fn scan_stop() -> Result<(), String> {
        Ok(())
    }

    pub fn meta_path() -> Result<String, String> {
        let dir = std::env::temp_dir().join("luckyray-qr-fake");
        std::fs::create_dir_all(&dir).ok();
        let p = dir.join("qr-result.meta.json");
        *FAKE_META.lock().unwrap() = Some(p.clone());
        Ok(p.to_string_lossy().into_owned())
    }

    /// Desktop stub: poll a meta file if one was pre-seeded (tests), else
    /// return a fixture QR payload after a short delay (dev loop).
    pub fn scan(timeout_ms: u64) -> Result<String, String> {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            let seeded = FAKE_META.lock().unwrap().clone();
            if let Some(p) = seeded {
                if let Ok(text) = std::fs::read_to_string(&p) {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                        if v["status"] == "done" {
                            let _ = std::fs::remove_file(&p);
                            return Ok(v["content"].as_str().unwrap_or("").to_string());
                        }
                        if v["status"] == "error" {
                            let _ = std::fs::remove_file(&p);
                            return Err(v["error"].as_str().unwrap_or("qr error").to_string());
                        }
                    }
                }
            }
            if Instant::now() >= deadline {
                return Err("qr scan timeout".into());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

pub use platform::{scan, scan_stop};
