// Actual production recovery UI and CSS in Chromium. Native seam is synthetic;
// real TLS/SQLite are covered separately. This is NOT an Android receipt.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const [endpoint,origin,out]=process.argv.slice(2);
if(!endpoint||!origin||!out)throw Error('Usage: node browser.test.mjs <CDP> <Vite> <evidence>');
await mkdir(out,{recursive:true});
const target=await fetch(endpoint+'/json/new?about:blank',{method:'PUT'}).then(r=>r.json());
const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((ok,no)=>{ws.onopen=ok;ws.onerror=no;});
let id=0;const pending=new Map(),errors=[],checks=[];
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p?.reject(Error(JSON.stringify(m.error))):p?.resolve(m.result);}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);};
const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const click=async text=>{
  const point=await evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e||e.disabled)throw Error('Missing enabled control');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),top=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);if(!e.contains(top))throw Error('Occluded control');return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});await pause(60);
};
const shot=async name=>{const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));};
try{
  await send('Runtime.enable');await send('Page.enable');
  for(const [width,height,mode]of[[320,568,'light'],[430,932,'dark'],[740,360,'light'],[360,380,'dark']]){
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true});
    await send('Page.navigate',{url:origin+'/tests/endpointRecovery/browser.html'});
    for(let n=0;n<100;n++){await pause(50);if(await evaluate(`!!window.__recoveryFixture&&!!document.querySelector('button')`))break;}
    await evaluate(`document.querySelector('.st-app').dataset.mode=${JSON.stringify(mode)}`);
    await click('恢复电脑连接地址');
    assert.equal(await evaluate(`window.__recoveryFixture.calls.length`),0,'opening never prepares, pairs or writes');
    await evaluate(`(()=>{const e=document.querySelector('textarea');e.focus();const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;setter.call(e,'SYNTHETIC ADDRESS HINT');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await pause(50);
    assert.equal(await evaluate(`document.activeElement.tagName`),'TEXTAREA');
    await click('检查地址资料');
    assert.equal(await evaluate(`window.__recoveryFixture.calls.join(',')`),'conn_endpoint_prepare');
    assert.match(await evaluate(`document.body.textContent`),/地址尚未连接验证/);
    const dimensions=await evaluate(`(()=>{const e=document.querySelector('[role=dialog]'),r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,bodyWidth:document.body.scrollWidth,scrollable:getComputedStyle(document.querySelector('.st-sheet-body')).overflowY};})()`);
    assert.ok(dimensions.left>=0&&dimensions.right<=width&&dimensions.top>=0&&dimensions.bottom<=height+1);assert.equal(dimensions.bodyWidth,width);
    await shot(`review-${width}x${height}-${mode}`);
    await click('验证并更新地址');await pause(300);
    assert.match(await evaluate(`document.body.textContent`),/此提示不代表实时连接已成功/);
    assert.equal(await evaluate(`window.__recoveryFixture.updated`),1);
    assert.deepEqual(await evaluate(`window.__recoveryFixture.calls`),['conn_endpoint_prepare','conn_endpoint_update']);
    await click('完成');assert.equal(await evaluate(`!!document.querySelector('[role=dialog]')`),false);
    checks.push({width,height,mode,dimensions,confirmation:'explicit',realtimeClaim:false});
  }
  // Real rendered cancellation (no update), then a fixed safe TLS failure.
  await click('恢复电脑连接地址');await click('取消');assert.equal(await evaluate(`!!document.querySelector('[role=dialog]')`),false);
  await click('恢复电脑连接地址');
  await evaluate(`(()=>{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'HINT');e.dispatchEvent(new Event('input',{bubbles:true}));window.__recoveryFixture.outcome='tls';})()`);await pause(50);
  await click('检查地址资料');await click('验证并更新地址');await pause(300);
  assert.match(await evaluate(`document.body.textContent`),/不会跳过证书校验/);
  assert.equal(await evaluate(`window.__recoveryFixture.updated`),1);
  assert.deepEqual(errors,[]);
  const result={result:'PASS',kind:'Chromium production component/CSS with synthetic native seam, not phone',checks,errors};
  await writeFile(path.join(out,'results.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}finally{ws.close();await fetch(endpoint+'/json/close/'+target.id).catch(()=>{});}
