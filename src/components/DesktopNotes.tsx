// DesktopNotes (STITCH-R6) — the Desktop synced-vault note domain.
//
// Visual source: R6 desktop knowledge — vault row → search → status notice →
// content rows with a truthful status badge.
//
// Behaviour unchanged: vault selection, per-vault cursor pagination with
// scroll restoration, the create flow, and sync-driven refresh.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api, type ConnState } from "../services/client";
import { dataStore } from "../services/dataStore";
import { syncCoordinator } from "../services/syncCoordinator";
import { contentError } from "./DesktopLibrary";
import { IconNotes, IconPlus, IconRefresh } from "../components/icons";
import { EmptyState, Notice, Row, RowArt, SearchField } from "./ui";
import { failureCopy } from "../services/feedback";
import { noteStatus, noteStatusClass } from "../services/noteProvenance";
let visit: { selected: string; q: string; page: number; scroll: number } = { selected: "", q: "", page: 1, scroll: 0 };

export function desktopNoteRoute(instance: string, vault: string, id: string) {
  return `desktop:${encodeURIComponent(instance)}:${encodeURIComponent(vault)}:${id}`;
}

export default function DesktopNotes({ conn, open }: { conn: ConnState | null; open: (route: string) => void }) {
  const [vaults, setVaults] = useState<any[]>([]);
  const [selected, setSelected] = useState(visit.selected);
  const [items, setItems] = useState<any[]>([]);
  const [q, setQ] = useState(visit.q);
  const [page, setPage] = useState(visit.page);
  const previousQuery = useRef(`${visit.selected}:${visit.q}`);
  const restore = useRef(visit.scroll);
  const [more, setMore] = useState(false);
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const version = useSyncExternalStore(fn => dataStore.subscribe(fn), () => dataStore.getVersion());
  const sync = useSyncExternalStore(fn => syncCoordinator.subscribe(fn), () => syncCoordinator.snapshot());
  const key = (v: any) => `${v.instanceId}:${v.vaultId}`;
  const vault = vaults.find(v => key(v) === selected);
  useEffect(() => { visit = { ...visit, selected, q, page }; }, [selected, q, page]);

  useEffect(() => {
    let alive = true;
    api.contentVaults().then(rows => {
      if (!alive) return;
      setVaults(rows);
      setSelected(old => rows.some(v => key(v) === old) ? old : rows.length ? key(rows.find(v => v.instanceId === conn?.identity?.instanceId) || rows[0]) : "");
    }).catch(e => { if (alive) setError(contentError(e)); });
    return () => { alive = false; };
  }, [version, conn?.identity?.instanceId]);
  useEffect(() => { syncCoordinator.trigger(); }, []);
  useEffect(() => {
    const gen = ++generation.current;
    if (!vault) { setItems([]); return; }
    setLoading(true);
    const sameQuery = previousQuery.current === `${selected}:${q}`;
    const pages = sameQuery ? page : 1;
    previousQuery.current = `${selected}:${q}`;
    if (!sameQuery) setPage(1);
    const timer = setTimeout(() => { void (async () => {
      const rows: any[] = []; let hasMore = false;
      for (let n = 1; n <= pages; n++) {
        const value = await api.contentNotes(vault.instanceId, vault.vaultId, q, n);
        if (gen !== generation.current) return;
        rows.push(...value.items); hasMore = value.hasMore;
        if (!hasMore) break;
      }
      if (gen !== generation.current) return;
      setItems(rows); setMore(hasMore); setError("");
      if (restore.current) { const scroll = restore.current; restore.current = 0; requestAnimationFrame(() => { const area = document.querySelector(".screen-area"); if (area) area.scrollTop = scroll; }); }
    })().catch(e => { if (gen === generation.current) setError(contentError(e)); })
      .finally(() => { if (gen === generation.current) setLoading(false); });
    }, q ? 300 : 0);
    return () => { clearTimeout(timer); generation.current++; };
  }, [selected, q, version, vault?.vaultId]);

  async function loadMore() {
    if (!vault || loading) return;
    const gen = generation.current;
    setLoading(true);
    try {
      const value = await api.contentNotes(vault.instanceId, vault.vaultId, q, page + 1);
      if (gen === generation.current) { setItems(old => [...old, ...value.items]); setMore(value.hasMore); setPage(n => n + 1); }
    } catch (e) { if (gen === generation.current) setError(contentError(e)); }
    finally { if (gen === generation.current) setLoading(false); }
  }
  async function create() {
    if (!vault || !title.trim()) return;
    try {
      const id = await api.contentNoteCreate(vault.instanceId, vault.vaultId, title.trim());
      setCreating(false); setTitle(""); dataStore.bump(); syncCoordinator.trigger();
      open(desktopNoteRoute(vault.instanceId, vault.vaultId, id));
    } catch (e) { setError(contentError(e)); }
  }

  const statusText =
    sync.status === "syncing"
      ? "正在同步…"
      : conn?.ws.state === "connected"
        ? "已连接电脑"
        : "离线可编辑已缓存笔记，恢复连接后同步";

  return (
    <section aria-label="电脑知识库">
      <div className="tool-row">
        {vaults.length > 1 ? (
          <select
            className="text-field"
            aria-label="电脑知识库选择"
            value={selected}
            onChange={e => setSelected(e.target.value)}
            style={{ flex: 1 }}
          >
            {vaults.map(v => (
              <option key={key(v)} value={key(v)}>
                {v.name}{v.instanceId !== conn?.identity?.instanceId ? " · 已保存的草稿与缓存" : ""}
              </option>
            ))}
          </select>
        ) : (
          <span className="field-label" style={{ flex: 1, margin: 0 }}>{vault?.name || "等待电脑知识库"}</span>
        )}
        <button className="filter-btn" disabled={!vault} onClick={() => setCreating(v => !v)} aria-label="新建电脑笔记">
          <IconPlus size={18} />
        </button>
        <button className="filter-btn" aria-label="刷新" onClick={() => syncCoordinator.trigger()}>
          <IconRefresh size={18} />
        </button>
      </div>

      {creating ? (
        <div style={{ marginTop: 10 }}>
          <input
            className="text-field"
            aria-label="新笔记标题"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="笔记标题"
          />
          <div className="btn-row">
            <button className="primary" disabled={!title.trim()} onClick={create}>创建</button>
            <button className="quiet" onClick={() => setCreating(false)}>取消</button>
          </div>
        </div>
      ) : null}

      <div className="tool-row">
        <SearchField value={q} onChange={setQ} placeholder="搜索标题、目录和正文…" />
      </div>

      <Notice tone={sync.status === "syncing" ? "warn" : "neutral"}>{statusText}</Notice>

      {q && conn?.ws.state !== "connected" ? (
        <p className="list-foot" style={{ textAlign: "left" }}>离线时仅搜索已缓存的标题、目录与正文。</p>
      ) : null}
      {(error || (!vaults.length && sync.error)) ? (
        <Notice tone="warn">{failureCopy(error || sync.error, contentError(sync.error))}</Notice>
      ) : null}

      {items.length ? (
        <div className="list">
          {items.map(note => {
            // ONE status authority for list and detail (see noteProvenance):
            // an only-metadata note must not read 已同步 here while the detail
            // header says 仅同步元数据.
            const status = noteStatus(note);
            return (
              <Row
                key={note.noteId}
                onClick={() => {
                  visit.scroll = document.querySelector(".screen-area")?.scrollTop || 0;
                  open(desktopNoteRoute(note.instanceId, note.vaultId, note.noteId));
                }}
                leading={<RowArt><IconNotes size={17} /></RowArt>}
                title={note.title || "未命名笔记"}
                meta={note.relativePath || "待创建"}
                state={
                  // Tone comes from noteStatusClass; neutral states render
                  // muted so informational notes never look like warnings.
                  <span className={`row-state ${noteStatusClass(status) || "muted"}`}>{status.label}</span>
                }
              />
            );
          })}
        </div>
      ) : null}

      {loading ? <p className="list-foot">加载中…</p> : null}
      {more ? (
        <button className="quiet btn-block load-more" disabled={loading} onClick={loadMore}>
          加载更多笔记
        </button>
      ) : null}
      {!loading && vault && !items.length ? (
        <EmptyState icon={<IconNotes size={20} />} title="这里还没有匹配的笔记" body="在电脑上新建笔记，或换个关键词。" />
      ) : null}
    </section>
  );
}
