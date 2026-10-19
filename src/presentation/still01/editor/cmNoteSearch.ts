import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { bodyMatchRanges, type BodyRange } from "../../../still/kit/noteSearch.ts";

export const setNoteSearch = StateEffect.define<{ query: string; index: number }>();
export type NoteSearchState = { query: string; index: number; ranges: BodyRange[]; decorations: DecorationSet };

function matches(state: EditorState, query: string, index: number): NoteSearchState {
  const ranges = bodyMatchRanges(state.doc.toString(), query);
  const active = ranges.length ? Math.max(0, Math.min(index, ranges.length - 1)) : 0;
  const decorations = Decoration.set(ranges.map((range, i) => Decoration.mark({
    class: i === active ? "st-note-find-hit is-current" : "st-note-find-hit",
  }).range(range.from, range.to)));
  return { query, index: active, ranges, decorations };
}

/** Decorations are presentation only: no selection, document or history changes. */
export const noteSearchField = StateField.define<NoteSearchState>({
  create: state => matches(state, "", 0),
  update(value, tr) {
    const effect = tr.effects.find(effect => effect.is(setNoteSearch));
    if (effect?.is(setNoteSearch)) return matches(tr.state, effect.value.query, effect.value.index);
    return tr.docChanged ? matches(tr.state, value.query, value.index) : value;
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations),
});
