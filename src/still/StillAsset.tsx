// STILL-01.1 — 素材查看 page (authority AssetDemo composition, real data).
// Local assets keep their real edit/export/share/delete authorities; Desktop
// assets stay read-only with on-demand acquisition and cancel. Image zoom is
// a media-layer-only interaction (data-media-zoom-layer) — the shell pinch
// blocker exempts exactly this layer.
import { useCallback, useEffect, useRef, useState } from "react";
import { Header, IconButton, Button, Sheet, Option, Empty, Icon } from "./kit/StillImports";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { api } from "../services/client";
import { localDataStore } from "../services/localDataStore";
import { dataStore } from "../services/dataStore";
import { contentError } from "../components/DesktopLibrary";
import { openInlineMediaLease, type MediaGrant } from "./kit/inlineMediaLease";
import "./assetDetail.css";
import {
  classifyExportDestination,
  exportActionLabel,
  exportCopyText,
  shareMimeFor,
} from "../services/exportPolicy";
import { failureCopy } from "../services/feedback";
import { toast } from "../services/toast";
import { fmtBytes } from "./stillData";
import { useStillNav } from "./StillShell";
import { MaterialOrganizationController, parseAssetRoute } from "./kit/materialOrganization";
import { createProductionServices, carrySafeSource } from "../services/companionServices/index.ts";
import { SourceEnrichmentController } from "../services/sourceEnrichment.ts";
import type { MaterialDetail } from "../../shared/companion-services-v1/types.ts";
import {
  sourceBlockOf, canonicalPageUrl,
  type SourceLoadState, type SourceBlockState,
} from "../services/sourceBlock";
import {
  PresentationActionController,
  type PresentFeedback,
} from "../services/presentationAction";
import { copyTextExact } from "../services/clipboardText";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ServicesSourceSection, sourceRetryText } from "./kit/servicesSourceSection";
import { thumbnailScheduler, desktopThumbKey, localThumbKey, materialImageVersion } from "../services/thumbnailQueue";

/** Presentation handoff for this one navigation route, not a data/cache authority. */
export type AssetPreview = { title: string; thumbnail: string; kind: string; version?: string };

type SheetName = "" | "info" | "more" | "rename" | "delete" | "acquire"
  | "organize" | "favorite" | "tags" | "folder" | "new-tag" | "new-folder";
const clamp = (v: number, lim: number) => Math.max(-lim, Math.min(lim, v));
// Native playback is the reviewed ordinary entry. Exact trial receipts are
// developer-only UI; the flag never gates playback or full-file acquisition.
const nativePlayerDiagnostics = import.meta.env.VITE_MATERIALS_NATIVE_PLAYER === "trial";
function videoFailureCopy(error: unknown): string {
  const code = String(error);
  if (/CODEC_UNSUPPORTED|TYPE_UNSUPPORTED/.test(code)) return "这段视频的格式或编码暂不受本机支持。可以在电脑打开，或换兼容版本。";
  if (/403|FORBIDDEN|GRANT_REQUIRED/.test(code)) return "没有读取这段视频的权限，请在电脑授权后重试。";
  if (/401|REVOKED|PAIRING_REQUIRED/.test(code)) return "电脑授权已失效，请检查连接设置。";
  if (/SOURCE_CHANGED/.test(code)) return "连接已变化，请回到素材库后重新打开。";
  if (/VERSION_CHANGED/.test(code)) return "电脑上的原文件已更新，请重新播放。";
  return "暂时无法播放，请检查连接后重试。";
}

export function StillAsset({ id, preview }: { id: string; preview?: AssetPreview }) {
  const { back, registerOverlay } = useStillNav();
  const route = parseAssetRoute(id);
  if (route.kind === "local") {
    return <LocalAsset key={route.assetId} localId={route.assetId} preview={preview} registerOverlay={registerOverlay} back={back} />;
  }
  if (route.kind === "desktop") {
    // The owner is proven by the route itself, so the page stays bound to one
    // Desktop for its whole lifetime.
    return <DesktopAsset key={`${route.owner}:${route.assetId}`} ownerInstanceId={route.owner} assetId={route.assetId} preview={preview} registerOverlay={registerOverlay} back={back} />;
  }
  // A route with no provable owner fails closed; it is never resolved by
  // guessing the owner from the live connection.
  return <UnownedAssetRoute back={back} />;
}

/** A Desktop asset route that carried no owner. There is no safe way to read
 *  it, so the page says so instead of silently picking a Desktop. */
function UnownedAssetRoute({ back }: { back: () => void }) {
  return (
    <>
      <Header title="电脑素材" left={<IconButton icon="back" label="返回素材库" onClick={back} />} />
      <div className="st-notice danger" role="status">
        这条素材没有记录所属电脑，无法安全打开。请返回后从素材库里重新打开。
      </div>
    </>
  );
}

function AssetHeader({ title, back }: { title: string; back: () => void }) {
  return <header className="st-asset-header"><IconButton icon="back" label="返回素材库" onClick={back} /><h1 title={title}>{title}</h1></header>;
}

function AssetAction({ icon, label, active, disabled, onClick }: { icon: string; label: string; active?: boolean; disabled?: boolean; onClick: () => void }) {
  return <button type="button" className={"st-asset-action" + (active ? " is-active" : "")} aria-label={label} aria-pressed={active} disabled={disabled} onClick={onClick}><Icon name={icon} size={23} /><span>{label}</span></button>;
}

/** Inline playback reuses the same owner-bound private lease as the native player.
 * A route/version/connection change unmounts it and retires pending grants. */
