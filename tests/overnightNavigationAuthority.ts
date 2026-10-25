import assert from 'node:assert/strict';
/** Only the explicitly requested gesture/viewport wiring is normalized. The
 * accepted icon paths, command toolbar, palette and all other kit bytes stay
 * pinned to their original hashes rather than silently refreshing snapshots. */
export function normalizeOvernightNavigation(source: string): string {
 const drop = (fragment: string) => { assert.equal(source.split(fragment).length, 2, 'one reviewed navigation addition: ' + fragment); source = source.replace(fragment, ''); };
 if (source.includes('export function NoteSurface(')) drop('import { useHorizontalSwipe } from "../../still/kit/useHorizontalSwipe";\n');
 else drop('import { useSourceSwipe } from "../../still/kit/useHorizontalSwipe";\n');
 if (source.includes('export function NoteSurface(')) {
  drop("import {useNoteViewportStability} from './editor/noteViewportStability';\n");
  drop(' useNoteViewportStability(tools.root);\n');
  drop(' // Existing notes are moved by NotePaperRail; no second gesture owner here.\n');
  drop(' style={{touchAction:"pan-y"}}');
  drop("const swipe=useHorizontalSwipe(direction=>{const index=ROOTS.findIndex(r=>r.id===value)+(direction==='left'?1:-1);if(ROOTS[index])onChange(ROOTS[index].id)});");
  drop(' data-swipe-owner="tabs" {...swipe} style={{touchAction:\'pan-y\'}}');
 } else {
  drop(" const sourceSwipe=useSourceSwipe(p.source,p.onSource,{disabled:Boolean(p.selecting)});\n");
  drop(' data-swipe-owner="sources" {...sourceSwipe} style={{touchAction:"pan-y"}}');
 }
 return source;
}
