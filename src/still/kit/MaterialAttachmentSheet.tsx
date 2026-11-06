import "./materialAttachmentSheet.css";
import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api, type ConnState } from "../../services/client";
import { desktopThumbKey, localThumbKey, materialImageVersion, thumbnailScheduler } from "../../services/thumbnailQueue";
import { useDesktopLibraries } from "./DesktopLibraryPicker";
import { Sheet, SourceSwitch, SearchField, Row, Button } from "./StillImports";

export type AttachmentSource = { kind: "local"; assetId: string; version: string }
  | { kind: "desktop"; instance: string; library?: string; assetId: string; version: string };
export type AttachmentTarget = { kind: "managed"; localVaultId: string; noteId: string; expectedRevision: string; from: number; to: number }
  | { kind: "desktop"; instance: string; vault: string; noteId: string; expectedContent: string };
type Folder = { id: string; label: string };

/** A bounded picker over the same scoped list, folder and thumbnail authorities
 * as the material library. Selecting a row passes identities only. */
export function MaterialAttachmentSheet({ conn, busy, message, onSelect, onClose, registerOverlay }: {
  conn: ConnState | null; busy: boolean; message: string; onSelect: (source: AttachmentSource) => void;
  onClose: () => void; registerOverlay: (close: () => void) => () => void;
}) {
  const [choice, setChoice] = useState<"library" | "folder" | null>(null);
  const [domain, setDomain] = useState<"local" | "desktop">("local");
  const [query, setQuery] = useState("");
  const [libraryChoice, setLibraryChoice] = useState<string | null>(null);
  const [folder, setFolder] = useState("");
  const [folders, setFolders] = useState<Folder[]>([]);
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<any[]>([]);
  const [rowsScope, setRowsScope] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  const owner = conn?.identity?.instanceId || "";
  const online = Boolean(owner && conn?.paired && conn.ws?.state === "connected");
  const libraries = useDesktopLibraries(owner, online, true);
  const library = libraries.catalog?.scopeSelectionVersion === 1 ? (libraryChoice ?? libraries.material) : "";
  const selected = libraries.catalog?.materials.find(row => row.libraryId === library);
  const readable = online && (libraries.phase === "legacy" || (libraries.phase === "ready" && Boolean(selected?.available && selected.readGranted)));
  const scope = JSON.stringify([domain, owner, library, libraries.materialsEpoch, readable, folder, query]);
  const scopeRef = useRef(scope); scopeRef.current = scope;

  useEffect(() => { setLibraryChoice(null); setFolder(""); setChoice(null); }, [owner]);
  useEffect(() => {
    let active = true;
    setFolders([]);
    if (domain !== "desktop" || !readable) return;
    api.contentNavigation(owner, library || undefined).then(value => {
      if (!active) return;
      const result: Folder[] = [];
      const flatten = (items: any[], prefix: string) => { for (const row of items || []) {
        if (typeof row.id !== "string" || typeof row.name !== "string") continue;
        result.push({ id: row.id, label: prefix + row.name });
        flatten(row.children || [], prefix + row.name + " / ");
      } };
      flatten(value.folders || [], ""); setFolders(result);
    }).catch(() => { if (active) setError("暂时无法读取电脑目录。"); });
    return () => { active = false; };
  }, [domain, owner, library, readable, libraries.materialsEpoch]);
  useEffect(() => {
    const token = ++request.current;
    setRows([]); setRowsScope(""); setPage(1); setHasMore(false); setError("");
    if (domain === "desktop" && !readable) { setLoading(false); return; }
    setLoading(true);
    const timer = setTimeout(() => { void fetchPage(1, scope, token); }, 200);
    return () => { clearTimeout(timer); request.current++; };
  }, [scope]);
  async function fetchPage(next: number, requestedScope: string, token: number) {
    try {
      const result = domain === "local"
        ? await api.localAssetList({ page: next, limit: 30, q: query.trim(), archived: false })
        : await api.contentAssets(owner, { page: next, limit: 30, q: query.trim(), folder: folder || undefined }, library || undefined);
      if (token !== request.current || requestedScope !== scopeRef.current) return;
      setRows(previous => {
        const idOf = (row: any) => domain === "local" ? row.assetId : row.desktopAssetId;
        const base = next === 1 ? [] : previous;
        const seen = new Set(base.map(idOf));
        return [...base, ...result.items.filter(row => { const id = idOf(row); if (typeof id !== "string" || seen.has(id)) return false; seen.add(id); return true; })];
      });
      setRowsScope(requestedScope);
      setPage(next); setHasMore(result.hasMore); setError("");
    } catch {
      if (token === request.current && requestedScope === scopeRef.current) setError("读取素材失败，请重试。");
    } finally { if (token === request.current && requestedScope === scopeRef.current) setLoading(false); }
  }
  function choose(row: any) {
    if (busy || rowsScope !== scope || (domain === "desktop" && !readable)) return;
    const id = domain === "local" ? row.assetId : row.desktopAssetId;
    const version = domain === "local" ? row.contentHash : materialImageVersion(row);
    if (typeof id !== "string" || typeof version !== "string" || !version) { setError("此素材暂时无法确认版本，请刷新后重试。"); return; }
    onSelect(domain === "local" ? { kind: "local", assetId: id, version }
      : { kind: "desktop", instance: owner, ...(library ? { library } : {}), assetId: id, version });
  }
  // Keep the controls stationary while source/catalog/search results arrive.
  // A content-sized sheet can otherwise replace a library control's tap target
  // with an asset row as the list expands.
  const backToAssets = () => { setChoice(null); };
  const choices = choice === "library"
    ? (libraries.catalog?.materials || []).flatMap(row => {
      const id = row.libraryId;
      // A missing identity is not the legacy/default library. Never expose an
      // empty-id choice or use an assertion to bypass the catalog contract.
      return typeof id === "string" && id.trim().length > 0
        ? [{ id, label: row.displayName, disabled: !row.available || !row.readGranted }] : [];
    })
    : [{ id: "", label: "全部目录", disabled: false }, ...folders.map(row => ({ ...row, disabled: false }))];
  return <Sheet title={choice === "library" ? "选择素材库" : choice === "folder" ? "选择文件夹" : "选择素材"} expanded busy={busy} registerDismiss={registerOverlay} onClose={onClose}
    footer={busy || message || error ? <p className="st-sheet-copy" role="status">{busy ? "正在读取素材并插入，请稍候…" : message || error}</p> : undefined}>
    <fieldset className="st-attachment-controls" disabled={busy}>
    {choice ? <div className="st-attachment-choices">
      <button type="button" className="st-attachment-back" onClick={backToAssets} disabled={busy} aria-label="返回素材列表"><span aria-hidden="true">‹</span>返回素材</button>
      {!choices.length ? <p className="st-sheet-copy" role="status">没有可选择的素材库。</p> : null}
      <div role="group" aria-label={choice === "library" ? "素材库" : "文件夹"}>
        {choices.map(row => <button type="button" key={row.id} className="st-attachment-choice" disabled={busy || row.disabled}
          aria-pressed={row.id === (choice === "library" ? library : folder)} onClick={() => {
            if (busy || row.disabled) return;
            if (choice === "library") { setLibraryChoice(row.id); setFolder(""); } else setFolder(row.id);
            backToAssets();
          }}><span>{row.label}</span>{row.disabled ? <small>不可用</small> : row.id === (choice === "library" ? library : folder) ? <span className="st-attachment-check" aria-hidden="true">✓</span> : null}</button>)}
      </div>
    </div> : <>
    <div className="st-attachment-source"><SourceSwitch value={domain} onChange={value => { if (!busy) { setDomain(value); setFolder(""); } }} /></div>
    {domain === "desktop" && <div className="st-attachment-filters">
      {libraries.catalog?.scopeSelectionVersion === 1 && <button type="button" className="st-attachment-filter" disabled={busy} onClick={() => setChoice("library")} aria-label="选择素材库">
        <span className="st-attachment-filter-label">素材库</span><span className="st-attachment-filter-value">{selected?.displayName || "选择素材库"}</span><svg className="st-attachment-chevron" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m7 10 5 5 5-5" /></svg>
      </button>}
      {readable && folders.length > 0 && <button type="button" className="st-attachment-filter" disabled={busy} onClick={() => setChoice("folder")} aria-label="选择文件夹">
        <span className="st-attachment-filter-label">文件夹</span><span className="st-attachment-filter-value">{folders.find(row => row.id === folder)?.label || "全部目录"}</span><svg className="st-attachment-chevron" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m7 10 5 5 5-5" /></svg>
      </button>}
    </div>}
    {domain === "desktop" && !readable ? <p className="st-sheet-copy" role="status">请连接电脑并选择已授权的素材库。</p> : <>
      <SearchField value={query} onChange={setQuery} placeholder="搜索素材" />
      {(rowsScope === scope ? rows : []).map(row => <AssetRow key={JSON.stringify([domain, owner, library, domain === "local" ? row.assetId : row.desktopAssetId])}
        row={row} domain={domain} owner={owner} library={library} disabled={busy} onChoose={() => choose(row)} />)}
      {!loading && rowsScope === scope && !rows.length && !error ? <p className="st-sheet-copy">没有找到素材。</p> : null}
      {rowsScope === scope && hasMore && !loading ? <Button kind="quiet" disabled={busy} onClick={() => { setLoading(true); void fetchPage(page + 1, scope, request.current); }}>加载更多</Button> : null}
      {loading ? <p className="st-sheet-copy" role="status">正在读取素材…</p> : null}
    </>}
    </>}
    </fieldset>
  </Sheet>;
}
function AssetRow({ row, domain, owner, library, disabled, onChoose }: { row: any; domain: "local" | "desktop"; owner: string; library: string; disabled: boolean; onChoose: () => void }) {
  const [thumb, setThumb] = useState("");
  const id = domain === "local" ? row.assetId : row.desktopAssetId;
  const version = materialImageVersion(row);
  useEffect(() => {
    let active = true; setThumb("");
    if (typeof id !== "string" || !(row.kind === "image" || row.kind === "video")) return;
    const key = domain === "local" ? localThumbKey(id, version) : desktopThumbKey(owner, id, version, false, library);
    void thumbnailScheduler.enqueue(key, () => domain === "local" ? api.localAssetThumbnail(id) : api.assetThumbnail(owner, id, false, false, version, library || undefined), "tail")
      .then(value => { if (active && value?.uri) setThumb(convertFileSrc(value.uri)); }).catch(() => {});
    return () => { active = false; };
  }, [domain, owner, library, id, version, row.kind]);
  return <Row title={row.name || "未命名素材"} meta={domain === "local" ? "本机" : "电脑"} thumb={thumb} icon={row.kind === "image" ? "image" : "file"} onClick={() => { if (!disabled) onChoose(); }} />;
}


