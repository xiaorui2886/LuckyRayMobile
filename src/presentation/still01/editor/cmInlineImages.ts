import { StateEffect, StateField, type Extension, type EditorState } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view';
import { convertFileSrc } from '@tauri-apps/api/core';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { wikiSyntax } from '../../../still/kit/wikiSyntax';
import { NoteResourceSession, type NoteResource, type NoteResourceScope } from '../../../services/noteResourceSession';
import { api } from '../../../services/client';
export type EditorImageScope=NoteResourceScope & {resources:NoteResource[];online:boolean};
export function editorImageRanges(doc:string, resources:NoteResource[]):{from:number;at:number;resource:NoteResource}[]{
 if(doc.length>250_000)return [];
 const parser=unified().use(remarkParse).use(remarkGfm).use(wikiSyntax(doc,new Map()));
 const tree=parser.runSync(parser.parse(doc));const found:{from:number;at:number;resource:NoteResource}[]=[];
 const byTarget=new Map(resources.filter(r=>r.status==='resolved'&&r.mimeType?.startsWith('image/')).map(r=>[r.target,r]));
 const definitions=new Map<string,string>();
 const collect=(node:any)=>{if(node.type==='definition'&&typeof node.identifier==='string'&&typeof node.url==='string')definitions.set(node.identifier.toLowerCase(),node.url);node.children?.forEach(collect)};
 collect(tree);
 const visit=(node:any)=>{if(found.length>=24)return;
  const url=typeof node.url==='string'?node.url:node.type==='imageReference'?definitions.get(String(node.identifier).toLowerCase()):undefined;
  if(['image','imageReference'].includes(node.type)&&typeof url==='string'){
   let target=url;try{target=decodeURIComponent(target)}catch{}
   const resource=byTarget.get(url)||byTarget.get(target);
   if(resource&&Number.isInteger(node.position?.start?.offset)&&Number.isInteger(node.position?.end?.offset))found.push({from:node.position.start.offset,at:node.position.end.offset,resource});
  }
  if(!['code','inlineCode','html'].includes(node.type))node.children?.forEach(visit);
 };
 visit(tree);return found;
}
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
export function cmInlineImages(scope:EditorImageScope,initialFocused=false):Extension {
 const refresh=StateEffect.define<null>();
 const focus=StateEffect.define<boolean>();
 const build=(state:EditorState,focused:boolean)=>Decoration.set(editorImageRanges(state.doc.toString(),scope.resources).flatMap(({from,at,resource})=>{
  if(imageSourceIsActive(state,from,at,focused))return [];
  const line=state.doc.lineAt(from),end=state.doc.lineAt(at);
  const block=line.number===end.number && !line.text.slice(0,from-line.from).trim() && !line.text.slice(at-line.from).trim();
  return [Decoration.replace({widget:new InlineImage(scope,resource,block),block,inclusive:false}).range(from,at)];
 }),true);
 const field=StateField.define<{decorations:DecorationSet;focused:boolean}>({
  create:state=>({decorations:build(state,initialFocused),focused:initialFocused}),
  update(value,tr){
   let focused=value.focused;
   for(const effect of tr.effects)if(effect.is(focus))focused=effect.value;
   if(tr.isUserEvent('input.type.compose'))return {focused,decorations:value.decorations.map(tr.changes)};
   if(tr.docChanged||tr.selection||focused!==value.focused||tr.effects.some(e=>e.is(refresh)))return {focused,decorations:build(tr.state,focused)};
   return value;
  },provide:f=>EditorView.decorations.from(f,value=>value.decorations)
 });
 const settle=ViewPlugin.fromClass(class {
  frame=0;dead=false;
  constructor(readonly view:EditorView){view.contentDOM.addEventListener('compositionend',this.end)}
  end=()=>{cancelAnimationFrame(this.frame);this.frame=requestAnimationFrame(()=>{
   if(this.dead)return;if(this.view.composing||this.view.compositionStarted){this.end();return}
   this.view.dispatch({effects:refresh.of(null)});
  })};
  destroy(){this.dead=true;cancelAnimationFrame(this.frame);this.view.contentDOM.removeEventListener('compositionend',this.end)}
 });
 return [field,settle,EditorView.domEventHandlers({
  focus:(_event,view)=>{view.dispatch({effects:focus.of(true)});return false},
  blur:(_event,view)=>{view.dispatch({effects:focus.of(false)});return false},
 })];
}
