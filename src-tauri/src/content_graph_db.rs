//! Pure local graph projection. In particular, do not call content_notes,
//! offline_selected, Store::new, or managed_vault_sync::recover from here:
//! those otherwise read-like entry points may recover durable file journals.
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

const LIBRARIES_SQL: &str = "SELECT o.vault_id,v.name,o.paused,o.waiting_current,o.write_state,v.initialized,
    EXISTS(SELECT 1 FROM app_meta WHERE key=?2 AND value=o.vault_id)
    FROM content_offline_vault o JOIN content_vault_cache v USING(desktop_instance_id,vault_id)
    WHERE o.desktop_instance_id=?1 ORDER BY v.name,o.vault_id";
const NOTES_SQL: &str = "SELECT note_id,title,relative_path,content,revision,dirty,cached_document,server_document,conflict_document,updated_at
    FROM note_cache WHERE desktop_instance_id=?1 AND vault_id=?2 AND deleted=0
    ORDER BY relative_path,note_id LIMIT 200 OFFSET ?3";
const TOTAL_SQL: &str = "SELECT COUNT(*) FROM note_cache WHERE desktop_instance_id=?1 AND vault_id=?2 AND deleted=0";

fn fail(error: rusqlite::Error) -> String {
    // Only structural diagnostics: never SQL, parameters, paths or note data.
    let kind = match error {
        rusqlite::Error::InvalidColumnType(index, _, ty) => format!("column_type:{index}:{ty:?}"),
        rusqlite::Error::SqliteFailure(code, _) => format!("sqlite:{}", code.extended_code),
        _ => "projection".into(),
    };
    eprintln!("[LR_GRAPH_CACHE] code=CONTENT_GRAPH_CACHE_UNAVAILABLE kind={kind}");
    "CONTENT_GRAPH_CACHE_UNAVAILABLE".into()
}
fn document(value: Option<String>) -> Option<Value> {
    value.and_then(|text| serde_json::from_str(&text).ok())
}

/// All queries share a read transaction; pagination stamps fence both writes
/// through this connection and commits by other SQLite connections. No data,
/// cursor, selection, draft, library registration or permission is changed.
pub(crate) fn read(db: &Connection, instance: &str, vault: Option<&str>, page: u32) -> Result<Value, String> {
    if instance.is_empty() || instance.len() > 4096 || vault.is_some_and(|v| v.is_empty() || v.len() > 4096)
        || page == 0 || page > 1_000_000 { return Err("CONTENT_GRAPH_SCOPE_INVALID".into()); }
    let tx = db.unchecked_transaction().map_err(fail)?;
    let paired: Option<String> = tx.query_row("SELECT desktop_instance_id FROM paired_desktop ORDER BY paired_at DESC LIMIT 1", [], |row| row.get(0)).optional().map_err(fail)?;
    if paired.as_deref() != Some(instance) { return Err("CONTENT_SOURCE_CHANGED".into()); }
    let data_version: i64 = tx.query_row("PRAGMA data_version", [], |row| row.get(0)).map_err(fail)?;
    let changes: i64 = tx.query_row("SELECT total_changes()", [], |row| row.get(0)).map_err(fail)?;
    let stamp = format!("{data_version}:{changes}");
    let libraries = {
        let mut statement = tx.prepare(LIBRARIES_SQL).map_err(fail)?;
        let rows = statement.query_map(params![instance, format!("knowledge.replica.s1:{instance}")], |row| Ok(json!({
            "instanceId": instance, "vaultId": row.get::<_, String>(0)?, "name": row.get::<_, String>(1)?,
            "paused": row.get::<_, bool>(2)?, "waitingCurrent": row.get::<_, bool>(3)?,
            "writeState": row.get::<_, String>(4)?, "metadataReady": row.get::<_, bool>(5)?, "confirmed": row.get::<_, bool>(6)?,
        }))).map_err(fail)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(fail)?
    };
    let selected = vault.and_then(|id| libraries.iter().find(|row| row["vaultId"].as_str() == Some(id)));
    let status = if vault.is_none() { "catalog" }
        else if selected.is_some_and(|row| row["writeState"] == "revoked") { "revoked" }
        else if selected.is_some_and(|row| row["confirmed"] == true && matches!(row["writeState"].as_str(), Some("granted" | "readonly"))) { "ready" }
        else { "not-saved" };
    let mut total = 0i64;
    let mut items = Vec::new();
    if status == "ready" {
        let vault = vault.ok_or("CONTENT_GRAPH_SCOPE_INVALID")?;
        total = tx.query_row(TOTAL_SQL, params![instance, vault], |row| row.get(0)).map_err(fail)?;
        let mut statement = tx.prepare(NOTES_SQL).map_err(fail)?;
        let rows = statement.query_map(params![instance, vault, u64::from(page - 1) * 200], |row| {
            let id: String = row.get(0)?;
            let content: String = row.get(3)?;
            let revision: String = row.get(4)?;
            let dirty: bool = row.get(5)?;
            let cached = document(row.get(6)?);
            let server = document(row.get(7)?);
            let conflict = document(row.get(8)?);
            // A metadata row also contains content="". Only the real cached
            // document (including an explicitly empty body) or a local draft
            // proves readability. Mismatched provenance is never adopted.
            let cached_body = cached.as_ref().is_some_and(|doc| doc["noteId"] == id && doc["vaultId"] == vault
                && doc["content"].is_string() && (dirty || doc["content"].as_str() == Some(content.as_str()))
                && doc["revision"].as_str() == Some(revision.as_str()) && !revision.is_empty());
            let readable = dirty || cached_body;
            let outdated = cached_body && server.as_ref().and_then(|doc| doc["revision"].as_str()).is_some_and(|latest| latest != revision);
            Ok(json!({"instanceId":instance,"vaultId":vault,"noteId":id,"title":row.get::<_,String>(1)?,
                "relativePath":row.get::<_,Option<String>>(2)?,"content":if readable {Some(content)} else {None},
                "revision":revision,"dirty":dirty,"cachedDocument":if cached_body {cached} else {None},
                "serverDocument":server,"conflictDocument":conflict,"bodyOutdated":outdated,
                "updatedAt":row.get::<_,Option<String>>(9)?.unwrap_or_default(),"bodyState":if readable {"ready"} else {"missing"}}))
        }).map_err(fail)?;
        items = rows.collect::<Result<Vec<_>, _>>().map_err(fail)?;
    }
    let more = u64::from(page) * 200 < total as u64;
    let result = json!({"instanceId":instance,"vaultId":vault,"libraries":libraries,"status":status,
        "items":items,"total":total,"hasMore":more,"stamp":stamp});
    tx.commit().map_err(fail)?;
    Ok(result)
}

