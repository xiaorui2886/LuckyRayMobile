// STILL-01.1 — Home (production data, Still authority tree).
// Hierarchy: wordmark -> settings -> search launcher -> connection ->
// 继续阅读 -> 最近收集的画面 -> 手边 -> (dock/+ rendered by the shell).
import { useEffect, useState, useSyncExternalStore } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { HomeView, type NoteItem, type AssetItem } from "../presentation/still01/Views";
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
  const [recentNote, setRecentNote] = useState<NoteItem | undefined>(undefined);
  const [assets, setAssets] = useState<AssetItem[]>([]);
  const [inboxCount, setInboxCount] = useState(0);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [notes, assetsPage, stats] = await Promise.all([
          api.localNoteList({ page: 1, limit: 1 }),
          api.localAssetList({ kind: "image", page: 1, limit: 2 }),
          api.localInboxStats(),
        ]);
        if (!alive) return;
        const n = (notes.items || [])[0];
        setRecentNote(n ? {
          id: n.noteId,
          title: n.title || "无标题笔记",
          body: n.content || "",
          source: "local",
          meta: localMeta(n.updatedAt),
          state: "local",
          notebook: "本机笔记",
        } : undefined);
        setInboxCount(stats.total);
        const imgs = (assetsPage.items || []).filter((a: any) => a.kind === "image").slice(0, 2);
        setAssets(imgs.map((a: any) => ({
          id: a.assetId,
          title: a.name,
          src: `local-thumb:${a.assetId}`,
          kind: "image" as const,
          source: "local" as const,
          meta: "图片 · 本机",
        })));
      } catch { /* keep last known */ }
    })();
    return () => { alive = false; };
  }, [version]);

  // Resolve real thumbnails for the 2-up media.
  useEffect(() => {
    let alive = true;
    for (const a of assets) {
      if (!a.src.startsWith("local-thumb:")) continue;
      const id = a.src.slice("local-thumb:".length);
      api.localAssetThumbnail(id).then((t) => {
        if (alive && t?.uri) {
          const uri = convertFileSrc(t.uri);
          setAssets((prev) => prev.map((x) => (x.id === id ? { ...x, src: uri } : x)));
        }
      }).catch(() => {});
    }
    return () => { alive = false; };
  }, [assets]);

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
        if (page === "asset" && id) { open("asset", "local:" + id); return; }
        if (page === "preferences" || page === "search" || page === "connect" || page === "inbox" || page === "new-note" || page === "capture") {
          open(page);
          return;
        }
        if (page === "library" || page === "settings" || page === "knowledge" || page === "ai" || page === "home") open(page);
      }}
    />
  );
}

