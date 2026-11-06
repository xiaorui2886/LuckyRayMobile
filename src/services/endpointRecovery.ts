// Ephemeral presentation only. Native prepare/verify/CAS remains the authority.
// No QR parsing, storage, pairing, credentials, scanning the LAN or auto-connect.
import type { EndpointRecoveryCancel, EndpointRecoveryPreview, EndpointRecoveryResult } from "./client";
import type { QrScanResult } from "./qrScannerAdapter";

export type RecoveryPorts = {
  prepare(payload: string): Promise<EndpointRecoveryPreview>;
  update(id: string): Promise<EndpointRecoveryResult>;
  cancel(id: string): Promise<EndpointRecoveryCancel>;
  scan(): Promise<QrScanResult>;
  cancelScan(): Promise<void>;
};
export type RecoveryPhase = "closed" | "input" | "scanning" | "preparing" | "review" | "verifying" | "cancelling" | "updated" | "error";
export type RecoverySnapshot = {
  phase: RecoveryPhase;
  preview?: EndpointRecoveryPreview;
  message?: string;
};

/** Fixed copy only: never display raw transport messages or pasted contents. */
export function recoveryError(raw: unknown): string {
  const code = typeof raw === "string" ? raw : raw instanceof Error ? raw.message : "";
  switch (code) {
    case "ENDPOINT_HINT_INVALID": return "地址资料无效。请从电脑「恢复手机连接」重新扫码或复制；不要使用配对码。";
    case "ENDPOINT_URL_INVALID": return "地址不受支持。当前仅接受原电脑提供的 HTTPS 局域网 IPv4 地址和端口。";
    case "ENDPOINT_INSTANCE_MISMATCH": return "这不是原来配对的电脑，地址没有更新。请回到原电脑获取地址资料。";
    case "ENDPOINT_PIN_MISMATCH":
    case "ENDPOINT_TLS_FAILED": return "电脑证书与原配对不符或已过期，地址没有更新。不会跳过证书校验。";
    case "ENDPOINT_AUTH_REJECTED": return "原配对授权已被电脑拒绝，地址没有更新。请在电脑端检查设备授权。";
    case "ENDPOINT_CREDENTIAL_UNAVAILABLE": return "本机原配对凭据不可用，地址没有更新。请检查本机安全存储或联系支持。";
    case "ENDPOINT_TIMEOUT": return "新地址验证超时，地址没有更新。请确认电脑连接服务已就绪，然后重试。";
    case "ENDPOINT_UNREACHABLE": return "暂时无法连接新地址，地址没有更新。请检查两端网络和电脑连接服务。";
    case "ENDPOINT_SOURCE_CHANGED":
    case "ENDPOINT_CANCELLED_OR_STALE": return "连接状态已经变化，本次恢复已失效。请重新获取地址资料。";
    case "ENDPOINT_PREPARE_EXPIRED": return "地址确认已超时，请重新扫码或粘贴。";
    case "ENDPOINT_SAVE_UNCONFIRMED": return "本机未能确认地址保存结果。请返回连接页重新检查，不要清除配对。";
    case "ENDPOINT_NOT_PAIRED": return "本机没有已配对的电脑，请先使用原有配对入口。";
    case "ENDPOINT_UPDATE_BUSY": return "另一项地址更新仍在保存，请稍后重新检查。";
    case "ENDPOINT_VERSION_UNSUPPORTED": return "电脑版本不支持此验证接口，地址没有更新。";
    case "ENDPOINT_REDIRECT_DENIED": return "新地址要求跳转，已拒绝，地址没有更新。请使用电脑直接提供的地址。";
    case "ENDPOINT_SESSION_MISMATCH": return "电脑返回的设备身份不符，地址没有更新。";
    case "ENDPOINT_PROTOCOL_INVALID":
    case "ENDPOINT_RESPONSE_TOO_LARGE": return "电脑返回的验证资料不符合协议，地址没有更新。";
    case "ENDPOINT_SERVICE_UNAVAILABLE": return "电脑连接服务暂时不可用，地址没有更新。";
    default: return "无法确认本次恢复结果。请返回连接页重新检查，保留原配对。";
  }
}

function deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("IPC_DEADLINE")), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

