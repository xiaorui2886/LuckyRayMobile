// STILL-01.1 visual-parity harness (DEV ONLY — loaded only when the URL has
// ?stillHarness=1, dynamically imported from main.tsx so it never ships in
// the normal bundle).
//
// It installs window.__TAURI_INTERNALS__ so the real @tauri-apps/api invoke
// choke point resolves against the SAME sample fixtures the authority demo
// renders (same strings, same media), letting the source-vs-production
// harness drive both sides through one driver. Production logic is untouched:
// provenance, pagers and coordinators keep deriving from the mocked rows.
import { navigation } from "../navigation";

type Row = Record<string, any>;

const MEDIA: Record<string, string> = {
  a1: "/harness-media/atrium.svg",
  a2: "/harness-media/paper.svg",
  a3: "/harness-media/waves.svg",
  a4: "/harness-media/form.svg",
  a5: "/harness-media/atrium.svg",
  a6: "/harness-media/waves.svg",
  a7: "/harness-media/paper.svg",
  a8: "/harness-media/form.svg",
};
const mediaOf = (id: string) => MEDIA[id] ?? MEDIA.a1;

let paired = true;
let wsState = "connected";
let runsHidden = false;

const localNotes: Row[] = [
  { noteId: "note-n1", title: "给想法留一点空白", content: "好的工具，不需要一直提醒你它的存在。\n\n留下今天看到的画面，写下一点还没成形的想法。先不着急分类，也不急着把它变成结果。\n\n一个舒服的工作空间，应该让内容自己呼吸。需要的时候，工具就在手边；不需要的时候，它们安静地退后。\n\n从手机上记下的这一刻，到电脑上慢慢展开，是同一件事的继续。", updatedAt: "2026-09-19T10:24:00", pinned: false, favorite: false, archived: false, tags: [] },
  { noteId: "note-n2", title: "今天的随手记", content: "窗边的光很好。\n\n想试试把画面里的灰绿色，放进下一张作品的背景。保留空间，让线条自己说话。", updatedAt: "2026-09-19T08:45:00", pinned: false, favorite: false, archived: false, tags: [] },
  { noteId: "note-n3", title: "一些关于留白的观察", content: "留白并不只是空着。\n\n它是内容之间的距离，也是读者停下来的地方。", updatedAt: "2026-09-18T21:02:00", pinned: false, favorite: true, archived: false, tags: ["留白"] },
  { noteId: "note-n4", title: "移动端的下一步", content: "不是另外一个 App。\n\n是同一份素材、知识与任务，在手机上更舒服的入口。", updatedAt: "2026-09-12T09:30:00", pinned: false, favorite: false, archived: false, tags: [] },
];

const desktopNotes: Row[] = [
  { noteId: "d1", title: "空间与光的收集", content: "把收集到的画面放在一起，才会发现它们之间的关系。\n\n光落在墙面上，留下浅浅的边界。那些没有被填满的部分，比装饰更耐看。\n\n手机适合随手发现，电脑适合认真展开。它们应该服务同一份内容。", updatedAt: "2026-09-19T09:00:00", instanceId: "inst-1", vaultId: "vault-1", vaultName: "LuckyRay 知识库", revision: "rev-d1", cachedDocument: { content: "把收集到的画面放在一起，才会发现它们之间的关系。", revision: "rev-d1", resources: [] }, serverDocument: { content: "把收集到的画面放在一起，才会发现它们之间的关系。", revision: "rev-d1" }, bodyOutdated: false },
  { noteId: "d2", title: "阅读清单", content: undefined, updatedAt: "2026-09-18T18:20:00", instanceId: "inst-1", vaultId: "vault-1", vaultName: "LuckyRay 知识库", revision: "rev-d2", cachedDocument: null, serverDocument: { revision: "rev-d2" }, bodyOutdated: false },
  { noteId: "d3", title: "整理方式的记录", content: "先收集，再慢慢整理。\n\n这是一份手机上可读的旧版本，电脑上的内容已经更新。", updatedAt: "2026-09-17T12:00:00", instanceId: "inst-1", vaultId: "vault-1", vaultName: "LuckyRay 知识库", revision: "rev-d3-old", cachedDocument: { content: "先收集，再慢慢整理。", revision: "rev-d3-old", resources: [] }, serverDocument: { revision: "rev-d3-new" }, bodyOutdated: true },
  { noteId: "d4", title: "旅行随笔", content: "今天在路上记下的片段。\n\n先存在手机里，连接恢复后继续同步。", updatedAt: "2026-09-16T15:40:00", instanceId: "inst-1", vaultId: "vault-1", vaultName: "LuckyRay 知识库", dirty: true, pendingKind: "edit", cachedDocument: { content: "今天在路上记下的片段。", revision: "rev-d4", resources: [] } },
  { noteId: "d5", title: "两边都修改过的想法", content: "手机上的版本：\n\n让日常记录更轻一点，也给后来整理留出余地。", updatedAt: "2026-09-15T11:11:00", instanceId: "inst-1", vaultId: "vault-1", vaultName: "LuckyRay 知识库", revision: "rev-d5", cachedDocument: { content: "手机上的版本：", revision: "rev-d5", resources: [] }, conflictDocument: { content: "让整理自然发生。先保存灵感的原貌，之后再补充联系和细节。" } },
];

