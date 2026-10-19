// Companion Services V1 — Rust-owned hint stream (Issue #77 REPAIR-R2/R3).
//
// Desktop `.3` exposes `/v1/services/events/stream` as a WEBSOCKET, not a JSON
// GET. This module owns that subscription in Rust so that:
//
//   * the bearer exists ONLY here and in the `Authorization` header — it never
//     enters JS, a URL or a query string;
//   * the certificate pin is the SAME pinned config the rest of pairing uses;
//   * the expected Desktop owner is captured and re-proven while the worker
//     lives, so a Desktop switch retires the worker;
//   * hints are typed `EventHint` values and are WAKE-UP TARGETS ONLY — the
//     durable cursor remains the truth and is never advanced from a hint;
//   * the foundation `/v1/events` worker is untouched (separate task);
//   * #72 LSH is untouched.
//
// MANAGED STATE TYPE (P1-H1): exactly ONE type is registered and requested
// everywhere — `ManagedHintState` = `Arc<HintStreamState>`. Tauri's managed-state
// lookup is type-based, so mixing a bare `HintStreamState` with an
// `Arc<HintStreamState>` would make a command fail before the worker started.
//
// WORKER STATE MACHINE (P1-H2): `start` reports an explicit outcome
// (Started / AlreadyRunning) instead of an ambiguous Option, and every worker
// exit path finishes ITS OWN generation only. Cleanup is generation-conditional,
// so a stale worker cannot clear a newer one and a later start can reconnect.
//
// RETIREMENT (P1-H3): `retire()` is called from the native connection-lifecycle
// boundaries (`do_pair` replacement, `ws_stop`, `conn_revoke`), never left to
// the UI, so an authenticated old-bearer socket cannot outlive a disconnect or
// a credential-ownership transition.

use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;
use tauri::{Manager, State};

use crate::content::expected_gateway;

/// Bounded hint buffer: hints are wake-up targets, so a small ring is enough
/// and a misbehaving peer can never grow Mobile memory.
pub(crate) const MAX_BUFFERED_HINTS: usize = 64;

/// Typed hint kinds the canonical `.3` stream may carry. Anything else fails
/// closed rather than being forwarded as an opaque blob.
const HINT_KINDS: &[&str] = &[
    "servicesChanged",
    "materialChanged",
    "knowledgeChanged",
    "ingestChanged",
    "lshStateChanged",
];

/// The managed state type. ONE type everywhere (see the module note).
pub type ManagedHintState = Arc<HintStreamState>;

/// A process-wide handle to the managed hint state.
///
/// The native connection-lifecycle paths (`do_pair`, `ws_stop`, `conn_revoke`)
/// do not all receive a `State` handle, so retirement is exposed through this
/// ONE process-global. It is set by `app.manage(...)` registration and points at
/// the SAME `Arc` the commands use, so there is still exactly one state object.
static MANAGED: std::sync::OnceLock<ManagedHintState> = std::sync::OnceLock::new();

/// Register the process-wide handle. Called once during setup, with the same
/// `Arc` that is handed to Tauri's managed-state table.
pub fn install_managed(state: ManagedHintState) {
    let _ = MANAGED.set(state);
}

fn managed() -> Option<&'static ManagedHintState> {
    MANAGED.get()
}

/// Retire the hint scope from a native lifecycle path.
///
/// Safe to call when no state was installed (e.g. unit tests): it is a no-op,
/// never a panic.
pub fn retire_managed() {
    if let Some(state) = managed() {
        state.retire();
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct HintRecord {
    pub generation: u64,
    pub hint: Value,
}

/// What `services_hints_start` did, reported explicitly so TS can distinguish
/// "a live worker exists" from "a task was queued".
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum StartOutcome {
    Started { generation: u64 },
    AlreadyRunning { generation: u64 },
}

impl StartOutcome {
    pub fn generation(&self) -> u64 {
        match self {
            StartOutcome::Started { generation } => *generation,
            StartOutcome::AlreadyRunning { generation } => *generation,
        }
    }
}

/// Coarse worker phase, exposed so TS can tell a live stream from a dead one.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HintPhase {
    Stopped,
    Starting,
    Running,
}

#[derive(Debug, Clone, Serialize)]
pub struct HintStatus {
    pub generation: u64,
    pub phase: HintPhase,
    pub owner: String,
    pub connect_failures: u64,
}

#[derive(Default)]
pub struct HintStreamState {
    inner: Mutex<HintStreamInner>,
    /// The live cancellation sender for the CURRENT worker generation.
    ///
    /// Retiring or replacing a generation drops/replaces this sender, which
    /// makes the worker's `select!` cancellation branch fire immediately — so
    /// the authenticated socket is closed promptly instead of waiting out the
    /// 30s read timeout (P1-H4). The sender carries the generation so a stale
    /// worker can never be cancelled by (or cancel) another generation.
    cancel: Mutex<Option<(u64, tokio::sync::watch::Sender<bool>)>>,

    /// Test-only pause hook for the install window (see
    /// `install_cancellation_if_current`). Never populated in production.
    #[cfg(test)]
    #[allow(clippy::type_complexity)]
    pub(crate) install_gate: Mutex<Option<fn()>>,
}

#[derive(Default)]
struct HintStreamInner {
    /// Bumped on every NEW scope. A worker whose generation is not current is
    /// stale: it can neither publish nor touch the shared state.
    generation: u64,
    hints: Vec<HintRecord>,
    /// The owner the live worker belongs to; empty when no worker runs.
    owner: String,
    phase: HintPhaseValue,
    connect_failures: u64,
}

#[derive(Default, Clone, Copy, PartialEq, Eq)]
enum HintPhaseValue {
    #[default]
    Stopped,
    Starting,
    Running,
}

impl From<HintPhaseValue> for HintPhase {
    fn from(value: HintPhaseValue) -> Self {
        match value {
            HintPhaseValue::Stopped => HintPhase::Stopped,
            HintPhaseValue::Starting => HintPhase::Starting,
            HintPhaseValue::Running => HintPhase::Running,
        }
    }
}

/// Outcome of asking the state to begin a worker scope.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum BeginOutcome {
    /// A fresh generation for this owner; the caller must spawn the worker.
    Started(u64),
    /// A live worker already serves this owner; nothing to spawn.
    AlreadyRunning(u64),
}

