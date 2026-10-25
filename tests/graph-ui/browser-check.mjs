import {createRequire} from 'node:module';import {writeFile,mkdir,readFile} from 'node:fs/promises';import {createServer} from 'node:http';import path from 'node:path';import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),repo=path.resolve(here,'../..'),out=process.env.GRAPH_QA_EVIDENCE||path.join(repo,'graph-qa-evidence'),require=createRequire(repo+'/package.json'),{build}=createRequire(require.resolve('vite/package.json'))('esbuild');
await mkdir(out+'/site/core',{recursive:true});
const nodes=Array.from({length:80},(_,i)=>({id:i+1,key:'synthetic-'+i,label:'Synthetic '+String(i).padStart(2,'0'),type:i%10===0?'tag':'note',relativePath:'Demo/Synthetic '+i+'.md',timelineAt:1700000000000+i*86400000}));
const edges=nodes.slice(1).map((n,i)=>[n.id,Math.floor(i/3)+1]);
const seed={nodes,edges,source:'real'};
await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import Graph from './src/features/graph/MobileGraphView';import './src/presentation/still01/still.css';import './src/presentation/still01/defaultTheme.css';createRoot(document.getElementById('root')).render(<div className="st-app" data-mode="light"><Graph modeSwitch={<div className="st-source"><button>笔记</button><button>图谱</button></div>}/></div>);`,resolveDir:repo,loader:'tsx'},outfile:out+'/site/app.js',bundle:true,format:'esm',platform:'browser',jsx:'automatic',plugins:[{name:'fixtures',setup(b){
b.onResolve({filter:/still\/StillShell$/},()=>({path:'nav',namespace:'fixture'}));b.onResolve({filter:/services\/mobileGraph$/},()=>({path:'data',namespace:'fixture'}));b.onResolve({filter:/services\/mobileGraphMutations$/},()=>({path:'mutations',namespace:'fixture'}));b.onResolve({filter:/kit\/Sheet$/},()=>({path:'sheet',namespace:'fixture'}));
b.onLoad({filter:/.*/,namespace:'fixture'},a=>({loader:'tsx',resolveDir:repo,contents:a.path==='nav'?`const nav={open:()=>{},registerOverlay:()=>()=>{},mode:'light',reduced:false};export const useStillNav=()=>nav;`:a.path==='data'?`const source={id:'synthetic',name:'演示笔记库',kind:'managed',readOnly:false};export const listMobileGraphSources=async()=>({sources:[source],selectedSourceId:source.id});export const loadMobileGraphSnapshot=async()=>({source,seed:${JSON.stringify(seed)},notesByKey:new Map(),resourcesByKey:new Map(),tagsByKey:new Map(),warnings:[]});export const subscribeMobileGraphChanges=()=>()=>{};export const createMobileGraphNote=async()=>{};export const linkMobileGraphNodes=async()=>{};export const unlinkMobileGraphNodes=async()=>{};export const setMobileGraphNoteTags=async()=>{};`:a.path==='mutations'?`export const mobileGraphRelationDisabledReason=()=>null;`:`export function Sheet({title,children}){return <section className="st-sheet"><h2>{title}</h2>{children}</section>}`}));}}]});
await build({entryPoints:[repo+'/src/features/graph/core/graphPhysics.worker.ts'],outfile:out+'/site/core/graphPhysics.worker.ts',bundle:true,format:'esm',platform:'browser'});
await writeFile(out+'/site/index.html','<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="app.css"><style>html,body,#root{margin:0;height:100%;width:100%}.st-app{height:100%;--st-safe-top:24px;--st-safe-bottom:16px;font-family:Arial,sans-serif}</style><div id="root"></div><script type="module" src="app.js"></script>');
const server=createServer(async(req,res)=>{try{const p=path.join(out,'site',req.url==='/'?'index.html':req.url);res.setHeader('Content-Type',p.endsWith('.css')?'text/css':p.endsWith('.html')?'text/html':'text/javascript');res.end(await readFile(p));}catch{res.statusCode=404;res.end();}});await new Promise(r=>server.listen(4188,'127.0.0.1',r));
const endpoint=process.env.CDP_ENDPOINT||'http://127.0.0.1:9222';
const target=await (await fetch(endpoint+'/json/new?about:blank',{method:'PUT'})).json();
const socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
let nextId=0;const pending=new Map(),errors=[];
socket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.id){const callbacks=pending.get(message.id);if(callbacks){pending.delete(message.id);message.error?callbacks.reject(Error(JSON.stringify(message.error))):callbacks.resolve(message.result);}}else if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.text);});
const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++nextId;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const screenshots=[],checks=[];
const shot=async(name,marker=false)=>{const response=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(path.join(out,name+'.png'),Buffer.from(response.data,'base64'));screenshots.push(name+'.png');if(marker){const small=await send('Page.captureScreenshot',{format:'png',clip:{x:0,y:0,width:await evaluate('innerWidth'),height:await evaluate('innerHeight'),scale:.5}});if(small.data.length<=300000)console.log(`GRAPH_QA_PNG_BEGIN ${name}\n${small.data}\nGRAPH_QA_PNG_END ${name}`);}};
try{
 await send('Page.enable');await send('Runtime.enable');
 for(const width of [360,430]){
  const height=width===360?740:932;
  await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true});await send('Emulation.setTouchEmulationEnabled',{enabled:true});
  await send('Page.navigate',{url:'http://127.0.0.1:4188/'});let ready=false;for(let attempt=0;attempt<100;attempt++){await pause(100);try{ready=await evaluate("!!document.querySelector('canvas') && !!document.querySelector('[aria-label=\"打开图谱设置\"]')");}catch{}if(ready)break;}if(!ready)throw Error('Graph fixture did not become ready');await pause(500);
  await evaluate("document.querySelector('.st-app').setAttribute('data-mode','light')");
  await shot(`graph-light-${width}`,width===360);
  await evaluate("document.querySelector('[aria-label=\"打开图谱设置\"]').click()");await pause(100);
  await shot(`settings-light-${width}`);
  const result=await evaluate(`(()=>{const panel=document.querySelector('.mg-settings'),stage=document.querySelector('.mg-stage');return {width:innerWidth,bodyWidth:document.body.scrollWidth,panel:panel.getBoundingClientRect().toJSON(),stage:stage.getBoundingClientRect().toJSON(),canvasWidth:document.querySelector('canvas').width,nodeSize:[...document.querySelectorAll('label')].find(x=>x.textContent.startsWith('节点大小')).querySelector('input').value};})()`);
  if(result.bodyWidth>width||result.panel.right>width||result.panel.left<0||result.canvasWidth<1||result.nodeSize!=='6')throw Error('Mobile graph layout/default assertion failed: '+JSON.stringify(result));checks.push(result);
  await evaluate("document.querySelector('.st-app').setAttribute('data-mode','dark')");await pause(100);await shot(`settings-dark-${width}`,width===430);
  for(const section of ['颜色组','力度']){
   await evaluate(`(()=>{const button=[...document.querySelectorAll('.mg-section-title')].find(x=>x.textContent.includes(${JSON.stringify(section)}));if(button.getAttribute('aria-expanded')!=='true')button.click();})()`);await pause(50);
   await evaluate(`(()=>{const button=[...document.querySelectorAll('.mg-section-title')].find(x=>x.textContent.includes(${JSON.stringify(section)}));button.scrollIntoView({block:'start'});})()`);await shot(`settings-${section==='力度'?'force':'colors'}-dark-${width}`);
  }
 }
 if(errors.length)throw Error('Browser exceptions: '+JSON.stringify(errors));
 await writeFile(path.join(out,'ui-browser-results.json'),JSON.stringify({status:'passed',kind:'synthetic-host-browser-not-Android',checks,screenshots,errors},null,2));console.log('PASS mobile graph host browser: light/dark 360/430, settings groups, bounds/defaults, canvas');
}finally{socket.close();server.close();try{await fetch(endpoint+'/json/close/'+target.id);}catch{}}
