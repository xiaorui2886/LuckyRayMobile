const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require(process.env.LR_JSDOM_MODULE||'jsdom');
const dom=new JSDOM('<div id="root"></div>',{url:'https://qa.invalid',pretendToBeVisual:true});
for(const k of ['window','document','HTMLElement','Element','Node','localStorage','Event','MouseEvent','KeyboardEvent'])global[k]=dom.window[k];
global.requestAnimationFrame=dom.window.requestAnimationFrame.bind(dom.window);global.cancelAnimationFrame=dom.window.cancelAnimationFrame.bind(dom.window);
window.matchMedia=()=>({matches:true,addEventListener(){},removeEventListener(){}});
const styles=document.createElement('style');styles.textContent=fs.readFileSync('src/presentation/still01/still.css','utf8')+'\n'+fs.readFileSync('src/still/kit/noteExperience.css','utf8');document.head.append(styles);
const {mount}=require(path.resolve(process.argv[2]));const delay=()=>new Promise(r=>setTimeout(r,50));
const text=t=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===t);const label=t=>document.querySelector(`[aria-label="${t}"]`);
async function click(b){assert.ok(b);b.click();await delay()}
(async()=>{let checks=0;const events=[];const root=mount(document.getElementById('root'),e=>events.push(e));await delay();
assert.equal(document.querySelectorAll('.st-folder-row').length,2);assert.equal(document.querySelector('nav.st-folder-breadcrumbs'),null);checks+=2;
await click(text('项目'));assert.equal(document.querySelectorAll('.st-folder-row').length,1);assert.equal(document.querySelector('[aria-current=location]').textContent,'项目');checks+=2;
await click(document.querySelector('.st-folder-row'));assert.equal(document.querySelector('[aria-current=location]').textContent,'参考');await click(text('项目'));assert.equal(document.querySelector('[aria-current=location]').textContent,'项目');checks+=2;
await click(text('全部笔记'));assert.equal(document.querySelector('nav.st-folder-breadcrumbs'),null);checks++;
const folder=document.querySelector('.st-folder-row'),note=document.querySelector('.st-note-row');assert.equal(window.getComputedStyle(folder).minHeight,'72px');assert.equal(window.getComputedStyle(note).minHeight,'72px');assert.equal(note.querySelector('small'),null);assert.equal(window.getComputedStyle(note.querySelector('.st-knowledge-note-symbol')).display,'flex');checks+=4;
await click(label('打开笔记列表'));assert.equal(events.at(-1),'browse');const icon=label('打开笔记列表').querySelector('svg');assert.ok(icon.querySelector('rect'));assert.equal(window.getComputedStyle(icon).position,'relative');assert.equal(window.getComputedStyle(icon).zIndex,'1');checks+=4;
const title=document.querySelector('.st-note-title'),body=document.querySelector('.st-note-editor'),surface=document.querySelector('.st-note-surface'),bottom=document.querySelector('.st-reader-bottom');
for(let i=0;i<3;i++){title.focus();await delay();assert.ok(surface.classList.contains('is-title-focused'));assert.equal(window.getComputedStyle(bottom).display,'none');body.focus();await delay();assert.ok(!surface.classList.contains('is-title-focused'));assert.notEqual(window.getComputedStyle(bottom).display,'none');checks+=4;}
Object.defineProperty(window,'innerHeight',{configurable:true,value:400});window.dispatchEvent(new Event('resize'));await delay();assert.ok(surface.classList.contains('has-editor-tools'));checks++;
title.focus();await delay();assert.ok(!surface.classList.contains('has-editor-tools'));assert.equal(window.getComputedStyle(bottom).display,'none');checks+=2;
title.blur();await delay();assert.ok(!surface.classList.contains('is-title-focused'));checks++;
await click(text('库管理'));let dialog=document.querySelector('[role=dialog]');assert.ok(dialog);assert.equal(dialog.querySelector('.st-folder-row'),null);assert.equal(dialog.querySelector('.st-folder-breadcrumbs'),null);assert.ok(text('合成库'));assert.ok(text('手机保存'));checks+=5;
await click(text('手机保存'));assert.equal(events.at(-1),'cache');await click(text('本机笔记'));assert.equal(events.at(-1),'local');assert.equal(document.querySelector('[role=dialog]'),null);checks+=3;
await click(text('库管理'));await click(text('合成库'));assert.equal(events.at(-1),'close');checks++;
root.unmount();console.log(JSON.stringify({status:'passed',checks,kind:'React DOM + CSS rule checks, not browser pixels or device IME'}));dom.window.close()})().catch(e=>{console.error(e);dom.window.close();process.exitCode=1});
