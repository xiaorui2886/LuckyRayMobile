import { mobileGraphFrontmatterTags, withMobileGraphTags } from './mobileGraphFrontmatter.ts';
/** Real native CAS writes, never visual-only graph edges. */
import { managedVault, type ManagedNote } from './managedVault.ts';
import { managedRelativeWikiTarget, verifiedManagedWikiPath } from '../still/kit/managedWiki.ts';
import { managedNoteResources } from './managedNoteResources.ts';
import { assertMobileGraphActive, mobileGraphCatalogSignature, type MobileGraphSnapshot } from './mobileGraph.ts';
import { mobileGraphResolve, parseMobileGraphBody } from './mobileGraphIndex.ts';
async function stableCatalog(s:MobileGraphSnapshot) {
  const catalog=await managedVault.linkCatalog(s.source.id); assertMobileGraphActive(s.signal);
  if(mobileGraphCatalogSignature(catalog.items)!==s.catalogStamp)throw Error('图谱关系目录已变化，请刷新后编辑');
}
async function writable(s: MobileGraphSnapshot) {
  assertMobileGraphActive(s.signal);
  if (s.source.kind !== 'managed' || s.source.readOnly) throw Error('此来源为只读图谱，不会自动迁移笔记');
  const c = await managedVault.list(); assertMobileGraphActive(s.signal);
  const v = c.items.find(v => v.localVaultId === s.source.id);
  if (!v || v.migrationState !== 'ready' || v.transferState || JSON.stringify(v.binding) !== JSON.stringify(s.source.binding ?? null)) throw Error('知识库已变化，请刷新图谱后编辑');
}
async function current(s: MobileGraphSnapshot, key: string) {
  const note = s.notesByKey.get(key);
  if (!note?.managed || note.bodyState !== 'ready' || typeof note.content !== 'string') throw Error('此节点不是可编辑的完整本机笔记');
  const actual = await managedVault.get(s.source.id,note.noteId); assertMobileGraphActive(s.signal);
  if (actual.localVaultId !== s.source.id || actual.noteId !== note.noteId || actual.revision !== note.revision || actual.content !== note.content || actual.bodyState !== 'ready' || actual.syncState === 'conflict') throw Error('笔记已变化或有冲突，请刷新图谱后重试');
  return {note,actual};
}
async function save(s: MobileGraphSnapshot,n: ManagedNote,body: string,tags=n.tags) {
  assertMobileGraphActive(s.signal);
  await stableCatalog(s);
  await managedVault.save(s.source.id,n.noteId,n.revision,n.title,body,tags);
}
export async function createMobileGraphNote(s: MobileGraphSnapshot,title: string,options: {folder?: string}={}) {
  await writable(s); const name=title.trim(),folder=options.folder||'';
  if (!name || /[\/\\\[\]#|:\u0000-\u001f\u007f]/.test(name) || name==='.' || name==='..') throw Error('请输入安全的笔记标题');
  if (/^\/|\\|[\u0000-\u001f\u007f]/.test(folder) || folder.split('/').some(p=>p==='.'||p==='..')) throw Error('文件夹路径无效');
  const folders=await managedVault.folders(s.source.id); assertMobileGraphActive(s.signal);
  if(folder&&!folders.paths.includes(folder)) throw Error('目标文件夹尚不存在，请先在笔记页创建');
  await stableCatalog(s);
  return managedVault.create(s.source.id,name,'',[],folder);
}
export async function setMobileGraphNoteTags(s: MobileGraphSnapshot,key: string,tags: string[]) {
  await writable(s);
  if (!Array.isArray(tags)||tags.some(t=>typeof t!=='string'||/[\u0000-\u001f\u007f]/.test(t))) throw Error('标签无效');
  const {actual}=await current(s,key);
  const next=[...new Set(tags.map(t=>t.trim().replace(/^#+/,'')).filter(Boolean))];
  await save(s,actual,withMobileGraphTags(actual.content!,next),next);
}
function targetText(s:MobileGraphSnapshot,from:ManagedNote,to:ManagedNote) {
  if(!s.source.binding)return `@id/${to.noteId}`;
  const scope={localVaultId:s.source.id,binding:s.source.binding};
  const a=verifiedManagedWikiPath(from,scope),b=verifiedManagedWikiPath(to,scope,true);
  if(!a||!b)throw Error('同步库路径尚未确认，不能写入本机私有文件名');
  return managedRelativeWikiTarget(a,b);
}
function resourceTargets(s:MobileGraphSnapshot,key:string,noteId:string):string[] {
  const resource=s.resourcesByKey.get(key);
  if(!resource)return [];
  return [...new Set(resource.references ? resource.references.filter(r=>r.noteId===noteId).map(r=>r.target) : resource.noteId===noteId?[resource.target]:[])];
}
export function mobileGraphRelationDisabledReason(s:MobileGraphSnapshot,a:string,b:string):string|null {
  if(s.source.readOnly||s.source.kind!=='managed')return '旧本机库只读，不自动迁移';
  const source=s.notesByKey.get(a),target=s.notesByKey.get(b);
  if(!source?.managed||source.bodyState!=='ready')return '请从完整本机笔记建立关系';
  if(a===b)return '不能连接自身';
  if(target)return target.bodyState==='ready'?null:'目标正文尚未完整保存在本机';
  if(s.tagsByKey.has(b))return null;
  const r=s.resourcesByKey.get(b);
  if(r&&resourceTargets(s,b,source.noteId).some(target=>managedNoteResources(source.managed!).some(x=>x.target===target&&x.status==='resolved')))return null;
  return r?'附件属于另一篇笔记资源范围，不能复制未验证路径':'请先创建缺失笔记';
}
export async function linkMobileGraphNodes(s:MobileGraphSnapshot,a:string,b:string) {
  await writable(s);const reason=mobileGraphRelationDisabledReason(s,a,b);if(reason)throw Error(reason);
  const {actual,note}=await current(s,a),tag=s.tagsByKey.get(b);
  if(tag){const next=[...new Set([...actual.tags,...mobileGraphFrontmatterTags(actual.content!),tag])];await save(s,actual,withMobileGraphTags(actual.content!,next),next);return;}
  const target=s.notesByKey.get(b);
  if(target){
    const checked=await current(s,b),notes=[...s.notesByKey.values()];
    if(parseMobileGraphBody(actual.content!).references.some(ref=>mobileGraphResolve(s.source,notes,note,ref).id===target.noteId))return;
    await save(s,actual,`${actual.content}${actual.content?.endsWith('\n')?'':'\n'}\n[[${targetText(s,actual,checked.actual)}]]\n`);return;
  }
  const targetForSource=resourceTargets(s,b,actual.noteId).find(target=>managedNoteResources(actual).some(r=>r.target===target&&r.status==='resolved'));
  if(!targetForSource)throw Error('附件资源已变化或不属于此笔记');
  if(parseMobileGraphBody(actual.content!).embeds.some(e=>e.target===targetForSource))return;
  if(/[\]\r\n]/.test(targetForSource))throw Error('附件目标不能安全写入');
  await save(s,actual,`${actual.content}\n\n![[${targetForSource}]]\n`);
}
export function removeMobileGraphRanges(body:string, spans: {from:number;to:number}[]):string {
  const merged:{from:number;to:number}[]=[];
  for(const span of [...spans].sort((a,b)=>a.from-b.from || b.to-a.to)){
    if(!Number.isInteger(span.from)||!Number.isInteger(span.to)||span.from<0||span.to<span.from||span.to>body.length)throw Error('关联位置已变化，请刷新图谱');
    const previous=merged[merged.length-1];
    if(previous&&span.from<=previous.to)previous.to=Math.max(previous.to,span.to);else merged.push({...span});
  }
  for(const span of merged.reverse())body=body.slice(0,span.from)+body.slice(span.to);
  return body;
}
export async function unlinkMobileGraphNodes(s:MobileGraphSnapshot,a:string,b:string) {
  await writable(s);const {note,actual}=await current(s,a),tag=s.tagsByKey.get(b);
  if(tag){const next=[...new Set([...actual.tags,...mobileGraphFrontmatterTags(actual.content!)])].filter(t=>t.toLocaleLowerCase()!==tag.toLocaleLowerCase());await save(s,actual,withMobileGraphTags(actual.content!,next),next);return;}
  const target=s.notesByKey.get(b),resource=s.resourcesByKey.get(b);if(!target&&!resource)throw Error('此关系目前不能安全编辑');
  if(target)await current(s,b);
  const parsed=parseMobileGraphBody(actual.content!),notes=[...s.notesByKey.values()];
  const spans=target?[...parsed.references.filter(ref=>mobileGraphResolve(s.source,notes,note,ref).id===target.noteId),...parsed.embeds.filter(e=>mobileGraphResolve(s.source,notes,note,{target:e.target,label:e.target,line:1,from:e.from,to:e.to}).id===target.noteId)]:parsed.embeds.filter(e=>resourceTargets(s,b,actual.noteId).includes(e.target));
  const selectedRanges=new Set(spans.map(span=>`${span.from}:${span.to}`));
  const others=[...parsed.references,...parsed.embeds].filter(span=>!selectedRanges.has(`${span.from}:${span.to}`));
  if(spans.some(span=>others.some(other=>span.from<=other.from&&span.to>=other.to)))throw Error('此链接内还包含另一项附件或引用，请在笔记中编辑以保留它');
  const body=removeMobileGraphRanges(actual.content!,spans);
  if(body!==actual.content)await save(s,actual,body);
}
