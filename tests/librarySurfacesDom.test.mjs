// DOM + cascade checks, not browser layout or Android/device QA.
// LR_DOM_TEST_TOOLS=/path/to/runtime node --test tests/librarySurfacesDom.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url);
const {build}=createRequire(require.resolve('vite/package.json'))('esbuild');
const runtime=process.env.LR_DOM_RUNTIME;
const toolsPath=process.env.LR_DOM_TEST_TOOLS;
if(!runtime&&!toolsPath)throw new Error('Set LR_DOM_TEST_TOOLS to a disposable jsdom runtime directory.');
const {JSDOM}=createRequire(resolve(toolsPath||runtime,'__harness__.cjs'))('jsdom');
const temp=mkdtempSync(join(tmpdir(),'lr-library-dom-'));
const out=join(temp,'render.mjs');
await build({stdin:{contents:`import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {CollectionView,InboxView} from './src/presentation/still01/Views';import {KnowledgeNoteRow} from './src/still/kit/knowledgeNoteRow';export function render(props){return renderToStaticMarkup(React.createElement(CollectionView,props))}export function note(props){return renderToStaticMarkup(React.createElement(KnowledgeNoteRow,props))}export function inbox(){return renderToStaticMarkup(React.createElement(InboxView,{items:[],query:'',onQuery(){},onOpen(){},onBack(){},onCapture(){}}))}`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,banner:{js:"import {createRequire} from 'node:module';const require=createRequire(import.meta.url);"},format:'esm',platform:'node',outfile:out,loader:{'.css':'empty'},logLevel:'silent'});
const {render,note,inbox}=await import(pathToFileURL(out));
const files=['src/presentation/still01/still.css','src/still/kit/noteExperience.css','src/still/kit/knowledgeNavigation.css','src/presentation/still01/defaultTheme.css','src/still/kit/librarySurfaces.css'];
const css=files.map(f=>readFileSync(f,'utf8')).join('\n');
const noop=()=>{};
const props={domain:'library',source:'local',onSource:noop,query:'',onQuery:noop,onNew:noop,onBrowse:noop,onRefresh:noop,notes:[],assets:[{id:'asset-a',title:'很长的中文素材标题'.repeat(15),meta:'图片 · 1 MB',src:'',kind:'image',source:'local'}],open:noop,paired:true,connected:true,list:false,onList:noop,filterLabel:''};
const menu='<div class="st-modal"><div class="st-sheet"><button class="st-option" aria-pressed="true"><span>很长的中文菜单选项名称<small>保留已选择的标签和排序</small></span></button></div></div>';
function fixture(content,mode='light'){const dom=new JSDOM(`<style>${css}</style><main class="st-app" data-mode="${mode}" style="width:320px">${content}</main>`,{pretendToBeVisual:true});return {dom,q:s=>dom.window.document.querySelector(s),style:s=>dom.window.getComputedStyle(dom.window.document.querySelector(s))}}
try {
for(const source of ['local','desktop'])for(const mode of ['light','dark']){
 test(`${source}/${mode}: real grid and list DOM retain identities and scoped depth`,()=>{
  const grid=fixture(render({...props,source})+menu,mode);
  assert.equal(grid.q('.st-media-tile').dataset.assetId,'asset-a');
  assert.equal(grid.style('.st-media-art').borderRadius,'13px');
  assert.match(grid.style('.st-media-art').boxShadow,/st-library-shadow/);
  assert.match(grid.style('.st-library-view').getPropertyValue('--st-library-shadow'),mode==='dark'?/rgba\(0,0,0,.20\)/:/rgba\(29,32,44,.065\)/);
  assert.equal(grid.style('.st-option').boxShadow,'none');
  assert.equal(grid.style('.st-option').marginBottom,'0px');
  assert.match(grid.q('.st-media-tile').getAttribute('aria-label'),/图片 · 1 MB/);
  assert.equal(grid.q('.st-media-tile>strong'),null,'art-only grid density stays unchanged');
  assert.equal(grid.style('.st-option').minHeight,'48px');
  assert.equal(grid.style('.st-option>span').overflowWrap,'anywhere');
  const list=fixture(render({...props,source,list:true,selectedIds:['asset-a'],selecting:true}),mode);
  assert.ok(list.q('.st-library-list-row.is-selected[data-asset-id="asset-a"]'));
  assert.equal(list.style('.st-library-list-row>.st-row').minHeight,'68px');
  assert.equal(list.style('.st-library-list-row').borderRadius,'14px');
  grid.dom.window.close();list.dom.window.close();
 });
}
test('nested multi-library picker shares the menu treatment',()=>{
 const f=fixture(`<div class="st-view st-library-view"><div class="st-library-choice">${menu}</div></div>`);
 assert.equal(f.style('.st-option').minHeight,'48px');
 assert.equal(f.style('.st-option').borderRadius,'12px');f.dom.window.close();
});
test('knowledge rows: DOM selection, reserved lane, title/preview/time hierarchy',()=>{
 const rowProps={title:'中文标题'.repeat(20),body:'预览正文'.repeat(25),meta:'2026年10月24日',noteId:'note-1',onClick:noop,onLongPress:noop};
 const plain=fixture(`<div class="st-view st-knowledge-view">${note(rowProps)}</div>`);
 const selected=fixture(`<div class="st-view st-knowledge-view">${note({...rowProps,selecting:true,selected:true})}</div>`);
 assert.equal(selected.q('.st-note-row').getAttribute('aria-pressed'),'true');
 assert.equal(plain.style('.st-note-row').paddingRight,selected.style('.st-note-row').paddingRight);
 assert.equal(plain.style('.st-note-row').borderRadius,'14px');
 assert.equal(plain.style('.st-note-row strong').fontWeight,'600');
 assert.equal(plain.style('.st-note-row small').fontSize,'11px');
 assert.equal(plain.style('.st-note-row strong').textOverflow,'ellipsis');
 plain.dom.window.close();selected.dom.window.close();
});
test('local note has one shared card with a 44px separate overflow target',()=>{
 const f=fixture(`<div class="st-view st-knowledge-view"><div class="st-local-note-entry">${note({title:'本机',body:'正文',meta:'时间',noteId:'n',onClick:noop})}<button class="st-icon-button">操作</button></div></div>`);
 assert.equal(f.style('.st-local-note-entry').borderRadius,'14px');
 assert.equal(f.style('.st-local-note-entry .st-note-row').boxShadow,'none');
 assert.equal(f.style('.st-local-note-entry>.st-icon-button').minWidth,'44px');
 assert.equal(f.style('.st-local-note-entry>.st-icon-button').minHeight,'44px');
 f.dom.window.close();
});
test('retained library cannot theme settings, LSH, reader or Inbox siblings',()=>{
 const f=fixture(`<div hidden>${render(props)}${menu}</div><div class="st-crossfade">${inbox()}${menu}</div><div class="st-page"><div class="st-note-surface">${note({title:'reader result',body:'body',meta:'time',noteId:'n',onClick:noop})}</div>${menu}</div>`);
 assert.equal(f.style('.st-crossfade .st-option').minHeight,'49px');
 assert.equal(f.style('.st-page .st-option').minHeight,'49px');
 assert.notEqual(f.style('.st-note-surface .st-note-row').borderRadius,'14px');
 f.dom.window.close();
});
}finally{rmSync(temp,{recursive:true,force:true})}
