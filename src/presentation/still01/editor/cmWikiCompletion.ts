import { wikiCompletionBounds } from './wikiCompletionLayout';
import { Prec, StateEffect, StateField, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, keymap, showTooltip, tooltips, type Tooltip, type ViewUpdate } from '@codemirror/view';
import { sameWikiCompletion, wikiCompletionAt, wikiInsertion, type WikiChoice, type WikiCompletion } from './wikiCompletion';
type Result={match:WikiCompletion;items:WikiChoice[];status:string;index:number};
export type WikiLoader=(query:string,embed?:boolean)=>Promise<{items:WikiChoice[];partial:boolean}>;
export function cmWikiCompletion(load:WikiLoader,enabled:()=>boolean):Extension {
 const space=(view?:EditorView)=>{
  const v=window.visualViewport,b=wikiCompletionBounds(v?.width||document.documentElement.clientWidth,v?.height||document.documentElement.clientHeight,v?.offsetLeft||0,v?.offsetTop||0);
  const toolbar=view?.dom.closest('.st-note-surface')?.querySelector('.st-reader-bottom')?.getBoundingClientRect();
  if(toolbar && toolbar.height>0 && toolbar.top>b.top)b.bottom=Math.min(b.bottom,toolbar.top-6);
  return b;
 };
 const replace=StateEffect.define<Result|null>();
 const accept=(view:EditorView,item:WikiChoice,result:Result)=>{
  if(!enabled()||!view.hasFocus||view.composing||view.compositionStarted)return false;
  const sel=view.state.selection.main;
  if(!sel.empty||!sameWikiCompletion(wikiCompletionAt(view.state.doc.toString(),sel.head),result.match))return false;
  const insert=wikiInsertion(item,Boolean(result.match.embed));if(!insert)return false;
  view.dispatch({changes:{from:result.match.from,to:result.match.to,insert},selection:{anchor:result.match.from+insert.length},effects:replace.of(null),userEvent:'input.complete'});
  view.focus();return true;
 };
 const field=StateField.define<Result|null>({create:()=>null,update(value,tr){for(const e of tr.effects)if(e.is(replace))return e.value;return tr.docChanged||tr.selection?null:value;},
  provide:f=>showTooltip.from(f,value=>value?({pos:value.match.from,above:false,strictSide:false,arrow:false,create(view){
   const dom=document.createElement('div');dom.className='st-wiki-completion';dom.setAttribute('role','listbox');dom.setAttribute('aria-label',value.match.embed?'匹配的附件':'匹配的笔记');
   const fit=()=>{const bounds=space(view);dom.style.width=Math.max(0,bounds.right-bounds.left)+'px';view.requestMeasure()};
   const style=getComputedStyle(view.dom);
   for(const key of ['--st-sheet','--st-ink','--st-line','--st-secondary','--st-selected'])dom.style.setProperty(key,style.getPropertyValue(key));
   dom.style.fontFamily=style.fontFamily;
   value.items.forEach((item,i)=>{const button=document.createElement('button');button.type='button';button.setAttribute('role','option');button.setAttribute('aria-selected',String(i===value.index));
    const name=document.createElement('strong');name.textContent=item.title;button.append(name);
    if(item.detail){const detail=document.createElement('small');detail.textContent=item.detail;button.append(detail)}
    let start:{x:number;y:number}|null=null,dragged=false;
    button.addEventListener('pointerdown',e=>{start={x:e.clientX,y:e.clientY};dragged=false;e.preventDefault()});
    button.addEventListener('pointermove',e=>{if(start&&Math.hypot(e.clientX-start.x,e.clientY-start.y)>8)dragged=true});
    button.addEventListener('pointercancel',()=>{dragged=true;start=null});
    button.addEventListener('mousedown',e=>e.preventDefault());
    button.addEventListener('click',e=>{if(e.detail===0||!dragged)accept(view,item,value);start=null});dom.append(button);
   });
   if(value.status){const status=document.createElement('div');status.className='st-wiki-completion-status';status.setAttribute('role','status');status.textContent=value.status;dom.append(status)}
   return {dom, getCoords(pos){const coords=view.coordsAtPos(pos)||view.dom.getBoundingClientRect();const bounds=space(view);return {...bounds,top:coords.top,bottom:coords.bottom,right:bounds.left}},
    mount(){fit();window.addEventListener('resize',fit);window.visualViewport?.addEventListener('resize',fit);window.visualViewport?.addEventListener('scroll',fit)},
    destroy(){window.removeEventListener('resize',fit);window.visualViewport?.removeEventListener('resize',fit);window.visualViewport?.removeEventListener('scroll',fit)}};
  }} satisfies Tooltip):null)});
 const plugin=ViewPlugin.fromClass(class {
  generation=0;timer:ReturnType<typeof setTimeout>|undefined;dead=false;
  constructor(readonly view:EditorView){this.schedule();view.contentDOM.addEventListener('compositionstart',this.composing);view.contentDOM.addEventListener('compositionend',this.ended)}
  composing=()=>{++this.generation;clearTimeout(this.timer);this.timer=setTimeout(()=>{if(!this.dead)this.view.dispatch({effects:replace.of(null)})},0)};
  ended=()=>this.schedule();
  update(u:ViewUpdate){
   if(u.transactions.some(tr=>tr.effects.some(e=>e.is(replace)&&e.value===null))){++this.generation;clearTimeout(this.timer)}
   if(u.docChanged||u.selectionSet||u.focusChanged)this.schedule()
  }
  schedule(){const token=++this.generation;clearTimeout(this.timer);this.timer=setTimeout(async()=>{
   if(this.dead||token!==this.generation)return;
   const view=this.view,sel=view.state.selection.main;
   const match=enabled()&&view.hasFocus&&sel.empty&&!view.composing&&!view.compositionStarted?wikiCompletionAt(view.state.doc.toString(),sel.head):null;
   if(!match){view.dispatch({effects:replace.of(null)});return}
   const current=()=>!this.dead&&token===this.generation&&enabled()&&view.hasFocus&&!view.composing&&!view.compositionStarted&&sameWikiCompletion(match,wikiCompletionAt(view.state.doc.toString(),view.state.selection.main.head));
   view.dispatch({effects:replace.of({match,items:[],status:'正在匹配…',index:0})});
   try{const result=await load(match.query,match.embed);if(!current())return;
    const items=result.items.filter(x=>wikiInsertion(x)!==null);
    view.dispatch({effects:replace.of({match,items,status:items.length?(result.partial?'继续输入可缩小范围':''):(result.partial?'当前结果无匹配，请继续输入更完整的名称':match.embed?'当前笔记中没有匹配的附件':'未找到匹配笔记'),index:0})});
   }catch{if(current())view.dispatch({effects:replace.of({match,items:[],status:'暂时无法读取候选，请稍后再试',index:0})})}
  },160)}
  destroy(){this.dead=true;++this.generation;clearTimeout(this.timer);this.view.contentDOM.removeEventListener('compositionstart',this.composing);this.view.contentDOM.removeEventListener('compositionend',this.ended)}
 });
 const step=(view:EditorView,delta:number)=>{const result=view.state.field(field);if(!enabled()||!view.hasFocus||!result||!result.items.length||view.composing||view.compositionStarted)return false;view.dispatch({effects:replace.of({...result,index:(result.index+delta+result.items.length)%result.items.length})});return true};
 return [tooltips({parent:document.body,position:"fixed",tooltipSpace:space}),field,plugin,Prec.highest(keymap.of([
  {key:'ArrowDown',run:v=>step(v,1)},{key:'ArrowUp',run:v=>step(v,-1)},
  {key:'Enter',run:v=>{const r=v.state.field(field);return !!r&&!!r.items[r.index]&&accept(v,r.items[r.index],r)}},
  {key:'Escape',run:v=>{if(v.composing||v.compositionStarted||!v.state.field(field))return false;v.dispatch({effects:replace.of(null)});return true}},
 ]))];
}
