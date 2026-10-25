// Production row DOM and CSS cascade contracts. JSDOM has no layout engine:
// these are NOT browser screenshots, measured glyph geometry or Android QA.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url)),require=createRequire(import.meta.url);
const tools=process.env.LR_DOM_TEST_TOOLS?createRequire(join(resolve(process.env.LR_DOM_TEST_TOOLS),'__harness__.cjs')):require;
const {JSDOM}=tools('jsdom'),{build,stop}=createRequire(require.resolve('vite/package.json'))('esbuild');
const read=p=>readFileSync(join(root,p),'utf8');
test('N1/N2/N6 note sidebar DOM and scoped CSS contracts',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'lr-sidebar-layout-'));let dom;
 try{
  const out=join(dir,'entry.cjs');
  await build({stdin:{contents:`import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {KnowledgeNoteRow} from './src/still/kit/knowledgeNoteRow';import {IconButton} from './src/still/kit/StillImports';export const row=(current=false)=>renderToStaticMarkup(<KnowledgeNoteRow title="luckyray-UI设计-极简原型很长的笔记标题" body="" meta={current?'当前笔记':'本机笔记'} noteId="one" current={current} onClick={()=>{}}/>);export const footer=renderToStaticMarkup(<footer className="st-note-drawer-footer"><small>本机知识库</small><div><IconButton icon="plus" label="新建笔记"/><IconButton icon="search" label="搜索笔记"/><IconButton icon="folder" label="收起所有目录"/></div></footer>);`,resolveDir:root,loader:'tsx'},outfile:out,bundle:true,platform:'node',format:'cjs',loader:{'.css':'empty'}});
  const {row,footer}=require(out);
  const css=['src/presentation/still01/still.css','src/presentation/still01/defaultTheme.css','src/presentation/still01/editor/cmLivePreview.css','src/still/kit/noteExperience.css','src/still/kit/noteSidePanel.css'].map(read).join('\n');
  dom=new JSDOM(`<style>${css}</style><div class="st-app"><div class="st-note-paper-viewport"><aside class="st-note-drawer"><div class="st-note-drawer-body">${row(true)}${row()}<section class="st-note-relations"><h3 class="st-links-heading">引用此笔记</h3><p class="st-folder-status">还没有其他笔记引用此笔记。</p></section></div>${footer}</aside><section class="st-note-surface"><div class="st-note-paper is-editing"><div class="st-note-editor is-cm"><div class="cm-scroller"><div class="st-note-heading"><input class="st-note-title"></div><div class="cm-content">正文</div></div></div></div></section></div><div class="st-knowledge-view">${row()}</div></div>`);
  const doc=dom.window.document,style=selector=>dom.window.getComputedStyle(doc.querySelector(selector));
  await t.test('N2 compact current row preserves label, identity and full title while truncating visually',()=>{
   const current=doc.querySelector('.st-note-drawer [aria-current=page]');assert.equal(current.dataset.noteId,'one');assert.equal(current.querySelector('strong').textContent,'luckyray-UI设计-极简原型很长的笔记标题');
   assert.equal(style('.st-note-drawer .st-note-row').minHeight,'48px');assert.equal(style('.st-note-drawer .st-note-row').paddingLeft,'38px');assert.equal(style('.st-note-drawer .st-note-row').borderBottomWidth,'0px');assert.equal(style('.st-note-drawer .st-note-row').boxShadow,'none');
   assert.equal(style('.st-note-drawer .st-note-row p').display,'none');assert.equal(style('.st-note-drawer .st-note-row strong').textOverflow,'ellipsis');assert.equal(style('.st-note-drawer .st-knowledge-note-symbol').display,'flex');
   assert.equal(style('.st-knowledge-view .st-note-row').minHeight,'72px','library rows retain their own density');
  });
  await t.test('N2 footer actions remain in one horizontal row with 44px hit targets',()=>{
   assert.equal(style('.st-note-drawer-footer>div').display,'flex');assert.equal(doc.querySelectorAll('.st-note-drawer-footer button').length,3);assert.equal(style('.st-note-drawer-footer button').minWidth,'44px');assert.equal(style('.st-note-drawer-footer button').height,'44px');
  });
  await t.test('N6 divider has explicit heading and empty-state spacing',()=>{
   assert.equal(style('.st-note-relations').paddingTop,'14px');assert.equal(style('.st-note-relations').marginTop,'16px');assert.equal(style('.st-note-relations>.st-links-heading').marginTop,'0px');assert.equal(style('.st-note-relations>.st-links-heading').marginBottom,'8px');assert.equal(style('.st-note-relations>.st-folder-status').paddingLeft,'0px');
  });
  await t.test('N1 heading and body share the borrowed gutter without moving reading title or toolbar',()=>{
   const sheet=read('src/still/kit/noteExperience.css');assert.match(sheet,/\.st-app \.st-note-surface\{--st-note-editor-inset:22px\}/);
   const heading=doc.querySelector('.st-note-heading');assert.ok(heading.matches('.st-app .st-note-editor.is-cm .cm-scroller>.st-note-heading'));
   assert.equal(style('.st-note-heading').paddingLeft,'var(--st-note-editor-inset)');assert.equal(style('.st-note-heading').paddingRight,'var(--st-note-editor-inset)');assert.equal(style('.st-note-heading').boxSizing,'border-box');
   assert.match(read('src/presentation/still01/editor/cmLivePreview.css'),/padding-left:var\(--st-note-editor-inset,\s*22px\);padding-right:var\(--st-note-editor-inset,\s*22px\)/);
  });
 }finally{dom?.window.close();stop();rmSync(dir,{recursive:true,force:true})}
});
