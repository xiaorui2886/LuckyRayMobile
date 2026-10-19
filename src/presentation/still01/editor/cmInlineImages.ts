import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view';
import { convertFileSrc } from '@tauri-apps/api/core';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { wikiSyntax } from '../../../still/kit/wikiSyntax';
import { NoteResourceSession, type NoteResource, type NoteResourceScope } from '../../../services/noteResourceSession';
import { api } from '../../../services/client';
export type EditorImageScope=NoteResourceScope & {resources:NoteResource[];online:boolean};
export function editorImageRanges(doc:string, resources:NoteResource[]):{at:number;resource:NoteResource}[]{
 if(doc.length>250_000)return [];
 const parser=unified().use(remarkParse).use(remarkGfm).use(wikiSyntax(doc,new Map()));
 const tree=parser.runSync(parser.parse(doc));const found:{at:number;resource:NoteResource}[]=[];
 const byTarget=new Map(resources.filter(r=>r.status==='resolved'&&r.mimeType?.startsWith('image/')).map(r=>[r.target,r]));
 const definitions=new Map<string,string>();
 const collect=(node:any)=>{if(node.type==='definition'&&typeof node.identifier==='string'&&typeof node.url==='string')definitions.set(node.identifier.toLowerCase(),node.url);node.children?.forEach(collect)};
 collect(tree);
 const visit=(node:any)=>{if(found.length>=24)return;
  const url=typeof node.url==='string'?node.url:['imageReference','linkReference'].includes(node.type)?definitions.get(String(node.identifier).toLowerCase()):undefined;
  if(['image','link','imageReference','linkReference'].includes(node.type)&&typeof url==='string'){
   let target=url;try{target=decodeURIComponent(target)}catch{}
   const resource=byTarget.get(url)||byTarget.get(target);
   if(resource&&Number.isInteger(node.position?.end?.offset))found.push({at:node.position.end.offset,resource});
  }
  if(!['code','inlineCode','html'].includes(node.type))node.children?.forEach(visit);
 };
 visit(tree);return found;
}
class InlineImage extends WidgetType {
 constructor(readonly scope:EditorImageScope,readonly resource:NoteResource){super()}
 eq(other:InlineImage){return JSON.stringify([this.scope.instance,this.scope.vault,this.scope.note,this.scope.online,this.resource])===JSON.stringify([other.scope.instance,other.scope.vault,other.scope.note,other.scope.online,other.resource])}
 sessions=new WeakMap<HTMLElement,NoteResourceSession>();
 toDOM(view:EditorView){
  const box=document.createElement('div');box.className='st-editor-image';box.setAttribute('contenteditable','false');
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
export function cmInlineImages(scope:EditorImageScope):Extension {
 const build=(state:any)=>Decoration.set(editorImageRanges(state.doc.toString(),scope.resources).map(({at,resource})=>
  Decoration.widget({widget:new InlineImage(scope,resource),block:true,side:1}).range(state.doc.lineAt(at).to)),true);
 const refresh=StateEffect.define<null>();
 const field=StateField.define<DecorationSet>({create:build,update(value,tr){
  if(tr.effects.some(e=>e.is(refresh)))return build(tr.state);
  return tr.docChanged?tr.isUserEvent('input.type.compose')?value.map(tr.changes):build(tr.state):value;
 },provide:f=>EditorView.decorations.from(f)});
 const settle=ViewPlugin.fromClass(class {
  frame=0;dead=false;
  constructor(readonly view:EditorView){view.contentDOM.addEventListener('compositionend',this.end)}
  end=()=>{cancelAnimationFrame(this.frame);this.frame=requestAnimationFrame(()=>{
   if(this.dead)return;if(this.view.composing||this.view.compositionStarted){this.end();return}
   this.view.dispatch({effects:refresh.of(null)});
  })};
  destroy(){this.dead=true;cancelAnimationFrame(this.frame);this.view.contentDOM.removeEventListener('compositionend',this.end)}
 });
 return [field,settle];
}
