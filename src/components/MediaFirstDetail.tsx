// Media-first asset detail sheet (REAL-DEVICE-UI-POLISH-R1).
//
// Two-state bottom sheet shared by the Local and Desktop asset details:
//   collapsed — handle + one-line summary (name · kind · size), media fills
//               the stage behind it;
//   expanded  — full metadata, tags, export/share and domain actions.
// WebView83-safe by construction: discrete states (no transform drag), the
// handle is BOTH a drag-threshold target and a 44px tap toggle, the sheet is
// absolutely positioned inside .app-shell (never position: fixed), and while
// expanded it registers into the production overlayStack so Android Back
// collapses it before any navigation.
import { useCallback, useEffect, useRef, useState } from "react";
import { IconChevronRight } from "../components/icons";
import { overlayStack } from "../services/overlayStack";

export function MediaFirstLayout({
  stage,
  summary,
  children,
}: {
  /** The media preview — fills the whole area above the collapsed sheet. */
  stage: React.ReactNode;
  /** Collapsed one-liner: [{label, value}] shown next to the name. */
  summary: { name: string; lines: string[] };
  /** Expanded details/actions. */
  children: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const dragStart = useRef<number | null>(null);
  const toggle = useCallback(() => setExpanded((v) => !v), []);

  // While expanded the sheet participates in the Back/overlay authority:
  // Back collapses it first; collapse also unregisters.
  useEffect(() => {
    if (!expanded) return;
    const release = overlayStack.push(() => setExpanded(false));
    return release;
  }, [expanded]);

  // Drag threshold: a decisive upward drag on the handle expands, a downward
  // drag collapses. No continuous transform is applied — only the discrete
  // flip at the threshold, which keeps WebView83 hit-testing intact.
  const onHandleTouchStart = (e: React.TouchEvent) => {
    dragStart.current = e.touches[0].clientY;
  };
  const onHandleTouchEnd = (e: React.TouchEvent) => {
    const start = dragStart.current;
    dragStart.current = null;
    if (start == null) return;
    const dy = e.changedTouches[0].clientY - start;
    if (dy < -24) setExpanded(true);
    else if (dy > 24) setExpanded(false);
  };

  return (
    <div className="media-first">
      <div className="media-stage">{stage}</div>
      <div className="detail-sheet" data-state={expanded ? "expanded" : "collapsed"} role="region" aria-label="素材详情">
        <button
          type="button"
          className="detail-sheet-handle"
          aria-expanded={expanded}
          aria-label={expanded ? "收起详情" : "展开详情"}
          onClick={toggle}
          onTouchStart={onHandleTouchStart}
          onTouchEnd={onHandleTouchEnd}
        >
          <span className="bar" aria-hidden="true" />
        </button>
        <div className="detail-sheet-summary">
          <span>
            <span className="name">{summary.name}</span>
            {summary.lines.length ? (
              <span className="sub">{summary.lines.join(" · ")}</span>
            ) : null}
          </span>
          <IconChevronRight
            size={16}
            className="i detail-sheet-chevron"
            style={expanded ? { transform: "rotate(-90deg)" } : { transform: "rotate(90deg)" }}
          />
        </div>
        <div className="detail-sheet-body">{expanded ? children : null}</div>
      </div>
    </div>
  );
}
