// MediaZoomLayer (INTERACTION-CLOSURE-R1): pinch-zoom for the asset image
// ONLY. Scale 1x–4x + pan clamped to the image bounds; everything lives on
// the img's own transform — the AppShell, headers, sheets and buttons are
// never transformed. State resets when the layer unmounts (route exit).
import { useEffect, useRef, useState } from "react";

const MIN_SCALE = 1;
const MAX_SCALE = 4;

export function MediaZoomLayer({ src, alt }: { src: string; alt: string }) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const pinch = useRef<{ dist: number; scale: number } | null>(null);
  const pan = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const frame = useRef<HTMLDivElement>(null);

  // Reset whenever the source changes (new asset / route exit unmounts).
  useEffect(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, [src]);

  const clampOffset = (next: { x: number; y: number }, s: number) => {
    const box = frame.current?.getBoundingClientRect();
    if (!box) return next;
    const maxX = (box.width * (s - 1)) / 2;
    const maxY = (box.height * (s - 1)) / 2;
    return {
      x: Math.max(-maxX, Math.min(maxX, next.x)),
      y: Math.max(-maxY, Math.min(maxY, next.y)),
    };
  };

  const dist = (t: { length: number; [i: number]: { clientX: number; clientY: number } }) =>
    Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      pinch.current = { dist: dist(e.touches), scale };
      pan.current = null;
    } else if (e.touches.length === 1 && scale > 1) {
      pan.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, ox: offset.x, oy: offset.y };
    }
  };

  const onTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && pinch.current) {
      const ratio = dist(e.touches) / pinch.current.dist;
      const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, pinch.current.scale * ratio));
      setScale(next);
      if (next === MIN_SCALE) setOffset({ x: 0, y: 0 });
      else setOffset((o) => clampOffset(o, next));
    } else if (e.touches.length === 1 && pan.current && scale > 1) {
      const next = {
        x: pan.current.ox + (e.touches[0].clientX - pan.current.x),
        y: pan.current.oy + (e.touches[0].clientY - pan.current.y),
      };
      setOffset(clampOffset(next, scale));
    }
  };

  const onTouchEnd = () => {
    pinch.current = null;
    pan.current = null;
    if (scale <= 1.02) {
      setScale(1);
      setOffset({ x: 0, y: 0 });
    }
  };

  const onDoubleClick = () => {
    if (scale > 1) {
      setScale(1);
      setOffset({ x: 0, y: 0 });
    } else {
      setScale(2.5);
    }
  };

  return (
    <div
      ref={frame}
      data-media-zoom-layer
      style={{ width: "100%", height: "100%", overflow: "hidden", touchAction: "none" }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onDoubleClick={onDoubleClick}
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "contain",
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          transition: pinch.current ? "none" : "transform 120ms ease-out",
        }}
      />
    </div>
  );
}
