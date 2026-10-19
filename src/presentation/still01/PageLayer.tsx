import React, {createContext, useContext, useLayoutEffect, useRef, type CSSProperties, type ReactNode} from 'react';

// Paint may be retained; whether this page can act must remain live.
const PageCurrentContext=createContext<boolean|undefined>(undefined);
export function usePageCurrent(fallback=true):boolean {
 return useContext(PageCurrentContext)??fallback;
}
export function useRetainedPage():boolean {
 return useContext(PageCurrentContext)!==undefined;
}

/** View-only retained layer. It does not create routes, save data, or listen to native Back.
 * The host's existing navigation/gesture authority supplies all props.
 * Covered content remains mounted (scroll/input retained) and stops receiving focus.
 */
export function PageLayer({children,current,blocked=false,covered,buried,masked=false,entered=true,leaving=false,revealing=false,progress=null,depth,onExited,onSettled}: {
 children:ReactNode;current:boolean;blocked?:boolean;covered:boolean;buried:boolean;masked?:boolean;entered?:boolean;
 leaving?:boolean;revealing?:boolean;progress?:number|null;depth:number;
 onExited?:()=>void;onSettled?:()=>void;
}) {
 const saved=useRef(children), node=useRef<HTMLDivElement>(null);
 if(current&&!leaving)saved.current=children;
 useLayoutEffect(()=>{
  const el=node.current;if(!el)return;
  // inert is progressive only. The tabindex fallback is required for older WebView.
  if('inert' in el)(el as HTMLDivElement & {inert:boolean}).inert=!current;
  if(current)return;
  const old:Array<[HTMLElement,string|null]>=[];
  for(const child of Array.from(el.querySelectorAll<HTMLElement>('button,input,textarea,select,a[href],[tabindex]'))){
   old.push([child,child.getAttribute('tabindex')]);child.setAttribute('tabindex','-1');
  }
  return()=>{for(const [child,value] of old){if(value===null)child.removeAttribute('tabindex');else child.setAttribute('tabindex',value)}};
 },[current]);
 const p=progress===null?null:Math.max(0,Math.min(1,progress));
 const style:CSSProperties={zIndex:20+depth};
 if(p!==null)style.transform=`translateX(${current?p*100:covered?-6*(1-p):0}%)`;
 return <PageCurrentContext.Provider value={current&&!leaving}><div ref={node} className={'st-detail-stage'+(entered?' is-entered':'')+(covered?' is-under':'')+(buried?' is-buried':'')+(masked&&p===null&&!revealing?' is-masked':'')+(leaving?' is-leaving':'')+(revealing?' is-revealing':'')+(p!==null?' is-gesture':'')}
  aria-hidden={!current||blocked||undefined} data-current={current?'true':undefined} data-layer-depth={depth} style={style}
  onTransitionEnd={e=>{if(e.target===e.currentTarget&&e.propertyName==='transform'){if(leaving)onExited?.();else onSettled?.()}}}>
  {saved.current}<div className="st-scene-shade" aria-hidden="true" style={p!==null&&covered?{opacity:.08*(1-p)}:undefined}/>
 </div></PageCurrentContext.Provider>;
}
