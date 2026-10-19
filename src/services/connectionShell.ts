// M3-M1 Phase-A — the ONE typed presentation/state layer for the 连接电脑
// product shell. It wraps INJECTED existing command ports (api.connState/
// connPair/connRevoke/wsStart/wsStop + QrScannerAdapter); it is not a store,
// not a second client/parser/credential authority, holds no persistence and
// has no production fake. Pairing payloads are forwarded verbatim to the
// existing canonical Rust parser via api.connPair — this layer never parses,
// normalizes or stores QR JSON.
//
// Error copy is fixed and user-safe: it never embeds the pasted payload, the
// secret, the fingerprint, or any raw transport/provider error body. Every
// navigation out of the error phase is authority-derived (back()/retry()
// re-read connState or re-run the failed operation), so the shell can never
// present an unpaired surface while the device is still paired.

import type { ConnState, ConnTransitionResult } from "./client";
import type { QrScanResult } from "./qrScannerAdapter";

/** The exact existing command surface this shell is allowed to call. */
export type ConnectionShellPorts = {
  connState(): Promise<ConnState>;
  connPair(payload: string): Promise<unknown>;
  connRevoke(): Promise<string>;
  wsStart(): Promise<ConnTransitionResult>;
  wsStop(): Promise<ConnTransitionResult>;
  qrScan(): Promise<QrScanResult>;
  qrCancel(): Promise<void>;
};

/** Typed user-visible phases (superset of the task-card minimum: paired_idle
 *  is the truthful “已配对（未实时连接）” state the existing
 *  connectionSummary copy already defined — never presented as connected). */
export type ConnectionPhase =
  | "unpaired"
  | "scanning_or_paste"
  | "pairing"
  | "connected"
  | "reconnecting"
  | "paired_idle"
  | "re_pair_required"
  | "revoked"
  | "error";

/** Typed, user-safe error codes — copy is rendered by shellErrorCopy, never
 *  from raw error bodies. Scan failures are split by cause (denied / timeout)
 *  and pairing failures by the Desktop's typed code (expired vs unreachable)
 *  so the user gets a next step that matches the real capability instead of
 *  one generic message. */
export type ShellErrorCode =
  | "pair_failed"
  | "pair_expired"
  | "pair_unreachable"
  | "pair_device_limit"
  | "pair_rate_limited"
  | "pair_bad_code"
  | "scan_failed"
  | "scan_denied"
  | "scan_timeout"
  | "revoke_failed"
  | "disconnect_failed"
  | "reconnect_failed"
  | "reconnect_timeout"
  | "state_unavailable";

export type ShellError = { code: ShellErrorCode; retryable: boolean };

export type ShellIdentity = {
  displayName: string;
  baseUrl: string;
  /** Short TLS fingerprint summary (e.g. `a1b2c3d4…e5f6`) — never the full
   *  hex, never the secret/credential. */
  fingerprintSummary: string;
};

export type ShellSnapshot = {
  phase: ConnectionPhase;
  /** Scan vs paste input mode while unpaired; null elsewhere. */
  mode: "scan" | "paste" | null;
  error?: ShellError;
  /** A non-fatal note about an operation that SUCCEEDED but could not be
   *  persisted (e.g. the desktop preference write failed). Never a substitute
   *  for a real error, and never derived from a raw provider body. */
  notice?: "preference_unsaved";
  identity?: ShellIdentity;
  ws: { state: string; last_seq: number; current: string; reason?: string | null; last_failure?: string | null };
};

/** Pure phase derivation from the EXISTING authority snapshot. Realtime
 *  claims come only from the WS authority — metadata alone never yields
 *  connected/reconnecting. */
export function derivePhase(paired: boolean, wsState: string): ConnectionPhase {
  if (!paired) return "unpaired";
  if (wsState === "connected") return "connected";
  if (wsState === "connecting" || wsState === "reconnecting") return "reconnecting";
  if (wsState === "re_pair_required") return "re_pair_required";
  return "paired_idle";
}

