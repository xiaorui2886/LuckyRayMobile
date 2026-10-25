// Real ReactDOM-mounted library and production row components. This is not
// browser layout, WebView rendering, or Android/device validation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url)),require=createRequire(import.meta.url);
const runtime=process.env.LR_DOM_TEST_TOOLS || process.env.LR_DOM_RUNTIME;
if(!runtime)throw Error('Set LR_DOM_TEST_TOOLS to the existing disposable jsdom runtime.');
const {JSDOM}=createRequire(join(resolve(runtime),'__harness__.cjs'))('jsdom');
const {build,stop}=createRequire(require.resolve('vite/package.json'))('esbuild');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}};
test('mounted material and knowledge A→B→A preserve rows, headers and scroll; revoked cold replies never paint',async()=>{
 const dom=new JSDOM('<div id="host"></div>',{url:'https://test.invalid/',pretendToBeVisual:true});
 const names=['window','document','navigator','HTMLElement','Element','Node','Event','MouseEvent','CustomEvent','MutationObserver','getComputedStyle','localStorage'];
 const saved=new Map(names.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 for(const key of names)Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:dom.window[key]});
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 const dir=mkdtempSync(join(tmpdir(),'lr-scoped-background-'));let app;
 const listeners=new Set(),pending=new Map(),calls=[];
 const catalog={scopeSelectionVersion:1,materials:['A','B','C'].map(libraryId=>({libraryId,displayName:libraryId,available:true,readGranted:true,writeGranted:true})),knowledge:[]};
 let selection={phase:'ready',catalog,material:'A',vault:'',materialsEpoch:1,knowledgeEpoch:0};
 globalThis.__scopedSelection={subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},snapshot:()=>selection};
 const result=(library,title=library)=>({items:[{desktopAssetId:library+'-asset',name:title,kind:'image',revision:'1'}],hasMore:false,page:1});
 globalThis.__scopedApi={localAssetList:async()=>({items:[],total:0,hasMore:false,page:1}),localAssetTags:async()=>({tags:[]}),
  contentAssets:async(_owner,_query,library)=>{calls.push(library);return pending.has(library)?pending.get(library).promise:result(library)},
  assetThumbnail:async(_owner,id)=>({uri:'asset://'+id}),contentMaterialTags:async()=>({tags:[]}),contentMaterialFolders:async()=>({folders:[]})};
 try{
  const out=join(dir,'entry.cjs');
  await build({stdin:{contents:`import React,{useEffect,useSyncExternalStore} from 'react';import {CollectionView} from './src/presentation/still01/Views';import {DirectoryStatusLine} from './src/still/kit/directoryStatusLine';export {act,createElement} from 'react';export {createRoot} from 'react-dom/client';export {StillLibrary} from './src/still/StillLibrary';export {KnowledgeDirectoryController} from './src/still/kit/knowledgeDirectoryController';export {createKnowledgeSession} from './src/still/kit/knowledgeSession';import {DesktopKnowledgeStatus} from './src/still/kit/desktopKnowledgeStatus';export function KnowledgeHarness({session,vault,scrolls}){const controller=session.desktop;const snapshot=useSyncExternalStore(fn=>controller.subscribe(fn),()=>session.desktopViewFor({paired:true,connected:true,instanceId:'desktop',vaultId:vault}));useEffect(()=>{controller.selectVault(vault);controller.setConnection({paired:true,connected:true,instanceId:'desktop',isLive:()=>true});controller.activate()},[controller,vault]);const noop=()=>{};return <CollectionView domain="knowledge" source="desktop" onSource={noop} query="" onQuery={noop} onNew={noop} onBrowse={noop} onRefresh={()=>controller.refresh()} notes={snapshot.rows.map(row=>({id:row.instanceId+'/'+row.vaultId+'/'+row.noteId,title:row.title,body:'',meta:'',source:'desktop',state:'synced',notebook:snapshot.vaultName}))} assets={[]} open={noop} paired connected list={false} onList={noop} filterLabel={snapshot.vaultName} scrollTop={scrolls.get(vault)||0} onScroll={top=>scrolls.set(vault,top)} statusSlot={<DesktopKnowledgeStatus quiet snapshot={snapshot} onConnect={noop}/>}/>};export function DirectoryHarness({controller,scope}){const snapshot=useSyncExternalStore(fn=>controller.subscribe(fn),()=>controller.snapshotFor(scope));const noop=()=>{};return <CollectionView domain="knowledge" source="desktop" onSource={noop} query="" onQuery={noop} onNew={noop} onBrowse={noop} onRefresh={noop} notes={snapshot.rows.map(row=>({id:row.noteId,title:row.title,body:'',meta:'',source:'desktop',state:'synced',notebook:'A'}))} assets={[]} open={noop} paired connected list={false} onList={noop} filterLabel="" statusSlot={<DirectoryStatusLine quiet snapshot={snapshot} onConnect={noop}/>}/>}`,resolveDir:root,loader:'tsx'},outfile:out,bundle:true,platform:'node',format:'cjs',loader:{'.css':'empty'},logLevel:'silent',plugins:[{name:'native-boundary',setup(b){
   b.onResolve({filter:/^react(?:\/|$)|^react-dom(?:\/|$)/},args=>({path:require.resolve(args.path),external:true}));
   b.onResolve({filter:/services\/companionServices\/index\.ts$|services\/client(?:\.ts)?$|\.\/StillShell$|\.\/kit\/DesktopLibraryPicker$|^@tauri-apps\/api\/(core|event)$/},args=>({path:args.path,namespace:'mock'}));
   b.onLoad({filter:/.*/,namespace:'mock'},args=>({loader:'tsx',resolveDir:root,contents:args.path.endsWith('/companionServices/index.ts')?'export const createProductionServices=()=>({registry:{subscribe:()=>()=>{},snapshot:()=>null,operation:()=>({state:"unsupported"})},knowledge:{},changeFeed:{}});':args.path.includes('DesktopLibraryPicker')?`import {useSyncExternalStore} from 'react';export function useDesktopLibraries(){return useSyncExternalStore(globalThis.__scopedSelection.subscribe,globalThis.__scopedSelection.snapshot)}export function DirectoryLibrarySheet({directory}){return directory}`:args.path.endsWith('StillShell')?'export const useStillNav=()=>({open(){},registerOverlay:()=>()=>{}});':args.path.includes('/core')?'export const convertFileSrc=x=>x;export const invoke=async()=>({});':args.path.includes('/event')?'export const listen=async()=>()=>{};export const emit=async()=>{};':'export const api=globalThis.__scopedApi;export const materialApi=()=>globalThis.__scopedApi;'}));
  }}]});
  const {act,createElement:h,createRoot,StillLibrary,KnowledgeDirectoryController,DirectoryHarness,createKnowledgeSession,KnowledgeHarness}=require(out);
  app=createRoot(document.getElementById('host'));
  const conn={paired:true,identity:{instanceId:'desktop'},ws:{state:'connected'}};
  const flush=async()=>act(async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve))});
  await act(async()=>app.render(h(StillLibrary,{conn})));await flush();
  await act(async()=>document.querySelector('.st-source button:last-child').click());await flush();
  const choose=async library=>act(async()=>{selection={...selection,material:library,materialsEpoch:selection.materialsEpoch+1};for(const listener of listeners)listener()});
  assert.equal(document.querySelector('.st-media-tile').dataset.assetId,'A-asset');
  const scroller=document.querySelector('.st-scroll');scroller.scrollTop=640;
  await act(async()=>scroller.dispatchEvent(new Event('scroll',{bubbles:true})));
  const firstGrid=document.querySelector('.st-media-grid');
  await choose('B');await flush();
  assert.equal(document.querySelector('.st-media-tile').dataset.assetId,'B-asset');
  document.querySelector('.st-scroll').scrollTop=90;
  await act(async()=>document.querySelector('.st-scroll').dispatchEvent(new Event('scroll',{bubbles:true})));
  const delayed=deferred();pending.set('A',delayed);
  await choose('A');await flush();
  assert.equal(document.querySelector('.st-media-tile').dataset.assetId,'A-asset');
  assert.strictEqual(document.querySelector('.st-media-grid'),firstGrid,'library switch never replaces the retained grid container');
  assert.equal(document.querySelector('.st-scroll').scrollTop,640,'A restores only A scroll offset');
  assert.equal(document.querySelector('.st-loading-block'),null);
  assert.doesNotMatch(document.querySelector('.st-compact-toolbar').textContent,/正在同步|正在读取/);
  const tile=document.querySelector('.st-media-tile'),grid=document.querySelector('.st-media-grid');
  await act(async()=>delayed.resolve(result('A','A refreshed')));await flush();
  assert.strictEqual(document.querySelector('.st-media-grid'),grid);
  assert.strictEqual(document.querySelector('.st-media-tile'),tile,'same row key keeps the mounted tile across refresh');
  assert.equal(document.querySelector('.st-scroll').scrollTop,640);
  assert.match(tile.getAttribute('aria-label'),/A refreshed/);
  const failing=deferred();pending.set('A',failing);
  await act(async()=>document.querySelector('[aria-label="刷新电脑内容"]').click());await flush();
  await act(async()=>failing.reject(new Error('NETWORK_TIMEOUT')));await flush();
  assert.strictEqual(document.querySelector('.st-media-tile'),tile,'temporary error retains the mounted row');
  assert.equal(document.querySelector('.st-loading-block'),null);
  const cold=deferred();pending.set('C',cold);await choose('C');await flush();
  assert.equal(document.querySelector('.st-media-tile'),null,'A is never shown under cold C');
  assert.ok(document.querySelector('.st-loading-block'),'cold scope reserves honest initial geometry');
  assert.ok(calls.filter(value=>value==='A').length>=2);
  await act(async()=>cold.resolve({items:[],hasMore:false,page:1}));await flush();
  const emptyRefresh=deferred();pending.set('C',emptyRefresh);
  await act(async()=>document.querySelector('[aria-label="刷新电脑内容"]').click());await flush();
  assert.equal(document.querySelector('.st-loading-block'),null,'settled-empty background refresh is not a cold load');
  assert.doesNotMatch(document.querySelector('.st-compact-toolbar').textContent,/正在同步|正在读取/);

  // Real knowledge session + its production CollectionView/status composition.
  // Cached library headers, row keys and scroll survive A→B→A before the
  // delayed canonical read completes. A presence/cache bump is presentation-only.
  const knowledgePending=new Map(),knowledgeCalls=[];
  const registry={refreshAdopting:async()=>({}),operation:()=>({state:'implemented'}),snapshot:()=>null,invalidate(){}};
  const knowledge={vaults:async(_instance,vault)=>({items:[{vaultId:vault,displayName:'Knowledge '+vault,readGranted:true,activeInDesktop:true}]}),
    registeredList:async(_instance,vault)=>{knowledgeCalls.push(vault);return knowledgePending.has(vault)?knowledgePending.get(vault).promise:{items:[{noteId:'note',vaultId:vault,title:'Note '+vault}],hasMore:false}}};
  const session=createKnowledgeSession({registry,knowledge,previewReader:async()=>({key:'',byNoteId:{}})}),scrolls=new Map();
  const showKnowledge=async vault=>{await act(async()=>app.render(h(KnowledgeHarness,{session,vault,scrolls})));await flush()};
  await showKnowledge('A');assert.match(document.querySelector('.st-note-row').textContent,/Note A/);
  const knowledgeScroller=document.querySelector('.st-scroll');knowledgeScroller.scrollTop=420;
  await act(async()=>knowledgeScroller.dispatchEvent(new Event('scroll',{bubbles:true})));
  await showKnowledge('B');assert.match(document.querySelector('.st-note-row').textContent,/Note B/);
  const knowledgeTail=deferred();knowledgePending.set('A',knowledgeTail);await showKnowledge('A');
  assert.strictEqual(document.querySelector('.st-scroll'),knowledgeScroller,'knowledge scroller remains mounted across scoped libraries');
  assert.equal(knowledgeScroller.scrollTop,420);
  assert.match(document.querySelector('.st-note-row').textContent,/Note A/);
  assert.match(document.querySelector('.st-compact-toolbar').textContent,/Knowledge A/);
  assert.equal(document.querySelector('.st-kb-status'),null,'background refresh inserts no loading/status row');
  const knowledgeRow=document.querySelector('.st-note-row'),callsBeforePresence=knowledgeCalls.length;
  session.observeNoteCacheVersion(12);await showKnowledge('A');
  assert.equal(knowledgeCalls.length,callsBeforePresence,'presence/cache event does not trigger foreground re-list');
  assert.strictEqual(document.querySelector('.st-note-row'),knowledgeRow);
  await act(async()=>knowledgeTail.resolve({items:[{noteId:'note',vaultId:'A',title:'Note A updated'}],hasMore:false}));await flush();
  assert.strictEqual(document.querySelector('.st-note-row'),knowledgeRow,'knowledge row identity survives atomic background commit');
  assert.equal(knowledgeScroller.scrollTop,420);
  assert.match(knowledgeRow.textContent,/Note A updated/);
  assert.equal(document.querySelector('.st-kb-status'),null);

  // Cold directory read has no cache entry yet. Its old response still must
  // never be painted after the permission epoch changes during the await.
  let revision=0,notify=()=>{};const protectedRead=deferred();
  const controller=new KnowledgeDirectoryController(()=>protectedRead.promise,{
    scopeRevision:()=>revision,subscribe:callback=>{notify=callback;return()=>{}},
  });
  controller.setOwner({paired:true,connected:true,instanceId:'desktop',writeGranted:true,isLive:()=>true});
  controller.setVault('A');controller.setDirectory('Folder');controller.activate();
  const scope={instanceId:'desktop',vaultId:'A',directory:'Folder',query:''};
  await act(async()=>app.render(h(DirectoryHarness,{controller,scope})));await flush();
  assert.equal(document.querySelector('.st-note-row'),null);
  let leaked=false;const observer=new MutationObserver(()=>{if(document.body.textContent.includes('PROTECTED_LATE_A'))leaked=true});
  observer.observe(document.getElementById('host'),{subtree:true,childList:true,characterData:true});
  await act(async()=>{revision++;notify()});
  await act(async()=>protectedRead.resolve({items:[{noteId:'secret',vaultId:'A',title:'PROTECTED_LATE_A'}],hasMore:false,source:'live'}));await flush();
  observer.disconnect();
  assert.equal(document.querySelector('.st-note-row'),null,'revoked cold A result never mounts a row');
  assert.equal(leaked,false,'no transient protected text was painted');
  assert.equal(controller.snapshot().rows.length,0);
 }finally{
  if(app){const {act}=require(join(dir,'entry.cjs'));await act(async()=>app.unmount())}
  stop();dom.window.close();for(const[key,value]of saved){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key]}
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;delete globalThis.__scopedSelection;delete globalThis.__scopedApi;rmSync(dir,{recursive:true,force:true});
 }
});
