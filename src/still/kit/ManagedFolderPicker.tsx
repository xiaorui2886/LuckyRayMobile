import { useState } from "react";
import { Icon, Option } from "./StillImports";

/** Exact stored identities; infer old leaf-only ancestors without deleting folders. */
export function managedFolderPaths(paths: string[]) {
  return [...new Set(paths.filter(Boolean).flatMap(path => path.split("/").map((_, index, parts) => parts.slice(0, index + 1).join("/"))))];
}
export function managedFolderChildren(paths: string[], parent: string) {
  return paths.filter(path => path.slice(0, Math.max(0, path.lastIndexOf("/"))) === parent).sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));
}
/** Same hierarchy as the inline list; expanding never changes selection. */
export function ManagedFolderPicker({ paths: raw, selected, onSelect }: { paths: string[]; selected: string; onSelect: (path: string) => void }) {
  const paths = managedFolderPaths(raw);
  const [expanded, setExpanded] = useState(() => new Set(selected.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"))));
  const branch = (parent: string): React.ReactNode => managedFolderChildren(paths, parent).map(path => {
    const children = managedFolderChildren(paths, path).length > 0;
    return <div key={path} className="st-picker-branch">
      <div className="st-picker-folder-row">
        {children ? <button type="button" className="st-picker-disclosure" aria-label={`${expanded.has(path) ? "收起" : "展开"}文件夹：${path}`} aria-expanded={expanded.has(path)} onClick={() => setExpanded(previous => { const next = new Set(previous); if (next.has(path)) next.delete(path); else next.add(path); return next; })}><Icon name="right" size={16}/></button> : <span className="st-picker-disclosure-space"/>}
        <div className="st-picker-folder-choice" title={path}><Option label={path.split("/").pop() || path} icon="folder" selected={selected === path} onClick={() => onSelect(path)} /></div>
      </div>
      {children && expanded.has(path) ? <div className="st-picker-children" role="group" aria-label={path}>{branch(path)}</div> : null}
    </div>;
  });
  return <nav aria-label="知识库文件夹" className="st-managed-folder-picker">{branch("")}</nav>;
}
