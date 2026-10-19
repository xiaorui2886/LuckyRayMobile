// 连接电脑 (STITCH-R6) — the product surface for safe pairing & connection.
//
// State comes ONLY from the connectionShell controller, which wraps the
// EXISTING authorities (api.connState/connPair/connRevoke/wsStart/wsStop +
// QrScannerAdapter). No second parser/client/store, no persistence, and the
// secret/credential are never displayed, stored or copied. The identity card
// shows only displayName, LAN base URL and a short TLS fingerprint summary.
//
// Visual source: R6 connect-computer screen — back header, quiet empty state
// with one primary action, setting rows for the paired identity, and a
// progress line while pairing. The phase model, error copy and authority
// wiring are UNCHANGED.
import { useEffect, useRef, useState } from "react";
import { api, type ConnState } from "../services/client";
import { QrScannerAdapter } from "../services/qrScannerAdapter";
import {
  createConnectionShellController,
  shellErrorCopy,
  type ShellSnapshot,
} from "../services/connectionShell";
import { IconDesktop } from "../components/icons";
import { BackHeader, EmptyState, Notice } from "../components/ui";

function wsStateLabel(state: string): string {
  if (state === "connected") return "实时连接";
  if (state === "connecting" || state === "reconnecting") return "正在连接";
  return "未实时连接";
}