impl HintStreamState {
    pub(crate) fn status(&self) -> HintStatus {
        match self.inner.lock() {
            Ok(inner) => HintStatus {
                generation: inner.generation,
                phase: inner.phase.into(),
                owner: inner.owner.clone(),
                connect_failures: inner.connect_failures,
            },
            Err(_) => HintStatus {
                generation: 0,
                phase: HintPhase::Stopped,
                owner: String::new(),
                connect_failures: 0,
            },
        }
    }

    /// Drop everything and retire the current worker scope (identity change,
    /// revoke, re-pair, disconnect). Bumping the generation makes any in-flight
    /// worker's writes stale, so a retiring worker can never publish — no need
    /// to wait for its socket read to time out.
    pub fn retire(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.generation = inner.generation.wrapping_add(1);
            inner.hints.clear();
            inner.owner.clear();
            inner.phase = HintPhaseValue::Stopped;
        }
        // Wake the CURRENT worker immediately so it closes its socket now
        // rather than at the next read timeout.
        self.cancel_current();
    }

    /// Fire the cancellation for whichever worker generation is live.
    ///
    /// Takes the sender out of the slot so a late second call is a no-op and a
    /// worker that already exited cannot be signalled twice.
    fn cancel_current(&self) {
        if let Ok(mut guard) = self.cancel.lock() {
            if let Some((_generation, sender)) = guard.take() {
                let _ = sender.send(true);
            }
        }
    }

    /// Install a fresh cancellation channel for `generation`, cancelling any
    /// PREVIOUS generation first. Returns the receiver the worker selects on.
    ///
    /// Because the slot records the generation, replacing A with B cancels A and
    /// leaves B's channel untouched.
    /// Install the cancellation channel for `generation` ONLY if it is still
    /// the current, non-stopped generation (P1-H7).
    ///
    /// This closes the retire-before-install race: a worker whose generation was
    /// retired while its task sat queued must NOT be able to install a fresh
    /// uncancelled sender and then perform an authenticated WSS handshake after
    /// the authority was already retired. Refusal happens BEFORE any dial, so
    /// the caller can return without touching the network.
    ///
    /// Lock ordering: `inner` is taken first and released before `cancel` is
    /// taken, so this is compatible with `retire()` (which also takes `inner`,
    /// releases it, then calls `cancel_current`). No lock is ever held while the
    /// other is acquired, so no deadlock is possible.
    /// True when `generation` is the current, non-stopped generation.
    fn generation_is_live(&self, generation: u64) -> bool {
        match self.inner.lock() {
            Ok(inner) => inner.generation == generation && inner.phase != HintPhaseValue::Stopped,
            Err(_) => false,
        }
    }

    /// Remove the cancellation slot ONLY if it belongs to `generation`.
    ///
    /// Generation-matched cleanup: a stale generation can never remove or
    /// cancel a newer worker's sender (P1-H8).
    fn remove_slot_if_generation(&self, generation: u64) {
        if let Ok(mut guard) = self.cancel.lock() {
            let matches = guard.as_ref().map(|(g, _)| *g == generation).unwrap_or(false);
            if matches {
                // Dropping the sender is safe: the receiver is being discarded
                // by the caller, and no retire can signal a slot we own.
                let _ = guard.take();
            }
        }
    }

    /// Install the cancellation channel for `generation` using a TWO-PHASE
    /// protocol, so a `retire()` landing in the window between the current-state
    /// check and the slot write cannot be missed (P1-H8).
    ///
    /// Phase 1 pre-check → install sender → phase 2 re-check. If the re-check
    /// fails, this generation's own sender is removed and `None` is returned, so
    /// the caller never constructs a WSS dial.
    ///
    /// Why this is sufficient: once the sender IS installed, any later native
    /// `retire()` finds a populated slot and signals it, which wakes the
    /// worker's dial/read `select!`. So the only dangerous window is
    /// "retire after the pre-check, before the install", and the phase-2 check
    /// catches exactly that.
    ///
    /// Lock ordering stays deterministic and deadlock-free: `inner` is acquired
    /// and released, then `cancel` is acquired and released, then `inner` again.
    /// The two locks are never held simultaneously.
    pub(crate) fn install_cancellation_if_current(
        &self,
        generation: u64,
    ) -> Option<tokio::sync::watch::Receiver<bool>> {
        // Phase 1 — pre-check.
        if !self.generation_is_live(generation) {
            return None;
        }

        // Test-only gate: lets a test pause the install EXACTLY between the
        // pre-check and the slot write, which is the window P1-H8 is about.
        // In production this compiles to nothing.
        #[cfg(test)]
        if let Some(hook) = self.install_gate.lock().ok().and_then(|g| *g) {
            hook();
        }

        // Phase 2 — install the sender for this generation only.
        let (sender, receiver) = tokio::sync::watch::channel(false);
        {
            let mut guard = match self.cancel.lock() {
                Ok(guard) => guard,
                Err(_) => return None,
            };
            if let Some((previous, _old)) = guard.as_ref() {
                // A slot owned by another generation means we lost the race and
                // must not disturb the live worker.
                if *previous != generation {
                    return None;
                }
            }
            *guard = Some((generation, sender));
        }

        // Phase 3 — post-install re-check. `retire()` may have run between the
        // pre-check and the install; that retire saw an empty slot and could not
        // signal anything, so staleness is detected here instead.
        if !self.generation_is_live(generation) {
            // Generation-matched cleanup: only OUR sender is removed.
            self.remove_slot_if_generation(generation);
            return None;
        }

        Some(receiver)
    }



}

#[cfg(test)]
impl HintStreamState {
    /// Install a one-shot pause hook that runs between the pre-check and the
    /// slot write. Used to make the P1-H8 window deterministic.
    pub(crate) fn set_install_gate(&self, hook: fn()) {
        if let Ok(mut guard) = self.install_gate.lock() {
            *guard = Some(hook);
        }
    }

    pub(crate) fn clear_install_gate(&self) {
        if let Ok(mut guard) = self.install_gate.lock() {
            *guard = None;
        }
    }
}

#[allow(dead_code)]
impl HintStreamState {
    /// The generation currently recorded in the cancellation slot, if any.
    /// Used by tests to prove a stale install did not touch a newer worker.
    pub(crate) fn installed_cancellation_generation(&self) -> Option<u64> {
        self.cancel.lock().ok().and_then(|guard| guard.as_ref().map(|(g, _)| *g))
    }

