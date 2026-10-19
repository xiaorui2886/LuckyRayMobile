//! The actual cold readonly refresh composition; never an editor epoch owner.
use serde_json::Value;
use std::future::Future;

pub(super) async fn fetch_if_missing<B, F, Fut, A, T>(
    is_cached: B,
    fetch: F,
    adopt: A,
) -> Result<Option<Value>, String>
where
    B: FnOnce() -> Result<bool, String>,
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<T, String>>,
    A: FnOnce(T) -> Result<Value, String>,
{
    if is_cached()? {
        return Ok(None);
    }
    adopt(fetch().await?).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use serde_json::json;
    use std::cell::{Cell, RefCell};

    fn fixture() -> RefCell<Db> {
        let db = Db::open(std::path::Path::new(":memory:")).unwrap();
        db.content_vault_remember("A", "v", "Vault").unwrap();
        RefCell::new(db)
    }

    fn document() -> Value {
        json!({"noteId":"fresh", "vaultId":"v", "title":"Desktop fresh",
            "relativePath":"Desktop fresh.md", "revision":"r1", "content":"desktop body",
            "resources":[], "updatedAt":"2026-09-30T16:00:00Z"})
    }

    // Canonical registeredList can return this exact id WITHOUT inserting a
    // note_cache row. Exercise the same begin/cache/fetch/adopt chain the real
    // command uses, against the real SQLite layer (no private device DB).
    #[tokio::test]
    async fn canonical_fresh_row_without_cache_bootstraps_exact_body_before_begin() {
        let db = fixture();
        let before = db.borrow().content_sync_position("A", "v").unwrap();
        let gets = Cell::new(0);
        assert_eq!(db.borrow().content_begin_edit("A", "v", "fresh").unwrap_err(), "CONTENT_NOTE_NOT_CACHED");
        let note = fetch_if_missing(
            || db.borrow().content_note_cached("A", "v", "fresh").map(|n| n.is_some()),
            || async { gets.set(gets.get() + 1); Ok(document()) },
            |doc| db.borrow_mut().content_cache_bootstrap("A", "v", "fresh", &doc),
        ).await.unwrap().unwrap();
        assert_eq!(gets.get(), 1);
        assert_eq!(note["noteId"], "fresh");
        assert_eq!(note["content"], "desktop body");
        assert_eq!(note["editorEpoch"], 0, "readonly bootstrap never owns the editor");
        assert_eq!(db.borrow().content_begin_edit("A", "v", "fresh").unwrap()["editorEpoch"], 1);
        assert_eq!(note["dirty"], false);
        assert_eq!(db.borrow().content_sync_position("A", "v").unwrap(), before);
        assert!(db.borrow_mut().content_prepare_operations("A", "v").unwrap().is_empty());
    }

    #[tokio::test]
    async fn existing_pending_draft_keeps_offline_fast_path_without_fetch_or_adopt() {
        let db = fixture();
        db.borrow().content_create("A", "v", "fresh", "Phone title", "phone body").unwrap();
        let cold = fetch_if_missing(
            || db.borrow().content_note_cached("A", "v", "fresh").map(|n| n.is_some()),
            || async { panic!("offline cached read must not fetch"); #[allow(unreachable_code)] Ok(()) },
            |()| { panic!("cached read must not adopt") },
        ).await.unwrap();
        assert!(cold.is_none());
        let note = db.borrow().content_begin_edit("A", "v", "fresh").unwrap();
        assert_eq!(note["content"], "phone body");
        assert_eq!(note["dirty"], true);
        assert_eq!(note["pendingKind"], "create");
        assert_eq!(note["editorEpoch"], 1);
    }

    #[tokio::test]
    async fn other_database_errors_never_trigger_fetch() {
        let result = fetch_if_missing(
            || Err("CONTENT_DATABASE: broken schema".to_owned()),
            || async { panic!("DB errors are not cache misses"); #[allow(unreachable_code)] Ok(()) },
            |()| { panic!("DB errors must not adopt") },
        ).await;
        assert_eq!(result.unwrap_err(), "CONTENT_DATABASE: broken schema");
    }

    #[tokio::test]
    async fn failed_read_or_source_fence_does_not_insert_or_advance_position() {
        for error in ["CONTENT_OFFLINE", "CONTENT_SOURCE_CHANGED", "CONTENT_HTTP_403"] {
            let db = fixture();
            let before = db.borrow().content_sync_position("A", "v").unwrap();
            let result = fetch_if_missing(
                || db.borrow().content_note_cached("A", "v", "fresh").map(|n| n.is_some()),
                || async { Err::<Value, _>(error.to_owned()) },
                |doc| db.borrow_mut().content_cache_bootstrap("A", "v", "fresh", &doc),
            ).await;
            assert_eq!(result.unwrap_err(), error);
            assert!(db.borrow().content_note("A", "v", "fresh").is_err());
            assert_eq!(db.borrow().content_sync_position("A", "v").unwrap(), before);
        }
    }

    #[tokio::test]
    async fn late_fetch_preserves_new_pending_draft_and_immutable_prepared_operation() {
        let db = fixture();
        let original = RefCell::new(None);
        let note = fetch_if_missing(
            || db.borrow().content_note_cached("A", "v", "fresh").map(|n| n.is_some()),
            || async {
                // Another editor/sync creates the row while the detail GET is
                // in flight, then the user keeps typing after preparation.
                let mut live = db.borrow_mut();
                live.content_create("A", "v", "fresh", "Phone title", "phone A").unwrap();
                let op = live.content_prepare_routed_operations("A", "v", true).unwrap().pop().unwrap();
                let epoch = live.content_begin_edit("A", "v", "fresh").unwrap()["editorEpoch"].as_i64().unwrap();
                live.content_edit("A", "v", "fresh", "Phone newer title", "phone B", epoch, 1).unwrap();
                *original.borrow_mut() = Some(op);
                Ok(document())
            },
            |doc| db.borrow_mut().content_cache_bootstrap("A", "v", "fresh", &doc),
        ).await.unwrap().unwrap();
        assert_eq!(note["title"], "Phone newer title");
        assert_eq!(note["content"], "phone B");
        assert_eq!(note["serverDocument"], Value::Null);
        assert_eq!(note["dirty"], true);
        assert_eq!(note["pendingKind"], "create");
        assert_eq!(note["draftGeneration"], 2);
        assert_eq!(note["editorEpoch"], 1, "late readonly A cannot steal B's epoch");
        db.borrow().content_edit("A", "v", "fresh", "Phone newer title", "phone C", 1, 2).unwrap();
        assert_eq!(db.borrow().content_note("A", "v", "fresh").unwrap()["content"], "phone C",
            "B's next generation still saves after late A response");
        let replay = db.borrow_mut().content_prepare_routed_operations("A", "v", false).unwrap().pop().unwrap();
        let sent = original.borrow();
        let sent = sent.as_ref().unwrap();
        assert_eq!(replay.payload, sent.payload);
        assert_eq!(replay.route, sent.route);
    }

    #[test]
    fn wrong_note_vault_or_summary_cannot_bootstrap_a_body() {
        let db = fixture();
        let before = db.borrow().content_sync_position("A", "v").unwrap();
        for key in ["noteId", "vaultId", "content", "revision", "resources", "updatedAt", "deleted"] {
            let mut invalid = document();
            invalid[key] = if key == "deleted" { json!(true) }
                else if key == "content" || key == "resources" || key == "updatedAt" { Value::Null }
                else { json!("") };
            assert_eq!(db.borrow_mut().content_cache_bootstrap("A", "v", "fresh", &invalid).unwrap_err(), "CONTENT_DOCUMENT_INVALID");
            assert!(db.borrow().content_note("A", "v", "fresh").is_err());
            assert_eq!(db.borrow().content_sync_position("A", "v").unwrap(), before);
        }
        let mut summary = document();
        summary.as_object_mut().unwrap().remove("content");
        assert!(db.borrow_mut().content_cache_bootstrap("A", "v", "fresh", &summary).is_err());
        assert!(db.borrow().content_note("A", "v", "fresh").is_err());
        assert_eq!(db.borrow().content_sync_position("A", "v").unwrap(), before);
    }
}
