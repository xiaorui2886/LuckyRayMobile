import { useEffect, useRef, useState, type ReactNode } from "react";
import { IconButton } from "./StillImports";
import "./swipeProgressDock.css";

/** Visual dismissal only. Deliberately has no sync coordinator/control dependency. */
export function SwipeProgressDock({ children, onDismiss }: { children: ReactNode; onDismiss: () => void }) {
  const [offset, setOffset] = useState(0), [dragging, setDragging] = useState(false), [closing, setClosing] = useState(false);
  const gesture = useRef<{id: number; x: number; y: number; axis: "pending" | "horizontal" | "vertical"} | null>(null);
  const dock = useRef<HTMLElement>(null), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissed = useRef(false), closingRef = useRef(false), suppressClick = useRef(false), callback = useRef(onDismiss);
  const touchId = useRef<number | null>(null), removeTouch = useRef<(() => void) | null>(null);
  callback.current = onDismiss;
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); removeTouch.current?.(); }, []);
  const finish = () => {
    if (!closingRef.current || dismissed.current) return;
    dismissed.current = true; if (timer.current) clearTimeout(timer.current); callback.current();
  };
  const dismiss = (direction = 1) => {
    if (closingRef.current) return;
    removeTouch.current?.(); removeTouch.current = null; touchId.current = null;
    closingRef.current = true; gesture.current = null; setDragging(false);
    const reduced = dock.current?.closest('[data-reduced="true"]') || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced) { finish(); return; }
    setClosing(true); setOffset(direction * ((dock.current?.getBoundingClientRect().width || 212) + 48));
    timer.current = setTimeout(finish, 220);
  };
  const reset = () => { removeTouch.current?.(); removeTouch.current = null; touchId.current = null; gesture.current = null; setDragging(false); setOffset(0); };
  const move = (x: number, y: number, event: {cancelable: boolean; preventDefault: () => void}) => {
    const start = gesture.current; if (!start) return;
    const dx=x-start.x, dy=y-start.y;
    if(start.axis === "pending" && Math.max(Math.abs(dx),Math.abs(dy))>7) start.axis=Math.abs(dx)>Math.abs(dy)*1.2?"horizontal":"vertical";
    if(start.axis!=="horizontal") return;
    if(event.cancelable) event.preventDefault(); suppressClick.current=true;setDragging(true);setOffset(dx);
  };
  const end = (x: number, y: number) => {
    const start=gesture.current; if(!start)return;
    const dx=x-start.x,dy=y-start.y,horizontal=start.axis!=="vertical"&&Math.abs(dx)>Math.abs(dy)*1.2;
    if(horizontal&&Math.abs(dx)>7)suppressClick.current=true;
    const threshold=Math.max(48,Math.min(80,(dock.current?.getBoundingClientRect().width||212)*.28));
    if(horizontal&&Math.abs(dx)>=threshold)dismiss(dx<0?-1:1);else reset();
  };
  return <aside ref={dock} data-no-swipe="true" className={"st-sync-dock st-swipe-progress" + (dragging ? " is-dragging" : "") + (closing ? " is-closing" : "")} aria-label="正文保存进度" style={{ transform: `translate3d(${offset}px,0,0)`, opacity: closing ? 0 : Math.max(.45, 1 - Math.abs(offset) / 330) }}
    onKeyDown={event => { if (event.key === "Enter" || event.key === " ") suppressClick.current = false; if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(); } }}
    onTransitionEnd={event => { if (event.target === event.currentTarget && event.propertyName === "transform") finish(); }}
    onClickCapture={event => { if (suppressClick.current || closingRef.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; } }}
    onTouchStart={event => {
      if(closingRef.current||event.touches.length!==1){reset();return;}
      removeTouch.current?.();const touch=event.touches[0],owner=event.currentTarget;
      touchId.current=touch.identifier;suppressClick.current=false;
      gesture.current={id:touch.identifier,x:touch.clientX,y:touch.clientY,axis:"pending"};
      // WebView 83 can cancel PointerEvents while its TouchEvent is still live.
      // A gesture-scoped non-passive listener keeps only horizontal drags owned.
      const moved=(native:TouchEvent)=>{if(native.touches.length!==1){reset();return;}const point=native.touches[0];if(point.identifier===touchId.current)move(point.clientX,point.clientY,native);};
      const multi=(native:TouchEvent)=>{if(native.touches.length!==1)reset();};
      owner.addEventListener("touchmove",moved,{passive:false});owner.ownerDocument.addEventListener("touchstart",multi,{capture:true,passive:true});
      removeTouch.current=()=>{owner.removeEventListener("touchmove",moved);owner.ownerDocument.removeEventListener("touchstart",multi,true);};
    }}
    onTouchEnd={event=>{const touch=Array.from(event.changedTouches).find(point=>point.identifier===touchId.current);if(event.touches.length||!touch){reset();return;}end(touch.clientX,touch.clientY);}}
    onTouchCancel={()=>{suppressClick.current=true;reset();}}
    onPointerDown={event => {
      if(touchId.current!==null)return;
      if (closingRef.current || event.isPrimary === false || event.button > 0) return;
      suppressClick.current = false; gesture.current = {id: event.pointerId, x: event.clientX, y: event.clientY, axis: "pending"};
    }}
    onPointerMove={event => {
      if(touchId.current!==null)return;
      const start = gesture.current; if (!start || start.id !== event.pointerId) return;
      move(event.clientX,event.clientY,event);
      if(start.axis!=="horizontal")return;
      if (!event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.setPointerCapture?.(event.pointerId);
    }}
    onPointerUp={event => {
      if(touchId.current!==null)return;
      const start = gesture.current; if (!start || start.id !== event.pointerId) return;
      end(event.clientX,event.clientY);
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture?.(event.pointerId);
    }}
    onPointerCancel={() => { if(touchId.current===null){suppressClick.current = true; reset();} }} onLostPointerCapture={() => { if (gesture.current&&touchId.current===null) reset(); }}>
    {children}
    <IconButton icon="close" label="收起保存进度，不停止同步" onClick={() => dismiss()}/>
  </aside>;
}
