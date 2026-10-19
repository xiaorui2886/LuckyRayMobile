import "./noteExperience.css";
import { Icon } from "./StillImports";
import { folderAncestors, folderChildren, folderStatus, type FolderSnapshot } from "./knowledgeFolderCatalog";

export function FolderBreadcrumbs({ current, onSelect }: { current: string; onSelect: (path: string) => void }) {
  if (!current) return null;
  const ancestors = folderAncestors(current);
  return <nav className="st-folder-breadcrumbs" aria-label="知识库目录路径">
    <div className="st-folder-trail">{ancestors.map((path, i) => <span key={path}>
      {i > 0 ? <Icon name="right" size={12} /> : null}
      {path === current ? <strong aria-current="location" title={current}>{path.slice(path.lastIndexOf("/") + 1)}</strong>
        : <button type="button" onClick={() => onSelect(path)}>{path ? path.slice(path.lastIndexOf("/") + 1) : "全部笔记"}</button>}
    </span>)}</div>
  </nav>;
}
export function FolderRows({ snapshot, current, online, onSelect, showStatus = true }: {
  snapshot: FolderSnapshot; current: string; online: boolean; onSelect: (path: string) => void; showStatus?: boolean;
}) {
  const children = folderChildren(snapshot.paths, current);
  const status = folderStatus(snapshot, online);
  return <section className="st-knowledge-folders" aria-label="文件夹">
    {showStatus && status ? <p className="st-folder-status" role="status">{status}</p> : null}
    {children.map(path => <button key={path} type="button" className="st-folder-row" onClick={() => onSelect(path)}>
      <span className="st-folder-symbol"><Icon name="folder" size={20} /></span><span className="st-folder-name">{path.slice(path.lastIndexOf("/") + 1)}</span><Icon name="right" size={14} />
    </button>)}
  </section>;
}
