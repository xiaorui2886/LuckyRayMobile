import { api } from '../../services/client';
import { assertNoteSearchScope } from './noteSearch';
import { localWikiId } from './localWiki';
import { safeWikiTarget } from './wikiSyntax';
import type { WikiChoice } from '../../presentation/still01/editor/wikiCompletion';
export type WikiChoiceScope={instance:string;vault:string};
/** Suggestions only, never a resolver or navigation authority. Native scope fences remain. */
export async function wikiChoices(query:string, scope?:WikiChoiceScope):Promise<{items:WikiChoice[];partial:boolean}> {
 const page=scope?await api.contentReplicaNotes(scope.instance,scope.vault,query,1,''):await api.localNoteList({q:query,page:1,limit:50,sort:'name'});
 const rows=page.items||[]; if(scope)assertNoteSearchScope(rows,{...scope,directory:''});
 const q=query.normalize('NFC').toLocaleLowerCase();
 const items:WikiChoice[]=[];
 for(const row of rows){
  if(typeof row.title!=='string'||typeof row.noteId!=='string')continue;
  const target=scope?row.relativePath:row.noteId;
  if(typeof target!=='string'||!safeWikiTarget(target)||(!scope&&!localWikiId(target)))continue;
  if(!row.title.normalize('NFC').toLocaleLowerCase().includes(q)&&!target.normalize('NFC').toLocaleLowerCase().includes(q))continue;
  items.push({id:row.noteId,title:row.title||'未命名笔记',target,detail:scope?row.relativePath:undefined});
 }
 return {items:items.slice(0,12),partial:Boolean(page.hasMore)||items.length>12};
}
