// Disposable synthetic installed-APK extensions. NOT RUN until actual Android QA passes.
// Caller owns empty-profile provenance, base-PASS gating, transport reconnection and check records.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';

async function guard(ctx) {
  assert.equal(process.env.GITHUB_ACTIONS,'true');
  assert.equal(process.env.CI_GRAPH_QA_REVIEWED,'yes');
  assert.equal(process.env.ANDROID_SERIAL,'emulator-5554');
  assert.ok(process.env.GRAPH_QA_EVIDENCE);
  await ctx.assertSystemHealthy('native-functional-before');
  assert.equal(ctx.syntheticFixtureVerified,true,'caller must establish fresh empty fixture and base PASS');
  assert.match(ctx.adb('shell','dumpsys','package','com.luckyray.mobile'),/DEBUGGABLE/);
  await ctx.poll(`document.querySelector('[aria-label="图谱知识库"]')?.value === 'local' && Boolean(document.querySelector('.mg-canvas canvas')) && !document.querySelector('.mg-status,.mg-canvas-warning,[role="dialog"]')`,120000);
}
async function key(ctx,key,code,windowsVirtualKeyCode,modifiers=0) {
  for(const type of ['keyDown','keyUp']) await ctx.send('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode,modifiers});
}
async function fill(ctx,label,text) {
  const index=await ctx.evaluate(`(()=>{const es=[...document.querySelectorAll('input')];return es.findIndex(e=>e.getAttribute('aria-label')===${JSON.stringify(label)}||[...(e.labels||[])].some(l=>l.textContent.trim()===${JSON.stringify(label)}));})()`);
  assert.ok(index>=0,`input not found: ${label}`);
  const rect=await ctx.evaluate(`(()=>{const e=document.querySelectorAll('input')[${index}];e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await ctx.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...rect,id:1}]});
  await ctx.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await ctx.poll(`document.activeElement === document.querySelectorAll('input')[${index}]`);
  await key(ctx,'a','KeyA',65,2);await key(ctx,'Backspace','Backspace',8);
  await ctx.send('Input.insertText',{text});
  await ctx.poll(`document.querySelectorAll('input')[${index}]?.value === ${JSON.stringify(text)}`);
}
async function chooseTarget(ctx,title) {
  const selector='[aria-label="选择关联目标"]';
  await ctx.poll(`(()=>{const s=document.querySelector(${JSON.stringify(selector)});return s&&[...s.options].filter(o=>o.value).length===1;})()`);
  const option=await ctx.evaluate(`(()=>{const s=document.querySelector(${JSON.stringify(selector)});const o=[...s.options].filter(o=>o.value);return o.length===1?{value:o[0].value,text:o[0].textContent}:null;})()`);
  assert.ok(option && (option.text===title||option.text.startsWith(title+' · ')),'single uniquely named real relation option');
  // Focus then keyboard selection avoids DOM value setters and native chooser coordinate guesses.
  await ctx.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  await key(ctx,'Home','Home',36);await key(ctx,'ArrowDown','ArrowDown',40);await key(ctx,'Tab','Tab',9);
  await ctx.poll(`document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(option.value)}`,10000);
}
async function selectNode(ctx,title) {
  await ctx.clickText('更多图谱操作');await ctx.clickText('查找图谱节点');
  await fill(ctx,'查找节点名称',title);
  await ctx.poll(`(()=>{const bs=[...document.querySelectorAll('.mg-node-list button')];return bs.length===1&&bs[0].textContent.startsWith(${JSON.stringify(title)});})()`);
  await ctx.clickSelector('.mg-node-list button');
  await ctx.poll(`document.querySelector('.mg-selection-head strong')?.textContent === ${JSON.stringify(title)} && !document.querySelector('[role="dialog"]')`);
}
const mediaQuery=['shell','content','query','--uri','content://media/external/images/media','--projection','_id:_display_name:mime_type:relative_path'];
export function parseMediaRows(text) {
  return text.split('\n').filter(l=>/^Row:/.test(l)).map(line=>({id:line.match(/\b_id=(\d+)/)?.[1],name:line.match(/\b_display_name=([^,]+)/)?.[1],mime:line.match(/\bmime_type=([^,]+)/)?.[1],path:line.match(/\brelative_path=([^,]+)/)?.[1]}));
}
export function inspectPng(bytes) {
  assert.ok(Buffer.isBuffer(bytes)&&bytes.length>=45&&bytes.length<=8*1024*1024,'bounded native PNG bytes');
  assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  assert.equal(bytes.readUInt32BE(8),13);assert.equal(bytes.toString('ascii',12,16),'IHDR');
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
  assert.ok(width>0&&height>0&&width*height<=8*1024*1024,'bounded PNG IHDR dimensions');
  assert.equal(bytes.toString('ascii',bytes.length-8,bytes.length-4),'IEND');
  return {width,height,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),proof:'native MediaStore bytes, PNG signature/IHDR/IEND; not independent full pixel decode'};
}
export async function nativeSavePng(ctx) {
  await guard(ctx);
  const before=new Set(parseMediaRows(ctx.adb(...mediaQuery)).map(r=>r.id));
  await ctx.clickText('更多图谱操作');await ctx.clickText('导出图谱图片');await ctx.clickText('保存到系统相册');
  await ctx.poll(`document.body.textContent.includes('图谱图片已保存到系统相册 LuckyRay。')`,60000);
  const added=parseMediaRows(ctx.adb(...mediaQuery)).filter(r=>r.id&&!before.has(r.id));
  assert.equal(added.length,1,'exactly one new MediaStore ID after single explicit save');
  const row=added[0];assert.equal(row.mime,'image/png');assert.equal(row.path,'Pictures/LuckyRay/');assert.match(row.name,/^LuckyRay-Graph(?:[ (._-].*)?\.png$/);
  const bytes=execFileSync('adb',['-s','emulator-5554','exec-out','content','read','--uri',`content://media/external/images/media/${row.id}`],{timeout:30000,maxBuffer:8*1024*1024+1});
  const png=inspectPng(bytes);writeFileSync(join(process.env.GRAPH_QA_EVIDENCE,'native-saved-graph.png'),bytes);
  await ctx.screenshot('native-save-confirmation',true);
  await ctx.clickText('收起图谱图片');await ctx.poll(`!document.querySelector('[role="dialog"]')`);
  await ctx.assertSystemHealthy('native-save-after');
  ctx.record('native-export-save',{...png,newMediaStoreId:row.id,shareInvoked:false});
}
export async function nativeRotation(ctx) {
  await guard(ctx);
  // Close only a verified visible IME, never dismiss an unknown system dialog.
  if(/(?:mInputShown|isInputViewShown)\s*[=:]\s*true/.test(ctx.adb('shell','dumpsys','input_method')))ctx.adb('shell','input','keyevent','4');
  await ctx.delay(500);
  const initialLandscape=await ctx.evaluate('window.innerWidth > window.innerHeight');
  const state=await ctx.evaluate(ctx.sessionExpression);assert.ok(state?.id&&state?.settings&&state?.camera);
  const rotation=ctx.adb('shell','settings','get','system','user_rotation'),auto=ctx.adb('shell','settings','get','system','accelerometer_rotation');
  try {
    ctx.adb('shell','settings','put','system','accelerometer_rotation','0');ctx.adb('shell','settings','put','system','user_rotation','1');
    await ctx.poll('window.innerWidth > window.innerHeight',30000);await ctx.delay(500);
    await ctx.poll(`Boolean(document.querySelector('.mg-canvas canvas')) && !document.querySelector('.mg-canvas-warning')`);
    assert.deepEqual((await ctx.evaluate(ctx.sessionExpression)).settings,state.settings);await ctx.screenshot('native-landscape',true);
    ctx.adb('shell','settings','put','system','user_rotation','0');await ctx.poll('window.innerHeight > window.innerWidth',30000);await ctx.delay(500);
    assert.deepEqual((await ctx.evaluate(ctx.sessionExpression)).settings,state.settings);await ctx.screenshot('native-portrait',true);
  } finally {
    for(const [name,value] of [['user_rotation',rotation],['accelerometer_rotation',auto]]) {
      if(value==='null')ctx.adb('shell','settings','delete','system',name);else {assert.match(value,/^[0-3]$/);ctx.adb('shell','settings','put','system',name,value);}
    }
  }
  await ctx.poll(`(window.innerWidth > window.innerHeight) === ${initialLandscape}`,30000);
  await ctx.delay(500);await ctx.assertSystemHealthy('native-rotation-after');ctx.record('native-rotation',{landscapeAndPortrait:true,settingsPreserved:true,method:'Android user_rotation, not CDP viewport emulation'});
}
export async function nativeGraphWriteRoundTrip(ctx) {
  await guard(ctx);
  const title='Synthetic-QA-Graph-Created',tag='synthetic-roundtrip';
  const byTitle=name=>ctx.evaluate(`(async()=>{const r=await window.__TAURI_INTERNALS__.invoke('managed_vault_note_list',{query:{localVaultId:'local',q:${JSON.stringify(name)},page:1,limit:20}});const ns=r.items.filter(n=>n.title===${JSON.stringify(name)});if(ns.length>1)throw Error('duplicate synthetic title');return ns.length?window.__TAURI_INTERNALS__.invoke('managed_vault_note_get',{localVaultId:'local',noteId:ns[0].noteId}):null;})()`);
  const count=()=>ctx.evaluate(`window.__TAURI_INTERNALS__.invoke('managed_vault_note_list',{query:{localVaultId:'local',page:1,limit:1}}).then(r=>r.total)`);
  const beforeCount=await count();assert.equal(beforeCount,100,'functional stage must precede stress extension');
  assert.equal(await byTitle(title),null,'single attempt only; no overwriting/retrying');
  const target=await byTitle('Synthetic-0000');assert.ok(target?.noteId);
  await ctx.clickText('更多图谱操作');await ctx.clickText('新建图谱笔记');await fill(ctx,'笔记名称',title);await ctx.clickText('确认保存');await ctx.poll(`!document.querySelector('.mg-form')`);
  const created=await byTitle(title);assert.ok(created?.noteId);assert.equal(await count(),beforeCount+1);
  await selectNode(ctx,title);await ctx.clickText('编辑标签');await fill(ctx,'标签（用逗号分隔）',tag);await ctx.clickText('确认保存');await ctx.poll(`!document.querySelector('.mg-form')`);
  const tagged=await byTitle(title);assert.ok(tagged.tags.includes(tag));assert.match(tagged.content,/synthetic-roundtrip/);
  await selectNode(ctx,title);await ctx.clickText('添加关联');await fill(ctx,'搜索关联目标','Synthetic-0000');await chooseTarget(ctx,'Synthetic-0000');await ctx.clickText('取消');await ctx.poll(`!document.querySelector('.mg-form')`);
  assert.equal((await byTitle(title)).content,tagged.content,'cancel does not write');
  await ctx.clickText('添加关联');await fill(ctx,'搜索关联目标','Synthetic-0000');await chooseTarget(ctx,'Synthetic-0000');await ctx.clickText('确认保存');await ctx.poll(`!document.querySelector('.mg-form')`);
  const linked=await byTitle(title),relation='[[@id/'+target.noteId+']]';assert.ok(linked.content.includes(relation));
  await selectNode(ctx,title);await ctx.clickText('移除关联');await fill(ctx,'搜索关联目标','Synthetic-0000');await chooseTarget(ctx,'Synthetic-0000');await ctx.clickText('确认保存');await ctx.poll(`!document.querySelector('.mg-form')`);
  const unlinked=await byTitle(title);assert.ok(!unlinked.content.includes(relation));assert.ok(unlinked.tags.includes(tag));assert.equal((await byTitle('Synthetic-0000')).content,target.content);assert.equal(await count(),beforeCount+1);
  if(/(?:mInputShown|isInputViewShown)\s*[=:]\s*true/.test(ctx.adb('shell','dumpsys','input_method')))ctx.adb('shell','input','keyevent','4');
  await ctx.poll(`Boolean(document.querySelector('.mg-canvas canvas')) && !document.querySelector('[role="dialog"]')`);
  await ctx.delay(500);
  await ctx.screenshot('native-write-roundtrip',true);
  await ctx.assertSystemHealthy('native-write-after');
  ctx.record('native-graph-write-roundtrip',{createdId:created.noteId,targetId:target.noteId,beforeCount,afterCount:beforeCount+1,create:true,tags:true,link:true,cancelNoWrite:true,unlink:true,readback:'existing native note APIs; writes only through real UI input'});
}