function InlineAssetVideo({ localPath, owner, id, poster, onFallback }: { localPath?: string; owner?: string; id: string; poster?: string; onFallback?: () => void }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const player = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = player.current;
    setError("");
    setUrl("");
    const jobId = `inline-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const retire = openInlineMediaLease({
      cached: () => owner ? api.contentMediaSource(owner, id) : api.localAssetMediaSource(id),
      stream: () => owner ? invoke<MediaGrant>("content_media_stream", { instance: owner, id, jobId }) : Promise.reject(new Error("CONTENT_NOT_CACHED")),
      release: api.contentMediaRelease,
      cancel: () => api.contentCancel(jobId),
      ready: setUrl,
      failed: (failure) => setError(videoFailureCopy(failure)),
    });
    return () => {
      element?.pause();
      element?.removeAttribute("src");
      element?.load();
      retire?.();
    };
  }, [owner, id, localPath]);
  return <div className="st-inline-video">
    <video ref={player} src={url || undefined} poster={poster} controls playsInline preload="metadata" aria-label="视频播放器" onError={() => setError("内嵌播放器暂不支持这段视频，可使用本机播放器。")} />
    {!url && !error ? <p role="status">正在准备视频…</p> : null}
    {error ? <div className="st-inline-video-error" role="status"><p>{error}</p>{onFallback ? <Button kind="quiet" onClick={onFallback}>使用本机播放器</Button> : null}</div> : null}
  </div>;
}

// --- shared zoomable media stage ---------------------------------------------

function ZoomStage({ src, alt, poster, video, onNeedOriginal, playLabel = "获取视频", playBusy = false, playMessage = "", notice = "", toggleSignal = 0 }: {
  src: string; alt: string;
  poster?: string; video?: { instance?: string; id: string; path: string; localPath?: string; epoch?: string } | null;
  onNeedOriginal?: () => void;
  playLabel?: string; playBusy?: boolean; playMessage?: string;
  notice?: string;
  toggleSignal?: number;
}) {
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const base = useRef({ distance: 0, zoom: 1, x: 0, y: 0, ox: 0, oy: 0 });
  const area = useRef<HTMLDivElement>(null);
  const firstSignal = useRef(toggleSignal);
  const [readySrc, setReadySrc] = useState("");
  const [imageError, setImageError] = useState("");
  useEffect(() => {
    let current = true;
    setImageError("");
    if (!src) { setReadySrc(""); return; }
    const image = new Image();
    image.onload = () => {
      void (image.decode ? image.decode() : Promise.resolve()).then(() => {
        if (current && image.naturalWidth > 0) setReadySrc(src);
      }).catch(() => { if (current) setImageError("图片暂时无法显示，可在更多操作中重新获取。"); });
    };
    image.onerror = () => { if (current) setImageError("图片暂时无法显示，可在更多操作中重新获取。"); };
    image.src = src;
    return () => { current=false; image.onload=null; image.onerror=null; image.src=""; };
  }, [src]);

  // The toolbar 放大图片 button drives the same media-layer zoom as double-tap.
  useEffect(() => {
    if (toggleSignal === firstSignal.current) return;
    firstSignal.current = toggleSignal;
    setZoom((z) => (z === 1 ? 2 : 1));
    setOffset({ x: 0, y: 0 });
  }, [toggleSignal]);

  return (
    <div
      ref={area}
      className="st-asset-area"
      data-media-zoom-layer="true"
      onDoubleClick={() => { if (video) return; setZoom((z) => (z === 1 ? 2 : 1)); setOffset({ x: 0, y: 0 }); }}
      onPointerDown={(e) => {
        if (!src || video) return;
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        e.currentTarget.setPointerCapture(e.pointerId);
        const pts = Array.from(pointers.current.values());
        base.current = {
          distance: pts.length === 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0,
          zoom, x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y,
        };
      }}
      onPointerMove={(e) => {
        if (!pointers.current.has(e.pointerId)) return;
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const pts = Array.from(pointers.current.values());
        if (pts.length === 2 && base.current.distance > 0) {
          const scale = Math.max(1, Math.min(4, base.current.zoom * Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) / base.current.distance));
          setZoom(scale);
          if (scale === 1) setOffset({ x: 0, y: 0 });
        } else if (zoom > 1) {
          const r = area.current!.getBoundingClientRect();
          setOffset({
            x: clamp(base.current.ox + e.clientX - base.current.x, r.width * (zoom - 1) / 2),
            y: clamp(base.current.oy + e.clientY - base.current.y, r.height * (zoom - 1) / 2),
          });
        }
      }}
      onPointerUp={(e) => pointers.current.delete(e.pointerId)}
      onPointerCancel={(e) => pointers.current.delete(e.pointerId)}
    >
      {video ? (
        <InlineAssetVideo key={`${video.instance || "local"}:${video.id}:${video.path}:${video.epoch || ""}`} owner={video.instance} id={video.id} localPath={video.localPath} poster={poster} onFallback={onNeedOriginal} />
      ) : readySrc && src ? (
        <img src={readySrc} alt={alt} style={{ transform: `translate(${offset.x}px,${offset.y}px) scale(${zoom})` }} />
      ) : poster ? (
        <img src={poster} alt={alt} />
      ) : null}
      {onNeedOriginal && !video ? (
        <button style={{ position: "absolute", background: "rgba(0,0,0,.65)", color: "white", border: 0, borderRadius: 24, width: 48, height: 48, display: "grid", placeItems: "center" }}
          aria-label={playLabel} disabled={playBusy} onClick={onNeedOriginal}><Icon name="play" /></button>
      ) : null}
      {playBusy || playMessage || notice || imageError ? <div className="st-media-feedback" role="status">{playBusy ? "正在准备播放…" : playMessage || notice || imageError}</div> : null}
    </div>
  );
}

// --- 本机素材 -----------------------------------------------------------------

function LocalAsset({ localId, preview, registerOverlay, back }: {
  localId: string; preview?: AssetPreview; registerOverlay: (d: () => void) => () => void; back: () => void;
}) {
  const { mode } = useStillNav();
  const [asset, setAsset] = useState<any>(null);
  const [favoriteBusy, setFavoriteBusy] = useState(false);
  const favoritePending = useRef(false);
  const [integrity, setIntegrity] = useState<any>(null);
  const [loadError, setLoadError] = useState("");
  const [sheet, setSheet] = useState<SheetName>("");
  const [name, setName] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [screenPreview, setScreenPreview] = useState("");
  const [previewRetry, setPreviewRetry] = useState(0);
  const appliedPreviewRetry = useRef(0);
  const [playBusy, setPlayBusy] = useState(false);
  const [playMessage, setPlayMessage] = useState("");
  const playPosition = useRef(0), playJob = useRef("");
  const playGeneration = useRef(0);
  useEffect(()=>{
    playGeneration.current++;
    playPosition.current=0;
    return ()=>{
      playGeneration.current++;
      if(playJob.current) void api.contentCancel(playJob.current);
    };
  },[localId]);

  useEffect(() => {
    let live=true;
    setScreenPreview("");
    if (asset?.kind === "image" && integrity?.status === "healthy") {
      const force=previewRetry>appliedPreviewRetry.current;
      appliedPreviewRetry.current=previewRetry;
      void thumbnailScheduler.enqueue(localThumbKey(localId,materialImageVersion(asset),true),()=>api.localAssetThumbnail(localId,true,force),"near")
        .then(value=>{if(live) {setLoadError("");setScreenPreview(convertFileSrc(value.uri)+(force ? `?preview=${previewRetry}` : ""));}})
        .catch(()=>{if(live) setLoadError("预览暂时不可用，可在更多操作中打开原图。");});
    }
    return ()=>{live=false;};
  },[localId,asset?.contentHash,asset?.kind,integrity?.status,previewRetry]);

  useEffect(() => {
    let alive = true;
    api.localAssetGet(localId).then((a) => { if (alive) { setAsset(a); setName(a.name ?? ""); } })
      .catch((e: any) => { if (alive) setLoadError(failureCopy(e, "读不到这条素材。")); });
    api.localAssetIntegrity(localId, true).then((r) => { if (alive) setIntegrity(r); }).catch(() => {if(alive) setLoadError("暂时无法读取本机文件，可稍后重新打开。");});
    return () => { alive = false; };
  }, [localId]);

  if (!asset) {
    return (
      <div className="st-asset-view">
        <AssetHeader title={preview?.title || "正在读取素材…"} back={back} />
        <ZoomStage src="" poster={loadError ? "" : preview?.thumbnail} alt={preview?.title || "素材"} notice={loadError || "正在读取本机文件…"} />
        <div className="st-asset-actions" role="toolbar" aria-label="素材操作">{[["share", "分享"], ["heart", "收藏"], ["info", "信息"], ["trash", "删除"], ["more", "更多"]].map(([icon, label]) => <AssetAction key={icon} icon={icon} label={label} disabled onClick={() => {}} />)}</div>
      </div>
    );
  }

  const healthy = integrity?.status === "healthy";
  const integrityError = integrity && integrity.status !== "healthy" ? integrity.status : null;
  const kindText = asset.kind === "document" ? "文档" : asset.kind === "video" ? "视频" : asset.kind === "image" ? "图片" : "文件";
  const previewSrc = asset.kind === "image" && healthy ? screenPreview : "";
  const integrityText: Record<string, string> = {
    missing: "文件缺失", unreadable: "文件无法读取",
    "size-mismatch": "文件大小异常", "hash-mismatch": "文件完整性校验失败",
  };

  async function toggleFavorite() {
    if (favoritePending.current) return;
    favoritePending.current = true; setFavoriteBusy(true);
    try {
      await api.localAssetSetFlags(localId, { favorite: !asset.favorite });
      setAsset({ ...asset, favorite: !asset.favorite });
      localDataStore.publish("asset");
    } catch (e: any) { toast.error(failureCopy(e, "操作失败。")); }
    finally { favoritePending.current = false; setFavoriteBusy(false); }
  }

  // A4 (LOCAL-LIBRARY-USABILITY-R1): archive/unarchive through the existing
  // flag authority. The original file is never touched — only the archived
  // flag — and the library list converges via the localDataStore publish.
  async function toggleArchive() {
    try {
      await api.localAssetSetFlags(localId, { archived: !asset.archived });
      setAsset({ ...asset, archived: !asset.archived });
      localDataStore.publish("asset");
      toast.success(asset.archived ? "已取消归档" : "已归档");
    } catch (e: any) { toast.error(failureCopy(e, "操作失败。")); }
  }

  async function saveMeta() {
    setBusy(true);
    try {
      const tags = tagInput.split(/[,，#\s]+/).map((t: string) => t.trim()).filter(Boolean).concat(asset.tags || []);
      const updated = await api.localAssetUpdate(localId, name.trim() || asset.name, Array.from(new Set(tags)));
      setAsset(updated);
      setTagInput("");
      toast.success("已保存");
      localDataStore.publish("asset");
      setSheet("");
    } catch (e: any) {
      toast.error(failureCopy(e, "保存失败。"));
    } finally { setBusy(false); }
  }

  async function exportToSystem() {
    if (!healthy) return;
    setBusy(true);
    try {
      const collection = classifyExportDestination(asset.kind, asset.mime);
      const r = await api.companionExport(asset.localPath, asset.name, asset.mime, collection);
      if (r.status === "created" || r.status === "already_exists") toast.success(exportCopyText(r.status, collection));
      else toast.error(r.message || "保存失败。");
    } catch (e: any) {
      toast.error(failureCopy(e, "保存失败。"));
    } finally { setBusy(false); }
  }

  async function share() {
    if (!healthy) return;
    setBusy(true);
    try {
      const r = await api.companionShareFile(asset.localPath, asset.name, shareMimeFor(asset.kind, asset.mime));
      if (r.status !== "ok") toast.error(r.message || "分享失败。");
    } catch (e: any) {
      toast.error(failureCopy(e, "分享失败。"));
    } finally { setBusy(false); }
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

  async function playVideo() {
    if(!healthy || playJob.current) return;
    const gen=playGeneration.current;
    const jobId=`play-local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    playJob.current=jobId;setPlayBusy(true);setPlayMessage("");
    try {
      const result=await api.localAssetVideoPlay(localId,jobId,asset.name||"视频",playPosition.current,mode==="dark");
      if(gen!==playGeneration.current) return;
      if(Number.isFinite(result.positionMs)) playPosition.current=result.reason==="ended" ? 0 : Math.max(0,result.positionMs);
      if(result.errorCode) setPlayMessage(videoFailureCopy(result.errorCode));
    } catch(error) {if(gen===playGeneration.current) setPlayMessage(videoFailureCopy(error));}
    finally {if(playJob.current===jobId) playJob.current="";if(gen===playGeneration.current) setPlayBusy(false);}
  }

  async function remove() {
    try {
      await api.localAssetDelete(localId);
      localDataStore.publish("asset");
      back();
    } catch (e: any) {
      toast.error(failureCopy(e, "删除失败。"));
    }
  }

  return (
    <>
      <div className={"st-asset-view" + (asset.kind === "image" ? " is-image" : "")}>
        <AssetHeader title={asset.name} back={back} />
        <ZoomStage src={previewSrc} poster={!integrityError ? preview?.thumbnail : ""} alt={asset.name}
          video={asset.kind === "video" && healthy ? { id: localId, path: asset.contentHash || asset.localPath, localPath: asset.localPath } : null}
          onNeedOriginal={asset.kind==="video" && healthy ? ()=>void playVideo() : undefined}
          playLabel="播放视频" playBusy={playBusy} playMessage={playMessage}
          notice={integrityError ? `${integrityText[integrityError] || "文件异常"} — 仅保留元数据。` : loadError} />
        <div className="st-asset-actions" role="toolbar" aria-label="素材操作">
          <AssetAction icon="share" label="分享" disabled={!healthy || busy} onClick={() => void share()} />
          <AssetAction icon="heart" label={asset.favorite ? "取消收藏" : "收藏"} active={Boolean(asset.favorite)} disabled={favoriteBusy} onClick={() => void toggleFavorite()} />
          <AssetAction icon="info" label="信息" onClick={() => setSheet("info")} />
          <AssetAction icon="trash" label="删除" onClick={() => setSheet("delete")} />
          <AssetAction icon="more" label="更多" onClick={() => setSheet("more")} />
        </div>
      </div>
      {sheet === "info" ? (
        <Sheet title="素材信息" registerDismiss={registerOverlay} onClose={() => setSheet("")}>
          <div className="st-metadata-row"><span>名称</span><b>{asset.name}</b></div>
          <div className="st-metadata-row"><span>来源</span><b>本机素材</b></div>
          <div className="st-metadata-row"><span>类型</span><b>{kindText}</b></div>
          <div className="st-metadata-row"><span>大小</span><b>{fmtBytes(asset.sizeBytes || 0)}</b></div>
        </Sheet>
      ) : null}
      {sheet === "more" ? (
        <Sheet title="素材操作" registerDismiss={registerOverlay} onClose={() => setSheet("")}>
          <Option label={asset.archived ? "取消归档" : "归档"} icon="archive" onClick={() => { void toggleArchive(); setSheet(""); }} />
          <Option label={healthy ? exportActionLabel(asset.kind) : "文件异常，无法导出"} icon="image" onClick={() => { if (healthy) { setSheet(""); void exportToSystem(); } }} />
          {asset.kind === "image" ? <Option label="查看原图" icon="zoom" onClick={() => { if (healthy) { setSheet(""); void openOriginal(); } }} /> : <Option label="打开原文件" icon="file" onClick={() => { if (healthy) { setSheet(""); void openOriginal(); } }} />}
          {asset.kind==="image" && healthy ? <Option label="重试清晰预览" icon="refresh" onClick={()=>{setSheet("");setPreviewRetry(v=>v+1);}} /> : null}
          <Option label="重命名与标签" icon="edit" onClick={() => { setName(asset.name); setTagInput(""); setSheet("rename"); }} />
        </Sheet>
      ) : null}
      {sheet === "rename" ? (
        <Sheet title="重命名与标签" registerDismiss={registerOverlay} onClose={() => setSheet("")} busy={busy}
          footer={<Button disabled={busy} onClick={() => void saveMeta()}>保存</Button>}>
          <label className="st-field">名称
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="st-field">添加标签
            <input value={tagInput} onChange={(e) => setTagInput(e.target.value)} placeholder="如：工作、旅行（逗号分隔）" />
          </label>
          {asset.tags?.length ? (
            <div style={{ marginTop: 10 }}>
              {asset.tags.map((t: string) => (
                <Option key={t} label={"#" + t} icon="list" onClick={() => {
                  const tags = (asset.tags || []).filter((x: string) => x !== t);
                  api.localAssetUpdate(localId, asset.name, tags).then((updated: any) => {
                    setAsset(updated); localDataStore.publish("asset");
                  }).catch((e: any) => toast.error(failureCopy(e, "删除标签失败。")));
                }} />
              ))}
            </div>
          ) : null}
        </Sheet>
      ) : null}
      {sheet === "delete" ? (
        <Sheet title="删除这条素材？" registerDismiss={registerOverlay} onClose={() => setSheet("")}
          footer={<>
            <Button kind="quiet" onClick={() => setSheet("")}>取消</Button>
            <Button kind="danger" onClick={() => { setSheet(""); void remove(); }}>删除</Button>
          </>}>
          <p className="st-sheet-copy">删除本机素材「{asset.name}」及其所属文件。收集箱和笔记不受影响。</p>
        </Sheet>
      ) : null}
    </>
  );
}