    /// Retire ONLY if `generation` is still the current one.
    ///
    /// This is the worker-side cleanup: a stale worker finishing its own
    /// generation must never retire (and therefore cancel) a newer one
    /// (P1-H5). Native lifecycle code keeps using `retire()`, which
    /// intentionally retires the CURRENT authority.
    /// Retire the scope ONLY for the named owner + generation (P1-G1H-STOP).
    ///
    /// Client-originated stop must be scope-qualified: after the process-global
    /// worker was replaced by another owner, a stale client's stop call is a
    /// no-op with ZERO state mutation and ZERO cancellation signal.
    ///
    /// The ownership + generation + live-phase checks happen under ONE `inner`
    /// acquisition, and the cancellation signal is generation-matched against
    /// the slot's own record, so there is no separate status->stop TOCTOU and a
    /// stale caller can never cancel a newer owner's worker.
    pub(crate) fn retire_if_current_scope(
        &self,
        expected_owner: &str,
        expected_generation: u64,
    ) -> bool {
        let retired = match self.inner.lock() {
            Ok(mut inner) => {
                if inner.phase == HintPhaseValue::Stopped
                    || inner.owner != expected_owner
                    || inner.generation != expected_generation
                {
                    // Mismatch: no-op. The live scope (possibly a newer owner)
                    // is left completely untouched.
                    return false;
                }
                inner.generation = inner.generation.wrapping_add(1);
                inner.hints.clear();
                inner.owner.clear();
                inner.phase = HintPhaseValue::Stopped;
                true
            }
            Err(_) => false,
        };
        if retired {
            // The cancellation signal is generation-matched: only the slot that
            // belongs to the scope we just retired is signalled.
            if let Ok(mut guard) = self.cancel.lock() {
                let matches = guard
                    .as_ref()
                    .map(|(g, _)| *g == expected_generation)
                    .unwrap_or(false);
                if matches {
                    if let Some((_g, sender)) = guard.take() {
                        let _ = sender.send(true);
                    }
                }
            }
        }
        retired
    }

    pub(crate) fn retire_if_current(&self, generation: u64) -> bool {
        let retired = match self.inner.lock() {
            Ok(mut inner) => {
                if inner.generation != generation {
                    false
                } else {
                    inner.generation = inner.generation.wrapping_add(1);
                    inner.hints.clear();
                    inner.owner.clear();
                    inner.phase = HintPhaseValue::Stopped;
                    true
                }
            }
            Err(_) => false,
        };
        if retired {
            // Only the generation we actually retired may be cancelled.
            if let Ok(mut guard) = self.cancel.lock() {
                let matches = guard.as_ref().map(|(g, _)| *g == generation).unwrap_or(false);
                if matches {
                    if let Some((_g, sender)) = guard.take() {
                        let _ = sender.send(true);
                    }
                }
            }
        }
        retired
    }

    /// True when the worker for `generation` has been signalled to stop.
    pub(crate) fn is_cancelled(receiver: &tokio::sync::watch::Receiver<bool>) -> bool {
        *receiver.borrow()
    }

    /// Hints buffered for the CURRENT generation only.
    /// Drain the buffer ONLY for the named owner and generation.
    ///
    /// Ownership check and buffer take happen under ONE `inner` acquisition, so
    /// this is atomic: a client that lost the global worker to another owner
    /// gets `[]` and the live worker's buffered records are left completely
    /// untouched (P1-G1H-DRAIN). Filtering after a destructive global take was
    /// the defect — the records were already gone by the time they were dropped.
    pub(crate) fn drain_if_current(
        &self,
        expected_owner: &str,
        expected_generation: u64,
    ) -> Vec<HintRecord> {
        let mut inner = match self.inner.lock() {
            Ok(guard) => guard,
            Err(_) => return Vec::new(),
        };
        // Refuse BEFORE any mutation when this is not the live scope, or the
        // worker is not actually running.
        if inner.phase == HintPhaseValue::Stopped
            || inner.owner != expected_owner
            || inner.generation != expected_generation
        {
            return Vec::new();
        }
        // Exact match: this caller owns the live scope, so it may take the
        // current generation's records.
        let current = inner.generation;
        inner.hints.retain(|h| h.generation == current);
        std::mem::take(&mut inner.hints)
    }

    /// Begin (or rejoin) a worker scope for `owner`.
    ///
    /// * same owner + live worker -> `AlreadyRunning` with the SAME generation
    ///   (idempotent success, never an error);
    /// * different owner, or a stopped/dead worker -> retire the old scope and
    ///   start a new generation.
    pub(crate) fn begin(&self, owner: &str) -> BeginOutcome {
        let mut inner = match self.inner.lock() {
            Ok(guard) => guard,
            Err(_) => return BeginOutcome::Started(0),
        };
        let live = inner.phase != HintPhaseValue::Stopped;
        if live && inner.owner == owner {
            return BeginOutcome::AlreadyRunning(inner.generation);
        }
        inner.generation = inner.generation.wrapping_add(1);
        inner.hints.clear();
        inner.owner = owner.to_string();
        inner.phase = HintPhaseValue::Starting;
        let generation = inner.generation;
        drop(inner);
        // A new scope replaces the old worker: cancel it immediately.
        self.cancel_current();
        BeginOutcome::Started(generation)
    }

    /// Mark the worker for `generation` as connected.
    pub(crate) fn mark_running(&self, generation: u64) -> bool {
        let mut inner = match self.inner.lock() {
            Ok(guard) => guard,
            Err(_) => return false,
        };
        if inner.generation != generation {
            return false; // a newer scope owns the state now
        }
        inner.phase = HintPhaseValue::Running;
        true
    }

    /// Finish a worker for `generation`.
    ///
    /// Generation-conditional: a stale worker exiting NEVER clears a newer
    /// worker's state, and it never bumps the generation (that would retire the
    /// new worker too).
    pub(crate) fn finish(&self, generation: u64, count_failure: bool) -> bool {
        let mut inner = match self.inner.lock() {
            Ok(guard) => guard,
            Err(_) => return false,
        };
        if inner.generation != generation {
            return false;
        }
        inner.phase = HintPhaseValue::Stopped;
        inner.hints.clear();
        inner.owner.clear();
        if count_failure {
            inner.connect_failures = inner.connect_failures.wrapping_add(1);
        }
        true
    }

