import test from 'node:test';import assert from 'node:assert/strict';
import {wikiCompletionBounds} from '../src/presentation/still01/editor/wikiCompletionLayout.ts';
for(const [w,h,x,y] of [[360,700,0,0],[320,280,0,0],[800,300,0,0],[180,240,50,20],[100,150,0,0]])test(`candidate viewport ${w}x${h} at ${x},${y}`,()=>{
 const b=wikiCompletionBounds(w,h,x,y);
 assert.ok(b.left>=x&&b.right<=x+w&&b.top>=y&&b.bottom<=y+h);
 assert.ok(b.right-b.left>0&&b.bottom-b.top>0);
});
