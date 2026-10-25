import {test} from 'node:test';import assert from 'node:assert/strict';
import {graphCameraSignature,graphActivationTransition} from '../../src/features/graph/mobileGraphLifecycle.ts';
test('equal external camera values remain identical despite new React identity',()=>{assert.equal(graphCameraSignature({scale:1,panX:2,panY:3}),graphCameraSignature({...{scale:1,panX:2,panY:3}}));assert.notEqual(graphCameraSignature({scale:1,panX:2,panY:3}),graphCameraSignature({scale:1,panX:4,panY:3}));});
test('new timeline nodes reheat a cooled solver and invalidate in-flight response',()=>{assert.deepEqual(graphActivationTransition('1',[1,2],.00001,7),{key:'1,2',changed:true,alpha:.4,revision:8});});
test('reverse seek and playback stop both update activation',()=>{assert.equal(graphActivationTransition('1,2',[1],0,8).revision,9);assert.equal(graphActivationTransition('1',[1,2,3],0,9).alpha,.4);});
test('unchanged activation cannot reheat forever',()=>{assert.deepEqual(graphActivationTransition('1,2',[1,2],.00001,7),{key:'1,2',changed:false,alpha:.00001,revision:7});});
