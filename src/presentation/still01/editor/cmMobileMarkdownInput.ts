import { EditorView, keymap } from '@codemirror/view';
import { mobileMarkdownEnterTransaction } from './mobileMarkdownCommands.ts';

const nativeEnter = new WeakMap<EditorView, { state: EditorView['state']; at: number }>();
export function trackMobileMarkdownBeforeInput(view: EditorView, input: Pick<InputEvent, 'isComposing' | 'inputType'>): void {
  nativeEnter.delete(view);
  if (!input.isComposing && !view.composing && !view.compositionStarted
    && ['insertParagraph', 'insertLineBreak'].includes(input.inputType)) {
    nativeEnter.set(view, { state: view.state, at: Date.now() });
  }
}
export function runMobileMarkdownEnter(view: EditorView, from?: number, to?: number): boolean {
  if (view.composing || view.compositionStarted || !view.hasFocus) return false;
  const transaction = mobileMarkdownEnterTransaction(view.state, from, to);
  if (!transaction) return false;
  nativeEnter.delete(view);
  view.dispatch(transaction);
  return true;
}

/** Android may ignore preventDefault on beforeinput even when cancelable.
 * Do not dispatch there: let CM's native Android delayed-key/DOM observer
 * synthesize Enter, which reaches our keymap before the default Enter binding.
 * Other native DOM input falls back to inputHandler only with explicit Enter
 * provenance. A pasted newline and IME candidate commit are never Enter. */
export const cmMobileMarkdownInput = [
  keymap.of([{ key: 'Enter', run: view => runMobileMarkdownEnter(view) }]),
  EditorView.domEventHandlers({
    beforeinput(event, view) {
      trackMobileMarkdownBeforeInput(view, event as InputEvent);
      return false;
    },
    paste(_event, view) { nativeEnter.delete(view); return false; },
    compositionstart(_event, view) { nativeEnter.delete(view); return false; },
    blur(_event, view) { nativeEnter.delete(view); return false; },
  }),
  EditorView.inputHandler.of((view, from, to, text) => {
    const intent = nativeEnter.get(view);
    nativeEnter.delete(view);
    if (text !== '\n' || !intent || intent.state !== view.state || Date.now() - intent.at > 1000
      || view.composing || view.compositionStarted) return false;
    return runMobileMarkdownEnter(view, from, to);
  }),
];