const localAssets: Row[] = [
  { assetId: "a1", name: "光落下的地方", kind: "image", mime: "image/svg+xml", sizeBytes: 428_000, localPath: MEDIA.a1, favorite: false, archived: false, tags: [], contentHash: "hash-atrium" },
  { assetId: "a2", name: "Less, but better", kind: "image", mime: "image/svg+xml", sizeBytes: 355_000, localPath: MEDIA.a2, favorite: true, archived: false, tags: [], contentHash: "hash-paper" },
  { assetId: "a3", name: "潮汐的形状", kind: "image", mime: "image/svg+xml", sizeBytes: 391_000, localPath: MEDIA.a3, favorite: false, archived: false, tags: [], contentHash: "hash-waves" },
  { assetId: "a4", name: "形体与负空间", kind: "image", mime: "image/svg+xml", sizeBytes: 287_000, localPath: MEDIA.a4, favorite: false, archived: false, tags: [], contentHash: "hash-form" },
];

const desktopAssets: Row[] = [
  { desktopAssetId: "a5", name: "空间研究", kind: "image", mimeType: "image/svg+xml", sizeBytes: 512_000, description: "" },
  { desktopAssetId: "a6", name: "色彩方向", kind: "image", mimeType: "image/svg+xml", sizeBytes: 488_000, description: "" },
  { desktopAssetId: "a7", name: "文字参考", kind: "document", mimeType: "text/plain", sizeBytes: 12_000, description: "" },
  { desktopAssetId: "a8", name: "形体片段", kind: "video", mimeType: "video/mp4", sizeBytes: 96_000_000, description: "" },
];

const inboxItems: Row[] = [
  { entryId: "i1", kind: "text", title: "想记住的这个想法", text: "内容要能在手机和电脑之间自然地继续，而不是重复收集、重复整理。", url: "", createdAt: "2026-09-19T10:00:00", favorite: false, archived: false, source: "manual" },
  { entryId: "i2", kind: "link", title: "关于自然的交互", text: "", url: "https://developer.apple.com/videos/play/wwdc2018/803/", createdAt: "2026-09-18T16:30:00", favorite: false, archived: false, source: "share" },
  { entryId: "i3", kind: "text", title: "下次整理素材时", text: "给图片保留来源，也保留当时为什么喜欢它。", createdAt: "2026-09-18T09:12:00", favorite: false, archived: false, source: "manual" },
];

const runs: Row[] = [
  { runId: "r1", summary: "整理这周的灵感素材", status: "running", startedAt: "2026-09-19T09:32:00" },
  { runId: "r2", summary: "阅读笔记结构检查", status: "completed", startedAt: "2026-09-18T14:02:00" },
];

const runEvents: Row[] = [
  { seq: 1, type: "任务已开始", payload: { detail: "从已选择的素材范围开始整理。" } },
  { seq: 2, type: "读取素材信息", payload: { detail: "保留来源、文件类型和原有目录。" } },
  { seq: 3, type: "检查重复内容", payload: { detail: "比较当前素材中的重复记录。" } },
  { seq: 4, type: "生成整理建议", payload: { detail: "电脑仍在处理中，内容没有被手机改写。" } },
];

