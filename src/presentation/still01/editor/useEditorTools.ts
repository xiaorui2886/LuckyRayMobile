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
  // null means a focused editor mounted with an already-short viewport: no
  // observed keyboard transition yet, so chrome must stay available.
  const [keyboardOpen, setKeyboardOpen] = useState<boolean | null>(null);
  useEffect(() => {
    const visibleHeight = () => Math.min(window.innerHeight, window.visualViewport?.height ?? window.innerHeight);
    let baseline = visibleHeight(), unknownHeight = baseline;
    let width = window.innerWidth, visibility: boolean | null = null;
    const update = () => {
      const height = visibleHeight();
      const rotated = Math.abs(window.innerWidth - width) > 80;
      if (rotated) { width = window.innerWidth; baseline = height; unknownHeight = height; visibility = null; }
      const focused = Boolean(root.current?.querySelector('.st-note-editor')?.contains(document.activeElement)
        || root.current?.querySelector('.st-editor-tools')?.contains(document.activeElement));
      const active = document.activeElement;
      const anyTextFocused = focused || Boolean(active && active.matches('input,textarea,[contenteditable="true"]'));
      setBodyFocused(focused);
      setTitleFocused(Boolean(root.current?.querySelector('.st-note-title')?.contains(document.activeElement)));
      // A visibility signal only; native insets still determine all layout.
      // Keep an open keyboard open through its resize/overshoot animation.
      if (height < baseline * .8) visibility = true;
      else if (visibility === true && height >= baseline * .92) visibility = false;
      else if (visibility === null && (!anyTextFocused || (!rotated && height > unknownHeight * 1.15))) visibility = false;
      baseline = Math.max(baseline, height);
      setKeyboardOpen(visibility);
      setCompactViewport(visibility === true);
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
  return { root, bodyFocused, titleFocused, keyboardOpen, expanded: bodyFocused && (compactViewport || !touch) };
}
