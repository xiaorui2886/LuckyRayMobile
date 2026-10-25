//! Connection-scoped protocol VERSION proof, never a catalog or permission cache.
//! Every business request still reaches the server's current authorization checks.
use serde_json::{json, Value};
use std::{collections::HashMap, future::Future, sync::{Arc, Mutex, OnceLock, Weak,
    atomic::{AtomicBool, AtomicU64, Ordering}}};
type Reply = Result<(u16, Value), String>;
type Flight = tokio::sync::OnceCell<Reply>;
const MAX_PROOFS: usize = 32;
struct Entry { owner: Weak<AtomicU64>, epoch: u64, flight: Arc<Flight>, retired: Arc<AtomicBool> }
static PROOFS: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();

/// Opaque length-delimited identity. Neither credentials nor authority names
/// are retained by the registry, diagnostics, or trace output.
pub(super) fn proof_key(runtime: usize, epoch: u64, instance: &str, base: &str, fingerprint: &str, credential: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut digest = Sha256::new();
    digest.update(b"scope-selection-v1");
    digest.update(runtime.to_le_bytes());
    digest.update(epoch.to_le_bytes());
    for value in [instance, base, fingerprint, credential] {
        digest.update((value.len() as u64).to_le_bytes());
        digest.update(value.as_bytes());
    }
    format!("{:x}", digest.finalize())
}

fn is_v1(result: &Reply) -> bool {
    matches!(result, Ok((200, value)) if value["scopeSelectionVersion"] == 1)
}
fn reusable(result: &Reply) -> bool {
    matches!(result, Ok((200, value)) if value["scopeSelectionVersion"] == 1 && value["reusableProofVersion"] == 1)
}
fn version_only(result: Reply) -> Reply {
    if reusable(&result) { Ok((200, json!({"scopeSelectionVersion":1,"reusableProofVersion":1}))) }
    else if is_v1(&result) { Ok((200, json!({"scopeSelectionVersion":1}))) } else { result }
}
pub(super) fn retire(key: &str) {
    if let Ok(mut proofs) = PROOFS.get_or_init(Default::default).lock() {
        if let Some(entry) = proofs.remove(key) { entry.retired.store(true, Ordering::SeqCst); }
    }
}
fn current(owner: &Arc<AtomicU64>, epoch: u64) -> Result<(), String> {
    if owner.load(Ordering::SeqCst) == epoch { Ok(()) } else { Err("CONTENT_SOURCE_CHANGED".into()) }
}
fn prune(proofs: &mut HashMap<String, Entry>) {
    proofs.retain(|_, entry| entry.owner.upgrade().is_some_and(|owner| owner.load(Ordering::SeqCst) == entry.epoch));
}
fn make_room(proofs: &mut HashMap<String, Entry>) -> bool {
    prune(proofs);
    if proofs.len() >= MAX_PROOFS {
        // Completed proofs are expendable. Never evict/cancel an active flight.
        if let Some(key) = proofs.iter().find(|(_, e)| e.flight.get().is_some()).map(|(k, _)| k.clone()) {
            proofs.remove(&key);
        }
    }
    proofs.len() < MAX_PROOFS
}

/// A fresh catalog/capability observation can seed or retire the VERSION proof.
/// No fields other than scopeSelectionVersion survive this call.
pub(super) fn observe(key: String, owner: &Arc<AtomicU64>, epoch: u64, status: u16, value: &Value) {
    let Ok(mut proofs) = PROOFS.get_or_init(Default::default).lock() else { return; };
    if let Some(entry) = proofs.remove(&key) { entry.retired.store(true, Ordering::SeqCst); }
    if current(owner, epoch).is_err() || status != 200 || value["scopeSelectionVersion"] != 1 || value["reusableProofVersion"] != 1 { return; }
    if make_room(&mut proofs) {
        let flight = Arc::new(Flight::new());
        let _ = flight.set(Ok((200, json!({"scopeSelectionVersion":1,"reusableProofVersion":1}))));
        proofs.insert(key, Entry { owner: Arc::downgrade(owner), epoch, flight, retired: Arc::new(AtomicBool::new(false)) });
    }
}

