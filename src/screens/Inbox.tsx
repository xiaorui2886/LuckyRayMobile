// Local Inbox (STITCH-R6) — the phone's own durable capture collection.
// Works with zero Desktop connection: text / link / image / photo / file.
//
// Visual source: R6 `function inbox()` — kind chip row → content rows
// (art well + title + meta) → load-more foot. Management actions
// (收纳/生成笔记/收藏/归档/删除) stay in a per-row "更多" sheet so the list
// reads as content rather than a wall of icon buttons, while every action
// stays one tap away.
//
// Behaviour source: production, unchanged (kind filter, controlled search,
// generation-safe pagination, localDataStore publishes).
import { useEffect, useRef, useState } from "react";
import { api } from "../services/client";
import {
  IconFile,
  IconImage,
  IconLink,
  IconMore,
  IconText,
} from "../components/icons";
import { localDataStore } from "../services/localDataStore";
import {
  commitPagedNextPage,
  commitPagedPageOne,
  initialPaged,
  pagedLoading,
  pagedStart,
  resetPaged,
  type PagedState,
} from "../services/generationPagination";
import { EmptyState, OptionRow, Row, RowArt, Sheet } from "../components/ui";
import { failureCopy } from "../services/feedback";
import { toast } from "../services/toast";

type Props = {
  go: (tab: "capture", detail: string) => void;
  onChanged?: () => void;
  tick?: number;
  refreshKey?: number;
  /** Search text controlled by the owning screen (Capture) so the field can
   *  live in the page header area instead of inside the list card. */
  search?: string;
  onOpenNote?: (noteId: string) => void;
  onOpenAsset?: (assetId: string) => void;
};

const INBOX_PAGE_SIZE = 50;

const KINDS = [
  { key: "", label: "全部" },
  { key: "text", label: "文本" },
  { key: "link", label: "链接" },
  { key: "image", label: "图片" },
  { key: "photo", label: "拍照" },
  { key: "file", label: "文件" },
];

