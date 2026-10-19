// QA-only isolated native IPC. Production shell, list, detail, navigation and
// Services controllers are not replaced. Never packaged in the mobile app.
import "../../src/services/webviewCompatibility";
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import StillApp, { stillNav } from "../../src/still/StillShell";
import { navigation } from "../../src/navigation";
import { dataStore } from "../../src/services/dataStore";
import { desktopAssetRoute } from "../../src/still/kit/materialOrganization";

const qa = (window as any).__materialsQa;
const owner = "synthetic-materials-pc";
const pageUrl = "https://example.org/作品/一段很长的来源路径?ref=中文%20空格&exact=a%2Fb#原图";
const records = Array.from({length: 30}, (_, i) => ({
  desktopAssetId: `asset-${i}`, name: i === 0 ? "Pinterest.png" : i === 1 ? "180 4K.mp4" : `底层列表标题-${i}.png`,
  kind: i === 1 ? "video" : "image", mimeType: i === 1 ? "video/mp4" : "image/png",
  sizeBytes: i === 1 ? 2412888064 : 10695475, etag: `"synthetic-${i}"`,
  tags: [], favorite: false, folderId: null,
  thumbnailRevision:"",contentHash:"",updatedAt:"",
}));
qa.records = records; qa.calls = []; qa.pageUrl = pageUrl;
const detailReads: {resolve: (value: any) => void; id: string}[] = [];
const sourceReads: (() => void)[] = [];
qa.releaseSources = () => { qa.deferSource = false; for (const done of sourceReads.splice(0)) done(); };
qa.releaseDetails = () => { qa.deferDetail = false; for (const p of detailReads.splice(0)) p.resolve(structuredClone(records.find(a => a.desktopAssetId === p.id))); };
qa.switchRoot = (tab: any) => navigation.switchRoot(tab);
let delayThumbnails = true;
const thumbnails: {resolve: (value: any) => void; id: string}[] = [];
const thumb = (id: string) => ({uri: `/synthetic-image/${id}${records.find(a=>a.desktopAssetId===id)?.thumbnailRevision === "r2" ? "?revision=r2" : ""}`, mime: "image/png", etag: `"thumb-${id}"`, w: 640, h: 400});
qa.releaseThumbnails = () => { delayThumbnails = false; for (const p of thumbnails.splice(0)) p.resolve(thumb(p.id)); };
qa.openAsset = (id: string) => navigation.pushDetail({tab: "library", detail: desktopAssetRoute(owner, id)});
qa.back = () => stillNav.back();
qa.bump = () => dataStore.bump();
qa.closeNative = (value: any) => { const session = qa.nativeSession; qa.nativeSession = null; session?.resolve(value); };
(window as any).__TAURI_INTERNALS__ = {
  convertFileSrc: (path: string) => path,
  invoke: async (cmd: string, args: any = {}) => {
    qa.calls.push({cmd, args});
    if (cmd === "local_asset_list") return {items: structuredClone(qa.localRecords || []), total: qa.localRecords?.length || 0, hasMore: false};
    if (cmd === "local_asset_get") return structuredClone(qa.localRecords?.find((a:any)=>a.assetId===args.assetId));
    if (cmd === "local_asset_integrity") return {status:"healthy",exists:true,isFile:true,sizeMatches:true,hashVerified:true};
    if (cmd === "local_asset_tags") return {tags: []};
    if (cmd === "local_note_list") return {items: [], total:0, hasMore:false};
    if (cmd === "local_inbox_stats") return {total:0};
    if (cmd === "content_assets") {
      if(qa.listError) throw new Error(qa.listError);
      const rows=args.kind ? records.filter(row=>row.kind===args.kind) : records;
      return {items: structuredClone(qa.paginated ? (args.page===2 ? rows.slice(19) : rows.slice(0,20)) : rows), page:args.page, limit:args.limit, hasMore:Boolean(qa.paginated && args.page===1), nextPage:qa.paginated && args.page===1 ? 2 : null, source: "network"};
    }
    if (cmd === "content_asset_detail") {
      if(qa.primaryError) throw new Error(qa.primaryError);
      return qa.deferDetail ? new Promise(resolve => detailReads.push({resolve, id: args.id})) : structuredClone(records.find(a => a.desktopAssetId === args.id));
    }
    if (cmd === "content_cached_resource") return qa.cachedResource || null;
    if (cmd === "local_asset_thumbnail") return thumb(args.assetId);
    if (cmd === "asset_thumbnail") {
      if(args.preview && qa.previewError) throw new Error(qa.previewError);
      return args.preview ? {uri:"/synthetic-image/sharp-0",etag:'"sharp-0"',mime:"image/png",w:1280,h:800} : delayThumbnails ? new Promise(resolve => thumbnails.push({resolve, id: args.id})) : thumb(args.id);
    }
    if(cmd==="content_asset_file") return structuredClone(qa.cachedResource);
    if (cmd === "content_navigation") return {tags: [], folders: []};
    if (cmd === "content_video_play" || cmd === "local_asset_video_play") return new Promise(resolve => {qa.nativeSession = {args, resolve};});
    if (cmd === "content_cancel") {
      if (qa.nativeSession?.args.jobId === args.jobId) qa.closeNative({reason: "cancelled", positionMs: 0, durationMs: 0});
      return;
    }
    if (cmd === "services_v1_request") {
      const r = args.request;
      if (r.operationId === "materials.detailV1") {
        if (qa.deferSource) await new Promise<void>(resolve => sourceReads.push(resolve));
        if (qa.sourceError) return {status: 403, body: {code: "GRANT_REQUIRED"}};
        const id = decodeURIComponent(r.path.split("/").at(-1));
        const a = records.find(a => a.desktopAssetId === id)!;
        return {status: 200, body: {...a, assetId: id, revision: a.etag, source: qa.noSource ? {captureKind: "unknown"} : {pageKind: "capture-page", captureKind: "web", siteOrigin: "https://example.org", pageUrl}}};
      }
      if (r.operationId === "presentation.open") return {status: 202, body: {opId: r.body.opId, state: "handoffStarted"}};
      return {status: 404, body: {code: "ENTITY_NOT_FOUND"}};
    }
    if (cmd === "plugin:opener|open_url" || cmd === "plugin:clipboard-manager|write_text") return;
    throw new Error(`Synthetic materials IPC not implemented: ${cmd}`);
  },
};
navigation.switchRoot("library");
localStorage.setItem("still.reduced", String(qa.reduced !== false));
localStorage.setItem("luckyray.theme", qa.dark ? "dark" : "light");
function App() {
  const [online, setOnline] = useState(true);
  qa.setOnline = (value: boolean) => setOnline(value);
  return <StillApp conn={{paired: true, identity: {instanceId: owner, displayName: "合成电脑", platform: "windows", appVersion: "QA", protocolVersion: 1, certificateFingerprint: "synthetic", baseUrl: "https://invalid"}, ws: {state: online ? "connected" : "disconnected", last_seq: 0, current: ""}, stats: null}} editingText={false} />;
}
createRoot(document.getElementById("root")!).render(<App />);
