//! Bounded read-only body fanout. The caller retains the sole cursor/write owner.
use futures_util::{stream, StreamExt};
use serde_json::Value;
use std::{future::Future, time::Duration};

pub(super) async fn run<J, C, R, F, A>(jobs: Vec<J>, check: C, read: R, mut apply: A) -> Result<usize, String>
where J: Clone, C: Fn() -> Result<(), String>, R: Fn(J) -> F,
    F: Future<Output = Result<Value, String>>,
    A: FnMut(J, Result<Value, String>) -> Result<bool, String>,
{
    // Gateway::content_request owns the complete metadata request timeout.
    // This layer limits new starts, not the duration of an in-flight read.
    let deadline = tokio::time::Instant::now() + Duration::from_millis(1500);
    let mut pending = stream::iter(jobs.into_iter().take(8)).map(|job| {
        let check = &check;
        let read = &read;
        async move {
            check()?;
            // Keep the sync writer available between rounds on slow networks.
            // Unstarted jobs remain pending rather than failed.
            if tokio::time::Instant::now() >= deadline { return Ok(None); }
            let request = read(job.clone());
            tokio::pin!(request);
            let result = loop {
                tokio::select! {
                    result = &mut request => break result,
                    _ = tokio::time::sleep(Duration::from_millis(100)) => check()?,
                }
            };
            check()?;
            Ok::<_, String>(Some((job, result)))
        }
    }).buffer_unordered(2);
    let mut applied = 0;
    while let Some(item) = pending.next().await {
        let Some((job, result)) = item? else { continue; };
        check()?;
        // One refusal/disconnect ends this bounded round. No fanout through a
        // known denied/rate-limited connection; dropping cancels other reads.
        let stop = result.as_ref().err().filter(|e|
            e.starts_with("CONTENT_HTTP_401") || e.starts_with("CONTENT_HTTP_403")
            || e.starts_with("CONTENT_HTTP_429") || matches!(e.as_str(),
                "CONTENT_OFFLINE" | "CONTENT_SOURCE_CHANGED" | "CONTENT_TIMEOUT")
        ).cloned();
        applied += usize::from(apply(job, result)?);
        if let Some(error) = stop { return Err(error); }
    }
    Ok(applied)
}

