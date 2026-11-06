import {normalizeOvernightNavigation} from "./overnightNavigationAuthority.ts";
import assert from 'node:assert/strict';

/** Normalize only the requested note chrome wiring. Original frozen palette,
 * icons, toolbar handlers and unrelated kit bytes remain under their old hash. */
export function normalizeNoteChrome(source: string): string {
 // Reverse only the authorized title wrapping adapter; retain the original
 // input handlers, palette/icons and every unrelated byte under frozen hashes.
 const titleWrap = [
  ["import { useNoteTitleLayout } from './editor/noteTitleLayout';\n", ''],
  ["import './editor/noteTitle.css';\n", ''],
  [' const titleInput=useRef<HTMLTextAreaElement>(null);', ' const titleInput=useRef<HTMLInputElement>(null);'],
  [' useNoteTitleLayout(titleInput,p.title,editable);\n', ''],
  ['<textarea ref={titleInput} rows={1} wrap="soft"', '<input ref={titleInput}'],
  ["onChange={e=>p.onChange(e.target.value.replace(/[\\r\\n]/g,''),p.body)} placeholder=\"标题\"", 'onChange={e=>p.onChange(e.target.value,p.body)} placeholder="标题"'],
 ];
 for (const [addition, original] of titleWrap) {
  assert.equal(source.split(addition).length, 2, 'one scoped title wrap adapter: '+addition);
  source = source.replace(addition, original);
 }
 source=normalizeOvernightNavigation(source);
 const exact = [
  "import { useNoteChrome } from './editor/useNoteChrome';\n",
  ";chromeBlocked?:boolean",
  " const hasWarning=['metadata','conflict','error'].includes(p.state)&&p.bodyAvailability!=='loading';\n useNoteChrome(tools.root,{scope:p.editorScope,mode:p.mode,blocked:p.chromeBlocked||hasWarning,keyboardOpen:tools.keyboardOpen});\n",
  '+(hasWarning?" has-note-warning":"")',
 ];
 for (const fragment of exact) {
  assert.equal(source.split(fragment).length,2,'one scoped chrome addition: '+fragment);
  source=source.replace(fragment,'');
 }
 const heading=/\n\n <NoteBodyTransition heading=\{(editable\?<input ref=\{titleInput\}[\s\S]*?<\/h1>)\} mode=/;
 const match=source.match(heading);assert.ok(match,'one title slot, retaining original input handlers');
 const title=match[1].replace('<h1 className="st-note-title">','<h1>');
 source=source.replace(heading,'\n {'+title+'}\n <NoteBodyTransition mode=');
 return source;
}
