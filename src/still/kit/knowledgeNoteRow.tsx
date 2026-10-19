// KNOWLEDGE-ORGANIZATION-R1 REPAIR-R1.1 (P1-1) — the Desktop Knowledge note
// row with the SAME #85 gesture primitives the Library rows use.
//
// The review found multi-select was wired only for Library assets: the
// Knowledge note rows in the status-slot path were plain buttons that never
// consumed selection/long-press/drag. This row reuses (does not copy) the
// ONE gesture authority (`useLongPress` from pressGesture.ts) and exposes a
// `data-note-id` hit target, so Desktop notes enter multi-select through
// long-press + drag-range exactly like assets, and the page's hit-testing
// addresses note rows instead of pretending asset tiles are Knowledge rows.

import React, { useRef } from "react";
import { Icon } from "./StillImports";
import { useLongPress } from "./pressGesture";
import type { HitSegment } from "./searchHit";

export type KnowledgeNoteRowProps = {
  title: string;
  /** The body line (the p element — "" when only metadata is known). */
  body: string;
  /** The metadata line (the small element — body preview or fallback). */
  meta: string;
  /** The raw note id (route-grade selection key + drag hit target). */
  noteId: string;
  onClick: () => void;
  /** Modal results must survive pointer-up until the native click is consumed;
   * otherwise removing the sheet retargets that click into the reader below.
   * Only for rows without long-press/selection, whose shared press path stays unchanged.
   */
  activateOnClick?: boolean;
  /** Long press enters selection mode and selects this note. */
  onLongPress?: () => void;
  /** This note is selected (drives the restrained check treatment). */
  selected?: boolean;
  /** Selection mode is active, so a tap toggles instead of opening. */
  selecting?: boolean;
  /** Move coordinates while this row's long press is held. */
  onDragSelect?: (x: number, y: number) => void;
  /** The held drag ended (finger up or teardown). */
  onDragEnd?: () => void;
  /** R1.5-D: literal title-hit segments (React rendering, never HTML). */
  titleHit?: HitSegment[];
  /** R1.5-D: the proven body/path hit line, or the truthful fallback. */
  bodyHitLine?: { kind: "hit"; segments: HitSegment[]; prefix?: string; suffix?: string } | { kind: "fallback"; text: string };
};

export function KnowledgeNoteRow({
  title, body, meta, noteId, onClick, activateOnClick = false, onLongPress, selected = false, selecting = false,
  onDragSelect, onDragEnd, titleHit, bodyHitLine,
}: KnowledgeNoteRowProps) {
  const hostRef = useRef<HTMLButtonElement | null>(null);
  // The SAME gesture adapter the tiles and Library list rows use: a short tap
  // opens (or toggles in selection mode), a held press reports its position
  // for drag-select, and the trailing click after a hold is swallowed.
  const press = useLongPress({
    enabled: Boolean(onLongPress),
    onLongPress: () => onLongPress?.(),
    onTap: () => onClick?.(),
    onDragSelect,
    onDragEnd,
    hostRef: hostRef as React.RefObject<HTMLElement | null>,
  });
  return (
    <button
      type="button"
      className={"st-note-row" + (selecting ? " is-selecting" : "") + (selected ? " is-selected" : "")}
      ref={hostRef}
      aria-pressed={selecting ? selected : undefined}
      data-note-id={noteId}
      {...(activateOnClick && !onLongPress ? { onClick } : press.handlers)}
    >
      <span className="st-knowledge-note-symbol" aria-hidden="true"><Icon name="file" size={20} /></span>
      <strong>{titleHit ? titleHit.map((s, i) => <span key={i} className={s.hit ? "st-hit" : undefined}>{s.text}</span>) : title}</strong>
      {bodyHitLine
        ? (bodyHitLine.kind === "hit"
          ? <p className="st-note-hit">{bodyHitLine.prefix?<span className="st-note-hit-prefix">{bodyHitLine.prefix}</span>:null}{bodyHitLine.segments.map((s, i) => <span key={i} className={s.hit ? "st-hit" : undefined}>{s.text}</span>)}{bodyHitLine.suffix}</p>
          : <p className="st-note-hit"><span className="st-note-nomatch">{bodyHitLine.text}</span></p>)
        : <p>{body}</p>}
      {meta ? <small><span className="st-note-meta">{meta}</span></small> : null}
      {selecting ? (
        <span className="st-note-check" aria-hidden="true">
          {selected ? (
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
              stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="m5 12.6 4.4 4.4L19 7.4" />
            </svg>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}
