// SecureCredentialStore: cross-platform credential persistence.
// Android: Android Keystore (AES-256-GCM) via KeystoreBridge + JNI (keystore.rs).
// Desktop/other: app-private file fallback (lab/dev only).
// iOS: interface only — native Keychain implementation deferred to a macOS/Xcode stage.

use crate::keystore;

pub trait SecureCredentialStore: Send + Sync {
    fn save_desktop_credential(&self, instance_id: &str, credential: &str) -> Result<(), String>;
    fn load_desktop_credential(&self, instance_id: &str) -> Result<Option<String>, String>;
    fn delete_desktop_credential(&self, instance_id: &str) -> Result<(), String>;
    fn delete_all_desktop_credentials(&self) -> Result<(), String>;
}

pub struct SecureCredentialStoreImpl;

impl SecureCredentialStore for SecureCredentialStoreImpl {
    fn save_desktop_credential(&self, instance_id: &str, credential: &str) -> Result<(), String> {
        keystore::save_secret(&format!("cred:{instance_id}"), credential).map(|_| ())
    }

    fn load_desktop_credential(&self, instance_id: &str) -> Result<Option<String>, String> {
        keystore::load_secret(&format!("cred:{instance_id}"))
    }

    fn delete_desktop_credential(&self, instance_id: &str) -> Result<(), String> {
        keystore::save_secret(&format!("cred:{instance_id}"), "").map(|_| ())
    }

    fn delete_all_desktop_credentials(&self) -> Result<(), String> {
        keystore::delete_all_secrets().map(|_| ())
    }
}
