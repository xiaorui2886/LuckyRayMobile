import test from "node:test";
import assert from "node:assert/strict";
import { EditorState, Transaction } from "@codemirror/state";
import { history } from "@codemirror/commands";
import { runEditorCommand } from "../src/presentation/still01/editor/editorCommands.ts";
import { withReadBackoff } from "../src/services/companionServices/readBackoff.ts";
import { callServices, ServicesError, type ServicesRequest } from "../src/services/companionServices/transport.ts";
import { ServiceRegistry } from "../src/services/companionServices/serviceRegistry.ts";
import { KnowledgeBrowseController } from "../src/still/kit/knowledgeBrowseController.ts";
const request: ServicesRequest = {instance:"A",method:"GET",operationId:"knowledge.registeredList",path:"/v1/services/knowledge/notes"};
const settle = async () => { for(let i=0;i<12;i++) await new Promise(r=>setImmediate(r)); };
function editor(doc="hello", anchor=0, head=doc.length) {
  let state=EditorState.create({doc, selection:{anchor,head},extensions:[history()]});
  let writes=0;
  const view={hasFocus:true,composing:false,compositionStarted:false,get state(){return state},dispatch(spec:any){
    const tr=spec instanceof Transaction?spec:state.update(spec);state=tr.state;if(tr.docChanged)writes++;
  }};
  return {view:view as any, get state(){return state},get writes(){return writes}};
}
test("toolbar wraps current selected text and native history undoes/redoes exactly once",()=>{
  const e=editor();assert.equal(runEditorCommand(e.view,"bold"),true);
  assert.equal(e.state.doc.toString(),"**hello**");assert.equal(e.state.sliceDoc(e.state.selection.main.from,e.state.selection.main.to),"hello");
  assert.equal(e.writes,1);assert.equal(runEditorCommand(e.view,"undo"),true);assert.equal(e.state.doc.toString(),"hello");
  assert.equal(runEditorCommand(e.view,"redo"),true);assert.equal(e.state.doc.toString(),"**hello**");assert.equal(e.writes,3);
});
test("wiki empty-pair caret stays inside; list commands act on complete lines",()=>{
  const e=editor("",0,0);runEditorCommand(e.view,"wiki");assert.equal(e.state.doc.toString(),"[[]]");assert.equal(e.state.selection.main.head,2);
  const lines=editor("one\ntwo");runEditorCommand(lines.view,"task");assert.equal(lines.state.doc.toString(),"- [ ] one\n- [ ] two");
  runEditorCommand(lines.view,"indent");assert.equal(lines.state.doc.toString(),"  - [ ] one\n  - [ ] two");
  runEditorCommand(lines.view,"outdent");assert.equal(lines.state.doc.toString(),"- [ ] one\n- [ ] two");
});
test("preedit, active composition, and title focus cause zero command writes",()=>{
  for(const field of ["composing","compositionStarted","hasFocus"]){const e=editor();e.view[field]=field!=="hasFocus";
    for(const command of ["undo","redo","wiki","bold","task"] as const) assert.equal(runEditorCommand(e.view,command),false);
    assert.equal(e.writes,0);assert.equal(e.state.doc.toString(),"hello");}
});
test("all HTTP429 body shapes are rate limits; arbitrary other bodies remain malformed",async()=>{
  for(const body of ["busy",null,{error:{code:"RATE_LIMITED"}},{code:"not-canonical"}]) await assert.rejects(callServices({request:async()=>({status:429,body})},request),{code:"RATE_LIMITED",status:429});
  await assert.rejects(callServices({request:async()=>({status:500,body:"bad"})},request),{code:"MALFORMED_RESPONSE",status:500});
});
test("read cooldown retries once then recovers; mutations never replay; owners are isolated",async()=>{
  let time=0;const calls:string[]=[];const delays:number[]=[];
  const t=withReadBackoff({request:async r=>{calls.push(r.instance+':'+r.method);return {status:calls.length===1?429:200,body:{}}}}, {now:()=>time,sleep:async ms=>{delays.push(ms);time+=ms}});
  assert.equal((await t.request(request)).status,200);assert.deepEqual(calls,["A:GET","A:GET"]);assert.deepEqual(delays,[2000]);
  let mutations=0;const m=withReadBackoff({request:async()=>{mutations++;return{status:429,body:{}}}}, {now:()=>time,sleep:async ms=>{time+=ms}});
  assert.equal((await m.request({...request,method:"POST"})).status,429);assert.equal(mutations,1);
  let failures=0;const permanent=withReadBackoff({request:async()=>{failures++;return{status:429,body:{}}}}, {now:()=>time,sleep:async ms=>{time+=ms}});
  assert.equal((await permanent.request(request)).status,429);assert.equal(failures,2);
  const before=time;await permanent.request({...request,instance:"B",method:"POST"});assert.equal(time,before);
});
function catalog(instance="A") {return {desktopInstanceId:instance,gatewayGeneration:1,permissionRevision:1,operations:{"knowledge.vaults":{state:"implemented"},"knowledge.registeredList":{state:"implemented"}}};}
test("parallel discovery joins; invalidation and A→B retire old adoption",async()=>{
  const tails:Array<(v:any)=>void>=[];const registry=new ServiceRegistry({request:()=>new Promise(resolve=>tails.push(resolve))});
  const a=registry.refreshAdopting("A"),b=registry.refreshAdopting("A");assert.equal(a,b);assert.equal(tails.length,1);
  registry.invalidate();const c=registry.refreshAdopting("A");assert.equal(tails.length,2);
  tails[0]({status:200,body:catalog()});await assert.rejects(a,/superseded/);
  tails[1]({status:200,body:catalog()});await c;assert.equal(registry.snapshot()?.desktopInstanceId,"A");
  const old=registry.refreshAdopting("A"),next=registry.refreshAdopting("B");assert.equal(tails.length,4);
  tails[3]({status:200,body:catalog("B")});await next;tails[2]({status:200,body:catalog()});await assert.rejects(old,/superseded/);assert.equal(registry.snapshot()?.desktopInstanceId,"B");
});
function browserHarness(){
  let error:ServicesError|null=null;
  const registry={refreshAdopting:async()=>catalog(),operation:()=>({state:"implemented"}),snapshot:()=>catalog(),invalidate(){}};
  const knowledge={vaults:async()=>({items:[{vaultId:"v",displayName:"Vault",activeInDesktop:true,readGranted:true}]}),registeredList:async()=>{if(error)throw error;return{items:[{noteId:"n",title:"Kept",revision:"r"}],hasMore:true,nextAfterId:"n"}}};
  const controller=new KnowledgeBrowseController({registry,knowledge,debounceMs:0} as any);
  controller.setConnection({paired:true,connected:true,instanceId:"A",isLive:()=>true});
  return {controller,setError:(e:ServicesError|null)=>{error=e}};
}
test("edit→Back fast revalidation and page2 rate failures retain last-good same-query rows",async()=>{
  const h=browserHarness();await settle();assert.equal(h.controller.snapshot().phase,"ready");
  h.setError(new ServicesError("RATE_LIMITED",429));h.controller.fastRevalidate();await settle();
  assert.equal(h.controller.snapshot().rows[0]?.noteId,"n");assert.match(h.controller.snapshot().errorCode,/RATE_LIMITED/);
  h.setError(null);h.controller.fastRevalidate();await settle();assert.equal(h.controller.snapshot().phase,"ready");
  h.setError(new ServicesError("RATE_LIMITED",429));h.controller.loadMore();await settle();assert.equal(h.controller.snapshot().rows[0]?.noteId,"n");
});
for(const code of ["GRANT_REQUIRED","AUTH_REVOKED","SCOPE_DENIED","PAIRING_REQUIRED","SOURCE_CHANGED"] as const)test(`transient retention never preserves actionable rows after ${code}`,async()=>{
  const h=browserHarness();await settle();h.setError(new ServicesError(code,403));h.controller.fastRevalidate();await settle();assert.equal(h.controller.snapshot().rows.length,0);
});
test("refresh adopting a new vault never labels old rows as the new vault or revives them after429",async()=>{
  let vault="A",blocked=false;const snapshots:any[]=[];
  const registry={refreshAdopting:async()=>catalog(),operation:()=>({state:"implemented"}),snapshot:()=>catalog(),invalidate(){}};
  const knowledge={vaults:async()=>({items:[{vaultId:vault,displayName:vault,activeInDesktop:true,readGranted:true}]}),registeredList:async()=>{if(blocked)throw new ServicesError("RATE_LIMITED",429);return{items:[{noteId:"from-"+vault}],hasMore:false}}};
  const c=new KnowledgeBrowseController({registry,knowledge} as any);c.subscribe(s=>snapshots.push(s));c.setConnection({paired:true,connected:true,instanceId:"A",isLive:()=>true});await settle();
  assert.equal(c.snapshot().rows[0].noteId,"from-A");vault="B";blocked=true;c.refresh();await settle();
  assert.equal(c.snapshot().rows.length,0);assert.equal(c.snapshot().vaultId,"B");
  assert.ok(snapshots.filter(s=>s.vaultId==="B").every(s=>s.rows.length===0));
});
for(const state of ["notGranted","unsupported","temporarilyUnavailable"])test(`refresh ${state} catalog clears kept rows`,async()=>{
  let permission="implemented";
  const registry={refreshAdopting:async()=>catalog(),operation:()=>({state:permission}),snapshot:()=>catalog(),invalidate(){}};
  const knowledge={vaults:async()=>({items:[{vaultId:"v",activeInDesktop:true,readGranted:true}]}),registeredList:async()=>({items:[{noteId:"n"}],hasMore:false})};
  const c=new KnowledgeBrowseController({registry,knowledge} as any);c.setConnection({paired:true,connected:true,instanceId:"A",isLive:()=>true});await settle();assert.equal(c.snapshot().rows.length,1);
  permission=state;c.refresh();await settle();assert.equal(c.snapshot().rows.length,0);
});
test("consecutive same-query429 retain the trusted rows on each attempt",async()=>{
  const h=browserHarness();await settle();h.setError(new ServicesError("RATE_LIMITED",429));
  for(let i=0;i<3;i++){h.controller.fastRevalidate();await settle();assert.equal(h.controller.snapshot().rows[0]?.noteId,"n");}
});
test("vault read revocation retires certification before a query change",async()=>{
  let granted=true,lists=0;
  const registry={refreshAdopting:async()=>catalog(),operation:()=>({state:"implemented"}),snapshot:()=>catalog(),invalidate(){}};
  const knowledge={vaults:async()=>({items:[{vaultId:"v",activeInDesktop:true,readGranted:granted}]}),registeredList:async()=>{lists++;return{items:[{noteId:"n"}],hasMore:false}}};
  const c=new KnowledgeBrowseController({registry,knowledge,debounceMs:0} as any);c.setConnection({paired:true,connected:true,instanceId:"A",isLive:()=>true});await settle();assert.equal(lists,1);
  granted=false;c.refresh();await settle();c.setQuery("hello");await new Promise(r=>setTimeout(r,10));await settle();assert.equal(lists,1);assert.equal(c.snapshot().rows.length,0);
});
test("successful recovery resets429 escalation without erasing a newer concurrent signal",async()=>{
  let now=0,status=429,calls=0;const waits:number[]=[];
  const t=withReadBackoff({request:async()=>{calls++;return{status:calls%2===0?200:status,body:{}}}}, {now:()=>now,sleep:async ms=>{waits.push(ms);now+=ms}});
  await t.request(request);await t.request(request);assert.deepEqual(waits,[2000,2000]);
});
test("an older successful request cannot cancel a newer concurrent429 cooldown",async()=>{
  let now=0;const tails:Array<(v:any)=>void>=[];const waits:number[]=[];
  const t=withReadBackoff({request:()=>new Promise(resolve=>tails.push(resolve))},{now:()=>now,sleep:async ms=>{waits.push(ms);now+=ms}});
  const old=t.request({...request,method:"POST"}),limited=t.request({...request,method:"POST"});
  tails[1]({status:429,body:{}});await limited;tails[0]({status:200,body:{}});await old;
  const read=t.request(request);await settle();assert.deepEqual(waits,[2000]);tails[2]({status:200,body:{}});await read;
});

