import test from 'node:test';
import assert from 'node:assert/strict';
import {buildMobileGraphSnapshot,parseMobileGraphBody} from '../src/services/mobileGraphIndex.ts';
import {loadMobileGraphSnapshot,listMobileGraphSources, type MobileGraphNote, type MobileGraphSource} from '../src/services/mobileGraph.ts';
import {managedVault} from '../src/services/managedVault.ts';
import {noteSourceSelection} from '../src/services/noteSourceSelection.ts';
import {api} from '../src/services/client.ts';
import {linkMobileGraphNodes,unlinkMobileGraphNodes,setMobileGraphNoteTags} from '../src/services/mobileGraphMutations.ts';
const source:MobileGraphSource={id:'local',name:'Local',kind:'managed',readOnly:false,binding:null};
function note(id:string,title:string,content:string,extra:Partial<MobileGraphNote>={}):MobileGraphNote {
 const base={noteId:id,title,content,folder:'',relativePath:`${title}.md`,revision:'r1',tags:[],historicalNames:[],updatedAt:'2026-01-01T00:00:00Z',openRoute:`vault:local:${id}`,bodyState:'ready',...extra};
 return {...base,managed:{...base,localVaultId:'local',pinned:false,favorite:false,archived:false,createdAt:base.updatedAt,syncState:'local'}} as MobileGraphNote;
}
test('local graph uses real bodies, aliases, directed merging, metadata tags, missing notes; no code/inline/web nodes',async()=>{
 const a=note('a','A','[[B]]\n[[Old B|alias]]\n[[Missing]]\n#inline\nhttps://example.com\n`[[False]]`\n```\n[[No]]\n```',{tags:['Topic']});
 const b=note('b','B','[[@id/a]]',{historicalNames:['Old B']});
 const s=await buildMobileGraphSnapshot(source,[a,b]);
 assert.equal(s.seed.nodes.filter(n=>n.type==='note').length,3);assert.equal(s.seed.nodes.filter(n=>n.type==='tag').length,1);assert.equal(s.seed.nodes.filter(n=>n.type==='web').length,0);
 assert.equal(s.seed.edgeDirections?.['0:1'],'bidirectional');assert(!s.seed.nodes.some(n=>n.label==='False'||n.label==='No'));
 assert(s.seed.nodes.some(n=>n.status==='missing'&&n.label==='Missing'));
});
test('frontmatter is not prose and embed parsing excludes escaped/code tokens',()=>{
 const p=parseMobileGraphBody('---\nsummary: "[[No]]"\n---\n[[Yes]]\n![[pic.png]]\n![alt](asset.png)\n`![[hidden.png]]`\n\\[[Escaped]]');
 assert.deepEqual(p.references.map(r=>r.target),['Yes']);assert.deepEqual(p.embeds.map(e=>e.target),['pic.png','asset.png']);
});
test('legacy stable identities and title aliases remain local and read-only',async()=>{
 const legacy={...source,id:'legacy-local',kind:'legacy' as const,readOnly:true};
 const s=await buildMobileGraphSnapshot(legacy,[note('note-a','A','[[Old B]]'),note('note-b','B','',{historicalNames:['Old B']})]);
 assert.equal(s.seed.edges.length,1);await assert.rejects(()=>setMobileGraphNoteTags(s,s.seed.nodes[0].key,['x']),/只读/);
});
test('ambiguous alias is never guessed, missing body warning is truthful',async()=>{
 const s=await buildMobileGraphSnapshot(source,[note('a','A','[[Alias]]'),note('b','B','',{historicalNames:['Alias']}),note('c','C','',{historicalNames:['Alias'],bodyState:'missing',content:undefined})]);
 assert.equal(s.seed.edges.length,0);assert(s.warnings.some(x=>x.includes('名称不唯一')));assert(s.warnings.some(x=>x.includes('正文未保存')));
});
test('abort interrupts chunked building',async()=>{const c=new AbortController();c.abort();await assert.rejects(()=>buildMobileGraphSnapshot(source,[note('a','A','')],{signal:c.signal}),{name:'AbortError'});});
test('all pages are read locally; no hydration, stable catalog after last page',async()=>{
 const original={notes:managedVault.notes,linkCatalog:managedVault.linkCatalog,hydrate:managedVault.hydrate};
 const rows=Array.from({length:203},(_,i)=>note('n'+i,'N'+i,i===202?'[[@id/n0]]':'').managed!);let pages:number[]=[];
 managedVault.notes=async q=>{pages.push(q.page!);assert.equal(q.folder,undefined);const start=(q.page!-1)*200;return {items:rows.slice(start,start+200),total:rows.length,hasMore:start+200<rows.length};};
 managedVault.linkCatalog=async()=>({items:rows});managedVault.hydrate=async()=>{throw Error('network forbidden');};
 try{const s=await loadMobileGraphSnapshot(source);assert.deepEqual(pages,[1,2]);assert.equal(s.notesByKey.size,203);assert.equal(s.seed.edges.length,1);}finally{Object.assign(managedVault,original);}
});
test('changed pagination fails instead of publishing partial ready graph',async()=>{
 const original={notes:managedVault.notes,linkCatalog:managedVault.linkCatalog};const row=note('a','A','').managed!;
 managedVault.linkCatalog=async()=>({items:[row]});managedVault.notes=async()=>({items:[row],total:2,hasMore:false});
 try{await assert.rejects(()=>loadMobileGraphSnapshot(source),/尚未完整/);}finally{Object.assign(managedVault,original);}
});
test('legacy recovery stays explicitly accessible without committing migration',async()=>{
 noteSourceSelection.select({kind:'legacy'});
 const originals={list:managedVault.list,migrationStatus:managedVault.migrationStatus};
 managedVault.list=async()=>({items:[],selectedVaultId:null});managedVault.migrationStatus=async()=>({state:'not-migrated',localVaultId:'local',noteCount:2,warnings:[]});
 try{const result=await listMobileGraphSources();assert.equal(result.sources[0].kind,'legacy');assert.equal(result.sources[0].readOnly,true);}finally{Object.assign(managedVault,originals);noteSourceSelection.select(null);}
});
test('CAS graph link persists stable identity; unlink touches only parsed prose',async()=>{
 const a=note('a','A','`[[@id/b]]`'),b=note('b','B','');const snapshot=await buildMobileGraphSnapshot(source,[a,b]);
 const originals={list:managedVault.list,get:managedVault.get,save:managedVault.save,linkCatalog:managedVault.linkCatalog};const saves:any[]=[];
 managedVault.list=async()=>({items:[{localVaultId:'local',name:'Local',binding:null,migrationState:'ready',noteCount:2}],selectedVaultId:'local'});
 managedVault.linkCatalog=async()=>({items:[a.managed!,b.managed!]});
 managedVault.get=async(_v,id)=>id==='a'?a.managed!:b.managed!;
 managedVault.save=async(...args)=>{saves.push(args);return a.managed!;};
 try{await linkMobileGraphNodes(snapshot,snapshot.seed.nodes[0].key,snapshot.seed.nodes[1].key);assert.equal(saves[0][2],'r1');assert.match(saves[0][4],/\n\[\[@id\/b\]\]/);
  a.content=saves[0][4];a.managed!.content=a.content;const updated=await buildMobileGraphSnapshot(source,[a,b]);await unlinkMobileGraphNodes(updated,updated.seed.nodes[0].key,updated.seed.nodes[1].key);assert.equal(saves[1][4].trim(),'`[[@id/b]]`');
 }finally{Object.assign(managedVault,originals);}
});
test('stale revision refuses all graph mutation',async()=>{
 const n=note('a','A',''),snapshot=await buildMobileGraphSnapshot(source,[n]);const originals={list:managedVault.list,get:managedVault.get,save:managedVault.save,linkCatalog:managedVault.linkCatalog};let writes=0;
 managedVault.list=async()=>({items:[{localVaultId:'local',name:'Local',binding:null,migrationState:'ready',noteCount:1}],selectedVaultId:'local'});managedVault.get=async()=>({...n.managed!,revision:'r2'});managedVault.save=async()=>{writes++;return n.managed!;};
 try{await assert.rejects(()=>setMobileGraphNoteTags(snapshot,snapshot.seed.nodes[0].key,['x']),/已变化/);assert.equal(writes,0);}finally{Object.assign(managedVault,originals);}
});

