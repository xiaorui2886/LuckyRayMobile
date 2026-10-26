//! Local workspace commands and one bounded preparation read after normal sync.
use super::*;

pub(super) fn local_owner(db: &Db, instance: &str) -> Result<(), String> {
    if instance.is_empty() || db.paired()?.is_none_or(|p| p.instance_id != instance) {
        return Err("CONTENT_SOURCE_CHANGED".into());
    }
    Ok(())
}

pub(super) async fn capabilities(source: &Source, state: &SharedState) -> Result<Value, String> {
    source.ensure_scope_protocol(state).await?;
    let (status, value) = source
        .gateway
        .content_request(reqwest::Method::GET, "/v1/capabilities", None)
        .await?;
    source.check(state)?;
    if status == 401
        || status == 403
        || (status == 200 && value["capabilities"]["noteRead"] == false)
    {
        source.with_db(state, |db| db.offline_revoke(&source.instance))?;
    }
    if status != 200 {
        return Err(format!("CONTENT_HTTP_{status}"));
    }
    if value["contentVersion"] != 1 || value["capabilities"]["noteRead"] != true {
        return Err("CONTENT_UPGRADE_REQUIRED".into());
    }
    Ok(value)
}

#[tauri::command]
pub(crate) fn content_offline_libraries(
    state: State<'_, SharedState>,
    instance: String,
) -> Result<Value, String> {
    with_db(&state, |db| {
        local_owner(db, &instance)?;
        db.offline_libraries(&instance)
    })
}

#[tauri::command]
pub(crate) fn content_offline_notes(
    state: State<'_, SharedState>,
    instance: String,
    vault: String,
    q: String,
    page: u32,
    directory: Option<String>,
) -> Result<Value, String> {
    if q.len() > 4096 || page == 0 || page > 1_000_000 {
        return Err("CONTENT_QUERY_INVALID".into());
    }
    with_db(&state, |db| {
        local_owner(db, &instance)?;
        if !db.offline_selected(&instance, &vault)? {
            return Err("CONTENT_OFFLINE_NOT_SELECTED".into());
        }
        let mut page = db.content_notes(&instance, &vault, &q, page, directory.as_deref().unwrap_or(""))?;
        page["source"] = json!("cache");
        Ok(page)
    })
}

#[tauri::command]
#[allow(dead_code)]
pub(crate) fn content_offline_create(
    state: State<'_, SharedState>,
    instance: String,
    vault: String,
) -> Result<String, String> {
    // Explicit disconnect does not prohibit a local save. Pair identity still does.
    with_db(&state, |db| {
        local_owner(db, &instance)?;
        db.offline_create(&instance, &vault)
    })
}

#[tauri::command]
pub(crate) async fn content_offline_control(
    state: State<'_, SharedState>,
    instance: String,
    vault: String,
    action: String,
) -> Result<(), String> {
    if matches!(action.as_str(), "pause" | "resume") {
        return with_db(&state, |db| {
            local_owner(db, &instance)?;
            if !db.offline_selected(&instance, &vault)? { return Err("CONTENT_OFFLINE_NOT_SELECTED".into()); }
            db.offline_pause(&instance, &vault, action == "pause")
        });
    }
    if action != "start" {
        return Err("CONTENT_INPUT_INVALID".into());
    }
    let source = Source::capture_expected(&state, &instance)?.scoped(None, Some(&vault))?;
    let caps = capabilities(&source, &state).await?;
    let vaults = source.gateway.content_get("/v1/vaults").await?;
    let current = vaults["items"]
        .as_array()
        .and_then(|v| v.iter().find(|row| row["vaultId"] == vault))
        .ok_or("CONTENT_VAULT_UNAVAILABLE")?;
    if current["vaultId"] != vault {
        return Err("CONTENT_VAULT_UNAVAILABLE".into());
    }
    source.with_db(&state, |db| {
        db.content_vault_remember(
            &instance,
            &vault,
            current["name"].as_str().unwrap_or("知识库"),
        )?;
        db.offline_select(&instance, &vault, caps["capabilities"]["noteWrite"] == true)
    })
}

