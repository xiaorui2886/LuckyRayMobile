// Equivalent secure storage for the M1 lab.
//
// Android: Android Keystore (AES-256-GCM, hardware-backed on supported devices)
// via a minimal Kotlin bridge (KeystoreBridge) + JNI. Stronghold itself cannot
// cross-compile from Windows for Android (libsodium configure needs a POSIX
// shell), so this platform-native alternative is verified here.
//
// Desktop/other: app-private file fallback (lab-only, documented as NOT
// production-grade).

#[cfg(target_os = "android")]
mod platform {
    use jni::objects::JValue;
    use jni::{JNIEnv, JavaVM};
    use std::sync::OnceLock;

    static VM: OnceLock<JavaVM> = OnceLock::new();
    // Cached reference to the KeystoreBridge Class. Native threads cannot
    // FindClass app classes under multidex; caching the Class from Kotlin's
    // init{} avoids the system classloader entirely.
    static KEYSTORE_CLASS: OnceLock<jni::objects::GlobalRef> = OnceLock::new();

    // Called from KeystoreBridge.init{} (Kotlin) on class load.
    // Kotlin `private external fun nativeInit()` is an INSTANCE method of the
    // singleton object, so JNI delivers the receiver as jobject (not jclass).
    #[no_mangle]
    pub extern "system" fn Java_com_luckyray_mobile_KeystoreBridge_nativeInit(
        env: JNIEnv,
        this: jni::objects::JObject,
    ) {
        if let Ok(vm) = env.get_java_vm() {
            let _ = VM.set(vm);
        }
        if let Ok(class) = env.get_object_class(&this) {
            if let Ok(g) = env.new_global_ref(class) {
                let _ = KEYSTORE_CLASS.set(g);
            }
        }
    }

    pub fn save_secret(key: &str, value: &str) -> Result<String, String> {
        call("saveSecret", Some(key), Some(value))
    }

    pub fn load_secret(key: &str) -> Result<Option<String>, String> {
        let out = call("loadSecret", Some(key), None)?;
        if out.is_empty() {
            Ok(None)
        } else {
            Ok(Some(out))
        }
    }

    pub fn delete_all_secrets() -> Result<String, String> {
        call("deleteAllSecrets", None, None)
    }

    fn call(method: &str, key: Option<&str>, value: Option<&str>) -> Result<String, String> {
        let vm = VM.get().ok_or("JVM not attached (KeystoreBridge not initialized)")?;
        let mut env = vm
            .attach_current_thread()
            .map_err(|e| format!("attach jvm: {e}"))?;
        let class: jni::objects::JClass = match KEYSTORE_CLASS.get() {
            Some(g) => {
                let obj: jni::objects::JObject = unsafe { jni::objects::JObject::from_raw(g.as_raw()) };
                obj.into()
            }
            None => env
                .find_class("com/luckyray/mobile/KeystoreBridge")
                .map_err(|e| format!("find class: {e}"))?,
        };
        let key_value = key
            .map(|input| env.new_string(input).map_err(|e| format!("new key string: {e}")))
            .transpose()?;
        let value_value = value
            .map(|input| env.new_string(input).map_err(|e| format!("new value string: {e}")))
            .transpose()?;
        let (sig, args): (&str, Vec<JValue>) = match (key_value.as_ref(), value_value.as_ref()) {
            (Some(key), Some(value)) => (
                "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
                vec![JValue::Object(key), JValue::Object(value)],
            ),
            (Some(key), None) => (
                "(Ljava/lang/String;)Ljava/lang/String;",
                vec![JValue::Object(key)],
            ),
            (None, None) => ("()Ljava/lang/String;", vec![]),
            (None, Some(_)) => return Err("keystore call missing key".into()),
        };
        let result = env
            .call_static_method(class, method, sig, &args)
            .map_err(|e| format!("call {method}: {e}"))?;
        let jobj = result.l().map_err(|e| format!("result: {e}"))?;
        let jstring: jni::objects::JString = jobj.into();
        let out: String = env
            .get_string(&jstring)
            .map_err(|e| format!("get string: {e}"))?
            .into();
        Ok(out)
    }
}

#[cfg(not(target_os = "android"))]
mod platform {
    // Lab-only fallback: app-private file. Documented as NOT production-grade.
    use std::path::PathBuf;
    use std::sync::OnceLock;

    pub fn save_secret(key: &str, value: &str) -> Result<String, String> {
        let path = store_path(key)?;
        if value.is_empty() {
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("delete: {e}")),
            }
            return Ok("ok".into());
        }
        std::fs::write(&path, value).map_err(|e| format!("write: {e}"))?;
        Ok("ok".into())
    }

    pub fn load_secret(key: &str) -> Result<Option<String>, String> {
        let path = store_path(key)?;
        match std::fs::read_to_string(&path) {
            Ok(v) if !v.is_empty() => Ok(Some(v)),
            Ok(_) => Ok(None),
            Err(_) => Ok(None),
        }
    }

    pub fn delete_all_secrets() -> Result<String, String> {
        let dir = DATA_DIR.get().ok_or("data dir not set")?;
        for entry in std::fs::read_dir(dir).map_err(|e| format!("list secure store: {e}"))? {
            let entry = entry.map_err(|e| format!("read secure store entry: {e}"))?;
            let name = entry.file_name();
            if name.to_string_lossy().starts_with("m1-secure-cred:") {
                std::fs::remove_file(entry.path()).map_err(|e| format!("delete secure store entry: {e}"))?;
            }
        }
        Ok("ok".into())
    }

    pub fn set_data_dir(dir: PathBuf) {
        let _ = DATA_DIR.set(dir);
    }

    static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

    fn store_path(key: &str) -> Result<PathBuf, String> {
        let dir = DATA_DIR.get().ok_or("data dir not set")?;
        Ok(dir.join(format!("m1-secure-{key}.txt")))
    }
}

pub use platform::{delete_all_secrets, load_secret, save_secret};

#[cfg(not(target_os = "android"))]
pub use platform::set_data_dir;
