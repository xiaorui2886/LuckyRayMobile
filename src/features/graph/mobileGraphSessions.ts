import { normalizeGraphView } from './core/graphSemantics';
import { defaultMobileGraphSettings, type MobileGraphSettingsState } from './MobileGraphSettings';
import type { Camera } from './core/graphCamera';
export type MobileGraphTab = { id: string; name: string; settings: MobileGraphSettingsState; selectedKey: string | null; scopeKey: string | null; camera?: Camera };
export type MobileGraphSession = { tabs: MobileGraphTab[]; activeId: string };
let counter = 0;
export function newMobileGraphTab(index = 1): MobileGraphTab { return { id: `view-${Date.now()}-${++counter}`, name: index === 1 ? '全局图谱' : `图谱 ${index}`, settings: defaultMobileGraphSettings(), selectedKey: null, scopeKey: null }; }
export function readMobileGraphSession(sourceId: string): MobileGraphSession {
  try {
    const stored = JSON.parse(localStorage.getItem(`luckyray.mobile.graph.v1:${sourceId}`) || 'null');
    if (stored && Array.isArray(stored.tabs) && stored.tabs.length) {
      const tabs: MobileGraphTab[] = stored.tabs.slice(0, 12).filter((t: any) => typeof t?.id === 'string').map((t: any) => ({
        id: t.id, name: typeof t.name === 'string' ? t.name.slice(0, 40) : '图谱', selectedKey: typeof t.selectedKey === 'string' ? t.selectedKey : null,
        scopeKey: typeof t.scopeKey === 'string' ? t.scopeKey : null,
        settings: { ...defaultMobileGraphSettings(), ...normalizeGraphView(t.settings || {}), sections: { ...defaultMobileGraphSettings().sections, ...normalizeGraphView(t.settings || {}).sections }, query: typeof t.settings?.query === 'string' ? t.settings.query.slice(0, 200) : '', folder: typeof t.settings?.folder === 'string' ? t.settings.folder : '', createdOnly: t.settings?.createdOnly === true },
        ...(t.camera && Number.isFinite(t.camera.scale) && Number.isFinite(t.camera.panX) && Number.isFinite(t.camera.panY) ? { camera: { scale: Math.max(.025, Math.min(12, t.camera.scale)), panX: t.camera.panX, panY: t.camera.panY } } : {}),
      }));
      if (tabs.length) return { tabs, activeId: tabs.some(t => t.id === stored.activeId) ? stored.activeId : tabs[0].id };
    }
  } catch { /* Storage unavailable/corrupt: retain a usable in-memory graph. */ }
  const tab = newMobileGraphTab(); return { tabs: [tab], activeId: tab.id };
}
export function saveMobileGraphSession(sourceId: string, session: MobileGraphSession) { try { localStorage.setItem(`luckyray.mobile.graph.v1:${sourceId}`, JSON.stringify(session)); return true; } catch { return false; /* Keep navigation usable and let the caller report unsaved view state. */ } }
