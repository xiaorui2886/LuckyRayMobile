import React from 'react';import {createRoot} from 'react-dom/client';
import {MobileCmEditor} from '../../src/presentation/still01/editor/MobileCmEditor';
import {api} from '../../src/services/client';
export {editorImageRanges} from '../../src/presentation/still01/editor/cmInlineImages';
export function mount(el:HTMLElement,record:(x:unknown)=>void){
 let scope='qa-local',value='[[]]',active=true;const ref={current:null as any};
 api.contentCachedResource=async(instance,id,vault,note)=>{record(['cached',instance,id,vault,note]);return {path:'/qa/approved.png',mime:'image/png'}};
 const root=createRoot(el);
 const render=()=>root.render(<div className="st-app"><MobileCmEditor scope={scope} value={value} handleRef={ref} assistActive={active}
  onChange={next=>{value=next;record(['change',next])}}
  wikiLoader={async q=>{record(['query',q]);await new Promise(r=>setTimeout(r,q==='slow'?350:10));return {items:[{id:'note-one',title:'示例笔记',target:'note-one'}],partial:false}}}
  imageScope={{instance:'pc',vault:'v',note:scope,online:false,resources:[{resourceId:'image-1',target:'safe.png',status:'resolved',mimeType:'image/png'}]}}/>
 </div>);
 render();return {root,ref,setValue(next:string){value=next;render()},retire(){active=false;render()},changeScope(){scope='qa-next';value='next';render()}};
}

export {wikiChoices} from '../../src/still/kit/wikiChoices';
export {api};
