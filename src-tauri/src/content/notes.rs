use super::*;
pub(crate) mod uploads;
mod mutation;
pub(crate) mod linked_import;
mod bootstrap;
mod replica_resources;
pub(crate) mod offline;
pub(crate) mod local_upload;
use mutation::Outcome;

pub(crate) static SYNC_GATE: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

async fn remote_note(source: &Source, vault: &str, id: &str) -> Result<Value, String> {
    let (status, value) = source
        .gateway
        .content_request(reqwest::Method::GET, &format!("/v1/notes/{id}?vault={}", encode(vault)), None)
        .await?;
    retained_document_response(status, value, vault, id)
}

// The UI rollback must not turn an unavailable read into deletion of a body
// saved by schema11. Only a successful full document or change-feed tombstone
// can replace that observation.
fn retained_document_response(status: u16, value: Value, vault: &str, id: &str) -> Result<Value, String> {
    if status != 200 { return Err(format!("CONTENT_HTTP_{status}")); }
    if value["noteId"] != id || value["vaultId"] != vault {
        return Err("CONTENT_DOCUMENT_INVALID".into());
    }
    if !value["content"].is_string() || !value["resources"].is_array()
        || value["revision"].as_str().is_none_or(str::is_empty) || value["deleted"] == true {
        return Err("CONTENT_BODY_UNAVAILABLE".into());
    }
    Ok(value)
}

async fn retained_change_documents<F, Fut>(changes: &[Value], vault: &str, mut read: F) -> Result<Vec<Value>, String>
where F: FnMut(String) -> Fut, Fut: std::future::Future<Output = Result<Value, String>> {
    let mut documents = Vec::new();
    let mut ids = std::collections::HashSet::new();
    for change in changes.iter().rev() {
        let id = change["noteId"].as_str().filter(|s| !s.is_empty()).ok_or("CONTENT_RESPONSE_INVALID")?;
        if !ids.insert(id) { continue; }
        if change["deleted"] == true {
            let revision = change["revision"].as_str().filter(|s| !s.is_empty()).ok_or("CONTENT_RESPONSE_INVALID")?;
            documents.push(json!({"noteId":id,"vaultId":vault,"revision":revision,"deleted":true}));
        } else {
            // Failed reads leave the cursor unchanged; no offline preparation
            // queue or automatic bulk download is resumed by this rollback.
            documents.push(read(id.to_owned()).await?);
        }
    }
    Ok(documents)
}

#[cfg(test)]
mod rollback_tests {
    use super::*;

    #[test]
    fn rollback_unavailable_body_never_becomes_a_tombstone() {
        for status in [403, 404, 410] {
            assert_eq!(retained_document_response(status, json!({}), "v", "n").unwrap_err(), format!("CONTENT_HTTP_{status}"));
        }
        let full = json!({"noteId":"n","vaultId":"v","revision":"r1","content":"","resources":[]});
        assert_eq!(retained_document_response(200, full.clone(), "v", "n").unwrap(), full);
        assert!(retained_document_response(200, full, "other", "n").is_err());
        assert!(retained_document_response(200, json!({"noteId":"n","vaultId":"v","revision":"r1"}), "v", "n").is_err());
    }

    #[tokio::test]
    async fn rollback_change_feed_uses_latest_explicit_delete_and_keeps_failed_reads_unapplied() {
        let deleted = retained_change_documents(&[
            json!({"noteId":"n","revision":"r1","deleted":false}),
            json!({"noteId":"n","revision":"r2","deleted":true}),
        ], "v", |_| async { panic!("an explicit tombstone does not need a 404 read") }).await.unwrap();
        assert_eq!(deleted, vec![json!({"noteId":"n","vaultId":"v","revision":"r2","deleted":true})]);
        let revived = retained_change_documents(&[
            json!({"noteId":"n","revision":"r2","deleted":true}),
            json!({"noteId":"n","revision":"r3","deleted":false}),
        ], "v", |_| async { Ok(json!({"noteId":"n","vaultId":"v","revision":"r3","content":"revived","resources":[]})) }).await.unwrap();
        assert_eq!(revived[0]["content"], "revived");
        let failed = retained_change_documents(&[json!({"noteId":"n","deleted":false})], "v", |_| async { Err("CONTENT_HTTP_404".into()) }).await;
        assert_eq!(failed.unwrap_err(), "CONTENT_HTTP_404");
        assert!(retained_change_documents(&[json!({"noteId":"n","deleted":true})], "v", |_| async { panic!("missing revision must be rejected") }).await.is_err());
    }
}

