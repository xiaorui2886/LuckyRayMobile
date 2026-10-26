// Actual settings component, synthetic state only. No native/device claims.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(repo+'/package.json');
const {build}=createRequire(require.resolve('vite/package.json'))('esbuild');
const {JSDOM}=(process.env.LR_DOM_TEST_TOOLS?createRequire(path.join(process.env.LR_DOM_TEST_TOOLS,'__test.cjs')):require)('jsdom');
const dir=await mkdtemp(path.join(repo,'tests/.graph-settings-'));
const dom=new JSDOM('<!doctype html><button id="trigger">设置</button><div id="root"></div>',{url:'https://synthetic.invalid/'});
for(const key of ['window','document','HTMLElement','HTMLInputElement','Event','MouseEvent','KeyboardEvent','navigator'])Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
try {
  await build({entryPoints:[repo+'/src/features/graph/MobileGraphSettings.tsx'],outfile:dir+'/settings.mjs',bundle:true,format:'esm',platform:'node',jsx:'automatic',plugins:[{name:'react',setup(b){b.onResolve({filter:/^(react|react\/jsx-runtime)$/},a=>({path:pathToFileURL(require.resolve(a.path)).href,external:true}));}}]});
  const React=await import(pathToFileURL(require.resolve('react')).href),{act}=React;
  const {createRoot}=await import(pathToFileURL(require.resolve('react-dom/client')).href);
  const {MobileGraphSettings,defaultMobileGraphSettings}=await import(pathToFileURL(dir+'/settings.mjs').href);
  const root=createRoot(document.getElementById('root'));
  let state=defaultMobileGraphSettings(),playing=false,version=0,registrations=0,releases=0,dismiss,closedBy=-1;
  const render=()=>root.render(React.createElement(MobileGraphSettings,{value:state,onChange:next=>{state=next;render();},onClose:(()=>{const latest=version;return()=>{closedBy=latest;};})(),onReset:()=>{state=defaultMobileGraphSettings();render();},folders:['Long/Synthetic/Folder'],playing,onPlay:()=>{playing=true;render();},onStop:()=>{playing=false;render();},focusAvailable:false,registerOverlay:fn=>{registrations++;dismiss=fn;return()=>releases++;}}));
  const click=async element=>{assert.ok(element);await act(async()=>element.click());};
  const heading=text=>[...document.querySelectorAll('.mg-section-title')].find(b=>b.textContent===text);
  const named=name=>document.querySelector(`[aria-label="${name}"]`);
  const input=async(element,value)=>act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));});
  document.getElementById('trigger').focus();await act(async()=>render());
  const panel=document.querySelector('.mg-settings'),scroll=panel.querySelector('.mg-settings-scroll'),header=panel.querySelector('.mg-settings-actions');
  assert.equal(document.activeElement,panel);assert.equal(header.parentElement,panel);assert.equal(scroll.parentElement,panel);assert.equal(scroll.contains(header),false,'fixed heading is outside scrolling body');
  assert.equal(panel.querySelectorAll('section').length,4);assert.equal(panel.querySelectorAll('input[type=range]').length,8);assert.equal(panel.querySelectorAll('[role=switch]').length,9);
  for(const button of panel.querySelectorAll('.mg-section-title')){const body=document.getElementById(button.getAttribute('aria-controls'));assert.ok(body);assert.equal(body.hidden,button.getAttribute('aria-expanded')!=='true');assert.ok(button.querySelector('svg[aria-hidden=true]'));}
  const search=panel.querySelector('input[type=search]');search.focus();await input(search,'中文');version=1;await act(async()=>render());
  assert.equal(document.activeElement,search,'typing and refreshed callback identities retain input focus');assert.equal(state.query,'中文');assert.equal(registrations,1,'overlay registers only once per opening');
  await click(heading('筛选'));assert.equal(search.closest('.mg-section-body').hidden,true);await click(heading('筛选'));assert.equal(search.value,'中文');
  await click(heading('颜色组'));const add=panel.querySelector('.mg-text-button');await click(add);await input(named('颜色组 1 规则'),'tag:alpha');await click(add);await input(named('颜色组 2 规则'),'path:Beta');await click(named('上移颜色组 2'));assert.equal(state.colorGroups[0].query,'path:Beta');await click(named('删除颜色组 1'));assert.equal(state.colorGroups[0].query,'tag:alpha');
  while(state.colorGroups.length<16)await click(add);assert.equal(add.disabled,true);assert.equal(state.colorGroups.length,16);
  await click(heading('力度'));const ranges=[...panel.querySelectorAll('.mg-range')];assert.deepEqual(ranges.map(l=>l.firstElementChild.firstChild.textContent),['文字显示阈值','节点大小','连线粗细','中心引力','节点斥力','连线引力','连线长度','节点间距']);
  await input(ranges.at(-1).querySelector('input'),'75');assert.equal(state.nodeSpacing,75);assert.equal(ranges.at(-1).querySelector('input').style.getPropertyValue('--mg-range-fill'),'75%');
  await click(panel.querySelector('.mg-primary'));assert.equal(playing,true);await click(panel.querySelector('.mg-primary'));assert.equal(playing,false);
  await click(named('重置图谱设置'));assert.deepEqual(state,defaultMobileGraphSettings());assert.equal(registrations,1);
  version=2;await act(async()=>render());await act(async()=>dismiss());assert.equal(closedBy,2,'native back sees latest close callback');
  closedBy=-1;await act(async()=>panel.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));assert.equal(closedBy,2);
  await act(async()=>root.unmount());assert.equal(releases,1);assert.equal(document.activeElement,document.getElementById('trigger'),'dismiss restores connected trigger');
  console.log('PASS settings: full option parity, fixed header/body structure, collapse semantics, stable typing focus, groups/order/limit, ranges, playback/reset, latest back callback and focus restore.');
} finally {dom.window.close();await rm(dir,{recursive:true,force:true});}
