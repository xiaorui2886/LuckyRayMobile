// Device capability probes (Android platform bridge).
//
// gms_available(): the QR barcode plugin (tauri-plugin-barcode-scanner) builds
// on ML Kit, which requires Google Play Services. Devices without GMS (e.g.
// Chinese-market Xiaomi) have no ML Kit, so scan() hangs forever without a
// camera preview. We surface that upfront so pairing UI can tell the user to
// use file pairing instead of leaving a silent no-op.

#[cfg(target_os = "android")]
mod platform {
    use jni::{JNIEnv, JavaVM};
    use std::sync::OnceLock;

    static VM: OnceLock<JavaVM> = OnceLock::new();
    // Cached DeviceBridge Class reference (multidex-safe: native threads cannot
    // FindClass app classes, so cache from Kotlin init{}). DeviceBridge is also
    // kept by proguard-rules, so Rust can reliably reach its statics.
    static DEVICE_CLASS: OnceLock<jni::objects::GlobalRef> = OnceLock::new();

    #[no_mangle]
    pub extern "system" fn Java_com_luckyray_mobile_DeviceBridge_nativeInit(
        env: JNIEnv,
        this: jni::objects::JObject,
    ) {
        if let Ok(vm) = env.get_java_vm() {
            let _ = VM.set(vm);
        }
        if let Ok(class) = env.get_object_class(&this) {
            if let Ok(g) = env.new_global_ref(class) {
                let _ = DEVICE_CLASS.set(g);
            }
        }
    }

    fn call_device_static(name: &str, sig: &str, args: &[jni::objects::JValue]) -> bool {
        let Ok(vm) = VM.get().ok_or("JVM not attached (DeviceBridge not initialized)") else {
            return false;
        };
        let Ok(mut env) = vm.attach_current_thread() else {
            return false;
        };
        let class: jni::objects::JClass = match DEVICE_CLASS.get() {
            Some(g) => {
                let obj: jni::objects::JObject = unsafe { jni::objects::JObject::from_raw(g.as_raw()) };
                obj.into()
            }
            None => {
                let Ok(c) = env.find_class("com/luckyray/mobile/DeviceBridge") else {
                    return false;
                };
                c
            }
        };
        match env.call_static_method(class, name, sig, args) {
            Ok(_) => true,
            Err(_) => false,
        }
    }

    pub fn gms_available() -> bool {
        call_device_static("gmsAvailable", "()Z", &[])
    }

    /// INTERACTION-CLOSURE-R1: send the app task to the background (Android
    /// Home semantics) WITHOUT finishing the activity or killing the process.
    /// The web layer calls this when Android Back fires at the Home root with
    /// nothing left to dismiss. Never touches insets/IME/pairing.
    pub fn move_task_to_back() -> bool {
        call_device_static("moveTaskToBack", "()V", &[])
    }

    /// INTERACTION-CLOSURE-R1: system-bar visual appearance only.
    pub fn set_system_bar_appearance(dark: bool) -> bool {
        call_device_static("setSystemBarAppearance", "(Z)V", &[dark.into()])
    }
}

#[cfg(not(target_os = "android"))]
mod platform {
    // Desktop/dev: GMS is irrelevant; report true so the scan path is exercised.
    pub fn gms_available() -> bool {
        true
    }
    // Desktop/dev: no Android task to background; report handled so callers do
    // not fall through to destructive alternatives.
    pub fn move_task_to_back() -> bool {
        true
    }
    pub fn set_system_bar_appearance(_dark: bool) -> bool {
        true
    }
}

pub fn gms_available() -> bool {
    platform::gms_available()
}

pub fn move_task_to_back() -> bool {
    platform::move_task_to_back()
}

pub fn set_system_bar_appearance(dark: bool) -> bool {
    platform::set_system_bar_appearance(dark)
}