/** Fixed user-safe copy for each typed error. */
export function shellErrorCopy(e: ShellError): string {
  switch (e.code) {
    case "pair_failed":
      return "配对失败 — 请确认配对码来自本电脑上的 LuckyRay 桌面端，然后重试";
    case "pair_expired":
      return "配对码已失效 — 请在电脑上重新生成一次配对信息，再扫码或粘贴";
    case "pair_unreachable":
      return "无法连接电脑 — 请确认手机与电脑在同一局域网、电脑端连接服务已启动，然后重试";
    case "pair_device_limit":
      return "这台电脑的配对设备已达上限 — 请在电脑端撤销一台旧设备后再配对";
    case "pair_rate_limited":
      return "配对操作过于频繁 — 请稍等片刻，或让电脑端重新生成配对信息后再试";
    case "pair_bad_code":
      return "配对信息无效 — 请在电脑端重新生成配对信息后再扫码或粘贴";
    case "scan_failed":
      return "无法完成扫码 — 请重试，或改用其他配对方式";
    case "scan_denied":
      return "没有相机权限 — 请在系统设置里允许 LuckyRay 使用相机，或改用其他配对方式";
    case "scan_timeout":
      return "扫码超时 — 请让二维码完整出现在取景框内，然后重试";
    case "revoke_failed":
      return "忘记此电脑失败 — 请稍后重试";
    case "disconnect_failed":
      return "断开连接失败 — 请稍后重试";
    case "reconnect_failed":
      return "重新连接失败 — 请稍后重试";
    case "reconnect_timeout":
      // IPC timeout, NOT a network verdict: the phone's own command did not
      // return. Copy must not claim anything about the desktop's network
      // state — dial failures surface separately via wsFailureCopy.
      return "连接操作超时 — 手机的连接命令没有返回结果，请重试；若持续超时，请完全关闭应用后重新打开";
    case "state_unavailable":
      return "无法读取连接状态 — 请重试";
  }
}

/** Map a denied/timeout/error scan result to its typed, user-safe code. */
export function scanErrorCode(reason: "denied" | "timeout" | "error"): ShellErrorCode {
  if (reason === "denied") return "scan_denied";
  if (reason === "timeout") return "scan_timeout";
  return "scan_failed";
}

/** User-safe copy for the typed ws `last_failure` class the Rust eventstream
 *  reports while it retries. Dial failures are NOT command failures: they
 *  arrive through the authority snapshot, not the reconnect error path, so
 *  network and TLS-identity problems can be named precisely without ever
 *  suggesting that the credential is invalid (that is 401-only truth) or
 *  relaxing certificate verification. */
export function wsFailureCopy(kind: string | null | undefined): string {
  switch (kind) {
    case "network":
      return "连不上电脑 — 请确认手机与电脑在同一局域网、电脑端 LuckyRay 正在运行（正在自动重试）";
    case "tls":
      return "电脑证书校验未通过 — 电脑端可能更换了证书或地址被其他设备占用。为安全起见不会跳过校验（正在自动重试）";
    default:
      return "连接尚未成功 — 正在自动重试";
  }
}

/** Fold the existing Rust companion error note (e.g. `pair http 409
 *  [pairing-expired]`) into a typed code. Only the frozen typed codes drive
 *  the classification — the raw note, payload, secret and fingerprint never
 *  reach the snapshot or the UI. */
export function classifyPairFailure(raw: string): ShellErrorCode {
  const note = raw.toLowerCase();
  // The Desktop has run out of pairing slots. Regenerating does not help until
  // the user revokes a device there, so this gets its own step.
  if (/pairing-device-limit|device-limit/.test(note)) {
    return "pair_device_limit";
  }
  // Throttled: the pairing code was requested or tried too often.
  if (/pairing-rate-limited|pairing-attempt-limit|auth_rate_limited|rate-limited|attempt-limit/.test(note)) {
    return "pair_rate_limited";
  }
  // The Desktop's one-time pairing ticket is gone (expired, closed, replaced,
  // already consumed or superseded): the user must regenerate it there.
  if (/pairing-(?:expired|required|replayed|generation-retired|already-active)/.test(note)) {
    return "pair_expired";
  }
  // The scanned/pasted code itself is not a valid one-time secret.
  if (/pairing-secret-invalid|secret-invalid/.test(note)) {
    return "pair_bad_code";
  }
  // Transport-level failure: the Desktop is unreachable on this network right
  // now. This is NOT proof that the pairing credential is invalid.
  if (
    /connect|timeout|timed out|unreachable|refused|reset|dns|tls|handshake|certificate|network/.test(
      note
    )
  ) {
    return "pair_unreachable";
  }
  return "pair_failed";
}

