import {MarkdownParseClient,SYNC_MARKDOWN_LIMIT,ASYNC_MARKDOWN_LIMIT} from './markdownParseClient';
import { StateEffect, StateField, type Extension, type EditorState } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view';
import { convertFileSrc } from '@tauri-apps/api/core';
import { NoteResourceSession, type NoteResource, type NoteResourceScope } from '../../../services/noteResourceSession';
import { api } from '../../../services/client';
export type EditorImageScope=NoteResourceScope & {resources:NoteResource[];online:boolean};
export { editorImageRanges } from './editorImageRanges';
import { editorImageRanges } from './editorImageRanges';
class InlineImage extends WidgetType {
 constructor(readonly scope:EditorImageScope,readonly resource:NoteResource,readonly block=true){super()}
 eq(other:InlineImage){return this.block===other.block&&JSON.stringify([this.scope.instance,this.scope.vault,this.scope.note,this.scope.online,this.resource])===JSON.stringify([other.scope.instance,other.scope.vault,other.scope.note,other.scope.online,other.resource])}
 sessions=new WeakMap<HTMLElement,NoteResourceSession>();
 toDOM(view:EditorView){
  const box=document.createElement(this.block?'div':'span');box.className='st-editor-image'+(this.block?'':' is-inline');box.setAttribute('contenteditable','false');
  const image=document.createElement('img');image.alt=this.resource.target;image.loading='lazy';image.hidden=true;
  const caption=document.createElement('span');caption.className='st-editor-image-caption';caption.textContent=this.resource.target;
  const retry=document.createElement('button');retry.type='button';retry.textContent='重新加载图片';retry.hidden=true;
  let alive=true;
  const reader=new NoteResourceSession(this.scope,this.resource,api,state=>{
   if(!alive)return;
   if(state.file?.mime.startsWith('image/')){const src=convertFileSrc(state.file.path);if(image.getAttribute('src')!==src)image.src=src;image.hidden=false;caption.textContent='';caption.hidden=true}
   else {caption.hidden=false;caption.textContent=state.message|| (state.busy?'正在加载图片…':this.scope.online?'图片尚未加载':'图片未缓存，连接原电脑后可查看')};
   retry.hidden=state.busy||!this.scope.online||Boolean(state.file);view.requestMeasure();
  },this.scope.online);
  image.addEventListener('load',()=>{if(alive)view.requestMeasure()});
  image.addEventListener('error',()=>{if(!alive)return;image.hidden=true;caption.hidden=false;caption.textContent='图片暂时无法显示';retry.hidden=!this.scope.online;view.requestMeasure()});
  retry.addEventListener('pointerdown',e=>e.preventDefault());retry.addEventListener('click',()=>void reader.download());
  let press:{x:number;y:number}|null=null;
  box.addEventListener('pointerdown',raw=>{const event=raw as PointerEvent;press={x:event.clientX,y:event.clientY}});
  box.addEventListener('pointercancel',()=>{press=null});
  box.addEventListener('click',raw=>{
   const event=raw as MouseEvent;
   if(event.target===retry)return;
   if(press&&Math.hypot(event.clientX-press.x,event.clientY-press.y)>8){press=null;return}press=null;
   if(view.composing||view.compositionStarted)return;
   const at=Math.min(view.state.doc.length,view.posAtDOM(box)+1);
   view.dispatch({selection:{anchor:at},scrollIntoView:true});view.focus();
  });
  box.append(image,caption,retry);this.sessions.set(box,reader);
  // Retire through the existing resource owner; no global file/URL cache.
  const visibility=()=>{if(document.hidden)reader.cancel();else if(alive)void reader.start()};
  document.addEventListener('visibilitychange',visibility);
  (box as any).__retireImage=()=>{alive=false;document.removeEventListener('visibilitychange',visibility);reader.retire()};
  if(!document.hidden)void reader.start();return box;
 }
 destroy(dom:HTMLElement){(dom as any).__retireImage?.();this.sessions.delete(dom)}
 ignoreEvent(){return true}
}
/** Only the attachment being edited exposes its source. Other attachments stay visual. */
export function imageSourceIsActive(state:EditorState, from:number, to:number, focused:boolean):boolean {
 return focused && state.selection.ranges.some(range=>range.empty
  ? range.head>=from && range.head<=to : range.from<to && range.to>from);
}
export function cmInlineImages(scope:EditorImageScope,initialFocused=false,onSettled?:(view:EditorView,available:boolean)=>void):Extension {
 const refresh=StateEffect.define<null>();
 const focus=StateEffect.define<boolean>();
 const composition=StateEffect.define<boolean>();
 let forceRaw=false;
 let cachedDoc:EditorState['doc']|undefined,cachedRanges:ReturnType<typeof editorImageRanges>=[];
 const result=StateEffect.define<{doc:EditorState['doc'];ranges:ReturnType<typeof editorImageRanges>}>();
 const ranges=(state:EditorState)=>{if(state.doc!==cachedDoc){if(state.doc.length>SYNC_MARKDOWN_LIMIT)return null;cachedDoc=state.doc;cachedRanges=editorImageRanges(state.doc.toString(),scope.resources)}return cachedRanges};
 const build=(state:EditorState,focused:boolean,previous=Decoration.none)=>{if(state.doc.length>ASYNC_MARKDOWN_LIMIT||forceRaw&&state.doc.length>SYNC_MARKDOWN_LIMIT)return Decoration.none;const parsed=ranges(state);if(!parsed)return previous.update({filter:(from,to)=>!imageSourceIsActive(state,from,to,focused)});return Decoration.set(parsed.flatMap(({from,at,resource})=>{
  if(imageSourceIsActive(state,from,at,focused))return [];
  const line=state.doc.lineAt(from),end=state.doc.lineAt(at);
  const block=line.number===end.number && !line.text.slice(0,from-line.from).trim() && !line.text.slice(at-line.from).trim();
  return [Decoration.replace({widget:new InlineImage(scope,resource,block),block,inclusive:false}).range(from,at)];
 }),true)};
 const field=StateField.define<{decorations:DecorationSet;focused:boolean;composing:boolean}>({
  create:state=>({decorations:build(state,initialFocused),focused:initialFocused,composing:false}),
  update(value,tr){
   let focused=value.focused,composing=value.composing;
   for(const effect of tr.effects){if(effect.is(focus))focused=effect.value;if(effect.is(composition))composing=effect.value}
   if(composing||tr.isUserEvent('input.type.compose'))return {focused,composing,decorations:value.decorations.map(tr.changes)};
   for(const effect of tr.effects)if(effect.is(result)&&effect.value.doc===tr.state.doc){cachedDoc=effect.value.doc;cachedRanges=effect.value.ranges;return {focused,composing,decorations:build(tr.state,focused)}}
   if(tr.docChanged||tr.selection||focused!==value.focused||composing!==value.composing||tr.effects.some(e=>e.is(refresh)))return {focused,composing,decorations:build(tr.state,focused,value.decorations.map(tr.changes))};
   return value;
  },provide:f=>EditorView.decorations.from(f,value=>value.decorations)
 });
 const settle=ViewPlugin.fromClass(class {
  frame=0;dead=false;requested:EditorState['doc']|undefined;requestId=0;pending:ReturnType<typeof editorImageRanges>|null=null;client:MarkdownParseClient<ReturnType<typeof editorImageRanges>>;
  constructor(readonly view:EditorView){
   this.client=new MarkdownParseClient('images',(parsed,id)=>{if(this.dead||id!==this.requestId||this.requested!==view.state.doc)return;forceRaw=false;this.pending=parsed;this.apply()},()=>{if(!this.dead){forceRaw=true;if(!view.composing&&!view.compositionStarted&&!view.state.field(field).composing)view.dispatch({effects:refresh.of(null)});this.notifySettled()}});
   view.contentDOM.addEventListener('compositionstart',this.start);view.contentDOM.addEventListener('compositionend',this.end);this.schedule();
  }
  notifySettled(){queueMicrotask(()=>{if(this.dead||this.view.composing||this.view.compositionStarted||this.view.state.field(field).composing)return;if(cachedDoc===this.view.state.doc||forceRaw||this.view.state.doc.length>ASYNC_MARKDOWN_LIMIT)onSettled?.(this.view, !forceRaw && this.view.state.doc.length <= ASYNC_MARKDOWN_LIMIT)})}
  schedule(){const doc=this.view.state.doc;if(this.requested===doc)return;this.pending=null;this.requested=doc;
   if(doc.length<=SYNC_MARKDOWN_LIMIT||doc.length>ASYNC_MARKDOWN_LIMIT){if(doc.length<=SYNC_MARKDOWN_LIMIT)forceRaw=false;this.client.cancel();this.notifySettled();return}
   this.requestId=this.client.request(doc.toString(),scope.resources,!cachedDoc);
  }
  apply(){if(this.dead||!this.pending||this.requested!==this.view.state.doc||this.view.composing||this.view.compositionStarted||this.view.state.field(field).composing)return;
   const ranges=this.pending;this.pending=null;this.view.dispatch({effects:result.of({doc:this.view.state.doc,ranges})});this.notifySettled();
  }
  update(update:any){if(update.docChanged)this.schedule()}
  start=()=>{if(!this.dead)this.view.dispatch({effects:composition.of(true)})}
  end=()=>{cancelAnimationFrame(this.frame);this.frame=requestAnimationFrame(()=>{
   if(this.dead)return;if(this.view.composing||this.view.compositionStarted){this.end();return}
   this.view.dispatch({effects:[composition.of(false),refresh.of(null)]});this.schedule();this.apply();this.notifySettled();
  })};
  destroy(){this.dead=true;this.client.destroy();cancelAnimationFrame(this.frame);this.view.contentDOM.removeEventListener('compositionstart',this.start);this.view.contentDOM.removeEventListener('compositionend',this.end)}
 });
 return [field,settle,EditorView.domEventHandlers({
  focus:(_event,view)=>{view.dispatch({effects:focus.of(true)});return false},
  blur:(_event,view)=>{view.dispatch({effects:focus.of(false)});return false},
 })];
}