test('YAML-only Desktop tags are included; inline words excluded; union preserves phone metadata',async()=>{
 const s=await buildMobileGraphSnapshot(source,[note('a','A','\uFEFF---\ntags: ["One", \'#Two\']\ntag:\n - Three\n---\n#inline',{tags:['Phone']})]);
 assert.deepEqual(s.seed.nodes.filter(n=>n.type==='tag').map(n=>n.label).sort(),['One','Phone','Three','Two']);
 assert.equal(s.notesByKey.values().next().value!.tags.length,4);
});
test('ordinary Markdown files and reference images are parsed; remote URLs never become graph assets',async()=>{
 const p=parseMobileGraphBody('[PDF](manual.pdf)\n[doc](readme.md)\n![image][img]\n\n[img]: pic.png\n');
 assert.deepEqual(p.embeds.map(e=>e.target),['manual.pdf','pic.png']);
 const s=await buildMobileGraphSnapshot(source,[note('a','A','![x](https://example.com/a.png)')]);assert.equal(s.seed.nodes.length,1);
});
test('unverified resources are not fabricated as real material nodes',async()=>{
 const s=await buildMobileGraphSnapshot(source,[note('a','A','![[missing.png]]')]);assert.equal(s.seed.nodes.length,1);assert(s.warnings.some(w=>w.includes('附件引用暂未显示')));
});
test('legacy alias metadata is joined from catalog, not absent list row historicalNames',async()=>{
 const old={localNoteList:api.localNoteList,localNoteLinkCatalog:api.localNoteLinkCatalog};
 const a=note('note-a','A','[[Old B]]'),b=note('note-b','B','');
 api.localNoteList=async()=>({items:[a,b],total:2,hasMore:false});api.localNoteLinkCatalog=async()=>({items:[{noteId:'note-a',title:'A',folder:'',historicalNames:[]},{noteId:'note-b',title:'B',folder:'',historicalNames:['Old B']}]});
 try{const s=await loadMobileGraphSnapshot({...source,id:'legacy-local',kind:'legacy',readOnly:true});assert.equal(s.seed.edges.length,1);}finally{Object.assign(api,old);}
});

