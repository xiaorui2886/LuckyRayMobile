import assert from 'node:assert/strict';
import test from 'node:test';
import {buildGraphPlaybackPlan,graphPlaybackNodeVisual,graphPlaybackEdgeProgress} from '../../src/features/graph/core/graphPlayback.ts';
test('empty graph has no fake playback and dated graph grows oldest first',()=>{
 assert.equal(buildGraphPlaybackPlan({nodes:[],edges:[],startedAt:0}),null);
 const plan=buildGraphPlaybackPlan({nodes:[{id:0,x:5,y:8,links:1,timelineAt:0},{id:1,x:100,y:200,links:1,timelineAt:86400000},{id:2,x:20,y:30,links:0}],edges:[{a:0,b:1}],startedAt:42})!;
 assert.ok(plan.nodes.get(0)!.startAt<plan.nodes.get(1)!.startAt);assert.ok(plan.nodes.get(1)!.startAt<plan.nodes.get(2)!.startAt);
 for(const n of plan.nodes.values()){assert.equal(graphPlaybackNodeVisual(n,n.startAt-1),null);assert.deepEqual(graphPlaybackNodeVisual(n,plan.totalDuration),{x:n.targetX,y:n.targetY,scale:1,alpha:1,progress:1});}
 for(const e of plan.edges.values()){assert.equal(graphPlaybackEdgeProgress(e,-1),0);assert.equal(graphPlaybackEdgeProgress(e,plan.totalDuration),1);}
});
test('playback is deterministic and ignores absent graph edges',()=>{
 const nodes=Array.from({length:40},(_,id)=>({id,x:id*2,y:id*3,links:id%3}));const input={nodes,edges:[{a:0,b:1},{a:1,b:2}],startedAt:0};
 assert.deepEqual(buildGraphPlaybackPlan(input),buildGraphPlaybackPlan(input));
 assert.deepEqual(buildGraphPlaybackPlan(input),buildGraphPlaybackPlan({...input,edges:[...input.edges,{a:0,b:999}]}));
});