pub(super) async fn discover<F, Fut>(key: String, owner: &Arc<AtomicU64>, epoch: u64, mut read: F) -> Reply
where F: FnMut() -> Fut, Fut: Future<Output = Reply> {
    current(owner, epoch)?;
    let (flight, retired, joined) = {
        let mut proofs = PROOFS.get_or_init(Default::default).lock()
            .map_err(|_| "CONTENT_UNAVAILABLE".to_owned())?;
        prune(&mut proofs);
        // Weak owner identity prevents allocator-address reuse across runtimes.
        if let Some(entry) = proofs.get(&key).filter(|e| e.epoch == epoch && e.owner.ptr_eq(&Arc::downgrade(owner))) {
            (entry.flight.clone(), entry.retired.clone(), true)
        } else {
            let flight = Arc::new(Flight::new());
            let retired = Arc::new(AtomicBool::new(false));
            if !make_room(&mut proofs) { return Err("CONTENT_UNAVAILABLE".into()); }
            proofs.insert(key.clone(), Entry { owner: Arc::downgrade(owner), epoch, flight: flight.clone(), retired: retired.clone() });
            (flight, retired, false)
        }
    };
    // OnceCell transfers initialization if its leader is dropped. A cancelled
    // follower cannot cancel another caller's active probe.
    let result = flight.get_or_init(|| async { version_only(read().await) }).await.clone();
    current(owner, epoch)?;
    if retired.load(Ordering::SeqCst) { return Err("CONTENT_SOURCE_CHANGED".into()); }
    if !reusable(&result) {
        {
            let mut proofs = PROOFS.get_or_init(Default::default).lock().map_err(|_| "CONTENT_UNAVAILABLE")?;
            if proofs.get(&key).is_some_and(|e| Arc::ptr_eq(&e.flight, &flight)) { proofs.remove(&key); }
        }
        // Legacy/default-vault negotiation and failures are caller-local.
        if joined {
            let result=version_only(read().await);
            current(owner, epoch)?;
            if retired.load(Ordering::SeqCst) { return Err("CONTENT_SOURCE_CHANGED".into()); }
            return result;
        }
    }
    result
}

/// Only idempotent discovery GETs may retry an explicit transient server
/// response. Owner/connection/scope are re-proven around every await. A hard
/// deadline bounds the complete sequence, not 20 seconds per attempt.
pub(super) async fn read_with_retry<C, F, Fut>(check: C, read: F) -> Reply
where C: Fn() -> Result<(), String>, F: FnMut() -> Fut, Fut: Future<Output = Reply> {
    read_retry(check, read, false).await
}

/// Called only by a captured, already negotiated version-1 scoped metadata GET.
pub(super) async fn read_metadata_with_retry<C, F, Fut>(check: C, read: F) -> Reply
where C: Fn() -> Result<(), String>, F: FnMut() -> Fut, Fut: Future<Output = Reply> {
    read_retry(check, read, true).await
}

