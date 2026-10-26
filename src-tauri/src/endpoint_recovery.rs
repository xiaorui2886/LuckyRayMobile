//! Explicit same-Desktop endpoint recovery. No re-pair, cache reset, credential
//! replacement, port scan, new certificate trust or implicit connect opt-in.
mod contract;
mod transport;
use crate::{
    connection_controls,
    secure::{SecureCredentialStore, SecureCredentialStoreImpl},
    with_db, SharedState,
};
use contract::Owner;
pub(crate) use contract::RecoveryBook;
use serde_json::{json, Value};
use tauri::{Emitter, State};

fn owner(state: &SharedState) -> Result<Owner, String> {
    with_db(state, |db| {
        let p = db
            .paired()
            .map_err(|_| "ENDPOINT_STATE_UNAVAILABLE")?
            .ok_or("ENDPOINT_NOT_PAIRED")?;
        Ok(Owner {
            instance: p.instance_id,
            fingerprint: p.fingerprint,
            base_url: p.base_url,
            paired_at: p.paired_at,
            display_name: p.display_name,
        })
    })
}

#[tauri::command]
pub(crate) fn conn_endpoint_prepare(
    state: State<'_, SharedState>,
    payload: String,
) -> Result<contract::Preview, String> {
    let (lifecycle, _) = connection_controls(&state);
    let current = owner(&state)?;
    lifecycle
        .recovery
        .prepare(&payload, current, lifecycle.observe())
        .map_err(str::to_owned)
}

#[tauri::command]
pub(crate) async fn conn_endpoint_cancel(
    state: State<'_, SharedState>,
    prepare_id: String,
) -> Result<Value, String> {
    let (lifecycle, _) = connection_controls(&state);
    let mut outcome = lifecycle.recovery.cancel(&prepare_id);
    // Commit itself is synchronous SQLite work. A late cancel reports that
    // result, never "cancelled" when an address has already been committed.
    for _ in 0..25 {
        if outcome != "commit_in_progress" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        outcome = lifecycle.recovery.cancel(&prepare_id);
    }
    Ok(json!({"status":outcome}))
}

#[tauri::command]
pub(crate) async fn conn_endpoint_update(
    state: State<'_, SharedState>,
    app: tauri::AppHandle,
    prepare_id: String,
) -> Result<Value, String> {
    let result = update(&state, &prepare_id, &SecureCredentialStoreImpl)
        .await
        .map_err(str::to_owned);
    if result.is_ok() {
        // App/Home uses event-driven conn_state, not polling. In particular,
        // retiring an already stopped worker emits no status on its own.
        // Publish the CURRENT authoritative snapshot, never fake connected.
        let (_, stream) = connection_controls(&state);
        let _ = app.emit("lr:ws-status", stream.snapshot());
    }
    result
}

async fn update<S: SecureCredentialStore + ?Sized>(
    state: &SharedState,
    id: &str,
    store: &S,
) -> Result<Value, &'static str> {
    let (lifecycle, eventstream) = connection_controls(state);
    let p = lifecycle.recovery.get(id)?;
    p.start()?;
    let _gate = lifecycle.lock().await;
    let result = async {
        p.check()?;
        if lifecycle.observe() != p.epoch
            || owner(state).map_err(|_| "ENDPOINT_SOURCE_CHANGED")? != p.owner
        {
            return Err("ENDPOINT_SOURCE_CHANGED");
        }
        // Load exactly this paired instance. No legacy SQLite fallback,
        // credential migration, other profile or another application's cache.
        let credential = store
            .load_desktop_credential(&p.owner.instance)
            .map_err(|_| "ENDPOINT_CREDENTIAL_UNAVAILABLE")?
            .ok_or("ENDPOINT_CREDENTIAL_UNAVAILABLE")?;
        let verify = transport::verify(&p.owner, &p.candidate, &credential, || {
            p.check()?;
            if lifecycle.observe() != p.epoch {
                return Err("ENDPOINT_SOURCE_CHANGED");
            }
            Ok(())
        });
        tokio::select! {
            result=verify => result?,
            _=p.cancelled.notified() => return Err("ENDPOINT_CANCELLED_OR_STALE"),
        }
        if lifecycle.observe() != p.epoch
            || owner(state).map_err(|_| "ENDPOINT_SOURCE_CHANGED")? != p.owner
        {
            return Err("ENDPOINT_SOURCE_CHANGED");
        }
        p.begin_commit()?;
        // This is a narrow CAS, not upsert_paired: every cache, grant,
        // credential and paired_at value remains untouched.
        with_db(state, |db| {
            db.update_paired_endpoint(
                &p.owner.instance,
                &p.owner.fingerprint,
                &p.owner.base_url,
                &p.owner.paired_at,
                &p.candidate,
            )
        })
        .map_err(|e| {
            if e == "ENDPOINT_SOURCE_CHANGED" {
                "ENDPOINT_SOURCE_CHANGED"
            } else {
                "ENDPOINT_SAVE_UNCONFIRMED"
            }
        })?;
        lifecycle.invalidate();
        p.applied();
        // Retire old transport ownership after the validated durable switch.
        // This is NOT ws_stop, which would change the user's connect preference.
        crate::lsh_carrier::stop();
        crate::services_hints::retire_managed();
        eventstream.stop().await;
        Ok(json!({"status":"updated","baseUrl":p.candidate,"requiresReconnect":true}))
    }
    .await;
    if result.is_err() {
        p.fail();
    }
    result
}