/** Short, non-sensitive fingerprint summary: first 8 + … + last 4 hex chars. */
export function fingerprintSummary(fp: string): string {
  if (fp.length <= 16) return fp;
  return `${fp.slice(0, 8)}…${fp.slice(-4)}`;
}

/** Rejected by {@link withDeadline} when the bounded wait outlives its
 * deadline. Distinguishes a timed-out WAIT from a real port failure so the
 * shell surfaces a typed timeout instead of a generic transport error. The
 * underlying port promise keeps running (IPC cannot be cancelled) — the
 * transition generation is what stops its late result from mattering. */
class OperationTimeout extends Error {
  constructor() {
    super("operation deadline exceeded");
  }
}

/** Bound how long a port call may hold the shell: a wedged command must
 * become user-visible feedback instead of an indefinite spinner. */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new OperationTimeout()), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

function shellIdentityFrom(cs: ConnState): ShellIdentity | undefined {
  if (!cs.paired || !cs.identity) return undefined;
  const id = cs.identity as {
    displayName?: string;
    baseUrl?: string;
    certificateFingerprint?: string;
  };
  return {
    displayName: id.displayName ?? "",
    baseUrl: id.baseUrl ?? "",
    fingerprintSummary: fingerprintSummary(id.certificateFingerprint ?? ""),
  };
}

export type ConnectionShellController = {
  subscribe(fn: () => void): () => void;
  snapshot(): ShellSnapshot;
  refresh(): Promise<void>;
  openScan(): Promise<void>;
  openPaste(): void;
  cancel(): void;
  /** Release the native scanner if a scan is still active (screen unmount). */
  cancelIfScanning(): void;
  submitPaste(payload: string): Promise<void>;
  retry(): Promise<void>;
  back(): Promise<void>;
  reconnect(): Promise<void>;
  disconnect(): Promise<void>;
  forget(): Promise<void>;
};

