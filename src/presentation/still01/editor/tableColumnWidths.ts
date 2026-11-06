/** Bounded visible-content proportions shared by reading and live editing.
 * URL/source markup length must never force a column past the viewport. */
export function tableColumnWidths(rows:readonly (readonly string[])[]):number[]{
 const columns=rows[0]?.length||0;if(!columns)return [];
 const weights=Array.from({length:columns},(_,column)=>Math.max(4,Math.min(24,Math.max(...rows.map(row=>Array.from(row[column]||'').reduce((width,char)=>width+(/[^\x00-\x7f]/.test(char)?2:1),0))))));
 const total=weights.reduce((sum,width)=>sum+width,0);return weights.map(width=>width/total*100);
}
