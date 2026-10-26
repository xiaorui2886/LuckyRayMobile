import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import {startSyntheticPeer} from './synthetic-peer.mjs';
test('synthetic peer: authenticated pair, scoped snapshot/change/write and redacted diagnostics',async()=>{
 if(process.env.GITHUB_ACTIONS==='true'&&!process.env.RUNNER_TEMP)throw Error('CI requires RUNNER_TEMP');
 const dir=mkdtempSync(join(process.env.RUNNER_TEMP||tmpdir(),'synthetic-peer-'));const p=await startSyntheticPeer({runtimeDir:dir,port:0});
 try{
  const pairing=JSON.parse(readFileSync(p.ready.pairingPath));let token='';
  const request=(method,path,body,scope=true)=>new Promise((resolve,reject)=>{
   const req=https.request({hostname:'127.0.0.1',port:p.ready.port,path,method,ca:readFileSync(join(dir,'peer-cert.pem')),checkServerIdentity:(_host,cert)=>cert.fingerprint256.replaceAll(':','').toLowerCase()===pairing.fp?undefined:Error('pin mismatch'),headers:{...(token?{authorization:'Bearer '+token}:{}),...(scope?{'x-luckyray-knowledge-vault':p.ready.vaultId}:{}),'content-type':'application/json'}},res=>{let chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks))}));});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
  });
  assert.equal((await request('GET','/v1/session')).status,401);
  assert.equal((await request('GET','/v1/hello')).body.instanceId,p.ready.instanceId);
  const paired=await request('POST','/v1/pair',{secret:pairing.secret,fingerprint:pairing.fp,deviceLabel:'Synthetic Test'});assert.equal(paired.status,200);token=paired.body.credential;
  assert.equal((await request('GET','/v1/session')).body.deviceId,paired.body.deviceId);
  const mod=await import(pathToFileURL(process.env.UNIFIED_PEER_WS_MODULE).href);const WS=mod.WebSocket||mod.default;
  const ws=new WS(`wss://127.0.0.1:${p.ready.port}/v1/services/events/stream`,{ca:readFileSync(join(dir,'peer-cert.pem')),checkServerIdentity:(_h,c)=>c.fingerprint256.replaceAll(':','').toLowerCase()===pairing.fp?undefined:Error('pin mismatch'),headers:{authorization:'Bearer '+token}});
  await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j)});let hint;ws.on('message',m=>{hint=JSON.parse(m)});ws.ping();
  assert.equal((await request('GET','/v1/notes')).status,200);
  assert.equal((await request('GET','/v1/notes',null,false)).status,403);
  const doc=(await request('GET','/v1/notes/'+p.ready.noteId)).body;
  const operation={opId:'test-op',kind:'update',noteId:doc.noteId,vaultId:doc.vaultId,title:doc.title,content:'Synthetic mobile update',expectedRevision:doc.revision};
  const ack=await request('PATCH','/v1/notes/'+doc.noteId,operation);assert.equal(ack.status,200);assert.equal(ack.body.document.content,operation.content);
  assert.deepEqual((await request('PATCH','/v1/notes/'+doc.noteId,operation)).body,ack.body);
  assert.equal((await request('PATCH','/v1/notes/'+doc.noteId,{...operation,opId:'stale'})).status,409);
  writeFileSync(p.ready.controlPath,JSON.stringify({action:'add-note'}));await new Promise(r=>setTimeout(r,300));
  assert.equal((await request('GET','/v1/sync/changes?after=1')).body.changes.length,2);assert.equal(hint.kind,'knowledgeChanged');assert.equal(hint.vaultId,p.ready.vaultId);assert.ok(JSON.parse(readFileSync(p.ready.evidencePath)).wsPings>0);ws.close();
  const ev=readFileSync(p.ready.evidencePath,'utf8');assert.ok(!ev.includes(token)&&!ev.includes(pairing.secret));assert.ok(JSON.parse(ev).tlsAccepted>0);
 }finally{await p.close();rmSync(dir,{recursive:true,force:true});}
});