export function createEndpointRecoveryController(ports: RecoveryPorts, onUpdated: () => void) {
  let snap: RecoverySnapshot = { phase: "closed" };
  let generation = 0, disposed = false, announced = false;
  let cancellation: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  function emit(value: RecoverySnapshot) { snap = value; if (!disposed) listeners.forEach(fn => fn()); }
  function phase(): RecoveryPhase { return snap.phase; }
  function updated(preview: EndpointRecoveryPreview) {
    emit({ phase: "updated", preview });
    if (!announced) { announced = true; onUpdated(); }
  }
  async function retire(id: string) { try { await ports.cancel(id); } catch { /* No update can be requested from this retired preview. */ } }

  async function prepare(payload: string) {
    if (disposed || !["input", "error"].includes(snap.phase)) return;
    const own = ++generation;
    emit({ phase: "preparing" });
    const task = ports.prepare(payload);
    // IPC is not cancellable. A delayed native preparation must still retire.
    void task.then(value => { if (disposed || own !== generation) void retire(value.prepareId); }, () => {});
    try {
      const preview = await deadline(task, 5_000);
      if (disposed || own !== generation) return;
      emit({ phase: "review", preview });
    } catch (error) {
      if (disposed || own !== generation) return;
      ++generation;
      emit({ phase: "error", message: recoveryError(error) });
    }
  }

  async function cancel() {
    if (cancellation) return cancellation;
    const preview = snap.preview;
    if (!preview || snap.phase === "updated") {
      ++generation;
      if (snap.phase === "scanning") void ports.cancelScan();
      emit({ phase: "closed" });
      return;
    }
    const own = generation;
    emit({ phase: "cancelling", preview });
    cancellation = (async () => {
      try {
        const result = await deadline(ports.cancel(preview.prepareId), 5_000);
        if (disposed || own !== generation) return;
        if (result.status === "already_updated") { updated(preview); return; }
        if (result.status === "commit_in_progress") {
          emit({ phase: "cancelling", preview, message: "地址正在保存，尚未确认结果。请稍后点「重新检查结果」。" });
          return;
        }
        ++generation;
        emit({ phase: "closed" });
      } catch {
        if (disposed || own !== generation) return;
        emit({ phase: "cancelling", preview, message: "取消结果尚未确认。请点「重新检查结果」，不要清除配对。" });
      }
    })().finally(() => { cancellation = null; });
    return cancellation;
  }

  return {
    snapshot: () => snap,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    open() { if (disposed || !["closed", "updated"].includes(snap.phase)) return; ++generation; announced = false; emit({ phase: "input" }); },
    prepare,
    async scan() {
      if (disposed || !["input", "error"].includes(snap.phase)) return;
      const own = ++generation;
      emit({ phase: "scanning" });
      try {
        const value = await deadline(ports.scan(), 45_000);
        if (disposed || own !== generation) return;
        if (!value.ok) {
          emit({ phase: "error", message: value.reason === "denied" ? "没有相机权限，可改用粘贴地址资料。" : "扫码未完成，可重试或改用粘贴地址资料。" });
          return;
        }
        emit({ phase: "input" });
        await prepare(value.content);
      } catch {
        if (disposed || own !== generation) return;
        ++generation;
        void ports.cancelScan();
        emit({ phase: "error", message: "扫码未完成，可重试或改用粘贴地址资料。" });
      }
    },
    async confirm() {
      if (disposed || snap.phase !== "review" || !snap.preview) return;
      const preview = snap.preview, own = generation;
      emit({ phase: "verifying", preview });
      try {
        await deadline(ports.update(preview.prepareId), 25_000);
        if (!disposed && own === generation) updated(preview);
      } catch (error) {
        if (disposed || own !== generation) return;
        if (error instanceof Error && error.message === "IPC_DEADLINE") { await cancel(); return; }
        if (phase() !== "cancelling") emit({ phase: "error", message: recoveryError(error) });
      }
    },
    cancel,
    activate() { disposed = false; },
    dispose() {
      const id = snap.preview?.prepareId;
      if (snap.phase === "scanning") void ports.cancelScan();
      disposed = true; ++generation; snap = { phase: "closed" }; listeners.clear();
      if (id) void retire(id);
    },
  };
}
