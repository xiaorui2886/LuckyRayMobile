import assert from 'node:assert/strict';
import test from 'node:test';
import {graphArrowTriangle,graphEdgePaint,graphNodeFill,graphPlaybackCameraTarget} from '../../src/features/graph/core/graphRenderer.ts';
import {buildGraphPlaybackPlan} from '../../src/features/graph/core/graphPlayback.ts';
test('arrows avoid overlap and missing/dimmed/growing-tree edges',()=>{
 assert.equal(graphArrowTriangle(0,0,2,0,4,1),null);const tri=graphArrowTriangle(0,0,100,0,4,1)!;assert.equal(tri.length,3);assert.ok(tri[0].x<96);assert.ok(tri.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)));
 const input={kind:'wiki-link' as const,scale:1,edgeWidth:1,relatedToFocus:false,dimmed:false,missingEndpoint:false,treeEdge:true,progress:.5,fromAlpha:.8,toAlpha:.6};
 assert.equal(graphEdgePaint(input).arrows,false);assert.equal(graphEdgePaint({...input,progress:1}).arrows,true);assert.equal(graphEdgePaint({...input,progress:1,missingEndpoint:true}).arrows,false);
 assert.ok(graphEdgePaint({...input,dimmed:true}).alpha<graphEdgePaint(input).alpha);
});
test('node color mixing and playback follow target preserve desktop bounds',()=>{
 const input={color:'#ffffff',background:'#000000',accent:'#ffffff',focused:false,dimmed:false,neighbor:false,document:true};assert.equal(graphNodeFill(input),'#e0e0e0');assert.equal(graphNodeFill({...input,dimmed:true}),'#292929');
 const nodes=[{id:0,x:50,y:80,r:4,links:0}],plan=buildGraphPlaybackPlan({nodes,edges:[],startedAt:0})!,camera={scale:1,panX:0,panY:0};assert.equal(graphPlaybackCameraTarget(plan,0,nodes,360,720,1,camera),null);
 const target=graphPlaybackCameraTarget(plan,plan.totalDuration,nodes,360,720,1,camera)!;assert.ok(target.scale>1&&target.scale<=1.65);assert.ok(Number.isFinite(target.panX)&&Number.isFinite(target.panY));
});
