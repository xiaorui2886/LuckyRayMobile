// Tauri invoke wrappers for the official mobile services.
import { invoke } from "@tauri-apps/api/core";

export type ConnState = {
  paired: boolean;
  identity: {
    instanceId: string;
    displayName: string;
    platform: string;
    appVersion: string;
    protocolVersion: number;
    certificateFingerprint: string;
    baseUrl: string;
  } | null;
  stats: { assets: number; notes: number; outbox: number; runs: number; sync_cursor: number } | null;
  ws: { state: string; last_seq: number; current: string; reason?: string | null; last_failure?: string | null };
};

/** Result of an explicit connect/disconnect or an automatic resume.
 *  `preferenceSaved === false` means the operation SUCCEEDED but the durable
 *  preference could not be written — the UI must say that, not "failed". */
export type ConnTransitionResult = {
  status: string;
  preferenceSaved: boolean;
  warning?: string | null;
};

export type NativeVideoReceipt = {reason: string; positionMs: number; durationMs: number; errorCode?: string; firstFrameMs?: number; remoteBytesBeforeFirstFrame?: number; remoteBytes: number; sizeBytes: number; transport: string; completeOffline: boolean; rangeRequests?: number; cacheBytes?: number; format?: {videoMime?: string; audioMime?: string; containerMime?: string; codecs?: string; videoDecoder?: string; audioDecoder?: string; width?: number; height?: number; frameRate?: number; lumaBitdepth?: number; chromaBitdepth?: number; channels?: number; sampleRate?: number; audioAdvancing?: boolean; rangeRetries?: number; playerErrorCode?: number}};

