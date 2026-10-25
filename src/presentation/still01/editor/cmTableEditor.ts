import {EditorView} from '@codemirror/view';
import {Transaction} from '@codemirror/state';
import {ownTableFocus,releaseTableFocus,tableStructureSelection,type TableCellSelection,type TableFocusOwner} from './tableFocus';
import {isolateHistory,undo,redo} from '@codemirror/commands';
import {editableTable,tableOperation,reorderTable,safeCellInput,type TableOperation} from './tableMarkdownModel';
export type TableEditorOptions={enabled:()=>boolean;registerOverlay?:(close:()=>void)=>()=>void};
export type TableController={update:(from:number,source:string)=>boolean;retire:()=>void};
/** Native cell input is deliberately outside contenteditable. Source transactions
 * remain owned by CM6, preserving history and asynchronous parser authority. */
export function installTableEditor(box:HTMLElement,view:EditorView,initialFrom:number,initialSource:string,options:TableEditorOptions,render:(source:string,from:number)=>void,revealSource:(from:number,source:string)=>void):TableController|null {
 let model=editableTable(initialSource);if(!model)return null;box.classList.add('cm-lp-table-editable');
 let from=initialFrom,source=initialSource,alive=true,active:{row:number;column:number;input:HTMLTextAreaElement;cell:HTMLElement;spanFrom:number;spanTo:number;originalNodes:Node[];originalValue:string}|null=null,composing=false;
 let suspended=false,pendingLeave=false;
 let pendingMenu:{kind:MenuKind;trigger:HTMLButtonElement;ensureOpen:boolean}|null=null;
 let preservingHistory=false,historyCell:TableCellSelection|null=null;
 let selected={row:0,column:0},menu:HTMLElement|null=null,release:(()=>void)|undefined;
 const ownsTarget=(node:Node|null)=>!!node&&(box.contains(node)||!!active?.input.contains(node)||!!menu?.contains(node));
 const canEdit=()=>alive&&box.isConnected&&options.enabled()&&view.state.doc.sliceString(from,from+source.length)===source;
 const closeMenu=()=>{menu?.remove();menu=null;delete box.dataset.tableSelection;tools.querySelectorAll('[aria-expanded]').forEach(b=>b.setAttribute('aria-expanded','false'));const r=release;release=undefined;r?.();if(suspended)showTools(false);view.requestMeasure()};
 const tools=document.createElement('div');tools.className='cm-lp-table-tools';tools.setAttribute('aria-label','表格操作');tools.hidden=true;
 let frame=0;
 const schedulePosition=()=>{if(!frame)frame=requestAnimationFrame(()=>{frame=0;positionTools()})};
 const positionTools=()=>{
  if(!alive||tools.hidden)return;const table=box.querySelector('table'),viewport=box.querySelector('.cm-lp-table-viewport'),cell=table?.querySelectorAll('tr')[selected.row]?.children[selected.column];if(!table||!viewport||!cell)return;
  const b=box.getBoundingClientRect(),v=viewport.getBoundingClientRect(),c=cell.getBoundingClientRect();
  const x=Math.max(v.left+18,Math.min(v.right-18,c.left+c.width/2))-b.left,y=c.top+c.height/2-b.top;
  const columnVisible=c.right>v.left&&c.left<v.right;tools.querySelectorAll<HTMLElement>('.cm-lp-table-edge--top,.cm-lp-table-edge--bottom').forEach(el=>el.hidden=!columnVisible);
  tools.style.setProperty('--table-column-x',`${x}px`);tools.style.setProperty('--table-row-y',`${y}px`);
  tools.style.setProperty('--table-bottom',`${v.bottom-b.top}px`);
  tools.style.setProperty('--table-top',`${v.top-b.top}px`);tools.style.setProperty('--table-height',`${v.height}px`);
  if(active){const input=active.input,style=getComputedStyle(active.cell),pl=parseFloat(style.paddingLeft)||0,pr=parseFloat(style.paddingRight)||0,pt=parseFloat(style.paddingTop)||0;const host=view.scrollDOM.getBoundingClientRect();input.style.left=`${c.left-host.left+view.scrollDOM.scrollLeft+pl+1}px`;input.style.top=`${c.top-host.top+view.scrollDOM.scrollTop+pt+1}px`;input.style.font=style.font;input.style.lineHeight=style.lineHeight;input.style.color=getComputedStyle(box).color;const width=`${Math.max(1,c.width-pl-pr-2)}px`,widthChanged=input.style.width!==width;input.style.width=width;input.style.textAlign=style.textAlign;input.style.visibility=columnVisible?'visible':'hidden';if(widthChanged)resizeInput(input);}
  if(menu){
   // Native insets already resize the note surface on Android. The visual
   // viewport alone can still include the IME-covered region on old WebViews.
   const visual=window.visualViewport,top=Math.max(0,visual?.offsetTop||0);
   let bottom=Math.min(window.innerHeight,top+(visual?.height||window.innerHeight));
   const surface=box.closest('.st-note-surface');const bounds=surface?.getBoundingClientRect();
   if(bounds&&bounds.height>0)bottom=Math.min(bottom,bounds.bottom);
   surface?.querySelectorAll<HTMLElement>('.st-editor-tools,.st-reader-bottom').forEach(bar=>{
    const r=bar.getBoundingClientRect(),style=getComputedStyle(bar);
    if(r.height>0&&r.bottom>top&&r.top<bottom&&style.display!=='none'&&style.visibility!=='hidden')bottom=Math.min(bottom,r.top);
   });
   menu.style.maxHeight=`${Math.max(1,bottom-top-16)}px`;
   menu.style.bottom=`${Math.max(8,window.innerHeight-bottom+8)}px`;
  }
  table.querySelectorAll('.is-selected-row,.is-selected-column').forEach(el=>el.classList.remove('is-selected-row','is-selected-column'));
  table.querySelectorAll('tr').forEach((row,index)=>{if(index===selected.row)row.classList.add('is-selected-row');row.children[selected.column]?.classList.add('is-selected-column')});
 };
 const showTools=(show:boolean)=>{if(!show){box.querySelectorAll('.is-selected-row,.is-selected-column').forEach(el=>el.classList.remove('is-selected-row','is-selected-column'))}tools.hidden=!show;box.classList.toggle('has-table-selection',show);view.requestMeasure();if(show)schedulePosition()};
 const status=document.createElement('span');status.className='cm-lp-table-status';status.setAttribute('role','status');status.hidden=true;
 const tell=(message:string)=>{status.textContent=message;status.hidden=!message};
 const icons:Record<string,string>={more:'M5 12h.01M12 12h.01M19 12h.01',row:'M9 6h.01 M15 6h.01 M9 12h.01 M15 12h.01 M9 18h.01 M15 18h.01',column:'M6 9h.01 M6 15h.01 M12 9h.01 M12 15h.01 M18 9h.01 M18 15h.01',plus:'M12 5v14 M5 12h14',source:'M8 7l-5 5 5 5 M16 7l5 5-5 5 M14 4l-4 16',done:'M5 12l4 4L19 6',deleteRow:'M3 4h18v16H3z M3 9h18 M3 15h18 M8 12h8',deleteColumn:'M4 3h16v18H4z M9 3v18 M15 3v18 M12 8v8',up:'M12 20V4 M6 10l6-6 6 6',down:'M12 4v16 M6 14l6 6 6-6',left:'M20 12H4 M10 6l-6 6 6 6',right:'M4 12h16 M14 6l6 6-6 6',delete:'M4 7h16 M9 7V4h6v3 M7 7l1 13h8l1-13 M10 10v7 M14 10v7',alignLeft:'M4 5h16 M4 10h10 M4 15h16 M4 20h10',alignCenter:'M4 5h16 M7 10h10 M4 15h16 M7 20h10',alignRight:'M4 5h16 M10 10h10 M4 15h16 M10 20h10'};
 const button=(parent:HTMLElement,label:string,glyph:string,action:(event:MouseEvent)=>void)=>{const b=document.createElement('button');b.type='button';b.title=label;b.setAttribute('aria-label',label);const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');svg.setAttribute('focusable','false');const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',icons[glyph]||icons.more);svg.appendChild(path);b.appendChild(svg);b.addEventListener('pointerdown',e=>{e.preventDefault();e.stopPropagation()});b.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();if((!composing||b.hasAttribute('aria-expanded'))&&canEdit())action(e)});parent.append(b);return b};
 const redraw=()=>{render(source,from);box.append(tools,status);schedulePosition();view.requestMeasure()};
 const write=(change:{from:number;to:number;insert:string},event:string,target?:{row:number;column:number})=>{
  if(!canEdit())return false;const old=source,next=source.slice(0,change.from)+change.insert+source.slice(change.to),parsed=editableTable(next);
  const absolute=from,focusedInput=active?.input===document.activeElement?active.input:null;
  const cell=target&&parsed?.rows[target.row]?.cells[target.column];
  const caret=active?{row:active.row,column:active.column,anchor:safeCellInput(active.input.value.slice(0,active.input.selectionDirection==='backward'?active.input.selectionEnd:active.input.selectionStart)).length,head:safeCellInput(active.input.value.slice(0,active.input.selectionDirection==='backward'?active.input.selectionStart:active.input.selectionEnd)).length}:null;
  const effect=cell&&target&&caret?tableStructureSelection.of({from:absolute,before:caret,after:{...target,anchor:cell.value.length,head:cell.value.length}}):undefined;
  source=next;model=parsed;
  try{view.dispatch({changes:{from:absolute+change.from,to:absolute+change.to,insert:change.insert},selection:cell?{anchor:absolute+cell.to}:undefined,effects:effect,userEvent:event,annotations:isolateHistory.of('full')});if(!suspended&&focusedInput?.isConnected&&document.activeElement===document.body)focusedInput.focus({preventScroll:true});tell('');if(!parsed){const resumeSource=!suspended;active?.input.remove();active=null;composing=false;releaseTableFocus(view,owner);showTools(false);if(resumeSource)revealSource(absolute,next)}return true}catch(error){source=old;model=editableTable(old);throw error}
 };
 const commitInput=()=>{if(!active||!canEdit()||!model)return;const c={from:active.spanFrom,to:active.spanTo,insert:safeCellInput(active.input.value)};if(source.slice(c.from,c.to)!==c.insert){active.spanTo=c.from+c.insert.length;write(c,'input.table')}};
 const finish=()=>{if(composing||!active&&!menu)return;commitInput();const previous=active;active=null;suspended=false;pendingMenu=null;pendingLeave=false;showTools(false);releaseTableFocus(view,owner);closeMenu();
  // Changing cells without changing content must not rebuild the entire table
  // (or remove the native pointer target before its click finishes).
  if(previous){previous.input.remove();previous.cell.classList.remove('is-editing');previous.cell.style.height='';}
  if(previous&&previous.cell.isConnected&&previous.input.value===previous.originalValue){}
  else if(model&&alive)redraw();
 };
 // Preserve scroll pixels, not the changing cell's screen position. Reordering
 // or undo may change a row's height; that is not permission to scroll the note.
 const anchorCell=()=>{const top=view.scrollDOM.scrollTop,left=view.scrollDOM.scrollLeft;return()=>{view.scrollDOM.scrollTop=top;view.scrollDOM.scrollLeft=left}};
 const owner:TableFocusOwner={input:()=>active?.input||null,contains:position=>position>=from&&position<=from+source.length,history(isRedo){
  if(composing||!active||!canEdit())return false;commitInput();closeMenu();const restoreAnchor=anchorCell();preservingHistory=true;
  try{return (isRedo?redo:undo)({state:view.state,dispatch:(tr:Transaction)=>{
   const nextFrom=tr.changes.mapPos(from,-1),nextTo=tr.changes.mapPos(from+source.length,1);
   let touchesTable=false;tr.changes.iterChangedRanges((a,b)=>{if(a<=from+source.length&&b>=from)touchesTable=true});
   const inTable=touchesTable&&nextTo>nextFrom&&!!editableTable(tr.newDoc.sliceString(nextFrom,nextTo));
   historyCell=tr.effects.find(effect=>effect.is(tableStructureSelection)&&effect.value.from===nextFrom)?.value.after||null;
   if(!inTable){preservingHistory=false;finish();showTools(false)}
   view.dispatch(tr);if(!inTable)view.focus();
   // Long notes retain mapped widgets until the Worker finishes. Apply only
   // this already bounded table now, so history does not leave a stale input
   // or depend on the asynchronous whole-note parser to restore its focus.
   if(alive&&active){const nextSource=tr.newDoc.sliceString(nextFrom,nextTo);if(source!==nextSource)update(nextFrom,nextSource);
    // resume() may run inside CM's widget update, where nested dispatch is not
    // allowed. Synchronize the restored native caret after dispatch completes.
    if(historyCell){const base=from+active.spanFrom,input=active.input,a=base+input.selectionStart,b=base+input.selectionEnd;view.dispatch({selection:{anchor:input.selectionDirection==='backward'?b:a,head:input.selectionDirection==='backward'?a:b},annotations:Transaction.addToHistory.of(false)})}
   }
  }})}finally{preservingHistory=false;historyCell=null;restoreAnchor()}
 }};
 const resizeInput=(input:HTMLTextAreaElement)=>{input.style.height='auto';const height=Math.max(parseFloat(getComputedStyle(input).lineHeight)||20,input.scrollHeight);input.style.height=height+'px';if(active?.input===input){const style=getComputedStyle(active.cell);active.cell.style.height=(height+(parseFloat(style.paddingTop)||0)+(parseFloat(style.paddingBottom)||0)+2)+'px'}schedulePosition();view.requestMeasure()};
 // Keep the native input connected to the stable scroller while table rows are rebuilt.
 // Moving it between cells blurs Android's IME even if focus is restored later.
 const resume=(previous:NonNullable<typeof active>,row:number,column:number,selection?:{anchor:number;head:number})=>{
  if(!model)return;row=Math.max(0,Math.min(row,model.rows.length-1));column=Math.max(0,Math.min(column,model.rows[0].cells.length-1));const value=model.rows[row].cells[column],cell=box.querySelectorAll('tr')[row]?.children[column] as HTMLElement|undefined;if(!cell)return;const input=previous.input;
  previous.cell.classList.remove('is-editing');previous.cell.style.height='';input.value=value.value;input.setAttribute('aria-label',`表格第 ${row+1} 行第 ${column+1} 列`);selected={row,column};active={row,column,input,cell,spanFrom:value.from,spanTo:value.to,originalNodes:Array.from(cell.childNodes),originalValue:value.value};cell.classList.toggle('is-editing',!suspended);input.hidden=suspended;
  const base=from+value.from,a=selection?Math.max(0,Math.min(value.value.length,selection.anchor-base)):value.value.length,b=selection?Math.max(0,Math.min(value.value.length,selection.head-base)):a;input.setSelectionRange(Math.min(a,b),Math.max(a,b),a>b?'backward':'forward');ownTableFocus(view,owner);resizeInput(input);showTools(!suspended);positionTools();if(!suspended&&document.activeElement!==input)input.focus({preventScroll:true});
 };
 const start=(row:number,column:number)=>{
  if(!canEdit()||!model||composing)return;
  suspended=false;
  if(active){const previous=active;commitInput();closeMenu();if(previous.input.value!==previous.originalValue)redraw();resume(previous,row,column);previous.input.dispatchEvent(new Event('select'));return}
  finish();const cell=box.querySelectorAll('tr')[row]?.children[column] as HTMLElement|undefined;const value=model.rows[row]?.cells[column];if(!cell||!value)return;
  selected={row,column};showTools(true);const input=document.createElement('textarea');input.className='cm-lp-table-input';input.rows=1;input.value=value.value;input.setAttribute('aria-label',`表格第 ${row+1} 行第 ${column+1} 列`);input.spellcheck=false;
  active={row,column,input,cell,spanFrom:value.from,spanTo:value.to,originalNodes:Array.from(cell.childNodes),originalValue:value.value};ownTableFocus(view,owner);
  // Android WebView83 predates Element.replaceChildren. Keep this local to
  // table activation so older devices can attach the same native input.
  view.scrollDOM.appendChild(input);cell.classList.add('is-editing');positionTools();
  const syncSelection=()=>{if(active?.input!==input||!model||!canEdit())return;const base=from+active.spanFrom;const anchor=base+safeCellInput(input.value.slice(0,input.selectionDirection==='backward'?input.selectionEnd:input.selectionStart)).length,head=base+safeCellInput(input.value.slice(0,input.selectionDirection==='backward'?input.selectionStart:input.selectionEnd)).length;if(view.state.selection.main.anchor!==anchor||view.state.selection.main.head!==head)view.dispatch({selection:{anchor,head}})};
  const resize=()=>resizeInput(input);
  input.addEventListener('input',()=>{commitInput();syncSelection();resize();if(suspended)redraw()});
  input.addEventListener('compositionstart',()=>{composing=true;input.dataset.composing='true'});input.addEventListener('compositionend',()=>{composing=false;delete input.dataset.composing;commitInput();syncSelection();resize();queueMicrotask(()=>{if(!alive||active?.input!==input||composing)return;commitInput();const pending=pendingMenu;pendingMenu=null;if(pendingLeave){pendingLeave=false;finish();showTools(false)}else if(pending)openMenu(pending.kind,pending.trigger,pending.ensureOpen)})});
  // CM may detach/reinsert a reused block widget during a source transaction.
  // Its synchronous/queued focus restoration must finish before deciding that
  // the user left this cell. Outside pointer/focus departures still finish.
  // A tap focuses the next cell before its click. Retiring the old input at
  // that blur would redraw/detach the pending target and swallow the tap.
  // Cell/control focus stays table-owned; start() or a real outside departure
  // finalizes it. Keep the existing microtask protection for CM DOM moves.
  input.addEventListener('blur',event=>{const tableTarget=event.relatedTarget instanceof Node&&ownsTarget(event.relatedTarget);queueMicrotask(()=>{if(alive&&active?.input===input&&!composing&&!suspended&&!pendingMenu&&!tableTarget&&!ownsTarget(input.ownerDocument.activeElement))finish()})});
  input.addEventListener('keydown',e=>{
   if(composing||e.isComposing)return;
   if((e.ctrlKey||e.metaKey)&&['z','y'].includes(e.key.toLowerCase())){e.preventDefault();owner.history(e.key.toLowerCase()==='y'||e.shiftKey);return}
   if((e.key==='F10'&&e.shiftKey)||(e.key==='ArrowDown'&&e.altKey)){e.preventDefault();e.stopPropagation();openMenu('all',tools.querySelector('.cm-lp-table-edge--corner')!);menu?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({preventScroll:true});return}
   if(e.key==='Escape'){e.preventDefault();e.stopPropagation();if(menu){closeMenu();return}finish();showTools(false);view.focus();return}
   if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();finish();view.focus();return}
   if(e.key==='Tab'){e.preventDefault();const count=model!.rows[0].cells.length,index=active!.row*count+active!.column+(e.shiftKey?-1:1),total=model!.rows.length*count;finish();if(index>=0&&index<total)start(Math.floor(index/count),index%count);else view.focus()}
  });
  input.addEventListener('select',syncSelection);input.addEventListener('keyup',syncSelection);input.addEventListener('click',syncSelection);input.focus({preventScroll:true});input.setSelectionRange(input.value.length,input.value.length);syncSelection();resize();
 };
 const operate=(operation:TableOperation)=>{if(composing||!model)return;const previous=active,restoreAnchor=anchorCell();commitInput();const change=tableOperation(model,selected.row,selected.column,operation);if(!change)return;closeMenu();
  const target={...selected};
  if(operation==='row-after'||operation==='row-before'&&target.row===0)target.row++;
  if(operation==='column-after'||operation==='column-right'||operation==='column-duplicate')target.column++;
  if(operation==='column-left')target.column--;if(operation==='row-up')target.row--;if(operation==='row-down'||operation==='row-duplicate')target.row++;
  if(operation.startsWith('sort-')&&target.row>0){const column=target.column,order=model.rows.slice(1).map((row,index)=>({row,index:index+1})).sort((a,b)=>{const delta=a.row.cells[column].value.localeCompare(b.row.cells[column].value,undefined,{numeric:true,sensitivity:'base'});return (operation==='sort-descending'?-delta:delta)||a.index-b.index});target.row=order.findIndex(row=>row.index===selected.row)+1}
  const next=editableTable(source.slice(0,change.from)+change.insert+source.slice(change.to));if(!next){write(change,'input.table.structure');restoreAnchor();return}
  target.row=Math.max(0,Math.min(target.row,next.rows.length-1));target.column=Math.max(0,Math.min(target.column,next.rows[0].cells.length-1));
  if(write(change,'input.table.structure',target)&&model&&alive){selected=target;redraw();if(previous)resume(previous,selected.row,selected.column);restoreAnchor()}
 };
 type MenuKind='all'|'row'|'column';
 const operationItems:[TableOperation,string,string][]=[['row-before','上方插入行','up'],['row-after','下方插入行','down'],['row-up','向上移动行','up'],['row-down','向下移动行','down'],['row-duplicate','复制当前行','row'],['row-delete','删除当前行','deleteRow'],['column-before','左侧插入列','left'],['column-after','右侧插入列','right'],['column-left','向左移动列','left'],['column-right','向右移动列','right'],['column-duplicate','复制当前列','column'],['column-delete','删除当前列','deleteColumn'],['sort-ascending','按列升序排列','up'],['sort-descending','按列降序排列','down'],['align-left','左对齐','alignLeft'],['align-center','居中','alignCenter'],['align-right','右对齐','alignRight']];
 const openMenu=(kind:MenuKind,trigger:HTMLButtonElement,ensureOpen=false)=>{
  // Android can emit its native contextmenu before or after our hold timer.
  // Both are open requests; only an ordinary short click toggles the menu.
  if(!active||!canEdit())return;
  // Blur requests native composition finalization; only compositionend may
  // commit/cancel it. Never manufacture an IME result or operate mid-compose.
  if(composing){pendingMenu={kind,trigger,ensureOpen};active.input.blur();return}
  if(menu&&menu.dataset.kind===kind){if(!ensureOpen)closeMenu();return}
  // Keep the logical cell and its history owner, but explicitly leave native
  // text entry. Menu actions/cancel must never summon the Android IME again.
  const restoreScroll=anchorCell();commitInput();suspended=true;
  if(active.input.value!==active.originalValue)redraw();
  active.cell.classList.remove('is-editing');active.input.hidden=true;active.input.blur();
  closeMenu();showTools(true);menu=document.createElement('div');menu.className='cm-lp-table-menu';menu.dataset.kind=kind;if(kind!=='all')box.dataset.tableSelection=kind;menu.setAttribute('role','menu');menu.setAttribute('aria-label',kind==='row'?'当前行操作':kind==='column'?'当前列操作':'表格行列操作');
  const groups=new Map<string,HTMLElement>();
  const groupFor=(op:string)=>{const kind=op.startsWith('sort-')?'排序':op.startsWith('align-')?'对齐':op.endsWith('-duplicate')||op.endsWith('-delete')?'复制与删除':/-(before|after)$/.test(op)?'插入':'移动';let group=groups.get(kind);if(!group){group=document.createElement('div');group.className='cm-lp-table-menu-group';group.setAttribute('role','group');group.setAttribute('aria-label',kind);groups.set(kind,group);menu!.append(group)}return group};
  for(const [op,label,icon]of operationItems){if(kind==='row'&&!op.startsWith('row-')||kind==='column'&&op.startsWith('row-'))continue;const b=button(groupFor(op),label,icon,()=>operate(op));if(op.endsWith('-delete'))b.classList.add('is-destructive');b.setAttribute('role','menuitem');const labelText=document.createElement('span');labelText.textContent=label;b.append(labelText);b.disabled=(['row-delete','row-up','row-down','row-duplicate'].includes(op)&&selected.row===0)||op==='row-up'&&selected.row<=1||op==='row-down'&&selected.row===model!.rows.length-1||op==='column-left'&&selected.column===0||op==='column-right'&&selected.column===model!.rows[0].cells.length-1||op==='column-delete'&&model!.rows[0].cells.length===1}
  for(const name of ['排序','插入','移动','对齐','复制与删除']){const group=groups.get(name);if(group)menu.append(group)}
  if(kind==='all'){button(menu,'编辑表格源码','source',()=>{finish();showTools(false);revealSource(from,source)});button(menu,'完成表格编辑','done',()=>{finish();showTools(false)})}
  menu.querySelectorAll('button').forEach(b=>{b.setAttribute('role','menuitem');if(!b.querySelector('span')){const text=document.createElement('span');text.textContent=b.getAttribute('aria-label');b.append(text)}});
  // Menu keyboard navigation never returns focus to the suspended text input.
  menu.addEventListener('keydown',e=>{if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();e.stopPropagation();const items=Array.from(menu!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));const current=items.indexOf(document.activeElement as HTMLButtonElement);const index=e.key==='Home'?0:e.key==='End'?items.length-1:(current+(e.key==='ArrowDown'?1:-1)+items.length)%items.length;items[index]?.focus({preventScroll:true});return}if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeMenu()}});
  // Escape editor stacking/overflow contexts, while retaining the app theme.
  (box.closest('.st-app')||document.body).append(menu);schedulePosition();trigger.setAttribute('aria-expanded','true');release=options.registerOverlay?.(()=>closeMenu());menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({preventScroll:true});restoreScroll();view.requestMeasure();
 };
 let drag:{axis:'row'|'column';pointer:number;start:number;target:number;x:number;y:number;armed:boolean;moved:boolean;button:HTMLButtonElement}|null=null;
 let touchId:number|null=null;
 let armTimer:ReturnType<typeof setTimeout>|undefined,menuTimer:ReturnType<typeof setTimeout>|undefined,suppressClick=false;
 const clearDrag=()=>{clearTimeout(armTimer);clearTimeout(menuTimer);armTimer=menuTimer=undefined;drag=null;delete box.dataset.tableDrag;box.querySelectorAll('.is-table-drop-target').forEach(el=>el.classList.remove('is-table-drop-target'))};
 const finishDrag=(cancelled:boolean)=>{
  const current=drag;if(!current)return;clearDrag();
  try{if(current.button.hasPointerCapture?.(current.pointer))current.button.releasePointerCapture(current.pointer)}catch{/* detached capture */}
  if(cancelled||!current.armed||!current.moved||!model||!canEdit()||composing)return;
  commitInput();const change=reorderTable(model,current.axis,current.start,current.target);if(!change)return;
  const restore=anchorCell(),previous=active;closeMenu();
  const target={...selected,[current.axis]:current.target};
  if(write(change,'input.table.reorder',target)&&model&&alive){selected=target;redraw();if(previous)resume(previous,selected.row,selected.column);showTools(true);tell(current.axis==='row'?'行已移动':'列已移动');restore()}
 };
 const bindGrip=(b:HTMLButtonElement,axis:'row'|'column')=>{
  b.dataset.tableGrip=axis;b.setAttribute('aria-description','长按后拖动调整顺序，停留打开操作菜单');
  const begin=(event:{button:number;pointerId:number;clientX:number;clientY:number})=>{
   if(!canEdit()||event.button>0)return;clearDrag();suppressClick=false;
   const start=axis==='row'?selected.row:selected.column;
   drag={axis,pointer:event.pointerId,start,target:start,x:event.clientX,y:event.clientY,armed:false,moved:false,button:b};
   try{b.setPointerCapture?.(event.pointerId)}catch{/* synthetic pointer */}
   armTimer=setTimeout(()=>{if(!drag||!canEdit()||composing)return;drag.armed=true;box.dataset.tableDrag=axis;suppressClick=true;closeMenu();},240);
   menuTimer=setTimeout(()=>{if(!drag||drag.moved||!canEdit())return;openMenu(axis,b,true);},650);
  };
  const move=(event:{pointerId:number;clientX:number;clientY:number;preventDefault:()=>void;stopPropagation:()=>void})=>{
   const d=drag;if(!d||d.pointer!==event.pointerId)return;
   const distance=Math.hypot(event.clientX-d.x,event.clientY-d.y);
   if(!d.armed){if(distance>9){suppressClick=true;finishDrag(true)}return}
   if(distance<8&&!d.moved)return;event.preventDefault();event.stopPropagation();d.moved=true;clearTimeout(menuTimer);closeMenu();
   const rows=Array.from(box.querySelectorAll('table tr'));
   const candidates=d.axis==='row'?rows:Array.from(rows[0]?.children||[]);
   const coordinate=d.axis==='row'?event.clientY:event.clientX;let nearest=d.start,distanceTo=Infinity;
   candidates.forEach((node,index)=>{if(d.axis==='row'&&(index===0||d.start===0))return;const r=node.getBoundingClientRect();const center=d.axis==='row'?r.top+r.height/2:r.left+r.width/2;const gap=Math.abs(coordinate-center);if(gap<distanceTo){nearest=index;distanceTo=gap}});
   d.target=nearest;box.querySelectorAll('.is-table-drop-target').forEach(el=>el.classList.remove('is-table-drop-target'));
   if(d.axis==='row')rows[nearest]?.classList.add('is-table-drop-target');else rows.forEach(row=>row.children[nearest]?.classList.add('is-table-drop-target'));
  };
  b.addEventListener('pointerdown',event=>{if(touchId===null)begin(event)});
  b.addEventListener('pointermove',event=>{if(touchId===null)move(event)});
  b.addEventListener('pointerup',event=>{if(touchId!==null||!drag||drag.pointer!==event.pointerId)return;suppressClick=drag.armed||drag.moved;finishDrag(false)});
  // Android's native long-press can cancel the pointer stream before the
  // finger moves. Own the grip's non-passive TouchEvent stream, not the note's
  // scrolling surface, and ignore compatibility pointer events until release.
  b.addEventListener('touchstart',event=>{
   if(event.touches.length!==1){touchId=null;clearDrag();suppressClick=true;return}
   if(!canEdit())return;
   event.preventDefault();event.stopPropagation();const point=event.touches[0];touchId=point.identifier;
   begin({button:0,pointerId:-1,clientX:point.clientX,clientY:point.clientY});
  },{passive:false});
  b.addEventListener('touchmove',event=>{
   if(touchId===null)return;
   if(event.touches.length!==1){touchId=null;finishDrag(true);return}
   const point=event.touches[0];if(point.identifier!==touchId)return;
   event.preventDefault();event.stopPropagation();
   move({pointerId:-1,clientX:point.clientX,clientY:point.clientY,preventDefault:()=>event.preventDefault(),stopPropagation:()=>event.stopPropagation()});
  },{passive:false});
  b.addEventListener('touchend',event=>{
   if(touchId!==null&&event.touches.length){touchId=null;suppressClick=true;finishDrag(true);return}
   if(touchId===null||!Array.from(event.changedTouches).some(point=>point.identifier===touchId))return;
   event.preventDefault();event.stopPropagation();touchId=null;const shortTap=!!drag&&!drag.armed&&!drag.moved;suppressClick=true;finishDrag(false);if(shortTap)openMenu(axis,b);
  },{passive:false});
  b.addEventListener('touchcancel',()=>{touchId=null;suppressClick=true;finishDrag(true)});
  b.addEventListener('pointercancel',()=>{if(touchId!==null)return;suppressClick=true;finishDrag(true)});
  b.addEventListener('lostpointercapture',()=>{if(touchId===null&&drag)finishDrag(true)});
  b.addEventListener('contextmenu',event=>{event.preventDefault();if(canEdit()&&!drag?.moved){suppressClick=true;openMenu(axis,b,true)}});
 };
 const edge=(label:string,icon:string,position:string,kind?:MenuKind,operation?:TableOperation)=>{const b=button(tools,label,icon,event=>{if(b.dataset.tableGrip&&suppressClick&&event.detail!==0){suppressClick=false;return}kind?openMenu(kind,b):operation&&operate(operation)});b.className=`cm-lp-table-edge cm-lp-table-edge--${position}`;if(kind){b.setAttribute('aria-expanded','false')}if(kind==='row'||kind==='column')bindGrip(b,kind);return b};
 edge('表格行列操作','more','corner','all');edge('当前列操作','column','top','column');edge('当前行操作','row','left','row');
 edge('添加列','plus','right',undefined,'column-after');edge('添加行','plus','bottom',undefined,'row-after');
 box.append(tools,status);schedulePosition();
 const onClick=(event:Event)=>{const target=event.target as Element;if(target.closest('button,textarea,.cm-lp-link-wrap'))return;const cell=target.closest('td,th');if(!cell||!box.contains(cell))return;const row=cell.parentElement!;event.preventDefault();event.stopPropagation();start(Array.from(box.querySelectorAll('tr')).indexOf(row as HTMLTableRowElement),Array.from(row.children).indexOf(cell))};
 const onKey=(event:KeyboardEvent)=>{if((event.target as Element).tagName==='TEXTAREA')return;if(event.key==='Escape'&&menu){event.preventDefault();event.stopPropagation();closeMenu();return;}if(event.key==='Enter'&&(event.target as Element).matches('td,th')){event.preventDefault();onClick(event)}};
 box.addEventListener('click',onClick);box.addEventListener('keydown',onKey);box.addEventListener('scroll',schedulePosition,true);view.scrollDOM.addEventListener('scroll',schedulePosition);window.addEventListener('resize',schedulePosition);window.visualViewport?.addEventListener('resize',schedulePosition);window.visualViewport?.addEventListener('scroll',schedulePosition);
 const resizeObserver=typeof ResizeObserver==='undefined'?null:new ResizeObserver(schedulePosition);resizeObserver?.observe(box);
 const focusOutside=(event:FocusEvent)=>{if(!ownsTarget(event.target as Node))return;const tableTarget=event.relatedTarget instanceof Node&&ownsTarget(event.relatedTarget);queueMicrotask(()=>{if(alive&&!composing&&(!suspended||!!event.relatedTarget)&&!pendingMenu&&!tableTarget&&!ownsTarget(document.activeElement)){finish();showTools(false)}})};document.addEventListener('focusout',focusOutside);
 // Existing note commands own their click and selection. Removing the native
 // cell on their pointerdown collapses the IME toolbar before click can run
 // (Android can then hit the navigation row occupying that same location).
 // Cell input is already committed; let the command transaction retire it.
 const outside=(event:Event)=>{if((event.target as Element).closest('.st-editor-tools'))return;if((active||menu||!tools.hidden)&&!ownsTarget(event.target as Node)){pendingMenu=null;if(composing)pendingLeave=true;clearDrag();finish();showTools(false)}};document.addEventListener('pointerdown',outside,true);
 const cancelMultitouch=(event:TouchEvent)=>{if(touchId!==null&&event.touches.length>1){touchId=null;suppressClick=true;finishDrag(true)}};
 document.addEventListener('touchstart',cancelMultitouch,{capture:true,passive:true});
 const update=(nextFrom:number,nextSource:string)=>{
  const previous=active,focusedInput=previous?.input===document.activeElement?previous.input:null;const parsed=editableTable(nextSource);if(!parsed)return false;
  const same=nextSource===source;from=nextFrom;source=nextSource;model=parsed;
  if(!same){clearDrag();active=null;composing=false;closeMenu();redraw();
   if(preservingHistory&&previous){
    // History carries a source selection, but that is not a DOM caret. Restore
    // the matching cell (or nearest surviving cell) using the SAME textarea.
    const pos=view.state.selection.main.head-from;let row=Math.min(previous.row,parsed.rows.length-1),column=Math.min(previous.column,parsed.rows[0].cells.length-1);
    if(historyCell){row=Math.min(historyCell.row,parsed.rows.length-1);column=Math.min(historyCell.column,parsed.rows[0].cells.length-1)}
    else if(pos>=0&&pos<=source.length){let distance=Infinity;parsed.rows.forEach((r,ri)=>r.cells.forEach((c,ci)=>{const d=pos<c.from?c.from-pos:pos>c.to?pos-c.to:0;if(d<distance){distance=d;row=ri;column=ci}}))}
    const base=from+parsed.rows[row].cells[column].from;
    resume(previous,row,column,historyCell?{anchor:base+historyCell.anchor,head:base+historyCell.head}:view.state.selection.main);
   }else{previous?.input.remove();releaseTableFocus(view,owner);suspended=false;pendingMenu=null;showTools(false);}
  }else if(!active)redraw();
  if(focusedInput)queueMicrotask(()=>{if(alive&&!suspended&&active?.input===focusedInput&&canEdit()&&document.activeElement===document.body)focusedInput.focus({preventScroll:true})});return true
 };
 return {update,retire(){active?.input.remove();alive=false;pendingMenu=null;touchId=null;clearDrag();releaseTableFocus(view,owner);closeMenu();if(frame)cancelAnimationFrame(frame);resizeObserver?.disconnect();window.removeEventListener('resize',schedulePosition);window.visualViewport?.removeEventListener('resize',schedulePosition);window.visualViewport?.removeEventListener('scroll',schedulePosition);box.removeEventListener('scroll',schedulePosition,true);view.scrollDOM.removeEventListener('scroll',schedulePosition);document.removeEventListener('focusout',focusOutside);document.removeEventListener('pointerdown',outside,true);document.removeEventListener('touchstart',cancelMultitouch,true);box.removeEventListener('click',onClick);box.removeEventListener('keydown',onKey)}};
}
