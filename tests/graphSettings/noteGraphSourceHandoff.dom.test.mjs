// Executes the exact source-handoff hooks extracted from LegacyStillKnowledge
// inside a small React harness. This is NOT the full Notes UI or native switcher.
// Extraction keeps the production decisions under test without exporting or
// changing the private component; the library authority is a deferred seam.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(repo+'/package.json');
const {build}=createRequire(require.resolve('vite/package.json'))('esbuild');
const {JSDOM}=(process.env.LR_DOM_TEST_TOOLS?createRequire(path.join(process.env.LR_DOM_TEST_TOOLS,'__test.cjs')):require)('jsdom');
const dir=await mkdtemp(path.join(repo,'tests/.source-handoff-'));
const sourceText=await readFile(repo+'/src/still/StillCollection.tsx','utf8');
const between=(start,end)=>{const a=sourceText.indexOf(start),b=sourceText.indexOf(end,a);assert.ok(a>=0&&b>a,'production hook markers exist');return sourceText.slice(a,b);};
const init=between('  const [source, setSourceState] = useState<"local" | "desktop">','  // R4.1/R4.2:');
const handoff=between('  const sharedSourceChoice = useSyncExternalStore','  useEffect(() => { desktopCtrl.selectVault');
const manual=between('            onSelect={async (id, isCurrent) => {','            }}\n            directory={<DirectoryContents').replace('            onSelect={async (id, isCurrent) => {','');
const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://synthetic.invalid/'});
for(const key of ['window','document','HTMLElement','Event','MouseEvent','navigator'])Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
let library,choice,libraryListeners=new Set(),requests=[],commits=[];
const publish=()=>{for(const fn of libraryListeners)fn();};
globalThis.__handoffLibraries={subscribe:fn=>{libraryListeners.add(fn);return()=>libraryListeners.delete(fn);},snapshot:()=>library,switchTo(instance,kind,vault,live){return new Promise((resolve,reject)=>{requests.push({instance,kind,vault,live,finish(ok=true){if(!ok){reject(Error('synthetic denied'));return;}if(!live()){resolve(false);return;}commits.push({instance,vault});library={...library,vault};publish();resolve(true);}});});}};
try {
  await build({stdin:{contents:`import {useEffect,useRef,useState,useSyncExternalStore} from 'react';import {noteSourceSelection} from './src/services/noteSourceSelection';export {noteSourceSelection};let rememberedSource='local';const desktopLibraries=globalThis.__handoffLibraries;const selectedLibraryReadable=(state)=>state.phase==='ready'&&state.catalog.knowledge.some(row=>row.vaultId===state.vault&&row.available&&row.readGranted);export function Harness({instanceId='owner',active=true}){${init}const currentInstanceRef=useRef(instanceId);currentInstanceRef.current=instanceId;const libraries=useSyncExternalStore(desktopLibraries.subscribe,desktopLibraries.snapshot);const selectedVault=libraries.catalog?.scopeSelectionVersion===1?libraries.vault:undefined;${handoff}const setSelectedIds=()=>{},setSelecting=()=>{};globalThis.__manualPick=async(id,isCurrent=()=>true)=>{${manual}};return <><output id="gate">{JSON.stringify({source,gatedVault,graphScopeReadable,pendingGraphScope,choice:sharedSourceChoice.selection})}</output><button id="local" onClick={()=>setSource('local')}>本机</button><button id="desktop" onClick={()=>setSource('desktop')}>电脑</button></>;}`,resolveDir:repo,loader:'tsx'},outfile:dir+'/harness.mjs',bundle:true,format:'esm',platform:'node',jsx:'automatic',plugins:[{name:'react',setup(b){b.onResolve({filter:/^(react|react\/jsx-runtime)$/},a=>({path:pathToFileURL(require.resolve(a.path)).href,external:true}));}}]});
  const React=await import(pathToFileURL(require.resolve('react')).href),{act}=React;
  const {createRoot}=await import(pathToFileURL(require.resolve('react-dom/client')).href);
  const {Harness,noteSourceSelection}=await import(pathToFileURL(dir+'/harness.mjs').href);choice=noteSourceSelection;
  const root=createRoot(document.getElementById('root'));let key=0;
  const gate=()=>JSON.parse(document.getElementById('gate').textContent);
  const reset=async(vault='B',instance='owner')=>{await act(async()=>root.render(null));requests=[];commits=[];library={phase:'ready',vault:'A',catalog:{scopeSelectionVersion:1,knowledge:['A','B','C'].map(vaultId=>({vaultId,available:true,readGranted:true}))}};choice.select({kind:'desktop',instanceId:instance,vaultId:vault});await act(async()=>root.render(React.createElement(Harness,{key:++key})));};
  await reset();assert.equal(requests.length,1);assert.equal(gate().gatedVault,'B');assert.equal(gate().graphScopeReadable,false,'pending Graph B must never admit selected A');assert.equal(gate().pendingGraphScope,true);
  await act(async()=>requests[0].finish());assert.equal(gate().gatedVault,'B');assert.equal(gate().graphScopeReadable,true);assert.equal(choice.snapshot().selection.vaultId,'B');assert.deepEqual(commits,[{instance:'owner',vault:'B'}]);
  await reset();await act(async()=>requests[0].finish(false));assert.equal(gate().gatedVault,'B');assert.equal(gate().graphScopeReadable,false,'failed B selection remains gated, never falls back to A');assert.equal(choice.snapshot().selection.vaultId,'B');
  await reset();const old=requests[0];await act(async()=>document.getElementById('local').click());assert.equal(gate().source,'local');assert.equal(choice.snapshot().selection.kind,'legacy');assert.equal(old.live(),false,'a newer local choice retires the old B intent');await act(async()=>old.finish());assert.deepEqual(commits,[]);assert.equal(library.vault,'A');assert.equal(choice.snapshot().selection.kind,'legacy');
  await reset();let manualResult;await act(async()=>{manualResult=globalThis.__manualPick('C').catch(error=>error);});assert.equal(requests.at(-1).vault,'C');await act(async()=>requests.at(-1).finish(false));await manualResult;await act(async()=>{library={...library};publish();});assert.equal(gate().gatedVault,'B','failed manual C preserves the earlier explicit B scope');assert.equal(gate().graphScopeReadable,false,'failed manual switch cannot expose old A');assert.equal(choice.snapshot().selection.vaultId,'B');
  await reset();await act(async()=>{manualResult=globalThis.__manualPick('C');});await act(async()=>requests.at(-1).finish());assert.equal(await manualResult,true);assert.equal(gate().gatedVault,'C');assert.equal(gate().graphScopeReadable,true);assert.equal(choice.snapshot().selection.vaultId,'C');
  await reset('B','other-owner');assert.equal(requests.length,0,'mismatched owner must not invoke a switch');assert.equal(gate().graphScopeReadable,false);assert.equal(gate().gatedVault,'B');assert.equal(choice.snapshot().selection.instanceId,'other-owner');
  await reset('A');assert.equal(requests.length,0);assert.equal(gate().graphScopeReadable,true);assert.equal(gate().pendingGraphScope,false);
  await act(async()=>root.render(null));requests=[];commits=[];library={phase:'idle',vault:'',catalog:null};choice.select({kind:'legacy'});await act(async()=>root.render(React.createElement(Harness,{key:++key,instanceId:''})));await act(async()=>document.getElementById('desktop').click());assert.equal(gate().source,'desktop');assert.deepEqual(choice.snapshot().selection,{kind:'desktop',instanceId:'',vaultId:''},'unpaired Desktop intent must not leave the shared source on legacy');assert.equal(requests.length,0);
  await act(async()=>root.unmount());assert.equal(libraryListeners.size,0);
  console.log('PASS extracted production Notes/Graph handoff hooks: pending B gates A; B success/failure; local cancels delayed B; different owner remains gated; manual C failure keeps B gated/success selects C; unpaired Desktop stays explicit; current scope stays stable. This is not full LegacyStillKnowledge rendering or native proof.');
}finally{dom.window.close();await rm(dir,{recursive:true,force:true});}
