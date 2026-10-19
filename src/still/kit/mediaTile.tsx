// MATERIAL-LIBRARY-INSTANT-R1 — the product media tile.
//
// The previous markup rendered `<img src={a.src} />` unconditionally, so an
// empty source or a failed decode produced the WebView's broken-image glyph
// (plus filename/alt), which is what users saw. This tile guarantees a stable
// product art state instead:
//
//   - no usable src  -> placeholder art, NO <img> at all;
//   - image onError  -> hide the failed image, keep the tile geometry, fall
//     back to product art, and re-query the EXISTING thumbnail authority at
//     most ONCE (never an unbounded retry loop);
//   - the tile keeps its box while bytes resolve, so thumbnails arriving late
//     cannot make the grid jump.
//
// It owns no cache: thumbnails are supplied by the caller (source-qualified)
// and the retry asks that same authority again.

import React, { useEffect, useState } from "react";

export type { MediaKind } from "./mediaTilePure";
export { mediaPlaceholderLabel, shouldRenderImage } from "./mediaTilePure";
import { mediaPlaceholderLabel, shouldRenderImage, type MediaKind } from "./mediaTilePure";
import { useLongPress } from "./pressGesture";

export type MediaTileProps = {
  title: string;
  /** Source-qualified thumbnail URL; "" means "not available yet". */
  src: string;
  kind: MediaKind;
  meta: string;
  /** One bounded re-query of the existing thumbnail authority. */
  onRetry?: () => void;
  /** Fired when the tile becomes (near-)visible — used for viewport-first work. */
  onVisible?: () => void;
  onClick?: () => void;
  /** REPAIR-R5: long press enters selection mode and selects this asset. */
  onLongPress?: () => void;
  /** REPAIR-R5: this tile is selected (drives the restrained check treatment). */
  selected?: boolean;
  /** REPAIR-R5: selection mode is active, so a tap toggles instead of opening. */
  selecting?: boolean;
  /** R7 (B1): the asset id, exposed as data-asset-id for drag hit-testing. */
  assetId?: string;
  /** R7 (B1): move coordinates while this tile's long press is held. */
  onDragSelect?: (x: number, y: number) => void;
  /** R7b: the held drag ended (finger up or teardown). */
  onDragEnd?: () => void;
};

export function MediaTile({ title, src, kind, meta, onRetry, onVisible, onClick, onLongPress, selected = false, selecting = false, assetId, onDragSelect, onDragEnd }: MediaTileProps) {
  const [failed, setFailed] = useState(false);
  const [retried, setRetried] = useState(false);
  // REPAIR-R2 (3B): a retry can legitimately return the SAME uri as before (the
  // native authority may hand back the same cache path). React would then keep
  // the <img> unchanged and the failure would stick, so each attempt carries its
  // own generation used as the element key: a forced re-attempt remounts the
  // image even when the URL is byte-identical.
  const [attempt, setAttempt] = useState(0);
  const hostRef = React.useRef<HTMLDivElement | null>(null);

  // REPAIR-R3 (3): the retry budget belongs to the LOGICAL TILE, not to the
  // current URL string. The forced refetch deliberately cycles the source
  // X -> "" -> X, which used to re-run a `[src]` effect and hand the tile a
  // fresh budget — so a persistently broken thumbnail could force refetch
  // forever. Only a genuinely different content identity may reset it.
  const contentKey = `${title}|${kind}|${meta}`;

  // A NEW logical tile is a new attempt: clear the previous failure (and the
  // retry budget) so a later successful thumbnail is not masked by an old error.
  useEffect(() => {
    setFailed(false);
    setRetried(false);
    setAttempt(0);
  }, [contentKey]);

  // A changed URL is a new attempt for THIS tile: the previous failure flag is
  // cleared so a recovered URL can render, but the one-retry budget is kept.
  useEffect(() => {
    setFailed(false);
  }, [src]);

  useEffect(() => {
    if (!onVisible || !hostRef.current) return;
    const el = hostRef.current;
    // IntersectionObserver is unavailable on some old WebViews: treat the tile
    // as immediately visible instead of silently never starting its work.
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
    }, { rootMargin: "200px 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [onVisible]);

  const showImage = shouldRenderImage(src, failed);

  // The gesture is ALWAYS active, so a short tap opens the asset on every
  // source. `onLongPress` being absent (the Local source, which has no
  // multi-select) only means there is no long press to arm — it must NOT
  // disable the tap, which is the tile's entire activation path.
  const press = useLongPress({
    enabled: Boolean(onLongPress),
    onLongPress: () => onLongPress?.(),
    onTap: () => onClick?.(),
    onDragSelect,
    onDragEnd,
    // R7a: the adapter's non-passive held-drag guard hangs off this element,
    // so a started drag-select cannot be stolen by the WebView's scroll.
    hostRef: hostRef as React.RefObject<HTMLElement | null>,
  });

  return (
    <button
      type="button"
      className={"st-media-tile" + (selecting ? " is-selecting" : "") + (selected ? " is-selected" : "")}
      ref={hostRef as never}
      aria-pressed={selecting ? selected : undefined}
      data-asset-id={assetId}
      {...press.handlers}
    >
      <div className="st-media-art" data-state={showImage ? "image" : "placeholder"}>
        {showImage ? (
          // REPAIR-R6 (2): the thumbnail is a purely VISUAL layer. A real
          // <img> used to intercept the long press on old WebViews (drag ghost
          // / copy-image callout), which is why image and video tiles could
          // not enter multi-select while document placeholders could. The
          // attributes here pair with the CSS (pointer-events/drag/callout);
          // the parent tile owns the whole gesture, and onError still works —
          // decode failures are not pointer events.
          <img
            src={src}
            alt={title}
            loading="lazy"
            decoding="async"
            draggable={false}
            onDragStart={(e) => { e.preventDefault(); }}
            key={`attempt-${attempt}`}
            onError={() => {
              setFailed(true);
              // ONE bounded retry through the existing thumbnail authority; the
              // attempt generation lets the re-resolved URL actually render.
              if (!retried && onRetry) {
                setRetried(true);
                setAttempt((n) => n + 1);
                onRetry();
              }
            }}
          />
        ) : (
          <span className="st-media-placeholder" aria-hidden="true">
            {mediaPlaceholderLabel(kind)}
          </span>
        )}
        {kind !== "image" ? (
          <span className="st-media-type">{kind === "video" ? "视频" : "文档"}</span>
        ) : null}
        {/* Selection is expressed by a check mark over the art, never by a
            border or a colour fill on the card itself. */}
        {selecting ? (
          <span className="st-tile-check" aria-hidden="true">
            {selected ? (
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
                stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="m5 12.6 4.4 4.4L19 7.4" />
              </svg>
            ) : null}
          </span>
        ) : null}
      </div>
      <strong>{title}</strong>
      <small>{meta}</small>
    </button>
  );
}