export default function ConnectComputer({
  onBack,
  onChanged,
  ws,
}: {
  onBack: () => void;
  onChanged?: () => void;
  ws?: ConnState["ws"];
}) {
  // The controller wraps the EXISTING command ports; created exactly once.
  const shellRef = useRef<ReturnType<typeof createConnectionShellController> | null>(null);
  if (!shellRef.current) {
    shellRef.current = createConnectionShellController({
      connState: () => api.connState(),
      connPair: (payload) => api.connPair(payload),
      connRevoke: () => api.connRevoke(),
      wsStart: () => api.wsStart(),
      wsStop: () => api.wsStop(),
      qrScan: () => QrScannerAdapter.scan(),
      qrCancel: () => QrScannerAdapter.cancel(),
    });
  }
  const shell = shellRef.current;
  const [snap, setSnap] = useState<ShellSnapshot>(shell.snapshot());
  const [paste, setPaste] = useState("");
  // "其他配对方式" stays collapsed by default so scanning remains the obvious
  // path; it is a disclosure, not a second product surface.
  const [showOther, setShowOther] = useState(false);
  useEffect(
    () =>
      shell.subscribe(() => {
        setSnap(shell.snapshot());
        onChanged?.();
      }),
    [shell, onChanged]
  );
  useEffect(() => {
    void shell.refresh();
  }, [shell]);
  // Live WS feed from the App snapshot: any authority change re-derives the
  // phase, so a paired view can never keep a stale 实时连接 claim.
  const wsState = ws?.state;
  useEffect(() => {
    if (wsState !== undefined) void shell.refresh();
  }, [shell, wsState]);
  // Leaving the screen mid-scan must tear the native camera down.
  useEffect(
    () => () => {
      shell.cancelIfScanning();
    },
    [shell]
  );

  const busy = snap.phase === "pairing";
  const pairedView = snap.phase === "connected" || snap.phase === "reconnecting" || snap.phase === "paired_idle";

  return (
    <>
      <BackHeader title="连接电脑" onBack={onBack} />

      <div className="detail-scroll">
        {snap.phase === "unpaired" && (
          <>
            <EmptyState
              icon={<IconDesktop size={20} />}
              title="配对一台电脑"
              body="与同一局域网内的 LuckyRay 桌面端安全配对。在电脑上打开「连接手机」，然后用手机扫描窗口里的二维码。"
            />
            {snap.error ? <Notice tone="danger">{shellErrorCopy(snap.error)}</Notice> : null}
            <button className="primary btn-block" style={{ marginTop: 14 }} disabled={busy} onClick={() => void shell.openScan()}>
              扫码配对
            </button>
            <button
              className="quiet btn-block"
              style={{ marginTop: 8 }}
              disabled={busy}
              onClick={() => setShowOther((v) => !v)}
              aria-expanded={showOther}
            >
              其他配对方式
            </button>
            {showOther && (
              <>
                <p className="list-foot" style={{ textAlign: "left", paddingTop: 12 }}>
                  扫码不方便时，可在电脑端「连接手机」窗口复制一次性配对信息，再粘贴到下面。
                </p>
                <button className="quiet btn-block" disabled={busy} onClick={() => shell.openPaste()}>
                  手动输入配对信息
                </button>
              </>
            )}
          </>
        )}

        {snap.phase === "scanning_or_paste" && snap.mode === "scan" && (
          <>
            <Notice>正在打开相机扫描二维码…</Notice>
            <button className="quiet btn-block" style={{ marginTop: 14 }} onClick={() => shell.cancel()}>
              取消
            </button>
          </>
        )}

        {snap.phase === "scanning_or_paste" && snap.mode === "paste" && (
          <>
            <label>
              <span className="field-label">粘贴电脑端复制的配对信息</span>
              <textarea
                className="text-field"
                rows={6}
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
                placeholder='{"v":1,...}'
                style={{ fontFamily: "var(--font-mono)" }}
              />
            </label>
            <button
              className="primary btn-block"
              style={{ marginTop: 14 }}
              disabled={!paste.trim()}
              onClick={() => {
                const p = paste.trim();
                setPaste("");
                shell.submitPaste(p).catch(() => {
                  // Double-submit while pairing is already guarded by the
                  // controller; the rejection is not user-visible noise.
                });
              }}
            >
              开始配对
            </button>
            <button className="quiet btn-block" style={{ marginTop: 8 }} onClick={() => { setPaste(""); shell.cancel(); }}>
              取消
            </button>
          </>
        )}

        {snap.phase === "pairing" && (
          <>
            <Notice>正在配对…</Notice>
            <div className="progress-line" style={{ marginTop: 12 }} />
          </>
        )}

        {snap.phase === "revoked" && (
          <Notice>已忘记此电脑，配对凭据已在本机清除。</Notice>
        )}

        {snap.phase === "re_pair_required" && (
          <>
            <Notice tone="danger">
              此电脑已拒绝当前配对凭据，需要重新配对。旧凭据不会再次用于连接。
            </Notice>
            <button className="primary btn-block" style={{ marginTop: 14 }} onClick={() => void shell.openScan()}>
              扫码重新配对
            </button>
            <button className="quiet btn-block" style={{ marginTop: 8 }} onClick={() => shell.openPaste()}>
              手动输入新配对信息
            </button>
          </>
        )}

        {snap.phase === "error" && snap.error && (
          <>
            <Notice tone="danger">{shellErrorCopy(snap.error)}</Notice>
            {snap.error.retryable ? (
              <button className="primary btn-block" style={{ marginTop: 14 }} onClick={() => void shell.retry()}>
                重试
              </button>
            ) : null}
            <button className="quiet btn-block" style={{ marginTop: 8 }} onClick={() => void shell.back()}>
              返回
            </button>
          </>
        )}

        {pairedView && snap.identity && (
          <>
            <div className="connection-box">
              <div className="setting-row static">
                <span className="sr-icon"><IconDesktop /></span>
                <span className="sr-label">电脑</span>
                <span className="sr-value">{snap.identity.displayName}</span>
              </div>
              <div className="setting-row static">
                <span className="sr-label">地址</span>
                <span className="sr-value mono">{snap.identity.baseUrl}</span>
              </div>
              <div className="setting-row static">
                <span className="sr-label">指纹</span>
                <span className="sr-value mono">{snap.identity.fingerprintSummary}</span>
              </div>
              <div className="setting-row static">
                <span className="sr-label">实时连接</span>
                <span className="sr-value">
                  <span className="subline">
                    <span
                      className={
                        "dot" +
                        (snap.ws.state === "connected"
                          ? ""
                          : snap.ws.state === "reconnecting" || snap.ws.state === "connecting"
                            ? " warn"
                            : " idle")
                      }
                    />
                    {wsStateLabel(snap.ws.state)}
                  </span>
                </span>
              </div>
            </div>

            {snap.phase === "paired_idle" ? (
              <button className="primary btn-block" style={{ marginTop: 18 }} onClick={() => void shell.reconnect()}>
                重新连接
              </button>
            ) : null}
            <button className="quiet btn-block" style={{ marginTop: 8 }} disabled={busy} onClick={() => void shell.disconnect()}>
              断开连接
            </button>
            <button
              className="danger-btn btn-block"
              style={{ marginTop: 8 }}
              disabled={busy}
              onClick={() => {
                if (confirm("忘记此电脑将清除本机保存的配对信息，需要重新配对。继续？")) {
                  void shell.forget();
                }
              }}
            >
              忘记此电脑
            </button>

            {snap.notice === "preference_unsaved" ? (
              <Notice tone="warn">
                本次操作已生效，但连接偏好未能保存 —— 下次启动可能不会沿用这个设置。
              </Notice>
            ) : null}

            <p className="list-foot" style={{ textAlign: "left", paddingTop: 12 }}>
              配对与连接状态仅来自本机与电脑的直接连接。此页面不表示素材、知识库或任务已同步。
            </p>
          </>
        )}
      </div>
    </>
  );
}