#[tauri::command]
pub(crate) async fn content_sync(state: State<'_, SharedState>, app: tauri::AppHandle, instance: Option<String>, vault: Option<String>) -> Result<Value, String> {
    let source = match instance.as_deref() {
        Some(instance) => Source::capture_expected(&state, instance)?,
        None if vault.is_none() => Source::capture(&state)?,
        None => return Err("CONTENT_SOURCE_CHANGED".into()),
    }.scoped(None, vault.as_deref())?.knowledge();
    let _gate = SYNC_GATE
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    source.check(&state)?;
    let requested_vault = vault;
    let capabilities = offline::capabilities(&source, &state).await?;
    let vaults = source.gateway.content_get("/v1/vaults").await?;
    let vault = vaults["items"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| requested_vault.as_deref().is_none_or(|id| row["vaultId"] == id)))
        .ok_or("CONTENT_VAULT_UNAVAILABLE")?;
    let vault_id = vault["vaultId"]
        .as_str()
        .ok_or("CONTENT_RESPONSE_INVALID")?;
    source.with_db(&state, |db| {
        db.offline_current(&source.instance, vault_id, capabilities["capabilities"]["noteWrite"] == true)?;
        db.content_vault_remember(
            &source.instance,
            vault_id,
            vault["name"].as_str().unwrap_or("电脑知识库"),
        )
    })?;
    let selected = source.with_db(&state, |db| {
        let rows = db.offline_libraries(&source.instance)?;
        Ok(rows.as_array().and_then(|rows| rows.iter().find(|row| row["confirmed"] == true)).cloned())
    })?;
    if requested_vault.is_none() && selected.as_ref().is_some_and(|library| library["vaultId"] != vault_id) {
        // The Desktop's current-vault protocol cannot serve this scope now.
        // Never send its pending work to the new vault or switch Desktop UI.
        return Ok(json!({"continuation":false,"pushed":0,"applied":0,"instanceId":source.instance,"vaultId":selected.unwrap()["vaultId"],"waitingCurrent":true}));
    }
    let pairing_review = match source.with_db(&state, |db| db.content_pairing_review(&source.instance, vault_id)) {
        Ok(()) => false,
        Err(code) if code == "CONTENT_PAIRING_REVIEW_REQUIRED" => true,
        Err(code) => return Err(code),
    };
    let mut folder_applied=0;let mut folder_more=false;
    if capabilities["knowledgeFolders"]["version"]==1 {
        let after=source.with_db(&state,|db|db.managed_folder_scan_cursor(&source.instance,vault_id))?;
        let mut path=format!("/v1/services/knowledge/vaults/{}/directories?limit=100",encode(vault_id));
        if !after.is_empty(){path.push_str(&format!("&afterPath={}",encode(&after)));}
        let (status,page)=source.gateway.content_request(reqwest::Method::GET,&path,None).await?;
        source.check(&state)?;
        if status==200 {(folder_applied,folder_more)=source.with_db(&state,|db|db.managed_folder_observe_page(&source.instance,vault_id,&page))?;}
        else if status!=404 {return Err(format!("CONTENT_FOLDER_READ_HTTP_{status}"));}
    }
    let mut pushed = 0;
    let mut desktop_busy_note_ids: Vec<String> = Vec::new();
    // R1.6-C: create collisions that were auto-copied (quiet, one-time UI
    // may surface them; the sync itself never blocks).
    let mut auto_renamed: Vec<Value> = Vec::new();
    // R1.6.1-4: a restaged create (stale-intent retry or auto-copy) must
    // drive ANOTHER sync pass automatically — without this the fresh op
    // could sit pending forever once the read side reports no continuation.
    let mut create_retry_pending = false;
    if capabilities["capabilities"]["noteWrite"] == true {
        // Read-only discovery chooses ONLY newly prepared creates. A missing old
        // Desktop route may use Content; a failed/ambiguous discovery does not
        // freeze a new route. Existing operations always keep their stored route.
        source.check(&state)?;
        let catalog_result = source.gateway
            .content_request(reqwest::Method::GET, "/v1/services", None).await;
        source.check(&state)?;
        let unique_create = catalog_result.as_ref().ok()
            .and_then(|(status, catalog)| mutation::create_route_capability(*status, catalog, &source.instance));
        // Empty-folder publication is additive: old servers keep local pending
        // folders intact, without guessing another endpoint or acknowledging them.
        if capabilities["knowledgeFolders"]["version"]==1 && capabilities["knowledgeFolders"]["create"]==true {
            let folders=source.with_db(&state,|db|db.managed_pending_folders(&source.instance,vault_id))?;
            for op in folders {
                if source.with_db(&state,|db|db.managed_mutation_blocked(&source.instance,vault_id,"folder",&op.relative_path))? {continue;}
                if !source.with_db(&state,|db|db.managed_folder_parent_ready(&source.instance,vault_id,&op.parent_relative_path))? {continue;}
                let (status,receipt)=source.mutate(&state,"/v1/notes/folders",reqwest::Method::POST,&op.payload()).await?;
                if status!=200 && status!=201 {
                    if matches!(status,400|409|422) {source.with_db(&state,|db|db.managed_mutation_block(&source.instance,vault_id,"folder",&op.relative_path,"folder-review-required"))?;continue;}
                    return Err(format!("CONTENT_FOLDER_HTTP_{status}"));
                }
                source.with_db(&state,|db|db.managed_folder_ack(&op,&receipt))?;
                pushed+=1;
            }
        }
        // Durable offline moves use the same serialized scope and exact payload
        // on every retry. UI vault selection never owns their execution.
        let moves=source.with_db(&state,|db|db.managed_pending_moves(&source.instance,vault_id))?;
        for (id,request) in moves {
            if source.with_db(&state,|db|db.managed_mutation_blocked(&source.instance,vault_id,"move",&id))? {continue;}
            if !source.with_db(&state,|db|db.managed_folder_parent_ready(&source.instance,vault_id,request["parentRelativePath"].as_str().ok_or("VAULT_MOVE_INTENT_INVALID")?))? {continue;}
            let path=format!("/v1/services/knowledge/notes/{}/move",encode(&id));
            let (status,receipt)=source.mutate(&state,&path,reqwest::Method::PATCH,&request).await?;
            if status!=200 {
                if matches!(status,400|404|409|422) {source.with_db(&state,|db|db.managed_mutation_block(&source.instance,vault_id,"move",&id,"move-review-required"))?;continue;}
                return Err(format!("CONTENT_MOVE_HTTP_{status}"));
            }
            source.with_db(&state,|db|db.managed_move_ack(&source.instance,vault_id,&id,&request,&receipt))?;
            pushed+=1;
        }
        let operations = source.with_db(&state, |db| {
            db.content_prepare_available_operations(&source.instance, vault_id, unique_create)
        })?;
        for prepared in operations {
            source.check(&state)?;
            let operation = &prepared.payload;
            let id = operation["noteId"]
                .as_str()
                .ok_or("CONTENT_OPERATION_INVALID")?;
            let op_id = operation["opId"]
                .as_str()
                .ok_or("CONTENT_OPERATION_INVALID")?;
            if prepared.route == crate::db::content_db::NoteOperationRoute::KnowledgeImportPlanned
                && (capabilities["knowledgeImportPlan"]["version"]!=1 || capabilities["knowledgeImportPlan"]["exactPaths"]!=true) {
                // A downgrade/absent capability never selects a generic create.
                desktop_busy_note_ids.push(id.to_owned());
                continue;
            }
            let source_ref = &source;
            let state_ref = &state;
            let (outcome, result) = mutation::dispatch(&prepared, |path, method, payload| async move {
                source_ref.mutate(state_ref, &path, method, &payload).await
            }).await?;
            source.check(&state)?;
            if outcome == Outcome::Ack {
                if result["opId"] != op_id {
                    return Err("CONTENT_ACK_INVALID".into());
                }
                source.with_db(&state, |db| {
                    db.content_ack(&source.instance, vault_id, id, op_id, &result["document"])
                })?;
                pushed += 1;
            } else if outcome == Outcome::LegacyCreateCollision || outcome == Outcome::NoteConflict {
                if outcome == Outcome::LegacyCreateCollision {
                    // R1.6-C: a CREATE 409 is a FILENAME COLLISION, never a
                    // same-note two-version conflict. NO content_conflict(),
                    // NO remote_note(newId) tombstone, NO conflict banner:
                    // retire/regenerate the create intent (stale-intent retry
                    // or bounded auto-copy) and let the next pass publish it.
                    source.check(&state)?;
                    let outcome = source.with_db(&state, |db| {
                        db.content_create_collision_retry(&source.instance, vault_id, id, operation)
                    })?;
                    if outcome["retried"] == true {
                        create_retry_pending = true;
                    }
                    if let Some(title) = outcome["renamed"].as_str() {
                        auto_renamed.push(json!({"noteId": id, "title": title}));
                    }
                } else {
                    let document = remote_note(&source, vault_id, id).await?;
                    source.with_db(&state, |db| {
                        db.content_conflict(&source.instance, vault_id, id, &document)
                    })?;
                }
            } else if outcome == Outcome::DesktopBusy {
                // A dirty desktop editor is a pending state. Keep the exact
                // operation and allow the normal polling/backoff to retry.
                desktop_busy_note_ids.push(id.to_owned());
                continue;
            } else {
                let Outcome::Refused(status) = outcome else { return Err("CONTENT_OPERATION_INVALID".into()); };
                if prepared.route == crate::db::content_db::NoteOperationRoute::KnowledgeImportPlanned && matches!(status,400|404|409|422) {
                    source.with_db(&state,|db|db.managed_linked_block(&source.instance,vault_id,id))?;
                    continue;
                }
                if source.with_db(&state, |db| db.content_pause_blank_rename(&source.instance, vault_id, &prepared, status, &result))? {
                    // Keep the old submitted bytes in both active storage and
                    // pause audit. No old-op automatic replay, no fake ACK;
                    // unrelated prepared notes and the read side may proceed.
                    continue;
                }
                let mut error = mutation::refusal_error(status, &prepared, &result);
                error.push_str(&mutation::receiver_context(source.gateway.base_url(), &catalog_result, &source.instance));
                return Err(error);
            }
        }
    }
    if capabilities["capabilities"]["noteAttachments"] == true {
        pushed += uploads::upload_pending(&source, &state, vault_id).await?;
    }
    let position = source.with_db(&state, |db| {
        db.content_sync_position(&source.instance, vault_id)
    })?;
    if position["initialized"] != true {
        let mut path = format!("/v1/notes?vault={}&limit=100", encode(vault_id));
        if let Some(after) = position["afterId"].as_str().filter(|s| !s.is_empty()) {
            path.push_str(&format!("&afterId={}", encode(after)));
        }
        if let Some(mark) = position["snapshotSeq"].as_i64() {
            path.push_str(&format!("&snapshotSeq={mark}"));
        }
        let page = source.gateway.content_get(&path).await?;
        let mut documents = page["items"]
            .as_array()
            .ok_or("CONTENT_RESPONSE_INVALID")?
            .clone();
        // Initial metadata pages do not clone the library's bodies. Existing
        // drafts do need a full opposing version before exposing a conflict.
        for document in &mut documents {
            let id = document["noteId"]
                .as_str()
                .ok_or("CONTENT_RESPONSE_INVALID")?;
            let dirty = source.with_db(&state, |db| {
                Ok(db
                    .content_note(&source.instance, vault_id, id)
                    .ok()
                    .is_some_and(|n| n["dirty"] == true))
            })?;
            if dirty {
                *document = remote_note(&source, vault_id, id).await?;
            }
        }
        let done = page["hasMore"] == false;
        source.with_db(&state, |db| {
            db.content_apply_batch(
                &source.instance,
                vault_id,
                &documents,
                page["snapshotSeq"]
                    .as_i64()
                    .ok_or("CONTENT_RESPONSE_INVALID")?,
                Some((page["nextId"].as_str().unwrap_or(""), done)),
            )
        })?;
        return Ok(json!({"continuation":true,"pushed":pushed,"applied":documents.len(),"autoRenamed":auto_renamed,"instanceId":source.instance,"vaultId":vault_id,"pairingReviewRequired":pairing_review,"warningCode":if pairing_review { "CONTENT_PAIRING_REVIEW_REQUIRED" } else { "" },"desktopBusyNoteIds":desktop_busy_note_ids}));
    }

    let cursor = position["cursor"].as_i64().unwrap_or(0);
    let page = match source
        .gateway
        .content_get(&format!(
            "/v1/sync/changes?vault={}&after={cursor}&limit=100",
            encode(vault_id)
        ))
        .await
    {
        Ok(value) => value,
        Err(error) if error.contains("410") => {
            source.with_db(&state, |db| {
                db.content_resnapshot(&source.instance, vault_id)
            })?;
            return Ok(json!({"continuation":true,"pushed":pushed,"applied":0,"instanceId":source.instance,"vaultId":vault_id,"pairingReviewRequired":pairing_review,"warningCode":if pairing_review { "CONTENT_PAIRING_REVIEW_REQUIRED" } else { "" },"desktopBusyNoteIds":desktop_busy_note_ids}));
        }
        Err(error) => return Err(error),
    };
    let changes = page["changes"]
        .as_array()
        .ok_or("CONTENT_RESPONSE_INVALID")?;
    // Multiple changes for one note are safely coalesced to its current value;
    // the cursor and all resulting documents commit in the same transaction.
    let (documents, deferred) = offline::change_documents(changes, vault_id, source.with_db(&state,|db|db.offline_selected(&source.instance,vault_id))?, |id| {
        let source = &source;
        async move { remote_note(source, vault_id, &id).await }
    }).await?;
    source.with_db(&state, |db| {
        db.content_apply_batch_deferred(
            &source.instance,
            vault_id,
            &documents,
            page["cursor"].as_i64().ok_or("CONTENT_RESPONSE_INVALID")?,
            None,
            &deferred,
        )
    })?;
    let (prepared, preparation_more) = offline::prepare_one(&source, &state, vault_id).await?;
    let resource_more = replica_resources::prepare_one(&source, state.clone(), &app, vault_id, &capabilities).await?;
    Ok(
        json!({"continuation":page["hasMore"]==true || pushed>0 || create_retry_pending || preparation_more || resource_more || folder_more,"pushed":pushed,"applied":documents.len()+usize::from(prepared)+folder_applied,"autoRenamed":auto_renamed,"createRetryPending":create_retry_pending,"instanceId":source.instance,"vaultId":vault_id,"pairingReviewRequired":pairing_review,"warningCode":if pairing_review { "CONTENT_PAIRING_REVIEW_REQUIRED" } else { "" },"desktopBusyNoteIds":desktop_busy_note_ids,"attentionRequired":source.with_db(&state, |db| db.content_sync_attention(&source.instance, vault_id))?}),
    )
}

