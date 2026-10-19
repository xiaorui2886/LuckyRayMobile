import type { ReactNode } from "react";
import { Sheet, Option } from "./StillImports";
/** Library/source management only. Folder browsing belongs to the collection;
 * move destinations retain their separate DirectorySheet and authority checks. */
export function KnowledgeLibrarySheet({ vaultName, registerOverlay, onClose, onLocal, management }: {
  vaultName: string;
  registerOverlay: (close: () => void) => () => void;
  onClose: () => void;
  onLocal: () => void;
  management: ReactNode;
}) {
  return <Sheet title="知识库" registerDismiss={registerOverlay} onClose={onClose}>
    <Option label="本机笔记" icon="knowledge" onClick={onLocal} />
    <Option label={vaultName || "电脑知识库"} icon="monitor" selected onClick={onClose} />
    {management}
  </Sheet>;
}
