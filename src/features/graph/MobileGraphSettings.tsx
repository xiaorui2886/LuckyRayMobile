import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from 'react';
import { MobileGraphIcon } from './MobileGraphIcon';

export type MobileGraphSettingsState = {
  query: string; folder: string; createdOnly: boolean; sections: Record<string, boolean>;
  filters: Record<'note' | 'material' | 'tag' | 'web', boolean>;
  showIsolated: boolean; nearbyFilter: boolean; nearbyDepth: 1 | 2;
  colorMode: 'default' | 'type' | 'degree'; colorGroups: { query: string; color: string }[];
  showArrows: boolean; showLabels: boolean; labelReveal: number; nodeSize: number; edgeWidth: number;
  centerForce: number; repulsionForce: number; linkAttraction: number; linkLength: number; nodeSpacing: number;
};
export const defaultMobileGraphSettings = (): MobileGraphSettingsState => ({
  query: '', folder: '', createdOnly: false, sections: { filter: true, groups: false, appearance: true, force: false }, filters: { note: true, material: false, tag: false, web: false },
  showIsolated: true, nearbyFilter: false, nearbyDepth: 1, colorMode: 'type', colorGroups: [],
  showArrows: false, showLabels: true, labelReveal: .45, nodeSize: 6, edgeWidth: 1,
  centerForce: 50, repulsionForce: 50, linkAttraction: 50, linkLength: 180, nodeSpacing: 50,
});
export function GraphToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return <label className="mg-toggle"><span>{label}</span><input type="checkbox" role="switch" checked={checked} onChange={e => onChange(e.target.checked)} /><span className="mg-switch" aria-hidden="true" /></label>;
}
function Range({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (n: number) => void }) {
  return <label className="mg-range"><span>{label}<output>{value}</output></span><input type="range" style={{ '--mg-range-fill': `${(value - min) / (max - min) * 100}%` } as CSSProperties} min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} /></label>;
}
export function MobileGraphSettings({ value, onChange, onClose, onReset, folders, playing, onPlay, onStop, focusAvailable, registerOverlay, searchResults }: {
  value: MobileGraphSettingsState; onChange: (v: MobileGraphSettingsState) => void; onClose: () => void; onReset: () => void;
  folders: string[]; playing: boolean; onPlay: () => void; onStop: () => void; focusAvailable: boolean;
  registerOverlay: (dismiss: () => void) => () => void; searchResults?: ReactNode;
}) {
  const panel = useRef<HTMLElement>(null);
  const panelId = useId();
  const close = useRef(onClose), register = useRef(registerOverlay);
  close.current = onClose;
  const sections = value.sections;
  const patch = (changes: Partial<MobileGraphSettingsState>) => onChange({ ...value, ...changes });
  // The navigation context refreshes while the panel is open. Autofocus and
  // restore belong to this opening, not every new registerOverlay identity.
  useEffect(() => { const before = document.activeElement as HTMLElement | null; panel.current?.focus({ preventScroll: true }); const release = register.current(() => close.current()); return () => { release(); if (before?.isConnected) before.focus({ preventScroll: true }); }; }, []);
  const heading = (key: keyof typeof sections, label: string) => <button type="button" className="mg-section-title" aria-expanded={sections[key]} aria-controls={`${panelId}-${key}`} onClick={() => patch({ sections: { ...sections, [key]: !sections[key] } })}>
    <span>{label}</span><svg className="mg-section-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
  </button>;
  const changeGroup = (index: number, changes: { query?: string; color?: string }) => patch({ colorGroups: value.colorGroups.map((g, i) => i === index ? { ...g, ...changes } : g) });
  return <aside className="mg-settings" ref={panel} tabIndex={-1} aria-label="图谱设置" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
    <header className="mg-settings-actions"><h2>图谱设置</h2><button type="button" aria-label="重置图谱设置" title="重置图谱设置" onClick={onReset}><MobileGraphIcon name="refresh" /></button><button type="button" aria-label="关闭图谱设置" onClick={onClose}><MobileGraphIcon name="close" /></button></header>
    <div className="mg-settings-scroll">
    <section>{heading('filter', '筛选')}<div id={`${panelId}-filter`} hidden={!sections.filter} className="mg-section-body">
      <label className="mg-search"><span className="mg-sr-only">搜索文件</span><input type="search" placeholder="搜索文件…" value={value.query} onChange={e => patch({ query: e.target.value })} /></label>
      {searchResults}<label className="mg-select-row">文件夹<select value={value.folder} onChange={e => patch({ folder: e.target.value })}><option value="">全部文件夹</option>{folders.map(f => <option key={f} value={f}>{f}</option>)}</select></label>
      {(['note', 'material', 'tag', 'web'] as const).map((type, i) => <GraphToggle key={type} label={['笔记', '附件与素材', '标签', '网页'][i]} checked={value.filters[type]} onChange={checked => patch({ filters: { ...value.filters, [type]: checked } })} />)}
      <GraphToggle label="仅显示已创建的笔记" checked={value.createdOnly} onChange={createdOnly => patch({ createdOnly })} />
      <GraphToggle label="孤立文件" checked={value.showIsolated} onChange={showIsolated => patch({ showIsolated })} />
      <GraphToggle label="局部图谱" checked={value.nearbyFilter} onChange={nearbyFilter => patch({ nearbyFilter })} />
      {value.nearbyFilter && <><label className="mg-select-row">关联深度<select value={value.nearbyDepth} onChange={e => patch({ nearbyDepth: Number(e.target.value) as 1 | 2 })}><option value={1}>1 跳</option><option value={2}>2 跳</option></select></label>{!focusAvailable && <p className="mg-hint">先在图中选择一个节点。</p>}</>}
    </div></section>
    <section>{heading('groups', '颜色组')}<div id={`${panelId}-groups`} hidden={!sections.groups} className="mg-section-body">
      <label className="mg-select-row">着色方式<select value={value.colorMode} onChange={e => patch({ colorMode: e.target.value as MobileGraphSettingsState['colorMode'] })}><option value="type">按类型</option><option value="default">统一颜色</option><option value="degree">按连接数</option></select></label>
      <p className="mg-hint">从上到下，首个匹配的颜色优先。支持名称、tag:标签、path:路径。</p>
      {value.colorGroups.map((group, i) => <div className="mg-color-group" key={i}><input aria-label={`颜色组 ${i + 1} 规则`} placeholder="名称 / tag: / path:" value={group.query} maxLength={200} onChange={e => changeGroup(i, { query: e.target.value })} /><input type="color" aria-label={`颜色组 ${i + 1} 颜色`} value={group.color} onChange={e => changeGroup(i, { color: e.target.value })} /><div className="mg-group-order"><button type="button" disabled={!i} aria-label={`上移颜色组 ${i + 1}`} onClick={() => { const groups = [...value.colorGroups]; [groups[i - 1], groups[i]] = [groups[i], groups[i - 1]]; patch({ colorGroups: groups }); }}>↑</button><button type="button" disabled={i === value.colorGroups.length - 1} aria-label={`下移颜色组 ${i + 1}`} onClick={() => { const groups = [...value.colorGroups]; [groups[i + 1], groups[i]] = [groups[i], groups[i + 1]]; patch({ colorGroups: groups }); }}>↓</button><button type="button" aria-label={`删除颜色组 ${i + 1}`} onClick={() => patch({ colorGroups: value.colorGroups.filter((_, index) => index !== i) })}>删除</button></div></div>)}
      <button type="button" className="mg-text-button" disabled={value.colorGroups.length >= 16} onClick={() => patch({ colorGroups: [...value.colorGroups, { query: '', color: '#8b6ccf' }] })}>＋ 添加颜色组{value.colorGroups.length >= 16 ? '（已达 16 组）' : ''}</button>
    </div></section>
    <section>{heading('appearance', '外观')}<div id={`${panelId}-appearance`} hidden={!sections.appearance} className="mg-section-body">
      <GraphToggle label="箭头" checked={value.showArrows} onChange={showArrows => patch({ showArrows })} />
      <GraphToggle label="显示文字" checked={value.showLabels} onChange={showLabels => patch({ showLabels })} />
      <Range label="文字显示阈值" value={value.labelReveal} min={0} max={1.6} step={.05} onChange={labelReveal => patch({ labelReveal })} />
      <Range label="节点大小" value={value.nodeSize} min={3} max={12} onChange={nodeSize => patch({ nodeSize })} />
      <Range label="连线粗细" value={value.edgeWidth} min={.5} max={4} step={.5} onChange={edgeWidth => patch({ edgeWidth })} />
      <button type="button" className="mg-primary" onClick={playing ? onStop : onPlay}>{playing ? '停止动画' : '播放动画'}</button>
    </div></section>
    <section>{heading('force', '力度')}<div id={`${panelId}-force`} hidden={!sections.force} className="mg-section-body">
      <Range label="中心引力" value={value.centerForce} min={0} max={100} onChange={centerForce => patch({ centerForce })} />
      <Range label="节点斥力" value={value.repulsionForce} min={0} max={100} onChange={repulsionForce => patch({ repulsionForce })} />
      <Range label="连线引力" value={value.linkAttraction} min={0} max={100} onChange={linkAttraction => patch({ linkAttraction })} />
      <Range label="连线长度" value={value.linkLength} min={64} max={360} step={2} onChange={linkLength => patch({ linkLength })} />
      <Range label="节点间距" value={value.nodeSpacing} min={0} max={100} onChange={nodeSpacing => patch({ nodeSpacing })} />
    </div></section>
    </div>
  </aside>;
}