#[tauri::command]
pub(crate) fn content_vaults(state: State<'_, SharedState>) -> Result<Value, String> {
    with_db(&state, |db| db.content_vaults())
}

#[tauri::command]
pub(crate) async fn content_notes(
    state: State<'_, SharedState>,
    instance: String,
    vault: String,
    q: String,
    page: u32,
    directory: Option<String>,
) -> Result<Value, String> {
    let directory = directory.unwrap_or_default();
    if q.len() > 4096 || page == 0 || page > 1_000_000 {
        return Err("CONTENT_QUERY_INVALID".into());
    }
    // A confirmed replica is the SAME list authority online and offline.
    // Querying it includes saved full bodies and unsent drafts; no split list.
    let replica = with_db(&state, |db| {
        offline::local_owner(db, &instance)?;
        if db.offline_selected(&instance, &vault)? {
            let mut result = db.content_notes(&instance, &vault, &q, page, &directory)?;
            result["source"] = json!("cache");
            Ok(Some(result))
        } else { Ok(None) }
    })?;
    if let Some(result) = replica { return Ok(result); }
    // A0-2: directory filters the LIVE gateway query too (vault-relative
    // prefix; the desktop serves this on the same route).
    let directory_query = if directory.trim().is_empty() {
        String::new()
    } else {
        format!("&directory={}", encode(&directory))
    };
    // A0-closure: a directory filter alone must also hit the live gateway
    // (previously only a non-empty q triggered the live path).
    if !q.trim().is_empty() || !directory.trim().is_empty() {
        if let Some(source) = Source::capture_expected(&state, &instance).and_then(|s| s.scoped(None, Some(&vault)))
            .ok()
            .filter(|s| s.instance == instance)
        {
            source.ensure_scope_protocol(&state).await?;
            // This is a scoped metadata GET, like capabilities and Services
            // discovery: use their existing bounded transient-response policy.
            // Never retry permission/identity errors or silently fall back.
            match source
                .metadata_get(&state, &format!(
                    "/v1/notes?vault={}&q={}&page={page}&limit=50{directory_query}",
                    encode(&vault),
                    encode(&q)
                ))
                .await
            {
                Ok(value) => {
                    return source.with_db(&state, |db| {
                        let rows = value["items"]
                            .as_array()
                            .ok_or("CONTENT_RESPONSE_INVALID")?;
                        let position = db.content_sync_position(&instance, &vault)?;
                        db.content_apply_batch(
                            &instance,
                            &vault,
                            rows,
                            position["cursor"].as_i64().unwrap_or(0),
                            None,
                        )?;
                        let items = rows
                            .iter()
                            .map(|row| {
                                db.content_note(
                                    &instance,
                                    &vault,
                                    row["noteId"].as_str().unwrap_or(""),
                                )
                            })
                            .collect::<Result<Vec<_>, _>>()?;
                        Ok(json!({"items":items,"hasMore":value["hasMore"],"page":page,"source":"live"}))
                    })
                }
                Err(e) if e == "CONTENT_OFFLINE" => {}
                Err(e) => return Err(e),
            }
        }
    }
    let mut cached = with_db(&state, |db| db.content_notes(&instance, &vault, &q, page, &directory))?;
    cached["source"] = json!("cache"); // offline fallback: truthful provenance
    Ok(cached)
}

