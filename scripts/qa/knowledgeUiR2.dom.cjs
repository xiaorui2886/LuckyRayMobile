const assert=require('node:assert/strict'),path=require('node:path');
const {JSDOM}=require(process.env.LR_JSDOM_MODULE||'jsdom');
const dom=new JSDOM('<div id="root"></div>',{url:'https://qa.invalid',pretendToBeVisual:true});
for(const k of ['window','document','HTMLElement','Element','Node','localStorage','Event','MouseEvent','KeyboardEvent'])global[k]=dom.window[k];
global.requestAnimationFrame=dom.window.requestAnimationFrame.bind(dom.window);global.cancelAnimationFrame=dom.window.cancelAnimationFrame.bind(dom.window);
window.matchMedia=query=>({matches:query.includes('reduced-motion'),addEventListener(){},removeEventListener(){}});
const {mountKnowledgeFixture}=require(path.resolve(process.argv[2]));
const delay=()=>new Promise(r=>setTimeout(r,80));const label=x=>[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===x);
async function click(button){assert.ok(button);button.click();await delay()}
(async()=>{let checks=0;
for(const desktop of [false,true]){const events=[];const root=mountKnowledgeFixture(document.getElementById('root'),desktop,e=>events.push(e));await delay();
 assert.equal(document.querySelector('.st-header-title').textContent,'');assert.equal(document.querySelector('.st-note-footnote'),null);assert.equal(document.querySelector('.st-note-placeholder').textContent,'');assert.equal(document.querySelector('.st-kb-status'),null);assert.equal(document.querySelector('.st-folder-status'),null);checks+=5;
 assert.equal(document.querySelector('.st-folder-trail [aria-current=location]').textContent,'参考');await click([...document.querySelectorAll('.st-folder-trail button')].find(b=>b.textContent==='项目'));assert.deepEqual(events.at(-1),['folder','项目']);checks++;
 await click(label('打开笔记列表'));assert.equal(document.querySelector('[role=dialog]').getAttribute('aria-label'),desktop?'电脑笔记':'本机笔记');assert.equal(document.querySelector('[role=dialog] input'),null);assert.equal(events.filter(e=>e[0]=== (desktop?'list-local':'list-desktop')).length,0);checks+=3;
 await click(document.querySelector('[data-note-id]'));assert.deepEqual(events.at(-1),['pick',desktop?'desktop:pc:v:qa':'note-qa']);checks++;
 await click(label('查找笔记'));assert.ok(document.querySelector('[role=dialog] input'));document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await delay();checks++;
 await click(label('切换到编辑模式'));assert.ok(document.querySelector('.st-note-editor'));assert.equal(document.querySelector('.st-note-editor').getAttribute('placeholder'),'');assert.equal(document.querySelectorAll('.st-editor-command svg').length,16);assert.equal(document.querySelectorAll('.st-editor-command text').length,0);checks+=4;
 await click(label('加粗'));assert.deepEqual(events.at(-1),['command','bold']);await click(label('切换到阅读模式'));assert.ok(document.querySelector('.st-note-prose'));assert.equal(document.querySelector('.st-editor-tools'),null);checks+=3;
 await click(label('笔记链接'));assert.deepEqual(events.at(-1),['relations']);await click(label('笔记更多操作'));assert.deepEqual(events.at(-1),['more']);checks+=2;
 root.unmount();await delay();}
console.log(JSON.stringify({status:'passed',checks,kind:'React DOM/scoped adapters; no screenshot/IME/geometry claim'}));dom.window.close();})().catch(e=>{console.error(e);dom.window.close();process.exitCode=1});
