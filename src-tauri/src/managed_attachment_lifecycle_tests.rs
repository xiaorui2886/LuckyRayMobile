//! Synthetic real DB/owned-file fixtures; no Tauri, remote network or device.
use crate::{db::Db, managed_vault::{self, Manifest, Store}};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, path::PathBuf};

struct Fixture { root: PathBuf, db: Db, store: Store, bound: String }
impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.root); } }
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("attachment-lifecycle-proof-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let mut db = Db::open(&root.join("luckyray-mobile.db")).unwrap();
        db.content_vault_remember("desktop-a", "vault-a", "Synthetic A").unwrap();
        db.content_apply_batch("desktop-a", "vault-a", &[json!({"noteId":"n","vaultId":"vault-a","title":"N","content":"before after","relativePath":"N.md","revision":"r1","resources":[],"updatedAt":"2026-10-30","deleted":false})], 1, None).unwrap();
        let store = Store::new(&root).unwrap();
        store.commit(Manifest { version:1,local_vault_id:"local".into(),name:"Synthetic local".into(),binding:None,checkpoint:Value::Null,generation:0,notes:BTreeMap::new(),folders:vec![] }, BTreeMap::new()).unwrap();
        store.register("local").unwrap();
        { let _guard = managed_vault::lock().unwrap(); db.managed_migrate_replicas().unwrap(); }
        let bound = store.list().unwrap()["items"].as_array().unwrap().iter().find(|x| x["binding"].is_object()).unwrap()["localVaultId"].as_str().unwrap().to_string();
        Self {root,db,store,bound}
    }
}
#[test]
fn fixture_real_db_and_owned_store_are_same_bound_note() {
    let f = Fixture::new();
    assert_eq!(f.store.get(&f.bound,"n").unwrap().content.as_deref(),Some("before after"));
    assert_eq!(f.db.content_note("desktop-a","vault-a","n").unwrap()["content"],"before after");
    assert!(f.db.content_note("desktop-b","vault-a","n").is_err());
    assert!(f.store.get("local","n").is_err());
}