#[tauri::command]
pub(crate) async fn content_note_directories(
    state: State<'_, SharedState>,
    instance: String,
    vault: String,
) -> Result<Value, String> {
    with_db(&state, |db| db.content_note_directories(&instance, &vault))
}

#[tauri::command]
pub(crate) fn content_note_begin(
    state: State<'_, SharedState>,
    instance: String,
    vault: String,
    id: String,
) -> Result<Value, String> {
    with_db(&state, |db| db.content_begin_edit(&instance, &vault, &id))
}

#[tauri::command]
pub(crate) fn content_note_get(
    state: State<'_, SharedState>,
    instance: String,
    vault: String,
    id: String,
) -> Result<Value, String> {
    with_db(&state, |db| db.content_note(&instance, &vault, &id))
}

async fn refresh_cold_note(
    state: &SharedState,
    source: &Source,
    instance: &str,
    vault: &str,
    id: &str,
) -> Result<Option<Value>, String> {
    let cache_generation = source.with_db(state, |db| db.content_cache_generation(instance, vault))?;
    bootstrap::fetch_if_missing(
        || source.with_db(state, |db| db.content_note_cached(instance, vault, id).map(|n| n.is_some())),
        || async {
            public_id(id)?;
            public_id(vault)?;
            source.verify_owner(state)?;
            source.check(state)?;
            source.ensure_scope_protocol(state).await?;
            // A missing server note remains a failed read, not a synthetic
            // tombstone or an editable empty baseline.
            let document = source.gateway.content_get(
                &format!("/v1/notes/{id}?vault={}", encode(vault)),
            ).await?;
            source.verify_owner(state)?;
            source.check(state)?;
            Ok(document)
        },
        |document| source.with_db(state, |db| {
            if db.content_cache_generation(instance, vault)? != cache_generation {
                return Err("CONTENT_CACHE_CHANGED".into());
            }
            db.content_cache_bootstrap(instance, vault, id, &document)
        }),
    ).await
}

