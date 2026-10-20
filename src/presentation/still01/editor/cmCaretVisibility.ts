import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

/** Geometry comes from the already resized native viewport, never an IME estimate. */
export function caretScrollDelta(top:number,bottom:number,visibleTop:number,visibleBottom:number):number {
 if(visibleBottom<=visibleTop)return 0;
 if(bottom>visibleBottom-12)return bottom-visibleBottom+12;
 if(top<visibleTop+8)return top-visibleTop-8;
 return 0;
}
export const cmCaretVisibility=ViewPlugin.fromClass(class {
 frame=0;dead=false;observer:ResizeObserver|undefined;
 constructor(readonly view:EditorView){
  window.addEventListener('resize',this.schedule);
  window.visualViewport?.addEventListener('resize',this.schedule);
  view.contentDOM.addEventListener('focus',this.schedule);
  view.contentDOM.addEventListener('compositionend',this.schedule);
  if(typeof ResizeObserver!=='undefined'){
   this.observer=new ResizeObserver(this.schedule);this.observer.observe(view.scrollDOM);
   const toolbar=view.dom.closest('.st-note-surface')?.querySelector('.st-reader-bottom');
   if(toolbar)this.observer.observe(toolbar);
  }
 }
 schedule=()=>{
  cancelAnimationFrame(this.frame);
  this.frame=requestAnimationFrame(()=>{
   if(this.dead||!this.view.hasFocus)return;
   if(this.view.composing||this.view.compositionStarted){this.schedule();return}
   const view=this.view,rect=view.scrollDOM.getBoundingClientRect();
   const caret=view.coordsAtPos(view.state.selection.main.head);if(!caret)return;
   const viewport=window.visualViewport;
   const toolbar=view.dom.closest('.st-note-surface')?.querySelector('.st-reader-bottom')?.getBoundingClientRect();
   const top=Math.max(rect.top,viewport?.offsetTop||0);
   const bottom=Math.min(rect.bottom,(viewport?.offsetTop||0)+(viewport?.height||window.innerHeight),toolbar&&toolbar.height>0?toolbar.top:Infinity);
   const delta=caretScrollDelta(caret.top,caret.bottom,top,bottom);
   if(delta)view.scrollDOM.scrollTop+=delta;
  });
 };
 update(update:ViewUpdate){
  if(update.selectionSet||update.focusChanged||update.transactions.some(tr=>tr.isUserEvent('input')))this.schedule();
 }
 destroy(){this.dead=true;cancelAnimationFrame(this.frame);this.observer?.disconnect();window.removeEventListener('resize',this.schedule);window.visualViewport?.removeEventListener('resize',this.schedule);this.view.contentDOM.removeEventListener('focus',this.schedule);this.view.contentDOM.removeEventListener('compositionend',this.schedule)}
});
