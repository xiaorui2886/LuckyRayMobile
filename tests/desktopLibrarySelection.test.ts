import test from "node:test";
import assert from "node:assert/strict";
import { DesktopLibraries, selectedLibraryReadable, type DesktopLibraryCatalog } from "../src/services/desktopLibraries.ts";
import { desktopAssetRoute, parseAssetRoute } from "../src/still/kit/materialOrganization.ts";
import { desktopIdentityOf, DesktopPageAuthority } from "../src/services/desktopPageAuthority.ts";
import { desktopThumbKey } from "../src/services/thumbnailQueue.ts";
function catalog(): DesktopLibraryCatalog { return {scopeSelectionVersion:1,
  materials:["a","b"].map((libraryId,i)=>({libraryId,displayName:libraryId,activeInDesktop:i===0,available:true,readGranted:true,writeGranted:true,ingestGranted:true})),
  knowledge:["x","y"].map((vaultId,i)=>({vaultId,displayName:vaultId,activeInDesktop:i===0,available:true,readGranted:true,writeGranted:false,ingestGranted:false}))}; }
const deferred = <T>() => { let resolve!: (v:T)=>void; const promise=new Promise<T>(r=>resolve=r);return {promise,resolve}; };
test("material and knowledge choices are independent and exact per desktop",async()=>{
 const store=new DesktopLibraries();await store.refresh("one",async()=>catalog());await store.refresh("two",async()=>catalog());
 store.select("one","materials","b");store.select("one","knowledge","y");
 assert.equal(store.snapshot("one").material,"b");assert.equal(store.snapshot("one").vault,"y");assert.equal(store.snapshot("two").material,"a");
});
test("catalog removal/revocation retains missing selection, retires epoch, never substitutes active",async()=>{
 const store=new DesktopLibraries();await store.refresh("one",async()=>catalog());store.select("one","materials","b");const epoch=store.snapshot("one").epoch;
 const removed=catalog();removed.materials=removed.materials.filter(x=>x.libraryId!=="b");await store.refresh("one",async()=>removed);
 assert.equal(store.snapshot("one").material,"b");assert.ok(store.snapshot("one").epoch>epoch);assert.equal(selectedLibraryReadable(store.snapshot("one"),"materials"),false);
 assert.throws(()=>store.select("one","materials","missing"));
});
test("a stale catalog response cannot overwrite newer permission truth",async()=>{
 const store=new DesktopLibraries(), late=deferred<DesktopLibraryCatalog>();const first=store.refresh("one",()=>late.promise);
 const denied=catalog();denied.materials[0].readGranted=false;await store.refresh("one",async()=>denied);late.resolve(catalog());await first;
 assert.equal(selectedLibraryReadable(store.snapshot("one"),"materials"),false);
});
test("network failure is not legacy fallback; explicit unsupported has no fabricated selection",async()=>{
 const store=new DesktopLibraries();await store.refresh("one",async()=>{throw Error("offline")});assert.equal(store.snapshot("one").phase,"error");assert.equal(selectedLibraryReadable(store.snapshot("one"),"materials"),false);
 await store.refresh("one",async()=>({scopeSelectionVersion:0,materials:[],knowledge:[]}));assert.equal(store.snapshot("one").phase,"legacy");assert.equal(store.snapshot("one").material,"");
});
test("route, thumbnail, and page identities include opaque library, legacy routes remain readable",()=>{
 const route=desktopAssetRoute("owner:a","same-id","库:b");assert.deepEqual(parseAssetRoute(route),{kind:"desktop",owner:"owner:a",assetId:"same-id",library:"库:b"});
 assert.equal(parseAssetRoute("desktop-library:o::id").kind,"unowned");
 assert.notEqual(desktopThumbKey("o","same","",false,"a"),desktopThumbKey("o","same","",false,"b"));
 const base={owner:"o",query:"",folder:"",tag:""};assert.notEqual(desktopIdentityOf({...base,library:"a"}),desktopIdentityOf({...base,library:"b"}));
 assert.deepEqual(parseAssetRoute(desktopAssetRoute("o","id")),{kind:"desktop",owner:"o",assetId:"id"});
});
test("late page from previous library cannot fill selected library or continue its paging",async()=>{
 const a=deferred<any>(),b=deferred<any>();const authority=new DesktopPageAuthority(async(_o,s)=>s.library==="a"?a.promise:b.promise,()=>{});
 const axes={query:"",folder:"",tag:""};authority.bind("o",{...axes,library:"a"});authority.bind("o",{...axes,library:"b"});
 b.resolve({items:[{desktopAssetId:"b"}],hasMore:false});await new Promise(r=>setTimeout(r,0));a.resolve({items:[{desktopAssetId:"a"}],hasMore:true});await new Promise(r=>setTimeout(r,0));
 assert.deepEqual(authority.snapshot().rows,[{desktopAssetId:"b"}]);assert.equal(authority.snapshot().hasMore,false);
});

