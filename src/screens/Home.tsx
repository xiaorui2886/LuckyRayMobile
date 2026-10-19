// Home.tsx (STITCH-R6) — the approved Home masthead hierarchy:
//   LuckyRay → Search → connection truth → Recent content
// plus the global Capture action rendered by the shell.
//
// Visual source: LuckyRay-Mobile-Visual-Rebuild-R6.html `function home()`.
// Behaviour source: production. Local-first data (Mobile-owned recent content +
// counts) is unchanged; the connection line stays truthful (paired != online).
import { useEffect, useRef, useSyncExternalStore, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { localDataStore } from "../services/localDataStore";
import { api, type ConnState } from "../services/client";
import {
  IconChevronRight,
  IconControls,
  IconFile,
  IconImage,
  IconLink,
  IconNotes,
  IconText,
} from "../components/icons";
import { EmptyState, Masthead, Row, RowArt, SearchField, SectionTitle } from "../components/ui";
import type { Tab } from "../App";
import {
  homeAssetRoute,
  homeDesktopOnline,
  homeInboxRoute,
  homeLocalStats,
  homeNoteRoute,
  mergeRecent,
  type RecentEntry,
} from "../services/homeLocalModel";

type Props = { conn: ConnState | null; go: (tab: Tab, detail?: string) => void };

export default function Home({ conn, go }: Props) {
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  const [inboxStats, setInboxStats] = useState<{ total: number } | null>(null);
  const [noteStats, setNoteStats] = useState<{ total: number } | null>(null);
  const [assetStats, setAssetStats] = useState<{ total: number } | null>(null);
  const [ready, setReady] = useState(false);
  const [query, setQuery] = useState("");

  const localVersion = useSyncExternalStore(
    (fn) => localDataStore.subscribe(fn),
    () => localDataStore.getVersion()
  );

  // FIX-V1B P2: latest-request-wins — successive local mutations can start
  // overlapping reads; a late OLDER refresh must never overwrite the newest
  // recent/count snapshot (both blocks guard on the same epoch).
  const loadGenRef = useRef(0);

  useEffect(() => {
    const gen = ++loadGenRef.current;
    (async () => {
      try {
        const [assets, notes, inbox] = await Promise.all([
          api.localAssetList({ page: 1, limit: 4 }),
          api.localNoteList({ page: 1, limit: 4 }),
          api.localInboxList({ page: 1, limit: 4 }),
        ]);
        if (gen !== loadGenRef.current) return; // stale refresh: latest wins
        setRecent(
          mergeRecent({ assets: assets.items || [], notes: notes.items || [], inbox: inbox.items || [] })
        );
        setReady(true);
      } catch {
        /* keep last known values */
      }
      try {
        const [is, ns, as] = await Promise.all([
          api.localInboxStats(),
          api.localNoteStats(),
          api.localAssetStats(),
        ]);
        if (gen !== loadGenRef.current) return; // stale refresh: latest wins
        setInboxStats(is);
        setNoteStats(ns);
        setAssetStats(as);
      } catch {
        /* not ready */
      }
    })();
  }, [localVersion]);

  // Phone-owned counts are the authority — never sourced from Desktop stats.
  const stats = homeLocalStats(inboxStats, noteStats, assetStats);
  const online = homeDesktopOnline(conn?.ws?.state ?? "");
  const connected = Boolean(conn?.paired) && online;

  function open(entry: RecentEntry) {
    if (entry.domain === "asset") go("library", homeAssetRoute(entry.id));
    else if (entry.domain === "note") go("knowledge", homeNoteRoute(entry.id));
    else go("capture", homeInboxRoute(entry.id));
  }

  return (
    <>
      {/* Masthead: brand + settings/controls action. No root-screen hero
          heading, and never a profile or sun icon (DESIGN.md §8). */}
      <Masthead
        title="LuckyRay"
        action={
          <button className="nav-action" aria-label="设置" onClick={() => go("settings")}>
            <IconControls size={18} />
          </button>
        }
      />

      <SearchField
        className="home-search"
        value={query}
        onChange={setQuery}
        placeholder="搜索本机笔记、收集箱、素材"
        onSubmit={() => go("search")}
      />

      {/* Connection truth sits BELOW Search (DESIGN.md §3) and never claims
          "connected" from pairing metadata alone. */}
      <div className="home-connection">
        <span className={"dot" + (connected ? "" : " idle")} />
        <span>
          {connected ? "电脑已连接 · 本机内容可用" : conn?.paired ? "已配对 · 未实时连接 · 本机内容可用" : "仅本机 · 未连接电脑"}
        </span>
        {!connected ? (
          <>
            {" · "}
            <button
              className="section-action accent"
              style={{ fontSize: 10.5, color: "var(--accent)", minHeight: 22 }}
              onClick={() => go("settings", "connect-computer")}
            >
              连接
            </button>
          </>
        ) : null}
      </div>

      <SectionTitle title="最近" meta={recent.length ? "全部本机内容" : undefined} />

      {recent.length === 0 ? (
        <EmptyState
          icon={ready ? <IconNotes size={20} /> : <IconText size={20} />}
          title={ready ? "还没有内容" : "正在读取本机内容…"}
          body={ready ? "用右下角的收集按钮记下第一条想法，或从素材库导入文件。" : undefined}
          action={
            ready ? (
              <button className="primary" onClick={() => go("capture")}>
                开始收集
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="list">
          {recent.map((entry) => (
            <RecentRow key={`${entry.domain}:${entry.id}`} entry={entry} onOpen={() => open(entry)} />
          ))}
        </div>
      )}

      <SectionTitle
        title="稍后整理"
        action={
          <button className="section-action" onClick={() => go("capture")}>
            收集箱 {stats.inbox}
            <IconChevronRight size={14} />
          </button>
        }
      />
    </>
  );
}

/** One unified recent row. Normal rows carry no badge; the source is stated in
 *  the meta line (本机 vs 收集箱) so provenance stays unambiguous without a
 *  badge wall (DESIGN.md §10). */
function RecentRow({ entry, onOpen }: { entry: RecentEntry; onOpen: () => void }) {
  const isMedia = entry.kind === "image" || entry.kind === "video";
  return (
    <Row
      onClick={onOpen}
      leading={
        isMedia && entry.domain === "asset" ? (
          <ArtThumb entry={entry} />
        ) : (
          <RowArt>{kindGlyph(entry)}</RowArt>
        )
      }
      title={entry.title}
      meta={entry.subtitle}
    />
  );
}

function kindGlyph(entry: RecentEntry) {
  if (entry.domain === "note") return <IconNotes size={18} />;
  if (entry.domain === "asset") return <IconFile size={18} />;
  switch (entry.kind) {
    case "link":
      return <IconLink size={18} />;
    case "image":
    case "photo":
      return <IconImage size={18} />;
    case "file":
      return <IconFile size={18} />;
    default:
      return <IconText size={18} />;
  }
}

function ArtThumb({ entry }: { entry: RecentEntry }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let alive = true;
    if (entry.domain !== "asset") return;
    api
      .localAssetThumbnail(entry.id)
      .then((t) => {
        if (alive && t?.uri) setSrc(convertFileSrc(t.uri));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [entry.domain, entry.id]);
  if (!src) return <RowArt media />;
  return (
    <RowArt media>
      <img src={src} alt="" />
    </RowArt>
  );
}
