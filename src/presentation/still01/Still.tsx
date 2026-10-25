import {useNoteViewportStability} from './editor/noteViewportStability';
import { useHorizontalSwipe } from "../../still/kit/useHorizontalSwipe";
import { useNoteChrome } from './editor/useNoteChrome';
import { NoteBodyTransition } from './editor/NoteBodyTransition';
import { systemBarScrim } from "../../services/systemBarAppearance";
import { NoteActionIcon, noteActionPaths } from './editor/NoteActionIcon';
import { type EditorCommand } from './editor/editorCommands';
import { toolbarCommands } from './editor/editorToolbarPreferences';
import { useToolbarPreferences } from './editor/useToolbarPreferences';
import { useEditorTools } from './editor/useEditorTools';
import React, {useEffect, useLayoutEffect, useRef, useState, type ReactNode} from 'react';
import { isReadingControl, readingOffsetAtPoint } from './editor/noteTapEditing';

export const iconPaths: Record<string, ReactNode> = {
 home:<><path d="m3.5 10 8.5-7 8.5 7v10H15v-6H9v6H3.5Z"/></>,
 library:<><rect x="3.5" y="3.5" width="6" height="6" rx="1.4"/><rect x="14.5" y="3.5" width="6" height="6" rx="1.4"/><rect x="3.5" y="14.5" width="6" height="6" rx="1.4"/><rect x="14.5" y="14.5" width="6" height="6" rx="1.4"/></>,
 knowledge:<><path d="M12 5.5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1v-15c-3-1-6-1-9 1Z"/><path d="M12 5.5v15"/></>,
 ai:<><path d="M12 3c.5 5.4 3.6 8.5 9 9-5.4.5-8.5 3.6-9 9-.5-5.4-3.6-8.5-9-9 5.4-.5 8.5-3.6 9-9Z"/></>,
 user:<><circle cx="12" cy="8" r="3.6"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/></>,
 settings:<><path d="m9.8 3-.5 2.2-2 .9-2-.7-2.1 3.7L5 10.6v2.8l-1.8 1.5 2.1 3.7 2-.7 2 .9.5 2.2h4.4l.5-2.2 2-.9 2 .7 2.1-3.7-1.8-1.5v-2.8l1.8-1.5-2.1-3.7-2 .7-2-.9-.5-2.2Z"/><circle cx="12" cy="12" r="3.2"/></>,
 plus:<path d="M12 4v16M4 12h16"/>, search:<><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.4 15.4 5 5"/></>,
 back:<path d="m14.5 5-7 7 7 7"/>, right:<path d="m9.5 5 7 7-7 7"/>, down:<path d="m6 9 6 6 6-6"/>,
 close:<path d="m6 6 12 12M6 18 18 6"/>, check:<path d="m5 12 4.5 4.5L19 7"/>,
 more:<><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/></>,
 folder:<path d="M3 7V5.5A1.5 1.5 0 0 1 4.5 4H10l2 3h7.5A1.5 1.5 0 0 1 21 8.5v10a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5Z"/>,
 file:<><path d="M5 3h9l5 5v13H5Z"/><path d="M14 3v6h5M8 13h8M8 17h6"/></>,
 image:<><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.4"/><path d="m3 17 6-6 5 5 3-3 4 4"/></>,
 edit:<><path d="m15.5 3.5 5 5-11 11L3 21l1.5-6.5Z"/><path d="m13 6 5 5"/></>,
 link:<><path d="m10 7 2-2a5 5 0 0 1 7 7l-2 2M14 17l-2 2a5 5 0 0 1-7-7l2-2M8 16l8-8"/></>,
 paperclip:<path d="m8 13 7-7a3 3 0 0 1 4 4l-9 9a5 5 0 0 1-7-7l9-9M6 15l8-8"/>,
 list:<><path d="M8 5h13M8 12h13M8 19h13"/><circle cx="3" cy="5" r=".8" fill="currentColor"/><circle cx="3" cy="12" r=".8" fill="currentColor"/><circle cx="3" cy="19" r=".8" fill="currentColor"/></>,
 filter:<><path d="M4 6h16M7 12h10M10 18h4"/></>,
 inbox:<><path d="M5 4h14l3 11v5H2v-5Z"/><path d="M2 15h6l2 3h4l2-3h6"/></>,
 monitor:<><rect x="2.5" y="3.5" width="19" height="13" rx="2"/><path d="M12 16.5V21M7 21h10"/></>,
 refresh:<><path d="M20 9a8 8 0 1 0-1 9M20 3v6h-6"/></>,
 stop:<rect x="6" y="6" width="12" height="12" rx="2"/>,
 play:<path d="m8 5 11 7-11 7Z"/>,
 eye:<><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></>,
 info:<><circle cx="12" cy="12" r="9"/><path d="M12 10v7M12 7v.2"/></>,
 share:<><path d="M12 15V2m-4 4 4-4 4 4M7 10H4v11h16V10h-3"/></>,
 camera:<><path d="M3 7h4l2-3h6l2 3h4v14H3Z"/><circle cx="12" cy="13" r="4"/></>,
 trash:<><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></>,
 sun:<><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5l1.5 1.5M5 19l1.5-1.5M17.5 6.5 19 5"/></>,
 moon:<path d="M20 14A8.8 8.8 0 0 1 10 3a9 9 0 1 0 10 11Z"/>,
 clock:<><circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/></>,
 pin:<><path d="M12 3.5c2.3 0 4.1 1.8 4.1 4 0 3-2.7 5.8-3.7 6.7-.2.2-.6.2-.8 0-1-.9-3.7-3.7-3.7-6.7 0-2.2 1.8-4 4.1-4Z"/><path d="M12 14.5V20"/></>,
 heart:<><path d="M12 20.2C7.2 16.9 3.6 13.8 3.6 9.9c0-2.4 1.8-4.3 4.1-4.3 1.7 0 3.3 1 4.3 2.6 1-1.6 2.6-2.6 4.3-2.6 2.3 0 4.1 1.9 4.1 4.3 0 3.9-3.6 7-8.4 10.3Z"/></>,
 keyboard:<><rect x="2" y="4" width="20" height="12" rx="2"/><path d="M6 8h1m4 0h1m4 0h1M6 12h11m-8 7 3 3 3-3"/></>,
 archive:<><path d="M3 3h18v5H3ZM5 8v13h14V8M9 12h6"/></>,
 select:<><rect x="3.5" y="3.5" width="10" height="10" rx="2.4"/><path d="m6.2 8.4 2 2 3.1-3.4"/><path d="M9.5 16.5h11v-11h-3.2" opacity=".55"/></>,
 text:<><path d="M4 5h16M12 5v15M8 20h8"/></>,
 zoom:<><circle cx="10" cy="10" r="6.5"/><path d="m15 15 6 6M7 10h6M10 7v6"/></>,
};
export function Icon({name,size=20,className}: {name:string;size?:number;className?:string}) {return <svg className={'st-icon'+(className?' '+className:'')} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{iconPaths[name]||noteActionPaths[name as keyof typeof noteActionPaths]||iconPaths.file}</svg>}
export function IconButton({icon,label,onClick,active=false,disabled=false,className=''}:{icon:string;label:string;onClick:()=>void;active?:boolean;disabled?:boolean;className?:string}){return <button type="button" className={'st-icon-button '+className+(active?' is-active':'')} aria-label={label} title={label} aria-pressed={active||undefined} disabled={disabled} onClick={onClick}><Icon name={icon}/></button>}
export function Button({children,onClick,kind='primary',disabled=false}: {children:ReactNode;onClick:()=>void;kind?:'primary'|'quiet'|'danger';disabled?:boolean}){return <button type="button" className={'st-button st-button--'+kind} onClick={onClick} disabled={disabled}>{children}</button>}
export function SearchField({value,onChange,placeholder='搜索',autoFocus=false}:{value:string;onChange:(s:string)=>void;placeholder?:string;autoFocus?:boolean}){return <div className="st-search"><Icon name="search" size={18}/><input type="search" aria-label={placeholder} value={value} autoFocus={autoFocus} onChange={e=>onChange(e.target.value)} placeholder={placeholder}/>{value&&<IconButton icon="close" label="清除搜索" onClick={()=>onChange('')}/>}</div>}
export function SearchLauncher({onClick}: {onClick:()=>void}){return <button className="st-search st-search-launcher" onClick={onClick}><Icon name="search" size={18}/><span>搜索手机上的内容</span></button>}
export type Root='home'|'library'|'ai'|'knowledge'|'settings';
export const ROOTS: {id:Root;label:string;icon:string}[]=[{id:'home',label:'首页',icon:'home'},{id:'library',label:'素材',icon:'library'},{id:'ai',label:'AI',icon:'ai'},{id:'knowledge',label:'知识',icon:'knowledge'},{id:'settings',label:'我的',icon:'user'}];
export function TabBar({value,onChange}: {value:Root;onChange:(v:Root)=>void}){const swipe=useHorizontalSwipe(direction=>{const index=ROOTS.findIndex(r=>r.id===value)+(direction==='left'?1:-1);if(ROOTS[index])onChange(ROOTS[index].id)});return <nav data-swipe-owner="tabs" {...swipe} style={{touchAction:'pan-y'}} className="st-tab-wrap" aria-label="主要导航"><div className="st-tab-bar">{ROOTS.map(r=><button key={r.id} className={'st-tab'+(value===r.id?' is-current':'')} aria-label={r.label} aria-current={value===r.id?'page':undefined} onClick={()=>onChange(r.id)}><Icon name={r.icon} size={22}/></button>)}</div></nav>}
export function SourceSwitch({value,onChange}:{value:'local'|'desktop';onChange:(v:'local'|'desktop')=>void}){return <div className="st-source" role="group" aria-label="内容来源"><span className={'st-source-glide '+(value==='desktop'?'is-desktop':'')} aria-hidden="true"/>{(['local','desktop'] as const).map(x=><button key={x} aria-pressed={x===value} onClick={()=>onChange(x)}><span className="st-source-label">{x==='local'?'本机':'电脑'}</span></button>)}</div>}
export function Header({title,left,right}:{title?:ReactNode;left?:ReactNode;right?:ReactNode}){return <header className="st-header"><div className="st-header-side">{left}</div><div className="st-header-title">{title}</div><div className="st-header-side end">{right}</div></header>}
export function SectionTitle({children,action}: {children:ReactNode;action?:ReactNode}){return <div className="st-section-label"><h2>{children}</h2>{action}</div>}
export function Row({title,meta,icon,onClick,trail,thumb,reserveThumbSlot}:{title:ReactNode;meta?:ReactNode;icon?:string;onClick:()=>void;trail?:ReactNode;thumb?:string;reserveThumbSlot?:boolean}){const [thumbFailed,setThumbFailed]=React.useState(false);React.useEffect(()=>{setThumbFailed(false)},[thumb]);return <button className="st-row" onClick={onClick}>{thumb&&!thumbFailed?<img className="st-row-thumb" src={thumb} alt="" onError={()=>setThumbFailed(true)}/>:icon?<span className="st-row-symbol"><Icon name={icon}/></span>:reserveThumbSlot?<span className="st-row-thumb is-placeholder" aria-hidden="true"/>:null}<span className="st-row-copy"><strong>{title}</strong>{meta&&<small>{meta}</small>}</span><span className="st-row-end">{trail||<Icon name="right" size={15}/>}</span></button>}
export function Notice({children,tone='muted',onClick}:{children:ReactNode;tone?:'muted'|'pending'|'danger'|'success';onClick?:()=>void}){return <div className={'st-notice '+tone} role="status">{onClick?<button onClick={onClick}>{children}<Icon name="right" size={14}/></button>:children}</div>}
export function Empty({title,body,children,icon}: {title:string;body?:string;children?:ReactNode;icon?:string}){return <div className="st-empty">{icon&&<span className="st-empty-symbol"><Icon name={icon} size={28}/></span>}<h2>{title}</h2>{body&&<p>{body}</p>}{children&&<div className="st-empty-actions">{children}</div>}</div>}
export function Option({label,detail,selected,onClick,danger=false,icon,iconSlot}:{label:string;detail?:string;selected?:boolean;onClick:()=>void;danger?:boolean;icon?:string;iconSlot?:ReactNode}){return <button className={'st-option'+(danger?' danger':'')} onClick={onClick} aria-pressed={selected===undefined?undefined:selected}>{iconSlot??(icon&&<Icon name={icon} size={19}/>)}<span>{label}{detail&&<small>{detail}</small>}</span>{selected!==undefined?(selected?<Icon name="check" size={18}/>:<span className="st-check-space"/>):<Icon name="right" size={14}/>}</button>}

