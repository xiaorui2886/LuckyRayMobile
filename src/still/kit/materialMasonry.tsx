import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { MediaKind } from "./mediaTilePure";
import "./materialMasonry.css";

type Item = {id: string; width?: number; height?: number; kind: MediaKind; excerpt?: string};

// Place each next asset into the shortest column. The DOM and detail-view
// sequence remain in the server's order; appending a page never rebalances
// existing columns as CSS columns would.
export function materialMasonryLayout(items: readonly Item[], width: number) {
  const columns = width >= 680 ? 3 : 2;
  const gap = 10, tileWidth = Math.max(1, (width - gap * (columns - 1)) / columns);
  const bottoms = Array(columns).fill(0) as number[];
  const positions = items.map(item => {
    const ratio = item.width && item.height && item.width > 0 && item.height > 0
      ? Math.max(.35, Math.min(2.4, item.width / item.height))
      : item.excerpt ? .78 : ["document", "audio", "other"].includes(item.kind) ? .65 : item.kind === "video" ? 16 / 10 : 1;
    const column = bottoms.indexOf(Math.min(...bottoms));
    const height = tileWidth / ratio, top = bottoms[column];
    bottoms[column] += height + gap;
    return {id:item.id, left:column * (tileWidth + gap), top, width:tileWidth, height};
  });
  return {positions, height:Math.max(0, ...bottoms) - (items.length ? gap : 0)};
}

export function MaterialMasonry({items, renderItem}: {items: readonly Item[]; renderItem: (index:number) => ReactNode}) {
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(300);
  const layout = useMemo(() => materialMasonryLayout(items, width), [items, width]);
  const previous = useRef<typeof layout | null>(null);
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const measure = () => { if (element.clientWidth > 0) setWidth(element.clientWidth); };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const element = host.current, old = previous.current;
    previous.current = layout;
    const scroll = element?.closest<HTMLElement>(".st-scroll");
    if (!element || !scroll || !old || old.positions[0]?.id !== layout.positions[0]?.id) return;
    const viewportTop = scroll.getBoundingClientRect().top - element.getBoundingClientRect().top;
    if (viewportTop <= 0) return;
    const anchor = old.positions.find(item => item.top + item.height > viewportTop);
    const next = anchor && layout.positions.find(item => item.id === anchor.id);
    if (anchor && next && Math.abs(next.top - anchor.top) > 1) scroll.scrollTop += next.top - anchor.top;
  }, [layout]);
  return <div className="st-material-masonry" ref={host} style={{height:layout.height}}>
    {layout.positions.map((position, index) => <div key={position.id} className="st-material-masonry-cell" style={{left:position.left,top:position.top,width:position.width,height:position.height}}>{renderItem(index)}</div>)}
  </div>;
}
