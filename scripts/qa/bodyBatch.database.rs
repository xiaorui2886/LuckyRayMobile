//! Actual DB selection + production async scheduler + actual CAS publication.
//! Read callback is synthetic; this is not a phone/network throughput benchmark.
use crate::{body_batch, db::Db};
use serde_json::{json, Value};
use std::{cell::{Cell,RefCell}, time::Duration};
fn doc(id: &str, revision: &str, body: bool) -> Value {
    let mut d=json!({"noteId":id,"vaultId":"v","title":id,"relativePath":format!("{id}.md"),"revision":revision,"resources":[]});
    if body {d["content"]=json!(format!("body-{id}"));} d
}
fn fixture(count: usize) -> RefCell<Db> {
    let mut db=Db::open(std::path::Path::new(":memory:")).unwrap();
    db.content_vault_remember("A","v","Vault").unwrap();
    db.offline_select("A","v",true).unwrap();
    let docs=(0..count).map(|n|doc(&format!("n{n:03}"),"r1",false)).collect::<Vec<_>>();
    db.content_apply_batch("A","v",&docs,52,Some(("",true))).unwrap();
    RefCell::new(db)
}
#[tokio::test]
async fn fifty_two_actual_pending_jobs_finish_in_seven_bounded_rounds_without_cursor_changes() {
    let db=fixture(52); let before=db.borrow().content_sync_position("A","v").unwrap();
    let reads=Cell::new(0); let active=Cell::new(0); let peak=Cell::new(0); let mut rounds=0; let mut committed=0;
    loop {
        let jobs=db.borrow().offline_jobs("A","v",1000).unwrap();
        if jobs.is_empty() {break;} assert!(jobs.len()<=8); rounds+=1;
        assert!(!db.borrow().content_needs_create_discovery("A","v").unwrap());
        committed+=body_batch::run(jobs, ||Ok(()), |job| {
            let active=&active; let peak=&peak; let reads=&reads;
            async move {
                reads.set(reads.get()+1);active.set(active.get()+1);peak.set(peak.get().max(active.get()));
                tokio::time::sleep(Duration::from_millis(1)).await; active.set(active.get()-1);
                Ok(doc(&job.id,&job.revision,true))
            }
        }, |job,result|db.borrow_mut().offline_finish("A","v",&job,result)).await.unwrap();
        assert_eq!(db.borrow().content_sync_position("A","v").unwrap(),before);
    }
    assert_eq!((rounds,reads.get(),peak.get(),committed),(7,52,2,52));
    assert_eq!(db.borrow().offline_libraries("A").unwrap()[0]["ready"],52);
    assert!(db.borrow().offline_job("A","v").unwrap().is_none());
    eprintln!("BODY_BATCH synthetic: pending=52 rounds=7 read_callbacks=52 max_inflight=2 adopted=52 remaining=0 (old one-body policy: 52 rounds)");
}
#[tokio::test]
async fn selection_change_and_revision_change_never_publish_stale_body() {
    let db=fixture(3); let jobs=db.borrow().offline_jobs("A","v",8).unwrap();
    db.borrow_mut().content_apply_batch("A","v",&[doc("n000","r2",false)],53,None).unwrap();
    let n=body_batch::run(jobs,||Ok(()),|job|async move {Ok(doc(&job.id,&job.revision,true))},
        |job,result|db.borrow_mut().offline_finish("A","v",&job,result)).await.unwrap();
    assert_eq!(n,2);
    assert_eq!(db.borrow().offline_job("A","v").unwrap().unwrap().revision,"r2");
    let jobs=db.borrow().offline_jobs("A","v",8).unwrap();
    db.borrow_mut().content_vault_remember("A","other","Other").unwrap();
    db.borrow_mut().offline_select("A","other",true).unwrap();
    let n=body_batch::run(jobs,||Ok(()),|job|async move {Ok(doc(&job.id,&job.revision,true))},
        |job,result|db.borrow_mut().offline_finish("A","v",&job,result)).await.unwrap();
    assert_eq!(n,0);
    assert!(db.borrow().offline_job("A","other").unwrap().is_none());
}
#[tokio::test]
async fn disconnected_batch_leaves_unattempted_jobs_and_retry_durable_without_tombstones() {
    let db=fixture(8);let jobs=db.borrow().offline_jobs("A","v",8).unwrap();
    let position=db.borrow().content_sync_position("A","v").unwrap();
    let result=body_batch::run(jobs,||Ok(()),|_| async {Err("CONTENT_OFFLINE".into())},
        |job,result|db.borrow_mut().offline_finish("A","v",&job,result)).await;
    assert_eq!(result.unwrap_err(),"CONTENT_OFFLINE");
    assert_eq!(db.borrow().offline_jobs("A","v",8).unwrap().len(),7);
    assert_eq!(db.borrow().content_sync_position("A","v").unwrap(),position);
    for n in 0..8 {assert_ne!(db.borrow().content_note("A","v",&format!("n{n:03}")).unwrap()["deleted"],true);}
    db.borrow_mut().offline_pause("A","v",false).unwrap();
    assert_eq!(db.borrow().offline_jobs("A","v",8).unwrap().len(),8);
}
#[test]
fn discovery_only_for_unprepared_creates_not_hydration_or_prepared_replay() {
    let db=fixture(1);
    assert!(!db.borrow().content_needs_create_discovery("A","v").unwrap());
    db.borrow_mut().content_create("A","v","new","New","body").unwrap();
    assert!(db.borrow().content_needs_create_discovery("A","v").unwrap());
    db.borrow_mut().content_prepare_available_operations("A","v",Some(false)).unwrap();
    assert!(!db.borrow().content_needs_create_discovery("A","v").unwrap());
    assert!(!db.borrow().content_needs_create_discovery("B","v").unwrap());
}

#[tokio::test]
async fn slow_real_jobs_finish_without_spending_retry_attempts() {
    let db=fixture(6); let jobs=db.borrow().offline_jobs("A","v",8).unwrap();
    let n=body_batch::run(jobs,||Ok(()),|job|async move {
        tokio::time::sleep(Duration::from_secs(1)).await;
        Ok(doc(&job.id,&job.revision,true))
    },|job,result|db.borrow_mut().offline_finish("A","v",&job,result)).await.unwrap();
    assert_eq!(n,4);
    assert_eq!(db.borrow().offline_libraries("A").unwrap()[0]["ready"],4);
    assert_eq!(db.borrow().offline_jobs("A","v",8).unwrap().len(),2,
        "unstarted jobs remain immediately eligible, not failed/backed off");
}
