import { useMemo } from "react";
import { Sheet } from "./StillImports";
import { noteHeadings, type NoteHeading } from "./noteHeadings";
import "./noteOutline.css";

export function NoteOutline({ body, registerOverlay, onClose, onSelect }: {
  body: string; registerOverlay: (dismiss: () => void) => () => void;
  onClose: () => void; onSelect: (heading: NoteHeading) => void;
}) {
  const headings = useMemo(() => noteHeadings(body), [body]);
  return <Sheet title="笔记大纲" registerDismiss={registerOverlay} onClose={onClose}>
    {headings.length ? <nav aria-label="笔记标题"><ol className="st-note-outline">
      {headings.map(heading => <li key={heading.from}>
        <button type="button" style={{ paddingInlineStart: 12 + (heading.depth - 1) * 12 }}
          onClick={() => onSelect(heading)}>
          <span className="st-note-outline-level" aria-label={`${heading.depth}级标题`}>H{heading.depth}</span>
          <span>{heading.label || "无标题"}</span>
        </button>
      </li>)}
    </ol></nav> : <p className="st-sheet-copy">还没有标题。在正文中使用 # 标题或 ## 小标题建立大纲。</p>}
  </Sheet>;
}
