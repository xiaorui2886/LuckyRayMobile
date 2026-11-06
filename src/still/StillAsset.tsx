import { recentAssetHistory } from "../services/recentAssetHistory";
import { DesktopDocumentFallback } from "./kit/DesktopDocumentFallback";
import { useDesktopLibraries } from "./kit/DesktopLibraryPicker";
import { usePageCurrent } from "../presentation/still01/PageLayer";
// STILL-01.1 — 素材查看 page (authority AssetDemo composition, real data).
// Local assets keep their real edit/export/share/delete authorities; Desktop
// assets stay read-only with on-demand acquisition and cancel. Image zoom is
// a media-layer-only interaction (data-media-zoom-layer) — the shell pinch
// blocker exempts exactly this layer.
import { useCallback, useMemo, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Header, IconButton, Button, Sheet, Option, Empty, Icon } from "./kit/StillImports";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { api, materialApi } from "../services/client";
import { localDataStore } from "../services/localDataStore";
import { dataStore } from "../services/dataStore";
import { contentDetailReads } from "../services/contentDetailReads";
import { contentReadCooldown, cooldownWakeDelay, rateLimitDelay, isContentReadDenied, isContentReadTransportFailure } from "../services/contentReadCooldown";
import { contentError } from "../components/DesktopLibrary";
import { InlineAssetVideo } from "./InlineAssetVideo";
import { assetSequenceNeighbor, assetSwipeDirection, type AssetSequenceItem, type AssetSequenceSession } from "./kit/assetSequence";
import { suppressTrailingSwipeClick } from "./kit/useHorizontalSwipe";
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
import { MaterialOrganizationController, parseAssetRoute, desktopAssetRoute, localAssetRoute } from "./kit/materialOrganization";
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
import { videoFailureCopy } from "../services/mediaFailureCopy";

/** Presentation handoff for this one navigation route, not a data/cache authority. */
export type AssetPreview = { swipeDirection?: -1 | 1; title: string; thumbnail: string; kind: string; version?: string; sequence?: readonly AssetSequenceItem[]; continuation?: AssetSequenceSession };

type SheetName = "" | "info" | "more" | "rename" | "delete" | "acquire"
  | "organize" | "favorite" | "tags" | "folder" | "new-tag" | "new-folder";
const clamp = (v: number, lim: number) => Math.max(-lim, Math.min(lim, v));
// Native playback is the reviewed ordinary entry. Exact trial receipts are
// developer-only UI; the flag never gates playback or full-file acquisition.
const nativePlayerDiagnostics = import.meta.env.VITE_MATERIALS_NATIVE_PLAYER === "trial";

export function StillAsset({ id, preview }: { id: string; preview?: AssetPreview }) {
  const { back, open, registerOverlay } = useStillNav();
  const current = usePageCurrent();
  const gesture = useRef<{ pointer: number; x: number; y: number; time: number } | null>(null);
  const locked = useRef(false);
  useEffect(() => { locked.current = false; gesture.current = null; }, [id]);
  const route = parseAssetRoute(id);
  const continuation = preview?.continuation;
  const paged = useSyncExternalStore(continuation?.subscribe || (() => () => {}), continuation?.snapshot || (() => null));
  const sequence = paged?.items || preview?.sequence;
  const routeRef = useRef(id); routeRef.current = id;
  const currentRef = useRef(current); currentRef.current = current;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!current || !continuation || paged?.error || !paged?.hasMore) return;
    const index = paged.items.findIndex(item => item.route === id);
    if (index >= 0 && index >= paged.items.length - 3) void continuation.loadNext();
  }, [current, id, continuation, paged]);
  const go = async (direction: -1 | 1) => {
    if (!current || locked.current) return;
    locked.current = true;
    const origin = id;
    let navigated = false;
    try {
      const next = continuation ? await continuation.neighbor(id, direction) : assetSequenceNeighbor(sequence, id, direction);
      if (!next || !mounted.current || !currentRef.current || routeRef.current !== origin) return;
      navigated = true;
      open("asset", next.route, { assetPreview: { ...next, swipeDirection: direction, sequence: continuation?.snapshot().items || sequence, continuation } });
    } finally { if (!navigated && routeRef.current === origin) locked.current = false; }
  };
  const previous = assetSequenceNeighbor(sequence, id, -1), next = assetSequenceNeighbor(sequence, id, 1);
  const content = route.kind === "local"
    ? <LocalAsset key={route.assetId} localId={route.assetId} preview={preview} registerOverlay={registerOverlay} back={back} />
    : route.kind === "desktop"
      ? <DesktopAsset key={`${route.owner}:${route.library || ""}:${route.assetId}`} library={route.library} ownerInstanceId={route.owner} assetId={route.assetId} preview={preview} registerOverlay={registerOverlay} back={back} />
      : <UnownedAssetRoute back={back} />;
  return <div className="st-asset-sequence" data-swipe-direction={preview?.swipeDirection} data-gesture-owner="asset-detail"
    onPointerDownCapture={event => {
      const target = event.target as Element;
      if (!current || gesture.current || event.isPrimary === false || event.pointerType === "mouse" || event.button > 0 || target.closest('button,input,select,a,[role="dialog"],.st-sheet,.st-inline-video.is-fullscreen,[data-media-zoomed="true"]')) { gesture.current = null; return; }
      const selection = event.currentTarget.ownerDocument.getSelection();
      if (selection && !selection.isCollapsed) return;
      gesture.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, time: Date.now() };
    }}
    onPointerMoveCapture={event => {
      const start = gesture.current;
      if (!start || start.pointer !== event.pointerId) return;
      const dx = event.clientX - start.x, dy = event.clientY - start.y;
      if (Date.now() - start.time > 900 || Math.abs(dy) > 12 && Math.abs(dy) >= Math.abs(dx)) gesture.current = null;
    }}
    onPointerUpCapture={event => {
      const start = gesture.current; gesture.current = null;
      if (!start || start.pointer !== event.pointerId) return;
      const direction = assetSwipeDirection(event.clientX - start.x, event.clientY - start.y, Date.now() - start.time);
      if (direction) {
        suppressTrailingSwipeClick(event.currentTarget.ownerDocument);
        // Let the inner zoom stage retire its pointer even at list boundaries.
        event.preventDefault(); go(direction);
      }
    }} onPointerCancelCapture={() => { gesture.current = null; }}>
    {content}
    {paged?.error ? <button type="button" className="st-asset-sequence-retry" onClick={() => { if (paged.hasMore) void continuation?.loadNext(); else back(); }}>{paged.error}</button> : null}
    {(previous || next || paged?.hasMore) ? <div className="st-asset-sequence-access" aria-label="切换素材"><button type="button" disabled={!previous} onClick={() => go(-1)}>上一项</button><button type="button" disabled={!next && !paged?.hasMore} onClick={() => void go(1)}>下一项</button></div> : null}
  </div>;
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

