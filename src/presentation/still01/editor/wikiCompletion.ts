import { unified } from 'unified';
import remarkParse from 'remark-parse';
export type WikiCompletion = { from: number; to: number; query: string; token: string; embed?: boolean; suffix?: string };
export type WikiChoice = { id: string; title: string; target: string; detail?: string };
const parser = unified().use(remarkParse);
/** Pure source range, never a DOM range. Does not touch code/HTML/Markdown links. */
export function wikiCompletionAt(doc: string, cursor: number): WikiCompletion | null {
 if (doc.length > 250_000 || cursor < 0 || cursor > doc.length) return null;
 const lineStart=doc.lastIndexOf('\n',cursor-1)+1;
 const before=doc.slice(lineStart,cursor), open=before.lastIndexOf('[[');
 if(open<0) return null;
 const embed=doc[lineStart+open-1]==='!';
 const from=lineStart+open-(embed?1:0);
 if((doc.slice(lineStart,from).match(/\\+$/)?.[0].length||0)%2) return null;
 const query=doc.slice(from+(embed?3:2),cursor);
 if(/[\[\]\n\r|#]/.test(query)||query.length>120) return null;
 let blocked=false;
 const visit=(n:any)=>{if(n.position?.start?.offset<=from&&n.position?.end?.offset>=cursor){
   if(['code','inlineCode','html','link','image','linkReference','imageReference'].includes(n.type))blocked=true;
   n.children?.forEach(visit);
 }};
 visit(parser.parse(doc)); if(blocked)return null;
 const rest=doc.slice(cursor,doc.indexOf('\n',cursor)<0?doc.length:doc.indexOf('\n',cursor));
 const closing=rest.indexOf(']]');
 const tail=closing>=0?rest.slice(0,closing):'';
 if(/[\[\]]/.test(tail))return null;
 // Editing a target must preserve the existing heading/alias (including image size).
 const suffixAt=tail.search(/[|#]/), suffix=suffixAt>=0?tail.slice(suffixAt):'';
 const to=closing>=0?cursor+closing+2:cursor;
 return {from,to,query,token:doc.slice(from,to),...(embed?{embed:true}:{}),...(suffix?{suffix}:{})};
}
export function wikiInsertion(choice: WikiChoice, embed=false): string | null {
 if(!choice.target||/[\[\]|\r\n\u0000-\u001f]/.test(choice.target)||choice.target.length>1024)return null;
 if(embed)return `![[${choice.target}]]`;
 const title=choice.title.trim();
 return `[[${choice.target}${title&&title!==choice.target&&!/[\[\]|\r\n\u0000-\u001f]/.test(title)?'|'+title:''}]]`;
}
export function sameWikiCompletion(a: WikiCompletion|null,b:WikiCompletion|null):boolean {
 return a===b||Boolean(a&&b&&a.from===b.from&&a.to===b.to&&a.query===b.query&&a.token===b.token);
}

/** A completion changes only this token; existing aliases/headings stay verbatim. */
export function wikiCompletionInsertion(choice: WikiChoice, match: WikiCompletion): string | null {
 const insertion=wikiInsertion(choice,Boolean(match.embed));
 if(!insertion)return null;
 return match.suffix ? `${match.embed?'!':''}[[${choice.target}${match.suffix}]]` : insertion;
}
/** The caret, not the start of a possibly wrapped link, anchors the popup. */
export function wikiCompletionAnchor(match: WikiCompletion): number {
 return match.from + (match.embed ? 3 : 2) + match.query.length;
}
export function wikiChoiceMatch(target:string,query:string):number {
 const value=target.normalize('NFC').toLocaleLowerCase(), q=query.normalize('NFC').toLocaleLowerCase();
 if(!q)return 0;
 const at=value.indexOf(q); if(at>=0)return at;
 // An in-token deletion should still find the original path. Do not guess a new target.
 let pos=0; for(const ch of q){pos=value.indexOf(ch,pos);if(pos<0)return -1;pos++;}
 return value.length + 100;
}
export function wikiResourceChoices(resources:readonly {resourceId:string;target:string;status:string}[], query:string):WikiChoice[]{
 const seen=new Set<string>();
 return resources.filter(r=>r.status==='resolved'&&!/^[\\/]|[:\u0000-\u001f\u007f]/.test(r.target)&&!seen.has(r.target)&&(seen.add(r.target),true))
  .map(r=>({id:r.resourceId,title:r.target.split('/').pop()||r.target,target:r.target,detail:r.target}))
  .filter(r=>wikiInsertion(r)!==null&&wikiChoiceMatch(r.target,query)>=0)
  .sort((a,b)=>wikiChoiceMatch(a.target,query)-wikiChoiceMatch(b.target,query));
}
export function mergeWikiChoices(notes:WikiChoice[],attachments:WikiChoice[],limit=12):WikiChoice[]{
 const seen=new Set<string>();
 // Alternate the two kinds so an empty query can expose attachments alongside notes.
 const merged:WikiChoice[]=[];
 for(let i=0;i<Math.max(notes.length,attachments.length);i++)for(const row of [notes[i],attachments[i]]){
  if(row&&!seen.has(row.target)&&wikiInsertion(row)!==null){seen.add(row.target);merged.push(row);}
 }
 return merged.slice(0,limit);
}