#[test]
fn managed_owned_attachment_survives_equivalent_app_data_path_spelling() {
    let mut f=Fixture::new();
    // SQLite may return a canonical app-data path while Tauri retains its
    // original spelling. Model that difference without touching real data.
    fs::create_dir_all(f.root.join("path-alias-parent")).unwrap();
    let alias=Store::new(&f.root.join("path-alias-parent").join("..")).unwrap();
    let before=alias.get(&f.bound,"n").unwrap();
    let saved=f.db.managed_stage_attachment(&alias,&f.bound,"n",&before.revision,"image.png","image/png",b"owned image fixture",7,7).unwrap();
    assert_eq!(saved.remote["localAttachments"].as_array().unwrap().len(),1,"same owned file must retain its descriptor at the first returned revision");
    let op=saved.remote["localAttachments"][0]["opId"].as_str().unwrap();
    let target=format!("luckyray-attachment:{op}");
    let file=crate::managed_vault_resources::resolve(&f.store,&f.bound,"n",&target).unwrap();
    assert_eq!(fs::read(file["path"].as_str().unwrap()).unwrap(),b"owned image fixture");
    assert!(crate::managed_vault_resources::resolve(&f.store,"local","n",&target).is_err());
}
fn stage(f: &mut Fixture, op: &str) {
    let bytes = b"synthetic attachment only";
    let path = f.root.join(format!("{op}.txt"));
    fs::write(&path, bytes).unwrap();
    f.db.content_stage_attachment("desktop-a","vault-a","n",op,"synthetic.txt","text/plain",path.to_str().unwrap(),bytes.len() as u64,&managed_vault::hash(bytes)).unwrap();
}
#[test]
fn existing_queue_receipt_is_scope_bound_idempotent_and_survives_reopen() {
    let mut f = Fixture::new(); stage(&mut f,"op-proof");
    assert_eq!(f.db.content_pending_attachments("desktop-a","vault-a").unwrap().len(),1);
    assert!(f.db.content_pending_attachments("desktop-b","vault-a").unwrap().is_empty());
    let receipt = json!({"publication":{"markdown":"[synthetic.txt](attachments/synthetic.txt)"}});
    f.db.content_attachment_receipt("desktop-b","vault-a","n","op-proof",&receipt).unwrap();
    assert_eq!(f.db.content_pending_attachments("desktop-a","vault-a").unwrap().len(),1);
    f.db = Db::open(&f.root.join("luckyray-mobile.db")).unwrap();
    assert_eq!(f.db.content_pending_attachments("desktop-a","vault-a").unwrap()[0]["opId"],"op-proof");
    f.db.content_attachment_receipt("desktop-a","vault-a","n","op-proof",&receipt).unwrap();
    let once=f.db.content_note("desktop-a","vault-a","n").unwrap()["content"].as_str().unwrap().to_string();
    f.db.content_attachment_receipt("desktop-a","vault-a","n","op-proof",&receipt).unwrap();
    assert_eq!(f.db.content_note("desktop-a","vault-a","n").unwrap()["content"],once);
    assert_eq!(once.matches("attachments/synthetic.txt").count(),1);
    assert!(f.db.content_pending_attachments("desktop-a","vault-a").unwrap().is_empty());
}
#[test]
fn existing_receipt_does_not_resurrect_removed_reference() {
    let mut f=Fixture::new(); stage(&mut f,"op-removed");
    let note=f.store.get(&f.bound,"n").unwrap();
    f.db.managed_save_bound(&f.store,&f.bound,"n",&note.revision,"N","reference removed",vec![]).unwrap();
    f.db.content_attachment_receipt("desktop-a","vault-a","n","op-removed",&json!({"publication":{"markdown":"[synthetic.txt](attachments/removed.txt)"}})).unwrap();
    assert_eq!(f.store.get(&f.bound,"n").unwrap().content.as_deref(),Some("reference removed"));
}
#[test]
fn managed_unbound_attachment_command_core_commits_body_owned_metadata_then_reopens() {
    let f=Fixture::new();let note=f.store.create("local","Local","A😀Z",vec![],"").unwrap();
    let saved=f.db.managed_stage_attachment(&f.store,"local",&note.note_id,&note.revision,"synthetic.txt","text/plain",b"local owned bytes",3,3).unwrap();
    let op=saved.remote["localAttachments"][0]["opId"].as_str().unwrap();
    let target=format!("luckyray-attachment:{op}");
    assert_eq!(saved.content.as_deref(),Some(format!("A😀[synthetic.txt]({target})Z").as_str()));
    assert!(f.db.content_pending_attachments("desktop-a","vault-a").unwrap().is_empty());
    let reopened=Store::new(&f.root).unwrap();
    let file=crate::managed_vault_resources::resolve(&reopened,"local",&note.note_id,&target).unwrap();
    assert_eq!(fs::read(file["path"].as_str().unwrap()).unwrap(),b"local owned bytes");
    assert_eq!(f.db.managed_stage_attachment(&reopened,"local",&note.note_id,&note.revision,"again.txt","text/plain",b"more",0,0).unwrap_err(),"VAULT_REVISION_CONFLICT");
    assert_eq!(reopened.get("local",&note.note_id).unwrap().remote["localAttachments"].as_array().unwrap().len(),1);
}
#[test]
fn managed_bound_attachment_queues_owned_bytes_and_receipt_retains_offline_preview() {
    let mut f=Fixture::new();let note=f.store.get(&f.bound,"n").unwrap();
    let saved=f.db.managed_stage_attachment(&f.store,&f.bound,"n",&note.revision,"synthetic.txt","text/plain",b"bound owned bytes",7,7).unwrap();
    let rows=f.db.content_pending_attachments("desktop-a","vault-a").unwrap();assert_eq!(rows.len(),1);
    let op=rows[0]["opId"].as_str().unwrap().to_string();let target=format!("luckyray-attachment:{op}");
    assert_eq!(saved.content.as_deref(),Some(format!("before [synthetic.txt]({target})after").as_str()));
    assert_eq!(fs::read(rows[0]["localPath"].as_str().unwrap()).unwrap(),b"bound owned bytes");
    assert!(crate::managed_vault_resources::resolve(&f.store,&f.bound,"n",&target).is_ok());
    f.db=Db::open(&f.root.join("luckyray-mobile.db")).unwrap();
    assert_eq!(f.db.content_pending_attachments("desktop-a","vault-a").unwrap()[0]["opId"],op);
    f.db.content_attachment_receipt("desktop-a","vault-a","n",&op,&json!({"publication":{"markdown":"[synthetic.txt](attachments/synthetic.txt)"}})).unwrap();
    let read=crate::managed_vault_resources::resolve(&f.store,&f.bound,"n","attachments/synthetic.txt").unwrap();
    assert_eq!(fs::read(read["path"].as_str().unwrap()).unwrap(),b"bound owned bytes");
    assert!(f.db.content_pending_attachments("desktop-a","vault-a").unwrap().is_empty());
    assert!(crate::managed_vault_resources::resolve(&f.store,"local","n","attachments/synthetic.txt").is_err());
}
#[test]
fn managed_attachment_rejects_stale_selection_without_publishing_body_or_queue() {
    let f=Fixture::new();let note=f.store.create("local","Local","A😀Z",vec![],"").unwrap();
    assert_eq!(f.db.managed_stage_attachment(&f.store,"local",&note.note_id,&note.revision,"synthetic.txt","text/plain",b"not published",2,2).unwrap_err(),"VAULT_SELECTION_CHANGED");
    let after=f.store.get("local",&note.note_id).unwrap();assert_eq!(after.revision,note.revision);assert_eq!(after.content,note.content);assert!(after.remote["localAttachments"].is_null());
    assert!(f.db.content_pending_attachments("desktop-a","vault-a").unwrap().is_empty());
}
#[test]
fn managed_transfer_carries_owned_attachment_bytes_and_durable_queue_without_source_dependency() {
    let f=Fixture::new();let note=f.store.create("local","Local attachment","body",vec![],"").unwrap();
    let saved=f.db.managed_stage_attachment(&f.store,"local",&note.note_id,&note.revision,"synthetic.txt","text/plain",b"transfer owned bytes",4,4).unwrap();
    let op=saved.remote["localAttachments"][0]["opId"].as_str().unwrap().to_string();
    let plan=crate::managed_vault_transfer::build(&f.db,&f.store,"local",&f.bound).unwrap();
    let result=crate::managed_vault_transfer::commit(&f.db,&f.store,"local",&f.bound,&plan.snapshot_hash).unwrap();
    assert_eq!(result["transferredCount"],1);
    let original=f.store.get("local",&note.note_id).unwrap();
    let new_id=original.remote["transferredTo"]["noteId"].as_str().unwrap();
    let target=format!("luckyray-attachment:{op}");
    let file=crate::managed_vault_resources::resolve(&f.store,&f.bound,new_id,&target).unwrap();
    assert_eq!(fs::read(file["path"].as_str().unwrap()).unwrap(),b"transfer owned bytes");
    assert!(std::path::Path::new(file["path"].as_str().unwrap()).starts_with(f.store.vault_root(&f.bound).unwrap()));
    assert_eq!(f.db.content_local_attachments("desktop-a","vault-a",new_id).unwrap().len(),1);
    let reopened=Store::new(&f.root).unwrap();
    assert!(crate::managed_vault_resources::resolve(&reopened,&f.bound,new_id,&target).is_ok());
    assert_eq!(reopened.get(&f.bound,new_id).unwrap().remote["localAttachments"].as_array().unwrap().len(),1);
}
#[test]
fn managed_transfer_failed_owned_bytes_retains_source_and_recovers_without_duplicate_queue() {
    for missing in [false,true] {
        let f=Fixture::new();let note=f.store.create("local","Local attachment","body",vec![],"").unwrap();
        let saved=f.db.managed_stage_attachment(&f.store,"local",&note.note_id,&note.revision,"synthetic.txt","text/plain",b"transfer recovery",4,4).unwrap();
        let op=saved.remote["localAttachments"][0]["opId"].as_str().unwrap();let target=format!("luckyray-attachment:{op}");
        let source_file=crate::managed_vault_resources::resolve(&f.store,"local",&note.note_id,&target).unwrap();let source_path=source_file["path"].as_str().unwrap();
        let preview=crate::managed_vault_transfer::preview(&f.db,&f.store,"local",&f.bound).unwrap();assert_eq!(preview["incompleteCount"],0);
        let hash=preview["snapshotHash"].as_str().unwrap();
        if missing {fs::remove_file(source_path).unwrap();} else {fs::write(source_path,b"corrupt").unwrap();}
        assert!(crate::managed_vault_transfer::commit(&f.db,&f.store,"local",&f.bound,hash).is_err());
        let retained=f.store.get("local",&note.note_id).unwrap();assert_eq!(retained.content,saved.content);assert!(retained.remote["transferredTo"].is_null());
        fs::write(source_path,b"transfer recovery").unwrap();
        crate::managed_vault_transfer::commit(&f.db,&f.store,"local",&f.bound,hash).unwrap();
        crate::managed_vault_transfer::commit(&f.db,&f.store,"local",&f.bound,hash).unwrap();
        let retained=f.store.get("local",&note.note_id).unwrap();let new_id=retained.remote["transferredTo"]["noteId"].as_str().unwrap();
        assert_eq!(f.db.content_local_attachments("desktop-a","vault-a",new_id).unwrap().len(),1);
        assert!(crate::managed_vault_resources::resolve(&f.store,&f.bound,new_id,&target).is_ok());
    }
}
