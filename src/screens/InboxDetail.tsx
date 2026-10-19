// InboxDetail.tsx (STITCH-R6) — 本地收集详情.
//
// Visual source: R6 detail-child pattern — back header (with the favorite
// action on the right) → content → metadata stack → grouped actions.
//
// Behaviour source: production, unchanged (metadata edit for text/link,
// attachment open / export / share, convert to note, promote to asset,
// archive/delete, localDataStore publishes).
import { useEffect, useState } from "react";
import { api } from "../services/client";
import { displayTitle, kindIcon, kindLabel } from "./Inbox";
import { localDataStore } from "../services/localDataStore";
import {
  classifyExportDestination,
  exportActionLabel,
  exportCopyText,
  shareMimeFor,
} from "../services/exportPolicy";
import { failureCopy } from "../services/feedback";
import { toast } from "../services/toast";
import { BackHeader, EmptyState, Notice } from "../components/ui";

type Props = {
  id: string;
  onBack: () => void;
  onChanged?: () => void;
  onOpenNote?: (noteId: string) => void;
  onOpenAsset?: (assetId: string) => void;
};

export default function InboxDetail({ id, onBack, onChanged, onOpenNote, onOpenAsset }: Props) {
  const [detail, setDetail] = useState<any>(null);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .localInboxGet(id)
      .then((d) => {
        if (!alive) return;
        setDetail(d);
        setTitle(d.item.title ?? "");
        setText(d.item.text ?? "");
        setUrl(d.item.url ?? "");
      })
      .catch((e: any) => {
        if (alive) setLoadError(failureCopy(e, "读不到这条收集内容。"));
      });
    return () => {
      alive = false;
    };
  }, [id]);

  if (!detail) {
    return (
      <>
        <BackHeader title="本地收集" onBack={onBack} />
        {loadError ? <EmptyState title="无法打开" body={loadError} /> : <EmptyState title="正在读取…" />}
      </>
    );
  }
  const item = detail.item;
  const attachment = detail.attachments?.[0];

  async function save() {
    setBusy(true);
    try {
      await api.localInboxUpdate(id, title, text, url);
      toast.success("已保存");
      onChanged?.();
      localDataStore.publish("inbox");
    } catch (e: any) {
      toast.error(failureCopy(e, "保存失败。"));
    } finally {
      setBusy(false);
    }
  }

  async function toggleFavorite() {
    try {
      await api.localInboxSetFavorite(id, !item.favorite);
      setDetail({ ...detail, item: { ...item, favorite: !item.favorite } });
      onChanged?.();
      localDataStore.publish("inbox");
    } catch (e: any) {
      toast.error(failureCopy(e, "操作失败。"));
    }
  }

  async function toggleArchive() {
    try {
      await api.localInboxSetArchived(id, !item.archived);
      setDetail({ ...detail, item: { ...item, archived: !item.archived } });
      onChanged?.();
      localDataStore.publish("inbox");
      toast.success(item.archived ? "已取消归档" : "已归档");
    } catch (e: any) {
      toast.error(failureCopy(e, "操作失败。"));
    }
  }

  async function remove() {
    if (!window.confirm("删除这条本地内容？附件只会删除这一条所拥有的文件。")) return;
    try {
      await api.localInboxDelete(id);
      onChanged?.();
      localDataStore.publish("inbox");
      onBack();
    } catch (e: any) {
      toast.error(failureCopy(e, "删除失败。"));
    }
  }

  async function convertToNote() {
    setBusy(true);
    try {
      const note = await api.localNoteConvertInbox(id);
      onChanged?.();
      localDataStore.publish("note");
      toast.success("已生成笔记");
      if (onOpenNote) onOpenNote(note.noteId);
    } catch (e: any) {
      toast.error(failureCopy(e, "生成笔记失败。"));
    } finally {
      setBusy(false);
    }
  }

  async function promoteToAsset() {
    setBusy(true);
    try {
      const asset = await api.localAssetPromoteInbox(id);
      onChanged?.();
      localDataStore.publish("asset");
      toast.success("已收纳到素材库");
      if (onOpenAsset) onOpenAsset(asset.assetId);
    } catch (e: any) {
      toast.error(failureCopy(e, "收纳失败。"));
    } finally {
      setBusy(false);
    }
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

  const attachmentKind = (m: string) =>
    m.startsWith("image/") ? "image" : m.startsWith("video/") ? "video" : "file";

  async function exportAttachment() {
    if (!attachment) return;
    setBusy(true);
    try {
      const kind = attachmentKind(attachment.mime);
      const collection = classifyExportDestination(kind, attachment.mime);
      const r = await api.companionExport(attachment.localPath, attachment.fileName, attachment.mime, collection);
      if (r.status === "created" || r.status === "already_exists") {
        toast.success(exportCopyText(r.status, collection));
      } else {
        toast.error(r.message || "保存失败。");
      }
    } catch (e: any) {
      toast.error(failureCopy(e, "保存失败。"));
    } finally {
      setBusy(false);
    }
  }

  async function shareAttachment() {
    if (!attachment) return;
    setBusy(true);
    try {
      const kind = attachmentKind(attachment.mime);
      const r = await api.companionShareFile(attachment.localPath, attachment.fileName, shareMimeFor(kind, attachment.mime));
      if (r.status !== "ok") toast.error(r.message || "分享失败。");
    } catch (e: any) {
      toast.error(failureCopy(e, "分享失败。"));
    } finally {
      setBusy(false);
    }
  }

  async function shareTextOrLink() {
    setBusy(true);
    try {
      const payload = item.kind === "link" ? (url.trim() || item.url || "") : (text.trim() || item.text || "");
      if (!payload) {
        toast.warn("没有可分享的内容");
        return;
      }
      const r = await api.companionShareText(payload);
      if (r.status !== "ok") toast.error(r.message || "分享失败。");
    } catch (e: any) {
      toast.error(failureCopy(e, "分享失败。"));
    } finally {
      setBusy(false);
    }
  }

  const editable = item.kind === "text" || item.kind === "link";

  return (
    <>
      <BackHeader
        title="本地收集"
        onBack={onBack}
        right={
          <button
            className={"nav-action" + (item.favorite ? " accent" : "")}
            onClick={toggleFavorite}
            aria-label={item.favorite ? "取消收藏" : "收藏"}
          >
            {item.favorite ? "★" : "☆"}
          </button>
        }
      />

      <div className="detail-scroll">
        <div className="meta-line">
          <span>来源</span>
          <b>{kindLabel(item.kind)} · {item.source === "share" ? "系统分享" : item.source === "picker" ? "本地选择" : "手动输入"}</b>
        </div>

        {editable ? (
          <>
            <label>
              <span className="field-label" style={{ marginTop: 14 }}>标题</span>
              <input className="text-field" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="可留空" />
            </label>
            {item.kind === "link" ? (
              <label>
                <span className="field-label" style={{ marginTop: 14 }}>链接</span>
                <input className="text-field" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" inputMode="url" />
              </label>
            ) : (
              <label>
                <span className="field-label" style={{ marginTop: 14 }}>内容</span>
                <textarea
                  className="text-field"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="内容"
                  rows={6}
                />
              </label>
            )}
            <div className="btn-row">
              <button className="primary" disabled={busy} onClick={save}>
                保存
              </button>
              <button className="quiet" disabled={busy} onClick={shareTextOrLink}>
                分享
              </button>
            </div>
          </>
        ) : (
          <>
            <span className="row-art" style={{ width: 46, height: 46, margin: "14px 0 4px" }}>{kindIcon(item.kind)}</span>
            <h3 className="editor-title">{displayTitle(item)}</h3>
            {attachment ? (
              <div className="meta-stack" style={{ marginTop: 8 }}>
                <div className="meta-line"><span>文件</span><b>{attachment.fileName}</b></div>
                <div className="meta-line"><span>类型</span><b>{attachment.mime}</b></div>
                <div className="meta-line"><span>大小</span><b>{fmt(attachment.sizeBytes)}</b></div>
                <div className="meta-line"><span>指纹</span><b className="mono">{(attachment.sha256 || "").slice(0, 16)}…</b></div>
              </div>
            ) : (
              <p style={{ margin: "0 0 10px", color: "var(--ink2)", fontSize: 12, lineHeight: 1.6 }}>
                {item.text || item.url || "无内容"}
              </p>
            )}
            <div className="btn-row">
              <button className="primary" disabled={!attachment || busy} onClick={openAttachment}>
                打开附件
              </button>
              {attachment ? (
                <button className="quiet" disabled={busy} onClick={exportAttachment}>
                  {exportActionLabel(attachmentKind(attachment.mime))}
                </button>
              ) : null}
            </div>
            {attachment ? (
              <button className="quiet btn-block" style={{ marginTop: 8 }} disabled={busy} onClick={shareAttachment}>
                分享附件
              </button>
            ) : null}
          </>
        )}

        <div className="meta-stack">
          <div className="meta-line"><span>时间</span><b>{item.createdAt?.replace("T", " ").slice(0, 16) || ""}</b></div>
          <div className="meta-line"><span>状态</span><b>{item.favorite ? "★ 已收藏" : "未收藏"} · {item.archived ? "已归档" : "未归档"}</b></div>
        </div>

        <div className="btn-row">
          <button className="quiet" disabled={busy} onClick={convertToNote}>
            转为笔记
          </button>
          <button className="quiet" onClick={toggleArchive}>
            {item.archived ? "取消归档" : "归档"}
          </button>
        </div>

        {!editable && attachment ? (
          <button className="primary btn-block" style={{ marginTop: 8 }} disabled={busy} onClick={promoteToAsset}>
            收纳到本机素材库
          </button>
        ) : null}

        <button className="danger-btn btn-block" style={{ marginTop: 22 }} onClick={remove}>
          删除这条内容
        </button>

        {loadError ? <Notice tone="danger">{loadError}</Notice> : null}
      </div>
    </>
  );
}

function fmt(n: number) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}