export const api = {
  managedVaultResourceOpen: (localVaultId: string, noteId: string, target: string, expectedRevision: string) => invoke<{ status: string }>("managed_vault_resource_open", { localVaultId, noteId, target, expectedRevision }),
  managedVaultResourceGet: (localVaultId: string, noteId: string, target: string, expectedRevision: string) => invoke<{ path: string; mime: string; sha256: string; sizeBytes: number }>("managed_vault_resource_get", { localVaultId, noteId, target, expectedRevision }),
  contentLibraryCatalog: (instance: string) => invoke<import("./desktopLibraries").DesktopLibraryCatalog>("content_library_catalog", {instance}),
  contentScopeChanged: (instance: string, kind: "materials" | "knowledge") => invoke<void>("content_scope_changed", {instance, kind}),
  connState: () => invoke<ConnState>("conn_state"),
  connPair: (payload: string) => invoke<unknown>("conn_pair", { payload }),
  connPairFile: (fileName: string) => invoke<unknown>("conn_pair_file", { fileName }),
  pairPickFile: () => invoke<unknown>("pair_pick_file"),
  connRevoke: () => invoke<string>("conn_revoke"),
  connHello: () => invoke<unknown>("conn_hello"),
  syncRun: () => invoke<{ applied: number; cursor: number; stats: unknown }>("sync_run"),
  assetsRefresh: (page: number, limit: number, kind?: string) =>
    invoke<{ items: unknown[]; total: number; hasMore: boolean }>("assets_refresh", { page, limit, kind }),
  assetsLocal: (page: number, limit: number, kind?: string) =>
    invoke<{ items: any[]; total: number; hasMore: boolean }>("assets_local", { page, limit, kind }),
  assetDetail: (id: string) => invoke<any>("asset_detail", { id }),
  /** Desktop thumbnails are owned: `instance` is the Desktop the page belongs
   *  to, and Rust fails closed if the live connection has moved on. */
  /** `force` is the bounded decode-failure retry: it drops this exact
   *  owner+asset cache row and refetches, never touching another owner. */
  assetThumbnail: (instance: string, id: string, force = false, preview = false, version = "", library?: string) => invoke<{ uri: string; etag: string; mime: string; w: number; h: number }>("asset_thumbnail", { library, instance, id, force, preview, version }),
  assetFile: (id: string) => invoke<string>("asset_file", { id }),
  contentCapabilities: () => invoke<import("../../shared/companion-content-v1/types").Capabilities>("content_capabilities"),
  /** Every Desktop material read carries the EXPECTED owner instance; the
   *  authority refuses (`CONTENT_SOURCE_CHANGED`) rather than silently reading
   *  whichever Desktop happens to be connected now. */
  contentAssets: (instance: string, opts: { page: number; limit: number; q?: string; kind?: string; folder?: string; tag?: string }, library?: string) =>
    invoke<import("../../shared/companion-content-v1/types").AssetPage>("content_assets", { library, instance, ...opts }),
  contentNavigation: (instance: string, library?: string) => invoke<{ folders: any[]; tags: any[] }>("content_navigation", { library, instance }),
  contentAssetDetail: (instance: string, id: string, library?: string) => invoke<any>("content_asset_detail", { library, instance, id }),
  contentAssetFile: (instance: string, id: string, jobId: string, maxBytes?: number, expectedVersion?: string, library?: string) => invoke<{ path: string; mime: string; etag: string; sizeBytes: number; assetVersion?: string }>("content_asset_file", { library, instance, id, jobId, ...(maxBytes === undefined ? {} : {maxBytes}), ...(expectedVersion === undefined ? {} : {expectedVersion}) }),
  contentCancel: (jobId: string) => invoke<void>("content_cancel", { jobId }),
  contentMediaSource: (instance: string, id: string, vault?: string, note?: string, library?: string) => invoke<{url: string; token: string}>("content_media_source", { library,instance,id,vault,note}),
  localAssetMediaSource: (assetId: string) => invoke<{url: string; token: string}>("local_asset_media_source", {assetId}),
  contentMediaRelease: (token: string) => invoke<void>("content_media_release", {token}),
  /** Native playback selects only this owner's complete cache or paired Range
   * source. No Desktop URL, bearer, arbitrary path or partial-cache authority. */
  contentVideoPlay: (instance: string, id: string, jobId: string, title: string, startPositionMs: number, darkMode = false, library?: string) =>
    invoke<NativeVideoReceipt>("content_video_play", { library,instance, id, jobId, title, startPositionMs, darkMode}),
  localAssetVideoPlay: (assetId: string, jobId: string, title: string, startPositionMs: number, darkMode = false) =>
    invoke<NativeVideoReceipt>("local_asset_video_play", {assetId, jobId, title, startPositionMs, darkMode}),
  contentNoteLocalAttachment: (instance: string, vault: string, note: string, op: string) => invoke<{path: string; mime: string; etag: string}>("content_note_local_attachment", {instance, vault, note, op}),
  contentNoteResource: (instance: string, vault: string, note: string, id: string, jobId: string) => invoke<{path: string; mime: string; etag: string}>("content_note_resource", { instance, vault, note, id, jobId }),
  /**
   * LSH remote surface (Issue #72). `expectedInstance` names the paired
   * Desktop the surface belongs to; the Rust gate refuses a moved connection
   * before any request. The session URL is opaque — Mobile invents neither the
   * bootstrap path, nor cookies, nor tokens (bound at the Desktop #166
   * integration closure).
   */
  lshSurfaceEmbed: (request: import("../still/kit/lshEmbedded").LshEmbedRequest) =>
    invoke<import("../still/kit/lshEmbedded").LshEmbedReceipt>("lsh_surface_embed", request),
  lshSurfaceState: (expectedInstance: string) =>
    invoke<{ granted: boolean; runtimeAvailable: boolean }>("lsh_surface_state", { expectedInstance }),
  lshSurfaceBootstrap: (expectedInstance: string) => invoke<{ sessionUrl: string; expiresAtMs: number; carrierGeneration: number; gatewayGeneration: number }>("lsh_surface_bootstrap", { expectedInstance }),
  lshSurfaceStop: () => invoke<{ stopped: boolean }>("lsh_surface_stop"),
  /** Open the dedicated Android WebView shell for one exact session URL. */
  lshSurfaceOpen: (request: { sessionUrl: string; ownerInstanceId: string; title: string }) => invoke<{ opened: boolean }>("lsh_surface_open", { ...request }),
  contentCachedResource: (instance: string, id: string, vault?: string, note?: string, library?: string) => invoke<{path: string; mime: string; etag: string}>("content_cached_resource", { library, instance, id, vault, note }),
  contentSync: (instance?: string, vault?: string) => invoke<{ continuation: boolean; pushed: number; applied: number; pairingReviewRequired?: boolean; warningCode?: string }>("content_sync", {instance,vault}),
  contentCacheLibraries: () => invoke<import("./knowledgeActions").CacheLibrary[]>("content_cache_libraries"),
  contentCacheClear: (instance: string, vault: string) => invoke<{clearedCount: number; protectedCount: number; paused: true}>("content_cache_clear", {instance, vault}),
  localNoteImportPick: () => invoke<{status: "launched"; requestId?: string}>("local_note_import_pick"),
  localNoteImportPending: () => invoke<{items: import("./knowledgeActions").ImportReceipt[]; hasMore?: boolean}>("local_note_import_pending"),
  localNoteImportAck: (requestIds: string[]) => invoke<void>("local_note_import_ack", {requestIds}),
  contentLocalNoteUploadTarget: (instance: string, vault?: string) => invoke<import("./knowledgeActions").UploadTarget>("content_local_note_upload_target", {instance, vault}),
  contentLocalNoteUpload: (instance: string, vault: string, noteId: string, parent: string) => invoke<{status: "queued" | "alreadySubmitted"; noteId: string; localNoteId: string; instanceId: string; vaultId: string; reused: boolean; transferScope: "titleAndContent"; localMetadataPreserved: true; localOriginalPreserved: true}>("content_local_note_upload", {instance, vault, noteId, parentRelativePath: parent}),
  contentVaults: () => invoke<any[]>("content_vaults"),
  contentReplicaLibraries: (instance: string) => invoke<import("./knowledgeReplica.ts").KnowledgeReplicaLibrary[]>("content_offline_libraries", {instance}),
  contentReplicaNotes: (instance: string, vault: string, q = "", page = 1, directory = "") => invoke<import("./knowledgeReplica.ts").KnowledgeReplicaPage>("content_offline_notes", {instance, vault, q, page, directory}),
  contentReplicaControl: (instance: string, vault: string, action: "start" | "pause" | "resume") => invoke<void>("content_offline_control", {instance, vault, action}),
  contentNotes: (instance: string, vault: string, q = "", page = 1, directory = "") => invoke<{items: any[]; hasMore: boolean; source?: "live" | "cache"; page?: number}>("content_notes", { instance, vault, q, page, directory }),
  /** KNOWLEDGE-ORGANIZATION-R1: apply a committed move receipt to the local cache projection. */
  contentNoteMoveReceipt: (instance: string, vault: string, id: string, revision: string, parentRelativePath: string) => invoke<void>("content_note_move_receipt", { instance, vault, id, revision, parentRelativePath }),
  /** REPAIR-R1.2: bounded LOCAL-ONLY move-safety facts for exactly the selected ids. */
  contentNoteMoveFacts: (instance: string, vault: string, ids: string[]) => invoke<{ items: Array<{ noteId: string; dirty: boolean; pending: boolean; conflict: boolean; revision: string; serverRevision: string }> }>("content_note_move_facts", { instance, vault, ids }),
  contentNoteDirectories: (instance: string, vault: string) => invoke<{ directories: string[] }>("content_note_directories", { instance, vault }),
  // Wave A: Desktop material organization (desired-state; Desktop owns truth).
  // Every call requires a connected Desktop and fails truthfully offline.
  contentMaterialSetFavorite: (instance: string, assetId: string, favorited: boolean, library?: string) =>
    invoke<{ desktopAssetId: string; favorited: boolean }>("content_material_set_favorite", { library, instance, assetId, favorited }),
  contentMaterialSetTags: (instance: string, assetId: string, patch: { set?: string[]; add?: string[]; remove?: string[] }, library?: string) =>
    invoke<{ desktopAssetId: string; tags: string[] }>("content_material_set_tags", { library, instance, assetId, set: patch.set ?? null, add: patch.add ?? null, remove: patch.remove ?? null }),
  contentMaterialSetFolder: (instance: string, assetId: string, folderId: string | null, library?: string) =>
    invoke<{ desktopAssetId: string; folderId: string | null }>("content_material_set_folder", { library, instance, assetId, folderId }),
  contentMaterialCreateTag: (instance: string, name: string, color?: string, library?: string) =>
    invoke<{ tag: { id: string; name: string; color?: string | null } }>("content_material_create_tag", { library, instance, name, color: color ?? null }),
  contentMaterialCreateFolder: (instance: string, name: string, parentId?: string, library?: string) =>
    invoke<{ folder: { id: string; name: string; parentId?: string | null } }>("content_material_create_folder", { library, instance, name, parentId: parentId ?? null }),
  /**
   * Batch organization. `folderChange` is an explicit PRESENCE signal: false
   * sends no folderId at all (leave the folder unchanged), true sends
   * folderId (null = root, string = that folder). Rust forwards the same
   * tri-state to the Desktop contract.
   */
  contentMaterialBatch: (instance: string, input: {
    assetIds: string[]; favorited?: boolean; add?: string[]; remove?: string[];
    folderChange: boolean; folderId?: string | null;
  }, library?: string) =>
    invoke<{ requested: number; succeeded: string[]; failed: { desktopAssetId: string; reason: string }[]; atomic: false }>(
      "content_material_batch",
      {
        library, instance,
        assetIds: input.assetIds,
        favorited: input.favorited ?? null,
        add: input.add ?? null,
        remove: input.remove ?? null,
        folderChange: input.folderChange,
        folderId: input.folderChange ? (input.folderId ?? null) : null,
      },
    ),
  contentNoteBegin: (instance: string, vault: string, id: string) => invoke<any>("content_note_begin", { instance, vault, id }),
  contentNoteGet: (instance: string, vault: string, id: string) => invoke<any>("content_note_get", { instance, vault, id }),
  /** R4 (B): ONE bounded LOCAL-ONLY bulk preview read (note_cache DB; zero network). */
  contentNotePreviews: (instance: string, vault: string, ids: string[]) => invoke<{ items: Array<{ noteId: string; content: string; dirty: boolean; bodyOutdated: boolean }> }>("content_note_previews", { instance, vault, ids }),
  contentNotePrefetch: (instance: string, vault: string, id: string, expectedRevision: string, jobId: string) => invoke<{changed: boolean}>("content_note_prefetch", {instance, vault, id, expectedRevision, jobId}),
  contentNoteRefresh: (instance: string, vault: string, id: string) => invoke<any>("content_note_refresh", { instance, vault, id }),
  contentNoteEdit: (input: {instance: string; vault: string; id: string; title: string; content: string; epoch: number; generation: number; expectedRevision?: string}) => invoke<any>("content_note_edit", input),
  contentNoteResumePaused: (input: {instance: string; vault: string; id: string; pausedOpId: string; epoch: number; generation: number}) => invoke<any>("content_note_resume_paused", input),
  contentNoteCreate: (instance: string, vault: string, title: string, parentRelativePath?: string) => invoke<string>("content_note_create", { instance, vault, title, parentRelativePath: parentRelativePath || null }),
  /** R1.5-A: READ-ONLY directory metadata hydration (no push, no bodies, no sync-position change). */
  contentHydrateDirectories: (instance: string, vault: string, afterId?: string | null) => invoke<{ nextAfterId: string; hasMore: boolean; applied: number }>("content_hydrate_directories", { instance, vault, afterId: afterId || null }),
  /** R1.5.1: the Desktop CREATE authority (Content V1 contentVersion 1 + noteWrite + exact vault). */
  contentNoteCreateAuthority: (instance: string, vault: string) => invoke<{ usable: boolean; reason?: string; contentVersion?: number; noteWrite?: boolean; vaultId?: string }>("content_note_create_authority", { instance, vault }),
  contentNoteDelete: (instance: string, vault: string, id: string) => invoke<void>("content_note_delete", { instance, vault, id }),
  contentNoteResolve: (instance: string, vault: string, id: string, copy: boolean) => invoke<string | null>("content_note_resolve", { instance, vault, id, copy }),
  contentNoteAttach: (instance: string, vault: string, id: string, kind: "image" | "photo" | "file") => invoke<any>("content_note_attach", { instance, vault, id, kind }),
  contentOpenResource: (instance: string, id: string, vault?: string, note?: string, library?: string) => invoke<any>("content_open_resource", { library,instance, id, vault, note}),
  notesList: () => invoke<any[]>("notes_list"),
  noteGet: (id: string) => invoke<any>("note_get", { id }),
  noteRefresh: (id: string) => invoke<any>("note_refresh", { id }),
  noteUpdate: (id: string, expectedRevision: string, content: string, title: string) =>
    invoke<any>("note_update", { id, expectedRevision, content, title }),
  noteLocalEdit: (id: string, title: string, content: string) =>
    invoke<string>("note_local_edit", { id, title, content }),
  captureAdd: (kind: string, text: string, link: string) => invoke<any>("capture_add", { kind, text, link }),
  captureList: () => invoke<any[]>("capture_list"),
  captureFlush: () => invoke<{ pushed: number; failed: number }>("capture_flush"),
  captureRetry: (opId: string) => invoke<any>("capture_retry", { opId }),
  // Local Inbox (M2.7) — Mobile-local durable data, works with zero Desktop.
  localInboxList: (opts: { kind?: string; q?: string; favorite?: boolean; archived?: boolean; page?: number; limit?: number }) =>
    invoke<{ items: any[]; total: number; hasMore: boolean }>("local_inbox_list", opts),
  localInboxGet: (itemId: string) => invoke<any>("local_inbox_get", { itemId }),
  localInboxAdd: (kind: string, text: string, link: string) =>
    invoke<{ itemId: string; kind: string }>("local_inbox_add", { kind, text, link }),
  localInboxAddMedia: (kind: string) => invoke<any>("local_inbox_add_media", { kind }),
  localInboxUpdate: (itemId: string, title: string, text: string, url: string) =>
    invoke<string>("local_inbox_update", { itemId, title, text, url }),
  localInboxSetFavorite: (itemId: string, favorite: boolean) =>
    invoke<string>("local_inbox_set_favorite", { itemId, favorite }),
  localInboxSetArchived: (itemId: string, archived: boolean) =>
    invoke<string>("local_inbox_set_archived", { itemId, archived }),
  localInboxDelete: (itemId: string) => invoke<string>("local_inbox_delete", { itemId }),
  localInboxStats: () => invoke<{ total: number; archived: number; favorites: number; bytes: number }>("local_inbox_stats"),
  localInboxEraseAll: () => invoke<string>("local_inbox_erase_all"),
  localInboxIngestShares: () => invoke<{ consumed: number }>("local_inbox_ingest_shares"),
  // Local Knowledge / Notes (M2.8) — Mobile-local durable notes, works with zero Desktop.
  localNoteList: (opts: { folder?: string; q?: string; tag?: string; pinned?: boolean; favorite?: boolean; archived?: boolean; page?: number; limit?: number; sort?: "recent" | "name" }) =>
    invoke<{ items: any[]; total: number; hasMore: boolean }>("local_note_list", opts),
  localNoteLinkCatalog: () => invoke<{ items: { noteId: string; title: string; folder: string; historicalNames: string[] }[] }>("local_note_link_catalog"),
  localNoteFolders: () => invoke<{ paths: string[] }>("local_note_folders"),
  localNoteCreateFolder: (name: string, parent = "") => invoke<{ path: string }>("local_note_create_folder", { name, parent }),
  localNoteSetFolder: (noteId: string, folder: string) => invoke<any>("local_note_set_folder", { noteId, folder }),
  /**
   * Every distinct tag on the Local Note tag AUTHORITY (bounded, stable
   * order). The filter picker needs this rather than the tags visible on the
   * currently loaded page.
   */
  localNoteTags: () => invoke<{ tags: string[] }>("local_note_tags"),
  localNoteGet: (noteId: string) => invoke<any>("local_note_get", { noteId }),
  localNoteAdd: (title: string, content: string, tags: string[], folder?: string) =>
    invoke<any>("local_note_add", { title, content, tags, folder }),
  localNoteUpdate: (noteId: string, title: string, content: string, tags: string[]) =>
    invoke<any>("local_note_update", { noteId, title, content, tags }),
  localNoteSetFlags: (noteId: string, flags: { pinned?: boolean; favorite?: boolean; archived?: boolean }) =>
    invoke<string>("local_note_set_flags", { noteId, ...flags }),
  localNoteDelete: (noteId: string) => invoke<string>("local_note_delete", { noteId }),
  localNoteStats: () => invoke<{ total: number; archived: number; favorites: number; pinned: number }>("local_note_stats"),
  localNoteEraseAll: () => invoke<string>("local_note_erase_all"),
  localNoteConvertInbox: (inboxId: string) => invoke<any>("local_note_convert_inbox", { inboxId }),
  unifiedLocalSearch: (q: string, page = 1, limit = 50) =>
    invoke<{ results: any[]; total: number; hasMore: boolean }>("unified_local_search", { q, page, limit }),
  // Local Asset Library (M2.9) — phone-owned durable materials, zero Desktop.
  localAssetList: (opts: { kind?: string; q?: string; tag?: string; favorite?: boolean; archived?: boolean; page?: number; limit?: number; sort?: "recent" | "name" | "size" }) =>
    invoke<{ items: any[]; total: number; hasMore: boolean }>("local_asset_list", opts),
  /** Every distinct tag on the Local Asset tag AUTHORITY (bounded, stable
   *  order) — the library filter picker needs this, not page-derived tags. */
  localAssetTags: () => invoke<{ tags: string[] }>("local_asset_tags"),
  localAssetGet: (assetId: string) => invoke<any>("local_asset_get", { assetId }),
  localAssetImport: (kind: string) => invoke<any>("local_asset_import", { kind }),
  localAssetUpdate: (assetId: string, name: string, tags: string[]) =>
    invoke<any>("local_asset_update", { assetId, name, tags }),
  localAssetSetFlags: (assetId: string, flags: { favorite?: boolean; archived?: boolean }) =>
    invoke<string>("local_asset_set_flags", { assetId, ...flags }),
  localAssetDelete: (assetId: string) => invoke<string>("local_asset_delete", { assetId }),
  localAssetStats: () => invoke<{ total: number; archived: number; favorites: number; bytes: number }>("local_asset_stats"),
  localAssetEraseAll: () => invoke<string>("local_asset_erase_all"),
  localAssetThumbnail: (assetId: string, preview = false, force = false) =>
    invoke<{ uri: string; mime: string; w: number; h: number }>("local_asset_thumbnail", { assetId, preview, force }),
  localAssetIntegrity: (assetId: string, verifyHash: boolean) =>
    invoke<{ assetId: string; exists: boolean; isFile: boolean; sizeMatches: boolean; hashVerified: boolean; status: string }>(
      "local_asset_integrity", { assetId, verifyHash }),
  localAssetPromoteInbox: (inboxId: string) => invoke<any>("local_asset_promote_inbox", { inboxId }),
  localAssetReconcile: () => invoke<{ reconciled: number }>("local_asset_reconcile"),
  // M2.11 — Mobile Companion Storage & Export.
  companionExport: (sourcePath: string, displayName: string, mime: string, collection: string) =>
    invoke<{ status: string; destination?: string; displayName?: string; uri?: string; bytes?: number; message?: string }>(
      "companion_export", { sourcePath, displayName, mime, collection }),
  companionShareFile: (sourcePath: string, displayName: string, mime: string) =>
    invoke<{ status: string; message?: string }>("companion_share_file", { sourcePath, displayName, mime }),
  companionShareText: (text: string) =>
    invoke<{ status: string; message?: string }>("companion_share_text", { text }),
  openAttachment: (sourcePath: string, mime: string) =>
    invoke<{ status: string; message?: string }>("open_attachment", { sourcePath, mime }),
  companionStorageStats: () =>
    invoke<{
      inbox: { count: number; bytes: number };
      assetOriginals: { count: number; bytes: number };
      thumbs: { count: number; bytes: number };
      outbox: { count: number; bytes: number };
    }>("companion_storage_stats"),
  companionClearCache: () =>
    invoke<{ freedBytes: number; filesRemoved: number; status?: string; message?: string }>("companion_clear_cache"),
  agentRuns: () => invoke<any[]>("agent_runs"),
  agentEvents: (runId: string) => invoke<{ events: any[] }>("agent_events", { runId }),
  agentStop: (runId: string) => invoke<any>("agent_stop", { runId }),
  wsStart: () => invoke<ConnTransitionResult>("ws_start"),
  wsStop: () => invoke<ConnTransitionResult>("ws_stop"),
  wsState: () => invoke<{ state: string; last_seq: number; current: string }>("ws_state"),
  /** M3-M1 R2: idempotent cold-start/foreground auto-recovery of an existing
   *  pairing. Skips itself when the user explicitly disconnected or the
   *  device is unpaired; never re-pairs and never invents a credential. */
  connResume: () => invoke<ConnTransitionResult>("conn_resume"),
  secureTest: () => invoke<string>("secure_test"),
  dbStats: () => invoke<any>("db_stats"),
  dbReset: () => invoke<string>("db_reset"),
  gmsAvailable: () => invoke<boolean>("gms_available"),
  /** INTERACTION-CLOSURE-R1: background the task (Android Home semantics) —
   * used ONLY by the root Back fallback. No process kill. */
  moveTaskToBack: () => invoke<boolean>("move_task_to_back"),
  /** INTERACTION-CLOSURE-R1: system-bar visual appearance follows color mode. */
  setSystemBarAppearance: (dark: boolean, dimmed = false, statusRgb?: number, navigationRgb?: number) => invoke<boolean>("set_system_bar_appearance", { dark, dimmed, statusRgb, navigationRgb }),
  qrScan: (timeoutMs: number) => invoke<string>("qr_scan", { timeoutMs }),
  qrCancel: () => invoke<string>("qr_cancel"),
  dbHealth: () => invoke<{ ok: boolean; schemaVersion: number; expectedVersion: number; tablesOk: boolean }>("db_health"),
  dbExportDiagnostics: () => invoke<string>("db_export_diagnostics"),
  dbResetFull: () => invoke<string>("db_reset_full"),
};

