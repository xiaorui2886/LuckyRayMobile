// Runs the production StillAsset and ZoomStage function bodies unchanged with
// local-data/host seams replaced. No browser, network, or real image decoder.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
const require=createRequire(import.meta.url);
const tools=process.env.LR_DOM_TEST_TOOLS?createRequire(path.join(path.resolve(process.env.LR_DOM_TEST_TOOLS),'__harness__.cjs')):require;
const {JSDOM}=process.env.JSDOM_MODULE?await import(process.env.JSDOM_MODULE):tools('jsdom');
const {build}=process.env.ESBUILD_MODULE?await import(process.env.ESBUILD_MODULE):createRequire(require.resolve('vite/package.json'))('esbuild');
const here=path.dirname(fileURLToPath(import.meta.url)),repo=path.dirname(here),dir=await mkdtemp(path.join(here,'.asset-swipe-test-'));
try {
 const source=await readFile(path.join(repo,'src/still/StillAsset.tsx'),'utf8');
 let viewer=source.slice(source.indexOf('export function StillAsset('),source.indexOf('/** A Desktop asset route'));
 if(process.env.REPLAY_PREVIOUS_CAPTURE_BUG==='1')viewer=viewer.replace('event.preventDefault(); go(direction);','event.preventDefault(); event.stopPropagation(); go(direction);');
 const zoom=source.slice(source.indexOf('function ZoomStage('),source.indexOf('// --- 本机素材'));
 const code=`import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
 import {assetSequenceNeighbor,assetSwipeDirection,AssetSequenceSession} from ${JSON.stringify(path.join(repo,'src/still/kit/assetSequence.ts'))};
 import {suppressTrailingSwipeClick} from ${JSON.stringify(path.join(repo,'src/still/kit/useHorizontalSwipe.ts'))};
 const usePageCurrent=()=>true;
 const useStillNav=()=>({open:(...args)=>{globalThis.__swipeOpen++;globalThis.__assetNavigations?.push(args)},back:()=>{},registerOverlay:()=>()=>{}});
 const parseAssetRoute=()=>({kind:'local',assetId:'a'});
 const Icon=()=>null, InlineAssetVideo=()=>null;
 const LocalAsset=()=> <ZoomStage src="https://test.invalid/image.png" alt="test"/>;
 ${viewer}\n${zoom}\nexport {AssetSequenceSession};`;
 await build({stdin:{contents:code,resolveDir:repo,loader:'tsx'},outfile:path.join(dir,'test.mjs'),bundle:true,format:'esm',platform:'node',jsx:'automatic',plugins:[{name:'react-identity',setup(b){b.onResolve({filter:/^(react|react\/jsx-runtime)$/},a=>({path:pathToFileURL(require.resolve(a.path)).href,external:true}));}}]});
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://test.invalid/'});
 for(const name of ['window','document','HTMLElement','Event','MouseEvent','Image'])globalThis[name]=dom.window[name];
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;globalThis.__swipeOpen=0;
 dom.window.HTMLElement.prototype.setPointerCapture=function(){};
 const React=await import('react'),{createRoot}=await import('react-dom/client'),{act}=React;
 const {StillAsset,AssetSequenceSession}=await import(pathToFileURL(path.join(dir,'test.mjs')).href);const root=createRoot(document.getElementById('root'));
 const item={route:'local:a',title:'A',thumbnail:'',kind:'image'};
 await act(async()=>root.render(React.createElement(StillAsset,{id:item.route,preview:{...item,sequence:[item]}})));
 const stage=document.querySelector('.st-asset-area');stage.getBoundingClientRect=()=>({width:300,height:500});
 const pointer=async(type,id,x,y=100,primary=true)=>{const e=new Event(type,{bubbles:true,cancelable:true});Object.assign(e,{pointerId:id,clientX:x,clientY:y,isPrimary:primary,pointerType:'touch',button:0});await act(async()=>stage.dispatchEvent(e));};
 for(const [start,end] of [[120,20],[20,120]]){
  await pointer('pointerdown',1,start);await pointer('pointermove',1,end);await pointer('pointerup',1,end);
  assert.equal(globalThis.__swipeOpen,0,'single-item boundaries must not navigate');
  await pointer('pointerdown',2,30);await pointer('pointermove',2,60);await pointer('pointerup',2,60);
  assert.equal(stage.dataset.mediaZoomed,'false','a retired boundary pointer must not become a fake second finger');
 }
 // Positive control: the same real zoom stage still recognizes two fingers.
 await pointer('pointerdown',3,30);await pointer('pointerdown',4,60,100,false);await pointer('pointermove',4,100,100,false);
 assert.equal(stage.dataset.mediaZoomed,'true');await pointer('pointerup',4,100,100,false);await pointer('pointerup',3,30);

 // A route not present in a short source snapshot must never trigger prefetch.
 let unrelatedCalls=0;
 const unrelated=new AssetSequenceSession([{...item,route:'local:other'}],1,true,async()=>{unrelatedCalls++;return {items:[],hasMore:false}},()=>true);
 await act(async()=>root.render(React.createElement(StillAsset,{id:item.route,preview:{...item,continuation:unrelated}})));
 assert.equal(unrelatedCalls,0,'absent route must not prefetch even for a one-item snapshot');
 // Same actual detail component, now continuing a remote page after the
 // initial array ends. The captured source continuation survives navigation.
 globalThis.__assetNavigations=[];
 let resolvePage;let requests=0;
 const continuation=new AssetSequenceSession([item],1,true,()=>{requests++;return new Promise(resolve=>resolvePage=resolve)},()=>true);
 await act(async()=>root.render(React.createElement(StillAsset,{id:item.route,preview:{...item,sequence:[item],continuation}})));
 assert.equal(requests,1,'near-end preview prefetches next source page');
 const nextControl=document.querySelector('.st-asset-sequence-access button:last-child');assert.equal(nextControl.disabled,false,'continuation keeps next available beyond initial snapshot');
 await act(async()=>{nextControl.dispatchEvent(new MouseEvent('click',{bubbles:true}));});
 assert.equal(requests,1,'gesture joins prefetch instead of issuing a duplicate');
 assert.equal(globalThis.__assetNavigations.length,0,'never navigate before actual next row exists');
 await act(async()=>resolvePage({items:[{...item,route:'local:b',title:'B'}],hasMore:false}));
 assert.equal(globalThis.__assetNavigations.length,1);
 const [page,route,options]=globalThis.__assetNavigations[0];assert.equal(page,'asset');assert.equal(route,'local:b');assert.equal(options.assetPreview.continuation,continuation);
 assert.deepEqual(options.assetPreview.sequence.map(row=>row.route),['local:a','local:b']);
 await act(async()=>root.unmount());
 // Leaving the detail during an awaited continuation must never pull the user back.
 const lateRoot=createRoot(document.getElementById('root'));let resolveLate;
 const late=new AssetSequenceSession([item],1,true,()=>new Promise(resolve=>resolveLate=resolve),()=>true);
 await act(async()=>lateRoot.render(React.createElement(StillAsset,{id:item.route,preview:{...item,sequence:[item],continuation:late}})));
 await act(async()=>document.querySelector('.st-asset-sequence-access button:last-child').dispatchEvent(new MouseEvent('click',{bubbles:true})));
 await act(async()=>lateRoot.unmount());await act(async()=>resolveLate({items:[{...item,route:'local:c'}],hasMore:false}));
 assert.equal(globalThis.__assetNavigations.length,1,'late continuation cannot navigate after leaving');
 dom.window.close();delete globalThis.__swipeOpen;delete globalThis.__assetNavigations;

 console.log('PASS: real detail continuation prefetched and navigation joined one request; resulting route carries same ordered session. Boundary pointer cleanup and real two-finger zoom passed. Android gestures/layout NOTRUN.');
}finally{await rm(dir,{recursive:true,force:true})}
