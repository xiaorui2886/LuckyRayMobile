// Runs ONLY against a brand-new disposable emulator/debug APK. No product code hook.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {initializeExpression,seedExpression} from './seed-expressions.mjs';
const out = process.env.GRAPH_QA_EVIDENCE;
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.CI_GRAPH_QA_REVIEWED !== 'yes' || process.env.ANDROID_SERIAL !== 'emulator-5554' || !out) throw Error('isolated QA guard');
const adb = (...args) => execFileSync('adb', ['-s', process.env.ANDROID_SERIAL, ...args], {encoding:'utf8'}).trim();
if (!adb('shell','dumpsys','package','com.luckyray.mobile').includes('DEBUGGABLE')) throw Error('debug package required for synthetic native seeding');
const delay = ms => new Promise(r => setTimeout(r, ms));
let socket;
for (let n=0;n<60;n++) {
 const pid=adb('shell','pidof','-s','com.luckyray.mobile');
 socket=adb('shell','cat','/proc/net/unix').split('\n').map(l=>l.split(/\s+/).at(-1)).find(s=>s===`@webview_devtools_remote_${pid}`);
 if(socket) break;
 await delay(1000);
}
if(!socket) throw Error('debug WebView CDP unavailable; installed test cannot fall back to browser');
adb('forward','tcp:9222',`localabstract:${socket.slice(1)}`);
const targets=await (await fetch('http://127.0.0.1:9222/json')).json();
const page=targets.find(t=>t.type==='page' && /^(https?:\/\/tauri\.localhost(?:[/:]|$)|tauri:\/\/)/.test(t.url));
if(!page) throw Error('packaged app WebView page missing');
const ws=new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});
let id=0; const pending=new Map(); const results=[]; const unexpectedOrigins=new Set();
ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Network.requestWillBeSent'){try{const u=new URL(m.params.request.url);if(/^https?:$/.test(u.protocol)&&!['tauri.localhost','ipc.localhost','127.0.0.1'].includes(u.hostname))unexpectedOrigins.add(u.origin);}catch{}}if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});
function send(method,params={}) {return new Promise((resolve,reject)=>{const key=++id; const timer=setTimeout(()=>{pending.delete(key);reject(Error(`CDP timeout: ${method}`));},600000);pending.set(key,{resolve,reject,timer});ws.send(JSON.stringify({id:key,method,params}));});}
async function evaluate(expression) {const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error('WebView evaluation failed: '+(r.exceptionDetails.exception?.description||r.exceptionDetails.text));return r.result.value;}
async function check(name, fn) {const started=Date.now();await fn();results.push({name,status:'passed',elapsedMs:Date.now()-started});writeFileSync(join(out,'checks.json'),JSON.stringify({source:process.env.GITHUB_SHA,emulationMode:process.env.GRAPH_EMULATION_MODE,results,limitations:['Not physical Xiaomi hardware','Runtime WebView version recorded separately','Pinch injected via CDP into real WebView, not OS-wide multitouch instrumentation','No multi-vault switching yet','No OS process-death persistence test; reload and tab reentry only','No exact WebView83 claim','No physical ARM64 or MIUI coverage','No full5000-note load or native profiler trace']},null,2));}
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
async function screenshot(name,logProof=false) {const metrics=await send('Page.getLayoutMetrics'); const s=metrics.cssVisualViewport||metrics.visualViewport;const shot=await send('Page.captureScreenshot',{format:'png',clip:{x:0,y:0,width:s.clientWidth,height:s.clientHeight,scale:1}});writeFileSync(join(out,`${name}.png`),Buffer.from(shot.data,'base64'));if(logProof){const small=await send('Page.captureScreenshot',{format:'png',clip:{x:0,y:0,width:s.clientWidth,height:s.clientHeight,scale:0.5}});if(small.data.length<=300000)console.log(`GRAPH_QA_PNG_BEGIN ${name}\n${small.data}\nGRAPH_QA_PNG_END ${name}`);}}
try {
 await send('Runtime.enable');await send('Network.enable');
 await check('native-bridge-ready',()=>poll(`Boolean(window.__TAURI_INTERNALS__ && document.querySelector('#root')?.children.length)`));
 await check('empty-native-vault-preflight',async()=>{
 const value=await evaluate(initializeExpression());
 if(value.state!=='ready')throw Error('synthetic empty migration not ready');
 });
 await check('native-seed-1000-notes',async()=>{
 const count=await evaluate(seedExpression(1000));
 if(count!==1000)throw Error('native note count mismatch');
 });
 await check('open-graph-real-ui',async()=>{await clickText('知识');await delay(300);await clickText('图谱');await poll(`Boolean(document.querySelector('.mg-canvas canvas')) && !document.querySelector('.mg-status') && !document.querySelector('.mg-notice[role="alert"]')`,120000);});
 await delay(800);await screenshot('graph-synthetic',true);
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
