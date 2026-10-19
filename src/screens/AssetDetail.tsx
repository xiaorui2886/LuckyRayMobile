// AssetDetail.tsx (STITCH-R6) — 电脑素材详情.
//
// Visual source: R6 `function assetDetail(desktop)` — back header → hero
// preview (or 按需获取 empty state) → title/meta stack → acquisition actions.
//
// Behaviour source: production, unchanged. Read-only cached Desktop asset
// preview; all acquisition/cancel semantics are unchanged (on-demand fetch,
// explicit cancel, private-cache playback through a bounded lease), and image
// zoom stays a proper full-screen layer.
import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "../services/client";
import { IconClose, IconFile, IconImage, IconVideo } from "../components/icons";
import { contentError } from "../components/DesktopLibrary";
import CachedMedia from "../components/CachedMedia";
import { BackHeader, EmptyState, Notice } from "../components/ui";
import { MediaFirstLayout } from "../components/MediaFirstDetail";
import { MediaZoomLayer } from "../components/MediaZoomLayer";

/**
 * Legacy Desktop asset detail. Carries the SAME owner discipline as the
 * StillAsset detail: the Desktop instance is supplied by the caller (never
 * guessed from a live connection) and every read is bound to it.
 */
export default function AssetDetail({ instance, id, onBack }: { instance: string; id: string; onBack: () => void }) {
  const [asset, setAsset] = useState<any>(null);
  const [thumb, setThumb] = useState("");
  const [resource, setResource] = useState<{path: string; mime: string} | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [zoom, setZoom] = useState(false);
  const generation = useRef(0);
  const job = useRef("");

  useEffect(() => {
    const gen = ++generation.current;
    setAsset(null); setThumb(""); setResource(null); setMessage(""); setBusy(false);
    api.contentAssetDetail(instance, id).then(value => { if (gen === generation.current) setAsset(value); })
      .catch(e => { if (gen === generation.current) setMessage(contentError(e)); });
    api.assetThumbnail(instance, id).then(value => { if (gen === generation.current) setThumb(convertFileSrc(value.uri)); }).catch(() => {});
    void api.contentCachedResource(instance, id).then(cached => {
      if (gen === generation.current) setResource(cached);
    }).catch(() => {});
    return () => { generation.current++; if (job.current) void api.contentCancel(job.current); };
  }, [instance, id]);

  async function load() {
    if (busy) return;
    const gen = generation.current;
    const jobId = `download-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    job.current = jobId; setBusy(true); setMessage("");
    try {
      const value = await api.contentAssetFile(instance, id, jobId);
      if (gen !== generation.current) return;
      setResource(value);
      if (!/^(image|video|audio)\//.test(value.mime)) await api.contentOpenResource(instance, id);
    } catch (e) { if (gen === generation.current) setMessage(contentError(e)); }
    finally { if (gen === generation.current) { setBusy(false); job.current = ""; } }
  }

  const source = resource ? convertFileSrc(resource.path) : "";
  const isImage = Boolean(source && resource?.mime.startsWith("image/"));
  return <>
    <BackHeader
      title="电脑素材"
      backLabel="返回素材库"
      onBack={onBack}
    />

    <MediaFirstLayout
      summary={{
        name: asset?.name || "正在读取素材…",
        lines: [
          ...(asset ? [asset.kind, formatSize(asset.sizeBytes || 0)] : []),
          ...(resource ? ["已缓存"] : []),
        ],
      }}
      stage={
        <>
          {busy && !source ? <span className="progress-line" style={{ width: "60%", position: "absolute" }} /> : null}
          {resource && /^(video|audio)\//.test(resource.mime) ? (
            <span style={{ width: "100%", height: "100%" }}>
              <CachedMedia instance={instance} id={id} version={resource.path} mime={resource.mime} poster={thumb} />
            </span>
          ) : isImage ? (
            source ? (
              <MediaZoomLayer src={source} alt={asset?.name || ""} />
            ) : (
              <button aria-label="放大图片" onClick={() => setZoom(true)} style={{ border: 0, background: "transparent", display: "contents", width: "100%", height: "100%" }}>
                <img src={thumb} alt={asset?.name || ""} />
              </button>
            )
          ) : thumb ? (
            <img src={thumb} alt="素材预览" />
          ) : (
            <span style={{ color: "var(--ink2)" }}>
              {asset?.kind === "video" ? <IconVideo size={30} /> : asset?.kind === "document" ? <IconFile size={30} /> : <IconImage size={30} />}
            </span>
          )}
        </>
      }
    >
      <div style={{ paddingTop: 6 }}>
        {message ? <Notice tone="warn">{message}</Notice> : null}

        {asset ? (
          <>
            {asset.description ? (
              <p style={{ margin: "6px 0 10px", color: "var(--ink2)", fontSize: 12, lineHeight: 1.6 }}>{asset.description}</p>
            ) : null}
            <div className="meta-stack">
              <div className="meta-line"><span>类型</span><b>{asset.mimeType || asset.kind}</b></div>
              <div className="meta-line"><span>大小</span><b>{formatSize(asset.sizeBytes || 0)}</b></div>
              <div className="meta-line"><span>来源</span><b>电脑缓存（实验）</b></div>
            </div>
            <div className="btn-row" style={{ marginTop: 16 }}>
              <button className="primary" disabled={busy} onClick={load}>
                {busy ? "获取中…" : resource ? "重新获取原文件" : asset.kind === "video" ? "获取并播放视频" : "查看原文件"}
              </button>
            </div>
            {busy ? (
              <button className="quiet btn-block" style={{ marginTop: 8 }} onClick={() => void api.contentCancel(job.current)}>
                取消获取
              </button>
            ) : null}
            {resource && !/^(image|video|audio)\//.test(resource.mime) ? (
              <button
                className="quiet btn-block"
                style={{ marginTop: 8 }}
                onClick={() => void api.contentOpenResource(instance, id).catch(() => setMessage("未找到可打开此文件的应用。"))}
              >
                打开已缓存文件
              </button>
            ) : null}
          </>
        ) : (
          <EmptyState title="按需获取" body="原文件只在你需要时从电脑获取，并缓存在手机私有空间。" />
        )}
      </div>
    </MediaFirstLayout>

    {zoom && source ? (
      <div className="zoom-layer" role="dialog" aria-label="图片原图">
        <button className="zoom-close" aria-label="关闭" onClick={() => setZoom(false)}>
          <IconClose />
        </button>
        <img src={source} alt={asset?.name || ""} />
      </div>
    ) : null}
  </>;
}

function formatSize(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}