const wsListeners: ((e: { payload: any }) => void)[] = [];
const connState = (): Row => ({
  paired,
  identity: {
    instanceId: "inst-1", displayName: "LuckyRay Desktop", platform: "desktop",
    appVersion: "0.2.0", protocolVersion: 1,
    certificateFingerprint: "aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99",
    baseUrl: "http://192.168.1.10:5273",
  },
  stats: { assets: localAssets.length + desktopAssets.length, notes: localNotes.length + desktopNotes.length, outbox: 0, runs: runs.length, sync_cursor: 4 },
  ws: { state: paired ? wsState : "stopped", last_seq: 4, current: "" },
});

function fireWs() {
  for (const cb of wsListeners) cb({ payload: { state: wsState, last_seq: 4 } });
}

function findDesktop(route: string): Row | undefined {
  const id = route.split(":").pop() || route;
  return desktopNotes.find((n) => n.noteId === id);
}

const handlers: Record<string, (args: any) => unknown> = {
  conn_state: () => connState(),
  conn_resume: () => ({}),
  conn_pair: () => ({ status: "ok", preferenceSaved: true }),
  conn_revoke: () => "已忘记此电脑",
  ws_start: () => ({}),
  ws_stop: () => ({}),
  set_system_bar_appearance: () => true,
  move_task_to_back: () => true,
  db_health: () => ({ ok: true, schemaVersion: 7, expectedVersion: 7, tablesOk: true }),
  db_export_diagnostics: () => "/tmp/luckyray-diagnostics.txt",
  db_reset_full: () => ({}),
  secure_test: () => "ok",
  sync_run: () => ({ applied: 0, cursor: 4, stats: {} }),
  content_sync: () => ({ continuation: false, pushed: 0, applied: 0 }),
  local_inbox_ingest_shares: () => ({ added: 0, consumed: [] }),
  local_note_list: (a) => {
    let rows = localNotes.filter((n) => !a.archived ? true : n.archived);
    if (a.pinned) rows = rows.filter((n) => n.pinned);
    if (a.favorite) rows = rows.filter((n) => n.favorite);
    if (a.archived === false) rows = rows.filter((n) => !n.archived);
    if (a.q) rows = rows.filter((n) => (n.title + n.content).includes(a.q));
    return { items: rows, total: rows.length, hasMore: false };
  },
  local_note_get: (a) => localNotes.find((n) => n.noteId === a.noteId) ?? localNotes[0],
  local_note_add: () => ({ noteId: "note-new-1" }),
  local_note_update: () => ({}),
  local_note_set_flags: () => ({}),
  local_note_delete: () => ({}),
  local_note_erase_all: () => "已清空",
  local_note_stats: () => ({ total: 9, archived: 0, favorites: 1, pinned: 1 }),
  local_note_convert_inbox: (a) => ({ noteId: "note-from-inbox-" + (a.inboxId ?? "x") }),
  notes_list: () => desktopNotes.filter((n) => !n.deleted),
  local_asset_list: (a) => {
    let rows = localAssets;
    if (a.kind && a.kind !== "全部" && a.kind !== "all") rows = rows.filter((x) => x.kind === a.kind);
    if (a.q) rows = rows.filter((x) => x.name.includes(a.q));
    if (a.favorite) rows = rows.filter((x) => x.favorite);
    return { items: rows, total: rows.length, hasMore: false };
  },
  local_asset_get: (a) => localAssets.find((x) => x.assetId === a.assetId) ?? localAssets[0],
  local_asset_integrity: () => ({ status: "healthy", hashVerified: true }),
  local_asset_thumbnail: (a) => ({ uri: mediaOf(a.assetId), etag: "e1", mime: "image/svg+xml", w: 300, h: 300 }),
  local_asset_update: () => ({}),
  local_asset_set_flags: () => ({}),
  local_asset_delete: () => ({}),
  local_asset_erase_all: () => "已清空",
  local_asset_stats: () => ({ total: 8, archived: 0, favorites: 1, bytes: 1_918_272 }),
  local_asset_import: () => ({ cancelled: true }),
  local_asset_promote_inbox: (a) => ({ assetId: "a1-" + (a.inboxId ?? "x") }),
  // The Desktop material reads are expected-instance: the harness refuses a
  // call that names no owner, exactly like the Rust authority does.
  asset_thumbnail: (a) => {
    if (!a.instance) throw new Error("CONTENT_SOURCE_CHANGED");
    return { uri: mediaOf(a.id), etag: "e1", mime: "image/svg+xml", w: 300, h: 300 };
  },
  content_assets: (a) => {
    if (!a.instance) throw new Error("CONTENT_SOURCE_CHANGED");
    return { items: desktopAssets, total: desktopAssets.length, hasMore: false };
  },
  content_navigation: (a) => {
    if (!a.instance) throw new Error("CONTENT_SOURCE_CHANGED");
    return { folders: [], tags: [] };
  },
  content_asset_detail: (a) => {
    if (!a.instance) throw new Error("CONTENT_SOURCE_CHANGED");
    const row = desktopAssets.find((x) => x.desktopAssetId === a.id) ?? desktopAssets[0];
    return { ...row, localPath: undefined };
  },
  content_asset_file: (a) => {
    if (!a.instance) throw new Error("CONTENT_SOURCE_CHANGED");
    return { path: MEDIA.a3, mime: "image/svg+xml", etag: "e1", sizeBytes: 391_000 };
  },
  content_cached_resource: () => ({ path: MEDIA.a3, mime: "image/svg+xml", etag: "e1" }),
  content_cancel: () => ({}),
  content_open_resource: () => ({ status: "ok" }),
  content_note_begin: (a) => {
    const row = findDesktop(`${a.instance}:${a.vault}:${a.id}`) ?? desktopNotes[0];
    return { ...row, editorEpoch: 7 };
  },
  content_note_refresh: (a) => {
    const row = findDesktop(`${a.instance}:${a.vault}:${a.id}`) ?? desktopNotes[0];
    return row;
  },
  content_note_get: (a) => findDesktop(`${a.instance}:${a.vault}:${a.id}`) ?? desktopNotes[0],
  content_note_edit: (a) => {
    const row = findDesktop(`${a.instance}:${a.vault}:${a.id}`);
    if (row) { row.content = a.content; row.title = a.title; row.dirty = true; }
    return row;
  },
  content_note_resolve: () => ({}),
  content_note_delete: () => ({}),
  content_note_attach: () => ({ cancelled: true }),
  local_inbox_list: () => ({ items: inboxItems, total: inboxItems.length, hasMore: false }),
  local_inbox_stats: () => ({ total: 3, archived: 0, favorites: 0, bytes: 4_096 }),
  local_inbox_get: (a) => ({
    item: inboxItems.find((x) => x.entryId === a.itemId) ?? inboxItems[0],
    attachments: [],
  }),
  local_inbox_add: () => ({}),
  local_inbox_add_media: () => ({ cancelled: false, fileName: "harness.svg" }),
  local_inbox_update: () => ({}),
  local_inbox_set_favorite: () => ({}),
  local_inbox_set_archived: () => ({}),
  local_inbox_delete: () => ({}),
  local_inbox_erase_all: () => "已清空",
  companion_storage_stats: () => ({
    inbox: { count: 3, bytes: 4_096 },
    assetOriginals: { count: 8, bytes: 1_918_272 },
    thumbs: { count: 12, bytes: 262_144 },
    outbox: { count: 0, bytes: 0 },
  }),
  companion_clear_cache: () => ({ status: "ok", freedBytes: 262_144, filesRemoved: 12 }),
  companion_export: () => ({ status: "created", path: "/tmp/export" }),
  companion_share_file: () => ({ status: "ok" }),
  companion_share_text: () => ({ status: "ok" }),
  open_attachment: () => ({ status: "ok" }),
  agent_runs: () => (runsHidden ? [] : runs),
  agent_events: () => ({ events: runEvents }),
  agent_stop: () => ({}),
  capture_list: () => [],
};

