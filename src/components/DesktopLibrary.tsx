// DesktopLibrary (STITCH-R6) — the Desktop cached asset domain.
//
// Visual source: R6 desktop library — search tool row → kind chips → media
// grid (grid/list preference) with truthful cached/offline indication.
//
// Behaviour is unchanged: real server-side pagination, debounced query,
// folder/tag/kind filters read from content_navigation, cached-offline
// indication, and the visit-scroll restoration.
import { useEffect, useRef, useState } from "react";
import { desktopAssetRoute } from "../still/kit/materialOrganization";
import { api } from "../services/client";
import Thumb from "./asset/Thumb";
import { IconFile, IconImage, IconVideo } from "../components/icons";
import { EmptyState, OptionRow, Sheet } from "./ui";
import { failureCopy } from "../services/feedback";
const visits = new Map<string, any>();

export function contentError(error: unknown): string {
  const value = String(error);
  if (/UPGRADE|404/.test(value)) return "电脑版本尚不支持这项内容，请更新电脑端。";
  if (/DISCONNECTED/.test(value)) return "已断开电脑连接，可在连接设置中重新连接。";
  if (/SOURCE_CHANGED|CANCELLED/.test(value)) return "连接已改变，请重新打开。";
  if (/401|REVOKED|PAIRING_REQUIRED/.test(value)) return "电脑授权已失效，请检查连接设置。";
  if (/RESOURCE_UNAVAILABLE|PREVIEW_UNAVAILABLE/.test(value)) return "文件暂时不可用，请在电脑上检查原文件。";
  return "暂时无法读取电脑内容，请检查电脑与网络后重试。";
}

const KINDS = [
  { key: "", label: "全部" },
  { key: "image", label: "图片" },
  { key: "video", label: "视频" },
  { key: "document", label: "文档" },
  { key: "audio", label: "音频" },
  { key: "other", label: "其他" },
];

type PickerKind = "folder" | "tag" | null;

