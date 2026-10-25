// Real React DOM/controls with mocked native/navigation boundaries. No browser
// launch and no pixel claims: jsdom does not lay out 320px or Android font scales.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const toolRequire = process.env.LR_DOM_TEST_TOOLS ? createRequire(join(resolve(process.env.LR_DOM_TEST_TOOLS), '__harness__.cjs')) : require;
const { JSDOM } = toolRequire('jsdom');
const { build, stop } = createRequire(require.resolve('vite/package.json'))('esbuild');

test('settings children render grouped production controls, preserve gates and theme states', async () => {
  const dom = new JSDOM('<div class="st-app" data-mode="light" data-reduced="true"><div id="root"></div></div>', {url:'https://test.invalid/', pretendToBeVisual:true});
  const keys = ['window','document','navigator','HTMLElement','Element','Node','Event','MouseEvent','KeyboardEvent','CustomEvent','MutationObserver','localStorage','requestAnimationFrame','cancelAnimationFrame','IS_REACT_ACT_ENVIRONMENT'];
  const old = new Map(keys.map(k => [k,Object.getOwnPropertyDescriptor(globalThis,k)]));
  for (const key of keys.slice(0,12)) Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:dom.window[key]});
  globalThis.requestAnimationFrame=dom.window.requestAnimationFrame.bind(dom.window);
  globalThis.cancelAnimationFrame=dom.window.cancelAnimationFrame.bind(dom.window);
  globalThis.IS_REACT_ACT_ENVIRONMENT=true;
  dom.window.matchMedia=()=>({matches:true,addEventListener(){},removeEventListener(){}});
  const channels=[], OriginalMessageChannel=globalThis.MessageChannel;
  globalThis.MessageChannel=class extends OriginalMessageChannel { constructor(){super();channels.push(this);} };
  const dir=mkdtempSync(join(tmpdir(),'lr-settings-dom-'));
  let app, act;
  const calls=[];
  globalThis.__settingsApi=new Proxy({}, {get:(_,name)=>async(...args)=>{
    calls.push([name,...args]);
    if(name==='companionStorageStats')return {inbox:{count:2,bytes:1024},assetOriginals:{count:3,bytes:2048},thumbs:{count:4,bytes:4096},outbox:{count:0,bytes:0}};
    if(name==='localNoteStats'||name==='localInboxStats')return {total:2};
    if(name==='contentCacheLibraries')return [{instanceId:'desktop-a',vaultId:'vault-a',name:'知识库 A',cachedCount:4,clearableCount:2,protectedCount:2}];
    if(name==='dbExportDiagnostics')return '/Downloads/'+ 'long-diagnostic-'.repeat(40)+'.json';
    return {status:'ok',ok:true,freedBytes:512};
  }});
  globalThis.__settingsNav={back:()=>calls.push(['back']),open:p=>calls.push(['open',p]),mode:'light',setMode:m=>calls.push(['mode',m]),reduced:false,setReduced:v=>calls.push(['reduced',v]),registerOverlay:()=>()=>{},conn:{paired:true,ws:{state:'connected'}}};
  globalThis.__settingsSnap={phase:'unpaired',ws:{state:'disconnected'},identity:null};
  try {
    const out=join(dir,'entry.cjs');
    await build({stdin:{contents:`export {act,createElement} from 'react'; export {createRoot} from 'react-dom/client'; export * from './src/still/StillSettings'; export {StillConnect} from './src/still/StillConnect';`,resolveDir:root,loader:'tsx'},outfile:out,bundle:true,platform:'node',format:'cjs',jsx:'automatic',loader:{'.css':'empty'},plugins:[{name:'boundaries',setup(b){
      b.onResolve({filter:/knowledgeSession$/},()=>({path:'session',namespace:'settings-mock'}));
      b.onResolve({filter:/screens\/Inbox$/},()=>({path:'inbox-labels',namespace:'settings-mock'}));
      b.onResolve({filter:/services\/client(?:\.ts)?$/},()=>({path:'api',namespace:'settings-mock'}));
      b.onResolve({filter:/services\/qrScannerAdapter$/},()=>({path:'scanner',namespace:'settings-mock'}));
      b.onResolve({filter:/StillShell$/},()=>({path:'nav',namespace:'settings-mock'}));
      b.onResolve({filter:/services\/syncCoordinator$/},()=>({path:'sync',namespace:'settings-mock'}));
      b.onResolve({filter:/services\/connectionShell$/},()=>({path:'connection',namespace:'settings-mock'}));
      b.onResolve({filter:/^@tauri-apps\/api\/core$/},()=>({path:'core',namespace:'settings-mock'}));
      b.onLoad({filter:/.*/,namespace:'settings-mock'},({path})=>({loader:'js',contents:path==='session'?'export const sessionKnowledge=()=>({previews:{clearScope(){}}});':path==='inbox-labels'?'export const displayTitle=x=>x.title;export const kindLabel=x=>x;':path==='scanner'?'export const QrScannerAdapter={scan:async()=>null,cancel:async()=>{}};':path==='api'?'export const api=globalThis.__settingsApi; export const materialApi=()=>api;':path==='nav'?'export const useStillNav=()=>globalThis.__settingsNav;':path==='sync'?'const state={status:"error",error:"CONTENT_MUTATION_HTTP_400 [NOTE_INPUT_INVALID] kind=rename route=content",pendingOutbox:0,desktopBusyNotes:[]}; export const syncCoordinator={subscribe:()=>()=>{},snapshot:()=>state};':path==='connection'?'export const createConnectionShellController=()=>({snapshot:()=>globalThis.__settingsSnap,subscribe:()=>()=>{},refresh:async()=>{},cancelIfScanning(){},openScan(){},openPaste(){},cancel(){},submitPaste:async()=>{},forget:async()=>{},disconnect:async()=>{},reconnect:async()=>{}});export const shellErrorCopy=e=>e.message;export const wsFailureCopy=e=>String(e);':'export const convertFileSrc=x=>x;export const invoke=async()=>({});'}));
    }}]});
    const m=require(out); act=m.act; app=m.createRoot(document.getElementById('root'));
    const render=async(name,props={})=>{await act(async()=>{app.render(m.createElement(m[name],{key:name+JSON.stringify(props),...props}));});};
    const button=label=>[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===label||b.textContent===label);
    const click=async label=>{const b=button(label);assert.ok(b,`reachable button ${label}`);await act(async()=>b.dispatchEvent(new MouseEvent('click',{bubbles:true})));};
    const close=async()=>{await act(async()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));await act(async()=>new Promise(r=>setTimeout(r,25)));};
    await render('StillPreferences');assert.equal(document.querySelectorAll('.st-settings-group').length,2);assert.equal(document.querySelectorAll('.st-settings-group .st-row').length,4);
    await click('连接诊断');assert.deepEqual(calls.at(-1),['open','diagnostics']);
    for(const mode of ['light','dark']){globalThis.__settingsNav.mode=mode;document.querySelector('.st-app').dataset.mode=mode;await render('StillAppearance',{testMode:mode});assert.equal(document.querySelector('.st-theme-choice[aria-pressed=true]').getAttribute('aria-label'),mode==='light'?'浅色':'深色');assert.ok(document.querySelector('.st-settings-group .st-option'));await click('减少动态效果保留状态变化，减少页面位移');assert.deepEqual(calls.at(-1),['reduced',true]);}
    await render('StillStorage');assert.equal(document.querySelectorAll('.st-settings-group').length,2);assert.equal(document.querySelectorAll('.st-settings-group .st-row').length,6);
    await click('电脑知识库缓存清理手机保存的正文，保留本机笔记与未同步修改');assert.match(document.querySelector('.st-sheet').textContent,/知识库 A/);await close();
    await click('清理预览缓存不删除素材原件或笔记');assert.match(document.querySelector('.st-sheet').textContent,/不删除素材原件、笔记和待同步内容/);await close();
    await click('管理本机数据分别清空不同内容，不合并删除');await click('清空本机笔记');assert.equal(button('清空所选数据').disabled,true);assert.ok(!calls.some(c=>c[0]==='localNoteEraseAll'));await click('我已了解删除范围');assert.equal(button('清空所选数据').disabled,false);await close();assert.ok(!calls.some(c=>c[0]==='localNoteEraseAll'),'acknowledgment alone never erases');
    await render('StillDiagnostics');assert.match(document.querySelector('.st-settings-diagnostics').textContent,/NOTE_INPUT_INVALID/);await click('导出诊断信息');assert.ok(document.querySelector('[role=status]').textContent.length>500);
    await render('StillRecoveryPage');assert.ok(document.querySelector('.st-settings-page .st-empty'));await click('重置本机数据');assert.equal(button('重置本机数据')?.closest('.st-settings-group')!==null,true);assert.equal(document.querySelector('.st-sheet-footer .st-button--danger').disabled,true);await close();
    await render('StillHealthRecovery',{health:null,onRetry(){},onExportDiagnostics(){},onResetLocalData(){}});assert.ok(document.querySelector('.st-settings-page .st-settings-group'));await click('重置本机数据');assert.equal(document.querySelector('.st-sheet-footer .st-button--danger').disabled,true);await close();
    await render('StillConnect');assert.ok(document.querySelector('.st-settings-connect'));await click('其他配对方式');assert.ok(document.querySelector('.st-field textarea'));assert.equal(button('开始配对').disabled,true);
    for(const phase of ['connected','paired_idle','reconnecting']){globalThis.__settingsSnap={phase,identity:{displayName:'Desktop'},ws:{state:phase==='connected'?'connected':'reconnecting'}};await render('StillConnect',{phase});assert.equal(document.querySelectorAll('.st-settings-group .st-row').length,2);await click('忘记此电脑');assert.match(document.querySelector('.st-sheet').textContent,/不会删除手机上的本机笔记/);await close();}
    for (const [phase,mode,expected] of [['scanning_or_paste','scan','正在打开相机'],['scanning_or_paste','paste','粘贴电脑端'],['pairing',null,'正在配对'],['revoked',null,'已忘记此电脑'],['re_pair_required',null,'重新配对'],['error',null,'连接出错']]) {
      globalThis.__settingsSnap={phase,mode,ws:{state:'disconnected'},identity:null,error:phase==='error'?{message:'连接出错',retryable:true}:undefined};
      await render('StillConnect',{phase,mode});assert.match(document.querySelector('.st-settings-connect').textContent,new RegExp(expected));
    }
    const css=readFileSync(join(root,'src/still/settingsPages.css'),'utf8');
    assert.match(css,/@media \(max-width: 360px\)/);assert.match(css,/overflow-wrap: anywhere/);assert.match(css,/white-space: normal/);assert.match(css,/\.st-row-end[\s\S]*?max-width: 46%/);assert.match(css,/repeat\(2, minmax\(0, 1fr\)\)/);assert.match(css,/data-mode=dark/);assert.doesNotMatch(css,/\.st-(?:note-paper|note-editor|collection|media-grid|tab-bar)/);
  } finally {
    if(app)await act(async()=>app.unmount());
    stop();for(const c of channels){c.port1.close();c.port2.close();}globalThis.MessageChannel=OriginalMessageChannel;dom.window.close();for(const[k,v]of old){if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k];}delete globalThis.__settingsApi;delete globalThis.__settingsNav;delete globalThis.__settingsSnap;rmSync(dir,{recursive:true,force:true});
  }
});
