/** Installed APK real native command + visible UI assertions; never DB injection.
 * Real WSS connection, user enrollment, frontend scheduling and UI editor autosave.
 * The real desktop application, killed-app sync and home LAN are NOT covered. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
export async function runSyntheticSync(ctx){
 const {config,invoke,check,recordNative,evaluate,poll,clickText,send,delay,screenshot}=ctx;
 const report={scope:'actual installed Android APK ↔ synthetic HTTPS protocol peer',pair:'NOT_RUN',pinRejection:'NOT_RUN',enroll:'NOT_RUN',pull:'NOT_RUN',desktopDelta:'NOT_RUN',pushAck:'NOT_RUN',notesGraphIdentity:'NOT_RUN',automaticScheduling:'NOT_RUN',wss:'NOT_RUN',realDesktopLAN:'NOT_RUN'};
 const save=()=>{recordNative('synthetic-sync-checks',report);try{recordNative('synthetic-peer-transport',JSON.parse(readFileSync(config.evidencePath,'utf8')));}catch{}};
 let localVaultId;
 const tapContaining=async(text)=>{const point=await evaluate(`(()=>{const e=Array.from(document.querySelectorAll('button,[role=button]')).find(e=>e.textContent.includes(${JSON.stringify(text)})&&e.getBoundingClientRect().width>0);if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);assert.ok(point,'visible UI button '+text);await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...point,id:1,radiusX:2,radiusY:2}]});await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await delay(200);};
 const getNote=noteId=>invoke('managed_vault_note_get',{localVaultId,noteId});
 async function syncUntil(predicate,label){const start=Date.now();let rounds=0;while(Date.now()-start<90000){rounds++;if(await predicate())return rounds;await delay(300);}throw Error('Synthetic sync deadline: '+label);}
 try{
  await check('synthetic-native-pair-pin-rejection',async()=>{
   let rejected=false;try{await invoke('conn_pair',{payload:JSON.stringify({...config.pairing,fp:'0'.repeat(64)})});}catch{rejected=true;}
   assert.ok(rejected,'wrong certificate pin must reject before pairing');
   const state=JSON.parse(readFileSync(config.statePath,'utf8'));assert.equal(state.paired,false);report.pinRejection='PASS';save();
  });
  await check('synthetic-native-first-pair',async()=>{
   const result=await invoke('conn_pair',{payload:JSON.stringify(config.pairing)});assert.equal(result.instanceId,config.instanceId);
   const ev=JSON.parse(readFileSync(config.evidencePath,'utf8'));
   for(const path of ['/v1/hello','/v1/pair','/v1/session'])assert.ok(ev.requests.some(r=>r.path===path&&r.status===200));
   report.pair='PASS';await invoke('ws_start',{});await poll(`window.__TAURI_INTERNALS__.invoke('conn_state').then(s=>s.ws.state==='connected')`,30000);assert.ok(JSON.parse(readFileSync(config.evidencePath,'utf8')).wsConnections.some(w=>w.path==='/v1/events'));report.wss='PASS';save();
  });
  await check('synthetic-desktop-vault-enrollment-is-idempotent',async()=>{
   const before=await invoke('managed_vault_list',{});
   await clickText('笔记');await poll(`Boolean(document.querySelector('[aria-label="目录与库"]'))`);await clickText('目录与库');await clickText('库');await clickText('添加知识库');await poll(`document.body.textContent.includes('Synthetic Unified Library')`,30000);await tapContaining('Synthetic Unified Library');await poll(`!document.querySelector('[aria-label="知识库名称"]')`,30000);
   const enrolled=await invoke('managed_vault_list',{});const a=enrolled.items.find(v=>v.binding?.instanceId===config.instanceId&&v.binding.remoteVaultId===config.vaultId);assert.ok(a,'UI enrollment created bound managed library');
   const b=await invoke('managed_vault_sync_to_phone',{instance:config.instanceId,vault:config.vaultId});
   assert.equal(a.localVaultId,b.localVaultId);assert.deepEqual(a.binding,{instanceId:config.instanceId,remoteVaultId:config.vaultId});localVaultId=a.localVaultId;
   const after=await invoke('managed_vault_list',{});assert.equal(after.items.length,before.items.length+1);assert.equal(after.items.filter(v=>v.binding?.instanceId===config.instanceId&&v.binding.remoteVaultId===config.vaultId).length,1);
   report.enroll='PASS';save();
  });
  await check('synthetic-desktop-body-pulls-to-managed-files',async()=>{
   report.pullRounds=await syncUntil(async()=>{try{return (await getNote(config.noteId)).bodyState==='ready';}catch{return false;}},'initial body');
   const n=await getNote(config.noteId);assert.ok(n.content.includes('Original desktop text.'));assert.equal(n.localVaultId,localVaultId);report.pull='PASS';save();
  });
  await check('synthetic-desktop-new-note-pulls-to-same-managed-vault',async()=>{
   writeFileSync(config.controlPath,JSON.stringify({action:'add-note',requestId:'installed-apk-add'}),{mode:0o600});await delay(300);
   report.deltaRounds=await syncUntil(async()=>{try{return (await getNote('kn-synthetic-added')).bodyState==='ready';}catch{return false;}},'desktop new note');
   assert.ok((await getNote('kn-synthetic-added')).content.includes('Created after phone enrollment.'));report.desktopDelta='PASS';const transport=JSON.parse(readFileSync(config.evidencePath,'utf8'));report.hintDelivery=transport.hintsSent>0?'SENT_TO_REAL_WSS_CLIENT':'FOREGROUND_POLL_ONLY';save();
  });
  await check('synthetic-mobile-save-reaches-peer-and-acks',async()=>{
   const n=await getNote(config.noteId);
   await poll(`document.body.textContent.includes('Synthetic Desktop Note')`,30000);await tapContaining('Synthetic Desktop Note');await poll(`Boolean(document.querySelector('.cm-content[contenteditable="true"]'))`,30000);
   await ctx.clickSelector('.cm-content[contenteditable="true"]');
   for(const type of ['keyDown','keyUp'])await send('Input.dispatchKeyEvent',{type,key:'Home',code:'Home',windowsVirtualKeyCode:36,modifiers:2});
   await send('Input.insertText',{text:'Synthetic Android UI edit.\n'});
   report.pushRounds=await syncUntil(async()=>{const state=JSON.parse(readFileSync(config.statePath,'utf8'));const local=await getNote(n.noteId);return state.notes.some(d=>d.noteId===n.noteId&&d.content.includes('Synthetic Android UI edit.'))&&local.content?.includes('Synthetic Android UI edit.')&&local.syncState==='synced';},'mobile write ACK');
   const ev=JSON.parse(readFileSync(config.evidencePath,'utf8'));assert.ok(ev.writes.some(w=>w.noteId===n.noteId&&w.contentSha256===createHash('sha256').update(JSON.parse(readFileSync(config.statePath,'utf8')).notes.find(d=>d.noteId===n.noteId).content).digest('hex')));report.pushAck='PASS';report.automaticScheduling='PASS_FOREGROUND';await screenshot('synthetic-ui-edit-synced',true);await clickText('切换到阅读模式');await delay(300);await clickText('返回上一页');await poll(`Boolean(document.querySelector('.st-knowledge-view'))`,30000);save();
  });
  await check('synthetic-bound-vault-visible-shared-notes-and-graph',async()=>{
   await clickText('图谱');await poll(`Boolean(document.querySelector('[aria-label="图谱知识库"]'))`);
   const selector='[aria-label="图谱知识库"]';
   await poll(`Array.from(document.querySelector(${JSON.stringify(selector)}).options).some(o=>o.value===${JSON.stringify(localVaultId)})`,30000);
   const ids=await evaluate(`Array.from(document.querySelector(${JSON.stringify(selector)}).options).map(o=>o.value)`);assert.equal(ids.filter(id=>id===localVaultId).length,1);
   await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
   const key=async(key,code,windowsVirtualKeyCode)=>{for(const type of ['keyDown','keyUp'])await send('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode});};
   await key('Home','Home',36);for(let i=0;i<ids.indexOf(localVaultId);i++)await key('ArrowDown','ArrowDown',40);await key('Tab','Tab',9);
   await poll(`document.querySelector(${JSON.stringify(selector)})?.value===${JSON.stringify(localVaultId)} && !document.querySelector('.mg-status,.mg-canvas-warning')`,60000);
   assert.equal((await invoke('managed_vault_list',{})).selectedVaultId,localVaultId);await screenshot('synthetic-bound-vault-graph',true);
   await clickText('笔记');await poll(`document.body.textContent.includes('Synthetic Desktop Note') && document.body.textContent.includes('Synthetic Added Desktop Note')`,30000);
   assert.equal((await invoke('managed_vault_list',{})).selectedVaultId,localVaultId);await screenshot('synthetic-bound-vault-notes',true);report.notesGraphIdentity='PASS';save();
  });
 }finally{save();}
}