// --- 电脑素材 -----------------------------------------------------------------

function DesktopAsset({ ownerInstanceId, assetId, preview, registerOverlay, back }: {
  ownerInstanceId: string; assetId: string; preview?: AssetPreview; registerOverlay: (d: () => void) => () => void; back: () => void;
}) {
  const { conn, mode } = useStillNav();
  const [asset, setAsset] = useState<any>(null);
  const [thumb, setThumb] = useState(preview?.thumbnail || "");
  const [resource, setResource] = useState<{ path: string; mime: string } | null>(null);
  const [screenPreview, setScreenPreview] = useState("");
  const [previewRetry, setPreviewRetry] = useState(0);
  const appliedPreviewRetry = useRef(0);
  const validationAttempt = useRef("");
  const [message, setMessage] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState<SheetName>("");
  const [playBusy, setPlayBusy] = useState(false);
  const [playMessage, setPlayMessage] = useState("");
  const [playEvidence, setPlayEvidence] = useState<Awaited<ReturnType<typeof api.contentVideoPlay>> | null>(null);
  const playJob = useRef("");
  const playPosition = useRef(0);
  // The owner is fixed by the ROUTE at mount and never re-derived from a live
  // connection. Every read below is issued against it and the authority refuses
  // (`CONTENT_SOURCE_CHANGED`) rather than serving a different Desktop.
  const owner = ownerInstanceId;
  // Wave A: Desktop remains the authority; the controller owns the single
  // in-flight organization request and the identity fence.
  const org = useRef(new MaterialOrganizationController({
    setFavorite: (i, id, fav) => api.contentMaterialSetFavorite(i, id, fav),
    setTags: (i, id, patch) => api.contentMaterialSetTags(i, id, patch),
    setFolder: (i, id, folderId) => api.contentMaterialSetFolder(i, id, folderId),
    createTag: (i, name) => api.contentMaterialCreateTag(i, name),
    createFolder: (i, name) => api.contentMaterialCreateFolder(i, name),
    batch: (i, input) => api.contentMaterialBatch(i, input),
  })).current;
  const [orgSnapshot, setOrgSnapshot] = useState(org.snapshot());
  useEffect(() => org.subscribe(setOrgSnapshot), [org]);
  // The REAL detail generation. It is bumped on mount, on route/owner change,
  // and on unmount, so an in-flight detail read or revalidation whose page is
  // gone can never commit.
  const detailGen = useRef(0);
  const readSeq = useRef(0);
  const assetRef = useRef<any>(null);
  const thumbRef = useRef(preview?.thumbnail || "");
  const denied = useRef(false);
  const job = useRef("");
  // SERVICES-ASSET-DETAIL-R1: additive Services V1 enrichment for the SAME
  // desktop asset — canonical source fidelity + "在电脑打开". Content V1 stays
  // the primary detail authority above; this is an additive block.
  const services = useRef(createProductionServices()).current;
  const [sourceState, setSourceState] = useState<SourceLoadState>({ phase: "idle" });
  const [present, setPresent] = useState<PresentFeedback | null>(null);
  const presentRef = useRef<PresentationActionController | null>(null);
  if (!presentRef.current) {
    presentRef.current = new PresentationActionController(services.presentation, {
      getFeedback: (f) => setPresent(f),
      // A late outcome may only commit while this exact page context is still
      // current (same generation, same owner, same asset).
      isCurrent: (ctx) => ctx.generation === detailGen.current,
    });
  }
  const presentCtrl = presentRef.current;
  // REPAIR-R1 P1-C1 / REPAIR-R2 R2-A — the source enrichment runs through the
  // PRODUCTION SourceEnrichmentController (independent token seam; the same
  // implementation the deferred-order tests exercise):
  //   latest-request-wins, exact owner+asset binding per bind, route/unmount
  //   and connection-drop retirement, and explicit retry as the
  //   permission-change recovery path (no polling, no new wire).
  const sourceCtrl = useRef<SourceEnrichmentController | null>(null);
  if (!sourceCtrl.current) {
    sourceCtrl.current = new SourceEnrichmentController({
      detailV1: (ownerId, asset) => services.materials.detailV1(ownerId, asset),
      commit: (c) => {
        if (c.phase === "ready") setSourceState({ phase: "ready", source: carrySafeSource(c.source) });
        else if (c.phase === "error") setSourceState({ phase: "error", code: c.code });
        else setSourceState({ phase: "loading" });
      },
      errorCodeOf: (e) => (e && typeof e === "object" && "code" in e) ? String((e as { code: unknown }).code) : "TRANSPORT_FAILED",
    });
  }
  const sourceCtrlRef = sourceCtrl.current;
  const sourceGen = useRef(0);

  const loadSource = useCallback(() => {
    sourceCtrlRef.load();
  }, [sourceCtrlRef]);

  const currentOwner = conn?.identity?.instanceId || "";
  const ownerMismatch = Boolean(owner) && currentOwner !== owner;

  /** The user's explicit 「重试来源」: same page, same owner+asset, newest
   *  token — succeeds without leaving the detail once Desktop grants read.
   *  This is the permission-change recovery path (no polling, no new wire). */
  const retrySource = useCallback(() => {
    if (ownerMismatch) return;
    loadSource();
  }, [loadSource, ownerMismatch]);

  const readDetail = useCallback(async () => {
    const gen=detailGen.current, seq=++readSeq.current;
    const current=()=>gen===detailGen.current && seq===readSeq.current;
    try {
      const value=await api.contentAssetDetail(owner,assetId);
      if (!current()) return;
      const version=materialImageVersion(value);
      const previous=assetRef.current ? materialImageVersion(assetRef.current) : preview?.version;
      const changed=previous!==undefined && previous!==version;
      const recovering=denied.current;
      assetRef.current=value; denied.current=false; setUnavailable(false); setAsset(value); setMessage("");
      if (recovering) {sourceCtrlRef.bind({owner,assetId,isLive:()=>gen===detailGen.current});loadSource();}
      if (changed) {thumbRef.current="";setThumb("");setScreenPreview("");playPosition.current=0;}
      if (!thumbRef.current) void thumbnailScheduler.enqueue(desktopThumbKey(owner,assetId,version),()=>api.assetThumbnail(owner,assetId,false,false,version),"near")
        .then(v=>{if(current()&&!denied.current&&materialImageVersion(assetRef.current)===version){thumbRef.current=convertFileSrc(v.uri);setThumb(thumbRef.current);}}).catch(()=>{});
    } catch (error) {
      if (!current()) return;
      if (/401|403|404|410|FORBIDDEN|REVOKED|NOT_FOUND|SOURCE_CHANGED/.test(String(error))) {
        denied.current=true;assetRef.current=null;thumbRef.current="";
        setAsset(null);setThumb("");setResource(null);setScreenPreview("");setUnavailable(true);
        sourceCtrlRef.retire();presentCtrl.retire();setSourceState({phase:"error",code:"GRANT_REQUIRED"});setPresent(null);
        if(job.current) void api.contentCancel(job.current);
        if(playJob.current) void api.contentCancel(playJob.current);
      }
      setMessage(contentError(error));
    }
  },[owner,assetId]);

  useEffect(() => {
    const gen = ++detailGen.current;
    assetRef.current=null;denied.current=false;thumbRef.current=preview?.thumbnail||"";
    setAsset(null); setThumb(thumbRef.current); setResource(null); setScreenPreview("");setUnavailable(false);setMessage(""); setBusy(false);
    setPlayBusy(false); setPlayMessage(""); setPlayEvidence(null); playPosition.current = 0;
    setPresent(null);
    org.setIdentity(owner);
    // Bind the presentation action to THIS page context; any previous
    // handle (older asset/owner) is retired so its late outcome is a no-op.
    presentCtrl.bind({ owner, assetId, generation: gen });
    // Bind the source enrichment to THIS page context too (retires the
    // previous asset/owner request), then issue the read.
    sourceGen.current = gen;
    sourceCtrlRef.bind({ owner, assetId, isLive: () => gen === detailGen.current });
    // Every read is expected-instance: the owner this page belongs to, not the
    // Desktop that happens to be connected when the promise settles.
    void readDetail();
    void api.contentCachedResource(owner, assetId).then((cached) => {
      if (gen === detailGen.current && !denied.current) setResource(cached);
    }).catch(() => {});
    // Services V1 enrichment through the production controller.
    loadSource();
    return () => {
      detailGen.current++;
      // Retire any outstanding source request for the gone page context.
      sourceCtrlRef.retire();
      presentCtrl.retire();
      if (job.current) void api.contentCancel(job.current);
      if (playJob.current) void api.contentCancel(playJob.current);
    };
    // `services`, `presentCtrl`, `loadSource`, `sourceCtrlRef` are stable
    // refs/callbacks; the effect's identity contract stays exactly the Wave A
    // [owner, assetId, org] triple.
  }, [owner, assetId, org]);

  useEffect(()=>dataStore.subscribe(()=>void readDetail()),[readDetail]);

  useEffect(() => {
    let live=true;
    if (!resource?.mime.startsWith("image/") || !asset || unavailable || ownerMismatch) return;
    const gen=detailGen.current, version=materialImageVersion(asset);
    const force=previewRetry>appliedPreviewRetry.current;
    appliedPreviewRetry.current=previewRetry;
    async function prepare() {
      try {
        const v=await thumbnailScheduler.enqueue(desktopThumbKey(owner,assetId,version,true),()=>api.assetThumbnail(owner,assetId,force,true,version),"near");
        if(live && gen===detailGen.current && !denied.current && materialImageVersion(assetRef.current)===version) {setMessage("");setScreenPreview(convertFileSrc(v.uri)+(force ? `?preview=${previewRetry}` : ""));}
      } catch(error) {
        if(!live || gen!==detailGen.current || denied.current || materialImageVersion(assetRef.current)!==version) return;
        // One legacy cached-original validation through the existing GET;
        // failure leaves the thumbnail and explicit retry, never a read loop.
        if(String(error).includes("VERSION_UNCONFIRMED") && version && conn?.ws?.state==="connected" && validationAttempt.current!==version) {validationAttempt.current=version;await load();}
        else setMessage(String(error).includes("VERSION") ? "清晰内容版本尚未确认，可重新获取；现显示缩略图。" : "清晰预览暂时不可用，可重新获取或打开原文件。");
      }
    }
    void prepare();
    return ()=>{live=false;};
  },[resource,asset?.contentHash,asset?.thumbnailRevision,asset?.updatedAt,ownerMismatch,unavailable,owner,assetId,previewRetry]);

  // REPAIR-R1 P1-C1: a meaningful same-Desktop connection transition (drop ->
  // reconnect) retires the old source request epoch and re-reads — the Rust
  // authority retires network epochs on reconnect, so a pre-drop answer must
  // not become the post-reconnect truth. No polling; existing signals only.
  const wsState = conn?.ws?.state || "";
  const prevWsRef = useRef(wsState);
  useEffect(() => {
    const prev = prevWsRef.current;
    prevWsRef.current = wsState;
    if (prev === wsState) return;
    const dropped = prev === "connected" && wsState !== "connected";
    const reconnected = wsState === "connected" && prev !== "connected";
    if (dropped) {
      readSeq.current++;
      // Retire the outstanding source request: anything it returns belongs to
      // the previous connection epoch.
      sourceCtrlRef.retire();
      if (sourceState.phase !== "idle") setSourceState({ phase: "error", code: "SERVICE_UNAVAILABLE" });
    } else if (reconnected && !ownerMismatch) {
      void readDetail();
      // Same Desktop came back: re-read the enrichment once (fresh binding so
      // the controller is live again after the drop's retire()).
      sourceCtrlRef.bind({ owner, assetId, isLive: () => sourceGen.current === detailGen.current });
      loadSource();
    }
  }, [wsState, ownerMismatch, owner, assetId, loadSource, sourceCtrlRef]);

  useEffect(() => () => org.dispose(), [org]);

  /** Re-read the authoritative asset row after a mutation. Same fixed owner and
   *  the same generation fence: a response for a page that is no longer current
   *  — or for a Desktop that is no longer the owner — never commits. */
  const revalidate = readDetail;

  /** Every organization entry point funnels through this: a detail page whose
   *  Desktop is no longer current refuses instead of retargeting. */
  function guardOrganization(): boolean {
    if (!owner) {
      setMessage("这条素材没有记录所属电脑，请返回后重新打开。");
      return false;
    }
    if (ownerMismatch) {
      setMessage("当前电脑已更换，这条素材属于原来那台电脑。请返回并重新打开后再整理。");
      return false;
    }
    return true;
  }

  async function load() {
    if (job.current || unavailable || ownerMismatch) return;
    const gen = detailGen.current;
    const jobId = `download-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    job.current = jobId; setBusy(true); setMessage("");
    try {
      const value = await api.contentAssetFile(owner, assetId, jobId);
      if (gen !== detailGen.current || denied.current) return;
      setResource(value);
      if (!/^(image|video|audio)\//.test(value.mime)) await api.contentOpenResource(owner, assetId);
    } catch (e) { if (gen === detailGen.current) setMessage(contentError(e)); }
    finally { if (gen === detailGen.current) { setBusy(false); job.current = ""; } }
  }

  const source = !unavailable && !ownerMismatch ? screenPreview : "";
  const isVideo = Boolean(resource?.mime.startsWith("video/"));
  const kindText = asset?.kind === "video" ? "视频" : asset?.kind === "document" ? "文档" : "图片";

  // --- SERVICES-ASSET-DETAIL-R1: source block + 在电脑打开 -------------------
  const block: SourceBlockState = sourceState.phase === "ready"
    ? sourceBlockOf({ source: sourceState.source } as MaterialDetail)
    : sourceState.phase === "loading" ? { kind: "loading" } : { kind: "none" };
  const pageUrl = canonicalPageUrl(block);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [pendingPresent, setPendingPresent] = useState(false);

  /** Open the EXACT canonical page URL in the SYSTEM browser. */
  async function openPageInBrowser(): Promise<void> {
    if (!pageUrl) return;
    try {
      await openUrl(pageUrl);
    } catch {
      setMessage("无法打开系统浏览器。");
    }
  }

  /** Copy the EXACT canonical page URL byte-for-byte (WebView83-safe). */
  async function copyPageUrl(): Promise<void> {
    if (!pageUrl) return;
    const result = await copyTextExact(pageUrl);
    setCopyState(result);
    if (result === "copied") toast.success("已复制来源链接");
    else setMessage("复制失败，请长按链接手动复制。");
  }

  /** One explicit user action = one operation (controller coalesces/retries). */
  function openOnDesktop(): void {
    if (ownerMismatch) {
      setMessage("当前电脑已更换，这条素材属于原来那台电脑，无法在此打开。");
      return;
    }
    if (!owner) {
      setMessage("这条素材没有记录所属电脑，请返回后重新打开。");
      return;
    }
    if (pendingPresent) return; // double-tap coalesces into the same operation
    setPendingPresent(true);
    setPresent({ tone: "pending", text: "正在请求电脑打开…" });
    void presentCtrl.open().finally(() => setPendingPresent(false));
  }

  async function playVideo() {
    if (playJob.current || busy || unavailable || ownerMismatch) return;
    const gen = detailGen.current;
    const jobId = `play-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    playJob.current = jobId; setPlayBusy(true); setPlayMessage(""); setPlayEvidence(null);
    try {
      const result = await api.contentVideoPlay(owner, assetId, jobId, asset?.name || preview?.title || "视频", playPosition.current, mode==="dark");
      if (gen !== detailGen.current) return;
      if (Number.isFinite(result.positionMs)) playPosition.current = result.reason === "ended" ? 0 : Math.max(0, result.positionMs);
      if (result.errorCode?.includes("VERSION_CHANGED")) playPosition.current = 0;
      setPlayEvidence(result);
      if (result.errorCode) setPlayMessage(videoFailureCopy(result.errorCode));
    } catch (e) {
      if (gen === detailGen.current) setPlayMessage(videoFailureCopy(e));
    } finally {
      if (playJob.current === jobId) playJob.current = "";
      if (gen === detailGen.current) setPlayBusy(false);
    }
  }

  const sourceSectionProps = {
    block, loading: sourceState.phase === "loading",
    errorCode: sourceState.phase === "error" ? sourceState.code : undefined,
    present, pendingPresent, copyState,
    onRetrySource: retrySource,
    onOpenBrowser: () => void openPageInBrowser(),
    onCopy: () => void copyPageUrl(),
    onOpenDesktop: openOnDesktop,
  };

  return (
    <>
      <div className={"st-asset-view" + ((asset?.kind || preview?.kind) === "image" ? " is-image" : "")}>
        <AssetHeader title={unavailable ? "素材暂不可用" : asset?.name || preview?.title || "正在读取素材…"} back={back} />
        <ZoomStage
          src={source && !isVideo ? source : ""}
          alt={asset?.name || preview?.title || "素材"}
          poster={!unavailable && !ownerMismatch ? thumb : ""}
          video={!unavailable && !ownerMismatch && asset?.kind === "video" ? { instance: owner, id: assetId, path: materialImageVersion(asset), epoch: wsState } : null}
          onNeedOriginal={!unavailable && !ownerMismatch && (asset?.kind || preview?.kind) === "video" ? () => void playVideo() : undefined}
          playLabel="播放视频" playBusy={playBusy} playMessage={playMessage}
          notice={ownerMismatch ? "当前电脑已更换，请返回素材库重新打开。" : orgSnapshot.error || (orgSnapshot.busy ? "正在同步收藏与整理状态…" : "") || message || (busy && !source ? "正在从电脑获取原文件…" : "")}
        />
        <div className="st-asset-actions" role="toolbar" aria-label="素材操作">
          <AssetAction icon="heart" label={asset?.favorite ? "取消收藏" : "收藏"} active={Boolean(asset?.favorite)}
            disabled={ownerMismatch || unavailable || !asset || orgSnapshot.busy}
            onClick={() => {
              if (!guardOrganization()) return;
              void org.setFavorite(assetId, !asset?.favorite, revalidate);
            }} />
          <AssetAction icon="info" label="信息" onClick={() => setSheet("info")} />
          <AssetAction icon="trash" label="删除" onClick={() => toast.info("请在电脑端删除这条素材，手机暂不支持删除电脑素材。")} />
          <AssetAction icon="more" label="更多" onClick={() => setSheet("more")} />
        </div>
      </div>
      {sheet === "info" ? (
        <Sheet title="素材信息" registerDismiss={registerOverlay} onClose={() => setSheet("")}>
          <div className="st-metadata-row"><span>名称</span><b>{asset?.name || preview?.title || "暂未取得"}</b></div>
          <div className="st-metadata-row"><span>位置</span><b>电脑素材</b></div>
          <div className="st-metadata-row"><span>离线</span><b>{resource ? "原文件已完整保存" : "原文件尚未保存到手机"}</b></div>
          <div className="st-metadata-row"><span>类型</span><b>{kindText}</b></div>
          <div className="st-metadata-row"><span>大小</span><b>{typeof asset?.sizeBytes === "number" && Number.isFinite(asset.sizeBytes) && asset.sizeBytes >= 0 ? fmtBytes(asset.sizeBytes) : "暂未取得"}</b></div>
          {nativePlayerDiagnostics && playEvidence ? <>
            <div className="st-metadata-row"><span>首帧（原生试验）</span><b>{playEvidence.firstFrameMs == null ? "未取得首帧" : `${(playEvidence.firstFrameMs / 1000).toFixed(2)} 秒`}</b></div>
            <div className="st-metadata-row"><span>首帧前远端读取</span><b>{fmtBytes(playEvidence.remoteBytesBeforeFirstFrame || 0)} / {fmtBytes(playEvidence.sizeBytes || 0)}</b></div>
            <div className="st-metadata-row"><span>本次远端读取</span><b>{fmtBytes(playEvidence.remoteBytes || 0)}</b></div>
            <div className="st-metadata-row"><span>精确首帧前读取</span><b>{playEvidence.remoteBytesBeforeFirstFrame ?? "未取得"} / {playEvidence.sizeBytes} B</b></div>
            <div className="st-metadata-row"><span>精确传输回执</span><b>{playEvidence.transport} · {playEvidence.remoteBytes} B · {playEvidence.firstFrameMs ?? "未取得"} ms · {playEvidence.rangeRequests ?? 0} Range</b></div>
            <div className="st-metadata-row"><span>关闭位置 / 时长</span><b>{playEvidence.positionMs} / {playEvidence.durationMs} ms · {playEvidence.reason}</b></div>
            {playEvidence.format ? <>
              <div className="st-metadata-row"><span>实际视频格式</span><b>{playEvidence.format.videoMime || "未取得"} · {playEvidence.format.width ?? "?"}×{playEvidence.format.height ?? "?"}</b></div>
              <div className="st-metadata-row"><span>实际视频解码器</span><b>{playEvidence.format.videoDecoder || "未取得"} · {playEvidence.format.codecs || "未报 profile"}</b></div>
              <div className="st-metadata-row"><span>实际位深 / 帧率</span><b>{playEvidence.format.lumaBitdepth ?? "未报"}/{playEvidence.format.chromaBitdepth ?? "未报"} bit · {playEvidence.format.frameRate ?? "未报"} fps</b></div>
              <div className="st-metadata-row"><span>实际音频解码器</span><b>{playEvidence.format.audioDecoder || "未取得"} · {playEvidence.format.audioMime || "未取得"}</b></div>
              <div className="st-metadata-row"><span>音轨推进（不代表实听）</span><b>{playEvidence.format.audioAdvancing ? "是" : "未取得"} · 重试 {playEvidence.format.rangeRetries ?? 0}</b></div>
            </> : null}
          </> : null}
          <ServicesSourceSection {...sourceSectionProps} />
        </Sheet>
      ) : null}
      {sheet === "more" ? (
        <Sheet title="素材操作" registerDismiss={registerOverlay} onClose={() => setSheet("")}>
          <Option label={busy ? "获取中…" : resource ? "重新获取原文件" : asset?.kind === "video" ? "完整保存视频供离线使用" : "查看原文件"} icon="refresh" onClick={() => { if (!busy) { setSheet(""); void load(); } }} />
          {resource && asset?.kind === "image" && !unavailable && !ownerMismatch ? <Option label="打开原图" icon="zoom" onClick={()=>{setSheet("");void api.contentOpenResource(owner,assetId).catch(()=>setMessage("无法打开原图。"));}} /> : null}
          {resource && asset?.kind==="image" && !unavailable && !ownerMismatch ? <Option label="重试清晰预览" icon="refresh" onClick={()=>{setSheet("");setPreviewRetry(v=>v+1);}} /> : null}
          {unavailable ? <Option label="重试读取素材" icon="refresh" onClick={()=>{setSheet("");void readDetail();}} /> : null}
          {busy ? <Option label="取消获取" icon="close" onClick={() => { void api.contentCancel(job.current); setSheet(""); }} /> : null}
          {resource && !/^(image|video|audio)\//.test(resource.mime) ? (
            <Option label="打开已缓存文件" icon="file" onClick={() => {
              setSheet("");
              api.contentOpenResource(owner, assetId).catch(() => setMessage("未找到可打开此文件的应用。"));
            }} />
          ) : null}
          {!ownerMismatch && !unavailable && asset ? (
            <>
              <Option label="标签" icon="list"
                onClick={() => { if (!guardOrganization()) { setSheet(""); return; } setSheet("tags"); }} />
              <Option label="移动到文件夹" icon="folder"
                onClick={() => { if (!guardOrganization()) { setSheet(""); return; } setSheet("folder"); }} />
            </>
          ) : (
            <div className="st-metadata-row" style={{ padding: "10px 14px", color: "var(--danger)" }}>
              <span>整理已停用</span><b>当前电脑不是这条素材所在的电脑</b>
            </div>
          )}
        </Sheet>
      ) : null}
      {sheet === "tags" ? (
        <TagOrganizationSheet
          assetId={assetId}
          owner={owner}
          current={(asset?.tags || []) as string[]}
          org={org}
          onClose={() => setSheet("")}
          registerOverlay={registerOverlay}
          onChanged={revalidate}
        />
      ) : null}
      {sheet === "folder" ? (
        <FolderOrganizationSheet
          assetId={assetId}
          owner={owner}
          currentFolderId={asset?.folderId ?? null}
          org={org}
          onClose={() => setSheet("")}
          registerOverlay={registerOverlay}
          onChanged={revalidate}
        />
      ) : null}
      {orgSnapshot.busy ? <div className="st-notice pending" role="status">正在同步到电脑…</div> : null}
      {orgSnapshot.error ? <div className="st-notice danger" role="status">{orgSnapshot.error}</div> : null}
      {orgSnapshot.partial ? (
        <div className="st-notice danger" role="status">
          部分完成：成功 {orgSnapshot.partial.succeeded} 项，失败 {orgSnapshot.partial.failed} 项
        </div>
      ) : null}
    </>
  );
}

