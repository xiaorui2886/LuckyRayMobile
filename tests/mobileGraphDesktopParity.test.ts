import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRealVaultGraphSeed} from './fixtures/desktopGraphSeedReference.ts';
import {buildMobileGraphSnapshot,parseMobileGraphBody} from '../src/services/mobileGraphIndex.ts';
import {mobileGraphFrontmatterTags} from '../src/services/mobileGraphFrontmatter.ts';
import type {MobileGraphSource,MobileGraphNote} from '../src/services/mobileGraph.ts';
import type {GraphSeed} from '../src/features/graph/core/graphTypes.ts';
const source:MobileGraphSource={id:'local',name:'Local',kind:'managed',readOnly:false};
function note(id:string,title:string,content:string):MobileGraphNote {return {noteId:id,title,content,folder:'',relativePath:`${title}.md`,revision:'r',tags:[],historicalNames:[],updatedAt:'2026-01-01T00:00:00Z',openRoute:id,bodyState:'ready'};}
function normalized(seed:GraphSeed){
 const key=(id:number)=>`${seed.nodes[id].type}:${seed.nodes[id].label}:${seed.nodes[id].status||'real'}`;
 return {nodes:seed.nodes.map(n=>`${n.type}:${n.label}:${n.status||'real'}`).sort(),edges:seed.edges.map(([a,b])=>{
 const ek=`${Math.min(a,b)}:${Math.max(a,b)}`,dir=seed.edgeDirections?.[ek]||'undirected';
 return `${dir==='bidirectional'?[key(a),key(b)].sort().join('<>'):dir==='reverse'?key(b)+'>'+key(a):key(a)+'>'+key(b)}:${seed.edgeKinds?.[ek]}`;
 }).sort()};
}
test('actual extracted desktop builder and mobile agree for shared plain Markdown fixture',async()=>{
 const rows=[note('a','A','---\ntags: [Topic, "#中文"]\n---\n[[B]] [[Missing]] [[../outside]]\n![[B]]\n`[[Hidden]]`\n#inline'),note('b','B','[[A]] [[Missing]]')];
 const index={vaultId:'v',documents:rows.map(n=>({relativePath:n.relativePath,title:n.title,mtime:n.updatedAt,wikiLinks:parseMobileGraphBody(n.content!).references.map(r=>({target:r.target})),frontmatterTags:mobileGraphFrontmatterTags(n.content!)}))};
 const desktop=buildRealVaultGraphSeed(index,new Map([['A.md',[{kind:'document' as const,relativePath:'B.md'}]]]));
 const mobile=(await buildMobileGraphSnapshot(source,rows)).seed;
 assert.deepEqual(normalized(mobile),normalized(desktop));
 assert.equal(mobile.nodes.filter(n=>n.status==='missing'&&n.label==='Missing').length,2,'Desktop itself scopes missing nodes by source document');
});
test('intentional phone legacy adaptation: ambiguous aliases are not guessed',async()=>{
 const rows=[note('a','A','[[Alias]]'),{...note('b','B',''),historicalNames:['Alias']},{...note('c','C',''),historicalNames:['Alias']}];
 const snapshot=await buildMobileGraphSnapshot(source,rows);
 assert.equal(snapshot.seed.edges.length,0);assert(snapshot.warnings.some(w=>w.includes('不唯一')));
});
test('phone root-relative missing location matches existing local wiki navigation rather than desktop source-relative',async()=>{
 const rows=[{...note('a','A','[[./B]]'),folder:'Folder',relativePath:'Folder/A.md'},{...note('b','B',''),folder:'Folder',relativePath:'Folder/B.md'}];
 const snapshot=await buildMobileGraphSnapshot(source,rows),missing=snapshot.seed.nodes.find(n=>n.status==='missing');assert.equal(missing?.missingTarget?.relativePath,'B.md');
});