// Wiring contracts, not browser-runtime claims. Real pan/route/IME behavior is
// gated separately by the opt-in Windows matrix and its screenshots.
test("folder browser cases select Desktop before interpreting rows as folder readiness",async()=>{
  const {readFileSync}=await import('node:fs');
  const qa=readFileSync(new URL('../scripts/qa/knowledgeNavigationRepair.test.mjs',import.meta.url),'utf8');
  for(const name of ['N1-folder-rerender','N2-late-folder']) {
    const body=qa.slice(qa.indexOf(`await run('${name}'`));
    const setup=body.indexOf('await selectDesktopFolders(page,evidence)');
    assert.ok(setup>=0&&setup<body.indexOf("await folder(page,"));
  }
  assert.match(qa,/getByRole\('button', \{name:'电脑',exact:true\}\)\.tap\(\)/);
  assert.match(qa,/desktopSetup\.directories\.length>0/);
  assert.match(qa,/page\.locator\(cards\)\.count\(\)/);
});
test("horizontal editor toolbar contains overscroll locally without cancelling root gestures",async()=>{
  const {readFileSync}=await import('node:fs');
  const css=readFileSync(new URL('../src/presentation/still01/still.css',import.meta.url),'utf8');
  const rule=css.match(/\.st-reader-tools\.st-editor-tools\{([^}]+)\}/)?.[1]||'';
  assert.match(rule,/overflow-x:auto/);assert.match(rule,/touch-action:pan-x/);
  assert.match(rule,/overscroll-behavior-x:contain/);
  assert.equal((css.match(/overscroll-behavior-x:contain/g)||[]).length,1);
});
test("touch regression retains both-edge real pans and distinguishes history loss from app failure",async()=>{
  const {readFileSync}=await import('node:fs');
  const qa=readFileSync(new URL('../scripts/qa/knowledgeNavigationRepair.test.mjs',import.meta.url),'utf8');
  assert.match(qa,/for\(let i=0;i<4;i\+\+\)await swipe\('left'\)/);
  assert.match(qa,/for\(let i=0;i<4;i\+\+\)await swipe\('right'\)/);
  assert.match(qa,/Input\.dispatchTouchEvent/);
  assert.match(qa,/state\.url,gestureBaseline\.url/);
  assert.match(qa,/state\.route,gestureBaseline\.route/);
  assert.match(qa,/state\.selection,gestureBaseline\.selection/);
  assert.match(qa,/page\.on\('framenavigated'/);assert.match(qa,/page\.on\('crash'/);
  assert.match(qa,/\['pageshow', 'pagehide', 'popstate', 'hashchange'\]/);
  assert.match(qa,/toolbarCount:document\.querySelectorAll/);
});

test("diagnostic baseline removes exactly one generated toolbar declaration and preserves all other CSS",async()=>{
  const {withoutToolbarOverscroll}=await import('../scripts/qa/navigationBoundaryVariant.mjs');
  const {readFileSync}=await import('node:fs');
  const css=readFileSync(new URL('../src/presentation/still01/still.css',import.meta.url),'utf8');
  assert.equal(withoutToolbarOverscroll(css),css.replace(';overscroll-behavior-x:contain',';'));
  assert.throws(()=>withoutToolbarOverscroll('body{overscroll-behavior-x:contain}'));
  assert.throws(()=>withoutToolbarOverscroll('.st-reader-tools.st-editor-tools{touch-action:pan-x}'));
  assert.throws(()=>withoutToolbarOverscroll(css+css));
  const spaced='.st-reader-tools.st-editor-tools { touch-action: pan-x; overscroll-behavior-x: contain; }';
  assert.equal(withoutToolbarOverscroll(spaced),'.st-reader-tools.st-editor-tools { touch-action: pan-x;  }');
});

test("QA single-document isolation prunes only initial about:blank once and records surviving entry",async()=>{
  const {isolateFixtureHistory}=await import('../scripts/qa/navigationHistoryIsolation.mjs');
  const calls:string[]=[];let reads=0;
  const cdp={send:async(method:string)=>{calls.push(method);if(method==='Page.resetNavigationHistory')return {};
    return reads++===0?{currentIndex:1,entries:[{id:10,url:'about:blank'},{id:11,url:'http://127.0.0.1:1234/'}]}:{currentIndex:0,entries:[{id:11,url:'http://127.0.0.1:1234/'}]};}};
  const e=await isolateFixtureHistory(cdp,'http://127.0.0.1:1234');
  assert.equal(e.outcome,'READY');assert.equal(e.before.entries.length,2);assert.equal(e.after.entries[0].id,11);
  assert.deepEqual(calls,['Page.getNavigationHistory','Page.resetNavigationHistory','Page.getNavigationHistory']);
});
test("QA history isolation refuses unexpected history and unsupported reset without retry",async()=>{
  const {isolateFixtureHistory}=await import('../scripts/qa/navigationHistoryIsolation.mjs');
  let resets=0;
  await assert.rejects(isolateFixtureHistory({send:async(method:string)=>{
    if(method==='Page.resetNavigationHistory')resets++;
    return {currentIndex:1,entries:[{id:1,url:'https://unrelated.invalid/'},{id:2,url:'http://127.0.0.1/'}]};
  }},'http://127.0.0.1'),/HISTORY_ISOLATION_BLOCKED/);assert.equal(resets,0);
  const evidence:any={};
  await assert.rejects(isolateFixtureHistory({send:async(method:string)=>{
    if(method==='Page.resetNavigationHistory'){resets++;throw new Error('method not supported');}
    return {currentIndex:0,entries:[{id:2,url:'http://127.0.0.1/'}]};
  }},'http://127.0.0.1',evidence),/HISTORY_ISOLATION_BLOCKED/);
  assert.equal(resets,1);assert.equal(evidence.outcome,'BLOCKED');
});