/// Scheduling only, never authorization or body state. A finite hydration burst
/// finishes first; a continuously replenished backlog yields one resource step
/// after eight rounds so attachments cannot starve indefinitely.
#[derive(Default)]
pub(super) struct ResourceCadence(std::collections::HashMap<String, u8>);
impl ResourceCadence {
    pub(super) fn allow(&mut self, scope: String, body_backlog: bool) -> bool {
        if !body_backlog { self.0.remove(&scope); return true; }
        if self.0.len() >= 256 && !self.0.contains_key(&scope) { self.0.clear(); }
        let turns = self.0.entry(scope.clone()).or_default();
        *turns += 1;
        if *turns < 8 { return false; }
        self.0.remove(&scope);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use serde_json::json;

    #[test]
    fn resource_cadence_has_bounded_fairness_and_scope_isolation() {
        let mut cadence=ResourceCadence::default();
        for _ in 0..7 {assert!(!cadence.allow("A:v".into(),true));}
        assert!(!cadence.allow("A:other".into(),true));
        assert!(!cadence.allow("B:v".into(),true));
        assert!(cadence.allow("A:v".into(),true));
        assert!(!cadence.allow("A:v".into(),true));
        assert!(cadence.allow("A:v".into(),false));
        for _ in 0..7 {assert!(!cadence.allow("A:v".into(),true));}
        assert!(cadence.allow("A:v".into(),true));
    }

    #[tokio::test]
    async fn eight_body_batch_has_only_two_active_reads_and_one_adopter() {
        let active=Cell::new(0); let peak=Cell::new(0); let reads=Cell::new(0);
        let adopted=RefCell::new(Vec::new());
        let n=run((0..100).collect(), || Ok(()), |id| {
            let active=&active; let peak=&peak; let reads=&reads;
            async move {
                active.set(active.get()+1); peak.set(peak.get().max(active.get())); reads.set(reads.get()+1);
                tokio::time::sleep(Duration::from_millis(2)).await;
                active.set(active.get()-1); Ok(json!(id))
            }
        }, |id, value| { assert_eq!(value.unwrap(),json!(id)); adopted.borrow_mut().push(id); Ok(true) }).await.unwrap();
        assert_eq!(n,8); assert_eq!(reads.get(),8); assert_eq!(peak.get(),2);
        let mut ids=adopted.into_inner(); ids.sort(); assert_eq!(ids,(0..8).collect::<Vec<_>>());
    }

    #[tokio::test]
    async fn disconnect_denial_and_rate_limit_stop_fanout_and_keep_unsent_jobs_pending() {
        for error in ["CONTENT_OFFLINE","CONTENT_HTTP_401","CONTENT_HTTP_403","CONTENT_HTTP_429 retryAfterMs=60000"] {
            let reads=Cell::new(0); let failed=Cell::new(0);
            let result=run((0..8).collect(), || Ok(()), |_| {
                reads.set(reads.get()+1); async { Err(error.to_owned()) }
            }, |_, value| { assert!(value.is_err()); failed.set(failed.get()+1); Ok(true) }).await;
            assert_eq!(result.unwrap_err(),error); assert!(reads.get()<=2); assert_eq!(failed.get(),1);
        }
    }

    #[tokio::test]
    async fn owner_change_during_read_prevents_any_adoption() {
        let current=Cell::new(true); let commits=Cell::new(0);
        let result=run(vec![1,2,3], || if current.get() {Ok(())} else {Err("CONTENT_SOURCE_CHANGED".into())}, |_| async {
            current.set(false); Ok(json!({}))
        }, |_,_| {commits.set(commits.get()+1); Ok(true)}).await;
        assert_eq!(result.unwrap_err(),"CONTENT_SOURCE_CHANGED"); assert_eq!(commits.get(),0);
    }

    #[tokio::test]
    async fn late_revision_rejected_by_adopter_is_not_counted_and_bad_note_does_not_starve_others() {
        let n=run(vec![1,2,3], ||Ok(()), |id| async move {
            if id==2 {Err("CONTENT_HTTP_404".into())} else {Ok(json!(id))}
        }, |id,_| Ok(id!=1)).await.unwrap();
        assert_eq!(n,2);
    }

    #[tokio::test]
    async fn owner_retirement_cancels_stalled_reads_promptly_without_publication() {
        let current=Cell::new(true); let commits=Cell::new(0);
        let started=tokio::time::Instant::now();
        let sync=run(vec![1,2,3],||if current.get(){Ok(())}else{Err("CONTENT_SOURCE_CHANGED".into())},
            |_|std::future::pending::<Result<Value,String>>(),|_,_|{commits.set(commits.get()+1);Ok(true)});
        let retire=async {tokio::time::sleep(Duration::from_millis(20)).await;current.set(false);};
        let (result,())=tokio::join!(sync,retire);
        assert_eq!(result.unwrap_err(),"CONTENT_SOURCE_CHANGED");assert_eq!(commits.get(),0);
        assert!(started.elapsed()<Duration::from_secs(1));
    }

    #[tokio::test]
    async fn one_second_bodies_finish_after_start_budget_without_false_timeout() {
        let reads=Cell::new(0);
        let n=run((0..8).collect(),||Ok(()),|id| {
            reads.set(reads.get()+1);
            async move { tokio::time::sleep(Duration::from_secs(1)).await; Ok(json!(id)) }
        },|id,result| {assert_eq!(result.unwrap(),json!(id));Ok(true)}).await.unwrap();
        // Second pair started before 1.5s must finish; the rest stays pending.
        assert_eq!(n,4); assert_eq!(reads.get(),4);
    }

    #[tokio::test]
    async fn gateway_timeout_is_preserved_and_does_not_launch_rest() {
        let reads=Cell::new(0);
        let result=run((0..8).collect(), ||Ok(()), |_| {
            reads.set(reads.get()+1); async { Err("CONTENT_TIMEOUT".to_owned()) }
        }, |_,result| { assert_eq!(result.unwrap_err(),"CONTENT_TIMEOUT"); Ok(true) }).await;
        assert_eq!(result.unwrap_err(),"CONTENT_TIMEOUT"); assert!(reads.get()<=2);
    }
}
