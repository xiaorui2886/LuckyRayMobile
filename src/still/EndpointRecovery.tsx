import { useEffect, useRef, useState } from "react";
import { api } from "../services/client";
import { QrScannerAdapter } from "../services/qrScannerAdapter";
import { createEndpointRecoveryController } from "../services/endpointRecovery";
import { Button, Notice, Sheet } from "./kit/StillImports";

/** Only same-Desktop address recovery; the existing pairing shell is unchanged. */
export function EndpointRecovery({ registerOverlay, onUpdated }: {
  registerOverlay: (fn: () => void) => () => void;
  onUpdated: () => void;
}) {
  const updatedRef = useRef(onUpdated); updatedRef.current = onUpdated;
  const [controller] = useState(() => createEndpointRecoveryController({
    prepare: api.connEndpointPrepare, update: api.connEndpointUpdate, cancel: api.connEndpointCancel,
    scan: () => QrScannerAdapter.scan(), cancelScan: () => QrScannerAdapter.cancel(),
  }, () => updatedRef.current()));
  const [snap, setSnap] = useState(controller.snapshot);
  const [payload, setPayload] = useState("");
  useEffect(() => controller.subscribe(() => setSnap(controller.snapshot())), [controller]);
  useEffect(() => { controller.activate(); return () => controller.dispose(); }, [controller]);
  const input = snap.phase === "input" || snap.phase === "error";
  const busy = ["scanning", "preparing", "verifying", "cancelling"].includes(snap.phase);
  const cancel = () => { setPayload(""); void controller.cancel(); };
  return <>
    <div style={{ marginTop: 20 }}><Button kind="quiet" onClick={() => controller.open()}>恢复电脑连接地址</Button></div>
    {snap.phase !== "closed" ? <Sheet title="恢复原电脑连接" registerDismiss={registerOverlay} onClose={cancel} busy={busy}
      footer={<>
        <Button kind="quiet" onClick={cancel}>{snap.phase === "updated" ? "完成" : "取消"}</Button>
        {snap.phase === "review" ? <Button onClick={() => void controller.confirm()}>验证并更新地址</Button> : null}
        {snap.phase === "cancelling" && snap.message ? <Button onClick={cancel}>重新检查结果</Button> : null}
      </>}>
      {input ? <>
        <p className="st-sheet-copy">在原电脑的「连接手机 → 恢复手机连接」中扫码或复制地址资料。只更新地址，保留原配对、已保存的库和内容。</p>
        <Button kind="quiet" onClick={() => { setPayload(""); void controller.scan(); }}>扫描恢复地址二维码</Button>
        <label className="st-field" style={{ marginTop: 16 }}>粘贴恢复地址资料
          <textarea rows={4} maxLength={4096} autoComplete="off" value={payload} onChange={e => setPayload(e.target.value)} />
        </label>
        <div style={{ marginTop: 12 }}><Button disabled={!payload.trim()} onClick={() => {
          const value = payload.trim(); setPayload(""); void controller.prepare(value);
        }}>检查地址资料</Button></div>
      </> : null}
      {snap.preview && snap.phase !== "updated" ? <>
        <p className="st-sheet-copy">电脑：{snap.preview.displayName}</p>
        <p className="st-sheet-copy" style={{ overflowWrap: "anywhere" }}>原地址：{snap.preview.currentBaseUrl}<br />新地址：{snap.preview.candidateBaseUrl}</p>
        <p className="st-sheet-copy">原证书：{snap.preview.fingerprintSummary}</p>
      </> : null}
      {snap.phase === "review" ? <Notice>地址尚未连接验证。确认后将核对原证书、电脑身份和原设备授权；全部通过才保存。</Notice> : null}
      {busy ? <Notice>{snap.message ?? (snap.phase === "scanning" ? "正在扫码…" : snap.phase === "preparing" ? "正在检查地址资料…" : snap.phase === "cancelling" ? "正在确认取消结果…" : "正在验证原电脑和设备授权…")}</Notice> : null}
      {snap.phase === "error" && snap.message ? <Notice tone="danger">{snap.message}</Notice> : null}
      {snap.phase === "updated" ? <Notice>地址已验证并保存。原配对和已保存内容已保留；返回连接页点「重新连接」。此提示不代表实时连接已成功。</Notice> : null}
    </Sheet> : null}
  </>;
}