    pub(crate) fn publish(&self, generation: u64, hint: Option<Value>) -> bool {
        let mut inner = match self.inner.lock() {
            Ok(guard) => guard,
            Err(_) => return false,
        };
        // A retired generation, or a worker that is not actually live, cannot
        // publish. This is what makes an immediate `retire()` sufficient
        // without waiting for the socket read to time out.
        if inner.generation != generation || inner.phase == HintPhaseValue::Stopped {
            return false;
        }
        if let Some(hint) = hint {
            if inner.hints.len() >= MAX_BUFFERED_HINTS {
                inner.hints.remove(0);
            }
            inner.hints.push(HintRecord { generation, hint });
        }
        true
    }

    pub(crate) fn is_current(&self, generation: u64) -> bool {
        self.inner
            .lock()
            .map(|i| i.generation == generation && i.phase != HintPhaseValue::Stopped)
            .unwrap_or(false)
    }
}

/// Validate one hint line into a typed `EventHint`.
///
/// `Ok(Some(_))` for a well-formed canonical hint; `Err(())` for a MALFORMED
/// hint, which fails closed (the caller stops the worker).
pub fn parse_hint(text: &str) -> Result<Option<Value>, ()> {
    let value: Value = serde_json::from_str(text).map_err(|_| ())?;
    let kind = value.get("kind").and_then(Value::as_str).ok_or(())?;
    if !HINT_KINDS.contains(&kind) {
        return Err(());
    }
    match kind {
        "servicesChanged" => {
            value.get("permissionRevision").and_then(Value::as_u64).ok_or(())?;
        }
        "materialChanged" => {
            value.get("cursor").and_then(Value::as_str).ok_or(())?;
        }
        "knowledgeChanged" => {
            value.get("vaultId").and_then(Value::as_str).ok_or(())?;
            value.get("cursor").and_then(Value::as_str).ok_or(())?;
        }
        "ingestChanged" => {
            value.get("jobId").and_then(Value::as_str).ok_or(())?;
        }
        "lshStateChanged" => {}
        _ => return Err(()),
    }
    Ok(Some(value))
}

// ---------------------------------------------------------------------------
// Commands. Every command requests the SAME managed type: ManagedHintState.
// ---------------------------------------------------------------------------

/// Drain hints ONLY for the named owner + generation.
///
/// Owner/generation/live checks and the buffer take are atomic in native state,
/// so a client that lost the worker to another owner can never remove that
/// owner's buffered records (P1-G1H-DRAIN).
#[tauri::command]
pub fn services_hints_state(
    state: State<'_, ManagedHintState>,
    instance: String,
    generation: u64,
) -> Vec<HintRecord> {
    state.drain_if_current(&instance, generation)
}

#[tauri::command]
pub fn services_hints_status(state: State<'_, ManagedHintState>) -> HintStatus {
    state.status()
}

/// Client-originated stop, SCOPE-QUALIFIED (P1-G1H-STOP).
///
/// Retires the hint scope only when `instance` + `generation` exactly match the
/// live worker. A stale client (one that lost the worker to another owner)
/// gets `false` with zero mutation and zero cancellation — it can never stop
/// another owner's worker.
///
/// Native lifecycle/security transitions (disconnect, revoke, re-pair,
/// db_reset, db_reset_full) intentionally retire the CURRENT authority via
/// `retire_managed()` and remain unconditional.
#[tauri::command]
pub fn services_hints_stop(
    state: State<'_, ManagedHintState>,
    instance: String,
    generation: u64,
) -> bool {
    state.retire_if_current_scope(&instance, generation)
}

