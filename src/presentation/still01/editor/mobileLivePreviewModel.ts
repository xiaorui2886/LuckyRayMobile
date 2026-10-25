import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { wikiSyntax } from '../../../still/kit/wikiSyntax.ts';
import { highlightSyntax } from '../../../still/kit/highlightSyntax.ts';
import type { WikiReference } from '../../../still/kit/knowledgeRelations.ts';
import type { NoteResource } from '../../../services/noteResourceSession.ts';
import { noteMediaLabel } from '../../../components/noteMediaLabel.ts';

export type PreviewSpan = { from:number; to:number; kind:'strong'|'emphasis'|'delete'|'inlineCode'|'highlight'; contentFrom:number; contentTo:number };
export type PreviewLink = { from:number; to:number; label:string; url:string; wiki?:WikiReference; resource?:NoteResource };
export type PreviewLine = { from:number; to:number; className:string; markers:{from:number;to:number;text?:string}[] };
export type PreviewTask = {from:number;to:number;checked:boolean;charAt:number};
export type PreviewInline = {kind:'text'|'strong'|'emphasis'|'delete'|'inlineCode'|'highlight'|'link';text?:string;children?:PreviewInline[];link?:PreviewLink};
export type PreviewTable = {from:number;to:number;rows:{from:number;to:number;cells:{from:number;to:number;text:string;editAt:number;inline:PreviewInline[]}[]}[];align:(string|null)[]};
export type LivePreviewModel = {spans:PreviewSpan[];links:PreviewLink[];lines:PreviewLine[];tasks:PreviewTask[];tables:PreviewTable[];rules:{from:number;to:number}[];limited:boolean};
export const LIVE_PREVIEW_MAX_CHARS=250_000;
const plain=(node:any):string=>typeof node.value==='string'?node.value:(node.children||[]).map(plain).join('');
const offsets=(node:any)=>({from:node.position?.start?.offset as number,to:node.position?.end?.offset as number});
const valid=(node:any)=>Number.isInteger(node.position?.start?.offset)&&Number.isInteger(node.position?.end?.offset);
/** Presentation model only: AST ranges always refer to the original UTF-16
 * Markdown. Never serialize this tree back into the saved document. */
