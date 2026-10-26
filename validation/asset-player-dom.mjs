// DOM behavior test, not Android video/codec or screenshot evidence.
// Optional test dependencies: jsdom and esbuild. Paths may be supplied by the test environment.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
const require=createRequire(import.meta.url);
const tools=process.env.LR_DOM_TEST_TOOLS?createRequire(path.join(path.resolve(process.env.LR_DOM_TEST_TOOLS),'__harness__.cjs')):require;
const {JSDOM}=process.env.JSDOM_MODULE?await import(process.env.JSDOM_MODULE):tools('jsdom');
const {build}=process.env.ESBUILD_MODULE?await import(process.env.ESBUILD_MODULE):createRequire(require.resolve('vite/package.json'))('esbuild');
const here=path.dirname(fileURLToPath(import.meta.url)),repo=path.dirname(here);
const dir=await mkdtemp(path.join(here,'.asset-player-test-'));
try{
const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://test.invalid/'});
for(const name of ['window','document','HTMLElement','HTMLVideoElement','HTMLMediaElement','Event','MouseEvent'])globalThis[name]=dom.window[name];
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
let plays=0,pauses=0,released=[],overlays=[];
const h=globalThis.__assetTest={source:async()=>({url:'https://test.invalid/video.mp4',token:'lease-1'}),release:async token=>released.push(token),push:close=>{overlays.push(close);return()=>{overlays=overlays.filter(value=>value!==close)}}};
dom.window.HTMLMediaElement.prototype.pause=function(){pauses++;this.dispatchEvent(new Event('pause'))};
dom.window.HTMLMediaElement.prototype.play=async function(){plays++;this.dispatchEvent(new Event('play'))};
dom.window.HTMLMediaElement.prototype.load=function(){};
await build({stdin:{contents:`export {InlineAssetVideo} from ${JSON.stringify(path.join(repo,'src/still/InlineAssetVideo.tsx'))}; export {suppressTrailingSwipeClick} from ${JSON.stringify(path.join(repo,'src/still/kit/useHorizontalSwipe.ts'))};`,resolveDir:repo},outfile:path.join(dir,'player.mjs'),bundle:true,platform:'node',format:'esm',jsx:'automatic',plugins:[{name:'test-seams',setup(b){
 b.onResolve({filter:/^(react|react\/jsx-runtime)$/},a=>({path:pathToFileURL(require.resolve(a.path)).href,external:true}));
 b.onResolve({filter:/services\/client$/},()=>({path:'api',namespace:'mock'}));
 b.onResolve({filter:/PageLayer$/},()=>({path:'page',namespace:'mock'}));
 b.onResolve({filter:/overlayStack$/},()=>({path:'overlay',namespace:'mock'}));
 b.onResolve({filter:/@tauri-apps\/api\/core/},()=>({path:'tauri',namespace:'mock'}));
 b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:a.path==='api'?'export const api={contentMediaSource:()=>globalThis.__assetTest.source(),localAssetMediaSource:()=>globalThis.__assetTest.source(),contentMediaRelease:t=>globalThis.__assetTest.release(t),contentCancel:async()=>{}}':a.path==='page'?'export const usePageCurrent=()=>true':a.path==='overlay'?'export const overlayStack={push:f=>globalThis.__assetTest.push(f)}':'export const invoke=async()=>{throw new Error("Unexpected stream")}'}));
}}]});
const React=await import('react'),{createRoot}=await import('react-dom/client'),{act}=React;
const {InlineAssetVideo,suppressTrailingSwipeClick}=await import(pathToFileURL(path.join(dir,'player.mjs')).href);
const root=createRoot(document.getElementById('root'));
const fullscreen=[];
await act(async()=>{root.render(React.createElement(InlineAssetVideo,{id:'asset-1',owner:'pc-1',onFullscreenChange:v=>fullscreen.push(v)}));});
const video=document.querySelector('video');assert.equal(video.controls,false);assert.equal(video.getAttribute('src'),'https://test.invalid/video.mp4');assert.equal(video.className,'');
Object.defineProperty(video,'duration',{configurable:true,value:120});
await act(async()=>{video.dispatchEvent(new Event('loadedmetadata'));});
assert.equal(video.className,'');
assert.ok(document.querySelector('.st-video-central'),'metadata-only preload must expose a usable play action before canplay');
const click=async selector=>{await act(async()=>document.querySelector(selector).dispatchEvent(new MouseEvent('click',{bubbles:true})))};
await click('.st-video-central');assert.equal(plays,1);
await act(async()=>video.dispatchEvent(new Event('loadeddata')));assert.equal(video.className,'is-ready');assert.ok(document.querySelector('[aria-label="暂停视频"]'));
await act(async()=>{for(let i=0;i<4;i++){video.dispatchEvent(new Event('timeupdate'));await new Promise(resolve=>setTimeout(resolve,750))}});
assert.ok(document.querySelector('.is-controls-hidden'),'time updates must not restart the auto-hide timer');
for(const control of document.querySelectorAll('.st-video-controls button,.st-video-controls input,.st-video-controls select'))assert.equal(control.tabIndex,-1);
await click('video');assert.equal(document.querySelector('.is-controls-hidden'),null);
const fullscreenButton=document.querySelector('[aria-label="全屏播放"]');
fullscreenButton.focus();const matches=fullscreenButton.matches;
fullscreenButton.matches=()=>{throw new dom.window.DOMException('Unsupported selector','SyntaxError')};
await act(async()=>new Promise(resolve=>setTimeout(resolve,2900)));
assert.equal(document.querySelector('.is-controls-hidden'),null,'old WebView selector fallback keeps focused controls usable');
fullscreenButton.matches=matches;fullscreenButton.blur();
await click('[aria-label="静音"]');assert.equal(video.muted,true);
const rate=document.querySelector('select');await act(async()=>{rate.value='1.5';rate.dispatchEvent(new Event('change',{bubbles:true}))});assert.equal(video.playbackRate,1.5);
await click('[aria-label="全屏播放"]');assert.ok(document.querySelector('.is-fullscreen'));assert.equal(overlays.length,1);assert.equal(fullscreen.at(-1),true);
await act(async()=>overlays[0]());assert.equal(overlays.length,0);assert.equal(fullscreen.at(-1),false);
await act(async()=>root.unmount());assert.deepEqual(released,['lease-1']);assert.ok(pauses>0);
// The capture guard lives on Document, so a replaced detail cannot receive
// the click synthesized after its owner's swipe/pointerup navigation.
const old=document.createElement('div');document.body.append(old);
suppressTrailingSwipeClick(document);old.remove();
const image=document.createElement('img');document.body.append(image);let activations=0;
image.addEventListener('click',()=>activations++);
image.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,detail:1}));assert.equal(activations,0);
image.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,detail:0}));assert.equal(activations,1,'keyboard activation remains available');
dom.window.close();delete globalThis.__assetTest;
console.log('PASS: source, hidden loading video, custom controls/auto-hide, play, mute, speed, in-place fullscreen/back, pause/release cleanup, old-WebView focus fallback, trailing swipe click after owner replacement. Native Android media/layout NOTRUN.');
}finally{await rm(dir,{recursive:true,force:true})}