// SERVICES-KNOWLEDGE-BROWSE-R1 REPAIR-R4 (B) — ONE bounded LOCAL-ONLY bulk
// read for the canonical list rows' content previews. This is a note_cache
// DB projection: zero network, zero Desktop calls, no per-row detail fetch,
// and it never mutates anything. Bounded by the caller's id list (the page
// passes at most the loaded page's ids); the SQL itself also clamps to 100.
#[tauri::command]
pub(crate) fn content_note_previews(
    state: State<'_, SharedState>,
    instance: String,
    vault: String,
    ids: Vec<String>,
) -> Result<Value, String> {
    with_db(&state, |db| db.content_note_previews(&instance, &vault, &ids))
}

/// Bounded speculative body read. Never begins an editor or publishes a draft.
#[tauri::command]
pub(crate) async fn content_note_prefetch(state: State<'_, SharedState>, instance: String,
    vault: String, id: String, expected_revision: String, job_id: String) -> Result<Value,String> {
    public_id(&id)?; public_id(&vault)?; public_id(&job_id)?;
    if expected_revision.len() > 4096 { return Err("CONTENT_ID_INVALID".into()); }
    static SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
    let _slot = SLOTS.try_acquire().map_err(|_| "CONTENT_BUSY")?;
    let source = Source::capture_expected(&state, &instance)?.scoped(None, Some(&vault))?;
    if source.with_db(&state, |db| db.content_cache_paused(&instance,&vault))? { return Ok(json!({"changed":false})); }
    let observed = source.with_db(&state, |db| db.content_note_cached(&instance,&vault,&id))?;
    if !Db::content_prefetch_eligible(&observed) { return Ok(json!({"changed":false})); }
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut jobs=DOWNLOADS.get_or_init(Default::default).lock().map_err(|_|"CONTENT_BUSY")?;
        if jobs.contains_key(&job_id) || jobs.len()>=128 {return Err("CONTENT_BUSY".into());}
        jobs.insert(job_id.clone(),cancelled.clone());
    }
    let _job=DownloadJob{id:job_id,cancelled:cancelled.clone()};
    let check=|| { if cancelled.load(Ordering::Acquire) {return Err("CONTENT_CANCELLED".into());} source.check(&state) };
    cancellable(source.capabilities(&state,"noteRead"),&check).await??;
    check()?;
    let document=cancellable(remote_note(&source,&vault,&id),&check).await??;
    if !expected_revision.is_empty() && document["revision"].as_str()!=Some(expected_revision.as_str()) {
        return Ok(json!({"changed":false}));
    }
    check()?;
    let changed=source.with_db(&state,|db| {
        if cancelled.load(Ordering::Acquire) {return Err("CONTENT_CANCELLED".into());}
        db.content_prefetch_adopt(&instance,&vault,&id,&observed,&document)
    })?;
    Ok(json!({"changed":changed}))
}

