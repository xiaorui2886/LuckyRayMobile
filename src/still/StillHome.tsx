import { managedVault, managedNoteRoute, type ManagedNote } from "../services/managedVault";
// STILL-01.1 — Home (production data, Still authority tree).
// Hierarchy: wordmark -> settings -> search launcher -> connection ->
// 继续阅读 -> 最近浏览 -> 手边 -> (dock/+ rendered by the shell).
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { HomeView, type NoteItem, type AssetItem } from "../presentation/still01/Views";
import { usePageCurrent } from "../presentation/still01/PageLayer";
import { useDesktopLibraries } from "./kit/DesktopLibraryPicker";
import { recentAssetHistory, recentAssetVisible } from "../services/recentAssetHistory";
import { parseAssetRoute } from "./kit/materialOrganization";
import { dataStore } from "../services/dataStore";
import { thumbnailScheduler, localThumbKey, desktopThumbKey, materialImageVersion } from "../services/thumbnailQueue";
import { isContentReadDenied, isContentReadTransportFailure, rateLimitDelay } from "../services/contentReadCooldown";
import { api } from "../services/client";
import { connectionOf } from "../presentation/still01/host";
import { localDataStore } from "../services/localDataStore";
import { localMeta } from "./stillData";
import { useStillNav } from "./StillShell";

