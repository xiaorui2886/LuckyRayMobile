import {StateEffect,type ChangeDesc} from "@codemirror/state";
import {invertedEffects} from "@codemirror/commands";
import type {EditorView} from "@codemirror/view";
/** Native cell IME is not owned by CodeMirror contenteditable. */
export const isTableCellComposing=(view:EditorView)=>Boolean(view.dom?.querySelector?.('.cm-lp-table-input[data-composing="true"]'));
export type TableFocusOwner={input:()=>HTMLTextAreaElement|null;contains:(position:number)=>boolean;history:(redo:boolean)=>boolean};
const owners=new WeakMap<EditorView,TableFocusOwner>();
export function ownTableFocus(view:EditorView,owner:TableFocusOwner){owners.set(view,owner)}
export function releaseTableFocus(view:EditorView,owner:TableFocusOwner){if(owners.get(view)===owner)owners.delete(view)}
export function nativeTableInput(view:EditorView){const input=owners.get(view)?.input();return input?.isConnected?input:null}
/** Only replace scrolling for the active native cell's source range. Searches,
 * explicit source mode and non-table CM selections retain normal scrolling. */
export function ownsTableScroll(view:EditorView,position:number){return !!nativeTableInput(view)&&!!owners.get(view)?.contains(position)}
export function runTableHistory(view:EditorView,redo:boolean):boolean|null {
 const owner=owners.get(view);return owner?.input()?.isConnected?owner.history(redo):null;
}

/** Source offsets cannot identify a cell across a whole-table replacement.
 * Keep both logical endpoints in CM history, not in an independent undo stack.
 * Carets are relative to the cell; only the table boundary maps with outside edits. */
export type TableCellSelection={row:number;column:number;anchor:number;head:number};
// Inserting outside text exactly before the table moves its identity right;
// replacing the table itself must keep the identity at the replacement start.
function mapTableFrom(from:number,changes:ChangeDesc){let association=-1;changes.iterChangedRanges((a,b)=>{if(a===from&&b===from)association=1});return changes.mapPos(from,association)}
export const tableStructureSelection=StateEffect.define<{from:number;before:TableCellSelection;after:TableCellSelection}>({
 map:(value,changes)=>({...value,from:mapTableFrom(value.from,changes)})
});
export const tableStructureHistory=invertedEffects.of(tr=>tr.effects.flatMap(effect=>effect.is(tableStructureSelection)?[
 tableStructureSelection.of({from:mapTableFrom(effect.value.from,tr.changes),before:effect.value.after,after:effect.value.before})
]:[]));