export function mobileLivePreviewModel(source:string,resources:NoteResource[]=[]):LivePreviewModel {
 const out:LivePreviewModel={spans:[],links:[],lines:[],tasks:[],tables:[],rules:[],limited:source.length>LIVE_PREVIEW_MAX_CHARS};
 if(out.limited)return out;
 const references=new Map<string,WikiReference>();
 const parser=unified().use(remarkParse).use(remarkGfm).use(wikiSyntax(source,references)).use(highlightSyntax(source));
 const tree=parser.runSync(parser.parse(source));
 const definitions=new Map<string,string>();
 const collect=(n:any)=>{if(n.type==='definition')definitions.set(String(n.identifier).toLowerCase(),n.url);n.children?.forEach(collect)};collect(tree);
 const findResource=(url:string)=>{let decoded=url;try{decoded=decodeURIComponent(url)}catch{}return resources.find(r=>r.target===url||r.target===decoded)};
 const inline=(node:any):PreviewInline[]=>{
  if(node.type==='link'||node.type==='linkReference'){
   const url=node.url||definitions.get(String(node.identifier).toLowerCase()),wiki=references.get(url),resource=findResource(url||'');
   const label=resource?noteMediaLabel(resource.target):plain(node);
   if(typeof url==='string'&&(wiki||resource||/^https?:\/\//i.test(url)))return [{kind:'link',link:{...offsets(node),label,url,...(wiki?{wiki}:{}),...(resource?{resource}:{})}}];
   return [{kind:'text',text:plain(node)}];
  }
  if(['strong','emphasis','delete','highlight'].includes(node.type))return [{kind:node.type,children:(node.children||[]).flatMap(inline)}];
  if(node.type==='inlineCode')return [{kind:'inlineCode',text:node.value}];
  if(node.type==='html')return [{kind:'text',text:node.value}];
  if(node.type==='image'||node.type==='imageReference')return [{kind:'text',text:node.alt||'图片'}];
  if(typeof node.value==='string')return [{kind:'text',text:node.value}];
  return (node.children||[]).flatMap(inline);
 };
 const lineStarts=(from:number,to:number)=>{const starts=[from];for(let at=from;at<to;at++)if(source[at]==='\n'&&at+1<to)starts.push(at+1);return starts};
 const visit=(node:any)=>{
  if(!valid(node)){node.children?.forEach(visit);return}
  const {from,to}=offsets(node),raw=source.slice(from,to);
  if(['html','image','imageReference','definition'].includes(node.type))return;
  if(['strong','emphasis','delete','inlineCode','highlight'].includes(node.type)){
   let left=0,right=0;
   if(node.type==='inlineCode'){left=/^`+/.exec(raw)?.[0].length||0;right=/`+$/.exec(raw)?.[0].length||0}
   else if(node.type==='highlight'){left=right=2}
   else if(node.type==='delete'){left=/^~+/.exec(raw)?.[0].length||0;right=/~+$/.exec(raw)?.[0].length||0}
   else {left=right=node.type==='emphasis'?1:2}
   if(node.type==='inlineCode'&&raw[left]===' '&&raw[raw.length-right-1]===' '&&/[^ ]/.test(raw.slice(left,raw.length-right))){left++;right++}
   if(left&&right&&to-from>left+right)out.spans.push({from,to,kind:node.type,contentFrom:from+left,contentTo:to-right});
   if(node.type!=='inlineCode')node.children?.forEach(visit);return;
  }
  if(node.type==='link'||node.type==='linkReference'){
   const url=node.url||definitions.get(String(node.identifier).toLowerCase());
   if(typeof url!=='string')return;
   const wiki=references.get(url),resource=findResource(url);
   // Never turn arbitrary file/data/javascript/HTML targets into live content.
   if(wiki||resource||/^https?:\/\//i.test(url))out.links.push({from,to,label:resource?noteMediaLabel(resource.target):plain(node)||url,url,...(wiki?{wiki}:{}),...(resource?{resource}:{})});
   return;
  }
  if(node.type==='table'){
   out.tables.push({from,to,align:node.align||[],rows:node.children.map((row:any)=>({...offsets(row),cells:row.children.map((cell:any)=>({...offsets(cell),text:plain(cell),inline:inline(cell),editAt:cell.children?.[0]?.position?.start?.offset ?? cell.position.start.offset}))}))});return;
  }
  if(node.type==='thematicBreak'){out.rules.push({from,to});return}
  if(node.type==='code'){
   const starts=lineStarts(from,to),fenced=/^(`{3,}|~{3,})/.exec(raw);
   starts.forEach((at,index)=>{const end=source.indexOf('\n',at),lineTo=end<0?source.length:Math.min(end,to);const markers:PreviewLine['markers']=[];
    if(fenced){
     if(index===0)markers.push({from:at,to:lineTo,text:node.lang||'代码'});
     else if(index===starts.length-1){
      // AST code position may begin after a quote/list container prefix, while
      // later physical lines retain that prefix. Hide only the closing fence.
      const closing=new RegExp('^([ \t]*(?:>[ \t]*)*)('+fenced[0][0]+'{'+fenced[0].length+',})[ \t]*$').exec(source.slice(at,lineTo));
      if(closing)markers.push({from:at+closing[1].length,to:lineTo});
     }
    }
    out.lines.push({from:at,to:lineTo,className:'cm-lp-code'+(index===0?' is-first':'')+(index===starts.length-1?' is-last':''),markers});
   });return;
  }
  if(node.type==='heading'){
   const starts=lineStarts(from,to),at=from,end=source.indexOf('\n',at),lineTo=end<0?to:Math.min(end,to);const markers:PreviewLine['markers']=[];
   const opening=/^#{1,6}[ \t]+/.exec(raw);if(opening)markers.push({from,to:from+opening[0].length});
   const closing=/[ \t]+#+[ \t]*$/.exec(source.slice(at,lineTo));if(opening&&closing)markers.push({from:at+closing.index,to:lineTo});
   if(!opening&&starts.length>1){const underline=starts[starts.length-1];out.lines.push({from:underline,to,className:'cm-lp-setext',markers:[{from:underline,to}]})}
   out.lines.push({from:at,to:lineTo,className:'cm-lp-heading cm-lp-h'+node.depth,markers});
  }
  if(node.type==='blockquote'){
   for(const at of lineStarts(from,to)){const end=source.indexOf('\n',at),lineTo=end<0?to:Math.min(end,to);const marker=/^[ \t]*>[ \t]?/.exec(source.slice(at,lineTo));
    out.lines.push({from:at,to:lineTo,className:'cm-lp-quote',markers:marker?[{from:at,to:at+marker[0].length}]:[]});}
  }
  if(node.type==='listItem'){
   const match=/^([ \t]*)([-+*]|\d+[.)])([ \t]+)(?:\[([ xX])\]([ \t]+))?/.exec(raw);
   if(match){const end=source.indexOf('\n',from),lineTo=end<0?to:Math.min(end,to);const prefixFrom=from+match[1].length,prefixTo=prefixFrom+match[2].length;const markers:PreviewLine['markers']=[];
    if(/^[-+*]$/.test(match[2])&&match[4]===undefined)markers.push({from:prefixFrom,to:prefixTo,text:'•'});
    if(match[4]!==undefined){const taskFrom=from+match[0].indexOf('[');out.tasks.push({from:prefixFrom,to:taskFrom+3,checked:match[4]!==' ',charAt:taskFrom+1})}
    out.lines.push({from,to:lineTo,className:'cm-lp-list'+(node.checked===true?' is-checked':''),markers});
   }
  }
  node.children?.forEach(visit);
 };visit(tree);
 // Compact only blank separators BETWEEN root Markdown blocks. Code, HTML,
 // tables and whitespace within a paragraph/list remain source-faithful.
 // These are line decorations, not replacements and never CM viewport gaps.
 const blocks=(tree as any).children||[];
 for(let i=1;i<blocks.length;i++){
  if(blocks[i-1].type==='html'||blocks[i].type==='html')continue;
  const previous=offsets(blocks[i-1]),next=offsets(blocks[i]);
  if(!Number.isInteger(previous.to)||!Number.isInteger(next.from))continue;
  let at=source.indexOf('\n',previous.to);
  while(at>=0&&at+1<next.from){const start=at+1,end=source.indexOf('\n',start);if(end<0||end>next.from)break;
   if(/^[ \t]*$/.test(source.slice(start,end)))out.lines.push({from:start,to:end,className:'cm-lp-blank-separator',markers:[]});
   at=end;
  }
 }
 return out;
}
/** Boundary-inclusive for a caret: a tap next to hidden syntax must make it
 * editable. Nonempty selections expose every crossed source token. */
export function previewRangeActive(from:number,to:number,ranges:readonly {from:number;to:number;empty:boolean;head:number}[],focused:boolean):boolean {
 return ranges.some(r=>r.empty?focused&&r.head>=from&&r.head<=to:r.from<to&&r.to>from);
}
