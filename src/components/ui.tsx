// UI primitives (STITCH-R6) — the R6 prototype's shared vocabulary.
//
// Presentation only: no data access, no navigation authority, no Tauri calls.
// Markup mirrors the approved prototype 1:1 (classes: row / row-art / row-main
// / row-title / row-meta / row-state / section-title / empty / empty-symbol /
// notice / sheet / opt / check) so the visuals are a migration, not a
// re-invention.
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { toastStore, type Toast } from "../services/toast";
import { overlayStack } from "../services/overlayStack";
import { IconChevronRight, IconClose } from "./icons";

/* ------------------------------------------------------------------ toasts */
export function ToastHost() {
  const items = useSyncExternalStore(
    (fn) => toastStore.subscribe(fn),
    () => toastStore.snapshot()
  );
  if (!items.length) return null;
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {items.map((t) => (
        <ToastRow key={t.id} toast={t} />
      ))}
    </div>
  );
}

function ToastRow({ toast }: { toast: Toast }) {
  return (
    <div className={`toast toast-${toast.tone}`}>
      <span className="toast-msg">{toast.message}</span>
      {toast.actionLabel && toast.onAction ? (
        <button
          className="toast-action"
          onClick={() => {
            toast.onAction?.();
            toastStore.dismiss(toast.id);
          }}
        >
          {toast.actionLabel}
        </button>
      ) : null}
      <button className="toast-x" aria-label="关闭提示" onClick={() => toastStore.dismiss(toast.id)}>
        <IconClose size={13} />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------- header */
/**
 * Root masthead (Home only — DESIGN.md §3: no root-screen hero headings, and
 * `素材 / AI / 知识 / 我的` are never repeated at the top).
 */
export function Masthead({
  title,
  status,
  action,
}: {
  title: ReactNode;
  status?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="masthead">
      <div className="masthead-copy">
        <h1>{title}</h1>
        {status ? <div className="masthead-status">{status}</div> : null}
      </div>
      {action}
    </header>
  );
}

/**
 * Pushed child-screen header: back + centred title + optional action slot.
 */
export function BackHeader({
  title,
  onBack,
  right,
  backLabel = "返回",
}: {
  title: ReactNode;
  onBack: () => void;
  right?: ReactNode;
  backLabel?: string;
}) {
  return (
    <header className="back-head">
      <button className="nav-action" aria-label={backLabel} onClick={onBack}>
        <BackGlyph />
      </button>
      <div className="back-title">{title}</div>
      {right ?? <span className="back-spacer" aria-hidden="true" />}
    </header>
  );
}

function BackGlyph() {
  return (
    <svg className="i" width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m14.5 5-7 7 7 7" />
    </svg>
  );
}

/* ------------------------------------------------------------------- search */
export function SearchField({
  value,
  onChange,
  placeholder,
  autoFocus = false,
  onSubmit,
  filterSlot,
  ariaLabel,
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  onSubmit?: () => void;
  filterSlot?: ReactNode;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <div className={"search" + (className ? " " + className : "")}>
      <svg className="i" width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="10.5" cy="10.5" r="6" />
        <path d="m15 15 5 5" />
      </svg>
      <input
        className="search-input"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder ?? "搜索"}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onSubmit?.();
          }
        }}
      />
      {value ? (
        <button className="search-clear" aria-label="清除" onClick={() => onChange("")}>
          <IconClose size={13} />
        </button>
      ) : null}
      {filterSlot}
    </div>
  );
}