export default function DesktopLibrary({ instance, name, open, query, reloadSignal = 0 }: { instance: string; name: string; open: (id: string) => void; query: string; reloadSignal?: number }) {
  const [picker, setPicker] = useState<PickerKind>(null);
  const previous = useRef(visits.get(instance));
  const first = useRef(true);
  const [items, setItems] = useState<any[]>(previous.current?.items || []);
  const q = query;
  const [kind, setKind] = useState(previous.current?.kind || "");
  const [folder, setFolder] = useState(previous.current?.folder || "");
  const [tag, setTag] = useState(previous.current?.tag || "");
  const [navigation, setNavigation] = useState<{ folders: any[]; tags: any[] }>({ folders: [], tags: [] });
  const [hasMore, setHasMore] = useState(previous.current?.hasMore || false);
  const [page, setPage] = useState(previous.current?.page || 1);
  const [cached, setCached] = useState(previous.current?.cached || false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const flight = useRef(false);
  useEffect(() => {
    visits.set(instance, { items, q, kind, folder, tag, page, hasMore, cached, scroll: visits.get(instance)?.scroll || 0 });
  }, [instance, items, q, kind, folder, tag, page, hasMore, cached]);

  useEffect(() => {
    let alive = true;
    api.contentNavigation(instance).then(value => { if (alive) setNavigation(value); }).catch(() => {});
    return () => { alive = false; };
  }, [instance, reload]);

  // INTERACTION-CLOSURE-R1: host header refresh button bumps reloadSignal.
  useEffect(() => {
    if (reloadSignal > 0) setReload((n) => n + 1);
  }, [reloadSignal]);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      if (previous.current?.items.length) {
        requestAnimationFrame(() => { const area = document.querySelector(".screen-area"); if (area) area.scrollTop = previous.current.scroll || 0; });
        return;
      }
    }
    const gen = ++generation.current;
    flight.current = true;
    setItems([]); setHasMore(false); setBusy(true); setError("");
    const timer = setTimeout(() => {
      api.contentAssets(instance, { page: 1, limit: 50, q, kind, folder, tag }).then(value => {
        if (generation.current !== gen) return;
        setItems(value.items); setHasMore(value.hasMore); setPage(1); setCached(!!value.cached);
      }).catch(e => { if (generation.current === gen) setError(contentError(e)); })
        .finally(() => { if (generation.current === gen) { setBusy(false); flight.current = false; } });
    }, 220);
    return () => { clearTimeout(timer); generation.current++; };
  }, [instance, q, kind, folder, tag, reload]);

  async function more() {
    if (flight.current || !hasMore) return;
    const gen = generation.current;
    flight.current = true; setBusy(true); setError("");
    try {
      const value = await api.contentAssets(instance, { page: page + 1, limit: 50, q, kind, folder, tag });
      if (gen !== generation.current) return;
      setItems(old => Array.from(new Map([...old, ...value.items].map(a => [a.desktopAssetId, a])).values()));
      setPage(value.page); setHasMore(value.hasMore); setCached(!!value.cached);
    } catch (e) { if (gen === generation.current) setError(contentError(e)); }
    finally { if (gen === generation.current) { flight.current = false; setBusy(false); } }
  }

  const folders: { id: string; label: string }[] = [];
  function flatten(rows: any[], prefix = "") {
    for (const row of rows) { folders.push({ id: row.id, label: prefix + row.name }); flatten(row.children || [], prefix + row.name + " / "); }
  }
  flatten(navigation.folders);
  const folderLabel = folders.find((f) => f.id === folder)?.label;
  const tagLabel = navigation.tags.find((t: any) => t.id === tag)?.name;

  return (
    <section aria-label="电脑素材库">
      {/* Single Search Owner (REAL-DEVICE-UI-POLISH-R1): the Library root owns
          the ONE search field; this domain only consumes `query`. Directory /
          tag pickers are LuckyRay Sheets; kind chips stay inline. */}
      {/* INTERACTION-CLOSURE-R1: 目录/标签 as compact triggers INSIDE the same
          tool row as the kind chips; refresh moved up next to the header `+`
          (host passes onRefresh); one contiguous tool area, no stacked rows. */}
      <div className="chip-scroll desktop-tools" aria-label="电脑素材筛选">
        <button
          className={"chip" + (folder ? " active" : "")}
          onClick={() => setPicker("folder")}
          aria-label="选择目录"
          aria-expanded={picker === "folder"}
        >
          {folderLabel || "目录"}
        </button>
        <button
          className={"chip" + (tag ? " active" : "")}
          onClick={() => setPicker("tag")}
          aria-label="选择标签"
          aria-expanded={picker === "tag"}
        >
          {tagLabel || "标签"}
        </button>
        {KINDS.map((k) => (
          <button
            key={k.key}
            className={"chip" + (kind === k.key ? " active" : "")}
            aria-pressed={kind === k.key}
            onClick={() => setKind(k.key)}
          >
            {k.label}
          </button>
        ))}
      </div>

      {picker === "folder" ? (
        <Sheet open title="选择目录" onClose={() => setPicker(null)}>
          <OptionRow label="全部目录" active={!folder} onClick={() => { setFolder(""); setPicker(null); }} />
          {folders.map((row) => (
            <OptionRow key={row.id} label={row.label} active={folder === row.id} onClick={() => { setFolder(row.id); setPicker(null); }} />
          ))}
        </Sheet>
      ) : null}
      {picker === "tag" ? (
        <Sheet open title="选择标签" onClose={() => setPicker(null)}>
          <OptionRow label="全部标签" active={!tag} onClick={() => { setTag(""); setPicker(null); }} />
          {navigation.tags.map((row: any) => (
            <OptionRow key={row.id} label={row.name} active={tag === row.id} onClick={() => { setTag(row.id); setPicker(null); }} />
          ))}
        </Sheet>
      ) : null}

      {(folderLabel || tagLabel || kind) ? (
        <div className="chip-scroll">
          {kind ? <button className="chip active" onClick={() => setKind("")}>{KINDS.find(k => k.key === kind)?.label} ✕</button> : null}
          {folderLabel ? <button className="chip active" onClick={() => setFolder("")}>{folderLabel} ✕</button> : null}
          {tagLabel ? <button className="chip active" onClick={() => setTag("")}>{tagLabel} ✕</button> : null}
        </div>
      ) : null}

      <p className="list-foot" style={{ textAlign: "left", paddingTop: 8 }}>
        {name} · 已加载 {items.length} 项{cached ? " · 离线缓存，内容可能已变化" : ""}
      </p>

      {error ? <InlineError message={error} /> : null}
      {!items.length && !busy && !error ? (
        <EmptyState icon={<IconFile size={20} />} title="没有符合条件的电脑素材" body="试试清除筛选或换个关键词。" />
      ) : null}

      <div className="media-grid" style={{ marginTop: 10 }}>
        {items.map(a => (
          <button
            key={a.desktopAssetId}
            className="tile"
            onClick={() => {
              visits.set(instance, { ...visits.get(instance), scroll: document.querySelector(".screen-area")?.scrollTop || 0 });
              // Carry the owner this library is bound to; a bare asset id
              // would leave the detail page unable to prove its Desktop.
              open(desktopAssetRoute(instance, a.desktopAssetId));
            }}
          >
            <span className={`thumb ${artTone(a.kind)}`}>
              <Thumb instance={instance} id={a.desktopAssetId} />
              {a.kind === "video" ? <IconVideo size={18} /> : a.kind === "document" ? <IconFile size={18} /> : <IconImage size={18} />}
            </span>
            <span className="tile-caption">
              <span className="tile-name">{a.name}</span>
              <span className="tile-meta">电脑 · {a.kind} · {Math.ceil((a.sizeBytes || 0) / 1024)} KB</span>
            </span>
          </button>
        ))}
      </div>

      {busy ? <p className="list-foot">加载中…</p> : null}
      {hasMore ? (
        <button className="quiet btn-block load-more" disabled={busy} onClick={more}>
          加载更多电脑素材
        </button>
      ) : items.length > 0 ? (
        <p className="list-foot">已到底</p>
      ) : null}
    </section>
  );
}

function artTone(kind: string): string {
  switch (kind) {
    case "image":
      return "a";
    case "video":
      return "b";
    case "document":
      return "c";
    default:
      return "d";
  }
}

function InlineError({ message }: { message: string }) {
  return <p role="status" className="list-foot" style={{ textAlign: "left", color: "var(--pending)" }}>{failureCopy(message, message)}</p>;
}