impl super::Db {
    pub(crate) fn content_graph_cache(&self, instance: &str, vault: Option<&str>, page: u32) -> Result<Value, String> {
        read(&self.conn, instance, vault, page)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE paired_desktop(desktop_instance_id TEXT,paired_at TEXT);
            CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT);
            CREATE TABLE content_offline_vault(desktop_instance_id TEXT,vault_id TEXT,paused INTEGER,waiting_current INTEGER,write_state TEXT);
            CREATE TABLE content_vault_cache(desktop_instance_id TEXT,vault_id TEXT,name TEXT,initialized INTEGER);
            CREATE TABLE note_cache(desktop_instance_id TEXT,vault_id TEXT,note_id TEXT,title TEXT,relative_path TEXT,content TEXT,revision TEXT,dirty INTEGER,cached_document TEXT,server_document TEXT,conflict_document TEXT,updated_at TEXT,deleted INTEGER);
            INSERT INTO paired_desktop VALUES('A','2026-01-01');
            INSERT INTO app_meta VALUES('knowledge.replica.s1:A','v');
            INSERT INTO content_offline_vault VALUES('A','v',0,0,'readonly');
            INSERT INTO content_offline_vault VALUES('A','other',0,0,'granted');
            INSERT INTO content_offline_vault VALUES('B','v',0,0,'granted');
            INSERT INTO content_vault_cache VALUES('A','v','A saved',1);
            INSERT INTO content_vault_cache VALUES('A','other','Not selected',1);
            INSERT INTO content_vault_cache VALUES('B','v','Other Desktop',1);").unwrap();
        db
    }
    fn note(db: &Connection, instance: &str, vault: &str, id: &str, body: &str, cached: bool, dirty: bool) {
        let doc = json!({"noteId":id,"vaultId":vault,"revision":"r1","content":body,"resources":[]});
        db.execute("INSERT INTO note_cache VALUES(?1,?2,?3,?3,?4,?5,'r1',?6,?7,?8,NULL,'2026-01-01',0)",
            params![instance,vault,id,format!("{id}.md"),body,dirty,if cached {Some(doc.to_string())} else {None},json!({"noteId":id,"vaultId":vault,"revision":"r1"}).to_string()]).unwrap();
    }
    #[test]
    fn graph_cache_is_read_only_exact_owner_and_explicit_saved_scope() {
        let db=fixture();
        note(&db,"A","v","same","[[target]]",true,false);
        note(&db,"A","other","same","other vault",true,false);
        note(&db,"B","v","same","other desktop",true,false);
        let changes=|db:&Connection|db.query_row("SELECT total_changes()",[],|row|row.get::<_,i64>(0)).unwrap();
        let before=changes(&db);
        db.execute_batch("PRAGMA query_only=ON").unwrap();
        let catalog=read(&db,"A",None,1).unwrap();
        assert!(catalog["libraries"].as_array().unwrap().iter().all(|row|row["instanceId"]=="A"));
        let page=read(&db,"A",Some("v"),1).unwrap();
        assert_eq!(page["items"][0]["content"],"[[target]]");
        assert_eq!(page["total"],1);
        assert_eq!(read(&db,"A",Some("other"),1).unwrap()["status"],"not-saved");
        assert_eq!(read(&db,"B",Some("v"),1).unwrap_err(),"CONTENT_SOURCE_CHANGED");
        assert_eq!(before,changes(&db),"graph must not write even cursor/selection/recovery metadata");
        assert_eq!(page["stamp"],read(&db,"A",Some("v"),1).unwrap()["stamp"]);
    }
    #[test]
    fn graph_cache_does_not_invent_body_from_summary_or_foreign_provenance() {
        let db=fixture();
        note(&db,"A","v","empty","",true,false);
        note(&db,"A","v","missing","",false,false);
        note(&db,"A","v","draft","draft [[empty]]",false,true);
        note(&db,"A","v","foreign","foreign",true,false);
        db.execute("UPDATE note_cache SET cached_document=?1 WHERE note_id='foreign'",[json!({"noteId":"foreign","vaultId":"other","revision":"r1","content":"foreign"}).to_string()]).unwrap();
        let page=read(&db,"A",Some("v"),1).unwrap();
        let find=|id:&str|page["items"].as_array().unwrap().iter().find(|row|row["noteId"]==id).unwrap();
        assert_eq!(find("empty")["content"],""); assert_eq!(find("empty")["bodyState"],"ready");
        assert!(find("missing")["content"].is_null()); assert_eq!(find("missing")["bodyState"],"missing");
        assert_eq!(find("draft")["content"],"draft [[empty]]");
        assert!(find("foreign")["content"].is_null());
    }
    #[test]
    fn graph_cache_pagination_stamp_and_revocation_fence() {
        let db=fixture();
        for n in 0..203 { note(&db,"A","v",&format!("n{n:03}"),"",true,false); }
        let first=read(&db,"A",Some("v"),1).unwrap();
        let last=read(&db,"A",Some("v"),2).unwrap();
        assert_eq!(first["items"].as_array().unwrap().len(),200); assert_eq!(first["hasMore"],true);
        assert_eq!(last["items"].as_array().unwrap().len(),3); assert_eq!(last["hasMore"],false);
        assert_eq!(first["stamp"],last["stamp"]);
        db.execute("UPDATE note_cache SET server_document=?1 WHERE note_id='n000'",[json!({"revision":"r2"}).to_string()]).unwrap();
        let changed=read(&db,"A",Some("v"),1).unwrap();
        assert_ne!(first["stamp"],changed["stamp"]); assert_eq!(changed["items"][0]["bodyOutdated"],true);
        db.execute("UPDATE content_offline_vault SET write_state='revoked' WHERE desktop_instance_id='A' AND vault_id='v'",[]).unwrap();
        let denied=read(&db,"A",Some("v"),1).unwrap();
        assert_eq!(denied["status"],"revoked");assert_eq!(denied["items"],json!([]));
    }
    #[test]
    fn graph_cache_pair_change_and_invalid_inputs_fail_closed() {
        let db=fixture();
        for (instance,vault,page) in [("",Some("v"),1),("A",Some(""),1),("A",Some("v"),0)] {
            assert!(read(&db,instance,vault,page).is_err());
        }
        db.execute("UPDATE paired_desktop SET desktop_instance_id='B'",[]).unwrap();
        assert_eq!(read(&db,"A",Some("v"),1).unwrap_err(),"CONTENT_SOURCE_CHANGED");
        assert_eq!(read(&db,"B",Some("v"),1).unwrap()["status"],"not-saved");
    }
    #[test]
    fn graph_cache_accepts_nullable_metadata_timestamp() {
        let db=fixture();
        note(&db,"A","v","nullable-timestamp","[[target]]",true,false);
        // The real note_cache schema allows metadata rows without updated_at.
        // One such row must not prevent reading the entire saved library.
        db.execute("UPDATE note_cache SET updated_at=NULL WHERE note_id='nullable-timestamp'",[]).unwrap();
        let page=read(&db,"A",Some("v"),1).unwrap();
        assert_eq!(page["status"],"ready");
        assert_eq!(page["items"][0]["updatedAt"],"");
        assert_eq!(page["items"][0]["content"],"[[target]]");
    }
}