#[tauri::command]
pub(crate) async fn content_note_refresh(
    state: State<'_, SharedState>,
    instance: String,
    vault: String,
    id: String,
) -> Result<Value, String> {
    public_id(&id)?;
    let source = Source::capture_expected(&state, &instance)?.scoped(None, Some(&vault))?;
    // Cold canonical rows need a readonly baseline first. Never allocate an
    // editor epoch across this await: the renderer must still own the page
    // before issuing the separate, synchronous content_note_begin.
    if let Some(note) = refresh_cold_note(&state, &source, &instance, &vault, &id).await? {
        return Ok(note);
    }
    // R1.5.1: a locally staged pending create with NO committed server
    // document must not remote-GET an expected pre-publication 404 (which
    // the sync path would read as a tombstone and poison the editor with a
    // fake conflict). Retain the local cached draft; the existing sync
    // coordinator publishes the create, and after the Desktop ack the
    // serverDocument exists and normal refresh resumes.
    let pending_unpublished = source.with_db(&state, |db| {
        db.content_note_pending_unpublished(&instance, &vault, &id)
    })?;
    if pending_unpublished {
        return source.with_db(&state, |db| db.content_note(&instance, &vault, &id));
    }
    let cache_generation = source.with_db(&state, |db| db.content_cache_generation(&instance, &vault))?;
    let expected = source.with_db(&state, |db| db.content_note_cached(&instance, &vault, &id))?;
    let document = remote_note(&source, &vault, &id).await?;
    // A late GET cannot replace an edit, ACK or newer observation that
    // committed while it was in flight. Always return today's local truth.
    source.with_db(&state, |db| {
        if db.content_cache_generation(&instance, &vault)? == cache_generation {
            db.content_refresh_adopt(&instance, &vault, &id, &expected, &document)?;
        }
        db.content_note(&instance, &vault, &id)
    })
}

