//! Immutable, scope-bound empty-folder intents. Call mutations inside a transaction
//! and publish with managed_vault_sync::commit; never send before that commit.
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use unicode_normalization::UnicodeNormalization;

pub(crate) const PREFIX: &str = "managed.folder.v1:";
pub(crate) const RECEIPT_PREFIX: &str = "managed.folder.receipt.v1:";
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FolderOperation {
    pub op_id: String,
    pub instance_id: String,
    pub vault_id: String,
    pub parent_relative_path: String,
    pub name: String,
    pub relative_path: String,
}
fn failure(e: rusqlite::Error) -> String { format!("MANAGED_FOLDER_DATABASE: {e}") }
fn key(prefix: &str, instance: &str, vault: &str, path: &str) -> String {
    format!("{prefix}{}", json!([instance,vault,path]))
}
fn require_tx(db: &Connection) -> Result<(), String> {
    if db.is_autocommit() { Err("MANAGED_FOLDER_TRANSACTION_REQUIRED".into()) } else { Ok(()) }
}
pub(crate) fn safe_path(path: &str, empty: bool) -> Result<(), String> {
    if path.is_empty() && empty { return Ok(()); }
    if path.is_empty() || path.len()>1024 || path.contains('\\') { return Err("VAULT_PATH_INVALID".into()); }
    for part in path.split('/') {
        let k=part.nfc().flat_map(char::to_uppercase).collect::<String>();
        let stem=k.split('.').next().unwrap_or("");
        if part.is_empty() || part=="." || part==".." || part.trim()!=part || part.ends_with('.')
            || part.chars().any(|c|c.is_control() || "<>:\"|?*".contains(c))
            || [".LUCKYRAY",".OBSIDIAN",".GIT"].contains(&k.as_str()) || k.starts_with(".LRK-")
            || ["CON","PRN","AUX","NUL"].contains(&stem)
            || (stem.len()==4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.as_bytes()[3].is_ascii_digit()) {
            return Err("VAULT_PATH_INVALID".into());
        }
    }
    Ok(())
}
fn collision(path: &str) -> String { path.nfc().flat_map(char::to_uppercase).collect() }
impl FolderOperation {
    pub(crate) fn payload(&self)->Value { json!({"opId":self.op_id,"vaultId":self.vault_id,"parentRelativePath":self.parent_relative_path,"name":self.name}) }
    fn validate(&self)->Result<(),String> {
        if self.instance_id.is_empty() || self.vault_id.is_empty() || self.op_id.is_empty() || self.name.contains('/') {return Err("MANAGED_FOLDER_INVALID".into());}
        safe_path(&self.relative_path,false)?; safe_path(&self.parent_relative_path,true)?; safe_path(&self.name,false)?;
        let path=if self.parent_relative_path.is_empty(){self.name.clone()}else{format!("{}/{}",self.parent_relative_path,self.name)};
        if path!=self.relative_path {return Err("MANAGED_FOLDER_INVALID".into());} Ok(())
    }
}
pub(crate) fn enqueue(db:&Connection,instance:&str,vault:&str,parent:&str,name:&str,known:&[String])->Result<Value,String> {
    require_tx(db)?; safe_path(parent,true)?; safe_path(name,false)?;
    if name.contains('/') || (!parent.is_empty() && !known.iter().any(|p|p==parent)) {return Err("VAULT_FOLDER_NOT_FOUND".into());}
    let path=if parent.is_empty(){name.into()}else{format!("{parent}/{name}")};
    if known.iter().any(|p|collision(p)==collision(&path)) {return Err("VAULT_FOLDER_EXISTS".into());}
    let op=FolderOperation {op_id:format!("folder-{}",uuid::Uuid::new_v4().simple()),instance_id:instance.into(),vault_id:vault.into(),parent_relative_path:parent.into(),name:name.into(),relative_path:path.clone()}; op.validate()?;
    db.execute("INSERT INTO app_meta(key,value) VALUES(?1,?2)",params![key(PREFIX,instance,vault,&path),serde_json::to_string(&op).map_err(|e|e.to_string())?]).map_err(failure)?;
    Ok(json!({"path":path,"opId":op.op_id,"syncState":"pending"}))
}
pub(crate) fn pending(db:&Connection,instance:&str,vault:&str)->Result<Vec<FolderOperation>,String> {
    let mut query=db.prepare("SELECT key,value FROM app_meta WHERE key LIKE 'managed.folder.v1:%' ORDER BY rowid").map_err(failure)?;
    let mut output=Vec::new();
    for row in query.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(failure)? {
        let (k,v)=row.map_err(failure)?;
        let parts:Vec<String>=serde_json::from_str(k.strip_prefix(PREFIX).ok_or("MANAGED_FOLDER_INVALID")?).map_err(|_|"MANAGED_FOLDER_INVALID")?;
        if parts.len()!=3 || parts[0]!=instance || parts[1]!=vault {continue;}
        let op:FolderOperation=serde_json::from_str(&v).map_err(|_|"MANAGED_FOLDER_INVALID")?; op.validate()?;
        if op.instance_id!=instance || op.vault_id!=vault || op.relative_path!=parts[2] {return Err("MANAGED_FOLDER_SCOPE_CHANGED".into());}
        output.push(op);
    }
    Ok(output)
}
pub(crate) fn parent_ready(db:&Connection,instance:&str,vault:&str,parent:&str)->Result<bool,String> {
    safe_path(parent,true)?;
    Ok(!pending(db,instance,vault)?.iter().any(|op|parent==op.relative_path || parent.starts_with(&format!("{}/",op.relative_path))))
}
pub(crate) fn acknowledge(db:&Connection,op:&FolderOperation,result:&Value)->Result<(),String> {
    require_tx(db)?; op.validate()?;
    if result["opId"]!=op.op_id || result["vaultId"]!=op.vault_id || result["relativePath"]!=op.relative_path || result["created"]!=true {return Err("MANAGED_FOLDER_ACK_INVALID".into());}
    let k=key(PREFIX,&op.instance_id,&op.vault_id,&op.relative_path);
    let stored:Option<String>=db.query_row("SELECT value FROM app_meta WHERE key=?1",[&k],|r|r.get(0)).optional().map_err(failure)?;
    let expected=serde_json::to_string(op).map_err(|e|e.to_string())?;
    if stored.as_deref()!=Some(&expected) {return Err("MANAGED_FOLDER_STALE_RESULT".into());}
    db.execute("INSERT OR REPLACE INTO app_meta(key,value) VALUES(?1,?2)",params![key(RECEIPT_PREFIX,&op.instance_id,&op.vault_id,&op.relative_path),expected]).map_err(failure)?;
    db.execute("DELETE FROM app_meta WHERE key=?1 AND value=?2",params![k,stored]).map_err(failure)?;
    Ok(())
}
/// Merge only explicit present directories. Incomplete/unavailable observations
/// never remove a local folder, and cannot acknowledge a pending operation.
pub(crate) fn recognize(db:&Connection,instance:&str,vault:&str,result:&Value)->Result<(),String> {
    require_tx(db)?;
    if result["vaultId"]!=vault || !result["complete"].is_boolean() {return Err("MANAGED_FOLDER_SNAPSHOT_INVALID".into());}
    let folders=result["folders"].as_array().filter(|rows|rows.len()<=4096).ok_or("MANAGED_FOLDER_SNAPSHOT_INVALID")?;
    for folder in folders {safe_path(folder.as_str().ok_or("MANAGED_FOLDER_SNAPSHOT_INVALID")?,true)?;}
    for folder in folders {
        let path=folder.as_str().unwrap(); if path.is_empty(){continue;}
        let (parent,name)=path.rsplit_once('/').unwrap_or(("",path));
        let op=FolderOperation{op_id:"observed".into(),instance_id:instance.into(),vault_id:vault.into(),parent_relative_path:parent.into(),name:name.into(),relative_path:path.into()};op.validate()?;
        db.execute("INSERT OR IGNORE INTO app_meta(key,value) VALUES(?1,?2)",params![key(RECEIPT_PREFIX,instance,vault,path),serde_json::to_string(&op).map_err(|e|e.to_string())?]).map_err(failure)?;
    } Ok(())
}
#[cfg(test)] mod tests {
    use super::*;
    fn fixture()->Connection {let db=Connection::open_in_memory().unwrap();db.execute_batch("CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);BEGIN IMMEDIATE;").unwrap();db}
    #[test] fn immutable_scope_parent_dependency_and_ack() {
        let db=fixture();enqueue(&db,"i","v","","Parent",&[]).unwrap();let op=pending(&db,"i","v").unwrap().remove(0);
        assert!(!parent_ready(&db,"i","v","Parent/Child").unwrap());assert!(parent_ready(&db,"other","v","Parent").unwrap());
        let ack=json!({"opId":op.op_id,"vaultId":"v","relativePath":"Parent","created":true});
        let mut bad=ack.clone();bad["vaultId"]=json!("wrong");assert!(acknowledge(&db,&op,&bad).is_err());
        acknowledge(&db,&op,&ack).unwrap();assert!(parent_ready(&db,"i","v","Parent").unwrap());assert!(acknowledge(&db,&op,&ack).is_err());
    }
    #[test] fn rejects_traversal_alias_reserved_and_unknown_parent() {
        let db=fixture(); for name in ["../x","A/B","A\\B","CON.txt","aux","LPT1","trailing."," leading",".obsidian","x:y","x\0z"] {assert!(enqueue(&db,"i","v","",name,&[]).is_err(),"{name}");}
        assert!(enqueue(&db,"i","v","unknown","x",&[]).is_err());assert!(enqueue(&db,"i","v","","é",&["e\u{301}".into()]).is_err());
    }
    #[test] fn observation_never_acks_or_erases_pending() {
        let db=fixture();enqueue(&db,"i","v","","Empty",&[]).unwrap();recognize(&db,"i","v",&json!({"vaultId":"v","complete":false,"folders":["Empty"]})).unwrap();
        assert_eq!(pending(&db,"i","v").unwrap().len(),1);assert!(!parent_ready(&db,"i","v","Empty").unwrap());
        recognize(&db,"i","v",&json!({"vaultId":"v","complete":true,"folders":[]})).unwrap();assert_eq!(pending(&db,"i","v").unwrap().len(),1);
    }
    #[test] fn rollback_and_commit_preserve_exact_payload() {let db=fixture();enqueue(&db,"i","v","","a",&[]).unwrap();let original=pending(&db,"i","v").unwrap();db.execute_batch("COMMIT;BEGIN;").unwrap();assert_eq!(original,pending(&db,"i","v").unwrap());enqueue(&db,"i","v","","b",&[]).unwrap();db.execute_batch("ROLLBACK;").unwrap();assert_eq!(original,pending(&db,"i","v").unwrap());assert!(enqueue(&db,"i","v","","c",&[]).is_err());}
}
