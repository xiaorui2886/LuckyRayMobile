//! Versioned linked transfer metadata. Network orchestration is separate; local
//! adoption publishes the whole dependency set through the existing outbox.
use crate::{db::Db,managed_vault::{self,Store},managed_vault_transfer::{self,Plan},managed_vault_wiki_plan::{self,SourceNote,ReservedPath}};
use rusqlite::{Connection,OptionalExtension};
use serde::{Serialize,Deserialize};
use serde_json::{json,Value};
use std::collections::{BTreeMap,BTreeSet};
use sha2::{Digest,Sha256};
pub(crate) const FILE:&str=".luckyray/linked-import-plan.json";
fn proof_path(state:&State)->String{format!(".luckyray/linked-import-proofs-{}.json",state.prepare_op_id)}
fn reservation_path(state:&State)->String{format!(".luckyray/linked-import-reservation-{}.json",state.prepare_op_id)}
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct Entry {pub source_note_id:String,pub note_id:String,pub op_id:String}
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct State {pub version:u32,pub snapshot:Plan,pub prepare_op_id:String,pub entries:Vec<Entry>,pub reservation:Option<Value>,#[serde(default)] pub wiki_proofs:Option<Value>}
fn encoded<T:Serialize>(value:&T)->Result<Vec<u8>,String>{serde_json::to_vec(value).map_err(|e|e.to_string())}
fn identifier(s:&str)->bool{!s.is_empty()&&s.len()<=160&&s.bytes().all(|c|c.is_ascii_alphanumeric()||c==b'-'||c==b'_')}
pub(crate) fn load(store:&Store,source:&str)->Result<Option<State>,String>{
    let path=managed_vault::guarded(&store.vault_root(source)?,FILE)?;if !path.exists(){return Ok(None);}
    let mut state:State=serde_json::from_slice(&std::fs::read(path).map_err(|e|e.to_string())?).map_err(|_|"LINKED_IMPORT_PLAN_INVALID")?;
    if state.version!=1||state.snapshot.source_vault_id!=source||state.snapshot.snapshot_hash!=managed_vault_transfer::fingerprint(&state.snapshot)?||!identifier(&state.prepare_op_id)||state.entries.len()!=state.snapshot.notes.len(){return Err("LINKED_IMPORT_PLAN_INVALID".into());}
    let mut ids=BTreeSet::new();let mut ops=BTreeSet::new();
    for (note,entry) in state.snapshot.notes.iter().zip(&state.entries){if entry.source_note_id!=note.note_id||!entry.note_id.starts_with("kn-")||!identifier(&entry.note_id)||!identifier(&entry.op_id)||!ids.insert(&entry.note_id)||!ops.insert(&entry.op_id){return Err("LINKED_IMPORT_PLAN_INVALID".into());}}
    let reservation=managed_vault::guarded(&store.vault_root(source)?,&reservation_path(&state))?;
    if reservation.exists(){state.reservation=Some(serde_json::from_slice(&std::fs::read(reservation).map_err(|e|e.to_string())?).map_err(|_|"LINKED_IMPORT_MAPPING_INVALID")?);}
    let proofs=managed_vault::guarded(&store.vault_root(source)?,&proof_path(&state))?;
    if proofs.exists(){state.wiki_proofs=Some(serde_json::from_slice(&std::fs::read(proofs).map_err(|e|e.to_string())?).map_err(|_|"LINKED_IMPORT_PROOFS_INVALID")?);}
    Ok(Some(state))
}
fn write(store:&Store,state:&State,freeze:bool)->Result<(),String>{
    let mut m=store.manifest(&state.snapshot.source_vault_id)?;
    if freeze && m.checkpoint["transfer"]["state"]!="completed" {m.checkpoint=json!({"transfer":{"state":"pending","targetVaultId":state.snapshot.target_vault_id,"linkedPlan":true}});
        for before in &state.snapshot.notes {let n=m.notes.get_mut(&before.note_id).ok_or("VAULT_TRANSFER_SOURCE_CHANGED")?;if !n.remote.is_object(){n.remote=json!({});}if n.remote["transferredTo"].is_null(){n.remote["transferPending"]=json!({"localVaultId":state.snapshot.target_vault_id});}}}
    let mut writes=BTreeMap::new();let mut initial=state.clone();initial.reservation=None;initial.wiki_proofs=None;writes.insert(FILE.into(),String::from_utf8(encoded(&initial)?).map_err(|e|e.to_string())?);if let Some(reservation)=&state.reservation{writes.insert(reservation_path(state),reservation.to_string());}if let Some(proofs)=&state.wiki_proofs{writes.insert(proof_path(state),proofs.to_string());}store.commit(m,writes)
}
pub(crate) fn begin(db:&Db,store:&Store,source:&str,target:&str,expected:&str)->Result<Option<State>,String>{
    db.managed_recover()?;
    {let _g=managed_vault::lock()?;if let Some(state)=load(store,source)?{
        let same=state.snapshot.target_vault_id==target&&state.snapshot.snapshot_hash==expected;
        if same && managed_vault_transfer::check(store,&state.snapshot).is_ok(){return Ok(Some(state));}
        if !store.manifest(source)?.checkpoint["transfer"].is_null(){return Err("LINKED_IMPORT_SOURCE_CHANGED".into());}
        // Only a never-adopted preparation may be archived. Publication always
        // freezes the source first, so this branch cannot replace attempted IDs.
    }}
    let p=managed_vault_transfer::build(db,store,source,target)?;
    if !p.notes.iter().any(|n|n.content.as_deref().is_some_and(|body|body.contains("[["))){return Ok(None);}
    if p.snapshot_hash!=expected{return Err("LINKED_IMPORT_SOURCE_CHANGED".into());}
    if managed_vault_transfer::blocked(db,&p)>0 || p.notes.iter().any(|n|n.content.as_deref().is_some_and(|s|s.starts_with('\u{feff}'))){return Err("LINKED_IMPORT_SOURCE_INVALID".into());}
    if p.notes.is_empty()||p.notes.len()>256{return Err("LINKED_IMPORT_PLAN_LIMIT".into());}
    let _g=managed_vault::lock()?;
    if store.vault_root(source)?.join(".luckyray/transfer-plan.json").exists(){return Err("LINKED_IMPORT_LEGACY_PARTIAL".into());}
    managed_vault_transfer::check(store,&p)?;
    if let Some(old)=load(store,source)? {
        if !store.manifest(source)?.checkpoint["transfer"].is_null(){return Err("LINKED_IMPORT_SOURCE_CHANGED".into());}
        let root=store.vault_root(source)?;let archive=format!(".luckyray/linked-import-abandoned-{}.json",old.prepare_op_id);
        let dest=managed_vault::guarded(&root,&archive)?;if dest.exists(){return Err("LINKED_IMPORT_RECOVERY_REQUIRED".into());}
        std::fs::rename(managed_vault::guarded(&root,FILE)?,dest).map_err(|e|e.to_string())?;
    }
    let entries=p.notes.iter().map(|n|Entry{source_note_id:n.note_id.clone(),note_id:format!("kn-{}",uuid::Uuid::new_v4().simple()),op_id:format!("li-{}",uuid::Uuid::new_v4().simple())}).collect();
    let state=State{version:1,snapshot:p,prepare_op_id:format!("lip-{}",uuid::Uuid::new_v4().simple()),entries,reservation:None,wiki_proofs:None};
    // Metadata-only preparation does not make the original notes read-only.
    write(store,&state,false)?;Ok(Some(state))
}
pub(crate) fn request(state:&State)->Value{json!({"opId":state.prepare_op_id,"vaultId":state.snapshot.target_binding.remote_vault_id,"sourceFingerprint":state.snapshot.snapshot_hash,"items":state.snapshot.notes.iter().zip(&state.entries).map(|(n,e)|json!({"sourceNoteId":n.note_id,"noteId":e.note_id,"title":n.title,"parentRelativePath":n.folder})).collect::<Vec<_>>()})}
pub(crate) fn mapping_hash(vault:&str,source:&str,items:&[ReservedPath])->String{
    let mut hash=Sha256::new();hash.update(b"lr-import-plan-v1\0");
    fn field(hash:&mut Sha256,s:&str){hash.update((s.len() as u64).to_be_bytes());hash.update(s.as_bytes());}
    field(&mut hash,vault);field(&mut hash,source);hash.update((items.len() as u64).to_be_bytes());
    for item in items{field(&mut hash,&item.source_note_id);field(&mut hash,&item.note_id);field(&mut hash,&item.relative_path);}format!("{:x}",hash.finalize())
}
pub(crate) fn mapping(state:&State,response:&Value)->Result<Vec<ReservedPath>,String>{
    if response["version"]!=1||response["vaultId"]!=state.snapshot.target_binding.remote_vault_id||response["sourceFingerprint"]!=state.snapshot.snapshot_hash||response["state"]!="prepared"||!response["planId"].as_str().is_some_and(|s|s.starts_with("ip-")&&identifier(s)){return Err("LINKED_IMPORT_MAPPING_INVALID".into());}
    let rows=response["items"].as_array().filter(|rows|rows.len()==state.entries.len()).ok_or("LINKED_IMPORT_MAPPING_INVALID")?;let mut paths=BTreeSet::new();let mut out=Vec::new();
    for ((row,entry),note) in rows.iter().zip(&state.entries).zip(&state.snapshot.notes){
        let path=row["relativePath"].as_str().ok_or("LINKED_IMPORT_MAPPING_INVALID")?;
        crate::managed_vault_folder_sync::safe_path(path,false)?;
        if row["sourceNoteId"]!=entry.source_note_id||row["noteId"]!=entry.note_id||!path.to_ascii_lowercase().ends_with(".md")||path.rsplit_once('/').map(|p|p.0).unwrap_or("")!=note.folder||!paths.insert(path.to_lowercase()){return Err("LINKED_IMPORT_MAPPING_INVALID".into());}
        out.push(ReservedPath{source_note_id:entry.source_note_id.clone(),note_id:entry.note_id.clone(),relative_path:path.into()});
    }
    if response["mappingHash"]!=mapping_hash(&state.snapshot.target_binding.remote_vault_id,&state.snapshot.snapshot_hash,&out){return Err("LINKED_IMPORT_MAPPING_INVALID".into());}Ok(out)
}
pub(crate) fn accept_and_adopt(db:&Db,store:&Store,mut state:State,response:&Value)->Result<Value,String>{
    let paths=mapping(&state,response)?;
    {let _g=managed_vault::lock()?;let old=load(store,&state.snapshot.source_vault_id)?.ok_or("LINKED_IMPORT_PLAN_MISSING")?;
        if encoded(&old)?!=encoded(&state)?{return Err("LINKED_IMPORT_PLAN_CHANGED".into());}
        if let Some(previous)=&state.reservation{if previous!=response{return Err("LINKED_IMPORT_MAPPING_CHANGED".into());}}
        state.reservation=Some(response.clone());write(store,&state,false)?;
        managed_vault_transfer::check(store,&state.snapshot)?;
    }
    let sources=state.snapshot.notes.iter().map(|n|Ok(SourceNote{source_note_id:n.note_id.clone(),title:n.title.clone(),folder:n.folder.clone(),historical_names:n.historical_names.clone(),content:n.content.clone().ok_or("LINKED_IMPORT_BODY_MISSING")?})).collect::<Result<Vec<_>,String>>()?;
    let rewritten=if let Some(proofs)=&state.wiki_proofs {
        let proofs:Vec<managed_vault_wiki_plan::SourceProof>=serde_json::from_value(proofs.clone()).map_err(|_|"LINKED_IMPORT_PROOFS_INVALID")?;
        managed_vault_wiki_plan::rewrite_all_proven(&sources,&paths,&proofs)?
    }else{managed_vault_wiki_plan::rewrite_all(&sources,&paths)?};
    if rewritten.iter().any(|n|n.content.len()>4*1024*1024 || n.content.starts_with('\u{feff}')){return Err("LINKED_IMPORT_CONTENT_INVALID".into());}
    {let _g=managed_vault::lock()?;managed_vault_transfer::check(store,&state.snapshot)?;write(store,&state,true)?;}
    db.managed_linked_adopt(store,&state,&rewritten)?;
    Ok(json!({"sourceVaultId":state.snapshot.source_vault_id,"targetVaultId":state.snapshot.target_vault_id,"preparedCount":state.entries.len(),"transferredCount":0,"syncState":"pending","linkedPlan":true}))
}
/// Run only with DB ownership, after normal bridge recovery. Receipt markers were
/// committed with the ordinary ACK transaction; no remote fetch or body rewrite.
pub(crate) fn reconcile(db:&Connection,store:&Store)->Result<(),String>{
    let _g=managed_vault::lock()?;let registry=store.list()?;
    for row in registry["items"].as_array().ok_or("VAULT_REGISTRY_INVALID")? {
        let id=row["localVaultId"].as_str().ok_or("VAULT_ID_INVALID")?;let Some(state)=load(store,id)? else {continue;};
        let Some(reservation)=&state.reservation else{continue;};
        let key=format!("managed.linked.plan.v1:{}",json!([state.snapshot.target_binding.instance_id,state.snapshot.target_binding.remote_vault_id,id]));
        let adopted:Option<String>=db.query_row("SELECT value FROM app_meta WHERE key=?1",[key],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        let Some(adopted)=adopted else{continue;};
        if adopted!=serde_json::to_string(&state).map_err(|e|e.to_string())?{return Err("LINKED_IMPORT_PLAN_CHANGED".into());}
        managed_vault_transfer::check(store,&state.snapshot)?;
        let mut m=store.manifest(id)?;let mut done=0;let mut changed=false;
        for entry in &state.entries {
            let key=format!("managed.linked.receipt.v1:{}",json!([state.snapshot.target_binding.instance_id,state.snapshot.target_binding.remote_vault_id,entry.note_id]));
            let receipt:Option<String>=db.query_row("SELECT value FROM app_meta WHERE key=?1",[key],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
            let Some(receipt)=receipt else{continue;};let receipt:Value=serde_json::from_str(&receipt).map_err(|_|"LINKED_IMPORT_RECEIPT_INVALID")?;
            if receipt["planId"]!=reservation["planId"]||receipt["mappingHash"]!=reservation["mappingHash"]||receipt["opId"]!=entry.op_id||receipt["noteId"]!=entry.note_id{return Err("LINKED_IMPORT_RECEIPT_INVALID".into());}
            // A later legitimate target edit is not overwritten by adoption.
            store.get(&state.snapshot.target_vault_id,&entry.note_id)?;
            let n=m.notes.get_mut(&entry.source_note_id).ok_or("LINKED_IMPORT_SOURCE_CHANGED")?;
            if n.remote["transferredTo"].is_null(){n.remote.as_object_mut().ok_or("LINKED_IMPORT_SOURCE_CHANGED")?.remove("transferPending");n.remote["transferredTo"]=json!({"localVaultId":state.snapshot.target_vault_id,"noteId":entry.note_id});changed=true;}done+=1;
        }
        if done==state.entries.len()&&m.checkpoint["transfer"]["state"]!="completed"{m.checkpoint=json!({"transfer":{"state":"completed","targetVaultId":state.snapshot.target_vault_id,"linkedPlan":true}});changed=true;}
        if changed{store.commit(m,BTreeMap::new())?;}
    }Ok(())
}

pub(crate) fn planned_wire(p:&Value)->Result<(String,Value),String>{
    let plan=&p["importPlan"]; let plan_id=plan["planId"].as_str().filter(|s|s.starts_with("ip-")&&identifier(s)).ok_or("LINKED_IMPORT_OPERATION_INVALID")?;
    let id=p["noteId"].as_str().filter(|s|s.starts_with("kn-")&&identifier(s)).ok_or("LINKED_IMPORT_OPERATION_INVALID")?;
    let content=p["content"].as_str().ok_or("LINKED_IMPORT_OPERATION_INVALID")?;
    if p["kind"]!="create"||plan["version"]!=1||!p["opId"].as_str().is_some_and(identifier)||!p["vaultId"].is_string()||!plan["mappingHash"].as_str().is_some_and(|s|s.len()==64&&s.bytes().all(|b|b.is_ascii_hexdigit()))||plan["contentSha256"]!=format!("{:x}",Sha256::digest(content.as_bytes())) {return Err("LINKED_IMPORT_OPERATION_INVALID".into());}
    crate::managed_vault_folder_sync::safe_path(plan["relativePath"].as_str().ok_or("LINKED_IMPORT_OPERATION_INVALID")?,false)?;
    Ok((format!("/v1/notes/import-plans/{plan_id}/entries/{id}"),json!({"opId":p["opId"],"vaultId":p["vaultId"],"mappingHash":plan["mappingHash"],"content":content,"contentSha256":plan["contentSha256"]})))
}
pub(crate) fn validate_document(p:&Value,d:&Value)->Result<(),String>{
    planned_wire(p)?;
    let title=p["importPlan"]["relativePath"].as_str().and_then(|s|std::path::Path::new(s).file_stem()).and_then(|s|s.to_str()).ok_or("CONTENT_ACK_INVALID")?;
    if d["title"]!=title || d["noteId"]!=p["noteId"]||d["vaultId"]!=p["vaultId"]||d["relativePath"]!=p["importPlan"]["relativePath"]||d["content"]!=p["content"]||d["deleted"]==true||!d["revision"].as_str().is_some_and(|s|!s.is_empty())||!d["title"].is_string()||!d["resources"].is_array(){return Err("CONTENT_ACK_INVALID".into());}Ok(())
}
pub(crate) fn validate_receipt(p:&Value,r:&Value)->Result<(),String>{
    if r["opId"]!=p["opId"]||r["planId"]!=p["importPlan"]["planId"]||r["mappingHash"]!=p["importPlan"]["mappingHash"]||r["noteId"]!=p["noteId"]||r["state"]!="committed"{return Err("CONTENT_ACK_INVALID".into());}validate_document(p,&r["document"])
}

#[cfg(test)]
#[path="managed_vault_linked_import_tests.rs"] mod tests;

pub(crate) fn attach_proofs(store:&Store,mut state:State,proofs:Option<Value>)->Result<State,String>{
    let Some(proofs)=proofs else{return Ok(state);};
    let _g=managed_vault::lock()?;managed_vault_transfer::check(store,&state.snapshot)?;
    let current=load(store,&state.snapshot.source_vault_id)?.ok_or("LINKED_IMPORT_PLAN_MISSING")?;
    if encoded(&current)?!=encoded(&state)?{return Err("LINKED_IMPORT_PLAN_CHANGED".into());}
    if let Some(old)=&state.wiki_proofs{if old!=&proofs{return Err("LINKED_IMPORT_PROOFS_CHANGED".into());}return Ok(state);}
    if !store.manifest(&state.snapshot.source_vault_id)?.checkpoint["transfer"].is_null(){return Err("LINKED_IMPORT_PROOFS_CHANGED".into());}
    let parsed:Vec<managed_vault_wiki_plan::SourceProof>=serde_json::from_value(proofs.clone()).map_err(|_|"LINKED_IMPORT_PROOFS_INVALID")?;
    let sources=state.snapshot.notes.iter().map(|n|Ok(SourceNote{source_note_id:n.note_id.clone(),title:n.title.clone(),folder:n.folder.clone(),historical_names:n.historical_names.clone(),content:n.content.clone().ok_or("LINKED_IMPORT_BODY_MISSING")?})).collect::<Result<Vec<_>,String>>()?;
    managed_vault_wiki_plan::validate_proofs(&sources,&parsed)?;
    state.wiki_proofs=Some(proofs);write(store,&state,false)?;Ok(state)
}
