import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Keeps the inline bitmap and reader scroll untouched while inspecting media. */
export function NoteImagePreview({ source, label, registerOverlay }: {
  source: string; label: string; registerOverlay?: (dismiss: () => void) => () => void;
}) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { setFailed(false); setOpen(false); }, [source]);
  useEffect(() => {
    if (!open) return;
    const element = dialog.current;
    const nativeModal = typeof element?.showModal === "function";
    if (nativeModal) element!.showModal();
    else { element?.setAttribute("open", ""); element?.setAttribute("data-modal-fallback", "true"); }
    // Older embedded engines can lack the dialog API. Keep a keyboard exit and
    // focus containment without assuming native support.
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); }
      if (!nativeModal && event.key === "Tab") {
        event.preventDefault(); element?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
      }
    };
    if (!nativeModal) element?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    document.addEventListener("keydown", keydown, true);
    const unregister = registerOverlay?.(() => setOpen(false));
    return () => {
      unregister?.(); document.removeEventListener("keydown", keydown, true);
      if (typeof element?.close === "function") element.close(); else element?.removeAttribute("open");
      // Do not scroll the reading pane back to the trigger on dismissal.
      trigger.current?.focus({ preventScroll: true });
    };
  }, [open, registerOverlay]);
  return <>
    <button ref={trigger} type="button" className="st-note-image-trigger" aria-label={`预览图片：${label}`}
      aria-haspopup="dialog" onClick={event => { event.stopPropagation(); setOpen(true); }}>
      <img src={source} alt={label} onError={() => setFailed(true)} />
    </button>
    {failed ? <span role="status">图片暂时无法显示，请检查文件后重试。</span> : null}
    {open && typeof document !== "undefined" ? createPortal(<dialog ref={dialog} className="st-note-image-dialog" role="dialog" aria-modal="true" aria-label={`图片预览：${label}`}
      onCancel={event => { event.preventDefault(); setOpen(false); }}
      onClick={event => { event.stopPropagation(); if (event.target === event.currentTarget) setOpen(false); }}>
      <header><span>{label}</span><button type="button" autoFocus onClick={() => setOpen(false)} aria-label="关闭图片预览">关闭</button></header>
      <img src={source} alt={label} />
    </dialog>, document.body) : null}
  </>;
}
