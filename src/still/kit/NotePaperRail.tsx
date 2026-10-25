import {createContext,useContext,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {paperAxis,paperDragOffset,paperSettleSide,paperSideOffset,paperSettleDuration,type PaperSide} from './notePaperGesture';
import {suppressTrailingSwipeClick} from './useHorizontalSwipe';
import {preserveNoteViewportNavigation} from '../../presentation/still01/editor/noteViewportStability';
import './noteSidePanel.css';

type RailContext={left:HTMLElement|null;right:HTMLElement|null;dragging:()=>boolean;preserveEditorFocus:()=>boolean;close:()=>void};
const Context=createContext<RailContext|null>(null);
export const useNotePaperRail=()=>useContext(Context);
/** One translated strip: left sidebar | unchanged note | right sidebar.
 * The editor stays mounted, including its IME, selection and scroll owners.
 * Native non-passive touch listeners are intentional: React's delegated touch
 * transport may be passive on Android WebView and cannot claim the gesture. */
export function NotePaperRail({panel,onPanelChange,disabled=false,children}:{panel:PaperSide;onPanelChange:(side:PaperSide)=>void;disabled?:boolean;children:ReactNode}){
 const viewport=useRef<HTMLDivElement>(null),track=useRef<HTMLDivElement>(null);
 const [left,setLeft]=useState<HTMLDivElement|null>(null),[right,setRight]=useState<HTMLDivElement|null>(null);
 const state=useRef({panel,disabled,onPanelChange});state.current={panel,disabled,onPanelChange};
 const width=useRef(0),offset=useRef(0),active=useRef(false),composing=useRef(false),touchOpened=useRef(false);
 const lastPanel=useRef<PaperSide>(panel),cancelGesture=useRef<(external?:PaperSide)=>void>(()=>{}),closeTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
 const reducedMotion=()=>Boolean(viewport.current?.closest('.st-app[data-reduced="true"]'))||Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
 const paint=(value:number,animate=false)=>{const duration=animate?paperSettleDuration(value-offset.current,width.current,reducedMotion()):0;offset.current=value;if(track.current){track.current.style.transition=duration?`transform ${duration}ms cubic-bezier(.2,.8,.2,1)`:'none';track.current.style.transform=`translate3d(${value}px,0,0)`}return duration};
 const close=()=>{if(closeTimer.current)return;const duration=paint(0,true);if(!duration){closeTimer.current=null;state.current.onPanelChange(null);return;}closeTimer.current=setTimeout(()=>{closeTimer.current=null;state.current.onPanelChange(null)},duration)};
 useLayoutEffect(()=>{
  const root=viewport.current;if(!root)return;
  const measure=()=>{const nextWidth=Math.min(root.getBoundingClientRect().width*.86,360);
   // Keyboard/visual-viewport height changes do not change this horizontal rail.
   // Avoid interrupting a drag or snapping a closing panel open on those resizes.
   if(Math.abs(nextWidth-width.current)<.5)return;
   if(active.current)cancelGesture.current(state.current.panel);
   width.current=nextWidth;root.style.setProperty('--st-note-panel-width',`${width.current}px`);
   if(closeTimer.current){clearTimeout(closeTimer.current);closeTimer.current=null;lastPanel.current=null;paint(0);state.current.onPanelChange(null);}
   else if(!active.current)paint(paperSideOffset(state.current.panel,width.current));
  };
  measure();const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(measure);observer?.observe(root);window.addEventListener('resize',measure);
  let gesture:{transport:'touch'|'pointer';id:number;x:number;y:number;at:number;origin:PaperSide;originX:number;locked:boolean;lastX:number;lastAt:number;velocity:number;side:PaperSide;scrollOwners:{min:number;max:number;start:number}[]}|null=null;
  let releaseTouchTarget=()=>{};
  const selected=()=>{const selection=root.ownerDocument.getSelection();return Boolean(selection&&!selection.isCollapsed&&selection.toString())};
  const end=(cancelled=false,external?:PaperSide)=>{
   const g=gesture;gesture=null;active.current=false;releaseTouchTarget();if(!g)return;
   if(!g.locked)return;
   root.classList.remove('is-dragging');
   const velocity=performance.now()-g.lastAt>90?0:g.velocity;
   const next=external!==undefined?external:cancelled||state.current.disabled?g.origin:paperSettleSide(g.origin,offset.current,width.current,velocity);
   suppressTrailingSwipeClick(root.ownerDocument);
   lastPanel.current=next;
   if(external===undefined&&next===null&&state.current.panel!==null&&!cancelled&&!state.current.disabled)close();
   else {paint(paperSideOffset(next,width.current),true);if(external===undefined)state.current.onPanelChange(next);}
   // A paper swipe is not a focus/navigation command. Moving focus to the
   // drawer would blur CM, rebuild active code marks and reopen IME on return.
  };
  cancelGesture.current=external=>end(true,external);
  const begin=(target:EventTarget|null,x:number,y:number,id:number,transport:'touch'|'pointer')=>{
   if(gesture)end(true);else releaseTouchTarget();
   if(state.current.disabled||composing.current||selected()||!(target instanceof Element))return;
   if(target.closest('[data-swipe-owner]')!==root)return;
   const bounds=root.getBoundingClientRect();
   // Leave Android's extreme system-back edges to the OS.
   if(x-bounds.left<12||bounds.right-x<12)return;
   if(target.closest('input,textarea,select,video,audio,[role="slider"],[data-no-swipe],.cm-lp-table-menu,[data-table-grip],.st-editor-tools'))return;
   if(target.closest('button,a')&&!target.closest('.is-paper-panel,.st-note-paper-return'))return;
   // Decide ownership only once direction is known. Remember start offsets so
   // a native pan that reaches its edge mid-gesture cannot become navigation.
   const scrollOwners:{min:number;max:number;start:number}[]=[];
   for(let node:Element|null=target;node&&node!==root;node=node.parentElement){
    const el=node as HTMLElement,style=getComputedStyle(el),extent=el.scrollWidth-el.clientWidth;
    if(extent>2&&['auto','scroll'].includes(style.overflowX)){
     const rtl=style.direction==='rtl';scrollOwners.push({min:rtl?-extent:0,max:rtl?0:extent,start:el.scrollLeft});
    }
   }

   const now=performance.now();gesture={transport,id,x,y,at:now,origin:state.current.panel,originX:offset.current,locked:false,lastX:x,lastAt:now,velocity:0,side:state.current.panel,scrollOwners};
   if(transport==='touch'&&target!==root){
    // Touch events retain their original target, even if a legitimate async
    // source/preview update disconnects that node. The ancestor path then no
    // longer includes the rail, so retain this stream on its actual target.
    // Connected events are claimed by the root capture listener only once.
    target.addEventListener('touchmove',touchMove as EventListener,{capture:true,passive:false});
    target.addEventListener('touchend',touchEnd as EventListener,true);
    target.addEventListener('touchcancel',touchCancel,true);
    releaseTouchTarget=()=>{target.removeEventListener('touchmove',touchMove as EventListener,true);target.removeEventListener('touchend',touchEnd as EventListener,true);target.removeEventListener('touchcancel',touchCancel,true);releaseTouchTarget=()=>{}};
   }
  };
  const move=(x:number,y:number,event:Event)=>{
   const g=gesture;if(!g)return;
   if(state.current.disabled||composing.current||(!g.locked&&selected())){end(true);return;}
   const now=performance.now(),dx=x-g.x,dy=y-g.y;
   if(!g.locked){if(now-g.at>360){end(true);return;}const axis=paperAxis(dx,dy,now-g.at);if(axis==='y'||axis==='cancel'){end(true);return;}if(axis!=='x')return;
    if(g.scrollOwners.some(owner=>dx>0?owner.start>owner.min+2:owner.start<owner.max-2)){end(true);return;}
    if(closeTimer.current){clearTimeout(closeTimer.current);closeTimer.current=null;}
   if(track.current){const transform=getComputedStyle(track.current).transform;const values=transform.match(/^matrix(3d)?\((.+)\)$/);if(values){const numbers=values[2].split(',').map(Number);const x=numbers[values[1]?12:4];if(Number.isFinite(x))paint(x);}}
    g.originX=offset.current;
    const note=root.querySelector<HTMLElement>('.st-note-surface');if(note)preserveNoteViewportNavigation(note);
    g.locked=true;active.current=true;if(!g.origin)touchOpened.current=true;root.classList.add('is-dragging');
    const side=g.origin??(dx>0?'left':'right');g.side=side;lastPanel.current=side;state.current.onPanelChange(side);
   }
   if(event.cancelable)event.preventDefault();event.stopPropagation();
   const dt=now-g.lastAt;if(dt>0)g.velocity=(x-g.lastX)/dt;g.lastX=x;g.lastAt=now;
   // Reverse through the center is allowed, but never switch side contents mid-drag.
   const value=paperDragOffset(g.originX,dx,width.current);paint(g.side==='left'?Math.max(0,value):Math.min(0,value));
  };
  const touchStart=(event:TouchEvent)=>{if(event.touches.length!==1){end(true);return;}const t=event.touches[0];begin(event.target,t.clientX,t.clientY,t.identifier,'touch')};
  const touchMove=(event:TouchEvent)=>{if(event.touches.length!==1){end(true);return;}const g=gesture;if(g?.transport!=='touch')return;const t=Array.from(event.touches).find(t=>t.identifier===g.id);if(t)move(t.clientX,t.clientY,event)};
  const touchEnd=(event:TouchEvent)=>{if(gesture?.transport==='touch'){if(event.touches.length){end(true);return;}end(false)}};
  const touchCancel=()=>{if(gesture?.transport==='touch')end(true)};
  const pointerCancel=()=>{if(gesture?.transport==='pointer')end(true)};
  const down=(event:PointerEvent)=>{if(event.pointerType==='touch'||event.pointerType==='mouse')return;if(!event.isPrimary||event.button!==0){end(true);return;}begin(event.target,event.clientX,event.clientY,event.pointerId,'pointer')};
  const pointerMove=(event:PointerEvent)=>{if(gesture?.transport==='pointer'&&gesture.id===event.pointerId)move(event.clientX,event.clientY,event)};
  const up=(event:PointerEvent)=>{if(gesture?.transport==='pointer'&&gesture.id===event.pointerId)end(false)};
  const compositionStart=()=>{composing.current=true;end(true)},compositionEnd=()=>{composing.current=false};
  root.addEventListener('touchstart',touchStart,{capture:true,passive:true});root.addEventListener('touchmove',touchMove,{capture:true,passive:false});root.addEventListener('touchend',touchEnd,true);root.addEventListener('touchcancel',touchCancel,true);
  root.addEventListener('pointerdown',down,true);root.addEventListener('pointermove',pointerMove,true);root.addEventListener('pointerup',up,true);root.addEventListener('pointercancel',pointerCancel,true);
  root.addEventListener('compositionstart',compositionStart,true);root.addEventListener('compositionend',compositionEnd,true);
  return()=>{releaseTouchTarget();if(closeTimer.current)clearTimeout(closeTimer.current);gesture=null;active.current=false;observer?.disconnect();window.removeEventListener('resize',measure);root.removeEventListener('touchstart',touchStart,true);root.removeEventListener('touchmove',touchMove,true);root.removeEventListener('touchend',touchEnd,true);root.removeEventListener('touchcancel',touchCancel,true);root.removeEventListener('pointerdown',down,true);root.removeEventListener('pointermove',pointerMove,true);root.removeEventListener('pointerup',up,true);root.removeEventListener('pointercancel',pointerCancel,true);root.removeEventListener('compositionstart',compositionStart,true);root.removeEventListener('compositionend',compositionEnd,true)};
 },[]);
 useLayoutEffect(()=>{if(closeTimer.current){clearTimeout(closeTimer.current);closeTimer.current=null;}if(active.current){if(disabled||panel!==lastPanel.current)cancelGesture.current(panel);return;}lastPanel.current=panel;if(panel===null)touchOpened.current=false;const target=paperSideOffset(panel,width.current);if(target!==offset.current)paint(target,true)},[panel,disabled]);
 return <Context.Provider value={{left,right,dragging:()=>active.current,preserveEditorFocus:()=>touchOpened.current,close}}><div ref={viewport} className="st-note-paper-viewport" data-swipe-owner="note-paper" data-panel={panel||'none'}>
  <div ref={track} className="st-note-paper-track"><div ref={setLeft} className="st-note-paper-side side-left"/><div className="st-note-paper-page">{children}{panel?<button className="st-note-paper-return" aria-label="返回笔记" onClick={close}/>:null}</div><div ref={setRight} className="st-note-paper-side side-right"/></div>
 </div></Context.Provider>;
}
