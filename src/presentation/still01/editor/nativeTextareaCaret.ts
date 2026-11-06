/** Measure the native textarea's visual caret, not the bottom of its entire
 * wrapped cell. A temporary offscreen mirror is used only on a scheduled
 * focus/input/viewport measurement; it neither focuses nor mutates the note. */
export function nativeTextareaCaretRect(input:HTMLTextAreaElement):{top:number;bottom:number}|null {
 const doc=input.ownerDocument,win=doc.defaultView;if(!win)return null;
 const rect=input.getBoundingClientRect(),style=win.getComputedStyle(input);
 if(!rect.width||!rect.height)return null;
 const mirror=doc.createElement('div'),marker=doc.createElement('span');
 const copied=['fontFamily','fontSize','fontStyle','fontWeight','fontVariant','letterSpacing','lineHeight','textIndent','textTransform','textAlign','paddingTop','paddingRight','paddingBottom','paddingLeft','borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth','boxSizing','tabSize','wordBreak','overflowWrap'] as const;
 for(const key of copied)mirror.style[key]=style[key];
 Object.assign(mirror.style,{position:'fixed',left:'-10000px',top:'0',visibility:'hidden',pointerEvents:'none',width:`${rect.width}px`,height:'auto',whiteSpace:'pre-wrap',overflow:'hidden',borderStyle:'solid'});
 mirror.setAttribute('aria-hidden','true');
 const offset=input.selectionDirection==='backward'?input.selectionStart:input.selectionEnd;
 // Keep the full suffix in one span. A zero-width break inserted mid-word
 // would change wrapping and report the caret on the previous line.
 mirror.append(doc.createTextNode(input.value.slice(0,offset)));marker.textContent=input.value.slice(offset)||'\u2060';mirror.append(marker);doc.body.append(mirror);
 try{const measured=marker.getClientRects()[0]||marker.getBoundingClientRect(),base=mirror.getBoundingClientRect(),line=parseFloat(style.lineHeight)||parseFloat(style.fontSize)*1.5||20;
  const top=rect.top+measured.top-base.top-input.scrollTop;
  return {top,bottom:top+line};
 }finally{mirror.remove()}
}