// --- install ----------------------------------------------------------------

declare global {
  interface Window {
    __TAURI_INTERNALS__: any;
    stillHarness: { jump: (scene: string) => void; ready: boolean };
  }
}

export function installHarness() {
  if (window.__TAURI_INTERNALS__) return;
  const callbackFns = new Map<number, (e: unknown) => void>();
  let nextCallbackId = 1;
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args: Record<string, unknown> = {}) => {
      const h = handlers[cmd];
      if (h) return Promise.resolve(h(args));
      return Promise.reject(new Error("harness: no handler for " + cmd));
    },
    transformCallback: (cb: (e: unknown) => void) => {
      const id = nextCallbackId++;
      callbackFns.set(id, cb);
      return id;
    },
    convertFileSrc: (path: string) => path,
    metatypes: {},
    isTauri: true,
  };
  // The App subscribes to lr:ws-status to refresh the connection projection;
  // the harness keeps real listeners working so jump() can vary connection.
  const realInvoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = (cmd: string, args: any = {}) => {
    if (cmd === "plugin:event|listen") {
      if (args?.event === "lr:ws-status") {
        const id = args.handler as number;
        wsListeners.push((e) => callbackFns.get(id)?.(e));
      }
      return Promise.resolve(1);
    }
    return realInvoke(cmd, args);
  };

  window.stillHarness = {
    ready: true,
    jump(scene: string) {
      switch (scene) {
        case "ai-unpaired": paired = false; wsState = "stopped"; fireWs(); navigation.reset({ tab: "ai" }); return;
        case "ai-empty": runsHidden = true; navigation.reset({ tab: "ai" }); return;
        case "ai-offline": paired = true; wsState = "reconnecting"; fireWs(); navigation.reset({ tab: "ai" }); return;
        default: paired = true; wsState = "connected"; fireWs();
      }
      navigation.reset({ tab: "home" });
      const go = () => {
        switch (scene) {
          case "home": return;
          case "library": case "knowledge": case "ai": case "settings":
            navigation.switchRoot(scene as any); return;
          case "search": navigation.openSearch(); return;
          case "capture": navigation.pushScreen("capture"); return;
          case "inbox": navigation.pushDetail({ tab: "home", detail: "inbox" }); return;
          case "asset": navigation.pushDetail({ tab: "library", detail: "local:a1" }); return;
          case "run": navigation.pushDetail({ tab: "ai", detail: "r1" }); return;
          case "note": navigation.pushDetail({ tab: "knowledge", detail: "note-n1" }); return;
          case "note-edit": navigation.pushDetail({ tab: "knowledge", detail: "edit:note-n1" }); return;
          case "note-desktop": navigation.pushDetail({ tab: "knowledge", detail: "desktop:inst-1:vault-1:d1" }); return;
          case "note-metadata": navigation.pushDetail({ tab: "knowledge", detail: "desktop:inst-1:vault-1:d2" }); return;
          case "note-outdated": navigation.pushDetail({ tab: "knowledge", detail: "desktop:inst-1:vault-1:d3" }); return;
          case "note-pending": navigation.pushDetail({ tab: "knowledge", detail: "desktop:inst-1:vault-1:d4" }); return;
          case "note-conflict": navigation.pushDetail({ tab: "knowledge", detail: "desktop:inst-1:vault-1:d5" }); return;
          case "note-empty": navigation.pushDetail({ tab: "knowledge", detail: "new" }); return;
          case "connect": navigation.pushDetail({ tab: "settings", detail: "connect-computer" }); return;
          case "preferences": navigation.pushDetail({ tab: "settings", detail: "preferences" }); return;
          case "appearance": navigation.pushDetail({ tab: "settings", detail: "appearance" }); return;
          case "storage": navigation.pushDetail({ tab: "settings", detail: "storage" }); return;
          case "diagnostics": navigation.pushDetail({ tab: "settings", detail: "diagnostics" }); return;
          case "recovery": navigation.pushDetail({ tab: "settings", detail: "recovery" }); return;
          case "unpaired-connect": paired = false; wsState = "stopped"; fireWs();
            navigation.pushDetail({ tab: "settings", detail: "connect-computer" }); return;
        }
      };
      go();
    },
  };
}
