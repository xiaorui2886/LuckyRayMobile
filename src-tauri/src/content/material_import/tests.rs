use super::*;
use std::sync::{atomic::{AtomicBool, Ordering}, Mutex};

struct Fixture(crate::capture_media::CaptureMedia);

#[test]
fn diagnostics_expose_only_bounded_identifiers_and_preserve_failure() {
    assert_eq!(diagnostic_code("SERVICE_UNAVAILABLE (503)"), "SERVICE_UNAVAILABLE");
    for detail in ["https://example.test/?token=secret", "C:\\private\\file.txt", "message with private data", "", &"A".repeat(81)] { assert_eq!(diagnostic_code(detail), "MATERIAL_IMPORT_FAILED"); }
    assert_eq!(observed("complete", Ok((503, json!({"code":"SERVICE_UNAVAILABLE","detail":"private content"})))).unwrap_err(), "SERVICE_UNAVAILABLE (503)");
    assert_eq!(observed("chunk", Err("CONTENT_SOURCE_CHANGED".into())).unwrap_err(), "CONTENT_SOURCE_CHANGED");
}
impl Fixture {
    fn new(bytes: &[u8]) -> Self {
        let path = std::env::temp_dir().join(format!("lr-material-import-{}.tmp", Uuid::new_v4()));
        std::fs::write(&path, bytes).unwrap();
        Self(crate::capture_media::CaptureMedia { ref_id:"ref-1".into(), kind:"file".into(), file_name:"测试 文件.png".into(), mime:"image/png".into(), size_bytes:bytes.len() as u64, sha256:format!("{:x}", Sha256::digest(bytes)), local_uri:path.to_str().unwrap().into() })
    }
}
impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_file(&self.0.local_uri); } }
struct Wire { requests:Mutex<Vec<Value>>, offset:Mutex<u64>, total:u64, live:AtomicBool, bad_ack:bool, bad_receipt:bool, change_after_chunk:bool }
impl Wire {
    fn new(total:u64) -> Self { Self { requests:Mutex::new(vec![]), offset:Mutex::new(0), total, live:AtomicBool::new(true), bad_ack:false, bad_receipt:false, change_after_chunk:false } }
    fn job(&self, completed:bool) -> Value { json!({"jobId":"job-1","opId":"op-1","state":if completed {"completed"} else {"staging"},"committedBytes":*self.offset.lock().unwrap(),"receipt":if completed {json!({"domain":if self.bad_receipt {"knowledge"} else {"materials"},"assetId":"asset-1","revision":"r1"})} else {Value::Null}}) }
}
impl ImportWire for Wire {
    async fn json(&self, method:&str, path:&str, body:&Value) -> Result<Value,String> {
        self.check()?; self.requests.lock().unwrap().push(json!({"method":method,"path":path,"body":body}));
        let completed=path.ends_with("/complete");
        if completed { assert_eq!(*self.offset.lock().unwrap(),self.total); }
        Ok(self.job(completed))
    }
    async fn chunk(&self, path:&str, offset:u64, bytes:&[u8]) -> Result<Value,String> {
        self.check()?; assert_eq!(offset,*self.offset.lock().unwrap());
        self.requests.lock().unwrap().push(json!({"path":path,"offset":offset,"bytes":bytes}));
        *self.offset.lock().unwrap() += bytes.len() as u64;
        let mut job=self.job(false);
        if self.bad_ack {job["committedBytes"]=json!(offset);}
        if self.change_after_chunk {self.live.store(false,Ordering::SeqCst);}
        Ok(job)
    }
    fn check(&self) -> Result<(),String> { if self.live.load(Ordering::SeqCst) { Ok(()) } else { Err("CONTENT_SOURCE_CHANGED".into()) } }
}

