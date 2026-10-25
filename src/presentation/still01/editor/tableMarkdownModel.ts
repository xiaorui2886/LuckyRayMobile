/** Conservative, lossless GFM pipe-table edits. Unsupported containers remain source-editable. */
export type TableCell = {from:number;to:number;value:string};
export type TableRow = {from:number;to:number;cells:TableCell[]};
export type EditableTable = {source:string;rows:TableRow[];delimiter:TableRow;align:('left'|'center'|'right'|null)[];newline:string};
export type TableChange = {from:number;to:number;insert:string};
function splitRow(line:string,from:number):TableRow|null {
 if(/^\s*>|^\s*[-+*]\s/.test(line))return null;
 const pipes:number[]=[];
 for(let i=0;i<line.length;i++)if(line[i]==='|'){let n=0;for(let j=i-1;j>=0&&line[j]==='\\';j--)n++;if(n%2===0)pipes.push(i)}
 if(!pipes.length)return null;
 const leading=/^[ \t]*\|/.test(line),trailing=/\|[ \t]*$/.test(line)&&pipes[pipes.length-1]===line.lastIndexOf('|');
 const bounds=[...(leading?[]:[-1]),...pipes,...(trailing?[]:[line.length])];
 const cells:TableCell[]=[];
 for(let i=0;i<bounds.length-1;i++){const start=bounds[i]+1,end=bounds[i+1],raw=line.slice(start,end);const left=/^[ \t]*/.exec(raw)![0].length,right=/[ \t]*$/.exec(raw)![0].length;const a=start+left,b=Math.max(a,end-right);cells.push({from:from+a,to:from+b,value:line.slice(a,b)})}
 return cells.length?{from,to:from+line.length,cells}:null;
}
export function editableTable(source:string):EditableTable|null {
 if(source.length>24000)return null;
 const newline=source.includes('\r\n')?'\r\n':'\n',lines=source.split(/\r?\n/);if(lines.length<2||lines.length>201)return null;
 let offset=0;const rows:TableRow[]=[];
 for(const line of lines){const row=splitRow(line,offset);if(!row)return null;rows.push(row);offset+=line.length+newline.length}
 const columns=rows[0].cells.length;if(columns>32||rows.some(r=>r.cells.length!==columns))return null;
 const delimiter=rows[1];if(delimiter.cells.some(c=>!/^:?-{3,}:?$/.test(c.value)))return null;
 const align=delimiter.cells.map(c=>c.value.startsWith(':')?(c.value.endsWith(':')?'center':'left'):c.value.endsWith(':')?'right':null) as EditableTable['align'];
 return {source,rows:[rows[0],...rows.slice(2)],delimiter,align,newline};
}
/** Cell editor exposes inline Markdown, never serializes rendered text. */
export function safeCellInput(value:string):string {
 // Cell inputs are single-line Markdown: pasted newlines/tabs become spaces, never extra rows or HTML.
 const text=value.replace(/\r\n?|\n/g,' ').replace(/\t/g,' ');let result='',slashes=0;
 for(const char of text){if(char==='|'&&slashes%2===0)result+='\\';result+=char;slashes=char==='\\'?slashes+1:0}return result;
}
export function editTableCell(table:EditableTable,row:number,column:number,value:string):TableChange|null {
 const cell=table.rows[row]?.cells[column];if(!cell)return null;return {from:cell.from,to:cell.to,insert:safeCellInput(value)};
}
export type TableOperation='row-before'|'row-after'|'row-delete'|'column-before'|'column-after'|'column-delete'|'align-left'|'align-center'|'align-right'|'row-up'|'row-down'|'row-duplicate'|'column-left'|'column-right'|'column-duplicate'|'sort-ascending'|'sort-descending';
export function tableOperation(table:EditableTable,row:number,column:number,operation:TableOperation):TableChange|null {
 const {rows,delimiter,source,newline}=table,columns=rows[0].cells.length;
 if(!rows[row]||column<0||column>=columns)return null;
 const rowText=(cells:string[])=>'| '+cells.join(' | ')+' |';
 if(operation==='row-up'||operation==='row-down')return reorderTable(table,'row',row,row+(operation==='row-up'?-1:1));
 if(operation==='column-left'||operation==='column-right')return reorderTable(table,'column',column,column+(operation==='column-left'?-1:1));
 if(operation==='row-duplicate'){
  if(row===0)return null;const target=rows[row];return {from:target.to,to:target.to,insert:newline+source.slice(target.from,target.to)};
 }
 if(operation==='sort-ascending'||operation==='sort-descending'){
  const sorted=rows.slice(1).map((r,i)=>({r,i})).sort((a,b)=>{
   const delta=a.r.cells[column].value.localeCompare(b.r.cells[column].value,undefined,{numeric:true,sensitivity:'base'});
   return (operation==='sort-descending'?-delta:delta)||a.i-b.i;
  });
  return {from:0,to:source.length,insert:[source.slice(rows[0].from,rows[0].to),source.slice(delimiter.from,delimiter.to),...sorted.map(({r})=>source.slice(r.from,r.to))].join(newline)};
 }
 if(operation.startsWith('align-')){const c=delimiter.cells[column];return {from:c.from,to:c.to,insert:operation==='align-left'?':---':operation==='align-right'?'---:':':---:'}}
 if(operation==='row-before'||operation==='row-after'){
  // A header cannot move below the delimiter. Before-header inserts the first body row.
  const target=row===0?delimiter:rows[row];const before=operation==='row-before'&&row>0;
  return before?{from:target.from,to:target.from,insert:rowText(Array(columns).fill(''))+newline}:{from:target.to,to:target.to,insert:newline+rowText(Array(columns).fill(''))};
 }
 if(operation==='row-delete'){
  if(row===0)return null;const target=rows[row];return target.to<source.length?{from:target.from,to:target.to+newline.length,insert:''}:{from:target.from-newline.length,to:target.to,insert:''};
 }
 if(operation==='column-delete'&&columns===1)return null;
 const all=[rows[0],delimiter,...rows.slice(1)];
 const rendered=all.map(r=>{const cells=r.cells.map(c=>c.value);if(operation==='column-delete')cells.splice(column,1);else if(operation==='column-duplicate')cells.splice(column+1,0,cells[column]);else cells.splice(column+(operation==='column-after'?1:0),0,r===delimiter?'---':'');return rowText(cells)});
 return {from:0,to:source.length,insert:rendered.join(newline)};
}

/** Reorder one row/column as one history step. Header stays a header and
 * column alignment travels with the column; cell Markdown is never rendered
 * back to source. No-op/invalid destinations cannot dirty the note. */
export function reorderTable(table:EditableTable,axis:'row'|'column',start:number,end:number):TableChange|null {
 const {rows,delimiter,source,newline}=table;
 const count=axis==='row'?rows.length:rows[0].cells.length;
 if(!Number.isInteger(start)||!Number.isInteger(end)||start===end||start<0||end<0||start>=count||end>=count)return null;
 if(axis==='row'){
  if(start===0||end===0)return null;
  const body=rows.slice(1);const [moved]=body.splice(start-1,1);body.splice(end-1,0,moved);
  return {from:0,to:source.length,insert:[rows[0],delimiter,...body].map(r=>source.slice(r.from,r.to)).join(newline)};
 }
 const all=[rows[0],delimiter,...rows.slice(1)];
 return {from:0,to:source.length,insert:all.map(r=>{
  const cells=r.cells.map(c=>c.value),[moved]=cells.splice(start,1);cells.splice(end,0,moved);
  return '| '+cells.join(' | ')+' |';
 }).join(newline)};
}
