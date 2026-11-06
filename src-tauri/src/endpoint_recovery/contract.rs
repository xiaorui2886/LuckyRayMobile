//! Address hints never carry new trust. This module holds no credentials.
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicU8, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

pub(super) const READY: u8 = 0;
pub(super) const VERIFYING: u8 = 1;
pub(super) const COMMITTING: u8 = 2;
pub(super) const APPLIED: u8 = 3;
pub(super) const CANCELLED: u8 = 4;
pub(super) const FAILED: u8 = 5;
const TTL: Duration = Duration::from_secs(120);

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Owner {
    pub instance: String,
    pub fingerprint: String,
    pub base_url: String,
    pub paired_at: String,
    pub display_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Hint {
    schema: u8,
    kind: String,
    base_url: String,
    desktop_instance_id: String,
    certificate_fingerprint: String,
}

pub(super) fn parse_hint(payload: &str, owner: &Owner) -> Result<String, &'static str> {
    if payload.len() > 4096 {
        return Err("ENDPOINT_HINT_INVALID");
    }
    let hint: Hint = serde_json::from_str(payload).map_err(|_| "ENDPOINT_HINT_INVALID")?;
    if hint.schema != 1
        || hint.kind != "luckyray.endpoint-recovery"
        || !hint
            .desktop_instance_id
            .strip_prefix("desktop-")
            .is_some_and(|s| crate::is_lower_hex(s, 32))
        || !crate::is_lower_hex(&hint.certificate_fingerprint, 64)
    {
        return Err("ENDPOINT_HINT_INVALID");
    }
    if hint.desktop_instance_id != owner.instance {
        return Err("ENDPOINT_INSTANCE_MISMATCH");
    }
    if hint.certificate_fingerprint != owner.fingerprint {
        return Err("ENDPOINT_PIN_MISMATCH");
    }
    // Parse the original authority BEFORE WHATWG URL normalization, so octal,
    // shorthand or integer IPv4 spellings cannot be silently adopted.
    let authority = hint
        .base_url
        .strip_prefix("https://")
        .ok_or("ENDPOINT_URL_INVALID")?;
    if authority.contains(['/', '?', '#', '@', '\\']) || authority.trim() != authority {
        return Err("ENDPOINT_URL_INVALID");
    }
    let (ip, port) = authority.split_once(':').ok_or("ENDPOINT_URL_INVALID")?;
    if !crate::is_private_lan_ipv4(ip)
        || port.is_empty()
        || !port.bytes().all(|b| b.is_ascii_digit())
    {
        return Err("ENDPOINT_URL_INVALID");
    }
    let port: u16 = port.parse().map_err(|_| "ENDPOINT_URL_INVALID")?;
    if port == 0 {
        return Err("ENDPOINT_URL_INVALID");
    }
    Ok(format!("https://{ip}:{port}"))
}

pub(crate) struct Prepared {
    pub id: String,
    pub owner: Owner,
    pub candidate: String,
    pub epoch: u64,
    pub state: AtomicU8,
    pub cancelled: tokio::sync::Notify,
    created: Instant,
}