// --- shared zoomable media stage ---------------------------------------------

function ZoomStage({ src, alt, poster, video, pendingVideo, onNeedOriginal, playLabel = "获取视频", playBusy = false, playMessage = "", notice = "", toggleSignal = 0, onVideoControlsVisibilityChange }: {
  src: string; alt: string;
  poster?: string; pendingVideo?: boolean; video?: { instance?: string; library?: string; id: string; path: string; localPath?: string; epoch?: string } | null;
  onNeedOriginal?: () => void;
  playLabel?: string; playBusy?: boolean; playMessage?: string;
  notice?: string;
  toggleSignal?: number;
  onVideoControlsVisibilityChange?: (visible: boolean) => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [videoFullscreen, setVideoFullscreen] = useState(false);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const base = useRef({ distance: 0, zoom: 1, x: 0, y: 0, ox: 0, oy: 0 });
  const area = useRef<HTMLDivElement>(null);
  const firstSignal = useRef(toggleSignal);
  const [readySrc, setReadySrc] = useState("");
  const [revealedSrc, setRevealedSrc] = useState("");
  const visibleSrc = readySrc === src ? readySrc : "";
  const [imageError, setImageError] = useState("");
  // The thumbnail and decoded original share one image layer and transform.
  // Loading the original must not make the already visible image inert.
  const imageZoomable = Boolean((src || poster) && !video && !pendingVideo);
  const finishPointer = (pointerId: number) => {
    if (!pointers.current.delete(pointerId)) return;
    const pts = Array.from(pointers.current.values());
    base.current = {
      distance: pts.length === 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0,
      zoom, x: pts[0]?.x ?? 0, y: pts[0]?.y ?? 0, ox: offset.x, oy: offset.y,
    };
  };
  useEffect(() => {
    let current = true;
    let revealFrame = 0;
    setImageError(""); setRevealedSrc(""); setReadySrc("");
    if (!src) { setReadySrc(""); return; }
    const image = new Image();
    image.onload = () => {
      void (image.decode ? image.decode() : Promise.resolve()).then(() => {
        if (current && image.naturalWidth > 0) { setReadySrc(src); revealFrame = requestAnimationFrame(() => { if(current) setRevealedSrc(src); }); }
      }).catch(() => { if (current) setImageError("图片暂时无法显示，可在更多操作中重新获取。"); });
    };
    image.onerror = () => { if (current) setImageError("图片暂时无法显示，可在更多操作中重新获取。"); };
    image.src = src;
    return () => { current=false; if (revealFrame) cancelAnimationFrame(revealFrame); image.onload=null; image.onerror=null; image.src=""; };
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
      className={"st-asset-area" + (videoFullscreen ? " is-video-fullscreen" : "")}
      data-media-zoom-layer="true"
      data-media-zoomed={zoom > 1 ? "true" : "false"}
      onDoubleClick={() => { if (!imageZoomable) return; setZoom((z) => (z === 1 ? 2 : 1)); setOffset({ x: 0, y: 0 }); }}
      onPointerDown={(e) => {
        if (!imageZoomable || pointers.current.size >= 2) return;
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
      onPointerUp={(e) => finishPointer(e.pointerId)}
      onPointerCancel={(e) => finishPointer(e.pointerId)}
      onLostPointerCapture={(e) => finishPointer(e.pointerId)}
    >
      {pendingVideo ? <div className="st-inline-video" role="status" aria-label="正在准备视频"><div className="st-video-wait"><span className="st-video-spinner" /></div></div> : video ? (
        <InlineAssetVideo key={`${video.instance || "local"}:${video.id}:${video.path}:${video.epoch || ""}`} owner={video.instance} library={video.library} id={video.id} localPath={video.localPath} poster={poster} onFallback={onNeedOriginal} onFullscreenChange={setVideoFullscreen} onControlsVisibilityChange={onVideoControlsVisibilityChange} />
      ) : visibleSrc || poster ? (
        <div className="st-progressive-image" style={{ transform: `translate(${offset.x}px,${offset.y}px) scale(${zoom})` }}>
          {poster && poster !== visibleSrc ? <img className="st-image-placeholder" src={poster} alt="" aria-hidden="true" draggable={false} /> : null}
          {visibleSrc ? <img key={visibleSrc} className={"st-image-original" + (revealedSrc === visibleSrc ? " is-revealed" : "")} src={visibleSrc} alt={alt} draggable={false} /> : <span className="st-sr-only">{alt}</span>}
        </div>
      ) : null}
      {onNeedOriginal && !video && !pendingVideo ? (
        <button style={{ position: "absolute", background: "rgba(0,0,0,.65)", color: "white", border: 0, borderRadius: 24, width: 48, height: 48, display: "grid", placeItems: "center" }}
          aria-label={playLabel} disabled={playBusy} onClick={onNeedOriginal}><Icon name="play" /></button>
      ) : null}
      {!pendingVideo && (playBusy || playMessage || notice || imageError) ? <div className="st-media-feedback" role="status">{playBusy ? "正在准备播放…" : playMessage || notice || imageError}</div> : null}
    </div>
  );
}

// --- 本机素材 -----------------------------------------------------------------

function LocalAsset({ localId, preview, registerOverlay, back }: {
  localId: string; preview?: AssetPreview; registerOverlay: (d: () => void) => () => void; back: () => void;
}) {
  const { mode } = useStillNav();
  const pageCurrent = usePageCurrent();
  const [pageVisible, setPageVisible] = useState(!document.hidden);
  useEffect(() => { const update = () => setPageVisible(!document.hidden); document.addEventListener("visibilitychange", update); return () => document.removeEventListener("visibilitychange", update); }, []);
  const recentRecorded = useRef(false);
  const [asset, setAsset] = useState<any>(null);
  const [videoControlsVisible, setVideoControlsVisible] = useState(true);
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

  useEffect(() => {
    if (!pageCurrent) { recentRecorded.current = false; return; }
    if (pageVisible && asset && integrity?.status === "healthy" && !recentRecorded.current) {
      recentRecorded.current = true;
      recentAssetHistory.record(localAssetRoute(localId), asset.name || "素材", asset.kind);
    }
  }, [pageCurrent, pageVisible, localId, asset, integrity?.status]);

  if (!asset) {
    return (
      <div className="st-asset-view">
        <AssetHeader title={preview?.title || "正在读取素材…"} back={back} />
        <ZoomStage src="" pendingVideo={!loadError && preview?.kind === "video"} poster={loadError ? "" : preview?.thumbnail} alt={preview?.title || "素材"} notice={loadError || "正在读取本机文件…"} />
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
    const previous = asset.favorite;
    setAsset({ ...asset, favorite: !previous });
    try {
      await api.localAssetSetFlags(localId, { favorite: !previous });
      localDataStore.publish("asset");
    } catch (e: any) { setAsset((current: any) => current ? { ...current, favorite: previous } : current); toast.error(failureCopy(e, "操作失败。")); }
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
      recentAssetHistory.forget(localAssetRoute(localId));
      preview?.continuation?.remove(`local:${localId}`);
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
        {asset.kind !== "image" && asset.kind !== "video" ? <DesktopDocumentFallback
          name={asset.name} preview={healthy ? preview?.thumbnail : ""} local cached
          busy={busy} disabled={!healthy} message={integrityError ? `${integrityText[integrityError] || "文件异常"} — 仅保留元数据。` : loadError}
          onOpen={() => { void openOriginal(); }}
        /> : <ZoomStage src={previewSrc} poster={!integrityError ? preview?.thumbnail : ""} alt={asset.name}
          pendingVideo={asset.kind === "video" && !integrity && !loadError}
        video={asset.kind === "video" && healthy ? { id: localId, path: asset.contentHash || asset.localPath, localPath: asset.localPath } : null}
          onNeedOriginal={asset.kind==="video" && healthy ? ()=>void playVideo() : undefined}
          onVideoControlsVisibilityChange={setVideoControlsVisible}
          playLabel="播放视频" playBusy={playBusy} playMessage={playMessage}
          notice={integrityError ? `${integrityText[integrityError] || "文件异常"} — 仅保留元数据。` : loadError} />}
        <div className="st-asset-actions" role="toolbar" aria-label="素材操作" aria-hidden={!videoControlsVisible || undefined} inert={!videoControlsVisible} style={{ visibility: videoControlsVisible ? "visible" : "hidden" }}>
          <AssetAction icon="share" label="分享" disabled={!healthy || busy} onClick={() => void share()} />
          <AssetAction icon="heart" label="收藏" active={Boolean(asset.favorite)} disabled={favoriteBusy} onClick={() => void toggleFavorite()} />
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

function DesktopAsset({ ownerInstanceId, library, assetId, preview, registerOverlay, back }: {
  ownerInstanceId: string; library?: string; assetId: string; preview?: AssetPreview; registerOverlay: (d: () => void) => () => void; back: () => void;
}) {
  const { conn, mode } = useStillNav();
  const [videoControlsVisible, setVideoControlsVisible] = useState(true);
  const libraries = useDesktopLibraries(ownerInstanceId,conn?.ws?.state === "connected", true);
  const writeGranted = !library || libraries.catalog?.materials.find(row=>row.libraryId===library)?.writeGranted === true;
  const scopedApi = materialApi(library,writeGranted);
  const [asset, setAsset] = useState<any>(null);
  const [thumb, setThumb] = useState(preview?.thumbnail || "");
  const pageCurrent = usePageCurrent();
  const recentRecorded = useRef(false);
  useEffect(() => { if (!pageCurrent) recentRecorded.current = false; }, [pageCurrent]);
  const [pageVisible, setPageVisible] = useState(!document.hidden);
  useEffect(() => { const update=()=>setPageVisible(!document.hidden);document.addEventListener("visibilitychange",update);return()=>document.removeEventListener("visibilitychange",update); }, []);
  const [resource, setResource] = useState<{ path: string; mime: string; assetVersion?: string } | null>(null);
  const [screenPreview, setScreenPreview] = useState("");
  const [previewRetry, setPreviewRetry] = useState(0);
  const appliedPreviewRetry = useRef(0);
  const validationAttempt = useRef("");
  const [message, setMessage] = useState("");
  const [reading, setReading] = useState(false);
  const cooldownKey = contentReadCooldown.key(ownerInstanceId, library);
  const [retryWait, setRetryWait] = useState(() => contentReadCooldown.remaining(cooldownKey));
  useEffect(() => {
    if (!retryWait) return;
    const delay = cooldownWakeDelay(retryWait);
    if (delay === null) return;
    let timer: ReturnType<typeof setTimeout>;
    const wake = () => {
      const remaining = contentReadCooldown.remaining(cooldownKey);
      setRetryWait(remaining);
      // Timers may wake early or another page may extend this scope's deadline.
      const next = cooldownWakeDelay(remaining);
      if (remaining > 0 && next !== null) timer = setTimeout(wake, Math.max(1, next));
    };
    timer = setTimeout(wake, delay);
    return () => clearTimeout(timer);
  }, [cooldownKey, retryWait]);
  const [recoveryPending, setRecoveryPending] = useState(false);
  const automaticStopped = useRef(false);
  const transportRecovery = useRef(false);
  const transportForegroundPending = useRef(false);
  const transportRecoveryFlight = useRef(false);
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
  const org = useMemo(() => new MaterialOrganizationController({
    setFavorite: (i, id, fav) => scopedApi.contentMaterialSetFavorite(i, id, fav),
    setTags: (i, id, patch) => scopedApi.contentMaterialSetTags(i, id, patch),
    setFolder: (i, id, folderId) => scopedApi.contentMaterialSetFolder(i, id, folderId),
    createTag: (i, name) => scopedApi.contentMaterialCreateTag(i, name),
    createFolder: (i, name) => scopedApi.contentMaterialCreateFolder(i, name),
    batch: (i, input) => scopedApi.contentMaterialBatch(i, input),
  }), [library,writeGranted]);
  const [cacheChecked, setCacheChecked] = useState(false);
  const autoImageAttempt = useRef("");
  const [orgSnapshot, setOrgSnapshot] = useState(org.snapshot());
  const [favoritePreview, setFavoritePreview] = useState<boolean | null>(null);
  const favoritePending = useRef(false);
  useEffect(() => org.subscribe(setOrgSnapshot), [org]);
  // Write-grant discovery changes only the mutation controller, not the
  // route-owned read/media lifetime. Never cancel an image/video for this.
  useEffect(() => { org.setIdentity(owner); }, [org, owner]);
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
  const services = useRef(createProductionServices({library})).current;
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
      detailV1: (ownerId, asset, isCurrent) => services.materials.detailV1(ownerId, asset, library, isCurrent),
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

  const sourceDeferred = useRef(false);
  const loadSource = useCallback(() => {
    if (!backgroundReadAllowed.current || denied.current) { sourceDeferred.current = true; return; }
    if (contentReadCooldown.remaining(cooldownKey)) { sourceDeferred.current = true; setSourceState({phase:"error", code:"RATE_LIMITED"}); return; }
    sourceDeferred.current = false;
    sourceCtrlRef.load();
  }, [sourceCtrlRef]);

  const currentOwner = conn?.identity?.instanceId || "";
  const ownerMismatch = Boolean(owner) && currentOwner !== owner;
  const backgroundReadAllowed = useRef(false);
  backgroundReadAllowed.current = pageCurrent && pageVisible && !ownerMismatch && conn?.ws?.state === "connected";

  /** The user's explicit 「重试来源」: same page, same owner+asset, newest
   *  token — succeeds without leaving the detail once Desktop grants read.
   *  This is the permission-change recovery path (no polling, no new wire). */
  const retrySource = useCallback(() => {
    if (ownerMismatch || !backgroundReadAllowed.current) return;
    loadSource();
  }, [loadSource, ownerMismatch]);

  const readDetailOnce = useCallback(async () => {
    const gen=detailGen.current, seq=++readSeq.current;
    const current=()=>gen===detailGen.current && seq===readSeq.current && backgroundReadAllowed.current && !document.hidden;
    setReading(true);
    try {
      const value=await contentDetailReads.read(owner, cooldownKey, current, () => scopedApi.contentAssetDetail(owner,assetId));
      if (!current()) return;
      if (!recentRecorded.current) {
        recentRecorded.current = true;
        recentAssetHistory.record(desktopAssetRoute(owner, assetId, library), value.name || "素材", value.kind);
      }
      const version=materialImageVersion(value);
      const previous=assetRef.current ? materialImageVersion(assetRef.current) : preview?.version;
      const changed=previous!==undefined && previous!==version;
      const recovering=denied.current;
      contentReadCooldown.recovered(cooldownKey); setRecoveryPending(false); automaticStopped.current=false; transportRecovery.current=false;
      assetRef.current=value; denied.current=false; setUnavailable(false); setAsset(value); setMessage("");
      if (!recovering && sourceDeferred.current) loadSource();
      if (recovering) {presentCtrl.bind({owner,assetId,generation:gen});sourceCtrlRef.bind({owner,assetId,isLive:()=>gen===detailGen.current && backgroundReadAllowed.current});loadSource();}
      if (changed) {thumbRef.current="";setThumb("");setScreenPreview("");playPosition.current=0;}
      if (!thumbRef.current) void thumbnailScheduler.enqueue(desktopThumbKey(owner,assetId,version,false,library),()=>scopedApi.assetThumbnail(owner,assetId,false,false,version),"near")
        .then(v=>{if(current()&&!denied.current&&materialImageVersion(assetRef.current)===version){thumbRef.current=convertFileSrc(v.uri);setThumb(thumbRef.current);}}).catch(()=>{});
    } catch (error) {
      if (!current()) return;
      transportRecovery.current = isContentReadTransportFailure(error);
      if (isContentReadDenied(error)) {
        denied.current=true;assetRef.current=null;thumbRef.current="";
        setAsset(null);setThumb("");setResource(null);setScreenPreview("");setUnavailable(true);
        sourceCtrlRef.retire();presentCtrl.retire();setSourceState({phase:"error",code:"GRANT_REQUIRED"});setPresent(null);
        if(job.current) void api.contentCancel(job.current);
        if(playJob.current) void api.contentCancel(playJob.current);
      }
      if (rateLimitDelay(error) !== null) {
        setRetryWait(contentReadCooldown.observe(cooldownKey, error));
        setRecoveryPending(true);
        detailQueued.current = false;
      } else {
        // No blind replay. Only a new foreground/reconnect can retry an exact
        // offline/timeout verdict; 503/protocol/denial keep explicit recovery.
        automaticStopped.current = true; setRecoveryPending(false); detailQueued.current = false;
      }
      setMessage(contentError(error));
    } finally { if (current()) { transportRecoveryFlight.current = false; setReading(false); } }
  },[owner,assetId]);

  const detailFlight = useRef<Promise<void> | null>(null);
  const detailQueued = useRef(false);
  const detailFlightEpoch = useRef(0);
  const readDetail = useCallback((): Promise<void> => {
    // Global note/cache commits are invalidations, not independent requests.
    // Preserve the active result and remember at most one subsequent refresh.
    if (!backgroundReadAllowed.current || document.hidden) return Promise.resolve();
    const waiting = contentReadCooldown.remaining(cooldownKey);
    if (waiting) { setRecoveryPending(true); setRetryWait(waiting); setMessage(cooldownWakeDelay(waiting) === null ? "电脑返回的等待时间过长，请检查电脑端。" : "读取频繁，请稍后重试。"); return Promise.resolve(); }
    if (detailFlight.current) { detailQueued.current = true; return detailFlight.current; }
    const gen = detailGen.current, epoch = ++detailFlightEpoch.current;
    const flight = (async () => {
      do {
        detailQueued.current = false;
        await readDetailOnce();
      } while (!contentReadCooldown.remaining(cooldownKey) && detailQueued.current && backgroundReadAllowed.current && epoch === detailFlightEpoch.current && gen === detailGen.current && !denied.current && !automaticStopped.current);
    })();
    detailFlight.current = flight;
    void flight.finally(() => { if (detailFlight.current === flight) detailFlight.current = null; }).catch(() => {});
    return flight;
  }, [readDetailOnce]);

  const recoverTransport = useCallback(() => {
    if (!transportRecovery.current || !backgroundReadAllowed.current || document.hidden || denied.current
        || contentReadCooldown.remaining(cooldownKey)) return false;
    transportForegroundPending.current = false; transportRecoveryFlight.current = true;
    transportRecovery.current = false; automaticStopped.current = false;
    sourceDeferred.current = true;
    sourceCtrlRef.bind({owner, assetId, isLive: () => sourceGen.current === detailGen.current && backgroundReadAllowed.current});
    void readDetail();
    return true;
  }, [readDetail, cooldownKey, owner, assetId, sourceCtrlRef]);
  useEffect(() => {
    const foreground = () => {
      if (!backgroundReadAllowed.current || document.hidden || denied.current || transportRecoveryFlight.current) return;
      // A pre-background IPC read may report its offline verdict only AFTER
      // the native resume event. Retain one hint, not a retry queue; a healthy
      // result consumes it without issuing another read.
      if (detailFlight.current) transportForegroundPending.current = true;
      else recoverTransport();
    };
    window.addEventListener("luckyray:foreground", foreground);
    return () => window.removeEventListener("luckyray:foreground", foreground);
  }, [recoverTransport]);
  useEffect(() => {
    if (!reading && transportForegroundPending.current) {
      transportForegroundPending.current = false;
      recoverTransport();
    }
  }, [reading, message, recoverTransport]);

  // Only the current foreground page owns the wakeup. Navigation transfers the
  // shared scope budget, not the timer; back/background/drop cancel it entirely.
  useEffect(() => {
    if (!recoveryPending || retryWait > 0 || !backgroundReadAllowed.current || denied.current
        || automaticStopped.current || !contentReadCooldown.recoveryAvailable(cooldownKey)) return;
    const timer = setTimeout(() => {
      if (!backgroundReadAllowed.current || document.hidden || denied.current || automaticStopped.current) return;
      const remaining = contentReadCooldown.remaining(cooldownKey);
      if (remaining) { setRetryWait(remaining); return; }
      if (contentReadCooldown.claimRecovery(cooldownKey)) { setRecoveryPending(false); void readDetail(); }
    }, 100); // prevent zero Retry-After from becoming a synchronous retry storm
    return () => clearTimeout(timer);
  }, [recoveryPending, retryWait, pageCurrent, pageVisible, ownerMismatch, conn?.ws?.state, cooldownKey, readDetail]);

  useEffect(() => {
    const gen = ++detailGen.current;
    automaticStopped.current=false; transportRecovery.current=false;
    transportForegroundPending.current=false; transportRecoveryFlight.current=false;
    setRecoveryPending(false); sourceDeferred.current=true;
    assetRef.current=null;denied.current=false;thumbRef.current=preview?.thumbnail||"";
    setAsset(null); setThumb(thumbRef.current); setResource(null); setScreenPreview("");setUnavailable(false);setMessage(""); setBusy(false);
    setPlayBusy(false); setPlayMessage(""); setPlayEvidence(null); playPosition.current = 0;
    setPresent(null); setFavoritePreview(null); favoritePending.current = false; setCacheChecked(false); autoImageAttempt.current="";
    // Bind the presentation action to THIS page context; any previous
    // handle (older asset/owner) is retired so its late outcome is a no-op.
    presentCtrl.bind({ owner, assetId, generation: gen });
    // Bind the source enrichment to THIS page context too (retires the
    // previous asset/owner request), then issue the read.
    sourceGen.current = gen;
    sourceCtrlRef.bind({ owner, assetId, isLive: () => gen === detailGen.current && backgroundReadAllowed.current });
    // Every read is expected-instance: the owner this page belongs to, not the
    // Desktop that happens to be connected when the promise settles.
    void readDetail();
    void scopedApi.contentCachedResource(owner, assetId).then((cached) => {
      if (gen === detailGen.current && !denied.current) setResource(cached);
    }).catch(() => {}).finally(() => { if(gen===detailGen.current) setCacheChecked(true); });
    // Source enrichment is additive: wait for primary detail authority first.
    // A failing/rate-limited page must not also start Services discovery.
    return () => {
      detailGen.current++;
      detailFlightEpoch.current++; detailQueued.current = false; detailFlight.current = null;
      // Retire any outstanding source request for the gone page context.
      sourceCtrlRef.retire();
      presentCtrl.retire();
      if (job.current) void api.contentCancel(job.current);
      if (playJob.current) void api.contentCancel(playJob.current);
    };
    // `services`, `presentCtrl`, `loadSource`, `sourceCtrlRef` are stable
    // refs/callbacks. Read identity is the route, not mutable write grants.
  }, [owner, assetId]);

  useEffect(() => {
    if (!ownerMismatch) {
      sourceCtrlRef.bind({owner, assetId, isLive: () => sourceGen.current === detailGen.current && backgroundReadAllowed.current});
      return;
    }
    // A temporary owner switch is still a lifetime boundary, even if the old
    // owner reconnects before a pending transport promise settles.
    readSeq.current++; detailFlightEpoch.current++;
    transportForegroundPending.current = false; transportRecoveryFlight.current = false;
    detailQueued.current = false; detailFlight.current = null;
    setReading(false); setRecoveryPending(false);
    sourceCtrlRef.retire(); sourceDeferred.current = true;
  }, [ownerMismatch, owner, assetId, sourceCtrlRef]);

  useEffect(()=>dataStore.subscribe((kind)=>{
    if (kind === "knowledge") return;
    // Local note/cache commits must not probe an offline or different Desktop.
    // Explicit retry remains separate; reconnect has its own fresh read below.
    if (!denied.current && !automaticStopped.current && !recoveryPending && pageCurrent && pageVisible && !ownerMismatch && conn?.ws?.state === "connected") void readDetail();
  }),[readDetail,ownerMismatch,conn?.ws?.state,pageCurrent,pageVisible,recoveryPending]);
  const detailActive = pageCurrent && pageVisible;
  const previousDetailActive = useRef(detailActive);
  useEffect(() => {
    const resumed = detailActive && !previousDetailActive.current;
    previousDetailActive.current = detailActive;
    if (!detailActive) { transportForegroundPending.current = false; sourceCtrlRef.retire(); sourceDeferred.current = true; }
    if (resumed) sourceCtrlRef.bind({owner, assetId, isLive: () => sourceGen.current === detailGen.current && backgroundReadAllowed.current});
    if (resumed && !recoverTransport() && !denied.current && !automaticStopped.current && !recoveryPending && !ownerMismatch && conn?.ws?.state === "connected") void readDetail();
  }, [detailActive,readDetail,recoverTransport,ownerMismatch,conn?.ws?.state,recoveryPending]);

  useEffect(() => {
    let live=true;
    if (!resource?.mime.startsWith("image/") || !asset || unavailable || ownerMismatch) return;
    const gen=detailGen.current, version=materialImageVersion(asset);
    const force=previewRetry>appliedPreviewRetry.current;
    appliedPreviewRetry.current=previewRetry;
    async function prepare() {
      try {
        const v=await thumbnailScheduler.enqueue(desktopThumbKey(owner,assetId,version,true,library),()=>scopedApi.assetThumbnail(owner,assetId,force,true,version),"near");
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

  useEffect(() => {
    if (!pageCurrent || !pageVisible || !cacheChecked || !asset || asset.kind!=="image" || unavailable || ownerMismatch
        || conn?.ws?.state!=="connected" || document.hidden || asset.sizeBytes>32*1024*1024) return;
    const version=materialImageVersion(asset);
    // A complete legacy download can carry the Desktop's old generic MIME.
    // Its presence/version alone must not suppress one authenticated re-read.
    if(resource?.mime.startsWith("image/") && (!resource.assetVersion || resource.assetVersion===version)) return;
    if(job.current || autoImageAttempt.current===version) return;
    autoImageAttempt.current=version;
    const gen=detailGen.current, jobId=`image-detail-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    job.current=jobId;
    void scopedApi.contentAssetFile(owner,assetId,jobId,32*1024*1024,version).then(value=>{
      if(gen===detailGen.current&&!denied.current&&materialImageVersion(assetRef.current)===version) {
        if(value.mime.startsWith("image/")) setResource(value);
        else setMessage("尚未取得可识别的原图，当前显示缩略图。可在电脑端检查素材后重试。");
      }
    }).catch(error=>{
      if(gen===detailGen.current&&!denied.current&&backgroundReadAllowed.current&&!document.hidden&&materialImageVersion(assetRef.current)===version) setMessage(contentError(error));
    })
      .finally(()=>{if(job.current===jobId)job.current="";});
    return ()=>{void api.contentCancel(jobId); if(job.current===jobId) {job.current="";autoImageAttempt.current="";} };
  },[pageCurrent,pageVisible,cacheChecked,asset?.kind,asset?.contentHash,asset?.thumbnailRevision,asset?.updatedAt,resource,ownerMismatch,unavailable,owner,assetId,conn?.ws?.state]);

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
      transportForegroundPending.current = false; transportRecoveryFlight.current = false;
      detailFlightEpoch.current++; detailQueued.current = false; detailFlight.current = null;
      setReading(false);
      // Retire the outstanding source request: anything it returns belongs to
      // the previous connection epoch.
      sourceCtrlRef.retire();
      if (sourceState.phase !== "idle") setSourceState({ phase: "error", code: "SERVICE_UNAVAILABLE" });
    } else if (reconnected && recoverTransport()) {
      // The same current page recovered only an explicit transport failure.
    } else if (reconnected && !ownerMismatch && !denied.current && !automaticStopped.current) {
      sourceDeferred.current = true;
      void readDetail();
      // Same Desktop came back: re-read the enrichment once (fresh binding so
      // the controller is live again after the drop's retire()).
      sourceCtrlRef.bind({ owner, assetId, isLive: () => sourceGen.current === detailGen.current });
    }
  }, [wsState, ownerMismatch, owner, assetId, loadSource, sourceCtrlRef, recoverTransport]);

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
      const value = await scopedApi.contentAssetFile(owner, assetId, jobId);
      if (gen !== detailGen.current || denied.current) return;
      setResource(value);
      if (!/^(image|video|audio)\//.test(value.mime)) await scopedApi.contentOpenResource(owner, assetId);
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
      const result = await scopedApi.contentVideoPlay(owner, assetId, jobId, asset?.name || preview?.title || "视频", playPosition.current, mode==="dark");
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
        {!asset && message ? <div className="st-asset-read-error" role="status">
          <p>{recoveryPending && contentReadCooldown.recoveryAvailable(cooldownKey) && cooldownWakeDelay(retryWait) !== null ? "读取频繁，等待后将自动重试。" : message}</p>
          <button type="button" disabled={reading || ownerMismatch || retryWait > 0} onClick={() => { contentDetailReads.allowManual(cooldownKey); automaticStopped.current = false; void readDetail(); }}>{reading ? "正在读取…" : retryWait > 0 ? "稍后重试" : "重新读取素材"}</button>
          <button type="button" onClick={back}>返回素材库</button>
        </div> : ["document", "audio", "other", "file"].includes(asset?.kind || preview?.kind || "") ? <DesktopDocumentFallback
          name={asset?.name || preview?.title || "文件"} preview={!unavailable && !ownerMismatch ? thumb : ""}
          cached={Boolean(resource)} busy={busy} disabled={unavailable || ownerMismatch || !asset}
          message={ownerMismatch ? "当前电脑已更换，请返回素材库重新打开。" : message}
          onOpen={() => {
            if (unavailable || ownerMismatch || !asset || busy) return;
            if (resource) void scopedApi.contentOpenResource(owner, assetId).catch(() => setMessage("未找到可打开此文件的应用。"));
            else void load();
          }}
        /> : <ZoomStage
          src={source && !isVideo ? source : ""}
          alt={asset?.name || preview?.title || "素材"}
          poster={!unavailable && !ownerMismatch ? thumb : ""}
          pendingVideo={!unavailable && !ownerMismatch && !asset && preview?.kind === "video"}
        video={!unavailable && !ownerMismatch && asset?.kind === "video" ? { instance: owner, library, id: assetId, path: materialImageVersion(asset), epoch: wsState } : null}
          onNeedOriginal={!unavailable && !ownerMismatch && (asset?.kind || preview?.kind) === "video" ? () => void playVideo() : undefined}
          onVideoControlsVisibilityChange={setVideoControlsVisible}
          playLabel="播放视频" playBusy={playBusy} playMessage={playMessage}
          notice={ownerMismatch ? "当前电脑已更换，请返回素材库重新打开。" : message || (busy && !source ? "正在从电脑获取原文件…" : "")}
        />}
        <div className="st-asset-actions" role="toolbar" aria-label="素材操作" aria-hidden={!videoControlsVisible || undefined} inert={!videoControlsVisible} style={{ visibility: videoControlsVisible ? "visible" : "hidden" }}>
          <AssetAction icon="heart" label="收藏" active={favoritePreview ?? Boolean(asset?.favorite)}
            disabled={ownerMismatch || unavailable || !asset}
            onClick={() => {
              if (favoritePending.current || org.snapshot().busy || !guardOrganization()) return;
              const target = !asset?.favorite, generation = detailGen.current;
              favoritePending.current = true; setFavoritePreview(target);
              void org.setFavorite(assetId, target, revalidate).finally(() => {
                if (generation !== detailGen.current) return;
                favoritePending.current = false; setFavoritePreview(null);
              });
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
          {resource && asset?.kind === "image" && !unavailable && !ownerMismatch ? <Option label="打开原图" icon="zoom" onClick={()=>{setSheet("");void scopedApi.contentOpenResource(owner,assetId).catch(()=>setMessage("无法打开原图。"));}} /> : null}
          {resource && asset?.kind==="image" && !unavailable && !ownerMismatch ? <Option label="重试清晰预览" icon="refresh" onClick={()=>{setSheet("");setPreviewRetry(v=>v+1);}} /> : null}
          {unavailable ? <Option label="重试读取素材" icon="refresh" onClick={()=>{setSheet("");void readDetail();}} /> : null}
          {busy ? <Option label="取消获取" icon="close" onClick={() => { void api.contentCancel(job.current); setSheet(""); }} /> : null}
          {resource && !/^(image|video|audio)\//.test(resource.mime) ? (
            <Option label="打开已缓存文件" icon="file" onClick={() => {
              setSheet("");
              scopedApi.contentOpenResource(owner, assetId).catch(() => setMessage("未找到可打开此文件的应用。"));
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
          owner={owner} library={library}
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
          owner={owner} library={library}
          currentFolderId={asset?.folderId ?? null}
          org={org}
          onClose={() => setSheet("")}
          registerOverlay={registerOverlay}
          onChanged={revalidate}
        />
      ) : null}
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
function TagOrganizationSheet({ assetId, owner, library, current, org, onClose, registerOverlay, onChanged }: {
  assetId: string; owner: string; library?: string; current: string[]; org: MaterialOrganizationController;
  onClose: () => void; registerOverlay: (d: () => void) => () => void;
  onChanged: () => Promise<void>;
}) {
  const scopedApi = materialApi(library);
  const [tags, setTags] = useState<{ id: string; name: string }[]>([]);
  const [selected, setSelected] = useState<string[]>(current);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [localError, setLocalError] = useState("");

  useEffect(() => {
    let alive = true;
    scopedApi.contentNavigation(owner).then((nav: any) => {
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
function FolderOrganizationSheet({ assetId, owner, library, currentFolderId, org, onClose, registerOverlay, onChanged }: {
  assetId: string; owner: string; library?: string; currentFolderId: string | null; org: MaterialOrganizationController;
  onClose: () => void; registerOverlay: (d: () => void) => () => void;
  onChanged: () => Promise<void>;
}) {
  const scopedApi = materialApi(library);
  const [folders, setFolders] = useState<{ id: string; label: string }[]>([]);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [localError, setLocalError] = useState("");

  useEffect(() => {
    let alive = true;
    scopedApi.contentNavigation(owner).then((nav: any) => {
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