test("known grant changes retire native domain before new catalog is exposed",async()=>{
 const store=new DesktopLibraries();await store.refresh("one",async()=>catalog());
 const gate=deferred<void>(),retired:string[]=[];store.setInvalidator(async(owner,kind)=>{retired.push(`${owner}:${kind}`);await gate.promise;});
 const next=catalog();next.materials[0].readGranted=false;const refresh=store.refresh("one",async()=>next);await new Promise(r=>setImmediate(r));
 assert.deepEqual(retired,["one:materials"]);assert.equal(store.snapshot("one").catalog?.materials[0].readGranted,true);
 gate.resolve();await refresh;assert.equal(selectedLibraryReadable(store.snapshot("one"),"materials"),false);
});

test("capability withdrawal never changes a prior explicit selection into legacy default",async()=>{
 const store=new DesktopLibraries();await store.refresh("one",async()=>catalog());store.select("one","materials","b");
 const retired:string[]=[];store.setInvalidator(async(_owner,kind)=>{retired.push(kind);});
 await store.refresh("one",async()=>({scopeSelectionVersion:0,materials:[],knowledge:[]}));
 assert.equal(store.snapshot("one").material,"b");assert.equal(selectedLibraryReadable(store.snapshot("one"),"materials"),false);assert.ok(retired.includes("materials"));
});