#[tokio::test]
async fn original_name_hash_folder_and_bounded_bytes_reach_canonical_ingest() {
    let file=Fixture::new(b"0123456789"); let wire=Wire::new(10);
    let receipt=transfer(&wire,&file.0,Some("folder-1"),"image","op-1",(64,4)).await.unwrap();
    assert_eq!(receipt["assetId"],"asset-1"); assert_eq!(receipt["completed"],true);
    let calls=wire.requests.lock().unwrap(); assert_eq!(calls.len(),5);
    assert_eq!(calls[0]["body"]["target"],json!({"domain":"materials","folderId":"folder-1"}));
    assert_eq!(calls[0]["body"]["name"],file.0.file_name); assert_eq!(calls[0]["body"]["sha256"],file.0.sha256);
    let data:Vec<u8>=calls.iter().skip(1).take(3).flat_map(|v|v["bytes"].as_array().unwrap().iter().map(|b|b.as_u64().unwrap() as u8)).collect();
    assert_eq!(data,b"0123456789"); assert_eq!(calls.last().unwrap()["path"],"/v1/services/ingest/jobs/job-1/complete");
}
#[tokio::test]
async fn resumed_job_uses_the_server_committed_offset_without_new_manifest() {
    let file=Fixture::new(b"0123456789"); let wire=Wire::new(10); *wire.offset.lock().unwrap()=3;
    transfer(&wire,&file.0,None,"file","op-1",(64,4)).await.unwrap();
    let calls=wire.requests.lock().unwrap(); assert_eq!(calls[1]["offset"],3); assert_eq!(calls[1]["bytes"],json!([51,52,53,54]));
}
#[tokio::test]
async fn bad_chunk_ack_is_not_success_or_automatic_retry() {
    let file=Fixture::new(b"0123456789"); let mut wire=Wire::new(10); wire.bad_ack=true;
    assert_eq!(transfer(&wire,&file.0,None,"file","op-1",(64,4)).await.unwrap_err(),"MATERIAL_IMPORT_INVALID_RECEIPT");
    assert_eq!(wire.requests.lock().unwrap().len(),2);
}
#[tokio::test]
async fn different_receipt_domain_never_reports_a_material_as_imported() {
    let file=Fixture::new(b"0123"); let mut wire=Wire::new(4); wire.bad_receipt=true;
    assert_eq!(transfer(&wire,&file.0,None,"file","op-1",(64,4)).await.unwrap_err(),"MATERIAL_IMPORT_INVALID_RECEIPT");
}
#[tokio::test]
async fn connection_or_scope_change_stops_before_another_chunk_or_complete() {
    let file=Fixture::new(b"0123456789"); let mut wire=Wire::new(10); wire.change_after_chunk=true;
    assert_eq!(transfer(&wire,&file.0,None,"file","op-1",(64,4)).await.unwrap_err(),"CONTENT_SOURCE_CHANGED");
    assert_eq!(wire.requests.lock().unwrap().len(),2);
}
#[tokio::test]
async fn changed_file_and_size_limits_reject_before_any_upload() {
    let file=Fixture::new(b"0123"); let wire=Wire::new(4);
    assert_eq!(transfer(&wire,&file.0,None,"file","op-1",(3,4)).await.unwrap_err(),"PAYLOAD_TOO_LARGE");
    std::fs::write(&file.0.local_uri,b"9999").unwrap();
    assert_eq!(transfer(&wire,&file.0,None,"file","op-1",(64,4)).await.unwrap_err(),"MATERIAL_IMPORT_FILE_CHANGED");
    assert!(wire.requests.lock().unwrap().is_empty());
}
#[test]
fn discovery_requires_exact_owner_all_operations_and_nonzero_limits() {
    let mut catalog=json!({"catalogVersion":1,"desktopInstanceId":"a","operations":{},"limits":{"uploadBytes":999999999,"uploadChunkBytes":999999}});
    for op in ["ingest.begin","ingest.status","ingest.chunk","ingest.complete"] { catalog["operations"][op]=json!({"state":"implemented"}); }
    assert_eq!(import_limits(&catalog,"a").unwrap(),(MAX_UPLOAD_BYTES,MAX_CHUNK_BYTES));
    assert!(import_limits(&catalog,"b").is_err());
    catalog["operations"]["ingest.begin"]["state"]=json!("notGranted"); assert_eq!(import_limits(&catalog,"a").unwrap_err(),"MATERIAL_IMPORT_NOT_GRANTED");
    catalog["operations"]["ingest.begin"]["state"]=json!("unsupported"); assert_eq!(import_limits(&catalog,"a").unwrap_err(),"CONTENT_UPGRADE_REQUIRED");
}
#[test]
fn foreign_jobs_cancelled_jobs_and_unbounded_error_details_are_rejected() {
    assert!(job_id(&json!({"jobId":"../../x","opId":"op-1","state":"staging","committedBytes":0}),"op-1",4).is_err());
    assert!(job_id(&json!({"jobId":"job-1","opId":"old-op","state":"staging","committedBytes":0}),"op-1",4).is_err());
    assert!(job_id(&json!({"jobId":"job-1","opId":"op-1","state":"cancelled","committedBytes":0}),"op-1",4).is_err());
    assert_eq!(accepted(403,json!({"code":"GRANT_REQUIRED","secret":"never return this"})).unwrap_err(),"GRANT_REQUIRED (403)");
    assert_eq!(accepted(500,json!({"code":"https://secret.invalid/","body":"private"})).unwrap_err(),"MATERIAL_IMPORT_FAILED (500)");
}