#[tauri::command]
pub(crate) fn content_note_edit(
    state: State<'_, SharedState>,
    instance: String,
    vault: String,
    id: String,
    title: String,
    content: String,
    epoch: i64,
    generation: i64,
    expected_revision: Option<String>,
) -> Result<Value, String> {
    if title.len() > 1024 || content.len() > 4 * 1024 * 1024 {
        return Err("CONTENT_NOTE_TOO_LARGE".into());
    }
    with_db(&state, |db| {
        offline::local_owner(db, &instance)?;
        db.content_edit_observed(&instance, &vault, &id, &title, &content, epoch, generation, expected_revision.as_deref())
    })
}

/// Explicit local-only recovery, serialized with ALL automatic Content sync.
/// No network proof/cancellation is invented, and no fresh baseline is fetched.
#[tauri::command]
pub(crate) async fn content_note_resume_paused(
    state: State<'_, SharedState>, instance: String, vault: String, id: String,
    paused_op_id: String, epoch: i64, generation: i64,
) -> Result<Value, String> {
    let _gate = SYNC_GATE.get_or_init(|| tokio::sync::Mutex::new(())).lock().await;
    let source = Source::capture_expected(&state, &instance)?.scoped(None, Some(&vault))?;
    source.with_db(&state, |db| db.content_resume_paused(&instance, &vault, &id, &paused_op_id, epoch, generation))
}

#[tauri::command]
pub(crate) fn content_note_create(
    state: State<'_, SharedState>,
    instance: String,
    vault: String,
    title: String,
    parent_relative_path: Option<String>,
) -> Result<String, String> {
    if title.trim().is_empty() || title.len() > 200 {
        return Err("CONTENT_TITLE_INVALID".into());
    }
    if with_db(&state, |db| { offline::local_owner(db, &instance)?; db.offline_selected(&instance, &vault) })? {
        return with_db(&state, |db| db.offline_create_in(&instance, &vault, title.trim(), parent_relative_path.as_deref().unwrap_or("")));
    }
    let id = format!("kn-{}", uuid::Uuid::new_v4().simple());
    with_db(&state, |db| {
        db.content_sync_position(&instance, &vault)?;
        // R1.5-B: an optional EXISTING parent directory stages the pending
        // create inside it (the Desktop ack replaces the provisional path).
        db.content_create_in(&instance, &vault, &id, title.trim(), "", parent_relative_path.as_deref().unwrap_or(""))
    })?;
    Ok(id)
}

#[tauri::command]
pub(crate) async fn content_note_delete(
    state: State<'_, SharedState>,
    instance: String,
    vault: String,
    id: String,
) -> Result<(), String> {
    // If sync is currently receiving a refusal, let its exact durable pause
    // finish before checking deletion. Local/offline deletion needs no GET.
    let _gate = SYNC_GATE.get_or_init(|| tokio::sync::Mutex::new(())).lock().await;
    with_db(&state, |db| db.content_delete(&instance, &vault, &id))
}

// KNOWLEDGE-ORGANIZATION-R1 (ORG-1B): apply a committed canonical
// knowledge.move receipt to the Mobile-local note_cache projection.
// Metadata-only provenance (path moves, body revision never fabricated).
#[tauri::command]
pub(crate) fn content_note_move_receipt(
    state: State<'_, SharedState>,
    instance: String,
    vault: String,
    id: String,
    revision: String,
    parent_relative_path: String,
) -> Result<(), String> {
    with_db(&state, |db| {
        crate::db::content_db::content_note_move_receipt(db, &instance, &vault, &id, &revision, &parent_relative_path)
    })
}

// KNOWLEDGE-ORGANIZATION-R1 REPAIR-R1.2: bounded LOCAL-ONLY move-safety
// facts for exactly the selected note ids (dirty/pending/conflict + both
// revision observations). Zero Desktop network.
#[tauri::command]
pub(crate) fn content_note_move_facts(
    state: State<'_, SharedState>,
    instance: String,
    vault: String,
    ids: Vec<String>,
) -> Result<serde_json::Value, String> {
    with_db(&state, |db| {
        db.content_note_move_facts(&instance, &vault, &ids)
    })
}

