// Actual React StillAgent + embedded controller. No Android/device acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const require=createRequire(import.meta.url);
const {JSDOM}=createRequire(join(resolve(process.env.LR_DOM_TEST_TOOLS),'x.cjs'))('jsdom');
const {build,stop}=createRequire(require.resolve('vite/package.json'))('esbuild');
const ready={opened:true,visible:true,ready:true,canGoBack:false};
test('actual Agent retains one native conversation and gates stale foreground permission',async()=>{
 const dom=new JSDOM('<div class="st-app"><div id="root"></div></div>',{url:'https://test.invalid/',pretendToBeVisual:true});
 let visible='visible';Object.defineProperty(dom.window.document,'visibilityState',{get:()=>visible});
 for(const key of ['window','document','navigator','HTMLElement','Element','Node','MutationObserver'])Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true,writable:true});
 globalThis.getComputedStyle=dom.window.getComputedStyle.bind(dom.window);
 globalThis.ResizeObserver=class{observe(){}disconnect(){}};
 const frames=new Map();let frameId=0;
 globalThis.requestAnimationFrame=fn=>{frames.set(++frameId,fn);return frameId};globalThis.cancelAnimationFrame=id=>frames.delete(id);
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 dom.window.setInterval=globalThis.setInterval.bind(globalThis);dom.window.setTimeout=globalThis.setTimeout.bind(globalThis);
 dom.window.HTMLElement.prototype.getBoundingClientRect=()=>({x:0,y:24,left:0,right:360,top:24,bottom:624,width:360,height:600});
 const recoveryTimers=[];const setTimer=dom.window.setTimeout;dom.window.setTimeout=(fn,ms,...args)=>{if(ms===20000)recoveryTimers.push(fn);return setTimer(fn,ms,...args)};
 const calls=[],bootstraps=[],pending=[];let hold=false,grant=true,fail=false,runtime=true,supports=true;let lifecycle=0,nativeSuspended=false;
 globalThis.__lshHostApi={connHello:async()=>({capabilities:{runs:false,lshRemoteSurface:supports}}),agentRuns:async()=>[],
 lshSurfaceState:async owner=>{if(hold)return new Promise(resolve=>pending.push(resolve));if(fail)throw Error('CONTENT_OFFLINE');return{granted:grant,runtimeAvailable:runtime}},
 lshSurfaceBootstrap:async owner=>{bootstraps.push(owner);return{sessionUrl:'opaque'}},lshSurfaceEmbed:async req=>{calls.push(req);
  if(req.action==='open')nativeSuspended=false;
  if(req.action==='hide')lifecycle++;
  if(req.action==='suspend'&&!nativeSuspended){nativeSuspended=true;lifecycle++;}
  if(req.action==='layout'&&req.lifecycleGeneration===lifecycle)nativeSuspended=false;
  return {...ready,lifecycleGeneration:lifecycle,suspended:nativeSuspended};}};
 const channels=[];const Channel=globalThis.MessageChannel;globalThis.MessageChannel=class extends Channel{constructor(){super();channels.push(this)}};
 const dir=mkdtempSync(join(tmpdir(),'lsh-retention-'));let app,bundle;
 try{
 await build({stdin:{contents:`export {act,createElement} from 'react';export {createRoot} from 'react-dom/client';export {StillAgent} from './src/still/StillAgent';export {retireEmbeddedLsh} from './src/still/kit/EmbeddedLshView';export {overlayStack} from './src/services/overlayStack';`,resolveDir:root,loader:'tsx'},outfile:join(dir,'entry.cjs'),bundle:true,platform:'node',format:'cjs',jsx:'automatic',loader:{'.css':'empty'},plugins:[{name:'boundaries',setup(b){
 b.onResolve({filter:/services\/client$/},()=>({path:'api',namespace:'mock'}));b.onResolve({filter:/StillShell$/},()=>({path:'nav',namespace:'mock'}));
 b.onResolve({filter:/StillImports$|presentation\/still01\/Views$/},()=>({path:'ui',namespace:'mock'}));
 b.onLoad({filter:/.*/,namespace:'mock'},({path})=>({contents:path==='api'?'export const api=globalThis.__lshHostApi;':path==='nav'?'export const useStillNav=()=>globalThis.__lshHostNav;':`import {createElement as h} from 'react';const C=({children,title,body})=>h('div',null,title,body,children);export const AgentView=C,Header=C,IconButton=C,Button=C,Sheet=C,Empty=C,Icon=C;`,resolveDir:root,loader:'js'}));
 }}]});
 bundle=require(join(dir,'entry.cjs'));const{act,createElement:h,createRoot,StillAgent,retireEmbeddedLsh,overlayStack}=bundle;
 globalThis.__lshHostNav={mode:'light',open(){},back(){},registerOverlay:owner=>overlayStack.push(owner)};
 app=createRoot(document.getElementById('root'));
 const conn=(state='connected',owner='A')=>({paired:true,identity:{instanceId:owner},ws:{state}});
 const settle=async()=>{for(let i=0;i<60;i++)await Promise.resolve()};
 const flush=async()=>act(async()=>{await settle();for(const fn of [...frames.values()])fn();frames.clear();await settle()});
 const render=async(active=true,c=conn())=>{await act(async()=>{app.render(h(StillAgent,{active,conn:c}));await settle()});await flush()};
 const foreground=async value=>{visible=value;await act(async()=>{document.dispatchEvent(new window.Event('visibilitychange'));await settle()});await flush()};
 await render();assert.equal(bootstraps.length,1);assert.equal(document.querySelector('[data-lsh-phase]')?.dataset.lshPhase,'ready');
 const host=document.querySelector('[data-lsh-phase]');
 await render(false);hold=true;await render();assert.equal(document.querySelector('[data-lsh-phase]'),host);assert.equal(host.dataset.lshSuspended,'true');assert.doesNotMatch(document.body.textContent,/手机任务控制尚未|正在恢复电脑连接/);hold=false;await act(async()=>{pending.shift()({granted:true,runtimeAvailable:true});await settle()});await flush();assert.equal(bootstraps.length,1,'tab return does not bootstrap');assert.equal(calls.filter(x=>x.action==='close').length,0,'initial controller unpaired must not destroy native');
 await foreground('hidden');hold=true;await foreground('visible');assert.ok(pending.length);assert.equal(document.querySelector('[data-lsh-phase]'),host,'pending permission retains same host');assert.equal(host.dataset.lshSuspended,'true');assert.ok(calls.some(x=>x.action==='suspend'));
 const beforeTap=calls.length;
 host.dispatchEvent(new window.Event('pointerdown',{bubbles:true}));host.dispatchEvent(new window.Event('pointerup',{bubbles:true}));host.click();
 await flush();assert.equal(calls.length,beforeTap,'pending host tap does not bootstrap, navigate or retry');assert.equal(host.dataset.lshSuspended,'true');
 await foreground('hidden');await foreground('visible');assert.equal(pending.length,2);
 await act(async()=>{pending.shift()({granted:true,runtimeAvailable:true});await settle()});await flush();assert.equal(document.querySelector('[data-lsh-phase]'),host,'old grant cannot replace host');assert.equal(host.dataset.lshSuspended,'true','old foreground grant cannot enable input');
 hold=false;await act(async()=>{pending.shift()({granted:true,runtimeAvailable:true});await settle()});await flush();assert.equal(bootstraps.length,1);assert.equal(document.querySelector('[data-lsh-phase]')?.dataset.lshPhase,'ready');
 // A second native pause can win after permission captured its ticket.
 await foreground('hidden');hold=true;await foreground('visible');lifecycle++;
 await act(async()=>{pending.shift()({granted:true,runtimeAvailable:true});await settle()});await flush();await flush();
 assert.equal(host.dataset.lshSuspended,'true','stale ticket must trigger a new permission probe, not interactive ready');
 assert.equal(pending.length,1);hold=false;
 await act(async()=>{pending.shift()({granted:true,runtimeAvailable:true});await settle()});await flush();
 assert.equal(nativeSuspended,false);assert.equal(host.dataset.lshSuspended,undefined);assert.equal(bootstraps.length,1,'stale ticket recovery retains the same session');
 fail=true;await foreground('hidden');await foreground('visible');assert.equal(calls.filter(x=>x.action==='close').length,0,'transport unknown hides without treating as revoke');assert.equal(document.querySelector('[data-lsh-phase]'),null);
 fail=false;grant=false;await foreground('hidden');await foreground('visible');assert.equal(calls.filter(x=>x.action==='close').length,1,'explicit grant false retires');
 grant=true;await foreground('hidden');await foreground('visible');assert.equal(bootstraps.length,2);
 const beforeReconnect=document.querySelector('[data-lsh-phase]');await render(true,conn('reconnecting'));assert.equal(document.querySelector('[data-lsh-phase]'),beforeReconnect);assert.equal(beforeReconnect.dataset.lshSuspended,'true');assert.doesNotMatch(document.body.textContent,/手机任务控制尚未|正在恢复电脑连接/);await act(async()=>{recoveryTimers.at(-1)();await settle()});await flush();assert.equal(document.querySelector('[data-lsh-phase]'),null,'bounded recovery exposes real offline UI');assert.match(document.body.textContent,/正在恢复电脑连接/);assert.equal(calls.filter(x=>x.action==='close').length,1,'recovering transport does not destroy');await render();assert.equal(bootstraps.length,2);
 await render(true,conn('connected','B'));assert.equal(calls.filter(x=>x.action==='close').length,2);assert.equal(bootstraps.at(-1),'B');
 await render(true,conn('stopped','B'));assert.equal(calls.filter(x=>x.action==='close').length,3,'manual stop retires');
 await render();runtime=false;await foreground('hidden');await foreground('visible');assert.equal(document.querySelector('[data-lsh-phase]'),null,'explicit runtime unavailable is never retained');assert.equal(calls.filter(x=>x.action==='close').length,4);
 runtime=true;await foreground('hidden');await foreground('visible');await render(true,conn('re_pair_required'));assert.equal(document.querySelector('[data-lsh-phase]'),null,'re-pair-required clears retained host');assert.equal(calls.filter(x=>x.action==='close').length,5);
 await render();supports=false;await render(true,conn('reconnecting'));await render();assert.equal(document.querySelector('[data-lsh-phase]'),null,'explicit capability loss cannot borrow cached capability');assert.equal(calls.filter(x=>x.action==='close').length,6);
 await act(async()=>{app.unmount();await retireEmbeddedLsh()});app=null;
 const shell=readFileSync(join(root,'src/still/StillShell.tsx'),'utf8');assert.match(shell,/key="retained-agent"/);assert.match(shell,/active=\{rootTab === "ai" && !top\}/);
 }finally{if(app)app.unmount();await bundle?.retireEmbeddedLsh();dom.window.close();for(const c of channels){c.port1.close();c.port2.close()}globalThis.MessageChannel=Channel;stop();rmSync(dir,{recursive:true,force:true})}
});
