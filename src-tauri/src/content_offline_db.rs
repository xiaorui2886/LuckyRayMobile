//! Body preparation uses the existing document/intent authority and cursor tx.
use super::*;

#[derive(Clone)]
pub(crate) struct BodyJob {
    pub id: String,
    pub revision: String,
    pub generation: i64,
    pub observed: String,
}

pub(super) fn selected(db: &Connection, instance: &str, vault: &str) -> Result<bool, String> {
    // Schema11 rows predate this UI and may include a manual pause. They are
    // preserved, but NOT a new user's scope selection. Only an explicit S1
    // confirmation writes this key; each paired instance has one selected vault.
    db.query_row("SELECT EXISTS(SELECT 1 FROM content_offline_vault WHERE desktop_instance_id=?1 AND vault_id=?2 AND EXISTS(SELECT 1 FROM app_meta WHERE key=?3 AND value=?2))", params![instance,vault,format!("knowledge.replica.s1:{instance}")], |r| r.get(0)).map_err(fail)
}

/// Called INSIDE the transaction which applies metadata and advances its cursor.
pub(super) fn remember(
    db: &Connection,
    instance: &str,
    vault: &str,
    doc: &Value,
) -> Result<(), String> {
    if !selected(db, instance, vault)? {
        return Ok(());
    }
    let id = text(doc, "noteId");
    if id.is_empty() || text(doc, "vaultId") != vault {
        return Err("CONTENT_DOCUMENT_INVALID".into());
    }
    if doc["deleted"] == true {
        db.execute("DELETE FROM content_offline_note WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3", params![instance,vault,id]).map_err(fail)?;
        return Ok(());
    }
    let revision = text(doc, "revision");
    if revision.is_empty() {
        return Err("CONTENT_DOCUMENT_INVALID".into());
    }
    let cached: Option<String> = db.query_row("SELECT cached_document FROM note_cache WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3", params![instance,vault,id], |r| r.get(0)).optional().map_err(fail)?.flatten();
    let ready = cached
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .is_some_and(|v| {
            v["content"].is_string() && text(&v, "revision") == revision && !revision.is_empty()
        });
    db.execute("INSERT INTO content_offline_note(desktop_instance_id,vault_id,note_id,target_revision,state) VALUES(?1,?2,?3,?4,?5)
      ON CONFLICT(desktop_instance_id,vault_id,note_id) DO UPDATE SET target_revision=excluded.target_revision,
      state=CASE WHEN excluded.state='ready' THEN 'ready' WHEN target_revision!=excluded.target_revision OR state='unverified' THEN 'pending' ELSE state END,
      error=CASE WHEN target_revision!=excluded.target_revision OR excluded.state='ready' THEN '' ELSE error END,
      attempts=CASE WHEN target_revision!=excluded.target_revision THEN 0 ELSE attempts END,
      priority=CASE WHEN excluded.state='ready' THEN 0 ELSE priority END,
      next_retry=CASE WHEN target_revision!=excluded.target_revision THEN 0 ELSE next_retry END",
      params![instance,vault,id,revision,if ready {"ready"} else {"pending"}]).map_err(fail)?;
    Ok(())
}