const tick = () => new Promise<void>(r=>setImmediate(r));
const rejectable = <T>() => { let resolve!: (v:T)=>void, reject!: (e:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject}; };
async function switchingStore() { const store=new DesktopLibraries(); await store.refresh('one',async()=>catalog());store.setInvalidator(async()=>{});return store; }
test('opening refresh then selecting waits before retirement, commits exact target', async()=>{
 const store=await switchingStore(), read=deferred<DesktopLibraryCatalog>();let retired=0;store.setInvalidator(async()=>{retired++;});
 const refresh=store.refresh('one',()=>read.promise);const choose=store.switchTo('one','materials','b');await tick();assert.equal(retired,0);
 read.resolve(catalog());await refresh;assert.equal(await choose,true);assert.equal(store.snapshot('one').material,'b');assert.equal(retired,1);
});
test('rapid A/B/A supersedes delayed success and does not publish B',async()=>{
 const store=await switchingStore(), gate=deferred<void>();let retired=0;store.setInvalidator(async()=>{retired++;await gate.promise;});
 const b=store.switchTo('one','materials','b');await tick();const a=store.switchTo('one','materials','a');gate.resolve();
 assert.equal(await b,false);assert.equal(await a,true);assert.equal(store.snapshot('one').material,'a');assert.equal(retired,1);
});
test('delayed failed switch rolls back exact scope, advances only affected domain and retry works',async()=>{
 const store=await switchingStore(), gate=rejectable<void>();const before=store.snapshot('one');store.setInvalidator(()=>gate.promise);
 const b=store.switchTo('one','materials','b');await tick();gate.reject(Error('CONTENT_OFFLINE'));await assert.rejects(b,/OFFLINE/);
 const after=store.snapshot('one');assert.equal(after.material,'a');assert.ok(after.materialsEpoch>before.materialsEpoch);assert.equal(after.knowledgeEpoch,before.knowledgeEpoch);
 store.setInvalidator(async()=>{});assert.equal(await store.switchTo('one','materials','b'),true);
});
test('independent domain intents both commit without cross-domain scope retirement',async()=>{
 const store=await switchingStore();const retired:string[]=[];store.setInvalidator(async(_owner,kind)=>{retired.push(kind);});
 assert.deepEqual(await Promise.all([store.switchTo('one','materials','b'),store.switchTo('one','knowledge','y')]),[true,true]);
 assert.equal(store.snapshot('one').material,'b');assert.equal(store.snapshot('one').vault,'y');assert.deepEqual(retired,['materials','knowledge']);
});
test('unmount guard and connection generation prevent stale completion even after reconnect same owner',async()=>{
 for(const mode of ['unmount','connection']) {const store=await switchingStore(),gate=deferred<void>();let live=true;store.setInvalidator(()=>gate.promise);store.observeConnection('one',true);
 const pending=store.switchTo('one','materials','b',()=>live);await tick();if(mode==='unmount')live=false;else {store.observeConnection('one',false);store.observeConnection('one',true);}
 gate.resolve();assert.equal(await pending,false);assert.equal(store.snapshot('one').material,'a');}
});
test('offline catalog refresh does not invalidate, fake empty, or switch cached selection',async()=>{
 const store=await switchingStore();let retired=0;store.setInvalidator(async()=>{retired++;});const read=rejectable<DesktopLibraryCatalog>();
 const refresh=store.refresh('one',()=>read.promise);const pending=store.switchTo('one','materials','b');read.reject(Error('offline'));await refresh;await assert.rejects(pending);
 assert.equal(retired,0);assert.equal(store.snapshot('one').material,'a');assert.equal(store.snapshot('one').catalog?.materials.length,2);
 await store.refresh('one',async()=>catalog());assert.equal(await store.switchTo('one','materials','b'),true);
});
test('new refresh failure after superseded retirement restarts exact current domain',async()=>{
 const store=await switchingStore(),gate=deferred<void>(),before=store.snapshot('one');store.setInvalidator(()=>gate.promise);
 const denied=catalog();denied.materials[0].readGranted=false;const old=store.refresh('one',async()=>denied);await tick();await store.refresh('one',async()=>{throw Error('offline');});gate.resolve();await old;
 assert.equal(store.snapshot('one').material,'a');assert.equal(store.snapshot('one').phase,'error');assert.ok(store.snapshot('one').materialsEpoch>before.materialsEpoch);assert.equal(store.snapshot('one').knowledgeEpoch,before.knowledgeEpoch);
});
test('catalog response arriving during invalidation preserves successful selected target',async()=>{
 const store=await switchingStore(),gate=deferred<void>();store.setInvalidator(()=>gate.promise);const choose=store.switchTo('one','materials','b');await tick();
 const refresh=store.refresh('one',async()=>catalog());gate.resolve();assert.equal(await choose,true);await refresh;assert.equal(store.snapshot('one').material,'b');assert.equal(store.snapshot('one').phase,'ready');
});
test('superseded delayed failure still restarts exact A when newest intent is A',async()=>{
 const store=await switchingStore(),gate=rejectable<void>(),before=store.snapshot('one');store.setInvalidator(()=>gate.promise);
 const b=store.switchTo('one','materials','b');await tick();const a=store.switchTo('one','materials','a');gate.reject(Error('CONTENT_OFFLINE'));await assert.rejects(b);assert.equal(await a,true);
 assert.equal(store.snapshot('one').material,'a');assert.ok(store.snapshot('one').materialsEpoch>before.materialsEpoch);assert.equal(store.snapshot('one').knowledgeEpoch,before.knowledgeEpoch);
});
test('revocation discovered by opening refresh rejects before any selection retirement',async()=>{
 const store=await switchingStore(),gate=deferred<DesktopLibraryCatalog>();let retired=0;store.setInvalidator(async()=>{retired++;});
 const refresh=store.refresh('one',()=>gate.promise);const choose=store.switchTo('one','materials','b');const denied=catalog();denied.materials[1].readGranted=false;gate.resolve(denied);await refresh;
 await assert.rejects(choose,/READ_NOT_GRANTED/);assert.equal(retired,0);assert.equal(store.snapshot('one').material,'a');
});
test('cancelled old catalog after same-owner reconnect cannot publish or overwrite new catalog',async()=>{
 const store=await switchingStore(),old=deferred<DesktopLibraryCatalog>();store.observeConnection('one',true);const pending=store.refresh('one',()=>old.promise);
 store.observeConnection('one',false);store.observeConnection('one',true);const fresh=catalog();fresh.materials[0].displayName='Fresh';await store.refresh('one',async()=>fresh);old.resolve(catalog());await pending;
 assert.equal(store.snapshot('one').catalog?.materials[0].displayName,'Fresh');
});
test('UI source contracts bind each domain only to its own retirement epoch',async()=>{
 const {readFile}=await import('node:fs/promises');
 const material=await readFile(new URL('../src/still/StillLibrary.tsx',import.meta.url),'utf8');
 const knowledge=await readFile(new URL('../src/still/StillCollection.tsx',import.meta.url),'utf8');
 assert.match(material,/\[desktopAuthority, conn\?\.paired, desktopOwner, library, libraries\.materialsEpoch\]/);
 assert.doesNotMatch(material,/libraries\.(?:epoch|knowledgeEpoch)/);
 // Graph handoff adds an exact-source gate, but must retain the Knowledge-only retirement epoch.
 assert.match(knowledge,/desktopCtrl\.selectVault\(gatedVault \|\| "", graphScopeReadable, libraries\.knowledgeEpoch\)/);
 assert.match(knowledge,/graphScopeReadable = !pendingGraphScope && selectedLibraryReadable\(libraries, 'knowledge'\)/);
 assert.match(knowledge,/gatedVault = pendingGraphScope.*requestedScope\.vaultId : selectedVault/);
 assert.doesNotMatch(knowledge,/libraries\.(?:epoch|materialsEpoch)/);
});

test('forced reconnect retires an in-flight same-library page without losing exact filters or exposing its late failure',async()=>{
 const first=rejectable<any>(),second=deferred<any>();let reads=0;const sent:any[]=[];
 const authority=new DesktopPageAuthority(async(owner,source,page)=>{sent.push({owner,...source,page});return ++reads===1?first.promise:second.promise;},()=>{});
 const source={library:'b',query:'portrait',folder:'folder-b',tag:'tag-b',kind:'image'};
 authority.bind('same-desktop',source);
 authority.revalidate(source,true);
 second.resolve({items:[{desktopAssetId:'fresh-b'}],hasMore:false});await tick();
 first.reject(Error('CONTENT_SOURCE_CHANGED'));await tick();
 assert.equal(reads,2);assert.deepEqual(sent[0],sent[1]);
 assert.deepEqual(authority.snapshot().rows,[{desktopAssetId:'fresh-b'}]);
 assert.equal(authority.snapshot().refreshing,false);assert.equal(authority.snapshot().error,'');
});
