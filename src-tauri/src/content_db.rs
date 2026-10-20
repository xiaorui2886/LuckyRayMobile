use super::*;
use serde_json::{json, Value};
#[path = "content_offline_db.rs"]
pub(crate) mod offline;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NoteOperationRoute {
    Content,
    KnowledgeCreateUnique,
}

impl NoteOperationRoute {
    fn stored(self) -> &'static str {
        match self {
            Self::Content => "content",
            Self::KnowledgeCreateUnique => "knowledgeCreateUnique",
        }
    }

    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "content" => Ok(Self::Content),
            "knowledgeCreateUnique" => Ok(Self::KnowledgeCreateUnique),
            _ => Err("CONTENT_OPERATION_ROUTE_INVALID".into()),
        }
    }
}

pub(crate) struct PreparedNoteOperation {
    pub payload: Value,
    pub route: NoteOperationRoute,
}

fn fail(error: rusqlite::Error) -> String {
    format!("CONTENT_DATABASE: {error}")
}
fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}

// A local proof of an ACK for the exact body this editor already saved, not
// another body authority. One app_meta slot per scoped note; schema and wire
// DTOs stay unchanged. Epoch + draft generation fence retired editors/inputs.
#[derive(serde::Serialize, serde::Deserialize)]
struct EditorBodyAck {
    epoch: i64,
    draft_generation: i64,
    revision: String,
}

fn editor_body_ack_key(instance: &str, vault: &str, id: &str) -> String {
    format!("knowledge.editor.body-ack.v1:{}", json!([instance, vault, id]))
}

fn editor_body_ack_revision(
    db: &Connection, instance: &str, vault: &str, id: &str, epoch: i64,
) -> Result<Option<String>, String> {
    let row: Option<(i64, i64, String, Option<String>, Option<String>)> = db.query_row(
        "SELECT n.editor_epoch,n.draft_generation,n.revision,n.base_revision,m.value
         FROM note_cache n LEFT JOIN app_meta m ON m.key=?4
         WHERE n.desktop_instance_id=?1 AND n.vault_id=?2 AND n.note_id=?3
           AND n.dirty=0 AND n.deleted=0 AND n.conflict_document IS NULL",
        params![instance, vault, id, editor_body_ack_key(instance, vault, id)],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    ).optional().map_err(fail)?;
    let Some((current_epoch, generation, revision, base, Some(bytes))) = row else { return Ok(None); };
    let Ok(ack) = serde_json::from_str::<EditorBodyAck>(&bytes) else { return Ok(None); };
    if current_epoch == epoch && ack.epoch == epoch && ack.draft_generation == generation
        && !revision.is_empty() && ack.revision == revision && base.as_deref() == Some(revision.as_str()) {
        Ok(Some(revision))
    } else { Ok(None) }
}

/// Apply one Desktop document. Two DISTINCT facts are maintained:
///
///  * `server_document` — the latest remote observation. It may be a metadata
///    summary with no `content` at all, and advances on every apply.
///  * `cached_document` + `content` + `revision` — the last COMPLETE body the
///    phone actually owns, and the revision that body truly corresponds to.
///    Only a document that carries a `content` key may advance these.
///
/// A summary without `content` must never clear the body, and must never
/// re-label it: `revision` feeds `expectedRevision` on the mutation path, so
/// pretending an old body is the new revision would silently overwrite a
/// Desktop update instead of surfacing the conflict.
/// UTC now in the same ISO shape the gateway documents carry.
fn now_iso() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| {
            let secs = d.as_secs() as i64;
            let days = secs.div_euclid(86_400);
            let tod = secs.rem_euclid(86_400);
            let (y, m, dd) = civil_from_days(days);
            format!(
                "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.000Z",
                y, m, dd,
                tod / 3600, (tod % 3600) / 60, tod % 60
            )
        })
        .unwrap_or("1970-01-01T00:00:00.000Z".to_string())
}

/// Howard Hinnant's civil-from-days, for the ISO timestamp above.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn apply_document(db: &Connection, instance: &str, vault: &str, doc: &Value) -> Result<(), String> {
    let id = text(doc, "noteId");
    if id.is_empty() || text(doc, "vaultId") != vault {
        return Err("CONTENT_DOCUMENT_INVALID".into());
    }
    let existing_vault: Option<String> = db
        .query_row(
            "SELECT vault_id FROM note_cache WHERE desktop_instance_id=?1 AND note_id=?2",
            params![instance, id],
            |row| row.get(0),
        )
        .optional()
        .map_err(fail)?;
    if existing_vault
        .as_deref()
        .is_some_and(|existing| !existing.is_empty() && existing != vault)
    {
        return Err("CONTENT_DOCUMENT_INVALID".into());
    }
    let deleted = doc["deleted"] == true;
    // A tombstone carries no body either; it deletes the note, so it must not
    // be mistaken for an unprovable summary (the recoverable text is kept by
    // the row-level UPDATE below).
    //
    // `content: ""` IS a real, complete empty body and is strictly different
    // from the field being absent — the presence test below is the whole point.
    let carries_body = !deleted && doc.get("content").is_some();
    // A first sighting that is only a summary has no body we could base an
    // edit on, so it must not claim a body revision either — that keeps the
    // row honestly "no trustworthy baseline" exactly like the v7 backfill.
    let body_revision = if carries_body { text(doc, "revision") } else { "" };
    // Conflict rule: a summary without a body is NOT an opposing version — it
    // carries nothing the user could compare or keep, and `content_resolve`
    // refuses to act on it. Treating it as one would block the draft from ever
    // being sent and leave an unresolvable local conflict. The real protection
    // is the SERVER's 409 on the mutation (which carries the full opposing
    // document); that path is unchanged. A tombstone or a document WITH a body
    // still opens the existing dual-preservation conflict exactly as before.
    let doc = doc;
    db.execute("INSERT INTO note_cache(desktop_instance_id,note_id,vault_id,title,relative_path,content,revision,updated_at,server_document,cached_document,deleted)
        VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
        ON CONFLICT(desktop_instance_id,note_id) DO UPDATE SET
        server_document=excluded.server_document,
        title=CASE WHEN note_cache.dirty=0 THEN excluded.title ELSE note_cache.title END,
        relative_path=excluded.relative_path,
        content=CASE WHEN note_cache.dirty=0 AND ?12 THEN excluded.content ELSE note_cache.content END,
        revision=CASE WHEN note_cache.dirty=0 AND ?12 THEN excluded.revision ELSE note_cache.revision END,
        cached_document=CASE WHEN ?12 THEN excluded.cached_document ELSE note_cache.cached_document END,
        deleted=CASE WHEN note_cache.dirty=0 AND ?12 THEN excluded.deleted
                     WHEN note_cache.dirty=0 AND ?13 THEN 1 ELSE note_cache.deleted END,
        updated_at=excluded.updated_at,
        conflict_document=CASE WHEN note_cache.dirty=1
            AND (?13 OR (?12 AND COALESCE(note_cache.base_revision,'')!=excluded.revision))
            AND NOT EXISTS(SELECT 1 FROM content_note_operation op WHERE op.desktop_instance_id=?1 AND op.vault_id=?3 AND op.note_id=?2)
            THEN excluded.server_document ELSE note_cache.conflict_document END",
        params![instance, id, vault, text(doc,"title"), text(doc,"relativePath"), text(doc,"content"), body_revision, text(doc,"updatedAt"), doc.to_string(),
            if carries_body { Some(doc.to_string()) } else { None },
            deleted,
            carries_body, deleted]).map_err(fail)?;
    Ok(())
}

    /// KNOWLEDGE-ORGANIZATION-R1 (ORG-1B): apply a COMMITTED canonical
    /// `knowledge.move` receipt to the Mobile note_cache projection.
    ///
    /// Provenance rules (the card's B4, verbatim):
    ///   - the cached relative-path metadata moves to the committed parent
    ///     (the file BASENAME is preserved — move never renames);
    ///   - the receipt's revision is recorded as the latest REMOTE observation
    ///     (server_document) WITHOUT claiming the cached body bytes are that
    ///     revision — `revision`/`base_revision` keep describing the body the
    ///     phone actually holds, exactly like every metadata-only document;
    ///   - a committed move is never turned into a fake local failure.
    ///
    /// Reuses apply_document's summary semantics rather than adding a second
    /// cache authority: a body-less document updates relative_path +
    /// server_document + updated_at and touches neither content nor the body
    /// revision.
const MIRROR_SEP: char = char::from_u32(0x5c).unwrap();