import {mobileGraphFrontmatterTags,withMobileGraphTags} from '../src/services/mobileGraphFrontmatter.ts';
test('tag CAS body formatter preserves unrelated attributes/body and removes old frontmatter tags',()=>{
 const body='---\ntitle: Keep\ntags:\n - old\ncustom: true\n---\n正文\n#inline\n';
 const changed=withMobileGraphTags(body,['中文','New']);assert.deepEqual(mobileGraphFrontmatterTags(changed),['中文','New']);assert(changed.includes('title: Keep\ncustom: true'));assert(changed.endsWith('正文\n#inline\n'));
 assert.deepEqual(mobileGraphFrontmatterTags(withMobileGraphTags('---\n---\nbody',['x'])),['x']);
 assert.deepEqual(mobileGraphFrontmatterTags(withMobileGraphTags(changed,[])),[]);
 assert.throws(()=>withMobileGraphTags('---\ntags: old\nbody',['x']),/未闭合/);
});
function boundNote(id:string,title:string,body:string,path:string):MobileGraphNote {
 const n=note(id,title,body);n.managed!.remote={instanceId:'i',vaultId:'v',relativePath:path,revision:'remote1',serverDocument:{instanceId:'i',vaultId:'v',noteId:id,relativePath:path,revision:'remote1'}};return n;
}
test('bound links resolve only verified Desktop paths and assets deduplicate confirmed logical path',async()=>{
 const bound={...source,id:'local',binding:{instanceId:'i',remoteVaultId:'v'}};
 const a=boundNote('a','A','[[../B]]\n![[../assets/p.png]]','Folder/A.md'),b=boundNote('b','B','![[assets/p.png]]','B.md');
 a.managed!.remote={...(a.managed!.remote as any),replica:{resources:[{resourceId:'ra',target:'../assets/p.png',status:'verified',localStatus:'verified'}]}};
 b.managed!.remote={...(b.managed!.remote as any),replica:{resources:[{resourceId:'rb',target:'assets/p.png',status:'verified',localStatus:'verified'}]}};
 const s=await buildMobileGraphSnapshot(bound,[a,b]);assert.equal(s.seed.nodes.filter(n=>n.type==='material').length,1);assert.equal(s.seed.edges.length,3);assert.equal(s.seed.nodes[0].relativePath,'Folder/A.md');
});
test('bound unconfirmed path cannot invent missing links or serialize private paths',async()=>{
 const bound={...source,binding:{instanceId:'i',remoteVaultId:'v'}},s=await buildMobileGraphSnapshot(bound,[note('a','A','[[Missing]]')]);
 assert.equal(s.seed.nodes.length,1);assert(s.warnings.some(w=>w.includes('路径尚未确认')));
});
test('verified old local assets produce one shared material node without external fetch',async()=>{
 const s=await buildMobileGraphSnapshot(source,[note('a','A','![[luckyray-local-asset:asset-1]]'),note('b','B','[PDF](luckyray-local-asset:asset-1)')],{resolveLocalAsset:async id=>({id,name:'本机资源'})});
 assert.equal(s.seed.nodes.filter(n=>n.type==='material').length,1);assert.equal(s.seed.edges.length,2);
});