/// Start (or rejoin) the hint worker for `instance`.
///
/// Returns `Started` when a new worker was spawned and `AlreadyRunning` when a
/// live worker already served this owner — both are SUCCESS. A dial failure is
/// reported through `services_hints_status` as `stopped`, so TS can degrade to
/// polling instead of assuming hints are live just because the call returned.
#[tauri::command]
pub async fn services_hints_start(
    app: tauri::AppHandle,
    shared: State<'_, crate::SharedState>,
    hints: State<'_, ManagedHintState>,
    instance: String,
) -> Result<StartOutcome, String> {
    if instance.is_empty() {
        return Err("SOURCE_CHANGED".to_string());
    }
    // Capture the expected owner + pinned gateway BEFORE the worker starts, so a
    // wrong/absent Desktop never opens a socket.
    let gateway = expected_gateway(&shared, &instance).map_err(|_| "SOURCE_CHANGED".to_string())?;

    let generation = match hints.begin(&instance) {
        BeginOutcome::AlreadyRunning(generation) => {
            return Ok(StartOutcome::AlreadyRunning { generation })
        }
        BeginOutcome::Started(generation) => generation,
    };

    let url = gateway.services_hint_url();
    let authorization = gateway.ws_authorization();
    let fingerprint = gateway.pinned_fingerprint().to_string();
    let owner = instance.clone();

    let shared_for_task = app.state::<crate::SharedState>().inner().clone();
    let state_for_task = app.state::<ManagedHintState>().inner().clone();

    tauri::async_runtime::spawn(async move {
        crate::eventstream::run_hint_worker(
            url,
            authorization,
            fingerprint,
            state_for_task,
            generation,
            shared_for_task,
            owner,
        )
        .await;
    });

    Ok(StartOutcome::Started { generation })
}

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // P1-H1 — one managed type everywhere
    // -----------------------------------------------------------------------

    #[test]
    fn every_command_requests_the_same_managed_type() {
        let source = include_str!("services_hints.rs");
        for command in [
            "pub fn services_hints_state",
            "pub fn services_hints_status",
            "pub fn services_hints_stop",
            "pub async fn services_hints_start",
        ] {
            let at = source.find(command).expect("command present");
            let head = &source[at..(at + 500).min(source.len())];
            let signature = &head[..head.find('{').unwrap_or(head.len())];
            assert!(
                signature.contains("ManagedHintState"),
                "{command} must request ManagedHintState, found: {signature}"
            );
            assert!(
                !signature.contains("State<'_, HintStreamState>"),
                "{command} must not request a bare HintStreamState"
            );
        }
    }

    #[test]
    fn setup_registers_the_same_managed_type() {
        let lib = include_str!("lib.rs");
        assert!(
            lib.contains("app.manage(std::sync::Arc::new(services_hints::HintStreamState::default()))")
                || lib.contains("services_hints::ManagedHintState"),
            "setup must manage Arc<HintStreamState>"
        );
    }

    // -----------------------------------------------------------------------
    // P1-H2 — explicit worker state machine
    // -----------------------------------------------------------------------

    #[test]
    fn a_second_start_for_the_same_owner_is_already_running_not_an_error() {
        let state = HintStreamState::default();
        assert_eq!(state.begin("desktop-a"), BeginOutcome::Started(1));
        state.mark_running(1);
        assert_eq!(
            state.begin("desktop-a"),
            BeginOutcome::AlreadyRunning(1),
            "idempotent success with the current generation"
        );
    }

    #[test]
    fn a_different_owner_retires_the_old_generation_and_starts_a_new_one() {
        let state = HintStreamState::default();
        assert_eq!(state.begin("desktop-a"), BeginOutcome::Started(1));
        state.mark_running(1);
        assert_eq!(state.begin("desktop-b"), BeginOutcome::Started(2));
        assert!(!state.is_current(1), "the old generation is no longer current");
        assert!(state.is_current(2));
    }

    #[test]
    fn a_dead_worker_can_be_restarted_for_the_same_owner() {
        let state = HintStreamState::default();
        assert_eq!(state.begin("desktop-a"), BeginOutcome::Started(1));
        assert!(state.finish(1, true), "its own generation finishes");
        assert_eq!(state.status().phase, HintPhase::Stopped, "not running after a failed dial");
        assert_eq!(state.status().connect_failures, 1, "the failure is observable");
        assert!(
            matches!(state.begin("desktop-a"), BeginOutcome::Started(_)),
            "a later start reconnects cleanly"
        );
    }

    #[test]
    fn a_stale_worker_exit_cannot_clear_a_newer_generation() {
        let state = HintStreamState::default();
        assert_eq!(state.begin("desktop-a"), BeginOutcome::Started(1));
        state.mark_running(1);
        assert_eq!(state.begin("desktop-b"), BeginOutcome::Started(2));
        state.mark_running(2);
        assert!(!state.finish(1, true), "a stale worker does not finish the new generation");
        assert!(state.is_current(2), "the newer worker is untouched");
        assert_eq!(state.status().phase, HintPhase::Running);
        assert_eq!(state.status().owner, "desktop-b");
    }

    #[test]
    fn a_stale_generation_cannot_publish() {
        let state = HintStreamState::default();
        assert_eq!(state.begin("desktop-a"), BeginOutcome::Started(1));
        state.mark_running(1);
        state.retire();
        assert!(
            !state.publish(1, Some(serde_json::json!({"kind":"lshStateChanged"}))),
            "a retired generation cannot publish"
        );
    }

    #[test]
    fn an_immediate_stop_blocks_publish_without_waiting_for_a_socket_timeout() {
        let state = HintStreamState::default();
        assert_eq!(state.begin("desktop-a"), BeginOutcome::Started(1));
        state.mark_running(1);
        // The socket may stay open for up to 30s, but the generation is finished
        // the instant retirement happens.
        state.retire();
        assert!(!state.publish(1, Some(serde_json::json!({"kind":"materialChanged","cursor":"m:1"}))));
        assert!(state.drain_if_current("desktop-a", 1).is_empty(), "nothing is delivered after retirement");
    }

    #[test]
    fn mark_running_is_generation_conditional() {
        let state = HintStreamState::default();
        assert_eq!(state.begin("desktop-a"), BeginOutcome::Started(1));
        assert_eq!(state.begin("desktop-b"), BeginOutcome::Started(2));
        assert!(!state.mark_running(1), "the stale worker cannot mark itself running");
        assert!(state.mark_running(2));
    }

    #[test]
    fn the_phase_reports_starting_then_running_then_stopped() {
        let state = HintStreamState::default();
        assert_eq!(state.status().phase, HintPhase::Stopped);
        assert!(matches!(state.begin("desktop-a"), BeginOutcome::Started(_)));
        assert_eq!(state.status().phase, HintPhase::Starting, "queued but not yet connected");
        let generation = state.status().generation;
        assert!(state.mark_running(generation));
        assert_eq!(state.status().phase, HintPhase::Running, "dial succeeded");
        assert!(state.finish(generation, false));
        assert_eq!(state.status().phase, HintPhase::Stopped, "EOF / protocol / ping failure");
    }

    #[test]
    fn retire_clears_owner_and_hints() {
        let state = HintStreamState::default();
        let BeginOutcome::Started(generation) = state.begin("desktop-a") else { panic!("started") };
        state.mark_running(generation);
        assert!(state.publish(generation, Some(serde_json::json!({"kind":"lshStateChanged"}))));
        state.retire();
        assert!(state.status().owner.is_empty());
        assert!(state.drain_if_current("desktop-a", generation).is_empty());
    }

    // -----------------------------------------------------------------------
    // typed hints / bounded buffer (R2 behaviour preserved)
    // -----------------------------------------------------------------------

    #[test]
    fn a_well_formed_hint_is_accepted() {
        assert!(parse_hint(r#"{"kind":"materialChanged","cursor":"m:1"}"#).unwrap().is_some());
        assert!(parse_hint(r#"{"kind":"servicesChanged","permissionRevision":2}"#).unwrap().is_some());
        assert!(parse_hint(r#"{"kind":"knowledgeChanged","vaultId":"v","cursor":"k:1"}"#).unwrap().is_some());
        assert!(parse_hint(r#"{"kind":"ingestChanged","jobId":"j"}"#).unwrap().is_some());
        assert!(parse_hint(r#"{"kind":"lshStateChanged"}"#).unwrap().is_some());
    }

    #[test]
    fn an_unknown_kind_fails_closed() {
        assert!(parse_hint(r#"{"kind":"somethingNew"}"#).is_err());
    }

    #[test]
    fn a_malformed_hint_fails_closed() {
        assert!(parse_hint("not json").is_err());
        assert!(parse_hint(r#"{"cursor":"m:1"}"#).is_err(), "missing kind");
        assert!(parse_hint(r#"{"kind":"materialChanged"}"#).is_err());
        assert!(parse_hint(r#"{"kind":"servicesChanged"}"#).is_err());
        assert!(parse_hint(r#"{"kind":"knowledgeChanged","vaultId":"v"}"#).is_err());
    }

    // -----------------------------------------------------------------------
    // P1-H4 — real, generation-scoped cancellation
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn retire_wakes_a_pending_worker_immediately() {
        // A worker parked on a read that NEVER completes must still exit
        // promptly once its generation is retired — no 30s timeout wait.
        let state: ManagedHintState = std::sync::Arc::new(HintStreamState::default());
        let BeginOutcome::Started(generation) = state.begin("desktop-a") else { panic!("started") };
        let mut cancel = state.install_cancellation_if_current(generation).expect("current");
        state.mark_running(generation);

        let worker_state = state.clone();
        let worker = tokio::spawn(async move {
            // The socket read is modelled as a future that never resolves.
            let pending = std::future::pending::<()>();
            tokio::select! {
                biased;
                _ = cancel.changed() => {
                    worker_state.finish(generation, false);
                }
                _ = pending => unreachable!("the read never completes"),
            }
        });

        // Retire on the shared authority exactly as a native path would.
        state.retire();
        // "shortly" — 500ms is far below the 30s read timeout.
        let outcome = tokio::time::timeout(std::time::Duration::from_millis(500), worker).await;
        assert!(outcome.is_ok(), "the worker must be woken by cancellation, not by timeout");
        assert_eq!(state.status().phase, HintPhase::Stopped);
    }

    #[tokio::test]
    async fn replacing_the_generation_cancels_the_previous_worker() {
        let state: ManagedHintState = std::sync::Arc::new(HintStreamState::default());
        let BeginOutcome::Started(gen_a) = state.begin("desktop-a") else { panic!("a") };
        let mut cancel_a = state.install_cancellation_if_current(gen_a).expect("a current");
        state.mark_running(gen_a);

        let worker_a = tokio::spawn(async move {
            let pending = std::future::pending::<()>();
            tokio::select! {
                biased;
                _ = cancel_a.changed() => true,
                _ = pending => false,
            }
        });

        // A different owner takes over: A must be cancelled promptly.
        let BeginOutcome::Started(gen_b) = state.begin("desktop-b") else { panic!("b") };
        state.install_cancellation_if_current(gen_b).expect("b current");
        state.mark_running(gen_b);

        let woke = tokio::time::timeout(std::time::Duration::from_millis(500), worker_a).await;
        assert!(matches!(woke, Ok(Ok(true))), "A is woken by the replacement");
        assert!(state.is_current(gen_b), "B is untouched");
        assert_eq!(state.status().owner, "desktop-b");
    }

    #[tokio::test]
    async fn cancelling_one_generation_does_not_cancel_another() {
        let state: ManagedHintState = std::sync::Arc::new(HintStreamState::default());
        let BeginOutcome::Started(gen_a) = state.begin("desktop-a") else { panic!("a") };
        let mut cancel_a = state.install_cancellation_if_current(gen_a).expect("a current");
        let BeginOutcome::Started(gen_b) = state.begin("desktop-b") else { panic!("b") };
        let mut cancel_b = state.install_cancellation_if_current(gen_b).expect("b current");

        // Retiring A by generation must not signal B.
        assert!(!state.retire_if_current(gen_a), "A is no longer current");
        assert!(
            !HintStreamState::is_cancelled(&cancel_b),
            "B was not cancelled by a stale A cleanup"
        );
        assert!(state.is_current(gen_b), "B is still current");
        // A's own receiver may be untouched too (it was never the live slot).
        let _ = &mut cancel_a;
    }

    #[test]
    fn retire_clears_the_cancellation_slot() {
        let state: ManagedHintState = std::sync::Arc::new(HintStreamState::default());
        let BeginOutcome::Started(generation) = state.begin("desktop-a") else { panic!("started") };
        let mut cancel = state.install_cancellation_if_current(generation).expect("current");
        state.retire();
        assert!(HintStreamState::is_cancelled(&cancel), "the live worker is signalled");
        // A second retire has nothing left to signal and must not panic.
        state.retire();
    }

    // -----------------------------------------------------------------------
    // P1-H7 — retire-before-install race
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn retire_before_install_refuses_the_late_worker_and_never_dials() {
        let state: ManagedHintState = std::sync::Arc::new(HintStreamState::default());
        // Dial counter: a real worker increments this immediately before
        // `hint_websocket_connect`. Zero means no socket was ever attempted.
        let dials = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));

        // 1) begin generation A; the task is queued but has NOT run yet.
        let BeginOutcome::Started(gen_a) = state.begin("desktop-a") else { panic!("a") };

        // 2) native retire happens BEFORE A installs its cancellation.
        state.retire();
        assert_eq!(state.status().phase, HintPhase::Stopped);
        assert_eq!(state.installed_cancellation_generation(), None, "the slot was never populated");

        // 3) the late worker now runs and attempts to install for A.
        let dials_worker = dials.clone();
        let state_worker = state.clone();
        let worker = tokio::spawn(async move {
            let Some(_cancel) = state_worker.install_cancellation_if_current(gen_a) else {
                // 4) refused BEFORE any dial.
                return;
            };
            // Only a live generation would reach the dial.
            dials_worker.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        });
        tokio::time::timeout(std::time::Duration::from_millis(500), worker)
            .await
            .expect("the worker returns promptly")
            .expect("no panic");

        // 5) no socket dial was attempted.
        assert_eq!(dials.load(std::sync::atomic::Ordering::SeqCst), 0, "the stale worker never dialled");
        assert_eq!(state.installed_cancellation_generation(), None, "no sender was installed");

        // 6) B begins and installs normally.
        let BeginOutcome::Started(gen_b) = state.begin("desktop-b") else { panic!("b") };
        let _cancel_b = state.install_cancellation_if_current(gen_b).expect("B installs normally");
        state.mark_running(gen_b);
        assert!(state.is_current(gen_b));
        assert_eq!(state.installed_cancellation_generation(), Some(gen_b));
    }

    /// Deterministic P1-H8 window: retire AFTER the pre-check but BEFORE the
    /// slot write. The gate is a plain fn, so the flags travel through a
    /// process-wide OnceLock that this test is the only writer of.
    /// Process-wide handshake for the install gate. Only the P1-H8 test writes
    /// these, and it holds GATE_SERIAL for the duration.
    static GATE_REACHED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    static GATE_RESUME: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    static GATE_SERIAL: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();

    /// Runs inside the install window: announces arrival and waits for the
    /// test to retire the generation before letting the install continue.
    fn gate_hook() {
        GATE_REACHED.store(true, std::sync::atomic::Ordering::SeqCst);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !GATE_RESUME.load(std::sync::atomic::Ordering::SeqCst) {
            if std::time::Instant::now() > deadline {
                break; // never hang the suite
            }
            std::thread::yield_now();
        }
    }
    // -----------------------------------------------------------------------
    // P1-G1H-DRAIN — atomic owner/generation drain
    // -----------------------------------------------------------------------

    #[test]
    fn a_stale_scoped_drain_cannot_remove_the_live_owners_records() {
        let state = HintStreamState::default();
        // A is current at gen 1, publishes one record.
        let BeginOutcome::Started(gen_a) = state.begin("desktop-a") else { panic!("a") };
        state.mark_running(gen_a);
        assert!(state.publish(gen_a, Some(serde_json::json!({"kind":"materialChanged","cursor":"m:A"}))));

        // B replaces A and publishes exactly one B record.
        let BeginOutcome::Started(gen_b) = state.begin("desktop-b") else { panic!("b") };
        state.mark_running(gen_b);
        assert!(state.publish(gen_b, Some(serde_json::json!({"kind":"lshStateChanged"}))));

        // Stale A's SCOPED drain is refused with zero mutation.
        let stolen = state.drain_if_current("desktop-a", gen_a);
        assert!(stolen.is_empty(), "a stale client gets no records");
        assert_eq!(state.drain_if_current("desktop-b", gen_b).len(), 1,
            "B's record is still buffered after the stale attempt");
    }

    #[test]
    fn a_stale_scoped_drain_between_generations_never_mutates() {
        let state = HintStreamState::default();
        let BeginOutcome::Started(gen_a) = state.begin("desktop-a") else { panic!("a") };
        state.mark_running(gen_a);
        assert!(state.publish(gen_a, Some(serde_json::json!({"kind":"lshStateChanged"}))));
        let BeginOutcome::Started(gen_b) = state.begin("desktop-b") else { panic!("b") };
        state.mark_running(gen_b);
        assert!(state.publish(gen_b, Some(serde_json::json!({"kind":"lshStateChanged"}))), "B publishes its own record");
        // A stale generation, a stale owner, and a bogus combination are all refused.
        assert!(state.drain_if_current("desktop-a", gen_a).is_empty(), "stale generation");
        assert!(state.drain_if_current("desktop-b", gen_a).is_empty(), "stale generation number");
        assert!(state.drain_if_current("desktop-a", gen_b).is_empty(), "swapped owner/generation");
        assert!(!state.drain_if_current("desktop-b", gen_b).is_empty(), "B still drains normally");
    }

    #[test]
    fn a_stopped_scope_never_drains_even_for_its_own_owner() {
        let state = HintStreamState::default();
        let BeginOutcome::Started(generation) = state.begin("desktop-a") else { panic!("a") };
        state.mark_running(generation);
        assert!(state.publish(generation, Some(serde_json::json!({"kind":"lshStateChanged"}))));
        state.retire();
        assert!(state.drain_if_current("desktop-a", generation).is_empty(),
            "a retired scope cannot be drained, even by its own owner");
    }

    #[test]
    fn drain_is_atomic_with_the_ownership_check_no_toctou() {
        // The EXACT review race: A holds a stale binding; B becomes current and
        // buffers a record; A then calls the scoped drain. The native check must
        // refuse A and leave B's record in place.
        let state = HintStreamState::default();
        let BeginOutcome::Started(gen_a) = state.begin("desktop-a") else { panic!("a") };
        state.mark_running(gen_a);
        let BeginOutcome::Started(gen_b) = state.begin("desktop-b") else { panic!("b") };
        state.mark_running(gen_b);
        state.publish(gen_b, Some(serde_json::json!({"kind":"materialChanged","cursor":"m:B"})));

        assert!(state.drain_if_current("desktop-a", gen_a).is_empty(), "A refused");
        let buffered = state.drain_if_current("desktop-b", gen_b);
        assert_eq!(buffered.len(), 1, "B's record survives A's stale attempt");
        assert_eq!(buffered[0].hint["cursor"], "m:B");
    }

    /// `flavor = "multi_thread"` is required: the gate parks the worker on its
    /// own OS thread, so the test task must be able to run concurrently.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn retire_between_pre_check_and_install_is_detected_by_the_post_check() {
        // Serialize against other tests that may use the gate.
        let _serial = GATE_SERIAL.get_or_init(|| std::sync::Mutex::new(())).lock();

        let state: ManagedHintState = std::sync::Arc::new(HintStreamState::default());
        let dials = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));

        // 1) A begins and is live.
        let BeginOutcome::Started(gen_a) = state.begin("desktop-a") else { panic!("a") };
        assert!(state.is_current(gen_a), "A passes the pre-check");

        // 2) Arm the gate so the NEXT install call pauses between the
        //    pre-check and the slot write. The flags are read by the hook on
        //    whichever thread the install runs on.
        GATE_REACHED.store(false, std::sync::atomic::Ordering::SeqCst);
        GATE_RESUME.store(false, std::sync::atomic::Ordering::SeqCst);
        state.set_install_gate(gate_hook);

        let state_worker = state.clone();
        let dials_worker = dials.clone();
        let worker = tokio::spawn(async move {
            let Some(_cancel) = state_worker.install_cancellation_if_current(gen_a) else {
                return; // refused: never dials
            };
            dials_worker.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        });

        // 3) Wait until the worker is parked inside the install window, then
        //    retire A while the slot is still EMPTY — the exact P1-H8 window.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !GATE_REACHED.load(std::sync::atomic::Ordering::SeqCst) {
            assert!(std::time::Instant::now() < deadline, "the install gate was never reached");
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert_eq!(state.installed_cancellation_generation(), None, "the slot is still empty");
        state.retire();
        assert_eq!(state.status().phase, HintPhase::Stopped);

        // 4) Resume: the post-install check must detect the staleness.
        GATE_RESUME.store(true, std::sync::atomic::Ordering::SeqCst);
        tokio::time::timeout(std::time::Duration::from_secs(5), worker)
            .await
            .expect("the worker returns promptly")
            .expect("no panic");

        // 5) Refused, no dial, and no stale A sender left behind.
        assert_eq!(dials.load(std::sync::atomic::Ordering::SeqCst), 0, "A never dialled");
        assert_eq!(
            state.installed_cancellation_generation(),
            None,
            "the stale A sender was cleaned up"
        );

        state.clear_install_gate();

        // 6) B begins, installs and runs normally.
        let BeginOutcome::Started(gen_b) = state.begin("desktop-b") else { panic!("b") };
        let _cancel_b = state.install_cancellation_if_current(gen_b).expect("B installs");
        assert!(state.mark_running(gen_b));
        assert_eq!(state.installed_cancellation_generation(), Some(gen_b), "B owns the slot");
        assert!(state.is_current(gen_b));
    }
    #[tokio::test]
    async fn a_retire_after_a_successful_install_still_signals_promptly() {
        let state: ManagedHintState = std::sync::Arc::new(HintStreamState::default());
        let BeginOutcome::Started(generation) = state.begin("desktop-a") else { panic!("a") };
        let mut cancel = state.install_cancellation_if_current(generation).expect("install");
        assert_eq!(state.installed_cancellation_generation(), Some(generation));

        // A retire AFTER the install finds a populated slot and signals it.
        state.retire();
        assert!(
            HintStreamState::is_cancelled(&cancel),
            "the installed sender is signalled promptly"
        );
        let woke = tokio::time::timeout(std::time::Duration::from_millis(500), cancel.changed()).await;
        assert!(woke.is_ok(), "the receiver wakes without waiting for a timeout");
        assert_eq!(state.installed_cancellation_generation(), None, "the slot was consumed");
    }

    #[test]
    fn a_stale_install_cannot_take_over_a_newer_cancellation_slot() {
        let state: ManagedHintState = std::sync::Arc::new(HintStreamState::default());
        let BeginOutcome::Started(gen_a) = state.begin("desktop-a") else { panic!("a") };
        // B becomes current and installs its own slot.
        let BeginOutcome::Started(gen_b) = state.begin("desktop-b") else { panic!("b") };
        let b_cancel = state.install_cancellation_if_current(gen_b).expect("b installs");
        state.mark_running(gen_b);
        assert_eq!(state.installed_cancellation_generation(), Some(gen_b));

        // The stale A worker now tries to install.
        assert!(
            state.install_cancellation_if_current(gen_a).is_none(),
            "a stale generation is refused"
        );
        assert_eq!(
            state.installed_cancellation_generation(),
            Some(gen_b),
            "B's slot is untouched"
        );
        assert!(!HintStreamState::is_cancelled(&b_cancel), "B was not cancelled by the stale install");
        assert!(state.is_current(gen_b), "B is still running");
    }

    #[test]
    fn install_after_a_stop_is_refused() {
        let state: ManagedHintState = std::sync::Arc::new(HintStreamState::default());
        let BeginOutcome::Started(generation) = state.begin("desktop-a") else { panic!("started") };
        state.mark_running(generation);
        state.retire();
        assert!(
            state.install_cancellation_if_current(generation).is_none(),
            "a stopped generation cannot install"
        );
        assert_eq!(state.installed_cancellation_generation(), None);
    }

    #[test]
    fn install_is_refused_for_a_generation_that_never_existed() {
        let state: ManagedHintState = std::sync::Arc::new(HintStreamState::default());
        let BeginOutcome::Started(_live) = state.begin("desktop-a") else { panic!("started") };
        assert!(state.install_cancellation_if_current(999).is_none(), "unknown generation is refused");
    }

    #[test]
    fn a_current_generation_installs_exactly_once() {
        let state: ManagedHintState = std::sync::Arc::new(HintStreamState::default());
        let BeginOutcome::Started(generation) = state.begin("desktop-a") else { panic!("started") };
        let first = state.install_cancellation_if_current(generation).expect("first install");
        // A second install for the SAME current generation replaces its own slot.
        let second = state.install_cancellation_if_current(generation).expect("re-install allowed");
        assert_eq!(state.installed_cancellation_generation(), Some(generation));
        assert!(!HintStreamState::is_cancelled(&first), "the same generation is not cancelled");
        assert!(!HintStreamState::is_cancelled(&second));
    }

    // -----------------------------------------------------------------------
    // P1-H5 — stale worker cleanup is generation-safe
    // -----------------------------------------------------------------------

    #[test]
    fn stale_malformed_cleanup_leaves_a_newer_generation_running() {
        let state = HintStreamState::default();
        let BeginOutcome::Started(gen_a) = state.begin("desktop-a") else { panic!("a") };
        state.mark_running(gen_a);
        // B becomes the new generation.
        let BeginOutcome::Started(gen_b) = state.begin("desktop-b") else { panic!("b") };
        state.mark_running(gen_b);

        // Stale A hits a malformed hint and runs its cleanup path.
        assert!(!state.retire_if_current(gen_a), "A cannot retire B");
        assert!(state.is_current(gen_b), "B is still running");
        assert_eq!(state.status().phase, HintPhase::Running, "B stays live");
        assert_eq!(state.status().owner, "desktop-b");
    }

    #[test]
    fn stale_owner_failure_cleanup_leaves_a_newer_generation_running() {
        let state = HintStreamState::default();
        let BeginOutcome::Started(gen_a) = state.begin("desktop-a") else { panic!("a") };
        state.mark_running(gen_a);
        let BeginOutcome::Started(gen_b) = state.begin("desktop-b") else { panic!("b") };
        state.mark_running(gen_b);

        // A's expected-owner check fails (its Desktop was replaced).
        assert!(!state.retire_if_current(gen_a), "A cannot retire B");
        assert!(state.is_current(gen_b));
        assert!(state.publish(gen_b, Some(serde_json::json!({"kind":"lshStateChanged"}))),
            "B can still publish");
    }

    #[test]
    fn the_current_generation_can_still_retire_itself() {
        let state = HintStreamState::default();
        let BeginOutcome::Started(generation) = state.begin("desktop-a") else { panic!("started") };
        state.mark_running(generation);
        assert!(state.retire_if_current(generation), "the live worker retires its own scope");
        assert!(!state.is_current(generation));
        assert_eq!(state.status().phase, HintPhase::Stopped);
    }

    #[test]
    fn the_buffer_is_bounded() {
        let state = HintStreamState::default();
        let BeginOutcome::Started(generation) = state.begin("desktop-a") else { panic!("started") };
        state.mark_running(generation);
        for i in 0..(MAX_BUFFERED_HINTS + 20) {
            state.publish(generation, Some(serde_json::json!({"kind":"ingestChanged","jobId":format!("j{i}")})));
        }
        let drained = state.drain_if_current("desktop-a", generation);
        assert!(drained.len() <= MAX_BUFFERED_HINTS, "bounded ring");
        assert!(!drained.is_empty());
    }
}
