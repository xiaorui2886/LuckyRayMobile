// Synthetic host-only integration fixture, included by the focused Rust gate.
// Uses the actual extracted Source/ExpectedGateway implementations; AppState
// storage/pair capture are in-memory adapters, not Tauri or a production DB.
#[cfg(test)] mod source_wire_tests {
    use super::*;
    use tokio::io::{AsyncReadExt,AsyncWriteExt};
    use std::sync::atomic::{AtomicBool,AtomicUsize};
    struct Fixture {base:String,requests:Arc<Mutex<Vec<String>>>,modern:Arc<AtomicBool>,allow:Arc<AtomicBool>,switch_on_probe:Arc<Mutex<Option<Arc<AtomicU64>>>>,task:tokio::task::JoinHandle<()>}
    impl Drop for Fixture {fn drop(&mut self){self.task.abort();}}
    async fn fixture()->Fixture {
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let base=format!("http://{}",listener.local_addr().unwrap());
        let requests=Arc::new(Mutex::new(Vec::new()));let modern=Arc::new(AtomicBool::new(true));let allow=Arc::new(AtomicBool::new(true));
        let switch_on_probe=Arc::new(Mutex::new(None::<Arc<AtomicU64>>));
        let (r,m,a,switch)=(requests.clone(),modern.clone(),allow.clone(),switch_on_probe.clone());
        let task=tokio::spawn(async move {while let Ok((mut socket,_))=listener.accept().await {
            let mut buf=vec![0;16*1024];let n=socket.read(&mut buf).await.unwrap();let request=String::from_utf8_lossy(&buf[..n]).to_ascii_lowercase();r.lock().unwrap().push(request.clone());
            let probe=request.starts_with("get /v1/services/libraries ");
            if probe {if let Some(epoch)=switch.lock().unwrap().take() {epoch.fetch_add(1,Ordering::SeqCst);}}
            let modern=m.load(Ordering::SeqCst);let allowed=a.load(Ordering::SeqCst);
            let status=if !probe&&!allowed {403}else{200};
            let body=if probe {if modern {json!({"scopeSelectionVersion":1,"reusableProofVersion":1})} else {json!({"scopeSelectionVersion":0,"mode":"legacyDefaultOnly","authorizationMode":"legacy"})}}
                else if !allowed {json!({"code":"SCOPE_DENIED"})}
                else {json!({"items":["synthetic-scope-data"]})}.to_string();
            let marker=if !probe&&modern&&allowed {"X-LuckyRay-Scope-Protocol: 1\r\n"}else{""};
            let reply=format!("HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nContent-Type: application/json\r\n{marker}Connection: close\r\n\r\n{body}",body.len());
            let _=socket.write_all(reply.as_bytes()).await;
        }});
        Fixture{base,requests,modern,allow,switch_on_probe,task}
    }
    static INSTANCE:AtomicUsize=AtomicUsize::new(0);
    fn state(f:&Fixture)->SharedState {
        Arc::new(Mutex::new(AppState{connection_lifecycle:ConnectionLifecycle::new(),conn_intent:Intent,
            db:Mutex::new(Db{paired:Paired{instance_id:format!("synthetic-source-{}",INSTANCE.fetch_add(1,Ordering::SeqCst))}}),base:f.base.clone()}))
    }
    fn gateway(state:&SharedState,library:Option<&str>,vault:Option<&str>)->ExpectedGateway {
        ExpectedGateway{source:Source::capture(state).unwrap().scoped(library,vault).unwrap()}
    }
    fn count(f:&Fixture)->(usize,usize) {
        let requests=f.requests.lock().unwrap();let probe=requests.iter().filter(|r|r.starts_with("get /v1/services/libraries ")).count();(probe,requests.len()-probe)
    }
    #[tokio::test]
    async fn actual_source_mixed_scopes_keep_exact_headers_and_reduce_six_reads_to_four() {
        let f=fixture().await;let state=state(&f);
        for (library,vault) in [(Some("fixture-a"),None),(None,Some("fixture-vault-a")),(Some("fixture-b"),None)] {
            let result=gateway(&state,library,vault).services_request(&state,"GET","/v1/services/discovery",false,&Value::Null).await.unwrap();assert_eq!(result.0,200);
        }
        assert_eq!(count(&f),(1,3),"one version probe plus every authorized business read");
        let requests=f.requests.lock().unwrap();let business:Vec<_>=requests.iter().filter(|r|!r.starts_with("get /v1/services/libraries ")).collect();
        assert!(business[0].contains("x-luckyray-material-library: fixture-a"));assert!(!business[0].contains("x-luckyray-knowledge-vault:"));
        assert!(business[1].contains("x-luckyray-knowledge-vault: fixture-vault-a"));assert!(!business[1].contains("x-luckyray-material-library:"));
        assert!(business[2].contains("x-luckyray-material-library: fixture-b"));
    }
    #[tokio::test]
    async fn actual_source_revocation_and_epoch_change_still_reach_current_server_checks() {
        let f=fixture().await;let state=state(&f);
        gateway(&state,Some("fixture-a"),None).services_request(&state,"GET","/v1/services/discovery",false,&Value::Null).await.unwrap();
        f.allow.store(false,Ordering::SeqCst);
        let denied=gateway(&state,Some("fixture-a"),None).services_request(&state,"GET","/v1/services/discovery",false,&Value::Null).await.unwrap();assert_eq!(denied.0,403);assert_eq!(denied.1["code"],"SCOPE_DENIED");
        assert_eq!(count(&f),(1,2));
        state.lock().unwrap().connection_lifecycle.invalidate();
        gateway(&state,Some("fixture-a"),None).services_request(&state,"GET","/v1/services/discovery",false,&Value::Null).await.unwrap();assert_eq!(count(&f),(2,3));
    }
    #[tokio::test]
    async fn actual_source_downgrade_rejects_success_and_mutation_does_not_send() {
        let f=fixture().await;let state=state(&f);
        let retained=gateway(&state,Some("fixture-a"),None);
        retained.services_request(&state,"GET","/v1/services/discovery",false,&Value::Null).await.unwrap();
        f.modern.store(false,Ordering::SeqCst);
        assert_eq!(retained.services_request(&state,"GET","/v1/services/discovery",false,&Value::Null).await.unwrap_err(),"CONTENT_UPGRADE_REQUIRED");
        let before=f.requests.lock().unwrap().len();
        assert_eq!(gateway(&state,Some("fixture-a"),None).services_request_json(&state,"POST","/v1/services/materials/assets/fixture-asset",&json!({})).await.unwrap_err(),"CONTENT_UPGRADE_REQUIRED");
        assert!(f.requests.lock().unwrap()[before..].iter().all(|request|request.starts_with("get /v1/services/libraries ")));
    }
    #[tokio::test]
    async fn actual_source_mutations_freshly_negotiate_even_with_warm_read_proof() {
        let f=fixture().await;let state=state(&f);
        let retained=gateway(&state,Some("fixture-a"),None);
        retained.services_request(&state,"GET","/v1/services/discovery",false,&Value::Null).await.unwrap();
        retained.services_request_json(&state,"POST","/v1/services/materials/assets/fixture-asset",&json!({})).await.unwrap();
        retained.services_request_with_chunk(&state,"PUT","/v1/services/ingest/jobs/fixture/chunks",b"x",&[]).await.unwrap();
        assert_eq!(count(&f),(3,3),"fresh probe per mutation; no repeated mutation sends");
    }    #[tokio::test]
    async fn actual_source_material_switch_does_not_cancel_independent_knowledge_scope() {
        let f=fixture().await;let state=state(&f);
        let material=gateway(&state,Some("fixture-a"),None);
        let knowledge=gateway(&state,None,Some("fixture-vault-a"));
        let instance=material.instance().to_string();
        CONTENT_SCOPE_EPOCHS.get_or_init(Default::default).lock().unwrap().entry(instance).or_default().0+=1;
        assert_eq!(material.services_request(&state,"GET","/v1/services/materials/assets/fixture-asset",false,&Value::Null).await.unwrap_err(),"CONTENT_SOURCE_CHANGED");
        assert_eq!(knowledge.services_request(&state,"GET","/v1/services/knowledge/vaults/fixture-vault-a/notes",false,&Value::Null).await.unwrap().0,200);
        assert_eq!(count(&f),(1,1));
    }
    #[tokio::test]
    async fn actual_source_epoch_change_during_fresh_mutation_probe_prevents_the_write() {
        let f=fixture().await;let state=state(&f);
        let retained=gateway(&state,Some("fixture-a"),None);
        retained.services_request(&state,"GET","/v1/services/materials/assets/fixture-asset",false,&Value::Null).await.unwrap();
        *f.switch_on_probe.lock().unwrap()=Some(state.lock().unwrap().connection_lifecycle.epoch.clone());
        assert_eq!(retained.services_request_json(&state,"POST","/v1/services/materials/assets/fixture-asset",&json!({})).await.unwrap_err(),"CONTENT_SOURCE_CHANGED");
        assert_eq!(count(&f),(2,1),"fresh probe is fenced before any mutation send");
    }

}
