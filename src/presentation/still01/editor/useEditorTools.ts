import { useEffect, useRef, useState } from "react";
/** Presentation only: choose which buttons fit the available viewport.
 * Native insets remain the ONLY keyboard geometry authority. No height CSS,
 * bottom offset, padding or scroll adjustment is written here.
 */
export function useEditorTools() {
  const root = useRef<HTMLDivElement>(null);
  const [bodyFocused, setBodyFocused] = useState(false);
  const [titleFocused, setTitleFocused] = useState(false);
  const [compactViewport, setCompactViewport] = useState(false);
  useEffect(() => {
    let baseline = window.innerHeight;
    let width = window.innerWidth;
    const update = () => {
      if (Math.abs(window.innerWidth - width) > 80) { width = window.innerWidth; baseline = window.innerHeight; }
      baseline = Math.max(baseline, window.innerHeight);
      const focused = Boolean(root.current?.querySelector('.st-note-editor')?.contains(document.activeElement)
        || root.current?.querySelector('.st-editor-tools')?.contains(document.activeElement));
      setBodyFocused(focused);
      setTitleFocused(Boolean(root.current?.querySelector('.st-note-title')?.contains(document.activeElement)));
      setCompactViewport(window.innerHeight < baseline * .8);
    };
    const focus = () => { queueMicrotask(update); };
    document.addEventListener('focusin', focus); document.addEventListener('focusout', focus);
    window.addEventListener('resize', update); window.visualViewport?.addEventListener('resize', update);
    update();
    return () => {
      document.removeEventListener('focusin', focus); document.removeEventListener('focusout', focus);
      window.removeEventListener('resize', update); window.visualViewport?.removeEventListener('resize', update);
    };
  }, []);
  // Hardware-keyboard / desktop users also have a directly reachable strip.
  const touch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
  return { root, bodyFocused, titleFocused, expanded: bodyFocused && (compactViewport || !touch) };
}
