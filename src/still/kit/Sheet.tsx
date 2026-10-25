import { systemBarScrim } from "../../services/systemBarAppearance";
// Still Sheet — Android compatibility implementation (STILL-01.1-USER-QA-FIX-R1).
//
// Renders the EXACT authority Sheet DOM/classes/behaviour (design/
// still-01-1-authority @17039ea, ui/Still.tsx `Sheet`): no visible X, 31x4
// grip in the 88x44 target, tap-to-dismiss, distance/velocity drag dismissal,
// short drag springs back, backdrop dismiss, focus save/restore, Escape trap,
// busy lock, transitionend completion, reduced-motion fallback.
//
// The ONLY difference is the drag transport: the authority version relies on
// setPointerCapture on the grip button. On Android WebViews (83 and current)
// the browser arbitrates the gesture mid-drag and fires pointercancel, so the
// real-finger drag "follows then springs back" and never dismisses. Here the
// move/up/cancel listeners live on `window` (capture-independent) and a
// non-passive touchmove blocker stops the WebView's scroll/overscroll
// arbitration for the duration of the drag. pointercancel no longer aborts an
// already-committed drag: past the distance threshold it dismisses (the user
// clearly dragged); below it springs back.
//
// Single dismiss path: close() — guarded by `closing`, registered with the
// host's overlayStack exactly like the authority sheet. A drag completion
// never synthesizes a second click.
import { useEffect, useRef, useState } from "react";
import { dragDismissDecision } from "./sheetDrag";

