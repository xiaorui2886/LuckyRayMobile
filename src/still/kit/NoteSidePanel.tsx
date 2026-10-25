import { useEffect, useRef, type ReactNode } from "react";
import {createPortal} from "react-dom";
import {useNotePaperRail} from "./NotePaperRail";
import { IconButton } from "./StillImports";
import { systemBarScrim } from "../../services/systemBarAppearance";
import { useHorizontalSwipe } from "./useHorizontalSwipe";
import "./noteSidePanel.css";

export function NoteSidePanel({ side, title, children, footer, onClose, registerOverlay }: {
  side: "left" | "right"; title: string; children: ReactNode; footer?: ReactNode;
  onClose: () => void; registerOverlay: (close: () => void) => () => void;
}) {
  const rail = useNotePaperRail();
  const panel = useRef<HTMLDivElement>(null), close = useRef(onClose); close.current = rail ? rail.close : onClose;
  // Either horizontal return gesture closes the panel; no hidden second layer.
  const gesture = useHorizontalSwipe(() => close.current());
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const unregister = registerOverlay(() => close.current());
    const releaseScrim = rail ? () => {} : systemBarScrim.acquire();
    // Keep the retained editor's focus/IME and live-preview geometry during a
    // paper gesture. Keyboard/button openings still receive dialog focus.
    const preserveEditorFocus = Boolean(rail?.preserveEditorFocus());
    if (!preserveEditorFocus && !rail?.dragging()) panel.current?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); close.current(); }
      if (event.key !== "Tab") return;
      const nodes = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,textarea,a[href],[tabindex="0"]') || []).filter(node => !node.closest('[hidden]'));
      if (!nodes.length) { event.preventDefault(); return; }
      const i = nodes.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && i <= 0) { event.preventDefault(); nodes[nodes.length - 1].focus({ preventScroll: true }); }
      else if (!event.shiftKey && (i < 0 || i === nodes.length - 1)) { event.preventDefault(); nodes[0].focus({ preventScroll: true }); }
    };
    document.addEventListener("keydown", key, true);
    return () => { unregister(); releaseScrim(); document.removeEventListener("keydown", key, true); if (!preserveEditorFocus && before?.isConnected) before.focus({ preventScroll: true }); };
  }, []);
  const content = <div className={'st-note-drawer-layer side-' + side + (rail ? ' is-paper-panel' : '')}>
    {!rail ? <button type="button" className="st-note-drawer-scrim" aria-label="返回笔记" onClick={() => close.current()} /> : null}
    <aside ref={panel} className="st-note-drawer" role="dialog" aria-modal={rail ? undefined : true} aria-label={title} tabIndex={-1} data-swipe-owner={rail ? undefined : "note-panel"} {...(rail ? {} : gesture)}>
      <header className="st-note-drawer-heading"><h2>{title}</h2><IconButton icon={side === "left" ? "back" : "right"} label="返回笔记" onClick={() => close.current()} /></header>
      <div className="st-note-drawer-body">{children}</div>
      {footer ? <footer className="st-note-drawer-footer">{footer}</footer> : null}
    </aside>
  </div>;
  const target = rail?.[side];
  return rail ? target ? createPortal(content, target) : null : content;
}