export function createConnectionShellController(
  ports: ConnectionShellPorts,
  opts?: { revokedHoldMs?: number; opTimeoutMs?: number }
): ConnectionShellController {
  const revokedHoldMs = opts?.revokedHoldMs ?? 1500;
  // Bounded waits for device operations: a wedged ws_start/ws_stop must turn
  // into typed feedback instead of an indefinite "正在连接" surface.
  const opTimeoutMs = opts?.opTimeoutMs ?? 15000;
  const listeners = new Set<() => void>();
  let snap: ShellSnapshot = {
    phase: "unpaired",
    mode: null,
    ws: { state: "stopped", last_seq: 0, current: "stopped" },
  };
  let pairing = false;
  let revokedUntil = 0;
  let revokeTimer: ReturnType<typeof setTimeout> | null = null;
  let requiresRePair = false;
  /** Refresh sequencing: only the LATEST started authority read may write.
   * Two refreshes in flight with the older resolving last must not clobber
   * the newer one's snapshot (out-of-order read protection on top of the
   * transition generation). */
  let refreshSeq = 0;
  /** Transition generation: bumped by EVERY user-facing transition entry.
   * Async continuations of an older generation (a timed-out or superseded
   * ws_start, a late connState read) must never write snapshot state on top
   * of what the user did afterwards — the stale-attempt guard for reconnect,
   * disconnect, forget and refresh alike. */
  let opGeneration = 0;
  /** Set when the last explicit transition succeeded but its preference could
   *  not be persisted; cleared when a later transition persists cleanly. */
  let preferenceNotice: ShellSnapshot["notice"];
  /** Scan generation: bumped on every new openScan and on any cancel/leave,
   *  so a stale in-flight scan continuation can never write state that
   *  clobbers what the user did afterwards (ghost scan_failed up to the
   *  native 30s deadline, paste-mode clobbering, re-scan cross-talk). */
  let scanGeneration = 0;
  /** Which input surface produced the current pairing attempt. Retry must
   *  return the user to THAT surface — a scan failure retries by scanning
   *  again, a paste failure returns to the paste field — instead of always
   *  dropping into one of them. */
  let lastPairSource: "scan" | "paste" | null = null;

  function emit() {
    for (const fn of Array.from(listeners)) fn();
  }

  function setPhase(phase: ConnectionPhase) {
    snap = { ...snap, phase };
    emit();
  }

  function setError(code: ShellErrorCode, retryable: boolean) {
    snap = { ...snap, phase: "error", error: { code, retryable } };
    emit();
  }

  async function refresh(): Promise<void> {
    const gen = opGeneration;
    const seq = ++refreshSeq;
    let cs: ConnState;
    try {
      cs = await ports.connState();
    } catch {
      // Authority read failure is surfaced as a typed, retryable shell error;
      // never as a raw transport message — and never mislabeled as a pairing
      // failure. A read superseded by a newer user transition writes nothing.
      if (gen !== opGeneration || seq !== refreshSeq) return;
      setError("state_unavailable", true);
      return;
    }
    // The await above may have straddled a user transition (reconnect tap,
    // cancel, back) or a NEWER refresh: a stale read must not clobber the
    // newer state.
    if (gen !== opGeneration || seq !== refreshSeq) return;
    const derived = derivePhase(Boolean(cs.paired), cs.ws?.state ?? "stopped");
    requiresRePair = derived === "re_pair_required";
    const revokedNow = Date.now() < revokedUntil;
    snap = {
      phase: !cs.paired && revokedNow ? "revoked" : derived,
      mode: cs.paired ? null : snap.mode === "scan" || snap.mode === "paste" ? snap.mode : null,
      // The durability notice describes the last explicit transition, so an
      // authority refresh must not silently drop it.
      notice: preferenceNotice,
      identity: shellIdentityFrom(cs),
      ws: cs.ws ?? { state: "stopped", last_seq: 0, current: "stopped" },
    };
    // A successful authority read clears any stale typed error.
    if (snap.phase !== "error") delete snap.error;
    emit();
  }

  async function pairWithPayload(payload: string, source: "scan" | "paste"): Promise<void> {
    if (pairing) {
      throw new Error("pairing busy");
    }
    pairing = true;
    opGeneration += 1; // pairing owns the surface: late reconnect/read writes are stale
    const gen = opGeneration;
    lastPairSource = source;
    setPhase("pairing");
    try {
      await ports.connPair(payload);
    } catch (e) {
      // The payload/secret and the raw failure body never enter the snapshot;
      // only the typed classification derived from the frozen error code does.
      pairing = false;
      if (gen !== opGeneration) return; // superseded while pairing
      setError(classifyPairFailure(String((e as Error)?.message ?? e)), true);
      return;
    }
    // The pairing SUCCEEDED at the authority, but a newer user transition may
    // own the surface by now. A stale success must not start the realtime
    // worker, flip bookkeeping, or refresh over whatever the user did next —
    // the stored credential itself is authority truth and the next authority
    // read will present it.
    if (gen !== opGeneration) {
      pairing = false;
      return; // stale pair success: no side effects, no state writes
    }
    requiresRePair = false;
    lastPairSource = null;
    preferenceNotice = undefined;
    try {
      // First pairing and re-pair share the existing realtime worker. The
      // wait is bounded: pairing already succeeded, so a wedged worker start
      // must not pin the surface in "pairing".
      const result = await withDeadline(ports.wsStart(), opTimeoutMs);
      if (result?.preferenceSaved === false) preferenceNotice = "preference_unsaved";
    } catch {
      // Pairing already succeeded and the new credential is authoritative.
      // Read that authority below; transport failure must not become pair_failed.
    }
    pairing = false;
    if (gen !== opGeneration) return; // superseded mid-pairing
    await refresh();
  }

  async function doReconnect(): Promise<void> {
    const gen = ++opGeneration;
    try {
      // Bounded manual reconnect: the Rust ws_start retires any previous
      // worker first (fresh dial, never AlreadyRunning on a wedged loop);
      // this deadline covers a wedged command itself.
      const result = await withDeadline(ports.wsStart(), opTimeoutMs);
      if (gen !== opGeneration) return; // a newer attempt owns the surface
      // The reconnect itself succeeded; a failed preference write is a
      // durability caveat, not a failed reconnect.
      preferenceNotice = result?.preferenceSaved === false ? "preference_unsaved" : undefined;
    } catch (e) {
      if (gen !== opGeneration) return; // stale attempt: never overwrite newer state
      // A timed-out WAIT is distinct from a refused start — the user gets an
      // actionable next step, not a generic failure. Neither ever touches the
      // pairing credential (transport failure is not auth truth).
      setError(e instanceof OperationTimeout ? "reconnect_timeout" : "reconnect_failed", true);
      return;
    }
    await refresh();
  }

  async function doDisconnect(): Promise<void> {
    const gen = ++opGeneration;
    try {
      const result = await withDeadline(ports.wsStop(), opTimeoutMs);
      if (gen !== opGeneration) return; // a newer attempt owns the surface
      // The worker IS stopped; only the opt-out may not survive a restart.
      preferenceNotice = result?.preferenceSaved === false ? "preference_unsaved" : undefined;
    } catch {
      if (gen !== opGeneration) return; // stale attempt: never overwrite newer state
      // The wait deadline and a refused stop surface identically: the worker
      // state is unknown until the next authority read either way.
      setError("disconnect_failed", true);
      return;
    }
    await refresh();
  }

  async function doForget(): Promise<void> {
    const gen = ++opGeneration;
    try {
      await withDeadline(ports.connRevoke(), opTimeoutMs);
    } catch {
      if (gen !== opGeneration) return;
      setError("revoke_failed", true);
      return;
    }
    if (gen !== opGeneration) return; // stale forget success: the authority changed under a newer transition
    // Bounded revoked transition, then the authority refresh yields the
    // truthful unpaired state.
    revokedUntil = Date.now() + revokedHoldMs;
    snap = { ...snap, phase: "revoked", mode: null, error: undefined };
    emit();
    if (revokeTimer) clearTimeout(revokeTimer);
    revokeTimer = setTimeout(() => {
      void refresh();
    }, revokedHoldMs + 20);
  }

  function releaseScanner() {
    // The native CameraX preview must be torn down when the user cancels or
    // leaves mid-scan — otherwise the next scan hits "qr scanner already
    // active". Failures are ignored (best-effort release).
    void ports.qrCancel().catch(() => {});
  }

  async function runScan(): Promise<void> {
    const gen = ++opGeneration; // the scan surface owns the UI from here
    const scanGen = ++scanGeneration;
    lastPairSource = "scan";
    snap = { ...snap, phase: "scanning_or_paste", mode: "scan", error: undefined };
    emit();
    let res: QrScanResult;
    try {
      res = await ports.qrScan();
    } catch {
      releaseScanner();
      if (scanGen !== scanGeneration) return; // cancelled/superseded mid-scan
      if (gen !== opGeneration) return; // a newer transition owns the surface
      snap = {
        ...snap,
        phase: requiresRePair ? "re_pair_required" : "unpaired",
        mode: null,
        error: { code: "scan_failed", retryable: true },
      };
      emit();
      return;
    }
    if (scanGen !== scanGeneration) {
      // A stale continuation (cancel, screen leave, or a newer scan) must
      // not write any state — the user may already be elsewhere.
      return;
    }
    if (gen !== opGeneration) return; // a newer transition owns the surface
    if (res.ok) {
      if (res.content) {
        // Scanned payloads go to the same existing parser seam (verbatim).
        snap = { ...snap, mode: null };
        emit();
        await pairWithPayload(res.content, "scan");
        return;
      }
      // Decoded but empty: not a usable payload — generic scan failure.
      releaseScanner();
      snap = {
        ...snap,
        phase: requiresRePair ? "re_pair_required" : "unpaired",
        mode: null,
        error: { code: "scan_failed", retryable: true },
      };
      emit();
      return;
    }
    // denied / timeout / error — release the scanner and return to a usable
    // unpaired state with typed copy (no scanner internals).
    releaseScanner();
    snap = {
      ...snap,
      phase: requiresRePair ? "re_pair_required" : "unpaired",
      mode: null,
      error: { code: scanErrorCode(res.reason), retryable: true },
    };
    emit();
  }

  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    snapshot() {
      // Derive the revoked transition lazily so the hold is bounded in time.
      if (snap.phase === "revoked" && Date.now() >= revokedUntil) {
        snap = { ...snap, phase: "unpaired" };
      }
      return snap;
    },

    async refresh() {
      await refresh();
    },

    openScan: runScan,

    openPaste() {
      opGeneration += 1; // the paste surface replaces whatever was pending
      lastPairSource = "paste";
      snap = { ...snap, phase: "scanning_or_paste", mode: "paste", error: undefined };
      emit();
    },

    cancel() {
      opGeneration += 1; // invalidate any in-flight operation continuation
      scanGeneration += 1; // invalidate any in-flight scan continuation
      if (snap.mode === "scan") releaseScanner();
      lastPairSource = null;
      snap = { ...snap, phase: requiresRePair ? "re_pair_required" : "unpaired", mode: null, error: undefined };
      emit();
    },

    cancelIfScanning() {
      if (snap.mode === "scan") {
        opGeneration += 1;
        scanGeneration += 1;
        releaseScanner();
        lastPairSource = null;
        snap = { ...snap, phase: requiresRePair ? "re_pair_required" : "unpaired", mode: null };
        emit();
      }
    },

    async submitPaste(payload: string) {
      snap = { ...snap, mode: null };
      await pairWithPayload(payload, "paste");
    },

    async retry() {
      // Re-run the FAILED operation when it is a device operation; input
      // corrections only apply to pairing/scan failures. Navigation is always
      // authority-derived, so a paired device never sees an unpaired surface.
      // The bump invalidates any still-pending continuation of the failed
      // attempt — its late result must not race this retry.
      opGeneration += 1;
      const code = snap.error?.code;
      const failedSource = lastPairSource;
      snap = { ...snap, error: undefined };
      if (code === "revoke_failed") {
        setPhase(derivePhase(true, snap.ws.state));
        await doForget();
        return;
      }
      if (code === "disconnect_failed") {
        setPhase(derivePhase(true, snap.ws.state));
        await doDisconnect();
        return;
      }
      if (code === "reconnect_failed" || code === "reconnect_timeout") {
        setPhase(derivePhase(true, snap.ws.state));
        await doReconnect();
        return;
      }
      if (code === "state_unavailable") {
        await refresh();
        return;
      }
      // pair_failed / pair_expired / pair_unreachable / scan_* (and any
      // unknown): return to the SAME input surface the user came from — a
      // scan failure retries through the camera, a paste failure through the
      // paste field — instead of always dropping into paste.
      if (failedSource === "scan") {
        await runScan();
        return;
      }
      if (failedSource === "paste") {
        snap = { ...snap, phase: "scanning_or_paste", mode: "paste" };
        emit();
        return;
      }
      snap = { ...snap, phase: "scanning_or_paste", mode: "scan" };
      emit();
    },

    async back() {
      // Authority-derived: paired devices return to their paired view, never
      // to an unpaired/pairing surface.
      opGeneration += 1; // invalidate any in-flight operation continuation
      scanGeneration += 1; // invalidate any in-flight scan continuation
      if (snap.mode === "scan") releaseScanner();
      snap = { ...snap, mode: null, error: undefined };
      await refresh();
    },

    reconnect: doReconnect,
    disconnect: doDisconnect,
    forget: doForget,
  };
}