import {removeMobileGraphRanges} from '../src/services/mobileGraphMutations.ts';
test('unlink merges overlapping nested image-link spans without consuming trailing prose',()=>{
 const body='before [![x](a.png)](a.png) trailing';const spans=parseMobileGraphBody(body).embeds.filter(e=>e.target==='a.png');
 assert.equal(spans.length,2);assert.equal(removeMobileGraphRanges(body,spans),'before  trailing');
});
test('tag writes reject ambiguous nested/block-scalar attributes without corrupting text',()=>{
 for(const body of ['---\ndescription: |\n  tags: keep me\ntags: [x]\n---\nbody','---\nmeta:\n  tags: [nested]\n---\nbody','---\ntags: [\n  nested\n]\n---\nbody'])assert.throws(()=>withMobileGraphTags(body,['New']),/属性|标签/);
 const body='---\ndescription: |\n  preserve this\ntags: [old]\n---\nbody';assert(withMobileGraphTags(body,['New']).includes('description: |\n  preserve this'));
});
test('tag writes reject multiline quoted values and sequence maps without leaving malformed remnants',()=>{
 for(const body of ['---\ntags: "first\n  second"\nother: x\n---\nbody','---\ntags:\n  - label: x\n    detail: keep\nother: x\n---\nbody','---\ntags: [x]\n  continuation\n---\nbody'])assert.throws(()=>withMobileGraphTags(body,['New']),/标签/);
});
test('shared canonical attachment unlink uses source-specific target provenance and native CAS',async()=>{
 const bound={...source,binding:{instanceId:'i',remoteVaultId:'v'}};
 const a=boundNote('a','A','![[../shared/p.png]]\n![[shared/p.png]]\ntrailing','dir/A.md'),b=boundNote('b','B','![[shared/p.png]]','B.md');
 a.managed!.remote={...(a.managed!.remote as any),replica:{resources:[{resourceId:'ra',target:'../shared/p.png',status:'verified',localStatus:'verified'},{resourceId:'rc',target:'shared/p.png',status:'verified',localStatus:'verified'}]}};
 b.managed!.remote={...(b.managed!.remote as any),replica:{resources:[{resourceId:'rb',target:'shared/p.png',status:'verified',localStatus:'verified'}]}};
 const snapshot=await buildMobileGraphSnapshot(bound,[a,b]),resource=[...snapshot.resourcesByKey].find(([,r])=>r.references?.length===2)!,original={list:managedVault.list,get:managedVault.get,save:managedVault.save,linkCatalog:managedVault.linkCatalog};let saved:any[]=[];
 managedVault.list=async()=>({items:[{localVaultId:'local',name:'Local',binding:bound.binding,migrationState:'ready',noteCount:2}],selectedVaultId:'local'});
 managedVault.linkCatalog=async()=>({items:[a.managed!,b.managed!]});managedVault.get=async()=>a.managed!;managedVault.save=async(...args)=>{saved=args;return a.managed!;};
 try{await unlinkMobileGraphNodes(snapshot,snapshot.seed.nodes[0].key,resource[0]);assert.equal(saved[1],'a');assert.equal(saved[2],'r1');assert.equal(saved[4],'\n![[shared/p.png]]\ntrailing');}finally{Object.assign(managedVault,original);}
});
test('actual CAS unlink refuses outer resource containing another independent image relation',async()=>{
 const n=note('a','A','[![pic](b.png)](a.pdf) tail');n.managed!.remote={replica:{resources:['a.pdf','b.png'].map((target,i)=>({resourceId:'r'+i,target,status:'verified',localStatus:'verified'}))}};
 const snapshot=await buildMobileGraphSnapshot(source,[n]),resource=[...snapshot.resourcesByKey].find(([,r])=>r.target==='a.pdf')!,original={list:managedVault.list,get:managedVault.get,save:managedVault.save,linkCatalog:managedVault.linkCatalog};let writes=0;
 managedVault.list=async()=>({items:[{localVaultId:'local',name:'Local',binding:null,migrationState:'ready',noteCount:1}],selectedVaultId:'local'});managedVault.get=async()=>n.managed!;managedVault.linkCatalog=async()=>({items:[n.managed!]});managedVault.save=async()=>{writes++;return n.managed!;};
 try{await assert.rejects(()=>unlinkMobileGraphNodes(snapshot,snapshot.seed.nodes[0].key,resource[0]),/另一项附件/);assert.equal(writes,0);assert.equal(n.managed!.content,'[![pic](b.png)](a.pdf) tail');}finally{Object.assign(managedVault,original);}
});
test('catalog change before CAS denies relationship writes even when source revision is unchanged',async()=>{
 const a=note('a','A','[[B]]'),b=note('b','B',''),snapshot=await buildMobileGraphSnapshot(source,[a,b]),old={list:managedVault.list,get:managedVault.get,save:managedVault.save,linkCatalog:managedVault.linkCatalog};let writes=0;
 managedVault.list=async()=>({items:[{localVaultId:'local',name:'Local',binding:null,migrationState:'ready',noteCount:2}],selectedVaultId:'local'});managedVault.get=async(_v,id)=>id==='a'?a.managed!:b.managed!;managedVault.linkCatalog=async()=>({items:[a.managed!,b.managed!,note('c','B','').managed!]});managedVault.save=async()=>{writes++;return a.managed!;};
 try{await assert.rejects(()=>unlinkMobileGraphNodes(snapshot,snapshot.seed.nodes[0].key,snapshot.seed.nodes[1].key),/目录已变化/);assert.equal(writes,0);}finally{Object.assign(managedVault,old);}
});

