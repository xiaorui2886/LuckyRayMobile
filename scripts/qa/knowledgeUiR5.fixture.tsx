import React from 'react';import {createRoot} from 'react-dom/client';
import DesktopNotePreview from '../../src/components/DesktopNotePreview';
import {MobileCmEditor} from '../../src/presentation/still01/editor/MobileCmEditor';
import {NoteSurface,Option} from '../../src/presentation/still01/Still';
import {NoteActionIcon} from '../../src/presentation/still01/editor/NoteActionIcon';
import {api} from '../../src/services/client';
export {wikiCompletionBounds} from '../../src/presentation/still01/editor/wikiCompletionLayout';
export {api};
export function mount(el:HTMLElement,record:(x:any)=>void){
 let version='v1',online=true,scope='qa-reader',editing=false,sourceMode=false;
 const ref={current:null as any};const root=createRoot(el);
 const resource=()=>({resourceId:'image-1',target:'safe.png',status:'resolved',mimeType:'image/png',version});
 api.contentCachedResource=async(...args)=>{await new Promise(r=>setTimeout(r,2));record(['cache',...args]);return {path:'/qa/'+version+'.png',mime:'image/png'}};
 api.contentNoteResource=async(...args)=>{record(['fetch',...args]);await new Promise(r=>setTimeout(r,40));return {path:'/qa/'+version+'.png',mime:'image/png'}};
 api.contentCancel=async(job)=>{record(['cancel',job])};
 const render=()=>root.render(<div className="st-app"><NoteSurface title="QA" body="![Image](safe.png)" notebook="QA" state="local" mode={editing?'edit':'read'} onBack={()=>{}} onBrowse={()=>{}} onMore={()=>{}} onNew={()=>{}} onEdit={()=>{}} onRead={()=>{}} onChange={()=>{}} onFormat={()=>{}} onSearch={()=>{}} onState={()=>{}}
  readingContent={<DesktopNotePreview instance="pc" vault="v" note={scope} content="![Image](safe.png)" resources={[resource()]} online={online} onWikiLink={()=>{}}/>}
  bodyEditor={<MobileCmEditor scope={scope} value="![Image](safe.png)\n[[]]" sourceMode={sourceMode} handleRef={ref} onChange={v=>record(['change',v])}
   wikiLoader={async()=>({items:[{id:'a',title:'测试笔记',target:'a'}],partial:false})}
   imageScope={{instance:'pc',vault:'v',note:scope,online:false,resources:[resource()]}}/>}/>
  <Option label="源码模式" iconSlot={<NoteActionIcon name="code" size={23}/>} onClick={()=>{}}/>
 </div>);
 render();return {root,ref,render,setOnline(v:boolean){online=v;render()},setVersion(v:string){version=v;render()},setScope(v:string){scope=v;render()},edit(){editing=true;render()},source(v:boolean){sourceMode=v;render()}};
}
