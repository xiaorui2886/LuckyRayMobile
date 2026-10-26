/** Isolated protocol fixture, NOT the desktop application or a home-LAN test.
 * No dependencies, no persistent credentials, no product TLS policy changes. */
import https from 'node:https';
import {randomBytes,createHash,X509Certificate} from 'node:crypto';
import {mkdirSync,chmodSync,writeFileSync,readFileSync,existsSync,renameSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const sha=s=>createHash('sha256').update(s).digest('hex');
export async function startSyntheticPeer({runtimeDir,port=17443,wsModule=process.env.UNIFIED_PEER_WS_MODULE}) {
 const wsImport=await import(pathToFileURL(wsModule || '/missing-isolated-ws-module').href);
 const WebSocketServer=wsImport.WebSocketServer || wsImport.default?.WebSocketServer || wsImport.default?.Server;
 if(!runtimeDir)throw Error('runtimeDir required');
 runtimeDir=resolve(runtimeDir);
 if(process.env.GITHUB_ACTIONS==='true'&&(!process.env.RUNNER_TEMP||!runtimeDir.startsWith(resolve(process.env.RUNNER_TEMP)+'/')))throw Error('CI peer runtime must be a child of RUNNER_TEMP');
 mkdirSync(runtimeDir,{recursive:true,mode:0o700});chmodSync(runtimeDir,0o700);
 // Refuse reuse: a fresh identity/key per process, never overwrite another run.
 if(existsSync(join(runtimeDir,'peer-key.pem')))throw Error('use a fresh isolated runtime directory');
 const keyPath=join(runtimeDir,'peer-key.pem'),certPath=join(runtimeDir,'peer-cert.pem');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyPath,'-out',certPath,'-days','1','-subj','/CN=synthetic-avd-peer'],{stdio:'pipe'});
 const cert=readFileSync(certPath),fp=sha(new X509Certificate(cert).raw),instanceId='desktop-'+randomBytes(16).toString('hex');
 const deviceId='device-'+randomBytes(16).toString('hex'),credential=deviceId+'.'+randomBytes(32).toString('hex'),secret=randomBytes(32).toString('hex');
 const vaultId='vault-synthetic-unified',noteId='kn-synthetic-initial',name='Synthetic Unified Library';
 const docs=new Map(),changes=[],receipts=new Map(),hintClients=new Set();let seq=0,paired=false,deviceLabel='Synthetic Phone';
 const evidence={scope:'synthetic protocol peer; not real desktop executable or home LAN',tcpAccepted:0,tlsAccepted:0,tlsErrors:[],requests:[],writes:[],desktopAdds:0,wsConnections:[],wsPings:0,wsPongs:0,hintsSent:0};
 const evidencePath=join(runtimeDir,'peer-evidence.json'),statePath=join(runtimeDir,'peer-state.json'),controlPath=join(runtimeDir,'control.json');
 const atomic=(path,value)=>{writeFileSync(path+'.tmp',JSON.stringify(value,null,2),{mode:0o600});renameSync(path+'.tmp',path);};
 const flush=()=>{atomic(evidencePath,evidence);atomic(statePath,{scope:evidence.scope,instanceId,vaultId,notes:[...docs.values()],seq,paired});};
 function put(id,title,content,deleted=false){seq++;const doc={noteId:id,vaultId,title,relativePath:title+'.md',content,revision:'r-'+seq,resources:[],deleted};docs.set(id,doc);changes.push({seq,noteId:id,vaultId,revision:doc.revision,deleted});for(const ws of hintClients){if(ws.readyState===1){ws.send(JSON.stringify({kind:'knowledgeChanged',vaultId,cursor:'k:'+seq}));evidence.hintsSent++;}}flush();return doc;}
 put(noteId,'Synthetic Desktop Note','# Synthetic Desktop Note\n\nOriginal desktop text.\n');
 const caps={contentVersion:1,capabilities:{noteRead:true,noteWrite:true,noteChanges:true,noteAttachments:false},replicaManifest:{version:1,resourceIdentity:'scoped-target-alias',bodyEncoding:'utf-8'},limits:{pageSize:100,noteBytes:4194304}};
 const catalog={scopeSelectionVersion:1,reusableProofVersion:1,materials:[],knowledge:[{vaultId,displayName:name,activeInDesktop:true,available:true,readGranted:true,writeGranted:true,ingestGranted:false}]};
 const server=https.createServer({key:readFileSync(keyPath),cert,minVersion:'TLSv1.2'},async(req,res)=>{
  let pathname;try{pathname=new URL(req.url,'https://synthetic.invalid').pathname;}catch{res.writeHead(400).end();return;}
  // Never collect headers, query strings, credentials, request bodies or arbitrary errors.
  const event={method:req.method,path:pathname,status:0};if(evidence.requests.length<600)evidence.requests.push(event);
  const send=(status,body)=>{event.status=status;res.writeHead(status,{'content-type':'application/json','x-luckyray-scope-protocol':'1'});res.end(JSON.stringify(body));flush();};
  try{
   if(req.method==='GET'&&pathname==='/v1/hello')return send(200,{protocolVersion:1,instanceId,certificateFingerprint:fp,displayName:'Synthetic Protocol Peer',platform:'windows',appVersion:'synthetic-only',capabilities:{pairing:true,authenticatedEvents:true,deviceRevocation:true,runs:false}});
   let body={};if(['POST','PATCH','DELETE'].includes(req.method)){let bytes=0,chunks=[];for await(const c of req){bytes+=c.length;if(bytes>5*1024*1024)return send(413,{code:'INPUT_TOO_LARGE'});chunks.push(c);}body=JSON.parse(Buffer.concat(chunks).toString()||'{}');}
   if(req.method==='POST'&&pathname==='/v1/pair'){
    if(paired||body.secret!==secret||body.fingerprint!==fp||typeof body.deviceLabel!=='string'||!body.deviceLabel.length||body.deviceLabel.length>80)return send(403,{code:'PAIR_INVALID'});
    paired=true;deviceLabel=body.deviceLabel;return send(200,{protocolVersion:1,deviceId,credential});
   }
   if(!paired||req.headers.authorization!=='Bearer '+credential)return send(401,{code:'AUTH_REVOKED'});
   if(pathname==='/v1/session')return send(200,{ok:true,protocolVersion:1,deviceId,deviceLabel});
   if(pathname==='/v1/services/libraries')return send(200,catalog);
   if(pathname==='/v1/services')return send(200,{catalogVersion:1,desktopInstanceId:instanceId,services:{knowledge:{version:1}},operations:{'knowledge.createUnique':{state:'unsupported'}}});
   if(pathname==='/v1/capabilities')return send(200,caps);
   if(pathname==='/v1/vaults')return send(200,{items:[{vaultId,name}],activeVaultId:vaultId});
   const query=new URL(req.url,'https://synthetic.invalid').searchParams;
   if(req.headers['x-luckyray-knowledge-vault']!==vaultId||((query.has('vault')&&query.get('vault')!==vaultId)||(body.vaultId&&body.vaultId!==vaultId)))return send(403,{code:'SCOPE_MISMATCH'});
   if(pathname==='/v1/notes'&&req.method==='GET')return send(200,{items:[...docs.values()].filter(n=>!n.deleted).map(({content,resources,...n})=>n),snapshotSeq:seq,hasMore:false,nextId:null});
   if(pathname==='/v1/sync/changes')return send(200,{changes:changes.filter(c=>c.seq>Number(query.get('after')||0)),cursor:seq,hasMore:false});
   const match=pathname.match(/^\/v1\/notes\/([a-zA-Z0-9_-]+)(\/replica-manifest)?$/),id=match?.[1];
   if(match&&req.method==='GET'){
    const doc=docs.get(id);if(!doc)return send(404,{code:'NOTE_NOT_FOUND'});
    if(match[2])return send(200,{schemaVersion:1,vaultId,noteId:id,revision:doc.revision,body:{sha256:sha(doc.content),sizeBytes:Buffer.byteLength(doc.content),encoding:'utf-8'},resourceIdentity:'scoped-target-alias',resources:[],complete:true});
    return send(200,doc);
   }
   if((match&&['PATCH','DELETE'].includes(req.method))||(pathname==='/v1/notes'&&req.method==='POST')){
    if(!body.opId||!body.noteId||body.vaultId!==vaultId||(id&&id!==body.noteId))return send(400,{code:'NOTE_INPUT_INVALID'});
    const serialized=JSON.stringify(body),cached=receipts.get(body.opId);if(cached)return send(cached.serialized===serialized?200:409,cached.serialized===serialized?cached.receipt:{code:'OP_REUSE_MISMATCH'});
    const old=docs.get(body.noteId);if((old&&body.expectedRevision!==old.revision)||(!old&&body.kind!=='create'))return send(409,{code:'REVISION_CONFLICT'});
    const doc=put(body.noteId,body.title??old?.title,body.content??old?.content,body.kind==='delete'),receipt={opId:body.opId,document:doc};
    receipts.set(body.opId,{serialized,receipt});evidence.writes.push({noteId:doc.noteId,revision:doc.revision,kind:body.kind,contentSha256:sha(doc.content)});return send(200,receipt);
   }
   return send(404,{code:'UNSUPPORTED_SYNTHETIC_ROUTE'});
  }catch{send(400,{code:'SYNTHETIC_REQUEST_INVALID'});}
 });
 const wss=new WebSocketServer({noServer:true,maxPayload:65536});
 server.on('upgrade',(req,socket,head)=>{
  const path=new URL(req.url,'https://synthetic.invalid').pathname;
  if(!paired||req.headers.authorization!=='Bearer '+credential||!['/v1/events','/v1/services/events/stream'].includes(path)||(req.headers['x-luckyray-knowledge-vault']&&req.headers['x-luckyray-knowledge-vault']!==vaultId)){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
  wss.handleUpgrade(req,socket,head,ws=>{evidence.wsConnections.push({path});if(path==='/v1/services/events/stream')hintClients.add(ws);ws.on('ping',()=>{evidence.wsPings++;flush();});ws.on('pong',()=>{evidence.wsPongs++;flush();});ws.on('close',()=>hintClients.delete(ws));ws.on('error',()=>{});flush();});
 });
 const heartbeat=setInterval(()=>{for(const ws of wss.clients)if(ws.readyState===1)ws.ping();},5000);
 server.on('connection',()=>{evidence.tcpAccepted++;flush();});server.on('secureConnection',()=>{evidence.tlsAccepted++;flush();});
 server.on('tlsClientError',e=>{if(evidence.tlsErrors.length<30)evidence.tlsErrors.push({code:/^[A-Z0-9_]+$/.test(e.code||'')?e.code:'TLS_ERROR'});flush();});
 await new Promise((r,j)=>{server.once('error',j);server.listen(port,'127.0.0.1',r);});port=server.address().port;
 const pairingPath=join(runtimeDir,'pairing.json');atomic(pairingPath,{v:1,name:'Synthetic Protocol Peer',instance:instanceId,ip:'10.0.2.2',port,secret,fp});
 const ready={port,instanceId,vaultId,noteId,pairingPath,controlPath,evidencePath,statePath};atomic(join(runtimeDir,'ready.json'),ready);
 let lastControl='';const timer=setInterval(()=>{try{const raw=readFileSync(controlPath,'utf8');if(raw===lastControl)return;lastControl=raw;const c=JSON.parse(raw);if(c.action==='add-note'){put('kn-synthetic-added','Synthetic Added Desktop Note','# Synthetic Added Desktop Note\n\nCreated after phone enrollment.\n');evidence.desktopAdds++;flush();}}catch{}},100);
 return {ready,close:async()=>{clearInterval(timer);clearInterval(heartbeat);for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));}};
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){const args=process.argv.slice(2);const get=n=>args[args.indexOf(n)+1];const peer=await startSyntheticPeer({runtimeDir:get('--runtime-dir'),port:Number(get('--port')||17443)});console.log('SYNTHETIC_PEER_READY');for(const sig of ['SIGTERM','SIGINT'])process.on(sig,async()=>{await peer.close();process.exit(0);});}
