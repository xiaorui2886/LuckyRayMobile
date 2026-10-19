import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { takeCmReadingAnchor } from "../../presentation/still01/editor/cmEditorSessions";
import { plainReadingBlocks, restoreReadingAnchor } from "../../presentation/still01/editor/noteReadingPosition";
import { bodyMatchRanges, type NoteSearchTarget, type BodyRange } from "./noteSearch";
import { NoteFindBar } from "./NoteFindBar";

export type ReadingFind = { body: string; ranges: BodyRange[]; index: number };

/** Literal source text keeps its own offsets even when a match is wrapped. */
export function ReadingText({ text, from, find }: { text: string; from: number; find: ReadingFind }) {
  const nodes: ReactNode[] = []; let consumed = 0;
  find.ranges.forEach((range, index) => {
    const start = Math.max(0, range.from - from), end = Math.min(text.length, range.to - from);
    if (end <= start) return;
    if (start > consumed) nodes.push(text.slice(consumed, start));
    nodes.push(<mark key={index} className={"st-note-find-hit" + (find.index === index ? " is-current" : "")}
      data-note-source-start={from + start} data-note-source-end={from + end}>{text.slice(start, end)}</mark>);
    consumed = end;
  });
  nodes.push(text.slice(consumed)); return <>{nodes}</>;
}

/** Mounted only by the reader. CM's detach has captured the visible source
 * position before this layout effect; restore before the reader's first paint.
 * No mode/save/selection authority lives here, and the retained editor is not
 * moved when the user goes back to editing.
 */
export function NoteReadingContent({ scope, body, title = "", children, search, onSearchChange, onDismissSearch }: {
  scope: string; body: string; title?: string; children?: ReactNode | ((find: ReadingFind) => ReactNode); search?: NoteSearchTarget;
  onSearchChange?: (target: NoteSearchTarget) => void; onDismissSearch?: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const ranges = useMemo(() => bodyMatchRanges(body, search?.query || ""), [body, search?.query]);
  const index = Math.max(0, search?.bodyRange ? ranges.findIndex(r => r.from === search.bodyRange?.from && r.to === search.bodyRange?.to) : 0);
  const find: ReadingFind = { body, ranges, index };
  useLayoutEffect(() => {
    const anchor = takeCmReadingAnchor(scope, body);
    if (root.current && anchor) restoreReadingAnchor(root.current, anchor);
  }, [scope]);
  useLayoutEffect(() => {
    if (root.current && ranges[index]) restoreReadingAnchor(root.current, { offset: ranges[index].from, viewportFraction: .5, atStart: false });
  }, [scope, body, search, index]);
  const nextMatch = (step: number) => {
    if (search && ranges.length) onSearchChange?.({ ...search, bodyRange: ranges[(index + step + ranges.length) % ranges.length] });
  };
  return <div ref={root} style={{ display: "contents" }}>
    {search?.query ? <NoteFindBar query={search.query} count={ranges.length} index={index}
      noMatch={bodyMatchRanges(title, search.query).length ? "仅标题命中，正文无匹配" : "正文无匹配"}
      onNext={nextMatch} onClose={onDismissSearch} /> : null}
    {!body ? <span className="st-note-placeholder" aria-hidden="true"/> : typeof children === "function" ? children(find) : children ?? plainReadingBlocks(body).map(({ text, from, to }, i) =>
      <p key={i} data-note-source-start={from} data-note-source-end={to}><ReadingText text={text} from={from} find={find} /></p>)}
  </div>;
}