async fn read_retry<C, F, Fut>(check: C, mut read: F, content_allowed: bool) -> Reply
where C: Fn() -> Result<(), String>, F: FnMut() -> Fut, Fut: Future<Output = Reply> {
    let operation = async {
        for attempt in 0..3 {
            check()?;
            let result = read().await;
            check()?;
            let retry = matches!(&result, Ok((503, value)) if value["code"] == "SERVICE_UNAVAILABLE"
                || content_allowed && value["code"] == "CONTENT_UNAVAILABLE");
            if !retry || attempt == 2 { return result; }
            tokio::time::sleep(std::time::Duration::from_millis(if attempt == 0 { 60 } else { 160 })).await;
            check()?;
        }
        unreachable!("bounded discovery retry exits in the final attempt")
    };
    tokio::time::timeout(std::time::Duration::from_secs(20), operation).await
        .map_err(|_| "CONTENT_TIMEOUT".to_owned())?
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    fn owner() -> Arc<AtomicU64> { Arc::new(AtomicU64::new(0)) }
    fn v1() -> Reply { Ok((200,json!({"scopeSelectionVersion":1,"reusableProofVersion":1,"materials":[{"id":"not-a-grant"}]}))) }

    #[test]
    fn every_authority_dimension_is_in_the_opaque_protocol_key() {
        let baseline=proof_key(1,0,"instance","https://desktop","pin","synthetic-credential");
        let keys=[proof_key(2,0,"instance","https://desktop","pin","synthetic-credential"),
            proof_key(1,1,"instance","https://desktop","pin","synthetic-credential"),
            proof_key(1,0,"other","https://desktop","pin","synthetic-credential"),
            proof_key(1,0,"instance","https://other","pin","synthetic-credential"),
            proof_key(1,0,"instance","https://desktop","other","synthetic-credential"),
            proof_key(1,0,"instance","https://desktop","pin","other")];
        assert!(keys.iter().all(|key| key != &baseline));
        assert_eq!(baseline.len(),64); assert!(!baseline.contains("synthetic"));
    }

    #[tokio::test]
    async fn sequential_mixed_scopes_reuse_version_without_retaining_catalog_data() {
        let owner=owner(); let reads=AtomicUsize::new(0); let business=AtomicUsize::new(0);
        for scope in ["materials-a", "vault-b", "materials-c", "vault-d"] {
            let result=discover("mixed".into(),&owner,0,|| async {reads.fetch_add(1,Ordering::SeqCst);v1()}).await.unwrap();
            assert_eq!(result.1,json!({"scopeSelectionVersion":1,"reusableProofVersion":1}));
            // Proof reuse does not provide data or prevent each scoped request.
            assert!(!scope.is_empty()); business.fetch_add(1,Ordering::SeqCst);
        }
        assert_eq!(reads.load(Ordering::SeqCst),1);
        assert_eq!(business.load(Ordering::SeqCst),4);
    }
    #[tokio::test]
    async fn old_v1_without_opt_in_is_fresh_for_every_source() {
        let owner=owner();let reads=AtomicUsize::new(0);
        for _ in 0..3 { let result=discover("old-v1".into(),&owner,0,||async {
            reads.fetch_add(1,Ordering::SeqCst);Ok((200,json!({"scopeSelectionVersion":1,"materials":["private"]})))
        }).await.unwrap();assert_eq!(result.1,json!({"scopeSelectionVersion":1})); }
        assert_eq!(reads.load(Ordering::SeqCst),3);
    }
    #[tokio::test]
    async fn newer_catalog_downgrade_retires_an_already_pending_probe() {
        let owner=owner();let o=owner.clone();
        let (started_tx,started_rx)=tokio::sync::oneshot::channel();
        let (finish_tx,finish_rx)=tokio::sync::oneshot::channel();
        let task=tokio::spawn(async move {let mut start=Some(started_tx);let mut finish=Some(finish_rx);
            discover("pending-downgrade".into(),&o,0,|| {let rx=finish.take().unwrap();let _=start.take().unwrap().send(());async move {rx.await.unwrap();v1()}}).await
        });
        started_rx.await.unwrap();
        observe("pending-downgrade".into(),&owner,0,200,&json!({"scopeSelectionVersion":0}));
        finish_tx.send(()).unwrap();
        assert_eq!(task.await.unwrap().unwrap_err(),"CONTENT_SOURCE_CHANGED");
        let reads=AtomicUsize::new(0);
        discover("pending-downgrade".into(),&owner,0,||async {reads.fetch_add(1,Ordering::SeqCst);v1()}).await.unwrap();
        assert_eq!(reads.load(Ordering::SeqCst),1);
    }

    #[tokio::test]
    async fn overlapping_and_later_probes_share_one_version_read() {
        let owner=owner(); let reads=Arc::new(AtomicUsize::new(0));let mut tasks=Vec::new();
        for _ in 0..20 {let owner=owner.clone();let reads=reads.clone();tasks.push(tokio::spawn(async move {
            discover("overlap".into(),&owner,0,||async {reads.fetch_add(1,Ordering::SeqCst);tokio::time::sleep(std::time::Duration::from_millis(15)).await;v1()}).await
        }));}
        for task in tasks { assert_eq!(task.await.unwrap().unwrap().1,json!({"scopeSelectionVersion":1,"reusableProofVersion":1})); }
        discover("overlap".into(),&owner,0,||async {reads.fetch_add(1,Ordering::SeqCst);v1()}).await.unwrap();
        assert_eq!(reads.load(Ordering::SeqCst),1);
    }
    #[tokio::test]
    async fn epoch_and_runtime_identity_changes_require_fresh_proof() {
        let a=owner();let b=owner();let reads=AtomicUsize::new(0);
        for (runtime,epoch) in [(&a,0),(&b,0),(&a,1)] {
            runtime.store(epoch,Ordering::SeqCst);
            discover("same-opaque-key".into(),runtime,epoch,||async {reads.fetch_add(1,Ordering::SeqCst);v1()}).await.unwrap();
        }
        assert_eq!(reads.load(Ordering::SeqCst),3);
        assert_eq!(discover("same-opaque-key".into(),&a,0,||async {panic!("stale caller sent")}).await.unwrap_err(),"CONTENT_SOURCE_CHANGED");
    }
    #[tokio::test]
    async fn owner_change_during_probe_does_not_publish_old_success() {
        let owner=owner();
        let result=discover("epoch-during".into(),&owner,0,||async {owner.store(1,Ordering::SeqCst);v1()}).await;
        assert_eq!(result.unwrap_err(),"CONTENT_SOURCE_CHANGED");
        let count=AtomicUsize::new(0);
        discover("epoch-during".into(),&owner,1,||async {count.fetch_add(1,Ordering::SeqCst);v1()}).await.unwrap();
        assert_eq!(count.load(Ordering::SeqCst),1);
    }
    #[tokio::test]
    async fn legacy_and_errors_are_never_reused() {
        let owner=owner();
        for result in [Err("CONTENT_OFFLINE".into()),Ok((403,json!({"code":"SCOPE_DENIED"}))),Ok((200,json!({"scopeSelectionVersion":0}))),Ok((404,json!({})))] {
            let count=AtomicUsize::new(0);
            for _ in 0..3 {let _=discover("failure".into(),&owner,0,||async {count.fetch_add(1,Ordering::SeqCst);result.clone()}).await;}
            assert_eq!(count.load(Ordering::SeqCst),3);
        }
    }
    #[tokio::test]
    async fn cancelled_leader_transfers_initialization_and_cancelled_follower_does_not_cancel_leader() {
        let owner=owner();let (tx,rx)=tokio::sync::oneshot::channel();let o=owner.clone();
        let leader=tokio::spawn(async move {let mut tx=Some(tx);discover("cancel-leader".into(),&o,0,|| {if let Some(tx)=tx.take(){let _=tx.send(());} async {std::future::pending::<Reply>().await}}).await});
        rx.await.unwrap(); leader.abort();let _=leader.await;
        assert!(discover("cancel-leader".into(),&owner,0,||async {v1()}).await.is_ok());
        let (tx,rx)=tokio::sync::oneshot::channel();let o=owner.clone();
        let leader=tokio::spawn(async move {let mut tx=Some(tx);discover("cancel-follower".into(),&o,0,|| {if let Some(tx)=tx.take(){let _=tx.send(());} async {tokio::time::sleep(std::time::Duration::from_millis(30)).await;v1()}}).await});
        rx.await.unwrap();let o=owner.clone();
        let follower=tokio::spawn(async move {discover("cancel-follower".into(),&o,0,||async {panic!("follower must not replace active leader")}).await});
        tokio::task::yield_now().await;follower.abort();let _=follower.await;
        assert!(leader.await.unwrap().is_ok());
    }
    #[tokio::test]
    async fn fresh_catalog_invalidates_version_and_never_caches_its_data() {
        let owner=owner();let key="catalog".to_owned();
        observe(key.clone(),&owner,0,200,&json!({"scopeSelectionVersion":1,"reusableProofVersion":1,"knowledge":["private"]}));
        assert_eq!(discover(key.clone(),&owner,0,||async {panic!("catalog seeded version")}).await.unwrap().1,json!({"scopeSelectionVersion":1,"reusableProofVersion":1}));
        observe(key.clone(),&owner,0,200,&json!({"scopeSelectionVersion":0}));
        let count=AtomicUsize::new(0);
        discover(key,&owner,0,||async {count.fetch_add(1,Ordering::SeqCst);v1()}).await.unwrap();
        assert_eq!(count.load(Ordering::SeqCst),1);
    }
    #[test]
    fn registry_is_bounded_and_stale_epochs_are_pruned() {
        let owner=owner();let mut proofs=HashMap::new();
        for i in 0..MAX_PROOFS {proofs.insert(i.to_string(),Entry {owner:Arc::downgrade(&owner),epoch:0,flight:Arc::new(Flight::new()),retired:Arc::new(AtomicBool::new(false))});}
        assert!(!make_room(&mut proofs));assert_eq!(proofs.len(),MAX_PROOFS);
        owner.store(1,Ordering::SeqCst);assert!(make_room(&mut proofs));assert!(proofs.is_empty());
        for i in 0..MAX_PROOFS {let flight=Arc::new(Flight::new());flight.set(v1()).unwrap();proofs.insert(i.to_string(),Entry {owner:Arc::downgrade(&owner),epoch:1,flight,retired:Arc::new(AtomicBool::new(false))});}
        assert!(make_room(&mut proofs));assert_eq!(proofs.len(),MAX_PROOFS-1);
    }
    #[tokio::test]
    async fn transient_503_retries_bounded_but_denial_scope_and_transport_failures_do_not() {
        let count=AtomicUsize::new(0);
        let result=read_with_retry(||Ok(()), || async {
            let call=count.fetch_add(1,Ordering::SeqCst);
            Ok(if call < 2 {(503,serde_json::json!({"code":"SERVICE_UNAVAILABLE"}))}
                else {(200,serde_json::json!({"scopeSelectionVersion":1,"reusableProofVersion":1}))})
        }).await.unwrap();
        assert_eq!(result.0,200); assert_eq!(count.load(Ordering::SeqCst),3);
        for (status,code) in [(401,"PAIRING_REQUIRED"),(403,"SCOPE_DENIED"),(409,"SCOPE_MISMATCH"),(404,"ENTITY_NOT_FOUND"),(503,"DESKTOP_DRAFT_BUSY")] {
            let count=AtomicUsize::new(0);
            assert_eq!(read_with_retry(||Ok(()), || async { count.fetch_add(1,Ordering::SeqCst); Ok((status,serde_json::json!({"code":code}))) }).await.unwrap().0,status);
            assert_eq!(count.load(Ordering::SeqCst),1);
        }
        let count=AtomicUsize::new(0);
        assert!(read_with_retry(||Ok(()), || async {count.fetch_add(1,Ordering::SeqCst); Err("CONTENT_OFFLINE".into())}).await.is_err());
        assert_eq!(count.load(Ordering::SeqCst),1);
    }
    #[tokio::test]
    async fn changed_source_stops_before_another_wire_attempt() {
        let checks=AtomicUsize::new(0); let reads=AtomicUsize::new(0);
        let result=read_with_retry(|| {
            if checks.fetch_add(1,Ordering::SeqCst)>=1 {Err("CONTENT_SOURCE_CHANGED".into())} else {Ok(())}
        }, || async {reads.fetch_add(1,Ordering::SeqCst); Ok((503,serde_json::json!({"code":"SERVICE_UNAVAILABLE"})))}).await;
        assert_eq!(result.unwrap_err(),"CONTENT_SOURCE_CHANGED"); assert_eq!(reads.load(Ordering::SeqCst),1);
    }

    #[tokio::test]
    async fn metadata_get_recovers_content_contention_without_extending_discovery_vocabulary() {
        for metadata in [false,true] {
            let count=AtomicUsize::new(0);
            let read=|| async {
                let call=count.fetch_add(1,Ordering::SeqCst);
                Ok(if call==0 {(503,serde_json::json!({"code":"CONTENT_UNAVAILABLE"}))}
                    else {(200,serde_json::json!({"items":[]}))})
            };
            let result=if metadata {read_metadata_with_retry(||Ok(()),read).await}
                else {read_with_retry(||Ok(()),read).await}.unwrap();
            assert_eq!(result.0,if metadata {200} else {503});
            assert_eq!(count.load(Ordering::SeqCst),if metadata {2} else {1});
        }
    }

}
