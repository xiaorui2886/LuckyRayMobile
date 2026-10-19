// STILL-01.1 — 收集内容 detail page (authority inbox-detail composition).
// Real Local Inbox authorities: metadata edit for text/link, attachment
// open / export / share, convert to note, promote to asset, archive/favorite,
// delete — the legacy InboxDetail behaviour, moved into Still sheets.
import { useEffect, useState } from "react";
import { Header, IconButton, Button, Sheet, Option, Row, Empty } from "./kit/StillImports";
import { api } from "../services/client";
import { localDataStore } from "../services/localDataStore";
import {
  classifyExportDestination,
  exportActionLabel,
  exportCopyText,
  shareMimeFor,
} from "../services/exportPolicy";
import { failureCopy } from "../services/feedback";
import { toast } from "../services/toast";
import { useStillNav } from "./StillShell";
import { displayTitle, kindLabel } from "../screens/Inbox";

export function StillInboxDetail({ id }: { id: string }) {
  const { back, open, registerOverlay } = useStillNav();
  const [detail, setDetail] = useState<any>(null);
  const [loadError, setLoadError] = useState("");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [editing, setEditing] = useState(false);
  const [sheet, setSheet] = useState<"" | "more" | "delete">("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api.localInboxGet(id)
      .then((d) => {
        if (!alive) return;
        setDetail(d);
        setTitle(d.item.title ?? "");
        setText(d.item.text ?? "");
        setUrl(d.item.url ?? "");
      })
      .catch((e: any) => { if (alive) setLoadError(failureCopy(e, "读不到这条收集内容。")); });
    return () => { alive = false; };
  }, [id]);

  if (!detail) {
    return (
      <div className="st-view">
        <Header title="收集内容" left={<IconButton icon="back" label="返回收集箱" onClick={back} />} />
        <div className="st-scroll">
          <Empty title={loadError ? "无法打开" : "正在读取…"} body={loadError || undefined} />
        </div>
      </div>
    );
  }

  const item = detail.item;
  const attachment = detail.attachments?.[0];
  const editable = item.kind === "text" || item.kind === "link";
  const isLink = item.kind === "link";

  async function save() {
    setBusy(true);
    try {
      await api.localInboxUpdate(id, title, text, url);
      toast.success("已保存");
      setEditing(false);
      localDataStore.publish("inbox");
    } catch (e: any) {
      toast.error(failureCopy(e, "保存失败。"));
    } finally { setBusy(false); }
  }

  async function convertToNote() {
    setBusy(true);
    try {
      const note = await api.localNoteConvertInbox(id);
      localDataStore.publish("note");
      toast.success("已生成笔记");
      open("note", note.noteId, { edit: true });
    } catch (e: any) {
      toast.error(failureCopy(e, "生成笔记失败。"));
    } finally { setBusy(false); }
  }

  async function promoteToAsset() {
    setBusy(true);
    try {
      const asset = await api.localAssetPromoteInbox(id);
      localDataStore.publish("asset");
      toast.success("已收纳到素材库");
      open("asset", "local:" + asset.assetId);
    } catch (e: any) {
      toast.error(failureCopy(e, "收纳失败。"));
    } finally { setBusy(false); }
  }

  async function toggleFlag(flag: "favorite" | "archived") {
    try {
      if (flag === "favorite") await api.localInboxSetFavorite(id, !item.favorite);
      else await api.localInboxSetArchived(id, !item.archived);
      const next = { ...detail, item: { ...item, [flag]: !item[flag] } };
      setDetail(next);
      localDataStore.publish("inbox");
      toast.success(flag === "favorite" ? (!item.favorite ? "已收藏" : "已取消收藏") : (!item.archived ? "已归档" : "已取消归档"));
    } catch (e: any) {
      toast.error(failureCopy(e, "操作失败。"));
    }
  }

  async function remove() {
    try {
      await api.localInboxDelete(id);
      localDataStore.publish("inbox");
      back();
    } catch (e: any) {
      toast.error(failureCopy(e, "删除失败。"));
    }
  }

  async function shareContent() {
    setBusy(true);
    try {
      const payload = isLink ? (url.trim() || item.url || "") : (text.trim() || item.text || "");
      if (!payload) { toast.warn("没有可分享的内容"); return; }
      const r = await api.companionShareText(payload);
      if (r.status !== "ok") toast.error(r.message || "分享失败。");
    } catch (e: any) {
      toast.error(failureCopy(e, "分享失败。"));
    } finally { setBusy(false); }
  }

  async function shareAttachment() {
    if (!attachment) return;
    setBusy(true);
    try {
      const kind = attachment.mime?.startsWith("image/") ? "image" : attachment.mime?.startsWith("video/") ? "video" : "file";
      const r = await api.companionShareFile(attachment.localPath, attachment.fileName, shareMimeFor(kind, attachment.mime));
      if (r.status !== "ok") toast.error(r.message || "分享失败。");
    } catch (e: any) {
      toast.error(failureCopy(e, "分享失败。"));
    } finally { setBusy(false); }
  }

  async function exportAttachment() {
    if (!attachment) return;
    setBusy(true);
    try {
      const kind = attachment.mime?.startsWith("image/") ? "image" : attachment.mime?.startsWith("video/") ? "video" : "file";
      const collection = classifyExportDestination(kind, attachment.mime);
      const r = await api.companionExport(attachment.localPath, attachment.fileName, attachment.mime, collection);
      if (r.status === "created" || r.status === "already_exists") toast.success(exportCopyText(r.status, collection));
      else toast.error(r.message || "保存失败。");
    } catch (e: any) {
      toast.error(failureCopy(e, "保存失败。"));
    } finally { setBusy(false); }
  }

  async function openAttachment() {
    if (!attachment) return;
    try {
      const r = await api.openAttachment(attachment.localPath, attachment.mime || "application/octet-stream");
      if (r.status !== "ok") toast.error(r.message || "无法打开附件。");
    } catch (e: any) {
      toast.error(failureCopy(e, "无法打开附件。"));
    }
  }

  return (
    <>
      <div className="st-view">
        <Header title="收集内容" left={<IconButton icon="back" label="返回收集箱" onClick={back} />}
          right={<IconButton icon="more" label="收集更多操作" onClick={() => setSheet("more")} />} />
        <div className="st-scroll">
          <div className="st-note-paper" style={{ padding: "22px 0" }}>
            {editing && editable ? (
              <>
                <input className="st-note-title" aria-label="标题" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="标题" />
                {isLink ? (
                  <input className="st-note-title" aria-label="链接" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" inputMode="url" />
                ) : (
                  <textarea className="st-note-editor" aria-label="内容" value={text} onChange={(e) => setText(e.target.value)} />
                )}
              </>
            ) : (
              <>
                <h1>{displayTitle(item)}</h1>
                <div className="st-note-prose">{item.text || item.url || (attachment ? "" : "无内容")}</div>
              </>
            )}
            <div className="st-note-footnote">{item.meta || kindLabel(item.kind)} · {(item.createdAt || "").replace("T", " ").slice(0, 16)}</div>
          </div>
          {attachment ? (
            <>
              <div className="st-metadata-row"><span>文件</span><b>{attachment.fileName}</b></div>
              <div className="st-metadata-row"><span>类型</span><b>{attachment.mime}</b></div>
            </>
          ) : null}
          <Row title="整理为笔记" meta="生成一篇可继续编辑的本机笔记" icon="knowledge" onClick={() => void convertToNote()} />
          {editable ? (
            editing
              ? <Button onClick={() => void save()} disabled={busy}>保存修改</Button>
              : null
          ) : (
            <Row title="收纳到素材库" icon="library" onClick={() => void promoteToAsset()} />
          )}
        </div>
      </div>
      {sheet === "more" ? (
        <Sheet title="整理收集内容" registerDismiss={registerOverlay} onClose={() => setSheet("")}>
          {editable ? (
            <Option label={editing ? "完成编辑" : "编辑内容"} icon="edit" onClick={() => { setEditing((v) => !v); setSheet(""); }} />
          ) : null}
          <Option label={item.favorite ? "取消收藏" : "收藏"} icon="pin" onClick={() => { void toggleFlag("favorite"); setSheet(""); }} />
          <Option label={item.archived ? "取消归档" : "归档"} icon="archive" onClick={() => { void toggleFlag("archived"); setSheet(""); }} />
          {editable ? <Option label="分享" icon="share" onClick={() => { setSheet(""); void shareContent(); }} /> : null}
          {attachment ? (
            <>
              <Option label="打开附件" icon="eye" onClick={() => { setSheet(""); void openAttachment(); }} />
              <Option label={exportActionLabel(attachment.mime?.startsWith("image/") ? "image" : "file")} icon="image" onClick={() => { setSheet(""); void exportAttachment(); }} />
              <Option label="分享附件" icon="share" onClick={() => { setSheet(""); void shareAttachment(); }} />
              <Option label="收纳到素材库" icon="library" onClick={() => { setSheet(""); void promoteToAsset(); }} />
            </>
          ) : null}
          <Option label="生成本机笔记" icon="knowledge" onClick={() => { setSheet(""); void convertToNote(); }} />
          <Option label="删除这一条" icon="trash" danger onClick={() => setSheet("delete")} />
        </Sheet>
      ) : null}
      {sheet === "delete" ? (
        <Sheet title="删除这条内容？" registerDismiss={registerOverlay} onClose={() => setSheet("")}
          footer={<>
            <Button kind="quiet" onClick={() => setSheet("")}>取消</Button>
            <Button kind="danger" onClick={() => { setSheet(""); void remove(); }}>删除</Button>
          </>}>
          <p className="st-sheet-copy">只删除这条内容及其所属数据，其他内容不受影响。</p>
        </Sheet>
      ) : null}
    </>
  );
}
