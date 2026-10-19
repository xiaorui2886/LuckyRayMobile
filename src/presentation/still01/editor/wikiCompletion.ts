import { unified } from 'unified';
import remarkParse from 'remark-parse';
export type WikiCompletion = { from: number; to: number; query: string; token: string };
export type WikiChoice = { id: string; title: string; target: string; detail?: string };
const parser = unified().use(remarkParse);
/** Pure source range, never a DOM range. Does not touch code/HTML/existing links. */
export function wikiCompletionAt(doc: string, cursor: number): WikiCompletion | null {
 if (doc.length > 250_000 || cursor < 0 || cursor > doc.length) return null;
 const lineStart=doc.lastIndexOf('\n',cursor-1)+1;
 const before=doc.slice(lineStart,cursor), open=before.lastIndexOf('[[');
 if(open<0) return null;
 const from=lineStart+open;
 if(doc[from-1]==='!' || (doc.slice(lineStart,from).match(/\\+$/)?.[0].length||0)%2) return null;
 const query=doc.slice(from+2,cursor);
 if(/[\[\]\n\r|#]/.test(query)||query.length>120) return null;
 let blocked=false;
 const visit=(n:any)=>{if(n.position?.start?.offset<=from&&n.position?.end?.offset>=cursor){
   if(['code','inlineCode','html','link','image','linkReference','imageReference'].includes(n.type))blocked=true;
   n.children?.forEach(visit);
 }};
 visit(parser.parse(doc)); if(blocked)return null;
 const rest=doc.slice(cursor,doc.indexOf('\n',cursor)<0?doc.length:doc.indexOf('\n',cursor));
 const closing=rest.indexOf(']]');
 if(closing>=0&&/[\[|#]/.test(rest.slice(0,closing)))return null;
 const to=closing>=0?cursor+closing+2:cursor;
 return {from,to,query,token:doc.slice(from,to)};
}
export function wikiInsertion(choice: WikiChoice): string | null {
 if(!choice.target||/[\[\]|\r\n\u0000-\u001f]/.test(choice.target)||choice.target.length>1024)return null;
 const title=choice.title.trim();
 return `[[${choice.target}${title&&title!==choice.target&&!/[\[\]|\r\n\u0000-\u001f]/.test(title)?'|'+title:''}]]`;
}
export function sameWikiCompletion(a: WikiCompletion|null,b:WikiCompletion|null):boolean {
 return a===b||Boolean(a&&b&&a.from===b.from&&a.to===b.to&&a.query===b.query&&a.token===b.token);
}
