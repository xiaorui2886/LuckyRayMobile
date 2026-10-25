// Runs ONLY against a brand-new disposable emulator/debug APK. No product code hook.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {initializeExpression,seedChunkExpression} from './seed-expressions.mjs';
const out = process.env.GRAPH_QA_EVIDENCE;
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.CI_GRAPH_QA_REVIEWED !== 'yes' || process.env.ANDROID_SERIAL !== 'emulator-5554' || !out) throw Error('isolated QA guard');
const adb = (...args) => execFileSync('adb', ['-s', process.env.ANDROID_SERIAL, ...args], {encoding:'utf8',timeout:30000}).trim();
if (!adb('shell','dumpsys','package','com.luckyray.mobile').includes('DEBUGGABLE')) throw Error('debug package required for synthetic native seeding');
const delay = ms => new Promise(r => setTimeout(r, ms));
const startupObservation={pidHistory:[],webviewSocketNames:[]};
const safeDiagnostic=lines=>lines.slice(-80).map(line=>/token|secret|password|authorization|credential|jwt|cookie/i.test(line)?'[credential-related line redacted]':line.slice(0,1000));
const componentIdentity=line=>({field:line.match(/mResumedActivity|topResumedActivity|ResumedActivity|mFocusedApp|mCurrentFocus/)?.[0]||'unknown',components:line.match(/[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+/g)||[]});
function startupFailure(reason) {
 let raw='';
 try { raw=adb('logcat','-b','crash','-d','-t','200'); } catch { /* bounded diagnostic best effort */ }
 const lines=raw.split('\n'),pids=new Set();
 for(const line of lines)if(line.includes('com.luckyray.mobile')){const m=line.match(/^\S+\s+\S+\s+(\d+)\s+\d+\s/);if(m)pids.add(m[1]);}
 const selected=lines.filter(line=>line.includes('com.luckyray.mobile')||[...pids].some(pid=>new RegExp('^\\S+\\s+\\S+\\s+'+pid+'\\s+').test(line))).slice(-60).map(line=>/token|secret|password|authorization|credential|jwt|cookie/i.test(line)?'[credential-related line redacted]':line.slice(0,1000));
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
writeFileSync(join(out,'native-startup-timing.json'),JSON.stringify(startupObservation,null,2));
if(!socket)throw startupFailure('APP_BOOT_FAILED: debug WebView CDP missing within 180 seconds; no seeding and no browser fallback');
console.log('GRAPH_QA_PHASE_PASS_webview_cdp_wait elapsedMs='+startupObservation.elapsedMs+' physicalPerformanceClaim=false');
adb('forward','tcp:9222',`localabstract:${socket.slice(1)}`);
const targets=await (await fetch('http://127.0.0.1:9222/json')).json();
const page=targets.find(t=>t.type==='page' && /^(https?:\/\/tauri\.localhost(?:[/:]|$)|tauri:\/\/)/.test(t.url));
if(!page) throw startupFailure('APP_BOOT_FAILED: packaged app WebView page missing');
const ws=new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});
let id=0; const pending=new Map(); const results=[]; const unexpectedOrigins=new Set(); const runtimeErrors=[];
function captureRuntimeError(kind, raw) {
 const text=String(raw || '').slice(0,1200).replace(/(?:token|secret|password|authorization|credential|jwt|cookie)\s*[:=]\s*[^\s,;]+/gi,'[redacted]');
 if(runtimeErrors.length<30)runtimeErrors.push({kind,text});
 writeFileSync(join(out,'webview-runtime-errors.json'),JSON.stringify(runtimeErrors,null,2));
}
ws.addEventListener('message',e=>{const m=JSON.parse(e.data);
 if(m.method==='Runtime.exceptionThrown')captureRuntimeError('uncaught',m.params.exceptionDetails?.exception?.description||m.params.exceptionDetails?.text);
 if(m.method==='Log.entryAdded'&&m.params.entry?.level==='error')captureRuntimeError('log-error',m.params.entry.text);
 if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error')captureRuntimeError('console-error',m.params.args.map(a=>a.description||a.value||'').join(' '));if(m.method==='Network.requestWillBeSent'){try{const u=new URL(m.params.request.url);if(/^https?:$/.test(u.protocol)&&!['tauri.localhost','ipc.localhost','127.0.0.1'].includes(u.hostname))unexpectedOrigins.add(u.origin);}catch{}}if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});
function send(method,params={}) {return new Promise((resolve,reject)=>{const key=++id; const timer=setTimeout(()=>{pending.delete(key);reject(Error(`CDP timeout: ${method}`));},600000);pending.set(key,{resolve,reject,timer});ws.send(JSON.stringify({id:key,method,params}));});}
async function evaluate(expression) {const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error('WebView evaluation failed: '+(r.exceptionDetails.exception?.description||r.exceptionDetails.text));return r.result.value;}
async function check(name, fn) {const started=Date.now();console.log('GRAPH_QA_CHECK_START '+name);await fn();console.log('GRAPH_QA_CHECK_PASS '+name+' elapsedMs='+(Date.now()-started));results.push({name,status:'passed',elapsedMs:Date.now()-started});writeFileSync(join(out,'checks.json'),JSON.stringify({source:process.env.GITHUB_SHA,emulationMode:process.env.GRAPH_EMULATION_MODE,results,limitations:['Not physical Xiaomi hardware','Runtime WebView version recorded separately','Pinch injected via CDP into real WebView, not OS-wide multitouch instrumentation','No multi-vault switching yet','No OS process-death persistence test; reload and tab reentry only','No exact WebView83 claim','No physical ARM64 or MIUI coverage','No full5000-note load or native profiler trace']},null,2));}
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
try {
 await send('Runtime.enable');await send('Network.enable');await send('Log.enable');
 await check('native-app-shell-ready-before-seed',async()=>{
   try { await poll(`(()=>{const app=document.querySelector('.st-app');const nav=app?.querySelector('nav[aria-label="主要导航"] button[aria-label="知识"]');const r=nav?.getBoundingClientRect();return Boolean(window.__TAURI_INTERNALS__ && app && r && r.width>0 && r.height>0);})()`,30000); }
   catch { throw Error('APP_BOOT_FAILED: native shell/visible Knowledge navigation not ready within 30s; no synthetic notes seeded'); }
   if(runtimeErrors.some(e=>e.kind==='uncaught'))throw Error('APP_BOOT_FAILED: uncaught runtime exception before seed');
 });
 await check('empty-native-vault-preflight',async()=>{
 const value=await evaluate(initializeExpression());
 if(value.state!=='ready')throw Error('synthetic empty migration not ready');
 });
 await check('native-seed-1000-notes',async()=>{
 const started=Date.now();
 for(let start=0;start<1000;start+=25){
   const count=await evaluate(seedChunkExpression(1000,start,25));
   if(count!==start+25)throw Error('native synthetic chunk count mismatch; no retry');
   console.log('GRAPH_QA_NATIVE_SEED_PROGRESS '+count+'/1000 elapsedMs='+(Date.now()-started));
 }
 writeFileSync(join(out,'native-seed-setup.json'),JSON.stringify({count:1000,chunkSize:25,elapsedMs:Date.now()-started,retries:0}));
 });
 await check('open-graph-real-ui',async()=>{await clickText('知识');await delay(300);await clickText('图谱');await poll(`Boolean(document.querySelector('.mg-canvas canvas')) && !document.querySelector('.mg-status') && !document.querySelector('.mg-notice[role="alert"]') && !document.querySelector('.mg-canvas-warning')`,120000);});
 await delay(800);
 await check('native-worker-no-fallback-warning',async()=>{
   if(await evaluate(`Boolean(document.querySelector('.mg-canvas-warning'))`))throw Error('Native graph worker fallback warning visible');
   if(runtimeErrors.some(e=>e.kind==='uncaught'||/worker|mobileGraph|graphLayout/i.test(e.text)))throw Error('Native graph runtime error; see bounded diagnostic');
 });
 await screenshot('graph-synthetic',true);
 await check('pinch-zoom-real-webview-touch',async()=>{
   await clickText('适应画布');await poll(`(${sessionExpression})?.camera?.scale > 0`);
   const before=await evaluate(sessionExpression);
   const r=await evaluate(`(()=>{const r=document.querySelector('.mg-canvas canvas').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};})()`);
   const points=d=>[{x:r.x+r.w/2-d,y:r.y+r.h/2,id:1,radiusX:2,radiusY:2},{x:r.x+r.w/2+d,y:r.y+r.h/2,id:2,radiusX:2,radiusY:2}];
   await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:points(r.w*.1)});
   for(let i=1;i<=10;i++){await send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:points(r.w*(.1+.01*i))});await delay(25);}
   await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
   await poll(`(${sessionExpression})?.camera?.scale > ${before?.camera?.scale||0} * 1.2`);
 });
 await check('pan-keyboard-accessible-camera',async()=>{
   const before=await evaluate(sessionExpression);
   await evaluate(`document.querySelector('.mg-canvas canvas').focus()`);
   await send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
   await send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
   await poll(`(${sessionExpression})?.camera?.panX !== ${before.camera.panX}`);
 });
 await check('graph-settings-visible',async()=>{await clickText('打开图谱设置');await poll(`Boolean(document.querySelector('[aria-label="图谱设置"]'))`);});
 await screenshot('graph-settings-synthetic',true);
 await check('setting-ui-persistence-reentry',async()=>{
   const changed=await evaluate(`(()=>{const e=Array.from(document.querySelectorAll('.mg-settings label')).find(e=>e.textContent==='标签')?.querySelector('input');return e?e.checked:null;})()`);
   if(changed===null)throw Error('tag setting missing');
   // Derive actual associated input position, without bypassing React/state.
   // The authoritative selector is the semantic label, not its ordinal.
   const tag=await evaluate(`(()=>{const e=Array.from(document.querySelectorAll('.mg-settings label')).find(e=>e.textContent==='标签');if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
   if(!tag)throw Error('tag label missing');
   await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...tag,id:1}]});await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
   await poll(`(${sessionExpression})?.settings.filters.tag === ${!changed}`);
   await clickText('关闭图谱设置');await clickText('笔记');await clickText('图谱');
   await poll(`(${sessionExpression})?.settings.filters.tag === ${!changed}`);
   await send('Page.reload',{ignoreCache:true});await poll(`Boolean(window.__TAURI_INTERNALS__ && document.querySelector('#root')?.children.length)`);await clickText('知识');await clickText('图谱');
   await poll(`(${sessionExpression})?.settings.filters.tag === ${!changed}`);
 });
 await check('background-resume',async()=>{
   adb('shell','input','keyevent','3');await delay(1200);
   const activity=adb('shell','cmd','package','resolve-activity','--brief','com.luckyray.mobile').split('\n').at(-1);
   if(!activity.startsWith('com.luckyray.mobile/'))throw Error('unexpected launch activity');
   adb('shell','am','start','-n',activity);await poll(`!document.hidden && Boolean(document.querySelector('.mg-canvas canvas'))`);
 });
 await check('offline-no-external-web-requests',async()=>{if(unexpectedOrigins.size)throw Error('Unexpected external origin request');});
 await check('canvas-frame-sample',async()=>{
   const sample=await evaluate(`new Promise(resolve=>{const gaps=[];let last=performance.now();function frame(now){gaps.push(now-last);last=now;if(gaps.length<120)requestAnimationFrame(frame);else{gaps.sort((a,b)=>a-b);resolve({count:gaps.length,p50Ms:gaps[59],p95Ms:gaps[113],maxMs:gaps[119],kind:'WebView requestAnimationFrame intervals, emulator-only, not GPU frame timings'});}}requestAnimationFrame(frame);})`);
   writeFileSync(join(out,'webview-frame-sample.json'),JSON.stringify(sample,null,2));
 });
 await check('node-list-local-note-open',async()=>{
   await clickText('更多图谱操作');await clickText('查找图谱节点');await clickSelector('[aria-label="查找节点名称"]');await send('Input.insertText',{text:'Synthetic-0000'});
   await poll(`Boolean(Array.from(document.querySelectorAll('.mg-node-list button')).find(e=>e.textContent.startsWith('Synthetic-0000')))`);
   await clickSelector('.mg-node-list button');await clickText('打开笔记');
   await poll(`document.body.textContent.includes('Synthetic graph fixture only.')`,30000);
 });
 console.log('Graph QA installed-app subset passed; see explicit limitations in checks.json');
} catch(error) {
 try { await screenshot('failure-synthetic',true); } catch { /* preserve original failure */ }
 results.push({name:'failure',status:'failed',message:String(error)});
 writeFileSync(join(out,'checks.json'),JSON.stringify({source:process.env.GITHUB_SHA,emulationMode:process.env.GRAPH_EMULATION_MODE,results},null,2));
 throw error;
} finally {ws.close();adb('forward','--remove','tcp:9222');}
