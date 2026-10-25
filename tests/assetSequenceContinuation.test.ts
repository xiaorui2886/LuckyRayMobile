import test from 'node:test';
import assert from 'node:assert/strict';
import { AssetSequenceSession } from '../src/still/kit/assetSequence.ts';
const row=(id:string,owner='local')=>({route:owner==='local'?`local:${id}`:`desktop:${owner}:${id}`,title:id,thumbnail:'',kind:'image'});
const deferred=<T>()=>{let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};};
test('continues list order beyond loaded page with one request for rapid gestures', async()=>{
 let calls=0;const gate=deferred<any>();const s=new AssetSequenceSession([row('z'),row('a')],1,true,async page=>{calls++;assert.equal(page,2);return gate.promise},()=>true);
 const a=s.neighbor('local:a',1),b=s.neighbor('local:a',1);assert.equal(calls,1);assert.equal(s.snapshot().loading,true);
 gate.resolve({items:[row('a'),row('m')],hasMore:false});assert.equal((await a)?.route,'local:m');assert.equal((await b)?.route,'local:m');assert.deepEqual(s.snapshot().items.map(r=>r.title),['z','a','m']);assert.equal(s.snapshot().loading,false);
 assert.equal(await s.neighbor('local:m',1),undefined);assert.equal(calls,1);assert.equal((await s.neighbor('local:m',-1))?.route,'local:a');
});
test('failed page retains current content and retries same page',async()=>{
 const pages:number[]=[];const s=new AssetSequenceSession([row('a')],2,true,async page=>{pages.push(page);if(pages.length===1)throw new Error('offline');return {items:[row('b')],hasMore:false}},()=>true);
 assert.equal(await s.neighbor('local:a',1),undefined);assert.match(s.snapshot().error,/重试/);assert.equal(s.snapshot().items[0].route,'local:a');
 assert.equal((await s.neighbor('local:a',1))?.route,'local:b');assert.deepEqual(pages,[3,3]);assert.equal(s.snapshot().error,'');
});
test('old owner/query response cannot enter a newer source',async()=>{
 let current=true;const gate=deferred<any>();const s=new AssetSequenceSession([row('a','pc-a')],1,true,()=>gate.promise,()=>current);
 const result=s.neighbor('desktop:pc-a:a',1);current=false;gate.resolve({items:[row('b','pc-a')],hasMore:true});assert.equal(await result,undefined);assert.deepEqual(s.snapshot().items.map(r=>r.title),['a']);assert.equal(s.snapshot().hasMore,false);
});
test('mixed owner and repeated empty continuation fail closed without loops',async()=>{
 for(const items of [[row('b','pc-b')],[],[row('a','pc-a')]]){
  let calls=0;const s=new AssetSequenceSession([row('a','pc-a')],1,true,async()=>{calls++;return {items,hasMore:true}},()=>true);
  assert.equal(await s.neighbor('desktop:pc-a:a',1),undefined);assert.equal(calls,1);assert.ok(s.snapshot().error);assert.equal(s.snapshot().items.length,1);
 }
});
test('retirement fences in-flight work; removed asset is never traversed',async()=>{
 const gate=deferred<any>();const s=new AssetSequenceSession([row('a'),row('b'),row('c')],1,true,()=>gate.promise,()=>true);
 s.remove('local:b');assert.equal((await s.neighbor('local:a',1))?.route,'local:c');const pending=s.loadNext();s.retire();gate.resolve({items:[row('d')],hasMore:false});await pending;assert.deepEqual(s.snapshot().items.map(r=>r.title),['a','c']);
});

test('source-provided non-consecutive continuation is honored',async()=>{
 const pages:number[]=[];const s=new AssetSequenceSession([row('a','pc')],1,true,async page=>{pages.push(page);return {items:[row(String(page),'pc')],hasMore:page===4,nextPage:page===4?9:null}},()=>true,4);
 await s.loadNext();await s.loadNext();assert.deepEqual(pages,[4,9]);assert.equal(s.snapshot().hasMore,false);
});

test('empty initial sequence cannot infer a source and never issues requests',async()=>{
 let calls=0;const s=new AssetSequenceSession([],0,true,async()=>{calls++;return {items:[row('a')],hasMore:true}},()=>true);
 await s.loadNext();await s.loadNext();assert.equal(await s.neighbor('local:a',1),undefined);assert.equal(calls,0);assert.equal(s.snapshot().hasMore,false);
});
test('late rejected request cannot overwrite retirement; stale failure retires',async()=>{
 for(const explicit of [true,false]){
  let reject!:(error:Error)=>void;let current=true;
  const s=new AssetSequenceSession([row('a')],1,true,()=>new Promise((_,fail)=>reject=fail),()=>current);
  const pending=s.loadNext();if(explicit)s.retire();else current=false;
  reject(new Error('offline'));await pending;
  assert.match(s.snapshot().error,/来源已变化/);assert.equal(s.snapshot().hasMore,false);assert.equal(s.snapshot().loading,false);
 }
});
