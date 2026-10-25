import { api } from '../../services/client';
import { wikiChoiceRows, type WikiChoiceScope } from './wikiChoiceRows';
import type { WikiChoice } from '../../presentation/still01/editor/wikiCompletion';
export type { WikiChoiceScope } from './wikiChoiceRows';
/** Suggestions only, never a resolver or navigation authority. Native scope fences remain. */
export async function wikiChoices(query:string, scope?:WikiChoiceScope):Promise<{items:WikiChoice[];partial:boolean}> {
 const page=scope?await api.contentReplicaNotes(scope.instance,scope.vault,query,1,''):await api.localNoteList({q:query,page:1,limit:50,sort:'name'});
 const items=wikiChoiceRows(page.items||[],query,scope);
 return {items:items.slice(0,12),partial:Boolean(page.hasMore)||items.length>12};
}
