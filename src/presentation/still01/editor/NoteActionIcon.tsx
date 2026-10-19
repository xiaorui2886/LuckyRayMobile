import type { ReactNode } from 'react';
import type { EditorCommand } from './editorCommands';
export type NoteActionName = EditorCommand | 'sidebar' | 'reading' | 'edit' | 'more' | 'tag' | 'up' | 'down' | 'close' | 'back' | 'search' | 'plus' | 'menu' | 'rename' | 'pin' | 'heart' | 'archive' | 'tools' | 'info' | 'trash' | 'folder';
export const noteActionPaths: Record<NoteActionName, ReactNode> = {
 back:<path d="m15 18-6-6 6-6"/>,
 search:<><circle cx="10.5" cy="10.5" r="7.5"/><path d="m16 16 5 5"/></>,
 plus:<path d="M12 4v16M4 12h16"/>,
 menu:<path d="M4 5h16M4 12h16M4 19h16"/>,
 rename:<><path d="M4 7V4h16v3M12 4v16M8 20h8"/></>,
 pin:<><path d="M16 9V3H8v6l-3 4v2h14v-2ZM12 15v7"/></>,
 heart:<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>,
 archive:<><rect x="3" y="3" width="18" height="4" rx="1"/><path d="M5 7v13h14V7M10 11h4"/></>,
 tools:<><path d="M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6"/></>,
 info:<><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></>,
 trash:<><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></>,
 folder:<path d="M3 7V5a2 2 0 0 1 2-2h5l2 4h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>,
 up:<path d="m6 14 6-6 6 6"/>,
 down:<path d="m6 10 6 6 6-6"/>,
 close:<path d="m6 6 12 12M6 18 18 6"/>,
 tag:<><path d="M3 3h8l10 10-8 8L3 11Z"/><circle cx="7.5" cy="7.5" r="1"/></>,
 sidebar:<><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M8 4v16"/></>,
 reading:<><path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1ZM12 5v15"/></>,
 edit:<><path d="m15 4 5 5-10 10-6 1 1-6ZM13 6l5 5"/></>,
 more:<><circle cx="12" cy="5" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="19" r="1" fill="currentColor"/></>,
 undo:<><path d="m8 5-5 5 5 5M3 10h11a6 6 0 0 1 0 12" transform="translate(0 -2)"/></>,
 redo:<><path d="m16 5 5 5-5 5M21 10H10a6 6 0 0 0 0 12" transform="translate(0 -2)"/></>,
 wiki:<path d="M8 4H4v16h4M16 4h4v16h-4"/>,
 heading:<path d="M5 4v16M19 4v16M5 12h14"/>,
 bold:<><path d="M6 4h7a4 4 0 0 1 0 8H6ZM6 12h8a4 4 0 0 1 0 8H6Z" strokeWidth="2.2"/></>,
 italic:<path d="M10 4h9M5 20h9M15 4 9 20"/>,
 strike:<><path d="M18 6c-1-2-4-3-7-2-4 1-4 5-1 7M6 18c2 3 9 3 11 0 1-2 0-4-3-5M3 12h18"/></>,
 highlight:<><path d="m13 3 7 7-9 9-5-5ZM6 14l-3 6h6M15 6l3 3M3 22h13"/></>,
 code:<path d="m7 7-5 5 5 5M17 7l5 5-5 5M14 4l-4 16"/>,
 quote:<><path d="M4 5h6v8c0 4-2 6-5 7v-3c2-1 2-2 2-4H4ZM14 5h6v8c0 4-2 6-5 7v-3c2-1 2-2 2-4h-3Z"/></>,
 link:<><path d="m10 7 2-2a5 5 0 0 1 7 7l-2 2M14 17l-2 2a5 5 0 0 1-7-7l2-2M8 16l8-8"/></>,
 bullet:<><path d="M9 5h12M9 12h12M9 19h12"/><circle cx="4" cy="5" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="19" r="1" fill="currentColor"/></>,
 number:<><path d="M10 5h11M10 12h11M10 19h11M3 3h2v6M3 9h4M3 15c0-3 4-3 4 0 0 2-4 3-4 6h4"/></>,
 task:<><path d="M10 4H4v16h16v-8M9 10l4 4 8-10"/></>,
 indent:<path d="M11 5h10M11 12h10M11 19h10M3 8l4 4-4 4"/>,
 outdent:<path d="M11 5h10M11 12h10M11 19h10M7 8l-4 4 4 4"/>,
};
/** Stroke SVGs avoid Android font/combining-glyph differences. Parent buttons own labels. */
export function NoteActionIcon({ name, size=21 }: { name: NoteActionName; size?: number }) {
 return <svg className="st-note-action-icon" data-note-icon={name} viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{noteActionPaths[name]}</svg>;
}