export function Sheet({ title, children, onClose, footer, registerDismiss, busy = false, retainEditorFocus = false, headingSlot }: {
  title: string; children: React.ReactNode; onClose: () => void; headingSlot?: React.ReactNode;
  footer?: React.ReactNode; registerDismiss?: (f: () => void) => () => void; busy?: boolean; retainEditorFocus?: boolean;
}) {
  useEffect(() => systemBarScrim.acquire(), []);
  const ref = useRef<HTMLDivElement>(null), dismiss = useRef(onClose), busyRef = useRef(busy);
  const keepInput = useRef(false);
  dismiss.current = onClose; busyRef.current = busy;
  const [shown, setShown] = useState(false), [drag, setDrag] = useState(0), [dragging, setDragging] = useState(false);
  const start = useRef<{ y: number; t: number; pointer: number } | null>(null), closing = useRef(false), done = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null), suppressClick = useRef(false), suppressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function finish() { if (!closing.current || done.current) return; done.current = true; if (timer.current) clearTimeout(timer.current); dismiss.current(); }
  function close() {
    if (busyRef.current || closing.current) return;
    closing.current = true; setDragging(false); setShown(false);
    const app = ref.current?.closest(".st-app");
    const reduce = app?.getAttribute("data-reduced") === "true" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    timer.current = setTimeout(finish, reduce ? 1 : 300); // fallback only; transitionend normally completes it
  }

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    // Android IMEs can hold candidates before any DOM composition event.
    // Formatting is an editor command, not a new input connection. Other
    // sheets keep their original modal autofocus; native IME insets do not change.
    keepInput.current = Boolean(retainEditorFocus && before?.closest(".st-note-editor"));
    const r = requestAnimationFrame(() => { setShown(true); if (!keepInput.current && !ref.current?.contains(document.activeElement)) ref.current?.focus({ preventScroll: true }); });
    const release = registerDismiss?.(close);
    function key(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); close(); }
      if (e.key === "Tab") {
        const f = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input,textarea,select,a[href],[tabindex="0"]') || []).filter((x) => x.offsetParent !== null);
        if (!f.length) { e.preventDefault(); return; }
        const first = f[0], last = f[f.length - 1], current = document.activeElement;
        if (!f.includes(current as HTMLElement)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
        else if (e.shiftKey && current === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && current === last) { e.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener("keydown", key, true);
    return () => {
      cancelAnimationFrame(r); if (timer.current) clearTimeout(timer.current); if (suppressTimer.current) clearTimeout(suppressTimer.current);
      release?.(); document.removeEventListener("keydown", key, true);
      if (before?.isConnected && !before.closest('[aria-hidden="true"]')) before.focus({ preventScroll: true });
    };
  }, []);

  // Compat drag transport: window-level tracking + touchmove arbitration lock.
  useEffect(() => {
    const handle = ref.current?.querySelector<HTMLElement>(".st-sheet-handle");
    if (!handle) return;

    function onPointerDown(e: PointerEvent) {
      if (busyRef.current || closing.current || (e.button ?? 0) > 0) return;
      suppressClick.current = false;
      start.current = { y: e.clientY, t: performance.now(), pointer: e.pointerId };
      setDragging(true);
    }
    function onPointerMove(e: PointerEvent) {
      const s = start.current;
      if (!s || s.pointer !== e.pointerId) return;
      const dy = Math.max(0, e.clientY - s.y);
      if (dy > 4) suppressClick.current = true;
      setDrag(dy);
    }
    function onPointerUp(e: PointerEvent) {
      const s = start.current;
      if (!s || s.pointer !== e.pointerId) return;
      const dy = e.clientY - s.y, dt = performance.now() - s.t;
      start.current = null; setDragging(false);
      if (dragDismissDecision(Math.max(0, dy), dt) === "dismiss") close(); else setDrag(0);
      if (suppressTimer.current) clearTimeout(suppressTimer.current);
      suppressTimer.current = setTimeout(() => { suppressClick.current = false; }, 0);
    }
    function onPointerCancel(e: PointerEvent) {
      const s = start.current;
      if (!s || s.pointer !== e.pointerId) return;
      const dy = Math.max(0, lastY.current - s.y), dt = performance.now() - s.t;
      start.current = null; setDragging(false);
      // Gesture arbitration cancelled us: dismiss only an already-committed
      // drag; a short cancelled drag springs back (never an accidental close).
      if (dragDismissDecision(dy, dt, true) === "dismiss") close(); else setDrag(0);
    }
    // Track the last client Y so a cancelled gesture can still be measured.
    const lastY = { current: 0 };
    function trackY(e: PointerEvent) { lastY.current = e.clientY; }
    function blockTouchScroll(e: TouchEvent) {
      if (start.current) e.preventDefault(); // passive:false — stops WebView scroll/overscroll arbitration
    }

    handle.addEventListener("pointerdown", onPointerDown);
    handle.addEventListener("pointermove", onPointerMove);
    handle.addEventListener("pointermove", trackY);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointermove", trackY);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    handle.addEventListener("touchmove", blockTouchScroll, { passive: false });
    window.addEventListener("touchmove", blockTouchScroll, { passive: false });
    return () => {
      handle.removeEventListener("pointerdown", onPointerDown);
      handle.removeEventListener("pointermove", onPointerMove);
      handle.removeEventListener("pointermove", trackY);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointermove", trackY);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      handle.removeEventListener("touchmove", blockTouchScroll);
      window.removeEventListener("touchmove", blockTouchScroll);
    };
  }, []);

  return <div className={"st-modal" + (shown ? " is-shown" : "") + (closing.current ? " is-closing" : "")}>
    <div className="st-scrim" onClick={close} aria-hidden="true" />
    <div ref={ref} className={"st-sheet" + (dragging ? " is-dragging" : "")} role="dialog" tabIndex={-1} aria-modal={keepInput.current ? undefined : true} aria-label={title} aria-busy={busy || undefined}
      onPointerDownCapture={(e) => { if (keepInput.current) e.preventDefault(); }}
      onMouseDownCapture={(e) => { if (keepInput.current) e.preventDefault(); }}
      onTransitionEnd={(e) => { if (e.target === e.currentTarget && e.propertyName === "transform") finish(); }}
      style={{ transform: shown ? `translateY(${drag}px)` : "translateY(105%)" }}>
      <div className="st-sheet-grip">
        <button className="st-sheet-handle" type="button" aria-label={"收起" + title} disabled={busy}
          onClick={() => { if (!suppressClick.current) close(); }}>
          <i aria-hidden="true" />
        </button>
      </div>
      <div className="st-sheet-heading">{headingSlot ?? <h2>{title}</h2>}</div>
      <div className="st-sheet-body">{children}</div>
      {footer && <div className="st-sheet-footer">{footer}</div>}
    </div>
  </div>;
}
