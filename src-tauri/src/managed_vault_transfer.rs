//! Explicit standalone -> existing bound vault adoption. Originals and a durable
//! plan survive every boundary; the ordinary outbox owns remote publication.
use crate::{db::Db,managed_vault::{self,Store,Note,Binding}};
use serde::{Serialize,Deserialize};
use serde_json::{json,Value};
use std::collections::BTreeMap;
const PLAN:&str=".luckyray/transfer-plan.json";
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct Plan {pub version:u32,pub source_vault_id:String,pub target_vault_id:String,pub target_binding:Binding,pub notes:Vec<Note>,pub folders:Vec<String>,pub snapshot_hash:String}
fn bytes<T:Serialize>(v:&T)->Result<Vec<u8>,String>{serde_json::to_vec(v).map_err(|e|e.to_string())}
pub(crate) fn fingerprint(plan:&Plan)->Result<String,String>{Ok(managed_vault::hash(&bytes(&json!([plan.version,plan.source_vault_id,plan.target_vault_id,plan.target_binding,plan.notes,plan.folders]))?))}
fn load(store:&Store,source:&str)->Result<Option<Plan>,String>{
    let path=managed_vault::guarded(&store.vault_root(source)?,PLAN)?;
    if !path.exists(){return Ok(None);}
    let p:Plan=serde_json::from_slice(&std::fs::read(path).map_err(|e|e.to_string())?).map_err(|_|"VAULT_TRANSFER_PLAN_INVALID")?;
    if p.version!=1||p.source_vault_id!=source||fingerprint(&p)?!=p.snapshot_hash{return Err("VAULT_TRANSFER_PLAN_INVALID".into());} Ok(Some(p))
}
pub(crate) fn check(store:&Store,p:&Plan)->Result<(),String>{
    let source=store.manifest(&p.source_vault_id)?;let target=store.manifest(&p.target_vault_id)?;
    if source.binding.is_some()||target.binding.as_ref()!=Some(&p.target_binding){return Err("VAULT_TRANSFER_TARGET_CHANGED".into());}
    let mut folders=std::collections::BTreeSet::new();
    for folder in &source.folders {let mut path=String::new();for part in folder.split('/') {if part.is_empty(){continue;}if !path.is_empty(){path.push('/');}path.push_str(part);folders.insert(path.clone());}}
    if folders.into_iter().collect::<Vec<_>>()!=p.folders{return Err("VAULT_TRANSFER_SOURCE_CHANGED".into());}
    let expected=p.notes.iter().map(|n|n.note_id.as_str()).collect::<std::collections::BTreeSet<_>>();
    if source.notes.values().filter(|n|!n.trashed && n.remote["transferredTo"].is_null()).any(|n|!expected.contains(n.note_id.as_str())){return Err("VAULT_TRANSFER_SOURCE_CHANGED".into());}
    for before in &p.notes {
        let current=store.get(&p.source_vault_id,&before.note_id)?;
        if current.revision!=before.revision||current.body_hash!=before.body_hash||current.content!=before.content||current.body_state!="ready"{return Err("VAULT_TRANSFER_SOURCE_CHANGED".into());}
        if current.remote["transferredTo"].is_object() && current.remote["transferredTo"]["localVaultId"]!=p.target_vault_id{return Err("VAULT_TRANSFER_ALREADY_ADOPTED_ELSEWHERE".into());}
        if current.remote["transferPending"].is_object() && current.remote["transferPending"]["localVaultId"]!=p.target_vault_id{return Err("VAULT_TRANSFER_PENDING_DIFFERENT_TARGET".into());}
    } Ok(())
}
pub(crate) fn build(db:&Db,store:&Store,source:&str,target:&str)->Result<Plan,String>{
    db.managed_recover()?;let _g=managed_vault::lock()?;
    if source==target{return Err("VAULT_TRANSFER_TARGET_INVALID".into());}
    let registry=store.list()?;
    let items=registry["items"].as_array().ok_or("VAULT_REGISTRY_INVALID")?;
    if !items.iter().any(|row|row["localVaultId"]==source)||!items.iter().any(|row|row["localVaultId"]==target){return Err("VAULT_NOT_REGISTERED".into());}
    if let Some(p)=load(store,source)?{if p.target_vault_id!=target{return Err("VAULT_TRANSFER_PENDING_DIFFERENT_TARGET".into());}check(store,&p)?;return Ok(p);}
    let m=store.manifest(source)?;if m.binding.is_some(){return Err("VAULT_TRANSFER_SOURCE_NOT_STANDALONE".into());}
    let binding=store.manifest(target)?.binding.ok_or("VAULT_BINDING_REQUIRED")?;
    let mut notes=Vec::new();for n in m.notes.values().filter(|n|!n.trashed && n.remote["transferredTo"].is_null()){notes.push(store.get(source,&n.note_id)?);}
    let mut folders=std::collections::BTreeSet::new();
    for folder in &m.folders {let mut path=String::new();for part in folder.split('/') {if part.is_empty(){continue;}if !path.is_empty(){path.push('/');}path.push_str(part);folders.insert(path.clone());}}
    let target_manifest=store.manifest(target)?;
    use unicode_normalization::UnicodeNormalization;
    let key=|v:&str|v.nfc().flat_map(char::to_uppercase).collect::<String>();
    for folder in &folders {
        crate::managed_vault_folder_sync::safe_path(folder,false)?;
        if target_manifest.folders.iter().any(|existing|key(existing)==key(folder)&&existing!=folder)
            || target_manifest.notes.values().filter(|n|!n.trashed).any(|n|key(folder)==key(&n.relative_path)||key(folder).starts_with(&format!("{}/",key(&n.relative_path)))) {
            return Err("VAULT_TRANSFER_FOLDER_COLLISION".into());
        }
    }
    let mut p=Plan{version:1,source_vault_id:source.into(),target_vault_id:target.into(),target_binding:binding,notes,folders:folders.into_iter().collect(),snapshot_hash:String::new()};p.snapshot_hash=fingerprint(&p)?;Ok(p)
}
pub(crate) fn blocked(_db:&Db,p:&Plan)->usize {p.notes.iter().filter(|n| n.body_state!="ready" || n.content.is_none() || n.content.as_ref().is_some_and(|s|s.len()>4*1024*1024) || n.title.len()>240 || !crate::db::content_db::fresh_title_valid(&n.title) || n.folder.len()>4096).count()}
pub(crate) fn preview(db:&Db,store:&Store,source:&str,target:&str)->Result<Value,String>{
    let p=if let Some(state)=crate::managed_vault_linked_import::load(store,source)? {
        if state.snapshot.target_vault_id==target && check(store,&state.snapshot).is_ok(){state.snapshot}
        else if store.manifest(source)?.checkpoint["transfer"].is_null(){build(db,store,source,target)?}
        else{return Err("VAULT_TRANSFER_SOURCE_CHANGED".into());}
    }else{build(db,store,source,target)?};let count=blocked(db,&p);
    Ok(json!({"parseInputs":p.notes.iter().map(|n|json!({"sourceNoteId":n.note_id,"sourceSha256":managed_vault::hash(n.content.as_deref().unwrap_or("").as_bytes()),"content":n.content})).collect::<Vec<_>>(),"requiresConnection":p.notes.iter().any(|n|n.content.as_deref().is_some_and(|s|s.contains("[["))),"snapshotHash":p.snapshot_hash,"sourceVaultId":source,"targetVaultId":target,"noteCount":p.notes.len(),"folderCount":p.folders.len(),"blockedCount":count,"incompleteCount":p.notes.iter().filter(|n|n.content.as_deref().is_some_and(|body|!db.managed_transfer_body_portable(body))).count(),"canCommit":count==0&&!p.notes.is_empty(),"pendingRecovery":store.vault_root(source)?.join(PLAN).exists()}))
}
pub(crate) fn commit(db:&Db,store:&Store,source:&str,target:&str,expected:&str)->Result<Value,String>{
    let p=build(db,store,source,target)?;
    if p.snapshot_hash!=expected{return Err("VAULT_TRANSFER_SOURCE_CHANGED".into());}
    if blocked(db,&p)>0{return Err("VAULT_TRANSFER_RESOURCES_INCOMPLETE".into());}
    {
        let _g=managed_vault::lock()?;check(store,&p)?;
        if load(store,source)?.is_none(){
            let mut m=store.manifest(source)?;
            m.checkpoint=json!({"transfer":{"state":"pending","targetVaultId":target}});
            for before in &p.notes {let n=m.notes.get_mut(&before.note_id).ok_or("VAULT_TRANSFER_SOURCE_CHANGED")?;if !n.remote.is_object(){n.remote=json!({});}n.remote["transferPending"]=json!({"localVaultId":target});}
            let mut writes=BTreeMap::new();writes.insert(PLAN.into(),String::from_utf8(bytes(&p)?).map_err(|e|e.to_string())?);store.commit(m,writes)?;
        }
    }
    let mut folders=p.folders.clone();folders.sort_by_key(|p|(p.matches('/').count(),p.clone()));
    for folder in folders {if folder.is_empty(){continue;}
        let exists={let _g=managed_vault::lock()?;store.manifest(target)?.folders.iter().any(|f|f==&folder)};
        if !exists {let (parent,name)=folder.rsplit_once('/').unwrap_or(("",&folder));db.managed_folder_create(store,target,name,parent)?;}
    }
    let mut transferred=0;
    for before in &p.notes {
        {let _g=managed_vault::lock()?;check(store,&p)?;
            let original=store.get(source,&before.note_id)?;
            if original.remote["transferredTo"].is_object(){
                let target_note=original.remote["transferredTo"]["noteId"].as_str().ok_or("VAULT_TRANSFER_TARGET_MISSING")?;
                store.get(target,target_note)?;
                transferred+=1;continue;
            }
        }
        let stable=format!("managed-transfer:{}:{}",source,before.note_id);
        let source_hash=managed_vault::hash(&bytes(before)?);
        let initial=json!({"pinned":before.pinned,"favorite":before.favorite,"archived":before.archived,"createdAt":before.created_at,"historicalNames":before.historical_names,"transferSource":{"localVaultId":source,"noteId":before.note_id,"sourceHash":source_hash}});
        let imported=db.managed_import_bound_with_metadata(store,target,&stable,&source_hash,&before.title,before.content.as_deref().ok_or("VAULT_TRANSFER_BODY_MISSING")?,before.tags.clone(),&before.folder,&initial)?;
        let _g=managed_vault::lock()?;check(store,&p)?;
        // The target is already journaled and queued. Preserve local presentation
        // metadata, then mark only this exact original as redirected/read-only.
        let mut sm=store.manifest(source)?;let n=sm.notes.get_mut(&before.note_id).ok_or("VAULT_TRANSFER_SOURCE_CHANGED")?;
        if !n.remote.is_object(){n.remote=json!({});}n.remote.as_object_mut().unwrap().remove("transferPending");n.remote["transferredTo"]=json!({"localVaultId":target,"noteId":imported.note_id});store.commit(sm,BTreeMap::new())?;transferred+=1;
    }
    {let _g=managed_vault::lock()?;check(store,&p)?;let mut m=store.manifest(source)?;m.checkpoint=json!({"transfer":{"state":"completed","targetVaultId":target}});store.commit(m,BTreeMap::new())?;store.select(target)?;}
    Ok(json!({"sourceVaultId":source,"targetVaultId":target,"transferredCount":transferred,"syncState":"pending"}))
}
