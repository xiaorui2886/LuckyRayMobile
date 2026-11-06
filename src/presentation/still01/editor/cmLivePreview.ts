import { tableColumnWidths } from './tableColumnWidths';
import {MarkdownParseClient,SYNC_MARKDOWN_LIMIT,ASYNC_MARKDOWN_LIMIT} from './markdownParseClient';
import { StateEffect, StateField, Transaction, type EditorState, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';
import { mobileLivePreviewModel, previewRangeActive, type LivePreviewModel, type PreviewLink, type PreviewTable, type PreviewInline } from './mobileLivePreviewModel';
import type { WikiReference } from '../../../still/kit/knowledgeRelations';
import type { EditorImageScope } from './cmInlineImages';
import { NoteResourceSession, type ResourceView } from '../../../services/noteResourceSession';
import { installTableEditor, type TableController } from './cmTableEditor';
import { editableTable } from './tableMarkdownModel';
import { api } from '../../../services/client';
import { openExternalWebLink } from '../../../services/safeExternalLink';

export type PreviewLinkStatus='resolved'|'missing'|'ambiguous'|'unknown';
export type LivePreviewOptions={tableEnabled?:()=>boolean;onSettled?:(view:EditorView,available:boolean)=>void;registerOverlay?:(dismiss:()=>void)=>()=>void;onWikiLink?:(reference:WikiReference)=>void;linkStatus?:(reference:WikiReference)=>PreviewLinkStatus;enabled:()=>boolean;imageScope?:EditorImageScope};
export const refreshLivePreview=StateEffect.define<null>();
const revealTableSource=StateEffect.define<number>();
const refresh=StateEffect.define<null>(), focus=StateEffect.define<boolean>(), composition=StateEffect.define<boolean>();
function available(view:EditorView,options:LivePreviewOptions){return options.enabled()&&view.dom.isConnected&&!view.composing&&!view.compositionStarted;}
function sameSource(view:EditorView,from:number,to:number,source:string){return to<=view.state.doc.length&&view.state.doc.sliceString(from,to)===source;}
function editSource(view:EditorView,from:number,to:number,source:string,options:LivePreviewOptions,at=from){
 if(!available(view,options)||!sameSource(view,from,to,source))return;
 view.focus();view.dispatch({selection:{anchor:Math.max(from,Math.min(to,at))},effects:focus.of(true),scrollIntoView:true,annotations:Transaction.addToHistory.of(false)});
}
/** A short click is navigation; holding is an explicit edit menu. Scrolling or
 * pointer cancellation never navigates. No asynchronous callback edits source. */
function installLinkGesture(box:HTMLElement,view:EditorView,link:PreviewLink,source:string,options:LivePreviewOptions,open:()=>void){
 let start:{x:number;y:number}|null=null,timer:ReturnType<typeof setTimeout>|undefined,moved=false,held=false,alive=true,menu:HTMLElement|null=null,unregister:(()=>void)|undefined;
 const close=()=>{menu?.remove();menu=null;clearTimeout(timer);const release=unregister;unregister=undefined;release?.()};
 const safeOpen=()=>{if(alive&&box.isConnected&&available(view,options)&&sameSource(view,link.from,link.to,source))open()};
 const showMenu=()=>{
  if(!alive||!box.isConnected||!available(view,options)||!sameSource(view,link.from,link.to,source))return;
  held=true;close();menu=document.createElement('span');menu.className='cm-lp-link-menu';menu.setAttribute('role','dialog');menu.setAttribute('aria-label','链接操作');
  const add=(label:string,action:()=>void)=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.addEventListener('pointerdown',e=>e.preventDefault());b.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();close();action()});menu!.append(b)};
  add('打开链接',safeOpen);add('编辑链接',()=>editSource(view,link.from,link.to,source,options,link.from+(source.startsWith('[[')?2:1)));
  add('复制链接',()=>{if(available(view,options)&&sameSource(view,link.from,link.to,source))void navigator.clipboard?.writeText(link.wiki?.target||link.resource?.target||link.url).catch(()=>{})});
  add('取消',()=>{});box.append(menu);unregister=options.registerOverlay?.(close);
  const rect=box.getBoundingClientRect(),width=Math.min(260,(window.visualViewport?.width||window.innerWidth)-24),left=window.visualViewport?.offsetLeft||0,top=window.visualViewport?.offsetTop||0;
  menu.style.width=width+'px';menu.style.left=Math.max(left+12,Math.min(rect.left,left+(window.visualViewport?.width||window.innerWidth)-width-12))+'px';menu.style.top=Math.max(top+12,Math.min(rect.bottom+6,top+(window.visualViewport?.height||window.innerHeight)-200))+'px';
 };
 box.addEventListener('pointerdown',e=>{if((e.target as Element).closest('.cm-lp-link-menu'))return;start={x:e.clientX,y:e.clientY};moved=false;held=false;clearTimeout(timer);timer=setTimeout(showMenu,520)});
 box.addEventListener('pointermove',e=>{if(start&&Math.hypot(e.clientX-start.x,e.clientY-start.y)>8){moved=true;clearTimeout(timer)}});
 box.addEventListener('pointerup',()=>clearTimeout(timer));box.addEventListener('pointercancel',()=>{moved=true;start=null;close()});
 box.addEventListener('contextmenu',e=>{e.preventDefault();e.stopPropagation();showMenu()});
 box.addEventListener('click',e=>{if((e.target as Element).closest('.cm-lp-link-menu'))return;e.preventDefault();e.stopPropagation();if(!held&&!moved&&available(view,options)&&sameSource(view,link.from,link.to,source))safeOpen();start=null});
 box.addEventListener('keydown',e=>{if(e.key==='Escape'){close();e.preventDefault()}else if(e.key==='F2'||e.key==='F10'&&e.shiftKey){showMenu();e.preventDefault()}else if(e.key==='Enter'&&!menu){e.preventDefault();if(available(view,options))safeOpen()}});
 const dismiss=(e:Event)=>{if(menu&&!box.contains(e.target as Node))close()};
 document.addEventListener('pointerdown',dismiss,true);window.addEventListener('scroll',close,true);
 (box as any).__retire=()=>{alive=false;close();document.removeEventListener('pointerdown',dismiss,true);window.removeEventListener('scroll',close,true)};
}
class LinkWidget extends WidgetType {
 constructor(readonly link:PreviewLink,readonly source:string,readonly options:LivePreviewOptions,readonly status:PreviewLinkStatus){super()}
 eq(other:LinkWidget){return this.source===other.source&&this.link.from===other.link.from&&this.link.to===other.link.to&&this.link.url===other.link.url&&this.status===other.status&&this.options===other.options}
 toDOM(view:EditorView){
  const box=document.createElement('span');box.className='cm-lp-link-wrap';
  const button=document.createElement('button');button.type='button';button.className='cm-lp-link is-'+this.status;button.textContent=this.link.label;button.title=this.link.wiki?.target||this.link.url;
  if(!this.link.wiki){const icon=document.createElement('span');icon.className='cm-lp-external';icon.textContent='↗';icon.setAttribute('aria-hidden','true');button.append(icon)}
  if(this.status==='missing'||this.status==='ambiguous'){const mark=document.createElement('span');mark.className='cm-lp-link-status';mark.textContent=this.status==='missing'?' ?':' ⋯';mark.setAttribute('aria-hidden','true');button.append(mark);button.setAttribute('aria-label',this.link.label+(this.status==='missing'?'，未找到目标':'，需选择同名目标'))}
  box.append(button);
  const status=document.createElement('span');status.className='cm-lp-file-status';status.setAttribute('role','status');status.hidden=true;box.append(status);
  let alive=true,opening=false;
  installLinkGesture(box,view,this.link,this.source,this.options,()=>{
   if(this.link.wiki){this.options.onWikiLink?.(this.link.wiki);return}
   if(opening)return;
   opening=true;status.textContent='';status.hidden=true;button.setAttribute('aria-busy','true');
   void openExternalWebLink(this.link.url).catch(()=>{
    if(alive&&box.isConnected&&available(view,this.options)&&sameSource(view,this.link.from,this.link.to,this.source)){
     status.textContent='无法打开网页，请检查浏览器后重试';status.hidden=false;view.requestMeasure();
    }
   }).finally(()=>{opening=false;if(alive)button.removeAttribute('aria-busy')});
  });
  const retire=(box as any).__retire;(box as any).__retire=()=>{alive=false;retire?.()};
  return box;
 }
 destroy(dom:HTMLElement){(dom as any).__retire?.()}
 ignoreEvent(){return true}
}
class FileWidget extends WidgetType {
 constructor(readonly link:PreviewLink,readonly source:string,readonly options:LivePreviewOptions){super()}
 eq(other:FileWidget){return this.source===other.source&&this.link.from===other.link.from&&this.options===other.options}
 toDOM(view:EditorView){
  const box=document.createElement('span');box.className='cm-lp-link-wrap';const button=document.createElement('button');button.type='button';button.className='cm-lp-file';button.textContent='▤ '+this.link.label;box.append(button);
  const status=document.createElement('span');status.className='cm-lp-file-status';status.setAttribute('role','status');box.append(status);
  let alive=true,current:ResourceView={file:null,busy:false,message:''};const resource=this.link.resource!,scope=this.options.imageScope!;
  const session=new NoteResourceSession(scope,resource,api,value=>{if(!alive)return;current=value;status.textContent=value.message||(value.busy?' 获取中…':resource.status!=='resolved'?' 未授权或文件缺失':'');view.requestMeasure()},scope.online);
  installLinkGesture(box,view,this.link,this.source,this.options,()=>{if(!alive||!available(view,this.options))return;if(current.file){void (scope.localVaultId ? api.managedVaultResourceOpen(scope.localVaultId,scope.note,resource.target,scope.revision||"") : api.contentOpenResource(scope.instance,resource.resourceId,scope.vault,scope.note)).catch(()=>{if(alive)status.textContent='未找到可打开此文件的应用'})}else if(current.busy)session.cancel();else void session.download()});
  const old=(box as any).__retire;(box as any).__retire=()=>{alive=false;old?.();session.retire()};
  const visibility=()=>{if(document.hidden)session.cancel();else if(alive)void session.start()};document.addEventListener('visibilitychange',visibility);const retire=(box as any).__retire;(box as any).__retire=()=>{retire();document.removeEventListener('visibilitychange',visibility)};
  if(!document.hidden)void session.start();return box;
 }
 destroy(dom:HTMLElement){(dom as any).__retire?.()}
 ignoreEvent(){return true}
}
class TextMarker extends WidgetType {
 constructor(readonly text:string,readonly className=''){super()}
 eq(other:TextMarker){return this.text===other.text&&this.className===other.className}
 toDOM(){const span=document.createElement('span');span.textContent=this.text;span.className='cm-lp-marker '+this.className;span.setAttribute('aria-hidden','true');return span}
 ignoreEvent(){return false}
}
class TaskWidget extends WidgetType {
 constructor(readonly from:number,readonly to:number,readonly charAt:number,readonly checked:boolean,readonly source:string,readonly options:LivePreviewOptions){super()}
 eq(o:TaskWidget){return this.from===o.from&&this.to===o.to&&this.checked===o.checked&&this.source===o.source&&this.options===o.options}
 toDOM(view:EditorView){const b=document.createElement('button');b.type='button';b.className='cm-lp-task';b.setAttribute('role','checkbox');b.setAttribute('aria-checked',String(this.checked));b.setAttribute('aria-label',this.checked?'标记未完成':'标记完成');b.textContent=this.checked?'✓':'';
  b.addEventListener('pointerdown',e=>e.preventDefault());b.addEventListener('click',e=>{e.preventDefault();if(!b.isConnected||!available(view,this.options)||!sameSource(view,this.from,this.to,this.source))return;view.dispatch({changes:{from:this.charAt,to:this.charAt+1,insert:this.checked?' ':'x'},annotations:isolateHistory.of('full'),userEvent:'input.task'})});return b}
 ignoreEvent(){return true}
}
class RuleWidget extends WidgetType {
 constructor(readonly from:number,readonly to:number,readonly source:string,readonly options:LivePreviewOptions){super()}
 eq(o:RuleWidget){return this.from===o.from&&this.to===o.to&&this.source===o.source&&this.options===o.options}
 toDOM(view:EditorView){const box=document.createElement('span');box.className='cm-lp-rule';box.setAttribute('role','separator');box.title='点击编辑分隔线';box.addEventListener('click',()=>editSource(view,this.from,this.to,this.source,this.options));return box}
 ignoreEvent(){return true}
}
class TableWidget extends WidgetType {
 children=new WeakMap<HTMLElement,{widget:WidgetType;dom:HTMLElement}[]>();
 controllers=new WeakMap<HTMLElement,TableController>();
 activeChildren:{widget:WidgetType;dom:HTMLElement}[]=[];
 renderInline(parent:HTMLElement,nodes:PreviewInline[],view:EditorView){for(const node of nodes){
  if(node.kind==='link'&&node.link){const link=node.link,source=view.state.doc.sliceString(link.from,link.to);const widget=link.resource&&this.options.imageScope?new FileWidget(link,source,this.options):new LinkWidget(link,source,this.options,link.wiki?this.options.linkStatus?.(link.wiki)||'unknown':'resolved');const dom=widget.toDOM(view);this.activeChildren.push({widget,dom});parent.append(dom);continue}
  if(node.kind==='text'){parent.append(document.createTextNode(node.text||''));continue}
  const element=document.createElement(({strong:'strong',emphasis:'em',delete:'del',inlineCode:'code',highlight:'mark'} as Record<string,string>)[node.kind]||'span');element.className='cm-lp-'+node.kind;if(node.text)element.textContent=node.text;if(node.children)this.renderInline(element,node.children,view);parent.append(element);
 }}