impl Prepared {
    pub fn check(&self) -> Result<(), &'static str> {
        if self.created.elapsed() >= TTL {
            for stage in [READY, VERIFYING] {
                let _ = self.state.compare_exchange(
                    stage,
                    CANCELLED,
                    Ordering::SeqCst,
                    Ordering::SeqCst,
                );
            }
            return Err("ENDPOINT_PREPARE_EXPIRED");
        }
        if matches!(self.state.load(Ordering::SeqCst), READY | VERIFYING) {
            Ok(())
        } else {
            Err("ENDPOINT_CANCELLED_OR_STALE")
        }
    }
    pub fn start(&self) -> Result<(), &'static str> {
        self.check()?;
        self.state
            .compare_exchange(READY, VERIFYING, Ordering::SeqCst, Ordering::SeqCst)
            .map(|_| ())
            .map_err(|_| "ENDPOINT_CANCELLED_OR_STALE")
    }
    pub fn begin_commit(&self) -> Result<(), &'static str> {
        self.check()?;
        self.state
            .compare_exchange(VERIFYING, COMMITTING, Ordering::SeqCst, Ordering::SeqCst)
            .map(|_| ())
            .map_err(|_| "ENDPOINT_CANCELLED_OR_STALE")
    }
    pub fn fail(&self) {
        let _ = self
            .state
            .compare_exchange(VERIFYING, FAILED, Ordering::SeqCst, Ordering::SeqCst);
        let _ = self
            .state
            .compare_exchange(COMMITTING, FAILED, Ordering::SeqCst, Ordering::SeqCst);
    }
    pub fn applied(&self) {
        self.state.store(APPLIED, Ordering::SeqCst);
    }
    fn cancel(&self) -> &'static str {
        loop {
            let state = self.state.load(Ordering::SeqCst);
            match state {
                APPLIED => return "already_updated",
                COMMITTING => return "commit_in_progress",
                CANCELLED | FAILED => return "cancelled",
                _ => {
                    if self
                        .state
                        .compare_exchange(state, CANCELLED, Ordering::SeqCst, Ordering::SeqCst)
                        .is_ok()
                    {
                        self.cancelled.notify_one();
                        return "cancelled";
                    }
                }
            }
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Preview {
    pub prepare_id: String,
    pub current_base_url: String,
    pub candidate_base_url: String,
    pub display_name: String,
    pub fingerprint_summary: String,
    pub verification: &'static str,
}

#[derive(Default)]
pub(crate) struct RecoveryBook {
    current: Mutex<Option<Arc<Prepared>>>,
}
impl RecoveryBook {
    pub fn prepare(
        &self,
        payload: &str,
        owner: Owner,
        epoch: u64,
    ) -> Result<Preview, &'static str> {
        let candidate = parse_hint(payload, &owner)?;
        let mut slot = self
            .current
            .lock()
            .map_err(|_| "ENDPOINT_STATE_UNAVAILABLE")?;
        if let Some(previous) = slot.as_ref() {
            if previous.cancel() == "commit_in_progress" {
                return Err("ENDPOINT_UPDATE_BUSY");
            }
        }
        let id = uuid::Uuid::new_v4().to_string();
        let preview = Preview {
            prepare_id: id.clone(),
            current_base_url: owner.base_url.clone(),
            candidate_base_url: candidate.clone(),
            display_name: owner.display_name.clone(),
            fingerprint_summary: format!(
                "{}…{}",
                &owner.fingerprint[..8],
                &owner.fingerprint[60..]
            ),
            verification: "not_yet_verified",
        };
        *slot = Some(Arc::new(Prepared {
            id,
            owner,
            candidate,
            epoch,
            state: AtomicU8::new(READY),
            cancelled: tokio::sync::Notify::new(),
            created: Instant::now(),
        }));
        Ok(preview)
    }
    pub fn get(&self, id: &str) -> Result<Arc<Prepared>, &'static str> {
        if id.len() != 36 {
            return Err("ENDPOINT_CANCELLED_OR_STALE");
        }
        self.current
            .lock()
            .map_err(|_| "ENDPOINT_STATE_UNAVAILABLE")?
            .as_ref()
            .filter(|entry| entry.id == id)
            .cloned()
            .ok_or("ENDPOINT_CANCELLED_OR_STALE")
    }
    pub fn cancel(&self, id: &str) -> &'static str {
        self.get(id)
            .map(|entry| entry.cancel())
            .unwrap_or("not_found")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn owner() -> Owner {
        Owner {
            instance: format!("desktop-{}", "a".repeat(32)),
            fingerprint: "b".repeat(64),
            base_url: "https://192.168.1.20:7303".into(),
            paired_at: "2026-01-01".into(),
            display_name: "Synthetic Desktop".into(),
        }
    }
    fn hint(url: &str) -> String {
        serde_json::json!({"schema":1,"kind":"luckyray.endpoint-recovery","baseUrl":url,"desktopInstanceId":owner().instance,"certificateFingerprint":owner().fingerprint}).to_string()
    }
    #[test]
    fn original_identity_and_private_literal_only() {
        assert_eq!(
            parse_hint(&hint("https://192.168.1.20:12345"), &owner()).unwrap(),
            "https://192.168.1.20:12345"
        );
        for url in [
            "http://192.168.1.20:12345",
            "https://8.8.8.8:12345",
            "https://localhost:12345",
            "https://127.0.0.1:12345",
            "https://192.168.1.20:0",
            "https://192.168.1.20:65536",
            "https://192.168.1.20:12345/x",
            "https://user@192.168.1.20:12345",
            "https://192.168.1.20:12345#x",
            "https://192.168.1.20:12345?x",
            "https://010.0.0.1:12345",
            "https://3232235796:12345",
            "https://192.168.1.20:12345/",
        ] {
            assert_eq!(
                parse_hint(&hint(url), &owner()).unwrap_err(),
                "ENDPOINT_URL_INVALID",
                "{url}"
            );
        }
        let mut input: serde_json::Value =
            serde_json::from_str(&hint("https://192.168.1.20:12345")).unwrap();
        input["desktopInstanceId"] = format!("desktop-{}", "c".repeat(32)).into();
        assert_eq!(
            parse_hint(&input.to_string(), &owner()).unwrap_err(),
            "ENDPOINT_INSTANCE_MISMATCH"
        );
        input["desktopInstanceId"] = owner().instance.into();
        input["certificateFingerprint"] = "c".repeat(64).into();
        assert_eq!(
            parse_hint(&input.to_string(), &owner()).unwrap_err(),
            "ENDPOINT_PIN_MISMATCH"
        );
    }
    #[test]
    fn reject_pairing_secrets_unknown_fields_duplicates_and_oversize() {
        for key in ["secret", "credential", "fp", "v", "extra"] {
            let mut input: serde_json::Value =
                serde_json::from_str(&hint("https://192.168.1.20:12345")).unwrap();
            input[key] = "never-log-this".into();
            assert_eq!(
                parse_hint(&input.to_string(), &owner()).unwrap_err(),
                "ENDPOINT_HINT_INVALID"
            );
        }
        assert_eq!(
            parse_hint(&"x".repeat(4097), &owner()).unwrap_err(),
            "ENDPOINT_HINT_INVALID"
        );
        assert_eq!(
            parse_hint(
                &hint("https://192.168.1.20:12345").replacen("{", "{\"schema\":1,", 1),
                &owner()
            )
            .unwrap_err(),
            "ENDPOINT_HINT_INVALID"
        );
    }
    #[test]
    fn replacement_cancel_and_single_use_never_apply_late() {
        let book = RecoveryBook::default();
        let a = book
            .prepare(&hint("https://192.168.1.20:12345"), owner(), 5)
            .unwrap();
        let old = book.get(&a.prepare_id).unwrap();
        old.start().unwrap();
        let b = book
            .prepare(&hint("https://192.168.1.20:12346"), owner(), 5)
            .unwrap();
        assert!(old.begin_commit().is_err());
        assert!(book.get(&a.prepare_id).is_err());
        let current = book.get(&b.prepare_id).unwrap();
        current.start().unwrap();
        assert!(current.start().is_err());
        assert_eq!(book.cancel(&b.prepare_id), "cancelled");
        assert!(current.begin_commit().is_err());
    }
    #[test]
    fn commit_linearization_reports_truth_and_never_rolls_back_applied() {
        let book = RecoveryBook::default();
        let p = book
            .prepare(&hint("https://192.168.1.20:12345"), owner(), 5)
            .unwrap();
        let entry = book.get(&p.prepare_id).unwrap();
        entry.start().unwrap();
        entry.begin_commit().unwrap();
        assert_eq!(book.cancel(&p.prepare_id), "commit_in_progress");
        assert_eq!(
            book.prepare(&hint("https://192.168.1.20:12346"), owner(), 5)
                .err(),
            Some("ENDPOINT_UPDATE_BUSY")
        );
        entry.applied();
        assert_eq!(book.cancel(&p.prepare_id), "already_updated");
        assert!(entry.begin_commit().is_err());
    }
    #[test]
    fn expiry_and_failure_keep_old_owner_without_replay() {
        let mut entry = Prepared {
            id: uuid::Uuid::new_v4().to_string(),
            owner: owner(),
            candidate: "https://192.168.1.20:12345".into(),
            epoch: 7,
            state: AtomicU8::new(READY),
            cancelled: tokio::sync::Notify::new(),
            created: Instant::now() - TTL,
        };
        assert_eq!(entry.start().unwrap_err(), "ENDPOINT_PREPARE_EXPIRED");
        assert_eq!(entry.owner.base_url, owner().base_url);
        entry.created = Instant::now();
        entry.state.store(VERIFYING, Ordering::SeqCst);
        entry.fail();
        assert!(entry.begin_commit().is_err());
        entry.created = Instant::now() - TTL;
        entry.state.store(APPLIED, Ordering::SeqCst);
        assert!(entry.start().is_err());
        assert_eq!(entry.cancel(), "already_updated");
    }
}
