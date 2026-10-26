import { useEffect, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { MobileGraphSettings, defaultMobileGraphSettings } from '../../src/features/graph/MobileGraphSettings';
import { MobileGraphIcon } from '../../src/features/graph/MobileGraphIcon';
import { TabBar } from '../../src/presentation/still01/Still';
import '../../src/presentation/still01/still.css';
import '../../src/presentation/still01/defaultTheme.css';
import '../../src/features/graph/mobileGraph.css';
import '../../src/still/kit/knowledgeActions.css';
function Fixture() {
  const [value,onChange]=useState(defaultMobileGraphSettings),[open,setOpen]=useState(false),[playing,setPlaying]=useState(false);
  const [inbox,setInbox]=useState(false),[inboxClicks,setInboxClicks]=useState(0),[noteClicks,setNoteClicks]=useState(0);
  useEffect(()=>{const show=()=>setInbox(true);window.addEventListener('fixture-show-inbox',show);return ()=>window.removeEventListener('fixture-show-inbox',show);},[]);
  return <div data-inbox-clicks={inboxClicks} data-note-clicks={noteClicks} className="st-app" data-mode="light" style={{'--st-safe-top':'24px','--st-safe-bottom':'16px'} as CSSProperties}>
    {inbox&&<button className="st-import-inbox-trigger" onClick={()=>setInboxClicks(n=>n+1)}>待处理导入 2</button>}
    <div className="st-root-stage">
    <div className="st-view mg-view"><div className="st-collection-head"><div className="st-source"><button>笔记</button><button aria-pressed="true">图谱</button></div></div>
      <div className="mg-source-row"><select aria-label="图谱知识库"><option>本机笔记</option><option>一个很长的知识库名称用来验证完整边界</option></select><button aria-label="刷新图谱"><MobileGraphIcon name="refresh"/></button></div>
      <div className={`mg-stage${open ? ' is-settings-open' : ''}`}><div className="mg-tools"><button aria-label="打开图谱设置" aria-pressed={open} onClick={()=>setOpen(!open)}><MobileGraphIcon name="settings"/></button><button aria-label="播放图谱动画"><MobileGraphIcon name="play"/></button><button aria-label="适应画布"><MobileGraphIcon name="fit"/></button><button aria-label="更多图谱操作">···</button></div>
        {inbox&&!open&&<div className="mg-selection"><button onClick={()=>setNoteClicks(n=>n+1)}>打开笔记</button></div>}
        {open&&<MobileGraphSettings value={value} onChange={onChange} onClose={()=>setOpen(false)} onReset={()=>onChange(defaultMobileGraphSettings())} folders={['笔记/一个很长的文件夹路径用于验证边界']} playing={playing} onPlay={()=>setPlaying(true)} onStop={()=>setPlaying(false)} focusAvailable={false} registerOverlay={()=>()=>{}}/>}
      </div>
    </div><TabBar value="knowledge" onChange={()=>{}} />
    </div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