/* --------------------------------------------------------------- source axis */
/** `本机 / 电脑` text tabs (DESIGN.md §9: underline, no pill container). */
export function SourceTabs<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
}: {
  items: readonly { key: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="source-tabs" role="tablist" aria-label={ariaLabel}>
      {items.map((it) => (
        <button
          key={it.key}
          role="tab"
          aria-selected={it.key === value}
          className={"source-tab" + (it.key === value ? " active" : "")}
          onClick={() => onChange(it.key)}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------- section head */
export function SectionTitle({
  title,
  action,
  meta,
}: {
  title: ReactNode;
  action?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <div className="section-title">
      <b>{title}</b>
      {meta ? <span>{meta}</span> : null}
      {action}
    </div>
  );
}

/* ------------------------------------------------------------------- rows */
/**
 * The single content row (`.row`). `leading` is a `.row-art` well; `state`
 * renders a compact `.row-state` (pending/conflict) — normal/synced rows carry
 * NO badge (DESIGN.md §10).
 */
export function Row({
  leading,
  title,
  meta,
  state,
  trailing,
  onClick,
  className = "",
}: {
  leading?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  state?: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  const interactive = typeof onClick === "function";
  const Tag: any = interactive ? "button" : "div";
  return (
    <Tag
      className={"row" + (interactive ? " tappable" : "") + (className ? " " + className : "")}
      onClick={onClick}
      {...(interactive ? { type: "button" } : {})}
    >
      {leading}
      <span className="row-main">
        <span className="row-title">{title}</span>
        {meta ? <span className="row-meta">{meta}</span> : null}
      </span>
      {state}
      {trailing ?? (interactive ? <IconChevronRight className="i row-chev" /> : null)}
    </Tag>
  );
}

/** `.row-art` well — a glyph, a gradient media placeholder, or a thumbnail. */
export function RowArt({
  children,
  media = false,
  className = "",
}: {
  children?: ReactNode;
  media?: boolean;
  className?: string;
}) {
  return <span className={"row-art" + (media ? " media" : "") + (className ? " " + className : "")}>{children}</span>;
}

/* ------------------------------------------------------------ empty states */
export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon ? <div className="empty-symbol">{icon}</div> : null}
      <b>{title}</b>
      {body ? <p>{body}</p> : null}
      {action}
    </div>
  );
}

/* ------------------------------------------------------------- inline note */
export function Notice({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "warn" | "danger";
  children: ReactNode;
}) {
  return <div className={"notice" + (tone === "neutral" ? "" : " " + tone)} role="status">{children}</div>;
}

/* -------------------------------------------------------------- bottom sheet */
export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const release = overlayStack.push(onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      release();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      className="sheet-layer"
      role="dialog"
      aria-modal="true"
      aria-label={typeof title === "string" ? title : undefined}
      onClick={(e) => {
        // Tap outside .sheet dismisses immediately
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="grab" aria-hidden="true" />
        <h3 style={{ margin: "0 0 12px", fontSize: 15 }}>{title}</h3>
        <div style={{ maxHeight: "calc(82vh - 130px)", overflowY: "auto" }}>
          {children}
        </div>
        {footer}
      </div>
    </div>
  );
}

/** Filter/selection option row (`.opt` + `.check`), never a chip cloud. */
export function OptionRow({
  label,
  hint,
  active,
  onClick,
}: {
  label: string;
  hint?: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button className="opt" onClick={onClick} aria-pressed={active}>
      <span>{label}</span>
      {hint ? <span className="opt-hint">{hint}</span> : null}
      <span className={"check" + (active ? " on" : "")} aria-hidden="true" />
    </button>
  );
}

/** Destructive confirmation: impact copy + explicit acknowledgement. */
export function ConfirmSheet({
  open,
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
  busy = false,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  const [ack, setAck] = useState(false);
  useEffect(() => {
    if (!open) setAck(false);
  }, [open]);
  return (
    <Sheet
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <div className="btn-row">
          <button className="quiet" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button className="danger-btn" disabled={!ack || busy} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      }
    >
      <p style={{ margin: "0 0 6px", fontSize: 11, lineHeight: 1.6, color: "var(--ink2)" }}>{body}</p>
      <label className="ack-row">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        <span>我已了解此操作不可撤销</span>
      </label>
    </Sheet>
  );
}
