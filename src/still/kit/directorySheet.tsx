import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Sheet, Button } from "./StillImports";
import { sessionKnowledge } from "./knowledgeSession";
import { FolderBreadcrumbs, FolderRows } from "./knowledgeFolders";
import { folderScopeKey } from "./knowledgeFolderCatalog";

export type DirectorySheetProps = {
  registerOverlay: (close: () => void) => () => void;
  onClose: () => void;
  instanceId: string;
  vaultId: string;
  vaultName: string;
  connected: boolean;
  current: string;
  onSelect: (directory: string) => void;
  title?: string;
  rootLabel?: string;
  notice?: string;
  syncManagement?: ReactNode;
};

export function DirectorySheet({ registerOverlay, onClose, instanceId, vaultId, vaultName, connected, current, onSelect,
  title = "目录与知识库", rootLabel = "全部笔记", notice, syncManagement }: DirectorySheetProps) {
  const catalog = sessionKnowledge().folders;
  const scope = { instance: instanceId, vault: vaultId };
  const key = folderScopeKey(scope);
  const [location, setLocation] = useState({ key, path: current.startsWith("（") ? "" : current });
  const path = location.key === key ? location.path : "";
  const snapshot = useSyncExternalStore(catalog.subscribe, () => catalog.snapshot(scope));
  useEffect(() => { void catalog.activate(scope, connected); }, [catalog, instanceId, vaultId, connected]);
  const browse = (path: string) => setLocation({ key, path });
  return <Sheet title={title} registerDismiss={registerOverlay} onClose={onClose}>
    <p className="st-sheet-caption">{vaultName}（电脑知识库）</p>
    {notice ? <p className="st-sheet-copy" role="status">{notice}</p> : null}
    <FolderBreadcrumbs current={path} onSelect={browse} />
    <FolderRows snapshot={snapshot} current={path} online={connected} onSelect={browse} />
    <div className="st-folder-pick"><Button kind="quiet" onClick={() => onSelect(path)}
      disabled={!instanceId || !vaultId || snapshot.phase === "denied"}>
      {title === "移动到目录" ? `移动到${path ? "此目录" : "根目录"}` : path ? "查看此目录" : rootLabel}
    </Button><Button kind="quiet" disabled={!connected || snapshot.phase === "loading"}
      onClick={() => void catalog.refresh(scope, connected)}>刷新目录</Button></div>
    {snapshot.complete && snapshot.phase === "ready" && snapshot.paths.filter(Boolean).length === 0
      ? <p className="st-sheet-copy">电脑知识库中还没有文件夹。</p> : null}
    {syncManagement}
  </Sheet>;
}