// KNOWLEDGE-ORGANIZATION-R1 R1.5-A: READ-ONLY directory metadata hydration.
// Reads the existing Content V1 note SUMMARY pages (`GET /v1/notes`, no
// q/directory filter) and applies them through the metadata-only projection.
// It NEVER calls content_sync (no pending write/attachment push), never
// downloads bodies, never edits the Desktop, and never advances the durable
// sync position — the ordinary sync pipeline keeps its own cursor state.
#[tauri::command]
pub(crate) async fn content_hydrate_directories(
    state: State<'_, SharedState>,
    instance: String,
    vault: String,
    after_id: Option<String>,
) -> Result<Value, String> {
    // Serialize against the sync pipeline: hydration never pushes, but the
    // note_cache projection writes must not interleave with a sync batch.
    let _gate = SYNC_GATE
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    let source = Source::capture_expected(&state, &instance)?.scoped(None, Some(&vault))?;
    // Exact owner fence: the captured pairing must BE the requested instance.
    if source.instance != instance {
        return Err("CONTENT_SOURCE_CHANGED".into());
    }
    source.capabilities(&state, "noteRead").await?;
    source.check(&state)?;
    // R1.5.1: ONE bounded page per invocation, resumed from the caller's
    // REAL cursor — never an implicit restart from page 1.
    let mut path = format!("/v1/notes?vault={}&limit=100", encode(&vault));
    if let Some(after) = after_id.as_deref().filter(|s| !s.is_empty()) {
        path.push_str(&format!("&afterId={}", encode(after)));
    }
    let page = source.gateway.content_get(&path).await?;
    let documents = page["items"]
        .as_array()
        .ok_or("CONTENT_RESPONSE_INVALID")?
        .clone();
    let applied = source.with_db(&state, |db| {
        db.content_apply_metadata_batch(&instance, &vault, &documents)
    })?;
    let next_after_id = page["nextId"].as_str().unwrap_or("").to_string();
    let has_more = page["hasMore"] == true && !next_after_id.is_empty();
    Ok(json!({"nextAfterId": next_after_id, "hasMore": has_more, "applied": applied}))
}

// R1.5.1: the Desktop CREATE authority — the Content V1 capability truth
// (contentVersion 1 + noteWrite), the exact current Desktop, and the exact
// requested vault being the Desktop's active Content V1 vault. Creating a
// note is NOT gated on the canonical knowledge.move operation.
#[tauri::command]
pub(crate) async fn content_note_create_authority(
    state: State<'_, SharedState>,
    instance: String,
    vault: String,
) -> Result<Value, String> {
    if let Some(authority) = with_db(&state, |db| {
        offline::local_owner(db, &instance)?;
        let rows = db.offline_libraries(&instance)?;
        Ok(rows.as_array().and_then(|rows| rows.iter().find(|row| row["confirmed"] == true && row["vaultId"] == vault)).map(|row|
            json!({"usable":row["writeState"]=="granted","reason":if row["writeState"]=="granted" {""} else {"CONTENT_OFFLINE_WRITE_UNAVAILABLE"},"vaultId":vault,"localReplica":true})))
    })? { return Ok(authority); }
    let source = Source::capture_expected(&state, &instance)?.scoped(None, Some(&vault))?;
    if source.instance != instance {
        return Ok(json!({"usable": false, "reason": "CONTENT_SOURCE_CHANGED"}));
    }
    // capabilities() itself proves contentVersion==1 + noteWrite==true.
    if let Err(reason) = source.capabilities(&state, "noteWrite").await {
        return Ok(json!({"usable": false, "reason": reason}));
    }
    let vaults = source.gateway.content_get("/v1/vaults").await?;
    // R1.5.2: exact-owner self-contained fencing AFTER the wire read — the
    // pairing must still be this instance before usable is ever reported.
    source.check(&state)?;
    let active = vaults["items"]
        .as_array()
        .and_then(|rows| rows.first())
        .and_then(|v| v["vaultId"].as_str())
        .unwrap_or("");
    if active.is_empty() || active != vault {
        return Ok(json!({"usable": false, "reason": "CONTENT_VAULT_UNAVAILABLE"}));
    }
    Ok(json!({"usable": true, "contentVersion": 1, "noteWrite": true, "vaultId": active}))
}

#[tauri::command]
pub(crate) fn content_note_resolve(
    state: State<'_, SharedState>,
    instance: String,
    vault: String,
    id: String,
    copy: bool,
) -> Result<Option<String>, String> {
    with_db(&state, |db| {
        db.content_resolve(&instance, &vault, &id, copy)
    })
}
