// MATERIAL-LIBRARY-INSTANT-R1 REPAIR-R3 — the Library's LIST row wrapper.
//
// List rows previously had no visibility path at all: the page eagerly queued
// only a bounded window (8 near + 12 tail), so row 21+ could keep its stable
// placeholder forever. This wrapper is LIBRARY-SPECIFIC (the shared `Row` and
// its other consumers are untouched) and only reports when the row actually
// enters or approaches the viewport, so the page can request that one
// thumbnail through the same source/owner-qualified, bounded authority.

import React, { useEffect, useRef } from "react";
import { Row } from "../../presentation/still01/Still";
import { useLongPress } from "./pressGesture";

export type LibraryListRowProps = {
  title: string;
  meta: string;
  /** Source-qualified thumbnail URL; empty/undefined keeps the placeholder. */
  thumb?: string;
  onClick: () => void;
  /** Fired once, when this row becomes visible or near-visible. */
  onVisible?: () => void;
  /** REPAIR-R5: long press enters selection mode and selects this asset. */
  onLongPress?: () => void;
  /** REPAIR-R5: this row is selected (drives the restrained check treatment). */
  selected?: boolean;
  /** REPAIR-R5: selection mode is active, so a tap toggles instead of opening. */
  selecting?: boolean;
  /** R7 (B1): the asset id, exposed as data-asset-id for drag hit-testing. */
  assetId?: string;
  /** R7 (B1): move coordinates while this row's long press is held. */
  onDragSelect?: (x: number, y: number) => void;
  /** R7b: the held drag ended (finger up or teardown). */
  onDragEnd?: () => void;
  /**
   * R7c: material rows keep their art slot even before the thumbnail
   * resolves. This is the EXPLICIT request — the generic Row no longer
   * reserves any left media slot by default (R7c restored the original
   * behaviour: no thumb and no icon renders nothing, so the settings rows'
   * text sits at the original left X).
   */
  reserveThumbSpace?: boolean;
};

export function LibraryListRow({ title, meta, thumb, onClick, onVisible, onLongPress, selected = false, selecting = false, assetId, onDragSelect, onDragEnd, reserveThumbSpace = true }: LibraryListRowProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!onVisible || !hostRef.current) return;
    const el = hostRef.current;
    // Old WebViews may not expose IntersectionObserver: treat the row as
    // visible immediately rather than silently never loading its thumbnail.
    if (typeof IntersectionObserver === "undefined") {
      onVisible();
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          onVisible();
          observer.disconnect();
          return;
        }
      }
    }, { rootMargin: "300px 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [onVisible]);

  // The SAME gesture authority the grid tile uses — no second timer, and the
  // tap/long-press split behaves identically in both layouts.
  const press = useLongPress({
    enabled: Boolean(onLongPress),
    onLongPress: () => onLongPress?.(),
    onTap: () => onClick(),
    onDragSelect,
    onDragEnd,
    // R7a: the adapter's non-passive held-drag guard hangs off this element,
    // so a started drag-select cannot be stolen by the WebView's scroll.
    hostRef,
  });

  return (
    // The press handlers live on the wrapper: the shared `Row` keeps its own
    // click contract and stays untouched for every other consumer.
    <div
      ref={hostRef}
      className={(selecting ? "is-selecting" : "") + (selected ? " is-selected" : "")}
      data-asset-id={assetId}
      {...press.handlers}
    >
      <Row
        title={title}
        meta={meta}
        thumb={thumb}
        reserveThumbSlot={reserveThumbSpace}
        onClick={() => { /* activation is owned by the gesture authority */ }}
        trail={selecting ? (
          <span className="st-row-check" aria-hidden="true">
            {selected ? (
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
                stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="m5 12.6 4.4 4.4L19 7.4" />
              </svg>
            ) : null}
          </span>
        ) : undefined}
      />
    </div>
  );
}
