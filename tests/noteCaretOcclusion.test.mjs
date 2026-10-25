import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const require=createRequire(import.meta.url);
const {build,stop}=createRequire(require.resolve('vite/package.json'))('esbuild');
const root=fileURLToPath(new URL('..',import.meta.url));
test('production caret clearance requires tail eligibility AND actual occlusion',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'lr-caret-occlusion-'));
 try {
  const out=join(dir,'entry.cjs');
  await build({entryPoints:[join(root,'src/presentation/still01/editor/noteTailClearance.ts')],outfile:out,bundle:true,platform:'node',format:'cjs'});
  const {tailRevealDelta}=require(out);
  for(const endBottom of [500,700,840,841,1400,20000]) {
   assert.equal(tailRevealDelta({top:460,bottom:480,endBottom,collapsed:true},0,440,1000,360),endBottom<=840?52:0,`caret hidden by toolbar/IME; document end=${endBottom}`);
  }
  assert.equal(tailRevealDelta({top:260,bottom:280,endBottom:20000,collapsed:true},0,440,1000,360),0,'visible mid-note caret stays put');
  assert.equal(tailRevealDelta({top:460,bottom:480,endBottom:1400,collapsed:false},0,440,1000,360),0,'range selection stays put');
  assert.equal(tailRevealDelta({top:-30,bottom:-10,endBottom:1400,collapsed:true},0,440,1000,360),0,'offscreen-above caret is not a reveal request');
  assert.equal(tailRevealDelta({top:460,bottom:480,endBottom:500,collapsed:true},0,440,20,360),20,'clamp to reachable content');
 } finally {stop();rmSync(dir,{recursive:true,force:true});}
});
