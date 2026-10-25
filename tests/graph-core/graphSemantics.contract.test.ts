import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizeGraphView,filteredGraph,graphForceParameters,buildGraphSearchResults,graphSearchScopeKeys} from '../../src/features/graph/core/graphSemantics.ts';
import type {GraphSeed} from '../../src/features/graph/core/graphTypes.ts';
const seed:GraphSeed={source:'real',nodes:[{id:0,key:'a',label:'A',type:'note',relativePath:'Folder/A.md'},{id:1,key:'b',label:'B',type:'note',relativePath:'Folder/B.md'},{id:2,key:'c',label:'C',type:'note',relativePath:'Else/C.md'},{id:3,key:'t',label:'项目',type:'tag'},{id:4,key:'iso',label:'Isolated',type:'note',relativePath:'Empty/Isolated.md'}],edges:[[0,1],[1,2],[0,3]],edgeDirections:{'0:1':'bidirectional'}};
test('desktop actual defaults and nonlinear force anchors preserved',()=>{
 const s=normalizeGraphView();assert.equal(s.labelReveal,.45);assert.equal(s.linkLength,180);assert.deepEqual(s.filters,{material:false,note:true,tag:false,web:false});
 const f=graphForceParameters(s);for(const [key,value] of Object.entries({repulsion:100,attraction:1,centerPull:.02,collisionGap:14}))assert.ok(Math.abs(f[key as keyof typeof f]-value)<1e-12);
 assert.equal(normalizeGraphView({labelReveal:Infinity}).labelReveal,.45);assert.equal(normalizeGraphView({forceStrength:2}).repulsionForce,75);
});
test('one/two hop and isolate preservation use filtered topology, not global degree',()=>{
 assert.deepEqual(filteredGraph(seed,normalizeGraphView({nearbyFilter:true}),{selectedId:0}).renderedNodes.map(n=>n.id),[0,1]);
 assert.deepEqual(filteredGraph(seed,normalizeGraphView({nearbyFilter:true,nearbyDepth:2}),{selectedId:0}).renderedNodes.map(n=>n.id),[0,1,2]);
 const s=normalizeGraphView({showIsolated:false});assert.ok(!filteredGraph(seed,s).renderedNodes.some(n=>n.id===4));assert.ok(filteredGraph(seed,s,{selectedId:4}).renderedNodes.some(n=>n.id===4));
 assert.ok(filteredGraph(seed,s,{scopeKeys:new Set(['iso'])}).renderedNodes.some(n=>n.id===4));
});
test('color groups use all original tag edges and first group wins, missing stays neutral',()=>{
 const s=normalizeGraphView({colorGroups:[{query:'tag:项目',color:'#112233'},{query:'A',color:'#445566'}]});assert.equal(filteredGraph(seed,s).nodes[0].color,'#112233');
 const missing={...seed,nodes:seed.nodes.map(n=>n.id===0?{...n,status:'missing' as const}:n)};assert.equal(filteredGraph(missing,s).nodes[0].color,'#59606a');
});
test('search supports folders, document neighbor scope and twelve-result cap',()=>{
 const folder=buildGraphSearchResults(seed.nodes,'folder')[0];assert.equal(folder.kind,'folder');assert.deepEqual([...graphSearchScopeKeys(folder,seed)],['a','b']);
 const doc=buildGraphSearchResults(seed.nodes,'A.md')[0];assert.equal(doc.kind,'document');assert.deepEqual([...graphSearchScopeKeys(doc,seed)],['a','b','t']);
 assert.equal(buildGraphSearchResults(Array.from({length:20},(_,id)=>({id,key:String(id),label:'test'+id,type:'note' as const})),'test').length,12);
});
test('edge kind and bidirectional orientation survive filtering',()=>{const scene=filteredGraph(seed,normalizeGraphView());assert.equal(scene.visibleEdges[0].direction,'bidirectional');assert.equal(scene.visibleEdges[0].kind,'relation');});