/** Pure presentation: no native Back/IME listener. The host supplies registerDismiss.
 * The grip is also a screen-reader/keyboard-accessible button, with no visible X.
 * All dismiss paths share one guarded animation. Business commits remain callbacks.
 */
export function Sheet({title,children,onClose,footer,registerDismiss,busy=false}:{title:string;children:ReactNode;onClose:()=>void;footer?:ReactNode;registerDismiss?:(f:()=>void)=>()=>void;busy?:boolean}){
 useEffect(() => systemBarScrim.acquire(), []);
 const ref=useRef<HTMLDivElement>(null),dismiss=useRef(onClose),busyRef=useRef(busy);
 dismiss.current=onClose;busyRef.current=busy;
 const [shown,setShown]=useState(false),[drag,setDrag]=useState(0),[dragging,setDragging]=useState(false);
 const start=useRef<{y:number;t:number;pointer:number}|null>(null),closing=useRef(false),done=useRef(false);
 const timer=useRef<ReturnType<typeof setTimeout>|null>(null),suppressClick=useRef(false),suppressTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
 function finish(){if(!closing.current||done.current)return;done.current=true;if(timer.current)clearTimeout(timer.current);dismiss.current()}
 function close(){
  if(busyRef.current||closing.current)return;
  closing.current=true;setDragging(false);setShown(false);
  const app=ref.current?.closest('.st-app');
  const reduce=app?.getAttribute('data-reduced')==='true'||window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  timer.current=setTimeout(finish,reduce?1:300); // fallback only; transitionend normally completes it
 }
 useEffect(()=>{
  const before=document.activeElement as HTMLElement|null;
  const r=requestAnimationFrame(()=>{setShown(true);ref.current?.focus({preventScroll:true})});
  const release=registerDismiss?.(close);
  function key(e:KeyboardEvent){
   if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();close()}
   if(e.key==='Tab'){
    const f=Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input,textarea,[tabindex="0"]')||[]).filter(x=>x.offsetParent!==null);
    if(!f.length){e.preventDefault();return}
    const first=f[0],last=f[f.length-1],current=document.activeElement;
    if(!f.includes(current as HTMLElement)){e.preventDefault();(e.shiftKey?last:first).focus()}
    else if(e.shiftKey&&current===first){e.preventDefault();last.focus()}
    else if(!e.shiftKey&&current===last){e.preventDefault();first.focus()}
   }
  }
  document.addEventListener('keydown',key,true);
  return ()=>{
   cancelAnimationFrame(r);if(timer.current)clearTimeout(timer.current);if(suppressTimer.current)clearTimeout(suppressTimer.current);
   release?.();document.removeEventListener('keydown',key,true);
   if(before?.isConnected&&!before.closest('[aria-hidden="true"]'))before.focus({preventScroll:true});
  }
 },[]);
 return <div className={'st-modal'+(shown?' is-shown':'')+(closing.current?' is-closing':'')}>
  <div className="st-scrim" onClick={close} aria-hidden="true"/>
  <div ref={ref} className={'st-sheet'+(dragging?' is-dragging':'')} role="dialog" tabIndex={-1} aria-modal="true" aria-label={title} aria-busy={busy||undefined}
   onTransitionEnd={e=>{if(e.target===e.currentTarget&&e.propertyName==='transform')finish()}}
   style={{transform:shown?`translateY(${drag}px)`:'translateY(105%)'}}>
   <div className="st-sheet-grip">
    <button className="st-sheet-handle" type="button" aria-label={'收起'+title} disabled={busy}
     onClick={()=>{if(!suppressClick.current)close()}}
     onPointerDown={e=>{if(busyRef.current||closing.current||e.button>0)return;suppressClick.current=false;start.current={y:e.clientY,t:performance.now(),pointer:e.pointerId};setDragging(true);e.currentTarget.setPointerCapture(e.pointerId)}}
     onPointerMove={e=>{if(start.current?.pointer!==e.pointerId)return;const dy=Math.max(0,e.clientY-start.current.y);if(dy>4)suppressClick.current=true;setDrag(dy)}}
     onPointerUp={e=>{
      if(!start.current||start.current.pointer!==e.pointerId)return;
      const dy=e.clientY-start.current.y,dt=performance.now()-start.current.t;
      start.current=null;setDragging(false);if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);
      if(dy>72||(dy>20&&dy/Math.max(dt,1)>.6))close();else setDrag(0);
      // A cancelled/short drag must not synthesize a click that closes the sheet.
      if(suppressTimer.current)clearTimeout(suppressTimer.current);
      suppressTimer.current=setTimeout(()=>{suppressClick.current=false},0);
     }}
     onPointerCancel={()=>{start.current=null;suppressClick.current=true;setDragging(false);setDrag(0)}}>
     <i aria-hidden="true"/>
    </button>
   </div>
   <div className="st-sheet-heading"><h2>{title}</h2></div>
   <div className="st-sheet-body">{children}</div>
   {footer&&<div className="st-sheet-footer">{footer}</div>}
  </div>
 </div>
}

