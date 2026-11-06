/** Shared focus admission for the mobile dock and text-control reveal path. */
const nonTextInputTypes = new Set([
  "checkbox", "radio", "range", "color", "file", "hidden", "button", "submit", "reset", "image",
]);
export function isTextEntryTarget(target: EventTarget | null): target is HTMLElement {
  if (target instanceof HTMLInputElement) return !nonTextInputTypes.has(target.type);
  return target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && Boolean(target.isContentEditable));
}
/** Scroll only the input that still owns focus after the keyboard settles. */
export function installTextEntryReveal(doc: Document): () => void {
  const view = doc.defaultView;
  if (!view) return () => {};
  let timer: number | undefined;
  const onFocus = (event: FocusEvent) => {
    if (timer !== undefined) view.clearTimeout(timer);
    timer = undefined;
    const target = event.target;
    if (!isTextEntryTarget(target)) return;
    timer = view.setTimeout(() => {
      timer = undefined;
      if (target.isConnected && doc.activeElement === target) {
        target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
      }
    }, 160);
  };
  doc.addEventListener('focusin', onFocus);
  return () => { doc.removeEventListener('focusin', onFocus); if (timer !== undefined) view.clearTimeout(timer); };
}
