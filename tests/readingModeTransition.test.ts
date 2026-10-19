import test from 'node:test';
import assert from 'node:assert/strict';
import {settleReadingMode} from '../src/presentation/still01/editor/readingModeTransition.ts';
function harness(){let current=true,composing=false,activity=0,unsaved=false,commits=0,flushes=0;let release!:(ok:boolean)=>void;
 return {setCurrent:(v:boolean)=>{current=v},setComposing:(v:boolean)=>{composing=v},edit:()=>{activity++},setUnsaved:(v:boolean)=>{unsaved=v},release:(ok=true)=>release(ok),get commits(){return commits},get flushes(){return flushes},options:{isCurrent:()=>current,isComposing:()=>composing,activity:()=>activity,hasUnsaved:()=>unsaved,flush:()=>{flushes++;return new Promise<boolean>(r=>{release=r})},commit:()=>{commits++;activity++}}};}
test('reading waits for the real save receipt, then commits exactly once',async()=>{const h=harness();const p=settleReadingMode(h.options);assert.equal(h.commits,0);h.release();assert.equal(await p,true);assert.equal(h.commits,1)});
test('preedit/composition and hidden owners never start a save or switch',async()=>{for(const condition of ['current','composing']){const h=harness();if(condition==='current')h.setCurrent(false);else h.setComposing(true);assert.equal(await settleReadingMode(h.options),false);assert.equal(h.flushes,0);assert.equal(h.commits,0)}});
test('new input, newly pending save, composition and retired owner cancel a late reading request',async()=>{for(const change of ['input','unsaved','composition','retired']){const h=harness();const p=settleReadingMode(h.options);if(change==='input')h.edit();if(change==='unsaved')h.setUnsaved(true);if(change==='composition')h.setComposing(true);if(change==='retired')h.setCurrent(false);h.release();assert.equal(await p,false);assert.equal(h.commits,0)}});
test('failed saves keep the editor and its draft',async()=>{const h=harness();const p=settleReadingMode(h.options);h.release(false);assert.equal(await p,false);assert.equal(h.commits,0)});

test("rejected save promises cannot unmount the editor",async()=>{const h=harness();assert.equal(await settleReadingMode({...h.options,flush:async()=>{throw Error("save failed")}}),false);assert.equal(h.commits,0)});