/** Tag organization: inspect, choose existing, create a simple new tag. */
function TagOrganizationSheet({ assetId, owner, current, org, onClose, registerOverlay, onChanged }: {
  assetId: string; owner: string; current: string[]; org: MaterialOrganizationController;
  onClose: () => void; registerOverlay: (d: () => void) => () => void;
  onChanged: () => Promise<void>;
}) {
  const [tags, setTags] = useState<{ id: string; name: string }[]>([]);
  const [selected, setSelected] = useState<string[]>(current);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [localError, setLocalError] = useState("");

  useEffect(() => {
    let alive = true;
    api.contentNavigation(owner).then((nav: any) => {
      if (alive) setTags((nav?.tags || []).map((t: any) => ({ id: t.id, name: t.name })));
    }).catch(() => { /* tags stay empty; creation still works */ });
    return () => { alive = false; };
  }, []);

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  async function save() {
    setLocalError("");
    const ok = await org.setTags(assetId, { set: selected }, onChanged);
    if (ok) onClose();
  }

  async function createAndAssign() {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setLocalError("");
    const created = await org.createTag(name);
    if (!created) { setLocalError("新建标签失败，请重试。"); setCreating(false); return; }
    setTags((prev) => [...prev, { id: created.id, name: created.name }]);
    setSelected((prev) => [...prev, created.id]);
    setNewName("");
    setCreating(false);
  }

  return (
    <Sheet title="标签" registerDismiss={registerOverlay} onClose={onClose} busy={org.snapshot().busy}
      footer={<Button disabled={org.snapshot().busy} onClick={() => void save()}>保存</Button>}>
      <p className="st-sheet-caption">已有标签</p>
      {tags.length === 0 ? <p className="st-sheet-copy">电脑上还没有标签，可以在下面新建一个。</p> : null}
      {tags.map((tag) => (
        <Option key={tag.id} label={tag.name} icon="list" selected={selected.includes(tag.id)} onClick={() => toggle(tag.id)} />
      ))}
      <p className="st-sheet-caption">新建标签</p>
      <label className="st-field">标签名称
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="如：旅行" />
      </label>
      <div style={{ marginTop: 10 }}>
        <Button kind="quiet" disabled={creating || !newName.trim()} onClick={() => void createAndAssign()}>
          {creating ? "正在创建…" : "创建并选中"}
        </Button>
      </div>
      {localError ? <p className="st-sheet-copy">{localError}</p> : null}
    </Sheet>
  );
}

