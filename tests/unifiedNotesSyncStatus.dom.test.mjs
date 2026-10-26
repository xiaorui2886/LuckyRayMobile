import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const tools = createRequire(path.join(process.env.LR_TEST_TOOLS || (process.env.LR_DOM_TEST_TOOLS ? path.resolve(process.env.LR_DOM_TEST_TOOLS, '..') : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.test-tools')), '__test.cjs'));
const { JSDOM } = tools('jsdom');
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild');
const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temporary = await mkdtemp(path.join(repo, 'tests/.unified-notes-'));
try {
  await build({ stdin: { contents: `export { UnifiedNotesRoot } from './src/still/kit/UnifiedNotesView'; export {SourceSwitch} from './src/presentation/still01/Still'; export {snapshotManagedImportTarget} from './src/services/managedImportIntents';`, resolveDir: repo, loader: 'tsx' }, outfile: path.join(temporary, 'test.mjs'), bundle: true, format: 'esm', platform: 'node', jsx: 'automatic', loader: { '.css': 'empty' }, plugins: [{ name: 'test-host-seams', setup(b) {
    b.onResolve({ filter: /^(react|react\/jsx-runtime|react-dom|react-dom\/client)$/ }, a => ({ path: pathToFileURL(require.resolve(a.path)).href, external: true }));
    // Canvas has its own real-render/gesture suite; this suite tests authority wiring, not jsdom graphics.
    b.onResolve({ filter: /MobileGraphCanvas$/ }, () => ({ path: 'canvas', namespace: 'fake' }));
    b.onResolve({ filter: /StillShell$/ }, () => ({ path: 'nav', namespace: 'fake' }));
    b.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'native', namespace: 'fake' }));
    b.onLoad({ filter: /.*/, namespace: 'fake' }, a => ({ contents: a.path === 'canvas' ? 'import {forwardRef,useImperativeHandle} from "react"; export const MobileGraphCanvas=forwardRef((props,ref)=>{globalThis.__graphSeed=props.seed;useImperativeHandle(ref,()=>({fit(){},reset(){},zoomBy(){},capture(){return Promise.reject(new Error("not exercised"))}}));return null;});' : a.path === 'nav' ? 'export const useStillNav=()=>({open:(...args)=>globalThis.__opens.push(args),registerOverlay:()=>()=>{}})' : 'export const invoke=(...args)=>globalThis.__invoke(...args);export const convertFileSrc=(v)=>v; export const isTauri=()=>false;', loader: 'js' }));
  } }] });
  const dom = new JSDOM('<!doctype html><div class="st-app" data-reduced="true"><div id="root"></div></div>', { url: 'https://test.invalid' });
  for (const name of ['window','document','HTMLElement','Event','MouseEvent','CustomEvent','KeyboardEvent','HTMLInputElement','HTMLTextAreaElement','localStorage','navigator']) Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
  globalThis.requestAnimationFrame = callback => setTimeout(callback, 0); globalThis.cancelAnimationFrame = clearTimeout;
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.__opens = [];
  const React = await import('react'); const { act } = React; const { createRoot } = await import('react-dom/client');
  const { UnifiedNotesRoot, SourceSwitch, snapshotManagedImportTarget } = await import(pathToFileURL(path.join(temporary, 'test.mjs')).href);

  const calls = [], pending = [], controls = [];
  let mode = 'ready';
  const row = (ready=3) => ({instanceId:'A',vaultId:'remote',confirmed:true,metadataReady:true,total:ready,ready,failed:0,unverified:0,paused:false});
  const deferred = () => { let resolve,reject; const promise=new Promise((a,b)=>{resolve=a;reject=b}); return {promise,resolve,reject}; };
  globalThis.__invoke = async (name,args) => {
    calls.push([name,args]);
    if(name==='managed_vault_list') return {items:[{localVaultId:'local',name:'Saved library',migrationState:'ready',noteCount:1,binding:{instanceId:'A',remoteVaultId:'remote'}}],selectedVaultId:'local'};
    if(name==='managed_vault_migration_status') return {state:'ready'};
    if(name==='managed_vault_note_list') return {items:[{localVaultId:'local',noteId:'n',title:'Saved readable note',content:'Saved body',bodyState:'ready',relativePath:'n.md',folder:'',revision:'r',tags:[],syncState:'local'}],total:1,hasMore:false};
    if(name==='managed_vault_folders') return {paths:[]};
    if(name==='content_library_catalog') return {libraries:[],currentVaultId:null};
    if(name==='content_offline_libraries') { if(mode==='deferred') {const d=deferred();pending.push(d);return d.promise;} if(mode==='failure') throw Error('CURRENT_FAILURE'); return [mode==='paused'?{...row(),paused:true}:row()]; }
    if(name==='content_offline_control') { const d=deferred(); controls.push(d);return d.promise; }
    throw Error('Unexpected native call: '+name);
  };
  const root=createRoot(document.getElementById('root'));
  const conn=(instance,online=false,paired=true)=>({paired,identity:{instanceId:instance},ws:{state:online?'connected':'disconnected'}});
  const render=async c=>act(async()=>{root.render(React.createElement(UnifiedNotesRoot,{conn:c,legacy:()=>null}));});
  const count=()=>calls.filter(([n])=>n==='content_offline_libraries').length;
  const status=()=>document.querySelector('.st-folder-status')?.textContent||'';
  const saved=()=>assert.match(document.body.textContent,/Saved readable note/);
  const changed=()=>act(async()=>{window.dispatchEvent(new Event('luckyray:managed-vault-change'));});
  const settle=(d,value,fail=false)=>act(async()=>{fail?d.reject(Error(value)):d.resolve(value);});
  const click=async text=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent===text);assert.ok(b,text);await act(async()=>b.dispatchEvent(new MouseEvent('click',{bubbles:true})));};
  // Foreign pair online/offline and unpaired never request A, while saved notes stay readable.
  await render(conn('B',true)); saved(); assert.equal(count(),0); assert.match(status(),/原电脑未连接/);
  await render(conn('B')); await changed(); saved(); assert.equal(count(),0);
  await render(conn('A',true,false)); await changed(); saved(); assert.equal(count(),0);
  // The same owner offline may read local coverage. A-offline -> B-offline must detach the listener.
  await render(conn('A')); assert.equal(count(),1); assert.match(status(),/正文已保存 · 3 篇/);
  await render(conn('B')); const before=count(); await changed(); assert.equal(count(),before); assert.doesNotMatch(status(),/3 篇/); saved();
  // Pending successes and failures from old A never replace foreign-pair state.
  mode='deferred'; await render(conn('A')); const oldSuccess=pending.at(-1);
  await render(conn('B')); await settle(oldSuccess,[row(99)]); assert.doesNotMatch(status(),/99/);
  await render(conn('A')); const oldFailure=pending.at(-1);
  await render(conn('B')); await settle(oldFailure,'STALE_FAILURE',true); assert.doesNotMatch(status(),/失败/);
  // ABA starts a new A request. Old A must not leak even though pair text is identical again.
  await render(conn('A')); const firstA=pending.at(-1);
  await render(conn('B')); const beforeABA=count();
  await render(conn('A')); const freshA=pending.at(-1); assert.equal(count(),beforeABA+1); assert.notEqual(firstA,freshA);
  await settle(freshA,[row(7)]); await settle(firstA,[row(88)]); assert.match(status(),/7 篇/); assert.doesNotMatch(status(),/88/);
  // Current errors remain actionable; foreign pairing synchronously removes errors and retry buttons.
  mode='failure'; await changed(); assert.match(status(),/同步进度读取失败/);
  await render(conn('B')); assert.doesNotMatch(status(),/失败|重新读取/);
  // An action started on first A cannot dispatch refreshes or leak error/busy into next A.
  mode='paused'; await render(conn('A',true)); await click('继续下载正文'); const oldAction=controls.at(-1);
  await render(conn('B')); await render(conn('A',true)); const beforeAction=count();
  await settle(oldAction,undefined); assert.equal(count(),beforeAction); assert.doesNotMatch(status(),/正在处理/);
  await click('继续下载正文'); const failedAction=controls.at(-1);
  await render(conn('B')); await render(conn('A',true)); await settle(failedAction,'STALE_ACTION',true);
  assert.equal(document.querySelector('.st-folder-status [role="alert"]'),null); assert.doesNotMatch(status(),/正在处理/);
  await render(null); const beforeUnpaired=count(); await changed(); assert.equal(count(),beforeUnpaired); saved(); assert.match(status(),/原电脑未连接 · 可使用已保存的笔记/);
  await act(async()=>root.unmount()); dom.window.close();
  console.log('PASS VaultSyncStatus real DOM: foreign pair online/offline, same-owner offline, offline pair transition, late success/failure, ABA requests/actions, unpaired saved notes');
} finally { await rm(temporary,{recursive:true,force:true}); }
