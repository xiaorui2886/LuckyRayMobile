import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeGraphWorkerPositions,activateGraphPlaybackBodies,dragGraphPlaybackBody,graphVisualEdgeEndpoint,graphPointerMoved,graphPositionIsFinite} from '../../src/features/graph/mobileGraphInteraction.ts';
import {buildGraphPlaybackPlan,graphPlaybackNodeVisual} from '../../src/features/graph/core/graphPlayback.ts';
const body=(id,x,y)=>({id,x,y,vx:0,vy:0,r:4});
test('worker replies advance neighbours without overwriting the grabbed node',()=>{
 const nodes=[body(1,100,100),body(2,200,200)];
 assert.equal(mergeGraphWorkerPositions(nodes,Float64Array.from([5,6,1,2,210,215,3,4]),1),true);
 assert.deepEqual(nodes[0],body(1,100,100));assert.equal(nodes[1].x,210);assert.equal(nodes[1].vy,4);
 assert.equal(mergeGraphWorkerPositions(nodes,Float64Array.from([1]),null),false);
 assert.equal(mergeGraphWorkerPositions(nodes,Float64Array.from([1,2,0,0,NaN,1,0,0]),null),false);assert.equal(nodes[0].x,100,'invalid buffer cannot partially update bodies');
});
test('birth positions follow the live parent and activate only once',()=>{
 const input=[{id:1,x:0,y:0,links:3},{id:2,x:120,y:0,links:1}];const timeline=buildGraphPlaybackPlan({nodes:input,edges:[{a:1,b:2}],startedAt:0});
 const bodies=new Map(input.map(n=>[n.id,body(n.id,n.x,n.y)])),active=new Set();const root=[...timeline.nodes.values()].find(p=>p.parentId===null),child=[...timeline.nodes.values()].find(p=>p.parentId!==null);
 assert.ok(root&&child);activateGraphPlaybackBodies(timeline,root.startAt,input,bodies,active);const parent=bodies.get(child.parentId);parent.x=300;parent.y=200;
 assert.equal(activateGraphPlaybackBodies(timeline,child.startAt,input,bodies,active),true);
 const childId=[...timeline.nodes].find(([,p])=>p===child)[0],actual=bodies.get(childId);assert.ok(Math.hypot(actual.x-300,actual.y-200)<=4.2);assert.ok(Math.hypot(actual.vx,actual.vy)<=1.450001);
 assert.equal(activateGraphPlaybackBodies(timeline,child.startAt,input,bodies,active),false);
});
test('dragging a playing node overrides birth easing and shifts future children',()=>{
 const timeline=buildGraphPlaybackPlan({nodes:[{id:1,x:0,y:0,links:3},{id:2,x:120,y:0,links:1}],edges:[{a:1,b:2}],startedAt:0});
 const [id,root]=[...timeline.nodes].find(([,p])=>p.parentId===null),child=[...timeline.nodes.values()].find(p=>p.parentId===id);const before=child.spawnX;
 dragGraphPlaybackBody(timeline,id,0,{x:40,y:20},{x:0,y:0});assert.equal(root.targetX,40);assert.equal(child.spawnX,before+40);assert.deepEqual(graphPlaybackNodeVisual(root,0,{x:40,y:20}),{x:40,y:20,scale:1,alpha:1,progress:1});
});
test('tree edge attaches to actual newborn node, not a second progress interpolation',()=>{const from={x:10,y:30},to={x:90,y:100};assert.equal(graphVisualEdgeEndpoint(from,to),to);});
test('desktop movement tolerance and finite restored positions',()=>{assert.equal(graphPointerMoved({x:0,y:0},{x:4,y:0}),false);assert.equal(graphPointerMoved({x:0,y:0},{x:4.1,y:0}),true);assert.equal(graphPositionIsFinite({key:'a',x:1,y:2,vx:0,vy:0}),true);assert.equal(graphPositionIsFinite({key:'a',x:Infinity,y:2,vx:0,vy:0}),false);});
