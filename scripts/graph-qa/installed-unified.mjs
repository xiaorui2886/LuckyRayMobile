// Runs ONLY against a brand-new disposable emulator/debug APK. No product code hook.
import { execFileSync, spawn } from 'node:child_process';
import { writeFileSync,readFileSync,existsSync,statSync } from 'node:fs';
import assert from 'node:assert/strict';

import { join } from 'node:path';
import {safeError} from './safe-diagnostics.mjs';
import {seedUnifiedExpression} from './unified-expressions.mjs';
const out = process.env.GRAPH_QA_EVIDENCE;
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.CI_GRAPH_QA_REVIEWED !== 'yes' || process.env.ANDROID_SERIAL !== 'emulator-5554' || !out) throw Error('isolated QA guard');
const phase=process.env.GRAPH_QA_TEST_PHASE||'initial';
if(!['initial','resume','sync','disconnected'].includes(phase))throw Error('unknown isolated test phase');
const phaseFile=join(out,'functional-reopen-baseline.json');
if(phase!=='initial'&&!existsSync(phaseFile))throw Error('No completed synthetic functional baseline; resume cannot seed');
const coverage=phase!=='initial'?JSON.parse(readFileSync(join(out,'coverage.json'),'utf8')):{nativeCreate:'NOT_RUN',sameNameIdentity:'NOT_RUN',graphSwitch:'NOT_RUN',settingsLayout:'NOT_RUN',cancelFeedback:'NOT_RUN',processDeath:'NOT_RUN',desktopBinding:'NOT_RUN',realDesktopLAN:'NOT_RUN',boundPeerDisconnectedRead:'NOT_RUN'};
const saveCoverage=()=>writeFileSync(join(out,'coverage.json'),JSON.stringify(coverage,null,2));saveCoverage();
const adb = (...args) => execFileSync('adb', ['-s', process.env.ANDROID_SERIAL, ...args], {encoding:'utf8',timeout:30000}).trim();
if (!adb('shell','dumpsys','package','com.luckyray.mobile').includes('DEBUGGABLE')) throw Error('debug package required for synthetic native seeding');
const delay = ms => new Promise(r => setTimeout(r, ms));
const startupObservation={pidHistory:[],webviewSocketNames:[]};
const safeDiagnostic=lines=>lines.slice(-80).map(line=>/token|secret|password|authorization|credential|jwt|cookie|bearer|pairing|payload|\bfp\b/i.test(line)?'[credential-related line redacted]':line.slice(0,1000));
const componentIdentity=line=>({field:line.match(/mResumedActivity|topResumedActivity|ResumedActivity|mFocusedApp|mCurrentFocus/)?.[0]||'unknown',components:line.match(/[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+/g)||[]});
function startupFailure(reason) {
 let raw='';
 try { raw=adb('logcat','-b','crash','-d','-t','200'); } catch { /* bounded diagnostic best effort */ }
 const lines=raw.split('\n'),pids=new Set();
 for(const line of lines)if(line.includes('com.luckyray.mobile')){const m=line.match(/^\S+\s+\S+\s+(\d+)\s+\d+\s/);if(m)pids.add(m[1]);}
 const selected=lines.filter(line=>line.includes('com.luckyray.mobile')||[...pids].some(pid=>new RegExp('^\\S+\\s+\\S+\\s+'+pid+'\\s+').test(line))).slice(-60).map(line=>/token|secret|password|authorization|credential|jwt|cookie|bearer|pairing|payload|\bfp\b/i.test(line)?'[credential-related line redacted]':line.slice(0,1000));
 let activityLines=[],windowLines=[],nativeLines=[];
 try{activityLines=adb('shell','dumpsys','activity','activities').split('\n').filter(l=>/mResumedActivity|topResumedActivity|ResumedActivity|mFocusedApp/.test(l)).slice(-12).map(componentIdentity);}catch{/* bounded */}
 try{windowLines=adb('shell','dumpsys','window','windows').split('\n').filter(l=>/mCurrentFocus|mFocusedApp/.test(l)).slice(-12).map(componentIdentity);}catch{/* bounded */}
 const lastPid=[...startupObservation.pidHistory].reverse().find(p=>/^\d+$/.test(p.pid))?.pid;
 if(lastPid)try{nativeLines=safeDiagnostic(adb('logcat','-d','-t','200','--pid='+lastPid).split('\n'));}catch{/* bounded package PID only */}
 const evidence={reason,package:'com.luckyray.mobile',...startupObservation,activityLines,windowLines,nativeLines,crashLines:selected,scope:'isolated synthetic AVD; package PID native logs and allowlisted Activity/window fields only'};
 writeFileSync(join(out,'app-startup-failure.json'),JSON.stringify(evidence,null,2));
 console.log('GRAPH_QA_APP_STARTUP_FAILURE '+JSON.stringify(evidence));
 try{const png=execFileSync('adb',['-s',process.env.ANDROID_SERIAL,'exec-out','screencap','-p'],{timeout:15000,maxBuffer:4*1024*1024});writeFileSync(join(out,'app-startup-failure.png'),png);if(png.length<225000)console.log('GRAPH_QA_PNG_BEGIN app-startup-failure\n'+png.toString('base64')+'\nGRAPH_QA_PNG_END app-startup-failure');}catch{/* original failure remains */}
 return Error(reason);
}
let socket;
const startupStarted=Date.now(),startupDeadline=startupStarted+180000;
let lastStartupProgress=0;
console.log('GRAPH_QA_PHASE_START_webview_cdp_wait');
while(Date.now()<startupDeadline) {
 let pid='';
 try { pid=adb('shell','pidof','-s','com.luckyray.mobile'); } catch(error) { if(error.status!==1)throw startupFailure('ADB pid lookup failed before app connection'); }
 if(!startupObservation.pidHistory.length||startupObservation.pidHistory.at(-1).pid!==pid){
   if(startupObservation.pidHistory.length<20)startupObservation.pidHistory.push({pid,atMs:Date.now()});
 }
 if(pid){
   const names=adb('shell','cat','/proc/net/unix').split('\n').map(l=>l.split(/\s+/).at(-1)).filter(s=>/^@webview_devtools_remote(?:_[A-Za-z0-9_.-]{1,80})?$/.test(s));
   startupObservation.webviewSocketNames=[...new Set([...startupObservation.webviewSocketNames,...names])].slice(0,20);
   socket=names.find(s=>s===`@webview_devtools_remote_${pid}`);
   if(socket)break;
 }
 if(Date.now()-lastStartupProgress>=15000){
   lastStartupProgress=Date.now();
   console.log('GRAPH_QA_NATIVE_STARTUP_PROGRESS '+JSON.stringify({elapsedMs:Date.now()-startupStarted,pid,webviewSocketNames:startupObservation.webviewSocketNames,limitMs:180000,physicalPerformanceClaim:false}));
 }
 await delay(1000);
}
startupObservation.elapsedMs=Date.now()-startupStarted;
startupObservation.limitMs=180000;
startupObservation.physicalPerformanceClaim=false;
writeFileSync(join(out,phase+'-native-startup-timing.json'),JSON.stringify(startupObservation,null,2));
if(!socket)throw startupFailure('APP_BOOT_FAILED: debug WebView CDP missing within 180 seconds; no seeding and no browser fallback');
console.log('GRAPH_QA_PHASE_PASS_webview_cdp_wait elapsedMs='+startupObservation.elapsedMs+' physicalPerformanceClaim=false');
adb('forward','tcp:9222',`localabstract:${socket.slice(1)}`);
let page,lastTargetSignature='';
startupObservation.targetHistory=[];
while(Date.now()<startupDeadline){
 let targets=[];
 try { const response=await fetch('http://127.0.0.1:9222/json',{signal:AbortSignal.timeout(5000)});if(response.ok)targets=await response.json(); } catch { /* same-package socket may still initialize; original total deadline holds */ }
 const summaries=Array.isArray(targets)?targets.slice(0,12).map(t=>{let url='';try{const u=new URL(t.url);url=u.origin==='null'?u.protocol+u.pathname:u.origin+u.pathname;}catch{url='unavailable';}return {type:String(t.type||'').slice(0,30),url:url.slice(0,300)};}):[];
 const signature=JSON.stringify(summaries);
 if(signature!==lastTargetSignature){lastTargetSignature=signature;const sample={elapsedMs:Date.now()-startupStarted,targets:summaries};if(startupObservation.targetHistory.length<20)startupObservation.targetHistory.push(sample);console.log('GRAPH_QA_PACKAGE_WEBVIEW_TARGETS '+JSON.stringify(sample));}
 page=Array.isArray(targets)?targets.find(t=>t.type==='page' && /^(https?:\/\/tauri\.localhost(?:[/:]|$)|tauri:\/\/)/.test(t.url)):undefined;
 if(page)break;
 await delay(500);
}
startupObservation.elapsedMs=Date.now()-startupStarted;
writeFileSync(join(out,phase+'-native-startup-timing.json'),JSON.stringify(startupObservation,null,2));
if(!page) throw startupFailure('APP_BOOT_FAILED: packaged app WebView page missing within original 180-second startup window');
const ws=new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});
let id=0; const pending=new Map(); const results=phase!=='initial'?JSON.parse(readFileSync(join(out,'checks.json'),'utf8')).results:[]; const unexpectedOrigins=new Set(); const runtimeErrors=[];
function captureRuntimeError(kind, raw) {
 const text=safeError(raw);
 if(runtimeErrors.length<30)runtimeErrors.push({kind,text});
 writeFileSync(join(out,phase+'-webview-runtime-errors.json'),JSON.stringify(runtimeErrors,null,2));
}
ws.addEventListener('message',e=>{const m=JSON.parse(e.data);
 if(m.method==='Runtime.exceptionThrown')captureRuntimeError('uncaught',m.params.exceptionDetails?.exception?.description||m.params.exceptionDetails?.text);
 if(m.method==='Log.entryAdded'&&m.params.entry?.level==='error')captureRuntimeError('log-error',m.params.entry.text);
 if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error')captureRuntimeError('console-error',m.params.args.map(a=>a.description||a.value||'').join(' '));if(m.method==='Network.requestWillBeSent'){try{const u=new URL(m.params.request.url);if(/^https?:$/.test(u.protocol)&&!['tauri.localhost','ipc.localhost','127.0.0.1'].includes(u.hostname))unexpectedOrigins.add(u.origin);}catch{}}if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});
let controlChannelFailed=false;
function send(method,params={},timeoutMs=30000) {return new Promise((resolve,reject)=>{const key=++id; const timer=setTimeout(()=>{pending.delete(key);if(method!=='Runtime.evaluate')controlChannelFailed=true;reject(Error(`CDP timeout: ${method}`));},timeoutMs);pending.set(key,{resolve,reject,timer});ws.send(JSON.stringify({id:key,method,params}));});}
async function evaluate(expression,timeoutMs=30000) {const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},timeoutMs);if(r.exceptionDetails)throw Error('WebView evaluation failed: '+safeError(r.exceptionDetails.exception?.description||r.exceptionDetails.text));return r.result.value;}
async function check(name, fn) {const started=Date.now();console.log('GRAPH_QA_CHECK_START '+name);await fn();console.log('GRAPH_QA_CHECK_PASS '+name+' elapsedMs='+(Date.now()-started));results.push({name,status:'passed',elapsedMs:Date.now()-started});writeFileSync(join(out,'checks.json'),JSON.stringify({source:process.env.GITHUB_SHA,emulationMode:process.env.GRAPH_EMULATION_MODE,results,limitations:['Not physical Xiaomi hardware','Runtime WebView version recorded separately','Touches injected via CDP into real WebView, not physical touchscreen instrumentation','Synthetic peer coverage recorded separately; real desktop LAN not covered','No exact WebView83 claim','No physical ARM64 or MIUI coverage','No full5000-note load or native profiler trace','20 notes per vault; no performance claim']},null,2));}
async function poll(expr,timeout=30000) {const deadline=Date.now()+timeout;do{if(await evaluate(expr))return;await delay(250);}while(Date.now()<deadline);throw Error('UI condition deadline');}
async function clickSelector(selector) {
 const rect=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
 if(!rect)throw Error(`UI target missing: ${selector}`);
 await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...rect,id:1,radiusX:2,radiusY:2}]});
 await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 await delay(150);
}
async function clickText(text) {
 const value=JSON.stringify(text);
 const selector=await evaluate(`(()=>{const es=Array.from(document.querySelectorAll('button,[role="button"]'));const index=es.findIndex(e=>(e.textContent.trim()===${value}||e.getAttribute('aria-label')===${value})&&e.getBoundingClientRect().width>0);return index<0?null:index;})()`);
 if(selector===null)throw Error(`UI target missing: ${text}`);
 const rect=await evaluate(`(()=>{const e=document.querySelectorAll('button,[role="button"]')[${selector}];e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
 await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...rect,id:1,radiusX:2,radiusY:2}]});
 await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 await delay(150);
}
const sessionExpression = `(()=>{const id=document.querySelector('[aria-label="图谱知识库"]')?.value;const s=JSON.parse(localStorage.getItem('luckyray.mobile.graph.v1:'+id)||'null');return s?.tabs.find(t=>t.id===s.activeId);})()`;
async function screenshot(name,logProof=false) {const metrics=await send('Page.getLayoutMetrics'); const s=metrics.cssVisualViewport||metrics.visualViewport;const shot=await send('Page.captureScreenshot',{format:'png',clip:{x:0,y:0,width:s.clientWidth,height:s.clientHeight,scale:1}});writeFileSync(join(out,`${name}.png`),Buffer.from(shot.data,'base64'));if(logProof){const proof=shot.data.length<=300000?shot:await send('Page.captureScreenshot',{format:'png',clip:{x:0,y:0,width:s.clientWidth,height:s.clientHeight,scale:0.5}});if(proof.data.length<=300000)console.log(`GRAPH_QA_PNG_BEGIN ${name}\n${proof.data}\nGRAPH_QA_PNG_END ${name}`);}}
async function adbTapKnowledge(){
 await assertSystemHealthy('before-adb-navigation');
 adb('shell','uiautomator','dump','--compressed','/data/local/tmp/graph-qa-window.xml');
 const xml=adb('exec-out','cat','/data/local/tmp/graph-qa-window.xml');
 const bounds=JSON.parse(execFileSync('python3',['-c',`import sys,json,xml.etree.ElementTree as E,re
r=E.fromstring(sys.stdin.read());n=next((n for n in r.iter('node') if n.get('class')=='android.webkit.WebView' and n.get('package')=='com.luckyray.mobile'),None)
if n is None:raise SystemExit('No package WebView UI bounds')
v=list(map(int,re.findall(r'\\d+',n.get('bounds',''))));assert len(v)==4;print(json.dumps(v))`],{input:xml,encoding:'utf8',timeout:5000}));
 const point=await evaluate(`(()=>{const e=document.querySelector('nav[aria-label="主要导航"] button[aria-label="知识"]');const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:innerWidth,h:innerHeight};})()`);
 const x=Math.round(bounds[0]+point.x*(bounds[2]-bounds[0])/point.w),y=Math.round(bounds[1]+point.y*(bounds[3]-bounds[1])/point.h);
 assert.ok(x>bounds[0]&&x<bounds[2]&&y>bounds[1]&&y<bounds[3]);
 adb('shell','input','tap',String(x),String(y));
 await poll(`document.querySelector('nav[aria-label="主要导航"] button[aria-label="知识"]')?.getAttribute('aria-current')==='page'`,15000);
 recordNative('adb-real-navigation',{action:'Android input tap',bounds,derivedScreenPoint:{x,y},confirmed:'knowledge nav aria-current page'});
}
function recordNative(name,value){if(!/^[a-z0-9-]+$/.test(name))throw Error('invalid evidence name');writeFileSync(join(out,name+'.json'),JSON.stringify(value,null,2));}
function nativeScreenshot(name){
 const png=execFileSync('adb',['-s','emulator-5554','exec-out','screencap','-p'],{timeout:15000,maxBuffer:8*1024*1024});
 assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
 writeFileSync(join(out,'android-fullscreen-'+name+'.png'),png);
 if(png.length<225000)console.log('GRAPH_QA_PNG_BEGIN android-'+name+'\n'+png.toString('base64')+'\nGRAPH_QA_PNG_END android-'+name);
}
async function assertSystemHealthy(name){
 try{console.log(execFileSync('python3',['scripts/graph-qa/system-ui-gate.py',name],{encoding:'utf8',timeout:50000,stdio:['ignore','pipe','pipe']}).trim());}
 catch(error){try{nativeScreenshot('system-blocked-'+name);}catch{}try{console.log(execFileSync('python3',['scripts/graph-qa/app-anr-evidence.py',name],{encoding:'utf8',timeout:45000,maxBuffer:256*1024}).trim());}catch{}throw Error('ANDROID_UI_BLOCKED_OR_UNOBSERVABLE: '+name+'; inspect app versus system ANR evidence; no automatic infrastructure attribution');}
}
let recorder,recorderClosed,recordingError=null;
function startRecording(){
 if(phase!=='initial')return;
 recorder=spawn('adb',['-s','emulator-5554','shell','screenrecord','--time-limit','180','--bit-rate','1000000','/data/local/tmp/unified-qa.mp4'],{stdio:'ignore'});
 recorderClosed=new Promise(resolve=>{recorder.once('close',resolve);recorder.once('error',e=>{recordingError=safeError(e);resolve(null);});});
}
async function finishRecording(){
 if(!recorder)return;
 try{
  let pid='';try{pid=adb('shell','pidof','-s','screenrecord');}catch(e){if(e.status!==1)throw e;}
  if(/^\d+$/.test(pid))adb('shell','kill','-2',pid);
  await Promise.race([recorderClosed,delay(10000)]);
  if(recordingError)throw Error(recordingError);
  adb('pull','/data/local/tmp/unified-qa.mp4',join(out,'unified-ui.mp4'));
  const bytes=statSync(join(out,'unified-ui.mp4')).size;assert.ok(bytes>32);
  recordNative('screen-recording',{status:'CAPTURED',bytes,maxSeconds:180,scope:'synthetic initial flow, may end before all checks; screenshots and checks are authoritative'});
 }catch(error){recordNative('screen-recording',{status:'UNAVAILABLE',reason:safeError(error)});}
}
const invokeExpression=(command,args={})=>`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`;
const catalogExpression=invokeExpression('managed_vault_list');
async function inputText(selector,text){await clickSelector(selector);await send('Input.insertText',{text});await poll(`document.querySelector(${JSON.stringify(selector)})?.value===${JSON.stringify(text)}`);}
async function key(key,code,windowsVirtualKeyCode){for(const type of ['keyDown','keyUp'])await send('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode});}
async function chooseGraph(id){
 const selector='[aria-label="图谱知识库"]';
 const options=await evaluate(`Array.from(document.querySelector(${JSON.stringify(selector)}).options).map(o=>o.value)`);
 const index=options.indexOf(id);assert.ok(index>=0,'exact native identity in graph catalog');
 await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
 await key('Home','Home',36);for(let i=0;i<index;i++)await key('ArrowDown','ArrowDown',40);await key('Tab','Tab',9);
 await poll(`document.querySelector(${JSON.stringify(selector)})?.value===${JSON.stringify(id)} && !document.querySelector('.mg-status,.mg-canvas-warning')`,120000);
 await poll(`(${catalogExpression}).then(c=>c.selectedVaultId===${JSON.stringify(id)})`);
}
async function noteIdentity(id){return evaluate(invokeExpression('managed_vault_note_list',{query:{localVaultId:id,page:1,limit:100,sort:'name'}}));}
async function assertNodePrefix(prefix){
 await clickText('更多图谱操作');await clickText('查找图谱节点');
 await poll(`document.querySelectorAll('.mg-node-list button').length===20`);
 const labels=await evaluate(`Array.from(document.querySelectorAll('.mg-node-list button')).map(e=>e.textContent)`);
 assert.ok(labels.every(label=>label.startsWith(prefix+'-')),'no old-vault nodes after selection');
 await screenshot('nodes-'+prefix,true);await clickSelector('.mg-node-list button');
 await poll(`document.querySelector('.mg-selection-head strong')?.textContent.startsWith(${JSON.stringify(prefix+'-')})`);
 await clickText('取消节点选择');
}
async function snapshot(ids){const catalog=await evaluate(catalogExpression);return {selected:catalog.selectedVaultId,items:catalog.items.filter(v=>ids.includes(v.localVaultId)).map(v=>({id:v.localVaultId,name:v.name,binding:v.binding,noteCount:v.noteCount})).sort((a,b)=>a.id.localeCompare(b.id)),notes:await Promise.all(ids.map(async id=>({id,data:await noteIdentity(id)})))};}
try {
 await send('Runtime.enable');await send('Network.enable');await send('Log.enable');
 await check('native-shell-before-fixture',async()=>{await poll(`Boolean(window.__TAURI_INTERNALS__ && document.querySelector('nav[aria-label="主要导航"] button[aria-label="知识"]'))`);await assertSystemHealthy('unified-before-ui');});
 await adbTapKnowledge();startRecording();
 if(phase==='disconnected') {
  await check('bound-vault-readable-after-synthetic-peer-stops',async()=>{
   const before=JSON.parse(readFileSync(join(out,'synthetic-disconnected-baseline.json'),'utf8'));
   await poll(`window.__TAURI_INTERNALS__.invoke('conn_state').then(s=>s.ws.state!=='connected')`,60000);
   assert.deepEqual(await snapshot([before.selected]),before,'stopped peer does not remove or replace local bound vault');
   await clickText('笔记');await poll(`document.body.textContent.includes('Synthetic Desktop Note') && document.body.textContent.includes('Synthetic Added Desktop Note')`);
   await screenshot('synthetic-peer-stopped-notes',true);
   await clickText('图谱');await poll(`document.querySelector('[aria-label="图谱知识库"]')?.value===${JSON.stringify(before.selected)} && Boolean(document.querySelector('.mg-canvas canvas')) && !document.querySelector('.mg-status,.mg-canvas-warning')`,60000);
   await screenshot('synthetic-peer-stopped-graph',true);
   recordNative('synthetic-peer-disconnected-read',{status:'PASS',scope:'own peer process stopped; OS network unchanged',sameVaultId:before.selected,wholeDeviceOffline:false});
  });coverage.boundPeerDisconnectedRead='PASS_SYNTHETIC_PEER_UNAVAILABLE';saveCoverage();
 } else if(phase==='sync') {
  const runtime=process.env.UNIFIED_PEER_RUNTIME;if(!runtime)throw Error('synthetic peer runtime required');
  const ready=JSON.parse(readFileSync(join(runtime,'ready.json'),'utf8'));
  const pairing=JSON.parse(readFileSync(ready.pairingPath,'utf8'));
  const {runSyntheticSync}=await import('../unified-vault-qa/synthetic-sync-check.mjs');
  await runSyntheticSync({config:{...ready,pairing,runtimeDir:runtime},evaluate,invoke:(command,args)=>evaluate(invokeExpression(command,args),120000),poll,clickText,clickSelector,send,screenshot,recordNative,check,adb,delay,assertSystemHealthy});
  coverage.desktopBinding='PASS_SYNTHETIC_PEER';coverage.realDesktopLAN='NOT_RUN';saveCoverage();
  const selected=(await evaluate(catalogExpression)).selectedVaultId;assert.ok(selected);writeFileSync(join(out,'synthetic-disconnected-baseline.json'),JSON.stringify(await snapshot([selected]),null,2));
 } else if(phase==='initial') {
 let first,second;
 await check('fresh-profile-ui-create-vault',async()=>{
  const before=await evaluate(catalogExpression);assert.ok(before.items.every(v=>!v.binding&&v.noteCount===0),'fresh unbound empty catalog only');
  await clickText('添加知识库');await inputText('[aria-label="知识库名称"]','Synthetic Unified');await clickText('创建知识库');
  await poll(`!document.querySelector('[aria-label="知识库名称"]')`);
  const after=await evaluate(catalogExpression);first=after.items.find(v=>v.name==='Synthetic Unified');assert.ok(first?.localVaultId&&first.migrationState==='ready'&&!first.binding);assert.equal(after.selectedVaultId,first.localVaultId);
  await screenshot('unified-created-vault',true);
 });coverage.nativeCreate='PASS';saveCoverage();
 await check('native-same-name-distinct-identity-and-idempotency',async()=>{
  const args={name:'Synthetic Unified',requestId:'qa-unified-second-20261026'};
  second=await evaluate(invokeExpression('managed_vault_create',args));
  const retry=await evaluate(invokeExpression('managed_vault_create',args));assert.equal(retry.localVaultId,second.localVaultId);assert.notEqual(first.localVaultId,second.localVaultId);
  const catalog=await evaluate(catalogExpression);assert.equal(catalog.items.filter(v=>v.name==='Synthetic Unified').length,2,'two actual distinct libraries, no retry duplicates');
  await evaluate(seedUnifiedExpression(first.localVaultId,'Synthetic-A'));await evaluate(seedUnifiedExpression(second.localVaultId,'Synthetic-B'));
 });coverage.sameNameIdentity='PASS';saveCoverage();
 await check('shared-notes-graph-catalog-and-source-switch',async()=>{
  await clickText('图谱');await poll(`Boolean(document.querySelector('[aria-label="图谱知识库"]'))`);
  await chooseGraph(first.localVaultId);await assertNodePrefix('Synthetic-A');
  const ids=await evaluate(`Array.from(document.querySelector('[aria-label="图谱知识库"]').options).filter(o=>o.value).map(o=>o.value)`);
  assert.equal(new Set(ids).size,ids.length,'no duplicate graph entries');assert.ok(ids.includes(first.localVaultId)&&ids.includes(second.localVaultId));
  const display=await evaluate(`Array.from(document.querySelector('[aria-label="图谱知识库"]').options).filter(o=>${JSON.stringify([first.localVaultId,second.localVaultId])}.includes(o.value)).map(o=>o.textContent)`);assert.equal(new Set(display).size,2,'same-name vault labels must remain distinguishable');
  await chooseGraph(second.localVaultId);await assertNodePrefix('Synthetic-B');
  await clickText('笔记');await poll(`document.body.textContent.includes('Synthetic-B-000') && !document.body.textContent.includes('Synthetic-A-000')`);
  await screenshot('unified-notes-selected-second',true);
  await clickText('图谱');await poll(`document.querySelector('[aria-label="图谱知识库"]')?.value===${JSON.stringify(second.localVaultId)}`);
 });coverage.graphSwitch='PASS';saveCoverage();
 await check('settings-leaves-usable-canvas',async()=>{
  await clickText('打开图谱设置');await poll(`Boolean(document.querySelector('.mg-settings'))`);
  const bounds=await evaluate(`(()=>{const p=document.querySelector('.mg-settings').getBoundingClientRect(),c=document.querySelector('.mg-canvas').getBoundingClientRect();return {panel:{x:p.x,y:p.y,width:p.width,height:p.height},canvas:{x:c.x,y:c.y,width:c.width,height:c.height},viewport:{width:innerWidth,height:innerHeight}}})()`);
  assert.ok(bounds.panel.width<=bounds.canvas.width*.82,'settings must not cover whole canvas');assert.ok(bounds.panel.x>=0&&bounds.panel.x+bounds.panel.width<=bounds.viewport.width+1);
  recordNative('unified-settings-bounds',bounds);await screenshot('unified-settings',true);await clickText('关闭图谱设置');
 });coverage.settingsLayout='PASS';saveCoverage();
 await check('cancel-create-does-not-write-or-toast',async()=>{
  const before=await noteIdentity(second.localVaultId);
  await clickText('更多图谱操作');await clickText('新建图谱笔记');await clickText('取消');await poll(`!document.querySelector('[role="dialog"]')`);await delay(800);
  const after=await noteIdentity(second.localVaultId);assert.equal(after.total,before.total);assert.deepEqual(after.items.map(n=>n.noteId),before.items.map(n=>n.noteId));
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('[role="alert"],.st-toast,.toast')).some(e=>e.getBoundingClientRect().width>0)`),false,'cancel emits no alert/toast');
  await screenshot('unified-cancel-clean',true);
 });coverage.cancelFeedback='PASS';saveCoverage();
 const expected=await snapshot([first.localVaultId,second.localVaultId]);writeFileSync(phaseFile,JSON.stringify(expected,null,2));
 } else {
  await check('unpaired-process-death-preserves-vaults-and-selection',async()=>{
   const expected=JSON.parse(readFileSync(phaseFile,'utf8'));const actual=await snapshot(expected.items.map(v=>v.id));
   assert.deepEqual(actual,expected,'real native storage survives process death without reseed');
   await clickText('图谱');await poll(`document.querySelector('[aria-label="图谱知识库"]')?.value===${JSON.stringify(expected.selected)} && !document.querySelector('.mg-status')`,120000);
   await assertNodePrefix('Synthetic-B');await screenshot('unified-unpaired-reopened',true);
  });coverage.processDeath='PASS';saveCoverage();
 }
 await assertSystemHealthy('unified-complete-'+phase);nativeScreenshot('unified-'+phase);
 assert.equal(unexpectedOrigins.size,0,'no unexpected remote WebView request');assert.ok(!runtimeErrors.some(e=>e.kind==='uncaught'),'no uncaught runtime error');
 console.log('UNIFIED_VAULT_PHASE_PASS '+phase+'; see exact coverage.json; realDesktopLAN remains NOT_RUN');
} catch(error) {
 try{nativeScreenshot('failure-'+phase);}catch{}
 try{console.log(execFileSync('python3',['scripts/graph-qa/app-anr-evidence.py','failure-'+phase],{encoding:'utf8',timeout:45000,maxBuffer:256*1024}).trim());}catch{}
 coverage.failure={phase,message:safeError(error),controlChannelFailed};saveCoverage();results.push({name:'failure',status:'failed',message:safeError(error)});writeFileSync(join(out,'checks.json'),JSON.stringify({source:process.env.GITHUB_SHA,results},null,2));throw new Error(safeError(error));
} finally {await finishRecording();ws.close();adb('forward','--remove','tcp:9222');}
