import { NoteActionIcon } from "../../presentation/still01/editor/NoteActionIcon";
export function NoteFindBar({ query, count, index, noMatch = "正文无匹配", onNext, onClose }: {
  query: string; count: number; index: number; noMatch?: string; onNext: (step: number) => void; onClose?: () => void;
}) {
  return <div className="st-note-find" role="group" aria-label="正文查找">
    <span className="st-note-find-query">{query}</span>
    <span className="st-note-find-count">{count ? `${index + 1} / ${count}` : noMatch}</span>
    <button type="button" aria-label="上一处匹配" disabled={!count} onPointerDown={e => e.preventDefault()} onClick={() => onNext(-1)}><NoteActionIcon name="up" size={18}/></button>
    <button type="button" aria-label="下一处匹配" disabled={!count} onPointerDown={e => e.preventDefault()} onClick={() => onNext(1)}><NoteActionIcon name="down" size={18}/></button>
    <button type="button" aria-label="关闭正文查找" onPointerDown={e => e.preventDefault()} onClick={onClose}><NoteActionIcon name="close" size={18}/></button>
  </div>;
}
