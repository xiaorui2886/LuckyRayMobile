import { useEffect, useRef, useState } from "react";
import { managedVault, managedNoteRoute } from "../../services/managedVault";
import { buildKnowledgeVaultCatalog, type KnowledgeVaultEntry } from "../../services/knowledgeVaultCatalog";
import { failureCopy } from "../../services/feedback";
import { toast } from "../../services/toast";
import { usePageCurrent } from "../../presentation/still01/PageLayer";
import { useStillNav } from "../StillShell";
import { Button, Header, IconButton, Option, Sheet } from "./StillImports";
import { ScopedNoteSwitcher } from "./noteSwitcher";
import { NotePaperRail } from "./NotePaperRail";
import "./noteVaultWorkspace.css";

/** Uses the same local registry/display names as the outer Notes selector. */
export function NoteVaultPicker({ localVaultId, onClose, onSelect }: {
  localVaultId?: string; onClose: () => void;
  onSelect: (id: string, isCurrent: () => boolean, displayName: string) => Promise<void> | void;
}) {
  const { registerOverlay } = useStillNav();
  const [items, setItems] = useState<KnowledgeVaultEntry[]>([]);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const active = useRef(true), busy = useRef(false);
  const dismiss = () => { active.current = false; onClose(); };
  useEffect(() => {
    active.current = true;
    void managedVault.list().then(catalog => {
      if (active.current) setItems(buildKnowledgeVaultCatalog(catalog).items);
    }, reason => { if (active.current) setError(failureCopy(reason, "读取知识库失败")); });
    return () => { active.current = false; };
  }, []);
  const isCurrent = () => active.current && !host.current?.querySelector(".is-closing");
  async function select(id: string) {
    if (!isCurrent() || busy.current) return;
    if (id === localVaultId) { dismiss(); return; }
    busy.current = true; setWorking(true); setError("");
    try {
      const fresh = buildKnowledgeVaultCatalog(await managedVault.list());
      if (!isCurrent()) return;
      const entry = fresh.items.find(item => item.id === id);
      if (!entry) throw Error("MANAGED_VAULT_UNAVAILABLE");
      await onSelect(id, isCurrent, entry.displayName);
    } catch (reason) { if (active.current) setError(failureCopy(reason, "切换知识库失败，原有内容未改变。")); }
    finally { busy.current = false; if (active.current) setWorking(false); }
  }
  return <div ref={host}><Sheet title="切换知识库" busy={working} registerDismiss={registerOverlay} onClose={dismiss}>
    {items.map(item => <Option key={item.id} label={item.displayName} detail={item.detailLabel} selected={item.id === localVaultId} icon="folder" onClick={() => void select(item.id)} />)}
    {error ? <p role="alert">{error}</p> : null}
  </Sheet></div>;
}

/** No editor, document ID, autosave owner or automatic file creation lives here. */
export function NoteVaultWorkspace({ localVaultId, initialName }: { localVaultId: string; initialName?: string }) {
  const { open, registerOverlay } = useStillNav();
  const current = usePageCurrent(true);
  const currentRef = useRef(current); currentRef.current = current;
  const alive = useRef(true), creating = useRef(false);
  const [entry, setEntry] = useState<KnowledgeVaultEntry>();
  const [panel, setPanel] = useState<"" | "browse" | "search" | "vault">("browse");
  const intent = useRef(0);
  useEffect(() => {
    let active = true;
    alive.current = true;
    void managedVault.list().then(catalog => {
      if (active && alive.current) setEntry(buildKnowledgeVaultCatalog(catalog).items.find(item => item.id === localVaultId));
    }, reason => { if (active && alive.current) toast.error(failureCopy(reason, "读取知识库失败")); });
    return () => { active = false; alive.current = false; intent.current += 1; };
  }, [localVaultId]);
  const live = () => alive.current && currentRef.current;
  const dismiss = () => { intent.current += 1; setPanel(""); };
  async function create() {
    if (!live() || creating.current) return;
    creating.current = true;
    const ticket = ++intent.current;
    try {
      const fresh = buildKnowledgeVaultCatalog(await managedVault.list()).items.find(item => item.id === localVaultId);
      if (!live() || ticket !== intent.current) return;
      if (!fresh || fresh.readOnly) throw Error("此知识库暂不可新建笔记");
      const note = await managedVault.create(localVaultId, "新笔记", "");
      if (note.localVaultId !== localVaultId || !note.noteId) throw Error("MANAGED_NOTE_SCOPE_MISMATCH");
      window.dispatchEvent(new Event("luckyray:managed-vault-change"));
      if (live() && ticket === intent.current) open("note", managedNoteRoute(localVaultId, note.noteId), { edit: true, linked: true });
    } catch (reason) { if (live() && ticket === intent.current) toast.error(failureCopy(reason, "新建笔记失败")); }
    finally { creating.current = false; }
  }
  const vaultName = entry?.displayName || initialName || "知识库";
  return <NotePaperRail panel={panel === "browse" ? "left" : null} disabled={!current || panel === "vault" || panel === "search"} onPanelChange={side => setPanel(side === "left" ? "browse" : "")}>
    <div className="st-view st-note-vault-workspace">
      <Header title={entry?.displayName || initialName || ""} left={<IconButton icon="folder" label="打开笔记" onClick={() => setPanel("browse")} />} />
      <div className="st-note-vault-actions">
        <Button kind="quiet" onClick={() => void create()}>新建笔记</Button>
        <Button kind="quiet" onClick={() => setPanel("browse")}>打开笔记</Button>
        <Button kind="quiet" onClick={() => { intent.current += 1; open("knowledge"); }}>返回笔记列表</Button>
      </div>
    </div>
    {panel === "browse" || panel === "search" ? <ScopedNoteSwitcher key={localVaultId + panel} localVaultId={localVaultId} vaultName={vaultName} variant={panel} registerOverlay={registerOverlay} onClose={dismiss} onSwitchVault={() => { intent.current += 1; setPanel("vault"); }} onNew={() => void create()} onPick={(route, target, isCurrent) => {
      if (!live() || !isCurrent()) return;
      intent.current += 1;
      open("note", route, { noteSearch: target, linked: true });
    }} /> : null}
    {panel === "vault" ? <NoteVaultPicker localVaultId={localVaultId} onClose={dismiss} onSelect={(id, isCurrent, displayName) => {
      if (live() && isCurrent()) { intent.current += 1; open("note-vault", id, { vaultName: displayName }); }
    }} /> : null}
  </NotePaperRail>;
}
