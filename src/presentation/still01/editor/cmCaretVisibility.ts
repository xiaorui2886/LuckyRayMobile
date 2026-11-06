import {retainNoteViewport} from './noteViewportStability';
import {nativeTextareaCaretRect} from './nativeTextareaCaret';
import {nativeTableInput} from './tableFocus';
import {noteScrollNavigation} from './noteScrollIntent.ts';
export {noteScrollNavigation} from './noteScrollIntent.ts';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

/** Overlay controls do not resize the scroll viewport. Account for them for
 * explicit CM scroll requests (search and heading links), not just IME. */
export function noteChromeInsets(view: EditorView): { top: number; bottom: number } {
 const host=view.dom.closest<HTMLElement>('.st-note-surface');
 if(!host || host.dataset.chromeHidden==='true')return {top:0,bottom:0};
 const rect=view.scrollDOM.getBoundingClientRect();
 const layoutRect=(element:HTMLElement| null)=>{
  if(!element)return undefined;
  // Transforms animate paint, not the final occupied area. A focus event in
  // the first reveal frame must reserve the whole toolbar, not its old offset.
  if(element.offsetParent===host){const top=host.getBoundingClientRect().top+element.offsetTop;return {top,bottom:top+element.offsetHeight,height:element.offsetHeight};}
  return element.getBoundingClientRect();
 };
 const header=layoutRect(host.querySelector<HTMLElement>(':scope > .st-header'));
 const toolbar=host.querySelector<HTMLElement>(':scope > .st-reader-bottom');
 const tools=toolbar && getComputedStyle(toolbar).display!=='none' ? layoutRect(toolbar):undefined;
 return {top:header&&header.height>0?Math.max(0,header.bottom-rect.top):0,
  bottom:tools&&tools.height>0?Math.max(0,rect.bottom-tools.top):0};
}

/** A navigation effect is deliberately separate from caret/format transactions. */
export const cmCaretVisibility=ViewPlugin.fromClass(class {
 allowNavigation=false;
 releaseTail:()=>void;
 owner:ReturnType<typeof retainNoteViewport>;
 constructor(readonly view:EditorView){this.owner=retainNoteViewport(view.dom.closest<HTMLElement>('.st-note-surface')||view.dom);this.releaseTail=this.owner.guard.setTailProvider(()=>{
  const native=nativeTableInput(view),selection=view.state.selection.main;
  if(native?native.ownerDocument.activeElement!==native:!view.hasFocus)return null;
  const caret=native?nativeTextareaCaretRect(native):view.coordsAtPos(selection.head);
  if(!caret)return null;
  const end=view.lineBlockAt(view.state.doc.length);
  return {scroller:view.scrollDOM,top:caret.top,bottom:caret.bottom,endBottom:view.documentTop+end.bottom,collapsed:native?native.selectionStart===native.selectionEnd:selection.empty};
 },()=>view.requestMeasure())}
 update(update:ViewUpdate){
  if(update.transactions.some(tr=>tr.effects.some(effect=>effect.is(noteScrollNavigation)))){this.owner.guard.allow();this.allowNavigation=true;return}
  if(update.selectionSet||update.transactions.some(tr=>tr.isUserEvent('input')||tr.isUserEvent('undo')||tr.isUserEvent('redo'))){
   this.allowNavigation=false;if(this.view.hasFocus||nativeTableInput(this.view))this.owner.guard.lock();this.owner.guard.restore();
  }
 }
 destroy(){this.releaseTail();this.owner.release()}
},{provide:plugin=>[EditorView.scrollMargins.of(noteChromeInsets),EditorView.scrollHandler.of(view=>{
 const state=view.plugin(plugin);if(state?.allowNavigation){state.allowNavigation=false;return false}return true;
})]});
