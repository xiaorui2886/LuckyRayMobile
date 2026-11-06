import { useDesktopLibraries } from "./DesktopLibraryPicker";
import { useEffect, useRef, useState } from "react";
import { api, type ConnState } from "../../services/client";
import { KnowledgeActionGate, type UploadTarget } from "../../services/knowledgeActions";
import { localNoteUploadFailure } from "../../services/localNoteUploadFailure";
import { syncCoordinator } from "../../services/syncCoordinator";
import { Sheet, Option, Button } from "./StillImports";

export function LocalNoteUploadSheet({ noteId, conn, onClose, registerOverlay }: { noteId: string; conn: ConnState | null; onClose: () => void; registerOverlay: (fn: () => void) => () => void }) {
  const instance = conn?.identity?.instanceId || "";
  const online = Boolean(conn?.paired && conn.ws?.state === "connected");
  const libraries = useDesktopLibraries(instance, online);
  const vault = libraries.catalog?.scopeSelectionVersion === 1 ? libraries.vault : undefined;
  const scope = JSON.stringify([instance, vault, online, noteId]);
  const gate = useRef(new KnowledgeActionGate()).current; gate.update(scope);
  const [target, setTarget] = useState<{scope: string; value: UploadTarget} | null>(null);
  const [parent, setParent] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(false);
  const current = target?.scope === scope ? target.value : null;
  useEffect(() => {
    let alive = true; setTarget(null); setParent(""); setBusy(false); setQueued(false); setNotice("");
    if (online && instance) api.contentLocalNoteUploadTarget(instance, vault).then(value => { if (value.instanceId !== instance || !value.vaultId || !value.writeGranted) throw Error("TARGET_CHANGED"); if (alive) setTarget({scope, value}); }).catch(() => { if (alive) setNotice("无法读取可写知识库。请确认电脑已连接，并已授予笔记写入权限。"); });
    return () => { alive = false; gate.cancel(); };
  }, [scope, gate]);
  const close = () => { if (busy) return; gate.cancel(); onClose(); };
  async function submit() {
    if (!current || !online || !current.writeGranted || queued) return;
    const token = gate.start(); if (token === null) return;
    setBusy(true); setNotice("");
    try {
      const fresh = await api.contentLocalNoteUploadTarget(instance, vault);
      if (!gate.current(token)) return;
      if (fresh.instanceId !== instance || fresh.vaultId !== current.vaultId || !fresh.writeGranted || !fresh.directories.includes(parent)) throw Error("TARGET_CHANGED");
      const receipt = await api.contentLocalNoteUpload(instance, current.vaultId, noteId, parent);
      if (!gate.current(token)) return;
      if (!["queued", "alreadySubmitted"].includes(receipt.status)) throw Error("UNKNOWN_UPLOAD_RECEIPT");
      if (receipt.instanceId !== instance || receipt.vaultId !== current.vaultId || receipt.localNoteId !== noteId) throw Error("RECEIPT_SCOPE");
      setQueued(true); setNotice(receipt.status === "alreadySubmitted" ? "此版本已提交过，未重复创建。本机原件仍保留。" : receipt.reused ? "这篇笔记已有上传任务，不会重复创建。本机原件仍保留。" : "已加入同步队列，尚未确认电脑保存。本机原件仍保留。");
      // The commit may land while an older sync response is still in flight.
      // Preserve one follow-up pass instead of dropping this durable wake.
      syncCoordinator.wake();
    } catch (error) {
      if (!gate.current(token)) return;
      setNotice(localNoteUploadFailure(error));
    } finally { if (gate.current(token)) setBusy(false); gate.finish(token); }
  }
  return <Sheet title="上传到电脑知识库" registerDismiss={registerOverlay} onClose={close} busy={busy}
    footer={<><Button kind="quiet" disabled={busy} onClick={close}>{queued ? "完成" : "取消"}</Button>{!queued ? <Button disabled={busy || !online || !current?.writeGranted} onClick={() => void submit()}>{busy ? "正在提交…" : "确认上传副本"}</Button> : null}</>}>
    <p className="st-sheet-copy">上传标题与正文副本，本机原文及标签、收藏等信息保留。重复提交同一上传不会重复创建；附件或本机链接不能完整转移时会停止，不会静默丢弃。</p>
    {!online ? <p className="st-sheet-copy" role="status">电脑未连接。连接后可选择当前可写知识库。</p> : current ? <><p className="st-sheet-caption">{current.name || "当前电脑知识库"}</p>{!queued ? current.directories.map(path => <Option key={path} label={path || "根目录"} icon="folder" selected={parent === path} onClick={() => { if (!busy) setParent(path); }} />) : null}</> : !notice ? <p className="st-sheet-copy">正在读取可写知识库…</p> : null}
    {notice ? <p className="st-sheet-copy" role="status">{notice}</p> : null}
  </Sheet>;
}