pub(super) async fn prepare_one(
    source: &Source,
    state: &SharedState,
    vault: &str,
) -> Result<(bool, bool), String> {
    let job = source.with_db(state, |db| db.offline_job(&source.instance, vault))?;
    let Some(job) = job else {
        return Ok((false, false));
    };
    // One read, bounded time. Each next pass starts with pending edits and changes.
    // No new timer/sync owner, and no preparation of attachment bytes.
    let result = tokio::time::timeout(
        std::time::Duration::from_millis(1500),
        remote_note(source, vault, &job.id),
    )
    .await
    .unwrap_or_else(|_| Err("CONTENT_OFFLINE".into()));
    let applied = source.with_db(state, |db| {
        db.offline_finish(&source.instance, vault, &job, result)
    })?;
    let more = source.with_db(state, |db| {
        Ok(db.offline_job(&source.instance, vault)?.is_some())
    })?;
    Ok((applied, more))
}

pub(super) fn document_response(
    status: u16,
    value: Value,
    vault: &str,
    id: &str,
) -> Result<Value, String> {
    if status != 200 {
        return Err(format!("CONTENT_HTTP_{status}"));
    }
    if value["noteId"] != id || value["vaultId"] != vault {
        return Err("CONTENT_DOCUMENT_INVALID".into());
    }
    if !value["content"].is_string()
        || !value["resources"].is_array()
        || value["revision"].as_str().is_none_or(str::is_empty)
        || value["deleted"] == true
    {
        return Err("CONTENT_BODY_UNAVAILABLE".into());
    }
    Ok(value)
}

