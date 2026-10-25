import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { api } from "../../services/client";
import { desktopLibraries, libraryIdOf, librarySelectionError, type LibraryKind } from "../../services/desktopLibraries";
import { Sheet, Icon, Button } from "./StillImports";
import "./desktopLibraryPicker.css";

desktopLibraries.setInvalidator(api.contentScopeChanged);

export function useDesktopLibraries(instance: string, connected: boolean) {
  const selection = useSyncExternalStore(desktopLibraries.subscribe, () => desktopLibraries.snapshot(instance));
  useEffect(() => {
    desktopLibraries.observeConnection(instance, connected);
    if (instance && connected) void desktopLibraries.refresh(instance, api.contentLibraryCatalog);
  }, [instance, connected]);
  useEffect(() => {
    const refresh = () => { if (instance && connected) void desktopLibraries.refresh(instance,api.contentLibraryCatalog); };
    window.addEventListener("luckyray:library-catalog-refresh",refresh);
    return () => window.removeEventListener("luckyray:library-catalog-refresh",refresh);
  }, [instance,connected]);
  return selection;
}

/** One stable sheet: switching a library never creates a second overlay. */
export function DirectoryLibrarySheet({ directory, instance, kind, fallback, registerOverlay, onClose, onSelect }: {
  directory: ReactNode; instance: string; kind: LibraryKind; fallback?: string;
  registerOverlay: (close: () => void) => () => void; onClose: () => void;
  onSelect: (id: string, isCurrent: () => boolean) => void | boolean | Promise<void | boolean>;
}) {
  const [tab, setTab] = useState<"directory" | "libraries">("directory");
  const [busy, setBusy] = useState(false);
  const id = useId();
  const tabs = ["directory", "libraries"] as const;
  const heading = <div className="st-source st-directory-tabs" role="tablist" aria-label="目录与库">
    <span className={"st-source-glide " + (tab === "libraries" ? "is-desktop" : "")} aria-hidden="true" />
    {tabs.map((value, index) => <button key={value} type="button" role="tab" id={`${id}-${value}-tab`}
      aria-selected={tab === value} aria-controls={`${id}-${value}-panel`} tabIndex={tab === value ? 0 : -1}
      onClick={() => setTab(value)} onKeyDown={event => {
        const next = event.key === "Home" ? 0 : event.key === "End" ? 1 :
          event.key === "ArrowRight" || event.key === "ArrowLeft" ? 1 - index : -1;
        if (next < 0) return;
        event.preventDefault(); setTab(tabs[next]);
        document.getElementById(`${id}-${tabs[next]}-tab`)?.focus();
      }}><span className="st-source-label">{index === 0 ? "目录" : "库"}</span></button>)}
  </div>;
  return <Sheet title="目录与库" headingSlot={heading} registerDismiss={registerOverlay} onClose={onClose} busy={busy}>
    <div className="st-directory-panel" role="tabpanel" id={`${id}-directory-panel`} aria-labelledby={`${id}-directory-tab`} hidden={tab !== "directory"}>
      {directory}
    </div>
    <div className="st-directory-panel" role="tabpanel" id={`${id}-libraries-panel`} aria-labelledby={`${id}-libraries-tab`} hidden={tab !== "libraries"}>
      <DesktopLibraryPicker instance={instance} kind={kind} fallback={fallback} active={tab === "libraries"} onSelect={onSelect} onBusy={setBusy} />
    </div>
  </Sheet>;
}

/** Inline saved-library choices, exclusively inside the directory sheet. */
export function DesktopLibraryPicker({ instance, kind, fallback, active, onSelect, onBusy }: {
  instance: string; kind: LibraryKind; fallback?: string; active: boolean;
  onSelect: (id: string, isCurrent: () => boolean) => void | boolean | Promise<void | boolean>; onBusy: (busy: boolean) => void;
}) {
  const state = useSyncExternalStore(desktopLibraries.subscribe, () => desktopLibraries.snapshot(instance));
  const identity = useRef(instance); identity.current = instance;
  const operation = useRef(0), mounted = useRef(false), pending = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; operation.current++; }; }, []);
  useEffect(() => { operation.current++; pending.current = false; setBusy(false); setError(""); onBusy(false); }, [instance, kind, onBusy]);
  useEffect(() => { if (active && instance) void desktopLibraries.refresh(instance, api.contentLibraryCatalog); }, [active, instance]);
  const selected = kind === "materials" ? state.material : state.vault;
  const supported = state.catalog?.scopeSelectionVersion === 1;
  const rows = state.catalog?.[kind] || [];
  const loading = state.phase === "loading" || state.phase === "idle";
  const choose = async (id: string) => {
    if (pending.current || loading) return;
    pending.current = true; const token = ++operation.current, owner = instance;
    const current = () => mounted.current && token === operation.current && identity.current === owner;
    setBusy(true); onBusy(true); setError("");
    try { await onSelect(id, current); }
    catch (reason) { if (current()) setError(librarySelectionError(reason)); }
    finally { if (current()) { pending.current = false; setBusy(false); onBusy(false); } }
  };
  return <div className="st-library-options" aria-busy={busy || loading}>
    {supported ? rows.map(item => {
      const id = libraryIdOf(kind, item), usable = item.available === true && item.readGranted === true;
      const detail = !item.available ? "当前不可用" : !item.readGranted ? "尚未授权" : undefined;
      return <button key={id} type="button" className="st-option st-library-option" aria-pressed={id === selected}
        disabled={!usable || busy || loading} onClick={() => void choose(id)}>
        <span>{item.displayName}{detail ? <small>{detail}</small> : null}</span>
        {id === selected ? <Icon name="check" size={18} /> : <span className="st-check-space" />}
      </button>;
    }) : state.phase === "legacy" ? <p className="st-sheet-copy">{fallback || (kind === "materials" ? "电脑当前素材库" : "电脑当前知识库")}<br />此电脑版本暂不支持切换库。</p> : null}
    {supported && selected && !rows.some(row => libraryIdOf(kind, row) === selected) ? <p className="st-sheet-copy" role="status">所选库已不可用，请选择其他库。</p> : null}
    {supported && !rows.length && !loading ? <p className="st-sheet-copy">还没有可用的库。</p> : null}
    {loading ? <p className="st-sheet-copy" role="status">正在读取库…</p> : busy ? <p className="st-sheet-copy" role="status">正在切换…</p> : null}
    {error || state.phase === "error" ? <p className="st-sheet-copy" role="status">{error || state.error || "暂时读不到库，请重试。"}</p> : null}
    <Button kind="quiet" disabled={busy || loading || !instance} onClick={() => { setError(""); void desktopLibraries.refresh(instance, api.contentLibraryCatalog); }}>
      {state.phase === "error" ? "重试读取库" : "刷新库"}
    </Button>
  </div>;
}
