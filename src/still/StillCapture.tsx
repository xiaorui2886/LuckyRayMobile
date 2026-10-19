// STILL-01.1 — 收集 (CaptureView, real Local Inbox authorities).
// Text / link pick the input type; 图片 / 拍照 / 文件 are immediate media
// actions. Every path saves into the Mobile-owned Local Inbox first, paired
// or not. A non-empty draft is protected by the capture-leave sheet.
import { useState } from "react";
import { CaptureView } from "../presentation/still01/Views";
import { Sheet, Button } from "./kit/StillImports";
import { api } from "../services/client";
import { syncCoordinator } from "../services/syncCoordinator";
import { localDataStore } from "../services/localDataStore";
import { failureCopy } from "../services/feedback";
import { toast } from "../services/toast";
import { useStillNav } from "./StillShell";

export function StillCapture() {
  const { back, open, registerOverlay } = useStillNav();
  const [kind, setKind] = useState<"text" | "link">("text");
  const [text, setText] = useState("");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [leaveOpen, setLeaveOpen] = useState(false);

  async function save() {
    const value = kind === "text" ? text.trim() : link.trim();
    if (!value || busy) return;
    setBusy(true);
    setError("");
    try {
      await api.localInboxAdd(kind, text, link);
      toast.success("已保存到手机");
      setText("");
      setLink("");
      localDataStore.publish("inbox");
      await syncCoordinator.refreshOutboxStatus();
    } catch (e: any) {
      setError(failureCopy(e, "保存失败，请重试。"));
    } finally { setBusy(false); }
  }

  async function media(m: "image" | "camera" | "file") {
    setBusy(true);
    try {
      const r = await api.localInboxAddMedia(m === "camera" ? "photo" : m);
      if (r?.cancelled) toast.info("已取消");
      else {
        toast.success(`已保存到手机 · ${r?.fileName ?? m}`);
        localDataStore.publish("inbox");
      }
      await syncCoordinator.refreshOutboxStatus();
    } catch (e: any) {
      toast.error(failureCopy(e, "收集失败，请重试。"));
    } finally { setBusy(false); }
  }

  function requestBack() {
    if (text.trim() || link.trim()) setLeaveOpen(true);
    else back();
  }

  return (
    <>
      <CaptureView
        kind={kind}
        onKind={setKind}
        value={kind === "text" ? text : link}
        onChange={(v) => (kind === "text" ? setText(v) : setLink(v))}
        onSave={() => void save()}
        busy={busy}
        error={error}
        onMedia={(k) => { if (k === "image" || k === "camera" || k === "file") void media(k); }}
        onBack={requestBack}
        onInbox={() => open("inbox")}
      />
      {leaveOpen ? (
        <Sheet title="先把想法留在这里" registerDismiss={registerOverlay} onClose={() => setLeaveOpen(false)}
          footer={<>
            <Button kind="quiet" onClick={() => setLeaveOpen(false)}>继续输入</Button>
            <Button onClick={() => { setLeaveOpen(false); back(); }}>保留并关闭</Button>
          </>}>
          <p className="st-sheet-copy">关闭后保留本次草稿，再次打开收集可以继续输入。草稿只存在本机，不会声称已同步。</p>
        </Sheet>
      ) : null}
    </>
  );
}