 destroy(dom:HTMLElement){(dom as any).__retireTable?.()}
 readonly linkPresentation:string;
 constructor(readonly table:PreviewTable,readonly source:string,readonly options:LivePreviewOptions){super();
  const statuses:string[]=[];
  const collect=(nodes:PreviewInline[])=>{for(const node of nodes){if(node.link?.wiki)statuses.push(`${node.link.from}:${options.linkStatus?.(node.link.wiki)||'unknown'}`);if(node.children)collect(node.children)}};
  for(const row of table.rows)for(const cell of row.cells)collect(cell.inline);
  this.linkPresentation=statuses.join('|');
 }
 eq(o:TableWidget){return this.table===o.table&&this.table.from===o.table.from&&this.source===o.source&&this.options===o.options&&this.linkPresentation===o.linkPresentation}
 updateDOM(dom:HTMLElement){const controller=(dom as any).__tableController as TableController|undefined;if(!controller)return false;(dom as any).__previewTable=this;this.controllers.set(dom,controller);return controller.update(this.table.from,this.source)}
 toDOM(view:EditorView){const box=document.createElement('div');box.className='cm-lp-table-wrap';(box as any).__previewTable=this;
  const render=(source:string,from:number)=>{
   for(const child of this.children.get(box)||[])child.widget.destroy(child.dom);this.activeChildren=[];
   const table=document.createElement('table');table.className='cm-lp-table';table.setAttribute('aria-label','表格，点击单元格编辑');
   // Parse only this bounded table for in-cell feedback; full-note parsing stays in its Worker.
   const latest=(box as any).__previewTable as TableWidget;const authoritative=source===latest.source&&from===latest.table.from?latest.table:null;
   const local=authoritative?null:mobileLivePreviewModel(source,this.options.imageScope?.resources).tables[0];
   const shift=(value:any):any=>Array.isArray(value)?value.map(shift):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,v])=>[key,['from','to','editAt'].includes(key)&&typeof v==='number'?v+from:shift(v)])):value;
   const model=authoritative||(local?shift(local) as PreviewTable:latest.table);
   model.rows.forEach((row,index)=>{const tr=document.createElement('tr');row.cells.forEach((cell,column)=>{const td=document.createElement(index?'td':'th');this.renderInline(td,cell.inline,view);if(!td.childNodes.length)td.textContent='\u00a0';td.tabIndex=0;td.title='编辑此单元格';if(['left','center','right'].includes(model.align[column]||''))td.style.textAlign=model.align[column]!;tr.append(td)});table.append(tr)});
   // Bounded visible-content weights, not source/URL length. Long descriptions
   // receive more room, but neither a long URL nor activation widens the grid.
   const visibleText=(items:PreviewInline[]):string=>items.map(n=>n.link?.label||n.text||(n.children?visibleText(n.children):'')).join('');
   const group=document.createElement('colgroup');
   tableColumnWidths(model.rows.map(row=>row.cells.map(cell=>visibleText(cell.inline)))).forEach(width=>{const col=document.createElement('col');col.style.width=`${width}%`;group.append(col)});table.prepend(group);
   const viewport=document.createElement('div');viewport.className='cm-lp-table-viewport';viewport.append(table);box.querySelector('.cm-lp-table-viewport')?.remove();box.prepend(viewport);this.children.set(box,this.activeChildren);
  };
  render(this.source,this.table.from);
  const controller=installTableEditor(box,view,this.table.from,this.source,{...this.options,enabled:this.options.tableEnabled||this.options.enabled},render,(from,source)=>{view.dispatch({effects:revealTableSource.of(from),selection:{anchor:from}});editSource(view,from,from+source.length,source,{...this.options,enabled:this.options.tableEnabled||this.options.enabled})});
  if(controller){this.controllers.set(box,controller);(box as any).__tableController=controller}else box.addEventListener('click',()=>editSource(view,this.table.from,this.table.to,this.source,this.options));
  (box as any).__retireTable=()=>{controller?.retire();for(const child of this.children.get(box)||[])child.widget.destroy(child.dom);this.children.delete(box)};
  return box;
 }
 ignoreEvent(){return true}
}
/** Pure decoration construction is also exercised without a browser. The
 * StateField (not viewport plugin) owns replacements that change line height. */