export function StillHome() {
  const { conn, open } = useStillNav();
  const version = useSyncExternalStore(
    (fn) => localDataStore.subscribe(fn),
    () => localDataStore.getVersion()
  );
  const [managedVersion, setManagedVersion] = useState(0);
  useEffect(() => { const changed = () => setManagedVersion(value => value + 1); window.addEventListener("luckyray:managed-vault-change", changed); return () => window.removeEventListener("luckyray:managed-vault-change", changed); }, []);
  const [recentNote, setRecentNote] = useState<NoteItem | undefined>(undefined);
  const current = usePageCurrent();
  const [pageVisible, setPageVisible] = useState(!document.hidden);
  useEffect(() => { const update = () => setPageVisible(!document.hidden); document.addEventListener("visibilitychange", update); return () => document.removeEventListener("visibilitychange", update); }, []);
  const instance = conn?.identity?.instanceId || "";
  const connected = conn?.ws?.state === "connected";
  const libraries = useDesktopLibraries(instance, connected, true, current && pageVisible);
  const history = useSyncExternalStore(recentAssetHistory.subscribe, recentAssetHistory.snapshot);
  const [materialVersion, setMaterialVersion] = useState(0);
  useEffect(() => dataStore.subscribe(kind => { if (kind !== "knowledge") setMaterialVersion(v => v + 1); }), []);
  const selected = history.filter(item => recentAssetVisible(item, instance, Boolean(conn?.paired), libraries)).slice(0, 2);
  const selectionKey = JSON.stringify(selected.map(item => [item.route, item.visitedAt]));
  const [previews, setPreviews] = useState<Record<string, { src: string; version: string; hidden?: boolean }>>({});
  const previewsRef = useRef(previews); previewsRef.current = previews;
  const assets: AssetItem[] = selected.filter(item => !previews[item.route]?.hidden).map(item => {
    const route = parseAssetRoute(item.route);
    return { id: item.route, title: item.title, kind: item.kind, source: route.kind === "local" ? "local" : "desktop",
      src: route.kind === "desktop" && !connected ? "" : previews[item.route]?.src || "",
      meta: route.kind === "local" ? "本机" : connected ? "电脑" : "电脑暂未连接" };
  });
  const [inboxCount, setInboxCount] = useState(0);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [notes, stats] = await Promise.all([
          (async () => {
            const vaults = await managedVault.list();
            const selected = vaults.items.find(vault => vault.localVaultId === vaults.selectedVaultId && vault.migrationState === "ready");
            if (!selected) return api.localNoteList({ page: 1, limit: 1 });
            const page = await managedVault.notes({ localVaultId: selected.localVaultId, page: 1, limit: 1 });
            return { ...page, items: page.items.map(note => ({ ...note, noteId: managedNoteRoute(note.localVaultId, note.noteId) })) };
          })(),
          api.localInboxStats(),
        ]);
        if (!alive) return;
        const n = (notes.items || [])[0];
        const managed = n?.noteId.startsWith("vault:") ? n as unknown as ManagedNote : undefined;
        const managedState = managed?.bodyState === "missing" || managed?.syncState === "incomplete" ? "metadata"
          : managed?.bodyState === "conflict" ? "conflict" : managed?.syncState;
        setRecentNote(n ? {
          id: n.noteId,
          title: n.title || "无标题笔记",
          body: n.content || "",
          source: "local",
          meta: localMeta(n.updatedAt),
          state: managedState === "pending" || managedState === "synced" || managedState === "conflict" || managedState === "metadata" ? managedState : "local",
          notebook: n.noteId.startsWith("vault:") ? "笔记" : "本机笔记",
        } : undefined);
        setInboxCount(stats.total);
      } catch { /* keep last known */ }
    })();
    return () => { alive = false; };
  }, [version, managedVersion]);

  // Validate only the two displayed history entries, never scan/prefetch the
  // full history. Same-source refreshes retain decoded thumbnails; owner/grant
  // changes filter cards synchronously and retire all late async results.
  useEffect(() => {
    if (!current || !pageVisible) return;
    let alive = true;
    const ids = new Set(selected.map(item => item.route));
    setPreviews(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => ids.has(id))));
    const update = (route: string, value: { src: string; version: string; hidden?: boolean }) => {
      if (alive) setPreviews(previous => ({ ...previous, [route]: value }));
    };
    for (const item of selected) {
      const route = parseAssetRoute(item.route);
      if (route.kind === "unowned" || (route.kind === "desktop" && !connected)) continue;
      void (async () => {
        try {
          const detail = route.kind === "local" ? await api.localAssetGet(route.assetId)
            : await api.contentAssetDetail(route.owner, route.assetId, route.library);
          if (!alive || document.hidden) return;
          const revision = materialImageVersion(detail);
          const previous = previewsRef.current[item.route];
          if (previous?.src && previous.version === revision && !previous.hidden) return;
          update(item.route, { src: "", version: revision });
          if (detail.kind !== "image" && detail.kind !== "video") return;
          // Shared scheduler jobs cannot be cancelled by one consumer: another
          // visible card may share the promise. Already-admitted jobs finish;
          // only this consumer's result is retired on navigation/background.
          const thumb = route.kind === "local"
            ? await thumbnailScheduler.enqueue(localThumbKey(route.assetId, revision), () => api.localAssetThumbnail(route.assetId), "near")
            : await thumbnailScheduler.enqueue(desktopThumbKey(route.owner, route.assetId, revision, false, route.library), () => api.assetThumbnail(route.owner, route.assetId, false, false, revision, route.library), "near");
          if (thumb?.uri) update(item.route, { src: convertFileSrc(thumb.uri), version: revision });
        } catch (error) {
          // Do not promote another old history entry and probe the whole store
          // after a deletion. Only explicit rate/transport failures may retain
          // verified pixels; CONTENT_UNAVAILABLE is not a permission proof.
          const missing = /NOT_FOUND|NOT_EXIST|MISSING|(?:CONTENT_HTTP_|\bhttp\s+)404\b/i.test(String(error));
          if (missing || isContentReadDenied(error)) {
            update(item.route, { src: "", version: "", hidden: true });
          } else if ((!isContentReadTransportFailure(error) && rateLimitDelay(error) === null) || !previewsRef.current[item.route]?.src) {
            update(item.route, { src: "", version: "" });
          }
        }
      })();
    }
    return () => { alive = false; };
  }, [selectionKey, current, pageVisible, instance, connected, libraries, version, materialVersion]);

  return (
    <HomeView
      connected={connectionOf(conn) === "connected"}
      paired={Boolean(conn?.paired)}
      recent={recentNote}
      assets={assets}
      inboxCount={inboxCount}
      open={(page, id) => {
        // Every note entry carries a REAL note id (the recent note, a list
        // row, a search hit). The demo-id production alias is gone: an entry
        // without an id is a NEW-NOTE intent, never "whatever is most
        // recent" (UX-POLISH-R1 §1.4).
        if (page === "note") {
          if (id) open("note", id);
          else open("new-note");
          return;
        }
        if (page === "asset" && id) { open("asset", id); return; }
        if (page === "preferences" || page === "search" || page === "connect" || page === "inbox" || page === "new-note" || page === "capture") {
          open(page);
          return;
        }
        if (page === "library" || page === "settings" || page === "knowledge" || page === "ai" || page === "home") open(page);
      }}
    />
  );
}

