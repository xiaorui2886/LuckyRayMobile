import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Touch hold is discovery only. Releasing a held icon never runs its action. */
export function GraphIconButton({ label, children, onClick, disabled = false, pressed, className = '' }: {
  label: string; children: ReactNode; onClick(): void; disabled?: boolean; pressed?: boolean; className?: string;
}) {
  const id = useId(), button = useRef<HTMLButtonElement>(null), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null), held = useRef(false), moved = useRef(false);
  const [tip, setTip] = useState(false);
  const clear = () => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; };
  useEffect(() => () => clear(), []);
  useEffect(() => {
    if (!tip) return;
    const dismiss = (e: PointerEvent) => { if (!button.current?.contains(e.target as Node)) setTip(false); };
    document.addEventListener('pointerdown', dismiss, true);
    return () => document.removeEventListener('pointerdown', dismiss, true);
  }, [tip]);
  const rect = tip ? button.current?.getBoundingClientRect() : undefined;
  const portal = button.current?.closest('.st-app') || (typeof document !== 'undefined' ? document.body : null);
  return <>
    <button ref={button} type="button" className={`mg-icon-action ${className}`.trim()} aria-label={label} aria-pressed={pressed} aria-describedby={tip ? id : undefined} disabled={disabled}
      onPointerDown={e => {
        if (disabled || e.button !== 0) return;
        clear(); held.current = false; moved.current = false; start.current = { x: e.clientX, y: e.clientY };
        timer.current = setTimeout(() => { timer.current = null; held.current = true; setTip(true); }, 450);
      }}
      onPointerMove={e => { if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 8) { clear(); moved.current = true; setTip(false); } }}
      onPointerUp={() => { clear(); start.current = null; }}
      onPointerCancel={() => { clear(); moved.current = true; start.current = null; setTip(false); }}
      onContextMenu={e => { e.preventDefault(); }}
      onFocus={e => { try { if (e.currentTarget.matches(':focus-visible')) setTip(true); } catch { /* Old WebView still has the accessible name. */ } }} onBlur={() => { clear(); setTip(false); }}
      onPointerEnter={e => { if (e.pointerType === 'mouse') setTip(true); }} onPointerLeave={() => { clear(); if (!held.current) setTip(false); }}
      onClick={e => { clear(); if (held.current || moved.current) { e.preventDefault(); e.stopPropagation(); held.current = false; moved.current = false; return; } setTip(false); onClick(); }}>
      {children}
    </button>
    {tip && rect && portal && createPortal(<span id={id} role="tooltip" className="mg-action-tooltip" style={{ left: Math.max(8, Math.min(window.innerWidth - 188, rect.left + rect.width / 2 - 90)), top: Math.max(8, rect.top - 8) }}>{label}</span>, portal)}
  </>;
}
