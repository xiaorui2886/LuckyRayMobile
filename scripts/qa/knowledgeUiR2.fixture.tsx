import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NoteSurface } from '../../src/presentation/still01/Still';
import { FolderRows, FolderBreadcrumbs } from '../../src/still/kit/knowledgeFolders';
import { ScopedNoteSwitcher } from '../../src/still/kit/noteSwitcher';
import { DirectoryStatusLine } from '../../src/still/kit/directoryStatusLine';
import { DesktopKnowledgeStatus } from '../../src/still/kit/desktopKnowledgeStatus';
import { api } from '../../src/services/client';
export function mountKnowledgeFixture(element: HTMLElement, desktop: boolean, record: (event:unknown)=>void) {
 api.localNoteList = async filters => { record(['list-local',filters]); return { items:[{noteId:'note-qa',title:'本机测试',content:'仅合成内容'}],total:1,hasMore:false }; };
 api.contentReplicaNotes = async (instance,vault,q,page,directory) => { record(['list-desktop',instance,vault,q,page,directory]); return { items:[{noteId:'qa',instanceId:instance,vaultId:vault,title:'电脑测试',relativePath:'QA.md',content:'仅合成内容'}],total:1,hasMore:false } as any; };
 function Fixture(){
  const [mode,setMode]=useState<'read'|'edit'>('read'),[sheet,setSheet]=useState(''),[directory,setDirectory]=useState('项目/参考');
  return <div className="st-app" data-reduced="true">
    <FolderBreadcrumbs current={directory} onSelect={path=>{record(['folder',path]);setDirectory(path)}}/>
    <FolderRows snapshot={{instance:'pc',vault:'v',paths:['项目','项目/参考','项目/参考/图片'],phase:'ready',complete:true,origin:'services',savedAt:1}} current={directory} online={false} showStatus={false} onSelect={setDirectory}/>
    <DirectoryStatusLine quiet snapshot={{phase:'ready',source:'cache',rows:[{noteId:'n'}]} as any} onConnect={()=>{}}/>
    <DesktopKnowledgeStatus quiet snapshot={{phase:'offline',rows:[{noteId:'n'}],replica:{}} as any} onConnect={()=>{}}/>
    <NoteSurface title="合成笔记" body="" notebook="不应显示的来源" savedLabel="不应显示的状态" mode={mode} state="pending"
      onBrowse={()=>setSheet('browse')} onSearch={()=>setSheet('search')} onMore={()=>record(['more'])} onRelations={()=>record(['relations'])}
      onRead={()=>{record(['read']);setMode('read')}} onEdit={()=>{record(['edit']);setMode('edit')}} onChange={()=>{}}
      onCommand={command=>record(['command',command])} onAttach={()=>record(['attachment'])}
      onBack={()=>record(['back'])} onNew={()=>{}} onFormat={()=>{}} onState={()=>{}}/>
    {sheet ? <ScopedNoteSwitcher key={sheet} variant={sheet==='browse'?'browse':'search'} scope={desktop?{instance:'pc',vault:'v',directory:''}:undefined}
      registerOverlay={()=>()=>{}} onClose={()=>setSheet('')} onPick={(route,_search,isCurrent)=>{if(isCurrent()){record(['pick',route]);setSheet('')}}}/> : null}
  </div>;
 }
 const root=createRoot(element);root.render(<Fixture/>);return root;
}