export function livePreviewDecorations(state:EditorState,model:LivePreviewModel,focused:boolean,options:LivePreviewOptions,rawTable:number|null=null):DecorationSet {
 const spans:Range<Decoration>[]=[];const doc=state.doc;
 const active=(from:number,to:number)=>previewRangeActive(from,to,state.selection.ranges,focused);
 const replace=(from:number,to:number,widget?:WidgetType,block=false)=>{if(to>from)spans.push(Decoration.replace({widget,block,inclusive:false}).range(from,to))};
 const mark=(from:number,to:number,cls:string)=>{if(to>from)spans.push(Decoration.mark({class:cls}).range(from,to))};
 for(const span of model.spans){mark(span.contentFrom,span.contentTo,'cm-lp-'+span.kind);if(!active(span.from,span.to)){replace(span.from,span.contentFrom);replace(span.contentTo,span.to)}}
 const byLine=new Map<number,{classes:Set<string>;markers:PreviewLineMarker[]}>();
 type PreviewLineMarker={from:number;to:number;text?:string};
 for(const line of model.lines){const at=doc.lineAt(line.from).from;const current=byLine.get(at)||{classes:new Set<string>(),markers:[]};current.classes.add(line.className);current.markers.push(...line.markers);byLine.set(at,current)}
 for(const [at,line] of byLine){const classes=[...line.classes].filter(name=>name!=='cm-lp-blank-separator'||!active(at,doc.lineAt(at).to));if(classes.length)spans.push(Decoration.line({class:classes.join(' ')}).range(at));if(!active(at,doc.lineAt(at).to)){
  const seen=new Set<string>();for(const marker of line.markers){const key=marker.from+':'+marker.to;if(!seen.has(key)){seen.add(key);replace(marker.from,marker.to,marker.text?new TextMarker(marker.text,line.classes.has('cm-lp-code')?'is-code':''):undefined)}}}}
 for(const task of model.tasks)if(!active(task.from,task.to))replace(task.from,task.to,new TaskWidget(task.from,task.to,task.charAt,task.checked,doc.sliceString(task.from,task.to),options));
 for(const link of model.links)if(!active(link.from,link.to)){const source=doc.sliceString(link.from,link.to);replace(link.from,link.to,link.resource&&options.imageScope?new FileWidget(link,source,options):new LinkWidget(link,source,options,link.wiki?options.linkStatus?.(link.wiki)||'unknown':'resolved'))}
 for(const rule of model.rules)if(!active(rule.from,rule.to)){spans.push(Decoration.line({class:'cm-lp-rule-line'}).range(doc.lineAt(rule.from).from));replace(rule.from,rule.to,new RuleWidget(rule.from,rule.to,doc.sliceString(rule.from,rule.to),options));}
 for(const table of model.tables){const source=doc.sliceString(table.from,table.to);if(table.from!==rawTable&&editableTable(source)||!active(table.from,table.to)&&table.from!==rawTable)replace(table.from,table.to,new TableWidget(table,source,options),true);}
 return Decoration.set(spans,true);
}
export function cmLivePreview(options:LivePreviewOptions,initialFocused=false):Extension {
 let rawTable:number|null=null;
 let cachedDoc:EditorState['doc']|undefined,cached:LivePreviewModel,currentDoc:EditorState['doc']|undefined,forceRaw=false;
 let guarded={...options,tableEnabled:options.enabled,enabled:()=>options.enabled()&&cachedDoc===currentDoc};
 const result=StateEffect.define<{doc:EditorState['doc'];model:LivePreviewModel}>();
 const parse=(state:EditorState)=>{currentDoc=state.doc;if(state.doc!==cachedDoc){if(state.doc.length>SYNC_MARKDOWN_LIMIT)return null;cachedDoc=state.doc;cached=mobileLivePreviewModel(state.doc.toString(),options.imageScope?.resources)}return cached};
 const build=(state:EditorState,focused:boolean,previous=Decoration.none)=>{if(state.doc.length>ASYNC_MARKDOWN_LIMIT||forceRaw&&state.doc.length>SYNC_MARKDOWN_LIMIT)return Decoration.none;const model=parse(state);return model?livePreviewDecorations(state,model,focused,guarded,rawTable):previous.update({filter:(from,to,value)=>Boolean(value.spec.class)&&!(value.spec.class==='cm-lp-blank-separator'&&previewRangeActive(from,state.doc.lineAt(from).to,state.selection.ranges,focused))||(!value.spec.class&&(value.spec.widget instanceof TableWidget?from!==rawTable:!previewRangeActive(from,to,state.selection.ranges,focused)))})};
 const field=StateField.define<{decorations:DecorationSet;focused:boolean;composing:boolean}>({
  create:state=>({decorations:build(state,initialFocused),focused:initialFocused,composing:false}),
  update(value,tr){currentDoc=tr.state.doc;if(rawTable!==null)rawTable=tr.changes.mapPos(rawTable);for(const e of tr.effects)if(e.is(revealTableSource))rawTable=e.value;if(rawTable!==null&&tr.selection&&!tr.effects.some(e=>e.is(revealTableSource))){const table=cached?.tables.find(t=>t.from===rawTable);if(table&&!previewRangeActive(table.from,table.to,tr.state.selection.ranges,true))rawTable=null;}let focused=value.focused,composing=value.composing;for(const e of tr.effects){if(e.is(focus))focused=e.value;if(e.is(composition))composing=e.value}
   // Availability callbacks read the live owner. Refresh link presentation,
   // not every widget identity: replacing a table detaches native touch targets.
   if(composing||tr.isUserEvent('input.type.compose'))return {focused,composing,decorations:value.decorations.map(tr.changes)};
   for(const e of tr.effects)if(e.is(result)&&e.value.doc===tr.state.doc){cachedDoc=e.value.doc;cached=e.value.model;return {focused,composing,decorations:build(tr.state,focused)}}
   if(tr.docChanged||tr.selection||focused!==value.focused||composing!==value.composing||tr.effects.some(e=>e.is(refresh)||e.is(refreshLivePreview)||e.is(revealTableSource)))return {focused,composing,decorations:build(tr.state,focused,value.decorations.map(tr.changes))};return value;
  },provide:f=>EditorView.decorations.from(f,v=>v.decorations)
 });
 const observer=ViewPlugin.fromClass(class {
  frame=0;dead=false;requested:EditorState['doc']|undefined;requestId=0;pending:LivePreviewModel|null=null;notice:HTMLElement;client:MarkdownParseClient<LivePreviewModel>;
  constructor(readonly view:EditorView){
   this.notice=document.createElement('div');this.notice.className='cm-lp-preview-status';this.notice.setAttribute('role','status');this.notice.hidden=true;view.dom.append(this.notice);
   this.client=new MarkdownParseClient('preview',(model,id)=>{if(this.dead||id!==this.requestId||this.requested!==view.state.doc)return;forceRaw=false;this.pending=model;this.apply()},()=>{if(!this.dead){forceRaw=true;this.status('此设备暂不可后台预览长笔记，正文仍可正常编辑');if(!view.composing&&!view.compositionStarted&&!view.state.field(field).composing)view.dispatch({effects:refresh.of(null)});this.notifySettled()}});
   view.contentDOM.addEventListener('compositionstart',this.start);view.contentDOM.addEventListener('compositionend',this.end);this.schedule();
  }
  notifySettled(){queueMicrotask(()=>{if(this.dead||this.view.composing||this.view.compositionStarted||this.view.state.field(field).composing)return;if(cachedDoc===this.view.state.doc||forceRaw||this.view.state.doc.length>ASYNC_MARKDOWN_LIMIT){options.onSettled?.(this.view, !forceRaw && this.view.state.doc.length <= ASYNC_MARKDOWN_LIMIT)}})}
  status(text:string){this.notice.textContent=text;this.notice.hidden=!text}
  schedule(){const doc=this.view.state.doc;if(doc===this.requested)return;this.pending=null;this.requested=doc;
   if(doc.length<=SYNC_MARKDOWN_LIMIT){forceRaw=false;this.client.cancel();this.status('');this.notifySettled();return}
   if(doc.length>ASYNC_MARKDOWN_LIMIT){this.client.cancel();this.status('超长笔记使用轻量源码编辑，内容与保存不受影响');this.notifySettled();return}
   if(!cachedDoc)this.status('正在准备预览，正文可继续编辑');this.requestId=this.client.request(doc.toString(),options.imageScope?.resources||[],!cachedDoc);
  }
  apply(){if(this.dead||!this.pending||this.requested!==this.view.state.doc||this.view.composing||this.view.compositionStarted||this.view.state.field(field).composing)return;
   const model=this.pending;this.pending=null;this.view.dispatch({effects:result.of({doc:this.view.state.doc,model})});this.status('');this.notifySettled();
  }
  update(update:any){if(update.docChanged)this.schedule()}
  start=()=>{if(!this.dead)this.view.dispatch({effects:composition.of(true)})};
  end=()=>{cancelAnimationFrame(this.frame);this.frame=requestAnimationFrame(()=>{if(this.dead)return;if(this.view.composing||this.view.compositionStarted){this.end();return}this.view.dispatch({effects:[composition.of(false),refresh.of(null)]});this.schedule();this.apply();this.notifySettled()})};
  destroy(){this.dead=true;this.client.destroy();this.notice.remove();cancelAnimationFrame(this.frame);this.view.contentDOM.removeEventListener('compositionstart',this.start);this.view.contentDOM.removeEventListener('compositionend',this.end)}
 });
 return [field,observer,EditorView.domEventHandlers({focus:(_e,v)=>{v.dispatch({effects:focus.of(true)});return false},blur:(_e,v)=>{if(!v.composing&&!v.compositionStarted)v.dispatch({effects:focus.of(false)});return false}})];
}