/** Folder organization: choose an existing folder, root, or create a folder. */
function FolderOrganizationSheet({ assetId, owner, currentFolderId, org, onClose, registerOverlay, onChanged }: {
  assetId: string; owner: string; currentFolderId: string | null; org: MaterialOrganizationController;
  onClose: () => void; registerOverlay: (d: () => void) => () => void;
  onChanged: () => Promise<void>;
}) {
  const [folders, setFolders] = useState<{ id: string; label: string }[]>([]);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [localError, setLocalError] = useState("");

  useEffect(() => {
    let alive = true;
    api.contentNavigation(owner).then((nav: any) => {
      if (!alive) return;
      const flat: { id: string; label: string }[] = [];
      const walk = (rows: any[], prefix: string) => {
        for (const row of rows || []) {
          flat.push({ id: row.id, label: prefix + (row.name ?? "") });
          walk(row.children || [], prefix + (row.name ?? "") + " / ");
        }
      };
      walk(nav?.folders || [], "");
      setFolders(flat);
    }).catch(() => { /* folders stay empty; root and creation still work */ });
    return () => { alive = false; };
  }, []);

  async function move(folderId: string | null) {
    setLocalError("");
    const ok = await org.setFolder(assetId, folderId, onChanged);
    if (ok) onClose();
  }

  async function createAndMove() {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setLocalError("");
    const created = await org.createFolder(name);
    if (!created) { setLocalError("新建文件夹失败，请重试。"); setCreating(false); return; }
    setCreating(false);
    await move(created.id);
  }

  return (
    <Sheet title="移动到文件夹" registerDismiss={registerOverlay} onClose={onClose} busy={org.snapshot().busy}>
      <Option label="根目录" icon="library" selected={currentFolderId === null} onClick={() => void move(null)} />
      {folders.map((folder) => (
        <Option key={folder.id} label={folder.label} icon="folder"
          selected={currentFolderId === folder.id} onClick={() => void move(folder.id)} />
      ))}
      <p className="st-sheet-caption">新建文件夹</p>
      <label className="st-field">文件夹名称
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="如：项目A" />
      </label>
      <div style={{ marginTop: 10 }}>
        <Button kind="quiet" disabled={creating || !newName.trim()} onClick={() => void createAndMove()}>
          {creating ? "正在创建…" : "创建并移动"}
        </Button>
      </div>
      {localError ? <p className="st-sheet-copy">{localError}</p> : null}
    </Sheet>
  );
}
