//! Reservation awaits without DB/file locks. Captured source identity and the
//! complete source snapshot are revalidated before any local adoption.
use super::*;
pub(crate) async fn commit(state:&SharedState,store:&crate::managed_vault::Store,from:&str,to:&str,hash:&str,wiki_proofs:Option<Value>)->Result<Value,String>{
    let plan=with_db(state,|db|crate::managed_vault_linked_import::begin(db,store,from,to,hash))?;
    let Some(plan)=plan else{return with_db(state,|db|crate::managed_vault_transfer::commit(db,store,from,to,hash));};
    let plan=with_db(state,|_|crate::managed_vault_linked_import::attach_proofs(store,plan,wiki_proofs))?;
    // A retained exact reservation is not a new network intent. After a
    // crash, adoption/retry remains local-first; upload still requires the
    // captured bound scope and advertised planned capability in normal sync.
    if let Some(response)=plan.reservation.clone(){return with_db(state,|db|crate::managed_vault_linked_import::accept_and_adopt(db,store,plan,&response));}
    let source=Source::capture_expected(state,&plan.snapshot.target_binding.instance_id)?.scoped(None,Some(&plan.snapshot.target_binding.remote_vault_id))?.knowledge();
    let caps=offline::capabilities(&source,state).await?;
    let cap=&caps["knowledgeImportPlan"];
    if cap["version"]!=1||cap["exactPaths"]!=true||cap["maxPlanEntries"].as_u64().unwrap_or(0)<plan.entries.len() as u64{return Err("LINKED_IMPORT_UPGRADE_REQUIRED".into());}
    let response=if let Some(response)=&plan.reservation{response.clone()}else{
        let request=crate::managed_vault_linked_import::request(&plan);
        let (status,value)=source.mutate(state,"/v1/notes/import-plans",reqwest::Method::POST,&request).await?;
        source.check(state)?;
        if status!=200{return Err(format!("LINKED_IMPORT_PREPARE_HTTP_{status}"));}value
    };
    source.with_db(state,|db|crate::managed_vault_linked_import::accept_and_adopt(db,store,plan,&response))
}
