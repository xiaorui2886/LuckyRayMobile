import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NoteSurface } from '../../src/presentation/still01/Still';
import { FolderRows, FolderBreadcrumbs } from '../../src/still/kit/knowledgeFolders';
import { KnowledgeLibrarySheet } from '../../src/still/kit/KnowledgeLibrarySheet';
import { KnowledgeNoteRow } from '../../src/still/kit/knowledgeNoteRow';
export function mount(element: HTMLElement, record: (event: unknown) => void) {
 function Fixture() {
  const [directory,setDirectory]=useState(''),[sheet,setSheet]=useState(false);
  const folders={instance:'pc',vault:'v',paths:['项目','项目/参考','项目/参考/长名称目录','空目录'],phase:'ready',complete:true,origin:'services',savedAt:1} as const;
  return <div className="st-app">
   <div className="st-knowledge-view"><FolderBreadcrumbs current={directory} onSelect={setDirectory}/>
    <FolderRows snapshot={{...folders,paths:[...folders.paths]}} current={directory} online showStatus={false} onSelect={setDirectory}/>
    <KnowledgeNoteRow title="合成笔记" body="合成摘要" meta="" noteId="qa" activateOnClick onClick={()=>record('note')}/>
   </div>
   <button onClick={()=>setSheet(true)}>库管理</button>
   {sheet?<KnowledgeLibrarySheet vaultName="合成库" registerOverlay={()=>()=>{}} onClose={()=>{record('close');setSheet(false)}} onLocal={()=>{record('local');setSheet(false)}} management={<button onClick={()=>record('cache')}>手机保存</button>}/>:null}
   <NoteSurface title="合成标题" body="正文" notebook="QA" state="local" mode="edit" onBack={()=>record('back')}
    onBrowse={()=>record('browse')} onMore={()=>{}} onNew={()=>{}} onEdit={()=>{}} onRead={()=>{}}
    onChange={()=>{}} onFormat={()=>{}} onSearch={()=>{}} onState={()=>{}} onCommand={()=>{}}/>
  </div>;
 }
 const root=createRoot(element);root.render(<Fixture/>);return root;
}
