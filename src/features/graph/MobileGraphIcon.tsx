import type { ReactNode } from 'react';
import { NoteActionIcon, noteActionPaths, type NoteActionName } from '../../presentation/still01/editor/NoteActionIcon';
const paths = {
  library: <path d="M3 7V5.5A1.5 1.5 0 0 1 4.5 4H10l2 3h7.5A1.5 1.5 0 0 1 21 8.5v10a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5Z"/>,
  info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></>,
  settings: <><path d="M12 3 14 6l3-.1.9 2.9 2.6 1.6-1.5 2.7.5 3-2.9 1.1L15 20l-3-1-3 1-1.6-2.8-2.9-1.1.5-3L3.5 10.4 6.1 8.8 7 5.9l3 .1Z"/><circle cx="12" cy="11.7" r="3"/></>,
  fit: <><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/><circle cx="12" cy="12" r="3"/></>,
  plus: <path d="M12 5v14M5 12h14"/>, minus: <path d="M5 12h14"/>,
  search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
  edit: <><path d="m15 4 5 5L9 20l-6 1 1-6Z"/><path d="m12 7 5 5"/></>,
  refresh: <><path d="M20 9a8 8 0 1 0-1 9M20 3v6h-6"/></>,
  close: <path d="m6 6 12 12M6 18 18 6"/>,
  share: <><path d="M12 15V3m-4 4 4-4 4 4M7 11H4v10h16V11h-3"/></>,
  play: <path d="m8 5 11 7-11 7Z"/>, stop: <rect x="6" y="6" width="12" height="12" rx="2"/>,
  controls: <><circle cx="5" cy="7" r="2"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="5" r="2"/><path d="m7 7 8-2M6 9l1 7M9 17l5-5M15 13h6M18 10v6"/></>,
  copy: <><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V3H3v13h5"/></>,
  ask: <><path d="M13 4H5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h3l4 3v-3h7a2 2 0 0 0 2-2v-4M18 2l1.4 3.6L23 7l-3.6 1.4L18 12l-1.4-3.6L13 7l3.6-1.4Z"/></>,
  local: <><path d="M8 5H4v16h16V5h-4M12 3v11m-4-4 4 4 4-4"/></>,
  neighborhood: <><circle cx="12" cy="12" r="3"/><circle cx="4" cy="4" r="1.5"/><circle cx="20" cy="5" r="1.5"/><circle cx="19" cy="20" r="1.5"/><circle cx="4" cy="19" r="1.5"/><path d="m6 6 4 4m4 0 4-4m-4 8 4 4M6 18l4-4"/></>,
  unlink: <><path d="m10 7 2-2a5 5 0 0 1 7 7l-2 2M14 17l-2 2a5 5 0 0 1-7-7l2-2M4 3l17 18M8 16l2-2m4-4 2-2"/></>,
  view: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M13 9h5m-2.5-2.5v5"/></>,
  arrange: <><circle cx="5" cy="5" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="12" cy="19" r="2"/><path d="m7 5 10 0M6 7l5 10m7-10-5 10"/></>,
} satisfies Record<string, ReactNode>;
export function MobileGraphIcon({ name }: { name: keyof typeof paths | NoteActionName }) {
  if (name in noteActionPaths) return <NoteActionIcon name={name as NoteActionName} />;
  return <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name as keyof typeof paths]}</svg>;
}