pub(crate) fn content_note_move_receipt(
    db: &Db,
    instance: &str,
    vault: &str,
    note_id: &str,
    revision: &str,
    parent_relative_path: &str,
) -> Result<(), String> {
    let parent = parent_relative_path.replace(MIRROR_SEP, "/");
    if !parent.trim().is_empty() && !is_clean_vault_relative(&parent) {
    return Err("CONTENT_PATH_INVALID".into());
    }
    let current: Option<(String, String)> = db
    .conn
        .query_row(
            "SELECT relative_path,title FROM note_cache WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3",
            params![instance, vault, note_id],
            |r| Ok((r.get::<_, Option<String>>(0)?.unwrap_or_default(), r.get(1)?)),
        )
        .optional()
        .map_err(fail)?;
    let Some((relative_path, title)) = current else {
        // A note Mobile has never cached has no projection to move; the
        // Desktop commit stands on its own and the next sync converges.
        return Ok(());
    };
    let normalized = relative_path.replace(MIRROR_SEP, "/");
    let basename = normalized.rsplit('/').next().unwrap_or("").to_string();
    if basename.is_empty() {
        return Ok(());
    }
    let new_path = if parent.trim().is_empty() {
        basename
    } else {
        format!("{parent}/{basename}")
    };
    let doc = serde_json::json!({
    "noteId": note_id,
    "vaultId": vault,
    "title": title,
    "relativePath": new_path,
    "revision": revision,
    "updatedAt": now_iso(),
    "deleted": false,
    // deliberately NO "content": a move receipt is metadata-only.
    });
    apply_document(&db.conn, instance, vault, &doc)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Db {
        let mut db = Db {
            conn: Connection::open_in_memory().unwrap(),
        };
        db.migrate_kind().unwrap();
        db.content_vault_remember("desktop-a", "vault-a", "测试库")
            .unwrap();
        db
    }


    fn prefetch_document(revision: &str) -> Value {
        json!({"noteId":"kn-a","vaultId":"vault-a","title":"预加载","relativePath":"预加载.md",
          "revision":revision,"content":"","resources":[],"updatedAt":"2026-10-20T00:00:00Z","deleted":false})
    }
    #[test]
    fn prefetch_empty_body_is_complete_and_does_not_allocate_epoch_or_move_cursor() {
        let mut db=fixture(); let before=db.content_sync_position("desktop-a","vault-a").unwrap();
        assert!(db.content_prefetch_adopt("desktop-a","vault-a","kn-a",&None,&prefetch_document("r1")).unwrap());
        let note=db.content_note_cached("desktop-a","vault-a","kn-a").unwrap();
        assert!(!Db::content_prefetch_eligible(&note));
        assert_eq!(note.as_ref().unwrap()["editorEpoch"],0);
        assert_eq!(db.content_sync_position("desktop-a","vault-a").unwrap(),before);
    }
    #[test]
    fn prefetch_metadata_adoption_is_conditional_on_exact_observation() {
        let mut db=fixture();let mut summary=prefetch_document("r1");summary.as_object_mut().unwrap().remove("content");
        db.content_apply_batch("desktop-a","vault-a",&[summary.clone()],4,None).unwrap();
        let old=db.content_note_cached("desktop-a","vault-a","kn-a").unwrap();
        assert!(Db::content_prefetch_eligible(&old));
        summary["revision"]=json!("r2");db.content_apply_batch("desktop-a","vault-a",&[summary],5,None).unwrap();
        assert!(!db.content_prefetch_adopt("desktop-a","vault-a","kn-a",&old,&prefetch_document("r1")).unwrap());
        let current=db.content_note_cached("desktop-a","vault-a","kn-a").unwrap();
        assert!(db.content_prefetch_adopt("desktop-a","vault-a","kn-a",&current,&prefetch_document("r2")).unwrap());
    }
    #[test]
    fn prefetch_does_not_replace_new_editor_epoch_or_dirty_draft() {
        let mut db=fixture();let mut summary=prefetch_document("r1");summary.as_object_mut().unwrap().remove("content");
        db.content_apply_batch("desktop-a","vault-a",&[summary],1,None).unwrap();
        let old=db.content_note_cached("desktop-a","vault-a","kn-a").unwrap();
        db.content_begin_edit("desktop-a","vault-a","kn-a").unwrap();
        assert!(!db.content_prefetch_adopt("desktop-a","vault-a","kn-a",&old,&prefetch_document("r1")).unwrap());
        for field in ["dirty","deleted"] { let mut n=old.clone().unwrap();n[field]=json!(true);assert!(!Db::content_prefetch_eligible(&Some(n))); }
        let mut n=old.clone().unwrap();n["pendingKind"]=json!("create");assert!(!Db::content_prefetch_eligible(&Some(n)));
        let mut n=old.unwrap();n["conflictDocument"]=json!({"content":"keep"});assert!(!Db::content_prefetch_eligible(&Some(n)));
    }
    #[test]
    fn prefetch_rejects_wrong_scope_and_incomplete_documents() {
        let mut db=fixture();for field in ["noteId","vaultId","content","resources","revision"] {
            let mut doc=prefetch_document("r1");doc.as_object_mut().unwrap().remove(field);
            assert!(db.content_prefetch_adopt("desktop-a","vault-a","kn-a",&None,&doc).is_err());
        }
        assert!(db.content_note_cached("desktop-a","vault-a","kn-a").unwrap().is_none());
    }

    // ------- A0-R2: hostile-path fail-closed + literal prefix -------
    #[test]
    fn hostile_paths_fail_closed_in_directories() {
        let db = fixture();
        let cases = vec![
            ("h1", "C:/Users/Alice/private/note.md"),
            ("h2", "C:\\Users\\Alice\\private\\note.md"),
            ("h3", "//server/share/private/note.md"),
            ("h4", "\\\\server\\\\share\\\\private\\\\note.md"),
            ("h5", "../secret/note.md"),
            ("h6", "A/../secret/note.md"),
            ("h7", "A/./note.md"),
        ];
        for (id, rel) in &cases {
            upsert_note(&db, "desktop-a", "vault-a", id, rel, "hostile");
        }
        let dirs = db.content_note_directories("desktop-a", "vault-a").unwrap()["directories"].as_array().unwrap().clone();
        assert!(dirs.is_empty(), "hostile paths must expose nothing, got {:?}", dirs);
        let page = db.content_notes("desktop-a", "vault-a", "", 1, "Users").unwrap();
        assert_eq!(page["items"].as_array().unwrap().len(), 0);
        let page = db.content_notes("desktop-a", "vault-a", "", 1, "secret").unwrap();
        assert_eq!(page["items"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn clean_relative_paths_still_project() {
        let db = fixture();
        upsert_note(&db, "desktop-a", "vault-a", "n1", "A/note.md", "one");
        upsert_note(&db, "desktop-a", "vault-a", "n2", "A/B/note.md", "two");
        let dirs = db.content_note_directories("desktop-a", "vault-a").unwrap()["directories"].as_array().unwrap().clone();
        assert_eq!(dirs.len(), 2);
    }

    // ------- R4 (B): the bounded LOCAL-ONLY bulk preview projection -------
    /// Raw insert with an EXACT body (the shared upsert_note wraps the title).
    fn seed_preview_note(db: &Db, instance: &str, vault: &str, id: &str, body: &str) {
        db.conn.execute(
            "INSERT INTO note_cache(desktop_instance_id,note_id,vault_id,title,relative_path,content,revision,deleted) VALUES(?1,?2,?3,?4,?5,?6,'r',0)",
            params![instance, id, vault, "t", "a.md", body],
        ).unwrap();
    }

    #[test]
    fn r4_note_previews_bulk_local_only_exact_scope() {
        let db = fixture();
        seed_preview_note(&db, "desktop-a", "vault-a", "n1", "cached body one");
        seed_preview_note(&db, "desktop-a", "vault-a", "n2", "cached body two");
        // The same noteId is unique per INSTANCE (the cache PK), so the
        // cross-scope proof uses the other rows that DO exist: a read for
        // (desktop-a, vault-a) must never see another instance's rows, and a
        // missing id is simply absent (never wrong-body).
        seed_preview_note(&db, "desktop-b", "vault-a", "other", "WRONG INSTANCE body");

        let out = db.content_note_previews("desktop-a", "vault-a", &["n1".into(), "n2".into(), "missing".into()]).unwrap();
        let items = out["items"].as_array().unwrap();
        assert_eq!(items.len(), 2, "absent ids are simply not present, no error");
        let by_id: std::collections::HashMap<&str, &serde_json::Value> = items
            .iter().map(|i| (i["noteId"].as_str().unwrap(), i)).collect();
        assert_eq!(by_id["n1"]["content"].as_str().unwrap(), "cached body one", "exact (instance, vault, note) keying");
        assert_eq!(by_id["n2"]["content"].as_str().unwrap(), "cached body two");
        assert!(!by_id.contains_key("other"), "another instance's row is invisible in this scope");
        // The projection carries the provenance flag without relabeling.
        assert_eq!(by_id["n1"]["bodyOutdated"].as_bool().unwrap(), false);

        // A DIFFERENT instance's read sees only its own rows.
        let other = db.content_note_previews("desktop-b", "vault-a", &["n1".into(), "other".into()]).unwrap();
        let other_items = other["items"].as_array().unwrap();
        assert_eq!(other_items.len(), 1);
        assert_eq!(other_items[0]["noteId"].as_str().unwrap(), "other");
        assert_eq!(other_items[0]["content"].as_str().unwrap(), "WRONG INSTANCE body");

        // Bounded: more than 100 ids clamps; nonexistent ids stay absent.
        let many: Vec<String> = (0..150).map(|i| format!("x{i}")).collect();
        let bounded = db.content_note_previews("desktop-a", "vault-a", &many).unwrap();
        assert_eq!(bounded["items"].as_array().unwrap().len(), 0, "clamped ids do not exist -> 0 rows, no error");
    }

    #[test]
    fn r4_note_previews_flags_body_outdated() {
        let db = fixture();
        seed_preview_note(&db, "i", "v", "n1", "stale cached body");
        // A newer SERVER revision than the cached row marks the body outdated
        // (the flag needs both a cached_document and a differing server one —
        // the same truthful provenance semantics as note_value).
        db.conn.execute(
            "UPDATE note_cache SET server_document='{\"revision\":\"r2\"}', cached_document='{\"revision\":\"r\"}' WHERE desktop_instance_id='i' AND note_id='n1'",
            [],
        ).unwrap();
        let out = db.content_note_previews("i", "v", &["n1".into()]).unwrap();
        let item = &out["items"].as_array().unwrap()[0];
        assert_eq!(item["content"].as_str().unwrap(), "stale cached body", "the body stays previewable");
        assert_eq!(item["bodyOutdated"].as_bool().unwrap(), true, "under the truthful provenance flag");
        assert_eq!(item["revision"].as_str().unwrap(), "r", "its revision is NOT relabeled");
    }

    #[test]
    fn directory_filter_is_literal_prefix_percent_underscore() {
        let db = fixture();
        upsert_note(&db, "desktop-a", "vault-a", "p1", "A_1%/real.md", "literal");
        upsert_note(&db, "desktop-a", "vault-a", "p2", "A_1%/inner/decoy.md", "decoy-under-literal");
        upsert_note(&db, "desktop-a", "vault-a", "p3", "AX1Y/other.md", "would-match-wildcard");
        upsert_note(&db, "desktop-a", "vault-a", "p4", "A_1/other.md", "underscore-wildcard-decoy");
        let page = db.content_notes("desktop-a", "vault-a", "", 1, "A_1%").unwrap();
        let items = page["items"].as_array().unwrap();
        assert_eq!(items.len(), 2, "only the literal A_1% subtree, got {:?}", items.iter().map(|i| i["relativePath"].as_str().unwrap()).collect::<Vec<_>>());
        let dirs = db.content_note_directories("desktop-a", "vault-a").unwrap()["directories"].as_array().unwrap().clone();
        assert!(dirs.iter().any(|d| d.as_str() == Some("A_1%")), "%/_ preserved verbatim");
        let sub = db.content_notes("desktop-a", "vault-a", "", 1, "A_1%/inner").unwrap();
        assert_eq!(sub["items"].as_array().unwrap().len(), 1);
    }

    // ------- A0 closure: directory projection + filtered listing -------
    fn upsert_note(db: &Db, instance: &str, vault: &str, id: &str, rel: &str, title: &str) {
        db.conn.execute(
            "INSERT INTO note_cache(desktop_instance_id,note_id,vault_id,title,relative_path,content,revision,deleted) VALUES(?1,?2,?3,?4,?5,?6,'r',0)",
            params![instance, id, vault, title, rel, format!("body of {title}")],
        )
        .unwrap();
    }

    #[test]
    fn directories_are_parent_paths_only_and_normalized() {
        let db = fixture();
        let inst = "desktop-a";
        let vault = "vault-a";
        upsert_note(&db, inst, vault, "n0", "note.md", "root note");
        upsert_note(&db, inst, vault, "n1", "A/note.md", "one");
        upsert_note(&db, inst, vault, "n2", "A/B/note.md", "two");
        upsert_note(&db, inst, vault, "n3", "A/B/C/note.md", "three");
        upsert_note(&db, inst, vault, "n4", "A\\B\\win.md", "windows separators");
        let got: Vec<String> = db.content_note_directories(inst, vault).unwrap()["directories"]
            .as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
        assert_eq!(got, vec!["A", "A/B", "A/B/C"]);
        for d in &got {
            assert!(!d.contains('\\'));
            assert!(!d.contains(':'));
            assert!(!d.starts_with('/'));
        }
    }

    #[test]
    fn directories_skip_deleted_and_pending_delete() {
        let db = fixture();
        upsert_note(&db, "desktop-a", "vault-a", "n1", "A/note.md", "one");
        db.conn.execute("UPDATE note_cache SET deleted=1 WHERE note_id='n1'", params![]).unwrap();
        assert_eq!(db.content_note_directories("desktop-a", "vault-a").unwrap()["directories"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn content_notes_directory_filter_composes_with_q() {
        let db = fixture();
        upsert_note(&db, "desktop-a", "vault-a", "n0", "note.md", "root");
        upsert_note(&db, "desktop-a", "vault-a", "n1", "A/note.md", "in A");
        upsert_note(&db, "desktop-a", "vault-a", "n2", "A/B/deep.md", "deep in A/B");
        let in_a = db.content_notes("desktop-a", "vault-a", "", 1, "A").unwrap();
        assert_eq!(in_a["items"].as_array().unwrap().len(), 2);
        assert!(in_a["items"].as_array().unwrap().iter().all(|i| i["relativePath"].as_str().unwrap().starts_with("A/")));
        let all = db.content_notes("desktop-a", "vault-a", "", 1, "").unwrap();
        assert_eq!(all["items"].as_array().unwrap().len(), 3);
        let both = db.content_notes("desktop-a", "vault-a", "deep", 1, "A").unwrap();
        assert_eq!(both["items"].as_array().unwrap().len(), 1);
    }
    fn document(rev: &str, content: &str) -> Value {
        json!({"noteId":"kn-a","vaultId":"vault-a","title":"原笔记","relativePath":"目录/原笔记.md","revision":rev,"content":content})
    }

    #[test]
    fn live_ack_before_next_renderer_read_keeps_continuous_input_sendable() {
        let mut db = fixture();
        db.content_apply_batch("desktop-a", "vault-a", &[document("r1", "中文\nS1OFFLINE_BODY")], 1, None).unwrap();
        let opened = db.content_begin_edit("desktop-a", "vault-a", "kn-a").unwrap();
        let epoch = opened["editorEpoch"].as_i64().unwrap();
        let displayed = opened["revision"].as_str().unwrap();
        let mut canonical = document("r1", "中文\nS1OFFLINE_BODY");
        let mut body = "中文\nS1OFFLINE_BODY\n".to_string();
        // The renderer is still focused and has not consumed the ACK reread.
        // Every edit therefore carries the original displayed revision. The
        // real DB owns saves, immutable preparation, ACKs and own change echo.
        for (index, ch) in "S1LIVE_PHONE_20261002_A1".chars().enumerate() {
            body.push(ch);
            let saved = db.content_edit_observed("desktop-a", "vault-a", "kn-a", "原笔记", &body, epoch, index as i64 + 1, Some(displayed)).unwrap();
            assert!(saved["conflictDocument"].is_null(), "own ACK must not create two versions at input {}: {}", index + 1, saved);
            if (index + 1) % 3 == 0 || index + 1 == "S1LIVE_PHONE_20261002_A1".len() {
                let ops = db.content_prepare_operations("desktop-a", "vault-a").unwrap();
                assert_eq!(ops.len(), 1, "continuous durable input remains publishable");
                let op = &ops[0];
                assert_eq!(op["expectedRevision"], canonical["revision"]);
                assert_eq!(op["content"], body);
                assert_eq!(db.content_prepare_operations("desktop-a", "vault-a").unwrap()[0], *op, "retry must preserve the captured operation");
                canonical = document(&format!("own-r{}", index + 1), &body);
                db.content_ack("desktop-a", "vault-a", "kn-a", op["opId"].as_str().unwrap(), &canonical).unwrap();
                db.content_apply_batch("desktop-a", "vault-a", &[canonical.clone()], index as i64 + 2, None).unwrap();
            }
        }
        let final_note = db.content_note("desktop-a", "vault-a", "kn-a").unwrap();
        assert_eq!(final_note["dirty"], false);
        assert!(final_note["conflictDocument"].is_null());
        assert_eq!(final_note["content"], body);
        assert_eq!(canonical["content"], body);
        assert!(body.ends_with("S1LIVE_PHONE_20261002_A1"));
    }

    #[test]
    fn live_ack_after_newer_save_keeps_draft_and_exact_operations() {
        let mut db = fixture();
        db.content_apply_batch("desktop-a", "vault-a", &[document("r1", "old")], 1, None).unwrap();
        let epoch = db.content_begin_edit("desktop-a", "vault-a", "kn-a").unwrap()["editorEpoch"].as_i64().unwrap();
        db.content_edit_observed("desktop-a", "vault-a", "kn-a", "原笔记", "partial", epoch, 1, Some("r1")).unwrap();
        let first = db.content_prepare_operations("desktop-a", "vault-a").unwrap().remove(0);
        db.content_edit_observed("desktop-a", "vault-a", "kn-a", "原笔记", "complete newer draft", epoch, 2, Some("r1")).unwrap();
        assert_eq!(db.content_prepare_operations("desktop-a", "vault-a").unwrap()[0], first);
        db.content_ack("desktop-a", "vault-a", "kn-a", first["opId"].as_str().unwrap(), &document("r2", "partial")).unwrap();
        db.content_apply_batch("desktop-a", "vault-a", &[document("r2", "partial")], 2, None).unwrap();
        let newer = db.content_note("desktop-a", "vault-a", "kn-a").unwrap();
        assert_eq!(newer["content"], "complete newer draft");
        assert_eq!(newer["dirty"], true);
        assert!(newer["conflictDocument"].is_null());
        let second = db.content_prepare_operations("desktop-a", "vault-a").unwrap().remove(0);
        assert_eq!(second["expectedRevision"], "r2");
        assert_eq!(second["content"], "complete newer draft");
        assert_ne!(second["opId"], first["opId"]);
        assert_eq!(db.content_ack("desktop-a", "vault-a", "kn-a", first["opId"].as_str().unwrap(), &document("stale", "wrong old body")).unwrap_err(), "CONTENT_ACK_STALE");
        assert_eq!(db.content_note("desktop-a", "vault-a", "kn-a").unwrap(), newer, "late ACK cannot change even revision/conflict truth");
        assert_eq!(db.content_prepare_operations("desktop-a", "vault-a").unwrap()[0], second);
        db.content_ack("desktop-a", "vault-a", "kn-a", second["opId"].as_str().unwrap(), &document("r3", "complete newer draft")).unwrap();
        let continued = db.content_edit_observed("desktop-a", "vault-a", "kn-a", "原笔记", "complete newer draft + next input", epoch, 3, Some("r1")).unwrap();
        assert!(continued["conflictDocument"].is_null());
        assert_eq!(db.content_prepare_operations("desktop-a", "vault-a").unwrap()[0]["expectedRevision"], "r3");
    }

    #[test]
    fn live_ack_proof_never_rebases_foreign_body_revision_or_tombstone() {
        for foreign in [
            document("foreign-r3", "真正电脑正文"),
            document("foreign-r3", "partial"),
            json!({"noteId":"kn-a", "vaultId":"vault-a", "revision":"deleted-r3", "deleted":true}),
        ] {
            let mut db = fixture();
            db.content_apply_batch("desktop-a", "vault-a", &[document("r1", "old")], 1, None).unwrap();
            let epoch = db.content_begin_edit("desktop-a", "vault-a", "kn-a").unwrap()["editorEpoch"].as_i64().unwrap();
            db.content_edit_observed("desktop-a", "vault-a", "kn-a", "原笔记", "partial", epoch, 1, Some("r1")).unwrap();
            let op = db.content_prepare_operations("desktop-a", "vault-a").unwrap().remove(0);
            db.content_ack("desktop-a", "vault-a", "kn-a", op["opId"].as_str().unwrap(), &document("r2", "partial")).unwrap();
            db.content_apply_batch("desktop-a", "vault-a", &[foreign.clone()], 3, None).unwrap();
            let saved = db.content_edit_observed("desktop-a", "vault-a", "kn-a", "原笔记", "完整手机草稿", epoch, 2, Some("r1")).unwrap();
            assert_eq!(saved["content"], "完整手机草稿");
            assert_eq!(saved["conflictDocument"], foreign, "same bytes alone cannot prove our own ACK");
            assert!(db.content_prepare_operations("desktop-a", "vault-a").unwrap().is_empty());
        }
    }

    #[test]
    fn live_ack_proof_is_scoped_to_the_open_editor_epoch() {
        let mut db = fixture();
        db.content_apply_batch("desktop-a", "vault-a", &[document("r1", "old")], 1, None).unwrap();
        let first_epoch = db.content_begin_edit("desktop-a", "vault-a", "kn-a").unwrap()["editorEpoch"].as_i64().unwrap();
        db.content_edit_observed("desktop-a", "vault-a", "kn-a", "原笔记", "partial", first_epoch, 1, Some("r1")).unwrap();
        let op = db.content_prepare_operations("desktop-a", "vault-a").unwrap().remove(0);
        db.content_ack("desktop-a", "vault-a", "kn-a", op["opId"].as_str().unwrap(), &document("r2", "partial")).unwrap();
        let next_epoch = db.content_begin_edit("desktop-a", "vault-a", "kn-a").unwrap()["editorEpoch"].as_i64().unwrap();
        let before = db.content_note("desktop-a", "vault-a", "kn-a").unwrap();
        assert_eq!(db.content_edit_observed("desktop-a", "vault-a", "kn-a", "原笔记", "retired input", first_epoch, 2, Some("r1")).unwrap_err(), "CONTENT_EDITOR_CHANGED");
        assert_eq!(db.content_note("desktop-a", "vault-a", "kn-a").unwrap(), before);
        let saved = db.content_edit_observed("desktop-a", "vault-a", "kn-a", "原笔记", "different editor's stale body", next_epoch, 1, Some("r1")).unwrap();
        assert_eq!(saved["conflictDocument"]["revision"], "r2");
        assert!(db.content_prepare_operations("desktop-a", "vault-a").unwrap().is_empty());
    }

    #[test]
    fn live_ack_with_a_different_body_is_not_proof_of_the_displayed_draft() {
        let mut db = fixture();
        db.content_apply_batch("desktop-a", "vault-a", &[document("r1", "old")], 1, None).unwrap();
        let epoch = db.content_begin_edit("desktop-a", "vault-a", "kn-a").unwrap()["editorEpoch"].as_i64().unwrap();
        db.content_edit_observed("desktop-a", "vault-a", "kn-a", "原笔记", "partial", epoch, 1, Some("r1")).unwrap();
        let op = db.content_prepare_operations("desktop-a", "vault-a").unwrap().remove(0);
        let different = document("r2", "不同的完整桌面正文");
        db.content_ack("desktop-a", "vault-a", "kn-a", op["opId"].as_str().unwrap(), &different).unwrap();
        let saved = db.content_edit_observed("desktop-a", "vault-a", "kn-a", "原笔记", "完整手机草稿", epoch, 2, Some("r1")).unwrap();
        assert_eq!(saved["content"], "完整手机草稿");
        assert_eq!(saved["conflictDocument"], different);
        assert!(db.content_prepare_operations("desktop-a", "vault-a").unwrap().is_empty());
    }

    #[test]
    fn live_ack_during_reopen_certifies_only_the_identical_opened_draft() {
        let mut db = fixture();
        db.content_apply_batch("desktop-a", "vault-a", &[document("r1", "old")], 1, None).unwrap();
        let prior_epoch = db.content_begin_edit("desktop-a", "vault-a", "kn-a").unwrap()["editorEpoch"].as_i64().unwrap();
        db.content_edit_observed("desktop-a", "vault-a", "kn-a", "原笔记", "partial", prior_epoch, 1, Some("r1")).unwrap();
        let op = db.content_prepare_operations("desktop-a", "vault-a").unwrap().remove(0);
        let reopened = db.content_begin_edit("desktop-a", "vault-a", "kn-a").unwrap();
        assert_eq!(reopened["content"], "partial");
        let epoch = reopened["editorEpoch"].as_i64().unwrap();
        db.content_ack("desktop-a", "vault-a", "kn-a", op["opId"].as_str().unwrap(), &document("r2", "partial")).unwrap();
        let saved = db.content_edit_observed("desktop-a", "vault-a", "kn-a", "原笔记", "partial + continued", epoch, 1, Some("r1")).unwrap();
        assert!(saved["conflictDocument"].is_null());
        assert_eq!(db.content_prepare_operations("desktop-a", "vault-a").unwrap()[0]["expectedRevision"], "r2");
    }

    #[test]
    fn live_ack_then_foreign_summary_keeps_real_cas_and_both_409_bodies() {
        let mut db = fixture();
        db.content_apply_batch("desktop-a", "vault-a", &[document("r1", "old")], 1, None).unwrap();
        let epoch = db.content_begin_edit("desktop-a", "vault-a", "kn-a").unwrap()["editorEpoch"].as_i64().unwrap();
        db.content_edit_observed("desktop-a", "vault-a", "kn-a", "原笔记", "partial", epoch, 1, Some("r1")).unwrap();
        let op = db.content_prepare_operations("desktop-a", "vault-a").unwrap().remove(0);
        db.content_ack("desktop-a", "vault-a", "kn-a", op["opId"].as_str().unwrap(), &document("own-r2", "partial")).unwrap();
        db.content_apply_batch("desktop-a", "vault-a", &[summary("foreign-r3")], 3, None).unwrap();
        let saved = db.content_edit_observed("desktop-a", "vault-a", "kn-a", "原笔记", "完整手机草稿", epoch, 2, Some("r1")).unwrap();
        assert!(saved["conflictDocument"].is_null(), "body-less metadata is not a comparable opposing version");
        let next = db.content_prepare_operations("desktop-a", "vault-a").unwrap().remove(0);
        assert_eq!(next["expectedRevision"], "own-r2", "never forge the unseen foreign revision");
        let foreign = document("foreign-r3", "真正电脑正文");
        db.content_conflict("desktop-a", "vault-a", "kn-a", &foreign).unwrap();
        let conflicted = db.content_note("desktop-a", "vault-a", "kn-a").unwrap();
        assert_eq!(conflicted["content"], "完整手机草稿");
        assert_eq!(conflicted["conflictDocument"], foreign);
        assert!(db.content_prepare_operations("desktop-a", "vault-a").unwrap().is_empty());
    }

    #[test]
    fn title_recovery_invalid_intermediate_draft_is_durable_without_a_fresh_intent() {
        let mut db = fixture();
        db.content_apply_batch("desktop-a", "vault-a", &[document("r1", "body")], 0, None).unwrap();
        let epoch = db.content_begin_edit("desktop-a", "vault-a", "kn-a").unwrap()["editorEpoch"].as_i64().unwrap();
        for (generation, title) in ["", " \t\u{3000}", ".", "..", "a/b", "a\\b", "a:b", "a\0b", ".LuCkYrAy", "~outside"].iter().enumerate() {
            let saved = db.content_edit("desktop-a", "vault-a", "kn-a", title, "body", epoch, generation as i64 + 1).unwrap();
            assert_eq!(saved["title"], *title);
            assert_eq!(saved["content"], "body");
            assert_eq!(saved["dirty"], true);
            assert_eq!(saved["titleNeedsCorrection"], true);
            assert!(db.content_prepare_operations("desktop-a", "vault-a").unwrap().is_empty());
        }
        db.content_edit("desktop-a", "vault-a", "kn-a", "合法标题.MD", "body", epoch, 11).unwrap();
        let ready = db.content_prepare_operations("desktop-a", "vault-a").unwrap();
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0]["kind"], "rename");
        assert_eq!(ready[0]["title"], "合法标题.MD");
    }

    #[test]
    fn title_recovery_confirmed_pause_preserves_old_bytes_and_later_draft_without_starvation() {
        let mut db = fixture();
        db.content_apply_batch("desktop-a", "vault-a", &[document("r1", "body")], 0, None).unwrap();
        let epoch = db.content_begin_edit("desktop-a", "vault-a", "kn-a").unwrap()["editorEpoch"].as_i64().unwrap();
        db.content_edit("desktop-a", "vault-a", "kn-a", "later title", "later body", epoch, 1).unwrap();
        // Persisted predecessor input at the database boundary, not a new-op
        // preparation path that this fix deliberately prohibits.
        let old = json!({"opId":"old-op","noteId":"kn-a","vaultId":"vault-a","kind":"rename","expectedRevision":"r1","title":" \t","content":"body","parentRelativePath":null});
        let bytes = old.to_string();
        db.conn.execute("INSERT INTO content_note_operation(desktop_instance_id,vault_id,note_id,op_id,payload,draft_generation,route) VALUES('desktop-a','vault-a','kn-a','old-op',?1,0,'content')", params![bytes]).unwrap();
        let prepared = PreparedNoteOperation { payload: old.clone(), route: NoteOperationRoute::Content };
        assert!(!db.content_pause_blank_rename("desktop-a", "vault-a", &prepared, 503, &json!({"code":"NOTE_INPUT_INVALID"})).unwrap());
        assert!(!db.content_pause_blank_rename("desktop-a", "vault-a", &prepared, 400, &json!({"code":"other"})).unwrap());
        assert!(db.content_pause_blank_rename("desktop-a", "vault-a", &prepared, 400, &json!({"code":"NOTE_INPUT_INVALID"})).unwrap());
        let saved = db.content_note("desktop-a", "vault-a", "kn-a").unwrap();
        assert_eq!(saved["content"], "later body");
        assert_eq!(saved["title"], "later title");
        assert_eq!(saved["operationPaused"], true);
        assert!(db.content_prepare_operations("desktop-a", "vault-a").unwrap().is_empty());
        assert!(db.content_sync_attention("desktop-a", "vault-a").unwrap());
        let other = json!({"noteId":"kn-b","vaultId":"vault-a","title":"Other","revision":"b1","relativePath":"Other.md","content":"other"});
        db.content_apply_batch("desktop-a", "vault-a", &[other], 0, None).unwrap();
        let b = db.content_begin_edit("desktop-a", "vault-a", "kn-b").unwrap()["editorEpoch"].as_i64().unwrap();
        db.content_edit("desktop-a", "vault-a", "kn-b", "Other", "changed", b, 1).unwrap();
        let ready = db.content_prepare_operations("desktop-a", "vault-a").unwrap();
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0]["noteId"], "kn-b");
        assert!(db.content_ack("desktop-a", "vault-a", "kn-a", "old-op", &document("r2", "wrong")).is_err());
        let audited: (String, String, i64) = db.conn.query_row("SELECT payload,route,draft_generation FROM content_note_operation_pause WHERE op_id='old-op'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        assert_eq!(audited, (bytes, "content".into(), 0));
    }

    #[test]
    fn title_recovery_explicit_new_id_keeps_original_baseline_and_rejects_old_ack() {
        let mut db = fixture();
        db.content_apply_batch("desktop-a", "vault-a", &[document("r1", "body")], 0, None).unwrap();
        let epoch = db.content_begin_edit("desktop-a", "vault-a", "kn-a").unwrap()["editorEpoch"].as_i64().unwrap();
        db.content_edit("desktop-a", "vault-a", "kn-a", "valid", "later body", epoch, 1).unwrap();
        let old = json!({"opId":"old-op","noteId":"kn-a","vaultId":"vault-a","kind":"rename","expectedRevision":"r1","title":"","content":"body","parentRelativePath":null});
        let bytes = old.to_string();
        db.conn.execute("INSERT INTO content_note_operation(desktop_instance_id,vault_id,note_id,op_id,payload,draft_generation,route) VALUES('desktop-a','vault-a','kn-a','old-op',?1,0,'content')", params![bytes]).unwrap();
        db.content_pause_blank_rename("desktop-a", "vault-a", &PreparedNoteOperation {payload:old,route:NoteOperationRoute::Content},400,&json!({"code":"NOTE_INPUT_INVALID"})).unwrap();
        assert!(db.content_resume_paused("desktop-a","wrong-vault","kn-a","old-op",epoch,1).is_err());
        assert!(db.content_resume_paused("desktop-a","vault-a","kn-a","wrong-op",epoch,1).is_err());
        assert!(db.content_resume_paused("desktop-a","vault-a","kn-a","old-op",epoch+1,1).is_err());
        assert!(db.content_resume_paused("desktop-a","vault-a","kn-a","old-op",epoch,0).is_err());
        // A newer remote observation cannot silently advance the saved base.
        db.content_apply_batch("desktop-a", "vault-a", &[document("r2", "desktop later")], 1, None).unwrap();
        let resumed = db.content_resume_paused("desktop-a","vault-a","kn-a","old-op",epoch,1).unwrap();
        assert_eq!(resumed["operationPaused"], false);
        assert_eq!(resumed["dirty"], true);
        let ready = db.content_prepare_operations("desktop-a","vault-a").unwrap();
        assert_eq!(ready.len(),1);
        assert_ne!(ready[0]["opId"], "old-op");
        assert_eq!(ready[0]["expectedRevision"], "r1");
        assert_eq!(ready[0]["content"], "later body");
        assert!(db.content_ack("desktop-a","vault-a","kn-a","old-op",&document("r3","wrong")).is_err());
        assert_eq!(db.content_note("desktop-a","vault-a","kn-a").unwrap()["content"],"later body");
        assert!(db.content_resume_paused("desktop-a","vault-a","kn-a","old-op",epoch,1).is_err());
        let new_op = ready[0]["opId"].as_str().unwrap();
        db.content_edit("desktop-a","vault-a","kn-a","third title","third body",epoch,2).unwrap();
        db.content_ack("desktop-a","vault-a","kn-a",new_op,&document("r3","later body")).unwrap();
        let after = db.content_note("desktop-a","vault-a","kn-a").unwrap();
        assert_eq!(after["content"],"third body");
        assert_eq!(after["title"],"third title");
        assert_eq!(after["dirty"],true);
        let audit: String = db.conn.query_row("SELECT payload FROM content_note_operation_pause WHERE op_id='old-op'",[],|r|r.get(0)).unwrap();
        assert_eq!(audit,bytes);
    }

    #[test]
    fn title_recovery_filters_before_batch_bound_and_preserves_pending_attachments() {
        let mut db = fixture();
        for n in 0..55 {
            let id = format!("kn-a-{n:02}");
            db.content_create("desktop-a","vault-a",&id,"\u{3000}","body").unwrap();
        }
        db.content_create("desktop-a","vault-a","kn-z","valid","body").unwrap();
        let ready = db.content_prepare_operations("desktop-a","vault-a").unwrap();
        assert_eq!(ready.len(),1);
        assert_eq!(ready[0]["noteId"],"kn-z");

        db.content_apply_batch("desktop-a","vault-a",&[document("r1","body")],0,None).unwrap();
        let epoch = db.content_begin_edit("desktop-a","vault-a","kn-a").unwrap()["editorEpoch"].as_i64().unwrap();
        db.content_edit("desktop-a","vault-a","kn-a","valid","![attachment](luckyray-attachment:att)",epoch,1).unwrap();
        db.conn.execute("INSERT INTO content_note_attachment VALUES('desktop-a','vault-a','kn-a','att','a.png','image/png','private-stage',123,'digest',5,NULL,'manifest')",[]).unwrap();
        let old = json!({"opId":"old","noteId":"kn-a","vaultId":"vault-a","kind":"rename","expectedRevision":"r1","title":"","content":"body","parentRelativePath":null});
        db.conn.execute("INSERT INTO content_note_operation VALUES('desktop-a','vault-a','kn-a','old',?1,0,'content')",params![old.to_string()]).unwrap();
        db.content_pause_blank_rename("desktop-a","vault-a",&PreparedNoteOperation{payload:old,route:NoteOperationRoute::Content},400,&json!({"code":"NOTE_INPUT_INVALID"})).unwrap();
        assert_eq!(db.content_resume_paused("desktop-a","vault-a","kn-a","old",epoch,1).unwrap_err(),"CONTENT_ATTACHMENTS_PENDING");
        let receipt: Option<String> = db.conn.query_row("SELECT receipt FROM content_note_attachment WHERE op_id='att'",[],|r|r.get(0)).unwrap();
        assert_eq!(receipt,None);
        assert_eq!(db.content_note("desktop-a","vault-a","kn-a").unwrap()["operationPaused"],true);
        assert!(db.conn.execute("UPDATE content_note_operation_pause SET payload='{}'",[]).is_err());
        assert!(db.conn.execute("DELETE FROM content_note_operation_pause",[]).is_err());
    }

    fn paused_rename_fixture(new_body: &str) -> (Db, i64) {
        let mut db = fixture();
        db.content_apply_batch("desktop-a","vault-a",&[document("r1","original body")],0,None).unwrap();
        let epoch = db.content_begin_edit("desktop-a","vault-a","kn-a").unwrap()["editorEpoch"].as_i64().unwrap();
        db.content_edit("desktop-a","vault-a","kn-a","用户的新标题",new_body,epoch,1).unwrap();
        let old = json!({"opId":"old-blank","noteId":"kn-a","vaultId":"vault-a","kind":"rename","expectedRevision":"r1","title":"","content":"original body","parentRelativePath":null});
        db.conn.execute("INSERT INTO content_note_operation VALUES('desktop-a','vault-a','kn-a','old-blank',?1,0,'content')",params![old.to_string()]).unwrap();
        db.content_pause_blank_rename("desktop-a","vault-a",&PreparedNoteOperation{payload:old,route:NoteOperationRoute::Content},400,&json!({"code":"NOTE_INPUT_INVALID"})).unwrap();
        db.content_resume_paused("desktop-a","vault-a","kn-a","old-blank",epoch,1).unwrap();
        (db,epoch)
    }

    #[test]
    fn title_recovery_update_ack_keeps_new_title_until_separate_rename_ack() {
        let (mut db,_) = paused_rename_fixture("new body");
        let update = db.content_prepare_operations("desktop-a","vault-a").unwrap().remove(0);
        assert_eq!(update["kind"],"update");
        assert_eq!(update["expectedRevision"],"r1");
        assert_ne!(update["opId"],"old-blank");
        // The REAL update receipt keeps the Desktop's old filename/title:
        // update does not rename. A one-receipt synthetic compound ACK would
        // hide the bug this regression is meant to pin.
        db.content_ack("desktop-a","vault-a","kn-a",update["opId"].as_str().unwrap(),&document("r2","new body")).unwrap();
        let after_update = db.content_note("desktop-a","vault-a","kn-a").unwrap();
        assert_eq!(after_update["title"],"用户的新标题");
        assert_eq!(after_update["content"],"new body");
        assert_eq!(after_update["dirty"],true);
        assert!(db.content_ack("desktop-a","vault-a","kn-a","old-blank",&document("r9","wrong")).is_err());
        let rename = db.content_prepare_operations("desktop-a","vault-a").unwrap().remove(0);
        assert_eq!(rename["kind"],"rename");
        assert_eq!(rename["title"],"用户的新标题");
        assert_eq!(rename["expectedRevision"],"r2");
        assert_ne!(rename["opId"],update["opId"]);
        let mut receipt = document("r3","new body");
        receipt["title"] = json!("用户的新标题");
        db.content_ack("desktop-a","vault-a","kn-a",rename["opId"].as_str().unwrap(),&receipt).unwrap();
        let complete = db.content_note("desktop-a","vault-a","kn-a").unwrap();
        assert_eq!(complete["dirty"],false);
        assert_eq!(complete["title"],"用户的新标题");
        assert_eq!(complete["content"],"new body");
        assert!(db.content_prepare_operations("desktop-a","vault-a").unwrap().is_empty());
    }

    #[test]
    fn title_recovery_rename_ack_keeps_later_body_until_separate_update_ack() {
        let (mut db,epoch) = paused_rename_fixture("original body");
        let rename = db.content_prepare_operations("desktop-a","vault-a").unwrap().remove(0);
        assert_eq!(rename["kind"],"rename");
        db.content_edit("desktop-a","vault-a","kn-a","用户的新标题","later body",epoch,2).unwrap();
        let mut rename_receipt = document("r2","original body");
        rename_receipt["title"] = json!("用户的新标题");
        db.content_ack("desktop-a","vault-a","kn-a",rename["opId"].as_str().unwrap(),&rename_receipt).unwrap();
        let after_rename = db.content_note("desktop-a","vault-a","kn-a").unwrap();
        assert_eq!(after_rename["title"],"用户的新标题");
        assert_eq!(after_rename["content"],"later body");
        assert_eq!(after_rename["dirty"],true);
        assert!(db.content_ack("desktop-a","vault-a","kn-a","old-blank",&document("r9","wrong")).is_err());
        let update = db.content_prepare_operations("desktop-a","vault-a").unwrap().remove(0);
        assert_eq!(update["kind"],"update");
        assert_eq!(update["expectedRevision"],"r2");
        assert_eq!(update["content"],"later body");
        assert_ne!(update["opId"],rename["opId"]);
        let mut update_receipt = document("r3","later body");
        update_receipt["title"] = json!("用户的新标题");
        db.content_ack("desktop-a","vault-a","kn-a",update["opId"].as_str().unwrap(),&update_receipt).unwrap();
        let complete = db.content_note("desktop-a","vault-a","kn-a").unwrap();
        assert_eq!(complete["dirty"],false);
        assert_eq!(complete["title"],"用户的新标题");
        assert_eq!(complete["content"],"later body");
    }

    #[test]
    fn title_recovery_delete_gate_preserves_pre_and_post_pause_fields_but_allows_historical_audit() {
        let mut db = fixture();
        db.content_apply_batch("desktop-a","vault-a",&[document("r1","original body")],0,None).unwrap();
        let epoch = db.content_begin_edit("desktop-a","vault-a","kn-a").unwrap()["editorEpoch"].as_i64().unwrap();
        db.content_edit("desktop-a","vault-a","kn-a","valid title","new body",epoch,1).unwrap();
        db.conn.execute("INSERT INTO content_note_attachment VALUES('desktop-a','vault-a','kn-a','att','a.png','image/png','private-stage',123,'digest',5,'receipt','manifest')",[]).unwrap();
        let old = json!({"opId":"old-blank","noteId":"kn-a","vaultId":"vault-a","kind":"rename","expectedRevision":"r1","title":"","content":"original body","parentRelativePath":null});
        db.conn.execute("INSERT INTO content_note_operation VALUES('desktop-a','vault-a','kn-a','old-blank',?1,0,'content')",params![old.to_string()]).unwrap();
        // Compare EVERY durable column, not only a display flag. Test DB
        // fixture boundary reads never inspect a real profile/private store.
        let snapshot = |db: &Db| {
            ["note_cache","content_note_operation","content_note_operation_pause","content_note_operation_recovery","content_note_attachment"].iter().map(|table| {
                let mut query = db.conn.prepare(&format!("SELECT * FROM {table}")).unwrap();
                let columns = query.column_count();
                let rows = query.query_map([],|row| Ok((0..columns).map(|i|format!("{:?}",row.get_ref(i).unwrap())).collect::<Vec<_>>())).unwrap();
                format!("{:?}",rows.collect::<Result<Vec<_>,_>>().unwrap())
            }).collect::<Vec<_>>()
        };
        // Even before any 400/pause is recorded, a delete must not alter the
        // row which a still-inflight blank rename may subsequently pause.
        let before_refusal = snapshot(&db);
        assert_eq!(db.content_delete("desktop-a","vault-a","kn-a").unwrap_err(),"CONTENT_OPERATION_PENDING");
        assert_eq!(snapshot(&db),before_refusal);
        assert_eq!(db.content_note("desktop-a","vault-a","kn-a").unwrap()["operationPaused"],false);
        assert!(db.content_pause_blank_rename("desktop-a","vault-a",&PreparedNoteOperation{payload:old,route:NoteOperationRoute::Content},400,&json!({"code":"NOTE_INPUT_INVALID"})).unwrap());
        let before = snapshot(&db);
        assert_eq!(db.content_delete("desktop-a","vault-a","kn-a").unwrap_err(),"CONTENT_OPERATION_PAUSED");
        assert_eq!(snapshot(&db),before);
        assert_eq!(db.content_note("desktop-a","vault-a","kn-a").unwrap()["pendingKind"],"update");
        db.content_resume_paused("desktop-a","vault-a","kn-a","old-blank",epoch,1).unwrap();
        let history: String = db.conn.query_row("SELECT payload FROM content_note_operation_pause",[],|r|r.get(0)).unwrap();
        db.content_delete("desktop-a","vault-a","kn-a").unwrap();
        assert_eq!(db.content_note("desktop-a","vault-a","kn-a").unwrap()["pendingKind"],"delete");
        assert_eq!(db.conn.query_row("SELECT payload FROM content_note_operation_pause",[],|r|r.get::<_,String>(0)).unwrap(),history);
    }

    #[test]
    fn cold_cache_probe_classifies_missing_but_preserves_real_sqlite_errors() {
        let db = fixture();
        assert!(db.content_note_cached("desktop-a", "vault-a", "absent").unwrap().is_none());
        assert_eq!(db.content_begin_edit("desktop-a", "vault-a", "absent").unwrap_err(), "CONTENT_NOTE_NOT_CACHED");
        // This is a throwaway memory DB, never a device/profile database.
        db.conn.execute_batch("DROP TABLE note_cache").unwrap();
        let error = db.content_note_cached("desktop-a", "vault-a", "absent").unwrap_err();
        assert!(error.starts_with("CONTENT_DATABASE:"));
        assert!(error.contains("no such table"));
        assert!(db.content_begin_edit("desktop-a", "vault-a", "absent").unwrap_err().starts_with("CONTENT_DATABASE:"));
    }

    #[test]
    fn readonly_bootstrap_does_not_reset_live_editor_generation() {
        let mut db = fixture();
        db.content_create("desktop-a", "vault-a", "kn-a", "Phone", "draft A").unwrap();
        let epoch = db.content_begin_edit("desktop-a", "vault-a", "kn-a").unwrap()["editorEpoch"].as_i64().unwrap();
        db.content_edit("desktop-a", "vault-a", "kn-a", "Phone", "draft B", epoch, 9).unwrap();
        let generation = || db.conn.query_row(
            "SELECT editor_generation FROM note_cache WHERE desktop_instance_id='desktop-a' AND note_id='kn-a'",
            [], |row| row.get::<_, i64>(0),
        ).unwrap();
        assert_eq!(generation(), 9);
        let mut incoming = document("r1", "old Desktop body");
        incoming["resources"] = json!([]);
        incoming["updatedAt"] = json!("2026-09-30T16:00:00Z");
        let before = db.content_note("desktop-a", "vault-a", "kn-a").unwrap();
        db.content_cache_bootstrap("desktop-a", "vault-a", "kn-a", &incoming).unwrap();
        assert_eq!(db.content_note("desktop-a", "vault-a", "kn-a").unwrap(), before);
        let generation: i64 = db.conn.query_row(
            "SELECT editor_generation FROM note_cache WHERE desktop_instance_id='desktop-a' AND note_id='kn-a'",
            [], |row| row.get(0),
        ).unwrap();
        assert_eq!(generation, 9);
        db.content_edit("desktop-a", "vault-a", "kn-a", "Phone", "draft C", epoch, 10).unwrap();
        assert_eq!(db.content_note("desktop-a", "vault-a", "kn-a").unwrap()["content"], "draft C");
    }
    /// A metadata-only summary: NO `content` key at all, as the Desktop sends
    /// for a list/change page.
    fn summary(rev: &str) -> Value {
        json!({"noteId":"kn-a","vaultId":"vault-a","title":"原笔记","relativePath":"目录/原笔记.md","revision":rev})
    }

    // -----------------------------------------------------------------------
    // KNOWLEDGE-ORGANIZATION-R1 REPAIR-R1.1 — direct behavior coverage for
    // the committed-move receipt (the review required real DB drives, not
    // source-string assertions).
    // -----------------------------------------------------------------------

    #[test]
    fn move_receipt_moves_path_keeps_basename_content_and_body_revision() {
        let mut db = fixture();
        db.content_apply_batch("desktop-a", "vault-a", &[document("r1", "旧正文")], 1, None)
            .unwrap();
        content_note_move_receipt(&db, "desktop-a", "vault-a", "kn-a", "r9", "Work").unwrap();
        let note = db.content_note("desktop-a", "vault-a", "kn-a").unwrap();
        // Path moved; the file BASENAME is preserved (move never renames).
        assert_eq!(note["relativePath"].as_str().unwrap(), "Work/原笔记.md");
        // Body bytes and the BODY revision are untouched — the receipt is
        // metadata-only and never re-labels the cached body.
        assert_eq!(note["content"], "旧正文");
        assert_eq!(note["revision"], "r1", "移动收据绝不能推进正文基线 revision");
        // The serverDocument records the move as the latest remote
        // observation (new revision + new path).
        assert_eq!(note["serverDocument"]["revision"].as_str().unwrap(), "r9");
        assert_eq!(note["serverDocument"]["relativePath"].as_str().unwrap(), "Work/原笔记.md");
        // The directory projection follows the moved path.
        let dirs = db.content_note_directories("desktop-a", "vault-a").unwrap()["directories"].as_array().unwrap().clone();
        assert!(dirs.iter().any(|d| d.as_str() == Some("Work")), "目录投影已跟随移动");
        assert!(!dirs.iter().any(|d| d.as_str() == Some("目录")), "旧目录不再包含该笔记");
    }

    #[test]
    fn move_receipt_after_metadata_summary_uses_remote_revision_not_body() {
        let mut db = fixture();
        // body r1 → summary r2 (metadata-only): the body baseline stays r1.
        db.content_apply_batch("desktop-a", "vault-a", &[document("r1", "旧正文")], 1, None)
            .unwrap();
        db.content_apply_batch("desktop-a", "vault-a", &[summary("r2")], 2, None)
            .unwrap();
        // The committed move carries the Desktop's OWN receipt revision r3.
        content_note_move_receipt(&db, "desktop-a", "vault-a", "kn-a", "r3", "Docs").unwrap();
        let note = db.content_note("desktop-a", "vault-a", "kn-a").unwrap();
        assert_eq!(note["revision"], "r1", "正文基线仍是 r1");
        assert_eq!(note["serverDocument"]["revision"].as_str().unwrap(), "r3", "远端观察推进到 r3");
        assert_eq!(note["content"], "旧正文");
        assert_eq!(note["relativePath"].as_str().unwrap(), "Docs/原笔记.md");
    }

    #[test]
    fn move_receipt_to_root_and_backslash_parent() {
        let mut db = fixture();
        db.content_apply_batch("desktop-a", "vault-a", &[document("r1", "x")], 1, None)
            .unwrap();
        // A Windows-style mirror separator is normalized to the vault path.
        content_note_move_receipt(&db, "desktop-a", "vault-a", "kn-a", "r2", "A\\B").unwrap();
        assert_eq!(db.content_note("desktop-a", "vault-a", "kn-a").unwrap()["relativePath"].as_str().unwrap(), "A/B/原笔记.md");
        // ROOT ("") moves the file to the vault root, basename preserved.
        content_note_move_receipt(&db, "desktop-a", "vault-a", "kn-a", "r3", "").unwrap();
        assert_eq!(db.content_note("desktop-a", "vault-a", "kn-a").unwrap()["relativePath"].as_str().unwrap(), "原笔记.md");
    }

    #[test]
    fn move_receipt_preserves_dirty_conflict_and_pending_safety() {
        let mut db = fixture();
        db.content_apply_batch("desktop-a", "vault-a", &[document("r1", "旧正文")], 1, None)
            .unwrap();
        // Simulate the exact safety states a mid-sync note carries: a dirty
        // local draft, an unresolved conflict document, and a pending op.
        db.conn.execute(
            "UPDATE note_cache SET dirty=1, conflict_document='{\"revision\":\"opposing\"}' WHERE note_id='kn-a'",
            params![],
        ).unwrap();
        db.conn.execute(
            "INSERT INTO content_note_operation(desktop_instance_id,vault_id,note_id,op_id,payload,draft_generation) VALUES('desktop-a','vault-a','kn-a','op-1','{}',1)",
            params![],
        ).unwrap();
        content_note_move_receipt(&db, "desktop-a", "vault-a", "kn-a", "r9", "Work").unwrap();
        let note = db.content_note("desktop-a", "vault-a", "kn-a").unwrap();
        assert_eq!(note["dirty"], true, "收据绝不能清除 dirty");
        assert!(note["conflictDocument"].is_object(), "收据绝不能清除 conflict_document");
        assert_eq!(note["content"], "旧正文");
        assert_eq!(note["revision"], "r1");
        let ops: i64 = db.conn.query_row(
            "SELECT COUNT(*) FROM content_note_operation WHERE desktop_instance_id='desktop-a' AND note_id='kn-a'",
            params![], |r| r.get(0),
        ).unwrap();
        assert_eq!(ops, 1, "收据绝不能吞掉待同步操作");
    }

    #[test]
    fn move_receipt_hostile_parent_fails_closed_and_unknown_note_is_noop() {
        let mut db = fixture();
        db.content_apply_batch("desktop-a", "vault-a", &[document("r1", "x")], 1, None)
            .unwrap();
        for hostile in ["../evil", "C:/evil", "//server/evil", "A/../evil"] {
            let err = content_note_move_receipt(&db, "desktop-a", "vault-a", "kn-a", "r2", hostile)
                .unwrap_err();
            assert_eq!(err, "CONTENT_PATH_INVALID", "hostile parent must fail closed: {hostile}");
        }
        assert_eq!(
            db.content_note("desktop-a", "vault-a", "kn-a").unwrap()["relativePath"].as_str().unwrap(),
            "目录/原笔记.md",
            "失败收据绝不移动路径"
        );
        // A note Mobile has never cached has no projection to move: Ok(noop).
        content_note_move_receipt(&db, "desktop-a", "vault-a", "ghost", "r2", "Work").unwrap();
    }

    // -----------------------------------------------------------------------
    // REPAIR-R1.2 (P1-5): the bounded local-only move-safety facts.
    // -----------------------------------------------------------------------

    #[test]
    fn move_facts_report_dirty_pending_conflict_per_exact_scope() {
        let mut db = fixture();
        db.content_apply_batch("desktop-a", "vault-a", &[document("r1", "旧正文")], 1, None)
            .unwrap();
        // A dirty note with a pending op and a conflict document.
        db.conn.execute(
            "UPDATE note_cache SET dirty=1, conflict_document='{\"revision\":\"opposing\"}' WHERE note_id='kn-a'",
            params![],
        ).unwrap();
        db.conn.execute(
            "INSERT INTO content_note_operation(desktop_instance_id,vault_id,note_id,op_id,payload,draft_generation) VALUES('desktop-a','vault-a','kn-a','op-1','{}',1)",
            params![],
        ).unwrap();
        // A clean note on another scope must be invisible here.
        db.content_apply_batch("desktop-b", "vault-a", &[json!({"noteId":"kn-b","vaultId":"vault-a","title":"B","relativePath":"B.md","revision":"rB","content":"b"})], 1, None)
            .unwrap();

        let out = db.content_note_move_facts("desktop-a", "vault-a", &["kn-a".into(), "missing".into(), "kn-b".into()]).unwrap();
        let items = out["items"].as_array().unwrap();
        assert_eq!(items.len(), 1, "absent ids are simply absent; another instance's note is invisible");
        let fact = &items[0];
        assert_eq!(fact["noteId"].as_str().unwrap(), "kn-a");
        assert_eq!(fact["dirty"], true);
        assert_eq!(fact["pending"], true, "a staged content_note_operation counts as pending");
        assert_eq!(fact["conflict"], true);
        assert_eq!(fact["revision"].as_str().unwrap(), "r1");
        assert_eq!(fact["serverRevision"].as_str().unwrap(), "r1");
    }

    #[test]
    fn move_facts_clean_row_and_server_revision_observation() {
        let mut db = fixture();
        db.content_apply_batch("desktop-a", "vault-a", &[document("r1", "旧正文")], 1, None)
            .unwrap();
        // A metadata-only summary advances the server observation to r2 while
        // the body baseline stays r1 — the facts must carry BOTH.
        db.content_apply_batch("desktop-a", "vault-a", &[summary("r2")], 2, None)
            .unwrap();
        let out = db.content_note_move_facts("desktop-a", "vault-a", &["kn-a".into()]).unwrap();
        let fact = &out["items"].as_array().unwrap()[0];
        assert_eq!(fact["dirty"], false);
        assert_eq!(fact["pending"], false);
        assert_eq!(fact["conflict"], false);
        assert_eq!(fact["revision"].as_str().unwrap(), "r1", "the body baseline");
        assert_eq!(fact["serverRevision"].as_str().unwrap(), "r2", "the latest remote observation");
    }

    // -----------------------------------------------------------------------
    // REPAIR-R1.5-A: READ-ONLY directory metadata hydration.
    // -----------------------------------------------------------------------

    fn summary_doc(id: &str, path: &str) -> Value {
        json!({"noteId":id,"vaultId":"vault-a","title":format!("t-{id}"),"relativePath":path,"revision":"r1"})
    }

    #[test]
    fn metadata_batch_populates_nested_directories_without_touching_sync_position() {
        let mut db = fixture();
        // Seed an unrelated body-cached note to prove read-only body behavior.
        db.content_apply_batch("desktop-a", "vault-a", &[document("r1", "旧正文")], 1, Some(("", true))).unwrap();
        let position_before = db.content_sync_position("desktop-a", "vault-a").unwrap();
        assert_eq!(position_before["initialized"], true);

        // The hydration applies Desktop SUMMARY pages (metadata-only).
        let applied = db.content_apply_metadata_batch("desktop-a", "vault-a", &[
            summary_doc("m1", "A/note.md"),
            summary_doc("m2", "A/B/deep.md"),
            summary_doc("m3", "root.md"),
        ]).unwrap();
        assert_eq!(applied, 3);
        let dirs = db.content_note_directories("desktop-a", "vault-a").unwrap()["directories"].as_array().unwrap().clone();
        let got: Vec<String> = dirs.iter().map(|v| v.as_str().unwrap().to_string()).collect();
        assert!(got.contains(&"A".to_string()) && got.contains(&"A/B".to_string()), "nested parents both appear: {got:?}");

        // READ-ONLY: the durable sync position is untouched (the ordinary
        // sync pipeline keeps its own cursor state).
        let position_after = db.content_sync_position("desktop-a", "vault-a").unwrap();
        assert_eq!(position_after["initialized"], position_before["initialized"]);
        assert_eq!(position_after["snapshotSeq"], position_before["snapshotSeq"]);
        assert_eq!(position_after["cursor"], position_before["cursor"]);
        assert_eq!(position_after["snapshotAfter"], position_before["snapshotAfter"]);
    }

    #[test]
    fn metadata_batch_is_read_only_for_bodies_pending_and_scope() {
        let mut db = fixture();
        db.content_apply_batch("desktop-a", "vault-a", &[document("r1", "旧正文")], 1, None).unwrap();
        db.conn.execute(
            "UPDATE note_cache SET dirty=1 WHERE note_id='kn-a'",
            params![],
        ).unwrap();
        db.conn.execute(
            "INSERT INTO content_note_operation(desktop_instance_id,vault_id,note_id,op_id,payload,draft_generation) VALUES('desktop-a','vault-a','kn-a','op-1','{}',1)",
            params![],
        ).unwrap();
        // A metadata summary with a NEWER revision and a moved path.
        db.content_apply_metadata_batch("desktop-a", "vault-a", &[
            json!({"noteId":"kn-a","vaultId":"vault-a","title":"远端新标题","relativePath":"Work/原笔记.md","revision":"r9"}),
        ]).unwrap();
        let note = db.content_note("desktop-a", "vault-a", "kn-a").unwrap();
        assert_eq!(note["content"], "旧正文", "body bytes untouched");
        assert_eq!(note["revision"], "r1", "cached-body revision never relabeled");
        assert_eq!(note["dirty"], true, "dirty preserved");
        assert_eq!(note["serverDocument"]["revision"], "r9", "the remote observation advanced");
        assert_eq!(note["serverDocument"]["relativePath"], "Work/原笔记.md");
        let ops: i64 = db.conn.query_row(
            "SELECT COUNT(*) FROM content_note_operation WHERE desktop_instance_id='desktop-a' AND note_id='kn-a'",
            params![], |r| r.get(0)).unwrap();
        assert_eq!(ops, 1, "no operation was pushed or consumed");
        // Exact scope: another instance's rows are invisible.
        let b: i64 = db.conn.query_row(
            "SELECT COUNT(*) FROM note_cache WHERE desktop_instance_id='desktop-b'",
            params![], |r| r.get(0)).unwrap();
        assert_eq!(b, 0, "zero B pollution from an A-scope apply");
    }

    // -----------------------------------------------------------------------
    // REPAIR-R1.5-B: Desktop create inside an EXISTING parent directory.
    // -----------------------------------------------------------------------

    #[test]
    fn create_in_parent_stages_publishes_and_ack_replaces() {
        let mut db = fixture();
        db.content_create_in("desktop-a", "vault-a", "kn-x1", "新笔记", "", "Work").unwrap();
        let note = db.content_note("desktop-a", "vault-a", "kn-x1").unwrap();
        assert_eq!(note["relativePath"], "Work/kn-x1.md", "the provisional filename is the unique note id");
        assert_eq!(note["dirty"], true);
        assert_eq!(note["pendingKind"], "create");
        let epoch = db.content_begin_edit("desktop-a", "vault-a", "kn-x1").unwrap()["editorEpoch"].as_i64().unwrap();
        db.content_edit("desktop-a", "vault-a", "kn-x1", "新笔记", "", epoch, 1).unwrap();
        // The published create mutation carries the intended EXISTING parent.
        let ops = db.content_prepare_operations("desktop-a", "vault-a").unwrap();
        let create = ops.iter().find(|o| o["kind"] == "create").expect("create op staged");
        assert_eq!(create["parentRelativePath"], "Work");
        // The Desktop acknowledgement replaces the provisional path with the
        // real committed one.
        db.content_ack("desktop-a", "vault-a", "kn-x1", create["opId"].as_str().unwrap(),
            &json!({"noteId":"kn-x1","vaultId":"vault-a","title":"新笔记","relativePath":"Work/真实文件名.md","revision":"r1","content":""})).unwrap();
        let note = db.content_note("desktop-a", "vault-a", "kn-x1").unwrap();
        assert_eq!(note["relativePath"], "Work/真实文件名.md", "the ack path replaces the provisional one");
    }

    // -----------------------------------------------------------------------
    // REPAIR-R1.5.1 — the pending-create refresh guard pipeline.
    // -----------------------------------------------------------------------

    #[test]
    fn pending_create_refresh_guard_lifecycle() {
        let mut db = fixture();
        // 1. Stage the create (inside Work) and open the detail immediately.
        db.content_create_in("desktop-a", "vault-a", "kn-p", "新笔记", "", "Work").unwrap();
        assert!(db.content_note_pending_unpublished("desktop-a", "vault-a", "kn-p").unwrap(),
            "a staged pending create with no serverDocument is pre-publication");
        let note = db.content_note("desktop-a", "vault-a", "kn-p").unwrap();
        assert_eq!(note["deleted"], false);
        assert!(note["serverDocument"].is_null(), "no committed observation yet");
        assert_eq!(note["relativePath"], "Work/kn-p.md", "the provisional path is retained");

        // 2. The user keeps editing BEFORE publication (a second generation).
        db.content_begin_edit("desktop-a", "vault-a", "kn-p").unwrap();
        let epoch = db.content_begin_edit("desktop-a", "vault-a", "kn-p").unwrap()["editorEpoch"].as_i64().unwrap();
        db.content_edit("desktop-a", "vault-a", "kn-p", "用户改过的标题", "用户正在编辑的内容", epoch, 1).unwrap();

        // 3. The create publishes with the correct title/content/parent.
        let ops = db.content_prepare_operations("desktop-a", "vault-a").unwrap();
        let create = ops.iter().find(|o| o["kind"] == "create").expect("create op");
        assert_eq!(create["parentRelativePath"], "Work");
        assert_eq!(create["title"], "用户改过的标题");
        assert_eq!(create["content"], "用户正在编辑的内容");

        // 4. The Desktop ack lands: the guard OPENS (serverDocument exists),
        //    and the real committed path replaces the provisional one.
        db.content_ack("desktop-a", "vault-a", "kn-p", create["opId"].as_str().unwrap(),
            &json!({"noteId":"kn-p","vaultId":"vault-a","title":"用户改过的标题","relativePath":"Work/真实.md","revision":"r1","content":"用户正在编辑的内容"})).unwrap();
        assert!(!db.content_note_pending_unpublished("desktop-a", "vault-a", "kn-p").unwrap(),
            "after the ack the note refreshes normally");
        let note = db.content_note("desktop-a", "vault-a", "kn-p").unwrap();
        assert_eq!(note["relativePath"], "Work/真实.md");

        // 5. A genuine later Desktop deletion is still detectable: the normal
        //    refresh path applies a tombstone summary without any guard.
        db.content_apply_batch("desktop-a", "vault-a",
            &[json!({"noteId":"kn-p","vaultId":"vault-a","deleted":true,"revision":"r2"})], 2, None).unwrap();
        let note = db.content_note("desktop-a", "vault-a", "kn-p").unwrap();
        assert_eq!(note["deleted"], true, "a real Desktop delete surfaces normally after publication");
    }

    // -----------------------------------------------------------------------
    // REPAIR-R1.6-C — create 409 filename-collision handling.
    // -----------------------------------------------------------------------

    fn staged_pending_note(db: &mut Db, parent: &str) -> String {
        let id = "kn-col";
        db.content_create_in("desktop-a", "vault-a", id, "新笔记", "", parent).unwrap();
        // Collision fixtures represent a real edit that retained the default title.
        let epoch = db.content_begin_edit("desktop-a", "vault-a", id).unwrap()["editorEpoch"].as_i64().unwrap();
        db.content_edit("desktop-a", "vault-a", id, "新笔记", "", epoch, 1).unwrap();
        id.to_string()
    }

    #[test]
    fn untouched_placeholder_waits_across_repeated_sync_until_real_edit() {
        let mut db = fixture();
        db.content_create_in("desktop-a", "vault-a", "kn-blank", "新笔记", "", "Work").unwrap();
        for _ in 0..3 {
            assert!(db.content_prepare_operations("desktop-a", "vault-a").unwrap().is_empty());
        }
        let note = db.content_note("desktop-a", "vault-a", "kn-blank").unwrap();
        assert_eq!(note["dirty"], true);
        assert!(note["conflictDocument"].is_null());
        let epoch = db.content_begin_edit("desktop-a", "vault-a", "kn-blank").unwrap()["editorEpoch"].as_i64().unwrap();
        db.content_edit("desktop-a", "vault-a", "kn-blank", "真实标题", "真实正文", epoch, 1).unwrap();
        let op = db.content_prepare_operations("desktop-a", "vault-a").unwrap().pop().unwrap();
        assert_eq!(op["title"], "真实标题");
        assert_eq!(op["content"], "真实正文");
        assert_eq!(op["parentRelativePath"], "Work");
        assert_eq!(db.content_prepare_operations("desktop-a", "vault-a").unwrap()[0], op, "immutable replay");
    }

    #[test]
    fn prepared_create_route_is_pinned_across_discovery_and_draft_changes() {
        for first_implemented in [false, true] {
            let mut db = fixture();
            db.content_create("desktop-a", "vault-a", "kn-route", "真实标题", "第一版").unwrap();
            let first = db.content_prepare_routed_operations("desktop-a", "vault-a", first_implemented).unwrap().pop().unwrap();
            assert_eq!(first.route, if first_implemented { NoteOperationRoute::KnowledgeCreateUnique } else { NoteOperationRoute::Content });
            let epoch = db.content_begin_edit("desktop-a", "vault-a", "kn-route").unwrap()["editorEpoch"].as_i64().unwrap();
            db.content_edit("desktop-a", "vault-a", "kn-route", "新标题", "第二版", epoch, 1).unwrap();
            let retry = db.content_prepare_routed_operations("desktop-a", "vault-a", !first_implemented).unwrap().pop().unwrap();
            assert_eq!(retry.route, first.route);
            assert_eq!(retry.payload, first.payload, "route and immutable opId/payload survive capability and draft changes");
            assert!(retry.payload.get("route").is_none(), "local transport metadata never reaches the wire");
        }
    }

    #[test]
    fn v8_operation_migration_preserves_payload_and_defaults_to_legacy_route() {
        let mut conn = Connection::open_in_memory().unwrap();
        for sql in MIGRATIONS.iter().take(8) { conn.execute_batch(sql).unwrap(); }
        conn.pragma_update(None, "user_version", 8).unwrap();
        let payload = r#"{"opId":"old-op","noteId":"old-note","kind":"create","expectedRevision":"","content":"保存的旧草稿"}"#;
        conn.execute("INSERT INTO content_note_operation VALUES('desktop-a','vault-a','old-note','old-op',?1,7)", params![payload]).unwrap();
        let tx = conn.transaction().unwrap();
        tx.execute_batch(MIGRATIONS[8]).unwrap();
        tx.pragma_update(None, "user_version", 9).unwrap();
        tx.commit().unwrap();
        let migrated: (String, String, i64) = conn.query_row("SELECT payload,route,draft_generation FROM content_note_operation", [], |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
        assert_eq!(migrated, (payload.into(), "content".into(), 7));
        assert!(conn.execute("UPDATE content_note_operation SET route='unknown'", []).is_err(), "unknown route fails closed");
    }

    #[test]
    fn unique_create_ack_adopts_final_name_path_revision_and_retains_newer_draft() {
        for (newer_draft, newer_title) in [(false, false), (true, false), (true, true)] {
            let mut db = fixture();
            db.content_create_in("desktop-a", "vault-a", "kn-unique", "同名", "第一版", "Work").unwrap();
            let prepared = db.content_prepare_routed_operations("desktop-a", "vault-a", true).unwrap().pop().unwrap();
            if newer_draft {
                let epoch = db.content_begin_edit("desktop-a", "vault-a", "kn-unique").unwrap()["editorEpoch"].as_i64().unwrap();
                db.content_edit("desktop-a", "vault-a", "kn-unique", if newer_title { "用户的新标题" } else { "同名" }, "后续正文", epoch, 1).unwrap();
            }
            let document = json!({"noteId":"kn-unique","vaultId":"vault-a","title":"同名（副本）","relativePath":"Work/同名（副本）.md","revision":"committed-r1","content":"第一版","resources":[]});
            db.content_ack("desktop-a", "vault-a", "kn-unique", prepared.payload["opId"].as_str().unwrap(), &document).unwrap();
            let note = db.content_note("desktop-a", "vault-a", "kn-unique").unwrap();
            assert_eq!(note["relativePath"], document["relativePath"]);
            assert_eq!(note["revision"], "committed-r1");
            assert_eq!(note["dirty"], newer_draft);
            assert!(note["conflictDocument"].is_null());
            assert_eq!(note["title"], if newer_title { "用户的新标题" } else { "同名（副本）" });
            assert_eq!(note["content"], if newer_draft { "后续正文" } else { "第一版" });
            let next = db.content_prepare_routed_operations("desktop-a", "vault-a", true).unwrap();
            if newer_draft {
                assert_eq!(next.len(), 1);
                assert_eq!(next[0].route, NoteOperationRoute::Content, "updates remain the existing Content authority");
                assert_eq!(next[0].payload["kind"], "update");
                assert_eq!(next[0].payload["expectedRevision"], "committed-r1");
                assert_eq!(next[0].payload["title"], note["title"]);
                assert_ne!(next[0].payload["opId"], prepared.payload["opId"]);
            } else { assert!(next.is_empty()); }
        }
    }

    #[test]
    fn unique_create_with_pending_attachment_adopts_selected_name_without_losing_body() {
        let mut db = fixture();
        let body = "正文 ![a](luckyray-attachment:op-att)";
        db.content_create("desktop-a", "vault-a", "kn-unique-att", "同名", body).unwrap();
        db.conn.execute("INSERT INTO content_note_attachment(desktop_instance_id,vault_id,note_id,op_id,file_name,mime,local_path,size_bytes,sha256) VALUES('desktop-a','vault-a','kn-unique-att','op-att','a.png','image/png','C:/tmp/a.png',10,'x')", []).unwrap();
        let prepared = db.content_prepare_routed_operations("desktop-a", "vault-a", true).unwrap().pop().unwrap();
        assert_eq!(prepared.payload["content"], "", "create publishes before local attachment placeholders");
        db.content_ack("desktop-a", "vault-a", "kn-unique-att", prepared.payload["opId"].as_str().unwrap(),
            &json!({"noteId":"kn-unique-att","vaultId":"vault-a","title":"同名（副本）","relativePath":"同名（副本）.md","revision":"r1","content":"","resources":[]})).unwrap();
        let note = db.content_note("desktop-a", "vault-a", "kn-unique-att").unwrap();
        assert_eq!(note["title"], "同名（副本）");
        assert_eq!(note["content"], body);
        assert_eq!(note["dirty"], true);
        assert_eq!(note["revision"], "r1");
        assert!(note["conflictDocument"].is_null());
        assert!(db.content_prepare_routed_operations("desktop-a", "vault-a", true).unwrap().is_empty(), "existing attachment-first update gate stays intact");
        let receipt: Option<String> = db.conn.query_row("SELECT receipt FROM content_note_attachment WHERE op_id='op-att'", [], |r|r.get(0)).unwrap();
        assert!(receipt.is_none(), "pending attachment is not discarded or falsely acknowledged");
    }

    #[test]
    fn placeholder_with_attachment_or_body_is_publishable() {
        let mut db = fixture();
        db.content_create("desktop-a", "vault-a", "kn-body", "新笔记", "正文").unwrap();
        assert_eq!(db.content_prepare_operations("desktop-a", "vault-a").unwrap().len(), 1);
        let mut db = fixture();
        db.content_create("desktop-a", "vault-a", "kn-att", "新笔记", "").unwrap();
        db.conn.execute("INSERT INTO content_note_attachment(desktop_instance_id,vault_id,note_id,op_id,file_name,mime,local_path,size_bytes,sha256,uploaded_bytes) VALUES('desktop-a','vault-a','kn-att','op-att','a.png','image/png','C:/tmp/a.png',10,'x',0)", []).unwrap();
        assert_eq!(db.content_prepare_operations("desktop-a", "vault-a").unwrap().len(), 1);
    }

    #[test]
    fn untouched_placeholders_do_not_starve_real_ops_and_existing_payload_replays() {
        let mut db = fixture();
        for i in 0..60 {
            db.content_create("desktop-a", "vault-a", &format!("a-blank-{i}"), "新笔记", "").unwrap();
        }
        db.content_create("desktop-a", "vault-a", "z-real", "真实标题", "正文").unwrap();
        let operations = db.content_prepare_operations("desktop-a", "vault-a").unwrap();
        assert_eq!(operations.len(), 1);
        assert_eq!(operations[0]["noteId"], "z-real");
        let legacy = json!({"opId":"legacy-op","kind":"create","noteId":"a-blank-0","vaultId":"vault-a","expectedRevision":"","title":"新笔记","content":""});
        db.conn.execute("INSERT INTO content_note_operation(desktop_instance_id,vault_id,note_id,op_id,payload,draft_generation) VALUES('desktop-a','vault-a','a-blank-0','legacy-op',?1,1)", params![legacy.to_string()]).unwrap();
        let operations = db.content_prepare_operations("desktop-a", "vault-a").unwrap();
        assert_eq!(operations[0], legacy, "previously prepared placeholder retains immutable retry");
    }

    fn op_payload_for(db: &mut Db, note_id: &str) -> Value {
        let ops = db.content_prepare_operations("desktop-a", "vault-a").unwrap();
        ops.iter().find(|o| o["noteId"] == note_id).cloned().expect("create op")
    }

    // -----------------------------------------------------------------------
    // REPAIR-R1.6.2 — collision provenance/attachment closure.
    // -----------------------------------------------------------------------

    #[test]
    fn collision_identity_is_generation_not_wire_content() {
        let mut db = fixture();
        let id = staged_pending_note(&mut db, "Work");
        // A pending attachment rides the create: the WIRE payload deliberately
        // sends content="" while note_cache holds the real body.
        db.conn.execute(
            "INSERT INTO content_note_attachment(desktop_instance_id,vault_id,note_id,op_id,file_name,mime,local_path,size_bytes,sha256,uploaded_bytes)
             VALUES('desktop-a','vault-a','kn-col','op-att','a.png','image/png','C:/tmp/a.png',10,'x',0)",
            params![],
        ).unwrap();
        db.conn.execute(
            "UPDATE note_cache SET content='![附件待同步](luckyray-attachment:op-att)' WHERE note_id='kn-col'",
            params![],
        ).unwrap();
        let op = op_payload_for(&mut db, &id);
        assert_eq!(op["content"], "", "the wire body is deliberately empty for a pending-attachment create");
        // (A) The latest title genuinely collides and the draft is UNCHANGED:
        // this must be a GENUINE collision (auto-copy), never stale.
        let out = db.content_create_collision_retry("desktop-a", "vault-a", &id, &op).unwrap();
        assert_eq!(out["renamed"].as_str().unwrap(), "新笔记（副本）", "genuine collision auto-copies despite the empty wire body");
        let note = db.content_note("desktop-a", "vault-a", &id).unwrap();
        assert_eq!(note["title"], "新笔记（副本）");
        let atts: i64 = db.conn.query_row(
            "SELECT COUNT(*) FROM content_note_attachment WHERE note_id='kn-col' AND receipt IS NULL",
            params![], |r| r.get(0)).unwrap();
        assert_eq!(atts, 1, "the attachment survives and keeps its upload pipeline");
        assert_eq!(note["relativePath"], "Work/kn-col.md", "parent preserved");

        // (B) The SAME setup, but after the op was prepared the user really
        // edited the title: the draft GENERATION moved -> STALE intent.
        let mut db2 = fixture();
        let id2 = staged_pending_note(&mut db2, "Work");
        let old_op = op_payload_for(&mut db2, &id2);
        let epoch = db2.content_begin_edit("desktop-a", "vault-a", &id2).unwrap()["editorEpoch"].as_i64().unwrap();
        db2.content_edit("desktop-a", "vault-a", &id2, "真新标题", "新正文", epoch, 1).unwrap();
        let out2 = db2.content_create_collision_retry("desktop-a", "vault-a", &id2, &old_op).unwrap();
        assert_eq!(out2["retried"], true, "a real user edit makes the old intent STALE");
        assert!(out2["renamed"].is_null(), "no auto-copy for a stale intent");
        let new_op = op_payload_for(&mut db2, &id2);
        assert_eq!(new_op["title"], "真新标题");
        assert_ne!(new_op["opId"].as_str().unwrap(), old_op["opId"].as_str().unwrap(), "NEW opId");
    }

    #[test]
    fn collision_block_is_outside_base_revision_and_user_edit_recovers() {
        let mut db = fixture();
        let id = staged_pending_note(&mut db, "");
        // Drive to the suffix-20 bound.
        db.conn.execute("UPDATE note_cache SET title='X（副本 20）' WHERE note_id='kn-col'", params![]).unwrap();
        let op = op_payload_for(&mut db, &id);
        let out = db.content_create_collision_retry("desktop-a", "vault-a", &id, &op).unwrap();
        assert_eq!(out["exhausted"], true);
        let blocked: i64 = db.conn.query_row(
            "SELECT create_collision_block FROM note_cache WHERE note_id='kn-col'", params![], |r| r.get(0)).unwrap();
        assert_eq!(blocked, 1, "the dedicated column carries the block");
        let base_rev: String = db.conn.query_row(
            "SELECT base_revision FROM note_cache WHERE note_id='kn-col'", params![], |r| r.get(0)).unwrap();
        assert_eq!(base_rev, "", "base_revision stays a pure write-provenance field");
        // Blocked creates are not re-prepared (no busy loop).
        let ops = db.content_prepare_operations("desktop-a", "vault-a").unwrap();
        assert!(!ops.iter().any(|o| o["noteId"] == "kn-col"), "no re-send of 副本 20");
        // The user renames to something unique: the edit CLEARS the block.
        let epoch = db.content_begin_edit("desktop-a", "vault-a", &id).unwrap()["editorEpoch"].as_i64().unwrap();
        db.content_edit("desktop-a", "vault-a", &id, "Unique", "内容", epoch, 1).unwrap();
        let blocked2: i64 = db.conn.query_row(
            "SELECT create_collision_block FROM note_cache WHERE note_id='kn-col'", params![], |r| r.get(0)).unwrap();
        assert_eq!(blocked2, 0, "a real user edit clears the collision block");
        // The next prepare regenerates a fresh create op with the new title.
        let ops = db.content_prepare_operations("desktop-a", "vault-a").unwrap();
        let create = ops.iter().find(|o| o["noteId"] == "kn-col").expect("recovered create op");
        assert_eq!(create["title"], "Unique");
        // Delete still works normally on a blocked note (a staged op queues
        // the pending delete through the existing pipeline).
        db.content_delete("desktop-a", "vault-a", &id).unwrap();
        let note = db.content_note("desktop-a", "vault-a", &id).unwrap();
        assert_eq!(note["pendingKind"], "delete", "delete is queued normally — unaffected by the block");
    }

    #[test]
    fn create_collision_stale_intent_retries_latest_without_conflict() {
        let mut db = fixture();
        let id = staged_pending_note(&mut db, "");
        // The op was prepared with the ORIGINAL title.
        let old_op = op_payload_for(&mut db, &id);
        assert_eq!(old_op["title"], "新笔记");
        let old_op_id = old_op["opId"].as_str().unwrap().to_string();
        // The user then edited the draft (title AND content changed).
        let epoch = db.content_begin_edit("desktop-a", "vault-a", &id).unwrap()["editorEpoch"].as_i64().unwrap();
        db.content_edit("desktop-a", "vault-a", &id, "252", "新内容", epoch, 1).unwrap();
        // The 409 arrives for the OLD intent.
        let out = db.content_create_collision_retry("desktop-a", "vault-a", &id, &old_op).unwrap();
        assert_eq!(out["retried"], true, "a stale intent is retried");
        assert!(out["renamed"].is_null(), "no auto-copy for a stale intent");
        let note = db.content_note("desktop-a", "vault-a", &id).unwrap();
        assert!(note["conflictDocument"].is_null(), "ZERO conflictDocument");
        assert_eq!(note["dirty"], true, "the pending create row survives");
        assert_eq!(note["title"], "252", "the LATEST title survives");
        // The regenerated op carries the LATEST draft with a NEW opId.
        let new_op = op_payload_for(&mut db, &id);
        assert_eq!(new_op["title"], "252");
        assert_eq!(new_op["content"], "新内容");
        assert_ne!(new_op["opId"].as_str().unwrap(), old_op_id, "changed payload gets a NEW opId");
    }

    #[test]
    fn create_collision_genuine_name_gets_bounded_auto_copy() {
        let mut db = fixture();
        let id = staged_pending_note(&mut db, "Work");
        // First collision: the op still matches the current draft.
        let op1 = op_payload_for(&mut db, &id);
        let out1 = db.content_create_collision_retry("desktop-a", "vault-a", &id, &op1).unwrap();
        assert_eq!(out1["renamed"].as_str().unwrap(), "新笔记（副本）");
        let note = db.content_note("desktop-a", "vault-a", &id).unwrap();
        assert_eq!(note["title"], "新笔记（副本）", "the local title truth updates");
        assert_eq!(note["relativePath"], "Work/kn-col.md", "parent/path unchanged");
        assert!(note["conflictDocument"].is_null());
        // The renamed payload retries and collides AGAIN -> 副本 2.
        let op2 = op_payload_for(&mut db, &id);
        assert_eq!(op2["title"], "新笔记（副本）");
        let out2 = db.content_create_collision_retry("desktop-a", "vault-a", &id, &op2).unwrap();
        assert_eq!(out2["renamed"].as_str().unwrap(), "新笔记（副本 2）");
        let op3 = op_payload_for(&mut db, &id);
        let out3 = db.content_create_collision_retry("desktop-a", "vault-a", &id, &op3).unwrap();
        assert_eq!(out3["renamed"].as_str().unwrap(), "新笔记（副本 3）");
        // Every changed payload carries a NEW opId (no reuse).
        let ids = [op1["opId"].as_str().unwrap(), op2["opId"].as_str().unwrap(), op3["opId"].as_str().unwrap()];
        assert_eq!(ids.iter().collect::<std::collections::HashSet<_>>().len(), 3, "each restage has a NEW opId");
        // Body/attachments/parent survive restage.
        let note = db.content_note("desktop-a", "vault-a", &id).unwrap();
        assert_eq!(note["content"], "", "content preserved");
        assert_eq!(note["relativePath"], "Work/kn-col.md", "parent preserved");
        assert_eq!(note["dirty"], true, "still a pending create");
    }

    #[test]
    fn create_collision_bound_is_bounded_and_attachments_survive() {
        let mut db = fixture();
        let id = staged_pending_note(&mut db, "");
        db.conn.execute(
            "UPDATE note_cache SET title='X（副本 20）' WHERE note_id='kn-col'",
            params![],
        ).unwrap();
        // An attachment rides on the pending create.
        db.conn.execute(
            "INSERT INTO content_note_attachment(desktop_instance_id,vault_id,note_id,op_id,file_name,mime,local_path,size_bytes,sha256,uploaded_bytes)
             VALUES('desktop-a','vault-a','kn-col','op-att-1','a.png','image/png','C:/tmp/a.png',10,'x',0)",
            params![],
        ).unwrap();
        let op = op_payload_for(&mut db, &id);
        let out = db.content_create_collision_retry("desktop-a", "vault-a", &id, &op).unwrap();
        assert_eq!(out["retried"], false, "the 20-suffix bound is respected — no 21st copy");
        assert!(out["renamed"].is_null());
        let note = db.content_note("desktop-a", "vault-a", &id).unwrap();
        assert_eq!(note["title"], "X（副本 20）", "the truthful pending state remains");
        assert!(note["conflictDocument"].is_null());
        let atts: i64 = db.conn.query_row(
            "SELECT COUNT(*) FROM content_note_attachment WHERE note_id='kn-col' AND receipt IS NULL",
            params![], |r| r.get(0)).unwrap();
        assert_eq!(atts, 1, "attachments survive every restage");
    }

    #[test]
    fn create_collision_deleted_pending_row_retires_op_only() {
        let mut db = fixture();
        let id = staged_pending_note(&mut db, "");
        let op = op_payload_for(&mut db, &id);
        db.conn.execute("UPDATE note_cache SET deleted=1 WHERE note_id='kn-col'", params![]).unwrap();
        let out = db.content_create_collision_retry("desktop-a", "vault-a", &id, &op).unwrap();
        assert_eq!(out["retried"], false);
        let ops: i64 = db.conn.query_row(
            "SELECT COUNT(*) FROM content_note_operation WHERE note_id='kn-col'",
            params![], |r| r.get(0)).unwrap();
        assert_eq!(ops, 0, "the operation intent is retired");
    }

    #[test]
    fn pending_create_guard_is_scope_exact_and_conflict_safe() {
        let mut db = fixture();
        db.content_create_in("desktop-a", "vault-a", "kn-g", "t", "", "").unwrap();
        // Exact scope: another vault/instance does not see the guard.
        assert!(!db.content_note_pending_unpublished("desktop-a", "vault-b", "kn-g").unwrap());
        assert!(!db.content_note_pending_unpublished("desktop-b", "vault-a", "kn-g").unwrap());
        // A published note (serverDocument present) is not guarded even if
        // it later goes dirty again.
        db.content_apply_batch("desktop-a", "vault-a", &[document("r1", "正文")], 1, None).unwrap();
        assert!(!db.content_note_pending_unpublished("desktop-a", "vault-a", "kn-a").unwrap());
    }

    #[test]
    fn create_parent_validation() {
        let db = fixture();
        // ROOT (empty parent) keeps the plain provisional name.
        db.content_create_in("desktop-a", "vault-a", "kn-r", "t", "", "").unwrap();
        assert_eq!(db.content_note("desktop-a", "vault-a", "kn-r").unwrap()["relativePath"], "kn-r.md");
        // Hostile parents fail closed; nothing is staged.
        for hostile in ["../evil", "C:/evil", "//s/evil", "A/../evil"] {
            let err = db.content_create_in("desktop-a", "vault-a", "kn-h", "t", "", hostile).unwrap_err();
            assert_eq!(err, "CONTENT_PATH_INVALID", "hostile parent {hostile}");
        }
        let n: i64 = db.conn.query_row(
            "SELECT COUNT(*) FROM note_cache WHERE note_id='kn-h'", params![], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "no row staged for a hostile parent");
    }

    #[test]
    fn move_facts_are_bounded_to_100_ids_per_call() {
        let mut db = fixture();
        db.content_apply_batch("desktop-a", "vault-a", &[document("r1", "x")], 1, None)
            .unwrap();
        for i in 0..130 {
            db.conn.execute(
                "INSERT INTO note_cache(desktop_instance_id,note_id,vault_id,title,relative_path,content,revision,deleted) VALUES('desktop-a',?1,'vault-a','t','a.md','',?2,0)",
                params![format!("n-{i}"), format!("r{i}")],
            ).unwrap();
        }
        let ids: Vec<String> = (0..130).map(|i| format!("n-{i}")).collect();
        let out = db.content_note_move_facts("desktop-a", "vault-a", &ids).unwrap();
        assert_eq!(out["items"].as_array().unwrap().len(), 100, "the local read is bounded to 100 existing rows (the TS side chunks)");
    }

    // -----------------------------------------------------------------------
    // STABILITY-FIX-R1 Finding A — cached body provenance.
    //
    // Frozen invariant: a summary WITHOUT `content` may advance the latest
    // remote observation, but it must never clear or re-label the cached body.
    // `revision` continues to mean "the revision the cached body actually
    // corresponds to", because it is the source of `expectedRevision` on the
    // mutation path.
    // -----------------------------------------------------------------------

    /// Matrix 1 — full r1 → summary r2 (no `content`).
    #[test]
    fn summary_without_content_keeps_cached_body_and_its_real_revision() {
        let mut db = fixture();
        db.content_apply_batch("desktop-a", "vault-a", &[document("r1", "旧正文")], 1, None)
            .unwrap();
        db.content_apply_batch("desktop-a", "vault-a", &[summary("r2")], 2, None)
            .unwrap();
        let note = db.content_note("desktop-a", "vault-a", "kn-a").unwrap();
        // The body is still readable and still r1.
        assert_eq!(note["content"], "旧正文", "旧正文不能被摘要清空");
        assert_eq!(note["revision"], "r1", "正文基线不能被摘要推进");
        // The latest remote observation did advance to r2.
        assert_eq!(note["serverDocument"]["revision"], "r2");
    }

    /// Matrix 2 — offline edit from the r1 cache must still base on r1.
    #[test]
    fn offline_edit_after_summary_still_uses_body_revision_as_expected() {
        let mut db = fixture();
        db.content_apply_batch("desktop-a", "vault-a", &[document("r1", "旧正文")], 1, None)
            .unwrap();
        db.content_apply_batch("desktop-a", "vault-a", &[summary("r2")], 2, None)
            .unwrap();
        let epoch = db
            .content_begin_edit("desktop-a", "vault-a", "kn-a")
            .unwrap()["editorEpoch"]
            .as_i64()
            .unwrap();
        db.content_edit(
            "desktop-a",
            "vault-a",
            "kn-a",
            "原笔记",
            "旧正文+手机改动",
            epoch,
            1,
        )
        .unwrap();
        let op = db
            .content_prepare_operations("desktop-a", "vault-a")
            .unwrap()
            .remove(0);
        assert_eq!(
            op["expectedRevision"], "r1",
            "离线编辑必须以正文真实版本 r1 为 expectedRevision，绝不能冒充 r2"
        );
        assert_ne!(
            op["expectedRevision"], "r2",
            "以 r2 为基线会静默覆盖 Desktop 的更新"
        );
    }

    /// Matrix 2b — reconnecting to r2 must enter the EXISTING conflict
    /// protection, not silently overwrite: the local edit keeps its r1 base,
    /// the server rejects it, and both versions are preserved.
    #[test]
    fn reconnecting_after_offline_edit_from_cached_body_enters_existing_conflict() {
        let mut db = fixture();
        db.content_apply_batch("desktop-a", "vault-a", &[document("r1", "旧正文")], 1, None)
            .unwrap();
        db.content_apply_batch("desktop-a", "vault-a", &[summary("r2")], 2, None)
            .unwrap();
        let epoch = db
            .content_begin_edit("desktop-a", "vault-a", "kn-a")
            .unwrap()["editorEpoch"]
            .as_i64()
            .unwrap();
        db.content_edit("desktop-a", "vault-a", "kn-a", "原笔记", "手机改动", epoch, 1)
            .unwrap();
        // The push carries the body's real base, so Desktop rejects it.
        let op = db
            .content_prepare_operations("desktop-a", "vault-a")
            .unwrap()
            .remove(0);
        assert_eq!(op["expectedRevision"], "r1");
        assert!(text(&op, "content").contains("手机改动"));
        // The 409 path stores the FULL opposing document (unchanged behaviour).
        db.content_conflict("desktop-a", "vault-a", "kn-a", &document("r2", "电脑改动"))
            .unwrap();
        let note = db.content_note("desktop-a", "vault-a", "kn-a").unwrap();
        assert_eq!(note["content"], "手机改动", "本地输入保留");
        assert_eq!(
            note["conflictDocument"]["content"], "电脑改动",
            "电脑版本需完整保留（可对比、可采纳）"
        );
        assert_eq!(note["dirty"], true);
    }

    /// Matrix 3 — a full r2 atomically advances body + resources + revision.
    #[test]
    fn full_document_advances_cached_body_resources_and_revision_together() {
        let mut db = fixture();
        db.content_apply_batch("desktop-a", "vault-a", &[document("r1", "旧正文")], 1, None)
            .unwrap();
        db.content_apply_batch("desktop-a", "vault-a", &[summary("r2")], 2, None)
            .unwrap();
        let mut full = document("r2", "新正文");
        full["resources"] = json!([{"resourceId": "res-1", "target": "图.png", "status": "resolved", "version": "v1", "mimeType": "image/png", "embedded": false}]);
        db.content_apply_batch("desktop-a", "vault-a", &[full], 3, None)
            .unwrap();
        let note = db.content_note("desktop-a", "vault-a", "kn-a").unwrap();
        assert_eq!(note["content"], "新正文");
        assert_eq!(note["revision"], "r2", "完整文档到达后正文基线才推进");
        assert_eq!(note["serverDocument"]["revision"], "r2");
        assert_eq!(note["serverDocument"]["resources"][0]["resourceId"], "res-1");
    }

    /// Matrix 4 — `content: ""` is a REAL complete empty body, not a missing field.
    #[test]
    fn explicit_empty_content_is_a_real_body_and_replaces_previous_text() {
        let mut db = fixture();
        db.content_apply_batch("desktop-a", "vault-a", &[document("r1", "有正文")], 1, None)
            .unwrap();
        db.content_apply_batch("desktop-a", "vault-a", &[document("r2", "")], 2, None)
            .unwrap();
        let note = db.content_note("desktop-a", "vault-a", "kn-a").unwrap();
        assert_eq!(note["content"], "", "真实空正文必须替换 r1");
        assert_eq!(note["revision"], "r2", "真实空正文同样推进正文基线");
    }

    /// Matrix 5 — tombstone keeps the recoverable text and the dirty draft.
    #[test]
    fn tombstone_after_summary_keeps_recoverable_body_and_dirty_draft() {
        let mut db = fixture();
        db.content_apply_batch("desktop-a", "vault-a", &[document("r1", "旧正文")], 1, None)
            .unwrap();
        db.content_apply_batch("desktop-a", "vault-a", &[summary("r2")], 2, None)
            .unwrap();
        db.content_apply_batch(
            "desktop-a",
            "vault-a",
            &[json!({"noteId":"kn-a","vaultId":"vault-a","deleted":true})],
            3,
            None,
        )
        .unwrap();
        let note = db.content_note("desktop-a", "vault-a", "kn-a").unwrap();
        assert_eq!(note["deleted"], true);
        assert_eq!(note["content"], "旧正文", "删除后仍保留可恢复正文");
    }

    /// The UI-facing provenance: a summary that outran a still-readable body is
    /// reported as such, so the editor can say "缓存版本 · 联网后更新" instead
    /// of wrongly claiming the body is uncached.
    #[test]
    fn note_reports_body_outdated_flag_without_leaking_it_to_the_protocol() {
        let mut db = fixture();
        db.content_apply_batch("desktop-a", "vault-a", &[document("r1", "旧正文")], 1, None)
            .unwrap();
        let fresh = db.content_note("desktop-a", "vault-a", "kn-a").unwrap();
        assert_eq!(fresh["bodyOutdated"], false);
        assert_eq!(fresh["cachedDocument"]["revision"], "r1");
        db.content_apply_batch("desktop-a", "vault-a", &[summary("r2")], 2, None)
            .unwrap();
        let stale = db.content_note("desktop-a", "vault-a", "kn-a").unwrap();
        assert_eq!(stale["bodyOutdated"], true, "缓存正文落后于远端摘要");
        assert_eq!(stale["cachedDocument"]["revision"], "r1", "缓存正文仍是 r1");
        assert_eq!(stale["serverDocument"]["revision"], "r2");
        assert_eq!(stale["content"], "旧正文");
        // A first sighting that is only a summary has nothing readable at all.
        db.content_apply_batch(
            "desktop-a",
            "vault-a",
            &[json!({"noteId":"kn-b","vaultId":"vault-a","revision":"r9","title":"只有摘要"})],
            3,
            None,
        )
        .unwrap();
        let thin = db.content_note("desktop-a", "vault-a", "kn-b").unwrap();
        assert!(thin["cachedDocument"].is_null(), "无正文就没有可读缓存文档");
        assert_eq!(thin["bodyOutdated"], false, "无可读正文时不谎报落后");
        assert_eq!(thin["revision"], "", "无正文不认领正文版本");
    }

    /// Matrix 6 — dirty draft + summary update: input survives, base not forged.
    #[test]
    fn dirty_draft_survives_summary_update_without_forging_its_base() {
        let mut db = fixture();
        db.content_apply_batch("desktop-a", "vault-a", &[document("r1", "原文")], 1, None)
            .unwrap();
        let epoch = db
            .content_begin_edit("desktop-a", "vault-a", "kn-a")
            .unwrap()["editorEpoch"]
            .as_i64()
            .unwrap();
        db.content_edit("desktop-a", "vault-a", "kn-a", "原笔记", "手机草稿", epoch, 1)
            .unwrap();
        db.content_apply_batch("desktop-a", "vault-a", &[summary("r2")], 2, None)
            .unwrap();
        let note = db.content_note("desktop-a", "vault-a", "kn-a").unwrap();
        assert_eq!(note["content"], "手机草稿", "草稿输入不丢");
        assert_eq!(note["dirty"], true);
        let op = db
            .content_prepare_operations("desktop-a", "vault-a")
            .unwrap()
            .remove(0);
        assert_eq!(op["expectedRevision"], "r1", "草稿基线仍是 r1，不伪造");
    }

    /// Matrix 7 — a summary must not break attachment presentation or deps.
    #[test]
    fn summary_does_not_break_attachment_presentation_or_pending_dependencies() {
        let mut db = fixture();
        db.content_apply_batch("desktop-a", "vault-a", &[document("r1", "原")], 1, None)
            .unwrap();
        db.content_stage_attachment(
            "desktop-a",
            "vault-a",
            "kn-a",
            "upload-a",
            "图.png",
            "image/png",
            "private-file",
            12,
            "digest",
        )
        .unwrap();
        // A metadata-only summary arrives while the attachment is still pending.
        db.content_apply_batch("desktop-a", "vault-a", &[summary("r2")], 2, None)
            .unwrap();
        let note = db.content_note("desktop-a", "vault-a", "kn-a").unwrap();
        assert!(
            text(&note, "content").contains("luckyray-attachment:upload-a"),
            "待同步附件标记仍在正文中"
        );
        assert_eq!(
            db.content_pending_attachments("desktop-a", "vault-a")
                .unwrap()
                .len(),
            1,
            "待同步附件依赖未被摘要破坏"
        );
        // The upload manifest must be based on the BODY revision, never the summary.
        let pending = db
            .content_pending_attachments("desktop-a", "vault-a")
            .unwrap();
        assert_eq!(
            pending[0]["serverDocument"]["revision"], "r1",
            "附件上传基线必须与正文版本一致"
        );
    }

    #[test]
    fn golden_contract_applies_and_preserves_tombstone_identity() {
        let golden: Value = serde_json::from_str(include_str!(
            "../../shared/companion-content-v1/golden.json"
        ))
        .unwrap();
        let mut db = fixture();
        db.content_vault_remember("desktop-golden", "vault-golden", "库")
            .unwrap();
        db.content_apply_batch(
            "desktop-golden",
            "vault-golden",
            &[golden["document"].clone()],
            1,
            None,
        )
        .unwrap();
        let note = db
            .content_note("desktop-golden", "vault-golden", "kn-golden")
            .unwrap();
        for key in ["noteId", "title", "relativePath", "content", "revision"] {
            assert_eq!(note[key], golden["document"][key]);
        }
        db.content_apply_batch(
            "desktop-golden",
            "vault-golden",
            &[golden["tombstone"].clone()],
            2,
            None,
        )
        .unwrap();
        assert_eq!(
            db.content_note("desktop-golden", "vault-golden", "kn-golden")
                .unwrap()["deleted"],
            true
        );
    }

    #[test]
    fn cached_note_pages_and_literal_body_search_are_complete() {
        let mut db = fixture();
        let rows: Vec<_> = (0..53)
            .map(|n| {
                let mut row = document(
                    "r1",
                    if n == 51 {
                        "body needle'中文"
                    } else {
                        "other"
                    },
                );
                row["noteId"] = json!(format!("kn-{n:03}"));
                row["relativePath"] = json!(format!("folder/{n:03}.md"));
                row
            })
            .collect();
        db.content_apply_batch("desktop-a", "vault-a", &rows, 53, None)
            .unwrap();
        let first = db.content_notes("desktop-a", "vault-a", "", 1, "").unwrap();
        assert_eq!(first["items"].as_array().unwrap().len(), 50);
        assert_eq!(first["hasMore"], true);
        let second = db.content_notes("desktop-a", "vault-a", "", 2, "").unwrap();
        assert_eq!(second["items"].as_array().unwrap().len(), 3);
        assert_eq!(second["hasMore"], false);
        let found = db
            .content_notes("desktop-a", "vault-a", "needle'中文", 1, "")
            .unwrap();
        assert_eq!(found["items"].as_array().unwrap().len(), 1);
        assert_eq!(found["items"][0]["noteId"], "kn-051");
        assert!(
            db.content_notes("desktop-a", "other-vault", "", 1, "").unwrap()["items"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn attachment_dependencies_survive_new_note_ack_and_receipt_rewrites_late_input() {
        let mut db = fixture();
        db.content_create("desktop-a", "vault-a", "kn-a", "原笔记", "离线正文")
            .unwrap();
        let staged = db
            .content_stage_attachment(
                "desktop-a",
                "vault-a",
                "kn-a",
                "upload-a",
                "图.png",
                "image/png",
                "private-file",
                12,
                "digest",
            )
            .unwrap();
        let before = text(&staged, "content").to_string();
        let op = db
            .content_prepare_operations("desktop-a", "vault-a")
            .unwrap()
            .remove(0);
        assert_eq!(op["kind"], "create");
        assert_eq!(op["content"], "");
        db.content_ack(
            "desktop-a",
            "vault-a",
            "kn-a",
            text(&op, "opId"),
            &document("r1", ""),
        )
        .unwrap();
        assert_eq!(
            db.content_note("desktop-a", "vault-a", "kn-a").unwrap()["content"],
            before
        );
        assert!(db
            .content_prepare_operations("desktop-a", "vault-a")
            .unwrap()
            .is_empty());
        let receipt = json!({"publication":{"markdown":"![图](附件/图.png)"}});
        db.content_attachment_receipt("desktop-a", "vault-a", "kn-a", "upload-a", &receipt)
            .unwrap();
        db.content_attachment_receipt("desktop-a", "vault-a", "kn-a", "upload-a", &receipt)
            .unwrap();
        let epoch = db
            .content_begin_edit("desktop-a", "vault-a", "kn-a")
            .unwrap()["editorEpoch"]
            .as_i64()
            .unwrap();
        db.content_edit(
            "desktop-a",
            "vault-a",
            "kn-a",
            "原笔记",
            &format!("{before}后来输入"),
            epoch,
            1,
        )
        .unwrap();
        let op = db
            .content_prepare_operations("desktop-a", "vault-a")
            .unwrap()
            .remove(0);
        assert!(text(&op, "content").contains("后来输入"));
        assert!(text(&op, "content").contains("附件/图.png"));
        assert!(!text(&op, "content").contains("luckyray-attachment:"));
    }

    #[test]
    fn never_published_deleted_note_does_not_create_remote_operation() {
        let mut db = fixture();
        db.content_create("desktop-a", "vault-a", "kn-a", "原笔记", "保留正文")
            .unwrap();
        db.content_delete("desktop-a", "vault-a", "kn-a").unwrap();
        assert!(db
            .content_prepare_operations("desktop-a", "vault-a")
            .unwrap()
            .is_empty());
        assert_eq!(
            db.content_note("desktop-a", "vault-a", "kn-a").unwrap()["content"],
            "保留正文"
        );
    }

    #[test]
    fn deleted_note_stops_attachment_publication_and_cross_vault_ids_fail_closed() {
        let mut db = fixture();
        db.content_apply_batch(
            "desktop-a",
            "vault-a",
            &[document("r1", "original")],
            1,
            None,
        )
        .unwrap();
        db.content_stage_attachment(
            "desktop-a",
            "vault-a",
            "kn-a",
            "upload-a",
            "a.png",
            "image/png",
            "private-file",
            12,
            "hash",
        )
        .unwrap();
        assert_eq!(
            db.content_pending_attachments("desktop-a", "vault-a")
                .unwrap()
                .len(),
            1
        );
        db.content_delete("desktop-a", "vault-a", "kn-a").unwrap();
        assert!(db
            .content_pending_attachments("desktop-a", "vault-a")
            .unwrap()
            .is_empty());
        assert_eq!(
            db.content_prepare_operations("desktop-a", "vault-a")
                .unwrap()[0]["kind"],
            "delete"
        );
        let mut other = document("other", "must not overwrite");
        other["vaultId"] = json!("vault-b");
        assert!(db
            .content_apply_batch("desktop-a", "vault-b", &[other], 2, None)
            .is_err());
        assert!(text(
            &db.content_note("desktop-a", "vault-a", "kn-a").unwrap(),
            "content"
        )
        .contains("original"));
    }

    #[test]
    fn incoming_revision_and_tombstone_preserve_offline_draft_and_both_versions() {
        let mut db = fixture();
        db.content_apply_batch("desktop-a", "vault-a", &[document("r1", "原文")], 1, None)
            .unwrap();
        let epoch = db
            .content_begin_edit("desktop-a", "vault-a", "kn-a")
            .unwrap()["editorEpoch"]
            .as_i64()
            .unwrap();
        db.content_edit(
            "desktop-a",
            "vault-a",
            "kn-a",
            "原笔记",
            "手机离线内容",
            epoch,
            1,
        )
        .unwrap();
        db.content_apply_batch(
            "desktop-a",
            "vault-a",
            &[document("r2", "电脑修改")],
            2,
            None,
        )
        .unwrap();
        let note = db.content_note("desktop-a", "vault-a", "kn-a").unwrap();
        assert_eq!(note["content"], "手机离线内容");
        assert_eq!(note["conflictDocument"]["content"], "电脑修改");
        assert_eq!(
            db.content_sync_position("desktop-a", "vault-a").unwrap()["cursor"],
            2
        );
        db.content_apply_batch(
            "desktop-a",
            "vault-a",
            &[json!({"noteId":"kn-a","vaultId":"vault-a","deleted":true})],
            3,
            None,
        )
        .unwrap();
        assert_eq!(
            db.content_note("desktop-a", "vault-a", "kn-a").unwrap()["content"],
            "手机离线内容"
        );
        assert!(db.reset_full().is_err());
        db.revoke_paired().unwrap();
        assert_eq!(
            db.content_note("desktop-a", "vault-a", "kn-a").unwrap()["content"],
            "手机离线内容"
        );
    }

    #[test]
    fn lost_response_reuses_payload_and_ack_does_not_clear_later_input() {
        let mut db = fixture();
        db.content_apply_batch("desktop-a", "vault-a", &[document("r1", "原文")], 1, None)
            .unwrap();
        let epoch = db
            .content_begin_edit("desktop-a", "vault-a", "kn-a")
            .unwrap()["editorEpoch"]
            .as_i64()
            .unwrap();
        db.content_edit("desktop-a", "vault-a", "kn-a", "原笔记", "第一份", epoch, 1)
            .unwrap();
        let op = db
            .content_prepare_operations("desktop-a", "vault-a")
            .unwrap()
            .remove(0);
        db.content_edit(
            "desktop-a",
            "vault-a",
            "kn-a",
            "原笔记",
            "上传中继续输入",
            epoch,
            2,
        )
        .unwrap();
        assert_eq!(
            db.content_prepare_operations("desktop-a", "vault-a")
                .unwrap()[0],
            op
        );
        db.content_ack(
            "desktop-a",
            "vault-a",
            "kn-a",
            text(&op, "opId"),
            &document("r2", "第一份"),
        )
        .unwrap();
        let note = db.content_note("desktop-a", "vault-a", "kn-a").unwrap();
        assert_eq!(note["content"], "上传中继续输入");
        assert_eq!(note["dirty"], true);
        let next = db
            .content_prepare_operations("desktop-a", "vault-a")
            .unwrap()
            .remove(0);
        assert_eq!(next["expectedRevision"], "r2");
        assert_ne!(next["opId"], op["opId"]);
        assert_eq!(next["content"], "上传中继续输入");
    }

    #[test]
    fn rollback_tombstone_retains_draft_and_exact_frozen_operation() {
        let mut db = fixture();
        db.content_apply_batch("desktop-a", "vault-a", &[document("r1", "saved body")], 1, None).unwrap();
        let epoch = db.content_begin_edit("desktop-a", "vault-a", "kn-a").unwrap()["editorEpoch"].as_i64().unwrap();
        db.content_edit("desktop-a", "vault-a", "kn-a", "原笔记", "unsent draft", epoch, 1).unwrap();
        let operation = db.content_prepare_operations("desktop-a", "vault-a").unwrap().remove(0);
        let before: String = db.conn.query_row("SELECT payload FROM content_note_operation WHERE note_id='kn-a'", [], |row| row.get(0)).unwrap();
        db.content_apply_batch("desktop-a", "vault-a", &[json!({"noteId":"kn-a","vaultId":"vault-a","revision":"deleted-r2","deleted":true})], 2, None).unwrap();
        let note = db.content_note("desktop-a", "vault-a", "kn-a").unwrap();
        assert_eq!(note["content"], "unsent draft");
        assert_eq!(note["conflictDocument"]["deleted"], true);
        assert_eq!(note["cachedDocument"]["content"], "saved body");
        let after: String = db.conn.query_row("SELECT payload FROM content_note_operation WHERE note_id='kn-a'", [], |row| row.get(0)).unwrap();
        assert_eq!(after, before);
        assert_eq!(serde_json::from_str::<Value>(&after).unwrap(), operation);
    }

    #[test]
    fn apply_and_cursor_roll_back_together_and_resnapshot_retains_pending_work() {
        let mut db = fixture();
        db.content_apply_batch("desktop-a", "vault-a", &[document("r1", "原文")], 1, None)
            .unwrap();
        assert!(db
            .content_apply_batch(
                "desktop-a",
                "vault-a",
                &[
                    document("r2", "新文"),
                    json!({"noteId":"other","vaultId":"wrong"})
                ],
                9,
                None
            )
            .is_err());
        assert_eq!(
            db.content_note("desktop-a", "vault-a", "kn-a").unwrap()["content"],
            "原文"
        );
        assert_eq!(
            db.content_sync_position("desktop-a", "vault-a").unwrap()["cursor"],
            1
        );
        let epoch = db
            .content_begin_edit("desktop-a", "vault-a", "kn-a")
            .unwrap()["editorEpoch"]
            .as_i64()
            .unwrap();
        db.content_edit("desktop-a", "vault-a", "kn-a", "原笔记", "草稿", epoch, 2)
            .unwrap();
        let op = db
            .content_prepare_operations("desktop-a", "vault-a")
            .unwrap();
        db.content_resnapshot("desktop-a", "vault-a").unwrap();
        assert_eq!(
            db.content_note("desktop-a", "vault-a", "kn-a").unwrap()["content"],
            "草稿"
        );
        assert_eq!(
            db.content_prepare_operations("desktop-a", "vault-a")
                .unwrap(),
            op
        );
        assert!(db
            .content_edit(
                "desktop-a",
                "vault-a",
                "kn-a",
                "原笔记",
                "迟到输入",
                epoch,
                1
            )
            .is_err());
    }

    #[test]
    fn conflict_copy_is_one_durable_create_and_repeat_choice_cannot_duplicate_it() {
        let mut db = fixture();
        db.content_apply_batch("desktop-a", "vault-a", &[document("r1", "原文")], 1, None)
            .unwrap();
        let epoch = db
            .content_begin_edit("desktop-a", "vault-a", "kn-a")
            .unwrap()["editorEpoch"]
            .as_i64()
            .unwrap();
        db.content_edit(
            "desktop-a",
            "vault-a",
            "kn-a",
            "原笔记",
            "自己的版本",
            epoch,
            1,
        )
        .unwrap();
        db.content_conflict("desktop-a", "vault-a", "kn-a", &document("r2", "电脑版"))
            .unwrap();
        let copy = db
            .content_resolve("desktop-a", "vault-a", "kn-a", true)
            .unwrap()
            .unwrap();
        assert_eq!(
            db.content_note("desktop-a", "vault-a", &copy).unwrap()["content"],
            "自己的版本"
        );
        assert_eq!(
            db.content_note("desktop-a", "vault-a", "kn-a").unwrap()["content"],
            "电脑版"
        );
        assert!(db
            .content_resolve("desktop-a", "vault-a", "kn-a", true)
            .is_err());
        assert_eq!(
            db.content_prepare_operations("desktop-a", "vault-a")
                .unwrap()
                .len(),
            1
        );
    }

    /// Matrix 8 — schema6 → schema7 preserves complete cache, drafts and
    /// pending operations/attachments across a process restart.
    #[test]
    fn actual_v6_database_upgrades_and_preserves_cache_drafts_and_pending_work() {
        let root = std::env::temp_dir().join(format!("lr-content-v6-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("mobile.db");
        // Build a REAL v6 database from the migration list itself.
        let conn = Connection::open(&path).unwrap();
        for (index, sql) in MIGRATIONS.iter().take(6).enumerate() {
            conn.execute_batch(sql).unwrap();
            conn.pragma_update(None, "user_version", index + 1).unwrap();
        }
        // A complete cached body (full document with content + resources).
        conn.execute(
            "INSERT INTO note_cache(desktop_instance_id,note_id,vault_id,title,relative_path,content,revision,dirty,draft_generation,server_document,deleted,pending_kind,base_revision)
             VALUES('desktop-a','kn-full','vault-a','完整','a.md','完整正文','r1',0,0,?1,0,'update',NULL)",
            params![json!({"noteId":"kn-full","vaultId":"vault-a","title":"完整","relativePath":"a.md","content":"完整正文","revision":"r1","resources":[]}).to_string()],
        )
        .unwrap();
        // A row whose server_document is only a summary (no content) — its
        // true body provenance is NOT provable, so it must not be trusted.
        conn.execute(
            "INSERT INTO note_cache(desktop_instance_id,note_id,vault_id,title,relative_path,content,revision,dirty,draft_generation,server_document,deleted,pending_kind,base_revision)
             VALUES('desktop-a','kn-summary','vault-a','摘要','b.md','','r2',0,0,?1,0,'update',NULL)",
            params![summary("r2").to_string()],
        )
        .unwrap();
        // A dirty draft with a pending operation + a pending attachment.
        conn.execute(
            "INSERT INTO note_cache(desktop_instance_id,note_id,vault_id,title,relative_path,content,revision,dirty,draft_generation,server_document,deleted,pending_kind,base_revision)
             VALUES('desktop-a','kn-draft','vault-a','草稿','c.md','草稿正文','r1',1,1,?1,0,'update','r1')",
            params![document("r1", "旧").to_string()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO content_note_operation(desktop_instance_id,vault_id,note_id,op_id,payload,draft_generation) VALUES('desktop-a','vault-a','kn-draft','op-a',?1,1)",
            params![json!({"opId":"op-a","noteId":"kn-draft","vaultId":"vault-a","kind":"update","expectedRevision":"r1","title":"草稿","content":"草稿正文"}).to_string()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO content_note_attachment(desktop_instance_id,vault_id,note_id,op_id,file_name,mime,local_path,size_bytes,sha256) VALUES('desktop-a','vault-a','kn-draft','upload-a','图.png','image/png','p',3,'sha')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO local_note_item(note_id,title,content,created_at,updated_at) VALUES('n1','本机','正文','t','t')",
            [],
        )
        .unwrap();
        drop(conn);

        let mut db = Db::open(&path).unwrap();
        assert_eq!(
            db.health().unwrap()["schemaVersion"].as_i64(),
            Some(SCHEMA_VERSION),
            "v6 必须升级到当前版本"
        );
        // Complete cache stays complete.
        let full = db.content_note("desktop-a", "vault-a", "kn-full").unwrap();
        assert_eq!(full["content"], "完整正文");
        assert_eq!(full["revision"], "r1");
        // The unprovable summary row keeps its (empty) text but must NOT be
        // promoted to a trustworthy body provenance at the summary revision.
        let sum = db
            .content_note("desktop-a", "vault-a", "kn-summary")
            .unwrap();
        assert_ne!(
            sum["revision"], "r2",
            "不得凭空把摘要 revision 认定为真实正文版本"
        );
        // Draft + pending op + pending attachment survive.
        let draft = db
            .content_note("desktop-a", "vault-a", "kn-draft")
            .unwrap();
        assert_eq!(draft["content"], "草稿正文");
        assert_eq!(draft["dirty"], true);
        let ops = db
            .content_prepare_operations("desktop-a", "vault-a")
            .unwrap();
        assert!(ops.iter().any(|o| o["opId"] == "op-a"), "待同步操作保留");
        assert_eq!(
            db.content_pending_attachments("desktop-a", "vault-a")
                .unwrap()
                .len(),
            1,
            "待同步附件保留"
        );
        // Local (non-Desktop) data is untouched.
        let local_notes: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM local_note_item", [], |r| r.get(0))
            .unwrap();
        assert_eq!(local_notes, 1, "本机笔记数据保留");
        // Restart again: still stable.
        drop(db);
        let db = Db::open(&path).unwrap();
        assert_eq!(
            db.content_note("desktop-a", "vault-a", "kn-draft")
                .unwrap()["content"],
            "草稿正文"
        );
        drop(db);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&root);
    }

    #[test]
    fn actual_v5_database_upgrades_and_pending_draft_survives_process_restart() {
        let root = std::env::temp_dir().join(format!("lr-content-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("mobile.db");
        let conn = Connection::open(&path).unwrap();
        for (index, sql) in MIGRATIONS.iter().take(5).enumerate() {
            conn.execute_batch(sql).unwrap();
            conn.pragma_update(None, "user_version", index + 1).unwrap();
        }
        conn.execute("INSERT INTO note_cache VALUES('desktop-a','legacy','旧缓存','旧.md','旧内容','r1','',1,'r1')",[]).unwrap();
        drop(conn);
        let db = Db::open(&path).unwrap();
        assert_eq!(
            db.content_note("desktop-a", "", "legacy").unwrap()["content"],
            "旧内容"
        );
        db.content_vault_remember("desktop-a", "vault-a", "测试库")
            .unwrap();
        db.content_create("desktop-a", "vault-a", "kn-draft", "离线新建", "重启保留")
            .unwrap();
        drop(db);
        let mut db = Db::open(&path).unwrap();
        assert_eq!(
            db.content_note("desktop-a", "vault-a", "kn-draft").unwrap()["content"],
            "重启保留"
        );
        let op = db
            .content_prepare_operations("desktop-a", "vault-a")
            .unwrap();
        drop(db);
        assert_eq!(
            Db::open(&path)
                .unwrap()
                .content_prepare_operations("desktop-a", "vault-a")
                .unwrap(),
            op
        );
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&root);
    }
}

/// R1.6-C: the parent directory of a vault-relative path ("" = ROOT).
fn parent_of_path(path: &str) -> String {
    let normalized = path.replace(MIRROR_SEP, "/");
    match normalized.rfind('/') {
        Some(i) => normalized[..i].to_string(),
        None => String::new(),
    }
}

/// R1.6-C: strip one auto-copy suffix from a title, returning (base, n)
/// where n is the suffix generation already present (0 = none).
fn strip_copy_suffix(title: &str) -> (String, u32) {
    if let Some(base) = title.strip_suffix("（副本）") {
        return (base.to_string(), 1);
    }
    if let Some(open) = title.rfind("（副本 ") {
        if let Some(close) = title[open..].find('）') {
            let digits = &title[open + "（副本 ".len()..open + close];
            if let Ok(n) = digits.parse::<u32>() {
                if n >= 2 {
                    return (title[..open].to_string(), n);
                }
            }
        }
    }
    (title.to_string(), 0)
}

fn note_value(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let server: Option<String> = row.get(9)?;
    let conflict: Option<String> = row.get(10)?;
    let cached: Option<String> = row.get(14)?;
    // R1.6.3-4: the Mobile-local create-collision block truth (SQLite-only
    // no more — the projection carries it for the UI).
    let create_collision_block: bool = row.get(15)?;
    let server_parsed = server.and_then(|s| serde_json::from_str::<Value>(&s).ok());
    let cached_parsed: Option<Value> = cached.and_then(|s| serde_json::from_str::<Value>(&s).ok());
    let revision: String = row.get(6)?;
    // Local-only presentation flag: the phone holds a readable body, but the
    // latest remote observation is a DIFFERENT (newer) revision. This never
    // travels to Desktop — it only lets the UI say "缓存版本 · 联网后更新".
    let body_outdated = cached_parsed.is_some()
        && !revision.is_empty()
        && server_parsed
            .as_ref()
            .and_then(|s| s["revision"].as_str())
            .is_some_and(|latest| latest != revision);
    Ok(
        json!({"instanceId": row.get::<_, String>(0)?, "vaultId": row.get::<_, String>(1)?, "noteId": row.get::<_, String>(2)?,
        "title": row.get::<_, String>(3)?, "relativePath": row.get::<_, Option<String>>(4)?, "content": row.get::<_, String>(5)?,
        "revision": revision, "dirty": row.get::<_, bool>(7)?, "draftGeneration": row.get::<_, i64>(8)?,
        "serverDocument": server_parsed,
        "cachedDocument": cached_parsed,
        "bodyOutdated": body_outdated,
        "conflictDocument": conflict.and_then(|s| serde_json::from_str::<Value>(&s).ok()),
        "deleted": row.get::<_, bool>(11)?, "pendingKind": row.get::<_, String>(12)?, "editorEpoch": row.get::<_, i64>(13)?,
        "createCollisionBlocked": create_collision_block,
        "titleNeedsCorrection": row.get::<_, bool>(7)? && !row.get::<_, bool>(11)? && !fresh_title_valid(&row.get::<_, String>(3)?),
        "operationPaused": row.get::<_, Option<String>>(16)?.is_some(),
        "pausedOperationId": row.get::<_, Option<String>>(16)?}),
    )
}

const NOTE_COLUMNS: &str = "desktop_instance_id,vault_id,note_id,title,relative_path,content,revision,dirty,draft_generation,server_document,conflict_document,deleted,pending_kind,editor_epoch,cached_document,create_collision_block,(SELECT p.op_id FROM content_note_operation_pause p JOIN content_note_operation op ON op.desktop_instance_id=p.desktop_instance_id AND op.vault_id=p.vault_id AND op.note_id=p.note_id AND op.op_id=p.op_id WHERE p.desktop_instance_id=note_cache.desktop_instance_id AND p.vault_id=note_cache.vault_id AND p.note_id=note_cache.note_id)";

/// Admission for NEW intents only. Never normalize a durable draft or an old
/// immutable payload. These are Desktop safe-name/path input predicates, not
/// claims about filesystem success, revision ownership, or remote acceptance.
pub(crate) fn fresh_title_valid(title: &str) -> bool {
    let title = title.trim();
    !title.is_empty() && title != "." && title != ".."
        && !title.contains(['/', '\\', ':', '\0'])
        && !title.eq_ignore_ascii_case(".luckyray") && !title.starts_with('~')
}

// Rust str::trim Unicode White_Space, passed to SQLite trim so admission is
// applied BEFORE the 50-intent bound. Unsuitable fresh drafts cannot starve a
// later valid note. Kept explicit and covered by the input-boundary tests.
const TITLE_WHITESPACE: &str = "\t\n\u{b}\u{c}\r \u{85}\u{a0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}";

/// A0-R2: true when path is a CLEAN vault-relative relative path.
/// Rejects drive-absolute (C:/...), UNC (//server/...), leading slashes and any
/// dot/dotdot segment - fail closed, no stripping into a fake relative path.
pub(crate) fn is_clean_vault_relative(path: &str) -> bool {
    if path.is_empty() {
        return true; // empty = all notes, always valid
    }
    if path.starts_with('/') {
        return false;
    }
    if path.len() >= 2 && path.as_bytes()[1] == b':' {
        return false; // drive-absolute
    }
    for segment in path.split('/') {
        match segment {
            "" => return false, // doubled slash
            "." | ".." => return false, // traversal segments
            _ => {}
        }
    }
    true
}

impl Db {
    pub(crate) fn content_cache_response(
        &self,
        instance: &str,
        key: &str,
        value: &Value,
    ) -> Result<(), String> {
        self.conn.execute("INSERT INTO content_response_cache VALUES(?1,?2,?3,datetime('now')) ON CONFLICT(desktop_instance_id,request_key) DO UPDATE SET payload=excluded.payload,saved_at=excluded.saved_at",params![instance,key,value.to_string()]).map_err(fail)?;
        Ok(())
    }
    pub(crate) fn content_cached_response(
        &self,
        instance: &str,
        key: &str,
    ) -> Result<Value, String> {
        let (payload,at):(String,String)=self.conn.query_row("SELECT payload,saved_at FROM content_response_cache WHERE desktop_instance_id=?1 AND request_key=?2",params![instance,key],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|_|"CONTENT_NOT_CACHED")?;
        let mut value: Value = serde_json::from_str(&payload).map_err(|_| "CONTENT_NOT_CACHED")?;
        value["cached"] = json!(true);
        value["cachedAt"] = json!(at);
        Ok(value)
    }
    pub(crate) fn content_stage_attachment(
        &mut self,
        instance: &str,
        vault: &str,
        id: &str,
        op: &str,
        name: &str,
        mime: &str,
        path: &str,
        size: u64,
        hash: &str,
    ) -> Result<Value, String> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(fail)?;
        tx.execute("INSERT INTO content_note_attachment(desktop_instance_id,vault_id,note_id,op_id,file_name,mime,local_path,size_bytes,sha256) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![instance,vault,id,op,name,mime,path,size,hash]).map_err(fail)?;
        let marker = format!("\n\n![附件待同步](luckyray-attachment:{op})\n");
        let count=tx.execute("UPDATE note_cache SET content=content||?4,dirty=1,draft_generation=draft_generation+1,base_revision=CASE WHEN dirty=0 THEN revision ELSE base_revision END WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3",params![instance,vault,id,marker]).map_err(fail)?;
        if count != 1 {
            return Err("CONTENT_NOTE_UNAVAILABLE".into());
        }
        tx.commit().map_err(fail)?;
        self.content_note(instance, vault, id)
    }

    /// KNOWLEDGE-ORGANIZATION-R1 REPAIR-R1.2 (P1-5): the bounded LOCAL-ONLY
    /// move-safety facts for exactly the SELECTED note ids — dirty/pending/
    /// conflict plus both revision observations. Reads at most 100 ids per
    /// call (the TS side chunks); an absent id is simply not present (the
    /// caller's explicit "no local row = no unsynced write" rule).
    pub(crate) fn content_note_move_facts(
        &self,
        instance: &str,
        vault: &str,
        ids: &[String],
    ) -> Result<Value, String> {
        let bounded: Vec<&str> = ids.iter().map(|s| s.as_str()).take(100).collect();
        let mut items = Vec::with_capacity(bounded.len());
        for id in &bounded {
            // `pending_kind` is a sticky label of the last op kind (a clean
            // synced row still says "update"), so an ACTIVE pending state is
            // proven by a staged content_note_operation row instead.
            let row = self.conn.query_row(
                "SELECT n.note_id, n.dirty, n.conflict_document, n.revision, n.server_document,
                        EXISTS(SELECT 1 FROM content_note_operation op
                               WHERE op.desktop_instance_id=n.desktop_instance_id
                                 AND op.vault_id=n.vault_id AND op.note_id=n.note_id) AS has_op
                 FROM note_cache n WHERE n.desktop_instance_id=?1 AND n.vault_id=?2 AND n.note_id=?3",
                params![instance, vault, id],
                |r| {
                    let conflict: Option<String> = r.get(2)?;
                    let server: Option<String> = r.get(4)?;
                    let server_revision = server
                        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                        .and_then(|v| v["revision"].as_str().map(|s| s.to_string()))
                        .unwrap_or_default();
                    Ok(json!({
                        "noteId": r.get::<_, String>(0)?,
                        "dirty": r.get::<_, bool>(1)?,
                        "pending": r.get::<_, bool>(5)?,
                        "conflict": conflict.is_some(),
                        "revision": r.get::<_, String>(3)?,
                        "serverRevision": server_revision,
                    }))
                },
            );
            match row {
                Ok(v) => items.push(v),
                Err(rusqlite::Error::QueryReturnedNoRows) => {}
                Err(other) => return Err(fail(other)),
            }
        }
        Ok(json!({ "items": items }))
    }

    pub(crate) fn content_pending_attachments(
        &self,
        instance: &str,
        vault: &str,
    ) -> Result<Vec<Value>, String> {
        let mut statement=self.conn.prepare("SELECT a.note_id,a.op_id,a.file_name,a.mime,a.local_path,a.size_bytes,a.sha256,a.manifest,COALESCE(n.cached_document, n.server_document)
            FROM content_note_attachment a JOIN note_cache n ON n.desktop_instance_id=a.desktop_instance_id AND n.vault_id=a.vault_id AND n.note_id=a.note_id
            WHERE a.desktop_instance_id=?1 AND a.vault_id=?2 AND a.receipt IS NULL AND n.deleted=0 AND n.pending_kind!='delete' AND n.conflict_document IS NULL AND n.server_document IS NOT NULL ORDER BY a.op_id LIMIT 16").map_err(fail)?;
        let rows=statement.query_map(params![instance,vault],|r|{
            let manifest:Option<String>=r.get(7)?;let server:String=r.get(8)?;
            Ok(json!({"noteId":r.get::<_,String>(0)?,"opId":r.get::<_,String>(1)?,"name":r.get::<_,String>(2)?,"mime":r.get::<_,String>(3)?,"localPath":r.get::<_,String>(4)?,"sizeBytes":r.get::<_,u64>(5)?,"sha256":r.get::<_,String>(6)?,
                "manifest":manifest.and_then(|s|serde_json::from_str::<Value>(&s).ok()),"serverDocument":serde_json::from_str::<Value>(&server).unwrap_or(Value::Null)}))
        }).map_err(fail)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(fail)
    }

    pub(crate) fn content_upload_manifest(
        &self,
        instance: &str,
        op: &str,
        manifest: &Value,
    ) -> Result<(), String> {
        self.conn.execute("UPDATE content_note_attachment SET manifest=?3 WHERE desktop_instance_id=?1 AND op_id=?2 AND manifest IS NULL",params![instance,op,manifest.to_string()]).map_err(fail)?;
        Ok(())
    }

    pub(crate) fn content_attachment_receipt(
        &mut self,
        instance: &str,
        vault: &str,
        id: &str,
        op: &str,
        receipt: &Value,
    ) -> Result<(), String> {
        let markdown = receipt["publication"]["markdown"]
            .as_str()
            .ok_or("CONTENT_ATTACHMENT_RECEIPT_INVALID")?;
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(fail)?;
        let count=tx.execute("UPDATE content_note_attachment SET receipt=?3,uploaded_bytes=size_bytes WHERE desktop_instance_id=?1 AND op_id=?2 AND receipt IS NULL",params![instance,op,receipt.to_string()]).map_err(fail)?;
        if count == 1 {
            let marker = format!("![附件待同步](luckyray-attachment:{op})");
            tx.execute("UPDATE note_cache SET content=replace(content,?4,?5),dirty=1,draft_generation=draft_generation+1 WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3",params![instance,vault,id,marker,markdown]).map_err(fail)?;
        }
        tx.commit().map_err(fail)
    }

    pub(crate) fn content_vault_remember(
        &self,
        instance: &str,
        vault: &str,
        name: &str,
    ) -> Result<(), String> {
        self.conn.execute("INSERT INTO content_vault_cache(desktop_instance_id,vault_id,name) VALUES(?1,?2,?3)
            ON CONFLICT(desktop_instance_id,vault_id) DO UPDATE SET name=excluded.name", params![instance,vault,name]).map_err(fail)?;
        Ok(())
    }

    pub(crate) fn content_vaults(&self) -> Result<Value, String> {
        let mut statement = self.conn.prepare("SELECT desktop_instance_id,vault_id,name,initialized FROM content_vault_cache ORDER BY name").map_err(fail)?;
        let rows = statement.query_map([], |r| Ok(json!({"instanceId": r.get::<_, String>(0)?, "vaultId": r.get::<_, String>(1)?, "name": r.get::<_, String>(2)?, "initialized": r.get::<_, bool>(3)?}))).map_err(fail)?;
        Ok(json!(rows.collect::<Result<Vec<_>, _>>().map_err(fail)?))
    }

    pub(crate) fn content_note(
        &self,
        instance: &str,
        vault: &str,
        id: &str,
    ) -> Result<Value, String> {
        self.conn.query_row(&format!("SELECT {NOTE_COLUMNS} FROM note_cache WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3"), params![instance,vault,id], note_value).map_err(fail)
    }

    /// R4 (B): a bounded LOCAL-ONLY bulk projection of preview fields
    /// (noteId + content + provenance flags) for exactly the requested ids of
    /// ONE (instance, vault). Pure read of note_cache; rows that are absent
    /// are simply not present in the result. The id list is clamped to 100 so
    /// a hostile/large caller can never turn this into an unbounded query.
    pub(crate) fn content_note_previews(
        &self,
        instance: &str,
        vault: &str,
        ids: &[String],
    ) -> Result<Value, String> {
        let bounded: Vec<&str> = ids.iter().map(|s| s.as_str()).take(100).collect();
        let mut items = Vec::with_capacity(bounded.len());
        for id in &bounded {
            let row = self.conn.query_row(
                "SELECT note_id, content, dirty, draft_generation, revision, server_document, cached_document
                 FROM note_cache WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3",
                params![instance, vault, id],
                |r| {
                    let server: Option<String> = r.get(5)?;
                    let cached: Option<String> = r.get(6)?;
                    let server_parsed = server.and_then(|s| serde_json::from_str::<Value>(&s).ok());
                    let cached_parsed: Option<Value> = cached.and_then(|s| serde_json::from_str::<Value>(&s).ok());
                    let revision: String = r.get(4)?;
                    let body_outdated = cached_parsed.is_some()
                        && !revision.is_empty()
                        && server_parsed
                            .as_ref()
                            .and_then(|s| s["revision"].as_str())
                            .is_some_and(|latest| latest != revision);
                    Ok(json!({
                        "noteId": r.get::<_, String>(0)?,
                        "content": r.get::<_, String>(1)?,
                        "dirty": r.get::<_, bool>(2)?,
                        "draftGeneration": r.get::<_, i64>(3)?,
                        "revision": revision,
                        "bodyOutdated": body_outdated,
                    }))
                },
            );
            match row {
                Ok(v) => items.push(v),
                Err(rusqlite::Error::QueryReturnedNoRows) => {}
                Err(other) => return Err(fail(other)),
            }
        }
        Ok(json!({ "items": items }))
    }


    pub(crate) fn content_notes(
        &self,
        instance: &str,
        vault: &str,
        q: &str,
        page: u32,
        directory: &str,
    ) -> Result<Value, String> {
        // A0-2: vault-relative directory prefix filter. Backslashes are
        // normalized on write; a defensive drive-prefix strip keeps any legacy
        // absolute path from ever becoming a directory label.
        let directory = directory.replace('\\', "/");
        // A0-R2: hostile directory input fails closed — matches nothing.
        if !is_clean_vault_relative(&directory) {
            return Ok(json!({"items": [], "hasMore": false, "page": page, "source": "cache"}));
        }
        // Literal prefix semantics: substr comparison, no LIKE wildcards, so a
        // directory named `A_1%` only ever matches its real subtree.
        let prefix = if directory.is_empty() { String::new() } else { format!("{directory}/") };
        let mut statement = self.conn.prepare(&format!("SELECT {NOTE_COLUMNS} FROM note_cache WHERE desktop_instance_id=?1 AND vault_id=?2 AND (deleted=0 OR dirty=1)
            AND (?3='' OR instr(lower(title),lower(?3))>0 OR instr(lower(content),lower(?3))>0 OR instr(lower(relative_path),lower(?3))>0)
            AND (?4='' OR instr(upper(replace(relative_path,'\\','/')), upper(?4))=1)
            ORDER BY relative_path,note_id LIMIT 51 OFFSET ?5")).map_err(fail)?;
        let rows = statement
            .query_map(
                params![instance, vault, q, prefix, page.saturating_sub(1) as u64 * 50],
                note_value,
            )
            .map_err(fail)?;
        let mut items = rows.collect::<Result<Vec<_>, _>>().map_err(fail)?;
        let more = items.len() > 50;
        items.truncate(50);
        Ok(json!({"items": items, "hasMore": more, "page": page}))
    }

    /// A0-2: deterministic vault-relative directory list derived from cached
    /// note summaries. Never returns absolute Windows paths.
    pub(crate) fn content_note_directories(
        &self,
        instance: &str,
        vault: &str,
    ) -> Result<Value, String> {
        let mut statement = self.conn.prepare(
            "SELECT DISTINCT replace(relative_path,'\\','/') FROM note_cache              WHERE desktop_instance_id=?1 AND vault_id=?2 AND deleted=0 AND pending_kind!='delete'",
        )
        .map_err(fail)?;
        let rows = statement
            .query_map(params![instance, vault], |r| r.get::<_, String>(0))
            .map_err(fail)?;
        let mut dirs: Vec<String> = Vec::new();
        for row in rows {
            let path = row.map_err(fail)?;
            // A0-R2: hostile legacy values fail closed — drive-absolute, UNC
            // and dot-segment paths are SKIPPED, never stripped into a
            // "relative-looking" path and never exposed as directories.
            if !is_clean_vault_relative(&path) {
                continue;
            }
            // Only PARENT paths are directories; the file name itself never
            // is (note.md -> [], A/B/note.md -> ["A","A/B"]).
            let mut parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
            parts.pop(); // drop the file name
            let mut acc = String::new();
            for segment in parts {
                if !acc.is_empty() {
                    acc.push('/');
                }
                acc.push_str(segment);
                if !dirs.contains(&acc) {
                    dirs.push(acc.clone());
                }
            }
        }
        dirs.sort();
        Ok(json!({ "directories": dirs }))
    }

    pub(crate) fn content_begin_edit(
        &self,
        instance: &str,
        vault: &str,
        id: &str,
    ) -> Result<Value, String> {
        let count = self.conn.execute("UPDATE note_cache SET editor_epoch=editor_epoch+1,editor_generation=0 WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3", params![instance,vault,id]).map_err(fail)?;
        if count == 0 {
            return Err("CONTENT_NOTE_NOT_CACHED".into());
        }
        self.content_note(instance, vault, id)
    }

    /// The readonly cache probe. Only an absent exact row may bootstrap;
    /// malformed schema, conversion and other DB errors must remain errors.
    /// Only missing bodies are speculated. Cached empty bodies are complete.
    pub(crate) fn content_prefetch_eligible(note: &Option<Value>) -> bool {
        note.as_ref().is_none_or(|n| n["dirty"] != true && n["deleted"] != true
            && n["pendingKind"].as_str().is_none_or(str::is_empty)
            && n["conflictDocument"].is_null() && n["cachedDocument"]["content"].is_null())
    }

    /// A late speculative response cannot replace a sync observation, editor
    /// epoch, operation or draft that changed during the GET. No cursor writes.
    pub(crate) fn content_prefetch_adopt(&mut self, instance: &str, vault: &str, id: &str,
        expected: &Option<Value>, document: &Value) -> Result<bool, String> {
        if text(document,"noteId") != id || text(document,"vaultId") != vault
            || document["deleted"] == true || !document["content"].is_string()
            || !document["resources"].is_array() || !document["title"].is_string()
            || !document["relativePath"].is_string() || !document["updatedAt"].is_string()
            || text(document,"revision").is_empty() { return Err("CONTENT_DOCUMENT_INVALID".into()); }
        let tx = self.conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(fail)?;
        let current = tx.query_row(
            &format!("SELECT {NOTE_COLUMNS} FROM note_cache WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3"),
            params![instance,vault,id], note_value).optional().map_err(fail)?;
        let adopt = &current == expected && Self::content_prefetch_eligible(&current);
        if adopt { apply_document(&tx,instance,vault,document)?; }
        tx.commit().map_err(fail)?;
        Ok(adopt)
    }

    pub(crate) fn content_note_cached(
        &self,
        instance: &str,
        vault: &str,
        id: &str,
    ) -> Result<Option<Value>, String> {
        self.conn.query_row(
            &format!("SELECT {NOTE_COLUMNS} FROM note_cache WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3"),
            params![instance,vault,id], note_value,
        ).optional().map_err(fail)
    }

    /// Adopt a cold detail response only while the row is STILL absent.
    /// A sync/editor arriving during the GET owns its complete existing row,
    /// including dirty body, prepared op, attachments and epoch. This does not
    /// change any durable sync cursor or snapshot position.
    pub(crate) fn content_cache_bootstrap(
        &mut self,
        instance: &str,
        vault: &str,
        id: &str,
        document: &Value,
    ) -> Result<Value, String> {
        if text(document, "noteId") != id || text(document, "vaultId") != vault
            || document["deleted"] == true
            || document.get("deleted").is_some_and(|value| !value.is_boolean())
            || !document["resources"].is_array()
            || !document["content"].is_string()
            || !document["title"].is_string()
            || !document["relativePath"].is_string()
            || !document["updatedAt"].is_string()
            || text(document, "revision").is_empty()
        {
            return Err("CONTENT_DOCUMENT_INVALID".into());
        }
        let tx = self.conn.transaction_with_behavior(
            rusqlite::TransactionBehavior::Immediate,
        ).map_err(fail)?;
        let existing = tx.query_row(
            &format!("SELECT {NOTE_COLUMNS} FROM note_cache WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3"),
            params![instance, vault, id], note_value,
        ).optional().map_err(fail)?;
        if existing.is_none() {
            apply_document(&tx, instance, vault, document)?;
        }
        let note = tx.query_row(
            &format!("SELECT {NOTE_COLUMNS} FROM note_cache WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3"),
            params![instance, vault, id], note_value,
        ).map_err(fail)?;
        tx.commit().map_err(fail)?;
        Ok(note)
    }

    pub(crate) fn content_edit(
        &self,
        instance: &str,
        vault: &str,
        id: &str,
        title: &str,
        content: &str,
        epoch: i64,
        generation: i64,
    ) -> Result<Value, String> {
        self.content_edit_observed(instance, vault, id, title, content, epoch, generation, None)
    }

    pub(crate) fn content_edit_observed(
        &self, instance: &str, vault: &str, id: &str, title: &str, content: &str,
        epoch: i64, generation: i64, displayed_revision: Option<&str>,
    ) -> Result<Value, String> {
        // A late renderer edit may still contain an upload marker that was
        // resolved while typing. Reapply durable receipts before saving it.
        let mut content = content.to_owned();
        let mut statement=self.conn.prepare("SELECT op_id,receipt FROM content_note_attachment WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3 AND receipt IS NOT NULL").map_err(fail)?;
        let receipts = statement
            .query_map(params![instance, vault, id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(fail)?;
        for receipt in receipts {
            let (op, body) = receipt.map_err(fail)?;
            if let Ok(value) = serde_json::from_str::<Value>(&body) {
                if let Some(markdown) = value["publication"]["markdown"].as_str() {
                    content = content.replace(
                        &format!("![附件待同步](luckyray-attachment:{op})"),
                        markdown,
                    );
                }
            }
        }
        let tx = rusqlite::Transaction::new_unchecked(&self.conn, rusqlite::TransactionBehavior::Immediate).map_err(fail)?;
        // The body cannot be replaced while typing, so a renderer reread can
        // trail its own ACK. Only a proven ACK of this editor's exact saved
        // generation may advance the next mutation's base without that reread.
        // Foreign refreshes/tombstones and a retired editor's proof never qualify.
        let acknowledged = if displayed_revision.is_some() {
            editor_body_ack_revision(&tx, instance, vault, id, epoch)?
        } else { None };
        let displayed_revision = acknowledged.as_deref().or(displayed_revision);
        let count = tx.execute("UPDATE note_cache SET title=?4,content=?5,base_revision=CASE WHEN dirty=0 THEN COALESCE(?8,revision) ELSE base_revision END,
            conflict_document=CASE WHEN dirty=0 AND ?8 IS NOT NULL AND revision!=?8 AND pending_kind!='create' THEN server_document ELSE conflict_document END,
            dirty=1,draft_generation=draft_generation+1,editor_generation=?7,create_collision_block=0,
            pending_kind=CASE WHEN pending_kind='create' THEN 'create' ELSE 'update' END
            WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3 AND editor_epoch=?6 AND editor_generation<?7",
            params![instance,vault,id,title,content,epoch,generation,displayed_revision]).map_err(fail)?;
        if count != 1 {
            return Err("CONTENT_EDITOR_CHANGED".into());
        }
        let note = tx.query_row(&format!("SELECT {NOTE_COLUMNS} FROM note_cache WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3"), params![instance,vault,id], note_value).map_err(fail)?;
        tx.commit().map_err(fail)?;
        Ok(note)
    }

    pub(crate) fn content_create(
        &self,
        instance: &str,
        vault: &str,
        id: &str,
        title: &str,
        content: &str,
    ) -> Result<(), String> {
        self.content_create_in(instance, vault, id, title, content, "")
    }

    /// KNOWLEDGE-ORGANIZATION-R1 R1.5-B: stage a Desktop create inside an
    /// EXISTING parent directory. The provisional filename is the unique
    /// note id (never user-visible as authoritative); the Desktop
    /// acknowledgement replaces the whole path with the committed one, and
    /// `content_prepare_operations` derives the create mutation's
    /// parentRelativePath from this row's parent either way.
    pub(crate) fn content_create_in(
        &self,
        instance: &str,
        vault: &str,
        id: &str,
        title: &str,
        content: &str,
        parent_relative_path: &str,
    ) -> Result<(), String> {
        let parent = parent_relative_path.replace(MIRROR_SEP, "/");
        if !parent.trim().is_empty() && !is_clean_vault_relative(&parent) {
            return Err("CONTENT_PATH_INVALID".into());
        }
        let relative_path = if parent.trim().is_empty() {
            format!("{id}.md")
        } else {
            format!("{parent}/{id}.md")
        };
        self.conn.execute("INSERT INTO note_cache(desktop_instance_id,note_id,vault_id,title,relative_path,content,revision,dirty,draft_generation,pending_kind,base_revision)
            VALUES(?1,?2,?3,?4,?5,?6,'',1,1,'create','')", params![instance,id,vault,title,relative_path,content]).map_err(fail)?;
        Ok(())
    }

    pub(crate) fn content_delete(
        &self,
        instance: &str,
        vault: &str,
        id: &str,
    ) -> Result<(), String> {
        // All callers share this gate. Historical audit alone never blocks a
        // new valid ACTIVE operation. Check and write are one IMMEDIATE tx.
        let tx = rusqlite::Transaction::new_unchecked(&self.conn, rusqlite::TransactionBehavior::Immediate).map_err(fail)?;
        if tx.query_row("SELECT EXISTS(SELECT 1 FROM content_note_operation op JOIN content_note_operation_pause p ON p.desktop_instance_id=op.desktop_instance_id AND p.vault_id=op.vault_id AND p.note_id=op.note_id AND p.op_id=op.op_id WHERE op.desktop_instance_id=?1 AND op.vault_id=?2 AND op.note_id=?3)",params![instance,vault,id],|r|r.get::<_,bool>(0)).map_err(fail)? {
            return Err("CONTENT_OPERATION_PAUSED".into());
        }
        let active: Option<(String, String, String)> = tx.query_row("SELECT op_id,payload,route FROM content_note_operation WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3",params![instance,vault,id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(fail)?;
        if let Some((op_id, bytes, route)) = active {
            let payload: Value = serde_json::from_str(&bytes).map_err(|_| "CONTENT_OPERATION_INVALID")?;
            // Only the exact scoped, stored Content blank rename is protected
            // before its refusal arrives. No pause/resume/new-op is invented.
            if route == "content" && payload["kind"] == "rename"
                && payload["opId"].as_str() == Some(op_id.as_str())
                && payload["noteId"].as_str() == Some(id)
                && payload["vaultId"].as_str() == Some(vault)
                && payload["title"].as_str().is_some_and(|title| title.trim().is_empty()) {
                return Err("CONTENT_OPERATION_PENDING".into());
            }
        }
        let local = tx.execute("UPDATE note_cache SET deleted=1,dirty=0,pending_kind='delete' WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3 AND server_document IS NULL AND NOT EXISTS(SELECT 1 FROM content_note_operation WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3)",params![instance,vault,id]).map_err(fail)?;
        if local == 1 {
            return tx.commit().map_err(fail);
        }
        // Keep recoverable text until the deletion acknowledgement. A later edit
        // has a new generation and cannot be cleared by that acknowledgement.
        tx.execute("UPDATE note_cache SET pending_kind='delete',base_revision=CASE WHEN dirty=0 THEN revision ELSE base_revision END,
            dirty=1,draft_generation=draft_generation+1 WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3", params![instance,vault,id]).map_err(fail)?;
        tx.commit().map_err(fail)
    }

    /// R1.6-C: handle a CREATE 409 REVISION_CONFLICT (a filename collision),
    /// which is NEVER a same-note two-version conflict. Two cases:
    ///
    ///  * STALE INTENT — the sent create payload no longer matches the
    ///    CURRENT pending draft (the user edited after the op was prepared):
    ///    retire ONLY that operation row; the pending note (title/content/
    ///    parent/attachments) survives untouched, and the next prepare
    ///    regenerates a fresh create op with a NEW opId from the newest
    ///    draft. Bounded: the regenerated op matches the draft, so a further
    ///    409 falls through to the collision case below (suffix-bounded).
    ///
    ///  * GENUINE COLLISION — the payload still matches the current draft:
    ///    auto-copy the title `X（副本）`, `X（副本 2）`, ... (bounded 20
    ///    suffix attempts), preserving noteId/parent/content/attachments;
    ///    the local title truth updates; the old op row is retired so the
    ///    next prepare emits a NEW opId. Exhausting the bound leaves the
    ///    truthful pending state (never a fabricated remote version).
    ///
    /// NEVER touches conflict_document and NEVER stages a tombstone.
    pub(crate) fn content_create_collision_retry(
        &mut self,
        instance: &str,
        vault: &str,
        note_id: &str,
        failed_payload: &Value,
    ) -> Result<Value, String> {
        let row: Option<(String, String, String)> = self
            .conn
            .query_row(
                "SELECT title, content, relative_path FROM note_cache
                 WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3
                   AND pending_kind='create' AND deleted=0",
                params![instance, vault, note_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, Option<String>>(2)?.unwrap_or_default())),
            )
            .optional()
            .map_err(fail)?;
        let Some((title, content, relative_path)) = row else {
            // The pending create is gone (user deleted it): retire the op.
            let _ = self.conn.execute(
                "DELETE FROM content_note_operation WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3",
                params![instance, vault, note_id],
            );
            return Ok(json!({"retried": false, "renamed": null}));
        };
        let payload_parent = failed_payload["parentRelativePath"].as_str().unwrap_or("");
        let current_parent = parent_of_path(&relative_path);
        // R1.6.2-3: collision identity is the SENT TITLE + PARENT — NEVER the
        // wire content (a pending-attachment create deliberately sends
        // content="" while note_cache holds the real body, so comparing wire
        // content would misjudge every genuine collision as stale), and never
        // the op row's draft_generation (prepare stores a -1 sentinel while
        // attachments are pending). A content-only edit after prepare keeps
        // the same filename intent: the genuine path retires the op and the
        // next prepare re-publishes from the NEWEST row, so latest content
        // still wins.
        let stale_intent = failed_payload["title"].as_str().unwrap_or("") != title
            || payload_parent != current_parent;
        if stale_intent {
            // Step 1: retire ONLY the stale operation intent; everything
            // else survives; the next prepare regenerates with a NEW opId.
            self.conn.execute(
                "DELETE FROM content_note_operation WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3",
                params![instance, vault, note_id],
            ).map_err(fail)?;
            return Ok(json!({"retried": true, "renamed": null}));
        }
        // Step 2: the latest title genuinely collides — bounded auto-copy
        // (the next suffix generation after any already-present one). At the
        // bound, the note is marked create_collision_block=1 durably (the
        // dedicated Mobile-local state — base_revision stays pure write
        // provenance): prepare_operations SKIPS blocked creates (no
        // busy-loop of re-sending 副本 20 forever), the note stays editable,
        // and any real user edit of title/content clears the block so the
        // next prepare re-publishes with a NEW opId.
        let (base, seen) = strip_copy_suffix(&title);
        if seen >= 20 {
            self.conn.execute(
                "UPDATE note_cache SET create_collision_block=1 WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3",
                params![instance, vault, note_id],
            ).map_err(fail)?;
            // The staged op is retired too: the block filter stops the
            // busy-loop, and once a real user edit clears the block the next
            // prepare regenerates from the NEWEST draft with a NEW opId
            // (never the stale staged payload).
            self.conn.execute(
                "DELETE FROM content_note_operation WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3",
                params![instance, vault, note_id],
            ).map_err(fail)?;
            return Ok(json!({"retried": false, "renamed": null, "exhausted": true}));
        }
        let mut renamed: Option<String> = None;
        if seen < 20 {
            let i = seen + 1;
            let candidate = if i == 1 {
                format!("{base}（副本）")
            } else {
                format!("{base}（副本 {i}）")
            };
            // Local truth update (title only — noteId/parent/content/
            // attachments unchanged) + retire the old op so the next
            // prepare emits a NEW opId with the renamed payload.
            self.conn.execute(
                "UPDATE note_cache SET title=?4 WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3",
                params![instance, vault, note_id, candidate],
            ).map_err(fail)?;
            self.conn.execute(
                "DELETE FROM content_note_operation WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3",
                params![instance, vault, note_id],
            ).map_err(fail)?;
            renamed = Some(candidate);
        }
        Ok(json!({"retried": renamed.is_some(), "renamed": renamed}))
    }

    /// R1.5.1: true while the note is a locally staged pending create with
    /// no committed server observation — the pre-publication window in which
    /// a remote detail GET would 404 and be mistaken for a tombstone.
    pub(crate) fn content_note_pending_unpublished(
        &self,
        instance: &str,
        vault: &str,
        id: &str,
    ) -> Result<bool, String> {
        let pending: Option<(String,)> = self
            .conn
            .query_row(
                "SELECT pending_kind FROM note_cache WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3 AND server_document IS NULL",
                params![instance, vault, id],
                |r| Ok((r.get(0)?,)),
            )
            .optional()
            .map_err(fail)?;
        Ok(pending.is_some_and(|(kind,)| kind == "create"))
    }

    /// KNOWLEDGE-ORGANIZATION-R1 R1.5-A: apply Desktop note SUMMARY documents
    /// into the Mobile note_cache projection WITHOUT touching the durable
    /// sync position (no snapshot_after/seq/cursor/initialized change) and
    /// without staging or pushing anything. Metadata-only provenance via the
    /// existing `apply_document` rules: paths/titles/server observations
    /// advance; cached bodies and their revisions are never relabeled; a
    /// summary never sets a conflict.
    pub(crate) fn content_apply_metadata_batch(
        &mut self,
        instance: &str,
        vault: &str,
        documents: &[Value],
    ) -> Result<usize, String> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(fail)?;
        for document in documents {
            apply_document(&tx, instance, vault, document)?;
        }
        tx.commit().map_err(fail)?;
        Ok(documents.len())
    }

    pub(crate) fn content_sync_position(
        &self,
        instance: &str,
        vault: &str,
    ) -> Result<Value, String> {
        self.conn.query_row("SELECT initialized,snapshot_after,snapshot_seq,cursor FROM content_vault_cache WHERE desktop_instance_id=?1 AND vault_id=?2", params![instance,vault], |r|
            Ok(json!({"initialized": r.get::<_,bool>(0)?, "afterId": r.get::<_,Option<String>>(1)?, "snapshotSeq": r.get::<_,Option<i64>>(2)?, "cursor": r.get::<_,i64>(3)?}))).map_err(fail)
    }

    pub(crate) fn content_apply_batch(
        &mut self,
        instance: &str,
        vault: &str,
        documents: &[Value],
        cursor: i64,
        snapshot: Option<(&str, bool)>,
    ) -> Result<(), String> {
        self.content_apply_batch_deferred(instance, vault, documents, cursor, snapshot, &[])
    }

    pub(crate) fn content_apply_batch_deferred(
        &mut self, instance: &str, vault: &str, documents: &[Value], cursor: i64,
        snapshot: Option<(&str, bool)>, deferred: &[Value],
    ) -> Result<(), String> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(fail)?;
        for document in documents {
            apply_document(&tx, instance, vault, document)?;
            offline::remember(&tx, instance, vault, document)?;
            // Preserve both versions without rewriting an unacknowledged
            // schema11 operation when an authoritative deletion arrives.
            if document["deleted"] == true && !text(document, "revision").is_empty() {
                tx.execute("UPDATE note_cache SET conflict_document=?4 WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3 AND dirty=1 AND pending_kind!='delete'",params![instance,vault,text(document,"noteId"),document.to_string()]).map_err(fail)?;
            }
        }
        for document in deferred {
            // The cursor cannot outrun a failed body read: persist its exact
            // revision and retry obligation in this same transaction.
            if !offline::selected(&tx, instance, vault)? { return Err("CONTENT_OFFLINE_NOT_SELECTED".into()); }
            offline::remember(&tx, instance, vault, document)?;
            tx.execute("UPDATE content_offline_note SET priority=1,state=CASE WHEN state='ready' THEN 'pending' ELSE state END WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3",params![instance,vault,text(document,"noteId")]).map_err(fail)?;
        }
        if let Some((after, done)) = snapshot {
            tx.execute("UPDATE content_vault_cache SET snapshot_after=?3,snapshot_seq=?4,initialized=?5,cursor=CASE WHEN ?5 THEN ?4 ELSE cursor END
                WHERE desktop_instance_id=?1 AND vault_id=?2", params![instance,vault,after,cursor,done]).map_err(fail)?;
        } else {
            tx.execute("UPDATE content_vault_cache SET cursor=?3 WHERE desktop_instance_id=?1 AND vault_id=?2", params![instance,vault,cursor]).map_err(fail)?;
        }
        tx.commit().map_err(fail)
    }

    pub(crate) fn content_resnapshot(&mut self, instance: &str, vault: &str) -> Result<(), String> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(fail)?;
        // Cursor expiry only invalidates discovery. Keep every saved body,
        // draft and frozen intent; absence from a new snapshot is not deletion.
        if offline::selected(&tx, instance, vault)? {
            tx.execute("UPDATE content_offline_vault SET generation=generation+1 WHERE desktop_instance_id=?1 AND vault_id=?2", params![instance,vault]).map_err(fail)?;
            tx.execute("UPDATE content_offline_note SET state='unverified',attempts=0,next_retry=0,error='' WHERE desktop_instance_id=?1 AND vault_id=?2", params![instance,vault]).map_err(fail)?;
        }
        tx.execute("UPDATE content_vault_cache SET initialized=0,snapshot_after=NULL,snapshot_seq=NULL,cursor=0 WHERE desktop_instance_id=?1 AND vault_id=?2", params![instance,vault]).map_err(fail)?;
        tx.commit().map_err(fail)
    }

    pub(crate) fn content_prepare_operations(
        &mut self,
        instance: &str,
        vault: &str,
    ) -> Result<Vec<Value>, String> {
        Ok(self.content_prepare_routed_operations(instance, vault, false)?
            .into_iter().map(|operation| operation.payload).collect())
    }

    pub(crate) fn content_prepare_routed_operations(
        &mut self,
        instance: &str,
        vault: &str,
        unique_create_implemented: bool,
    ) -> Result<Vec<PreparedNoteOperation>, String> {
        self.content_prepare_available_operations(instance, vault, Some(unique_create_implemented))
    }

    /// None defers ONLY first preparation of creates; stored ops and Content
    /// noncreates stay live even when the additive Services catalog is offline.
    pub(crate) fn content_prepare_available_operations(
        &mut self,
        instance: &str,
        vault: &str,
        unique_create_implemented: Option<bool>,
    ) -> Result<Vec<PreparedNoteOperation>, String> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(fail)?;
        let rows = {
            let mut statement = tx.prepare(&format!("SELECT {NOTE_COLUMNS} FROM note_cache WHERE desktop_instance_id=?1 AND vault_id=?2 AND dirty=1 AND conflict_document IS NULL
                AND create_collision_block=0
                AND (pending_kind='delete' OR EXISTS(SELECT 1 FROM content_note_operation op WHERE op.desktop_instance_id=?1 AND op.vault_id=?2 AND op.note_id=note_cache.note_id) OR (trim(title,?4) NOT IN ('','.','..') AND lower(trim(title,?4))!='.luckyray' AND substr(trim(title,?4),1,1)!='~' AND instr(title,'/')=0 AND instr(title,char(92))=0 AND instr(title,':')=0 AND instr(title,char(0))=0))
                AND NOT EXISTS(SELECT 1 FROM content_note_operation_pause p JOIN content_note_operation op ON op.desktop_instance_id=p.desktop_instance_id AND op.vault_id=p.vault_id AND op.note_id=p.note_id AND op.op_id=p.op_id WHERE p.desktop_instance_id=?1 AND p.vault_id=?2 AND p.note_id=note_cache.note_id)
                AND (?3 OR pending_kind!='create' OR EXISTS(SELECT 1 FROM content_note_operation op WHERE op.desktop_instance_id=?1 AND op.vault_id=?2 AND op.note_id=note_cache.note_id))
                AND (NOT (pending_kind='create' AND draft_generation=1 AND title='新笔记' AND content='' AND NOT EXISTS(SELECT 1 FROM content_note_attachment a WHERE a.desktop_instance_id=?1 AND a.vault_id=?2 AND a.note_id=note_cache.note_id)) OR EXISTS(SELECT 1 FROM content_note_operation op WHERE op.desktop_instance_id=?1 AND op.vault_id=?2 AND op.note_id=note_cache.note_id))
                AND (pending_kind IN ('create','delete') OR EXISTS(SELECT 1 FROM content_note_operation op WHERE op.desktop_instance_id=?1 AND op.vault_id=?2 AND op.note_id=note_cache.note_id) OR NOT EXISTS(SELECT 1 FROM content_note_attachment a WHERE a.desktop_instance_id=?1 AND a.vault_id=?2 AND a.note_id=note_cache.note_id AND a.receipt IS NULL))
                ORDER BY note_id LIMIT 50")).map_err(fail)?;
            let rows = statement
                .query_map(params![instance, vault, unique_create_implemented.is_some(), TITLE_WHITESPACE], note_value)
                .map_err(fail)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(fail)?
        };
        let mut operations = Vec::new();
        for note in rows {
            let id = text(&note, "noteId");
            let old: Option<(String, String)> = tx.query_row("SELECT payload,route FROM content_note_operation WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3", params![instance,vault,id], |r|Ok((r.get(0)?, r.get(1)?))).optional().map_err(fail)?;
            if let Some((payload, route)) = old {
                operations.push(PreparedNoteOperation {
                    payload: serde_json::from_str(&payload).map_err(|_| "CONTENT_OPERATION_INVALID")?,
                    route: NoteOperationRoute::parse(&route)?,
                });
                continue;
            }
            let pending = text(&note, "pendingKind");
            // Typing may durably pass through an invalid title. Preserve it,
            // but do not freeze an unsendable intent. Existing ops above still
            // replay byte-identically; their recovery requires explicit action.
            if pending != "delete" && !fresh_title_valid(text(&note, "title")) {
                continue;
            }
            let server = &note["serverDocument"];
            let kind = if matches!(pending, "create" | "delete") {
                pending
            } else if note["content"] != server["content"] {
                "update"
            } else {
                "rename"
            };
            let base: Option<String> = tx.query_row("SELECT base_revision FROM note_cache WHERE desktop_instance_id=?1 AND note_id=?2", params![instance,id], |r|r.get(0)).map_err(fail)?;
            let op_id = uuid::Uuid::new_v4().to_string();
            let pending_attachments=kind=="create" && tx.query_row("SELECT COUNT(*) FROM content_note_attachment WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3 AND receipt IS NULL",params![instance,vault,id],|r|r.get::<_,u64>(0)).map_err(fail)?>0;
            let payload = json!({"opId":op_id,"noteId":id,"vaultId":vault,"kind":kind,"expectedRevision":base,
                "title":note["title"],"content":if pending_attachments{json!("")}else{note["content"].clone()},
                "parentRelativePath":if kind=="create" {std::path::Path::new(text(&note,"relativePath")).parent().map(|p|p.to_string_lossy().replace('\\',"/"))} else {None}});
            let route = if kind == "create" && unique_create_implemented == Some(true) {
                NoteOperationRoute::KnowledgeCreateUnique
            } else {
                NoteOperationRoute::Content
            };
            tx.execute(
                "INSERT INTO content_note_operation(desktop_instance_id,vault_id,note_id,op_id,payload,draft_generation,route) VALUES(?1,?2,?3,?4,?5,?6,?7)",
                params![
                    instance,
                    vault,
                    id,
                    op_id,
                    payload.to_string(),
                    if pending_attachments {
                        -1
                    } else {
                        note["draftGeneration"].as_i64().unwrap_or(0)
                    },
                    route.stored()
                ],
            )
            .map_err(fail)?;
            operations.push(PreparedNoteOperation { payload, route });
        }
        tx.commit().map_err(fail)?;
        Ok(operations)
    }

    /// Nonterminal, exact submitted-operation pause. An observed refusal does
    /// NOT prove there is no server intent or cancel any server transaction.
    pub(crate) fn content_pause_blank_rename(
        &mut self, instance: &str, vault: &str, prepared: &PreparedNoteOperation,
        status: u16, result: &Value,
    ) -> Result<bool, String> {
        let payload = &prepared.payload;
        if status != 400 || result["code"] != "NOTE_INPUT_INVALID"
            || prepared.route != NoteOperationRoute::Content || payload["kind"] != "rename"
            || text(payload, "vaultId") != vault
            || !payload["title"].as_str().is_some_and(|title| title.trim().is_empty()) {
            return Ok(false);
        }
        let id = text(payload, "noteId");
        let op_id = text(payload, "opId");
        let tx = self.conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(fail)?;
        let stored: Option<(String, String)> = tx.query_row("SELECT payload,route FROM content_note_operation WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3 AND op_id=?4", params![instance,vault,id,op_id], |r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(fail)?;
        let Some((bytes, route)) = stored else { return Err("CONTENT_OPERATION_CHANGED".into()); };
        if route != "content" || serde_json::from_str::<Value>(&bytes).map_err(|_| "CONTENT_OPERATION_INVALID")? != *payload {
            return Err("CONTENT_OPERATION_CHANGED".into());
        }
        // SELECT copies the ORIGINAL bytes/route/generation, never a serialized
        // replacement. Current editor title/body/epoch/generation are untouched.
        tx.execute("INSERT OR IGNORE INTO content_note_operation_pause(desktop_instance_id,vault_id,note_id,op_id,payload,route,draft_generation,reason,paused_at) SELECT desktop_instance_id,vault_id,note_id,op_id,payload,route,draft_generation,'BLANK_RENAME_400',?5 FROM content_note_operation WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3 AND op_id=?4", params![instance,vault,id,op_id,now_iso()]).map_err(fail)?;
        tx.commit().map_err(fail)?;
        Ok(true)
    }

    pub(crate) fn content_sync_attention(&self, instance: &str, vault: &str) -> Result<bool, String> {
        // Read only title/flags, not every pending body/attachment payload.
        let mut query = self.conn.prepare("SELECT title,deleted,EXISTS(SELECT 1 FROM content_note_operation op JOIN content_note_operation_pause p ON p.desktop_instance_id=op.desktop_instance_id AND p.vault_id=op.vault_id AND p.note_id=op.note_id AND p.op_id=op.op_id WHERE op.desktop_instance_id=?1 AND op.vault_id=?2 AND op.note_id=note_cache.note_id) FROM note_cache WHERE desktop_instance_id=?1 AND vault_id=?2 AND dirty=1").map_err(fail)?;
        let rows = query.query_map(params![instance,vault], |r| Ok((r.get::<_,String>(0)?,r.get::<_,bool>(1)?,r.get::<_,bool>(2)?))).map_err(fail)?;
        for row in rows {
            let (title, deleted, paused) = row.map_err(fail)?;
            if paused || !deleted && !fresh_title_valid(&title) { return Ok(true); }
        }
        Ok(false)
    }

    /// Called ONLY by the explicit local recovery command, serialized behind
    /// the sync gate. The old unknown server intent is NOT cancelled. Its audit
    /// stays immutable; the user's current draft gets a new id and OLD base CAS.
    pub(crate) fn content_resume_paused(&mut self, instance: &str, vault: &str, id: &str,
        paused_op_id: &str, epoch: i64, generation: i64) -> Result<Value, String> {
        let tx = self.conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(fail)?;
        let current = tx.query_row(&format!("SELECT {NOTE_COLUMNS} FROM note_cache WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3 AND editor_epoch=?4 AND draft_generation=?5 AND dirty=1 AND deleted=0 AND conflict_document IS NULL AND pending_kind='update'"),params![instance,vault,id,epoch,generation],note_value).optional().map_err(fail)?.ok_or("CONTENT_EDITOR_CHANGED")?;
        if !fresh_title_valid(text(&current,"title")) { return Err("CONTENT_TITLE_REQUIRED".into()); }
        if tx.query_row("SELECT EXISTS(SELECT 1 FROM content_note_attachment WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3 AND receipt IS NULL)",params![instance,vault,id],|r|r.get::<_,bool>(0)).map_err(fail)? {
            return Err("CONTENT_ATTACHMENTS_PENDING".into());
        }
        if current["pausedOperationId"].as_str() != Some(paused_op_id) { return Err("CONTENT_OPERATION_CHANGED".into()); }
        let (bytes, route, audit): (String,String,String) = tx.query_row("SELECT op.payload,op.route,p.payload FROM content_note_operation op JOIN content_note_operation_pause p ON p.desktop_instance_id=op.desktop_instance_id AND p.vault_id=op.vault_id AND p.note_id=op.note_id AND p.op_id=op.op_id WHERE op.desktop_instance_id=?1 AND op.vault_id=?2 AND op.note_id=?3 AND op.op_id=?4 AND p.reason='BLANK_RENAME_400'",params![instance,vault,id,paused_op_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(fail)?.ok_or("CONTENT_OPERATION_CHANGED")?;
        let old: Value = serde_json::from_str(&bytes).map_err(|_| "CONTENT_OPERATION_INVALID")?;
        let base: Option<String> = tx.query_row("SELECT base_revision FROM note_cache WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3",params![instance,vault,id],|r|r.get(0)).map_err(fail)?;
        if bytes != audit || route != "content" || old["kind"] != "rename" || old["expectedRevision"] != json!(base)
            || old["noteId"] != id || old["vaultId"] != vault { return Err("CONTENT_OPERATION_CHANGED".into()); }
        let new_op_id = uuid::Uuid::new_v4().to_string();
        let kind = if current["content"] == current["serverDocument"]["content"] { "rename" } else { "update" };
        let payload = json!({"opId":new_op_id,"noteId":id,"vaultId":vault,"kind":kind,"expectedRevision":base,"title":current["title"],"content":current["content"],"parentRelativePath":null});
        // Exact active-slot CAS, followed by fresh capture in the SAME tx. No
        // edits, attachment ownership/receipts, base, or epoch are overwritten.
        if tx.execute("DELETE FROM content_note_operation WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3 AND op_id=?4 AND payload=?5 AND route=?6",params![instance,vault,id,paused_op_id,bytes,route]).map_err(fail)? != 1 { return Err("CONTENT_OPERATION_CHANGED".into()); }
        tx.execute("INSERT INTO content_note_operation(desktop_instance_id,vault_id,note_id,op_id,payload,draft_generation,route) VALUES(?1,?2,?3,?4,?5,?6,'content')",params![instance,vault,id,new_op_id,payload.to_string(),generation]).map_err(fail)?;
        tx.execute("INSERT INTO content_note_operation_recovery(desktop_instance_id,vault_id,note_id,paused_op_id,new_op_id,recovered_at) VALUES(?1,?2,?3,?4,?5,?6)",params![instance,vault,id,paused_op_id,new_op_id,now_iso()]).map_err(fail)?;
        tx.commit().map_err(fail)?;
        self.content_note(instance,vault,id)
    }

    pub(crate) fn content_ack(
        &mut self,
        instance: &str,
        vault: &str,
        id: &str,
        op_id: &str,
        document: &Value,
    ) -> Result<(), String> {
        if text(document, "vaultId") != vault || text(document, "noteId") != id {
            return Err("CONTENT_ACK_INVALID".into());
        }
        if self.conn.query_row("SELECT EXISTS(SELECT 1 FROM content_note_operation_pause WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3 AND op_id=?4)", params![instance,vault,id,op_id], |r| r.get::<_, bool>(0)).map_err(fail)? {
            return Err("CONTENT_ACK_PAUSED".into());
        }
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(fail)?;
        let operation: Option<(i64,String,String)> = tx.query_row("SELECT draft_generation,payload,route FROM content_note_operation WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3 AND op_id=?4", params![instance,vault,id,op_id], |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(fail)?;
        let Some((sent_generation, payload, route)) = operation else {
            return Err("CONTENT_ACK_STALE".into());
        };
        let payload: Value =
            serde_json::from_str(&payload).map_err(|_| "CONTENT_OPERATION_INVALID")?;
        let current = tx.query_row(&format!("SELECT {NOTE_COLUMNS} FROM note_cache WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3"),params![instance,vault,id],note_value).map_err(fail)?;
        let same_generation = current["draftGeneration"].as_i64() == Some(sent_generation);
        let deleted = document["deleted"] == true;
        let pending_title = payload["kind"] == "update" && current["title"] != document["title"];
        let dirty = !same_generation || pending_title;
        // Unique creation owns the final collision-free name. A later BODY
        // edit or pending attachment is not a later TITLE edit: adopt the
        // selected name while retaining that newer durable body. A genuinely
        // changed local title remains the user's next rename intent.
        let adopt_unique_title = route == "knowledgeCreateUnique"
            && payload["kind"] == "create" && current["title"] == payload["title"];
        let conflict = dirty
            && (deleted
                || (payload["kind"] == "rename"
                    && current["serverDocument"]["content"] != document["content"]));
        // Same provenance rule as apply_document: an acknowledgement that
        // carries no `content` may record the remote observation, but must not
        // fabricate a body baseline. `revision`/`base_revision` continue to
        // describe the body the phone actually holds.
        let carries_body = !deleted && document.get("content").is_some();
        tx.execute("UPDATE note_cache SET server_document=?4,
            revision=CASE WHEN ?14 THEN ?5 ELSE revision END,
            base_revision=CASE WHEN ?14 THEN ?5 ELSE base_revision END,
            relative_path=?6,
            content=CASE WHEN ?14 AND NOT ?7 THEN ?8 ELSE content END,
            cached_document=CASE WHEN ?14 THEN ?4 ELSE cached_document END,
            title=CASE WHEN ?9 THEN title ELSE ?10 END,
            dirty=?11,deleted=?12,pending_kind=CASE WHEN ?7 AND pending_kind='delete' THEN 'delete' ELSE 'update' END,
            conflict_document=?13 WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3",
            params![instance,vault,id,document.to_string(),text(document,"revision"),text(document,"relativePath"),!same_generation,
                text(document,"content"),dirty && !adopt_unique_title,text(document,"title"),dirty,deleted && !dirty,if conflict{Some(document.to_string())}else{None},carries_body]).map_err(fail)?;
        let ack_key = editor_body_ack_key(instance, vault, id);
        if same_generation && carries_body && !conflict && document["content"].is_string()
            && document["content"] == payload["content"] && current["content"] == payload["content"]
            && !text(document, "revision").is_empty() {
            let proof = EditorBodyAck {
                epoch: current["editorEpoch"].as_i64().ok_or("CONTENT_EDITOR_INVALID")?,
                draft_generation: sent_generation,
                revision: text(document, "revision").to_owned(),
            };
            let bytes = serde_json::to_string(&proof).map_err(|_| "CONTENT_ACK_INVALID")?;
            tx.execute("INSERT OR REPLACE INTO app_meta VALUES (?1,?2)", params![ack_key, bytes]).map_err(fail)?;
        } else {
            tx.execute("DELETE FROM app_meta WHERE key=?1", params![ack_key]).map_err(fail)?;
        }
        tx.execute("DELETE FROM content_note_operation WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3 AND op_id=?4",params![instance,vault,id,op_id]).map_err(fail)?;
        offline::remember(&tx, instance, vault, document)?;
        tx.commit().map_err(fail)
    }

    pub(crate) fn content_conflict(
        &self,
        instance: &str,
        vault: &str,
        id: &str,
        document: &Value,
    ) -> Result<(), String> {
        self.conn.execute("UPDATE note_cache SET conflict_document=?4,server_document=?4 WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3",params![instance,vault,id,document.to_string()]).map_err(fail)?;
        Ok(())
    }

    pub(crate) fn content_resolve(
        &mut self,
        instance: &str,
        vault: &str,
        id: &str,
        copy: bool,
    ) -> Result<Option<String>, String> {
        let note = self.content_note(instance, vault, id)?;
        let server = &note["conflictDocument"];
        if server.is_null() {
            return Err("CONTENT_CONFLICT_ALREADY_RESOLVED".into());
        }
        if server.get("content").is_none() && server["deleted"] != true {
            return Err("CONTENT_CONFLICT_NEEDS_DOWNLOAD".into());
        }
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(fail)?;
        let copy_id = if copy {
            let new_id = format!("kn-{}", uuid::Uuid::new_v4().simple());
            let title = format!(
                "{}（手机副本 {}）",
                text(&note, "title"),
                &new_id[new_id.len() - 6..]
            );
            tx.execute("INSERT INTO note_cache(desktop_instance_id,note_id,vault_id,title,content,revision,dirty,draft_generation,pending_kind,base_revision,relative_path)
                VALUES(?1,?2,?3,?4,?5,'',1,1,'create','',?6)", params![instance,new_id,vault,title,text(&note,"content"),text(&note,"relativePath")]).map_err(fail)?;
            let pending = {
                let mut statement=tx.prepare("SELECT op_id FROM content_note_attachment WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3 AND receipt IS NULL").map_err(fail)?;
                let rows = statement
                    .query_map(params![instance, vault, id], |r| r.get::<_, String>(0))
                    .map_err(fail)?;
                rows.collect::<Result<Vec<_>, _>>().map_err(fail)?
            };
            for old_op in pending {
                let new_op = uuid::Uuid::new_v4().to_string();
                tx.execute("UPDATE content_note_attachment SET note_id=?4,op_id=?5,manifest=NULL,uploaded_bytes=0 WHERE desktop_instance_id=?1 AND vault_id=?2 AND op_id=?3",params![instance,vault,old_op,new_id,new_op]).map_err(fail)?;
                tx.execute("UPDATE note_cache SET content=replace(content,?4,?5) WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3",params![instance,vault,new_id,format!("luckyray-attachment:{old_op}"),format!("luckyray-attachment:{new_op}")]).map_err(fail)?;
            }
            Some(new_id)
        } else {
            None
        };
        tx.execute("UPDATE content_note_attachment SET receipt='{}' WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3 AND receipt IS NULL",params![instance,vault,id]).map_err(fail)?;
        tx.execute("DELETE FROM content_note_operation WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3",params![instance,vault,id]).map_err(fail)?;
        tx.execute("UPDATE note_cache SET dirty=0,conflict_document=NULL,pending_kind='update' WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3",params![instance,vault,id]).map_err(fail)?;
        apply_document(&tx, instance, vault, server)?;
        tx.commit().map_err(fail)?;
        Ok(copy_id)
    }
}
