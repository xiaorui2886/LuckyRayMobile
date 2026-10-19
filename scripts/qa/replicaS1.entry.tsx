// Isolated synthetic IPC only; renders the real StillApp/Knowledge/editor.
// This is QA-only and is not an application entry or a Desktop adapter.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import StillApp from "../../src/still/StillShell";
import { navigation } from "../../src/navigation";
import { dataStore } from "../../src/services/dataStore";
import { syncCoordinator } from "../../src/services/syncCoordinator";

const qa = (window as any).__replicaQa;
const instance = "synthetic-pc", vault = "synthetic-vault";
const names = ["关于一座城与一段很长很长的中文标题：在移动端继续思考的知识笔记", "项目计划与会议记录", "一本书的阅读札记", "空正文", "边界与重复名字"];
const bodies = ["清晨的光穿过窗边，我们把还没完成的想法写在这里。保留原页面里的留白与轻盈，也让每一次离线修改都有落点。\n第二段继续记录。", "# 项目计划\n一段合成的正文，没有真实用户资料。正文末尾的唯一检索词：山海鲸落。", "阅读是把别人的思考带回自己的世界。\n\n" + "这是一段用于窄屏行数检查的中文摘要。".repeat(10), "", "此处用于核对按身份而不是标题去重。"];
const records = Array.from({ length: qa.empty ? 0 : 112 }, (_, i) => {
  const noteId = `n${String(i).padStart(3, "0")}`;
  const doc = {noteId, vaultId: vault, title: names[i % 5] + (i > 4 ? ` ${i}` : ""), relativePath: `资料/${noteId}.md`, content: bodies[i % 5], revision: `r${i}`, resources: [], updatedAt: "2026-09-28T00:00:00Z"};
  return {...doc, instanceId: instance, dirty: false, deleted: false, cachedDocument: doc, serverDocument: doc, editorEpoch: 1, draftGeneration: 0, pendingKind: "update"};
});
const local = names.map((title, i) => ({noteId: `note-qa-local-${i}`, title, content: bodies[i], updatedAt: "2026-09-28T00:00:00Z", tags: [], pinned: false, favorite: false, archived: false}));
let confirmed = qa.confirmed === true, paused = false, remoteRevision = 0;
const library = () => ({instanceId: instance, vaultId: vault, name: "随身知识库", confirmed, paused, waitingCurrent: qa.waiting === true, writeState: qa.revoked ? "revoked" : "granted", metadataReady: true, total: records.length, ready: qa.partial ? 50 : records.length, failed: 0, unverified: 0});
const filtered = (q = "", directory = "") => records.filter(n => (!directory || n.relativePath.startsWith(directory + "/")) && `${n.title} ${n.content} ${n.relativePath}`.toLowerCase().includes(q.toLowerCase()));
qa.records = records;
qa.localRecords = local;
qa.calls = [];
qa.currentRoute = () => ({...navigation.current()});
qa.openRead = (noteId: string, retainDetail = false) => navigation.pushDetail({tab: "knowledge", detail: `desktop:${encodeURIComponent(instance)}:${encodeURIComponent(vault)}:${noteId}`}, {retainDetail});
qa.openLocal = (noteId = local[0].noteId, retainDetail = false) => navigation.pushDetail({tab: "knowledge", detail: noteId}, {retainDetail});
qa.leaveNote = () => navigation.switchRoot("knowledge");
qa.updateRemote = (noteId: string, content: string, notify = true) => {
  const n = records.find(n => n.noteId === noteId)!;
  const doc = {...n.serverDocument, content, revision: `remote-${++remoteRevision}`};
  Object.assign(n, {content, revision: doc.revision, serverDocument: doc, cachedDocument: doc, dirty: false});
  if (notify) dataStore.bump();
  return n;
};
(window as any).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args: any = {}) => {
    qa.calls.push({cmd, args});
    if (cmd === "services_v1_request") {
      const r = args.request;
      if (qa.error) return {status: 503, body: {code: "SERVICE_UNAVAILABLE"}};
      if (qa.loading) return new Promise(() => {});
      if (r.operationId === "services.discover") return {status: 200, body: {desktopInstanceId: instance, gatewayGeneration: 1, permissionRevision: 1, services: qa.navigationRepair ? {knowledge:{version:1}} : undefined, operations: Object.fromEntries(["knowledge.vaults", "knowledge.registeredList", "knowledge.move", ...(qa.navigationRepair ? ["knowledge.directories", "knowledge.relations"] : [])].map(op => [op, {state: "implemented", scope: "registeredVault", grant: "knowledge", capability: op}]))}};
      if (r.operationId === "knowledge.vaults") return {status: 200, body: {items: [{vaultId: vault, displayName: "随身知识库", activeInDesktop: true, readGranted: true, writeGranted: true}]}};
      if (qa.navigationRepair && r.operationId === "knowledge.directories") return {status:200,body:{vaultId:vault,items:["attachments","资料","资料/empty"].map(parentRelativePath=>({parentRelativePath})),hasMore:false,nextAfterPath:null}};
      if (qa.navigationRepair && r.operationId === "knowledge.relations") {
        if (qa.relationsDenied) return {status:403,body:{code:"GRANT_REQUIRED"}};
        const noteId = r.path.split("/").at(-2), n = records.find(n=>n.noteId===noteId);
        return {status:200,body:{vaultId:vault,noteId,revision:n?.revision||"",items:[],hasMore:false,nextAfter:null}};
      }
      if (r.operationId === "knowledge.registeredList") {
        if (qa.list429 > 0) { qa.list429--; return {status:429,body:"busy"}; }
        const all = filtered(r.query?.q); const at = r.query?.afterId ? all.findIndex(n => n.noteId === r.query.afterId) + 1 : 0;
        const items = all.slice(at, at + 50).map(n => ({...n, parentRelativePath: "资料"}));
        return {status: 200, body: {items, hasMore: at + 50 < all.length, nextAfterId: at + 50 < all.length ? items.at(-1)?.noteId : null}};
      }
      return {status: 404, body: {code: "ENTITY_NOT_FOUND"}};
    }
    if (cmd === "content_offline_libraries") return confirmed || qa.historical ? [library()] : [];
    if (cmd === "content_offline_control") { if (args.action === "start") confirmed = true; else paused = args.action === "pause"; dataStore.bump(); return; }
    if (cmd === "content_offline_notes" || cmd === "content_notes") {
      if (qa.navigationRepair && qa.deferDirectory === args.directory && args.directory) {
        qa.deferDirectory = null;
        return new Promise(resolve=>{qa.releaseDirectory=()=>{const all=filtered(args.q,args.directory);resolve({items:structuredClone(all.slice(0,50)),hasMore:false,source:"cache",page:1});};});
      }
      const all = filtered(args.q, args.directory); const at = ((args.page || 1) - 1) * 50; return {items: structuredClone(all.slice(at, at + 50)), hasMore: at + 50 < all.length, source: "cache", page: args.page || 1}; }
    if (cmd === "content_note_previews") return {items: structuredClone(records.filter(n => args.ids.includes(n.noteId)))};
    if (cmd === "content_note_directories") return {directories: ["资料"]};
    if (cmd === "content_hydrate_directories") return {hasMore: false, nextAfterId: null, applied: 0};
    if (cmd === "content_note_create_authority") return {usable: !qa.revoked, vaultId: vault, localReplica: confirmed};
    if (cmd === "content_note_create") {
      const noteId = `qa-created-${records.length}`;
      const doc = {noteId, vaultId: vault, title: args.title, content: "", relativePath: `${args.parentRelativePath ? args.parentRelativePath + "/" : ""}${noteId}.md`, revision: "", resources: [], updatedAt: "2026-09-28T00:00:00Z"};
      records.push({...doc, instanceId: instance, dirty: true, deleted: false, cachedDocument: doc, serverDocument: null as any, editorEpoch: 1, draftGeneration: 0, pendingKind: "create"});
      return noteId;
    }
    if (cmd === "content_note_refresh" && qa.deferFirstRefresh && !qa.firstRefreshDeferred) {
      qa.firstRefreshDeferred = true;
      qa.firstRefreshPending = true;
      qa.firstRefreshNoteId = args.id;
      return new Promise(resolve => {
        qa.releaseFirstRefresh = (content: string) => {
          // No dataStore bump: only the initial effect's actual async callback
          // may handle this response, not a later version-driven refresh.
          const fresh = qa.updateRemote(args.id, content, false);
          qa.firstRefreshPending = false;
          resolve(structuredClone(fresh));
        };
      });
    }
    if (["content_note_begin", "content_note_get", "content_note_refresh"].includes(cmd)) return structuredClone(records.find(n => n.noteId === args.id));
    if (cmd === "content_note_edit") {
      const n = records.find(n => n.noteId === args.id)!;
      if (qa.deferNextEdit) {
        qa.deferNextEdit = false;
        qa.desktopSavePending = args.id;
        return new Promise((resolve, reject) => { qa.releaseEdit = (success = true) => {
          qa.desktopSavePending = false; qa.releaseEdit = undefined;
          if (!success) { reject(new Error("QA_DESKTOP_SAVE_FAILED")); return; }
          Object.assign(n, {title: args.title, content: args.content, dirty: true, draftGeneration: args.generation});
          resolve(structuredClone(n));
        }; });
      }
      Object.assign(n, {title: args.title, content: args.content, dirty: true, draftGeneration: args.generation});
      return structuredClone(n);
    }
    if (cmd === "content_note_attach") {
      const n = records.find(n => n.noteId === args.id)!;
      n.content += "\n![附件待同步](luckyray-attachment:qa-resource)";
      n.dirty = true;
      return {cancelled: false, note: structuredClone(n)};
    }
    if (cmd === "content_sync") {
      if (qa.pendingWaiting) { qa.pendingWaiting = false; qa.waiting = true; }
      if (qa.pendingRevoked) { qa.pendingRevoked = false; qa.revoked = true; throw new Error("CONTENT_HTTP_403"); }
      return {continuation: false, pushed: 0, applied: 0, instanceId: instance, vaultId: vault};
    }
    if (cmd === "local_note_list") {
      const rows = local.filter(n => `${n.title} ${n.content}`.includes(args.q || ""));
      const limit = args.limit || 50, at = ((args.page || 1) - 1) * limit;
      const result = { items: structuredClone(rows.slice(at, at + limit)), total: rows.length, hasMore: at + limit < rows.length };
      if (qa.deferLocalWikiList) { qa.deferLocalWikiList = false; return new Promise(resolve => { qa.releaseLocalWikiList = () => resolve(result); }); }
      return result;
    }
    if (cmd === "local_note_tags") return {tags: []};
    if (cmd === "local_note_get") return structuredClone(local.find(n => n.noteId === args.noteId));
    if (cmd === "local_note_add") {
      const n = {noteId: `note-qa-created-${local.length}`, title: args.title, content: args.content, tags: args.tags || [],
        updatedAt: "2026-09-28T00:00:00Z", pinned: false, favorite: false, archived: false};
      if (qa.deferNextCreate) {
        qa.deferNextCreate = false; qa.createPending = true;
        return new Promise(resolve => { qa.releaseCreate = () => {
          qa.createPending = false; qa.releaseCreate = undefined;
          local.push(n); resolve(structuredClone(n));
        }; });
      }
      local.push(n);
      return structuredClone(n);
    }
    if (cmd === "local_note_update") {
      const n = local.find(n => n.noteId === args.noteId);
      if (!n) throw new Error("Synthetic local note not found");
      if (qa.deferNextLocalSave) {
        qa.deferNextLocalSave = false;
        qa.localSavePending = args.noteId;
        return new Promise((resolve, reject) => {
          qa.releaseLocalSave = (success = true) => {
            qa.localSavePending = false;
            qa.releaseLocalSave = undefined;
            if (!success) { reject(new Error("QA_LOCAL_SAVE_FAILED")); return; }
            Object.assign(n, {title: args.title, content: args.content, tags: args.tags});
            resolve(structuredClone(n));
          };
        });
      }
      Object.assign(n, {title: args.title, content: args.content, tags: args.tags});
      return structuredClone(n);
    }
    if (cmd === "capture_list") return [];
    throw new Error(`Synthetic IPC not implemented: ${cmd}`);
  },
};
navigation.switchRoot("knowledge");
localStorage.setItem("still.reduced", qa.reducedMotion === false ? "false" : "true");
localStorage.setItem("luckyray.theme", qa.dark ? "dark" : "light");
function App() {
  const [online, setOnline] = useState(qa.online !== false);
  qa.setOnline = (v: boolean) => { qa.online = v; setOnline(v); };
  qa.bump = () => dataStore.bump();
  qa.runSync = () => syncCoordinator.run();
  return <StillApp conn={{paired: true, identity: {instanceId: instance, displayName: "合成电脑", platform: "windows", appVersion: "QA", protocolVersion: 1, certificateFingerprint: "synthetic", baseUrl: "https://invalid"}, ws: {state: online ? "connected" : "disconnected", last_seq: 0, current: ""}, stats: null}} editingText={false} />;
}
createRoot(document.getElementById("root")!).render(<App />);
