/** Document-end breathing room, not an IME inset or Markdown mutation. Native
 * layout remains the viewport authority; only its observed loss is measured. */
export function noteTailSpace(closedHeight:number, visibleHeight:number, toolbarHeight:number, rememberedKeyboard=0){
 const closed=Math.max(0,closedHeight), lost=Math.max(0,closed-visibleHeight);
 const keyboard=lost>closed*.12?lost:rememberedKeyboard||closed*.38;
 return Math.round(Math.min(closed*.65,Math.max(0,keyboard)+Math.max(0,toolbarHeight)));
}
export type TailCaret={scroller:HTMLElement;top:number;bottom:number;endBottom:number;collapsed:boolean};
/** Eligibility and visibility are separate: only the rendered document tail
 * within the currently measured IME + visible toolbar range may move. endBottom
 * is the content end, excluding decorative tail padding and virtual viewport.
 * Spacer fallbacks/caps must never widen this gate. */
export function tailRevealDelta(caret:Pick<TailCaret,'top'|'bottom'|'endBottom'|'collapsed'>,visibleTop:number,visibleBottom:number,maxDelta:number,tailRange:number,revealing=false){
 const height=visibleBottom-visibleTop;
 if(!caret.collapsed||height<=0||caret.top<visibleTop||!Number.isFinite(tailRange)||tailRange<=0)return 0;
 // Subpixel subtraction may differ by a floating-point ulp while scrolling.
 const distance=caret.endBottom-caret.bottom;
 if(!Number.isFinite(distance)||distance< -1e-6||distance>tailRange+1e-6)return 0;
 // A visible caret must not move merely because it enters the comfort margin.
 if(caret.bottom<=visibleBottom-(revealing?12:0))return 0;
 return Math.max(0,Math.min(maxDelta,caret.bottom-visibleBottom+12));
}
