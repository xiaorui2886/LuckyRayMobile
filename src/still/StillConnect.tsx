import "./settingsPages.css";
// STILL-01.1 — 连接电脑 page (Still composition, connectionShell authority).
// State comes ONLY from createConnectionShellController, which wraps the
// EXISTING pairing authorities. The secret/credential is never displayed;
// only displayName, LAN base URL and the fingerprint summary are shown.
import { useEffect, useRef, useState } from "react";
import { Header, IconButton, Button, Row, Empty, Notice, Sheet } from "./kit/StillImports";
import { api } from "../services/client";
import { QrScannerAdapter } from "../services/qrScannerAdapter";
import {
  createConnectionShellController,
  shellErrorCopy,
  wsFailureCopy,
  type ShellSnapshot,
} from "../services/connectionShell";
import { useStillNav } from "./StillShell";

export function StillConnect() {
  const { conn, back, registerOverlay } = useStillNav();
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
  const [showOther, setShowOther] = useState(false);
  const [forgetOpen, setForgetOpen] = useState(false);

  useEffect(() => shell.subscribe(() => { setSnap(shell.snapshot()); }), [shell]);
  useEffect(() => { void shell.refresh(); }, [shell]);
  const wsState = conn?.ws?.state;
  useEffect(() => {
    if (wsState !== undefined) void shell.refresh();
  }, [shell, wsState]);
  // Leaving the page mid-scan must tear the native camera down.
  useEffect(() => () => { shell.cancelIfScanning(); }, [shell]);

  const pairing = snap.phase === "pairing";
  const pairedView = snap.phase === "connected" || snap.phase === "reconnecting" || snap.phase === "paired_idle";
  const online = snap.ws.state === "connected";

  return (
    <div className="st-settings-overlay-scope">
      <div className="st-view st-settings-page st-settings-connect">
        <Header title="连接电脑" left={<IconButton icon="back" label="返回上一页" onClick={back} />} />
        <div className="st-scroll">
          {snap.phase === "unpaired" ? (
            <>
              <Empty icon="monitor" title="让内容在两端继续" body="在电脑上打开「连接手机」，然后扫码配对。">
                <Button kind="quiet" disabled={pairing} onClick={() => void shell.openScan()}>扫码配对</Button>
              </Empty>
              {snap.error ? <Notice tone="danger">{shellErrorCopy(snap.error)}</Notice> : null}
              <Button kind="quiet" disabled={pairing} onClick={() => setShowOther((v) => !v)}>其他配对方式</Button>
              {showOther ? (
                <>
                  <p className="st-sheet-copy" style={{ marginTop: 16 }}>扫码不方便时，可在电脑端「连接手机」窗口复制一次性配对信息，再粘贴到下面。</p>
                  <label className="st-field">粘贴电脑端复制的配对信息
                    <textarea rows={5} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder='{"v":1,...}' />
                  </label>
                  <div style={{ marginTop: 12 }}>
                    <Button disabled={!paste.trim() || pairing} onClick={() => {
                      const p = paste.trim();
                      setPaste("");
                      void shell.submitPaste(p).catch(() => {});
                    }}>开始配对</Button>
                  </div>
                  <div style={{ marginTop: 10 }}>
                    <Button kind="quiet" onClick={() => { setPaste(""); setShowOther(false); shell.cancel(); }}>取消</Button>
                  </div>
                </>
              ) : null}
            </>
          ) : null}

          {snap.phase === "scanning_or_paste" && snap.mode === "scan" ? (
            <>
              <Notice>正在打开相机扫描二维码…</Notice>
              <div style={{ marginTop: 14 }}><Button kind="quiet" onClick={() => shell.cancel()}>取消</Button></div>
            </>
          ) : null}

          {snap.phase === "scanning_or_paste" && snap.mode === "paste" ? (
            <>
              <label className="st-field">粘贴电脑端复制的配对信息
                <textarea rows={5} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder='{"v":1,...}' />
              </label>
              <div style={{ marginTop: 14 }}>
                <Button disabled={!paste.trim()} onClick={() => {
                  const p = paste.trim();
                  setPaste("");
                  void shell.submitPaste(p).catch(() => {});
                }}>开始配对</Button>
              </div>
              <div style={{ marginTop: 10 }}>
                <Button kind="quiet" onClick={() => { setPaste(""); shell.cancel(); }}>取消</Button>
              </div>
            </>
          ) : null}

          {pairing ? (
            <>
              <Notice>正在配对…</Notice>
              <div style={{ marginTop: 14 }}><Button kind="quiet" onClick={() => shell.cancel()}>取消</Button></div>
            </>
          ) : null}

          {snap.phase === "revoked" ? <Notice>已忘记此电脑，配对凭据已在本机清除。</Notice> : null}

          {snap.phase === "re_pair_required" ? (
            <>
              <Notice tone="danger">此电脑已拒绝当前配对凭据，需要重新配对。旧凭据不会再次用于连接。</Notice>
              <div style={{ marginTop: 14 }}><Button disabled={pairing} onClick={() => void shell.openScan()}>扫码重新配对</Button></div>
              <div style={{ marginTop: 10 }}><Button kind="quiet" onClick={() => shell.openPaste()}>手动输入新配对信息</Button></div>
            </>
          ) : null}

          {snap.phase === "error" && snap.error ? (
            <>
              <Notice tone="danger">{shellErrorCopy(snap.error)}</Notice>
              {snap.error.retryable ? (
                <div style={{ marginTop: 14 }}><Button onClick={() => void shell.retry()}>重试</Button></div>
              ) : null}
              <div style={{ marginTop: 10 }}><Button kind="quiet" onClick={() => void shell.back()}>返回</Button></div>
            </>
          ) : null}

          {pairedView && snap.identity ? (
            <>
              <Empty icon="monitor" title="LuckyRay Desktop"
                body={online ? "已配对 · 当前连接正常" : "已配对 · 当前未连接"} />
              <div className="st-settings-group">
                <Row title="连接状态" trail={online ? "已连接" : snap.ws.state === "reconnecting" || snap.ws.state === "connecting" ? "正在连接" : "未实时连接"} onClick={() => void shell.refresh()} />
                <Row title="连接方式" trail="同一局域网" onClick={() => void shell.refresh()} />
              </div>
              {/* 重新连接 is reachable in BOTH idle and reconnecting phases: a
                  wedged retry loop must be manually interruptible without
                  falling back to 断开连接 (which vetoes auto-resume). ws_start
                  retires the previous worker first, so this tap always dials
                  fresh. */}
              {snap.phase === "paired_idle" || snap.phase === "reconnecting" ? (
                <div style={{ marginTop: 20 }}><Button onClick={() => void shell.reconnect()}>重新连接</Button></div>
              ) : null}
              <div style={{ marginTop: snap.phase === "paired_idle" || snap.phase === "reconnecting" ? 10 : 20 }}>
                <Button kind="quiet" disabled={pairing} onClick={() => void shell.disconnect()}>断开连接</Button>
              </div>
              <div style={{ marginTop: 10 }}>
                <Button kind="quiet" disabled={pairing} onClick={() => setForgetOpen(true)}>忘记此电脑</Button>
              </div>
              {snap.notice === "preference_unsaved" ? (
                <Notice tone="pending">本次操作已生效，但连接偏好未能保存 —— 下次启动可能不会沿用这个设置。</Notice>
              ) : null}
              {/* Dial-failure feedback rides the AUTHORITY snapshot (ws
                  last_failure), not the command error path — so network vs
                  TLS-identity is named precisely while the worker keeps
                  retrying, and the credential is never implied invalid
                  (that is 401-only truth). */}
              {(snap.ws.state === "reconnecting" || snap.ws.state === "connecting") && snap.ws.last_failure ? (
                <Notice tone="pending">{wsFailureCopy(snap.ws.last_failure)}</Notice>
              ) : null}
              <p className="st-sheet-copy" style={{ marginTop: 28 }}>配对和内容同步是不同状态；此页面不代表素材或任务已同步。</p>
            </>
          ) : null}
        </div>
      </div>
      {forgetOpen ? (
        <Sheet title="忘记这台电脑？" registerDismiss={registerOverlay} onClose={() => setForgetOpen(false)}
          footer={<>
            <Button kind="quiet" onClick={() => setForgetOpen(false)}>取消</Button>
            <Button kind="danger" disabled={pairing} onClick={() => { setForgetOpen(false); void shell.forget(); }}>忘记电脑</Button>
          </>}>
          <p className="st-sheet-copy">清除配对后需要重新配对。不会删除手机上的本机笔记、素材或收集箱。</p>
        </Sheet>
      ) : null}
    </div>
  );
}
