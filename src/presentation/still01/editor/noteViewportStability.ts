import {useLayoutEffect,type RefObject} from 'react';
import {nativeTextareaCaretRect} from './nativeTextareaCaret';
import {noteTailSpace,tailRevealDelta,type TailCaret} from './noteTailClearance';

/** One viewport owner for title, fallback textarea, source and live preview.
 * Caret visibility is not navigation. In particular, an IME resize never
 * alone authorizes neither the body scroller nor its paper ancestor to move.
 * A narrowly authorized tail-only occluded-caret reveal is also owned here.
 * A real drag/wheel releases the lock immediately, including inertia. */
export class NoteViewportStability {
 private locked=false;
 private frame=0;
 private dead=false;
 private pointer:{x:number;y:number;editable:boolean}|null=null;
 private measureViewport:(()=>void)|null=null;
 private tailProvider:(()=>TailCaret|null)|null=null;
 private timer:ReturnType<typeof setTimeout>|undefined;
 private animation=0;
 private pendingUntil=0;
 private expectedTop:number|null=null;
 private closedHeight=0;
 private keyboard=0;
 private width=0;
 private observer:ResizeObserver|undefined;
 private mutations:MutationObserver|undefined;
 private motion:MediaQueryList|undefined;
 setTailProvider(provider:(()=>TailCaret|null),measureViewport?:()=>void){if(this.tailProvider)this.cancelTail();this.tailProvider=provider;this.measureViewport=measureViewport||null;return()=>{if(this.tailProvider===provider){this.tailProvider=null;this.measureViewport=null;this.cancelTail()}}}
 private cancelTail=()=>{this.pendingUntil=0;if(this.timer)clearTimeout(this.timer);this.timer=undefined;if(this.animation)cancelAnimationFrame(this.animation);this.animation=0;this.expectedTop=null};
 private active=()=>!this.dead&&this.root.dataset.viewportBlocked!=='true'&&!this.root.closest('[data-current="false"]')&&!this.root.ownerDocument.querySelector('[role="dialog"],[aria-modal="true"],[role="menu"]');
 private metrics=()=>{
  const win=this.root.ownerDocument.defaultView!,rect=this.root.getBoundingClientRect(),visual=win.visualViewport;
  const height=Math.min(rect.height||win.innerHeight,visual?.height||win.innerHeight);
  if(Math.abs(win.innerWidth-this.width)>80){this.cancelTail();this.width=win.innerWidth;this.closedHeight=height;this.keyboard=0}
  this.closedHeight=Math.max(this.closedHeight,height);
  const lost=this.closedHeight-height;if(lost>this.closedHeight*.12)this.keyboard=lost;
  const toolbar=this.root.querySelector<HTMLElement>('.st-reader-bottom');
  const painted=toolbar?.getBoundingClientRect();
  const bar=toolbar?.offsetParent===this.root?{top:rect.top+toolbar.offsetTop,height:toolbar.offsetHeight}:painted;
  const measured=toolbar&&win.getComputedStyle(toolbar).display!=='none'&&bar&&bar.height>0;
  const shown=measured&&this.root.dataset.chromeHidden!=='true';
  // Keep end breathing room stable when chrome fades out, but do not treat
  // an invisible toolbar as a real occluder.
  this.root.style.setProperty('--note-tail-clearance',`${noteTailSpace(this.closedHeight,height,measured?bar.height:0,this.keyboard)}px`);
  let bottom=Math.min(rect.bottom||win.innerHeight,(visual?.offsetTop||0)+(visual?.height||win.innerHeight));
  const top=Math.max(rect.top,visual?.offsetTop||0);
  // Only measured current loss authorizes the tail zone. The decorative
  // spacer's fallback/remembered size is not evidence of keyboard coverage.
  // Count only toolbar pixels inside the already-clipped viewport, never the
  // keyboard overlap a second time (visualViewport coordinates are CSS px).
  const toolbarOverlap=shown?Math.max(0,Math.min(bottom,bar.top+bar.height)-Math.max(top,bar.top)):0;
  if(shown)bottom=Math.min(bottom,bar.top);
  return {top,bottom,tailRange:Math.max(0,lost)+toolbarOverlap};
 };
 private resized=()=>{this.metrics();this.restore();this.measureViewport?.();this.scheduleTail()};
 private scheduleTail=()=>{if(this.animation)return;if(this.pendingUntil<=Date.now()||this.pointer)return;if(this.timer)clearTimeout(this.timer);this.timer=setTimeout(this.revealTail,110)};
 private nativeCaret=():TailCaret|null=>{
  const input=this.root.ownerDocument.activeElement;
  if(!(input instanceof this.root.ownerDocument.defaultView!.HTMLTextAreaElement)||!input.matches('textarea.st-note-editor'))return null;
  const rect=nativeTextareaCaretRect(input);if(!rect)return null;
  // Native fallback uses its own scrollable content. Table input geometry is
  // supplied by CM, whose document end remains authoritative.
  const end=input.getBoundingClientRect().top+input.scrollHeight-input.scrollTop-(parseFloat(this.root.ownerDocument.defaultView!.getComputedStyle(input).paddingBottom)||0);
  return {...rect,endBottom:end,collapsed:input.selectionStart===input.selectionEnd,scroller:input};
 };
 private revealTail=()=>{
  this.timer=undefined;if(!this.active()||this.pendingUntil<=Date.now()||this.pointer){this.cancelTail();return}
  const caret=this.tailProvider?.()||this.nativeCaret();if(!caret)return;
  const bounds=this.metrics(),scroller=caret.scroller,clip=scroller.getBoundingClientRect();
  bounds.top=Math.max(bounds.top,clip.top);bounds.bottom=Math.min(bounds.bottom,clip.bottom);
  const delta=tailRevealDelta(caret,bounds.top,bounds.bottom,Math.max(0,scroller.scrollHeight-scroller.clientHeight-scroller.scrollTop),bounds.tailRange);
  if(delta<1)return;this.pendingUntil=0;this.lock();
  const anchor=this.anchors.find(a=>a.element===scroller);if(!anchor)return;
  const start=scroller.scrollTop,started=this.root.ownerDocument.defaultView!.performance.now();
  const step=(now:number)=>{this.animation=0;const current=this.tailProvider?.()||this.nativeCaret();
   if(!this.active()||!current||!current.collapsed||current.scroller!==scroller){this.cancelTail();return}
   // IME/toolbars can still move after the first measurement. Re-evaluate
   // the same caret's occlusion without installing a second scroll owner.
   const visible=this.metrics(),currentClip=scroller.getBoundingClientRect();
   visible.top=Math.max(visible.top,currentClip.top);visible.bottom=Math.min(visible.bottom,currentClip.bottom);
   const remaining=tailRevealDelta(current,visible.top,visible.bottom,Math.max(0,scroller.scrollHeight-scroller.clientHeight-scroller.scrollTop),visible.tailRange,true);
   if(remaining<=0){this.cancelTail();return}
   const target=scroller.scrollTop+remaining;
   const progress=this.motion?.matches?1:Math.min(1,(now-started)/220);
   anchor.top=Math.max(scroller.scrollTop,start+(target-start)*(1-Math.pow(1-progress,3)));this.expectedTop=anchor.top;scroller.scrollTop=anchor.top;anchor.top=scroller.scrollTop;this.expectedTop=anchor.top;this.measureViewport?.();
   if(progress<1)this.animation=requestAnimationFrame(step);
  };this.animation=requestAnimationFrame(step);
 };
 private releasePointer=()=>{if(!this.pointer)return;const editable=this.pointer.editable;this.pointer=null;if(editable){this.pendingUntil=Date.now()+1400;this.scheduleTail()}};
 private input=(event:Event)=>{if(!this.active()||!(event.target as Element).closest?.('.cm-content,.cm-lp-table-input,textarea.st-note-editor'))return;this.pendingUntil=Date.now()+700;this.scheduleTail()};
 private anchors:{element:HTMLElement;top:number;left:number}[]=[];
 constructor(readonly root:HTMLElement){
  root.addEventListener('pointerdown',this.press,true);
  root.addEventListener('pointermove',this.move,true);
  root.addEventListener('touchmove',this.gesture,{passive:true});
  root.addEventListener('wheel',this.gesture,{passive:true});
  root.addEventListener('focusin',this.focus,true);
  root.addEventListener('scroll',this.scroll,true);
  root.ownerDocument.addEventListener('pointerup',this.releasePointer,true);
  root.ownerDocument.addEventListener('pointercancel',this.cancelPointer,true);
  root.addEventListener('input',this.input,true);
  window.addEventListener('resize',this.resized);
  window.visualViewport?.addEventListener('resize',this.resized);
  this.motion=window.matchMedia?.('(prefers-reduced-motion: reduce)');this.motion?.addEventListener?.('change',this.cancelTail);
  if(typeof ResizeObserver!=='undefined'){this.observer=new ResizeObserver(this.resized);this.observer.observe(root)}
  if(typeof MutationObserver!=='undefined'){this.mutations=new MutationObserver(()=>{if(!this.active())this.cancelTail();else this.resized()});this.mutations.observe(root,{attributes:true,attributeFilter:['class','data-viewport-blocked','data-chrome-hidden']});const stage=root.closest('[data-current]');if(stage)this.mutations.observe(stage,{attributes:true,attributeFilter:['data-current']})}
  this.metrics();
 }
 lock(){
  const scrollers=Array.from(this.root.querySelectorAll<HTMLElement>('.cm-scroller,.st-note-paper,textarea.st-note-editor'));
  if(this.root.matches('.cm-scroller,.st-note-paper,textarea.st-note-editor'))scrollers.push(this.root);
  this.anchors=scrollers.map(element=>this.locked?this.anchors.find(a=>a.element===element)||{element,top:element.scrollTop,left:element.scrollLeft}:{element,top:element.scrollTop,left:element.scrollLeft});this.locked=true;
 }
 hold=()=>{this.allow();this.lock()};
 allow=()=>{this.cancelTail();this.locked=false;this.pointer=null;if(this.frame)cancelAnimationFrame(this.frame);this.frame=0};
 private press=(event:PointerEvent)=>{this.allow();this.pointer={x:event.clientX,y:event.clientY,editable:!(event.target as Element).closest?.('button,a,[data-table-grip],[role=menu]')&&Boolean((event.target as Element).closest?.('.cm-content,.cm-lp-table-editable,.cm-lp-table-input,.st-note-prose,textarea.st-note-editor'))};this.lock()};
 private cancelPointer=(event:PointerEvent)=>{
  // The rail has already claimed the horizontal touch. WebView's subsequent
  // compatibility pointercancel is not permission for vertical focus scroll.
  if(event.target instanceof Element&&event.target.closest('.st-note-paper-viewport.is-dragging'))return;
  this.allow();
 };
 private move=(event:PointerEvent)=>{
  if(this.pointer&&Math.hypot(event.clientX-this.pointer.x,event.clientY-this.pointer.y)>8&&!(event.target as Element).closest?.('[data-table-grip]'))this.allow();
 };
 private gesture=(event:Event)=>{if(!(event.target instanceof Element&&event.target.closest('[data-table-grip]')))this.allow()};
 private focus=()=>{this.lock();this.restore();this.scheduleTail()};
 private scroll=(event:Event)=>{if(this.animation&&this.expectedTop!==null&&this.anchors.some(a=>a.element===event.target&&Math.abs(a.element.scrollTop-a.top)>2)){this.allow();return}if(this.anchors.some(anchor=>anchor.element===event.target))this.restore()};
 restore=()=>{
  if(this.dead||!this.locked||this.frame)return;
  this.frame=requestAnimationFrame(()=>{this.frame=0;if(this.dead||!this.locked)return;
   let changed=false;
   for(const anchor of this.anchors){const {element,top,left}=anchor;if(!element.isConnected)continue;
    if(element.scrollTop!==top){element.scrollTop=top;changed=true}if(element.scrollLeft!==left){element.scrollLeft=left;changed=true}
    // Respect a legitimate content/viewport clamp; don't schedule an endless
    // scroll loop trying to restore a now-unreachable bottom coordinate.
    anchor.top=element.scrollTop;anchor.left=element.scrollLeft;
   }
   // A native focus scroll can make CM render a different virtual range.
   // Restoring pixels alone is insufficient if WebView coalesces the next
   // scroll/intersection notification. Refresh the SAME view after the write;
   // never dispatch selection, replace its state, or rebuild the editor.
   if(changed)this.measureViewport?.();
  });
 };
 destroy(){this.dead=true;this.allow();
  this.root.removeEventListener('pointerdown',this.press,true);this.root.removeEventListener('pointermove',this.move,true);
  this.root.removeEventListener('touchmove',this.gesture);this.root.removeEventListener('wheel',this.gesture);
  this.root.removeEventListener('focusin',this.focus,true);this.root.removeEventListener('scroll',this.scroll,true);
  this.root.ownerDocument.removeEventListener('pointerup',this.releasePointer,true);this.root.ownerDocument.removeEventListener('pointercancel',this.cancelPointer,true);this.root.removeEventListener('input',this.input,true);
  window.removeEventListener('resize',this.resized);window.visualViewport?.removeEventListener('resize',this.resized);
  this.motion?.removeEventListener?.('change',this.cancelTail);this.observer?.disconnect();this.mutations?.disconnect();this.root.style.removeProperty('--note-tail-clearance');
 }
}
const owners=new WeakMap<HTMLElement,{guard:NoteViewportStability;leases:number}>();
export function retainNoteViewport(root:HTMLElement){
 let owner=owners.get(root);if(!owner){owner={guard:new NoteViewportStability(root),leases:0};owners.set(root,owner)}owner.leases++;
 let retired=false;return {guard:owner.guard,release:()=>{if(retired)return;retired=true;if(--owner!.leases===0){owner!.guard.destroy();owners.delete(root)}}};
}
/** Existing explicit search/heading/mode restoration can release the same
 * owner before changing pixels. No second scrolling authority is installed. */
export function allowNoteViewportNavigation(element:HTMLElement){const root=element.closest<HTMLElement>('.st-note-surface')||element;owners.get(root)?.guard.allow()}
/** Horizontal panel transitions are not document navigation. Retain the
 * current pixels while cancelling any pending caret reveal/drag ownership. */
export function preserveNoteViewportNavigation(element:HTMLElement){const root=element.closest<HTMLElement>('.st-note-surface')||element;owners.get(root)?.guard.hold()}
export function useNoteViewportStability(ref:RefObject<HTMLElement|null>){
 useLayoutEffect(()=>{if(!ref.current)return;return retainNoteViewport(ref.current).release},[ref]);
}