test('attachment warnings count reference occurrences, distinguish known checks, never claim lost files',async()=>{
 const n=note('a','A','![[same.png]]\n![[same.png]]\n![[pending.png]]\n![](luckyray-local-asset:local1)');
 n.managed!.remote={replica:{resources:[{resourceId:'r',target:'pending.png',status:'verified',localStatus:'missing'}]}};
 const s=await buildMobileGraphSnapshot(source,[n],{resolveLocalAsset:async()=>null});
 assert.equal(s.seed.nodes.length,1);
 const warning=s.warnings.find(w=>w.includes('附件引用'))!;
 assert.match(warning,/4 处附件引用/);assert.match(warning,/2 处未找到附件索引/);assert.match(warning,/2 处附件尚未通过本机可用性检查/);
 assert.match(warning,/不代表丢失的文件数/);assert.doesNotMatch(warning,/未假定|4 个文件|4 个附件/);
});
test('managed graph retries one settling metadata edit, never loops while notes keep changing',async()=>{
 const originals={notes:managedVault.notes,linkCatalog:managedVault.linkCatalog};
 const a=note('a','A','').managed!;let reads=0;
 managedVault.linkCatalog=async()=>({items:[a]});
 managedVault.notes=async()=>({items:[{...a,revision:++reads===1?'old':a.revision}],total:1,hasMore:false});
 try{
  assert.equal((await loadMobileGraphSnapshot(source)).notesByKey.size,1);assert.equal(reads,2);
  reads=0;managedVault.notes=async()=>{reads++;return {items:[{...a,revision:'always-changing'}],total:1,hasMore:false};};
  await assert.rejects(()=>loadMobileGraphSnapshot(source),/元数据已变化/);assert.equal(reads,2);
 }finally{Object.assign(managedVault,originals);}
});
test('managed graph rejects late response after selection A to B to A',async()=>{
 const originals={notes:managedVault.notes,linkCatalog:managedVault.linkCatalog};
 const a=note('a','A','').managed!;let release!:(value:any)=>void;
 managedVault.linkCatalog=()=>new Promise(resolve=>{release=resolve;});
 managedVault.notes=async()=>({items:[a],total:1,hasMore:false});
 noteSourceSelection.select({kind:'managed',localVaultId:'local'});
 try{
  const pending=loadMobileGraphSnapshot(source);
  noteSourceSelection.select({kind:'managed',localVaultId:'other'});
  noteSourceSelection.select({kind:'managed',localVaultId:'local'});
  release({items:[a]});await assert.rejects(()=>pending,{name:'AbortError'});
 }finally{Object.assign(managedVault,originals);noteSourceSelection.select(null);}
});