/** Immutable route/request-bound material API. Do not pass a mutable selection getter. */
export function materialApi(library: string | undefined, writeGranted = true) {
  const bind = <A extends unknown[], R>(fn: (...args: [...A, string?]) => R, arity: number, write = false) => (...args: A): R => {
    if (write && !writeGranted) return Promise.reject(new Error("LIBRARY_READ_ONLY")) as R;
    const fixed = [...args]; while (fixed.length < arity) fixed.push(undefined);
    return fn(...[...fixed, library] as unknown as [...A, string?]);
  };
  return {
    assetThumbnail: bind(api.assetThumbnail, 5),
    contentAssets: bind(api.contentAssets, 2),
    contentNavigation: bind(api.contentNavigation, 1),
    contentAssetDetail: bind(api.contentAssetDetail, 2),
    contentAssetFile: bind(api.contentAssetFile, 5),
    contentMediaSource: bind(api.contentMediaSource, 4),
    contentVideoPlay: bind(api.contentVideoPlay, 6),
    contentCachedResource: bind(api.contentCachedResource, 4),
    contentMaterialSetFavorite: bind(api.contentMaterialSetFavorite, 3, true),
    contentMaterialSetTags: bind(api.contentMaterialSetTags, 3, true),
    contentMaterialSetFolder: bind(api.contentMaterialSetFolder, 3, true),
    contentMaterialCreateTag: bind(api.contentMaterialCreateTag, 3, true),
    contentMaterialCreateFolder: bind(api.contentMaterialCreateFolder, 3, true),
    contentMaterialBatch: bind(api.contentMaterialBatch, 2, true),
    contentOpenResource: bind(api.contentOpenResource, 4),
  };
}
