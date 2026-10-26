import { noteSourceSelection } from "../../services/noteSourceSelection";
import { buildKnowledgeVaultCatalog } from "../../services/knowledgeVaultCatalog";
import { Sheet } from "./Sheet";
import { noteImportFailure, type ImportReceipt } from "../../services/knowledgeActions";
import { useStillNav } from "../StillShell";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { systemBarScrim } from "../../services/systemBarAppearance";
import { listen } from "@tauri-apps/api/event";
import { api } from "../../services/client";
import { localDataStore } from "../../services/localDataStore";
import { managedVault, managedNoteRoute, type ManagedVault } from "../../services/managedVault";
import { ManagedImportIntents, snapshotManagedImportTarget, currentManagedImportTarget, type ImportTarget } from "../../services/managedImportIntents";
import { toast } from "../../services/toast";

let picking: string | true | false = false;
let launchSettled: Promise<void> = Promise.resolve();
const intents = () => new ManagedImportIntents(localStorage);
export async function pickLocalNoteFile() {
  if (picking) return;
  const target = snapshotManagedImportTarget();
  picking = true;
  launchSettled = (async () => {
    try {
      // Legacy callers may launch before migration, but never guess a managed target.
      const result = await api.localNoteImportPick();
      if (result.status !== "launched") throw Error("IMPORT_NOT_LAUNCHED");
      picking = result.requestId || false;
      if (result.requestId && target) intents().remember(result.requestId, target);
    } catch { picking = false; toast.error("无法确认导入请求。若已选择文件，请在待处理导入中选择笔记库。"); }
  })();
  await launchSettled;
  window.dispatchEvent(new Event("luckyray:import-drain"));
}
/** Receipt acknowledgement follows validated managed copy, never mere discovery. */
export function LocalNoteImportBridge({ showEntry = true }: { showEntry?: boolean }) {
  const modalOpen = useSyncExternalStore(listener => systemBarScrim.subscribe(listener), () => systemBarScrim.active());
  const { open, registerOverlay } = useStillNav();
  const [inboxOpen, setInboxOpen] = useState(false);
  const openRef = useRef(open); openRef.current = open;
  const [waiting, setWaiting] = useState<{noteId: string; title: string}[]>([]);
  const [recovery, setRecovery] = useState<ImportReceipt[]>([]);
  const [vaults, setVaults] = useState<ManagedVault[]>([]);
  const [targetId, setTargetId] = useState("");
  const [busy, setBusy] = useState(false);
  const adopting = useRef(new Set<string>());
  const aliveRef = useRef(true);
  const present = (noteId: string, title: string, mayOpen: boolean) => {
    if (!aliveRef.current) return;
    if (mayOpen && !document.querySelector(".st-note-surface")) openRef.current("note", noteId, { edit: false });
    else setWaiting(previous => previous.some(item => item.noteId === noteId) ? previous : [...previous, { noteId, title }]);
    toast.success(`已导入知识库：${title}`);
  };
  const adopt = async (item: ImportReceipt, localVaultId: string, captured?: ImportTarget, allowOpen = true) => {
    if (!item.noteId || adopting.current.has(item.requestId)) return false;
    if (captured && !currentManagedImportTarget(captured)) return false;
    const selectionVersion = noteSourceSelection.snapshot().version;
    adopting.current.add(item.requestId);
    try {
      const alias = await managedVault.resolveLegacy(item.noteId);
      if (captured && !currentManagedImportTarget(captured)) return false;
      if (!alias) {
        const catalog = buildKnowledgeVaultCatalog(await managedVault.list());
        if (!catalog.items.some(entry => entry.id === localVaultId && !entry.readOnly)) throw Error("IMPORT_TARGET_READONLY");
        if (captured && !currentManagedImportTarget(captured)) return false;
      }
      const note = alias ? await managedVault.get(alias.localVaultId, alias.noteId)
        : await managedVault.importLegacyReceipt(localVaultId, item.noteId, captured?.folder || "");
      // Core resolves any pre-existing alias; route uses that returned identity.
      if (!note.noteId || !note.localVaultId || note.bodyState !== "ready") throw Error("IMPORT_COPY_UNVERIFIED");
      await api.localNoteImportAck([item.requestId]);
      intents().forget(item.requestId);
      localDataStore.publish("note");
      window.dispatchEvent(new Event("luckyray:managed-vault-change"));
      present(managedNoteRoute(note.localVaultId, note.noteId), note.title || "未命名笔记", allowOpen && noteSourceSelection.snapshot().version === selectionVersion && (!captured || currentManagedImportTarget(captured)));
      setRecovery(previous => previous.filter(value => value.requestId !== item.requestId));
      setTargetId("");
      return true;
    } finally { adopting.current.delete(item.requestId); }
  };
  const adoptRef = useRef(adopt); adoptRef.current = adopt;
  useEffect(() => {
    let alive = true, draining = false, again = false;
    aliveRef.current = true;
    const unlisten: (() => void)[] = [];
    async function drain() {
      if (!alive) return;
      if (draining) { again = true; return; }
      draining = true;
      try {
        do {
          again = false;
          await launchSettled;
          const result = await api.localNoteImportPending();
          if (!alive) return;
          let acknowledged = false;
          for (const item of result.items) {
            // Replaying an older alias must not navigate away and retire the
            // folder captured by a different, currently active picker.
            const anotherPicker = typeof picking === "string" && picking !== item.requestId;
            if (picking === item.requestId) picking = false;
            if (item.status === "imported" && item.noteId) {
              const captured = item.source === "picker" ? intents().matching(item.requestId, snapshotManagedImportTarget()) : null;
              let adopted = false;
              try {
                const alias = await managedVault.resolveLegacy(item.noteId);
                if (alias) adopted = await adoptRef.current(item, alias.localVaultId, captured || undefined, !anotherPicker && !!captured && alias.localVaultId === captured.localVaultId);
                else if (captured) adopted = await adoptRef.current(item, captured.localVaultId, captured);
              } catch { /* Keep receipt and expose explicit retry. */ }
              if (adopted) acknowledged = true;
              else setRecovery(previous => previous.some(value => value.requestId === item.requestId) ? previous : [...previous, item].slice(0, 32));
            } else {
              if (item.status === "error") toast.error(noteImportFailure(item.error));
              await api.localNoteImportAck([item.requestId]);
              intents().forget(item.requestId); acknowledged = true;
            }
          }
          // Never spin on unacknowledged recovery receipts.
          if (result.hasMore && acknowledged) again = true;
        } while (again && alive);
      } catch { /* Durable receipt is retained until next focus or explicit recovery. */ }
      finally { draining = false; }
    }
    const visible = () => { if (!document.hidden) void drain(); };
    for (const event of ["lr:local-share", "tauri://focus"]) void listen(event, () => void drain()).then(fn => { if (alive) { unlisten.push(fn); void drain(); } else fn(); });
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("luckyray:import-drain", visible);
    void drain();
    return () => { alive = false; aliveRef.current = false; unlisten.forEach(fn => fn()); document.removeEventListener("visibilitychange", visible); window.removeEventListener("luckyray:import-drain", visible); };
  }, []);
  useEffect(() => {
    if (!recovery.length) return;
    let live = true;
    const refresh = () => { void managedVault.list().then(value => { if (live) setVaults(buildKnowledgeVaultCatalog(value).items.filter(entry => !entry.readOnly).map(entry => ({ ...entry.vault, name: entry.displayName }))); }).catch(() => {}); };
    refresh(); window.addEventListener("luckyray:managed-vault-change", refresh);
    return () => { live = false; window.removeEventListener("luckyray:managed-vault-change", refresh); };
  }, [recovery.length]);
  return <>
    {showEntry && !modalOpen && !inboxOpen && (recovery.length || waiting.length) ? <button type="button" className="st-import-inbox-trigger" onClick={() => setInboxOpen(true)}>待处理导入 {recovery.length + waiting.length}</button> : null}
    {inboxOpen ? <Sheet title="导入记录" registerDismiss={registerOverlay} onClose={() => { if (!busy) setInboxOpen(false); }} busy={busy}>
    {recovery.length ? <div className="st-import-inbox-recovery" role="status">
      <span>待处理导入：{recovery[0].title || "笔记"}。请选择保存的笔记库，将存入根目录；原始文件仍保留。</span>
      <select aria-label="导入目标笔记库" value={targetId} disabled={busy} onChange={event => setTargetId(event.target.value)}><option value="">请选择笔记库</option>{vaults.map(vault => <option key={vault.localVaultId} value={vault.localVaultId}>{vault.name}</option>)}</select>
      <button type="button" disabled={busy || !vaults.some(vault => vault.localVaultId === targetId)} onClick={() => {
        if (busy) return; setBusy(true);
        void adopt(recovery[0], targetId).catch(() => toast.error("导入尚未确认，原始内容和待处理请求已保留，请重试。")).finally(() => setBusy(false));
      }}>保存到所选库</button>
      {!vaults.length ? <span>请先在笔记中添加知识库。</span> : null}
    </div> : null}
    {waiting.length ? <div className="st-import-inbox-receipt" role="status">
      <span>已导入知识库：{waiting[0].title}{waiting.length > 1 ? ` 等 ${waiting.length} 篇` : ""}</span>
      <button type="button" onClick={() => {
        if (document.querySelector(".st-note-surface")) { toast.error("请先保存并关闭当前笔记，再查看导入内容。"); return; }
        setInboxOpen(false); openRef.current("note", waiting[0].noteId, {edit: false}); setWaiting(previous => previous.slice(1));
      }}>查看</button><button type="button" aria-label="关闭导入提示" onClick={() => setWaiting([])}>关闭</button>
    </div> : null}
    {!recovery.length && !waiting.length ? <p>导入已处理完毕。</p> : null}
    </Sheet> : null}
  </>;
}