/// A bounded incremental page precedes bulk preparation. Failed/slow reads
/// become durable high-priority jobs before its cursor can move, not tombstones.
pub(super) async fn change_documents<F, Fut>(
    changes: &[Value],
    vault: &str,
    selected: bool,
    mut read: F,
) -> Result<(Vec<Value>, Vec<Value>), String>
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = Result<Value, String>>,
{
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(1500);
    let mut documents = Vec::new();
    let mut deferred = Vec::new();
    let mut ids = std::collections::HashSet::new();
    for change in changes.iter().rev() {
        let id = change["noteId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("CONTENT_RESPONSE_INVALID")?;
        let revision = change["revision"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("CONTENT_RESPONSE_INVALID")?;
        if !ids.insert(id) {
            continue;
        }
        if change["deleted"] == true {
            documents.push(json!({"noteId":id,"vaultId":vault,"revision":revision,"deleted":true}));
            continue;
        }
        let result = if selected {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                Err("CONTENT_OFFLINE".into())
            } else {
                tokio::time::timeout(
                    remaining.min(std::time::Duration::from_millis(750)),
                    read(id.to_owned()),
                )
                .await
                .unwrap_or_else(|_| Err("CONTENT_OFFLINE".into()))
            }
        } else {
            read(id.to_owned()).await
        };
        match result {
            Ok(doc) => documents.push(doc),
            Err(_) if selected => {
                deferred.push(json!({"noteId":id,"vaultId":vault,"revision":revision}))
            }
            Err(error) => return Err(error),
        }
    }
    Ok((documents, deferred))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn offline_a1_incremental_page_defers_bad_body_without_blocking_live_changes_or_local_edits(
    ) {
        let path = std::env::temp_dir().join(format!("lr-a1-flow-{}.db", uuid::Uuid::new_v4()));
        let mut db = Db::open(&path).unwrap();
        db.content_vault_remember("A", "v", "Library").unwrap();
        db.offline_select("A", "v", true).unwrap();
        let summary = json!({"noteId":"a-bulk","vaultId":"v","revision":"r1","title":"Bulk","relativePath":"Bulk.md"});
        db.content_apply_batch("A", "v", &[summary], 1, Some(("", true)))
            .unwrap();
        let changes = vec![
            json!({"noteId":"live","revision":"r2","deleted":false}),
            json!({"noteId":"z-bad","revision":"r3","deleted":false}),
        ];
        let (documents, deferred) = change_documents(&changes, "v", true, |id| async move {
            let (status, value) = if id == "z-bad" { (404,json!({"code":"NOT_FOUND"})) }
                else { (200,json!({"noteId":id,"vaultId":"v","revision":"r2","title":"Live","relativePath":"Live.md","content":"live update","resources":[]})) };
            document_response(status, value, "v", &id)
        }).await.unwrap();
        db.content_apply_batch_deferred("A", "v", &documents, 3, None, &deferred)
            .unwrap();
        assert_eq!(
            db.content_note("A", "v", "live").unwrap()["content"],
            "live update"
        );
        assert_eq!(db.content_sync_position("A", "v").unwrap()["cursor"], 3);
        // A local create can still enter the original immutable operation path
        // between preparation reads; body work has no second save queue.
        let local = db.offline_create("A", "v").unwrap();
        let epoch = db.content_begin_edit("A", "v", &local).unwrap()["editorEpoch"]
            .as_i64()
            .unwrap();
        db.content_edit("A", "v", &local, "Local", "new local text", epoch, 1)
            .unwrap();
        let operations = db.content_prepare_operations("A", "v").unwrap();
        assert!(operations
            .iter()
            .any(|op| op["noteId"] == local && op["kind"] == "create"));
        let job = db.offline_job("A", "v").unwrap().unwrap();
        assert_eq!(job.id, "z-bad", "incremental retry precedes bulk backlog");
        db.offline_finish("A", "v", &job, Err("CONTENT_HTTP_404".into()))
            .unwrap();
        assert_eq!(db.offline_job("A", "v").unwrap().unwrap().id, "a-bulk");
        assert_eq!(db.content_prepare_operations("A", "v").unwrap(), operations);
        assert_eq!(db.offline_libraries("A").unwrap()[0]["failed"], 1);
        drop(db);
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn offline_a1_r1_paused_bulk_still_applies_deferred_live_change() {
        let path = std::env::temp_dir().join(format!("lr-a1-r1-{}.db", uuid::Uuid::new_v4()));
        let mut db = Db::open(&path).unwrap();
        db.content_vault_remember("A", "v", "Library").unwrap();
        db.offline_select("A", "v", true).unwrap();
        db.content_apply_batch(
            "A",
            "v",
            &[json!({"noteId":"bulk","vaultId":"v","revision":"b1","title":"Bulk"})],
            1,
            Some(("", true)),
        )
        .unwrap();
        let old_bulk = db.offline_job("A", "v").unwrap().unwrap();
        let changes = vec![json!({"noteId":"live","revision":"r2","deleted":false})];
        let (docs, deferred) = change_documents(&changes, "v", true, |_| async {
            std::future::pending::<Result<Value, String>>().await
        })
        .await
        .unwrap();
        db.content_apply_batch_deferred("A", "v", &docs, 2, None, &deferred)
            .unwrap();
        db.offline_pause("A", "v", true).unwrap();
        assert!(!db.offline_finish("A", "v", &old_bulk, Ok(json!({"noteId":"bulk","vaultId":"v","revision":"b1","content":"old bulk","resources":[]}))).unwrap());
        assert_eq!(db.content_sync_position("A", "v").unwrap()["cursor"], 2);
        let live = db
            .offline_job("A", "v")
            .unwrap()
            .expect("pause must not block durable live work");
        assert_eq!(live.id, "live");
        // Inject only wall-clock time at the real persistence boundary. Three
        // failed reads must not turn live synchronization into manual resume.
        for attempt in 0..3 {
            let now = 1000 + attempt * 301;
            let retry = db.offline_job_at("A", "v", now).unwrap().unwrap();
            db.offline_finish_at("A", "v", &retry, Err("CONTENT_OFFLINE".into()), now)
                .unwrap();
            assert!(
                db.offline_job_at("A", "v", now).unwrap().is_none(),
                "no immediate retry loop"
            );
        }
        // Pending edits and explicit tombstones still commit during backoff.
        let local = db.offline_create("A", "v").unwrap();
        let epoch = db.content_begin_edit("A", "v", &local).unwrap()["editorEpoch"]
            .as_i64()
            .unwrap();
        db.content_edit("A", "v", &local, "Phone", "pending", epoch, 1)
            .unwrap();
        assert_eq!(db.content_prepare_operations("A", "v").unwrap().len(), 1);
        let (deleted, deferred) = change_documents(
            &[json!({"noteId":"gone","revision":"d1","deleted":true})],
            "v",
            true,
            |_| async { panic!("tombstone needs no GET") },
        )
        .await
        .unwrap();
        db.content_apply_batch_deferred("A", "v", &deleted, 3, None, &deferred)
            .unwrap();
        assert_eq!(db.content_note("A", "v", "gone").unwrap()["deleted"], true);
        let live = db
            .offline_job_at("A", "v", 2000)
            .unwrap()
            .expect("same-revision live read must auto-recover after three failures");
        db.offline_finish_at("A", "v", &live, Ok(json!({"noteId":"live","vaultId":"v","revision":"r2","title":"Live","content":"after slow read","resources":[]})),2000).unwrap();
        assert_eq!(
            db.content_note("A", "v", "live").unwrap()["content"],
            "after slow read"
        );
        assert!(
            db.offline_job("A", "v").unwrap().is_none(),
            "bulk remains paused"
        );
        drop(db);
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn offline_a1_slow_change_is_bounded_and_latest_explicit_delete_wins() {
        let changes = vec![
            json!({"noteId":"gone","revision":"r1","deleted":false}),
            json!({"noteId":"gone","revision":"r2","deleted":true}),
            json!({"noteId":"slow","revision":"r3","deleted":false}),
        ];
        let start = tokio::time::Instant::now();
        let (documents, deferred) = change_documents(&changes, "v", true, |id| async move {
            assert_eq!(id, "slow", "do not GET a superseded deletion");
            std::future::pending::<Result<Value, String>>().await
        })
        .await
        .unwrap();
        assert!(start.elapsed() < std::time::Duration::from_secs(3));
        assert_eq!(documents[0]["deleted"], true);
        assert_eq!(documents[0]["revision"], "r2");
        assert_eq!(deferred[0]["noteId"], "slow");
    }

    #[test]
    fn offline_a1_unknown_404_and_permission_errors_are_not_tombstones() {
        for status in [404, 403, 401, 409, 500] {
            assert_eq!(
                document_response(status, json!({"code":"NOT_FOUND"}), "v", "n").unwrap_err(),
                format!("CONTENT_HTTP_{status}")
            );
        }
        assert!(document_response(
            200,
            json!({"noteId":"wrong","vaultId":"v","content":""}),
            "v",
            "n"
        )
        .is_err());
        let empty = json!({"noteId":"n","vaultId":"v","content":"","revision":"r","resources":[]});
        assert_eq!(
            document_response(200, empty.clone(), "v", "n").unwrap(),
            empty
        );
    }
}

/// Local maintenance intentionally accepts historical owners, not only the
/// currently paired Desktop. Never sends requests or removes original files.
#[tauri::command]
pub(crate) fn content_cache_libraries(state: State<'_, SharedState>) -> Result<Value, String> {
    with_db(&state, |db| db.content_cache_libraries())
}
#[tauri::command]
pub(crate) fn content_cache_clear(state: State<'_, SharedState>, instance: String, vault: String) -> Result<Value, String> {
    with_db(&state, |db| db.content_cache_clear(&instance, &vault))
}
