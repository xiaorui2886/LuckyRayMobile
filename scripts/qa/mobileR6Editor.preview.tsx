import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {NoteSurface} from '../../src/presentation/still01/Still';
import {MobileCmEditor} from '../../src/presentation/still01/editor/MobileCmEditor';
import DesktopNotePreview from '../../src/components/DesktopNotePreview';
import {api} from '../../src/services/client';
import '../../src/design/tokens.css';import '../../src/app.css';import '../../src/presentation/still01/still.css';import '../../src/still/kit/noteExperience.css';
const svg='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="380"><rect width="640" height="380" fill="#c0c7b9"/><circle cx="430" cy="140" r="70" fill="#eee8dc"/><path d="M0 380V240L200 120 420 380" fill="#697968"/><path d="M230 380L510 200 640 300V380" fill="#96a48f"/></svg>');
(window as any).__TAURI_INTERNALS__={convertFileSrc:()=>svg};
api.contentCachedResource=async()=>({path:'/safe.png',mime:'image/png',etag:'1'});api.contentNoteResource=api.contentCachedResource as any;api.contentCancel=async()=>{};
const resources=[{resourceId:'safe',target:'attachments/safe.png',status:'resolved',mimeType:'image/png',version:'1'}];
const original='今天的山野记录\n\n![[attachments/safe.png]]\n\n图片与文字之间保持轻巧的间距。\n\n'+Array.from({length:12},(_,i)=>`${i+1}. 继续记录，滑动到底部后输入，光标应保持可见。`).join('\n\n');
function App(){const[body,setBody]=useState(original),[edit,setEdit]=useState(true),[source,setSource]=useState(false),[dark,setDark]=useState(false),[short,setShort]=useState(false),[title,setTitle]=useState('山野与留白');const ref={current:null as any};
return <><div style={{position:'absolute',left:430,top:20,display:'grid',gap:12}}><button onClick={()=>setDark(!dark)}>切换深浅色</button><button onClick={()=>setEdit(!edit)}>阅读 / 编辑</button><button onClick={()=>setSource(!source)}>源码模式</button><button onMouseDown={e=>e.preventDefault()} onClick={()=>setShort(!short)}>模拟键盘可用高度</button></div><div className="st-app" data-theme={dark?'dark':'light'} data-mode={dark?'dark':'light'} style={{width:390,height:short?430:780,position:'relative',background:'var(--st-canvas)',color:'var(--st-ink)',overflow:'hidden'}}>
<NoteSurface title={title} body={body} notebook="QA" state="local" mode={edit?'edit':'read'} onBack={()=>{}} onBrowse={()=>{}} onMore={()=>setSource(!source)} onNew={()=>{}} onEdit={()=>setEdit(true)} onRead={()=>setEdit(false)} onChange={(t,b)=>{setTitle(t);setBody(b)}} onFormat={()=>{}} onSearch={()=>{}} onState={()=>{}} onCommand={c=>ref.current?.runCommand(c)}
readingContent={<DesktopNotePreview instance="synthetic" vault="v" note="n" content={body} resources={resources} online={false} onWikiLink={()=>{}}/>}
bodyEditor={<MobileCmEditor scope="mobile-r6-preview" value={body} onChange={setBody} handleRef={ref} sourceMode={source} imageScope={{instance:'synthetic',vault:'v',note:'n',online:false,resources}} wikiLoader={async()=>({items:[{id:'n2',target:'旅行日记.md',title:'旅行日记'}],partial:false})}/>}/>
</div></>}
createRoot(document.getElementById('root')!).render(<App/>);
