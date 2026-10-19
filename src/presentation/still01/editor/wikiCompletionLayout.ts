/** CSS-pixel visual viewport, including IME/pinch offsets. Insets are kept on
 * both sides so a caret near the right edge cannot push candidates off-screen. */
export function wikiCompletionBounds(width:number,height:number,left=0,top=0){
 const inset=Math.min(12,Math.max(0,width/10));
 return {left:left+inset,right:left+Math.max(inset,width-inset),top:top+8,bottom:top+Math.max(8,height-8)};
}