export default function Inbox({ go, onChanged, tick, refreshKey, search = "", onOpenNote, onOpenAsset }: Props) {
  const [page, setPage] = useState<PagedState<any>>(initialPaged);
  const queryGenRef = useRef(0);
  const [kind, setKind] = useState("");
  const [msg, setMsg] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  // The item whose action sheet is open (null = closed).
  const [actionItem, setActionItem] = useState<any | null>(null);

  const reload = () => setReloadKey((k) => k + 1);

  const localVersion = useLocalDataVersion();

  useEffect(() => {
    const gen = ++queryGenRef.current;
    setPage((prev) => pagedLoading(resetPaged(prev)));
    api
      .localInboxList({ kind: kind || undefined, q: search || undefined, page: 1, limit: INBOX_PAGE_SIZE })
      .then((r) => {
        if (gen !== queryGenRef.current) return;
        setPage((prev) => commitPagedPageOne(prev, gen, r.items || [], r.total, r.hasMore, (x) => x.itemId));
      })
      .catch((e: any) => {
        if (gen !== queryGenRef.current) return;
        setPage((prev) => ({ ...resetPaged(prev), generation: prev.generation }));
        setMsg(failureCopy(e, "读取收集箱失败。"));
      });
  }, [kind, search, reloadKey, tick, refreshKey, localVersion]);

  async function loadMore() {
    setPage((prev) => (prev.loading || !prev.hasMore ? prev : { ...prev, loading: true }));
    const gen = queryGenRef.current;
    const pageNum = pagedStart(page);
    try {
      const r = await api.localInboxList({ kind: kind || undefined, q: search || undefined, page: pageNum, limit: INBOX_PAGE_SIZE });
      if (gen !== queryGenRef.current) return;
      setPage((prev) => commitPagedNextPage(prev, gen, pageNum, r.items || [], r.total, r.hasMore, (x) => x.itemId));
    } catch (e: any) {
      if (gen !== queryGenRef.current) return;
      setPage((prev) => (prev.generation !== gen ? prev : { ...prev, loading: false }));
      setMsg(failureCopy(e, "加载更多失败。"));
    }
  }

  const items = page.items;

  function after(action: string) {
    toast.success(action);
    reload();
    onChanged?.();
  }

  async function convertToNote(item: any) {
    try {
      const note = await api.localNoteConvertInbox(item.itemId);
      localDataStore.publish("note");
      setActionItem(null);
      after(`已生成笔记「${note.title || "未命名"}」`);
      if (onOpenNote) onOpenNote(note.noteId);
    } catch (e: any) {
      toast.error(failureCopy(e, "生成笔记失败。"));
    }
  }

  async function promoteToAsset(item: any) {
    try {
      const asset = await api.localAssetPromoteInbox(item.itemId);
      localDataStore.publish("asset");
      setActionItem(null);
      after(`已收纳到素材库`);
      if (onOpenAsset) onOpenAsset(asset.assetId);
    } catch (e: any) {
      toast.error(failureCopy(e, "收纳失败。"));
    }
  }

  async function toggleFavorite(item: any) {
    try {
      await api.localInboxSetFavorite(item.itemId, !item.favorite);
      setActionItem({ ...item, favorite: !item.favorite });
      localDataStore.publish("inbox");
      reload();
      onChanged?.();
    } catch (e: any) {
      toast.error(failureCopy(e, "操作失败。"));
    }
  }

  async function toggleArchive(item: any) {
    try {
      await api.localInboxSetArchived(item.itemId, !item.archived);
      setActionItem(null);
      localDataStore.publish("inbox");
      after(item.archived ? "已取消归档" : "已归档");
    } catch (e: any) {
      toast.error(failureCopy(e, "操作失败。"));
    }
  }

  async function remove(item: any) {
    setActionItem(null);
    if (!window.confirm(`删除「${displayTitle(item)}」？仅删除这一条本地收集内容。`)) return;
    try {
      await api.localInboxDelete(item.itemId);
      localDataStore.publish("inbox");
      after("已删除");
    } catch (e: any) {
      toast.error(failureCopy(e, "删除失败。"));
    }
  }

  const hasAttachment = (k: string) => k === "image" || k === "photo" || k === "file";

  return (
    <>
      {/* Kind scope stays reachable but compact — it refines the list below. */}
      <div className="chip-scroll">
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

      {items.length === 0 && !page.loading ? (
        <EmptyState
          icon={<IconText size={20} />}
          title={search || kind ? "没有匹配的内容" : "收集箱是空的"}
          body={
            search || kind
              ? "试试别的关键词或类型。"
              : "用上面的输入框或媒体按钮，把内容先存进手机。"
          }
        />
      ) : (
        <div className="list">
          {items.map((item) => (
            <Row
              key={item.itemId}
              onClick={() => go("capture", item.itemId)}
              leading={<RowArt>{kindIcon(item.kind)}</RowArt>}
              title={displayTitle(item)}
              meta={[
                kindLabel(item.kind),
                item.attachment ? fmt(item.attachment.sizeBytes) : "",
                item.createdAt?.replace("T", " ").slice(0, 16) || "",
              ]
                .filter(Boolean)
                .join(" · ")}
              state={
                <>
                  {item.favorite ? <span className="row-state">★</span> : null}
                  {item.archived ? <span className="row-state muted">已归档</span> : null}
                </>
              }
              trailing={
                <button
                  className="icon-mini"
                  aria-label="更多操作"
                  onClick={(e) => {
                    e.stopPropagation();
                    setActionItem(item);
                  }}
                >
                  <IconMore size={16} />
                </button>
              }
            />
          ))}
        </div>
      )}

      {msg ? <p className="list-foot">{msg}</p> : null}

      {page.hasMore ? (
        <button className="quiet btn-block load-more" disabled={page.loading} onClick={loadMore}>
          {page.loading ? "加载中…" : "加载更多"}
        </button>
      ) : items.length > 0 ? (
        <p className="list-foot">已显示 {items.length} / {page.total} 条</p>
      ) : null}

      {/* Per-item actions. Keeps every capability reachable without turning the
          list into a field of icon buttons. */}
      <Sheet
        open={Boolean(actionItem)}
        onClose={() => setActionItem(null)}
        title={actionItem ? displayTitle(actionItem) : ""}
      >
        {actionItem ? (
          <>
            {hasAttachment(actionItem.kind) ? (
              <OptionRow label="收纳到本机素材库" hint="保留文件副本" onClick={() => promoteToAsset(actionItem)} />
            ) : null}
            <OptionRow label="生成笔记" hint="以这条内容新建笔记" onClick={() => convertToNote(actionItem)} />
            <OptionRow
              label={actionItem.favorite ? "取消收藏" : "收藏"}
              onClick={() => toggleFavorite(actionItem)}
            />
            <OptionRow
              label={actionItem.archived ? "取消归档" : "归档"}
              onClick={() => toggleArchive(actionItem)}
            />
            <OptionRow label="删除" hint="不可撤销" onClick={() => remove(actionItem)} />
          </>
        ) : null}
      </Sheet>
    </>
  );
}

export function kindIcon(kind: string) {
  switch (kind) {
    case "link":
      return <IconLink />;
    case "image":
    case "photo":
      return <IconImage />;
    case "file":
      return <IconFile />;
    default:
      return <IconText />;
  }
}

export function kindLabel(kind: string) {
  switch (kind) {
    case "link":
      return "链接";
    case "image":
      return "图片";
    case "photo":
      return "拍照";
    case "file":
      return "文件";
    default:
      return "文本";
  }
}

export function displayTitle(item: any) {
  if (item.title) return item.title;
  if (item.kind === "link") return item.url || "链接";
  if (item.kind === "text") return item.text || "文本";
  return item.attachment?.fileName || "附件";
}

function fmt(n: number) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

function useLocalDataVersion(): number {
  const [version, setVersion] = useState(() => localDataStore.getVersion());
  useEffect(() => {
    return localDataStore.subscribe(() => setVersion(localDataStore.getVersion()));
  }, []);
  return version;
}
