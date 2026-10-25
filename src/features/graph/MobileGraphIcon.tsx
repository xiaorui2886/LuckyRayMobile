import type { ReactNode } from 'react';
const paths: Record<string, ReactNode> = {
  settings: <><path d="M12 3 14 6l3-.1.9 2.9 2.6 1.6-1.5 2.7.5 3-2.9 1.1L15 20l-3-1-3 1-1.6-2.8-2.9-1.1.5-3L3.5 10.4 6.1 8.8 7 5.9l3 .1Z"/><circle cx="12" cy="11.7" r="3"/></>,
  fit: <><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/><circle cx="12" cy="12" r="3"/></>,
  plus: <path d="M12 5v14M5 12h14"/>, minus: <path d="M5 12h14"/>,
  search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
  edit: <><path d="m15 4 5 5L9 20l-6 1 1-6Z"/><path d="m12 7 5 5"/></>,
  refresh: <><path d="M20 9a8 8 0 1 0-1 9M20 3v6h-6"/></>,
  close: <path d="m6 6 12 12M6 18 18 6"/>,
  share: <><path d="M12 15V3m-4 4 4-4 4 4M7 11H4v10h16V11h-3"/></>,
  play: <path d="m8 5 11 7-11 7Z"/>, stop: <rect x="6" y="6" width="12" height="12" rx="2"/>,
};
export function MobileGraphIcon({ name }: { name: keyof typeof paths }) { return <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>; }
