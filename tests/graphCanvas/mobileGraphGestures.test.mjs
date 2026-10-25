import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pinchCamera,graphPoint,graphPixelRatio} from '../../src/features/graph/mobileGraphGestures.ts';
test('pinch preserves world coordinate under moving focal midpoint',()=>{
 const camera={scale:2,panX:10,panY:30};const before=[{x:40,y:50},{x:140,y:50}];const after=[{x:20,y:80},{x:220,y:80}];
 const next=pinchCamera(camera,before,after);assert.equal(next.scale,4);assert.deepEqual(graphPoint(camera,{x:90,y:50}),graphPoint(next,{x:120,y:80}));
});
test('pinch clamps maximum/minimum scale and stays finite with coincident touches',()=>{
 assert.equal(pinchCamera({scale:12,panX:0,panY:0},[{x:0,y:0},{x:1,y:0}],[{x:0,y:0},{x:100,y:0}]).scale,12);
 const result=pinchCamera({scale:1,panX:0,panY:0},[{x:0,y:0},{x:0,y:0}],[{x:0,y:0},{x:0,y:0}]);assert.equal(result.scale,.025);assert.ok(Number.isFinite(result.panX));
});
test('translation of a two-finger gesture pans without changing zoom',()=>{
 const result=pinchCamera({scale:1,panX:0,panY:0},[{x:0,y:0},{x:20,y:0}],[{x:40,y:60},{x:60,y:60}]);assert.deepEqual(result,{scale:1,panX:40,panY:60});
});
test('DPR cap bounds phone backing pixel allocation',()=>{
 assert.equal(graphPixelRatio(3,400,800),2);assert.ok(graphPixelRatio(4,2000,2000)<=1);assert.equal(graphPixelRatio(NaN,400,800),1);
});
