import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const core=new URL('../../src/features/graph/core/',import.meta.url);
test('ported pure desktop engine matches pinned source bytes without remote access',()=>{
 const manifest=JSON.parse(readFileSync(new URL('SOURCE-PROVENANCE.json',core),'utf8'));
 assert.equal(manifest.commit,'200433932c465ea26b16e8e4fa272507ce692388');assert.equal(manifest.byteIdentical.length,7);
 for(const item of manifest.byteIdentical){const content=readFileSync(new URL(item.file,core));assert.equal(createHash('sha256').update(content).digest('hex'),item.sha256,item.file);}
});