impl Db {
    pub(crate) fn offline_revoke(&self, instance: &str) -> Result<(), String> {
        self.conn.execute("UPDATE content_offline_vault SET write_state='revoked',generation=generation+1 WHERE desktop_instance_id=?1", [instance]).map_err(fail)?;
        Ok(())
    }
    pub(crate) fn offline_select(
        &mut self,
        instance: &str,
        vault: &str,
        write: bool,
    ) -> Result<(), String> {
        self.content_sync_position(instance, vault)?;
        let tx = self.conn.transaction().map_err(fail)?;
        tx.execute("INSERT INTO content_offline_vault(desktop_instance_id,vault_id,write_state) VALUES(?1,?2,?3)
          ON CONFLICT(desktop_instance_id,vault_id) DO UPDATE SET generation=generation+1,waiting_current=0,write_state=excluded.write_state",
          params![instance,vault,if write {"granted"} else {"readonly"}]).map_err(fail)?;
        tx.execute("INSERT OR REPLACE INTO app_meta(key,value) VALUES(?1,?2)", params![format!("knowledge.replica.s1:{instance}"),vault]).map_err(fail)?;
        let docs = {
            let mut s=tx.prepare("SELECT server_document FROM note_cache WHERE desktop_instance_id=?1 AND vault_id=?2 AND server_document IS NOT NULL").map_err(fail)?;
            let rows = s
                .query_map(params![instance, vault], |r| r.get::<_, String>(0))
                .map_err(fail)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(fail)?
        };
        for doc in docs {
            remember(
                &tx,
                instance,
                vault,
                &serde_json::from_str::<Value>(&doc).map_err(|_| "CONTENT_DOCUMENT_INVALID")?,
            )?;
        }
        tx.commit().map_err(fail)
    }
    pub(crate) fn offline_pause(
        &mut self,
        instance: &str,
        vault: &str,
        paused: bool,
    ) -> Result<(), String> {
        let tx = self.conn.transaction().map_err(fail)?;
        if tx.execute("UPDATE content_offline_vault SET paused=?3,generation=generation+1 WHERE desktop_instance_id=?1 AND vault_id=?2",params![instance,vault,paused]).map_err(fail)? != 1 { return Err("CONTENT_OFFLINE_NOT_SELECTED".into()); }
        if !paused {
            tx.execute("UPDATE content_offline_note SET state='pending',attempts=0,next_retry=0,error='' WHERE desktop_instance_id=?1 AND vault_id=?2 AND state='failed'",params![instance,vault]).map_err(fail)?;
        }
        tx.commit().map_err(fail)
    }
    pub(crate) fn offline_current(
        &self,
        instance: &str,
        vault: &str,
        write: bool,
    ) -> Result<(), String> {
        self.conn.execute("UPDATE content_offline_vault SET waiting_current=(vault_id!=?2),write_state=CASE WHEN vault_id=?2 THEN ?3 ELSE write_state END WHERE desktop_instance_id=?1",params![instance,vault,if write {"granted"} else {"readonly"}]).map_err(fail)?;
        Ok(())
    }
    pub(crate) fn offline_libraries(&self, instance: &str) -> Result<Value, String> {
        let mut s=self.conn.prepare("SELECT o.vault_id,v.name,o.paused,o.waiting_current,o.write_state,v.initialized,
          (SELECT COUNT(*) FROM content_offline_note n WHERE n.desktop_instance_id=o.desktop_instance_id AND n.vault_id=o.vault_id),
          (SELECT COUNT(*) FROM content_offline_note n WHERE n.desktop_instance_id=o.desktop_instance_id AND n.vault_id=o.vault_id AND state='ready'),
          (SELECT COUNT(*) FROM content_offline_note n WHERE n.desktop_instance_id=o.desktop_instance_id AND n.vault_id=o.vault_id AND state='failed'),
          (SELECT COUNT(*) FROM content_offline_note n WHERE n.desktop_instance_id=o.desktop_instance_id AND n.vault_id=o.vault_id AND state='unverified')
          FROM content_offline_vault o JOIN content_vault_cache v USING(desktop_instance_id,vault_id) WHERE o.desktop_instance_id=?1 ORDER BY v.name,o.vault_id").map_err(fail)?;
        let rows=s.query_map([instance],|r|Ok(json!({"instanceId":instance,"vaultId":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"paused":r.get::<_,bool>(2)?,"waitingCurrent":r.get::<_,bool>(3)?,"writeState":r.get::<_,String>(4)?,"metadataReady":r.get::<_,bool>(5)?,"total":r.get::<_,u64>(6)?,"ready":r.get::<_,u64>(7)?,"failed":r.get::<_,u64>(8)?,"unverified":r.get::<_,u64>(9)?}))).map_err(fail)?;
        let mut rows = rows.collect::<Result<Vec<_>, _>>().map_err(fail)?;
        for row in &mut rows {
            row["confirmed"] = json!(selected(&self.conn, instance, text(row, "vaultId"))?);
        }
        Ok(json!(rows))
    }
    pub(crate) fn offline_selected(&self, instance: &str, vault: &str) -> Result<bool, String> {
        selected(&self.conn, instance, vault)
    }
    pub(crate) fn offline_create(&self, instance: &str, vault: &str) -> Result<String, String> {
        self.offline_create_in(instance, vault, "新笔记", "")
    }
    pub(crate) fn offline_create_in(&self, instance: &str, vault: &str, title: &str, parent: &str) -> Result<String, String> {
        if !self.offline_selected(instance, vault)? { return Err("CONTENT_OFFLINE_NOT_SELECTED".into()); }
        let write: Option<String>=self.conn.query_row("SELECT write_state FROM content_offline_vault WHERE desktop_instance_id=?1 AND vault_id=?2",params![instance,vault],|r|r.get(0)).optional().map_err(fail)?;
        if write.as_deref() != Some("granted") {
            return Err("CONTENT_OFFLINE_WRITE_UNAVAILABLE".into());
        }
        let id = format!("kn-{}", uuid::Uuid::new_v4().simple());
        // Existing directory admission and immutable create intent are reused.
        self.content_create_in(instance, vault, &id, title, "", parent)?;
        Ok(id)
    }
    pub(crate) fn offline_job(
        &self,
        instance: &str,
        vault: &str,
    ) -> Result<Option<BodyJob>, String> {
        let now = self
            .conn
            .query_row("SELECT unixepoch()", [], |r| r.get(0))
            .map_err(fail)?;
        self.offline_job_at(instance, vault, now)
    }
    pub(crate) fn offline_job_at(
        &self,
        instance: &str,
        vault: &str,
        now: i64,
    ) -> Result<Option<BodyJob>, String> {
        if !self.offline_selected(instance, vault)? { return Ok(None); }
        self.conn.query_row("SELECT n.note_id,n.target_revision,o.generation,COALESCE(c.server_document,'')
          FROM content_offline_note n JOIN content_offline_vault o USING(desktop_instance_id,vault_id)
          LEFT JOIN note_cache c ON c.desktop_instance_id=n.desktop_instance_id AND c.vault_id=n.vault_id AND c.note_id=n.note_id
          WHERE n.desktop_instance_id=?1 AND n.vault_id=?2 AND (o.paused=0 OR n.priority=1) AND o.waiting_current=0
          AND (n.state='pending' OR (n.state='failed' AND (n.priority=1 OR n.attempts<3) AND n.next_retry<=?3))
          ORDER BY n.priority DESC,COALESCE(c.dirty,0) DESC,n.attempts,n.note_id LIMIT 1",params![instance,vault,now],|r|Ok(BodyJob{id:r.get(0)?,revision:r.get(1)?,generation:r.get(2)?,observed:r.get(3)?})).optional().map_err(fail)
    }
    pub(crate) fn offline_finish(
        &mut self,
        instance: &str,
        vault: &str,
        job: &BodyJob,
        result: Result<Value, String>,
    ) -> Result<bool, String> {
        if !self.offline_selected(instance, vault)? { return Ok(false); }
        let now = self
            .conn
            .query_row("SELECT unixepoch()", [], |r| r.get(0))
            .map_err(fail)?;
        self.offline_finish_at(instance, vault, job, result, now)
    }
    pub(crate) fn offline_finish_at(
        &mut self,
        instance: &str,
        vault: &str,
        job: &BodyJob,
        result: Result<Value, String>,
        now: i64,
    ) -> Result<bool, String> {
        if !self.offline_selected(instance, vault)? { return Ok(false); }
        let tx = self.conn.transaction().map_err(fail)?;
        let live: bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM content_offline_note n JOIN content_offline_vault o USING(desktop_instance_id,vault_id) WHERE n.desktop_instance_id=?1 AND n.vault_id=?2 AND n.note_id=?3 AND n.target_revision=?4 AND o.generation=?5 AND (o.paused=0 OR n.priority=1) AND o.waiting_current=0)",params![instance,vault,job.id,job.revision,job.generation],|r|r.get(0)).map_err(fail)?;
        if !live {
            return Ok(false);
        }
        let observed: Option<String>=tx.query_row("SELECT server_document FROM note_cache WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3",params![instance,vault,job.id],|r|r.get(0)).optional().map_err(fail)?.flatten();
        if observed.unwrap_or_default() != job.observed {
            return Ok(false);
        } // newer sync/ACK owns the row
        let validated = result.and_then(|doc| {
            if text(&doc, "noteId") != job.id
                || text(&doc, "vaultId") != vault
                || !doc["content"].is_string()
                || text(&doc, "revision").is_empty()
                || text(&doc, "revision") != job.revision
                || !doc["resources"].is_array()
                || doc["deleted"] == true
            {
                Err("CONTENT_BODY_UNAVAILABLE".into())
            } else {
                Ok(doc)
            }
        });
        match validated {
            Ok(doc) => {
                apply_document(&tx, instance, vault, &doc)?;
                remember(&tx, instance, vault, &doc)?;
            }
            Err(error) => {
                let safe = match error.as_str() {
                    "CONTENT_BODY_UNAVAILABLE" => "BODY_UNAVAILABLE",
                    "CONTENT_OFFLINE" => "OFFLINE",
                    "CONTENT_HTTP_404" => "NOT_FOUND_UNCONFIRMED",
                    "CONTENT_HTTP_403" | "CONTENT_HTTP_401" => "PERMISSION_REQUIRED",
                    _ => "READ_FAILED",
                };
                // Live changes are durable synchronization obligations, not
                // optional bulk downloads: retain automatic bounded recovery
                // after three failures. The existing app sync/fallback checks
                // due time; one job per pass and 5s..300s backoff prevent spin.
                tx.execute("UPDATE content_offline_note SET state='failed',error=?4,attempts=min(attempts+1,1000000),next_retry=?5+CASE WHEN priority=1 THEN min(300,5*(1 << min(attempts,6))) ELSE 30 END WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3",params![instance,vault,job.id,safe,now]).map_err(fail)?;
                if safe == "PERMISSION_REQUIRED" {
                    tx.execute("UPDATE content_offline_vault SET write_state='revoked' WHERE desktop_instance_id=?1 AND vault_id=?2",params![instance,vault]).map_err(fail)?;
                }
            }
        }
        tx.commit().map_err(fail)?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replica_s1_old_selection_needs_confirmation_and_does_not_unpause() {
        let mut db = fixture();
        db.conn.execute("INSERT INTO content_offline_vault VALUES('A','v',1,7,0,'granted')", []).unwrap();
        db.conn.execute("INSERT INTO content_offline_note VALUES('A','v','n','r1','pending','',0,0,0)", []).unwrap();
        assert!(!db.offline_selected("A", "v").unwrap());
        assert!(db.offline_job("A", "v").unwrap().is_none());
        assert_eq!(db.offline_libraries("A").unwrap()[0]["confirmed"], false);
        db.offline_select("A", "v", true).unwrap();
        assert_eq!(db.offline_libraries("A").unwrap()[0]["paused"], true);
        assert!(db.offline_job("A", "v").unwrap().is_none());
        db.offline_pause("A", "v", false).unwrap();
        let old = db.offline_job("A", "v").unwrap().unwrap();
        db.content_vault_remember("A", "other", "Other").unwrap();
        db.offline_select("A", "other", true).unwrap();
        assert!(!db.offline_finish("A", "v", &old, Ok(doc("n", "r1", Some("late")))).unwrap());
        assert!(!db.offline_selected("A", "v").unwrap());
        assert!(db.offline_create("A", "v").is_err());
        assert_eq!(db.conn.query_row("SELECT COUNT(*) FROM content_offline_note WHERE vault_id='v'", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    }
    #[test]
    fn replica_s1_deferred_editor_save_preserves_displayed_baseline_and_both_versions() {
        let mut db = fixture(); db.offline_select("A", "v", true).unwrap();
        db.content_apply_batch("A", "v", &[doc("n", "r1", Some("displayed"))], 1, None).unwrap();
        let epoch = db.content_begin_edit("A", "v", "n").unwrap()["editorEpoch"].as_i64().unwrap();
        db.content_apply_batch("A", "v", &[doc("n", "r2", Some("desktop changed while IME focused"))], 2, None).unwrap();
        let value = db.content_edit_observed("A", "v", "n", "n", "displayed + 中文输入", epoch, 1, Some("r1")).unwrap();
        assert_eq!(value["content"], "displayed + 中文输入");
        assert_eq!(value["conflictDocument"]["content"], "desktop changed while IME focused");
        assert_eq!(db.conn.query_row("SELECT base_revision FROM note_cache WHERE note_id='n'", [], |r| r.get::<_, String>(0)).unwrap(), "r1");
        assert!(db.content_prepare_operations("A", "v").unwrap().is_empty());
        let copy = db.content_resolve("A", "v", "n", true).unwrap().unwrap();
        assert_eq!(db.content_note("A", "v", "n").unwrap()["content"], "desktop changed while IME focused");
        assert_eq!(db.content_note("A", "v", &copy).unwrap()["content"], "displayed + 中文输入");
    }

    #[test]
    fn replica_s1_cold_unopened_body_search_and_waiting_vault_keep_exact_outbox() {
        let path = std::env::temp_dir().join(format!("lr-replica-s1-{}.db", uuid::Uuid::new_v4()));
        let mut db = Db::open(&path).unwrap();
        db.content_vault_remember("A", "v", "Library").unwrap();
        db.offline_select("A", "v", true).unwrap();
        db.content_apply_batch("A", "v", &[doc("unopened", "r1", None)], 1, Some(("", true))).unwrap();
        let job = db.offline_job("A", "v").unwrap().unwrap();
        db.offline_finish("A", "v", &job, Ok(doc("unopened", "r1", Some("从未点开也能搜索：唯一长尾词")))).unwrap();
        let id = db.offline_create("A", "v").unwrap();
        let epoch = db.content_begin_edit("A", "v", &id).unwrap()["editorEpoch"].as_i64().unwrap();
        db.content_edit("A", "v", &id, "本地新建", "离线草稿", epoch, 1).unwrap();
        let ops = db.content_prepare_operations("A", "v").unwrap();
        db.offline_current("A", "other", true).unwrap();
        drop(db);
        let mut db = Db::open(&path).unwrap();
        assert_eq!(db.content_notes("A", "v", "唯一长尾词", 1, "").unwrap()["items"][0]["noteId"], "unopened");
        assert_eq!(db.content_note("A", "v", &id).unwrap()["content"], "离线草稿");
        assert_eq!(db.offline_libraries("A").unwrap()[0]["waitingCurrent"], true);
        assert_eq!(db.content_prepare_operations("A", "v").unwrap(), ops);
        assert!(db.content_prepare_operations("A", "other").unwrap().is_empty());
        db.offline_current("A", "v", true).unwrap();
        let mut ack = doc(&id, "r2", Some("离线草稿")); ack["title"] = json!("本地新建");
        db.content_ack("A", "v", &id, ops[0]["opId"].as_str().unwrap(), &ack).unwrap();
        assert!(db.content_prepare_operations("A", "v").unwrap().is_empty());
        assert_eq!(db.offline_libraries("A").unwrap()[0]["ready"], 2);
        drop(db);
        std::fs::remove_file(path).unwrap();
    }
    fn fixture() -> Db {
        let mut db = Db {
            conn: Connection::open_in_memory().unwrap(),
        };
        db.migrate_kind().unwrap();
        db.content_vault_remember("A", "v", "Library").unwrap();
        db
    }
    fn doc(id: &str, revision: &str, body: Option<&str>) -> Value {
        let mut d = json!({"noteId":id,"vaultId":"v","title":id,"relativePath":format!("{id}.md"),"revision":revision,"resources":[]});
        if let Some(body) = body {
            d["content"] = json!(body);
        }
        d
    }
    #[test]
    fn offline_a1_metadata_is_not_complete_body_and_cancel_retires_late_read() {
        let mut db = fixture();
        db.offline_select("A", "v", true).unwrap();
        db.content_apply_batch("A", "v", &[doc("n", "r1", None)], 7, Some(("n", true)))
            .unwrap();
        assert_eq!(db.offline_libraries("A").unwrap()[0]["ready"], 0);
        assert_eq!(db.offline_libraries("A").unwrap()[0]["metadataReady"], true);
        let job = db.offline_job("A", "v").unwrap().unwrap();
        db.offline_pause("A", "v", true).unwrap();
        assert!(!db
            .offline_finish("A", "v", &job, Ok(doc("n", "r1", Some("late"))))
            .unwrap());
        assert_eq!(db.content_note("A", "v", "n").unwrap()["content"], "");
        db.offline_pause("A", "v", false).unwrap();
        let job = db.offline_job("A", "v").unwrap().unwrap();
        db.offline_finish("A", "v", &job, Ok(doc("n", "r1", Some(""))))
            .unwrap();
        assert_eq!(
            db.offline_libraries("A").unwrap()[0]["ready"],
            1,
            "empty full body is valid"
        );
    }
    #[test]
    fn offline_a1_bad_body_does_not_starve_other_tasks_or_fake_completion() {
        let mut db = fixture();
        db.offline_select("A", "v", true).unwrap();
        db.content_apply_batch(
            "A",
            "v",
            &[doc("a", "r1", None), doc("b", "r1", None)],
            2,
            None,
        )
        .unwrap();
        let a = db.offline_job("A", "v").unwrap().unwrap();
        db.offline_finish("A", "v", &a, Err("CONTENT_HTTP_404".into()))
            .unwrap();
        assert_eq!(db.content_note("A", "v", "a").unwrap()["deleted"], false);
        let b = db.offline_job("A", "v").unwrap().unwrap();
        assert_eq!(b.id, "b");
        db.offline_finish("A", "v", &b, Ok(doc("b", "r1", Some("可全文搜索"))))
            .unwrap();
        assert_eq!(db.offline_libraries("A").unwrap()[0]["failed"], 1);
        assert_eq!(db.offline_libraries("A").unwrap()[0]["ready"], 1);
        assert_eq!(
            db.content_notes("A", "v", "全文", 1, "").unwrap()["items"][0]["noteId"],
            "b"
        );
    }
    #[test]
    fn offline_a1_inflight_read_keeps_dirty_text_frozen_intent_and_newer_ack() {
        let mut db = fixture();
        db.offline_select("A", "v", true).unwrap();
        db.content_apply_batch("A", "v", &[doc("n", "r1", Some("base"))], 1, None)
            .unwrap();
        db.content_apply_batch("A", "v", &[doc("n", "r2", None)], 2, None)
            .unwrap();
        let job = db.offline_job("A", "v").unwrap().unwrap();
        let epoch = db.content_begin_edit("A", "v", "n").unwrap()["editorEpoch"]
            .as_i64()
            .unwrap();
        db.content_edit("A", "v", "n", "n", "phone draft", epoch, 1)
            .unwrap();
        let before = db.content_prepare_operations("A", "v").unwrap();
        db.offline_finish("A", "v", &job, Ok(doc("n", "r2", Some("remote"))))
            .unwrap();
        assert_eq!(
            db.content_note("A", "v", "n").unwrap()["content"],
            "phone draft"
        );
        assert_eq!(db.content_prepare_operations("A", "v").unwrap(), before);
        db.content_edit("A", "v", "n", "n", "later draft", epoch, 2)
            .unwrap();
        db.content_ack(
            "A",
            "v",
            "n",
            before[0]["opId"].as_str().unwrap(),
            &doc("n", "r3", Some("phone draft")),
        )
        .unwrap();
        assert!(!db
            .offline_finish("A", "v", &job, Ok(doc("n", "r2", Some("late remote"))))
            .unwrap());
        assert_eq!(
            db.content_note("A", "v", "n").unwrap()["content"],
            "later draft"
        );
        assert_eq!(db.content_note("A", "v", "n").unwrap()["revision"], "r3");
    }
    #[test]
    fn offline_a1_deferred_change_and_cursor_commit_together_and_tombstone_protects_dirty() {
        let mut db = fixture();
        db.offline_select("A", "v", true).unwrap();
        db.content_apply_batch_deferred("A", "v", &[], 9, None, &[doc("n", "r9", None)])
            .unwrap();
        assert_eq!(db.content_sync_position("A", "v").unwrap()["cursor"], 9);
        assert_eq!(db.offline_job("A", "v").unwrap().unwrap().id, "n");
        assert!(db
            .content_apply_batch_deferred(
                "A",
                "v",
                &[],
                10,
                None,
                &[json!({"noteId":"wrong","vaultId":"other"})]
            )
            .is_err());
        assert_eq!(db.content_sync_position("A", "v").unwrap()["cursor"], 9);
        db.content_apply_batch("A", "v", &[doc("n", "r9", Some("base"))], 9, None)
            .unwrap();
        let epoch = db.content_begin_edit("A", "v", "n").unwrap()["editorEpoch"]
            .as_i64()
            .unwrap();
        db.content_edit("A", "v", "n", "n", "phone", epoch, 1)
            .unwrap();
        let frozen = db.content_prepare_operations("A", "v").unwrap();
        db.content_apply_batch(
            "A",
            "v",
            &[json!({"noteId":"n","vaultId":"v","revision":"deleted","deleted":true})],
            10,
            None,
        )
        .unwrap();
        let note = db.content_note("A", "v", "n").unwrap();
        assert_eq!(note["content"], "phone");
        assert_eq!(note["conflictDocument"]["deleted"], true);
        let stored: String = db
            .conn
            .query_row(
                "SELECT payload FROM content_note_operation WHERE note_id='n'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&stored).unwrap(), frozen[0]);
    }
    #[test]
    fn offline_a1_mismatched_body_revision_never_downgrades_saved_baseline() {
        let mut db = fixture();
        db.offline_select("A", "v", true).unwrap();
        db.content_apply_batch("A", "v", &[doc("n", "r1", Some("saved"))], 1, None)
            .unwrap();
        db.content_apply_batch("A", "v", &[doc("n", "r2", None)], 2, None)
            .unwrap();
        let job = db.offline_job("A", "v").unwrap().unwrap();
        db.offline_finish("A", "v", &job, Ok(doc("n", "r0", Some("stale"))))
            .unwrap();
        assert_eq!(db.content_note("A", "v", "n").unwrap()["content"], "saved");
        assert_eq!(db.offline_libraries("A").unwrap()[0]["failed"], 1);
        // Re-snapshot invalidates old jobs but preserves searchable bodies;
        // missing from a completed snapshot is still not a tombstone.
        db.content_resnapshot("A", "v").unwrap();
        db.content_apply_batch("A", "v", &[], 3, Some(("", true)))
            .unwrap();
        assert_eq!(db.offline_libraries("A").unwrap()[0]["unverified"], 1);
        assert!(db.offline_job("A", "v").unwrap().is_none());
        assert_eq!(
            db.content_notes("A", "v", "saved", 1, "").unwrap()["items"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(!db
            .offline_finish("A", "v", &job, Ok(doc("n", "r2", Some("late"))))
            .unwrap());
    }

    #[test]
    fn offline_a1_r1_live_backoff_is_bounded_while_bulk_keeps_manual_retry_limit() {
        let mut db = fixture();
        db.offline_select("A", "v", true).unwrap();
        db.content_apply_batch("A", "v", &[doc("bulk", "b1", None)], 1, None)
            .unwrap();
        for attempt in 0..3 {
            let now = 1000 + attempt * 30;
            let job = db.offline_job_at("A", "v", now).unwrap().unwrap();
            db.offline_finish_at("A", "v", &job, Err("CONTENT_OFFLINE".into()), now)
                .unwrap();
        }
        assert!(
            db.offline_job_at("A", "v", 5000).unwrap().is_none(),
            "bulk still needs explicit retry after three failures"
        );
        db.content_apply_batch_deferred("A", "v", &[], 2, None, &[doc("live", "r2", None)])
            .unwrap();
        for (attempt, delay) in [5, 10, 20, 40, 80, 160, 300, 300].into_iter().enumerate() {
            let now = 2000 + attempt as i64 * 301;
            let job = db.offline_job_at("A", "v", now).unwrap().unwrap();
            assert_eq!(job.id, "live");
            db.offline_finish_at("A", "v", &job, Err("CONTENT_OFFLINE".into()), now)
                .unwrap();
            assert!(db
                .offline_job_at("A", "v", now + delay - 1)
                .unwrap()
                .is_none());
            assert_eq!(
                db.offline_job_at("A", "v", now + delay)
                    .unwrap()
                    .unwrap()
                    .id,
                "live"
            );
        }
    }

    #[test]
    fn offline_a1_restart_retains_selection_progress_and_exact_create_operation() {
        let path = std::env::temp_dir().join(format!("lr-offline-a1-{}.db", uuid::Uuid::new_v4()));
        let mut db = Db::open(&path).unwrap();
        db.content_vault_remember("A", "v", "Library").unwrap();
        db.offline_select("A", "v", true).unwrap();
        let id = db.offline_create("A", "v").unwrap();
        let epoch = db.content_begin_edit("A", "v", &id).unwrap()["editorEpoch"]
            .as_i64()
            .unwrap();
        db.content_edit("A", "v", &id, "Offline new", "saved body", epoch, 1)
            .unwrap();
        let ops = db.content_prepare_operations("A", "v").unwrap();
        drop(db);
        let mut db = Db::open(&path).unwrap();
        assert_eq!(db.offline_libraries("A").unwrap()[0]["vaultId"], "v");
        assert_eq!(
            db.content_note("A", "v", &id).unwrap()["content"],
            "saved body"
        );
        assert_eq!(db.content_prepare_operations("A", "v").unwrap(), ops);
        let mut ack = doc(&id, "r1", Some("saved body"));
        ack["title"] = json!("Offline new");
        db.content_ack("A", "v", &id, ops[0]["opId"].as_str().unwrap(), &ack)
            .unwrap();
        assert!(db.content_prepare_operations("A", "v").unwrap().is_empty());
        assert!(db
            .content_ack("A", "v", &id, ops[0]["opId"].as_str().unwrap(), &ack)
            .is_err());
        assert!(db.offline_create("A", "unknown").is_err());
        db.offline_current("A", "v", false).unwrap();
        assert!(db.offline_create("A", "v").is_err());
        drop(db);
        let _ = std::fs::remove_file(path);
    }
}
