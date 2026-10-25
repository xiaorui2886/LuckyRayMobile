// DOM-contract geometry only. Real font wrapping / Android IME needs device QA.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url)),require=createRequire(import.meta.url);
const tools=process.env.LR_DOM_TEST_TOOLS?createRequire(join(resolve(process.env.LR_DOM_TEST_TOOLS),'__harness__.cjs')):require;
const {JSDOM}=tools('jsdom'),{build,stop}=createRequire(require.resolve('vite/package.json'))('esbuild');
test('native table caret mirror preserves whole-word wrapping and measures only first suffix line',async()=>{
 const dom=new JSDOM('<textarea></textarea>',{pretendToBeVisual:true}),dir=mkdtempSync(join(tmpdir(),'lr-caret-'));
 try{const out=join(dir,'caret.cjs');await build({entryPoints:[join(root,'src/presentation/still01/editor/nativeTextareaCaret.ts')],outfile:out,bundle:true,platform:'node',format:'cjs'});const {nativeTextareaCaretRect}=require(out);
  const doc=dom.window.document,input=doc.querySelector('textarea');input.style.fontSize='14px';input.style.lineHeight='21px';input.style.width='90px';input.value='short wholeword afterwards';input.setSelectionRange(9,9);
  input.getBoundingClientRect=()=>({top:100,left:0,width:90,height:200});input.scrollTop=7;
  const original=dom.window.HTMLElement.prototype.getClientRects;let observed=false;
  dom.window.HTMLElement.prototype.getClientRects=function(){if(this.tagName==='SPAN'){observed=true;assert.equal(this.textContent,'leword afterwards');assert.equal(this.parentElement.textContent,input.value);assert.equal(this.parentElement.style.width,'90px');return [{top:21,height:42},{top:42,height:21}]}return original.call(this)};
  assert.deepEqual(nativeTextareaCaretRect(input),{top:114,bottom:135});assert.equal(observed,true);assert.equal(doc.body.children.length,1,'offscreen mirror must be removed');
  input.getBoundingClientRect=()=>({top:100,left:0,width:0,height:0});assert.equal(nativeTextareaCaretRect(input),null);
 }finally{stop();dom.window.close();rmSync(dir,{recursive:true,force:true})}
});
