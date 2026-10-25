// Production React graph host/settings with deterministic local bridge seams.
// This is not device/WebView proof; native Android CI exercises those separately.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { JSDOM } = process.env.LR_DOM_TEST_TOOLS ? createRequire(path.join(process.env.LR_DOM_TEST_TOOLS, '__test.cjs'))('jsdom') : require('jsdom');
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild');
const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url))), dir = await mkdtemp(path.join(repo, 'tests/.graph-ui-'));
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://synthetic.invalid/' });
for (const key of ['window','document','HTMLElement','HTMLInputElement','Event','MouseEvent','KeyboardEvent','localStorage','navigator']) Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.__graphCalls = []; globalThis.__overlay = [];
const node = (id,key,label) => ({id,key,label,type:'note',relativePath:`Synthetic/${label}.md`});
const sourceA = {id:'a',name:'Synthetic A',kind:'managed',readOnly:false}, sourceB = {id:'b',name:'Synthetic B',kind:'managed',readOnly:false};
function snapshot(source) { const nodes = source.id === 'a' ? [node(1,'a1','Synthetic Alpha'),node(2,'a2','Synthetic Beta')] : [node(1,'b1','Synthetic Other')]; return {source,seed:{nodes,edges:source.id==='a'?[[1,2]]:[],source:'real'},notesByKey:new Map(nodes.map(n=>[n.key,{noteId:n.key,title:n.label,tags:[],folder:'Synthetic',openRoute:`managed:${source.id}:${n.key}`} ])),resourcesByKey:new Map(),tagsByKey:new Map(),warnings:[]}; }
globalThis.__graphSources = {sources:[sourceA,sourceB],selectedSourceId:'a'};
globalThis.__load = async source => snapshot(source);
try {
 await build({entryPoints:[path.join(repo,'src/features/graph/MobileGraphView.tsx')],outfile:path.join(dir,'host.mjs'),bundle:true,format:'esm',platform:'node',jsx:'automatic',loader:{'.css':'empty'},plugins:[{name:'local-seams',setup(b){
 b.onResolve({filter:/^(react|react\/jsx-runtime)$/},a=>({path:pathToFileURL(require.resolve(a.path)).href,external:true}));
 b.onResolve({filter:/still\/StillShell$/},()=>({path:'nav',namespace:'seam'}));
 b.onResolve({filter:/services\/mobileGraph$/},()=>({path:'data',namespace:'seam'}));
 b.onResolve({filter:/services\/mobileGraphMutations$/},()=>({path:'mutations',namespace:'seam'}));
 b.onResolve({filter:/MobileGraphCanvas$/},()=>({path:'canvas',namespace:'seam'}));
 b.onResolve({filter:/kit\/Sheet$/},()=>({path:'sheet',namespace:'seam'}));
 b.onLoad({filter:/.*/,namespace:'seam'},a=>({loader:'tsx',contents:a.path==='nav'?`const nav={open:(...args)=>globalThis.__graphCalls.push(['open',...args]),registerOverlay:f=>{globalThis.__overlay.push(f);return ()=>{globalThis.__overlay=globalThis.__overlay.filter(x=>x!==f)}},mode:'light',reduced:false};export const useStillNav=()=>nav;`:a.path==='data'?`export const listMobileGraphSources=async()=>globalThis.__graphSources;export const loadMobileGraphSnapshot=(s)=>globalThis.__load(s);export const subscribeMobileGraphChanges=()=>()=>{};export const createMobileGraphNote=async(...a)=>globalThis.__graphCalls.push(['create',...a]);export const linkMobileGraphNodes=async(...a)=>globalThis.__graphCalls.push(['link',...a]);export const unlinkMobileGraphNodes=async(...a)=>globalThis.__graphCalls.push(['unlink',...a]);export const setMobileGraphNoteTags=async(...a)=>globalThis.__graphCalls.push(['tags',...a]);`:a.path==='mutations'?`export const mobileGraphRelationDisabledReason=()=>null;`:a.path==='sheet'?`export function Sheet({title,children,onClose}){return <section aria-label={title}><button onClick={onClose}>关闭弹层</button>{children}</section>}`:`import {forwardRef,useImperativeHandle} from 'react';export const MobileGraphCanvas=forwardRef((p,r)=>{globalThis.__canvasProps=p;useImperativeHandle(r,()=>({fit:()=>{},zoomBy:()=>{},capture:async()=>new Blob()}));return <canvas aria-label="本地图谱画布"/>});` }));
 }}]});
 const React = await import('react'), {act} = React, {createRoot} = await import('react-dom/client');
 const {default:Graph} = await import(pathToFileURL(path.join(dir,'host.mjs')).href), root = createRoot(document.getElementById('root'));
 const click = async el => { assert.ok(el,'target exists'); await act(async()=>el.dispatchEvent(new MouseEvent('click',{bubbles:true}))); };
 const label = name => document.querySelector(`[aria-label="${name}"]`);
 const textButton = text => [...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text);
 await act(async()=>root.render(React.createElement(Graph,{modeSwitch:React.createElement('span',null,'图谱')})));
 assert.equal(globalThis.__canvasProps.seed.nodes.length,2);
 await click(label('打开图谱设置')); assert.ok(label('图谱设置'));
 for(const [name,value] of [['节点大小','6'],['连线粗细','1'],['文字显示阈值','0.45']]){const field=[...document.querySelectorAll('label')].find(l=>l.textContent.startsWith(name));assert.equal(field.querySelector('input').value,value);}
 const arrows=[...document.querySelectorAll('label')].find(l=>l.textContent==='箭头').querySelector('input'); await click(arrows); assert.equal(globalThis.__canvasProps.settings.showArrows,true);
 await click(label('重置图谱设置')); assert.equal(globalThis.__canvasProps.settings.showArrows,false);
 await click(label('关闭图谱设置')); await click(label('更多图谱操作')); await click(label('新建图谱视图')); assert.equal(document.querySelectorAll('.mg-view-tabs>div').length,2);
 await click(label('更多图谱操作')); await click(label('查找图谱节点')); await click([...document.querySelectorAll('.mg-node-list button')][0]); assert.equal(globalThis.__canvasProps.selectedKey,'a1');
 await click(textButton('局部图谱')); assert.equal(globalThis.__canvasProps.settings.nearbyFilter,true);
 await click(textButton('打开笔记')); assert.deepEqual(globalThis.__graphCalls[0],['open','note','managed:a:a1']);
 await click(textButton('复制提问并打开 LSH')); assert.equal(globalThis.__graphCalls.filter(c=>c[1]==='ai').length,0,'clipboard failure does not navigate');
 Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>globalThis.__copied=text}});
 await click(textButton('复制提问并打开 LSH'));assert.equal(globalThis.__graphCalls.filter(c=>c[1]==='ai').length,1);assert.ok(globalThis.__copied.includes('Synthetic Alpha') && globalThis.__copied.includes('Synthetic Beta'));
 await click(textButton('添加关联')); assert.equal(globalThis.__graphCalls.filter(c=>c[0]==='link').length,0,'opening confirmation is read only');
 const target=document.querySelector('.mg-form select'); await act(async()=>{target.value='a2';target.dispatchEvent(new Event('change',{bubbles:true}));});
 await click(textButton('确认保存')); assert.equal(globalThis.__graphCalls.filter(c=>c[0]==='link').length,1);
 await click(label('打开图谱设置')); const arrowAgain=[...document.querySelectorAll('label')].find(l=>l.textContent==='箭头').querySelector('input'); await click(arrowAgain); await click(label('关闭图谱设置'));
 const picker=label('图谱知识库'); await act(async()=>{picker.value='b';picker.dispatchEvent(new Event('change',{bubbles:true}));});
 const persistedA=JSON.parse(localStorage.getItem('luckyray.mobile.graph.v1:a'));assert.equal(persistedA.tabs.find(t=>t.id===persistedA.activeId).settings.showArrows,true,'immediate vault switch flushes last setting');
 assert.equal(globalThis.__canvasProps.seed.nodes[0].key,'b1');assert.equal(globalThis.__canvasProps.selectedKey,null,'vault state isolated');
 assert.equal(document.querySelectorAll('.mg-view-tabs>div').length,0,'single view strip hidden; views scoped by vault');
 // Deferred previous-vault load must not overwrite the new source.
 let complete;globalThis.__load=s=>s.id==='a'?new Promise(r=>complete=()=>r(snapshot(s))):Promise.resolve(snapshot(s));
 await act(async()=>{picker.value='a';picker.dispatchEvent(new Event('change',{bubbles:true}));});
 await act(async()=>{picker.value='b';picker.dispatchEvent(new Event('change',{bubbles:true}));});
 await act(async()=>complete());assert.equal(globalThis.__canvasProps.seed.nodes[0].key,'b1');
 globalThis.__load=async s=>snapshot(s);const realSet=dom.window.Storage.prototype.setItem;dom.window.Storage.prototype.setItem=()=>{throw Error('quota');};
 await act(async()=>globalThis.__canvasProps.onCameraChange({scale:2,panX:10,panY:20}));
 await act(async()=>{picker.value='a';picker.dispatchEvent(new Event('change',{bubbles:true}));});
 assert.ok(document.body.textContent.includes('笔记不受影响'),'departing source storage failure is visible');dom.window.Storage.prototype.setItem=realSet;
 await act(async()=>root.unmount());assert.equal(globalThis.__overlay.length,0);
 console.log('PASS graph UI: settings defaults/reset, tabs, local scope, accessible node open, confirmed mutations, vault isolation and stale-result cancellation');
} finally { await rm(dir,{recursive:true,force:true}); dom.window.close(); }
