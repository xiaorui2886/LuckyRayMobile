// LocalAssetDetail.tsx (STITCH-R6) — 本机素材详情.
//
// Visual source: R6 `function assetDetail()` — back header (favorite action on
// the right) → hero preview → title/meta stack → grouped action buttons.
//
// Behaviour source: production, unchanged. Same authorities and safety rules
// as before: integrity gates the preview/open path; a broken original is never
// silently deleted; export is an explicit copy. Tags stay real and editable.
import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "../services/client";
import { IconFile, IconImage, IconVideo } from "../components/icons";
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
import { MediaFirstLayout } from "../components/MediaFirstDetail";
import { MediaZoomLayer } from "../components/MediaZoomLayer";

type Props = {
  id: string;
  onBack: () => void;
  onChanged?: () => void;
};

export default function LocalAssetDetail({ id, onBack, onChanged }: Props) {
  const [asset, setAsset] = useState<any>(null);
  const [name, setName] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [integrity, setIntegrity] = useState<any>(null);

  useEffect(() => {
    let alive = true;
    api
      .localAssetGet(id)
      .then((a) => {
        if (!alive) return;
        setAsset(a);
        setName(a.name ?? "");
      })
      .catch((e: any) => {
        if (alive) setLoadError(failureCopy(e, "读不到这条素材。"));
      });
    return () => {
      alive = false;
    };
  }, [id]);

  useEffect(() => {
    let alive = true;
    api
      .localAssetIntegrity(id, true)
      .then((r) => {
        if (alive) setIntegrity(r);
      })
      .catch(() => {
        /* integrity is best-effort; the metadata block still renders */
      });
    return () => {
      alive = false;
    };
  }, [id]);

  if (!asset) {
    return (
      <>
        <BackHeader title="素材详情" onBack={onBack} />
        {loadError ? <EmptyState title="无法打开" body={loadError} /> : <EmptyState title="正在读取…" />}
      </>
    );
  }

  const healthy = integrity?.status === "healthy";
  const integrityError = integrity && integrity.status !== "healthy" ? integrity.status : null;
  const previewSrc = asset.kind === "image" && healthy ? convertFileSrc(asset.localPath) : "";

  const integrityText: Record<string, string> = {
    missing: "文件缺失",
    unreadable: "文件无法读取",
    "size-mismatch": "文件大小异常",
    "hash-mismatch": "文件完整性校验失败",
  };

  async function save() {
    setBusy(true);
    try {
      const tags = parseTags(tagInput).concat(asset.tags || []);
      const updated = await api.localAssetUpdate(id, name.trim() || asset.name, tags);
      setAsset(updated);
      setTagInput("");
      toast.success("已保存");
      onChanged?.();
      localDataStore.publish("asset");
    } catch (e: any) {
      toast.error(failureCopy(e, "保存失败。"));
    } finally {
      setBusy(false);
    }
  }

  async function toggleFavorite() {
    try {
      await api.localAssetSetFlags(id, { favorite: !asset.favorite });
      setAsset({ ...asset, favorite: !asset.favorite });
      onChanged?.();
      localDataStore.publish("asset");
    } catch (e: any) {
      toast.error(failureCopy(e, "操作失败。"));
    }
  }

  async function toggleArchive() {
    try {
      await api.localAssetSetFlags(id, { archived: !asset.archived });
      setAsset({ ...asset, archived: !asset.archived });
      onChanged?.();
      localDataStore.publish("asset");
      toast.success(asset.archived ? "已取消归档" : "已归档");
    } catch (e: any) {
      toast.error(failureCopy(e, "操作失败。"));
    }
  }

  async function remove() {
    if (!window.confirm(`删除本机素材「${asset.name}」？只删除这一条素材及其所属文件，收集箱和笔记不受影响。`)) return;
    try {
      await api.localAssetDelete(id);
      onChanged?.();
      localDataStore.publish("asset");
      onBack();
    } catch (e: any) {
      toast.error(failureCopy(e, "删除失败。"));
    }
  }

  async function removeTag(t: string) {
    try {
      const tags = (asset.tags || []).filter((x: string) => x !== t);
      const updated = await api.localAssetUpdate(id, asset.name, tags);
      setAsset(updated);
      localDataStore.publish("asset");
    } catch (e: any) {
      toast.error(failureCopy(e, "删除标签失败。"));
    }
  }

  async function openOriginal() {
    if (!healthy) return;
    try {
      const r = await api.openAttachment(asset.localPath, asset.mime || "application/octet-stream");
      if (r.status !== "ok") toast.error(r.message || "无法打开这个文件。");
    } catch (e: any) {
      toast.error(failureCopy(e, "无法打开这个文件。"));
    }
  }

  async function exportToSystem() {
    if (!healthy) return;
    setBusy(true);
    try {
      const collection = classifyExportDestination(asset.kind, asset.mime);
      const r = await api.companionExport(asset.localPath, asset.name, asset.mime, collection);
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

  async function share() {
    if (!healthy) return;
    setBusy(true);
    try {
      const r = await api.companionShareFile(asset.localPath, asset.name, shareMimeFor(asset.kind, asset.mime));
      if (r.status !== "ok") toast.error(r.message || "分享失败。");
    } catch (e: any) {
      toast.error(failureCopy(e, "分享失败。"));
    } finally {
      setBusy(false);
    }
  }

  const kindText = asset.kind === "document" ? "文档" : asset.kind === "video" ? "视频" : asset.kind === "image" ? "图片" : "文件";

  return (
    <>
      <BackHeader
        title="素材详情"
        onBack={onBack}
        right={
          <button
            className={"nav-action" + (asset.favorite ? " accent" : "")}
            onClick={toggleFavorite}
            aria-label={asset.favorite ? "取消收藏" : "收藏"}
          >
            {asset.favorite ? "★" : "☆"}
          </button>
        }
      />

      <MediaFirstLayout
        summary={{
          name: name || asset.name,
          lines: [kindText, fmt(asset.sizeBytes), ...(integrityError ? [integrityText[integrityError] || "文件异常"] : [])],
        }}
        stage={
          integrityError ? (
            <span style={{ color: "var(--ink2)" }}><IconFile size={30} /></span>
          ) : previewSrc ? (
            <MediaZoomLayer src={previewSrc} alt="" />
          ) : (
            <span style={{ color: "var(--ink2)" }}>
              {asset.kind === "video" ? <IconVideo size={30} /> : asset.kind === "document" || asset.kind === "file" ? <IconFile size={30} /> : <IconImage size={30} />}
            </span>
          )
        }
      >
        <div style={{ paddingTop: 6 }}>
          {integrityError ? (
            <Notice tone="danger">
              {integrityText[integrityError] || "文件异常"}
              {integrity?.hashVerified ? "（已执行完整性校验）" : ""} — 仅保留元数据，可删除该素材。
            </Notice>
          ) : null}

          <label>
            <span className="field-label" style={{ marginTop: integrityError ? 14 : 0 }}>名称</span>
            <input className="text-field" value={name} onChange={(e) => setName(e.target.value)} />
          </label>

          <div className="meta-stack">
            <div className="meta-line"><span>类型</span><b>{kindText} · {asset.mime}</b></div>
            <div className="meta-line"><span>大小</span><b>{fmt(asset.sizeBytes)}</b></div>
            <div className="meta-line"><span>指纹</span><b className="mono">{(asset.contentHash || "").slice(0, 16)}…</b></div>
            <div className="meta-line"><span>状态</span><b>{asset.favorite ? "★ 已收藏 · " : ""}{asset.archived ? "已归档" : "未归档"}</b></div>
          </div>

          {asset.tags?.length ? (
            <div className="chip-scroll" style={{ marginTop: 10 }}>
              {asset.tags.map((t: string) => (
                <button key={t} className="chip" onClick={() => removeTag(t)} title={`移除标签 ${t}`}>
                  #{t} ✕
                </button>
              ))}
            </div>
          ) : null}

          <label>
            <span className="field-label" style={{ marginTop: 8 }}>添加标签</span>
            <input
              className="text-field"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              placeholder="如：工作、旅行（逗号分隔）"
            />
          </label>

          <div className="btn-row">
            <button className="primary" disabled={busy} onClick={save}>
              保存
            </button>
            <button className="quiet" onClick={toggleArchive}>
              {asset.archived ? "取消归档" : "归档"}
            </button>
          </div>

          <div className="btn-row">
            <button className="quiet" disabled={busy || !healthy} onClick={exportToSystem}>
              {exportActionLabel(asset.kind)}
            </button>
            <button className="quiet" disabled={busy || !healthy} onClick={share}>
              分享
            </button>
          </div>

          <button className="quiet btn-block" style={{ marginTop: 8 }} disabled={busy || !healthy} onClick={openOriginal}>
            {asset.kind === "video" || asset.kind === "document" || asset.kind === "file" ? "打开原文件" : "查看原图"}
          </button>

          <button className="danger-btn btn-block" style={{ marginTop: 22 }} onClick={remove}>
            删除这条素材
          </button>
        </div>
      </MediaFirstLayout>
    </>
  );
}

function parseTags(input: string): string[] {
  return input
    .split(/[,，#\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function fmt(n: number) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}