/** Home-only floating capture. Other screens keep their contextual import/new actions. */
export function HomeCapture({root,onCapture}:{root:Root;onCapture:()=>void}){
 return root==='home'?<button className="st-compose" type="button" onClick={onCapture} aria-label="快速收集" title="快速收集"><Icon name="plus" size={20}/></button>:null;
}

export type NoteState='local'|'synced'|'metadata'|'outdated'|'pending'|'conflict'|'error';
export interface NoteSurfaceProps {title:string;body:string;notebook:string;mode:'read'|'edit';state:NoteState;bodyAvailability?:"loading"|"online"|"offline"|"error";savedLabel?:string;onBack:()=>void;onBrowse:()=>void;onMore:()=>void;onNew:()=>void;onEdit:(bodyOffset?:number)=>void;onRead?:()=>void;onChange:(title:string,body:string)=>void;onFormat:()=>void;onSearch:()=>void;onState:()=>void;onAttach?:()=>void;onCommand?:(command:EditorCommand)=>void;onRelations?:()=>void;readOnly?:boolean;readingContent?:ReactNode;/** The same retained CM editor replaces only the body textarea. */bodyEditor?:ReactNode;editorScope?:string;chromeBlocked?:boolean}
export function NoteSurface(p:NoteSurfaceProps){
 // Existing notes are moved by NotePaperRail; no second gesture owner here.
 const input=useRef<HTMLTextAreaElement>(null);
 const titleInput=useRef<HTMLInputElement>(null);
 // A committed reading transition ends title editing too; failed saves keep focus.
 useLayoutEffect(()=>{const title=titleInput.current;if(p.mode==='read'&&title&&title.ownerDocument.activeElement===title)title.blur()},[p.mode]);
 const tools=useEditorTools();
 useNoteViewportStability(tools.root);
 const hasWarning=['metadata','conflict','error'].includes(p.state)&&p.bodyAvailability!=='loading';
 useNoteChrome(tools.root,{scope:p.editorScope,mode:p.mode,blocked:p.chromeBlocked||hasWarning,keyboardOpen:tools.keyboardOpen});
 const commands=toolbarCommands(useToolbarPreferences());
 const gesture=useRef<{x:number;y:number;dragged:boolean}|null>(null);
 const pendingBody=useRef<number|null>(null);
 const pointer=useRef<{x:number;y:number;at:number}|null>(null);
 const warnings:Record<string,string>={metadata:'正文还没存到手机',conflict:'这篇笔记有两个版本',error:'尚未保存 · 请保留此页重试'};
 const noBody=p.state==='metadata', editable=!noBody&&!p.readOnly;
 const beginBody=(offset:number)=>{if(!editable)return;pendingBody.current=offset;p.onEdit(offset)};
 // Only an explicit body gesture focuses the fallback. Route mount and
 // title focus never schedule a competing body focus or scroll reset.
 useLayoutEffect(()=>{if(p.mode==='edit'&&!p.bodyEditor&&pendingBody.current!==null){const at=pendingBody.current;pendingBody.current=null;input.current?.focus({preventScroll:true});input.current?.setSelectionRange(at,at)}},[p.mode,p.bodyEditor]);
 const tapBody=(event:React.MouseEvent<HTMLDivElement>)=>{
   const start=pointer.current;pointer.current=null;
   if(!editable||event.defaultPrevented||event.button!==0||isReadingControl(event.target as Element,event.currentTarget))return;
   if(start&&(Math.hypot(event.clientX-start.x,event.clientY-start.y)>8||Date.now()-start.at>550))return;
   const selection=event.currentTarget.ownerDocument.getSelection();
   if(selection&&!selection.isCollapsed)return;
   beginBody(event.detail===0?0:readingOffsetAtPoint(event.currentTarget,p.body,event.clientX,event.clientY));
 };
 return <div ref={tools.root} style={{touchAction:"pan-y"}} className={"st-note-surface"+(tools.expanded?" has-editor-tools":"")+(tools.titleFocused?" is-title-focused":"")+(hasWarning?" has-note-warning":"")}><Header left={<button type="button" className="st-icon-button" aria-label="打开笔记列表" title="打开笔记列表" onClick={p.onBrowse}><NoteActionIcon name="sidebar"/></button>} right={<div className="st-note-header-actions">
   {!noBody&&<button type="button" className="st-icon-button" aria-label={p.mode==='edit'?'切换到阅读模式':'切换到编辑模式'} title={p.mode==='edit'?'阅读模式':'编辑模式'} disabled={p.mode==='edit'?!p.onRead:!editable} onPointerDown={e=>e.preventDefault()} onClick={()=>p.mode==='edit'?p.onRead?.():p.onEdit()}><NoteActionIcon name={p.mode==='edit'?'reading':'edit'}/></button>}
   {p.onRelations?<button type="button" className="st-icon-button" aria-label="笔记链接" title="笔记链接" onClick={p.onRelations}><NoteActionIcon name="more"/></button>:null}
 </div>}/>

 {warnings[p.state]&&p.bodyAvailability!=='loading'&&<Notice tone={p.state==='conflict'||p.state==='error'?'danger':p.state==='pending'?'pending':'muted'} onClick={p.onState}>{warnings[p.state]}</Notice>}
 {/* Touch arbitration stops at this scroll container, before the outer swipe owner. */}
 <main style={{touchAction:'pan-y'}} className={'st-note-paper'+(p.mode==='edit'?' is-editing':'')}>
 {noBody?<><h1>{p.title}</h1>{p.bodyAvailability==='loading'?<div className="st-note-opening" role="status" aria-label="正在读取笔记"><i/><i/><i/></div>:<Empty title={p.bodyAvailability==='online'||p.bodyAvailability==='error'?"正文暂未读取":"连接电脑后，继续阅读"} body={p.bodyAvailability==='online'||p.bodyAvailability==='error'?"正文还没有缓存到手机，请稍后重试。":"标题和位置已保存，正文尚未缓存。"}><Button kind="quiet" onClick={p.onState}>{p.bodyAvailability==='online'||p.bodyAvailability==='error'?"查看状态":"查看连接"}</Button></Empty>}</>:<>

 <NoteBodyTransition heading={editable?<input ref={titleInput} className="st-note-title" aria-label="笔记标题" enterKeyHint="done" onKeyDown={e=>{if(e.key==='Enter'&&!e.nativeEvent.isComposing&&e.keyCode!==229){e.preventDefault();p.onRead?.()}}} value={p.title} onFocus={()=>{if(p.mode==='read')p.onEdit()}} onChange={e=>p.onChange(e.target.value,p.body)} placeholder="标题"/>:<h1 className="st-note-title">{p.title||'未命名笔记'}</h1>} mode={p.mode==='edit'&&editable?'edit':'read'} scope={p.editorScope} body={p.body} editor={p.bodyEditor??<textarea ref={input} className="st-note-editor" aria-label="笔记正文" value={p.body} onChange={e=>p.onChange(p.title,e.target.value)} placeholder="" spellCheck={false}/>}><div className={'st-note-prose'+(editable?' is-tap-editable':'')} tabIndex={editable?0:undefined} aria-label={editable?'笔记正文，点击输入':'笔记正文'}
   onPointerDown={e=>{pointer.current=e.isPrimary&&e.button===0?{x:e.clientX,y:e.clientY,at:Date.now()}:null}}
   onPointerCancel={()=>{pointer.current=null}} onClick={tapBody}
   onKeyDown={e=>{if(editable&&e.target===e.currentTarget&&(e.key==='Enter'||e.key===' ')){e.preventDefault();beginBody(0)}}}>
   {p.readingContent||(p.body?p.body.split('\n\n').map((x,i)=><p key={i}>{x}</p>):<span className="st-note-placeholder" aria-hidden="true"/>)}
 </div></NoteBodyTransition>
 </>}
 </main><div className="st-reader-bottom">
   <div className="st-reader-tools st-note-navigation" role="toolbar" aria-label="笔记工具">
     <button type="button" className="st-note-nav-button" aria-label="返回上一页" title="返回上一页" onClick={p.onBack}><NoteActionIcon name="back" size={25}/></button>
     <button type="button" className="st-note-nav-button" aria-label="查找笔记" title="查找笔记" onClick={p.onSearch}><NoteActionIcon name="search" size={25}/></button>
     <button type="button" className="st-note-nav-button" aria-label="新建笔记" title="新建笔记" onClick={p.onNew}><NoteActionIcon name="plus" size={25}/></button>
     <button type="button" className="st-note-nav-button" aria-label="笔记更多操作" title="笔记更多操作" onClick={p.onMore}><NoteActionIcon name="menu" size={25}/></button>
   </div>
   {p.mode==='edit'&&editable&&p.onCommand?<div className="st-reader-tools st-editor-tools" role="toolbar" aria-label="编辑工具，可左右滑动"
     onPointerDown={e=>{gesture.current={x:e.clientX,y:e.clientY,dragged:false};e.preventDefault()}}
     onPointerMove={e=>{const start=gesture.current;if(start&&Math.hypot(e.clientX-start.x,e.clientY-start.y)>8)start.dragged=true}}
     onPointerCancel={()=>{if(gesture.current)gesture.current.dragged=true}}
     onClickCapture={e=>{if(e.detail!==0&&gesture.current?.dragged){e.preventDefault();e.stopPropagation()}gesture.current=null}}
   >
     {commands.map((item,index)=><React.Fragment key={item.command}>
       {index===Math.min(3,commands.length-1)&&p.onAttach?<button type="button" aria-label="插入附件" title="插入附件" onMouseDown={e=>e.preventDefault()} onClick={p.onAttach}><Icon name="paperclip" size={20}/></button>:null}
       <button type="button" className={'st-editor-command command-'+item.command} aria-label={item.label} title={item.label}
         onMouseDown={e=>e.preventDefault()} onClick={()=>p.onCommand?.(item.command)}><NoteActionIcon name={item.command}/></button>
     </React.Fragment>)}
     <button type="button" aria-label="更多文本格式" onMouseDown={e=>e.preventDefault()} onClick={p.onFormat}>Aa</button>
     <button type="button" aria-label="收起编辑工具" onClick={()=>{(document.activeElement as HTMLElement)?.blur()}}><Icon name="keyboard" size={20}/></button>
   </div>:null}
 </div></div>

}
