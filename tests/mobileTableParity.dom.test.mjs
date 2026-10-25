// Actual Markdown renderer + shared width calculation. No Android layout claims.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url)),require=createRequire(import.meta.url);
const {build,stop}=createRequire(require.resolve('vite/package.json'))('esbuild');
test('reading tables preserve safe Markdown and share editor content widths',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'lr-table-parity-'));
 try{
  const out=join(dir,'test.cjs');await build({stdin:{contents:`export {SafeNoteMarkdown} from './src/components/SafeNoteMarkdown';export {tableColumnWidths} from './src/presentation/still01/editor/tableColumnWidths';export {createElement} from 'react';export {renderToStaticMarkup} from 'react-dom/server';`,resolveDir:root,loader:'tsx'},outfile:out,bundle:true,platform:'node',format:'cjs',loader:{'.css':'empty'}});
  const {SafeNoteMarkdown,tableColumnWidths,createElement,renderToStaticMarkup}=require(out);
  const rows=[['项','说明'],['短','描述内容需要自动换行而不是撑出屏幕']];const widths=tableColumnWidths(rows);
  const source='| 项 | 说明 |\n| --- | --- |\n| **短** | 描述内容需要自动换行而不是撑出屏幕 |';
  const html=renderToStaticMarkup(createElement(SafeNoteMarkdown,{content:source}));
  assert.match(html,/<colgroup>/);for(const width of widths)assert.ok(html.includes(`width:${width}%`));assert.match(html,/<strong[^>]*><span[^>]*>短<\/span><\/strong>/);assert.ok(Math.abs(widths.reduce((a,b)=>a+b,0)-100)<1e-8);
  const unsafe=renderToStaticMarkup(createElement(SafeNoteMarkdown,{content:'| A | B |\n| --- | --- |\n| <script>bad()</script> | [bad](javascript:alert(1)) |'}));assert.doesNotMatch(unsafe,/<script|href="javascript:/);
  assert.deepEqual(tableColumnWidths([]),[]);assert.deepEqual(tableColumnWidths([['','']]),[50,50]);
 }finally{stop();rmSync(dir,{recursive:true,force:true})}
});
